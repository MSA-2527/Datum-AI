using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Datum.Contracts;
using Datum.Connector.SolidWorks.Context;
using Datum.Connector.SolidWorks.Execution;
using Datum.Connector.SolidWorks.Realtime;
using Datum.Connector.SolidWorks.Transport;
using Datum.Connector.SolidWorks.Ui;
using Microsoft.Win32;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swpublished;

namespace Datum.Connector.SolidWorks
{
    /// <summary>
    /// The SOLIDWORKS add-in entry point. Everything DATUM does inside the CAD process
    /// hangs off this object.
    ///
    /// Deliberately thin: it owns lifetimes and wiring, and delegates all real work.
    /// ConnectToSW must return quickly — anything slow here is time the user spends
    /// staring at a SOLIDWORKS splash screen blaming us for it.
    /// </summary>
    [ComVisible(true)]
    [Guid("8E5B2C41-7A3D-4F19-9C6E-2B8A4D5F1E07")]
    [ProgId("DATUM.Connector.SolidWorks.AddIn")]
    public sealed class DatumAddIn : ISwAddin
    {
        private SldWorks _sw = null!;
        private int _cookie;

        private DeltaRing _ring = null!;
        private DeltaPump _pump = null!;
        private EventTap _events = null!;
        private IdlePump _idle = null!;
        private PidResolver _pids = null!;
        private OpExecutor _executor = null!;
        private ContextReader _context = null!;
        private PipeClient _pipe = null!;
        private TaskPaneHost? _taskPane;
        private CommandUi? _commands;

        // ── ISwAddin ────────────────────────────────────────────────────────────────

        public bool ConnectToSW(object ThisSW, int Cookie)
        {
            var sw = Stopwatch.StartNew();
            try
            {
                _sw = (SldWorks)ThisSW;
                _cookie = Cookie;

                // Required before any callback registration, or SOLIDWORKS silently
                // ignores every command handler we add.
                _sw.SetAddinCallbackInfo2(0, this, _cookie);

                KernelLog.VerboseEnabled = ReadVerboseFlag();
                KernelLog.Info($"DATUM kernel connecting to SOLIDWORKS {_sw.RevisionNumber()}.");

                _ring = new DeltaRing(8192);
                _pids = new PidResolver();
                _idle = new IdlePump();
                _context = new ContextReader(_sw);
                _executor = new OpExecutor(_sw, _pids);

                _pipe = new PipeClient(Process.GetCurrentProcess().Id);
                _pipe.CommandReceived += OnCommand;
                _pipe.ConnectionChanged += connected =>
                    KernelLog.Info(connected ? "Orchestrator online." : "Orchestrator offline.");

                _pump = new DeltaPump(_ring, _pipe.Send);
                _executor.Progress += p => _pipe.SendJson(FrameType.Progress, p);

                _events = new EventTap(_sw, _ring, _pump, _idle.Drain);
                _events.AttachApplication();
                _events.AttachOpenDocuments();

                _pump.Start();
                _pipe.Start();

                // Ribbon and context-menu gestures relay to the panel over the same
                // socket everything else uses, so there is one path into the UI's state.
                UiBridge.Sink = (verb, payload) => _pipe.SendJson(FrameType.UiRequest, new
                {
                    verb,
                    payload
                });

                _commands = new CommandUi(_sw, _cookie, this);
                _commands.Install();

                _taskPane = new TaskPaneHost(_sw);
                _taskPane.Create();

                sw.Stop();
                KernelLog.Info($"DATUM kernel connected in {sw.ElapsedMilliseconds} ms.");
                return true;
            }
            catch (Exception ex)
            {
                KernelLog.Error("ConnectToSW failed", ex);
                KernelLog.Flush();
                // Returning false makes SOLIDWORKS disable the add-in cleanly rather
                // than leaving a half-initialised object wired to live events.
                return false;
            }
        }

        public bool DisconnectFromSW()
        {
            KernelLog.Info("DATUM kernel disconnecting.");
            try
            {
                UiBridge.Sink = null;
                _taskPane?.Dispose();
                _commands?.Remove();
                _events?.Dispose();
                _pump?.Dispose();
                _pipe?.Dispose();
                _idle?.Clear();
            }
            catch (Exception ex) { KernelLog.Error("Disconnect error", ex); }
            finally
            {
                KernelLog.Shutdown();
                // Release the SOLIDWORKS RCW promptly; leaving it to a finaliser can
                // keep SLDWORKS.exe alive after the user closes it.
                if (_sw != null) Marshal.ReleaseComObject(_sw);
                _sw = null!;
                GC.Collect();
                GC.WaitForPendingFinalizers();
            }
            return true;
        }

        // ── SOLIDWORKS UI callbacks ─────────────────────────────────────────────────
        //
        // SOLIDWORKS resolves callback and enable-method names by reflection against the
        // object passed to SetAddinCallbackInfo2 — this instance. They must therefore
        // live here rather than on CommandUi, and they must be public; CommandUi
        // references them through nameof() so a rename cannot silently break the ribbon.
        //
        // Each one returns immediately. They are invoked on the STA thread in the middle
        // of SOLIDWORKS's own command dispatch, so the actual work is a single queued
        // frame to the panel.

        public void CmdTogglePanel() => UiBridge.Request(UiRequest.TogglePanel, null);

        public void CmdAskSelection() =>
            UiBridge.Request(UiRequest.FocusComposer, new { mode = "Ask", useSelection = true });

        public void CmdLint() => UiBridge.Request(UiRequest.RunLint, null);

        /// <summary>Enable-method: 1 = enabled, 0 = greyed out. Names are bound by string.</summary>
        public int EnableAlways() => 1;

        public int EnableWithDocument()
        {
            // _sw is released on disconnect; a late callback must grey the button out,
            // not throw inside SOLIDWORKS's command dispatch.
            try { return _sw.ActiveDoc != null ? 1 : 0; }
            catch { return 0; }
        }

        // ── command dispatch ────────────────────────────────────────────────────────

        /// <summary>
        /// Called on a pipe thread. Nothing here touches SOLIDWORKS directly — the work
        /// is posted to the idle pump so it lands on the STA thread.
        /// </summary>
        private void OnCommand(KernelCommand cmd)
        {
            bool exclusive = cmd.Verb == KernelCommand.ApplyPlan ||
                             cmd.Verb == KernelCommand.DryRunPlan;

            _idle.Post(cmd.Verb, () => Execute(cmd), exclusive);
        }

        private void Execute(KernelCommand cmd)
        {
            var sw = Stopwatch.StartNew();
            KernelResult result;

            try
            {
                switch (cmd.Verb)
                {
                    case KernelCommand.GetContext:
                        result = Ok(cmd, _context.Read());
                        break;

                    case KernelCommand.Capabilities:
                        result = Ok(cmd, BuildCapabilities());
                        break;

                    case KernelCommand.ResolvePlan:
                        result = ResolvePlan(cmd);
                        break;

                    case KernelCommand.ApplyPlan:
                        result = ApplyPlan(cmd);
                        break;

                    case KernelCommand.CancelPlan:
                        _executor.Cancel.Cancel();
                        result = Ok(cmd, new { cancelled = true });
                        break;

                    case KernelCommand.SetParam:
                        result = SetParamFast(cmd);
                        break;

                    case KernelCommand.Rebuild:
                        RequireDoc().EditRebuild3();
                        result = Ok(cmd, new { errors = OpExecutor.CountRebuildErrors(RequireDoc()) });
                        break;

                    case KernelCommand.Undo:
                        UndoScope.UndoLast(_sw, RequireDoc());
                        result = Ok(cmd, new { undone = true });
                        break;

                    case KernelCommand.Highlight:
                        result = Highlight(cmd);
                        break;

                    case KernelCommand.ClearHighlight:
                        RequireDoc().ClearSelection2(true);
                        result = Ok(cmd, new { cleared = true });
                        break;

                    default:
                        result = KernelResult.Fail(cmd.Id, "unknown_verb",
                            $"This kernel does not implement the verb '{cmd.Verb}'.");
                        break;
                }
            }
            catch (OpException ex)
            {
                result = KernelResult.Fail(cmd.Id, ex.Code, ex.Message);
            }
            catch (COMException ex)
            {
                result = KernelResult.Fail(cmd.Id, KernelError.ComFailure,
                    "SOLIDWORKS rejected the request: " + ex.Message,
                    "HRESULT 0x" + ex.ErrorCode.ToString("X8"));
            }
            catch (Exception ex)
            {
                KernelLog.Error($"Command '{cmd.Verb}' failed", ex);
                result = KernelResult.Fail(cmd.Id, "internal", ex.Message);
            }

            result.ElapsedMs = sw.ElapsedMilliseconds;
            _pipe.SendJson(FrameType.CommandResult, result);
        }

        private KernelResult ResolvePlan(KernelCommand cmd)
        {
            var doc = RequireDoc();
            var body = cmd.Body.Deserialize<ResolveRequest>(IrJson.Options)
                       ?? throw new OpException(KernelError.PreconditionFailed, "Malformed resolve request.");

            if (!_executor.Resolve(doc, body.Plan, body.Mode, out var error))
                return new KernelResult { Id = cmd.Id, Ok = false, Error = error };

            return Ok(cmd, new { plan = body.Plan });
        }

        private KernelResult ApplyPlan(KernelCommand cmd)
        {
            var doc = RequireDoc();
            var body = cmd.Body.Deserialize<ResolveRequest>(IrJson.Options)
                       ?? throw new OpException(KernelError.PreconditionFailed, "Malformed apply request.");

            // Guard rails that must hold regardless of what the planner produced.
            if (doc.IsOpenedReadOnly() || doc.IsOpenedViewOnly())
                return KernelResult.Fail(cmd.Id, KernelError.NotWritable,
                    "This document is read-only. Check it out of the vault before editing.");

            // Re-resolve immediately before mutating: the model may have changed between
            // preview and apply, and stale targets are exactly what we refuse to guess at.
            if (!_executor.Resolve(doc, body.Plan, body.Mode, out var resolveError))
                return new KernelResult { Id = cmd.Id, Ok = false, Error = resolveError };

            var report = _executor.Apply(doc, body.Plan, out var applyError);

            return new KernelResult
            {
                Id = cmd.Id,
                Ok = applyError == null,
                Error = applyError,
                Body = JsonSerializer.SerializeToElement(report, IrJson.Options)
            };
        }

        /// <summary>
        /// Fast path for Parameter Inspector slider drags. Bypasses the planner and the
        /// whole plan pipeline: a slider drag must feel like dragging a dimension in
        /// SOLIDWORKS, so it cannot afford a round trip through validation.
        /// </summary>
        private KernelResult SetParamFast(KernelCommand cmd)
        {
            var doc = RequireDoc();
            string name = cmd.Body.GetProperty("name").GetString() ?? "";
            double value = cmd.Body.GetProperty("value").GetDouble();
            bool deferRebuild = cmd.Body.TryGetProperty("deferRebuild", out var d) && d.GetBoolean();

            var mgr = doc.GetEquationMgr();
            int idx = Handlers.ParamHandlers.FindGlobalIndex(mgr, name);
            if (idx < 0)
                return KernelResult.Fail(cmd.Id, KernelError.PreconditionFailed,
                    $"No global variable named '{name}'.");

            string units = cmd.Body.TryGetProperty("units", out var u) ? (u.GetString() ?? "mm") : "mm";
            mgr.set_Equation(idx, $"\"{name}\" = {value.ToString("0.############", System.Globalization.CultureInfo.InvariantCulture)}{units}");

            if (!deferRebuild) doc.EditRebuild3();

            return Ok(cmd, new
            {
                name,
                value,
                massG = deferRebuild ? 0 : OpExecutor.SafeMassGrams(doc),
                errors = deferRebuild ? 0 : OpExecutor.CountRebuildErrors(doc)
            });
        }

        /// <summary>
        /// Preview highlighting: selects the plan's resolved entities in the real
        /// viewport when the user hovers an operation row. This is the affordance that
        /// lets someone verify the AI understood the target without reading any JSON.
        /// </summary>
        private KernelResult Highlight(KernelCommand cmd)
        {
            var doc = RequireDoc();
            doc.ClearSelection2(true);

            if (!cmd.Body.TryGetProperty("pids", out var pids) ||
                pids.ValueKind != JsonValueKind.Array)
                return Ok(cmd, new { highlighted = 0 });

            var objs = new System.Collections.Generic.List<object>();
            foreach (var p in pids.EnumerateArray())
            {
                var o = _pids.Resolve(doc, p.GetString() ?? "", out _);
                if (o != null) objs.Add(o);
            }

            int n = PidResolver.SelectForPreview(doc, objs);
            return Ok(cmd, new { highlighted = n });
        }

        private Capabilities BuildCapabilities()
        {
            var caps = new Capabilities
            {
                SwVersion = _executor.SwVersionMajor(),
                SwBuild = _sw.RevisionNumber()
            };

            foreach (var name in OpCatalog.AllNames)
            {
                bool supported = OpCatalog.SupportedBy(name, caps.SwVersion) && _executor.CanHandle(name);
                if (supported) caps.SupportedOps.Add(name);
                else caps.UnsupportedOps.Add(name);
            }
            return caps;
        }

        private IModelDoc2 RequireDoc()
        {
            var doc = _sw.ActiveDoc as IModelDoc2;
            if (doc == null)
                throw new OpException(KernelError.NoDocument,
                    "No document is open in SOLIDWORKS.");
            return doc;
        }

        private static KernelResult Ok(KernelCommand cmd, object body) => new KernelResult
        {
            Id = cmd.Id,
            Ok = true,
            Body = JsonSerializer.SerializeToElement(body, IrJson.Options)
        };

        private static bool ReadVerboseFlag()
        {
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(@"Software\DATUM"))
                    return k?.GetValue("VerboseLogging")?.ToString() == "1";
            }
            catch { return false; }
        }

        private sealed class ResolveRequest
        {
            public Plan Plan { get; set; } = new Plan();
            public PlanMode Mode { get; set; } = PlanMode.Edit;
        }

        // ── COM registration ────────────────────────────────────────────────────────
        // Registered under HKCU by default so a normal user can install without an
        // administrator. The MSI writes HKLM for machine-wide enterprise deployment.

        [ComRegisterFunction]
        public static void RegisterFunction(Type t)
        {
            try
            {
                using (var key = Registry.CurrentUser.CreateSubKey(
                    @"SOFTWARE\SolidWorks\Addins\{" + t.GUID.ToString().ToUpperInvariant() + "}"))
                {
                    key.SetValue(null, 1);                       // load at startup
                    key.SetValue("Title", "DATUM");
                    key.SetValue("Description", "AI design copilot — native parametric operations");
                }

                using (var key = Registry.CurrentUser.CreateSubKey(
                    @"Software\SolidWorks\AddInsStartup\{" + t.GUID.ToString().ToUpperInvariant() + "}"))
                {
                    key.SetValue(null, 1);
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("DATUM registration failed: " + ex.Message);
            }
        }

        [ComUnregisterFunction]
        public static void UnregisterFunction(Type t)
        {
            try
            {
                string guid = "{" + t.GUID.ToString().ToUpperInvariant() + "}";
                Registry.CurrentUser.DeleteSubKeyTree(@"SOFTWARE\SolidWorks\Addins\" + guid, false);
                Registry.CurrentUser.DeleteSubKeyTree(@"Software\SolidWorks\AddInsStartup\" + guid, false);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("DATUM unregistration failed: " + ex.Message);
            }
        }
    }
}

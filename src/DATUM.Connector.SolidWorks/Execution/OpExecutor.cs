using System;
using System.Collections.Generic;
using System.Diagnostics;
using Datum.Contracts;
using Datum.Connector.SolidWorks.Handlers;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Datum.Connector.SolidWorks.Execution
{
    internal delegate void OpHandler(OpContext ctx);

    /// <summary>
    /// The only component in the system that turns an <see cref="Operation"/> into
    /// SOLIDWORKS API calls. Runs exclusively on the STA thread, driven by the idle pump.
    ///
    /// Pipeline (docs/02-architecture.md §3). Steps 1–6 mutate nothing, which is the
    /// property that makes the product safe to hand to a sceptic:
    ///
    ///   4. Resolve   — resolve every PID and query, evaluate preconditions   (read-only)
    ///   6. Dry run   — optional, against a scratch copy                      (read-only to the real doc)
    ///   7. Apply     — snapshot ▸ undo scope ▸ fast scope ▸ ops ▸ rebuild
    ///   8. Verify    — errors, mass delta, interference, plan assertions
    ///   9. Settle    — pass → commit; fail → roll back
    /// </summary>
    internal sealed class OpExecutor
    {
        private readonly SldWorks _sw;
        private readonly PidResolver _pids;
        private readonly Dictionary<string, OpHandler> _handlers =
            new Dictionary<string, OpHandler>(256, StringComparer.Ordinal);

        public readonly CancellationFlag Cancel = new CancellationFlag();

        /// <summary>Raised per operation during apply so the UI can fill the op-row progress bars.</summary>
        public event Action<OpProgress>? Progress;

        public OpExecutor(SldWorks sw, PidResolver pids)
        {
            _sw = sw;
            _pids = pids;
            RegisterAll();
        }

        private void RegisterAll()
        {
            ParamHandlers.Register(_handlers);
            FeatureHandlers.Register(_handlers);
            SketchHandlers.Register(_handlers);
            DocHandlers.Register(_handlers);
            QueryHandlers.Register(_handlers);
            ConfigHandlers.Register(_handlers);
            AssemblyHandlers.Register(_handlers);
            DrawingHandlers.Register(_handlers);
            MetaHandlers.Register(_handlers);

            KernelLog.Info($"OpExecutor registered {_handlers.Count} of {OpCatalog.Count} catalogued operations.");
        }

        public bool CanHandle(string opName) => _handlers.ContainsKey(opName);
        public IEnumerable<string> ImplementedOps => _handlers.Keys;

        // ─────────────────────────────  step 4: RESOLVE  ─────────────────────────────

        /// <summary>
        /// Read-only pass. Resolves every target, evaluates preconditions, and annotates
        /// the plan in place. Makes no change to the document whatsoever, so a plan that
        /// fails here has cost the user nothing.
        /// </summary>
        public bool Resolve(IModelDoc2 doc, Plan plan, PlanMode mode, out KernelError? error)
        {
            error = null;
            int swVersion = SwVersionMajor();

            IReadOnlyList<Operation> ordered;
            try { ordered = plan.TopologicalOrder(); }
            catch (IrException ex)
            {
                error = new KernelError { Code = KernelError.PreconditionFailed, Message = ex.Message };
                return false;
            }

            foreach (var op in ordered)
            {
                if (!OpCatalog.Exists(op.Op))
                {
                    error = new KernelError
                    {
                        Code = KernelError.UnknownOp,
                        Message = $"'{op.Op}' is not in the operation vocabulary.",
                        OpId = op.Id
                    };
                    return false;
                }

                if (!OpCatalog.AllowedInMode(op.Op, mode))
                {
                    error = new KernelError
                    {
                        Code = KernelError.ModeViolation,
                        Message = $"'{op.Op}' is not permitted in {mode} mode.",
                        OpId = op.Id
                    };
                    return false;
                }

                if (!OpCatalog.SupportedBy(op.Op, swVersion))
                {
                    error = new KernelError
                    {
                        Code = KernelError.OpNotSupported,
                        Message = $"'{op.Op}' requires a newer SOLIDWORKS than {swVersion}.",
                        OpId = op.Id
                    };
                    return false;
                }

                if (!_handlers.ContainsKey(op.Op))
                {
                    error = new KernelError
                    {
                        Code = KernelError.OpNotSupported,
                        Message = $"'{op.Op}' is catalogued but not yet implemented in this kernel build.",
                        OpId = op.Id
                    };
                    return false;
                }

                op.EstimatedMs = OpCatalog.EstimateMs(op.Op);
                op.Resolved = ResolveTarget(doc, op);

                if (op.Resolved != null && !op.Resolved.Ok)
                {
                    // Halt. Never fall back to a nearby entity — silent retargeting is
                    // how an AI destroys a model without anyone noticing.
                    error = new KernelError
                    {
                        Code = KernelError.PidUnresolved,
                        Message = op.Resolved.Problem ?? "A referenced entity could not be resolved.",
                        OpId = op.Id
                    };
                    return false;
                }
            }

            return true;
        }

        private ResolvedTarget ResolveTarget(IModelDoc2 doc, Operation op)
        {
            var rt = new ResolvedTarget { Ok = true };
            var t = op.Target;
            if (t == null) return rt;   // document-scoped operation

            switch (t.Kind)
            {
                case TargetKind.Document:
                    break;

                case TargetKind.Pid:
                {
                    var pidList = new List<string>();
                    if (!string.IsNullOrEmpty(t.Pid)) pidList.Add(t.Pid!);
                    if (t.Pids != null) pidList.AddRange(t.Pids);

                    var objs = new List<object>();
                    if (!_pids.ResolveAll(doc, pidList, objs, out string? problem))
                    {
                        rt.Ok = false;
                        rt.Problem = (t.Label != null ? t.Label + ": " : "") + problem;
                        return rt;
                    }
                    rt.Pids.AddRange(pidList);
                    rt.Count = objs.Count;
                    break;
                }

                case TargetKind.Selection:
                {
                    var selMgr = (ISelectionMgr)doc.SelectionManager;
                    int n = selMgr.GetSelectedObjectCount2(-1);
                    if (n == 0)
                    {
                        rt.Ok = false;
                        rt.Problem = "The operation targets the current selection, but nothing is selected.";
                        return rt;
                    }
                    for (int i = 1; i <= n; i++)
                    {
                        object o = selMgr.GetSelectedObject6(i, -1);
                        string? pid = PidResolver.Capture(doc, o);
                        if (pid != null) rt.Pids.Add(pid);
                        rt.Labels.Add(selMgr.GetSelectedObjectType3(i, -1).ToString());
                    }
                    rt.Count = rt.Pids.Count;
                    break;
                }

                case TargetKind.Query:
                {
                    var found = GeometryQuery.Evaluate(doc, t.Query ?? "", out string? qerr);
                    if (found == null)
                    {
                        rt.Ok = false;
                        rt.Problem = qerr ?? "The geometric query could not be evaluated.";
                        return rt;
                    }
                    foreach (var e in found)
                    {
                        string? pid = PidResolver.Capture(doc, e);
                        if (pid != null) rt.Pids.Add(pid);
                    }
                    rt.Count = rt.Pids.Count;
                    if (rt.Count == 0)
                    {
                        rt.Ok = false;
                        rt.Problem = $"The query '{t.Query}' matched nothing in this model.";
                    }
                    break;
                }

                case TargetKind.Name:
                {
                    var feat = doc.FeatureByName(t.Name) as IFeature;
                    if (feat == null)
                    {
                        rt.Ok = false;
                        rt.Problem = $"No feature named '{t.Name}' in this document.";
                        return rt;
                    }
                    string? pid = PidResolver.Capture(doc, feat);
                    if (pid != null) rt.Pids.Add(pid);
                    rt.Count = 1;
                    break;
                }
            }

            return rt;
        }

        // ─────────────────────────────  step 7-9: APPLY  ─────────────────────────────

        /// <summary>
        /// Executes a resolved plan. Assumes <see cref="Resolve"/> already succeeded.
        /// Returns a verification report; on failure the document is rolled back.
        /// </summary>
        public VerifyReport Apply(IModelDoc2 doc, Plan plan, out KernelError? error)
        {
            error = null;
            Cancel.Reset();

            var sw = Stopwatch.StartNew();
            var report = new VerifyReport();

            // Baseline BEFORE any mutation, so the verify block can make a real claim.
            report.ErrorsBefore = CountRebuildErrors(doc);
            report.MassBeforeG = SafeMassGrams(doc);

            var ordered = plan.TopologicalOrder();
            int total = ordered.Count;
            int index = 0;

            using (var undo = new UndoScope(doc, plan.Undo.GroupName))
            {
                FastScope? fast = null;
                try
                {
                    fast = new FastScope(_sw, doc);

                    foreach (var op in ordered)
                    {
                        Cancel.ThrowIfCancelled();

                        var opSw = Stopwatch.StartNew();
                        Progress?.Invoke(new OpProgress
                        {
                            PlanId = plan.PlanId, OpId = op.Id,
                            Index = index, Total = total, Status = "running"
                        });

                        var ctx = new OpContext
                        {
                            Sw = _sw, Doc = doc, Pids = _pids,
                            Op = op, Fast = fast, Cancel = Cancel
                        };

                        // Re-resolve against live COM pointers. The PID cache generation
                        // makes this cheap when nothing has changed, and correct when a
                        // preceding operation altered topology.
                        if (op.Resolved != null && op.Resolved.Pids.Count > 0)
                        {
                            if (!_pids.ResolveAll(doc, op.Resolved.Pids, ctx.Targets, out string? problem))
                                throw new OpException(KernelError.PidUnresolved,
                                    $"A reference used by '{op.Op}' became invalid after an earlier operation: {problem}");
                        }

                        _handlers[op.Op](ctx);

                        opSw.Stop();
                        Progress?.Invoke(new OpProgress
                        {
                            PlanId = plan.PlanId, OpId = op.Id,
                            Index = index, Total = total,
                            Status = "done", ElapsedMs = opSw.ElapsedMilliseconds
                        });
                        index++;
                    }

                    // Single rebuild for the whole plan — the entire reason rebuilds are
                    // deferred inside FastScope.
                    fast.SettleForRead();
                }
                catch (OpException ex)
                {
                    error = new KernelError
                    {
                        Code = ex.Code,
                        Message = ex.Message,
                        OpId = index < ordered.Count ? ordered[index].Id : null,
                        RolledBack = true
                    };
                }
                catch (System.Runtime.InteropServices.COMException ex)
                {
                    error = new KernelError
                    {
                        Code = KernelError.ComFailure,
                        Message = "SOLIDWORKS rejected the operation: " + ex.Message,
                        Detail = "HRESULT 0x" + ex.ErrorCode.ToString("X8"),
                        OpId = index < ordered.Count ? ordered[index].Id : null,
                        RolledBack = true
                    };
                }
                catch (Exception ex)
                {
                    error = new KernelError
                    {
                        Code = KernelError.ComFailure,
                        Message = ex.Message,
                        OpId = index < ordered.Count ? ordered[index].Id : null,
                        RolledBack = true
                    };
                    KernelLog.Error("Unhandled exception during apply", ex);
                }
                finally
                {
                    fast?.Dispose();
                }

                if (error != null)
                {
                    // Dispose without Commit cancels the undo record, reverting everything.
                    report.Passed = false;
                    report.RolledBack = true;
                    report.ElapsedMs = sw.ElapsedMilliseconds;
                    Progress?.Invoke(new OpProgress
                    {
                        PlanId = plan.PlanId,
                        OpId = error.OpId ?? "", Index = index, Total = total, Status = "failed"
                    });
                    _pids.InvalidateAll();
                    return report;
                }

                // ── step 8: verify ──
                report.ErrorsAfter = CountRebuildErrors(doc);
                report.MassAfterG = SafeMassGrams(doc);
                EvaluateChecks(doc, plan, report);

                if (!report.Passed)
                {
                    error = new KernelError
                    {
                        Code = KernelError.VerifyFailed,
                        Message = "Verification failed after applying; the model was restored.",
                        Detail = DescribeFailures(report),
                        RolledBack = true
                    };
                    report.RolledBack = true;
                    report.ElapsedMs = sw.ElapsedMilliseconds;
                    _pids.InvalidateAll();
                    return report;    // no Commit → UndoScope reverts
                }

                undo.Commit();
            }

            _pids.InvalidateAll();
            report.ElapsedMs = sw.ElapsedMilliseconds;
            return report;
        }

        private void EvaluateChecks(IModelDoc2 doc, Plan plan, VerifyReport report)
        {
            bool ok = true;

            void Check(string name, bool pass, string? detail = null)
            {
                report.Checks.Add(new VerifyResult { Check = name, Ok = pass, Detail = detail });
                if (!pass) ok = false;
            }

            // Implicit check applied to every plan: never leave the model with more
            // rebuild errors than it started with.
            Check("rebuild_errors",
                  report.ErrorsAfter <= report.ErrorsBefore,
                  $"{report.ErrorsBefore} → {report.ErrorsAfter}");

            foreach (var v in plan.Verify)
            {
                switch (v.Check)
                {
                    case "rebuild_errors":
                    {
                        int expect = v.Expect is { ValueKind: System.Text.Json.JsonValueKind.Number } e
                                   ? e.GetInt32() : 0;
                        Check("rebuild_errors_expected", report.ErrorsAfter <= expect,
                              $"expected ≤ {expect}, got {report.ErrorsAfter}");
                        break;
                    }
                    case "mass_delta_pct":
                    {
                        double max = v.Max ?? 100;
                        double actual = Math.Abs(report.MassDeltaPct);
                        Check("mass_delta_pct", actual <= max,
                              $"{actual:F1}% (limit {max:F1}%)");
                        break;
                    }
                    case "no_interference":
                    {
                        int n = CountInterferences(doc);
                        report.Interferences = n;
                        Check("no_interference", n == 0, n + " found");
                        break;
                    }
                    default:
                        // Unknown checks are recorded but never fail a plan: a newer
                        // orchestrator must not be able to brick an older kernel.
                        report.Checks.Add(new VerifyResult
                        {
                            Check = v.Check, Ok = true, Detail = "not evaluated by this kernel"
                        });
                        break;
                }
            }

            report.Passed = ok;
        }

        private static string DescribeFailures(VerifyReport r)
        {
            var parts = new List<string>();
            foreach (var c in r.Checks)
                if (!c.Ok) parts.Add(c.Check + (c.Detail != null ? " (" + c.Detail + ")" : ""));
            return string.Join("; ", parts);
        }

        // ─────────────────────────────  helpers  ─────────────────────────────

        public int SwVersionMajor()
        {
            try
            {
                // e.g. "34.0.0" for 2026; SOLIDWORKS major 24 == 2016, so offset by 1992.
                string rev = _sw.RevisionNumber();
                int dot = rev.IndexOf('.');
                int major = int.Parse(dot > 0 ? rev.Substring(0, dot) : rev);
                return 1992 + major;
            }
            catch { return 2022; }
        }

        /// <summary>
        /// Walks the tree calling IFeature::GetErrorCode2. Deliberately does this rather
        /// than trusting a document-level count: the per-feature codes are what the
        /// Repair Assistant needs anyway, and they distinguish errors from warnings.
        /// </summary>
        public static int CountRebuildErrors(IModelDoc2 doc)
        {
            int errors = 0;
            try
            {
                var feat = doc.FirstFeature() as IFeature;
                while (feat != null)
                {
                    int code = feat.GetErrorCode2(out _);
                    if (IsErrorCode(code)) errors++;

                    var sub = feat.GetFirstSubFeature() as IFeature;
                    while (sub != null)
                    {
                        int subCode = sub.GetErrorCode2(out _);
                        if (IsErrorCode(subCode)) errors++;
                        sub = sub.GetNextSubFeature() as IFeature;
                    }

                    feat = feat.GetNextFeature() as IFeature;
                }
            }
            catch (Exception ex) { KernelLog.Warn("Error-count traversal failed: " + ex.Message); }
            return errors;
        }

        private static bool IsErrorCode(int code) =>
            code != (int)swFeatureError_e.swFeatureErrorNone &&
            code != (int)swFeatureError_e.swFeatureErrorWarnGenericWarning;

        public static double SafeMassGrams(IModelDoc2 doc)
        {
            try
            {
                if ((swDocumentTypes_e)doc.GetType() == swDocumentTypes_e.swDocDRAWING) return 0;
                var mp = doc.Extension.CreateMassProperty();
                if (mp == null) return 0;
                return mp.Mass * 1000.0;   // SOLIDWORKS reports kg
            }
            catch { return 0; }
        }

        private static int CountInterferences(IModelDoc2 doc)
        {
            try
            {
                if ((swDocumentTypes_e)doc.GetType() != swDocumentTypes_e.swDocASSEMBLY) return 0;
                var asm = (AssemblyDoc)doc;
                var idm = asm.InterferenceDetectionManager;
                if (idm == null) return 0;
                idm.TreatCoincidenceAsInterference = false;
                idm.IncludeMultibodyPartInterferences = true;
                var results = idm.GetInterferences() as object[];
                return results?.Length ?? 0;
            }
            catch { return 0; }
        }
    }
}

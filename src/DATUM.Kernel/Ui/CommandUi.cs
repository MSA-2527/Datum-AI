using System;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Datum.Kernel.Ui
{
    /// <summary>
    /// Ribbon tab, toolbar and context-menu entry points.
    ///
    /// Right-clicking a face and choosing "Ask DATUM" is input modality I20 from the
    /// spec: it pre-seeds both the selection and the intent, which is the lowest-friction
    /// way into the product from inside a modelling flow.
    /// </summary>
    [ComVisible(true)]
    internal sealed class CommandUi
    {
        private const int GroupUserId = 0x0DA701;

        // SOLIDWORKS resolves every callback and enable-method name against the object
        // handed to SetAddinCallbackInfo2 — the DatumAddIn instance, not this class.
        // These names must therefore match public methods on DatumAddIn exactly.
        private const string CmdTogglePanel = nameof(DatumAddIn.CmdTogglePanel);
        private const string CmdAskSelection = nameof(DatumAddIn.CmdAskSelection);
        private const string CmdLint = nameof(DatumAddIn.CmdLint);
        private const string EnableAlways = nameof(DatumAddIn.EnableAlways);
        private const string EnableWithDocument = nameof(DatumAddIn.EnableWithDocument);

        private readonly SldWorks _sw;
        private readonly int _cookie;
        private readonly object _owner;
        private ICommandGroup? _group;

        public CommandUi(SldWorks sw, int cookie, object owner)
        {
            _sw = sw; _cookie = cookie; _owner = owner;
        }

        public void Install()
        {
            try
            {
                var cmdMgr = _sw.GetCommandManager(_cookie);

                int errors = 0;
                _group = cmdMgr.CreateCommandGroup2(
                    UserID: GroupUserId,
                    Title: "DATUM",
                    ToolTip: "AI design copilot",
                    Hint: "Plan and apply native parametric operations",
                    Position: -1,
                    IgnorePreviousVersion: true,
                    Errors: ref errors);

                if (_group == null)
                {
                    KernelLog.Warn("CreateCommandGroup2 failed (code " + errors + ").");
                    return;
                }

                _group.AddCommandItem2("Open DATUM", -1,
                    "Show or hide the DATUM panel", "DATUM", 0,
                    CmdTogglePanel, EnableAlways, 0,
                    (int)swCommandItemType_e.swMenuAndToolbarItem);

                _group.AddCommandItem2("Ask about selection", -1,
                    "Ask DATUM about the current selection", "Ask", 1,
                    CmdAskSelection, EnableWithDocument, 0,
                    (int)swCommandItemType_e.swMenuAndToolbarItem);

                _group.AddCommandItem2("Lint this model", -1,
                    "Run the design linter against the active document", "Lint", 2,
                    CmdLint, EnableWithDocument, 0,
                    (int)swCommandItemType_e.swMenuAndToolbarItem);

                _group.HasToolbar = true;
                _group.HasMenu = true;
                _group.Activate();

                // Context menu on faces and features — the fastest path from "I'm looking
                // at the thing" to "I'm asking about the thing".
                foreach (var t in new[] { swSelectType_e.swSelFACES, swSelectType_e.swSelEDGES,
                                          swSelectType_e.swSelSOLIDBODIES, swSelectType_e.swSelCOMPONENTS })
                {
                    _sw.AddMenuPopupItem3((int)swDocumentTypes_e.swDocPART, _owner,
                        (int)t, "Ask DATUM", CmdAskSelection, EnableWithDocument, "", "");
                    _sw.AddMenuPopupItem3((int)swDocumentTypes_e.swDocASSEMBLY, _owner,
                        (int)t, "Ask DATUM", CmdAskSelection, EnableWithDocument, "", "");
                }

                KernelLog.Info("Command UI installed.");
            }
            catch (Exception ex)
            {
                // A missing ribbon tab is a degraded experience, not a reason to fail
                // the whole add-in — the task pane still works.
                KernelLog.Error("Command UI installation failed", ex);
            }
        }

        public void Remove()
        {
            try
            {
                _sw.GetCommandManager(_cookie).RemoveCommandGroup2(GroupUserId, true);
            }
            catch (Exception ex) { KernelLog.Warn("Command group removal failed: " + ex.Message); }
        }

    }

    /// <summary>
    /// One-way channel from SOLIDWORKS UI gestures into the web panel. The orchestrator
    /// relays these over the same WebSocket the panel already listens on, so there is
    /// only ever one path into the UI's state store.
    /// </summary>
    internal static class UiBridge
    {
        /// <summary>
        /// Set once during ConnectToSW. Null until then, and null again after disconnect,
        /// so a stray ribbon click during teardown is a no-op rather than an exception
        /// raised inside SOLIDWORKS's own command dispatch.
        /// </summary>
        public static Action<string, object?>? Sink;

        public static void Request(string verb, object? payload)
        {
            try { Sink?.Invoke(verb, payload); }
            catch (Exception ex) { KernelLog.Warn("UiBridge dispatch failed: " + ex.Message); }
        }
    }
}

using System;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Datum.Connector.SolidWorks.Execution
{
    /// <summary>
    /// The apply-time performance discipline. Turns a 200-operation plan on a large
    /// part from minutes into seconds.
    ///
    /// Every setting is restored in Dispose, including on the exception path — leaving
    /// a customer's SOLIDWORKS with the feature tree disabled or UserControl off would
    /// be an unforgivable failure mode, so restoration is individually guarded.
    ///
    /// Because rebuilds are deferred inside this scope, operation handlers must not read
    /// derived geometry mid-plan without an explicit doc.rebuild operation first.
    /// </summary>
    internal sealed class FastScope : IDisposable
    {
        private readonly SldWorks _sw;
        private readonly IModelDoc2 _doc;
        private readonly bool _suspendGraphics;

        private readonly bool _prevUserControl;
        private readonly bool _prevUserControlBg;
        private readonly bool _prevCommandInProgress;
        private readonly bool _prevAddToDb;
        private readonly bool _prevDisplayWhenAdded;
        private readonly bool _prevEnableTree;
        private readonly bool _prevInputDimension;

        private bool _disposed;

        public FastScope(SldWorks sw, IModelDoc2 doc, bool suspendGraphics = true)
        {
            _sw = sw; _doc = doc; _suspendGraphics = suspendGraphics;

            var fm = doc.FeatureManager;
            var ext = doc.Extension;

            // Capture before mutating so we restore the user's actual state, not defaults.
            _prevUserControl = _sw.UserControl;
            _prevUserControlBg = _sw.UserControlBackground;
            _prevCommandInProgress = _sw.CommandInProgress;
            _prevAddToDb = ext.GetAddToDB();
            _prevDisplayWhenAdded = ext.GetDisplayWhenAdded();
            _prevEnableTree = fm.EnableFeatureTree;
            _prevInputDimension = _sw.GetUserPreferenceToggle(
                (int)swUserPreferenceToggle_e.swInputDimValOnCreate);

            try
            {
                // Tells SOLIDWORKS an API-driven command is running: suppresses some
                // UI churn and is the single biggest win for out-of-process callers.
                _sw.CommandInProgress = true;

                // Block user interaction during the mutation window. Without this the
                // user can click into the middle of a plan and corrupt selection state.
                _sw.UserControl = false;
                _sw.UserControlBackground = false;

                // Bulk insertion mode: skip per-entity solving and display.
                ext.SetAddToDB(true);
                ext.SetDisplayWhenAdded(false);

                // The feature tree control is surprisingly expensive to keep in sync
                // during bulk feature creation.
                _doc.FeatureManager.EnableFeatureTree = false;

                // Critical: with this on, AddDimension pops a modal input box and the
                // whole plan blocks forever waiting for a human.
                _sw.SetUserPreferenceToggle(
                    (int)swUserPreferenceToggle_e.swInputDimValOnCreate, false);

                if (_suspendGraphics) SetGraphicsUpdate(false);
            }
            catch (Exception ex)
            {
                KernelLog.Warn("FastScope setup partially failed: " + ex.Message);
                // Never leave a half-applied scope: unwind whatever did take effect.
                Dispose();
                throw;
            }
        }

        /// <summary>
        /// Ends bulk-insert mode and forces one rebuild. Call this before reading any
        /// derived geometry (mass, bounding box, interference) inside the scope.
        /// </summary>
        public void SettleForRead()
        {
            try
            {
                _doc.Extension.SetAddToDB(false);
                _doc.EditRebuild3();
            }
            catch (Exception ex)
            {
                KernelLog.Warn("SettleForRead failed: " + ex.Message);
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            // Each restore is independently guarded: one failure must not prevent the
            // rest from running, or the user is left in a broken UI state.
            Try(() => { if (_suspendGraphics) SetGraphicsUpdate(true); });
            Try(() => _sw.SetUserPreferenceToggle(
                    (int)swUserPreferenceToggle_e.swInputDimValOnCreate, _prevInputDimension));
            Try(() => _doc.FeatureManager.EnableFeatureTree = _prevEnableTree);
            Try(() => _doc.Extension.SetDisplayWhenAdded(_prevDisplayWhenAdded));
            Try(() => _doc.Extension.SetAddToDB(_prevAddToDb));
            Try(() => _sw.UserControlBackground = _prevUserControlBg);
            Try(() => _sw.UserControl = _prevUserControl);
            Try(() => _sw.CommandInProgress = _prevCommandInProgress);
        }

        private void SetGraphicsUpdate(bool enabled)
        {
            // ActiveView is typed as object and is null for a document with no open
            // window (common during silent batch processing), so this must stay defensive.
            if (_doc.ActiveView is IModelView view)
                view.EnableGraphicsUpdate = enabled;
        }

        private static void Try(Action a)
        {
            try { a(); }
            catch (Exception ex) { KernelLog.Warn("FastScope restore step failed: " + ex.Message); }
        }
    }
}

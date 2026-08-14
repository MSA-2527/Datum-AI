using System;
using SolidWorks.Interop.sldworks;

namespace Datum.Kernel.Execution
{
    /// <summary>
    /// Collapses an entire plan — however many hundreds of API calls it makes — into a
    /// single SOLIDWORKS undo record.
    ///
    /// This is the highest-leverage trust mechanism in the product. Users will not adopt
    /// an AI they cannot reverse with one keystroke, and the undo rate is the metric that
    /// tells us whether the previews are actually communicating (docs/03-product-spec §18).
    ///
    /// Usage:
    ///     using (var undo = new UndoScope(doc, "DATUM: NEMA 17 mounting"))
    ///     {
    ///         ... execute operations ...
    ///         undo.Commit();          // omit to roll back
    ///     }
    /// </summary>
    internal sealed class UndoScope : IDisposable
    {
        private readonly IModelDoc2 _doc;
        private readonly string _name;
        private bool _committed;
        private bool _disposed;
        private readonly bool _started;

        public UndoScope(IModelDoc2 doc, string name)
        {
            _doc = doc;
            _name = string.IsNullOrWhiteSpace(name) ? "DATUM operation" : name;

            try
            {
                _started = _doc.Extension.StartRecordingUndoObject();
                if (!_started)
                    KernelLog.Warn("StartRecordingUndoObject returned false; undo will not be grouped. " +
                                   "The pre-apply snapshot remains the recovery path.");
            }
            catch (Exception ex)
            {
                _started = false;
                KernelLog.Error("StartRecordingUndoObject threw", ex);
            }
        }

        /// <summary>True when SOLIDWORKS accepted the undo grouping.</summary>
        public bool IsGrouped => _started;

        /// <summary>Keep the changes. Without this call, Dispose reverts them.</summary>
        public void Commit() => _committed = true;

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            if (!_started) return;

            try
            {
                // Second argument is 'cancel': true discards the recorded work, which is
                // exactly the auto-rollback path when verification fails.
                _doc.Extension.FinishRecordingUndoObject(_name, !_committed);
            }
            catch (Exception ex)
            {
                KernelLog.Error("FinishRecordingUndoObject threw", ex);
            }
        }

        /// <summary>
        /// Explicit rollback used when verification fails after a committed apply.
        /// Prefer the snapshot when this returns false.
        /// </summary>
        public static bool UndoLast(SldWorks sw, IModelDoc2 doc)
        {
            try
            {
                doc.EditUndo2(1);
                doc.EditRebuild3();
                return true;
            }
            catch (Exception ex)
            {
                KernelLog.Error("EditUndo2 failed", ex);
                return false;
            }
        }
    }
}

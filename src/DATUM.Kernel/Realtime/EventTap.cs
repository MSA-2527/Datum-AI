using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Datum.Contracts;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Datum.Kernel.Realtime
{
    /// <summary>
    /// Hooks every SOLIDWORKS notification DATUM cares about and converts each one into
    /// a single ring-buffer write.
    ///
    /// Discipline enforced throughout this file:
    ///   - every handler returns 0 immediately;
    ///   - no handler allocates beyond a possible short string;
    ///   - no handler calls back into the SOLIDWORKS API for anything expensive
    ///     (mass properties, tree traversal) — that happens later, off the STA thread,
    ///     driven by the RebuildDone delta.
    ///
    /// Notifications are attached per object, so the tap must register against each
    /// document as it opens and detach as it closes, or events silently stop arriving.
    /// </summary>
    internal sealed class EventTap : IDisposable
    {
        private readonly SldWorks _sw;
        private readonly DeltaRing _ring;
        private readonly DeltaPump _pump;
        private readonly Action _onIdle;

        // ModelDoc -> synthetic stable document id. Using a synthetic int keeps the
        // wire format fixed-width and avoids marshalling COM pointers to the UI.
        private readonly Dictionary<string, int> _docIds = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        private readonly List<Attachment> _attachments = new List<Attachment>();
        private int _nextDocId = 1;
        private bool _disposed;

        private sealed class Attachment
        {
            public string Key = "";
            public int DocId;
            public object Doc = null!;
            public Action Detach = null!;
        }

        public EventTap(SldWorks sw, DeltaRing ring, DeltaPump pump, Action onIdle)
        {
            _sw = sw; _ring = ring; _pump = pump; _onIdle = onIdle;
        }

        // ── application-level ────────────────────────────────────────────────────────

        public void AttachApplication()
        {
            _sw.ActiveDocChangeNotify += OnActiveDocChange;
            _sw.FileOpenPostNotify += OnFileOpenPost;
            _sw.OnIdleNotify += OnIdleNotify;
            _sw.DestroyNotify += OnAppDestroy;
            _sw.ActiveModelDocChangeNotify += OnActiveModelDocChange;
            KernelLog.Info("EventTap attached to application.");
        }

        private int OnActiveDocChange()
        {
            var doc = _sw.ActiveDoc as IModelDoc2;
            int id = doc != null ? EnsureDoc(doc) : 0;
            _ring.Write(DeltaKind.ActiveDocChanged, id, 0, text: doc?.GetPathName() ?? "");
            _pump.Poke();
            return 0;
        }

        private int OnActiveModelDocChange()
        {
            // Fires for in-place assembly edits where ActiveDocChangeNotify does not.
            return OnActiveDocChange();
        }

        private int OnFileOpenPost(string fileName)
        {
            var doc = _sw.ActiveDoc as IModelDoc2;
            if (doc != null) AttachDocument(doc);
            _ring.Write(DeltaKind.DocOpened, doc != null ? EnsureDoc(doc) : 0, 0, text: fileName);
            _pump.Poke();
            return 0;
        }

        /// <summary>
        /// The idle tick is how queued operations reach the STA thread. It must stay
        /// cheap: the pump owner returns immediately if there is no queued work.
        /// </summary>
        private int OnIdleNotify()
        {
            try { _onIdle(); }
            catch (Exception ex) { KernelLog.Error("OnIdle handler threw", ex); }
            return 0;
        }

        private int OnAppDestroy()
        {
            KernelLog.Info("SOLIDWORKS is shutting down.");
            Dispose();
            return 0;
        }

        // ── per-document ─────────────────────────────────────────────────────────────

        public void AttachOpenDocuments()
        {
            var doc = _sw.GetFirstDocument() as IModelDoc2;
            while (doc != null)
            {
                AttachDocument(doc);
                doc = doc.GetNext() as IModelDoc2;
            }
        }

        public void AttachDocument(IModelDoc2 doc)
        {
            string key = DocKey(doc);
            foreach (var a in _attachments)
                if (string.Equals(a.Key, key, StringComparison.OrdinalIgnoreCase)) return;

            int id = EnsureDoc(doc);

            switch ((swDocumentTypes_e)doc.GetType())
            {
                case swDocumentTypes_e.swDocPART: AttachPart((PartDoc)doc, key, id); break;
                case swDocumentTypes_e.swDocASSEMBLY: AttachAssembly((AssemblyDoc)doc, key, id); break;
                case swDocumentTypes_e.swDocDRAWING: AttachDrawing((DrawingDoc)doc, key, id); break;
            }
        }

        private void AttachPart(PartDoc part, string key, int id)
        {
            DPartDocEvents_AddItemNotifyEventHandler add =
                (t, n) => { _ring.Write(DeltaKind.FeatureAdded, id, t, text: n); return 0; };
            DPartDocEvents_DeleteItemNotifyEventHandler del =
                (t, n) => { _ring.Write(DeltaKind.FeatureDeleted, id, t, text: n); return 0; };
            DPartDocEvents_RenameItemNotifyEventHandler ren =
                (t, o, n) => { _ring.Write(DeltaKind.FeatureRenamed, id, t, text: n); return 0; };
            DPartDocEvents_RegenPostNotify2EventHandler regen =
                (o, stopped) => { WriteRebuild(id, stopped); return 0; };
            DPartDocEvents_UserSelectionPostNotifyEventHandler sel =
                () => { _ring.Write(DeltaKind.SelectionChanged, id, 0); _pump.Poke(); return 0; };
            DPartDocEvents_ActiveConfigChangePostNotifyEventHandler cfg =
                () => { _ring.Write(DeltaKind.ConfigChanged, id, 0); _pump.Poke(); return 0; };
            DPartDocEvents_FileSavePostNotifyEventHandler save =
                (code, name) => { _ring.Write(DeltaKind.SaveDone, id, code, text: name); return 0; };
            DPartDocEvents_DestroyNotify2EventHandler destroy =
                (t) => { DetachByKey(key); _ring.Write(DeltaKind.DocClosed, id, 0); return 0; };

            part.AddItemNotify += add;
            part.DeleteItemNotify += del;
            part.RenameItemNotify += ren;
            part.RegenPostNotify2 += regen;
            part.UserSelectionPostNotify += sel;
            part.ActiveConfigChangePostNotify += cfg;
            part.FileSavePostNotify += save;
            part.DestroyNotify2 += destroy;

            Register(key, id, part, () =>
            {
                part.AddItemNotify -= add;
                part.DeleteItemNotify -= del;
                part.RenameItemNotify -= ren;
                part.RegenPostNotify2 -= regen;
                part.UserSelectionPostNotify -= sel;
                part.ActiveConfigChangePostNotify -= cfg;
                part.FileSavePostNotify -= save;
                part.DestroyNotify2 -= destroy;
            });
        }

        private void AttachAssembly(AssemblyDoc asm, string key, int id)
        {
            DAssemblyDocEvents_AddItemNotifyEventHandler add =
                (t, n) => { _ring.Write(DeltaKind.FeatureAdded, id, t, text: n); return 0; };
            DAssemblyDocEvents_DeleteItemNotifyEventHandler del =
                (t, n) => { _ring.Write(DeltaKind.FeatureDeleted, id, t, text: n); return 0; };
            DAssemblyDocEvents_RenameItemNotifyEventHandler ren =
                (t, o, n) => { _ring.Write(DeltaKind.FeatureRenamed, id, t, text: n); return 0; };
            DAssemblyDocEvents_RegenPostNotify2EventHandler regen =
                (o, stopped) => { WriteRebuild(id, stopped); return 0; };
            DAssemblyDocEvents_UserSelectionPostNotifyEventHandler sel =
                () => { _ring.Write(DeltaKind.SelectionChanged, id, 0); _pump.Poke(); return 0; };
            DAssemblyDocEvents_ComponentStateChangeNotify2EventHandler comp =
                (o, name, oldS, newS) => { _ring.Write(DeltaKind.ComponentState, id, newS, text: name); return 0; };
            DAssemblyDocEvents_ActiveConfigChangePostNotifyEventHandler cfg =
                () => { _ring.Write(DeltaKind.ConfigChanged, id, 0); _pump.Poke(); return 0; };
            DAssemblyDocEvents_FileSavePostNotifyEventHandler save =
                (code, name) => { _ring.Write(DeltaKind.SaveDone, id, code, text: name); return 0; };
            DAssemblyDocEvents_DestroyNotify2EventHandler destroy =
                (t) => { DetachByKey(key); _ring.Write(DeltaKind.DocClosed, id, 0); return 0; };

            asm.AddItemNotify += add;
            asm.DeleteItemNotify += del;
            asm.RenameItemNotify += ren;
            asm.RegenPostNotify2 += regen;
            asm.UserSelectionPostNotify += sel;
            asm.ComponentStateChangeNotify2 += comp;
            asm.ActiveConfigChangePostNotify += cfg;
            asm.FileSavePostNotify += save;
            asm.DestroyNotify2 += destroy;

            Register(key, id, asm, () =>
            {
                asm.AddItemNotify -= add;
                asm.DeleteItemNotify -= del;
                asm.RenameItemNotify -= ren;
                asm.RegenPostNotify2 -= regen;
                asm.UserSelectionPostNotify -= sel;
                asm.ComponentStateChangeNotify2 -= comp;
                asm.ActiveConfigChangePostNotify -= cfg;
                asm.FileSavePostNotify -= save;
                asm.DestroyNotify2 -= destroy;
            });
        }

        private void AttachDrawing(DrawingDoc drw, string key, int id)
        {
            DDrawingDocEvents_AddItemNotifyEventHandler add =
                (t, n) => { _ring.Write(DeltaKind.FeatureAdded, id, t, text: n); return 0; };
            DDrawingDocEvents_DeleteItemNotifyEventHandler del =
                (t, n) => { _ring.Write(DeltaKind.FeatureDeleted, id, t, text: n); return 0; };
            DDrawingDocEvents_RegenPostNotifyEventHandler regen =
                () => { WriteRebuild(id, false); return 0; };
            DDrawingDocEvents_UserSelectionPostNotifyEventHandler sel =
                () => { _ring.Write(DeltaKind.SelectionChanged, id, 0); _pump.Poke(); return 0; };
            DDrawingDocEvents_ActivateSheetPostNotifyEventHandler sheet =
                (name) => { _ring.Write(DeltaKind.ViewChanged, id, 0, text: name); return 0; };
            DDrawingDocEvents_DestroyNotify2EventHandler destroy =
                (t) => { DetachByKey(key); _ring.Write(DeltaKind.DocClosed, id, 0); return 0; };

            drw.AddItemNotify += add;
            drw.DeleteItemNotify += del;
            drw.RegenPostNotify += regen;
            drw.UserSelectionPostNotify += sel;
            drw.ActivateSheetPostNotify += sheet;
            drw.DestroyNotify2 += destroy;

            Register(key, id, drw, () =>
            {
                drw.AddItemNotify -= add;
                drw.DeleteItemNotify -= del;
                drw.RegenPostNotify -= regen;
                drw.UserSelectionPostNotify -= sel;
                drw.ActivateSheetPostNotify -= sheet;
                drw.DestroyNotify2 -= destroy;
            });
        }

        /// <summary>
        /// RegenPostNotify2 is the heartbeat of the whole real-time story: after every
        /// rebuild the orchestrator re-reads error counts, mass properties and lint
        /// state. Note we only stamp the signal here — the expensive reads happen off
        /// the STA thread in response to this delta.
        /// </summary>
        private void WriteRebuild(int docId, bool stopped)
        {
            _ring.Write(stopped ? DeltaKind.RebuildFailed : DeltaKind.RebuildDone, docId, 0);
            _pump.Poke();
        }

        // ── bookkeeping ──────────────────────────────────────────────────────────────

        private void Register(string key, int id, object doc, Action detach)
        {
            _attachments.Add(new Attachment { Key = key, DocId = id, Doc = doc, Detach = detach });
            KernelLog.Verbose($"EventTap attached doc {id} ({key}).");
        }

        private void DetachByKey(string key)
        {
            for (int i = _attachments.Count - 1; i >= 0; i--)
            {
                if (!string.Equals(_attachments[i].Key, key, StringComparison.OrdinalIgnoreCase)) continue;
                try { _attachments[i].Detach(); }
                catch (Exception ex) { KernelLog.Warn("Detach failed: " + ex.Message); }
                _attachments.RemoveAt(i);
            }
        }

        public int EnsureDoc(IModelDoc2 doc)
        {
            string key = DocKey(doc);
            if (_docIds.TryGetValue(key, out int id)) return id;
            id = _nextDocId++;
            _docIds[key] = id;
            return id;
        }

        public int DocIdOf(IModelDoc2? doc) =>
            doc != null && _docIds.TryGetValue(DocKey(doc), out int id) ? id : 0;

        /// <summary>
        /// Identity key. Falls back to the window title for never-saved documents,
        /// which have no path yet.
        /// </summary>
        private static string DocKey(IModelDoc2 doc)
        {
            string path = doc.GetPathName();
            return string.IsNullOrEmpty(path) ? "untitled::" + doc.GetTitle() : path;
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            for (int i = _attachments.Count - 1; i >= 0; i--)
            {
                try { _attachments[i].Detach(); } catch { /* teardown */ }
            }
            _attachments.Clear();

            try
            {
                _sw.ActiveDocChangeNotify -= OnActiveDocChange;
                _sw.FileOpenPostNotify -= OnFileOpenPost;
                _sw.OnIdleNotify -= OnIdleNotify;
                _sw.DestroyNotify -= OnAppDestroy;
                _sw.ActiveModelDocChangeNotify -= OnActiveModelDocChange;
            }
            catch (Exception ex) { KernelLog.Warn("Application detach failed: " + ex.Message); }

            KernelLog.Info("EventTap disposed.");
        }
    }
}

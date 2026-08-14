using System;
using System.Collections.Generic;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Datum.Kernel.Execution
{
    /// <summary>
    /// Persistent Reference ID resolution.
    ///
    /// This is the single most important correctness mechanism in the executor.
    /// Face, edge and feature references by name or index break on rebuild — that is
    /// precisely why hand-written macros rot. PIDs survive rebuilds, sessions, and
    /// SOLIDWORKS version upgrades, so every reference DATUM stores is a PID.
    ///
    /// Hard rule: if a PID fails to resolve, the caller HALTS. There is no fallback to
    /// "nearest similar entity" — silently retargeting is how AI destroys models.
    /// </summary>
    internal sealed class PidResolver
    {
        private readonly Dictionary<string, CacheEntry> _cache =
            new Dictionary<string, CacheEntry>(256, StringComparer.Ordinal);

        private struct CacheEntry
        {
            public object Obj;
            public int Generation;
        }

        /// <summary>
        /// Bumped on every rebuild. Cached COM pointers are only trusted within one
        /// generation, because a rebuild can invalidate them even when the PID itself
        /// remains valid.
        /// </summary>
        private int _generation;

        public void InvalidateAll()
        {
            _generation++;
            if (_cache.Count > 2048) _cache.Clear();   // bound growth on long sessions
        }

        public int CacheCount => _cache.Count;

        /// <summary>Capture a stable reference to a selectable object.</summary>
        public static string? Capture(IModelDoc2 doc, object entity)
        {
            try
            {
                var ext = doc.Extension;
                object pid = ext.GetPersistReference3(entity);
                if (pid is byte[] bytes && bytes.Length > 0)
                    return Convert.ToBase64String(bytes);
            }
            catch (Exception ex)
            {
                KernelLog.Warn("GetPersistReference3 failed: " + ex.Message);
            }
            return null;
        }

        /// <summary>
        /// Resolve a base64 PID back to a live COM object.
        /// Returns null and sets <paramref name="problem"/> on any failure.
        /// </summary>
        public object? Resolve(IModelDoc2 doc, string base64Pid, out string? problem)
        {
            problem = null;

            if (string.IsNullOrEmpty(base64Pid))
            {
                problem = "empty persistent reference";
                return null;
            }

            string key = doc.GetPathName() + "|" + base64Pid;
            if (_cache.TryGetValue(key, out var hit) && hit.Generation == _generation)
                return hit.Obj;

            byte[] bytes;
            try { bytes = Convert.FromBase64String(base64Pid); }
            catch { problem = "malformed persistent reference"; return null; }

            try
            {
                int errCode;
                object obj = doc.Extension.GetObjectByPersistReference3(bytes, out errCode);

                var status = (swPersistReferencedObjectStates_e)errCode;
                if (status != swPersistReferencedObjectStates_e.swPersistReferencedObject_Ok)
                {
                    problem = DescribeState(status);
                    return null;
                }
                if (obj == null)
                {
                    problem = "reference resolved to nothing";
                    return null;
                }

                _cache[key] = new CacheEntry { Obj = obj, Generation = _generation };
                return obj;
            }
            catch (Exception ex)
            {
                problem = "resolution threw: " + ex.Message;
                return null;
            }
        }

        private static string DescribeState(swPersistReferencedObjectStates_e s)
        {
            switch (s)
            {
                case swPersistReferencedObjectStates_e.swPersistReferencedObject_Deleted:
                    return "the referenced entity no longer exists";
                case swPersistReferencedObjectStates_e.swPersistReferencedObject_Invalid:
                    return "the reference is invalid for this document";
                case swPersistReferencedObjectStates_e.swPersistReferencedObject_Suppressed:
                    return "the referenced entity is suppressed";
                case swPersistReferencedObjectStates_e.swPersistReferencedObject_Ambiguous:
                    return "the reference is ambiguous after the last topology change";
                default:
                    return "reference could not be resolved (state " + (int)s + ")";
            }
        }

        /// <summary>
        /// Resolve a whole set, all-or-nothing. Used by the read-only resolve pass so
        /// the preview can report an exact affected count before anything mutates.
        /// </summary>
        public bool ResolveAll(IModelDoc2 doc, IEnumerable<string> pids,
                               List<object> resolved, out string? problem)
        {
            problem = null;
            foreach (var p in pids)
            {
                var o = Resolve(doc, p, out string? why);
                if (o == null)
                {
                    problem = why ?? "unresolved reference";
                    resolved.Clear();
                    return false;
                }
                resolved.Add(o);
            }
            return true;
        }

        /// <summary>Select resolved entities so the user can see the plan's target highlighted.</summary>
        public static int SelectForPreview(IModelDoc2 doc, IReadOnlyList<object> entities, int mark = 1)
        {
            int n = 0;
            var selMgr = (ISelectionMgr)doc.SelectionManager;
            var data = selMgr.CreateSelectData();
            data.Mark = mark;

            foreach (var e in entities)
            {
                if (e is IEntity ent)
                {
                    if (ent.Select4(true, data)) n++;
                }
                else if (e is IFeature feat)
                {
                    if (feat.Select2(true, mark)) n++;
                }
            }
            return n;
        }
    }
}

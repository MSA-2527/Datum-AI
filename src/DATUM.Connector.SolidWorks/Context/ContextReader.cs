using System;
using System.Collections.Generic;
using System.Diagnostics;
using Datum.Contracts;
using Datum.Connector.SolidWorks.Execution;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Datum.Connector.SolidWorks.Context
{
    /// <summary>
    /// Pipeline step 1: assemble everything the planner needs about the live session.
    ///
    /// Runs on the STA thread via the idle pump. Cost discipline matters — this is called
    /// on every prompt and on a debounce after every rebuild, so the tree walk is capped
    /// and mass properties are only computed when cheap enough to be worth having.
    /// </summary>
    internal sealed class ContextReader
    {
        private const int MaxFeatures = 2000;   // beyond this the digest is truncated, not the model

        private readonly SldWorks _sw;

        public ContextReader(SldWorks sw) { _sw = sw; }

        public ModelContext Read(bool includeMass = true, bool includeSelection = true)
        {
            var ctx = new ModelContext { Connected = true };

            try { ctx.SwVersion = ParseVersion(_sw.RevisionNumber()); }
            catch { ctx.SwVersion = 2022; }

            var doc = _sw.ActiveDoc as IModelDoc2;
            if (doc == null) return ctx;

            var sw = Stopwatch.StartNew();

            ctx.DocPath = doc.GetPathName();
            ctx.DocTitle = doc.GetTitle();
            ctx.DocType = DocTypeName(doc);
            ctx.Writable = !doc.IsOpenedReadOnly() && !doc.IsOpenedViewOnly();
            ctx.Units = UnitsOf(doc);

            try
            {
                var cfgMgr = doc.ConfigurationManager;
                ctx.Configuration = cfgMgr?.ActiveConfiguration?.Name;
                var names = doc.GetConfigurationNames() as string[];
                if (names != null) ctx.Configurations.AddRange(names);
            }
            catch (Exception ex) { KernelLog.Verbose("Config read: " + ex.Message); }

            if ((swDocumentTypes_e)doc.GetType() == swDocumentTypes_e.swDocPART)
            {
                try { ctx.Material = ((PartDoc)doc).GetMaterialPropertyName2("", out _); }
                catch { /* no material assigned */ }
            }

            ReadFeatures(doc, ctx);
            ReadGlobals(doc, ctx);
            ReadProperties(doc, ctx);
            if (includeSelection) ReadSelection(doc, ctx);

            ctx.RebuildErrors = OpExecutor.CountRebuildErrors(doc);

            if (includeMass)
            {
                try
                {
                    ctx.MassG = OpExecutor.SafeMassGrams(doc);
                    ctx.BBoxMm = ReadBBoxMm(doc);
                }
                catch (Exception ex) { KernelLog.Verbose("Mass read: " + ex.Message); }
            }

            sw.Stop();
            ctx.LastRebuildMs = sw.Elapsed.TotalMilliseconds;
            KernelLog.Verbose($"Context read in {sw.ElapsedMilliseconds} ms ({ctx.Features.Count} features).");
            return ctx;
        }

        private static void ReadFeatures(IModelDoc2 doc, ModelContext ctx)
        {
            try
            {
                int id = 0;
                var feat = doc.FirstFeature() as IFeature;
                while (feat != null && ctx.Features.Count < MaxFeatures)
                {
                    var node = new FeatureNode
                    {
                        Id = id++,
                        Name = feat.Name,
                        Type = feat.GetTypeName2(),
                        Depth = 0,
                        Suppressed = feat.IsSuppressed(),
                        ErrorCode = feat.GetErrorCode2(out _)
                    };

                    // Linter inputs, gathered here so the UI badge and the planner
                    // context always agree about model health.
                    if (feat.GetSpecificFeature2() is ISketch sketch)
                    {
                        node.UnderDefined = !sketch.GetConstrainedStatus().Equals(
                            (int)swSketchFullyConstrained_e.swSketchFullyConstrained);
                        node.FragileRef = SketchIsOnModelFace(sketch);
                    }

                    node.CreatedByDatum = HasDatumTag(feat);

                    ctx.Features.Add(node);
                    feat = feat.GetNextFeature() as IFeature;
                }
            }
            catch (Exception ex) { KernelLog.Warn("Feature traversal failed: " + ex.Message); }
        }

        /// <summary>
        /// A sketch whose reference is a model face rather than a datum plane is the
        /// classic fragile reference: it breaks whenever upstream topology changes.
        /// </summary>
        private static bool SketchIsOnModelFace(ISketch sketch)
        {
            try
            {
                var refEnt = sketch.GetReferenceEntity(out int entType);
                return refEnt != null &&
                       (swSelectType_e)entType == swSelectType_e.swSelFACES;
            }
            catch { return false; }
        }

        private static bool HasDatumTag(IFeature feat)
        {
            try
            {
                var cpm = feat.CustomPropertyManager;
                if (cpm == null) return false;
                cpm.Get5("DatumOp", false, out _, out string resolved, out _);
                return !string.IsNullOrEmpty(resolved);
            }
            catch { return false; }
        }

        private static void ReadGlobals(IModelDoc2 doc, ModelContext ctx)
        {
            try
            {
                var mgr = doc.GetEquationMgr();
                if (mgr == null) return;

                int count = mgr.GetCount();
                for (int i = 0; i < count; i++)
                {
                    string eq = mgr.get_Equation(i);
                    if (string.IsNullOrEmpty(eq)) continue;

                    int q1 = eq.IndexOf('"');
                    if (q1 < 0) continue;
                    int q2 = eq.IndexOf('"', q1 + 1);
                    if (q2 < 0) continue;

                    string name = eq.Substring(q1 + 1, q2 - q1 - 1);

                    // Only entries whose left side is a bare quoted name are globals;
                    // everything else is a dimension-driving equation.
                    int eqSign = eq.IndexOf('=', q2);
                    if (eqSign < 0) continue;
                    if (eq.Substring(q2 + 1, eqSign - q2 - 1).Trim().Length > 0) continue;

                    ctx.Globals.Add(new GlobalVar
                    {
                        Name = name,
                        Index = i,
                        Value = mgr.get_Value(i),
                        Equation = eq.Substring(eqSign + 1).Trim(),
                        Units = ctx.Units,
                        ReadOnly = false
                    });
                }
            }
            catch (Exception ex) { KernelLog.Verbose("Globals read: " + ex.Message); }
        }

        private static void ReadProperties(IModelDoc2 doc, ModelContext ctx)
        {
            try
            {
                var cpm = doc.Extension.CustomPropertyManager[""];
                var names = cpm.GetNames() as string[];
                if (names == null) return;
                foreach (var n in names)
                {
                    cpm.Get5(n, false, out _, out string resolved, out _);
                    ctx.Properties[n] = resolved ?? "";
                }
            }
            catch (Exception ex) { KernelLog.Verbose("Properties read: " + ex.Message); }
        }

        /// <summary>
        /// The current selection is the highest-signal implicit context there is: it tells
        /// the planner exactly which entity the user means without them describing it.
        /// Captured as PIDs so the reference survives the round trip.
        /// </summary>
        private static void ReadSelection(IModelDoc2 doc, ModelContext ctx)
        {
            try
            {
                var sel = (ISelectionMgr)doc.SelectionManager;
                int n = sel.GetSelectedObjectCount2(-1);
                for (int i = 1; i <= n && i <= 64; i++)
                {
                    object o = sel.GetSelectedObject6(i, -1);
                    var type = (swSelectType_e)sel.GetSelectedObjectType3(i, -1);

                    ctx.Selection.Add(new SelectionItem
                    {
                        Type = type.ToString().Replace("swSel", ""),
                        Label = DescribeSelection(o, type, i, sel),
                        Pid = PidResolver.Capture(doc, o)
                    });
                }
            }
            catch (Exception ex) { KernelLog.Verbose("Selection read: " + ex.Message); }
        }

        private static string DescribeSelection(object o, swSelectType_e type, int i, ISelectionMgr sel)
        {
            try
            {
                if (o is IFeature f) return f.Name;
                if (o is IComponent2 c) return c.Name2;

                // Faces and edges have no name; describe them by their owning feature,
                // which is what the user sees in the tree.
                if (o is IEntity ent && ent.GetComponent() is IFeature owner)
                    return $"{type.ToString().Replace("swSel", "")}<{i}> of {owner.Name}";
            }
            catch { /* fall through */ }
            return $"{type.ToString().Replace("swSel", "")}<{i}>";
        }

        private static double[]? ReadBBoxMm(IModelDoc2 doc)
        {
            if ((swDocumentTypes_e)doc.GetType() != swDocumentTypes_e.swDocPART) return null;
            try
            {
                var bodies = ((PartDoc)doc).GetBodies2((int)swBodyType_e.swSolidBody, false) as object[];
                if (bodies == null || bodies.Length == 0) return null;

                double minX = double.MaxValue, minY = double.MaxValue, minZ = double.MaxValue;
                double maxX = double.MinValue, maxY = double.MinValue, maxZ = double.MinValue;

                foreach (var bo in bodies)
                {
                    if (!(bo is IBody2 b) || !(b.GetBodyBox() is double[] box) || box.Length < 6) continue;
                    minX = Math.Min(minX, box[0]); minY = Math.Min(minY, box[1]); minZ = Math.Min(minZ, box[2]);
                    maxX = Math.Max(maxX, box[3]); maxY = Math.Max(maxY, box[4]); maxZ = Math.Max(maxZ, box[5]);
                }

                if (minX > maxX) return null;
                return new[]
                {
                    (maxX - minX) * 1000, (maxY - minY) * 1000, (maxZ - minZ) * 1000
                };
            }
            catch { return null; }
        }

        private static string DocTypeName(IModelDoc2 doc)
        {
            switch ((swDocumentTypes_e)doc.GetType())
            {
                case swDocumentTypes_e.swDocPART: return "part";
                case swDocumentTypes_e.swDocASSEMBLY: return "assembly";
                case swDocumentTypes_e.swDocDRAWING: return "drawing";
                default: return "unknown";
            }
        }

        private static string UnitsOf(IModelDoc2 doc)
        {
            try
            {
                var u = (swLengthUnit_e)doc.Extension.GetUserPreferenceInteger(
                    (int)swUserPreferenceIntegerValue_e.swUnitsLinear, 0);
                switch (u)
                {
                    case swLengthUnit_e.swINCHES: return "in";
                    case swLengthUnit_e.swFEET: return "ft";
                    case swLengthUnit_e.swMETER: return "m";
                    case swLengthUnit_e.swCM: return "cm";
                    default: return "mm";
                }
            }
            catch { return "mm"; }
        }

        private static int ParseVersion(string revision)
        {
            int dot = revision.IndexOf('.');
            int major = int.Parse(dot > 0 ? revision.Substring(0, dot) : revision);
            return 1992 + major;
        }
    }
}

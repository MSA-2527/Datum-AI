using System;
using System.Collections.Generic;
using Datum.Contracts;
using Datum.Kernel.Execution;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Datum.Kernel.Handlers
{
    /// <summary>
    /// Sketch creation and constraining.
    ///
    /// The linter's "fully defined" rule exists because under-constrained sketches lose
    /// design intent the moment a driving dimension changes, so these handlers add
    /// relations aggressively rather than leaving geometry floating. A sketch DATUM
    /// creates should be fully defined by the time the plan finishes.
    /// </summary>
    internal static class SketchHandlers
    {
        public static void Register(Dictionary<string, OpHandler> h)
        {
            h["sketch.create"] = Create;
            h["sketch.close"] = Close;
            h["sketch.line"] = Line;
            h["sketch.circle"] = Circle;
            h["sketch.rectangle"] = Rectangle;
            h["sketch.slot"] = Slot;
            h["sketch.polygon"] = Polygon;
            h["sketch.add_relation"] = AddRelation;
            h["sketch.dimension"] = Dimension;
            h["sketch.fully_define"] = FullyDefine;
            h["sketch.convert_entities"] = ConvertEntities;
            h["sketch.offset"] = Offset;
            h["sketch.mirror"] = Mirror;
        }

        private static void Create(OpContext c)
        {
            var doc = c.Doc;
            doc.ClearSelection2(true);

            if (c.Targets.Count > 0)
            {
                // Sketch on the resolved plane or face.
                if (c.Targets[0] is IEntity e) e.Select4(false, null);
                else if (c.Targets[0] is IFeature f) f.Select2(false, 0);
            }
            else
            {
                // Default to a datum plane, never a model face. Sketching on model faces
                // is the fragile-reference pattern the linter flags — features built that
                // way break whenever upstream topology changes.
                string plane = c.GetString("plane", "Front Plane") ?? "Front Plane";
                if (!doc.Extension.SelectByID2(plane, "PLANE", 0, 0, 0, false, 0, null, 0))
                    throw new OpException(KernelError.PreconditionFailed,
                        $"Could not find a plane named '{plane}'.");
            }

            doc.SketchManager.InsertSketch(true);
            var sketch = doc.SketchManager.ActiveSketch as ISketch;
            if (sketch == null)
                throw new OpException(KernelError.ComFailure, "Sketch could not be opened.");

            c.Output["sketch"] = ((IFeature)sketch).Name;
        }

        private static void Close(OpContext c)
        {
            if (c.Doc.SketchManager.ActiveSketch == null) return;   // idempotent
            c.Doc.SketchManager.InsertSketch(c.GetBool("rebuild", true));
        }

        private static void Line(OpContext c)
        {
            var sm = RequireActiveSketch(c);
            string u = Units(c);
            double x1 = OpContext.ToMetres(c.GetDouble("x1"), u);
            double y1 = OpContext.ToMetres(c.GetDouble("y1"), u);
            double x2 = OpContext.ToMetres(c.GetDouble("x2"), u);
            double y2 = OpContext.ToMetres(c.GetDouble("y2"), u);

            if (sm.CreateLine(x1, y1, 0, x2, y2, 0) == null)
                throw new OpException(KernelError.ComFailure, "CreateLine failed.");
        }

        private static void Circle(OpContext c)
        {
            var sm = RequireActiveSketch(c);
            string u = Units(c);
            double cx = OpContext.ToMetres(c.GetDouble("cx"), u);
            double cy = OpContext.ToMetres(c.GetDouble("cy"), u);
            double r = OpContext.ToMetres(c.GetDouble("radius", c.GetDouble("diameter", 10) / 2), u);

            if (sm.CreateCircleByRadius(cx, cy, 0, r) == null)
                throw new OpException(KernelError.ComFailure, "CreateCircleByRadius failed.");
        }

        private static void Rectangle(OpContext c)
        {
            var sm = RequireActiveSketch(c);
            string u = Units(c);
            double w = OpContext.ToMetres(c.GetDouble("width", 50), u);
            double hgt = OpContext.ToMetres(c.GetDouble("height", 30), u);
            double cx = OpContext.ToMetres(c.GetDouble("cx"), u);
            double cy = OpContext.ToMetres(c.GetDouble("cy"), u);

            bool centered = c.GetBool("centered", true);
            double x0 = centered ? cx - w / 2 : cx;
            double y0 = centered ? cy - hgt / 2 : cy;

            var segs = sm.CreateCornerRectangle(x0, y0, 0, x0 + w, y0 + hgt, 0) as object[];
            if (segs == null || segs.Length == 0)
                throw new OpException(KernelError.ComFailure, "CreateCornerRectangle failed.");

            // A corner rectangle is only fully defined once it is located. Adding the
            // symmetry relations here is what stops the shape collapsing when width or
            // height later change.
            if (centered && c.GetBool("autoConstrain", true))
                TryCenterOnOrigin(c, segs);

            c.Output["segments"] = segs.Length;
        }

        private static void Slot(OpContext c)
        {
            var sm = RequireActiveSketch(c);
            string u = Units(c);
            double x1 = OpContext.ToMetres(c.GetDouble("x1"), u);
            double y1 = OpContext.ToMetres(c.GetDouble("y1"), u);
            double x2 = OpContext.ToMetres(c.GetDouble("x2"), u);
            double y2 = OpContext.ToMetres(c.GetDouble("y2"), u);
            double width = OpContext.ToMetres(c.GetDouble("width", 8), u);

            var segs = sm.CreateSketchSlot(
                (int)swSketchSlotCreationType_e.swSketchSlotCreationType_line,
                (int)swSketchSlotLengthType_e.swSketchSlotLengthType_CenterCenter,
                width, x1, y1, 0, x2, y2, 0, 0, 0, 0, 1, false) as object[];

            if (segs == null) throw new OpException(KernelError.ComFailure, "CreateSketchSlot failed.");
        }

        private static void Polygon(OpContext c)
        {
            var sm = RequireActiveSketch(c);
            string u = Units(c);
            double cx = OpContext.ToMetres(c.GetDouble("cx"), u);
            double cy = OpContext.ToMetres(c.GetDouble("cy"), u);
            double r = OpContext.ToMetres(c.GetDouble("radius", 10), u);
            int sides = Math.Max(3, c.GetInt("sides", 6));

            if (sm.CreatePolygon(cx, cy, 0, cx + r, cy, 0, sides, c.GetBool("inscribed", true)) == null)
                throw new OpException(KernelError.ComFailure, "CreatePolygon failed.");
        }

        private static void AddRelation(OpContext c)
        {
            c.RequireTargets();
            var doc = c.Doc;
            doc.ClearSelection2(true);
            foreach (var t in c.Targets)
                if (t is IEntity e) e.Select4(true, null);

            string kind = c.RequireString("relation");
            doc.SketchAddConstraints(MapRelation(kind));
        }

        private static void Dimension(OpContext c)
        {
            c.RequireTargets();
            var doc = c.Doc;
            doc.ClearSelection2(true);
            foreach (var t in c.Targets)
                if (t is IEntity e) e.Select4(true, null);

            string u = Units(c);
            double atX = OpContext.ToMetres(c.GetDouble("atX"), u);
            double atY = OpContext.ToMetres(c.GetDouble("atY"), u);

            var dd = doc.Extension.AddDimension(atX, atY, 0,
                        (int)swSmartDimensionDirection_e.swSmartDimensionDirection_Default) as IDisplayDimension;
            if (dd == null)
                throw new OpException(KernelError.ComFailure,
                    "AddDimension failed. Check that the selected entities can be dimensioned together.");

            if (c.TryGetProp("value", out _))
            {
                var dim = dd.GetDimension2(0);
                dim.SetSystemValue3(OpContext.ToMetres(c.GetDouble("value"), u),
                    (int)swSetValueInConfiguration_e.swSetValue_InThisConfiguration, null);
            }

            if (c.TryGetProp("name", out _))
                dd.GetDimension2(0).Name = c.RequireString("name");
        }

        private static void FullyDefine(OpContext c)
        {
            var sketch = c.Doc.SketchManager.ActiveSketch as ISketch;
            if (sketch == null)
                throw new OpException(KernelError.PreconditionFailed, "fully_define needs an open sketch.");

            bool ok = c.Doc.SketchManager.FullyDefineSketch(
                RelationsScope: 1, ApplyRelations: true, DimensionsScope: 1,
                DimensionType: (int)swFullyDefineSketchDimScheme_e.swFullyDefineSketchDimScheme_Baseline,
                HorizontalDimScheme: 0, VerticalDimScheme: 0,
                HorizontalDimPlacement: 0, VerticalDimPlacement: 0,
                HorizontalDimSelection: null, VerticalDimSelection: null,
                Entities: null, Relations: null);

            c.Output["fullyDefined"] = ok;
            if (!ok)
                KernelLog.Warn("FullyDefineSketch could not fully constrain the sketch; the linter will flag it.");
        }

        private static void ConvertEntities(OpContext c)
        {
            c.RequireTargets();
            c.Doc.ClearSelection2(true);
            foreach (var t in c.Targets)
                if (t is IEntity e) e.Select4(true, null);
            c.Doc.SketchManager.SketchUseEdge3(c.GetBool("chain", true), false);
        }

        private static void Offset(OpContext c)
        {
            c.RequireTargets();
            c.Doc.ClearSelection2(true);
            foreach (var t in c.Targets)
                if (t is IEntity e) e.Select4(true, null);

            double d = c.GetLengthMetres("distance", 1);
            c.Doc.SketchManager.SketchOffset2(
                d, c.GetBool("reverse", false), true,
                (int)swSkOffsetCapEndType_e.swSkOffsetNoCap, 0, false);
        }

        private static void Mirror(OpContext c)
        {
            c.RequireTargets(2);
            c.Doc.ClearSelection2(true);
            foreach (var t in c.Targets)
                if (t is IEntity e) e.Select4(true, null);
            c.Doc.SketchManager.CreateSketchMirror();
        }

        // ── helpers ─────────────────────────────────────────────────────────────────

        private static ISketchManager RequireActiveSketch(OpContext c)
        {
            var sm = c.Doc.SketchManager;
            if (sm.ActiveSketch == null)
                throw new OpException(KernelError.PreconditionFailed,
                    $"'{c.Op.Op}' needs an open sketch. Emit sketch.create first.");
            return sm;
        }

        private static string Units(OpContext c) => c.GetString("units", "mm") ?? "mm";

        private static void TryCenterOnOrigin(OpContext c, object[] segs)
        {
            try
            {
                // Diagonal corners symmetric about the origin fully locates the rectangle.
                var doc = c.Doc;
                doc.ClearSelection2(true);
                if (segs.Length < 4) return;

                if (segs[0] is ISketchSegment s0 && segs[2] is ISketchSegment s2)
                {
                    (s0 as IEntity)?.Select4(true, null);
                    (s2 as IEntity)?.Select4(true, null);
                    doc.Extension.SelectByID2("Point1@Origin", "EXTSKETCHPOINT", 0, 0, 0, true, 0, null, 0);
                    doc.SketchAddConstraints("sgSYMMETRIC");
                }
            }
            catch (Exception ex)
            {
                KernelLog.Verbose("Auto-constrain skipped: " + ex.Message);
            }
        }

        private static string MapRelation(string kind)
        {
            switch (kind.ToLowerInvariant())
            {
                case "horizontal": return "sgHORIZONTAL2D";
                case "vertical": return "sgVERTICAL2D";
                case "coincident": return "sgCOINCIDENT";
                case "concentric": return "sgCONCENTRIC";
                case "parallel": return "sgPARALLEL";
                case "perpendicular": return "sgPERPENDICULAR";
                case "tangent": return "sgTANGENT";
                case "equal": return "sgSAME";
                case "symmetric": return "sgSYMMETRIC";
                case "collinear": return "sgCOLINEAR";
                case "midpoint": return "sgATMIDDLE";
                case "fix": return "sgFIXED";
                default: return kind;   // pass through unknown SOLIDWORKS relation ids
            }
        }
    }
}

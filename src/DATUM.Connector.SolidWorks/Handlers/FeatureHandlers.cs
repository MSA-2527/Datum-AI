using System;
using System.Collections.Generic;
using Datum.Contracts;
using Datum.Connector.SolidWorks.Execution;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Datum.Connector.SolidWorks.Handlers
{
    /// <summary>
    /// Solid feature creation and editing.
    ///
    /// Every handler here selects its resolved entities explicitly rather than relying
    /// on whatever the user happened to have highlighted. Leaving selection state to
    /// chance is the single most common cause of macros that "work on my machine".
    /// </summary>
    internal static class FeatureHandlers
    {
        public static void Register(Dictionary<string, OpHandler> h)
        {
            h["feature.fillet"] = Fillet;
            h["feature.chamfer"] = Chamfer;
            h["feature.extrude"] = ctx => Extrude(ctx, cut: false);
            h["feature.extrude_cut"] = ctx => Extrude(ctx, cut: true);
            h["feature.revolve"] = ctx => Revolve(ctx, cut: false);
            h["feature.revolve_cut"] = ctx => Revolve(ctx, cut: true);
            h["feature.shell"] = Shell;
            h["feature.hole_wizard"] = HoleWizard;
            h["feature.simple_hole"] = SimpleHole;
            h["feature.pattern_linear"] = LinearPattern;
            h["feature.pattern_circular"] = CircularPattern;
            h["feature.mirror"] = MirrorFeature;
            h["feature.reference_plane"] = ReferencePlane;

            h["feature.edit.set_params"] = EditSetParams;
            h["feature.edit.rename"] = EditRename;
            h["feature.edit.suppress"] = ctx => SetSuppression(ctx, true);
            h["feature.edit.unsuppress"] = ctx => SetSuppression(ctx, false);
            h["feature.edit.delete"] = EditDelete;
            h["feature.edit.rollback_to"] = RollbackTo;
        }

        // ── creation ────────────────────────────────────────────────────────────────

        private static void Fillet(OpContext c)
        {
            c.RequireTargets();
            double radius = c.GetLengthMetres("radius", 3);
            bool propagate = c.GetBool("propagate", true);
            bool tangentProp = c.GetBool("tangentPropagation", true);

            SelectAll(c, clearFirst: true);

            var fm = c.Doc.FeatureManager;
            var feat = fm.FeatureFillet3(
                Options: (int)(swFeatureFilletOptions_e.swFeatureFilletUniformRadius |
                               (propagate ? swFeatureFilletOptions_e.swFeatureFilletPropagate : 0)),
                R1: radius,
                Ftyp: (int)swFeatureFilletType_e.swFeatureFilletTypeConstantRadius,
                OverflowType: (int)swFilletOverFlowType_e.swFilletOverFlowType_Default,
                ConicTypeForCrossSectionProfile: (int)swFeatureFilletProfileType_e.swFeatureFilletCircular,
                RadiiTable: null, SetBackTable: null, PointRadiusArray: null) as IFeature;

            if (feat == null)
                throw new OpException(KernelError.ComFailure,
                    $"Fillet R{OpContext.FromMetres(radius, "mm"):F2} mm failed on {c.Targets.Count} edge(s). " +
                    "The radius may exceed the available geometry.");

            Tag(c, feat);
            c.Output["feature"] = feat.Name;
            c.Output["edges"] = c.Targets.Count;
        }

        private static void Chamfer(OpContext c)
        {
            c.RequireTargets();
            double distance = c.GetLengthMetres("distance", 1);
            double angleDeg = c.GetDouble("angle", 45);

            SelectAll(c, clearFirst: true);

            var feat = c.Doc.FeatureManager.InsertFeatureChamfer(
                Options: (int)swChamferPropagation_e.swChamferPropagation_Yes,
                ChamferType: (int)swChamferType_e.swChamferAngleDistance,
                Width: distance,
                Angle: angleDeg * Math.PI / 180.0,
                OtherDist: 0, VertexChamDist1: 0, VertexChamDist2: 0, VertexChamDist3: 0) as IFeature;

            if (feat == null)
                throw new OpException(KernelError.ComFailure, "Chamfer failed on the selected edges.");

            Tag(c, feat);
            c.Output["feature"] = feat.Name;
        }

        private static void Extrude(OpContext c, bool cut)
        {
            // Target is the sketch to extrude; if absent, use whatever sketch is selected.
            if (c.Targets.Count > 0) SelectAll(c, clearFirst: true);

            double depth = c.GetLengthMetres("depth", 10);
            bool bothDirections = c.GetBool("bothDirections", false);
            bool reverse = c.GetBool("reverse", false);
            bool midplane = c.GetBool("midplane", false);
            string end = c.GetString("endCondition", "blind") ?? "blind";

            int endCond = EndCondition(end);
            var fm = c.Doc.FeatureManager;

            IFeature? feat;
            if (cut)
            {
                feat = fm.FeatureCut4(
                    Sd: midplane, Flip: reverse, Dir: false,
                    T1: endCond, T2: (int)swEndConditions_e.swEndCondBlind,
                    D1: depth, D2: 0,
                    Dchk1: false, Dchk2: false, Ddir1: false, Ddir2: false,
                    Dang1: 0, Dang2: 0,
                    OffsetReverse1: false, OffsetReverse2: false,
                    TranslateSurface1: false, TranslateSurface2: false,
                    NormalCut: true, UseFeatScope: true, UseAutoSelect: true,
                    AssemblyFeatureScope: false, AutoSelectComponents: false,
                    PropagateFeatureToParts: false,
                    T0: (int)swStartConditions_e.swStartSketchPlane, StartOffset: 0,
                    FlipStartOffset: false, OptimizeGeometry: true) as IFeature;
            }
            else
            {
                feat = fm.FeatureExtrusion3(
                    Sd: true, Flip: reverse, Dir: bothDirections,
                    T1: endCond, T2: (int)swEndConditions_e.swEndCondBlind,
                    D1: depth, D2: 0,
                    Dchk1: false, Dchk2: false, Ddir1: false, Ddir2: false,
                    Dang1: 0, Dang2: 0,
                    OffsetReverse1: false, OffsetReverse2: false,
                    TranslateSurface1: false, TranslateSurface2: false,
                    Merge: true, UseFeatScope: true, UseAutoSelect: true,
                    T0: (int)swStartConditions_e.swStartSketchPlane, StartOffset: 0,
                    FlipStartOffset: false) as IFeature;
            }

            if (feat == null)
                throw new OpException(KernelError.ComFailure,
                    (cut ? "Extruded cut" : "Extrusion") + " failed. The sketch may be open or self-intersecting.");

            Tag(c, feat);
            c.Output["feature"] = feat.Name;
        }

        private static void Revolve(OpContext c, bool cut)
        {
            if (c.Targets.Count > 0) SelectAll(c, clearFirst: true);
            double angleDeg = c.GetDouble("angle", 360);
            double angle = angleDeg * Math.PI / 180.0;

            var fm = c.Doc.FeatureManager;
            var feat = fm.FeatureRevolve2(
                SingleDir: true,
                IsSolid: !cut, IsThin: false, IsCut: cut,
                ReverseDir: c.GetBool("reverse", false),
                BothDirectionUpToSameEntity: false,
                Dir1Type: (int)swEndConditions_e.swEndCondBlind,
                Dir2Type: (int)swEndConditions_e.swEndCondBlind,
                Dir1Angle: angle, Dir2Angle: 0,
                OffsetReverse1: false, OffsetReverse2: false,
                OffsetDistance1: 0, OffsetDistance2: 0,
                ThinType: 0, ThinThickness1: 0, ThinThickness2: 0,
                Merge: true, UseFeatScope: true, UseAutoSelect: true) as IFeature;

            if (feat == null)
                throw new OpException(KernelError.ComFailure,
                    "Revolve failed. Check that the sketch has a valid axis and does not cross it.");

            Tag(c, feat);
            c.Output["feature"] = feat.Name;
        }

        private static void Shell(OpContext c)
        {
            double thickness = c.GetLengthMetres("thickness", 2);
            bool outward = c.GetBool("outward", false);

            if (c.Targets.Count > 0) SelectAll(c, clearFirst: true);

            var feat = c.Doc.FeatureManager.InsertFeatureShell(thickness, outward) as IFeature;
            if (feat == null)
                throw new OpException(KernelError.ComFailure,
                    $"Shell at {OpContext.FromMetres(thickness, "mm"):F2} mm failed — the wall may exceed the local geometry.");

            Tag(c, feat);
            c.Output["feature"] = feat.Name;
        }

        /// <summary>
        /// Hole Wizard. Positions arrive in sketch coordinates on the target face, so the
        /// handler creates the positioning sketch itself rather than trusting the caller
        /// to have left one selected.
        /// </summary>
        private static void HoleWizard(OpContext c)
        {
            c.RequireTargets();
            var face = c.Targets[0] as IEntity
                       ?? throw new OpException(KernelError.PidUnresolved, "Hole Wizard needs a face target.");

            string standardName = c.GetString("standard", "ISO") ?? "ISO";
            string fastener = c.GetString("fastener", "M3") ?? "M3";
            string fit = c.GetString("fit", "normal") ?? "normal";
            string endCondition = c.GetString("endCondition", "through_all") ?? "through_all";
            double[] positions = c.GetDoubleArray("positions") ?? new double[0];
            string units = c.GetString("units", "mm") ?? "mm";

            if (positions.Length < 2 || positions.Length % 2 != 0)
                throw new OpException(KernelError.PreconditionFailed,
                    "hole_wizard needs a flat [x0,y0, x1,y1, ...] positions array.");

            var doc = c.Doc;
            doc.ClearSelection2(true);
            face.Select4(false, null);

            int standard = MapStandard(standardName);
            int fastenerType = (int)swWzdGeneralHoleTypes_e.swWzdHole;   // clearance hole
            int endCond = endCondition == "blind"
                        ? (int)swEndConditions_e.swEndCondBlind
                        : (int)swEndConditions_e.swEndCondThroughAll;

            var fm = doc.FeatureManager;
            var feat = fm.HoleWizard5(
                GenericHoleType: fastenerType,
                StandardIndex: standard,
                fastenerTypeIndex: MapFit(fit),
                SSizeName: fastener,
                EndType: endCond,
                Diameter: c.GetLengthMetres("diameter", 3.4),
                Depth: c.GetLengthMetres("depth", 10),
                Length: 0, ThreadDiameter: 0, ThreadDepth: 0, TapDrillDiameter: 0,
                HeadClearanceDiameter: 0, CounterSinkAngle: 0,
                HeadClearance: 0, CounterBoreDiameter: 0, CounterBoreDepth: 0,
                CounterSinkDiameter1: 0, CounterSinkAngle1: 0,
                CounterSinkDiameter2: 0, CounterSinkAngle2: 0,
                NearSideCounterSinkDiameter: 0, NearSideCounterSinkAngle: 0,
                FarSideCounterSinkDiameter: 0, FarSideCounterSinkAngle: 0,
                UseDefaultTolDisplay: true, Reverse: false,
                FeatureScope: true, AutoSelect: true,
                AssemblyFeatureScope: false, AutoSelectComponents: false,
                PropagateFeatureToParts: false) as IFeature;

            if (feat == null)
                throw new OpException(KernelError.ComFailure,
                    $"Hole Wizard failed for {fastener} {fit} fit on the selected face.");

            // Place the hole centres by editing the wizard's positioning sketch.
            PlaceHoleCentres(c, feat, positions, units);

            Tag(c, feat);
            c.Output["feature"] = feat.Name;
            c.Output["holes"] = positions.Length / 2;
        }

        private static void PlaceHoleCentres(OpContext c, IFeature holeFeature, double[] positions, string units)
        {
            // The positioning sketch is the wizard feature's second sub-feature.
            var sub = holeFeature.GetFirstSubFeature() as IFeature;
            ISketch? sketch = null;
            while (sub != null)
            {
                if (sub.GetSpecificFeature2() is ISketch s) { sketch = s; }
                sub = sub.GetNextSubFeature() as IFeature;
            }
            if (sketch == null)
            {
                KernelLog.Warn("Hole Wizard positioning sketch not found; holes stay at their default centre.");
                return;
            }

            var doc = c.Doc;
            ((IFeature)sketch).Select2(false, 0);
            doc.EditSketch();

            var sm = doc.SketchManager;
            sm.AddToDB = true;
            try
            {
                for (int i = 0; i < positions.Length; i += 2)
                {
                    double x = OpContext.ToMetres(positions[i], units);
                    double y = OpContext.ToMetres(positions[i + 1], units);
                    sm.CreatePoint(x, y, 0);
                }
            }
            finally
            {
                sm.AddToDB = false;
                doc.InsertSketch2(true);
            }
        }

        private static void SimpleHole(OpContext c)
        {
            c.RequireTargets();
            SelectAll(c, clearFirst: true);

            double dia = c.GetLengthMetres("diameter", 5);
            double depth = c.GetLengthMetres("depth", 10);

            var feat = c.Doc.FeatureManager.SimpleHole2(
                Depth: depth, Diameter: dia,
                Type: (int)swEndConditions_e.swEndCondThroughAll,
                Ang: 0, ReverseDir: false, UseFeatScope: true, UseAutoSelect: true) as IFeature;

            if (feat == null) throw new OpException(KernelError.ComFailure, "Simple hole failed.");
            Tag(c, feat);
            c.Output["feature"] = feat.Name;
        }

        private static void LinearPattern(OpContext c)
        {
            c.RequireTargets();
            SelectAll(c, clearFirst: true);

            int count1 = Math.Max(1, c.GetInt("count", 2));
            double spacing1 = c.GetLengthMetres("spacing", 10);
            int count2 = Math.Max(1, c.GetInt("count2", 1));
            double spacing2 = c.GetLengthMetres("spacing2", 0);

            var feat = c.Doc.FeatureManager.FeatureLinearPattern5(
                Num1: count1, Spacing1: spacing1,
                Num2: count2, Spacing2: spacing2,
                FlipDir1: c.GetBool("reverse", false), FlipDir2: false,
                DName1: "", DName2: "",
                GeometryPattern: c.GetBool("geometryPattern", true),
                VarySketch: false, VaryInstance: false, VarySpacing: false,
                SpacingIncrement1: 0, SpacingIncrement2: 0,
                Direction1Reverse: false, Direction2Reverse: false) as IFeature;

            if (feat == null) throw new OpException(KernelError.ComFailure, "Linear pattern failed.");
            Tag(c, feat);
            c.Output["feature"] = feat.Name;
            c.Output["instances"] = count1 * count2;
        }

        private static void CircularPattern(OpContext c)
        {
            c.RequireTargets();
            SelectAll(c, clearFirst: true);

            int count = Math.Max(2, c.GetInt("count", 4));
            double angleDeg = c.GetDouble("angle", 360);
            bool equalSpacing = c.GetBool("equalSpacing", true);

            var feat = c.Doc.FeatureManager.FeatureCircularPattern5(
                Number: count, Spacing: angleDeg * Math.PI / 180.0,
                FlipDirection: c.GetBool("reverse", false),
                DName: "", GeometryPattern: c.GetBool("geometryPattern", true),
                EqualSpacing: equalSpacing, VarySketch: false,
                Number2: 1, Spacing2: 0, EqualSpacing2: false,
                Direction2: false) as IFeature;

            if (feat == null) throw new OpException(KernelError.ComFailure, "Circular pattern failed.");
            Tag(c, feat);
            c.Output["feature"] = feat.Name;
        }

        private static void MirrorFeature(OpContext c)
        {
            c.RequireTargets(2);   // plane + at least one feature
            SelectAll(c, clearFirst: true);

            var feat = c.Doc.FeatureManager.InsertMirrorFeature2(
                BMirrorBody: false, BGeometryPattern: c.GetBool("geometryPattern", true),
                BMerge: true, BKnit: false,
                FeatureScope: (int)swFeatureScope_e.swFeatureScope_AllBodies) as IFeature;

            if (feat == null) throw new OpException(KernelError.ComFailure, "Mirror failed.");
            Tag(c, feat);
            c.Output["feature"] = feat.Name;
        }

        private static void ReferencePlane(OpContext c)
        {
            c.RequireTargets();
            SelectAll(c, clearFirst: true);
            double offset = c.GetLengthMetres("offset", 10);

            var feat = c.Doc.FeatureManager.InsertRefPlane(
                (int)swRefPlaneReferenceConstraints_e.swRefPlaneReferenceConstraint_Distance, offset,
                0, 0, 0, 0) as IFeature;

            if (feat == null) throw new OpException(KernelError.ComFailure, "Reference plane creation failed.");
            Tag(c, feat);
            c.Output["feature"] = feat.Name;
        }

        // ── editing ─────────────────────────────────────────────────────────────────

        /// <summary>
        /// The canonical edit path: GetDefinition → AccessSelections → mutate → ModifyDefinition.
        ///
        /// AccessSelections is mandatory and easy to forget; without it ModifyDefinition
        /// silently drops the feature's references and the rebuild fails in a way that
        /// looks like a geometry problem rather than a code problem.
        /// </summary>
        private static void EditSetParams(OpContext c)
        {
            c.RequireTargets();
            var feat = c.Targets[0] as IFeature
                       ?? throw new OpException(KernelError.PidUnresolved, "feature.edit.set_params needs a feature target.");

            object def = feat.GetDefinition();
            if (def == null)
                throw new OpException(KernelError.OpNotSupported,
                    $"'{feat.Name}' ({feat.GetTypeName2()}) does not expose an editable definition.");

            bool accessed = feat.AccessSelections(c.Doc, null);
            try
            {
                int applied = ApplyDefinitionParams(c, def);
                if (applied == 0)
                    throw new OpException(KernelError.PreconditionFailed,
                        $"No recognised parameters for a {feat.GetTypeName2()} feature in this operation.");

                if (!feat.ModifyDefinition(def, c.Doc, null))
                    throw new OpException(KernelError.ComFailure,
                        $"SOLIDWORKS rejected the modified definition for '{feat.Name}'.");

                c.Output["feature"] = feat.Name;
                c.Output["paramsApplied"] = applied;
            }
            catch
            {
                if (accessed) feat.ReleaseSelectionAccess();
                throw;
            }
        }

        /// <summary>
        /// Maps IR parameters onto the typed feature-data objects. Returns how many were
        /// applied so an operation that matched nothing fails loudly instead of silently
        /// "succeeding" with no effect.
        /// </summary>
        private static int ApplyDefinitionParams(OpContext c, object def)
        {
            int n = 0;

            switch (def)
            {
                case ISimpleFilletFeatureData2 fillet:
                    if (c.TryGetProp("radius", out _)) { fillet.DefaultRadius = c.GetLengthMetres("radius"); n++; }
                    if (c.TryGetProp("propagate", out _)) { fillet.PropagateToTangentFaces = c.GetBool("propagate"); n++; }
                    break;

                case IExtrudeFeatureData2 ext:
                    if (c.TryGetProp("depth", out _)) { ext.SetDepth(true, c.GetLengthMetres("depth")); n++; }
                    if (c.TryGetProp("reverse", out _)) { ext.ReverseDirection = c.GetBool("reverse"); n++; }
                    if (c.TryGetProp("draftAngle", out _))
                    {
                        ext.SetDraftAngle(true, c.GetDouble("draftAngle") * Math.PI / 180.0); n++;
                    }
                    break;

                case IChamferFeatureData2 cham:
                    if (c.TryGetProp("distance", out _)) { cham.Distance = c.GetLengthMetres("distance"); n++; }
                    if (c.TryGetProp("angle", out _)) { cham.Angle = c.GetDouble("angle") * Math.PI / 180.0; n++; }
                    break;

                case IShellFeatureData shell:
                    if (c.TryGetProp("thickness", out _)) { shell.Thickness = c.GetLengthMetres("thickness"); n++; }
                    if (c.TryGetProp("outward", out _)) { shell.ShellOutward = c.GetBool("outward"); n++; }
                    break;

                case ILinearPatternFeatureData lin:
                    if (c.TryGetProp("count", out _)) { lin.D1TotalInstances = c.GetInt("count"); n++; }
                    if (c.TryGetProp("spacing", out _)) { lin.D1Spacing = c.GetLengthMetres("spacing"); n++; }
                    break;

                case ICircularPatternFeatureData circ:
                    if (c.TryGetProp("count", out _)) { circ.TotalInstances = c.GetInt("count"); n++; }
                    if (c.TryGetProp("angle", out _)) { circ.Spacing = c.GetDouble("angle") * Math.PI / 180.0; n++; }
                    break;

                default:
                    KernelLog.Warn("No parameter mapping for feature data type " + def.GetType().Name);
                    break;
            }

            return n;
        }

        private static void EditRename(OpContext c)
        {
            c.RequireTargets();
            var feat = c.Targets[0] as IFeature
                       ?? throw new OpException(KernelError.PidUnresolved, "rename needs a feature target.");
            feat.Name = c.RequireString("name");
            c.Output["feature"] = feat.Name;
        }

        private static void SetSuppression(OpContext c, bool suppress)
        {
            c.RequireTargets();
            int state = suppress
                ? (int)swFeatureSuppressionAction_e.swSuppressFeature
                : (int)swFeatureSuppressionAction_e.swUnSuppressFeature;

            int done = 0;
            foreach (var t in c.Targets)
            {
                if (t is IFeature f &&
                    f.SetSuppression2(state,
                        (int)swInConfigurationOpts_e.swThisConfiguration, null))
                    done++;
            }
            if (done == 0)
                throw new OpException(KernelError.ComFailure,
                    (suppress ? "Suppression" : "Unsuppression") + " was rejected for every target.");
            c.Output["changed"] = done;
        }

        private static void EditDelete(OpContext c)
        {
            c.RequireTargets();
            SelectAll(c, clearFirst: true);

            // Children go with the parent unless the plan says otherwise. Making this
            // explicit matters: the difference silently orphans or destroys downstream work.
            int option = c.GetBool("deleteChildren", true)
                ? (int)swDeleteSelectionOptions_e.swDelete_Children
                : (int)swDeleteSelectionOptions_e.swDelete_Absorbed;

            if (!c.Doc.Extension.DeleteSelection2(option))
                throw new OpException(KernelError.ComFailure, "SOLIDWORKS refused to delete the selection.");

            c.Output["deleted"] = c.Targets.Count;
        }

        private static void RollbackTo(OpContext c)
        {
            c.RequireTargets();
            var feat = c.Targets[0] as IFeature
                       ?? throw new OpException(KernelError.PidUnresolved, "rollback_to needs a feature target.");
            feat.Select2(false, 0);
            if (!c.Doc.FeatureManager.EditRollback(
                    (int)swMoveRollbackBarTo_e.swMoveRollbackBarToBeforeFeature, feat.Name))
                throw new OpException(KernelError.ComFailure, $"Could not roll back to '{feat.Name}'.");
        }

        // ── shared helpers ──────────────────────────────────────────────────────────

        private static void SelectAll(OpContext c, bool clearFirst)
        {
            if (clearFirst) c.Doc.ClearSelection2(true);

            int selected = 0;
            foreach (var t in c.Targets)
            {
                if (t is IEntity ent) { if (ent.Select4(true, null)) selected++; }
                else if (t is IFeature f) { if (f.Select2(true, 0)) selected++; }
            }

            if (selected != c.Targets.Count)
                throw new OpException(KernelError.PidUnresolved,
                    $"Only {selected} of {c.Targets.Count} target(s) could be selected. " +
                    "The model changed after the plan was resolved.");
        }

        /// <summary>
        /// Marks a feature as DATUM-created so the Model Explorer can badge it and the
        /// audit trail can distinguish automated work from hand modelling.
        /// </summary>
        private static void Tag(OpContext c, IFeature feat)
        {
            try
            {
                var cpm = feat.CustomPropertyManager;
                cpm?.Add3("DatumOp", (int)swCustomInfoType_e.swCustomInfoText, c.Op.Op,
                          (int)swCustomPropertyAddOption_e.swCustomPropertyReplaceValue);
            }
            catch { /* tagging is best-effort and must never fail an operation */ }
        }

        private static int EndCondition(string s)
        {
            switch (s.ToLowerInvariant())
            {
                case "through_all": return (int)swEndConditions_e.swEndCondThroughAll;
                case "through_all_both": return (int)swEndConditions_e.swEndCondThroughAllBoth;
                case "up_to_next": return (int)swEndConditions_e.swEndCondUpToNext;
                case "up_to_vertex": return (int)swEndConditions_e.swEndCondUpToVertex;
                case "up_to_surface": return (int)swEndConditions_e.swEndCondUpToSurface;
                case "up_to_body": return (int)swEndConditions_e.swEndCondUpToBody;
                case "midplane": return (int)swEndConditions_e.swEndCondMidPlane;
                default: return (int)swEndConditions_e.swEndCondBlind;
            }
        }

        private static int MapStandard(string s)
        {
            switch (s.ToUpperInvariant())
            {
                case "ANSI": case "ANSI METRIC": return (int)swWzdHoleStandards_e.swStandardAnsiMetric;
                case "ANSI INCH": return (int)swWzdHoleStandards_e.swStandardAnsiInch;
                case "DIN": return (int)swWzdHoleStandards_e.swStandardDin;
                case "JIS": return (int)swWzdHoleStandards_e.swStandardJis;
                case "BSI": return (int)swWzdHoleStandards_e.swStandardBsi;
                default: return (int)swWzdHoleStandards_e.swStandardIso;
            }
        }

        private static int MapFit(string fit)
        {
            switch (fit.ToLowerInvariant())
            {
                case "close": return (int)swWzdHoleStandardFastenerTypes_e.swStandardFastenerScrewClearanceClose;
                case "loose": return (int)swWzdHoleStandardFastenerTypes_e.swStandardFastenerScrewClearanceLoose;
                default: return (int)swWzdHoleStandardFastenerTypes_e.swStandardFastenerScrewClearanceNormal;
            }
        }
    }
}

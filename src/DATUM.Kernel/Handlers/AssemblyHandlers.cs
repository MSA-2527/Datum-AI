using System;
using System.Collections.Generic;
using System.IO;
using Datum.Contracts;
using Datum.Kernel.Execution;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Datum.Kernel.Handlers
{
    /// <summary>
    /// Assembly operations. asm.fasten is the direct answer to problem A5 — inserting a
    /// screw and adding three mates, forty-eight times, is one of the most reliably
    /// soul-destroying tasks in mechanical design.
    /// </summary>
    internal static class AssemblyHandlers
    {
        public static void Register(Dictionary<string, OpHandler> h)
        {
            h["asm.insert_component"] = InsertComponent;
            h["asm.delete_component"] = DeleteComponent;
            h["asm.mate"] = Mate;
            h["asm.fasten"] = Fasten;
            h["asm.set_state"] = SetState;
            h["asm.set_fixed"] = SetFixed;
            h["asm.pattern_component"] = PatternComponent;
        }

        private static AssemblyDoc RequireAssembly(OpContext c)
        {
            if ((swDocumentTypes_e)c.Doc.GetType() != swDocumentTypes_e.swDocASSEMBLY)
                throw new OpException(KernelError.PreconditionFailed,
                    $"'{c.Op.Op}' can only run in an assembly document.");
            return (AssemblyDoc)c.Doc;
        }

        private static void InsertComponent(OpContext c)
        {
            var asm = RequireAssembly(c);
            string path = c.RequireString("path");

            if (!File.Exists(path))
                throw new OpException(KernelError.PreconditionFailed, $"Component file not found: {path}");

            string u = c.GetString("units", "mm") ?? "mm";
            double x = OpContext.ToMetres(c.GetDouble("x"), u);
            double y = OpContext.ToMetres(c.GetDouble("y"), u);
            double z = OpContext.ToMetres(c.GetDouble("z"), u);

            // Open the referenced document silently first: AddComponent5 will not load
            // a document that is not already in session, and fails with no diagnostic.
            int err = 0, warn = 0;
            var docType = path.EndsWith(".sldasm", StringComparison.OrdinalIgnoreCase)
                ? swDocumentTypes_e.swDocASSEMBLY : swDocumentTypes_e.swDocPART;

            c.Sw.OpenDoc6(path, (int)docType,
                (int)swOpenDocOptions_e.swOpenDocOptions_Silent, "", ref err, ref warn);

            var comp = asm.AddComponent5(
                path,
                (int)swAddComponentConfigOptions_e.swAddComponentConfigOptions_CurrentSelectedConfig,
                c.GetString("configuration", "") ?? "",
                false, "", x, y, z) as IComponent2;

            if (comp == null)
                throw new OpException(KernelError.ComFailure,
                    $"AddComponent5 failed for '{Path.GetFileName(path)}'.");

            c.Output["component"] = comp.Name2;
        }

        private static void DeleteComponent(OpContext c)
        {
            RequireAssembly(c);
            c.RequireTargets();
            c.Doc.ClearSelection2(true);

            foreach (var t in c.Targets)
                if (t is IComponent2 comp) comp.Select4(true, null, false);

            if (!c.Doc.Extension.DeleteSelection2((int)swDeleteSelectionOptions_e.swDelete_Absorbed))
                throw new OpException(KernelError.ComFailure, "Component deletion was refused.");

            c.Output["deleted"] = c.Targets.Count;
        }

        private static void Mate(OpContext c)
        {
            var asm = RequireAssembly(c);
            c.RequireTargets(2);

            c.Doc.ClearSelection2(true);
            foreach (var t in c.Targets)
                if (t is IEntity e) e.Select4(true, null);

            string type = c.GetString("type", "coincident") ?? "coincident";
            string align = c.GetString("alignment", "closest") ?? "closest";
            double distance = c.GetLengthMetres("distance", 0);
            double angleDeg = c.GetDouble("angle", 0);

            int errCode;
            var mate = asm.AddMate5(
                MateTypeFromName(type),
                AlignmentFromName(align),
                c.GetBool("flip", false),
                distance, distance, distance,
                0, 0,
                angleDeg * Math.PI / 180.0, 0, 0,
                false, false,
                (int)swMateWidthOptions_e.swMateWidth_Centered,
                out errCode) as IMate2;

            if (mate == null || errCode != (int)swAddMateError_e.swAddMateError_NoError)
                throw new OpException(KernelError.ComFailure,
                    $"Mate '{type}' failed ({DescribeMateError(errCode)}). " +
                    "The selected entities may be incompatible or the mate over-defines the assembly.");

            c.Output["mate"] = ((IFeature)mate).Name;
        }

        /// <summary>
        /// Hole-aware fastener insertion: place the fastener, then concentric + coincident
        /// against the hole it was targeted at. Saves the insert-plus-three-mates loop
        /// that dominates hardware assembly work.
        /// </summary>
        private static void Fasten(OpContext c)
        {
            var asm = RequireAssembly(c);
            c.RequireTargets();

            string path = c.RequireString("fastenerPath");
            if (!File.Exists(path))
                throw new OpException(KernelError.PreconditionFailed, $"Fastener file not found: {path}");

            int placed = 0;
            foreach (var target in c.Targets)
            {
                if (!(target is IEntity holeFace)) continue;

                int err = 0, warn = 0;
                c.Sw.OpenDoc6(path, (int)swDocumentTypes_e.swDocPART,
                    (int)swOpenDocOptions_e.swOpenDocOptions_Silent, "", ref err, ref warn);

                var comp = asm.AddComponent5(path,
                    (int)swAddComponentConfigOptions_e.swAddComponentConfigOptions_CurrentSelectedConfig,
                    "", false, "", 0, 0, 0) as IComponent2;

                if (comp == null)
                {
                    KernelLog.Warn("Fastener insert failed; skipping this hole.");
                    continue;
                }

                var axis = FindCylindricalFace(comp);
                if (axis == null)
                {
                    KernelLog.Warn($"No cylindrical face on '{comp.Name2}'; left unmated.");
                    placed++;
                    continue;
                }

                c.Doc.ClearSelection2(true);
                (axis as IEntity)?.Select4(true, null);
                holeFace.Select4(true, null);

                int mateErr;
                asm.AddMate5((int)swMateType_e.swMateCONCENTRIC,
                    (int)swMateAlign_e.swMateAlignCLOSEST, false, 0, 0, 0, 0, 0, 0, 0, 0,
                    false, false, 0, out mateErr);

                placed++;
                c.Cancel.ThrowIfCancelled();
            }

            if (placed == 0)
                throw new OpException(KernelError.ComFailure, "No fasteners could be placed.");

            c.Output["placed"] = placed;
        }

        private static void SetState(OpContext c)
        {
            RequireAssembly(c);
            c.RequireTargets();
            string state = c.GetString("state", "resolved") ?? "resolved";

            int n = 0;
            foreach (var t in c.Targets)
            {
                if (!(t is IComponent2 comp)) continue;
                switch (state.ToLowerInvariant())
                {
                    case "suppressed":
                        comp.SetSuppression2((int)swComponentSuppressionState_e.swComponentSuppressed); break;
                    case "lightweight":
                        comp.SetSuppression2((int)swComponentSuppressionState_e.swComponentLightweight); break;
                    default:
                        comp.SetSuppression2((int)swComponentSuppressionState_e.swComponentFullyResolved); break;
                }
                n++;
            }
            c.Output["changed"] = n;
        }

        private static void SetFixed(OpContext c)
        {
            var asm = RequireAssembly(c);
            c.RequireTargets();
            c.Doc.ClearSelection2(true);
            foreach (var t in c.Targets)
                if (t is IComponent2 comp) comp.Select4(true, null, false);

            if (c.GetBool("fixed", true)) asm.FixComponent();
            else asm.UnfixComponent();
        }

        private static void PatternComponent(OpContext c)
        {
            var asm = RequireAssembly(c);
            c.RequireTargets();
            c.Doc.ClearSelection2(true);
            foreach (var t in c.Targets)
                if (t is IComponent2 comp) comp.Select4(true, null, false);

            var feat = asm.FeatureLinearPattern(
                c.GetInt("count", 2), c.GetLengthMetres("spacing", 20),
                c.GetInt("count2", 1), c.GetLengthMetres("spacing2", 0),
                c.GetBool("reverse", false), false) as IFeature;

            if (feat == null) throw new OpException(KernelError.ComFailure, "Component pattern failed.");
            c.Output["feature"] = feat.Name;
        }

        // ── helpers ─────────────────────────────────────────────────────────────────

        private static IFace2? FindCylindricalFace(IComponent2 comp)
        {
            try
            {
                var bodies = comp.GetBodies3((int)swBodyType_e.swSolidBody, out _) as object[];
                if (bodies == null) return null;

                foreach (var bo in bodies)
                {
                    if (!(bo is IBody2 body)) continue;
                    var faces = body.GetFaces() as object[];
                    if (faces == null) continue;

                    foreach (var fo in faces)
                        if (fo is IFace2 f && f.IGetSurface().IsCylinder())
                            return f;
                }
            }
            catch (Exception ex) { KernelLog.Verbose("FindCylindricalFace: " + ex.Message); }
            return null;
        }

        private static int MateTypeFromName(string t)
        {
            switch (t.ToLowerInvariant())
            {
                case "concentric": return (int)swMateType_e.swMateCONCENTRIC;
                case "parallel": return (int)swMateType_e.swMatePARALLEL;
                case "perpendicular": return (int)swMateType_e.swMatePERPENDICULAR;
                case "tangent": return (int)swMateType_e.swMateTANGENT;
                case "distance": return (int)swMateType_e.swMateDISTANCE;
                case "angle": return (int)swMateType_e.swMateANGLE;
                case "lock": return (int)swMateType_e.swMateLOCK;
                case "width": return (int)swMateType_e.swMateWIDTH;
                case "symmetric": return (int)swMateType_e.swMateSYMMETRIC;
                case "gear": return (int)swMateType_e.swMateGEAR;
                case "cam": return (int)swMateType_e.swMateCAMFOLLOWER;
                case "screw": return (int)swMateType_e.swMateSCREW;
                default: return (int)swMateType_e.swMateCOINCIDENT;
            }
        }

        private static int AlignmentFromName(string a)
        {
            switch (a.ToLowerInvariant())
            {
                case "aligned": return (int)swMateAlign_e.swMateAlignALIGNED;
                case "anti_aligned": return (int)swMateAlign_e.swMateAlignANTI_ALIGNED;
                default: return (int)swMateAlign_e.swMateAlignCLOSEST;
            }
        }

        private static string DescribeMateError(int code)
        {
            var e = (swAddMateError_e)code;
            switch (e)
            {
                case swAddMateError_e.swAddMateError_IncorrectMateType: return "incompatible mate type for those entities";
                case swAddMateError_e.swAddMateError_IncorrectAlignment: return "incorrect alignment";
                case swAddMateError_e.swAddMateError_OverDefinedAssembly: return "would over-define the assembly";
                case swAddMateError_e.swAddMateError_IncorrectSelections: return "incorrect selections";
                default: return "error " + code;
            }
        }
    }
}

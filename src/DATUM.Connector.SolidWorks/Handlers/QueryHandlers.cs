using System;
using System.Collections.Generic;
using Datum.Contracts;
using Datum.Connector.SolidWorks.Execution;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Datum.Connector.SolidWorks.Handlers
{
    /// <summary>
    /// Read-only queries. Every operation here carries OpTraits.ReadOnly, which is what
    /// makes Ask mode provably incapable of mutation — the executor rejects anything
    /// without that trait before a handler is ever reached.
    /// </summary>
    internal static class QueryHandlers
    {
        public static void Register(Dictionary<string, OpHandler> h)
        {
            h["query.mass_properties"] = MassProperties;
            h["query.bounding_box"] = BoundingBox;
            h["query.measure"] = Measure;
            h["query.list_features"] = ListFeatures;
            h["query.list_dimensions"] = ListDimensions;
            h["query.list_configurations"] = ListConfigurations;
            h["query.list_properties"] = ListProperties;
            h["query.list_components"] = ListComponents;
            h["query.rebuild_errors"] = RebuildErrors;
            h["query.check_interference"] = CheckInterference;
            h["query.check_thickness"] = CheckThickness;
            h["query.get_bom"] = GetBom;
        }

        private static void MassProperties(OpContext c)
        {
            var mp = c.Doc.Extension.CreateMassProperty()
                     ?? throw new OpException(KernelError.ComFailure, "Mass properties are unavailable.");

            c.Output["massG"] = mp.Mass * 1000.0;
            c.Output["volumeCm3"] = mp.Volume * 1e6;
            c.Output["surfaceAreaCm2"] = mp.SurfaceArea * 1e4;
            c.Output["density"] = mp.Density;

            if (mp.CenterOfMass is double[] com && com.Length >= 3)
                c.Output["centerOfMassMm"] = new[] { com[0] * 1000, com[1] * 1000, com[2] * 1000 };
        }

        private static void BoundingBox(OpContext c)
        {
            if ((swDocumentTypes_e)c.Doc.GetType() != swDocumentTypes_e.swDocPART)
                throw new OpException(KernelError.PreconditionFailed, "Bounding box needs a part document.");

            var part = (PartDoc)c.Doc;
            var bodies = part.GetBodies2((int)swBodyType_e.swSolidBody, false) as object[];
            if (bodies == null || bodies.Length == 0)
                throw new OpException(KernelError.PreconditionFailed, "The part has no solid bodies.");

            double minX = double.MaxValue, minY = double.MaxValue, minZ = double.MaxValue;
            double maxX = double.MinValue, maxY = double.MinValue, maxZ = double.MinValue;

            foreach (var bo in bodies)
            {
                if (!(bo is IBody2 body)) continue;
                if (!(body.GetBodyBox() is double[] b) || b.Length < 6) continue;
                minX = Math.Min(minX, b[0]); minY = Math.Min(minY, b[1]); minZ = Math.Min(minZ, b[2]);
                maxX = Math.Max(maxX, b[3]); maxY = Math.Max(maxY, b[4]); maxZ = Math.Max(maxZ, b[5]);
            }

            c.Output["sizeMm"] = new[]
            {
                (maxX - minX) * 1000, (maxY - minY) * 1000, (maxZ - minZ) * 1000
            };
            c.Output["minMm"] = new[] { minX * 1000, minY * 1000, minZ * 1000 };
            c.Output["maxMm"] = new[] { maxX * 1000, maxY * 1000, maxZ * 1000 };
        }

        private static void Measure(OpContext c)
        {
            c.RequireTargets();
            c.Doc.ClearSelection2(true);
            foreach (var t in c.Targets)
                if (t is IEntity e) e.Select4(true, null);

            var measure = c.Doc.Extension.CreateMeasure();
            if (measure == null || !measure.Calculate(null))
                throw new OpException(KernelError.ComFailure,
                    "SOLIDWORKS could not measure that combination of entities.");

            if (measure.Length >= 0) c.Output["lengthMm"] = measure.Length * 1000;
            if (measure.Distance >= 0) c.Output["distanceMm"] = measure.Distance * 1000;
            if (measure.Area > 0) c.Output["areaMm2"] = measure.Area * 1e6;
            if (measure.Angle != 0) c.Output["angleDeg"] = measure.Angle * 180.0 / Math.PI;
            if (measure.Diameter > 0) c.Output["diameterMm"] = measure.Diameter * 1000;
        }

        private static void ListFeatures(OpContext c)
        {
            var list = new List<object>();
            var feat = c.Doc.FirstFeature() as IFeature;
            while (feat != null)
            {
                list.Add(new Dictionary<string, object?>
                {
                    ["name"] = feat.Name,
                    ["type"] = feat.GetTypeName2(),
                    ["suppressed"] = feat.IsSuppressed(),
                    ["errorCode"] = feat.GetErrorCode2(out _)
                });
                feat = feat.GetNextFeature() as IFeature;
            }
            c.Output["features"] = list;
            c.Output["count"] = list.Count;
        }

        private static void ListDimensions(OpContext c)
        {
            var list = new List<object>();
            var feat = c.Doc.FirstFeature() as IFeature;
            while (feat != null)
            {
                var dd = feat.GetFirstDisplayDimension() as IDisplayDimension;
                while (dd != null)
                {
                    var dim = dd.GetDimension2(0);
                    if (dim != null)
                        list.Add(new Dictionary<string, object?>
                        {
                            ["name"] = dim.FullName,
                            ["valueMm"] = dim.GetSystemValue3(
                                (int)swInConfigurationOpts_e.swThisConfiguration, null) is double[] v && v.Length > 0
                                ? v[0] * 1000 : 0.0,
                            ["driven"] = dim.DrivenState == (int)swDimensionDrivenState_e.swDimensionDriven
                        });
                    dd = feat.GetNextDisplayDimension(dd) as IDisplayDimension;
                }
                feat = feat.GetNextFeature() as IFeature;
            }
            c.Output["dimensions"] = list;
        }

        private static void ListConfigurations(OpContext c)
        {
            var names = c.Doc.GetConfigurationNames() as string[] ?? new string[0];
            c.Output["configurations"] = names;
            c.Output["active"] = c.Doc.ConfigurationManager.ActiveConfiguration?.Name;
        }

        private static void ListProperties(OpContext c)
        {
            var result = new Dictionary<string, string>();
            var cpm = c.Doc.Extension.CustomPropertyManager[""];
            var names = cpm.GetNames() as string[];
            if (names != null)
                foreach (var n in names)
                {
                    cpm.Get5(n, false, out _, out string resolved, out _);
                    result[n] = resolved ?? "";
                }
            c.Output["properties"] = result;
        }

        private static void ListComponents(OpContext c)
        {
            if ((swDocumentTypes_e)c.Doc.GetType() != swDocumentTypes_e.swDocASSEMBLY)
                throw new OpException(KernelError.PreconditionFailed, "This query needs an assembly.");

            var asm = (AssemblyDoc)c.Doc;
            var comps = asm.GetComponents(false) as object[] ?? new object[0];
            var list = new List<object>();

            foreach (var co in comps)
            {
                if (!(co is IComponent2 comp)) continue;
                list.Add(new Dictionary<string, object?>
                {
                    ["name"] = comp.Name2,
                    ["path"] = comp.GetPathName(),
                    ["configuration"] = comp.ReferencedConfiguration,
                    ["suppressed"] = comp.IsSuppressed(),
                    ["fixed"] = comp.IsFixed()
                });
            }
            c.Output["components"] = list;
            c.Output["count"] = list.Count;
        }

        private static void RebuildErrors(OpContext c)
        {
            var list = new List<object>();
            var feat = c.Doc.FirstFeature() as IFeature;
            while (feat != null)
            {
                int code = feat.GetErrorCode2(out string desc);
                if (code != (int)swFeatureError_e.swFeatureErrorNone)
                    list.Add(new Dictionary<string, object?>
                    {
                        ["feature"] = feat.Name,
                        ["code"] = code,
                        ["description"] = desc
                    });
                feat = feat.GetNextFeature() as IFeature;
            }
            c.Output["errors"] = list;
            c.Output["count"] = list.Count;
        }

        private static void CheckInterference(OpContext c)
        {
            if ((swDocumentTypes_e)c.Doc.GetType() != swDocumentTypes_e.swDocASSEMBLY)
                throw new OpException(KernelError.PreconditionFailed, "Interference detection needs an assembly.");

            var idm = ((AssemblyDoc)c.Doc).InterferenceDetectionManager;
            idm.TreatCoincidenceAsInterference = c.GetBool("coincidenceCounts", false);
            idm.IncludeMultibodyPartInterferences = true;
            idm.UseTransform = false;

            var results = idm.GetInterferences() as object[] ?? new object[0];
            var list = new List<object>();

            foreach (var ro in results)
            {
                if (!(ro is IInterference itf)) continue;
                var comps = itf.Components as object[];
                list.Add(new Dictionary<string, object?>
                {
                    ["volumeMm3"] = itf.Volume * 1e9,
                    ["components"] = ComponentNames(comps)
                });
            }

            c.Output["interferences"] = list;
            c.Output["count"] = list.Count;
        }

        private static void CheckThickness(OpContext c)
        {
            double minMm = c.GetDouble("minWallMm", 2);
            // Reported as a request rather than computed here: real thickness analysis
            // needs the Thickness Analysis add-in, which is not present on every seat.
            // Returning an honest "unavailable" beats returning a fabricated number.
            c.Output["requestedMinWallMm"] = minMm;
            c.Output["available"] = false;
            c.Output["note"] = "Thickness analysis requires the SOLIDWORKS Utilities add-in on this seat.";
        }

        private static void GetBom(OpContext c)
        {
            if ((swDocumentTypes_e)c.Doc.GetType() != swDocumentTypes_e.swDocASSEMBLY)
                throw new OpException(KernelError.PreconditionFailed, "BOM extraction needs an assembly.");

            var asm = (AssemblyDoc)c.Doc;
            var comps = asm.GetComponents(true) as object[] ?? new object[0];
            var rollup = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

            foreach (var co in comps)
            {
                if (!(co is IComponent2 comp) || comp.IsSuppressed()) continue;
                string key = comp.GetPathName() + "|" + comp.ReferencedConfiguration;
                rollup[key] = rollup.TryGetValue(key, out int n) ? n + 1 : 1;
            }

            var lines = new List<object>();
            int item = 1;
            foreach (var kv in rollup)
            {
                var parts = kv.Key.Split('|');
                lines.Add(new Dictionary<string, object?>
                {
                    ["item"] = item++,
                    ["path"] = parts[0],
                    ["configuration"] = parts.Length > 1 ? parts[1] : "",
                    ["qty"] = kv.Value
                });
            }

            c.Output["bom"] = lines;
            c.Output["lineCount"] = lines.Count;
        }

        private static List<string> ComponentNames(object[]? comps)
        {
            var names = new List<string>();
            if (comps == null) return names;
            foreach (var co in comps)
                if (co is IComponent2 comp) names.Add(comp.Name2);
            return names;
        }
    }
}

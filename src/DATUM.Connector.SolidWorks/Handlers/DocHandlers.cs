using System;
using System.Collections.Generic;
using System.IO;
using Datum.Contracts;
using Datum.Connector.SolidWorks.Execution;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Datum.Connector.SolidWorks.Handlers
{
    /// <summary>
    /// Document-level operations: properties, material, export, save, rebuild.
    /// These cover Tier-A problems A3 (metadata entry) and A4 (batch export), which are
    /// pure deterministic wins and need no model at all.
    /// </summary>
    internal static class DocHandlers
    {
        public static void Register(Dictionary<string, OpHandler> h)
        {
            h["doc.set_property"] = SetProperty;
            h["doc.set_properties_bulk"] = SetPropertiesBulk;
            h["doc.delete_property"] = DeleteProperty;
            h["doc.set_material"] = SetMaterial;
            h["doc.rebuild"] = Rebuild;
            h["doc.force_rebuild_all"] = ForceRebuildAll;
            h["doc.save"] = Save;
            h["doc.save_as"] = SaveAs;
            h["doc.export"] = Export;
            h["doc.set_units"] = SetUnits;
            h["doc.capture_screenshot"] = Screenshot;
        }

        private static void SetProperty(OpContext c)
        {
            string name = c.RequireString("name");
            string value = c.GetString("value", "") ?? "";
            string scope = c.GetString("scope", "document") ?? "document";

            var cpm = ResolveProps(c, scope);
            int rc = cpm.Add3(name, (int)swCustomInfoType_e.swCustomInfoText, value,
                              (int)swCustomPropertyAddOption_e.swCustomPropertyReplaceValue);

            // Add3 returns a failure code when the property exists AND the value is
            // identical, which is a success from the caller's point of view.
            if (rc != (int)swCustomInfoAddResult_e.swCustomInfoAddResult_AddedOrChanged &&
                rc != (int)swCustomInfoAddResult_e.swCustomInfoAddResult_GenericFail)
            {
                c.Output["unchanged"] = true;
            }
            c.Output["name"] = name;
        }

        private static void SetPropertiesBulk(OpContext c)
        {
            if (!c.TryGetProp("properties", out var props) ||
                props.ValueKind != System.Text.Json.JsonValueKind.Object)
                throw new OpException(KernelError.PreconditionFailed,
                    "set_properties_bulk needs a 'properties' object.");

            var cpm = ResolveProps(c, c.GetString("scope", "document") ?? "document");
            int n = 0;
            foreach (var p in props.EnumerateObject())
            {
                string v = p.Value.ValueKind == System.Text.Json.JsonValueKind.String
                         ? (p.Value.GetString() ?? "")
                         : p.Value.ToString();
                cpm.Add3(p.Name, (int)swCustomInfoType_e.swCustomInfoText, v,
                         (int)swCustomPropertyAddOption_e.swCustomPropertyReplaceValue);
                n++;
            }
            c.Output["written"] = n;
        }

        private static void DeleteProperty(OpContext c)
        {
            var cpm = ResolveProps(c, c.GetString("scope", "document") ?? "document");
            cpm.Delete2(c.RequireString("name"));
        }

        private static void SetMaterial(OpContext c)
        {
            if ((swDocumentTypes_e)c.Doc.GetType() != swDocumentTypes_e.swDocPART)
                throw new OpException(KernelError.PreconditionFailed, "Materials apply to parts only.");

            string material = c.RequireString("material");
            string db = c.GetString("database", "SOLIDWORKS Materials") ?? "SOLIDWORKS Materials";

            ((PartDoc)c.Doc).SetMaterialPropertyName2(
                c.GetString("configuration", "") ?? "", db, material);

            // SetMaterialPropertyName2 has no return code, so verify by reading back —
            // a silently-ignored material assignment would pass verification otherwise.
            string applied = ((PartDoc)c.Doc).GetMaterialPropertyName2(
                c.GetString("configuration", "") ?? "", out _);
            if (string.IsNullOrEmpty(applied))
                throw new OpException(KernelError.ComFailure,
                    $"Material '{material}' was not applied. Check that it exists in '{db}'.");

            c.Output["material"] = applied;
        }

        private static void Rebuild(OpContext c)
        {
            bool top = c.GetBool("topOnly", false);
            bool ok = top ? c.Doc.EditRebuild3() : c.Doc.ForceRebuild3(false);
            c.Output["ok"] = ok;
            c.Output["errors"] = OpExecutor.CountRebuildErrors(c.Doc);
        }

        private static void ForceRebuildAll(OpContext c)
        {
            c.Doc.ForceRebuild3(true);
            c.Output["errors"] = OpExecutor.CountRebuildErrors(c.Doc);
        }

        private static void Save(OpContext c)
        {
            int err = 0, warn = 0;
            bool ok = c.Doc.Extension.SaveAs3(
                c.Doc.GetPathName(), (int)swSaveAsVersion_e.swSaveAsCurrentVersion,
                (int)swSaveAsOptions_e.swSaveAsOptions_Silent, null, null, ref err, ref warn);

            if (!ok) throw new OpException(KernelError.ComFailure, DescribeSaveError(err));
            c.Output["saved"] = c.Doc.GetPathName();
        }

        private static void SaveAs(OpContext c)
        {
            string path = c.RequireString("path");
            bool overwrite = c.GetBool("overwrite", false);

            if (File.Exists(path) && !overwrite)
                throw new OpException(KernelError.PreconditionFailed,
                    $"'{path}' already exists and the operation did not request overwrite.");

            Directory.CreateDirectory(Path.GetDirectoryName(path) ?? ".");

            int err = 0, warn = 0;
            bool ok = c.Doc.Extension.SaveAs3(
                path, (int)swSaveAsVersion_e.swSaveAsCurrentVersion,
                (int)swSaveAsOptions_e.swSaveAsOptions_Silent, null, null, ref err, ref warn);

            if (!ok) throw new OpException(KernelError.ComFailure, DescribeSaveError(err));
            c.Output["path"] = path;
        }

        /// <summary>
        /// Export honouring per-configuration expansion and a naming template.
        /// Tokens: {Name} {Config} {Rev} {PartNumber} {Date}.
        /// </summary>
        private static void Export(OpContext c)
        {
            string format = (c.GetString("format", "STEP") ?? "STEP").ToUpperInvariant();
            string dir = c.GetString("directory") ?? Path.GetDirectoryName(c.Doc.GetPathName()) ?? ".";
            string template = c.GetString("naming", "{Name}") ?? "{Name}";

            Directory.CreateDirectory(dir);

            string baseName = Path.GetFileNameWithoutExtension(c.Doc.GetPathName());
            if (string.IsNullOrEmpty(baseName)) baseName = c.Doc.GetTitle();

            string resolved = template
                .Replace("{Name}", baseName)
                .Replace("{Config}", c.Doc.ConfigurationManager.ActiveConfiguration?.Name ?? "")
                .Replace("{Rev}", ReadProp(c.Doc, "Revision"))
                .Replace("{PartNumber}", ReadProp(c.Doc, "PartNo"))
                .Replace("{Date}", DateTime.Now.ToString("yyyyMMdd"));

            foreach (char bad in Path.GetInvalidFileNameChars())
                resolved = resolved.Replace(bad, '_');

            string path = Path.Combine(dir, resolved + ExtensionFor(format));

            int err = 0, warn = 0;
            bool ok = c.Doc.Extension.SaveAs3(
                path, (int)swSaveAsVersion_e.swSaveAsCurrentVersion,
                (int)swSaveAsOptions_e.swSaveAsOptions_Silent, null, null, ref err, ref warn);

            if (!ok) throw new OpException(KernelError.ComFailure,
                $"Export to {format} failed: {DescribeSaveError(err)}");

            c.Output["path"] = path;
            c.Output["format"] = format;
        }

        private static void SetUnits(OpContext c)
        {
            string u = (c.GetString("units", "mm") ?? "mm").ToLowerInvariant();
            int sysUnit = u == "in" || u == "inch"
                ? (int)swUnitSystem_e.swUnitSystem_IPS
                : (int)swUnitSystem_e.swUnitSystem_MMGS;
            c.Doc.Extension.SetUserPreferenceInteger(
                (int)swUserPreferenceIntegerValue_e.swUnitSystem, 0, sysUnit);
        }

        private static void Screenshot(OpContext c)
        {
            string path = c.GetString("path")
                ?? Path.Combine(Path.GetTempPath(), "datum_" + Guid.NewGuid().ToString("N") + ".png");
            // ActiveView is typed `object` in the interop, and is null for a document with
            // no open window — the normal case during silent batch processing.
            (c.Doc.ActiveView as IModelView)?.GraphicsRedraw2();
            if (!c.Sw.SaveBMP(path, 0, 0))
                throw new OpException(KernelError.ComFailure, "Screen capture failed.");
            c.Output["path"] = path;
        }

        // ── helpers ─────────────────────────────────────────────────────────────────

        private static ICustomPropertyManager ResolveProps(OpContext c, string scope)
        {
            // "document" writes file-level properties; anything else is treated as a
            // configuration name. Getting this wrong silently writes to the wrong place,
            // which is a classic source of BOM mismatches.
            if (string.Equals(scope, "document", StringComparison.OrdinalIgnoreCase))
                return c.Doc.Extension.CustomPropertyManager[""];

            string cfg = string.Equals(scope, "active", StringComparison.OrdinalIgnoreCase)
                ? (c.Doc.ConfigurationManager.ActiveConfiguration?.Name ?? "")
                : scope;

            return c.Doc.Extension.CustomPropertyManager[cfg];
        }

        private static string ReadProp(IModelDoc2 doc, string name)
        {
            try
            {
                var cpm = doc.Extension.CustomPropertyManager[""];
                cpm.Get5(name, false, out _, out string resolved, out _);
                return resolved ?? "";
            }
            catch { return ""; }
        }

        private static string ExtensionFor(string format)
        {
            switch (format)
            {
                case "STEP": return ".step";
                case "IGES": return ".igs";
                case "PARASOLID": return ".x_t";
                case "STL": return ".stl";
                case "3MF": return ".3mf";
                case "DXF": return ".dxf";
                case "DWG": return ".dwg";
                case "PDF": return ".pdf";
                case "EDRAWINGS": return ".eprt";
                case "JT": return ".jt";
                case "GLTF": return ".gltf";
                default: return "." + format.ToLowerInvariant();
            }
        }

        private static string DescribeSaveError(int err)
        {
            var e = (swFileSaveError_e)err;
            switch (e)
            {
                case swFileSaveError_e.swReadOnlySaveError:
                    return "the file is read-only (check it out of the vault first)";
                case swFileSaveError_e.swFileLockError:
                    return "the file is locked by another process";
                case swFileSaveError_e.swFileNameEmpty:
                    return "no file name was supplied";
                case swFileSaveError_e.swFileSaveFormatNotAvailable:
                    return "that export format is not available on this seat";
                case swFileSaveError_e.swFileNameContainsAtSign:
                    return "the file name contains an '@', which SOLIDWORKS rejects";
                default:
                    return $"SOLIDWORKS save error {err}";
            }
        }
    }
}

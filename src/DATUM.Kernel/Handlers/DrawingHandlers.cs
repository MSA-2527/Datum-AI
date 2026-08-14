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
    /// Drawing automation — the single biggest time sink in the problem inventory (A2),
    /// and the most template-able. Target: template + part → checked, exported drawing
    /// in under 60 seconds against a 20–60 minute manual baseline.
    /// </summary>
    internal static class DrawingHandlers
    {
        public static void Register(Dictionary<string, OpHandler> h)
        {
            h["drw.create_from_model"] = CreateFromModel;
            h["drw.add_view_standard3"] = AddStandard3;
            h["drw.add_view_projected"] = AddProjected;
            h["drw.add_view_section"] = AddSection;
            h["drw.add_view_flat_pattern"] = AddFlatPattern;
            h["drw.import_model_items"] = ImportModelItems;
            h["drw.auto_balloon"] = AutoBalloon;
            h["drw.add_bom"] = AddBom;
            h["drw.fill_title_block"] = FillTitleBlock;
            h["drw.add_note"] = AddNote;
            h["drw.export"] = Export;
        }

        private static DrawingDoc RequireDrawing(OpContext c)
        {
            if ((swDocumentTypes_e)c.Doc.GetType() != swDocumentTypes_e.swDocDRAWING)
                throw new OpException(KernelError.PreconditionFailed,
                    $"'{c.Op.Op}' can only run in a drawing document.");
            return (DrawingDoc)c.Doc;
        }

        private static void CreateFromModel(OpContext c)
        {
            string template = c.RequireString("template");
            string modelPath = c.GetString("modelPath") ?? c.Doc.GetPathName();

            if (!File.Exists(template))
                throw new OpException(KernelError.PreconditionFailed,
                    $"Drawing template not found: {template}");

            var drw = c.Sw.NewDocument(template, (int)swDwgPaperSizes_e.swDwgPapersUserDefined,
                                       c.GetDouble("sheetWidthM", 0.4),
                                       c.GetDouble("sheetHeightM", 0.28)) as IModelDoc2;
            if (drw == null)
                throw new OpException(KernelError.ComFailure, "Could not create the drawing document.");

            c.Output["drawing"] = drw.GetTitle();
            c.Output["modelPath"] = modelPath;
        }

        /// <summary>Places the standard view set in one call, letting SOLIDWORKS handle alignment.</summary>
        private static void AddStandard3(OpContext c)
        {
            var drw = RequireDrawing(c);
            string modelPath = c.RequireString("modelPath");

            // 1 = *Front, 2 = *Top, ... the array positions map to view slots.
            var viewIds = c.GetString("views", "front,top,right,iso") ?? "front,top,right,iso";
            drw.Create3rdAngleViews2(modelPath);

            c.Output["views"] = viewIds;
        }

        private static void AddProjected(OpContext c)
        {
            var drw = RequireDrawing(c);
            string parent = c.RequireString("parentView");
            string direction = c.GetString("direction", "right") ?? "right";

            if (!drw.ActivateView(parent))
                throw new OpException(KernelError.PreconditionFailed, $"No drawing view named '{parent}'.");

            var view = drw.CreateUnfoldedViewAt3(
                c.GetDouble("x", 0.2), c.GetDouble("y", 0.15), 0,
                direction == "left" || direction == "down") as IView;

            if (view == null) throw new OpException(KernelError.ComFailure, "Projected view failed.");
            c.Output["view"] = view.Name;
        }

        private static void AddSection(OpContext c)
        {
            var drw = RequireDrawing(c);
            string parent = c.RequireString("parentView");
            if (!drw.ActivateView(parent))
                throw new OpException(KernelError.PreconditionFailed, $"No drawing view named '{parent}'.");

            // A section needs a sketched line on the parent view; the plan supplies it.
            double[] line = c.GetDoubleArray("line") ?? new double[] { 0, -0.1, 0, 0, 0.1, 0 };
            if (line.Length < 6)
                throw new OpException(KernelError.PreconditionFailed,
                    "Section view needs a 'line' array [x1,y1,z1,x2,y2,z2] in metres.");

            c.Doc.SketchManager.CreateLine(line[0], line[1], line[2], line[3], line[4], line[5]);
            var view = drw.CreateSectionViewAt5(
                c.GetDouble("x", 0.25), c.GetDouble("y", 0.15), 0,
                c.GetString("label", "A") ?? "A",
                (int)swCreateSectionViewAtOptions_e.swCreateSectionView_DisplayOnly, null, 0) as IView;

            if (view == null) throw new OpException(KernelError.ComFailure, "Section view failed.");
            c.Output["view"] = view.Name;
        }

        private static void AddFlatPattern(OpContext c)
        {
            var drw = RequireDrawing(c);
            string modelPath = c.RequireString("modelPath");

            var view = drw.CreateFlatPatternViewFromModelView3(
                modelPath, "", c.GetDouble("x", 0.15), c.GetDouble("y", 0.15), 0,
                c.GetBool("bendLines", true), c.GetBool("bendNotes", true)) as IView;

            if (view == null)
                throw new OpException(KernelError.ComFailure,
                    "Flat pattern view failed — is the model a sheet metal part?");
            c.Output["view"] = view.Name;
        }

        /// <summary>
        /// Pulls the dimensions the modeller already marked for drawing. Starting from
        /// model items rather than dimensioning from scratch preserves design intent and
        /// is why generated drawings match how the part was actually built.
        /// </summary>
        private static void ImportModelItems(OpContext c)
        {
            var drw = RequireDrawing(c);
            string view = c.GetString("view") ?? "";
            if (!string.IsNullOrEmpty(view) && !drw.ActivateView(view))
                throw new OpException(KernelError.PreconditionFailed, $"No drawing view named '{view}'.");

            var ext = c.Doc.Extension;
            var inserted = ext.InsertModelAnnotations3(
                (int)swImportModelItemsSource_e.swImportModelItemsFromEntireModel,
                (int)swInsertAnnotation_e.swInsertDimensionsMarkedForDrawing,
                c.GetBool("allViews", true), c.GetBool("hiddenViews", false),
                false, c.GetBool("includeHoleCallouts", true)) as object[];

            c.Output["annotations"] = inserted?.Length ?? 0;
        }

        private static void AutoBalloon(OpContext c)
        {
            var drw = RequireDrawing(c);
            string view = c.GetString("view") ?? "";
            if (!string.IsNullOrEmpty(view)) drw.ActivateView(view);

            var opts = drw.CreateAutoBalloonOptions();
            opts.Layout = (int)swBalloonLayoutType_e.swDetailingBalloonLayout_Square;
            opts.IgnoreMultiple = true;
            opts.InsertMagneticLine = c.GetBool("magneticLine", true);
            opts.Style = (int)swBalloonStyle_e.swBS_Circular;
            opts.Size = (int)swBalloonFit_e.swBF_2Chars;

            var notes = drw.AutoBalloon5(opts) as object[];
            c.Output["balloons"] = notes?.Length ?? 0;
        }

        private static void AddBom(OpContext c)
        {
            var drw = RequireDrawing(c);
            string template = c.GetString("template", "") ?? "";

            var view = drw.ActiveDrawingView as IView
                       ?? throw new OpException(KernelError.PreconditionFailed, "Activate a drawing view first.");

            var bom = view.InsertBomTable4(
                UseAnchorPoint: c.GetBool("useAnchor", true),
                X: c.GetDouble("x", 0.3), Y: c.GetDouble("y", 0.25),
                AnchorType: (int)swBOMConfigurationAnchorType_e.swBOMConfigurationAnchor_TopLeft,
                BomType: (int)swBomType_e.swBomType_TopLevelOnly,
                Configuration: c.GetString("configuration", "") ?? "",
                TableTemplate: template,
                Hidden: false, IndentedNumberingType: 0, DetailedCutList: false) as IBomTableAnnotation;

            if (bom == null) throw new OpException(KernelError.ComFailure, "BOM insertion failed.");
            c.Output["rows"] = ((ITableAnnotation)bom).RowCount;
        }

        /// <summary>
        /// Fills the sheet-format title block from custom properties, and optionally
        /// writes back any the drawing knows but the model does not.
        /// </summary>
        private static void FillTitleBlock(OpContext c)
        {
            RequireDrawing(c);
            if (!c.TryGetProp("fields", out var fields) ||
                fields.ValueKind != System.Text.Json.JsonValueKind.Object)
                throw new OpException(KernelError.PreconditionFailed, "fill_title_block needs a 'fields' object.");

            var cpm = c.Doc.Extension.CustomPropertyManager[""];
            int n = 0;
            foreach (var f in fields.EnumerateObject())
            {
                string v = f.Value.ValueKind == System.Text.Json.JsonValueKind.String
                         ? (f.Value.GetString() ?? "") : f.Value.ToString();
                cpm.Add3(f.Name, (int)swCustomInfoType_e.swCustomInfoText, v,
                         (int)swCustomPropertyAddOption_e.swCustomPropertyReplaceValue);
                n++;
            }
            c.Output["fields"] = n;
        }

        private static void AddNote(OpContext c)
        {
            string text = c.RequireString("text");
            var note = c.Doc.InsertNote(text) as INote;
            if (note == null) throw new OpException(KernelError.ComFailure, "Note insertion failed.");

            note.SetTextJustification((int)swTextJustification_e.swTextJustificationLeft);
            var ann = note.GetAnnotation() as IAnnotation;
            ann?.SetPosition(c.GetDouble("x", 0.05), c.GetDouble("y", 0.05), 0);
            c.Output["note"] = text;
        }

        private static void Export(OpContext c)
        {
            RequireDrawing(c);
            string format = (c.GetString("format", "PDF") ?? "PDF").ToUpperInvariant();
            string dir = c.GetString("directory") ?? Path.GetDirectoryName(c.Doc.GetPathName()) ?? ".";
            Directory.CreateDirectory(dir);

            string name = Path.GetFileNameWithoutExtension(c.Doc.GetPathName());
            string ext = format == "DXF" ? ".dxf" : format == "DWG" ? ".dwg" : ".pdf";
            string path = Path.Combine(dir, name + ext);

            int err = 0, warn = 0;
            if (!c.Doc.Extension.SaveAs3(path, (int)swSaveAsVersion_e.swSaveAsCurrentVersion,
                    (int)swSaveAsOptions_e.swSaveAsOptions_Silent, null, null, ref err, ref warn))
                throw new OpException(KernelError.ComFailure, $"Drawing export failed (code {err}).");

            c.Output["path"] = path;
        }
    }
}

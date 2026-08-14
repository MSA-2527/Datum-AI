using System;
using System.Collections.Generic;

namespace Datum.Contracts
{
    [Flags]
    public enum OpTraits
    {
        None = 0,
        /// <summary>Makes no change to the document. Safe in Ask mode, never needs confirmation.</summary>
        ReadOnly = 1 << 0,
        /// <summary>Removes data. Always requires explicit confirmation and a snapshot.</summary>
        Destructive = 1 << 1,
        /// <summary>Changes B-Rep topology, so downstream PIDs may need re-resolution.</summary>
        TopologyChange = 1 << 2,
        /// <summary>Touches more than the active configuration.</summary>
        CrossConfig = 1 << 3,
        /// <summary>May invalidate drawings that reference this document.</summary>
        AffectsDrawings = 1 << 4,
        /// <summary>Writes to disk or a vault.</summary>
        Io = 1 << 5,
        /// <summary>Generated code. Requires per-run approval; disabled by enterprise policy.</summary>
        Script = 1 << 6
    }

    /// <summary>Composer mode. Also a hard safety control: the executor rejects ops outside the mode's namespaces.</summary>
    public enum PlanMode { Ask = 0, Build = 1, Edit = 2, Batch = 3 }

    public readonly struct OpSpec
    {
        public readonly string Name;
        public readonly OpTraits Traits;
        /// <summary>Minimum SOLIDWORKS major version exposing the underlying API.</summary>
        public readonly int MinSwVersion;
        /// <summary>Rough cost hint in ms, used for progress estimation only.</summary>
        public readonly int CostMs;

        public OpSpec(string name, OpTraits traits, int minSw = 2022, int costMs = 120)
        {
            Name = name; Traits = traits; MinSwVersion = minSw; CostMs = costMs;
        }
    }

    /// <summary>
    /// The closed operation vocabulary (IR v1.4). A planner may only emit names present here.
    /// Grammar-constrained decoding is generated from this table at build time, which is what
    /// lets a small local model emit structurally valid plans (docs/02-architecture.md §5.2).
    /// </summary>
    public static class OpCatalog
    {
        private static readonly Dictionary<string, OpSpec> Map = Build();

        public static bool TryGet(string name, out OpSpec spec) => Map.TryGetValue(name, out spec);
        public static bool Exists(string name) => Map.ContainsKey(name);
        public static IEnumerable<string> AllNames => Map.Keys;
        public static int Count => Map.Count;

        public static OpTraits TraitsOf(string name) =>
            Map.TryGetValue(name, out var s) ? s.Traits : OpTraits.None;

        public static bool IsReadOnly(string name) => (TraitsOf(name) & OpTraits.ReadOnly) != 0;
        public static bool IsDestructive(string name) => (TraitsOf(name) & OpTraits.Destructive) != 0;
        public static bool IsScript(string name) => (TraitsOf(name) & OpTraits.Script) != 0;

        public static int EstimateMs(string name) =>
            Map.TryGetValue(name, out var s) ? s.CostMs : 120;

        /// <summary>
        /// Mode gating. Ask mode is provably incapable of mutation because the executor
        /// refuses anything without the ReadOnly trait.
        /// </summary>
        public static bool AllowedInMode(string name, PlanMode mode)
        {
            if (!Map.TryGetValue(name, out var spec)) return false;
            switch (mode)
            {
                case PlanMode.Ask:
                    return (spec.Traits & OpTraits.ReadOnly) != 0;
                case PlanMode.Edit:
                    // Edit may not create whole new documents; it modifies what exists.
                    return name != "doc.new_from_template";
                case PlanMode.Build:
                case PlanMode.Batch:
                default:
                    return true;
            }
        }

        public static bool SupportedBy(string name, int swMajorVersion) =>
            Map.TryGetValue(name, out var s) && swMajorVersion >= s.MinSwVersion;

        private static Dictionary<string, OpSpec> Build()
        {
            var d = new Dictionary<string, OpSpec>(256, StringComparer.Ordinal);

            void Add(string name, OpTraits t = OpTraits.None, int minSw = 2022, int cost = 120)
                => d[name] = new OpSpec(name, t, minSw, cost);

            const OpTraits Topo = OpTraits.TopologyChange | OpTraits.AffectsDrawings;
            const OpTraits Del = OpTraits.Destructive | OpTraits.TopologyChange | OpTraits.AffectsDrawings;

            // ── sketch.* ────────────────────────────────────────────────────────────
            Add("sketch.create", OpTraits.None, cost: 60);
            Add("sketch.line", OpTraits.None, cost: 15);
            Add("sketch.arc", OpTraits.None, cost: 15);
            Add("sketch.circle", OpTraits.None, cost: 15);
            Add("sketch.rectangle", OpTraits.None, cost: 25);
            Add("sketch.slot", OpTraits.None, cost: 30);
            Add("sketch.spline", OpTraits.None, cost: 40);
            Add("sketch.polygon", OpTraits.None, cost: 30);
            Add("sketch.text", OpTraits.None, cost: 60);
            Add("sketch.offset", OpTraits.None, cost: 40);
            Add("sketch.trim", OpTraits.None, cost: 40);
            Add("sketch.convert_entities", OpTraits.None, cost: 50);
            Add("sketch.mirror", OpTraits.None, cost: 40);
            Add("sketch.pattern", OpTraits.None, cost: 80);
            Add("sketch.add_relation", OpTraits.None, cost: 20);
            Add("sketch.dimension", OpTraits.None, cost: 30);
            Add("sketch.fully_define", OpTraits.None, cost: 250);
            Add("sketch.close", OpTraits.None, cost: 40);

            // ── feature.* (creation) ────────────────────────────────────────────────
            foreach (var f in new[]
            {
                "extrude","extrude_cut","revolve","revolve_cut","sweep","sweep_cut",
                "loft","loft_cut","boundary","fillet","chamfer","shell","draft","rib",
                "dome","wrap","hole_wizard","simple_hole","thread","pattern_linear",
                "pattern_circular","pattern_sketch_driven","pattern_curve_driven",
                "pattern_fill","mirror","move_copy_body","combine","split","scale","indent"
            })
                Add("feature." + f, Topo, cost: 400);

            Add("feature.reference_plane", OpTraits.None, cost: 80);
            Add("feature.reference_axis", OpTraits.None, cost: 80);
            Add("feature.coordinate_system", OpTraits.None, cost: 80);
            Add("feature.curve", OpTraits.None, cost: 120);

            // ── feature.edit.* ──────────────────────────────────────────────────────
            Add("feature.edit.set_params", Topo, cost: 350);
            Add("feature.edit.rename", OpTraits.None, cost: 40);
            Add("feature.edit.suppress", Topo, cost: 200);
            Add("feature.edit.unsuppress", Topo, cost: 250);
            Add("feature.edit.reorder", Topo, cost: 300);
            Add("feature.edit.delete", Del, cost: 300);
            Add("feature.edit.rollback_to", OpTraits.TopologyChange, cost: 200);
            Add("feature.edit.reattach_reference", Topo, cost: 350);
            Add("feature.edit.change_end_condition", Topo, cost: 300);
            Add("feature.edit.flip_direction", Topo, cost: 250);

            // ── sheetmetal.* ────────────────────────────────────────────────────────
            foreach (var f in new[]
            {
                "base_flange","edge_flange","miter_flange","hem","jog","sketched_bend",
                "closed_corner","corner_relief","unfold","fold","flat_pattern"
            })
                Add("sheetmetal." + f, Topo, cost: 450);
            Add("sheetmetal.set_bend_table", OpTraits.CrossConfig, cost: 150);
            Add("sheetmetal.set_gauge_table", OpTraits.CrossConfig, cost: 150);
            Add("sheetmetal.export_dxf", OpTraits.Io, cost: 900);

            // ── weldment.* ──────────────────────────────────────────────────────────
            foreach (var f in new[] { "structural_member", "trim_extend", "gusset", "end_cap", "weld_bead" })
                Add("weldment." + f, Topo, cost: 500);
            Add("weldment.cut_list_update", OpTraits.None, cost: 300);

            // ── surface.* ───────────────────────────────────────────────────────────
            foreach (var f in new[]
            {
                "extrude","revolve","loft","boundary","fill","knit","trim",
                "offset","thicken","delete_face","radiate","ruled"
            })
                Add("surface." + f, Topo, cost: 450);

            // ── param.* ─────────────────────────────────────────────────────────────
            Add("param.set_dimension", OpTraits.TopologyChange | OpTraits.AffectsDrawings, cost: 150);
            Add("param.set_global", OpTraits.TopologyChange | OpTraits.AffectsDrawings, cost: 150);
            Add("param.add_global", OpTraits.None, cost: 80);
            Add("param.add_equation", OpTraits.TopologyChange, cost: 100);
            Add("param.edit_equation", OpTraits.TopologyChange, cost: 100);
            Add("param.delete_equation", OpTraits.Destructive | OpTraits.TopologyChange, cost: 100);
            Add("param.link_dimension", OpTraits.None, cost: 80);
            Add("param.import_equations", OpTraits.TopologyChange, cost: 300);
            Add("param.goal_seek", OpTraits.TopologyChange, cost: 4000);

            // ── config.* ────────────────────────────────────────────────────────────
            Add("config.create", OpTraits.CrossConfig, cost: 250);
            Add("config.derive", OpTraits.CrossConfig, cost: 250);
            Add("config.activate", OpTraits.TopologyChange, cost: 400);
            Add("config.set_dimension", OpTraits.CrossConfig | OpTraits.TopologyChange, cost: 200);
            Add("config.set_suppression", OpTraits.CrossConfig | OpTraits.TopologyChange, cost: 200);
            Add("config.set_property", OpTraits.CrossConfig, cost: 100);
            Add("config.delete", OpTraits.Destructive | OpTraits.CrossConfig, cost: 200);
            Add("config.design_table_create", OpTraits.CrossConfig, cost: 800);
            Add("config.design_table_update", OpTraits.CrossConfig, cost: 800);
            Add("config.family_table_update", OpTraits.CrossConfig, minSw: 2026, cost: 800);

            // ── asm.* ───────────────────────────────────────────────────────────────
            Add("asm.insert_component", Topo, cost: 600);
            Add("asm.replace_component", Del, cost: 900);
            Add("asm.delete_component", Del, cost: 400);
            Add("asm.mate", OpTraits.TopologyChange, cost: 300);
            Add("asm.mate_by_reference", OpTraits.TopologyChange, cost: 350);
            Add("asm.fasten", Topo, cost: 900);
            Add("asm.pattern_component", Topo, cost: 700);
            Add("asm.mirror_component", Topo, cost: 700);
            Add("asm.set_state", OpTraits.None, cost: 300);
            Add("asm.set_fixed", OpTraits.None, cost: 100);
            Add("asm.move", OpTraits.None, cost: 150);
            Add("asm.smart_fasteners", Topo, cost: 2000);
            Add("asm.explode_step", OpTraits.None, cost: 400);
            Add("asm.flexible_subassembly", OpTraits.TopologyChange, cost: 400);
            Add("asm.envelope", OpTraits.None, cost: 300);

            // ── doc.* ───────────────────────────────────────────────────────────────
            Add("doc.new_from_template", OpTraits.Io, cost: 900);
            Add("doc.open", OpTraits.Io, cost: 1500);
            Add("doc.save", OpTraits.Io, cost: 800);
            Add("doc.save_as", OpTraits.Io | OpTraits.Destructive, cost: 1200);
            Add("doc.close", OpTraits.None, cost: 300);
            Add("doc.set_material", OpTraits.None, cost: 200);
            Add("doc.set_appearance", OpTraits.None, cost: 200);
            Add("doc.set_property", OpTraits.None, cost: 40);
            Add("doc.set_properties_bulk", OpTraits.None, cost: 150);
            Add("doc.delete_property", OpTraits.Destructive, cost: 40);
            Add("doc.set_units", OpTraits.None, cost: 80);
            Add("doc.export", OpTraits.Io, cost: 2000);
            Add("doc.pack_and_go", OpTraits.Io, cost: 4000);
            Add("doc.rebuild", OpTraits.None, cost: 800);
            Add("doc.force_rebuild_all", OpTraits.None, cost: 5000);
            Add("doc.set_view", OpTraits.None, cost: 80);
            Add("doc.capture_screenshot", OpTraits.Io, cost: 300);

            // ── drw.* ───────────────────────────────────────────────────────────────
            Add("drw.create_from_model", OpTraits.Io, cost: 2500);
            Add("drw.add_sheet", OpTraits.None, cost: 400);
            Add("drw.set_sheet_format", OpTraits.None, cost: 400);
            foreach (var v in new[]
            {
                "add_view_standard3","add_view_projected","add_view_section",
                "add_view_detail","add_view_broken_out","add_view_flat_pattern","add_view_exploded"
            })
                Add("drw." + v, OpTraits.None, cost: 700);
            Add("drw.align_views", OpTraits.None, cost: 200);
            Add("drw.import_model_items", OpTraits.None, cost: 900);
            Add("drw.add_dimension", OpTraits.None, cost: 120);
            Add("drw.arrange_dimensions", OpTraits.None, cost: 500);
            Add("drw.add_note", OpTraits.None, cost: 80);
            Add("drw.add_gtol", OpTraits.None, cost: 120);
            Add("drw.add_datum", OpTraits.None, cost: 100);
            Add("drw.add_surface_finish", OpTraits.None, cost: 100);
            Add("drw.add_weld_symbol", OpTraits.None, cost: 100);
            Add("drw.add_center_mark", OpTraits.None, cost: 60);
            Add("drw.add_centerline", OpTraits.None, cost: 60);
            Add("drw.auto_balloon", OpTraits.None, cost: 800);
            Add("drw.add_bom", OpTraits.None, cost: 900);
            Add("drw.add_cut_list_table", OpTraits.None, cost: 700);
            Add("drw.add_revision_table", OpTraits.None, cost: 400);
            Add("drw.fill_title_block", OpTraits.None, cost: 200);
            Add("drw.export", OpTraits.Io, cost: 2500);

            // ── pdm.* ───────────────────────────────────────────────────────────────
            Add("pdm.get_latest", OpTraits.Io, cost: 2000);
            Add("pdm.check_out", OpTraits.Io, cost: 1500);
            Add("pdm.check_in", OpTraits.Io | OpTraits.Destructive, cost: 2500);
            Add("pdm.undo_check_out", OpTraits.Io | OpTraits.Destructive, cost: 1200);
            Add("pdm.set_variable", OpTraits.Io, cost: 400);
            Add("pdm.change_state", OpTraits.Io | OpTraits.Destructive, cost: 1500);
            Add("pdm.add_to_vault", OpTraits.Io, cost: 2000);
            Add("pdm.where_used", OpTraits.ReadOnly, cost: 1500);
            Add("pdm.get_history", OpTraits.ReadOnly, cost: 900);

            // ── query.* (read-only, always free, never confirmed) ────────────────────
            foreach (var q in new[]
            {
                "mass_properties","bounding_box","measure","section_properties",
                "check_interference","check_clearance","check_draft","check_thickness",
                "check_geometry","list_features","list_dimensions","list_configurations",
                "list_properties","list_components","get_bom","where_used",
                "rebuild_errors","compare_documents"
            })
                Add("query." + q, OpTraits.ReadOnly, cost: 300);

            // ── meta.* ──────────────────────────────────────────────────────────────
            Add("meta.assert", OpTraits.ReadOnly, cost: 10);
            Add("meta.snapshot", OpTraits.Io, cost: 500);
            Add("meta.note", OpTraits.ReadOnly, cost: 5);
            Add("meta.ask_user", OpTraits.ReadOnly, cost: 5);
            Add("meta.run_skill", OpTraits.None, cost: 1000);
            Add("meta.run_plan", OpTraits.None, cost: 1000);

            // ── escape hatch ────────────────────────────────────────────────────────
            Add("script.macro", OpTraits.Script | OpTraits.Destructive | OpTraits.TopologyChange, cost: 3000);

            return d;
        }
    }
}

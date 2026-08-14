# DATUM — Product & Capability Specification

> Modules, behaviours, and acceptance criteria. Operation vocabulary lives in `02-architecture.md §2.3`; problem inventory in `01-research.md §3`.

---

## 0. Product statement

**DATUM is a SOLIDWORKS-native design copilot that turns intent into native parametric operations.** It never creates geometry itself — it plans work that SOLIDWORKS executes through its own API, so every result is a real feature tree with real design intent, fully editable by hand afterwards.

Three promises, in priority order:
1. **It will not break your model.** Preview everything, one-keystroke undo, snapshot before apply, verify after.
2. **It works without AI, and without the internet, for free.** The deterministic core is the product; the model is an accelerant.
3. **It lives where you work.** Docked in SOLIDWORKS. No alt-tab for the common case.

---

## 1. Module map

| # | Module | Solves | Free | Pro |
|---|---|---|---|---|
| M1 | **Copilot Panel** (chat + plan + apply) | A1–A10, all inputs | ✅ local/BYO | ✅ frontier + agent loop |
| M2 | **Model Explorer** (live tree, params, health) | A6, B1, B10 | ✅ | ✅ |
| M3 | **Parameter Inspector** (live sliders, equations, goal-seek) | A1, B5 | ✅ | ✅ + AI goal-seek |
| M4 | **Skills** (parametric generators) | A1, B7, C2 | ✅ run/author/version | ✅ AI-authored, org library |
| M5 | **Batch Runner** | A3, A4, A9, B2 | ✅ ≤25 targets | ✅ unlimited, scheduled, multi-instance |
| M6 | **Drawing Autopilot** | A2 | ✅ template-driven | ✅ AI view/dim judgement |
| M7 | **Standards & Linter** | A10, B1, C3 | ✅ built-in packs | ✅ AI rule authoring, org enforcement |
| M8 | **Reuse Index** (find, don't remodel) | A8, B2 | ✅ local folders | ✅ org + PDM + geometry search |
| M9 | **Repair Assistant** | A6, B4 | ✅ rule-based | ✅ AI diagnosis + self-repair |
| M10 | **Impact Analysis** (where-used, dependency graph) | A9, B2 | ✅ local | ✅ vault-wide |
| M11 | **Vault Bridge** (PDM/PLM) | C1 | ✅ read + lock gating | ✅ workflow automation |
| M12 | **History & Audit** (op log, snapshots, rationale) | B6, C3 | ✅ | ✅ + export/attach to revision |
| M13 | **Assembly Studio** (insert, mate, fasten, interfere) | A5, B8 | ✅ deterministic ops | ✅ AI mating strategy, generation |
| M14 | **Settings & Providers** | C4, C5 | ✅ | ✅ |

---

## 2. M1 — Copilot Panel

The daily driver. Lives in the SOLIDWORKS Task Pane (WebView2), also available as the right rail of Studio.

### 2.1 Modes

The composer has four modes, switchable with `Tab` or the mode chip:

| Mode | Icon | Behaviour | Mutates? |
|---|---|---|---|
| **Ask** | `?` | Answers questions about the model, standards, or SOLIDWORKS itself. Runs `query.*` ops freely. | No |
| **Build** | `+` | Creates new geometry, features, parts, assemblies, drawings. | Yes, after preview |
| **Edit** | `~` | Modifies what exists — dims, features, properties, configs. Strongly prefers `param.*` and `feature.edit.*` over re-creating geometry. | Yes, after preview |
| **Batch** | `⧉` | Same prompt, applied across a target set. Opens the target picker inline. | Yes, after dry run |

Mode changes the system prompt, the allowed op namespaces, and the confirmation policy. It is a *safety* control as much as a UX one — Ask mode is provably incapable of mutation because the executor rejects non-`query.*` ops for that mode.

### 2.2 Composer inputs (implementing `01-research.md §4`)

| Input | Affordance |
|---|---|
| Text (I1) | Main textarea. `/` opens the command palette, `@` opens the reference picker. |
| Selection (I2) | Live chip above the composer: *"3 faces, 1 edge selected"* — click to expand into named tokens. Auto-included unless dismissed. |
| Voice (I3) | Mic button; push-to-talk with `Ctrl+Space`. Live transcript in the composer, editable before send. |
| Direct numeric (I4) | `@Length = 62` typed in the composer bypasses the planner entirely (parsed deterministically, zero tokens, zero cost). |
| Constraints (I5) | `/constrain` opens a persistent constraint card: envelope, min wall, mass target, material, cost. Pinned to the document; the linter enforces it continuously. |
| Images (I6, I7) | Drag-drop, paste from clipboard, or **"Capture viewport"** button which grabs the SOLIDWORKS graphics area for markup. A built-in annotator lets the user draw arrows and type dimensions on it. |
| Drawing PDF/DWG (I8) | Drag-drop → extraction preview showing detected views + dimensions before planning. |
| Reference 3D file (I9) | Drag-drop `.STEP/.SLDPRT/...` → becomes a `@ref` token with a thumbnail. |
| Spreadsheet (I10) | Drag-drop → column mapper → Variant Matrix. |
| Datasheet PDF (I11) | Drag-drop → extracted parameter table (bolt circle, shaft Ø, envelope) shown for confirmation. |
| Existing macro (I12) | Drag `.swp` → "Convert to Skill" flow. |
| Record actions (I13) | Record button → user works in SOLIDWORKS → stop → generalised Skill draft with detected parameters. |
| Standards docs (I14) | Settings → Standards → Import (Pro for AI extraction; free accepts hand-written rule JSON). |
| Target sets (I15, I16) | Batch mode target picker: folder, glob, vault query, BOM paste, current assembly, where-used results. |
| Templates (I17) | `@template:` token. |
| Prior transcripts (I18) | History → "Replay on…" → pick a new target. |
| Tree drag (I19) | Drag any feature/component from the SOLIDWORKS tree into the composer → `@Feature` token bound to its PID. |
| Context menu (I20) | Right-click in the graphics area or tree → *Ask DATUM* / *Edit with DATUM* / *Lint this*. |

### 2.3 The plan card

The core UI object. States: `streaming` → `resolving` → `ready` → `running` → `done` | `failed` | `rolled_back`.

Contents:
- **Intent line** — one-sentence restatement of what it understood. If this is wrong, the user knows immediately, before anything happens.
- **Assumptions** — explicit list. *"Assumed M3 clearance, normal fit"*. Each is clickable to change and re-plan. This is where trust is won: an AI that states its assumptions is auditable.
- **Op list** — one row per op: icon, human sentence (*"Fillet 12 vertical edges, R3"*), resolved target count, risk badge, expand for raw params.
- **Affected preview** — hovering an op highlights its resolved targets in the SOLIDWORKS viewport in real time (via `IModelDoc2.Extension.SelectByID2` on a temp selection mark, cleared on blur).
- **Predicted tree diff** — a before/after feature tree with `+` / `~` / `−` markers.
- **Risk badges** — `destructive`, `topology-change`, `crosses-configs`, `affects-drawings`, `unresolved-reference`, `outside-standards`.
- **Footer** — `Preview in scratch` · `Apply` · `Apply & remember as Skill` · `Discard`. Keyboard: `Enter` applies, `Esc` discards.

Every op row is editable in place. Users who know exactly what they want will edit params directly rather than re-prompt — support that, it's the power-user path.

### 2.4 The result card

- Outcome badge, elapsed time, ops succeeded/failed.
- **Verify block** — rebuild errors before/after, mass before/after with Δ%, interference count, linter score delta. Green/amber/red per check.
- **Undo** button (single click = `Ctrl+Z` equivalent) plus **Restore snapshot** for the belt-and-braces case.
- **Save as Skill** — promotes this plan into a reusable parametric generator, auto-detecting which literals should become inputs.
- **Explain** — generates a design-rationale note (B6) and can write it to a custom property or the op log.

### 2.5 Acceptance criteria

- Panel first paint < 400 ms after SOLIDWORKS finishes loading add-ins.
- Selection chip updates within 100 ms of a selection change in SOLIDWORKS.
- A single-op edit plan (local model) completes prompt→preview in < 4 s on a mid-range workstation with no GPU.
- Applying a 50-op plan on a 500-feature part completes in < 15 s.
- `Ctrl+Z` immediately after any apply restores the exact prior state, verified by mass-property and feature-count equality.
- Panel never blocks the SOLIDWORKS UI thread for more than 16 ms in any single handler.

---

## 3. M2 — Model Explorer

A live mirror of the active document, but *enriched* in ways SOLIDWORKS's own tree isn't.

- **Tree** with health overlay: error/warning badges from `GetErrorCode2`, linter findings, "fragile reference" markers on features that depend on model faces rather than datums.
- **Filter bar**: by feature type, by error state, by "created by DATUM", by "not fully defined", by "unnamed".
- **Feature detail drawer**: parameters read from `GetDefinition()`, parents/children dependency list, the sketch's constraint status, and which configs it's suppressed in.
- **Bidirectional selection**: clicking in DATUM selects in SOLIDWORKS and vice versa.
- **Search**: `Ctrl+F` fuzzy over feature names, dimension names, and property values.
- **Health header**: feature count, rebuild time, error count, file size, config count, last rebuild — the numbers that predict whether a model is about to become a maintenance problem.

Assembly mode swaps in the component tree with resolve state, mate list per component, and a fixed/floating indicator.

---

## 4. M3 — Parameter Inspector

The highest-frequency, zero-AI, always-free surface. This is the module that earns daily usage even from people who distrust AI.

- Table of **global variables** and **named dimensions** with current value, units, driving equation, and which features consume them.
- **Live slider** per numeric parameter with sensible min/max inferred from the model's bounding box (overridable). Dragging rebuilds live (debounced, §4.2 of the architecture doc).
- **Equation editor** with syntax highlighting, dependency validation, and a live evaluation preview — catches circular references before you commit them.
- **Linked readouts**: mass, volume, surface area, bounding box, CoG update live as you drag.
- **Goal seek**: pick a target (mass = 250 g), pick free variables, set bounds → DATUM runs a bounded search using `IMassProperty` feedback after each rebuild. Free tier uses a deterministic bisection/Nelder–Mead; Pro adds AI-chosen variable selection and multi-objective handling.
- **Variant Matrix**: a spreadsheet-like grid of configurations × parameters. Paste from Excel (I10), edit inline, then commit as configurations, a design table, or a family table. Live preview thumbnails per row.
- **Snapshot/compare**: save a parameter set, restore it, diff two sets.

---

## 5. M4 — Skills

A **Skill** is a versioned, typed, parametric generator: an input schema plus an op template. It is the mechanism that converts a one-off AI success into permanent, deterministic, free capability.

```jsonc
{
  "id": "skl_mounting_plate",
  "name": "ACME Mounting Plate",
  "version": "2.1.0",
  "owner": "s.ahmad",
  "description": "Standard plate with configurable bolt pattern and cable cutout.",
  "inputs": [
    { "key": "width",  "type": "length", "min": 20, "max": 400, "default": 120, "unit": "mm" },
    { "key": "height", "type": "length", "min": 20, "max": 400, "default": 80 },
    { "key": "thickness", "type": "enum", "values": [3, 4, 5, 6, 8, 10], "default": 5 },
    { "key": "boltPattern", "type": "enum", "values": ["NEMA17", "NEMA23", "custom"] },
    { "key": "material", "type": "material", "default": "6061-T6" }
  ],
  "guards": [
    { "assert": "thickness >= 3", "message": "Below minimum stock thickness" },
    { "assert": "width * height <= 160000", "message": "Exceeds available stock sheet" }
  ],
  "ops": [ /* Operation IR template with ${input} interpolation */ ],
  "tests": [
    { "inputs": { "width": 120, "height": 80, "thickness": 5, "boltPattern": "NEMA17" },
      "expect": { "rebuildErrors": 0, "massG": { "min": 120, "max": 140 }, "featureCount": 7 } }
  ]
}
```

Behaviours:
- **Run** from a generated form (inputs render as typed controls with live validation), from the composer (`/skill mounting-plate width=140`), or from a Batch.
- **Author** three ways: hand-write the JSON; promote a successful plan ("Save as Skill" auto-detects parameterisable literals); or record UI actions (I13). Pro adds "describe it and I'll write the Skill".
- **Import legacy macros** (I12): parse a `.swp`, map recognised API calls onto the Operation IR, flag the parts it couldn't map, and leave those as a reviewed `script.macro` op.
- **Test on save.** Skills carry test cases that run against a scratch document. A skill that fails its tests is marked broken in the library rather than silently rotting (this is the direct answer to C2, macro rot).
- **Version + provenance.** SemVer, changelog, owner, usage count, last-run status. Org-shared skills (Pro) sync from a team library with approval workflow.

---

## 6. M5 — Batch Runner

1. **Choose targets** — folder (recursive, with glob), current assembly components, BOM paste, saved search, vault query (Pro), where-used results, or a `.txt` list. Live count + preview grid with thumbnails.
2. **Choose the operation** — a Skill, a saved plan, a prompt (planned once, replayed per file with per-file context re-resolution), or a built-in recipe (export, property set, drawing generation, flat-pattern DXF, upgrade file version).
3. **Configure** — output naming template with tokens (`{PartNumber}_{Config}_{Rev}`), destination, conflict policy, per-configuration expansion, PDM check-out policy.
4. **Dry run** — executes against copies in a temp tree; produces a report grid with per-file outcome, diffs, and warnings. Free tier: dry run capped at 25 files (same as the run cap). 
5. **Run** — live grid: file, status, duration, output paths, errors. Pause / resume / cancel. Dead-letter list with one-click retry.
6. **Report** — CSV/PDF summary, attachable to a change order.

Built-in recipes shipped free: batch export (STEP/PDF/DXF/STL/3MF), property fill from rules, sheet-metal flat DXF, drawing generation, thumbnail regeneration, file version upgrade, linter sweep, index rebuild.

---

## 7. M6 — Drawing Autopilot

The largest single time sink (A2), and highly template-able.

**Pipeline:** pick template → place views → import model items → arrange → annotate → balloon + BOM → title block → check → export.

- **Templates** encode: sheet format, view set (e.g. front/top/right/iso, or flat-pattern + formed for sheet metal), scale policy, dimension standard, layer mapping, annotation styles, title-block field mapping.
- **View placement** uses `CreateDrawingViewFromModelView3` with automatic scale-to-fit and collision-free arrangement. Section and detail views are placed from declared rules ("section through the largest cylindrical feature") or, in Pro, chosen by the model.
- **Dimensioning** starts with `InsertModelAnnotations3` (marked-for-drawing dims), then de-clutters: removes duplicates, spaces to standard offsets, moves to the most readable view. Pro adds judgement about which dims a machinist actually needs.
- **Balloons + BOM** via `AutoBalloon5` and `InsertBomTable4`, with the company BOM template and item-number sync.
- **Title block** filled from custom properties, with the reverse direction too (fill missing properties from the drawing).
- **Standards check** runs the drawing rule pack before export: missing views, unballooned items, dimensions outside the sheet, missing tolerance block, wrong sheet format, unreferenced notes.
- **Export** to PDF/DWG/DXF with the naming template.

Acceptance: for a typical machined part with an existing template, drawing → checked → exported in **under 60 seconds**, against a manual baseline of 20–60 minutes.

---

## 8. M7 — Standards & Linter

- **Rule packs**: built-in (free), company (authored or AI-extracted from your standards documents, Pro), project-scoped overrides.
- **Live linting** on rebuild, debounced. Findings appear as badges in the Model Explorer and a rolled-up count in the panel header.
- **Finding card**: severity, rule, what's wrong, why it matters, and — where a `fix` exists — a one-click **Fix** that runs through the normal preview/apply/undo pipeline.
- **Suppress with reason.** Every suppression is recorded with a justification and an owner; suppressions are visible in review. (An unauditable "ignore" button destroys the value of a linter.)
- **Gate mode** (Pro/enterprise): block PDM check-in or state change while errors exist.
- **Health score** per document with trend over time, so teams can see model quality moving.

---

## 9. M8 — Reuse Index

- Background crawl of configured folders; incremental update on save; optional vault-wide index (Pro).
- Search by text, by geometry (drop a file or point at the current body), or by both.
- **Proactive interception**: when a Build-mode prompt describes something that resembles an indexed part above a similarity threshold, the plan card is preceded by a *"3 similar parts already exist"* card with thumbnails, part numbers, where-used counts, and a one-click *Insert instead*.
- **Duplicate audit**: batch job that reports near-identical parts across a folder or vault, ranked by consolidation value.

---

## 10. M9 — Repair Assistant

Triggered from a rebuild error, a linter finding, or explicitly.

- Reads `GetErrorCode2` per feature, walks the dependency chain to find the **root** failure rather than the symptom.
- Common repairs it offers, each as a previewable plan: re-attach a dangling sketch reference to an equivalent PID; replace a fragile face reference with a datum plane; fix an over-defined sketch by removing the redundant relation; repair a broken external reference; restore a deleted parent by rolling back and re-creating; convert a failed pattern seed.
- Pro adds a **self-repair loop**: apply → verify → if verification fails, diagnose and retry (bounded attempts, every attempt logged, always ending in either a verified-good state or a full rollback).

---

## 11. M10 — Impact Analysis

Before a change: *what will this break?*

- Parametric dependency graph within the document (dimension → equation → feature → config).
- Cross-document: where-used (assemblies, drawings) from the local index or the vault.
- **Blast radius view**: a graph/list of affected files with an estimate of rebuild cost and which drawings will need re-checking.
- Feeds directly into Batch: *"apply the change to all 34 affected files"*.

---

## 12. M11 — Vault Bridge

- Read vault state for every open document: checked out by whom, version, state, workflow.
- **Hard gate**: DATUM refuses to mutate a file it doesn't hold a lock on. Offers `pdm.check_out` inline.
- Variable mapping between SOLIDWORKS custom properties and PDM variables, with conflict detection.
- Pro: automated check-out → operate → check-in with comment, state transitions, revision bump, batch vault operations, and attaching the DATUM op log to the revision as evidence of what changed.

---

## 13. M12 — History & Audit

- Per-document timeline: every plan, who ran it, when, which model authored it, what changed, verification results.
- Diff view between any two points (feature tree diff + parameter diff + mass diff).
- Snapshot restore.
- **Replay**: run a historical plan against a different document.
- **Design rationale export**: readable narrative of why the model is the way it is, generated from the intent lines and assumptions in the op log — the answer to "the person who built this left" (B6).

---

## 14. M13 — Assembly Studio

- Component insert with mate-reference-aware auto-mating; `asm.fasten` inserts a full fastener stack (screw + washer + nut) into a recognised hole and mates it, then follows hole patterns automatically (A5).
- Mate audit: over-defined mates, redundant mates, mates to fragile faces.
- Interference and clearance verification run automatically after any assembly-mutating plan (B8).
- Component pattern/mirror, replace-component with mate re-mapping, sub-assembly extraction.
- Pro: generate an assembly structure from a description, choose mating strategy, and iterate to a non-interfering state.

---

## 15. M14 — Settings & Providers

- **Providers**: pick and rank Local / BYO-key / Pro per task class. Model download manager for local GGUF models with size, RAM/VRAM requirement, and an honest capability rating for CAD planning.
- **Egress ledger**: default local-only; a per-request preview of exactly what would be sent; a running log of everything that has been sent.
- **Policy**: auto-apply rules (per mode, per skill), destructive-op confirmation, snapshot retention, batch caps.
- **Standards, templates, export profiles, naming templates.**
- **Enterprise**: admin-locked settings via GPO, SSO, shared skill/standards library, audit export, telemetry controls.

---

## 16. Problem → module traceability

Every problem from `01-research.md §3` must be addressed. Nothing is left unmapped.

| Problem | Modules |
|---|---|
| A1 Variant design | M3 (Variant Matrix), M4 (Skills), M5 |
| A2 Drawings | M6, M5 |
| A3 Metadata | M5, M7, M11 |
| A4 Batch export | M5 |
| A5 Hardware mating | M13, M4 |
| A6 Rebuild errors | M9, M2 |
| A7 Sheet metal DXF | M5 (recipe), M1 (`sheetmetal.*`) |
| A8 Find don't remodel | M8 |
| A9 Change propagation | M10 → M5 |
| A10 Standards | M7, M6 |
| B1 Sketch quality | M7, M2 |
| B2 BOM / where-used | M10, M6, M5 |
| B3 Napkin sketch | M1 (I6) |
| B4 Dumb solids | M9, M1 |
| B5 Mass targets | M3 (goal seek) |
| B6 Rationale | M12 |
| B7 Onboarding | M4 |
| B8 Interference | M13 |
| B9 Config sprawl | M3, M7 |
| B10 Quick queries | M1 (Ask), M2 |
| C1 PDM friction | M11 |
| C2 Macro rot | M4 (tests, versions, import) |
| C3 Audit trail | M12 |
| C4 Cost | Free tier (M1–M14 deterministic core) |
| C5 IP leakage | M14 (egress ledger, local-only default) |

---

## 17. Release plan

| Milestone | Scope | Proves |
|---|---|---|
| **M0 — Spike** (3 wks) | Kernel add-in + idle pump + one op (`param.set_global`) + task pane WebView2 round-trip | The architecture is sound; latency is real |
| **M1 — Deterministic core** (8 wks) | Op executor for `param/doc/query/feature.edit`, Model Explorer, Parameter Inspector, undo scope, op log, snapshots | **Useful with zero AI.** Shippable as free alpha. |
| **M2 — Planner** (6 wks) | Operation IR, validator, local model + GBNF, BYO key, plan/preview/apply loop | The AI loop is safe |
| **M3 — Automation** (8 wks) | Skills, Batch Runner, Standards & Linter, export recipes | Covers the 80% repetitive time |
| **M4 — Drawings** (6 wks) | Drawing Autopilot + templates + drawing rule pack | The single biggest time win |
| **M5 — Pro** (8 wks) | Managed frontier models, vision inputs, agent loop with self-repair, assembly generation | The upgrade is worth paying for |
| **M6 — Scale** (8 wks) | Reuse Index, Impact Analysis, Vault Bridge, team library, enterprise deployment | Org-level value |

---

## 18. Metrics that matter

- **Time-to-first-value**: install → first successful applied plan. Target < 5 minutes.
- **Undo rate**: fraction of applied plans undone within 60 s. Target < 8%. This is the trust metric — if it rises, the planner is wrong or previews are unclear.
- **Preview-to-apply rate**: fraction of previewed plans applied. Target > 70%.
- **Deterministic share**: fraction of executed ops originating from Skills/recipes rather than fresh LLM plans. Should *rise* over time in a healthy account — it means the org is converting AI wins into permanent free capability.
- **Free-tier weekly retention**: the free tier must stand alone. Target > 40% W4.
- **Model health delta**: linter score trend across a team's files.
- **SOLIDWORKS stability**: crashes-per-session attributable to DATUM. Target ≈ 0. Non-negotiable.

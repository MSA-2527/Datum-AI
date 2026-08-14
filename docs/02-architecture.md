# DATUM — System Architecture

> Companion to `01-research.md`. Every decision here traces back to a constraint documented there.

---

## 1. The three-process model

The 100× in-process/out-of-process performance gap and the STA threading constraint force the shape of this system. There is no design freedom here — get this wrong and the product is unusable.

```
┌──────────────────────────────── SLDWORKS.exe (STA) ────────────────────────────────┐
│                                                                                     │
│   ┌───────────────────────────────────────────────────────────────────────────┐    │
│   │  DATUM.Kernel  —  in-process add-in (ISwAddin, .NET Framework 4.8)         │    │
│   │                                                                            │    │
│   │   OpExecutor        typed op → SOLIDWORKS API calls, on the STA thread     │    │
│   │   IdlePump          drains the work queue on OnIdleNotify                  │    │
│   │   EventTap          all swSldWorks/Part/Assembly/Drawing notifications     │    │
│   │   ContextReader     tree, params, selection, mass, errors, PDM state       │    │
│   │   PidResolver       GetPersistReference3 / GetObjectByPersistReference3    │    │
│   │   UndoScope         StartRecordingUndoObject … FinishRecordingUndoObject   │    │
│   │   SnapshotSvc       pre-apply file snapshot + scratch-copy dry runs        │    │
│   │   HostUI            CommandManager tab, context menus, PMPages,            │    │
│   │                     TaskpaneView ▸ WebView2  ◀── renders the React app     │    │
│   └────────────────────────────────┬──────────────────────────────────────────┘    │
└────────────────────────────────────│───────────────────────────────────────────────┘
                                     │  duplex gRPC over named pipe
                                     │  (\\.\pipe\datum.kernel.<swpid>)
                                     ▼
┌──────────────────────── DATUM.Orchestrator (Windows service / tray, .NET 8) ───────┐
│                                                                                     │
│   SessionManager      one session per SOLIDWORKS process; multi-seat aware          │
│   Planner             LLM tool-use loop → Operation IR                              │
│   ProviderRouter      Local(llama.cpp) │ BYO-key │ Managed-Pro  — hot-swappable     │
│   Validator           JSON-Schema + precondition + policy checks on every plan      │
│   PolicyEngine        standards, guardrails, egress ledger, tier gating             │
│   SkillRuntime        parametric generators (typed inputs → op template)            │
│   BatchEngine         target-set expansion, concurrency, resume, dead-letter        │
│   IndexSvc            geometry fingerprints + text embeddings (part reuse)          │
│   Store               SQLite: sessions, op log, skills, standards, snapshots        │
│   ApiGateway          Kestrel: localhost HTTPS + WebSocket (loopback, token auth)   │
└────────────────────────────────────┬───────────────────────────────────────────────┘
                                     │  WebSocket (state deltas) + HTTP (commands)
                                     ▼
┌──────────────────────── DATUM.Studio (WPF shell + WebView2, .NET 8) ───────────────┐
│   Standalone window: Batch, Skills, Standards, Index, History, Settings             │
│   Same React bundle as the Task Pane, different route + layout mode                 │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### Why three processes and not two

- **Kernel must be in-process** — non-negotiable (100× perf, STA).
- **Orchestrator must be out-of-process** — it runs a local LLM (GPU, GBs of RAM), does embedding, batch scheduling, and file I/O. Running any of that inside `SLDWORKS.exe` would destabilise the host and tie its lifetime to SOLIDWORKS. It also survives a SOLIDWORKS crash, so history and queued batches aren't lost.
- **Studio is a thin shell** — it's the same web app; it exists because some work (batch of 4,000 files, skill authoring, index browsing) needs more than a 450 px task pane.

### Why not .NET 8 for the Kernel

In-process .NET 8 COM add-ins are technically possible but fragile: runtime-loading conflicts with other add-ins in the same process, `hostfxr` initialisation order, and the fact that SOLIDWORKS itself and most of the add-in ecosystem are .NET Framework. **Kernel = .NET Framework 4.8, deliberately boring.** It contains no AI, no HTTP stack, no heavy dependencies — just interop, a queue, and a pipe client. The Orchestrator gets .NET 8 and all the interesting libraries.

---

## 2. The Operation IR — the contract at the centre of everything

This is the most important artefact in the system. **The LLM never writes code that touches SOLIDWORKS.** It emits a `Plan`: an ordered list of typed `Operation` objects from a closed, versioned vocabulary. The Kernel is the only thing that knows how to turn an `Operation` into API calls.

Consequences:
- The model cannot invent an API call, so it cannot corrupt a model in a way we didn't anticipate.
- Plans are **diffable** (show the user what will change), **replayable** (run the same plan on another file), **serialisable** (store in the op log, attach to a revision), and **editable by hand** (power users tweak a param without re-prompting).
- Grammar-constrained decoding against the schema means even a small local model emits *valid* ops.
- Deterministic subsystems (Skills, Batch, Drawing Autopilot) emit the same IR — so the free, no-AI path and the AI path share one executor and one safety model.

### 2.1 Shape

```jsonc
{
  "planId": "pln_01J...",
  "irVersion": "1.4",
  "target": { "docPath": "D:\\Projects\\ACME\\bracket.SLDPRT", "configuration": "Default" },
  "intent": "Add mounting holes for a NEMA 17 and fillet the outer corners",
  "assumptions": [
    "NEMA 17 bolt circle 31 mm square pattern, M3 clearance",
    "Fillet radius 3 mm chosen to match existing R3 on Boss-Extrude1"
  ],
  "ops": [
    {
      "id": "op1",
      "op": "feature.hole_wizard",
      "target": { "kind": "pid", "pid": "AQAAAA...", "label": "Face<1> of Boss-Extrude1" },
      "params": {
        "standard": "ISO", "type": "clearance", "fastener": "M3",
        "fit": "normal", "endCondition": "through_all",
        "positions": [[15.5,15.5],[-15.5,15.5],[-15.5,-15.5],[15.5,-15.5]],
        "units": "mm"
      },
      "preconditions": [
        { "check": "pid_resolves", "ref": "AQAAAA..." },
        { "check": "face_is_planar" },
        { "check": "doc_is_writable" }
      ],
      "reversible": true,
      "estimatedMs": 900
    },
    {
      "id": "op2",
      "op": "feature.fillet",
      "dependsOn": ["op1"],
      "target": { "kind": "query", "query": "edges(vertical, of: Boss-Extrude1, convex: true)" },
      "params": { "type": "constant", "radius": 3.0, "units": "mm", "propagate": true }
    }
  ],
  "verify": [
    { "check": "rebuild_errors", "expect": 0 },
    { "check": "mass_delta_pct", "max": 15 },
    { "check": "linter_score_not_worse" }
  ],
  "undo": { "groupName": "DATUM: NEMA 17 mounting + corner fillets" }
}
```

### 2.2 Target resolution — three kinds, in strict order of preference

| Kind | Form | When used |
|---|---|---|
| `pid` | Persistent Reference ID blob | Always preferred. Survives rebuild, session, version. |
| `selection` | `@selection[0..n]` | What the user had highlighted when they typed. Resolved to PIDs at plan time. |
| `query` | Declarative geometric query, e.g. `faces(normal: +Z, area: >100)`, `edges(convex, length: >20)` | When intent is set-based ("all vertical edges"). Evaluated by the Kernel's query engine, **and the resolved set is shown in the preview before apply.** |
| `name` | `"Fillet3"` | Discouraged. Only for features the user named explicitly. Flagged as fragile by the linter. |

If a `pid` fails to resolve at apply time, **the plan halts.** It never falls back to "nearest similar entity" — that is how AI silently destroys models.

### 2.3 Operation vocabulary (v1.4)

Grouped by namespace. Every op is: declarative, idempotent where possible, and individually reversible or explicitly marked destructive.

**`sketch.*`** — `create`, `line`, `arc`, `circle`, `rectangle`, `slot`, `spline`, `polygon`, `text`, `offset`, `trim`, `convert_entities`, `mirror`, `pattern`, `add_relation`, `dimension`, `fully_define`, `close`

**`feature.*`** — `extrude`, `extrude_cut`, `revolve`, `revolve_cut`, `sweep`, `sweep_cut`, `loft`, `loft_cut`, `boundary`, `fillet`, `chamfer`, `shell`, `draft`, `rib`, `dome`, `wrap`, `hole_wizard`, `simple_hole`, `thread`, `pattern_linear`, `pattern_circular`, `pattern_sketch_driven`, `pattern_curve_driven`, `pattern_fill`, `mirror`, `move_copy_body`, `combine`, `split`, `scale`, `indent`, `reference_plane`, `reference_axis`, `coordinate_system`, `curve`

**`feature.edit.*`** — `set_params` (GetDefinition→AccessSelections→ModifyDefinition), `rename`, `suppress`, `unsuppress`, `reorder`, `delete`, `rollback_to`, `reattach_reference`, `change_end_condition`, `flip_direction`

**`sheetmetal.*`** — `base_flange`, `edge_flange`, `miter_flange`, `hem`, `jog`, `sketched_bend`, `closed_corner`, `corner_relief`, `unfold`, `fold`, `flat_pattern`, `set_bend_table`, `set_gauge_table`, `export_dxf`

**`weldment.*`** — `structural_member`, `trim_extend`, `gusset`, `end_cap`, `weld_bead`, `cut_list_update`

**`surface.*`** — `extrude`, `revolve`, `loft`, `boundary`, `fill`, `knit`, `trim`, `offset`, `thicken`, `delete_face`, `radiate`, `ruled`

**`param.*`** — `set_dimension`, `set_global`, `add_global`, `add_equation`, `edit_equation`, `delete_equation`, `link_dimension`, `import_equations`, `goal_seek`

**`config.*`** — `create`, `derive`, `activate`, `set_dimension`, `set_suppression`, `set_property`, `delete`, `design_table_create`, `design_table_update`, `family_table_update`

**`asm.*`** — `insert_component`, `replace_component`, `delete_component`, `mate` (coincident, concentric, parallel, perpendicular, tangent, distance, angle, lock, width, symmetric, path, gear, cam, limit, screw), `mate_by_reference`, `fasten` (hole-aware fastener stack: screw+washer+nut, auto-mated), `pattern_component`, `mirror_component`, `set_state` (resolved/lightweight/suppressed), `set_fixed`, `move`, `smart_fasteners`, `explode_step`, `flexible_subassembly`, `envelope`

**`doc.*`** — `new_from_template`, `open`, `save`, `save_as`, `close`, `set_material`, `set_appearance`, `set_property`, `set_properties_bulk`, `delete_property`, `set_units`, `export` (STEP, IGES, Parasolid, STL, 3MF, DXF, DWG, PDF, eDrawings, JT, glTF), `pack_and_go`, `rebuild`, `force_rebuild_all`, `set_view`, `capture_screenshot`

**`drw.*`** — `create_from_model`, `add_sheet`, `set_sheet_format`, `add_view_standard3`, `add_view_projected`, `add_view_section`, `add_view_detail`, `add_view_broken_out`, `add_view_flat_pattern`, `add_view_exploded`, `align_views`, `import_model_items`, `add_dimension`, `arrange_dimensions`, `add_note`, `add_gtol`, `add_datum`, `add_surface_finish`, `add_weld_symbol`, `add_center_mark`, `add_centerline`, `auto_balloon`, `add_bom`, `add_cut_list_table`, `add_revision_table`, `fill_title_block`, `export`

**`pdm.*`** — `get_latest`, `check_out`, `check_in`, `undo_check_out`, `set_variable`, `change_state`, `add_to_vault`, `where_used`, `get_history`

**`query.*` (read-only, always free, never needs confirmation)** — `mass_properties`, `bounding_box`, `measure`, `section_properties`, `check_interference`, `check_clearance`, `check_draft`, `check_thickness`, `check_geometry`, `list_features`, `list_dimensions`, `list_configurations`, `list_properties`, `list_components`, `get_bom`, `where_used`, `rebuild_errors`, `compare_documents`

**`meta.*`** — `assert` (halt if a condition fails), `snapshot`, `note` (annotate the op log), `ask_user` (planner explicitly requests a decision mid-plan), `run_skill`, `run_plan` (compose plans)

**`script.macro` — the escape hatch.** Generates VBA/C# for something outside the vocabulary. **Always requires explicit per-run approval**, always runs in a scratch-copy dry run first, always shown in full to the user, and is disabled by default in team/enterprise policy. Its existence prevents the vocabulary from being a ceiling; its friction prevents it from being the default path.

---

## 3. Execution pipeline

```
 prompt + context
       │
   ┌───▼────┐  1. CONTEXT ASSEMBLY  (Kernel → Orchestrator)
   │        │     active doc, config, units, selection→PIDs, feature tree digest,
   │        │     global vars, materials, rebuild errors, PDM lock state,
   │        │     applicable standards, recent op log, retrieved similar parts
   └───┬────┘
   ┌───▼────┐  2. PLAN            (ProviderRouter → LLM, grammar-constrained)
   │        │     streams ops into the UI as they're generated
   └───┬────┘
   ┌───▼────┐  3. VALIDATE        (Orchestrator, no SOLIDWORKS calls yet)
   │        │     JSON-Schema ▸ vocabulary/version ▸ dependency DAG is acyclic ▸
   │        │     policy (tier, standards, destructive-op rules) ▸ unit sanity
   └───┬────┘
   ┌───▼────┐  4. RESOLVE + PRECHECK  (Kernel, read-only)
   │        │     resolve every PID and query; evaluate preconditions;
   │        │     compute the affected set → this is what the preview shows
   └───┬────┘
   ┌───▼────┐  5. PREVIEW          (UI)
   │        │     op cards, resolved targets highlighted in the 3D viewport,
   │        │     predicted tree diff, risk badges. User can edit params,
   │        │     drop ops, reorder, or reject.
   └───┬────┘        ── user approves (or auto-approve if policy allows) ──
   ┌───▼────┐  6. DRY RUN          (Kernel, optional/auto for destructive plans)
   │        │     execute against a hidden scratch copy; capture result metrics
   └───┬────┘
   ┌───▼────┐  7. APPLY            (Kernel, STA, inside one UndoScope)
   │        │     snapshot ▸ StartRecordingUndoObject ▸ suspend graphics/rebuild ▸
   │        │     execute ops in DAG order ▸ resume ▸ rebuild ▸
   │        │     FinishRecordingUndoObject("DATUM: <intent>")
   └───┬────┘
   ┌───▼────┐  8. VERIFY           (Kernel)
   │        │     rebuild error count, mass delta, interference, linter delta,
   │        │     verify[] assertions from the plan
   └───┬────┘
   ┌───▼────┐  9. SETTLE
        │        pass → result card + op log entry + undo affordance
        │        fail → auto-rollback (Pro: self-repair loop, max N attempts)
```

**Steps 1–6 mutate nothing.** That property is what makes the product safe to hand to someone who doesn't trust AI yet.

### 3.1 Apply-time performance discipline

Before the op loop, the Kernel sets up a **fast-execution scope** and tears it down in a `finally`:

- `ISldWorks.CommandInProgress = true`
- `ISldWorks.UserControl = false`, `UserControlBackground = false`
- `IModelDoc2.FeatureManager.EnableFeatureTree = false`
- `IModelDoc2.SetAddToDB(true)` for bulk sketch/feature insertion; `SetDisplayWhenAdded(false)`
- Suppress automatic rebuild; single `ForceRebuild3` at the end
- `swViewDisplayHideAllTypes` for reference geometry during the run
- Silent-mode file operations (`swOpenDocOptions_Silent`, warning suppression with the warnings *captured and reported*, never discarded)

This turns a 200-op plan from minutes into seconds, and it's also why every op must be written to tolerate a deferred-rebuild world (no reading derived geometry mid-plan without an explicit `doc.rebuild` op).

---

## 4. Real-time architecture

"Realtime" here means three distinct things, each with its own mechanism.

### 4.1 SOLIDWORKS → UI: live state (push, sub-100 ms)

```
EventTap (STA, handler must return in <1 ms)
   └─ writes a StateDelta into a lock-free ring buffer
        └─ DeltaPump (background thread, coalesces at 30 Hz)
             └─ named-pipe gRPC stream → Orchestrator
                  └─ WebSocket broadcast → all connected UI surfaces
                       └─ React store patch (immer) → only affected components rerender
```

Coalescing is essential: `AddItemNotify` can fire hundreds of times during a pattern rebuild. The pump merges deltas within a 33 ms window and drops superseded ones.

Live-updating surfaces:
- Feature tree mirror (add/delete/rename/suppress/reorder)
- Parameter Inspector values (dimension + global variable changes, including ones the user makes in SOLIDWORKS directly)
- Rebuild status badge and error list
- Selection context chip
- Mass / bounding box / CoG readout
- Design Linter findings
- PDM lock state
- Viewport thumbnail (throttled JPEG stream on view-change idle, 2–4 fps, only when the Studio window is visible)

### 4.2 UI → SOLIDWORKS: live manipulation (debounced write path)

Dragging a slider in the Parameter Inspector should feel like dragging a dimension in SOLIDWORKS. Path:

- Slider drag → optimistic local update → debounce 60 ms → `param.set_global` op with `deferRebuild: true`
- On drag end → `doc.rebuild` → verify → commit to op log as a single entry
- The whole drag session is one undo group ("DATUM: Length 40 → 62 mm")
- If a rebuild fails mid-drag, the UI shows the error inline and offers revert-to-last-good

### 4.3 Planner → UI: streaming generation

Ops stream in as the model emits them. Each op card appears in a `pending` state with a skeleton, fills in as tokens arrive, then flips to `resolved` once the Kernel precheck returns for it. The user sees the plan being built and can cancel at any token. Cancellation is real: nothing has touched SOLIDWORKS yet.

---

## 5. Model provider architecture (the free/Pro mechanism)

```
                       ┌──────────────── ProviderRouter ────────────────┐
   PlanRequest ───────▶│  task class → capability requirements →        │
                       │  eligible providers → policy filter → choose   │
                       └───┬──────────────┬──────────────┬──────────────┘
                           │              │              │
                 ┌─────────▼───┐  ┌───────▼──────┐  ┌────▼─────────────┐
                 │  LocalLLM   │  │  BYO-Key     │  │  Managed (Pro)   │
                 │ llama.cpp / │  │ user's own   │  │ Claude Opus 5    │
                 │ Ollama,     │  │ Anthropic /  │  │  (planner)       │
                 │ GGUF 7–14B  │  │ OpenAI /     │  │ Claude Sonnet 5  │
                 │ GBNF grammar│  │ Google key   │  │  (inline/fast)   │
                 │ + local VLM │  │              │  │ + vision, long   │
                 │ + Whisper   │  │              │  │   context, agent │
                 └─────────────┘  └──────────────┘  └──────────────────┘
```

### 5.1 Task classes and routing

| Task class | Free/local viable? | Notes |
|---|---|---|
| Single-op parameter edit | ✅ excellent | Grammar-constrained; the op is nearly extractive |
| Feature add on a selected face | ✅ good | Selection provides the hard part (the target) |
| Property fill from rules | ✅ deterministic, no LLM at all | Rules engine |
| Drawing from template | ✅ deterministic | Template + model items |
| Batch over a target set | ✅ deterministic | Plan authored once, replayed |
| Multi-feature part from description | ⚠️ mixed | Local models fumble sketch topology; Pro much stronger |
| Napkin sketch photo → model | ⚠️ weak locally | Needs frontier vision |
| Assembly generation + mating strategy | ❌ | Pro only |
| Plan → verify → self-repair agent loop | ❌ | Pro only |
| Standards authoring from a PDF | ❌ | Pro only |

### 5.2 Grammar-constrained decoding

The Operation IR JSON Schema is compiled to a GBNF grammar at build time. Local generation is constrained to it, so a 7B model physically cannot emit a malformed op or a nonexistent op name. This is the single technique that makes the free tier credible. Cloud providers use native structured-output / tool-use with the same schema.

### 5.3 Escalation UX

When the router determines a request exceeds local capability, it does **not** silently fail or silently upsell. It shows an honest capability card:

> *This plan needs 14 dependent operations and assembly mating strategy. Your local model (Qwen-Coder 14B) succeeded on 6 of 14 steps in the dry run. Options: run the 6 it got right · retry with your own API key · run on DATUM Pro.*

Attempted-and-honest beats blocked-and-nagging. The user can always run the partial plan.

### 5.4 Egress ledger

Before any non-local call, the UI can show **exactly** what would be transmitted: prompt, context digest, PID labels, any attached geometry summary. Local mode is the default on first run. Enterprise policy can hard-disable all egress providers, and the setting is machine-level (not user-overridable) when set by an admin.

---

## 6. Safety & trust model

| Guarantee | Mechanism |
|---|---|
| **One-keystroke undo** | Every plan is one `UndoScope`. Ctrl+Z reverts the whole thing. |
| **Nothing happens without preview** | Steps 1–6 are read-only. Auto-apply is opt-in, per-skill, and never available for `script.macro` or `*.delete`. |
| **Recoverable even if undo fails** | Pre-apply snapshot of the file to `%LOCALAPPDATA%\DATUM\snapshots` (content-addressed, retention configurable). Restore from the history panel. |
| **Destructive ops are gated** | `feature.edit.delete`, `config.delete`, `asm.delete_component`, `doc.save_as` overwrite, `pdm.check_in` require explicit confirmation with the affected set listed. |
| **Never edit what you don't own** | PDM lock check before any mutation. Read-only files → offer check-out, never force. |
| **No silent reference guessing** | PID resolution failure halts the plan. |
| **Verifiable outcome** | Post-apply `verify[]` block: rebuild errors, mass delta bounds, interference, linter score. Failure → auto-rollback. |
| **Full audit trail** | Immutable append-only op log per document (SQLite + optional sidecar `.datum.log` next to the file). Exportable; attachable to a PDM revision. |
| **Reproducibility** | Plan + IR version + provider + model + seed + context digest hash are all recorded. A plan can be replayed byte-identically. |
| **Crash containment** | Per-op try/catch; COM exception → halt + rollback; Kernel watchdog; if the Kernel faults 3× it self-disables and tells the user rather than fighting SOLIDWORKS. |

---

## 7. Data model (SQLite, `%LOCALAPPDATA%\DATUM\datum.db`)

```
documents      docId, path, uuid, type, lastSeenAt, swVersion, vaultId
sessions       sessionId, swPid, startedAt, endedAt
messages       msgId, sessionId, role, content, attachments[], createdAt
plans          planId, msgId, docId, irVersion, intentText, status,
               providerId, modelId, promptTokens, completionTokens, seed,
               contextDigestSha256, createdAt
ops            opId, planId, ordinal, opName, targetJson, paramsJson,
               status, startedAt, durationMs, errorJson
snapshots      snapId, docId, planId, blobPath, sha256, sizeBytes, createdAt
oplog          entryId, docId, planId, appliedAt, undoGroupName, verifyJson,
               massBefore, massAfter, errorsBefore, errorsAfter, userId
skills         skillId, name, version, ownerId, inputSchemaJson, opTemplateJson,
               testsJson, tags[], visibility, createdAt, updatedAt
skill_runs     runId, skillId, planId, inputsJson, outcome
standards      ruleId, packId, severity, scope, predicateJson, fixJson, enabled
lint_findings  findingId, docId, ruleId, targetPid, message, status, seenAt
batches        batchId, name, targetQueryJson, planTemplateId, status,
               total, done, failed, createdAt
batch_items    itemId, batchId, docPath, status, planId, errorJson, attempts
index_parts    partId, path, sha256, bboxJson, mass, volume, faceCount,
               edgeCount, topoHash, featureSig, textEmbedding, geomEmbedding
providers      providerId, kind, endpoint, modelId, keyRef, enabled, isDefault
settings       key, value, scope(machine|user), lockedByAdmin
```

Secrets (API keys) never go in SQLite — they go in **Windows DPAPI / Credential Manager**, referenced by `keyRef`.

---

## 8. Part-reuse index (A8)

Two-channel retrieval, because neither alone works:

1. **Text channel** — filename, description, custom properties, material, part number, drawing notes → embedded (local `bge-small` in free tier; better model in Pro).
2. **Geometry channel** — a fingerprint computed from `IBody2`: bounding-box ratios, volume/bbox fill ratio, face-type histogram (planar/cylindrical/conical/spline), edge-length distribution, symmetry detection, topology hash, and a feature-signature string from the tree. Cheap, deterministic, no GPU, and good enough to catch "we already have this bracket".

Fusion via reciprocal-rank fusion. Results surface **proactively**: when a user starts a new part and describes it, DATUM interjects *before* modelling begins — "3 similar parts exist" — which is the moment where the value is highest.

Indexing runs as a low-priority background crawl over configured folders and, in Pro, over vault query results, with incremental updates on `FileSavePostNotify`.

---

## 9. Batch engine

- **Target-set expansion:** folder glob, recursive, vault query, BOM list, pasted part numbers, saved search, current assembly's components, where-used results.
- **Per-item isolation:** each file opened silently, processed, saved, closed. One bad file never kills the run.
- **Concurrency:** file-level parallelism is impossible (one STA SOLIDWORKS instance), so concurrency = 1 by default. Pro can spin **additional headless SOLIDWORKS instances** (subject to seat licensing) via a worker pool, each with its own Kernel; the Orchestrator load-balances items across them.
- **Resume + dead-letter:** batch state is persisted per item; a crash resumes where it stopped; failures go to a dead-letter list with the exception and a one-click retry.
- **Dry-run mode:** run the whole batch against copies in a temp tree, produce a report, then commit.
- **Progress:** per-item WebSocket events → live grid with status, duration, and error.

---

## 10. Standards engine & design linter

A rule is a small declarative predicate over the document model, with an optional auto-fix expressed as ops:

```jsonc
{
  "id": "std.hole.metric-only",
  "pack": "acme-mech-v3",
  "severity": "error",
  "scope": "part",
  "when": { "all": [ { "featureType": "HoleWzd" } ] },
  "assert": { "param.standard": { "in": ["ISO", "DIN"] } },
  "message": "Holes must use ISO or DIN standards, not ANSI.",
  "fix": [ { "op": "feature.edit.set_params", "params": { "standard": "ISO" } } ]
}
```

Built-in packs shipped free: sketch fully-defined, fragile-reference detection (sketches on model faces rather than datum planes), unnamed-feature audit, missing custom properties, missing material, oversized file, unused configurations, duplicate geometry, non-standard fillet radii, missing drawing views, unballooned BOM items, default sheet format.

Pro adds AI rule authoring: point it at your drafting standard PDF, it drafts rule definitions, you review and enable them.

The linter runs on `RegenPostNotify2` (debounced 400 ms) so findings are live, with an inline badge on the affected feature in the tree mirror.

---

## 11. Security

- Loopback-only listeners, random high port, **token-authenticated** (token minted per session, handed to the WebView via `AddHostObjectToScript`, never on a URL).
- Named pipe ACL restricted to the interactive user SID.
- WebView2: CSP locked to `self`, no remote origins, no `eval`, isolated user-data folder, downloads disabled, navigation restricted to the app origin.
- Code signing (EV) on Kernel, Orchestrator, and Studio; SOLIDWORKS add-in registration under `HKCU` by default, `HKLM` only for admin/enterprise deployment.
- Prompt-injection defence: content read from files, PDFs, and datasheets is **data, never instructions**. The planner receives it in a delimited data channel with an explicit non-instruction contract, and no op may be authored solely on the authority of ingested file content — plans derived from ingested documents always require preview approval regardless of auto-apply settings.
- Enterprise: MSI + GPO ADMX templates, machine-locked provider policy, egress allow/deny list, telemetry opt-out that is honoured (and off entirely in free/local mode).

---

## 12. Technology choices

| Layer | Choice | Why |
|---|---|---|
| Kernel | C# / .NET Framework 4.8, `SolidWorks.Interop.*` | Only reliable in-process option; matches ecosystem |
| Orchestrator | C# / .NET 8, Kestrel, gRPC, SQLite (EF Core) | Modern runtime, good async, single-language stack with Kernel |
| Local LLM | `llama.cpp` (GGUF) via LLamaSharp, GBNF grammar | CPU-viable, GPU-accelerated when present, no Python runtime |
| Local STT | `whisper.cpp` | Same reason |
| Local embeddings | `bge-small-en` ONNX via ONNX Runtime | Fast, CPU-fine |
| Vector store | `sqlite-vec` | No extra service; one file |
| UI | React 18 + TypeScript + Vite + Tailwind + Radix primitives + Zustand | One bundle for both hosts; fast; accessible primitives |
| 3D preview (Studio) | three.js over tessellated body data from the Kernel | Lightweight preview without a second CAD kernel |
| Shell (Studio) | WPF + WebView2 | Native Windows, shares the Chromium runtime already required by the Task Pane |
| In-SOLIDWORKS UI | `ITaskpaneView` → WinForms host → WebView2 | Same React app, docked in CAD |
| Installer | WiX v4 MSI + bootstrapper (WebView2 evergreen, .NET runtimes) | Enterprise deployable |
| Telemetry | OpenTelemetry, local-first, opt-in export | Debuggable without being invasive |

---

## 13. Failure modes and what the user sees

| Failure | Behaviour |
|---|---|
| SOLIDWORKS not running | Studio works in "offline" mode: browse history, author skills, edit standards, queue batches. Panel shows a connect prompt. |
| Kernel disconnected mid-plan | Plan halts, snapshot preserved, UI shows reconnect + "restore snapshot" |
| PID unresolvable | Op card turns amber, plan pauses, user is asked to re-pick the entity (click in the viewport) |
| Rebuild errors after apply | Verify fails → auto-rollback → result card lists the errors and offers Repair Assistant |
| Local model produced an invalid plan | Grammar makes this near-impossible; if semantic validation fails, show the invalid op with the reason and offer escalation |
| No GPU / low RAM | Local model auto-selects a smaller quant; UI states the tradeoff plainly |
| File is read-only / not checked out | Mutation blocked before planning even starts; offer `pdm.check_out` |
| Long-running batch, SOLIDWORKS crashes | Orchestrator survives; batch resumes on reconnect from the last completed item |

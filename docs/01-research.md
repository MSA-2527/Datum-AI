# DATUM — Research & Problem Inventory

> Product working name: **DATUM** (a datum is the stable reference everything else is built from — which is exactly the promise: AI edits that hang off stable references, not guesses).
> Research date: July 2026. Target: SOLIDWORKS 2022–2026, Windows 10/11 x64.

---

## 1. Why this is hard (and why most "AI CAD" tools fail)

The naive product is "chat box → generates a mesh." That is a demo, not a tool. Research converges on one conclusion: **AI CAD output is worthless downstream unless it is parametric, editable, and carries design intent.**

The recurring complaints from engineers about AI-generated CAD:

| Complaint | Consequence |
|---|---|
| Optimises for looking right on screen, not for engineering utility | Model can't be manufactured or quoted |
| No feature tree, or a garbage one | Every edit is a rebuild-from-scratch |
| Under-constrained sketches | Change one dimension, symmetry collapses |
| No material, tolerance, or manufacturing annotation | Fails at CAM/inspection handoff |
| Ignores company naming/layer/format standards | Rejected at drawing check |
| Almost none produce real assemblies with mates | Useless above single-part scope |

**Design principle #1 that falls out of this:** DATUM never produces geometry. It produces a **plan of typed parametric operations** which SOLIDWORKS itself executes through its own API. The feature tree is native, because SOLIDWORKS built it. There is no import, no mesh, no translation loss.

**Design principle #2:** the unit of AI output is an *editable, replayable, diffable operation list* — not a file.

---

## 2. The integration surface: what SOLIDWORKS actually allows

### 2.1 Hard constraints (these dictate the architecture)

1. **The API is COM and STA (single-threaded apartment).** You cannot call it from a worker thread. Attempting it doesn't crash — it silently degrades, e.g. an operation that takes milliseconds on the UI thread takes over a minute on a `BackgroundWorker`.
2. **Out-of-process is catastrophically slow.** Measured benchmark for the same workload:

   | Approach | Time | Relative |
   |---|---|---|
   | Stand-alone, direct out-of-process calls | 241.95 s | ~92× slower |
   | Stand-alone + `CommandInProgress` | 36.14 s | ~13.7× slower |
   | **Stand-alone dispatching into an in-process add-in** | **1.77 s** | baseline |

   Cross-apartment COM marshalling costs ~100× on chatty call patterns. An AI that issues hundreds of API calls per prompt **must** run in-process.
3. **Therefore: the execution engine is a `.NET` in-process add-in implementing `ISwAddin`**, receiving the `ISldWorks` pointer via `ConnectToSW(object sw, int cookie)`. Everything else (UI, LLM, indexing) lives out-of-process and *dispatches* work into it.
4. **The dispatch pattern is a deferred queue drained on `OnIdle`.** The orchestrator enqueues an operation batch; the add-in drains it on the SOLIDWORKS idle event, so all API calls land on the correct STA thread while SOLIDWORKS is in a quiescent state. Results return via a callback channel.
5. **Entity references are fragile.** Face/edge/feature references by name or index break on rebuild. `IModelDocExtension::GetPersistReference3` / `GetObjectByPersistReference3` produce **Persistent Reference IDs (PIDs)** that survive rebuilds, sessions, and SOLIDWORKS version upgrades. Every reference DATUM stores must be a PID.

### 2.2 What we can read (context acquisition)

| Source | Interface | Use in DATUM |
|---|---|---|
| Open documents, active doc | `ISldWorks`, `IModelDoc2` | Session state |
| Feature tree, full traversal | `IFeatureManager`, `IFeature.GetNextFeature` | Model Explorer mirror |
| Feature definition + params | `IFeature.GetDefinition()` → typed `I*FeatureData` | Understand what a feature *is* |
| Sketches, segments, relations | `ISketch`, `ISketchSegment`, `ISketchRelationManager` | Constraint analysis, linting |
| Dimensions | `IDisplayDimension.GetDimension2`, `IDimension.GetSystemValue3` | Parametric editing |
| Equations & global variables | `IEquationMgr` | The *correct* target for parametric edits |
| Configurations | `IConfigurationManager`, `IConfiguration` | Variants |
| Design tables | `IDesignTable` | Bulk variants |
| Custom / config-specific properties | `ICustomPropertyManager` | Metadata automation |
| Mass properties | `IMassProperty` | Verification, delta checks |
| Bodies & topology | `IBody2`, `IFace2`, `IEdge`, `ILoop2` | Geometry fingerprinting, reuse search |
| Materials | `IPartDoc.GetMaterialPropertyName2`, 2026 `IDSPBRMaterial` | Material assignment |
| Assembly structure | `IAssemblyDoc`, `IComponent2`, `IMate2` | Assembly reasoning |
| Interference / clearance | `IInterferenceDetectionMgr`, `IClearanceVerification` | Post-op validation |
| Drawing structure | `IDrawingDoc`, `IView`, `IBomTableAnnotation` | Drawing automation |
| Selection | `ISelectionMgr` + `UserSelectionPostNotify` | **Implicit prompt context** |
| Rebuild errors | `IFeature.GetErrorCode2`, `IModelDoc2.GetFeatureCount` | Health, linting |
| Sheet metal | `ISheetMetalFeatureData`, flat-pattern config | DXF/laser output |
| PDM vault state | `IEdmVault5`, `IEdmFile5` | Lock/check-out gating |

### 2.3 What we can write (the mutation surface)

| Domain | Key API |
|---|---|
| Sketch creation | `ISketchManager.InsertSketch`, `CreateLine/CreateCircle/CreateArc`, `ISketchRelationManager.AddRelation` |
| Dimensioning | `IModelDocExtension.AddDimension`, `IDimension.SetSystemValue3` |
| Solid features | `IFeatureManager.FeatureExtrusion3`, `FeatureRevolve2`, `InsertProtrusionSwept4`, `InsertLoft2`, `FeatureFillet3`, `InsertFeatureChamfer`, `InsertSheetMetalBaseFlange2`, `HoleWizard5` |
| Patterns / mirrors | `FeatureLinearPattern5`, `FeatureCircularPattern5`, `InsertMirrorFeature2` |
| **Editing existing features** | `IFeature.GetDefinition()` → `AccessSelections()` → mutate → `IFeature.ModifyDefinition()` |
| Tree surgery | `IFeatureManager.EditRollback`, `IFeature.SetSuppression2`, reorder, `IFeature.Delete` |
| Parameters | `IModelDoc2.Parameter("D1@Sketch1").SystemValue`, `IEquationMgr.Add3/SetEquation` |
| Configurations | `IModelDoc2.AddConfiguration3`, `IConfiguration` property set |
| Assemblies | `IAssemblyDoc.AddComponent5`, `AddMate3`, `FeatureLinearPattern`, `ReplaceComponents2` |
| Metadata | `ICustomPropertyManager.Add3/Set2`, `IPartDoc.SetMaterialPropertyName2` |
| Drawings | `CreateDrawingViewFromModelView3`, `IDrawingDoc.InsertModelAnnotations3`, `AutoBalloon5`, `InsertBomTable4` |
| Export | `IModelDocExtension.SaveAs3` (STEP/IGES/PDF/DXF/DWG/STL/3MF/Parasolid) |
| **Undo grouping** | `IModelDocExtension.StartRecordingUndoObject()` / `FinishRecordingUndoObject(name, false)` |
| Custom native feature | Macro Feature (`IFeatureManager.InsertMacroFeature3`) — appears in the tree, editable, suppressible |
| Custom UI | `ITaskpaneView` (hosts a **WebView2** control), `IPropertyManagerPage2`, `ICommandManager` |

**The single most important write-side API for trust:** `StartRecordingUndoObject` / `FinishRecordingUndoObject`. Every DATUM plan, however many hundreds of API calls it contains, collapses into **one Ctrl+Z**. Users will not adopt an AI that they cannot undo in one keystroke.

### 2.4 Events (the real-time backbone)

SOLIDWORKS is an event-rich host. Notifications are attached per-object, so DATUM must register on `ISldWorks` globally and on **each** `IPartDoc` / `IAssemblyDoc` / `IDrawingDoc` as it opens.

| Event set | Events DATUM hooks | Drives |
|---|---|---|
| `swSldWorksNotify` | `ActiveDocChangeNotify`, `FileOpenPostNotify`, `FileNewNotify`, `DocumentLoadNotify2`, `OnIdleNotify`, `DestroyNotify`, `CommandCloseNotify` | Session/context bar, work-queue drain |
| `swPartNotify` | `AddItemNotify`, `DeleteItemNotify`, `RenameItemNotify`, `RegenPostNotify2`, `ActiveConfigChangePostNotify`, `FileSavePostNotify`, `UserSelectionPostNotify`, `DestroyNotify2` | Live feature tree, live linter, selection context |
| `swAssemblyNotify` | `ComponentStateChangeNotify`, `AddItemNotify`, `RegenPostNotify2`, `ActiveViewChangeNotify` | Assembly explorer, interference re-check |
| `swDrawingNotify` | `AddItemNotify`, `ActivateSheetPostNotify`, `RegenPostNotify` | Drawing automation surface |
| PDM (`IEdmAddIn5` hooks) | `EdmCmd_PostLock`, `EdmCmd_PostUnlock`, `EdmCmd_PreState`, `EdmCmd_PostAdd` | Check-out gating, revision awareness |

`RegenPostNotify2` is the heartbeat: after every rebuild we re-read error counts, mass properties, and sketch constraint status, and push a delta to the UI over WebSocket. That is what makes the product feel *live* rather than request/response.

> ⚠️ Event-handler discipline: SOLIDWORKS notifications fire on the STA thread and **must return fast**. DATUM handlers do nothing but stamp a lightweight delta record into a lock-free ring buffer; a separate pump serialises and ships it. A slow handler freezes SOLIDWORKS, which is the fastest way to get uninstalled.

### 2.5 SOLIDWORKS 2026 API deltas worth exploiting

- `IDSPBRMaterial` — physically-based material object → richer material assignment and render-accurate appearance automation.
- `IBodyFolder` / `GetTopLevelFeatures` — feature-aware validation; cleaner multibody traversal for the linter.
- Family Table APIs (`IFamilyTableAnnotation`) — a better variant target than raw design tables.
- Expanded event handling explicitly aimed at "real-time enforcement" — i.e. Dassault is signalling that live validation add-ins are a first-class use case.

DATUM ships a **capability probe**: on connect it detects the SOLIDWORKS major version and enables/disables ops accordingly, so a 2022 seat degrades gracefully rather than throwing COM exceptions.

### 2.6 UI hosting options inside SOLIDWORKS

| Surface | API | DATUM use |
|---|---|---|
| **Task Pane** | `ISldWorks.CreateTaskpaneView2` → host a WinForms host → **WebView2** | **Primary UI.** The whole React app runs here, docked next to the graphics area. |
| PropertyManager Page | `IPropertyManagerPage2` | Native-feel parameter editing for a single op ("tweak this fillet") |
| CommandManager tab + toolbar | `ICommandManager.CreateCommandGroup2` | Ribbon entry points, keyboard shortcuts |
| Context menu | `ICommandManager` + `AddMenuPopupItem3` | Right-click a face → "Ask DATUM about this" |
| Status bar / balloon | `ISldWorks.SendMsgToUser2`, custom overlay | Non-blocking progress + result toasts |
| Macro Feature | `InsertMacroFeature3` | AI-generated *procedural* features that stay live and editable in the tree |

Hosting WebView2 in the Task Pane is the unlock: it means **one React codebase** serves both the in-SOLIDWORKS panel and the standalone Studio window. Designers never alt-tab for the common case.

---

## 3. The designer's real problems

Ordinary engineers reportedly spend ~80% of their time on repetitive modification and sorting work; automation-enabled teams report ~25% reduction in design cycle time. Below is the problem inventory that DATUM is built against — each row maps to concrete features in `03-product-spec.md`.

### 3.1 Tier-A problems (daily, high pain, high automatability)

| # | Problem | What actually happens | DATUM answer |
|---|---|---|---|
| A1 | **Variant / size-family design** | Same bracket in 40 sizes; manual dimension edits, one config at a time | Skills (parametric generators) + Variant Matrix + design-table generation |
| A2 | **Drawing creation** | Insert views, align, dimension, balloon, BOM, title block — 20–60 min per part | Drawing Autopilot: template-driven view set, model-item import, auto-balloon, BOM, standards check |
| A3 | **Custom property / metadata entry** | Part number, description, material, mass, finish, revision typed by hand per file | Property Autofill from rules + model-derived values; batch across folder/vault |
| A4 | **Batch export** | STEP for supplier, DXF for laser, PDF for shop, STL for print — per config, per file | Batch Runner with export profiles, per-configuration expansion, naming templates |
| A5 | **Repetitive hardware mating** | Insert screw → 3 mates → repeat ×48 | `asm.fasten` op: hole-aware fastener insertion with auto-mate + pattern following |
| A6 | **Fixing rebuild errors** | Dangling references after an upstream edit; hunt-and-peck repair | Repair Assistant: reads `GetErrorCode2`, proposes PID re-binding, previews fix |
| A7 | **Sheet metal flat pattern → DXF** | Toggle flat pattern, export, name correctly, verify bend table | Sheet-metal pipeline op with bend-table + material/gauge validation |
| A8 | **Finding an existing part instead of remodelling** | No good search → engineer remodels a part the company already owns | Geometry+text reuse index; "we already have this" interception before modelling |
| A9 | **Engineering change propagation** | Change a dim; find every affected part, drawing, config, BOM | Impact Analysis (where-used + parametric dependency graph) then batched apply |
| A10 | **Standards compliance** | Hole callout style, layer, sheet format, naming, tolerance blocks | Standards Engine + live Design Linter |

### 3.2 Tier-B problems (weekly, high value)

| # | Problem | DATUM answer |
|---|---|---|
| B1 | Under-constrained / fragile sketches; symmetry collapses on edit | Linter rules: fully-defined check, fragile-reference check (sketching on model faces vs datum planes), suggest-and-apply relations |
| B2 | BOM accuracy & where-used | Live BOM view, where-used across vault, exclusion-flag audit |
| B3 | Napkin sketch / whiteboard photo → model | Image input → dimensioned sketch plan → parametric solid |
| B4 | Supplier STEP import with no tree ("dumb solid") | Feature Recognition assist + wrap in editable parameters |
| B5 | Mass/CoG targets | Goal-seek loop over global variables with `IMassProperty` feedback |
| B6 | Design review handoff / "why is it like this?" | Auto-generated design rationale from the op log + model diff |
| B7 | Onboarding: nobody knows the internal macro library | Skills library with searchable, documented, versioned parametric generators |
| B8 | Interference discovered late | Post-op automatic interference/clearance verification |
| B9 | Configuration explosion / unused configs | Config audit + prune with usage evidence |
| B10 | Manual measurement & quick maths | Query ops: measure, mass, volume, bounding box, wall thickness, draft check |

### 3.3 Tier-C problems (organisational)

| # | Problem | DATUM answer |
|---|---|---|
| C1 | PDM friction — editing a file you don't have checked out | Vault-state gating: DATUM refuses to mutate a non-checked-out file, offers to check out |
| C2 | Macro rot — VBA written by someone who left | Skills are versioned, typed, tested, and have owners; import existing `.swp` and generalise |
| C3 | No audit trail of automated changes | Immutable op log per file, exportable, attaches to the revision |
| C4 | Licence/seat cost of automation tools | **Free tier that is genuinely useful without any AI at all** (see §5) |
| C5 | IP leaving the building | Local-only mode: nothing leaves the workstation; explicit egress ledger |

---

## 4. Input modalities a designer can realistically give

This is the "what kind of inputs" question, answered exhaustively. Every one of these is a first-class input in the composer.

| # | Modality | Example | How it's consumed |
|---|---|---|---|
| I1 | **Natural-language prompt** | "Add a 6 mm fillet to all vertical edges of the boss" | Planner → Operation IR |
| I2 | **Live selection (implicit)** | User pre-selects 3 faces, types "shell these to 2 mm" | `ISelectionMgr` → PIDs injected as `@selection` |
| I3 | **Voice** | Hands on the mouse, dictate the edit | Local Whisper (free) / cloud STT (Pro) → I1 |
| I4 | **Numeric / parametric direct entry** | Drag a slider on `Length` | Bypasses AI entirely — direct `IEquationMgr` write |
| I5 | **Constraint / requirement statement** | "Must fit in 120×80×40, min wall 2 mm, mass < 300 g" | Becomes a persistent *constraint set*; linter + goal-seek enforce it |
| I6 | **Image: napkin sketch / whiteboard / screenshot** | Photo of a hand sketch with dims | Vision → sketch plan → dimensioned sketch → features |
| I7 | **Image: markup on a screenshot of the model** | Red arrows + "make this 15" | Vision + viewport ray-cast to resolve arrows to PIDs |
| I8 | **2D drawing (PDF/DWG/DXF)** | Legacy drawing to be remodelled | Extract views + dims → sketch plan |
| I9 | **Reference 3D file (STEP/IGES/Parasolid/SLDPRT)** | "Make a bracket like this but 30 mm longer" | Geometry fingerprint + feature recognition |
| I10 | **Spreadsheet (XLSX/CSV)** | Size table for 40 variants | Variant Matrix → configurations / design table |
| I11 | **Datasheet / spec PDF** | Motor datasheet → mounting pattern | Extract bolt circle, shaft dia → parametric mount |
| I12 | **Existing macro (.swp / .swb / C#)** | Legacy automation | Import → parse → convert into a typed Skill |
| I13 | **Recorded UI actions** | Record me doing it once | `swCommandCloseNotify` capture → generalised Skill draft |
| I14 | **Company standards documents** | Drafting standard PDF, naming convention | Ingested into Standards Engine as rules |
| I15 | **File / folder / vault query as a target set** | "All parts in \Projects\X released after June" | Batch target selector |
| I16 | **BOM / part-number list** | Paste 200 part numbers | Batch target selector |
| I17 | **Template / seed model** | "Use our standard enclosure seed" | Skill input binding |
| I18 | **Prior conversation / op log** | "Do what you did to the last bracket" | Replay a transcript against a new target |
| I19 | **Drag-drop from the feature tree** | Drag `Fillet3` into the composer | Becomes a `@Fillet3` PID token |
| I20 | **Right-click context invoke** | Right-click face → "Ask DATUM" | Pre-seeds selection + intent |

---

## 5. The free / Pro split (per the requirement: free, with a maximum-powered paid upgrade)

The critical design decision: **the free tier must not be a crippled demo.** It is a complete, deterministic CAD automation tool that happens to also run a local model. The paid tier buys *reasoning power and org-scale*, not basic function.

### 5.1 What makes this possible

Everything downstream of the planner is deterministic C# that calls the SOLIDWORKS API. The LLM only *authors the plan*. So:

- **Deterministic subsystems** (Op executor, Skills, Batch Runner, Parameter Inspector, Linter, Standards Engine, Drawing Autopilot templates, exports, op log, undo) — **free forever, no AI required, no account required, works fully offline.**
- **The planner** is a pluggable provider:
  - **Free / Local** — a quantised local model via `llama.cpp`/Ollama (e.g. a 7–14B code model) constrained by grammar-based decoding to the Operation IR JSON schema. Grammar constraints matter enormously here: they let a small local model produce *valid* ops even when its reasoning is weaker.
  - **Free / BYO key** — user pastes their own Anthropic/OpenAI/Google key. DATUM takes no cut and adds no markup. This alone makes the free tier "maximum powered" for anyone willing to pay a model vendor directly.
  - **Pro / Managed** — DATUM-managed Claude Opus 5 for planning + Claude Sonnet 5 for fast inline edits, with no key management, higher context, vision, and a fine-tuned Operation-IR planner.

### 5.2 Tier matrix

| Capability | Free (local / BYO key) | **Pro — Maximum** |
|---|---|---|
| Op executor, undo grouping, op log | ✅ | ✅ |
| Parameter Inspector, live sliders | ✅ | ✅ |
| Skills: run, author manually, version | ✅ | ✅ + AI-authored skills, org sharing |
| Batch Runner | ✅ up to 25 targets/run | ✅ unlimited + scheduled + headless agent |
| Design Linter + Standards Engine | ✅ built-in rule packs | ✅ + AI rule authoring from your standards PDFs |
| Drawing Autopilot | ✅ template-driven | ✅ + AI view selection & dimensioning judgement |
| Local model planner | ✅ | ✅ (still available offline) |
| BYO API key | ✅ | ✅ |
| Managed frontier model (Opus 5 / Sonnet 5) | — | ✅ |
| Vision inputs (sketch photo, markup, PDF drawing) | Local VLM, best-effort | ✅ frontier vision |
| Part-reuse index | ✅ local folders | ✅ org-wide + PDM + geometry search |
| PDM / PLM integration | ✅ read + lock gating | ✅ full workflow automation |
| Multi-step autonomous agent (plan → execute → verify → repair loop) | Single-step plans only | ✅ full agent loop with self-repair |
| Assembly-scale generation | — | ✅ |
| Team: shared skills, standards, audit, SSO | — | ✅ |
| Air-gapped / zero-egress mode | ✅ (it's the default) | ✅ with local model fallback |

### 5.3 Honest framing of the free tier's limits

A 14B local model will not architect a 60-part assembly. It *will* reliably do: parameter edits, fillets/chamfers/patterns, property fill, export batches, drawing generation from templates, linting, and running skills someone else authored. That covers Tier-A problems A1, A3, A4, A7, A10 and most of A2 — which is the bulk of the 80% repetitive time. The upgrade prompt should be *earned and contextual* ("this plan needs 14 dependent steps and assembly reasoning — local model declined; run on Pro?"), never a nag.

---

## 6. Competitive read

| Tool | Approach | Gap DATUM targets |
|---|---|---|
| Leo AI | CAD-aware copilot, "Large Mechanical Model", PDM/PLM connectors, geometry-aware part search, assembly generation from text | Closed, cloud-only, subscription-first; no local/offline tier; limited deterministic automation without AI |
| Zoo (zoo.dev) | Correctly argues AI must generate *parametric* CAD; own KCL language | Not SOLIDWORKS-native — you leave your CAD system |
| CADGPT / AdamCAD / text-to-CAD generators | Prompt → model, often mesh or new-format | Poor feature trees, weak edit story, no company standards |
| DriveWorks | Rules-based configurator, mature, proven ~25% cycle reduction | Expensive, project-scale setup, no natural language, not ad-hoc |
| SOLIDWORKS Task Scheduler / #TASK | Batch processing | No intelligence, rigid |
| Native SOLIDWORKS 2026 AI features | Auto-generate drawings etc. | Vendor-paced, version-locked, not extensible by the customer |
| CodeStack / macro libraries | Free, excellent, huge | Requires a programmer; macros rot; no UI |

**DATUM's position:** SOLIDWORKS-native (never leave the app), parametric-only output, deterministic core that's free and offline-capable, with frontier reasoning as the paid accelerant.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Add-in crashes SOLIDWORKS → instant uninstall | All op execution in try/catch per-op; watchdog; crash-safe op log; add-in can be soft-disabled without unregistering; never block the STA thread |
| AI destroys hours of work | Single-undo grouping; mandatory dry-run on a scratch copy for destructive ops; auto-snapshot before apply; PDM check-out gating |
| Model hallucinates an op or param | Operation IR is a closed, versioned, JSON-Schema'd vocabulary; grammar-constrained decoding; every op has preconditions validated *before* any mutation |
| PID drift after heavy topology change | Re-resolve PIDs before apply; if a PID fails to resolve, the plan halts and asks rather than guessing a nearby entity |
| Performance regression on big assemblies | Lazy tree mirroring, LOD on the explorer, `CommandInProgress`, suspend rebuild/graphics during batches, cap event fan-out |
| SOLIDWORKS version differences | Capability probe at connect; per-version op availability matrix; graceful degradation |
| Licence / EULA and API redistribution | Add-in uses only public COM interop assemblies; no redistribution of SOLIDWORKS binaries; user supplies their own seat |
| IP leakage | Zero-egress default; explicit egress ledger UI showing exactly what would be sent before any cloud call |

---

## Sources

- [SOLIDWORKS API Getting Started Overview — 2025](https://help.solidworks.com/2025/English/api/sldworksapiprogguide/GettingStarted/SolidWorks_API_Getting_Started_Overview.htm)
- [Events — SOLIDWORKS API Help 2025](https://help.solidworks.com/2025/English/api/sldworksapiprogguide/Overview/Events.htm)
- [Persistent Reference IDs — SOLIDWORKS API Help](https://help.solidworks.com/2022/english/api/sldworksapiprogguide/overview/persistent_reference_ids.htm)
- [GetSpecificFeature2 / IFeature — SOLIDWORKS API Help 2026](https://help.solidworks.com/2026/english/api/sldworksapi/Solidworks.Interop.sldworks~SOLIDWORKS.Interop.sldworks.IFeature~GetSpecificFeature2.html)
- [In-process invoking of SOLIDWORKS add-in API from out-of-process applications — CodeStack](https://www.codestack.net/solidworks-api/getting-started/inter-process-communication/invoke-add-in-functions/in-process-invoking/)
- [SOLIDWORKS Stand-Alone API: do not compromise on performance — CodeStack blog](https://blog.codestack.net/solidworks-stand-alone-performance)
- [Handling SOLIDWORKS events — CodeStack blog](https://blog.codestack.net/handling-solidworks-events)
- [Utilizing Macro Features in SOLIDWORKS API — CodeStack](https://www.codestack.net/solidworks-api/document/macro-feature/)
- [Automating mates in assemblies using SOLIDWORKS API — CodeStack](https://www.codestack.net/solidworks-api/document/assembly/mates/)
- [Automating drawings using SOLIDWORKS API — CodeStack](https://www.codestack.net/solidworks-api/document/drawing/)
- [Working with dimensions using SOLIDWORKS API — CodeStack](https://www.codestack.net/solidworks-api/document/dimensions/)
- [Using persistent reference id in SOLIDWORKS API to track objects — CodeStack](https://www.codestack.net/solidworks-api/document/tracking-objects/persist-references/)
- [Check-out active SOLIDWORKS model using SOLIDWORKS and PDM API — CodeStack](https://www.codestack.net/solidworks-pdm-api/files/check-out-active-model/)
- [IEdmVault5 Interface — SOLIDWORKS API Help](https://help.solidworks.com/2023/english/api/epdmapi/EPDM.Interop.epdm~EPDM.Interop.epdm.IEdmVault5.html)
- [A Practical Guide to the SOLIDWORKS PDM API in 2026 — Blue Byte Systems](https://bluebyte.biz/solidworks/solidworkspdm/a-practical-guide-to-the-solidworks-pdm-api-in-2026/)
- [Optimizing SOLIDWORKS API Performance: Best Practices and Key API Calls — Blue Byte Systems](https://bluebyte.biz/solidworks/optimizing-solidworks-api-performance-best-practices-and-key-api-calls/)
- [What's New In the 2026 SOLIDWORKS API — CADSharp](https://www.cadsharp.com/blog/whats-new-in-the-2026-solidworks-api/)
- [Advanced API: Using Persistent IDs to Locate Objects — CADSharp](https://www.cadsharp.com/blog/solidworks-api-getting-pointers-persistent-ids/)
- [Mating Automation Techniques: Pros and Cons — CADSharp](https://www.cadsharp.com/blog/solidworks-api-mating-automation-techniques/)
- [Why AI Must Generate Parametric CAD — Zoo](https://zoo.dev/blog/why-ai-must-generate-parametric-cad)
- [How Text-to-CAD Actually Works: From Prompt to Parametric Model — Leo AI](https://www.getleo.ai/blog/how-text-to-cad-works)
- [Can AI Generate CAD Models? What Actually Works in 2026 — Leo AI](https://www.getleo.ai/blog/can-ai-generate-cad-models)
- [Leo AI can now generate full CAD assemblies — Engineering.com](https://www.engineering.com/leo-ai-can-now-generate-full-cad-assemblies/)
- [The Must-Have Guide to SOLIDWORKS Automation in 2026 — SolidBoris](https://solidboris.com/our-blog/tpost/dk4g4bjyn1-the-must-have-guide-to-solidworks-automa)
- [The ultimate guide to SOLIDWORKS Configurations — DriveWorks](https://www.driveworks.co.uk/articles/ultimate-guide-to-solidworks-configurations/)
- [Aligning Constraint Generation with Design Intent in Parametric CAD — arXiv](https://arxiv.org/pdf/2504.13178)
- [What's New in SOLIDWORKS 2026 — Dassault Systèmes](https://www.solidworks.com/product/whats-new)

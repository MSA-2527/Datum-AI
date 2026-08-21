# DATUM — Technical Audit, Competitive Position, and Path to an Industrial-Scale AI CAD Company

**Audit date:** 20 August 2026
**Subject:** `D:\Application` (DATUM), commit state as staged
**Scope:** Full architecture read, AI/ML methodology review, comparison against SolidWorks/Fusion and the AI-CAD cohort (Zoo, Autodesk, MecAgent, AdamCAD, Leo AI), and against `github.com/ForgeCAD/forgecad-public-kit`
**Assessment basis:** Source code as written. Where a document in the repo and the code disagree, the code is treated as the fact.
**Mandate:** Analysis only. No code was modified.

---

## 0. Executive summary

DATUM is a genuinely impressive piece of engineering that is **positioned against the wrong competitor set** and is **one architectural decision away** from being investable at scale.

Three findings dominated the first draft of this report. **One of them was wrong** and is
marked as withdrawn below, with the evidence that disproves it. It is left in place rather than
deleted because a report that quietly removes its own mistakes cannot be trusted about the ones
it keeps.

**Finding A — WITHDRAWN. The exact geometry kernel is wired, and it works.**

> **Correction, 20 August 2026.** This finding was wrong, and it was wrong in the way that
> matters most: it was the report's headline claim and it would have failed in a diligence
> room in one click.
>
> The original finding rested on a repo-wide grep for **static** imports of `kernel/brep/`,
> which returned zero sites. The import is **dynamic**, and deliberately so:
> `modelStore.ts:568` reads `const { exactFromDocument } = await import('./kernel/brep/fromDocument')`,
> inside `makeExact()`, with a header explaining that 66 MB of WebAssembly must stay out of the
> main chunk. The **Exact** button exists at `components/ModelStudio.tsx:213–217`. The
> production build emits `assets/fromDocument-*.js` and `assets/opencascade.wasm-*.wasm` as
> separate chunks, which only happens for a module that is actually reachable.
>
> Verified in the running application: building `a 50 mm cylinder 80 mm long` gives a
> tessellated **156.67 cm³**; pressing **Exact** returns *"Rebuilt exactly: 1 solid. 3 faces,
> 157079.63 mm³ — exact, not tessellated."* The closed form is π × 25² × 80 =
> **157079.63267 mm³**. Exact to five significant figures, against 0.26% low tessellated, and
> three analytic faces rather than a triangle count.
>
> `docs/ROADMAP.md` was right and this report was wrong. The lesson for anyone auditing a
> lazily-loaded module: grep the build output, not only the source.

**What remains true from this finding.** The mesh kernel is still the default path, and
everything downstream of it — mass properties in the status bar, the drawing, the DFM
measurements, the benchmark — measures the tessellated solid, not the exact one. Exact is a
*view* for measuring and exporting, by design (`modelStore.ts:560`). The genuine opportunity is
not wiring it; it is **publishing the delta**: the volume-error figure above is a headline
number no competitor in the cohort can state, and it is currently visible only to a user who
happens to press the button.

**Finding B — There is no learned model anywhere in the system.**
The `ml/` directory contains exactly one estimator: closed-form **ridge regression on 256 hashed text features predicting a 3-number bounding box** (`ml/ridge.ts`, `ml/dimensions.ts`), gated to refuse below 8 examples. That is not text-to-CAD; it is a size prior. Text-to-CAD is a hand-written recursive-descent parser (`generate/parse.ts`, 668 lines) plus a clause composer (`generate/compose.ts`, 637 lines) over a **27-archetype catalogue** and **8 hard-coded assembly recipes**. Photo-to-CAD is **100% classical computer vision** — Otsu threshold, Moore contour tracing, Douglas-Peucker, line/arc fitting, and shape-from-shading (`ingest/image/trace.ts`, `relief.ts`). No neural network is trained, fine-tuned, or run anywhere. The code is admirably honest about this; the pitch cannot be.

**Finding C — The LLM provider layer is text-only, which structurally forecloses vision.**
`CompletionRequest` in `ai/providers.ts` is `{ system: string; user: string; maxTokens?; signal? }`. There is no image content block, no multimodal message array, no base64 attachment path. Every provider adapter (Anthropic, OpenAI, Gemini, Groq, Ollama) sends text. Consequently a photograph can **never** reach a vision model — which is precisely how every credible 2026 competitor does image-to-CAD. This is a ~200-line change that unlocks an entire product category.

**The honest verdict on the stated mandate.** Against "replace SolidWorks, Fusion 360, and all AI CAD tools," DATUM today scores roughly **2.1 / 5** on its own five requirements (detailed in §5). It cannot generate an arbitrary part from text — it refuses anything whose head noun is not in a 27-item catalogue, by design. It cannot build a rocket from a prompt; it has a hard-coded rocket recipe. That gate is *good engineering* — refusing beats hallucinating — but it is a **ceiling**, not a foundation, and no amount of adding archetypes escapes it.

**The reframe that makes this fundable.** DATUM's differentiators are real and rare: exact mass properties via the divergence theorem, Shewchuk adaptive predicates, 16 analytically-Jacobian'd sketch constraints, true hidden-line removal, ISO 2768 tolerancing, DFM rule packs with cited limits, and a benchmark that asserts against closed-form physics rather than golden snapshots. **That is a verification and manufacturing-truth layer, and nobody else in the AI-CAD cohort has one.** Zoo generates geometry it cannot prove is manufacturable. MecAgent and AdamCAD generate code that may not execute. DATUM's refusal discipline and citation-per-finding architecture are exactly what a $50M mechanical program needs and cannot buy. Sell that, then bolt generative capability on top of it — not the reverse.

---

## 1. What DATUM actually is

### 1.1 Shipping architecture

The product is the **TypeScript application in `ui/`**. The `.NET` solution is peripheral:

| Project | Target | Status |
|---|---|---|
| `DATUM.Kernel` | net48 | **A SolidWorks `ISwAddin`, not a geometry kernel.** README states it "has never been compiled." |
| `DATUM.Orchestrator` | net8.0-windows | Local service — planner routing, SQLite storage, DPAPI credential store, update service |
| `DATUM.Studio` | net8.0-windows | WPF + WebView2 shell that hosts the same web bundle |
| `DATUM.Contracts` | netstandard2.0 | Operation IR and wire protocol |

`Directory.Build.props` still declares `<Product>DATUM for SOLIDWORKS</Product>`. Naming the SolidWorks add-in "Kernel" is an active liability in a diligence room — a technical reviewer opening `src/DATUM.Kernel/` expects a geometry kernel and finds COM interop against `HoleWizard5` and `AddMate5`.

### 1.2 The real engine

~50k lines of TypeScript, all browser-resident, no server required:

```
kernel/math/predicates.ts   Shewchuk adaptive exact orient2d/orient3d
kernel/math/linalg.ts       LU, Householder QR, Jacobi SVD, pseudo-inverse, null space
kernel/math/nurbs.ts        B-spline basis/derivatives, exact rational conics, interpolation
kernel/topo/mesh.ts         Indexed mesh, exact mass properties (divergence theorem),
                            closure/manifoldness/Euler/genus checks, T-junction repair
kernel/sketch/solver.ts     Variational solver, 16 constraint types, analytic Jacobians
kernel/ops/boolean.ts       BSP boolean + Manifold-3d fast path
kernel/ops/modify.ts        Shell, chain fillet/chamfer, holes, patterns, mirror (59k)
kernel/assembly/assembly.ts Instances, 7 mate types, mate solver, interference, BOM
kernel/brep/exact.ts        OpenCascade wrapper — WRITTEN, WIRED TO NOTHING
```

**The kernel is a mesh kernel.** `kernel/brep/load.ts` says so in its own header: *"DATUM's own kernel is triangles. That is why a fillet is approximated by cutting with a swept tool rather than built as a true rolling-ball blend, why a 6 mm hole measures 5.94 mm."* The README concedes curved-body volume runs 0.4% low at default quality.

**Manifold-3d *is* wired in.** `kernel/ops/boolean.ts:431` tries `manifoldBoolean` first and falls back to the BSP engine. So the codebase already proves it can adopt a third-party geometry library successfully — which makes the OpenCascade orphan a wiring oversight, not a capability gap.

### 1.3 Verification posture — the genuine crown jewel

`eval/cases.ts` opens with a design rule most ML teams never articulate:

> *"Every expectation here has to be defensible without running the product … recording what the system currently emits and asserting it does not change proves only that the system is consistently wrong, and locks the mistake in as the specification."*

Expectations may only be **physical invariants** (closed solid, positive volume, plausible mass) or **published figures** (ISO fastener across-flats, a dimension the user stated). `eval/baseline.json` refuses downward re-baselining in its own note. `expect.volumeMm3` exists specifically to catch a *dropped operation* — a box asked to be hollow that comes back solid passes every dimensional check and only fails on volume. `expect.featureKinds` asserts the result is still **editable** rather than a fused lump.

This is better evaluation thinking than most funded AI-CAD startups have. **It is also only 22 cases** — grown from 10 on 20 August 2026 to cover composition, refusal correctness, drawing fidelity and manufacturability, but still small enough that breadth is the next thing to buy.

---

## 2. AI and ML methodology — reviewed in detail

### 2.1 Text-to-CAD: a parser, gated by design

Three routes, tried in order (`ai/decompose.ts`):

1. **Built-in recipe** — 8 hand-written assemblies: `phone, laptop, motor, gearbox, aeroplane, chair, rocket, bicycle`
2. **Single-shape catalogue** — 27 archetypes: `bottle box bracket car cup cylinder enclosure engine flange frame funnel gear handle hook knob lamp nut pipe plate pulley rack shaft sphere table tray washer wheel`
3. **Language model** — only if configured, and **only to emit an `AssemblyPlan`**, never geometry

The LLM constraint is architecturally sound and worth preserving verbatim in the pitch:

> *"A model is asked for a plan, never for geometry. It picks from the same closed vocabulary of shapes the rest of the application uses and supplies numbers; it cannot emit a mesh, a script, or an operation the kernel does not implement."*

**The head-noun gate** (`generate/parse.ts:263-367`) is the defining behaviour. If the request's head noun is not a known archetype, the request is **refused by name**. "A crankshaft for a 4-cylinder engine" is rejected rather than answered with the cylinder its subordinate clause mentions. Four eval cases exist purely to assert refusals: `refuse-crankshaft`, `refuse-bearing`, `refuse-capscrew`, `refuse-turbine`.

**Assessment.** As engineering, this is right — silent wrongness is the worst failure mode in CAD. As a *product*, it means DATUM answers a bounded vocabulary and declines the open world. Requirement 1 says "any part … including the most complicated parts humans can make." A 27-item catalogue with a refusal gate is the architectural opposite of that. **You cannot reach requirement 1 by adding archetypes; the cost is linear and the world is infinite.**

**The composer** (`generate/compose.ts`) partially escapes this. It reads a request as base shape + modifier clauses over `{box, cylinder, tube, sphere}` × `{hole, fillet, chamfer, shell, pocket, slot}`, with per-clause measurement scoping so the "3" in "3 mm walls" cannot leak into the box height. Unhandled clauses are reported, never dropped. This is the right primitive — **it is a tiny hand-written CAD DSL** — but it is 4 bases × 6 operations, and it is not exposed as a language a model can freely write.

### 2.2 Photo-to-CAD: excellent classical CV, zero learning

`ingest/image/trace.ts` (32k) — Otsu threshold → Moore contour tracing with hole nesting → Douglas-Peucker → **line and arc recognition with reported residuals**. The header correctly identifies why arc fitting is the step that matters: *"a drawing needs 'R12.4', not four hundred coordinates."* Most image-to-CAD tools skip it.

`ingest/image/relief.ts` (18k) — shape-from-shading. Uses the silhouette twice, cleverly: once to recover light direction for free (at a smooth object's edge the normal lies in the image plane), once as the boundary condition that pins the integration. The header is explicit: *"classical computer vision rather than a learned model — worth saying plainly, because this application has no server to run a network on and no dataset to train one with."*

**Assessment.** Silhouette-only, single-view, requires an explicit mm/pixel scale. It cannot see an occluded feature, read a hole it cannot see through, or interpret a title block. Compare **Zero-to-CAD (arXiv 2604.24479)**, which fine-tuned a **2B vision-language model** on 999,633 synthetic CAD programs and hit **82.1% success / 0.747 mean IoU** on in-distribution image-to-sequence reconstruction, beating GPT-5.2's 0.485 IoU, and generalised to **61.0%** on human-designed ABC geometry. That is the bar in 2026, and DATUM has no path to it because — per Finding C — **an image cannot physically reach a model through the current provider interface.**

### 2.3 "Training": retrieval plus a size prior

`lib/training.ts` is scrupulously honest:

> *"It is **retrieval-augmented few-shot learning** … It is **not** gradient fine-tuning. Nothing here adjusts a model's weights … `toJsonl` exists for exactly that day."*

`ml/dimensions.ts` + `ml/ridge.ts` is the only actual learning: ridge regression, 256 FNV-1a-hashed text features, trained in **log-millimetres** (correct — proportional error is how being wrong about size actually hurts), primal/dual form chosen by matrix shape, cross-validated, and **it declines to answer** unless it beats median-prediction by 25% *and* lands under 50% typical error. `MIN_EXAMPLES = 8`.

The two-gate refusal logic is genuinely sophisticated statistics, and the comment explaining why beating the baseline alone was insufficient (a noise corpus still "won" by 9% while being 190% out) shows real rigour.

**Assessment.** It predicts a **bounding box**. It does not predict geometry, topology, features, or a feature tree. Calling this "trained on specific parts and geometries" (requirement 5) is not sustainable in diligence. `datum-training.jsonl` is 13,953 bytes — roughly a few dozen examples. A fine-tune needs 10⁴–10⁶.

### 2.4 The reasoning stack

`ai/` contains a real agentic scaffold: `requirements.ts` (extract checkable requirements), `reason.ts` (record steps and whether the result meets the ask), `critique.ts` (inspect built geometry), `decompose.ts` (plan + validate + **repair loop**), `edit.ts` (natural-language edits to an existing tree), `clarify.ts`. Plans are validated and repaired, corrections and dropped items are surfaced, and retrieved exemplars that steered an answer are **named in the reply**.

`reference/` adds a standards corpus (`standards.ts`, 22k) with retrieval and `audit.ts` producing cited findings. `lib/limits.ts` states manufacturing limits **once**, injected into the planner prompt *and* enforced by the linter — so prompt and linter cannot disagree. That single-source-of-truth pattern is excellent and rare.

**This is the most fundable part of the AI stack**, and it is undersold because it sits behind a parser that refuses most requests.

---

## 3. Comparison against SolidWorks, Fusion 360, and traditional CAD

| Capability | SolidWorks / Fusion / NX | DATUM | Gap |
|---|---|---|---|
| **Geometry representation** | Parasolid / ACIS / Fusion — analytic NURBS B-rep throughout | **Triangle mesh**; OCCT present but unwired | **Critical.** Volume 0.4% low; 6 mm hole measures 5.94 mm |
| **Fillets** | True rolling-ball blends, correct corner patches | Swept-tool approximation; three-face corners wrong | **Critical.** Corner patches are unreachable in mesh |
| **Sketch constraints** | ~20 types, drag-to-solve, full DOF diagnosis | **16–22 types, analytic Jacobians, 4-state diagnosis** — genuinely competitive; **no dragging** (type values only) | Moderate |
| **Feature set** | 200+ features | 24 modelling features | Large but tractable |
| **Surfacing / freeform** | Full NURBS surfacing, class-A | None | **Critical for automotive/aero** |
| **Assemblies** | Thousands of parts, motion, contact, FEA | Instances, 7 mates, interference, BOM; **static only** | Large |
| **Drawings** | Full GD&T, sections, details, BOM balloons | HLR + auto-dims + ISO 2768 + GD&T + title block; **no sections/details** | Moderate |
| **File exchange** | Everything | STEP AP203/214 (planes/cylinders/cones only), DXF, SVG, STL | Large — no Parasolid, JT, native reads |
| **PDM / versioning** | Enterprise PDM, Vault, Teamcenter | localStorage | **Critical for enterprise** |
| **Simulation** | FEA, CFD, thermal, motion | None | Large |
| **Install / licence** | Multi-GB, seat licence, Windows | **Zero-install, browser, offline, free tier** | **DATUM wins decisively** |
| **Mass properties** | Exact | **Exact — divergence theorem, full inertia tensor** | **Parity** |
| **DFM** | Add-in / third-party | **Built-in rule packs with cited limits + cost model** | **DATUM wins** |

**Read.** DATUM is not a SolidWorks replacement and will not be on any realistic timeline — the gap is 30 years of surfacing, simulation, PDM, and file exchange. It is, however, already a credible **early-stage design and manufacturing-review tool** that runs where SolidWorks cannot: in a browser, offline, with no seat. That is a real wedge. Positioning it as a SolidWorks replacement invites the one comparison it cannot win.

---

## 4. Comparison against the AI-CAD cohort

### 4.1 Zoo (zoo.dev / KittyCAD) — the direct competitor

Zoo built their **own B-rep kernel from scratch** rather than licensing Parasolid, with **GPU-accelerated surface/surface intersection** reformulated as parallel root-finding. B-rep is maintained **throughout the entire stack** — never converted to mesh — preserving exact NURBS and parametric editability at every stage. Text-to-CAD outputs **B-rep surfaces exported as STEP**, importable and editable in any CAD program. **Zookeeper** is a conversational agent on a Plan → Act → Observe → Update loop that writes **KCL** (KittyCAD Language) code, executes it, debugs it, queries mass/COM/surface area/volume, and **reviews geometry visually via multi-view snapshots**. They offer **enterprise fine-tuning on customer CAD libraries** (NX, Creo, CATIA, SolidWorks).

| Axis | Zoo | DATUM |
|---|---|---|
| Kernel | Own B-rep, GPU SSI, NURBS end-to-end | Mesh; OCCT unwired |
| Model output | KCL code → executed → B-rep | JSON `AssemblyPlan` → 27 archetypes |
| Agent loop | Plan/Act/Observe with visual review | Plan → validate → repair (no visual observe) |
| Vision | Multi-view snapshot review | **None — text-only provider** |
| Fine-tuning | Enterprise, on customer libraries | None (JSONL export only) |
| Expressiveness | **Turing-complete DSL** | **Closed 27-item vocabulary** |
| Verification | Mass/volume queries | **Physics-invariant benchmark, DFM rule packs, refusal discipline** ← DATUM wins |

**The structural lesson.** Zoo's LLM writes **code in a language**, so its expressive ceiling is the language's, not a catalogue's. DATUM's LLM fills **fields in a fixed schema**, so its ceiling is 27 archetypes. Both are "constrained generation" and both prevent triangle-soup — but one scales to arbitrary parts and one does not. **DATUM's `compose.ts` is already a miniature version of the right idea and should be promoted to a real DSL.**

### 4.2 ForgeCAD (`ForgeCAD/forgecad-public-kit`) — the closest architectural mirror

919 stars, 102 forks, 1,295 commits, MIT-licensed public kit; core app and backend are closed. Thesis: **"TypeScript is the file format. The browser is the CAD system."** Models are `.forge.js` files that become live parametric models with parameters, assemblies, validation, renders, inspections, and exports.

Capabilities: Monaco editor + live parameters + real-time 3D viewport; code-first API for primitives, sketches, booleans, transforms, offsets, constraints, patterns, **and SDF/level-set workflows**; named shapes with face/edge references; fillet/chamfer helpers; geometry inspection, dimensions, BOMs; **assemblies with parts, connectors, joints, coupled motion, and collision/clearance checks**; CLI for validation, **parameter sweeps**, rendering, inspection bundles, mesh export; STEP and STL export.

**Its AI architecture is the key transferable lesson.** Installable **agent skills** (`forgecad skill install`) covering design specification, model building, **CAD reconstruction**, **image-based reconstruction**, inspection, grading, **MuJoCo simulation verification**, and project sync. The canonical loop is:

> `agent edits .forge.js → forgecad run → forgecad inspect <evidence> → iterate`

Skills flatten into single context files for chat tools without shell access. They publish an **LLM benchmark table** (Feb 2026) across GPT-5.2-codex, Claude Opus, Gemini, DeepSeek, Qwen, MiniMax, Amazon Nova on prompts like "home AC unit with assembly requirements," "detailed 3D printer," "robot hand mechanics," scored by whether the model renders a working GIF or throws a runtime error.

**Head-to-head:**

| Axis | ForgeCAD | DATUM |
|---|---|---|
| Model representation | **Code (`.forge.js`) — the file format** | JSON feature tree |
| Generative ceiling | **Whatever a program can express** | 27 archetypes + 4×6 composer |
| Agent integration | **Installable skills, evidence-driven loop, CLI** | Internal planner only, no CLI, no skills |
| Verification in the loop | `inspect` returns **evidence** the agent iterates on; **MuJoCo physics** | Critique exists but is not an agent-callable tool contract |
| Simulation | MuJoCo | None |
| Sweeps | CLI parameter sweeps | None |
| Ecosystem | **919 stars, 102 forks, public issues, published benchmark** | Private repo, no community |
| Geometry rigour | Not disclosed; SDF/level-set | **Shewchuk predicates, exact mass props, closed-form-asserted tests** ← DATUM wins |
| Manufacturing truth | Not evident | **DFM packs, ISO 2768, cost model, anodizing domain** ← DATUM wins |

**What DATUM should take from ForgeCAD, in priority order:**

1. **Code as the file format.** This is the single decision that removes the archetype ceiling.
2. **An agent-callable tool contract.** `run`, `inspect`, `measure`, `critique`, `dfm` as named tools returning structured evidence — DATUM already has all this logic internally; it is not exposed as a tool surface an external agent can drive.
3. **A CLI.** No headless path exists today. This blocks CI, batch generation, dataset synthesis, and every enterprise pilot.
4. **A published benchmark with named models.** ForgeCAD's table is marketing *and* a technical moat.
5. **Skills/packaging.** Distribution through agent ecosystems rather than through a UI.

### 4.3 MecAgent, AdamCAD, Leo AI, Autodesk

- **AdamCAD** — YC W25, **$4.1M raised**, text-to-3D generation. Direct comparable for what a seed round buys in this space.
- **Leo AI** — deliberately **not** primarily generative. Positions on **search-and-reuse across PDM/PLM** (SolidWorks PDM, Autodesk Vault, PTC Windchill, Siemens Teamcenter, Arena PLM) with visible calculation logic and source citations. Their published critique of generative text-to-CAD: it produces *"geometry with no feature tree, no tolerance data, no material callouts"* and treats CAD generation *"like image generation."* **DATUM answers that critique directly — it has all three — but only Leo is saying it out loud.** DATUM's `lib/reuse.ts` ("have we already made this?", asked *before* generation) is the same insight, implemented, and unmarketed.
- **Autodesk** — Fusion generative design/topology optimisation, plus the **Fusion 360 Gallery** dataset (real human design sequences) — a data moat DATUM has no equivalent of.
- **Text2CAD-Bench (arXiv 2605.18430)** — 600 human-curated cases, L1–L4 difficulty, dual-style prompts, scored on **Chamfer Distance, Invalidity Rate, IoU**, plus VLM multi-view scoring at L4. Tested GPT-5.2, Claude-4.5-Sonnet, Gemini-3-Flash, DeepSeek-V3.2, Qwen3-max, MiniMax-M2.1, GLM-4.7 plus domain models Text2CAD, Text2CADQuery, CADFusion. **Headline: invalidity rates spike to 70–90% on advanced features (L3/L4).** That failure rate is the market opening — and DATUM's refusal architecture is the correct response to it, if it can be made to *build* rather than only to *decline*.

---

## 5. Scorecard against the five stated requirements

| # | Requirement | Score | Evidence and gap |
|---|---|---|---|
| **1** | Any part from text, including the most complex humans can make | **1.5 / 5** | 27 archetypes + 4-base × 6-operation composer. Head-noun gate **refuses by design** anything else. "Crankshaft," "bearing," "capscrew," "turbine" are eval cases asserting *refusal*. No path to arbitrary parts without a generative representation. |
| **2** | Any assembly from text, editable, incl. rockets/cars/machinery | **2 / 5** | 8 hard-coded recipes (`rocket` is a literal recipe, not a generated decomposition). LLM route emits a validated `AssemblyPlan` and *is* editable with a real feature tree — genuinely good — but constrained to the same closed shape vocabulary. Static assemblies only; no kinematics. |
| **3** | 2D drawings / CAD drawings / photos → part or assembly | **2.5 / 5** | **Strongest requirement.** Photo→profile with real arc recognition; shape-from-shading relief; DXF→solid via view recognition; STEP→solid via own Part 21 reader. But: silhouette-only, single-view, scale must be supplied, STEP limited to planes/cylinders/cones (splines/tori/spheres skipped), DXF is visual hull only, **and no vision model is reachable**. |
| **4** | Manufacturing-ready engineering drawings | **3 / 5** | **Best-scoring.** True depth-buffer HLR, automatic dimensioning, **ISO 2768-m tolerances**, grouped hole callouts, GD&T, title block with computed mass, SVG + DXF out. Missing: section views, detail views, BOM balloons, sheet sets, weldment/sheet-metal flat patterns with bend tables. Repo's own ROADMAP contradicts itself here (claims "no tolerances, GD&T or title block" while the code has all three) — resolve before diligence. |
| **5** | Trainable on specific parts/geometries to generate better combinations | **1.5 / 5** | Retrieval-augmented few-shot + a ridge-regression **bounding-box** predictor requiring ≥8 examples. No gradient training, no geometric generative model, no embeddings over geometry (`reuse.ts` explicitly notes matching is on *words*, not geometry — *"there is no part yet to compare geometry against"*). |

**Weighted total ≈ 2.1 / 5.**

---

## 6. Ranked gap list

### Tier 0 — Do these before any investor conversation (days to weeks)

**0.1 — ~~Wire OpenCascade~~ → DONE ALREADY. Publish the number instead.**
Withdrawn: see Finding A. The kernel is wired through a dynamic import, the **Exact** button
ships, and it returns 157079.63 mm³ against a closed form of 157079.63267 mm³.

What is left is presentation. That figure — *exact to five significant figures, versus 0.26%
low tessellated* — is the single most persuasive number in the repository and it appears
nowhere except in a transient notice after a user presses a button. Put it in the benchmark as
a case, in the README as a headline, and in the pitch. Nobody else in the cohort can state a
volume error at all, because nobody else asserts against closed forms.

**0.2 — Reconcile every claimed number. → DONE.**
The finding was correct: five documents stated five different sets of figures, every one true
on the day it was typed.

Fixed as recommended — generated from the code, in CI. `ui/src/lib/facts.ts` derives the counts
from the same arrays the product runs on; `facts.test.ts` fails the build if any document
states one that no longer matches; `tools/facts.mjs` regenerates `docs/FACTS.md`, and a CI step
fails if that file is out of date. `CONSTRAINT_KINDS` was promoted from a bare type union to a
runtime array so its count is derivable at all.

The three stale claims it immediately caught — README's *16 constraint types* (17), the status
report's *15 parametric archetypes* (27) and its *16 constraint types* — are corrected. The
truth, counted: **27 archetypes, 8 recipes, 17 constraint types, 24 modelling features, 1,774
tests, 22 benchmark cases, 54,167 lines of product code.**

**0.3 — Rename `DATUM.Kernel`. → DONE.**
Renamed throughout: the directory, the project file, `AssemblyName`, `RootNamespace` and all
seven C# namespaces (`Datum.Kernel.*` → `Datum.Connector.SolidWorks.*`, 26 files), plus the
solution entry, the CI path and every reference in the README and docs. Nothing outside the
project referenced those namespaces, which is what made a complete rename safe rather than a
half one.

`<Product>DATUM for SOLIDWORKS</Product>` is now `<Product>DATUM</Product>` — it was stamping
that name onto every assembly, including the ones that never touch a CAD seat.

**Unverified:** there is no .NET SDK on this machine and no SOLIDWORKS seat, so the project
still cannot be compiled here — as it could not before. The rename is a mechanical token
substitution over a self-contained project with no external consumers, and the CI job that
attempts it is advisory (`continue-on-error: true`).

**0.4 — Add image support to `CompletionRequest`.**
Change `{system, user}` to accept content blocks with base64 images, and implement in the Anthropic/OpenAI/Gemini adapters. ~200 lines. This is the gate on the entire photo-to-CAD roadmap.

### Tier 1 — The architectural decision that determines the ceiling (1–2 quarters)

**1.1 — Introduce a CAD DSL and make it the model's output target. → DONE.**
`ui/src/generate/script.ts` (DatumScript) and `ui/src/ai/scriptRoute.ts`. Declarative by
design — no loops, no branches, no functions — so the guarantee survives: every
statement names a feature the kernel implements, every argument is checked against that
feature's own schema, and a script that could not be built does not parse. It round-trips, so
a part built by clicking reads as a program and a program edits with the sliders; the Studio
has a Script view that does both. The model writes it and its errors go back by line, all at
once, twice. Routed on the study pass's own ONE-PART/ASSEMBLY verdict, so an assembly costs
no extra call.

The original recommendation follows.


This is the report's central recommendation. Both credible comparables converged on it independently: Zoo emits **KCL**, ForgeCAD emits **`.forge.js`**. DATUM emits **JSON fields in a 27-slot schema**.

The migration is unusually cheap here because `generate/compose.ts` already *is* a small DSL — base shapes plus operation clauses with scoped measurements. Promote it:

- Define `DatumScript`: a small, sandboxed, deterministic language over sketches, features, patterns, expressions, and assemblies. `model/expr.ts` already has an expression evaluator; `model/document.ts` (106k) already has the full feature vocabulary.
- Make the **document format** the script, with the JSON tree as its evaluated form.
- Make the LLM write **script**, execute it in the kernel, and **feed errors back** — the Zero-to-CAD result showed a 22.3% first-attempt success rate rising to a usable corpus at **3.3 attempts average**. The repair loop is where the quality is.
- Retire the head-noun gate as the primary path. Keep it as a **fast deterministic route** for catalogue hits — it is genuinely better than an LLM for "M10 hex nut" — but stop letting it define the ceiling.

**Consequence:** requirement 1 goes from 1.5 to a plausible 4, and requirement 5 becomes reachable because a script corpus is fine-tunable in a way a 27-slot schema is not.

**1.2 — Expose an agent tool contract and a CLI. → DONE.**
`ui/src/cli.ts`, built to one Node file by `npm --prefix ui run cli`. Commands: `run`,
`inspect`, `dfm`, `export`, `print`, `corpus`. Every one answers with **evidence rather than a
verdict** — `inspect` returns volume, mass, envelope, centroid, closure, genus and every
feature with its state; `dfm` names each rule that fired and the limit it enforces — and
`--json` gives the same content as one object. Exit codes are load-bearing: an open solid, a
failed feature or a blocking finding each fail the command, so any of them gates a build. CI
builds it and exercises every command. 22 tests.

Two real defects surfaced within minutes of the CLI existing, which is the argument for having
it: `cx`/`cy` were read by `holePositions` and declared in no schema, so a bolt circle could
only ever sit on the origin — not by decision but because the field to move it was missing
from what the editor and the parser both read; and `run` reported an open solid without naming
the feature that opened it, leaving a CI job to bisect by hand.

`render` and `sweep` are not built. Rendering needs a GPU context Node does not have without a
headless surface, and a sweep is a loop over `run`.

**1.3 — Close the visual observation loop. → DONE.**
The blocker was not the loop, it was that `viewport/renderer.ts` is WebGL and needs a browser
and a canvas — so the two cases where seeing the part matters most, a command line and a
model reviewing its own work, both had no way to see it.

`ui/src/render/raster.ts` is a software rasteriser: orthographic, z-buffered, Lambert-shaded,
plain arithmetic, no context and no platform. Orthographic deliberately — a perspective view
is prettier and worse to judge from, which is why engineering drawings are not. It runs
identically in Node and the browser, which also makes it testable: a cube seen square-on covers
the fraction of the frame its fit implies, and that is an assertion rather than a screenshot to
eyeball. `ui/src/render/png.ts` encodes the result with no dependency, using DEFLATE stored
blocks — twenty lines instead of a compressor, and the size does not matter for images a
model resizes before looking at them.

`ui/src/ai/review.ts` renders four views, sends them with the request, and asks whether the
part is the thing that was asked for. A verdict of `wrong` becomes another repair round
carrying what was *seen* rather than a line number. Anything unreadable is `unsure`, never
approval or rejection: a review that cannot be parsed must not condemn a good part or pass a
bad one, and `wrong` with nothing to point at is not actionable either. On by default wherever
the provider has eyes; it declines gracefully where it does not.

`datum render <file> --out v.png` writes the same views for a person. 31 tests.

### Tier 2 — Making the ML claims true (2–3 quarters)

**2.1 — Synthesise a training corpus. → BUILT, not yet run at scale.**
`ui/src/ml/synth.ts` and `datum corpus`. Six families of part are sampled over their own
dimensions, written as DatumScript, executed through the same kernel the product runs on, and
kept only if the result is closed, manifold and has positive volume — with the measurement
and any manufacturability findings attached to each pair. Reproducible from a seed. Measured
yield **99% over 200 programs**; the rejections are genuine boolean failures the judge caught.

The filter is the part that matters and the part nobody else can copy cheaply: a corpus
filtered on "it parsed" teaches a model to write plausible-looking scripts, and one filtered
on "it produced a manufacturable solid" teaches it to write parts. What remains is breadth —
six families is not 10⁵ distinct parts, and generator variety is now the limiting factor
rather than infrastructure.

**2.2 — Fine-tune a small model on DatumScript.** Zero-to-CAD's 2B VLM beat GPT-5.2 by 54% relative IoU on image-to-sequence. A small specialist model that runs locally is also the answer to enterprise data-residency objections — and it preserves DATUM's offline-first identity, which is a real differentiator.

**2.3 — Geometric retrieval.** `reuse.ts` matches on words and admits it. Add shape descriptors (D2 shape distributions, spherical harmonics, or a learned encoder over the mesh) so "have we already made this?" works on geometry. This makes Leo AI's search-and-reuse thesis available to DATUM, on top of generation rather than instead of it.

**2.4 — Vision-based reconstruction.** With 0.4 and 1.3 in place: multi-view photo → feature tree, orthographic drawing sheet → model, hand sketch → parametric part.

### Tier 3 — Requirement completion (3–4 quarters)

- **Drawings:** section views, detail views, BOM balloons, sheet sets, flat patterns with bend tables → requirement 4 reaches 4.5/5
- **Sketcher:** drag-to-solve (the solver already handles rank deficiency with minimum-norm steps — the interaction is missing, not the math)
- **Assemblies:** kinematic joints, motion, contact; ForgeCAD ships MuJoCo verification
- **Exchange:** full STEP surface coverage (splines, tori, spheres), Parasolid/JT read
- **Surfacing:** NURBS surfacing — hard gate on automotive/aerospace credibility
- **Data:** replace localStorage with a real document store; version history; multiplayer

---

## 7. Positioning and the funding narrative

### 7.1 The claim to stop making

"Replaces SolidWorks, Fusion 360, and all AI CAD tools." Every technical reviewer will test it in ten minutes with a request outside the catalogue and get a refusal. The refusal is *correct engineering* and it will read as *incapability* against that claim.

### 7.2 The claim to make instead

> **DATUM is the verification layer for AI-generated CAD.**
>
> The 2026 problem is not generating geometry — it is trusting it. Text2CAD-Bench measures **70–90% invalidity rates** on advanced features across every frontier model. Leo AI's own critique of the category is that generated CAD arrives with *"no feature tree, no tolerance data, no material callouts."*
>
> DATUM has all three, plus exact mass properties, DFM rule packs that cite the standard they enforce, ISO 2768 tolerancing, a benchmark that asserts against closed-form physics rather than golden snapshots, and — uniquely — **an architecture that refuses rather than guesses.** Every operation it cannot build is named. Every example that steered an answer is cited. Every manufacturing limit is stated once and enforced by both the prompt and the linter.
>
> It runs in a browser with no install, no licence, no account, and no network.

That is defensible, differentiated, and **already true today**. It converts DATUM's biggest apparent weakness — the refusal gate — into the product thesis.

### 7.3 What each tier buys

| Milestone | What it proves | Comparable |
|---|---|---|
| Tier 0 complete | The claims match the code; exact geometry is real | Table stakes for DD |
| DatumScript + CLI + agent tools | The ceiling is removed; ecosystem-distributable | ForgeCAD (919★ on the kit alone) |
| Published benchmark, named models, Text2CAD-Bench numbers | Measurable, third-party-comparable capability | ForgeCAD's benchmark table |
| Synthetic corpus + fine-tuned specialist | A real, ownable ML moat | Zero-to-CAD; Zoo enterprise fine-tuning |
| Vision loop | Photo/drawing → editable parametric model | The category's most-demanded feature |

**Positioning against AdamCAD's $4.1M seed:** DATUM has substantially more engineering depth in the kernel, drafting, and verification than a text-to-3D generator. It has substantially less in generative reach and zero in ecosystem. Tier 0 + Tier 1 closes the gap on the dimension that is actually scored, while keeping the depth as the moat.

### 7.4 The one-line pitch

> **Every AI can draw a part. DATUM is the only one that can prove it can be made.**

---

## 8. Verification of this report's claims

Every finding above traces to a specific file. The load-bearing ones:

| Claim | Evidence |
|---|---|
| ~~OCCT orphaned~~ **WITHDRAWN** | The grep was for *static* imports. `modelStore.ts:568` imports it dynamically; the **Exact** button is at `ModelStudio.tsx:213`; the build emits `assets/fromDocument-*.js` and `assets/opencascade.wasm-*.wasm`; the running app returns 157079.63 mm³ against π×25²×80 = 157079.63267 mm³ |
| Manifold IS wired | `kernel/ops/boolean.ts:431` — `manifoldReady() ? manifoldBoolean(a,b,op) : null` |
| No vision path | `ai/providers.ts` — `CompletionRequest = { system, user, maxTokens?, signal? }`; no image field in any of 5 adapters |
| Only ML is ridge regression | `ml/` contains `ridge.ts`, `dimensions.ts`, `corpus.ts` only; `WIDTH = 256`, `MIN_EXAMPLES = 8` |
| 27 archetypes / 8 recipes | `grep -oP "id: '\K[a-zA-Z0-9_-]+" generate/archetypes.ts \| sort -u` → 27; same on `assembly/recipes.ts` → 8 |
| Refusal by design | `generate/parse.ts:263-367` head-noun gate; `eval/baseline.json` cases `refuse-crankshaft`, `refuse-bearing`, `refuse-capscrew`, `refuse-turbine` |
| 22 eval cases | `eval/baseline.json` — enumerated, `"score": 1`, recorded 2026-08-20 |
| Mesh kernel, not B-rep | `kernel/brep/load.ts` header: *"DATUM's own kernel is triangles … a 6 mm hole measures 5.94 mm"* |
| ~~Doc/code contradiction~~ **WITHDRAWN** | `docs/ROADMAP.md` was correct. OpenCascade is integrated and the **Exact** button exists |
| Count contradictions **FIXED** | Was: README (451 tests, 16 constraints) vs `07-status-report.md` (627, 15 archetypes) vs `ROADMAP.md` (1,549 cases, 54 shapes, 9 recipes, 22 constraints) vs code. Now generated: `docs/FACTS.md`, gated by `lib/facts.test.ts` and a CI step |

---

## Sources

- [ForgeCAD public kit](https://github.com/ForgeCAD/forgecad-public-kit)
- [Zoo — Zookeeper conversational CAD agent](https://zoo.dev/research/zookeeper)
- [Zoo — Design Studio v1: A New Stack for Mechanical CAD](https://zoo.dev/blog/zoo-design-studio-v1)
- [Zoo — Introducing Text-to-CAD](https://docs.zoo.dev/blog/introducing-text-to-cad)
- [Zoo — ML for CAD Design API](https://zoo.dev/machine-learning-api)
- [Text2CAD-Bench: A Benchmark for LLM-based Text-to-Parametric CAD Generation (arXiv 2605.18430)](https://arxiv.org/html/2605.18430v1)
- [Zero-to-CAD: Agentic Synthesis of Interpretable CAD Programs at Million-Scale Without Real Data (arXiv 2604.24479)](https://arxiv.org/html/2604.24479)
- [Leo AI — Best AI for CAD Generation in 2026](https://www.getleo.ai/blog/best-ai-for-cad-generation-2026)
- [AdamCAD review — YC W25, $4.1M raised](https://pasqualepillitteri.it/en/news/3372/adamcad-text-to-cad-ai-review-2026)
- [Autodesk Fusion 360 Gallery Dataset](https://github.com/AutodeskAILab/Fusion360GalleryDataset)

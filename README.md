# DATUM — a standalone AI CAD system

DATUM models, draws and exports mechanical parts on its own. It has its own geometry
kernel, its own constraint solver and its own drafting engine, so it needs **no CAD
licence, no installation and no network** to do any of its work.

SOLIDWORKS is supported as an **optional connector** for teams who need native files. It is
not a dependency, and nothing in the product stops working without it.

```
"make a cup"                          →  a revolved, shelled solid with a swept handle
a photograph of a bracket             →  a traced profile with real radii, ready to extrude
a two-view DXF                        →  the solid it describes, rebuilt
any solid                             →  a dimensioned, toleranced drawing in SVG and DXF
```

---

## What it does

| | What you get | Where it stops |
|---|---|---|
| **Model** | Extrude, revolve, sweep, loft. Boolean union/cut/intersect. Shell, fillet, chamfer, draft, pattern, mirror. Exact mass, centroid and inertia tensor at every step. | Tessellated, not analytic. Dimensions are exact; curved-body *volume* runs low by a known amount — 0.4% at default quality, under 0.03% at the finest. |
| **Sketch** | Draw lines, rectangles and circles; relations are inferred as you draw, so a rectangle is a rectangle and a near-horizontal line is horizontal. Every length and diameter is shown on the canvas and typing into one drives the geometry. 16 constraint types solved together, with under-defined, fully defined, over-defined and contradictory reported and the constraints at fault named. | 2D only. No dragging geometry yet — sizes are changed by typing them. |
| **Generate** | 15 parametric archetypes from plain English, with editable parameters and a real feature tree. Understands units, imperial fractions, ISO fastener designations and capacities. | A finite catalogue. Unrecognised requests are refused with suggestions, not approximated. |
| **Trace** | Image → closed profile. Otsu threshold, contour tracing with hole nesting, line and arc recognition, symmetry detection. | A scale must be supplied — an image records no size. Silhouette only. |
| **Import** | STEP AP203/214 → solid: a Part 21 reader and a B-rep tessellator, no dependency. DXF → solid, by recognising the views and intersecting their extruded outlines. | STEP: planes, cylinders and cones. Splines, tori and spheres are reported and skipped, never approximated. Parts whose cones meet other surfaces come back with hairline cracks and are reported as untrustworthy. DXF: visual hull — an enclosed cavity cannot be seen from outside. |
| **Draw** | Standard views with true hidden-line removal, automatic dimensions with ISO 2768-m tolerances, grouped hole callouts, GD&T, title block with computed mass. SVG and DXF out. | Envelope and hole pattern. Design-intent dimensions still need an engineer. |
| **Assemble** | Instances, seven mate types, a mate solver, interference detection that tells a press fit from a clash, mass properties and a bill of materials. | Static. No motion study, no contact simulation. |
| **Manufacture** | CNC, sheet metal, additive and moulding rule packs; every finding cites its rule. The same limits are stated to the planner *before* it designs, from one definition, so the prompt and the linter cannot disagree. Itemised cost model. | Cost is an estimate for comparing designs, not a quotation. |
| **Learn** | Your own parts become worked examples: a request, and the plan that answers it. A whole exported folder can be taught in one pass, geometry from the STEP files and requests from the manifest beside them, with an outcome reported for every file. The closest are retrieved and shown to the model at request time, so it builds in your vocabulary and conventions — and every example that steered an answer is named in the reply. Exports as JSONL for a real fine-tune later. | Retrieval, not gradient training: nothing adjusts a model's weights. An example must be expressible as a plan, so parts using sketches or fillets are refused rather than stored half-learnt. |
| **Recognise** | An imported solid is read back into something editable. A catalogue shape first — parameters derived from the mesh, the archetype rebuilt, the two compared. Failing that, the **extruded profile** itself: the solid is sectioned at every height its cross-section changes, each slab's outline traced, drilled holes recovered as circles with their diameters, and the stack re-extruded and checked. Accepted only at 97% agreement. | Catalogue: box, cylinder, pipe, washer, stepped shaft, hex nut. Profile: parts that section into a handful of constant slabs — a plain plate, a base with pads, a multi-level clip. Beyond a handful of levels a stack of slabs stops describing the design and becomes a voxelisation, and is refused. A solid that imports non-manifold is refused on that ground: a section is only as trustworthy as the solid it is cut from. |
| **Anodize** | Any part on screen sizes an anodizing rack: wetted area measured off the solid, current from the process density, spine/arm/contact sections from that current, tier count from tank depth, part pitch from solution flow, cooling load in kW and L/min, coating time and the growth that changes the fit. Eight quality checks, each stating its measurement and limit. | Steady-state figures a rack is sized from. No bath chemistry, rectifier ripple, or thermal transient. |
| **Reuse** | Saved parts are searched *before* anything is generated. A request that matches one is answered with the part rather than a second copy of it, and a stated dimension the saved part does not meet vetoes the match outright. | Local library only. Matching is on words, archetype and stated dimensions — there is no part yet to compare geometry against. |

---

## Try it

```bash
npm --prefix ui install
npm --prefix ui run dev
```

That is the whole setup. Then type `make a cup`, or `M10 hex nut`, or
`200 x 120 x 8 plate with 9 mm holes`.

### Deploying it

`npm --prefix ui run build` produces a folder of static files, and that is a complete
deployment rather than a demo of one — the kernel, the solver and the drafting engine all run
in the browser. GitHub Pages, an S3 bucket or any file server will do.

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes to GitHub Pages on
every push to `main`, gated on the type check, the test suite and the benchmark.

Two properties make a static host work, and both are load-bearing:

- assets are emitted with **relative** paths (`base: './'`), so the bundle runs from
  `user.github.io/repo/` without the repository name compiled into it;
- surfaces are selected with a query string (`?surface=studio`), not a path, so no
  single-page-app 404 fallback is needed.

What is absent on a static host is the optional half: the SOLIDWORKS connector and the local
orchestrator. The application detects their absence rather than probing for them, and runs
the standalone path — which is the free tier, and everything above.

---

## How it is built

```
ui/src/engine.ts            One entry point for everything below
ui/src/kernel/
  math/predicates.ts        Exact geometric predicates (Shewchuk adaptive arithmetic)
  math/linalg.ts            LU, Householder QR, Jacobi SVD, pseudo-inverse, null space
  math/nurbs.ts             B-splines: exact conics, interpolation, approximation
  math/vec.ts               Vectors, matrices, quaternions, bounding boxes
  topo/mesh.ts              Indexed mesh, exact mass properties, health checks
  sketch/profile.ts         Profiles, ear-clipping triangulation, offsets, corner rounding
  sketch/solver.ts          Variational constraint solver
  ops/build.ts              Extrude, revolve, sweep, loft
  ops/boolean.ts            BSP boolean engine with T-junction repair
  ops/modify.ts             Shell, fillet, chamfer, patterns, holes
  assembly/assembly.ts      Instances, mates, interference, BOM
ui/src/generate/            Text → parametric archetypes
ui/src/lib/limits.ts        Manufacturing limits as data: enforced by the linter, stated to the planner
ui/src/lib/library.ts       The named part library, and what was measured when each was saved
ui/src/lib/reuse.ts         "Have we already made this?", asked before anything is generated
ui/src/lib/training.ts      Your parts as worked examples, retrieved into the prompt at request time
ui/src/lib/bulk.ts          A folder of exports taught in one pass, with an outcome per file
ui/src/ingest/image/        Raster → profile
ui/src/ingest/drawing/      DXF → solid
ui/src/ingest/step/         STEP → solid: Part 21 parser, then B-rep to mesh
ui/src/drafting/            Solid → manufacturing drawing
ui/src/ingest/fit/          Mesh → archetype or extruded profile: propose, rebuild, verify
ui/src/domain/anodizing.ts  Rack sizing: area → current → section → cooling, every figure cited
ui/src/eval/                The benchmark: cases, runner, and the regression gate (npm run eval)
tools/solidworks/           Batch export from an existing SOLIDWORKS library
src/DATUM.Kernel/           SOLIDWORKS connector (optional, unverified — see below)
src/DATUM.Orchestrator/     Local service: planner routing, storage, audit
```

### The mathematics

Four decisions carry most of the weight, and each was made after the naive alternative
failed.

**Exact predicates where the input is exact.** Orientation tests in ordinary floating point
are occasionally wrong near coplanar geometry, and wrong *inconsistently* — the same point
classified differently by two neighbouring triangles, so the mesh fails to close. Real parts
are full of coplanar faces because engineers align things. `predicates.ts` implements
Shewchuk's adaptive scheme: the cheap answer plus a rigorous error bound, escalating to
exact expansion arithmetic only when the sign is genuinely in doubt.

**Epsilon classification where the input is derived.** The boolean engine deliberately does
*not* use the exact predicate. A vertex created by splitting an edge is only approximately
on its plane, so an exact test reports it as still spanning, the piece splits again, and the
recursion never terminates. Exactness makes it worse. The engine uses a scale-relative
epsilon, which terminates and is equally consistent. Both choices are documented where they
are made.

**Analytic Jacobians in the sketch solver, numerical ones in the assembly solver.** A sketch
has hundreds of variables and constraints like tangency that already involve cancellation; a
finite-difference Jacobian loses half the available precision and the solver stalls short of
tolerance. So every derivative is written out by hand — and verified against numerical
differentiation by a test, because a wrong sign there does not fail loudly, it converges to
plausible geometry that does not satisfy the constraint. An assembly has six variables per
component and rotation derivatives that are long and error-prone, so there the trade runs
the other way.

**Minimum-norm steps.** Both solvers are rank-deficient in normal use — that is what an
under-defined sketch or a mechanism *is*. Solving through the damped normal equations
squares the condition number and the step comes back too inaccurate to converge; the
pseudo-inverse handles the deficiency exactly and returns the solution that moves the
geometry least, which is also the one a user expects.

---

## Verification

```bash
npm --prefix ui test
```

**451 tests.** They assert against closed-form answers wherever one exists — a revolved
sphere must have volume 4/3·πr³, a cut block must lose exactly the volume of the cut, an
inscribed polygon must under-run its circle by exactly `1 − (n/2π)·sin(2π/n)` — because
comparing against a previous run only proves the kernel is consistently wrong.

Every boolean result is checked for closure, manifoldness and Euler characteristic. Every
archetype must produce a closed solid or report `valid: false` with a reason. Every
constraint's Jacobian is verified against central differences.

---

## The SOLIDWORKS connector

`src/DATUM.Kernel` is a .NET Framework 4.8 `ISwAddin` that pushes the same operations into a
live SOLIDWORKS session as native features.

**It has never been compiled.** Building it needs the interop assemblies that ship with a
licensed SOLIDWORKS installation, and there is none on this machine. It is reviewed code and
nothing more. When the easy two-thirds of the C# was first compiled it exposed a
showstopper and a silently-dead feature, so assume this contains defects of similar
severity until its first successful build.

Nothing in the standalone product depends on it. `src/engine.test.ts` enforces that: it
walks every user journey end to end and imports nothing from the connector.

```bash
# On a machine with SOLIDWORKS 2022–2026 installed:
dotnet build src\DATUM.Kernel\DATUM.Kernel.csproj -c Release
```

Expect interop signature drift — `HoleWizard5`, `AddMate5`, `FeatureLinearPattern5` and
`AutoBalloon5` all changed arity across those versions.

Everything else builds without a seat:

```bash
dotnet build DATUM.NoSolidWorks.slnf -c Release
dotnet test  DATUM.NoSolidWorks.slnf -c Release
```

---

## Configuration

Everything works with none of these set.

| Variable | Purpose |
|---|---|
| `DATUM_LOCAL_ENDPOINT` | llama.cpp / Ollama endpoint, for phrasing the built-in parser does not recognise |
| `DATUM_LOCAL_MODEL` | Local GGUF model id |
| `ANTHROPIC_API_KEY` | Bring your own key. No markup, no data retained |

A language model only ever maps unusual phrasing onto the same archetypes and parameters the
deterministic parser uses. There is exactly one code path that builds geometry, so a model
cannot produce something the kernel would not have built.

---

## Documentation

| Document | Contents |
|---|---|
| [docs/01-research.md](docs/01-research.md) | Designer problem inventory, input modalities, competitive read |
| [docs/02-architecture.md](docs/02-architecture.md) | Process model, operation IR, execution pipeline, safety model |
| [docs/03-product-spec.md](docs/03-product-spec.md) | Modules with acceptance criteria, release plan, metrics |
| [docs/04-ux-spec.md](docs/04-ux-spec.md) | Design system, screens, latency budgets, keyboard map |
| [docs/07-status-report.md](docs/07-status-report.md) | What is built, what is verified, what is not |

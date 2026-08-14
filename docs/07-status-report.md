# Status report

**What changed:** the product no longer depends on SOLIDWORKS. It has its own geometry
kernel, constraint solver, assembly solver and drafting engine, and every headline
capability runs with no CAD licence, no installation and no network.

SOLIDWORKS is now one connector among several, and it is the *only* part of the system that
has never been compiled.

---

## 1. Verification

```
npx tsc --noEmit                        →  clean
npm test                                →  451 passing, 17 files
npm run build                           →  clean, 90.5 KB gzipped
dotnet build DATUM.NoSolidWorks.slnf    →  0 warnings, 0 errors
dotnet test  DATUM.NoSolidWorks.slnf    →  176 passing
```

**627 tests in total.**

Tests assert against closed-form answers wherever one exists. A revolved sphere must have
volume 4/3·πr³; a cut block must lose exactly the volume of the cut; an inscribed n-gon must
under-run its circle by exactly `1 − (n/2π)·sin(2π/n)`. Comparing against a previous run
would only prove the kernel is consistently wrong.

| Area | Tests | What they establish |
|---|---|---|
| Geometry kernel | 75 | Exact predicates, linear algebra, NURBS, mass properties, booleans, construction |
| Constraint solver | 37 | All 16 constraint types solve; all 16 Jacobians verified numerically; four states diagnosed |
| Archetypes | 69 | Every shape closes; parameters traceable; engineering checks fire |
| Drawings | 42 | Hidden lines separated, no mirroring, dimensions match geometry, DXF/SVG valid |
| DXF import | 39 | Parsing, loop assembly, view recognition, reconstruction |
| Assemblies | 23 | Mates hold, measured on geometry; interference; mass; BOM |
| Image tracing | 26 | Accuracy against known synthetic shapes |
| End-to-end | 11 | Five complete user journeys with no connector |
| Pre-existing UI/DFM | 129 | Document model, DFM packs, recipes, persistence, diagnostics |

---

## 2. What was built

Roughly 11,000 lines of new, tested engine.

### Geometry kernel
- **`math/predicates.ts`** — Shewchuk adaptive exact arithmetic for `orient2d`/`orient3d`.
- **`math/linalg.ts`** — LU with partial pivoting, Householder QR, one-sided Jacobi SVD,
  pseudo-inverse, null space, rank, condition number, Cholesky, polynomial roots.
- **`math/nurbs.ts`** — B-spline basis and derivatives, exact rational conics, global
  interpolation, least-squares approximation, adaptive tessellation, closest point.
- **`topo/mesh.ts`** — indexed mesh with face tags, welding builder, **exact** mass
  properties via the divergence theorem (volume, centroid, full inertia tensor, principal
  axes), health checks (closure, manifoldness, Euler characteristic, genus), T-junction
  repair, ray casting, point-in-solid.
- **`sketch/profile.ts`** — profiles with holes, ear-clipping triangulation with hole
  bridging, offsets, minimum feature size, sketch-level corner rounding, tessellation
  quality control.
- **`ops/build.ts`** — extrude with draft, revolve, sweep with rotation-minimising frames,
  loft with correspondence matching; primitives.
- **`ops/boolean.ts`** — BSP boolean engine with coplanar handling and T-junction repair.
- **`ops/modify.ts`** — shell, chain-based fillet and chamfer, holes with counterbore and
  countersink, patterns, mirror.
- **`sketch/solver.ts`** — variational constraint solver, 16 constraint types.
- **`assembly/assembly.ts`** — instances, 7 mate types, mate solver, interference, BOM.

### Above the kernel
- **`generate/`** — 15 parametric archetypes and a deterministic NL parser (units, imperial
  fractions, ISO fastener designations, capacities, negations).
- **`ingest/image/`** — Otsu threshold, Moore contour tracing with hole nesting,
  Douglas-Peucker, line/arc fitting, symmetry detection, scale calibration.
- **`ingest/drawing/`** — defensive DXF reader, loop assembly, view clustering and role
  assignment, multi-view reconstruction.
- **`drafting/`** — orthographic projection with depth-buffer HLR, silhouette extraction,
  automatic dimensioning with ISO 2768-m tolerances, GD&T, sheet layout, SVG and DXF export.
- **`engine.ts`** — single entry point, with a capability list that states every limit.

---

## 3. Bugs found and fixed

Every one of these was found by a test asserting against ground truth, and every one would
have shipped silently.

| Bug | Symptom | Why it mattered |
|---|---|---|
| `orient2d` fast path returned the negation of its exact path | Convex profiles worked; non-convex ones produced overlapping, inverted triangles | The two paths disagreed depending only on whether the filter triggered |
| BSP used `-1` for BACK in a bitmask | `1 \| -1 === -1`, so the spanning case never fired and no split vertices were inserted | Solids interpenetrated with no new edges; results leaked |
| Exact predicate in the BSP classifier | Infinite recursion, stack overflow | Split vertices are never exactly on their plane; exactness made it worse than an epsilon |
| BSP output riddled with T-junctions | Correct volume, `closed: false` | Geometrically watertight, topologically open — breaks later booleans and STL export |
| Ear clipping blocked by bridge duplicates | Triangulation collapsed to a garbage fan | 7 of 12 triangles inverted on any profile with a hole |
| Triangulator was O(n³) | 200-tooth gear never finished | Only reflex vertices can block an ear |
| T-junction repair walked edges in tolerance-sized steps | 600,000 iterations for a 60 mm edge | Search cost has nothing to do with match precision |
| Jacobi SVD used `Math.sign(0)` | Rotation angle zero, never converged | Equal-norm columns are the *most* symmetric case |
| SVD rejected wide matrices | Null space empty, pseudo-inverse wrong | An under-constrained sketch is exactly a wide matrix |
| Tangent constraint: all four line-endpoint signs inverted | Converged to a line 33 mm from a 20 mm circle | A wrong Jacobian finds a stationary point of *something* |
| Symmetric constraint had no axis derivatives | Solved wrongly whenever the mirror axis was free | Solver could move the axis with no apparent response |
| `revolve` tagged the whole surface as one face, storing the axis as its normal | Fillet silently did nothing | A cup's outer wall, rim, inner wall and floor are four faces |
| `edgeChains` never oriented its edges | Circle detection found nothing after a boolean | A chain was a *set*, and consumers treated it as an ordered polygon |
| View roles required matching sizes | Any stepped part fell back to a single view and an invented thickness | Alignment is the convention, not size equality |
| Views normalised to their own bounding boxes | Stepped parts reconstructed with features in the wrong place | Views share an axis; that is what makes a drawing readable |
| Otsu threshold off by one class | Clean black-on-white images reported as empty | The returned level is the top of the dark class |
| Contour tracing measured pixel centres | Every traced part 1 pixel narrow | Material extends half a pixel past the outermost centre |
| HLR ray-cast every triangle per sample | 231 s to draw one flange | All rays are parallel in orthographic projection |

---

## 4. Two decisions worth recording

**Where exactness helps and where it hurts.** The obvious design is exact predicates
everywhere. That is wrong. Exact arithmetic is decisive for *input* geometry — the profile
triangulator depends on it, and coplanar faces are everywhere in real parts because
engineers align things. It is actively harmful for *derived* geometry: a vertex created by
splitting an edge is only approximately on its plane, an exact test says it still spans, and
the recursion never terminates. Both choices are documented at the point they are made,
along with the reasoning, so neither gets "fixed" into the other.

**Fillet at the sketch level where possible.** Rounding a revolved body in 3D means a boolean
between two coaxial tessellated revolves — dozens of near-coincident planes, the worst case
for any BSP. Measured: 77 seconds and a non-manifold result. Rounding the corner in the 2D
section and revolving once gives geometry that is identical (the arc is tangent by
construction) in 150 ms. The 3D fillet remains for prismatic bodies, where the chains are
straight and the tools are cheap extrusions.

---

## 5. Known limits

Stated in the product itself, not only here.

- **Volume of curved bodies runs low** by the inscribed-polygon deficit: ~0.4% at default
  quality, under 0.03% at `precise`. Dimensions are always exact. Rebuild finer when a mass
  will be quoted.
- **Drawing reconstruction is the visual hull.** An enclosed cavity cannot be seen from
  outside and comes back solid. The output says so; a section view resolves it.
- **Image tracing recovers the silhouette only**, and needs a scale.
- **Assemblies are static.** No motion study, no contact simulation.
- **Auto-dimensioning covers envelope and hole pattern.** Design-intent dimensions still
  need an engineer.
- **Fillets are tessellated, not analytic**, and chains meeting at a corner are blended
  independently rather than with a single spherical patch.

---

## 6. What is not verified

| Item | Blocked by |
|---|---|
| **`DATUM.Kernel` has never been compiled** | Needs interop assemblies from a licensed SOLIDWORKS installation |
| Live SOLIDWORKS round-trip | Needs a seat |
| Provider tests against real endpoints | Needs API keys |
| Production code signing | Needs an EV certificate |
| Installer on a clean machine | Needs a fresh Windows VM |

The SOLIDWORKS connector is reviewed code and nothing more. When the easy two-thirds of the
C# was first compiled it exposed a showstopper (`JsonElement.Undefined` made most plans
unserialisable) and a silently-dead feature (self-repair could never match). Assume the
connector holds defects of similar severity until its first successful build.

**This no longer blocks the product.** `src/engine.test.ts` walks all five user journeys end
to end and imports nothing from the connector; if the engine ever grew a dependency on it,
that file would fail to run.

---

## 7. Where it stands

The five things asked for:

1. **Standalone, SOLIDWORKS optional** — done and enforced by test.
2. **Picture → 3D** — done: trace, fit lines and arcs, extrude or revolve.
3. **"make a cup"** — done: 15 archetypes, real feature trees, editable parameters.
4. **2D drawing → 3D parts** — done: DXF in, views recognised, solid reconstructed, bodies
   split.
5. **Strong mathematics** — exact predicates, NURBS, SVD/pseudo-inverse, a variational
   constraint solver with verified analytic Jacobians, exact mass properties.

The engine is complete and tested. What remains is UI surface area: the new capabilities are
reachable through `engine.ts` and covered by tests, but the existing React views were built
against the older 2.5D document model and have not all been rewired to the new kernel. That
is presentation work on a verified foundation, not further engineering.

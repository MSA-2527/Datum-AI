# DATUM against the goal

An honest comparison between what DATUM is today and the stated aim: a standalone parametric
modeller that replaces SolidWorks, Fusion 360 and the AI CAD tools, and makes CAD workers
superbuilders.

Written to be useful rather than encouraging. Where something is far off, it says so and says
why. Where a gap is cheap to close, it says that too — and those are the ones to do first.

---

## Where it stands

| | Today |
|---|---|
| Modelling features | 24 |
| Sketch constraints | 22 |
| Sketch tools | 7 |
| Catalogue shapes | 54 |
| Assembly recipes | 9 |
| Source | 49,000 lines |
| Tests | 17,000 lines, 1,549 cases |
| Exchange | STEP AP214 in and out, DXF, SVG, STL |
| Runs | Entirely in a browser. No server, no account, no network |

Against the five stated capabilities:

| Goal | State |
|---|---|
| 1. Any part from text | Works for the catalogue and for stated dimensions. Not for arbitrary parts |
| 2. Any assembly from text | 9 hand-written recipes; general decomposition needs a language model |
| 3. Drawings and photos → model | Photos yes, with real shape-from-shading. CAD drawings only as DXF outlines |
| 4. Manufacturing-ready drawings | Dimensioned views only. No tolerances, GD&T, sections or title block |
| 5. Trained on your geometry | Retrieval, plus a learned size model. Not a generative geometric model |

---

## The one that governs everything else

### 0. The kernel — DONE, by adoption

**OpenCascade is integrated.** Not written — adopted, compiled to WebAssembly, which is the only
sensible way to acquire thirty years of geometry work.

What it gives, measured in the running application on a 40 x 50 mm cylinder:

| | Volume | Error | Faces |
|---|---|---|---|
| Tessellated kernel | 60.00 cm³ | 4.51% short | a band of strips |
| Exact kernel | 62.83 cm³ | 0.003% | 3 |

And a true fillet: a blended box comes back with 26 faces — six flats, twelve edge blends and
**eight corner patches**. Those corners are what the swept-tool approach cannot produce, because
three tools meeting at a vertex do not agree about what the corner should be.

**The cost, and how it is paid.** The module is 63 MB of WebAssembly. Loading that at startup
would destroy the thing DATUM is actually good at, so it is never loaded at startup. The main
bundle is unchanged at 816 KB; OpenCascade is a separate chunk fetched the first time someone
presses **Exact**, and never for anyone who does not.

**What still stands.** Exact geometry is a *view* of the model, not a replacement for it. The
feature tree remains the document and every edit rebuilds the mesh as before — converting the
tree into an exact solid would trade every parameter for one snapshot of the shape.

**What converts.** Boxes, cylinders, spheres, the three boolean operations, and fillets. Sweeps,
lofts, traced reliefs and sheet metal do not yet, and the conversion names what it had to leave
behind rather than quietly omitting it.

**Licence.** OpenCascade is LGPL-2.1. It is linked as a separate WebAssembly module, which is
the arrangement the licence is written for, but it is a fact about redistribution worth knowing.

### 0b. What the old kernel still is

Every solid in DATUM is a triangle mesh. SolidWorks is Parasolid; Fusion is ASM; both store
**exact** surfaces — planes, cylinders, cones, tori, NURBS — with exact intersection curves
between them.

This is not a detail. It is the reason for most of what follows:

- **Fillets** are approximated by cutting with a swept tool rather than by constructing a true
  rolling-ball blend surface. Complex fillet networks — three faces meeting at a corner, a
  variable-radius blend, a face fillet across a gap — are out of reach.
- **Exported STEP** carries planes and cylinders where DATUM recognised them and faceted
  surfaces elsewhere. A CAM package can machine the first and struggles with the second.
- **Measurements** carry tessellation error. A 6 mm hole measures 5.94 mm because it is a
  24-sided prism. Every test in this repo that checks a volume allows for it.
- **GD&T, tolerance analysis and CMM inspection** all need exact surfaces to mean anything.
- **Surfacing** — the class A work that car bodies and consumer products need — is impossible
  without NURBS surfaces and continuity control.

**What it would take:** a boundary-representation kernel with exact surface types, exact
surface–surface intersection, tolerant topology, and a robust fillet engine. This is the single
largest item on this list by an order of magnitude — Parasolid represents about thirty-five
years of work, and open kernels like OpenCascade around twenty-five. A credible route is to
adopt OpenCascade compiled to WebAssembly rather than to write one, at the cost of roughly
8 MB of WASM and a rewrite of every operation in `kernel/ops`.

**The mesh kernel is still the one that runs when you open the page**, and that is right: it is
instant, it needs no download, and for design and massing it is enough. The exact kernel is there
for the moment accuracy starts to matter — measuring, blending, exporting for manufacture.

The items below that were blocked on this are now unblocked: GD&T has surfaces to be a claim
about, and exported STEP can carry the surfaces themselves.

---

## Priority 1 — close the everyday gaps

These are what a mechanical engineer hits in the first hour.

### 1.1 Sketcher completion
Missing: trim, extend, offset, sketch fillet, mirror, construction geometry, spline, ellipse,
dimension tool with a value dialogue, driven-vs-driving dimension distinction.

Present: 7 tools, 22 constraints, constrained dragging, snapping, automatic relations.

*Effort: moderate. No kernel work.*

### 1.2 Every feature reachable from the viewport
Six of 24 features are on the right-click menu. All of them should be, scoped to what is picked.

Also missing: drag an edge to set a fillet radius, move handles on a body, double-click a face
to edit the feature that made it.

*Effort: moderate. No kernel work.*

### 1.3 Sheet metal
An entire modelling paradigm that is absent: base flange, edge flange, bend, unfold, flat
pattern, bend table, K-factor. Perhaps a third of all mechanical parts are sheet metal.

*Effort: large, but tractable on a mesh kernel — bends are developable surfaces.*

### 1.4 Weldments and frames
Structural member from a sketch path, trim/extend at joints, gussets, end caps, cut list.

*Effort: moderate.*

### 1.5 Configurations and design tables
Named sets of parameter values in one document: a family of parts, sizes S/M/L, variants with
features suppressed. Standard in every package and entirely absent here.

*Effort: small. The parametric machinery already exists.*

---

## Priority 2 — the drawing half

A model nobody can manufacture from is half a tool. DATUM produces dimensioned SVG and DXF; a
manufacturing drawing needs far more.

### 2.1 Proper drawing views
Section views, detail views, broken views, auxiliary views, exploded assembly views.

### 2.2 Tolerances and GD&T
Plus/minus tolerances, fits (H7/g6), geometric tolerance frames, datum features, surface finish
symbols, weld symbols.

**Note:** GD&T on a tessellated model is a claim the geometry cannot support. A flatness
tolerance of 0.05 mm is meaningless on a surface that is faceted to 0.1 mm. This item genuinely
waits on item 0.

### 2.3 Title block, revision table, BOM
Sheet formats, standards-compliant borders, a bill of materials that balloons to the assembly.

### 2.4 Drawing → model
Currently a DXF becomes an outline. A real reader would recognise the *views* — front, top,
right — pair up their dimensions, infer the third from two, and reconstruct the solid. This is
one of the stated goals and is genuinely hard research, though a constrained version (orthogonal
views of a prismatic part) is achievable.

---

## Priority 3 — the physics

The goal says "training and teaching it all the fundamental mathematic and physics equations".
Some of that exists; most does not.

### 3.1 What exists
Mass properties by the divergence theorem, inertia tensors, anodizing electrochemistry (Faraday
growth, current density, MIL-A-8625), manufacturing limits as data for seven processes, DFM
checks, mesh health as exact topology.

### 3.2 What does not
- **FEA.** Static stress, modal, thermal, buckling. Needs a meshing engine, element formulations
  and a sparse solver. Large but well-understood; the tessellated kernel is actually *less* of an
  obstacle here than elsewhere.
- **Kinematics.** Mechanism simulation, linkage motion, interference through a motion cycle.
  The mate solver already does the hard part; this is a time integration on top of it.
- **CFD, injection-moulding flow, tolerance stack-up.** Each is its own product.
- **Engineering calculators.** Beam deflection, bolted joints, gear ratings, bearing life,
  spring rates, fits and tolerances. These are equations, not simulations — cheap to add, and
  they are what a mechanical engineer actually reaches for daily.

*Do 3.2's last item first. It is a fortnight of work and it is used constantly.*

---

## Priority 4 — the AI

### 4.1 What exists
A staged reasoning chain that runs offline: read requirements → choose an approach → build →
measure the result against every requirement → correct → report what was and was not met. Plus
retrieval-augmented examples from your own parts, and a learned size model with an honest
refusal when it has learned nothing.

### 4.2 The gaps

**It builds; it does not edit.** Every request starts a new document. "Make the wall 2 mm
thicker", "add a boss here", "move the holes to a 60 mm circle" — none of them work. This is the
single biggest AI gap and it does not need a bigger model, only a different interface: the
assistant needs the *feature operations* as tools it can call against the open document.

**One shot, not a conversation.** No memory across turns, no clarifying questions except the
built-in ones, no "no, not like that".

**No geometric reasoning.** The model emits a plan of primitives. It cannot look at what was
built and reason about it — "the bracket will fail at the fillet", "these holes are too close to
the edge for the bolt spec you named".

**No true training.** Fine-tuning needs hundreds to thousands of examples and a provider's
infrastructure; the export exists for the day the volume does. A generative geometric model —
one that produces *geometry* rather than a plan — is a research programme, not a feature.

*4.2's first item is the highest-value AI work available and is weeks, not months.*

---

## Priority 5 — scale and trust

### 5.1 Large assemblies
A rocket is a hundred thousand parts. DATUM rebuilds the whole tree on every edit and holds
every triangle in memory. It needs: lazy evaluation with a dependency graph, level-of-detail
display, lightweight component representations, and out-of-core storage.

*This is what "the most complex assemblies humans have ever built" actually requires, and it is
mostly engineering rather than research.*

### 5.2 Robustness of the feature tree
Real CAD suffers from topological naming: delete a feature and everything scoped to its faces
breaks. DATUM has the same problem — face ids are positions in a triangle list. A persistent
naming scheme is needed before large models are editable in practice.

### 5.3 Collaboration and versioning
Multi-user editing, branching, diffing two versions of a model, PDM.

---

## Progress

Items 1 to 4 of the order below are done or substantially done.

| Item | State |
|---|---|
| 1.1 Sketcher | Arc, hexagon and slot tools; construction geometry, mirror, offset; constrained dragging; snapping; all 22 constraints exposed. **Trim, extend, spline and ellipse remain** |
| 1.2 Viewport | All 24 features reachable from the right-click menu; push-pull a face by dragging it |
| 1.3 Sheet metal | Bends, flanges, flat pattern, bend allowance and deduction, press-brake checks. **Unfold of an arbitrary solid remains** |
| 1.4 Weldments | Not started |
| 1.5 Configurations | Done |
| 3.2 Calculators | Beam, bolt, press fit, buckling, ISO 286 fits |
| 4.2 AI editing | Done — the assistant changes the open model rather than always starting a new one |

Still open, in order: weldments, drawing views and tolerances, FEA, and the kernel.

---

## Honest summary

**What DATUM already does better than the AI CAD tools:** it produces an *editable feature tree*
rather than a mesh, it runs with no account or network, it checks its own answers against what
was asked, and it says so when it fails.

**What it cannot yet do that SolidWorks does:** exact geometry, sheet metal, weldments,
surfacing, manufacturing drawings, simulation, and assemblies beyond a few hundred parts.

**The honest order of work:**

1. Sketcher completion and viewport coverage — days each, and they are what makes it *usable*
2. Configurations, engineering calculators — small, high daily value
3. Let the AI edit the open model — weeks, and the biggest single AI improvement available
4. Sheet metal and weldments — the two biggest missing modelling paradigms
5. Drawing views, tolerances, title blocks — the manufacturing half
6. FEA — large, self-contained, well-understood
7. A B-rep kernel — the one that unlocks the rest, and the one that should be adopted rather
   than written

Items 1 to 6 make DATUM a genuinely useful tool that an engineer would choose for a class of
work. Item 7 is what would make the word "replace" honest.

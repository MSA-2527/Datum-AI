# DATUM — how to use it

A CAD modeller that turns a sentence, a picture, or a drawing into a real parametric
assembly. It runs entirely in your browser. No account, no licence, no server, and nothing
you model leaves the machine.

---

## Starting it

```bash
npm --prefix ui install
```

```bash
npm --prefix ui run dev
```

Open the address it prints (usually `http://localhost:5273`). That is the whole install.

For a production bundle:

```bash
npm --prefix ui run build
```

The output in `ui/dist` is a static site — it will run from any web server, or from a file
share, with no backend.

---

## The three workspaces

The bar across the top switches between them. Each is a real page with its own URL, so it can
be linked to and the back button works.

| Tab | What it is |
| --- | --- |
| **Modeller** | The default, and the product. Describe a part, build it, edit it, export it. Needs nothing installed. |
| **Studio** | Thirteen views: manufacturability and cost, drawings, skills, recipes, batch runs, health, reuse index, history, diagnostics. |
| **CAD panel** | The task pane that runs inside SOLIDWORKS. Needs the add-in and a seat. |

---

## The window

| Where | What it is |
| --- | --- |
| **Left** | The feature tree. Every part is a row. Click one to select it; the parameters appear underneath and the part highlights in blue in the 3D view. |
| **Middle** | The 3D view. Drag to orbit, middle-drag or shift-drag to pan, scroll to zoom. The buttons top-right snap to ISO / front / top / right. |
| **Right** | The assistant. Type what you want and press **Build**. |
| **Bottom strip** | Live mass, volume, triangle count, rebuild time, and whether the solid is closed. |

The **solid: closed** readout is the one to watch. `closed` means the model is watertight and
can be 3D-printed, meshed for simulation, or costed. `OPEN` means it cannot, and the assistant
will have said why.

---

## Making something

Type it in plain language and press **Build**.

| Type this | You get |
| --- | --- |
| `a phone` | A 16-part smartphone assembly — chassis, battery, board, display stack, cameras, port |
| `a gearbox` | Case, input pinion, output gear, shafts, bearings, with the ratio worked out |
| `a bicycle` | Frame tubes, two spoked wheels, drivetrain, bars, saddle, post and stem |
| `make aeroplane` | A 20-part airliner at A320 proportions — 35.8 m span, 39 t |
| `a rocket` | Body tube, nose cone, four fins in a cruciform, nozzle, payload bay |
| `a chair` | Seat, four legs, back rails and stretchers at standard heights |
| `Create a model of a car` | A body-in-white massing model with separate wheels |
| `make a cup 90 mm tall` | A single turned part, sized as asked |
| `M10 hex nut` | A fastener to ISO 4032 |
| `a bracket 120 long in 6 mm steel` | An L-bracket with the dimensions you named |

Sizes, counts and materials in the sentence are read and used. "A small phone", "a 40-tooth
gear", "a 200 mm shaft" all work.

### What it can build with no AI configured

Eight assemblies — **phone, laptop, motor, gearbox, bicycle, aeroplane, chair, rocket** — and
twenty-five single parts:

| | |
| --- | --- |
| **Mechanical** | gear, shaft, pulley, knob, nut, washer, pipe |
| **Structural** | bracket, plate, flange, table, frame, hook, handle |
| **Vessels** | cup, bottle, funnel, tray, enclosure |
| **Vehicle** | car, wheel |
| **Process** | plating / anodizing rack |
| **Primitives** | box, cylinder, sphere |

They answer to ordinary words, not just their catalogue names: *desk*, *workbench* and
*dining table* all reach the table; *bin*, *crate* and *caddy* reach the tray; *dial* and
*handwheel* reach the knob.

It also reads the sentence rather than just the noun. **"a cup with no handle"** builds a cup
without one — a negated word is not what you asked for. **"a mug with a handle"** builds a
mug, because a noun after *with* is a feature of the thing rather than the thing itself.

These are hand-written from real hardware, work offline, and build in milliseconds. Anything
outside that list needs a model turned on (below).

---

## When it asks you questions

Some parts are made to fit something else. A cup is a cup, but a **plating rack** is a fixture
for *your* parts in *your* tank — its height, reach and current capacity are decided by things
your sentence cannot contain.

Type `create an anodizing rack` and it asks first: spine height, spine width, tiers, arm
length. Each question carries the reason it matters, and each has a default already chosen, so
you can answer none of them and press **Build it**.

It only asks for made-to-fit parts, and only when you have not already said. `a rack with
spine height 1200 and 8 tiers` builds straight away.

Every part now understands its own parameter names in plain language — `a gear with 40 teeth`,
`a rack arm length 400`, `a table 1800 top length`.

---

## Editing what you made

Click any part in the tree. Its parameters appear as sliders and number boxes. Change one and
the model rebuilds — typically in tens of milliseconds, and always in the background, so the
window never freezes.

The tree is the document. The 3D shape is derived from it, which is what makes every
dimension editable after the fact rather than baked in.

- **Undo / redo** — buttons in the toolbar, or `Ctrl+Z` / `Ctrl+Shift+Z`.
- **Reorder** — the ↑ ↓ arrows on a row. Order matters: a cut removes material from
  everything above it and nothing below it.
- **Suppress** — the ● toggle builds the model as if that feature were not there.
- **Delete** — the ✕.

### Parameters: the dimensions the design is built around

Under the feature editor is a **Parameters** panel. This is what separates a model that was
*generated* from one that was *designed*.

Without it, an assistant's output is thirty parts at literal coordinates. Change the wheelbase
and nothing follows, because nothing in the model knows a wheelbase existed — so "make it
longer" means asking again and getting a different object.

A parameter is a named driving dimension. Any feature parameter can be written in terms of it:
press the **ƒx** button beside a dimension and type an expression instead of a number.

```
plateLength = 350          ← edit this
Length      = plateLength   ← and this follows
Width       = plateLength * 0.6
Boss X      = plateLength / 2 - 20
```

Parameters may be defined in terms of each other in any order. The arithmetic available is
`+ - * / % ^`, brackets, and `min max abs sqrt round floor ceil sin cos tan hypot` — angles in
degrees. Each row shows what it resolves to as well as what it says, and how many expressions
reference it, so an unused parameter is visibly unused.

Renaming a parameter rewrites every expression that uses it. A circular definition, or one
naming something that does not exist, is reported by name rather than left as a silent zero —
and the geometry falls back to its last good value rather than collapsing to the origin.

**The assistant emits these.** Ask for a car and the plan comes back with a wheelbase, a track
and an overall length, with the wheels placed at `-wheelbase / 2` rather than at `-1167.5`.
Editing the wheelbase then moves the wheels, which is what a dimension means in CAD.

### Sketching: draw roughly, then say what must be true

Click **✎ Sketch** in the feature toolbar. A drawing canvas appears under the tree.

This is the loop that makes a modeller parametric rather than a shape generator. You do *not*
type corner coordinates. You draw the profile roughly with **Rectangle**, **Line** or
**Circle**, then click the geometry and press constraint buttons to say what must hold:

| Constraint | What it fixes |
| --- | --- |
| **Horizontal** / **Vertical** | A line runs along X or Y |
| **Parallel** / **Perpendicular** | Two lines stay aligned, or meet at 90° |
| **Equal** | Two lines the same length, or two circles the same radius |
| **Coincident** | Two points become one |
| **Concentric** | Two circles share a centre |
| **Distance** / **Radius** | A driving dimension — type the number in the box first |

The status line underneath counts what is left: *"Under-constrained: 4 degrees of freedom"*
becomes *"Fully constrained"* when the shape can no longer move. That readout is the difference
between knowing a dimension will hold and hoping it will.

Set the **Thickness** in the parameters below and the profile extrudes. A rectangle drawn by
eye, told to be horizontal, vertical, 100 wide and 60 tall, comes out as **exactly**
120.00 cm³ at 20 mm thick — nobody measured anything.

Now change the 100 to 150. The whole profile follows, because the constraints say those corners
belong together. That is what a dimension means in CAD, and it is not what typing a number into
a primitive does.

A circle drawn inside the outline becomes a hole. Construction lines (for reference only) are
ignored when the profile is built. Conflicting constraints are refused at the moment you add
them, naming what they clash with, rather than leaving you with a broken sketch.

### Assemblies: relationships, not coordinates

Below the parameters, the **Assembly** panel appears once a model has two or more components.

**Check for clashes** is the one to run on anything the assistant built. A generated plan
places every component by absolute coordinate, and the failure is rarely a part a metre out of
place — that is obvious. It is a gear a few millimetres inside a case wall, which looks right in
the viewport and cannot be built. The check lists each overlapping pair with the shared volume
and how much of the smaller part it represents:

```
Case ∩ Output gear    33.6 cm³ · 24%
Case ∩ Output shaft    6.2 cm³ · 19%
```

Overlaps under 1 % of the smaller part are counted separately and not listed — that is an
interference *fit*, which is how dowels and bearings are retained, and flagging it the same way
as a real clash just trains you to ignore both.

**Mates** are how you fix one. Pick two components, then press a relationship:

| Mate | What it holds |
| --- | --- |
| **Coincident** | Both origins at the same point |
| **Concentric** | Both Z axes on one line |
| **Distance** | Origins a set distance apart |
| **Parallel** / **Perpendicular** | Axes aligned, or at 90° |
| **Lock** | The two fixed rigidly together |

Solving moves the components and writes the result into their placements, so the tree stays an
ordinary tree that saves and rebuilds like any other. The panel reports what freedom is left —
*"32 degrees of freedom"* — and **Re-solve** re-applies every mate after you have edited
something. A mate that would conflict is refused when you add it, not silently applied.

Mates act on each component's own origin and Z axis. That is the honest subset: the viewport
selects features, not faces on them, so offering "mate to that bore" would be a control with
nothing behind it.

### Picking faces

Add a **Fillet** or **Chamfer** and a *Face scope* panel appears. Click a face in the 3D view
— it turns amber — then press **Apply picked faces**. The rounding now applies only to the
edges of those faces. Shift-click to add more; **Clear pick** starts over.

While a fillet is open, clicks in the 3D view pick faces rather than switching which feature
you are editing. Use the tree to move to a different feature.

Fillet also has a **Which edges** control: outside only, inside corners only, or both. A
bracket's inside fillet carries load; the outside ones are cosmetic. They are different
decisions and it asks which you meant.

---

## From a picture

Press **Open / Import** and choose a photo or a scan. The outline is traced and extruded into
a solid you can then edit like anything else.

Holes come through. A washer traces as a ring, not a disc; a flange traces with its bolt
circle. The message tells you how many were found.

It is a silhouette, so it gives you the outline and its holes, not internal detail that never
reaches the boundary. An image carries no scale, so the picture is taken as 100 mm across and
the message says so — click *Traced outline* in the tree and set **Overall width** to the real
figure. The outline and every hole rescale together, about the part's own centre, so correcting
the scale does not move it.

A traced outline shows only Overall width, Thickness, Draft and Operation. Length and Corner
radius are absent on purpose: a traced profile is a point list, and those two would be boxes
you could type into that changed nothing.

Works best on a clear shape against a plain background.

## From a drawing

Import a `.dxf` and the views are reconstructed into 3D. Front, top and side are matched up
and the solid is built from what they agree on.

---

## Getting work out

| Button | File | For |
| --- | --- | --- |
| **STEP** | `.step` | Any CAD, CAM or inspection package — the one that lets the work continue elsewhere |
| **STL** | `.stl` | 3D printing, meshing, anything downstream |
| **Drawing SVG** | `.svg` | A dimensioned drawing you can print or drop in a report |
| **Drawing DXF** | `.dxf` | The same drawing, into any 2D CAD package |
| **Save** | `.datum.json` | The feature tree — reopens fully editable |

Save the JSON, not the STL, if you want to come back and change something. The STL is the
result; the JSON is the recipe.

### STEP — the one that matters outside DATUM

An STL is triangles and nothing else: no faces to select, no edges to dimension, no way back
to an editable solid. No machine shop quotes milling from one.

**STEP** exports a real boundary representation — a closed shell of planar faces with shared
edges, which SOLIDWORKS, Fusion, Onshape, FreeCAD, Mastercam and any inspection package will
open as a solid body. The triangles are put back together first: an L-bracket that renders as
392 triangles exports as **86 faces**, so the top of the plate is one face you can click, not
two hundred you cannot.

The message tells you the face count each time, because that number is the difference between
a solid another package can work on and one it can only look at.

**Holes, shafts and tapers come through as real curved surfaces.** DATUM recognises the
cylinder or cone that a ring of facets was approximating and writes it as one
`CYLINDRICAL_SURFACE` or `CONICAL_SURFACE` with a true radius, half-angle and circular edges:

| Part | Triangles | → Faces | Recovered |
| --- | --- | --- | --- |
| Flange | 3290 | 491 | 10 cylinders — bore, outer diameter, eight bolt holes |
| Funnel | 1240 | **11** | 1 cylinder and 2 cones |
| V-belt pulley | 1372 | **22** | 4 cylinders and 2 cones |

Each of those is one selectable face with a measurable diameter, not forty flat strips. And
because the analytic surface *is* the one the mesh was sampling, the exported solid is
fractionally more accurate than the model it came from.

**Validity is never traded for elegance.** If recognising a surface would leave any edge owned
by one face instead of two, that surface is dropped and its facets stay planar — a verbose
solid that knits is worth far more than a tidy one that arrives as loose surfaces.

**Surfaces are declared, not rediscovered.** When the kernel builds a cylinder it records the
cylinder; when it builds a cone it records the half-angle and apex. Those tags travel through
booleans untouched, so a bore drilled through a plate still knows it is a 10 mm bore. Export
uses what the geometry *says it is* rather than measuring the triangles back:

| | Fitted from triangles | Declared by the kernel |
| --- | --- | --- |
| Flange bore | `44.9999999383` | `45.` |
| Bolt hole | `7.00000012636` | `7.` |
| Boss taper | 36.8687° | 36.869897646° (exactly `atan(12/16)`) |

Fitting could never close that gap. A boolean lands its intersection points on the *chords*
between triangles, a hair inside the true surface, so every fitted radius is slightly small and
every fitted taper slightly off. Nothing is being rediscovered now, so there is nothing to be
noisy.

Fitting is still there, and still correct, for geometry that arrives without tags — a traced
outline, an imported mesh, a repaired body. A tag is also checked against the vertices before it
is believed, so one that survived an operation it should not have cannot move geometry.

**The honest limit**, also written into the file's own header: only planes, cylinders and cones
are *exported* as analytic surfaces. Spheres and tori now carry correct surface data through the
kernel — a sphere is one spherical surface rather than twenty-four cone bands — but still
tessellate on the way out, because a complete sphere's boundary is degenerate and needs seam
handling this does not yet have. Fillet blends remain faceted throughout.

---

## Turning on AI

Press the **AI** button. Choose a provider, paste a key, press **Test**.

| Provider | Notes |
| --- | --- |
| Google Gemini | Supports Google Search grounding — it can look up a real product's dimensions and cite the sources |
| Groq | The fastest of the hosted options by a wide margin; runs open models on its own hardware. OpenAI-compatible, so any model id Groq lists will work |
| Anthropic Claude | Needs browser access enabled on the key |
| OpenAI | Standard key |
| Ollama | Runs locally, no key, nothing leaves the machine |

Speed matters more here than it looks. A request is planned, the geometry inspected, and — if
the inspection finds real problems — sent back for one correction. That is up to two round
trips per build, so a fast provider is felt directly.

If a build fails with *"rejected its own model's reply for not being valid JSON"*, the plan ran
past the token limit and was cut off mid-object — the provider validates the whole reply before
returning it, so a long assembly is discarded rather than truncated. It is retried
automatically without the strict-JSON constraint, so you will only see this if the second
attempt fails too. Ask for something smaller, or use a model that follows a schema more
reliably.

If **Test** fails with *"Could not reach…"*, nothing left the page at all — so the key and the
model name are not the cause; a bad key comes back as a rejection, not a failure to connect.
The usual reason is a **custom base URL**: this page's Content-Security-Policy allows the four
built-in providers and localhost, and nothing else. Add the origin to `connect-src` in
`ui/index.html` to use a proxy or a self-hosted gateway.

**About your key.** It is stored in this browser's local storage and sent only to the provider
it belongs to. There is no backend and nothing proxies it. Anything able to run script on the
page could read it, which is true of every browser-stored credential — the settings panel says
so plainly rather than hiding it.

With a model on, anything outside the built-in list works: *"a cordless drill"*, *"a desk
lamp with an articulated arm"*, *"a 3D printer extruder assembly"*.

---

## What makes the output trustworthy

Three things run on every model, and all three work offline.

**Real dimensions, not remembered ones.** 111 published figures — ISO 4762 cap screws, ISO 15
bearings, IEC 60086 cells, NEMA motor frames, IPC board thicknesses, material densities — are
looked up and handed to the model before it designs. Ask for a skateboard and it is given the
608 bearing's real 8 × 22 × 7 mm without being told skateboards have bearings. Every figure
names the standard it came from, so you can look it up and disagree with it.

**An audit against those figures.** The finished model is read back. A density that disagrees
with its material is corrected outright — aluminium is 2.70 g/cm³ or the part is not
aluminium. A dimension that disagrees with the standard its name invokes is *reported and left
alone*, because an 18650 cell measuring 70 mm might be a protected cell or might be a mistake,
and guessing would be worse than saying so.

**An inspection of the geometry.** Parts floating in space, parts bigger than the assembly
they belong to, cuts that remove no material, duplicate parts in the same place. When a model
generates a plan and the inspection finds real problems, the findings are handed back and a
correction is requested — and the correction is only kept if it is actually better.

That inspection is not decorative. The first time it ran over the hand-written recipes it
found the bicycle's wheels lying flat, the laptop's lid placed beside its base rather than on
top, and four assemblies declaring themselves smaller than they were built. Every one of those
had been producing a perfectly valid, watertight solid for months.

**Mass is real.** Each part is weighed at its own density and summed, and every shape knows
what it is normally made of — a table is oak, a storage bin is polypropylene, a hook is steel.
An oak coffee table comes out at 23 kg and an M10 nut at 11 g. A phone comes out at
251 g, a 13-inch laptop at 1.67 kg, a gearbox at 3.09 kg. Where a part is drawn solid but is
really a shell — a wheel rim, a saddle, a laptop lid — an effective density is used and the
part says so in its own note.

---

## The boolean engine

Every cut, join and intersection goes through **Manifold** — the same engine behind OpenSCAD
and Blender's boolean node. Apache-2.0, 541 kB of WebAssembly, bundled; nothing to install and
no licence to accept.

It is *guaranteed manifold by construction* rather than by getting floating-point tolerances
right, which is what the previous engine had to do. That difference shows up everywhere:

| | Before | Now |
| --- | --- | --- |
| Fillet a box | 10 edges of 12 | **all 12** |
| Chamfer a box | 7 of 12 | **all 12** |
| Cup | 19,396 triangles, 1.1 s | **3,538 triangles, 0.16 s** |
| Bicycle | 55,548 triangles, 7.2 s | **14,840 triangles, 0.58 s** |
| Cut into a part that already has a hole | often failed | **works** |
| 1.2 mm port through a 163 mm wall | impossible | **works** |

Face identity travels through it, so selection, face-scoped fillets, drawings and the bill of
materials all still know which feature made which face.

If the engine cannot load, every operation falls back to the original built-in kernel. The
application keeps working with the older ceiling rather than failing.

---

## Honest limits

These are real and worth knowing before a demo.

- **The kernel is a triangle mesh, not B-rep.** Curves are tessellated, so a cylinder is a
  many-sided prism — accurate to a fraction of a percent, but not exact. There is no STEP
  export, and a fillet is a swept approximation rather than a true rolling-ball surface. This
  is the remaining gap to a package like SOLIDWORKS, and closing it means OpenCascade.
- **The phone still models its port, tray and speaker as parts rather than holes.** The
  boolean can now cut them, but the recipe has not been rewritten to do so.
- **The bicycle has no hubs, cranks, pedals, chain or brakes.** It has a seatpost and stem now,
  so nothing floats, but the mass is of what is drawn rather than of a complete bicycle.
- **A spoked wheel is kept as separate bodies** — rim, hub and spokes overlapping where they
  would be welded — because merging twenty-four spokes into one shell fails at most spoke
  widths. It is watertight and weighs the right amount either way.
- **Image import gives you the outline and its holes**, not internal features that never
  reach the boundary.
- **No live constraint-driven mates yet.** Parts are placed, not mated. Moving one does not
  drag its neighbours.

Nothing here fails silently. If a feature could not be built, the assistant says which one and
why, and the model keeps the last good state rather than showing you something broken.

---

## If something goes wrong

- **`solid: OPEN`** — read the assistant's message; it names the feature that broke it.
  Suppressing that feature gets you back to a usable body.
- **A fillet rounded nothing** — the radius is probably larger than half the shortest edge it
  runs along. It tells you the maximum that will work.
- **A rebuild is slow** — big assemblies with spoked wheels or fine gears are genuinely
  expensive. The window stays responsive; the spinner is on the viewport.
- **The model returned something unusable** — the raw reply is shown under the error. Smaller
  models sometimes cannot hold a JSON schema; a larger one fixes it.

---

## Tests

```bash
npm --prefix ui test
```

937 tests. They cover the geometry kernel, the constraint solver, the drawing generator, the
reference corpus, the audit, and the geometry inspection — including the specific defects
listed above, so a regression is loud rather than silent.

### Checking it yourself

[TESTS.md](TESTS.md) has five hand-run test cases, one per headline capability, with the input
files supplied in `test-fixtures/` and every expected number measured from this build:

| # | Capability | Input |
|---|---|---|
| 1 | A picture becomes a 3D solid | `test-fixtures/washer.png`, `flange.png` |
| 2 | A sentence becomes a 3D object | `make a cup` |
| 3 | A 2D drawing becomes a 3D part | `test-fixtures/bracket.dxf` |
| 4 | A 3D model becomes a manufacturing drawing | **Drawing SVG** on any model |
| 5 | The mathematics | boxes, holes and fillets against closed-form volumes |

Test 5 is the one worth running slowly: it checks the app against volumes you can work out on
paper, including the coincident-face boolean that normally breaks mesh CSG.

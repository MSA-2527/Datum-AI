# DATUM — a walkthrough

Twelve minutes, in the order the value builds. Everything below was run and its output copied
from the run, not written from memory.

**Start:** `npm --prefix ui run dev`, then open the address it prints. Nothing is installed,
nothing is licensed, and nothing leaves the machine unless a language model is deliberately
configured.

---

## 1. It builds parts — offline, in milliseconds

Type into the assistant:

> a 120 x 80 x 8 mm mounting plate

```
Built a plate. Read: length = 120 mm, width = 80 mm, thickness = 8 mm.
```

No model was involved. The request was parsed, matched against a catalogue of 27 shapes, and
built by the kernel. The point to make: **the dimensions in the reply are the ones it read out of
the sentence**, so a reader can tell at a glance whether it understood.

Then the toolbar: Box, Cylinder, Revolve, Loft, Sweep — 24 feature kinds, each parametric.

**Worth saying:** a request it cannot build is refused by name rather than answered with the
nearest thing. Ask for *a hydroformed titanium turbine volute with variable-section runners* and
it declines and says which operation is missing. That is the discipline the whole system is
built around — a wrong part returned confidently is the one failure nothing downstream catches.

## 2. It is a real CAD viewport

- **Four display modes** — shaded, shaded with edges, hidden-line, wireframe (`W` cycles)
- **View cube** in the corner, click a face to snap to that view
- **Move and turn gizmo** on the selected part: drag an arrow to slide it along one axis, an arc
  to turn it. Verified: a 40 px drag moves the part exactly the distance the pointer covered; a
  60° sweep applies 59.87°.
- **Measure** (`M`) — click two points. Snaps to corners, real edges and bore centres, and reads
  a bore's diameter off the surface it came from, not off its facets: **⌀12.00**, not the 11.94
  a chord measurement gives.
- **Section** (`S`), **adaptive grid**, **scale bar**, **origin triad**
- Panels drag to resize, and remember it.

## 3. Sketching happens on the model

Click **Sketch**. The editor opens over the viewport with the part behind it.

- **Draw** — drag any shape freehand. It comes back as *lines and arcs*, not a scribble: a
  hand-drawn square is four dimensionable lines, a hand-drawn circle is arcs.
- Or place a line, rectangle, circle, arc, hexagon or slot.
- Constrain it: horizontal, vertical, parallel, perpendicular, tangent, concentric, equal, plus
  dimensional distance, radius and angle.
- The solver reports what is left: *"Under-constrained: 8 degrees of freedom."*

Press **Done** and it extrudes.

## 4. A picture becomes a part

Three routes, and the application works out which one the picture needs:

| what you drop in | what happens |
|---|---|
| a flat part, square on | traced, fitted to lines and arcs, extruded |
| one object, lit | its shading solved into a surface — a domed cover comes back domed |
| a multi-view **drawing** | the views are read and intersected into the solid |
| a photograph of a machine | refused, with the reason, and offered to a vision model |

The drawing case is the one to show. Drop in a scan or photo of a three-view drawing:

```
22.9 x 15.2 x 15.2 mm, 1.9 cm³, from 3 views.
Read from 3 views (top, front, right) at 0.192 mm per pixel —
a picture carries no scale, so check the size.
```

It identifies which view is which by how they line up, sets hidden-detail dashes aside so a bore
does not come back filled in, and intersects the three extrusions. A single-view drawing of a
flat part works too, and says its thickness was a default rather than something the drawing
stated.

**Worth saying:** it refuses to trace a photograph of a machine. That refusal is the feature —
tracing one gives a flat slab in the shape of the whole photograph, which looks entirely correct
and is worthless.

## 5. Manufacturing-ready drawings

**Drawing SVG** in the toolbar, or from the command line:

```bash
node ui/dist-cli/datum.mjs export bracket.datum --out sheets.svg --details
```

```
3 sheets, SVG
  1 of 3  Bracket             36 dims  sheets-1-bracket.svg
  2 of 3  Base                36 dims  sheets-2-base.svg
  3 of 3  Post                 6 dims  sheets-3-post.svg
```

The assembly, then **a dimensioned sheet per part**, numbered as a set. Each part is rebuilt on
its own so the sheet shows the part as it was made, and each hole is attributed to the part it
actually cuts — checked by rebuilding, not guessed from the order it was typed in.

Also exports STEP, STL, DXF and SVG. The STEP opens in SolidWorks, Fusion or Inventor.

## 6. The anodising rack

This is the one that is specific to the shop. Open or import a part, then either click
**Rack for this** or say it:

> design an anodising rack for this part

```
4 stations on a 100-0132 bar at 62.3 mm pitch, carrying 4 parts.
11.7 A at 1.5 A/dm², 36 min for 15 µm.
Clip: Grade 4 Ti, 1.016 mm strip, 25.4 mm wide, gripping 12.0 mm, 2 spot welds.
32% of the current coats the rack. Every check met.
```

Every constant is read off a released drawing in the shop's own rack library and cited where it
is used: the 100-0132 bar at 309.563 mm with 249.238 mm of usable span, Grade 2 sheet for the bar
and Grade 4 for the clips, 3/16" spot welds, two per clip.

**The number that matters is the station count**, and it is the one the shop tunes. The revision
history of 426-0244 is the whole design problem in two lines:

```
A   WAS 10-ACROSS, NOW 8-ACROSS      5 June 2024
AB  WAS 8-ACROSS,  NOW 6-ACROSS     24 June 2024
```

They did not reduce it because the parts stopped fitting — they fitted at ten. They reduced it
because the bath could not carry fresh electrolyte between the parts and the coating came out
patchy. So the generator spaces the bar rather than packing it, then checks that what fits also
drains. It reproduces both of the shop's own answers: four stations for the candle lid, six for
the 50 ml plaque.

The rack comes out as an editable model with the clips drawn folded — back leg, fold, return jaw
with the grip open between — and goes straight to a drawing.

## 7. It says when it is unsure

Every result carries what was checked. After a build the assistant reports parts left floating,
components turned to angles nobody chose (`89.4° about RZ, 0.60° off square`), parts swallowed
inside others, and sizes that differ from what was asked. None of it blocks the result — an
exploded view has every component floating — but none of it is hidden either.

---

## What is not finished

Worth saying before someone finds it.

- **The depth model's inference has not been observed running.** The download, the caching, the
  cancel, the tensor going in and the depth map coming out are all tested; the ONNX session
  itself has only been proven with a stand-in that returns a known depth map. It needs one
  successful run on a decent connection.
- **Reading dimension text off a drawing.** The reconstruction is accurate to about a pixel,
  which on a 300 dpi scan is 0.08 mm. A dimension that must be exact should be read from the
  callout, and that needs OCR.
- **Class-A surfaces.** The kernel does extrusions, revolutions, lofts, constant sweeps,
  primitives, booleans, holes, shells, blends and patterns. It does not do the freeform surfacing
  a car body needs, and it says so rather than approximating one.

---

## The figures

Generated from the code, not written by hand — see `docs/FACTS.md`.

| | |
|---|---|
| Tests | **2,248**, all passing |
| Feature kinds | 24 |
| Catalogue shapes | 27 archetypes, 8 assembly recipes |
| Manufacturing rules | 17 |
| Product code | 63,299 lines |
| Model benchmark | 22 cases, 100% of buildable requests built |

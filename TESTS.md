# DATUM — five manual test cases

Five tests, one per capability. Each is a few minutes of clicking, with fixture files supplied
so nothing depends on finding your own input. Every expected number below was measured from
this build, not estimated.

## Before you start

```bash
cd ui && npm run dev
```

Open the address Vite prints — `http://localhost:5273`. The top of the window has three tabs —
**Modeller**, **Studio**, **CAD panel**. All five tests run in **Modeller**.

Two places to read results:

- **The status line** under the 3D view: `mass · vol · tri · build · solid`.
  `solid: closed` means the mesh is watertight — a valid solid. `OPEN` means it is not, and that
  is a failure in every test here.
- **The assistant reply** in the right-hand column, which states what was built and why.

Fixtures live in `test-fixtures/` at the repository root:

| File | What it is |
|---|---|
| `washer.png` | Black annulus — outer ⌀100 px, bore ⌀40 px, on a 140 px square |
| `flange.png` | Flange face — outer ⌀200 px, bore ⌀60 px, four ⌀24 px bolt holes on a ⌀140 px circle |
| `bracket.dxf` | 120 × 80 plate, ⌀20 central bore, four ⌀9 holes on a 90 × 50 pattern, in millimetres |

---

## TC-1 — A picture becomes a 3D solid

**Proves:** capability 1, 2D picture → 3D model.

### Steps

1. Modeller → **Open / Import…**
2. Choose `test-fixtures/washer.png`.

### Expected

| Check | Value |
|---|---|
| Assistant reply | `Traced 70.7 x 70.7 mm: 0 straight edges, 1 arcs, 1 hole.` followed by `The picture was taken as 100 mm across — if that is wrong, click Traced outline in the tree and set Overall width.` |
| Status `solid` | `closed` |
| Status `vol` | `20.01 cm³` |
| Status `mass` | `54.0 g` |
| Status `tri` | `112` |
| Feature tree | one feature, **Traced outline** |
| Viewport | a washer — a disc with a concentric round hole, seen in 3D, orbitable |

Then repeat with `flange.png`. Expect `Traced 83.8 x 83.8 mm: 0 straight edges, 1 arcs, 5 holes.`,
`closed`, `28.12 cm³`, 336 triangles — the bore plus four bolt holes, all found and all cut
through.

### Then fix the scale — the second half of the test

A photograph carries no scale, so the app assumes the picture is 100 mm across and says so. The
washer occupies 100 px of a 140 px image, so it comes out **70.71 mm** wide. Correct it:

1. Click **Traced outline** in the tree.
2. Set **Overall width** to `50`.

| Check | Value |
|---|---|
| Status `vol` | `10.00 cm³` — was 20.01, and 20.01 × (50/70.71)² = 10.00 |
| Status `mass` | `27.0 g` |
| Status `solid` | still `closed` |
| Bore | shrinks in proportion — the hole scales with the outline, it does not stay put |
| Position | unchanged — rescaling does not walk the part across the origin |

The editor for a traced outline shows only **Overall width**, **Thickness**, **Draft** and
**Operation**. Length and Corner radius are deliberately absent: a traced profile is a point
list, and those two would be controls that quietly did nothing.

### Pass

The outline and *every* internal hole are recovered, the result is `closed`, the hole count in
the reply matches the picture (1 for the washer, 5 for the flange), and setting **Overall width**
rescales outline and holes together while the part stays where it was.

### Fail means

A hole count below the real one means island detection dropped a contour. `OPEN` means the
traced polygon self-intersects and the extrude could not close it.

---

## TC-2 — A sentence becomes a 3D object

**Proves:** capability 2, prompt → model.

### Steps

1. Modeller → click into the assistant box on the right.
2. Type `make a cup` and press Enter.

### Expected

| Check | Value |
|---|---|
| Assistant reply | begins `Built a cup / mug.` and states the capacity (**about 289 ml**) |
| Status `solid` | `closed` |
| Status `mass` | `256.8 g` |
| Status `tri` | `3538` |
| Bounding size | 114 × 82 × 95 mm |
| Viewport | a mug with a hollow bore and a handle standing off one side |

The reply also volunteers where it compromised — one 2 mm round was skipped because the corner
only had 2.00 mm of run-out for a radius needing 2.22 mm. That is the app reporting its own
limit rather than silently producing a wrong blend.

### More prompts worth trying

| Prompt | Expected |
|---|---|
| `a gearbox` | 8 parts, ratio stated as `54/18 = 3.00:1`, 3091.9 g, `closed` |
| `make an aeroplane` | 20 parts, A320 proportions, 37.6 m long / 35.8 m span, `closed` |
| `a car engine` | **asks you first**, then builds — see below |

### The conversation, not just the command

`a car engine` is the one to watch, because it is the case that used to fail: it returned a car.
Now it stops and asks four questions before building any geometry —

1. **Power?** Crank kilowatts.
2. **Cylinders?** Four in line, six or eight in a vee.
3. **Rated speed?** rev/min at peak power.
4. **Brake mean effective pressure?** Bar — ~10–12 naturally aspirated, 18–25 turbocharged.

Every question carries a default, so **Build it** works without answering any. Answer them and
the engine is sized from them rather than picked off a shelf: `P = BMEP·V·N/2` for a four-stroke
gives the swept volume, and `V = πb²s/4` with a chosen stroke/bore ratio gives the bore. Change
the power and the block changes size. That is the difference between a catalogue and a model.

### The offline boundary — test this too

Type `a hex bolt M8 x 40` with **AI: off**. It should refuse cleanly:

> Nothing in the built-in catalogue matches "a hex bolt M8 x 40". Configure a model in AI
> settings to decompose objects that are not in the list, or try one of the shapes below.

That is correct behaviour, not a bug. Now click **AI: off** in the toolbar, choose a provider,
paste a key, and send the same prompt again — it should now build. Testing both halves is the
point: the catalogue covers common objects offline, and the model covers the rest.

### Pass

The named object appears, it is `closed`, its mass is physically sensible for the material, and
the reply describes what was built rather than a generic acknowledgement.

---

## TC-3 — A 2D drawing becomes a 3D part

**Proves:** capability 3, 2D drawing → 3D.

### Steps

1. Modeller → **New** (clear anything from TC-2).
2. **Open / Import…** → `test-fixtures/bracket.dxf`.

### Expected

| Check | Value |
|---|---|
| Status `solid` | `closed` |
| Status `vol` | `54.22 cm³` |
| Status `mass` | `146.4 g` — aluminium 6061-T6 at 2.7 g/cm³ |
| Status `tri` | `512` |
| Bounding size | 120 × 6 × 80 mm |
| Feature tree | one feature, **Reconstructed solid**; the document is named **From drawing** |
| Assistant reply | `Built a solid 120.0 × 6.0 × 80.0 mm, 146.4 g, from 1 view.` then explains where 6 mm came from |

### The depth is inferred, not invented — check this specifically

A single view cannot show thickness. The drawing carries no thickness note, so the app reads it
off the **fastener pattern** instead: the four repeated ⌀9 holes are M8 clearance, an M8 joint
wants about 6.4 mm of plate, and the nearest stocked sheet is **6 mm**. The reply says exactly
that.

To see the stronger path, open `bracket.dxf` in a text editor and add a thickness note before
the final `ENDSEC`:

```
0
TEXT
8
NOTES
10
10.0
20
-20.0
40
5.0
1
THK 3 MM MS PLATE
```

Re-import. The depth becomes **3 mm**, the reply reads *"The drawing states 3 mm, so the depth
is not a guess"*, and the message turns from amber to normal — because a stated dimension is
not a caveat.

### Verify the geometry by hand

The DXF holds 4 lines and 5 circles. Analytically:

```
(120 × 80 − π·10² − 4·π·4.5²) × 6 = 54 188.23 mm³
```

The app returns 54 220.99 mm³ — **605 ppm high (0.06 %)**, which is the polygon approximation of
the five circular arcs, not an arithmetic error. Raise the arc resolution and the gap shrinks;
the flat 120 × 80 outline contributes zero error.

### Pass

All five circles appear as through holes in the right places, the outline is 120 × 80, the solid
is `closed`, and the assistant states the depth assumption out loud instead of inventing one
silently.

### Fail means

If the reply says *"The file has no ENTITIES section"* the DXF did not parse. If holes are
missing, circle entities on the `HOLES` layer were not classified as internal.

---

## TC-4 — A 3D model becomes a manufacturing drawing

**Proves:** capability 4, 3D → drawing.

### Steps

1. Build something first — `make a cup` from TC-2 is fine.
2. Click **Drawing SVG**.
3. Open the downloaded `Cup / mug.svg` in a browser.

### Expected in the sheet

| Element | Expected |
|---|---|
| Views | four, labelled **FRONT**, **TOP**, **RIGHT**, **ISO** |
| Projection note | `FIRST ANGLE PROJECTION · ISO 2768-m` |
| Linear dimensions | toleranced, e.g. `114.0 ±0.3`, `95.0 ±0.3`, `81.99 ±0.3` |
| Diameters | with fit class, e.g. `⌀82.0 H11`, `⌀50.45 H11` |
| Repeated features | collapsed, e.g. `2 x ⌀73.6 H11` |
| Geometric tolerance | a flatness frame `[ ⏥ | 0.1 ]` |
| Title block | PART NUMBER, DESCRIPTION, MATERIAL (`Stoneware`), SCALE (`1:3`), MASS (`256.8 g`), UNITS (`mm`), SHEET (`1 of 1`), REV, DATE |
| General notes | `Break sharp edges 0.3 max.` · `Dimensions in mm.` |

Then click **Drawing DXF** and open it in any DXF viewer — same dimension set, as CAD entities
rather than a picture, so a shop can measure it.

Also click **STL** and confirm the file has **3538 facets**, matching the `tri` count on screen.
The drawing and the mesh come from the same solid, so they cannot disagree.

### Then export a STEP, which is the one that leaves DATUM

1. **New** → type `a bracket` → Enter.
2. Click **STEP**.

| Check | Expected |
|---|---|
| Message | `Exported L-bracket.step — 86 faces from 392 triangles.` |
| First line of the file | `ISO-10303-21;` |
| Schema | `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'))` |
| Body | one `MANIFOLD_SOLID_BREP('L-bracket', …)` |
| Faces | 86 `ADVANCED_FACE` entities — **not** 392 |
| Edge sharing | exactly twice as many `ORIENTED_EDGE` as `EDGE_CURVE` |

Then try parts with curved geometry and export STEP again:

| Prompt | Expected message |
|---|---|
| `a flange` | `491 faces from 3290 triangles, including 10 cylindrical surfaces recovered from 926 facets.` |
| `a funnel` | `11 faces from 1240 triangles, including 1 cylindrical and 2 conical surfaces recovered from 744 facets.` |
| `a pulley` | `22 faces from 1372 triangles, including 4 cylindrical and 2 conical surfaces recovered from 910 facets.` |

The file should contain `CYLINDRICAL_SURFACE` and `CONICAL_SURFACE` entities with `CIRCLE`
edges at the rims. **Check the radii are round numbers** — the flange writes `80.`, `45.` and
`7.`, not `79.9999999181`. The kernel declares each surface when it builds it and carries the
tag through the boolean, so nothing is measured back off the triangles. A funnel arriving as **eleven faces** rather than 1240 triangles is the whole
point: in a CAD package each is one selectable face with a measurable diameter or taper angle.

Check the edge ratio on each — still exactly 2.00. Recognising surfaces must never cost the
solid its validity, and if it would, DATUM drops the surface rather than the guarantee.

That last row is the one that decides whether the file is CAD or scenery. Every edge of a
closed solid is walked once by each of the two faces meeting along it, so the ratio must be
exactly 2.00. A writer that gave each face its own copy of the shared edge lands on 1.00, and
the receiving package reports "unable to knit solid" and imports loose surfaces instead.

If you have SOLIDWORKS, Fusion, Onshape or FreeCAD to hand, open the file: it should arrive as
a **solid body**, not a surface body, and clicking the top of the plate should select the whole
face in one click.

### Pass

Four correctly projected views, every dimension carrying a tolerance or a fit class, a complete
title block with the mass matching the status line, and a scale that makes the part fit the
sheet.

---

## TC-5 — The mathematics

**Proves:** capability 5, exactness that parametric modellers are usually measured by.

This is the one to run slowly, because it is the claim that is easiest to assert and hardest to
back up. Each step compares the app against a closed-form answer you can check on paper.

Build these in the Modeller with the **Add a feature** buttons in the left column. Parameters
commit as you type — there is no Apply for numbers.

### 5a — Exact on planar geometry

1. **New** → click **▭ Box**.
2. Click **Box1** in the tree, set length **100**, width **60**, height **20**.

| Check | Expected |
|---|---|
| `vol` | `120.00 cm³` — exactly 100 × 60 × 20 |
| `mass` | `324.0 g` — exactly 120 cm³ × 2.7 |
| `tri` | `12` |
| Error vs closed form | **0 ppm** |

Twelve triangles for a box, not hundreds. Nothing is approximated when nothing curves.

### 5b — Coincident faces, the case that breaks naive booleans

1. **New** → **▭ Box**, set 100 × 60 × 20.
2. **▭ Box** again, set 40 × 40 × **20**, and set **Operation → Remove material**.

Both boxes are centred on the origin and both are 20 tall, so the cutter's top and bottom faces
lie **exactly** on the target's top and bottom faces. Coplanar faces are the classic failure
mode for BSP-based CSG: the classifier cannot tell inside from outside on a shared plane, and
the usual results are stray slivers, doubled facets, or a leaky solid.

| Check | Expected |
|---|---|
| `vol` | `88.00 cm³` — exactly 120 000 − 32 000 |
| `mass` | `237.6 g` |
| `solid` | `closed` |
| `tri` | `32` |
| Error vs closed form | **0 ppm** |

### 5c — Total annihilation

Same again, but make the second box **identical** to the first — 100 × 60 × 20, **Remove
material**.

| Check | Expected |
|---|---|
| `tri` | `0` |
| `vol`, `mass`, `solid` | all `—` — with no geometry left there is nothing to measure, and the status line says so rather than printing a misleading `0.00 cm³` |
| Behaviour | no crash, no error banner, tree still editable |

Subtracting a body from itself is degenerate everywhere at once. The correct answer is nothing,
and the app must survive returning it — an empty viewport, not a crash or a stuck spinner.

To confirm it recovered, click **✕** on Box2 in the tree. The 120 cm³ box returns immediately.
(**Undo** also works, but it steps back one *edit* at a time — the last edit was typing a
parameter, so one press restores Box2's previous size rather than removing the feature.)

### 5d — Curved geometry, and an honest error bound

1. **New** → **▭ Box** 100 × 60 × 20.
2. **⊙ Hole** → pattern **single**, diameter **10**.

Closed form: `120 000 − π·5²·20 = 118 429.20 mm³`.

| Check | Expected |
|---|---|
| `vol` | `118.45 cm³` |
| Error | **164 ppm (0.016 %)** |

Now do it with six holes — **⊙ Hole**, pattern **bolt circle**, diameter **8**, circle **40**,
count **6**. Closed form `120 000 − 6·π·4²·20 = 113 968.14 mm³`; the app gives 114 066.87 mm³,
**866 ppm**. The error scales with the number of curved surfaces because it *is* the arc
faceting, and it is bounded and predictable rather than drifting.

### 5e — Fillets on all twelve edges

1. **New** → **▭ Box** 100 × 60 × 20.
2. **◜ Fillet** → radius **5**, leave the scope on the whole body.

A box with every edge rolled at radius *r* is the Minkowski sum of a shrunken box and a ball, so
it has an exact volume:

```
V = a'b'c' + 2r(a'b' + b'c' + c'a') + πr²(a' + b' + c') + 4πr³/3
  where a' = 100−10 = 90, b' = 60−10 = 50, c' = 20−10 = 10
  V = 45 000 + 59 000 + 11 780.97 + 523.60 = 116 304.57 mm³
```

| Check | Expected |
|---|---|
| `vol` | `116.51 cm³` |
| Error | **1807 ppm (0.18 %)** — arc and sphere faceting on 12 edges and 8 corners |
| `solid` | `closed` |
| `tri` | `508` |
| Edges filleted | **all 12**, corners blended into each other, no gaps at the corners |

Rotate the model and look at the corners specifically. Three fillets meeting at a corner is
where blend algorithms fail; the corner patch should be a smooth sphere octant, not a hole or a
crease.

### Pass for TC-5

- Planar volume and the planar boolean are **exact** — 0 ppm, not "close"; the self-cut leaves
  nothing at all and the app stays usable.
- Coincident faces produce the right volume and stay `closed`.
- Curved error stays under 0.2 % and grows only with the number of curved faces.
- All 12 edges take the fillet, and the corners close.

### 5f — Constraints, not coordinates

The other five parts of this test measure arithmetic. This one measures whether the app is
*parametric* — whether a dimension drives geometry, or is just a number in a box.

1. **New** → click **✎ Sketch** in the feature toolbar.
2. With **Rectangle** selected, click twice on the canvas to drag out a rough rectangle. Do not
   try to be accurate; make it visibly crooked.
3. Note the status: **Under-constrained: 8 degrees of freedom left.**
4. Click the bottom line, press **Horizontal**. Repeat for the top. Click each side, press
   **Vertical**. The status falls to **4**.
5. Type `100` in the Dimension box. Click the two bottom corner points, press **Distance**.
6. Type `60`. Click the two right-hand corner points, press **Distance**.

| Check | Expected |
|---|---|
| Status | **Under-constrained: 2 degrees of freedom left** |
| Status `vol` | `120.00 cm³` — exactly 100 × 60 × 20 |
| Status `solid` | `closed` |
| Status `tri` | `12` |

The rectangle is now geometrically exact although nothing exact was ever entered. The two
remaining degrees of freedom are the profile's freedom to translate — nothing anchors it to the
origin yet, which is correct and is what a real sketcher would also report.

**Then change one number.** Edit the 100 mm dimension to 150. The volume becomes `180.00 cm³`,
and *both* corners on that side move — not one. That is the whole point: a constraint expresses
a relationship, so editing it propagates through everything that depends on it.

Draw a circle inside the outline and it becomes a hole. Add a second **Distance** of 250 mm
across a span already fixed at 100 and the editor refuses it, naming the clash, rather than
accepting a sketch that cannot solve.

### 5g — Components that know about each other

1. **New** → type `a gearbox` → Enter.
2. Scroll to the **Assembly** panel under the parameters.
3. Press **Check for clashes**.

| Check | Expected |
|---|---|
| Summary | `6 clashes: components overlapping by more than a press fit would.` |
| First row | `Case ∩ Output gear` at roughly `33.6 cm³ · 24%` |
| Components listed | Case, Input pinion, Output gear, Input shaft, Output shaft, Bearing 1, Bearing 2 |

Note what is **not** in that list: *Case cavity*. A cavity is a tool that hollows the case, not
a part sitting inside it. Counting it as a component made the same gearbox report fourteen
clashes, most of them a case overlapping its own cavity by 100 % — every one an artefact.

Then mate two parts:

4. Set **First** to `Case` and **Second** to `Output gear`.
5. Press **Concentric**.

| Check | Expected |
|---|---|
| Message | `32 degrees of freedom left.` |
| Mate list | `concentric · Case ↔ Output gear` |
| Viewport | the gear moves onto the case's axis |

Seven components, one fixed, six free at 6 DOF each is 36. A concentric mate removes 4, leaving
32. **Re-solve** re-applies every mate after an edit. Adding a mate that cannot hold alongside
the others is refused at the moment you add it rather than quietly rearranging the model.

### 5h — One number, and the model follows

The test that decides whether this is a CAD system or a shape generator.

1. **New** → click **▭ Box**. Note `vol 60.00 cm³` — the 60 × 40 × 25 default.
2. In the **Parameters** panel, press **Add a parameter**.
3. Click its name, type `plateLength`, press Enter.
4. Set its value to `200`.
5. In the box's parameters, press the small **ƒx** button beside **Length**.
6. The field becomes text. Type `plateLength`.

| Check | Expected |
|---|---|
| Under the field | `= 200 mm`, in green |
| Status `vol` | `200.00 cm³` — 200 × 40 × 25 |
| Parameter row | now reads `1×` instead of `unused` |

**Now change the parameter to `350`.**

| Check | Expected |
|---|---|
| Status `vol` | `350.00 cm³` |
| Status `mass` | `945.0 g` |

Nothing was typed into the box's Length. It followed, because it is written in terms of
something else. Type `plateLength * 2 + 10` and it follows that too; type `nope * 2` and the
field turns red with *"There is no parameter called nope"* while the geometry holds its last
good value rather than collapsing.

Two parameters referring to each other in a loop are reported as circular by name, not left as
a silent zero. Renaming a parameter rewrites every expression that uses it.

### Why this is the strong claim

The parametric modellers this is measured against are exact on curves too, because they carry
analytic surfaces rather than triangles. Where DATUM is ahead is the *rest* of the list: it
holds up on coincident and degenerate input where BSP CSG normally fails, it reports its own
compromises rather than hiding them (see the cup's skipped round in TC-2), and the same solid
feeds the mass, the drawing, and the mesh, so those three can never disagree. Where it is
behind is arc resolution — and 5d and 5e measure exactly how far, instead of asserting it.

---

## Score sheet

| # | Capability | Fixture / input | Key expected value | Pass |
|---|---|---|---|---|
| 1 | Picture → 3D | `washer.png`, `flange.png` | 1 hole / 5 holes, `closed`, rescales to 10.00 cm³ | ☐ |
| 2 | Prompt → 3D | `make a cup` | 256.8 g, ~289 ml, `closed` | ☐ |
| 3 | Drawing → 3D | `bracket.dxf` | 54.22 cm³ (605 ppm), 120 × 6 × 80, depth inferred from M8 holes | ☐ |
| 4 | 3D → drawing | cup → **Drawing SVG**, bracket → **STEP** | 4 views, toleranced dims, title block; 86 faces, 2.00 edge ratio | ☐ |
| 5 | Mathematics | boxes, holes, fillets | 0 ppm planar, 0 ppm coincident cut | ☐ |
| 5f | Constraints drive geometry | Sketch → constrain → dimension | 120.00 cm³ from a crooked rectangle | ☐ |
| 5g | Assemblies hold together | `a gearbox` → Check for clashes → Concentric | 6 clashes found; mate removes 4 DOF | ☐ |
| 5h | Design intent survives | Parameter → ƒx expression → edit it | 200.00 → 350.00 cm³ from one number | ☐ |

## If a test fails

Open the browser console (F12). Geometry problems print the feature that failed and why.
`solid: OPEN` on the status line is always worth reporting — it means a boolean left the mesh
non-watertight, and the volume and mass printed alongside it are then meaningless.

The automated suite covers the same ground and more:

```bash
cd ui && npm test
```

937 tests, all passing on this build. A manual test failing while the suite passes usually means
a difference in the input, so check the fixture file first.

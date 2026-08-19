# DATUM manual

Every feature, and how to use it.

Units are millimetres. Z is up. The feature tree is the document — the mesh is derived from it,
so anything can be edited after the fact by changing a parameter.

---

## 1. Building shapes

Click a toolbar button to add a feature. It appears in the tree and opens in the editor below.

Every feature that adds material has an **Operation**: `Add`, `Remove` (cut) or `Keep the
overlap` (intersect).

### Box
Rectangular block.

| Parameter | Meaning |
|---|---|
| Length, Width, Height | Size along X, Y, Z |
| Centre X, Centre Y | Where it sits |
| Edge break | Rounds all 12 edges. Leave at 0 to keep the edges sharp — a broken edge cannot be filleted later |

### Cylinder
Cylinder or disc, axis along Z. Diameter, Height, Centre X/Y, Edge break.

### Sphere
Diameter, Centre X/Y/Z.

### Sketch
Draw a closed profile, constrain it, extrude it.

1. Add **Sketch**. The editor opens with a drawing canvas.
2. Draw lines, rectangles or circles.
3. Relations are added automatically — lines within 5° of horizontal or vertical are snapped
   and constrained.
4. Click any dimension on the canvas to type an exact value. It becomes a driving dimension.
5. Set **Thickness** to extrude it.

Plane: Top (XY), Front (XZ) or Right (YZ). Draft tapers the walls as it extrudes.

### Extrude
Push a profile along its plane's normal.

| Parameter | Meaning |
|---|---|
| Plane | Which plane the profile sits on |
| Length, Width, Corner radius | The rectangular profile |
| Distance | How far to push |
| Draft | Taper, in degrees |

A traced or imported outline is a point list instead, and shows **Overall width** rather than
Length and Width — because a picture carries no scale and that is the number you adjust.

### Revolve
Spin a section about the Z axis of its plane.

Section length, Section width, Offset from axis, Angle (360 for a full turn).

### Loft
Blend one section into another. Use for duct transitions, tapered bosses, aerofoil sections.

| Parameter | Meaning |
|---|---|
| Plane | Which plane the bottom section sits on |
| Height | Distance between the two sections |
| Bottom / Top shape | Rectangle, circle or polygon — each end independent |
| Bottom / Top offset X, Y | Move an end sideways to lean or sweep the solid |
| Smoothness | Intermediate rings; more gives a smoother blend |

Only the dimensions each end actually uses are shown — a circular end has a diameter, not a
length and width.

### Sweep
Drive a section along a path. Use for springs, threads, tubes, handles.

| Parameter | Meaning |
|---|---|
| Section | Circle, rectangle or polygon, and its size |
| Path | Straight, Arc or Helix |
| Straight | Length |
| Arc | Bend radius, Bend angle |
| Helix | Coil radius, Turns, Pitch |
| Twist | Rotation of the section over the whole path |
| End scale | Taper — 0.5 finishes at half size |

Set Operation to `Remove` for a swept cut.

---

## 2. Modifying the solid

These act on whatever has been built so far, so they go **after** it in the tree.

### Hole
| Type | What it cuts | Its own parameters |
|---|---|---|
| Through | All the way through | — |
| Blind | Stops at a depth | Depth |
| Counterbore | Hole plus a flat recess for a cap screw head | Counterbore diameter, Counterbore depth |
| Countersink | Hole plus a cone for a flat head | Countersink diameter, Head angle |
| Tapped | Drilled at the **tapping** size, not the thread size — M6 gives a 5 mm hole | Depth |

Drilled downwards from the top of the part; depths are measured from there. In the viewport,
right-click a face that points up and choose **Drill a hole here** to place one at its centre.

Pattern: `Single` (X, Y), `Bolt circle` (Bolt circle diameter, Count) or `Grid` (Columns, Rows,
Spacing X, Spacing Y).

### Pocket
Mill a rectangular recess into the top face. Length, Width, Depth, Corner radius, Centre X/Y.

### Slot
Cut a rounded-end slot. Length, Width, Centre X/Y, Angle.

### Fillet
Round sharp edges. Radius.

Scope it by picking faces first — see *Right-click menu* below. Without a face selection it
rounds every edge sharper than 30°.

A radius wider than half the edge it runs along is refused, with the maximum stated.

### Chamfer
Cut edges back at 45°. Distance. Same scoping as Fillet.

### Shell
Hollow the solid out, leaving walls of the given Thickness.

### Rib
Stand a stiffening wall on the part.

Length, Thickness, Height, Centre X/Y, Draft. Drafted by default, because a rib with parallel
sides cannot leave a mould.

### Draft
Taper the walls so the part can be drawn from a mould. Angle.

Positive narrows towards the top; negative narrows downwards. The footprint and the overall
height are unchanged.

### Dome
Bulge a flat face into a curved one.

Face (Top or Bottom), Height, Smoothness.

The bulge is elliptical over the face's own extent, so a dome on a long rectangular face
follows the rectangle rather than bulging a circle in the middle of it. It falls to nothing at
the edge, which is what leaves the footprint unchanged.

Smoothness is a request, not a guarantee. Refining splits *every* triangle in the part — it has
to, or the mesh develops cracks — so a part that is already dense is refined less. A dome on a
tessellated sphere would otherwise go from 3,800 triangles to 242,000 to raise a bump worth a
third of a percent of its volume.

### Split
Cut the solid into two bodies with a plane.

Cut along (X, Y or Z), Position (a fraction through the part), Keep (Both halves / The near half
only / The far half only).

Both halves are kept by default — that is what the operation is for. They come back as separate
bodies, so each takes its own colour and its own line in the bill of materials.

### Wrap
Knurling, a gripping pattern, a retaining groove or a ring of flats, rolled around a round part.

| Parameter | Meaning |
|---|---|
| How many | Features around the circumference |
| Feature width | Width of each one |
| Depth | How far it cuts in, or stands out |
| Band height | How tall the band is |
| Band centre Z | Where the band sits |
| Radius | Taken from the part if left alone |
| Cut or raise | Engrave into the surface, or emboss onto it |

**What it does not do:** text on a cone, or a sketch wrapped onto a doubly-curved surface. Those
need a surface parameterisation the kernel does not carry. This builds the case that covers most
of the use — the same shape repeated around an axis at a constant radius — rather than
approximating the rest badly.

### Datum
A reference plane to build on. It creates no geometry.

Parallel to (Top / Front / Right), Offset, Tilt about X, Tilt about Y.

Once a datum exists, **Plane** on Sketch and Extrude offers *A datum plane*, and a second
control names which one. Tilt is about the datum's own in-plane axes, so "tilt about X" means
the same thing on a datum parallel to Front as on one parallel to Top.

Sketching on a model face covers the common case. A datum covers the one it cannot: a plane
offset from, or tilted relative to, anything that exists yet.

A feature pointing at a datum that has been deleted falls back to its named plane rather than
refusing, so an older document still builds.

### Linear pattern
Repeat the previous feature along a direction. Count, Spacing, and the direction as dx/dy/dz.

### Circular pattern
Repeat around the Z axis. Count, Angle, Centre X/Y.

### Mirror
Mirror the body across a plane. Plane: XY, XZ or YZ.

---

## 3. The viewport

### Navigation
| Action | Does |
|---|---|
| Drag | Orbit |
| Middle-drag, or Shift-drag | Pan |
| Wheel | Zoom at the pointer |
| Double-click | Fit to window |
| Right-drag | Move the selected part |

### Selecting
| Action | Does |
|---|---|
| Click a face | Selects it, and its feature in the tree |
| Drag a selected face | Pushes or pulls it — see below |
| Shift-click | Adds a face to the selection |
| **Ctrl-drag** | Rubber-band sweep — takes every face the band covers, front and back |
| Shift + Ctrl-drag | Adds the swept faces to the selection |
| Click empty space | Clears the selection |

### Push and pull
Grab a face and drag it.

1. **Click** a face to select it.
2. **Drag** that same face. It moves along its own normal, and the distance shows at the top.
3. Release.

Pulling out adds material; pushing in cuts it. Dragging *along* the face does nothing, dragging
*away* from it moves the full amount — the pointer's travel is projected onto the face normal as
it appears on screen.

A drag that starts anywhere other than an already-selected face still orbits, so navigation
keeps its meaning.

It stays parametric. The drag does not move vertices — it adds an **Extrude** whose profile is
that face's own outline, on that face's own plane, with the drag as its distance. Reopen it to
type an exact number, suppress it, or delete it, exactly like a feature added from the toolbar.

Flat faces only: a curved face has no single direction to move along, and it says so.

### Right-click menu
Right-click **without dragging** to open it.

- Round / Chamfer these faces — adds the feature already scoped to what you picked
- Drill a hole here — at the centre of the face
- Sketch on this face / Extrude from this face — builds on that face rather than on a named plane
- Rib on this face
- Delete *the feature that made this face*
- Clear selection

### Measuring
Pick faces and read the status line. It replaces the mass and volume while anything is picked.

| Picked | Reports |
|---|---|
| One flat face | Area, normal, centre, what the face is for |
| One round face | Diameter, length, axis |
| Two parallel flat faces | Distance between them, measured along the shared normal |
| Two flat faces at an angle | Angle, centre distance |
| Two round faces | Centre distance, both diameters |
| More | Total area, largest, smallest |

### Section view
Press **S** or click **SEC** to cut the part open.

Choose the axis (X, Y, Z) and drag the slider for how far through. The slider is a fraction, so
it means the same on a washer and on an airliner.

### Keyboard
| Key | Does |
|---|---|
| 1–7 | Front, Back, Left, Right, Top, Bottom, Isometric |
| F | Fit to window |
| E | Show or hide edges |
| S | Section view |
| Ctrl+Z / Ctrl+Y | Undo / Redo |

---

## 4. Parameters and expressions

### Named parameters
**Add a parameter** in the Parameters panel. Give it a name, a value and a note.

Parameters can be written in terms of each other, in any order. A circular definition is
reported by name.

### Driving a feature from a parameter
Click the **ƒx** beside any dimension to turn it into an expression. Type a name or a formula.
The resolved value is shown underneath.

### Referencing another feature
An expression can name any dimension of any feature **earlier in the tree**:

```
Base.length / 2
Base.height * 2 - clearance
Plate.thickness
```

The name is the feature's name with spaces and hyphens turned into underscores — `Mid-frame`
becomes `Mid_frame`. Renaming the feature renames its dimensions. Two features sharing a name:
the first keeps it, the second becomes `Rib_2`.

Start typing in an expression field and the editor offers every name valid at that feature,
with its current value.

A feature cannot reference one that comes after it, which is why a circular reference cannot be
written.

### Maths available
`+ - * / % ^`, brackets, and `sin cos tan asin acos atan sqrt abs min max round floor ceil hypot`.
Angles are in degrees.

---

## 5. Getting geometry in

**Open / Import…** takes:

| File | Becomes |
|---|---|
| `.datum.json` | The feature tree, fully editable |
| `.step` / `.stp` | One feature per solid body. Units are read from the file |
| `.dxf` | A drawing rebuilt as a profile |
| Image | See below |

### Image → 3D
A dedicated button. Give it a photograph or a screenshot.

1. The part is separated from its background — by how far each pixel is from the background
   colour, so a shaded object survives.
2. The outline is traced and fitted to straight lines and arcs.
3. Then one of three things:
   - **Relief.** If the brightness varies inside the outline and the light is near the camera,
     the surface is recovered from the shading and the top face is shaped to match.
   - **Revolve.** If the outline is symmetric about one centreline only — a bottle seen from
     the side — it is revolved.
   - **Extrude.** Otherwise, a flat profile of the given thickness.

The message says which of the three it did, and why.

A picture carries no scale, so 100 mm across is assumed. Click the feature and set **Overall
width** to correct it. **Relief depth** is a parameter too.

Holes rule out a revolve: a picture you can see through is a plan view, not a silhouette.

---

## 6. Getting geometry out

| Button | Produces |
|---|---|
| Drawing SVG | Dimensioned drawing |
| Drawing DXF | The same, for CAD and CAM |
| STEP | AP214 solid with faces and edges — for any CAD or CAM package |
| STL | Mesh, for 3D printing |
| Save file | The feature tree as `.datum.json`, so it stays editable |

---

## 7. The assistant

Type what you want and press Build. It works with no model configured.

### How it reasons
Every build, whichever route it took, goes through the same steps. Open **How this was worked
out** under the reply to see them:

1. **What was asked for** — the dimensions, mass, material and counts read from your request
2. **From your own parts** — what your library suggests, when you did not state a size
3. **Approach** — which route was used and why
4. **Check** — the built solid measured against every requirement
5. **Correct** — scaled to meet them, if scaling can
6. **Result** — what was met and what was not

The panel opens by itself when something was not met. A part that does not meet what you asked
for says so rather than looking finished.

### Stating requirements
Write them in plain language. All of these are read:

```
a 400 mm long bracket
a plate 200 mm long, 120 mm wide and 6 mm thick
a 2 inch diameter shaft
a bracket to hold 2 kg
a mounting plate in 6061
```

Two dimensions that demand different scale factors cannot both be met — it says so instead of
picking one.

### With a language model
Set one in **AI: off**. It adds: research of real products, decomposition of objects not in the
catalogue, and a repair pass where a first attempt that fails inspection is sent back.

---

## 8. Your own parts

### Library
**Library…** saves the open part under a name and reopens it later.

Before generating anything, a request is checked against what you have saved. If a saved part
answers it, you are offered it instead of a new one — with the choice to build anyway.

### Teaching
**Teach…** stores a request and the part that correctly answers it.

Taught examples are retrieved by relevance and shown to a language model as worked answers, so
it builds in your vocabulary and at your dimensions. It does not change any model's weights.

**Learned dimensions** in the same panel shows what your parts imply about size. It needs at
least 8 saved parts, and it only offers a number when it lands within 50% and clearly beats
taking the middle of your library. Otherwise it says nothing.

Export builds a JSONL dataset for fine-tuning, for the day you have the volume.

---

## 9. Appearance

Select a feature and use **Appearance** in the editor.

- **Colour** — a chosen colour for that body. Reset returns it to its material's colour.
- Bodies with no colour set are coloured by material; where materials do not distinguish them,
  by position in the tree.

A fillet is the same colour as the part it belongs to — colour follows the body, not the
feature. A feature placed rather than combined starts a new body.

---

## 10. Assemblies

Once a document has more than one body, the Assembly panel lists them and lets you mate them.

Add a mate by choosing its kind and the two bodies: `Coincident`, `Concentric`, `Parallel`,
`Perpendicular`, `Distance` (takes a value) and `Lock`.

**Resolve** solves the whole set at once and reports the outcome: solved, under-constrained,
over-constrained, conflicting, or diverged. Under-constrained is not an error — it means the
assembly still has freedom left, which is usually what you want until the last mate.

The panel also reports interference between bodies and a bill of materials with a real mass
against every line.

---

## 11. Anodizing rack

**Rack for this** sizes a rack for the open part: area, current, section, cooling and contacts.

It reports the process, rack material, electrical load and eight checks against it.

# Getting an existing SOLIDWORKS library into DATUM

## The problem, stated plainly

`.sldprt`, `.sldasm`, `.slddrw` and `.dwg` are proprietary binary formats. Nothing outside
SOLIDWORKS and a licensed translator can read them — not a browser, not this project. That is
a property of the formats, not a gap anyone left open, and no amount of work here changes it.

What *can* be done is to use the SOLIDWORKS seat you already have to convert the library once,
into formats that are open and that DATUM reads.

## What to run

[`BatchExport.swb`](BatchExport.swb) — a VBA macro that walks a folder and writes:

| Source | Export | Readable today |
|---|---|---|
| `.slddrw` | `.dxf` | **Yes** — reconstructed into a solid by recognising the views |
| `.dwg` | `.dxf` | **Yes** — same path |
| `.sldprt` | `.step` (AP214) | **Yes** — planes, cylinders and cones; see below |
| `.sldasm` | `.step` (AP214) | **Yes** — same reader |
| — | `manifest.csv` | **Yes** — and it is the most important output |

To run it: **Tools → Macro → New**, paste the file in, save as `BatchExport.swp`, set
`SOURCE_FOLDER` and `OUTPUT_FOLDER` at the top, then **Tools → Macro → Run**.

Files are opened read-only and silently. Nothing is written back to a source file, and a file
that fails to open is recorded in the manifest with the reason rather than stopping the run.

## Why the manifest matters more than the geometry

`manifest.csv` carries one row per file: source path, export path, part number, revision,
**description**, material and mass.

The description column is the half of a training example that geometry cannot supply. An
example is *a request and the part that answers it* — and the request cannot be recovered from
a mesh afterwards, by any method. Whatever your parts are called and described as in
SOLIDWORKS is the closest thing to that request you already have, so it is worth checking that
column is populated before running the batch on nine hundred files.

If your parts have empty Description properties, the batch is still worth running for the
geometry, but plan on writing the requests by hand.

## What happens to each export

### Drawings → DXF → solids, today

DATUM reads the DXF, recognises which outlines are which view, and intersects their extruded
profiles to rebuild the solid. This is a **visual hull**: an enclosed internal cavity cannot be
seen from outside and will not appear. The import says so in its own output rather than leaving
you to discover it.

A reconstructed solid can be saved to the part library and will be found by the reuse gate
before anything similar is generated again. It **cannot** yet be taught as a training example —
see below.

### Parts and assemblies → STEP, today

The STEP importer reads planes, cylinders and cones — which is what a prismatic machined part
is made of. Open the `.step` file the same way you open anything else.

Prismatic and simply-turned work round-trips exactly — plates with holes, tube, washers, hex
nuts, gears, bottles. Parts whose **conical faces meet other surfaces** — a chamfered shaft, a
hubbed flange, a V-grooved pulley — come back with hairline cracks along those joins. Their
shape and size are right and the volume is within a few percent, and they are labelled
untrustworthy rather than presented as solids.

What the reader cannot represent at all — spline surfaces, tori, spheres — is reported and
skipped, never approximated. A part missing faces says so, because every measurement taken
from a solid with a hole in it is wrong without appearing to be.

### From an imported solid to a part you can teach

A training example is a *plan* — archetypes and primitives placed in space, which is the
vocabulary the planner emits. An imported solid is a mesh: correct, measurable, exportable, and
carrying no record of the features that produced it.

**Recognise** bridges the two. It reads parameters off the mesh, rebuilds the archetype from
them, and compares the two — accepting only at 97% agreement across volume, section profile,
principal inertia, surface area and envelope, with through-hole count as an exact gate. A part
that passes becomes parametric, editable and teachable at once.

It recovers boxes, cylinders, pipes, washers, stepped shafts and hex nuts, and **refuses
everything else**, saying how close it got. That refusal is the feature, not a shortfall: an
example naming a flange a washer teaches the model to answer "flange" with "washer", which is
worse than the silence it replaced.

So the position today:

- **Reuse works.** Import the library, save it, and DATUM stops regenerating parts you own —
  including parts it cannot recognise, which are still searched by name and size.
- **Teaching works** for parts built in DATUM and for imported parts that Recognise accepts.
- **Widening what can be taught** means adding proposers to the fitter, one shape at a time.

## What a real library actually does

Measured against four parts from a working SOLIDWORKS 2025 library of clips and bases
(`SwSTEP 2.0`, AP214), now committed as [test fixtures](../../ui/src/ingest/step/fixtures):

| | Result |
|---|---|
| Read at the right size | **4 of 4** — all in inches, converted correctly |
| Every face read | **4 of 4** — nothing skipped |
| Closed solid | **3 of 4** — the fourth is reported as untrustworthy, not hidden |
| Recognised as an editable part | **3 of 4** |

The last row is the one that matters for training. None of these parts is a catalogue shape —
they are machined clips and bases — so recognition works the other way round: the **outline is
traced off the solid** and the part becomes a profile cut to a thickness, which is editable,
drawable and teachable.

The solid is sectioned at every height its cross-section changes, so a part is read as a stack
of slabs — a plain plate is one, a base with a pad on it is two, a five-level clip is five.
Where a section is in several pieces, each piece is its own region: solid and void are told
apart by which way the boundary winds, not by which is bigger.

Three of the four are recovered this way, at 99.3%, 100% and 99.5% agreement. The fourth is
refused because it **imports non-manifold** — a section is only as trustworthy as the solid it
is cut from, and saying so points at the importer rather than at the profile reader.

So a library like this can now be **imported, measured, searched, racked and taught**, for the
parts that are a single extrusion.

## Teaching the whole folder at once

Once the batch has run, you do not teach parts one at a time.

In DATUM: **Teach… → Teach a folder…**, then select the export folder — the `.step` files
*and* `manifest.csv` together. DATUM reads each solid, recognises what it can, and pairs it
with that file's **description** from the manifest. One pass, and every file gets an outcome:

| Outcome | What it means | What to do |
|---|---|---|
| **taught** | Recognised, described, and now steering generation. | Nothing. |
| **not recognised** | Read as a solid, but no catalogue shape fits it. | Expected for most parts. The reason names the closest match and its score. |
| **no description** | Recognised, but the manifest row was blank. | Fill in Description in SOLIDWORKS and re-export. This one is worth chasing — the part was ready to learn from. |
| **incomplete** | The solid did not close, so its dimensions cannot be trusted. | A limitation of the STEP reader on that shape, not of your file. |
| **unreadable** | Not a STEP file, or not a solid. | Check the `status` column in the manifest. |

The per-file list is the useful output. "40 taught" on its own says nothing; **40 taught, 300
no description, 560 not recognised** tells you to go and populate a property. The reverse tells
you the fitter needs more shapes.

## Suggested order

1. Check that Description and Part Number are populated on a sample of your parts.
2. Run the batch on **one folder** first — twenty files, not nine hundred — and read
   `manifest.csv` and the `status` column.
3. Import a handful of the exports into DATUM — the STEP files first, the DXFs after — and
   confirm the solids are what you expect.
4. Press **Recognise** on a few and see how many are recovered; that number tells you how much
   of the library can be taught rather than only searched.
5. Then run the batch across the library.

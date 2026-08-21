# A part goes in, its rack comes out

**What was asked:** give DATUM a file of an object and have it produce the workable anodising
rack for that specific part, trained on the shop's own rack library.

**What is now there:** `datum rack <file>` — a STEP file in, a rack design out, checked, costed
in amps and minutes, and emitted as an editable DatumScript.

```bash
node ui/dist-cli/datum.mjs rack candle-lid.step --out rack.datum
```

```
CandleLid — 100.0 × 100.0 × 12.0 mm, 1.95 dm², 254.1 g

4 stations on a 100-0132 bar at 62.3 mm pitch, carrying 4 parts. 11.7 A at 1.5 A/dm²,
36 min for 15 µm. Clip: Grade 4 Ti, 1.016 mm strip, 25.4 mm wide, gripping 12.0 mm,
2 spot welds. 32% of the current coats the rack. Every check met.
```

The rack that comes out builds: 309.563 × 25.4 × 43.3 mm, closed solid, 5 features, 21 ms. It
opens in the viewport, exports to STEP, and goes through the drawing engine like any other part.

---

## Where the numbers come from

Not from a model. Every constant is read off a released drawing in the shop's own library and
cited at the point it is used, in `ui/src/domain/barRack.ts`:

| | |
|---|---|
| **100-0132**, `1" RACK BAR` | Grade 2 Ti, 309.563 × 25.400 × 1.270 mm, 249.238 mm usable span, 16,574.29 mm², 44.42 g |
| **Clip stock** | Grade 4 Ti, 0.025" or 0.040" strip, R0.080" bends |
| **Spot welds** | 3/16" diameter, two per clip |
| **Stations** | 2 to 10 — the range the library actually uses |

Grade 4 for the sprung parts and Grade 2 for the bar is not arbitrary: Grade 4 work-hardens, so
a clip holds contact pressure through a strip-and-reuse cycle instead of relaxing after a few
runs, and a relaxed contact is a burnt contact.

## The design variable, and what the library taught

How many stations go across the bar. The revision history of 426-0244 is the whole problem in
two lines:

```
A   WAS 10-ACROSS, NOW 8-ACROSS      5 June 2024
AB  WAS 8-ACROSS,  NOW 6-ACROSS     24 June 2024
```

Nobody reduced the count because the parts stopped fitting — they fitted at ten. They reduced it
because the bath could not carry fresh electrolyte between the parts and the coating came out
patchy. So the generator does not pack the bar. It spaces it, then checks that what fits also
drains.

Two rules fell out of the drawings, and both were wrong in the first draft:

**A part hangs edge-on.** Its two large dimensions go down into the tank and outward; only its
*smallest* dimension takes room along the bar. That is why four ~105 mm candle lids fit on
249 mm of span — the lids are 12 mm deep, and it is the 12 mm that competes. Reading the
second-largest dimension as the one that occupies the span halves the load, doubles the cost per
part, and looks entirely reasonable on the way out.

**The clear path scales with the part's face, not its thickness.** Spent electrolyte has to
travel out past the edge of the part before fresh solution replaces it, so the gap that must
stay open scales with how far there is to travel. Calibrated on the two documented racks:

```
426-0272   ~105 mm candle lid, 12 mm deep   →  4 stations   (12 + 0.4×105 = 54.0 mm)
426-0244    76 mm plaque,      10 mm deep   →  6 stations   (10 + 0.4×76  = 40.4 mm)
```

Two points fit one constant. That reproduces the shop's own two answers and is an extrapolation
everywhere else — a third documented rack would be worth more to this number than any amount of
reasoning about it.

## What it checks

Five, each stating what it measured against what, so it can be argued with rather than believed:
the stations fit the bar; solution can reach between the parts; the part hangs within a tank
depth; there is something for a clip to close on; most of the current coats work rather than
rack. A blocker fails the command, so `datum rack` is usable as a gate.

---

## On "train the model on this folder"

The honest answer, because it changes what is worth building.

The Drive folder holds around fifty files, and nearly all of them are SolidWorks-native
(`.SLDPRT`, `.SLDASM`, `.SLDDRW`) — a closed format DATUM cannot read, and only about three are
STEP. **Fifty examples, mostly unreadable, cannot train a deep model.** Anyone quoting a figure
off a model trained on that would be quoting noise. Saying so is not a limitation of this
system; it is what the data is.

What that library *does* contain is worth more than a small model would be: a set of design
rules a shop arrived at by running parts and looking at the coating. Those rules are what this
file encodes, and they are checkable — against the racks they came from, which is the only
validation worth having. `ui/src/domain/barRack.test.ts` asserts the generator lands on four
stations for a candle lid and no more than six for a 50 ml plaque, and never proposes the ten
this library already tried and corrected.

Two things would make the AI half real, in order of value:

1. **Readable examples.** Every rack exported once to STEP with its packet — bar, clip part
   numbers, station count, the part it carries. Twenty of those turn the constants above from
   two-point fits into measured relationships, and turn the generator into something that can be
   retrieved against rather than extrapolated from.
2. **Retrieval over those examples**, so a new part is answered by the nearest worked rack and
   the difference from it, rather than by a rule alone. The infrastructure for this is already
   here — the parts are meshes, and the measurements are the ones `anodizing.ts` computes.

Neither needs a trained network. Both need the library in a format a machine can read.

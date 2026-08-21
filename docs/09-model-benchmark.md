# The model path, measured

**Run:** 20 August 2026 · `npm --prefix ui run cli && node ui/dist-cli/datum.mjs bench`
**Cases:** `ui/src/eval/model.ts` — 19 requests spanning what the routes actually do
**Reproduce:** set `DATUM_PROVIDER`, `DATUM_MODEL` and `DATUM_API_KEY`, then run the command above.

This is separate from the deterministic benchmark in `ui/src/eval/`, and has to be. That one
answers *"what does every user get, offline, for nothing"* and must be reproducible to the digit
or it cannot gate a build. This answers *"how good is the model path"*, and cannot be
reproducible, because a model is not. The same prompt measured 188.08 cm³ on one run of this
suite and 11.67 cm³ on another.

---

## Result

**Groq · `openai/gpt-oss-120b`** — 19 cases, 542 s wall clock, free tier.

| | |
|---|---|
| Built a closed solid | **100%** of buildable requests (18 of 18 measured) |
| Answered by the script route | 5 |
| — first attempt, no repair | **80%** |
| — mean repairs | **0.2** |
| Answered offline, no model involved | **12 of 19**, median 112 ms |
| Refused what should be refused | **1 of 1** — after the fix below |
| Throttled and excluded | 1 |

A throttled case is excluded from every figure. A free tier refusing a fourth call in a minute
says nothing about whether the model could have written the part, and counting it as a failure
would make this a benchmark of the price plan.

---

## What the model actually wrote

The figure is worth nothing without the work. These are verbatim, and each was executed by the
same kernel the product runs on.

**A 200 mm channel section** — 137.5 cm³, three features, one repair:

```
param length = 200
param width = 60
param height = 40
param thickness = 5
param interiorWidth = width - 2*thickness

box Base length=200 width=60 height=40
pocket Void length=200 width=50 depth=35 x=5 y=5
fillet Internal radius=2 minAngle=0 convexity=all faceMatch=between
```

**A dovetail slide** — 70.96 cm³, first attempt. It reached for a loft, which is exactly what a
dovetail is:

```
loft Dovetail plane=XY height=20 baseShape=rect baseLength=120 baseWidth=40
     topShape=rect topLength=120 topWidth=20
```

**A stepped bore adapter** — 34.85 cm³, first attempt. Flange, spigot stacked on it, bored
through:

```
cylinder Flange diameter=60 height=10
cylinder Spigot diameter=30 height=25 at.z=10
cylinder Bore   diameter=18 height=35 operation=cut
```

**A heat sink base** — 87.52 cm³, first attempt. The closed form is
100 × 100 × 8 + π × 20² × 6 = **87.54 cm³**:

```
box      base length=100 width=100 height=8
cylinder boss diameter=40 height=6 at.z=8
```

None of these is in the catalogue. None could have been built before the language existed.

---

## The finding that mattered, and the fix

**On the first run, with a model configured, the refusal discipline collapsed.** The one
request in the set that nothing should build — *"a hydroformed titanium turbine volute with
variable-section runners"* — came back as three components and a closed 300 cm³ solid.

Offline that request is refused by name. The script route can decline too. But the **plan**
route asks a model to decompose an object into components, and a model asked to decompose
complies. Every check downstream passed, because every check downstream reads a description:
the mass was real, the drawing dimensioned it, the manufacturability rules cleared it. That is
the one failure this application cannot afford, and it was measured rather than argued:
`refused 0 of 1`.

**Two changes closed it.**

The study pass now answers a third question. It already said what the object is and whether it
is one part or several; it now also says whether the *shape* can be expressed at all, judged
against the operations the kernel actually has — extrusions, revolutions, lofts, constant
sweeps, primitives, booleans, holes, shells, constant-radius blends, patterns. The criterion is
deliberately about form and not difficulty: a part is declined when its shape cannot be said in
those words, never because it is complicated. An explicit `NO` refuses and names what is
missing; anything else — a hedge, a missing heading, an unparseable reply — lets the request
through, because losing a buildable part to a misread heading is worse than building one that
should have been declined. The second is visible and the first is not.

And the plan route now **looks at what it built**, as the script route already did. A reviewer's
objection is reported rather than acted on: the part is still handed over, with the objection
attached and `satisfied` cleared, so it surfaces as a warning rather than as success. The user
sees both, which is more than either alone.

Measured after the fix, against the same model:

```
refused  refused  4075ms  a hydroformed titanium turbine volute…
         This cannot be built here, and building the nearest thing to it would give you a
         part you did not ask for. The shape requires a sweep with a continuously varying
         section. The shapes available are: extrusions and revolutions of closed profiles;
         lofts between two sections; …

built 100% of buildable requests
refused 1 of 1 unbuildable requests
```

Four seconds, one call, nothing spent trying to build it.

---

## What the numbers do not say

**Twelve of nineteen requests never reached a model.** The catalogue and the composer answered
them in a median of 112 ms, offline, for nothing. That is excellent for a user and it means the
100% headline is mostly a measurement of the deterministic path. The figure worth watching is
the script route's 80% first attempt over five cases — five is a small number, and it is the
number that should grow.

**The same prompt does not give the same answer twice.** *"A heat sink base 100 × 100 × 8 mm
with a 40 mm raised boss"* was classified ONE-PART on one run and written as a two-feature
script measuring 87.52 cm³ against a closed form of 87.54; on another it was classified
ASSEMBLY, went to the plan route, dropped a component and measured 77.99 cm³. Nothing is wrong
with either path. A model is not reproducible, which is the whole reason the gate that runs on
every commit is the deterministic one.

**One model, one run.** Gemini's free tier throttled too hard to complete a run
(`gemini-3.6-flash`, 63 s waits then failures), and the DeepSeek key returned 402. Both are in
`ui/src/eval/model.ts` and will run against a paid key without changes.

**The reviewer never saw anything.** `gpt-oss-120b` is a text model behind an endpoint that
accepts images, so every visual review returned `unsure` — which is treated as no opinion, not
as approval. The loop is tested (`ui/src/ai/review.test.ts`) and has not yet been measured
against a model that can see.

---

## One defect this run found

The headless CLI never called `initManifold()`, so every part it built went through the BSP
fallback rather than the Manifold engine the application and the test suite both use. The
fallback cannot resolve two cuts that touch along a wall, so a pillow block with a bore and two
foot holes came back open, and a first draft of this document reported that as a kernel
limitation. It was not. With Manifold loaded the same part closes at 153.57 cm³ against a
hand-computed 153.4, in 60 ms and 328 triangles instead of 228 ms and 2,310.

The measurements above were taken after the fix. `datum run` now says so in its output when the
fallback is in use, so a number can never again be quoted without knowing which engine produced
it.

A second defect, in the composer: *"two M8 feet holes"* read the 8 of **M8** as a free number
and the following word **feet** as the imperial unit, giving a ⌀2438.4 mm hole in an 80 mm
block. A digit welded to a letter is part of a designation, and "feet" is a unit only where a
unit can stand.

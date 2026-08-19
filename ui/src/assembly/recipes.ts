/**
 * Built-in assembly recipes.
 *
 * These decompose a named object into the parts it is actually made of, without needing a
 * language model. Two reasons that matters.
 *
 * They work offline and instantly, which is the whole promise of the deterministic core. And
 * they are *checkable*: the dimensions below come from real hardware and are commented with
 * where they come from, so a reviewer can disagree with a number rather than having to
 * disagree with a black box. A model asked to invent a phone's battery thickness will give a
 * plausible figure every time and a different one each time; 3.9 mm is what a 5000 mAh pouch
 * cell actually measures.
 *
 * A model's role is the requests these do not cover. When one is configured it emits the
 * same `AssemblyPlan` structure, so the builder cannot tell which produced it.
 */

import { IDENTITY_PLACEMENT, type AssemblyPlan, type ComponentSpec } from './plan';

// ── helpers ──────────────────────────────────────────────────────────────────

let seq = 0;

/**
 * Gives a primitive component a proportionate edge break, unless it names its own.
 *
 * Applied here rather than at seventy-odd call sites, because it is not a decision anyone
 * makes per part: real components have broken edges, and a recipe that had to remember to say
 * so for each one would forget. A twentieth of the smallest dimension is a radius that reads
 * at the scale of the part it is on — half a millimetre on a phone bezel, two hundred on a
 * fuselage — which a single fixed number cannot do across four orders of magnitude.
 *
 * Boxes only, and that is a cost decision rather than a taste one. A knife-edged prism is the
 * thing that reads as a block; a cylinder already reads as turned, and its rim contributes far
 * less. Blending the cylinders as well took the airliner from 1.5 to 4.7 seconds and from 21
 * to 60 thousand triangles — three seconds and forty thousand triangles for the rims of a
 * fuselage and two nacelles. Any component that genuinely needs a broken rim can still ask for
 * one by naming `round` itself, which this leaves alone.
 *
 * `broken` in the evaluator drops any radius the solid cannot actually take, so this is a
 * request rather than an instruction and no component can be spoiled by it.
 */
function withEdgeBreak(
  shape: string, params: Record<string, string | number>,
): Record<string, string | number> {
  if (shape !== 'box') return params;
  if (params.round !== undefined) return params;

  const sizes = ['length', 'width', 'height', 'diameter']
    .map((k) => params[k])
    .filter((v): v is number => typeof v === 'number' && v > 0);
  if (sizes.length === 0) return params;

  const round = Math.min(...sizes) * 0.05;
  return { ...params, round: Number(round.toFixed(3)) };
}

function part(
  name: string, role: string, shape: string,
  // Not `Record<string, number>`: a loft names the shape of each of its ends, and a sweep
  // names its path.
  params: Record<string, string | number>,
  at: Partial<typeof IDENTITY_PLACEMENT>,
  material: string, density: number,
  extra: { quantity?: number; operation?: 'add' | 'cut'; note?: string } = {},
): ComponentSpec {
  return {
    id: `p${++seq}`,
    name, role, shape, params: withEdgeBreak(shape, params),
    placement: { ...IDENTITY_PLACEMENT, ...at },
    material, density,
    quantity: extra.quantity ?? 1,
    operation: extra.operation ?? 'add',
    note: extra.note,
  };
}

// Densities in g/cm³, for the per-component mass in the BOM.
const D = {
  aluminium: 2.70,
  steel: 7.85,
  stainless: 8.00,
  glass: 2.50,
  abs: 1.05,
  polycarbonate: 1.20,
  liIon: 2.60,      // pouch cell, averaged over its stack
  fr4: 1.85,        // populated PCB, averaged
  copper: 8.96,
  rubber: 1.20,
  ceramic: 2.40,

  // Effective densities, for parts modelled as a solid where the real thing is a shell.
  //
  // A massing model wants the part's *envelope* — that is what you check for clearance and
  // what reads correctly in the viewport — but a solid envelope at the material's own density
  // weighs several times what the part does. Spreading the real mass over the modelled volume
  // keeps both right, and every one of these carries a note saying it was done.
  //
  // This is the same trick the battery and display panels above already use, made explicit.
  wheelAssembly: 0.81,   // 700c rim, spokes, hub and tyre: 1.9 kg over the modelled solid
  saddleAssembly: 0.17,  // shell, rails and foam: 250 g over its bounding block
  lidShell: 0.85,        // a 1.5 mm aluminium lid shell: 350 g over its solid envelope

  // An airframe is almost entirely air. A fuselage drawn as a solid cylinder is 460 m³, and
  // at aluminium's own density that is 1 240 tonnes for an aircraft that weighs 42. These
  // spread the real empty mass of each structure over the envelope it occupies.
  // Each is the real empty mass of that structure divided by the envelope it is drawn as.
  // Together they put the airliner at about 39 tonnes against a published operating empty
  // weight of 42.6 — close enough that the number is worth quoting, and honest about being a
  // massing model rather than a weights breakdown.
  airframeShell: 0.0434,   // fuselage: skin, frames, floor, systems, interior — 20 t
  wingStructure: 0.0697,   // wing box, skin and ribs — 4.5 t a side, dry
  tailStructure: 0.0436,   // stabilisers — 350 kg each
  finStructure: 0.0710,    // fin — 700 kg
  tailConeShell: 0.0576,   // aft fairing and APU — 600 kg
  radomeShell: 0.0024,     // a composite dome is 60 kg over 25 m³ of enclosed air
  nacelleAndEngine: 0.1706, // 2.6 t a side: the engine core is the dense part
  pylonStructure: 0.119,   // 250 kg each
  wingletShell: 0.0586,    // 90 kg each
  gearLeg: 2.80,           // oleo strut, drawn as a plain cylinder
  gearWheel: 0.588         // wheel, tyre and brake pack over the swept disc
} as const;

// ── phone ────────────────────────────────────────────────────────────────────

/**
 * A smartphone, decomposed.
 *
 * Dimensions are those of a current 6.7-inch flagship, which is the shape most people mean
 * by "a phone": 163 x 78 x 8.3 mm. Every component below is sized against that envelope and
 * against what the real part measures, not scaled arbitrarily from the outside.
 */
export function phoneRecipe(scale = 1): AssemblyPlan {
  const L = 163 * scale;
  const W = 78 * scale;
  const T = 8.3 * scale;

  const wall = 1.2 * scale;
  const glassT = 0.8 * scale;

  return {
    name: 'Phone',
    description: 'A 6.7-inch smartphone, decomposed into its major components.',
    // Height is over the camera island, not the body. Quoting body thickness alone reads
    // better in marketing and is wrong for packaging, clearance and the drawing.
    envelope: { length: L, width: W, height: T + 2.4 * scale },
    source: 'recipe',
    components: [
      part('Mid-frame', 'Structural chassis everything mounts to', 'box',
        { length: L, width: W, height: T },
        { z: 0 }, 'Aluminium 7075', D.aluminium,
        { note: 'The load path. A phone is stiff because of this, not the covers.' }),

      // One cut to the chassis, immediately after it, so it hollows the chassis alone rather
      // than boring through the battery and the board.
      part('Frame cavity', 'Hollows the chassis so parts fit inside', 'box',
        { length: L - wall * 2, width: W - wall * 2, height: T - wall * 2 },
        { z: 0 }, '—', D.aluminium,
        { operation: 'cut', note: `${wall} mm wall, typical for a milled aluminium mid-frame.` }),

      // The connector, the SIM tray and the speaker opening are placed as *parts*, not cut as
      // holes.
      //
      // That is deliberate and it is the more honest model for a package study: a USB-C
      // receptacle is a component with a mass, a material and a supplier, and it belongs in
      // the bill of materials as one. It is also what the engine can do reliably — a second
      // cut through an already-cut thin wall leaves slivers the boolean cannot resolve, and
      // the solid comes out open. Where the *hole* is what matters, it belongs in a detailed
      // model of the chassis alone.
      // Every one of these cuts starts outside the chassis and finishes inside the cavity.
      //
      // A cut that stops within the wall leaves a blind pocket bounded by a sliver of
      // material thinner than the tolerances the boolean works to, and the result is an open
      // solid. Passing fully through is both what the real feature does and what the engine
      // can resolve.
      part('USB-C port', 'Charge and data connector', 'box',
        { length: 9 * scale, width: 3.2 * scale, height: 3.2 * scale },
        { x: -L / 2 + 2 * scale, z: 0 }, 'Stainless and polymer', D.stainless,
        { note: 'USB-C receptacle is 8.94 x 2.56 mm; cut with clearance.' }),

      // One slot rather than the six 1.2 mm ports a real grille has.
      //
      // Not laziness: a 1.2 mm feature cut through a 163 mm chassis is a 135:1 ratio, and six
      // of them in succession fragment the mesh until the boolean engine runs out of memory.
      // The ports also tell a package study nothing the slot does not. Where the distinction
      // matters — a moulding tool, a cosmetic render — it belongs in a detailed model, and
      // the notes say so.
      part('Speaker slot', 'Bottom-firing speaker opening', 'box',
        { length: 8 * scale, width: 14 * scale, height: 2 * scale },
        { x: -L / 2 + 1 * scale, y: 14 * scale, z: 0 }, '—', D.aluminium,
        { note: 'Stands in for six 1.2 mm ports across the same span.' }),

      part('SIM tray', 'Removable card carrier', 'box',
        { length: 14 * scale, width: 6 * scale, height: 6 * scale },
        { x: -40 * scale, y: -W / 2 + 1 * scale, z: 0 }, 'Stainless and polymer', D.stainless,
        { note: 'Cut through the side wall into the cavity, as the real tray is.' }),


      part('Display glass', 'Cover glass over the panel', 'box',
        { length: L - 2 * scale, width: W - 2 * scale, height: glassT },
        { z: T / 2 - glassT / 2 }, 'Chemically strengthened glass', D.glass,
        { note: '0.8 mm is standard cover glass; thinner cracks, thicker hurts touch sensitivity.' }),

      part('Display panel', 'OLED stack behind the glass', 'box',
        { length: L - 6 * scale, width: W - 6 * scale, height: 1.4 * scale },
        { z: T / 2 - glassT - 0.7 * scale }, 'OLED assembly', 1.4,
        { note: 'Panel plus digitiser and adhesive.' }),

      part('Battery', 'Li-ion pouch cell', 'box',
        { length: 95 * scale, width: 62 * scale, height: 3.9 * scale },
        { x: -8 * scale, z: -T / 2 + wall + 1.95 * scale }, 'Li-ion pouch', D.liIon,
        { note: '~5000 mAh at this footprint. Thickness drives the phone’s.' }),

      part('Mainboard', 'SoC, memory and modem', 'box',
        { length: 42 * scale, width: 62 * scale, height: 2.2 * scale },
        { x: 52 * scale, z: -T / 2 + wall + 1.1 * scale }, 'FR-4, populated', D.fr4,
        { note: 'Stacked board above the battery, at the top of the phone.' }),

      part('Camera island', 'Raised housing for the rear cameras', 'box',
        { length: 38 * scale, width: 34 * scale, height: 2.4 * scale },
        { x: 52 * scale, y: -18 * scale, z: -T / 2 - 1.2 * scale }, 'Aluminium 7075', D.aluminium,
        { note: 'The bump. It exists because the lens stack is taller than the phone.' }),

      // The lens sits *in* the island, not proud of it. Centred on the island's own face it
      // stood 1.2 mm beyond the bump it is supposed to be recessed into, which made the phone
      // measure 14 mm over a camera that on real hardware finishes flush with its housing.
      part('Camera lens', 'Rear camera module', 'cylinder',
        { diameter: 14 * scale, height: 3.6 * scale },
        { x: 60 * scale, y: -26 * scale, z: -T / 2 - 0.35 * scale }, 'Glass and sapphire', D.glass,
        { quantity: 3, note: 'Wide, ultra-wide and telephoto. Recessed 0.25 mm into the island.' }),

      part('Back cover', 'Rear glass', 'box',
        { length: L - 1 * scale, width: W - 1 * scale, height: glassT },
        { z: -T / 2 + glassT / 2 }, 'Chemically strengthened glass', D.glass),

      part('Side button', 'Power and volume', 'box',
        { length: 12 * scale, width: 1.6 * scale, height: 3.4 * scale },
        { x: 30 * scale, y: W / 2 - 0.4 * scale, z: 0 }, 'Aluminium 7075', D.aluminium,
        { quantity: 2, note: 'Power on one side, volume rocker above it.' }),

    ],
    notes: [
      'Sized as a 6.7-inch flagship: 163 x 78 x 8.3 mm.',
      'Solid blocks standing in for the real internals. The battery is a cell-shaped volume, ' +
      'not a cell; the mainboard is a board-shaped volume, not a circuit.',
      'This is a package and clearance study — it tells you whether the parts fit and what it ' +
      'weighs. It is not a manufacturable design.',
      'The port, tray and speaker opening are modelled as the parts that fill them rather ' +
      'than as holes cut in the chassis. For a package study and a bill of materials that is ' +
      'the more useful representation; if you need the openings themselves, model the ' +
      'chassis on its own and cut them there.',
    ],
  };
}

// ── laptop ───────────────────────────────────────────────────────────────────

export function laptopRecipe(scale = 1): AssemblyPlan {
  const L = 312 * scale;
  const W = 221 * scale;
  const baseT = 11 * scale;
  const lidT = 6 * scale;

  return {
    name: 'Laptop',
    description: 'A 13-inch laptop, base and lid.',
    envelope: { length: L, width: W + 15 * scale, height: baseT + lidT },
    source: 'recipe',
    components: [
      part('Base chassis', 'Lower housing', 'box', { length: L, width: W, height: baseT },
        {}, 'Aluminium 6063', D.aluminium),
      part('Base cavity', 'Hollows the base', 'box',
        { length: L - 3 * scale, width: W - 3 * scale, height: baseT - 3 * scale },
        {}, '—', D.aluminium, { operation: 'cut' }),
      part('Battery', 'Li-ion pack', 'box', { length: 250 * scale, width: 90 * scale, height: 6 * scale },
        { y: -50 * scale, z: -baseT / 2 + 4.5 * scale }, 'Li-ion', D.liIon,
        { note: '~58 Wh at this footprint.' }),
      part('Mainboard', 'Logic board', 'box', { length: 200 * scale, width: 70 * scale, height: 3 * scale },
        { y: 60 * scale, z: -baseT / 2 + 3 * scale }, 'FR-4, populated', D.fr4),
      part('Keyboard', 'Key deck', 'box', { length: 280 * scale, width: 110 * scale, height: 2 * scale },
        { y: -30 * scale, z: baseT / 2 - 1 * scale }, 'Polycarbonate', D.polycarbonate),
      part('Trackpad', 'Glass touch surface', 'box',
        { length: 130 * scale, width: 80 * scale, height: 1.2 * scale },
        { y: -85 * scale, z: baseT / 2 - 0.6 * scale }, 'Glass', D.glass),
      // Directly above the base, not behind it. A y offset of half the width put the lid
      // alongside the base rather than on top, making the closed laptop 346 mm deep — half
      // as deep again as it declares itself to be.
      part('Lid', 'Display housing', 'box', { length: L, width: W, height: lidT },
        { z: baseT / 2 + lidT / 2 }, 'Aluminium shell and hinge assembly', D.lidShell,
        { note: 'Modelled closed and solid, at an effective density — a real lid is a 1.5 mm shell. A hinge angle would need a mate, not a placement.' }),
      part('Display panel', 'IPS panel', 'box',
        { length: L - 10 * scale, width: W - 12 * scale, height: 2 * scale },
        { z: baseT / 2 + 1.5 * scale }, 'LCD assembly', 1.5),
    ],
    notes: [
      'Modelled with the lid closed; opening it is a hinge mate, which this kernel does not yet solve.',
      'Internals are volumes, not working parts.',
    ],
  };
}

// ── electric motor ───────────────────────────────────────────────────────────

export function motorRecipe(scale = 1): AssemblyPlan {
  const bodyD = 80 * scale;
  const bodyL = 120 * scale;
  const shaftD = 19 * scale;

  return {
    name: 'Electric motor',
    description: 'A NEMA-style brushed DC motor with mounting flange.',
    // Over the flange and terminal box, which both stand proud of the body diameter. The
    // body alone was quoted here, and a motor that does not fit its own stated envelope is
    // a drawing error waiting to happen.
    envelope: { length: bodyD + 42 * scale, width: bodyD + 20 * scale, height: bodyL + 95 * scale },
    source: 'recipe',
    components: [
      part('Housing', 'Stator can', 'cylinder', { diameter: bodyD, height: bodyL },
        {}, 'Steel', D.steel),
      part('Front flange', 'Mounting face', 'flange',
        {
          outerDia: bodyD + 20 * scale, boreDia: shaftD + 6 * scale, thickness: 8 * scale,
          boltCircle: bodyD + 4 * scale, boltDia: 6.5 * scale, boltCount: 4,
          hubDia: 0, hubHeight: 0,
        },
        { z: bodyL / 2 + 4 * scale }, 'Aluminium', D.aluminium,
        { note: 'Four M6 on a bolt circle just inside the housing diameter.' }),
      part('Output shaft', 'Drive shaft', 'shaft',
        {
          diameter: shaftD, length: 60 * scale, stepDia: 0, stepLength: 0,
          chamfer: 1 * scale, keywayWidth: 6 * scale, keywayDepth: 3.5 * scale,
          keywayLength: 30 * scale,
        },
        { z: bodyL / 2 + 30 * scale }, 'Steel 1045', D.steel,
        { note: '19 mm with a 6 mm keyway, standard for this frame size.' }),
      part('Rear bearing cap', 'Closes the can', 'cylinder',
        { diameter: bodyD, height: 10 * scale },
        { z: -bodyL / 2 - 5 * scale }, 'Aluminium', D.aluminium),
      part('Rotor', 'Armature', 'cylinder', { diameter: bodyD - 12 * scale, height: bodyL - 20 * scale },
        {}, 'Laminated steel and copper', 6.5,
        { note: 'A volume, not a winding. Mass is representative, torque is not.' }),
      part('Terminal box', 'Electrical connection', 'box',
        { length: 40 * scale, width: 30 * scale, height: 25 * scale },
        { x: bodyD / 2 + 12 * scale }, 'Aluminium', D.aluminium),
    ],
    notes: ['The rotor is a solid volume; this models mass and package, not electromagnetics.'],
  };
}

// ── gearbox ──────────────────────────────────────────────────────────────────

export function gearboxRecipe(scale = 1): AssemblyPlan {
  const module = 2 * scale;
  const inputTeeth = 18;
  const outputTeeth = 54;
  const centres = (module * (inputTeeth + outputTeeth)) / 2;

  return {
    name: 'Gearbox',
    description: `A single-stage 3:1 spur reduction, ${inputTeeth}:${outputTeeth} teeth.`,
    source: 'recipe',
    components: [
      part('Case', 'Housing', 'box',
        { length: centres + 90 * scale, width: 90 * scale, height: 70 * scale },
        {}, 'Cast aluminium', D.aluminium),
      part('Case cavity', 'Hollows the housing', 'box',
        { length: centres + 70 * scale, width: 70 * scale, height: 50 * scale },
        {}, '—', D.aluminium, { operation: 'cut' }),
      part('Input pinion', 'Driving gear', 'gear',
        { module, teeth: inputTeeth, faceWidth: 16 * scale, pressureAngle: 20, boreDia: 12 * scale, hubDia: 0, hubWidth: 0 },
        { x: -centres / 2, rx: 90 }, 'Steel 20MnCr5, case hardened', D.steel,
        { note: `Pitch diameter ${(module * inputTeeth).toFixed(1)} mm.` }),
      part('Output gear', 'Driven gear', 'gear',
        { module, teeth: outputTeeth, faceWidth: 16 * scale, pressureAngle: 20, boreDia: 20 * scale, hubDia: 0, hubWidth: 0 },
        { x: centres / 2, rx: 90 }, 'Steel 20MnCr5, case hardened', D.steel,
        { note: `Pitch diameter ${(module * outputTeeth).toFixed(1)} mm. Centres at ${centres.toFixed(1)} mm.` }),
      part('Input shaft', 'Drive in', 'shaft',
        { diameter: 12 * scale, length: 110 * scale, stepDia: 0, stepLength: 0, chamfer: 1, keywayWidth: 4 * scale, keywayDepth: 2.5 * scale, keywayLength: 25 * scale },
        { x: -centres / 2, rx: 90 }, 'Steel 1045', D.steel),
      part('Output shaft', 'Drive out', 'shaft',
        { diameter: 20 * scale, length: 110 * scale, stepDia: 0, stepLength: 0, chamfer: 1, keywayWidth: 6 * scale, keywayDepth: 3.5 * scale, keywayLength: 30 * scale },
        { x: centres / 2, rx: 90 }, 'Steel 1045', D.steel),
      part('Bearing', 'Shaft support', 'washer',
        { outerDia: 32 * scale, boreDia: 12 * scale, thickness: 10 * scale },
        { x: -centres / 2, y: 40 * scale, rx: 90 }, 'Bearing steel', D.steel,
        { quantity: 2, note: 'Stands in for a 6001 deep-groove ball bearing.' }),
    ],
    notes: [
      `Ratio ${outputTeeth}/${inputTeeth} = ${(outputTeeth / inputTeeth).toFixed(2)}:1.`,
      'The gears are true involute profiles and will mesh; the bearings are placeholders.',
    ],
  };
}

// ── bicycle ──────────────────────────────────────────────────────────────────

export function bicycleRecipe(scale = 1): AssemblyPlan {
  const wheelD = 700 * scale;
  const wheelbase = 1025 * scale;

  return {
    name: 'Bicycle',
    description: 'A road bicycle: frame tubes, wheels and drivetrain.',
    envelope: { length: 1750 * scale, width: 440 * scale, height: 1060 * scale },
    source: 'recipe',
    components: [
      // No rotation on the wheels. The archetype builds them with the axle already along Y,
      // which is how a bicycle wheel stands; an rx of 90 laid both of them flat, and the
      // result was a valid closed solid that simply was not a bicycle.
      part('Front wheel', 'Rolling', 'wheel',
        { diameter: wheelD, width: 25 * scale, rimDiameter: 622 * scale, boreDiameter: 20 * scale, spokes: 24, spokeWidth: 3 * scale },
        { x: wheelbase / 2, z: wheelD / 2 }, 'Aluminium and rubber', D.wheelAssembly,
        { note: 'Effective density: a box-section rim is modelled solid, so 0.81 g/cm³ over that solid gives the 1.9 kg a real 700c wheel and tyre weigh.' }),
      part('Rear wheel', 'Driven', 'wheel',
        { diameter: wheelD, width: 25 * scale, rimDiameter: 622 * scale, boreDiameter: 20 * scale, spokes: 24, spokeWidth: 3 * scale },
        { x: -wheelbase / 2, z: wheelD / 2 }, 'Aluminium and rubber', D.wheelAssembly,
        { note: 'Same as the front; a real rear wheel is slightly heavier for the freehub.' }),
      part('Down tube', 'Main frame member', 'pipe',
        { outerDia: 38 * scale, wall: 1.4 * scale, length: 640 * scale, bendRadius: 0, bendAngle: 0 },
        { x: 40 * scale, z: 480 * scale, ry: 62 }, 'Aluminium 6061-T6', D.aluminium),
      part('Top tube', 'Upper frame member', 'pipe',
        { outerDia: 32 * scale, wall: 1.2 * scale, length: 545 * scale, bendRadius: 0, bendAngle: 0 },
        { x: 30 * scale, z: 790 * scale, ry: 83 }, 'Aluminium 6061-T6', D.aluminium),
      part('Seat tube', 'Carries the saddle', 'pipe',
        { outerDia: 34 * scale, wall: 1.4 * scale, length: 500 * scale, bendRadius: 0, bendAngle: 0 },
        { x: -230 * scale, z: 570 * scale, ry: 17 }, 'Aluminium 6061-T6', D.aluminium),
      part('Chain stay', 'Rear triangle, lower', 'pipe',
        { outerDia: 22 * scale, wall: 1.2 * scale, length: 420 * scale, bendRadius: 0, bendAngle: 0 },
        { x: -320 * scale, y: 45 * scale, z: 300 * scale, ry: 88 }, 'Aluminium 6061-T6', D.aluminium,
        { quantity: 2 }),
      part('Fork', 'Front steering', 'pipe',
        { outerDia: 28 * scale, wall: 1.6 * scale, length: 400 * scale, bendRadius: 0, bendAngle: 0 },
        { x: 480 * scale, y: 45 * scale, z: 530 * scale, ry: 16 }, 'Carbon composite', 1.6,
        { quantity: 2 }),
      part('Chainring', 'Front sprocket', 'gear',
        { module: 3.2 * scale, teeth: 50, faceWidth: 2 * scale, pressureAngle: 20, boreDia: 30 * scale, hubDia: 0, hubWidth: 0 },
        { x: -170 * scale, y: 40 * scale, z: 280 * scale, rx: 90 }, 'Aluminium 7075', D.aluminium,
        { note: '50 tooth, a standard road outer ring.' }),
      part('Cassette sprocket', 'Rear sprocket', 'gear',
        { module: 3.2 * scale, teeth: 16, faceWidth: 2 * scale, pressureAngle: 20, boreDia: 25 * scale, hubDia: 0, hubWidth: 0 },
        { x: -wheelbase / 2, y: 12 * scale, z: wheelD / 2, rx: 90 }, 'Steel', D.steel,
        { note: 'Sits against the wheel; a real freehub carries it on splines.' }),
      part('Seatpost', 'Carries the saddle and sets its height', 'pipe',
        { outerDia: 27.2 * scale, wall: 2 * scale, length: 260 * scale, bendRadius: 0, bendAngle: 0 },
        { x: -300 * scale, z: 790 * scale, ry: 16 }, 'Aluminium 6061-T6', D.aluminium,
        { note: '27.2 mm is the classic road post diameter — thin enough to flex a little.' }),

      part('Stem', 'Joins the bars to the steerer', 'pipe',
        { outerDia: 31.8 * scale, wall: 2.5 * scale, length: 100 * scale, bendRadius: 0, bendAngle: 0 },
        { x: 440 * scale, z: 940 * scale, ry: 82 }, 'Aluminium 6061-T6', D.aluminium),

      part('Saddle', 'Seat', 'box',
        { length: 270 * scale, width: 140 * scale, height: 40 * scale },
        { x: -300 * scale, z: 900 * scale }, 'Composite and foam', D.saddleAssembly,
        { note: 'Effective density. A saddle is a thin shell over rails and mostly air; the block is its envelope, and 0.17 g/cm³ over it gives the 250 g one weighs.' }),
      part('Handlebar', 'Steering', 'pipe',
        { outerDia: 31.8 * scale, wall: 2 * scale, length: 420 * scale, bendRadius: 0, bendAngle: 0 },
        { x: 480 * scale, z: 950 * scale, rx: 90 }, 'Aluminium 6061-T6', D.aluminium),
    ],
    notes: [
      'Frame geometry is representative of a 56 cm road frame.',
      'Tubes are placed, not mitred and welded; the joints are approximate.',
      'No hubs, cranks, pedals, chain or brakes. The mass is therefore of what is drawn — ' +
      'frame, wheels, bars, saddle, post, stem and chainring — not of a complete bicycle.',
      `Gearing: 50/16 at a ${wheelD} mm wheel gives about ` +
      `${((50 / 16) * Math.PI * wheelD / 1000).toFixed(2)} m per crank revolution.`,
    ],
  };
}


// ── aeroplane ────────────────────────────────────────────────────────────────

/**
 * A narrow-body airliner, decomposed.
 *
 * Proportions are those of an A320-family aircraft, which is what most people picture: 37.6 m
 * long, 35.8 m span, a 3.95 m fuselage. Modelled at full size in millimetres like everything
 * else, so the numbers in the tree are the numbers on the type certificate.
 *
 * Wings and stabilisers are lofted from root section to tip section, so the taper and the
 * sweep are the geometry rather than a note apologising for a box. What is still not modelled
 * is camber: the sections are rectangles, not aerofoils, because for a package study the
 * planform and the volume it encloses are what matter. The notes say so.
 */
export function aeroplaneRecipe(scale = 1): AssemblyPlan {
  const L = 37570 * scale;        // overall length
  const fuseD = 3950 * scale;     // fuselage diameter
  const span = 35800 * scale;
  const sweepDeg = 25;

  // Wing panel width, solved so the swept wing reaches the real span.
  //
  // Rotating a box about its own centre widens the box it occupies: a panel of width w and
  // chord c swept by θ reaches (w·cosθ + c·sinθ)/2 either side of its centre. Setting the
  // panel width to the bare half-span instead put the tips a metre past the type
  // certificate's 35.8 m, which the inspection caught immediately.
  const sweep = (sweepDeg * Math.PI) / 180;
  const chord = 6000 * scale;

  // A lofted panel runs straight out along the span and carries its sweep as an offset of the
  // tip section, so the half-span is simply the half-span. The old box was rotated about its
  // own centre, which widens the box it occupies, and the width had to be solved backwards
  // from the certificated span to compensate.
  const halfSpan = (span - fuseD) / 2;

  const wingRoot = chord;
  const wingTip = 1600 * scale;
  const wingT = 700 * scale;
  // Thickness tapers with chord, which is what holds the thickness-to-chord ratio constant
  // along the span — the thing a wing is actually designed to do.
  const wingTipT = (wingT * wingTip) / wingRoot;
  const wingSweepBack = halfSpan * Math.tan(sweep);
  const dihedral = halfSpan * Math.tan((5 * Math.PI) / 180);

  const finH = 5870 * scale;
  const tailX = -L / 2 + 3500 * scale;

  return {
    name: 'Airliner',
    description: 'A narrow-body twin-jet airliner, decomposed into its major structures.',
    envelope: { length: L, width: span, height: 11760 * scale },
    source: 'recipe',
    components: [
      part('Fuselage', 'Pressure vessel carrying payload and crew', 'cylinder',
        { diameter: fuseD, height: L },
        { ry: 90, z: 0 }, 'Airframe structure and interior', D.airframeShell,
        { note: '3.95 m outside diameter — the width that sets six-abreast seating. Drawn ' +
                'solid at an effective density; a fuselage is a 3 mm shell, not a billet.' }),

      part('Nose radome', 'Weather radar cover', 'sphere',
        { diameter: fuseD * 0.92 },
        { x: L / 2, z: 0 }, 'Composite radome', D.radomeShell,
        { note: 'Non-metallic so the radar can see through it.' }),

      part('Tail cone', 'Aft fairing and APU housing', 'cylinder',
        { diameter: fuseD * 0.45, height: 4200 * scale },
        { x: -L / 2 - 1600 * scale, ry: 90, z: 620 * scale }, 'Aft fairing and APU', D.tailConeShell),

      /*
       * Wings, one per side, lofted root to tip.
       *
       * On the XZ plane the loft grows along -Y, so the panel is built outboard from the
       * fuselage side and the mirrored instance gives the other wing. Sweep is the tip
       * section's offset along the chord, dihedral its offset in height — both of them
       * geometry the loft carries, rather than a rotation of a constant-section box.
       *
       * The taper is not cosmetic: a 6 m root tapering to a 1.6 m tip holds well under half
       * the volume of the box that used to stand in for it, and that volume is what the fuel
       * capacity and the structural mass are read from.
       */
      part('Wing', 'Lift and fuel tank', 'loft',
        {
          plane: 'XZ', height: halfSpan, subdivisions: 4,
          baseShape: 'rect', baseLength: wingRoot, baseWidth: wingT, baseX: 0, baseY: 0,
          topShape: 'rect', topLength: wingTip, topWidth: wingTipT,
          topX: -wingSweepBack, topY: dihedral,
        },
        { x: 1200 * scale, y: -fuseD / 2, z: -fuseD / 4 },
        'Wing box and fuel', D.wingStructure,
        { quantity: 2, note: 'Swept 25°, tapered 6.0 m root to 1.6 m tip, 5° dihedral. ' +
                             'Also the main fuel tank — about 19 000 litres a side.' }),

      part('Winglet', 'Reduces induced drag at the tip', 'box',
        { length: wingTip, width: 400 * scale, height: 2400 * scale },
        { x: -3000 * scale, y: fuseD / 2 + halfSpan - 200 * scale, z: 900 * scale },
        'Winglet structure', D.wingletShell,
        { quantity: 2 }),

      part('Engine nacelle', 'Turbofan cowling', 'cylinder',
        { diameter: 2100 * scale, height: 4400 * scale },
        { x: 4200 * scale, y: fuseD / 2 + halfSpan * 0.38, z: -fuseD * 0.62, ry: 90 },
        'Nacelle and turbofan', D.nacelleAndEngine,
        { quantity: 2, note: 'A 2.1 m fan is what gives a modern turbofan its bypass ratio.' }),

      part('Pylon', 'Carries the engine under the wing', 'box',
        { length: 3000 * scale, width: 500 * scale, height: 1400 * scale },
        { x: 3400 * scale, y: fuseD / 2 + halfSpan * 0.38, z: -fuseD * 0.42 },
        'Pylon structure', D.pylonStructure,
        { quantity: 2 }),

      part('Horizontal stabiliser', 'Pitch trim and control', 'loft',
        {
          plane: 'XZ', height: 5900 * scale, subdivisions: 3,
          baseShape: 'rect', baseLength: 3400 * scale, baseWidth: 400 * scale,
          topShape: 'rect', topLength: 1300 * scale, topWidth: 160 * scale,
          topX: -2900 * scale, topY: 0,
        },
        { x: tailX, y: -fuseD / 2, z: 500 * scale },
        'Stabiliser structure', D.tailStructure,
        { quantity: 2 }),

      // The fin lofts upward, so it is built on XY and tapers root to tip like the wing.
      part('Vertical fin', 'Yaw stability', 'loft',
        {
          plane: 'XY', height: finH, subdivisions: 3,
          baseShape: 'rect', baseLength: 4800 * scale, baseWidth: 350 * scale,
          topShape: 'rect', topLength: 2200 * scale, topWidth: 180 * scale,
          topX: -1900 * scale, topY: 0,
        },
        { x: tailX - 600 * scale, z: fuseD / 2 - 300 * scale },
        'Fin structure', D.finStructure,
        { note: 'Fin height sets the 11.76 m overall height, not the fuselage.' }),

      // Each wheel gets its leg. Without one the wheels hung in the air below the fuselage
      // touching nothing, which is exactly what the geometry inspection reported.
      part('Main gear leg', 'Oleo strut', 'cylinder',
        { diameter: 320 * scale, height: 2000 * scale },
        { x: 600 * scale, y: fuseD / 2 - 800 * scale, z: -fuseD / 2 - 900 * scale },
        'Oleo strut', D.gearLeg,
        { quantity: 2 }),

      part('Main gear wheel', 'Takes the landing load', 'cylinder',
        { diameter: 1150 * scale, height: 900 * scale },
        { x: 600 * scale, y: fuseD / 2 - 800 * scale, z: -fuseD / 2 - 1700 * scale, rx: 90 },
        'Wheel, tyre and brake', D.gearWheel,
        { quantity: 2, note: 'Shown down. Retracted geometry would need a mate, not a placement.' }),

      part('Nose gear leg', 'Steering strut', 'cylinder',
        { diameter: 220 * scale, height: 1700 * scale },
        { x: L / 2 - 6000 * scale, z: -fuseD / 2 - 750 * scale },
        'Oleo strut', D.gearLeg),

      part('Nose gear wheel', 'Steering', 'cylinder',
        { diameter: 780 * scale, height: 600 * scale },
        { x: L / 2 - 6000 * scale, z: -fuseD / 2 - 1450 * scale, rx: 90 },
        'Wheel, tyre and brake', D.gearWheel),
    ],
    notes: [
      'Proportions are those of an A320-family narrow-body: 37.6 m long, 35.8 m span.',
      'Wings and stabilisers are swept tapered boxes, not aerofoil sections. The planform ' +
      'and enclosed volume are right; the camber is not modelled.',
      'No control surfaces, doors, windows or interior. This is an external massing model.',
      'Landing gear is shown extended and simplified to a single wheel and leg per station; a\n      real main gear is a four-wheel bogie.',
    ],
  };
}

// ── chair ────────────────────────────────────────────────────────────────────

/**
 * A four-legged chair.
 *
 * Seat at 450 mm and back at 850 mm are the anthropometric standards — the height a person's
 * knee sits at, and the height that supports a shoulder blade. Getting those two right is what
 * makes a chair read as a chair rather than as furniture-shaped boxes.
 */
export function chairRecipe(scale = 1): AssemblyPlan {
  const seatH = 450 * scale;
  const seatW = 450 * scale;
  const seatD = 430 * scale;
  const backH = 850 * scale;
  const leg = 38 * scale;
  const seatT = 30 * scale;

  const dx = seatD / 2 - leg / 2 - 20 * scale;
  const dy = seatW / 2 - leg / 2 - 20 * scale;

  return {
    name: 'Chair',
    description: 'A four-legged dining chair with a slatted back.',
    envelope: { length: seatD, width: seatW, height: backH },
    source: 'recipe',
    components: [
      part('Seat', 'Load-bearing surface', 'box',
        { length: seatD, width: seatW, height: seatT },
        { z: seatH - seatT / 2 }, 'Beech', 0.72,
        { note: '450 mm seat height is the anthropometric standard for a dining chair.' }),

      part('Front leg', 'Support', 'box',
        { length: leg, width: leg, height: seatH - seatT },
        { x: dx, y: dy, z: (seatH - seatT) / 2 }, 'Beech', 0.72,
        { quantity: 2 }),

      part('Rear leg', 'Support, continues into the back', 'box',
        { length: leg, width: leg, height: backH },
        { x: -dx, y: dy, z: backH / 2 }, 'Beech', 0.72,
        { quantity: 2, note: 'Runs full height, so the back is not a separate joint.' }),

      part('Back rail', 'Ties the rear legs and supports the shoulder', 'box',
        { length: 30 * scale, width: seatW - leg, height: 90 * scale },
        { x: -dx, z: backH - 80 * scale }, 'Beech', 0.72),

      part('Lower back slat', 'Lumbar support', 'box',
        { length: 22 * scale, width: seatW - leg, height: 70 * scale },
        { x: -dx, z: seatH + 190 * scale }, 'Beech', 0.72),

      part('Side stretcher', 'Stops the legs splaying', 'box',
        { length: seatD - leg * 2, width: 25 * scale, height: 25 * scale },
        { y: dy, z: 200 * scale }, 'Beech', 0.72,
        { quantity: 2 }),
    ],
    notes: [
      'Seat 450 mm, back 850 mm — the standard dining-chair anthropometrics.',
      'Joints are butted, not mortised. A real chair lives or dies on its joinery and this ' +
      'model says nothing about it.',
      'No upholstery, and the seat is flat rather than dished.',
    ],
  };
}

// ── rocket ───────────────────────────────────────────────────────────────────

/**
 * A two-stage sounding rocket.
 *
 * A body tube, a nose cone, fins and a nozzle. The fin count and the nose fineness ratio are
 * the two numbers that decide whether a rocket is stable, so both are called out.
 */
export function rocketRecipe(scale = 1): AssemblyPlan {
  const bodyD = 320 * scale;
  const bodyL = 3200 * scale;
  const noseL = 960 * scale;      // 3:1 fineness, the usual subsonic compromise
  const finSpan = 340 * scale;

  return {
    name: 'Rocket',
    description: 'A single-stage sounding rocket with four fins.',
    envelope: { length: bodyD + finSpan * 2, width: bodyD + finSpan * 2, height: bodyL + noseL + 100 * scale },
    source: 'recipe',
    components: [
      part('Body tube', 'Airframe and propellant casing', 'pipe',
        { outerDia: bodyD, wall: 4 * scale, length: bodyL, bendRadius: 0, bendAngle: 0 },
        { z: bodyL / 2 }, 'Aluminium 6061-T6', D.aluminium,
        { note: '4 mm wall — thin-walled tube in compression is the efficient airframe.' }),

      // Every archetype is centred on its own origin, so this is placed by its middle: half
      // the cone's height above the tube's top, less a little so the two overlap rather than
      // meeting on a single plane.
      part('Nose cone', 'Reduces drag and carries the payload', 'funnel',
        { mouthDia: bodyD, spoutDia: 20 * scale, coneHeight: noseL, spoutLength: 40 * scale, wall: 3 * scale },
        { z: bodyL + 380 * scale, rx: 180 }, 'Glass-reinforced composite', 1.9,
        { note: '3:1 fineness ratio, the usual subsonic compromise between drag and volume.' }),

      // Two pairs rather than one set of four. A quantity mirrors across a single axis, which
      // makes two fins facing each other, not the cruciform a rocket actually flies with.
      part('Fin', 'Moves the centre of pressure aft of the centre of mass', 'box',
        { length: 520 * scale, width: 6 * scale, height: finSpan },
        { x: 0, y: bodyD / 2 + finSpan / 2, z: 300 * scale, rx: 90 },
        'Aluminium 6061-T6', D.aluminium,
        { quantity: 2, note: 'Four fins in all. Three is lighter; four is easier to align.' }),

      part('Fin, second pair', 'Completes the cruciform', 'box',
        { length: 6 * scale, width: 520 * scale, height: finSpan },
        { x: bodyD / 2 + finSpan / 2, y: 0, z: 300 * scale, ry: 90 },
        'Aluminium 6061-T6', D.aluminium,
        { quantity: 2 }),

      part('Nozzle', 'Expands the exhaust', 'funnel',
        { mouthDia: bodyD * 0.85, spoutDia: 70 * scale, coneHeight: 300 * scale, spoutLength: 60 * scale, wall: 6 * scale },
        { z: -180 * scale }, 'Graphite and steel', 4.5,
        { note: 'A converging-diverging nozzle would have a throat; this is the bell only.' }),

      part('Payload bay', 'Instruments', 'cylinder',
        { diameter: bodyD - 10 * scale, height: 400 * scale },
        { z: bodyL - 220 * scale }, 'Aluminium 6061-T6', D.aluminium),
    ],
    notes: [
      'Stability needs the centre of pressure behind the centre of mass. That depends on the ' +
      'propellant load, which this model does not carry, so it is not checked here.',
      'The nozzle is a bell only — no throat, no expansion ratio.',
      'No recovery system, igniter or plumbing.',
    ],
  };
}

// ── registry ─────────────────────────────────────────────────────────────────

export interface Recipe {
  id: string;
  label: string;
  aliases: string[];
  build: (scale?: number) => AssemblyPlan;
  /** One line describing what comes out, for the catalogue. */
  summary: string;
}

export const RECIPES: Recipe[] = [
  {
    id: 'phone', label: 'Phone',
    aliases: ['phone', 'smartphone', 'mobile', 'mobile phone', 'iphone', 'android phone', 'handset', 'cell phone', 'cellphone'],
    build: phoneRecipe,
    summary: '13 components: chassis, display stack, battery, board, cameras, buttons, ports.',
  },
  {
    id: 'laptop', label: 'Laptop',
    aliases: ['laptop', 'notebook', 'macbook', 'ultrabook'],
    build: laptopRecipe,
    summary: '8 components: base, lid, battery, board, keyboard, trackpad, panel.',
  },
  {
    id: 'motor', label: 'Electric motor',
    aliases: ['motor', 'electric motor', 'dc motor', 'servo', 'stepper'],
    build: motorRecipe,
    summary: '6 components: housing, flange, shaft with keyway, rotor, terminal box.',
  },
  {
    id: 'gearbox', label: 'Gearbox',
    aliases: ['gearbox', 'gear box', 'reducer', 'reduction gearbox', 'transmission'],
    build: gearboxRecipe,
    summary: '8 components: case, two involute gears, two shafts, bearings. 3:1.',
  },
  {
    id: 'aeroplane', label: 'Airliner',
    aliases: ['aeroplane', 'airplane', 'plane', 'airliner', 'aircraft', 'jet', 'passenger jet'],
    build: aeroplaneRecipe,
    summary: '11 components: fuselage, swept wings, engines, tail and gear, at A320 proportions.',
  },
  {
    id: 'chair', label: 'Chair',
    aliases: ['chair', 'dining chair', 'seat', 'stool'],
    build: chairRecipe,
    summary: '6 components: seat, four legs, back rails and stretchers at standard heights.',
  },
  {
    id: 'rocket', label: 'Rocket',
    aliases: ['rocket', 'missile', 'sounding rocket', 'launch vehicle'],
    build: rocketRecipe,
    summary: '5 components: body tube, nose cone, four fins, nozzle and payload bay.',
  },
  {
    id: 'bicycle', label: 'Bicycle',
    aliases: ['bicycle', 'bike', 'pushbike', 'road bike', 'cycle'],
    build: bicycleRecipe,
    summary: '11 components: frame tubes, two spoked wheels, drivetrain, saddle, bars.',
  },
];

export const recipeById = (id: string): Recipe | undefined => RECIPES.find((r) => r.id === id);

/**
 * Finds a recipe for a request.
 *
 * Longest alias wins, so "mobile phone" beats "phone" if both are ever registered — the more
 * specific match is the one the user meant.
 */
/**
 * Words that turn a category into a particular product.
 *
 * A recipe describes the *kind* of thing — a phone, a chair — built from figures that are
 * typical rather than measured off any one device. That is the right answer to "a phone" and
 * the wrong answer to "iPhone 15 Pro Max", which has published dimensions somebody can look
 * up and check against. Building the generic one and calling it the named one is the more
 * embarrassing failure of the two.
 */
const VARIANT_WORDS = [
  'pro', 'max', 'ultra', 'plus', 'mini', 'lite', 'air', 'se',
  'gen', 'mark', 'mk', 'series', 'model',
];

/**
 * True when the request names a specific product rather than a category.
 *
 * The signal is a model designation left over once the matched alias is removed: a bare
 * number, or one of the variant words above. Numbers carrying a unit are excluded, because
 * "a phone 160 mm long" is a dimensioned category and not a product name.
 */
export function namesSpecificProduct(text: string, recipe: Recipe): boolean {
  let rest = ` ${text.toLowerCase()} `;
  for (const alias of recipe.aliases) rest = rest.split(alias).join(' ');

  // Drop anything that is a measurement: a number followed by a unit.
  rest = rest.replace(/\d+(\.\d+)?\s*(mm|cm|m|in|inch|inches|"|kg|g|deg|°)\b/g, ' ');

  if (/\b\d{2,}\b/.test(rest)) return true;
  return VARIANT_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(rest));
}

export function matchRecipe(text: string): Recipe | null {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;

  let best: Recipe | null = null;
  let bestLength = 0;

  for (const recipe of RECIPES) {
    for (const alias of recipe.aliases) {
      if (!lower.includes(` ${alias} `)) continue;
      if (alias.length > bestLength) { best = recipe; bestLength = alias.length; }
    }
  }
  return best;
}

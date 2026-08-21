/**
 * The benchmark.
 *
 * Every expectation here has to be defensible *without* running the product. That rule is
 * the whole design, and it is the opposite of how a snapshot suite works: recording what the
 * system currently emits and asserting it does not change proves only that the system is
 * consistently wrong, and locks the mistake in as the specification.
 *
 * So an expectation may only be one of two things:
 *
 *   - a **physical invariant** — the solid is closed, its volume is positive, its mass is
 *     within a range the material and size make possible;
 *   - a **published figure** — a dimension somebody outside this project decided, such as an
 *     ISO fastener across-flats or a stated request repeated back ("200 × 120 × 8 plate").
 *
 * Tolerances are generous on purpose. This measures whether the system produces the right
 * *object*, not whether it reproduces a golden mesh — a cup 4 mm taller than last month is
 * not a regression, and a suite that says it is trains people to re-baseline without reading.
 *
 * Cases marked `deterministic` run with no model configured, which is what makes this
 * runnable in CI on every commit: no key, no network, no per-run cost, no variance.
 */

export interface Expectation {
  /** The request must produce geometry at all. */
  builds: boolean;
  /** Watertight: an open solid has no trustworthy volume, mass or manufacturability. */
  closed?: boolean;
  /** Inclusive range of components. Guards the failure where a car comes back as three boxes. */
  components?: [number, number];
  /**
   * Overall size in mm, largest dimension first, as the request or the standard states it.
   * Compared against the sorted bounding box, so orientation is not part of the assertion.
   */
  sizeMm?: [number, number, number];
  /** Fractional tolerance on `sizeMm` and `largestMm`. */
  sizeTol?: number;
  /**
   * The overall largest dimension, mm.
   *
   * For requests that state one dimension and leave the rest to catalogue defaults. Asserting
   * the two unstated axes as well would be asserting this project's own defaults back at
   * itself, which measures nothing.
   */
  largestMm?: number;
  /** Plausible mass range in grams, from the material and the size. */
  massG?: [number, number];
  /** The geometric inspection must find nothing it calls an error. */
  noCritiqueErrors?: boolean;

  /**
   * Volume in mm³, as a range computed by hand from the request.
   *
   * The check that catches an operation being *dropped*. A block asked to be hollow that comes
   * back solid has the right envelope, the right mass for what was built, and the wrong part —
   * and every dimensional assertion above passes. Only the volume moves.
   */
  volumeMm3?: [number, number];

  /**
   * Feature kinds the tree must contain.
   *
   * Volume proves material went missing; this proves it went missing *as the operation that
   * was asked for*, and that the result is still editable rather than a fused lump. A hole the
   * user can reopen and resize is the difference between a CAD model and a mesh.
   */
  featureKinds?: string[];

  /**
   * Strings that must appear in the drawing generated from the solid.
   *
   * A dimension in the drawing is the number the shop cuts to, so it has to be the number the
   * request stated — not the one the model rounded to after a rebuild.
   */
  drawingHas?: string[];

  /**
   * A manufacturability rule that must fire on this part.
   *
   * Asserted the same way as everything else here: the geometry is chosen so that a published
   * limit is unambiguously breached, and the rule that names it must be the one that fires.
   */
  blockerRule?: string;
}

export interface EvalCase {
  id: string;
  prompt: string;
  /** Why these numbers, so a failure can be judged rather than re-baselined. */
  basis: string;
  /** Runs with no model: offline, free, and the same answer every time. */
  deterministic: boolean;
  expect: Expectation;
}

export const CASES: EvalCase[] = [
  // ── single parts, stated dimensions ──
  {
    id: 'plate-stated',
    prompt: '200 x 120 x 8 plate with 9 mm holes',
    basis: 'The request states every dimension. Anything else is the parser failing to read it.',
    deterministic: true,
    expect: {
      builds: true,
      closed: true,
      components: [1, 1],
      sizeMm: [200, 120, 8],
      sizeTol: 0.02,
      noCritiqueErrors: true,
    },
  },
  {
    id: 'plate-imperial',
    prompt: 'a 1/4 inch thick plate 12 inches long',
    basis: 'Imperial fractions are how imperial parts are specified. 1/4" = 6.35 mm, 12" = 304.8 mm.',
    deterministic: true,
    expect: { builds: true, closed: true, sizeMm: [304.8, 120, 6.35], sizeTol: 0.02 },
  },
  {
    id: 'nut-m10',
    prompt: 'M10 hex nut',
    basis: 'ISO 4032: across-flats 17 mm, thickness 8.4 mm. Published, not chosen by this project.',
    deterministic: true,
    expect: {
      builds: true,
      closed: true,
      components: [1, 1],
      sizeMm: [19.6, 17, 8.4],   // across-corners 17 / cos(30) = 19.63
      sizeTol: 0.04,
    },
  },
  {
    id: 'cup',
    prompt: 'make a cup',
    basis:
      'A 350 ml stoneware mug is 80–85 mm across and 90–100 mm tall, and weighs 250–500 g. ' +
      'Anything an order of magnitude out is a units error, which is the failure that matters.',
    deterministic: true,
    expect: { builds: true, closed: true, massG: [150, 700], noCritiqueErrors: true },
  },
  {
    id: 'cup-sized',
    prompt: 'a cup 120 mm tall',
    basis:
      'The request states one figure, so one figure is asserted — tightly. The diameter and ' +
      'wall come from the catalogue, and checking those would assert the defaults of this ' +
      'project back at itself.',
    deterministic: true,
    expect: { builds: true, closed: true, largestMm: 120, sizeTol: 0.02 },
  },

  // ── assemblies from recipes ──
  {
    id: 'phone',
    prompt: 'a phone',
    basis:
      'A modern handset is roughly 163 × 77 mm, and about 11 mm over the camera island — the ' +
      'overall box is measured, so the island is in it. The component count guards the real ' +
      'failure mode: a phone returned as two boxes is valid geometry and not a phone.',
    deterministic: true,
    expect: {
      builds: true,
      components: [8, 25],
      sizeMm: [163, 77, 11],
      sizeTol: 0.08,
      massG: [120, 400],
      noCritiqueErrors: true,
    },
  },
  {
    id: 'gearbox',
    prompt: 'a gearbox',
    basis: 'The recipe declares 8 components: case, two gears, two shafts, bearings.',
    deterministic: true,
    expect: { builds: true, components: [6, 12], noCritiqueErrors: true },
  },
  {
    id: 'bicycle',
    prompt: 'a bicycle',
    basis:
      'A road bicycle is about 1750 mm long, 1000 mm to the bars, and 440 mm across them. The ' +
      'height assertion caught wheels lying flat once already; the width one would catch bars ' +
      'modelled fore-and-aft.',
    deterministic: true,
    expect: {
      builds: true,
      components: [6, 30],
      sizeMm: [1750, 1000, 440],
      sizeTol: 0.15,
      noCritiqueErrors: true,
    },
  },
  {
    id: 'motor',
    prompt: 'an electric motor',
    basis: 'The recipe declares 6 components: housing, flange, shaft with keyway, rotor, terminals.',
    deterministic: true,
    expect: { builds: true, components: [4, 10], noCritiqueErrors: true },
  },

  // ── what it must refuse ──
  {
    id: 'refusal',
    prompt: 'a hydroformed titanium turbine volute with variable-section runners',
    basis:
      'Nothing in the catalogue is this, and no model is configured. A refusal is the correct ' +
      'answer; approximating it with the nearest archetype would be the serious failure.',
    deterministic: true,
    expect: { builds: false },
  },

  // ── composition: the operation asked for actually happens ──
  //
  // Each volume below is arithmetic anyone can redo on paper, and each is the check that
  // catches the failure the archetype route used to have: the right envelope, the right mass
  // for what was built, and every dimensional assertion passing on a part that had silently
  // lost what was asked of it.
  {
    id: 'compose-hollow-box',
    prompt: 'a hollow box 80 x 60 x 40 with 3 mm walls',
    basis:
      'Solid it would be 192 000 mm³. Shelled 3 mm with an open top, the void is ' +
      '74 × 54 × 37 = 147 852 mm³, leaving about 44 000 mm³. The band allows for which faces ' +
      'the shell opens; a solid result is far outside it either way.',
    deterministic: true,
    expect: {
      builds: true, closed: true,
      volumeMm3: [20000, 60000],
      featureKinds: ['shell'],
    },
  },
  {
    id: 'compose-block-hole',
    prompt: 'a 60 x 40 x 10 block with an 8 mm hole in the middle',
    basis:
      '60 × 40 × 10 = 24 000 mm³ less a ⌀8 hole through 10 mm, π × 4² × 10 = 503 mm³. ' +
      'A tessellated cylinder under-runs its true volume slightly, so the hole removes a ' +
      'little less than 503.',
    deterministic: true,
    expect: {
      builds: true, closed: true,
      volumeMm3: [23440, 23530],
      featureKinds: ['hole'],
    },
  },
  {
    id: 'compose-cylinder-bore',
    prompt: 'a 50 mm cylinder 80 mm long with a 12 mm hole through it',
    basis:
      'π × 25² × 80 = 157 080 mm³ less π × 6² × 80 = 9 048 mm³, so 148 032 mm³. Both are ' +
      'tessellated and run low by well under a percent at default quality.',
    deterministic: true,
    expect: {
      builds: true, closed: true,
      volumeMm3: [145000, 148100],
      featureKinds: ['cylinder', 'hole'],
    },
  },
  {
    id: 'compose-square-bar',
    prompt: 'a 100 mm long bar 20 mm square with 5 mm chamfers',
    basis:
      '"20 mm square" states both cross-section dimensions: 100 × 20 × 20 = 40 000 mm³, less ' +
      'the chamfers. Read as a single width the bar comes out 100 × 100 × 20, which is five ' +
      'times the material and the failure this case exists to catch.',
    deterministic: true,
    expect: {
      builds: true, closed: true,
      sizeMm: [100, 20, 20], sizeTol: 0.02,
      volumeMm3: [32000, 40000],
      featureKinds: ['chamfer'],
    },
  },
  {
    id: 'compose-bushing',
    prompt: 'a 25 mm bushing 40 mm long with a 15 mm bore',
    basis:
      'π(12.5² − 7.5²) × 40 = 12 566 mm³. A bushing is not in the catalogue, so this is the ' +
      'composed route answering a request the archetype list cannot.',
    deterministic: true,
    expect: {
      builds: true, closed: true,
      sizeMm: [40, 25, 25], sizeTol: 0.03,
      volumeMm3: [12200, 12580],
    },
  },

  // ── refusal: the property that separates this from a system that always answers ──
  //
  // A CAD tool that answers the wrong question confidently is worse than one that answers
  // nothing, because the user has no signal that the solid on screen is not their part. Each
  // of these names a part the catalogue does not have and the composer cannot build, and each
  // was previously answered with the nearest archetype: a crankshaft with a plain cylinder, a
  // ball bearing with a sphere, a cap screw with a knob.
  {
    id: 'refuse-crankshaft',
    prompt: 'a crankshaft for a 4 cylinder engine',
    basis: 'The head noun is "crankshaft". The "cylinder" belongs to a subordinate clause.',
    deterministic: true,
    expect: { builds: false },
  },
  {
    id: 'refuse-bearing',
    prompt: 'a ball bearing 6205',
    basis: 'The head noun is "bearing"; "ball" is a compound modifier, and a sphere is not one.',
    deterministic: true,
    expect: { builds: false },
  },
  {
    id: 'refuse-capscrew',
    prompt: 'a socket head cap screw M6 x 20',
    basis: 'English compounds are head-final: this is a screw, not a socket and not a head.',
    deterministic: true,
    expect: { builds: false },
  },
  {
    id: 'refuse-turbine',
    prompt: 'a turbine blade with a twisted aerofoil',
    basis: 'No archetype, and a twisted aerofoil is not a primitive with operations on it.',
    deterministic: true,
    expect: { builds: false },
  },

  // ── the drawing states what the request stated ──
  {
    id: 'drawing-dimensions',
    prompt: 'a 150 x 90 x 12 plate',
    basis:
      'A drawing is what the shop cuts to, so its dimensions have to be the ones asked for. ' +
      'The figures are the request; the tolerance class is ISO 2768-m, which this project ' +
      'did not choose.',
    deterministic: true,
    expect: {
      builds: true, closed: true,
      sizeMm: [150, 90, 12], sizeTol: 0.02,
      drawingHas: ['150.0', '90.0', '12.0'],
    },
  },

  // ── manufacturability fires on geometry that breaches a published limit ──
  {
    id: 'dfm-thin-wall',
    prompt: 'a hollow box 80 x 60 x 40 with 0.4 mm walls',
    basis:
      '0.4 mm is below the 0.8 mm floor for a machined wall — thinner than that chatters away ' +
      'from the cutter in aluminium and will not hold tolerance in steel at all. The rule ' +
      'that names it must be the one that fires.',
    deterministic: true,
    expect: {
      builds: true,
      blockerRule: 'dfm.mill.min-wall',
    },
  },

  // ── units ──
  {
    id: 'capacity-bottle',
    prompt: 'a 500 ml bottle',
    basis:
      'A bottle sized by capacity has to hold it. 500 ml of water is 500 g, and a 500 ml ' +
      'vessel is 60–90 mm across and 180–260 mm tall whatever else it is.',
    deterministic: true,
    expect: { builds: true, closed: true, largestMm: 220, sizeTol: 0.35 },
  },
];

export const deterministicCases = (): EvalCase[] => CASES.filter((c) => c.deterministic);

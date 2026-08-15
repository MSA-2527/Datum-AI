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
];

export const deterministicCases = (): EvalCase[] => CASES.filter((c) => c.deterministic);

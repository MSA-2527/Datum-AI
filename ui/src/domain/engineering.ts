/**
 * The equations a mechanical engineer reaches for daily.
 *
 * Not simulation. Simulation answers questions about a specific geometry and needs a mesh, a
 * solver and a great deal of care; these are closed-form results that have been in the handbooks
 * for a century, and the reason to have them here is that they are what actually gets used —
 * sizing a bolt, checking a beam will not sag, working out whether a press fit will hold.
 *
 * Every function reports the assumption it rests on rather than only a number. A deflection
 * figure with no statement of the end conditions is a number someone will use for a case it does
 * not describe, and a wrong answer that looks authoritative is the failure mode worth avoiding.
 * Where a result crosses a limit — yield, buckling, a fit that will not assemble — it says so.
 */

export interface Result {
  /** What was worked out, with units. */
  lines: { label: string; value: string; note?: string }[];
  /** What the answer depends on. Always populated. */
  assumes: string[];
  /** A problem with the result: over yield, will not assemble, out of range. */
  warning?: string;
}

const mm = (v: number) => `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 3)} mm`;
const mpa = (v: number) => `${v.toFixed(v >= 100 ? 0 : 1)} MPa`;
const nm = (v: number) => `${v.toFixed(v >= 100 ? 0 : 2)} N·m`;
const kn = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)} kN` : `${v.toFixed(0)} N`);

// ── materials ────────────────────────────────────────────────────────────────

export interface Material {
  id: string;
  name: string;
  /** Young's modulus, MPa. */
  E: number;
  /** Yield strength, MPa. */
  yield: number;
  /** Density, g/cm³. */
  density: number;
  poisson: number;
}

/**
 * Typical values for the alloys people actually specify.
 *
 * Typical, not guaranteed: a real design uses the figure on the certificate for the heat it was
 * supplied from. Stated here so nobody takes these for design minima.
 */
export const MATERIALS: Material[] = [
  { id: '6061', name: 'Aluminium 6061-T6', E: 68900, yield: 276, density: 2.70, poisson: 0.33 },
  { id: '7075', name: 'Aluminium 7075-T6', E: 71700, yield: 503, density: 2.81, poisson: 0.33 },
  { id: '1018', name: 'Mild steel 1018', E: 205000, yield: 370, density: 7.87, poisson: 0.29 },
  { id: '4140', name: 'Alloy steel 4140', E: 205000, yield: 655, density: 7.85, poisson: 0.29 },
  { id: '304', name: 'Stainless 304', E: 193000, yield: 215, density: 8.00, poisson: 0.29 },
  { id: 'ti64', name: 'Titanium Ti-6Al-4V', E: 113800, yield: 880, density: 4.43, poisson: 0.34 },
  { id: 'brass', name: 'Brass C360', E: 97000, yield: 310, density: 8.50, poisson: 0.34 },
  { id: 'abs', name: 'ABS', E: 2300, yield: 40, density: 1.04, poisson: 0.35 },
  { id: 'nylon', name: 'Nylon 6/6', E: 2800, yield: 82, density: 1.14, poisson: 0.39 },
];

export const materialById = (id: string): Material =>
  MATERIALS.find((m) => m.id === id) ?? MATERIALS[0]!;

// ── beams ────────────────────────────────────────────────────────────────────

export type BeamCase = 'cantilever-end' | 'cantilever-udl' | 'simple-centre' | 'simple-udl';

export interface SectionProperties {
  /** Second moment of area about the bending axis, mm⁴. */
  I: number;
  /** Distance from the neutral axis to the extreme fibre, mm. */
  c: number;
  /** Cross-sectional area, mm². */
  area: number;
}

/** A solid rectangle bending about its horizontal axis. */
export const rectangleSection = (width: number, height: number): SectionProperties => ({
  I: (width * height ** 3) / 12,
  c: height / 2,
  area: width * height,
});

/** A solid round bar. */
export const roundSection = (diameter: number): SectionProperties => ({
  I: (Math.PI * diameter ** 4) / 64,
  c: diameter / 2,
  area: (Math.PI * diameter ** 2) / 4,
});

/** A tube. Hollow sections are most of what anyone builds a frame from. */
export const tubeSection = (outer: number, wall: number): SectionProperties => {
  const inner = Math.max(0, outer - 2 * wall);
  return {
    I: (Math.PI * (outer ** 4 - inner ** 4)) / 64,
    c: outer / 2,
    area: (Math.PI * (outer ** 2 - inner ** 2)) / 4,
  };
};

/**
 * Deflection and stress of a loaded beam.
 *
 * Four cases, which between them cover most of what gets checked by hand. Loads in newtons,
 * lengths in millimetres, so the answers come out in millimetres and megapascals without a
 * conversion anyone has to remember.
 *
 * Reported against yield with the margin stated, because "12 MPa" means nothing on its own and
 * "12 MPa against 276 MPa yield, a factor of 23" means everything.
 */
export function beam(
  kase: BeamCase, load: number, length: number, section: SectionProperties, material: Material,
): Result {
  const { I, c } = section;
  const E = material.E;

  if (!(I > 0) || !(length > 0)) {
    return { lines: [], assumes: [], warning: 'The section or the length is zero.' };
  }

  // Deflection at the worst point, and the maximum bending moment.
  let deflection: number;
  let moment: number;
  let where: string;

  switch (kase) {
    case 'cantilever-end':
      deflection = (load * length ** 3) / (3 * E * I);
      moment = load * length;
      where = 'at the free end';
      break;
    case 'cantilever-udl':
      deflection = (load * length ** 3) / (8 * E * I);
      moment = (load * length) / 2;
      where = 'at the free end';
      break;
    case 'simple-centre':
      deflection = (load * length ** 3) / (48 * E * I);
      moment = (load * length) / 4;
      where = 'at mid-span';
      break;
    default:
      deflection = (5 * load * length ** 3) / (384 * E * I);
      moment = (load * length) / 8;
      where = 'at mid-span';
      break;
  }

  const stress = (moment * c) / I;
  const factor = stress > 0 ? material.yield / stress : Infinity;

  const distributed = kase.endsWith('udl');

  return {
    lines: [
      { label: 'Deflection', value: mm(deflection), note: where },
      { label: 'Bending stress', value: mpa(stress) },
      { label: 'Against yield', value: `${factor.toFixed(1)}×`, note: `${material.name}, ${mpa(material.yield)}` },
      { label: 'Bending moment', value: nm(moment / 1000) },
      { label: 'Second moment', value: `${I.toFixed(0)} mm⁴` },
    ],
    assumes: [
      distributed ? 'The load is spread evenly along the beam.' : 'The load acts at one point.',
      'Linear elastic material, small deflections, no buckling of the compression flange.',
      'Yield is a typical value for the alloy, not a certified minimum.',
    ],
    warning: factor < 1
      ? `The bending stress exceeds yield — the beam would take a permanent set. It needs about `
        + `${Math.cbrt(1 / factor).toFixed(2)}× the section depth, or a stronger material.`
      : factor < 1.5
        ? `Only ${factor.toFixed(2)}× against yield. Most design codes want at least 1.5.`
        : undefined,
  };
}

// ── bolted joints ────────────────────────────────────────────────────────────

/** Coarse metric threads: nominal to pitch and tensile stress area, mm and mm². */
const THREADS: Record<number, { pitch: number; area: number }> = {
  3: { pitch: 0.5, area: 5.03 },
  4: { pitch: 0.7, area: 8.78 },
  5: { pitch: 0.8, area: 14.2 },
  6: { pitch: 1.0, area: 20.1 },
  8: { pitch: 1.25, area: 36.6 },
  10: { pitch: 1.5, area: 58.0 },
  12: { pitch: 1.75, area: 84.3 },
  16: { pitch: 2.0, area: 157 },
  20: { pitch: 2.5, area: 245 },
  24: { pitch: 3.0, area: 353 },
};

export const BOLT_SIZES = Object.keys(THREADS).map(Number);

/** Proof strength by property class, MPa. */
const CLASSES: Record<string, { proof: number; tensile: number }> = {
  '4.6': { proof: 225, tensile: 400 },
  '8.8': { proof: 600, tensile: 800 },
  '10.9': { proof: 830, tensile: 1040 },
  '12.9': { proof: 970, tensile: 1220 },
};

export const BOLT_CLASSES = Object.keys(CLASSES);

/**
 * Preload, torque and capacity of a bolted joint.
 *
 * The torque relation is the short-form `T = K · F · d`, with K the nut factor. That constant
 * carries all of the friction, and friction is where nearly all the scatter in a bolted joint
 * lives — a torque wrench gets you within about ±25% of the preload you intended even when
 * everything is clean and consistent. The figure is reported with that spread rather than as a
 * single number, because a preload quoted to three digits is a false precision that leads people
 * to trust a torque setting further than it deserves.
 */
export function bolt(
  size: number, grade: string, count = 1, shearLoad = 0, friction = 0.2,
): Result {
  const thread = THREADS[size];
  const spec = CLASSES[grade];

  if (!thread || !spec) {
    return { lines: [], assumes: [], warning: 'That size or class is not in the table.' };
  }

  // Tightened to 75% of proof, which is the usual target for a reusable joint.
  const preload = 0.75 * spec.proof * thread.area;
  const torque = (friction * preload * size) / 1000;

  // Friction grip, at a coefficient typical of dry machined steel.
  const SLIP = 0.15;
  const grip = SLIP * preload * count;

  // Shear on the bolt itself, if the joint slips and the bolts go into bearing.
  const shearCapacity = 0.6 * spec.tensile * thread.area * count;
  const applied = shearLoad > 0 ? shearLoad / count : 0;

  return {
    lines: [
      { label: 'Preload', value: kn(preload), note: '75% of proof, per bolt' },
      { label: 'Tightening torque', value: nm(torque), note: `±25%, K = ${friction}` },
      { label: 'Stress area', value: `${thread.area} mm²`, note: `M${size} × ${thread.pitch}` },
      { label: 'Friction grip', value: kn(grip), note: `${count} bolt${count === 1 ? '' : 's'}, µ = ${SLIP}` },
      { label: 'Shear capacity', value: kn(shearCapacity), note: 'if the joint slips into bearing' },
      ...(applied > 0 ? [{ label: 'Applied per bolt', value: kn(applied) }] : []),
    ],
    assumes: [
      'The nut factor carries all the friction, and friction is where nearly all the scatter is.',
      'Clean, dry, unlubricated threads. Lubricant can halve the torque for the same preload.',
      'The clamped material can take the preload without crushing.',
    ],
    warning: shearLoad > grip
      ? `The joint would slip: ${kn(shearLoad)} applied against ${kn(grip)} of friction grip. `
        + 'Add bolts, increase preload, or design for bearing with fitted bolts.'
      : undefined,
  };
}

// ── press fits ───────────────────────────────────────────────────────────────

/**
 * Interference fit between a shaft and a hub.
 *
 * Lamé's thick-cylinder solution. Returns the pressure at the interface, the torque the joint
 * will carry, and the force to press it together — and whether the hub yields, which is the
 * failure people get wrong most often because the shaft looks like the highly-stressed part and
 * is not.
 */
export function pressFit(
  shaftDia: number, hubOuter: number, interference: number,
  material: Material, length: number, friction = 0.12,
): Result {
  if (!(shaftDia > 0) || !(hubOuter > shaftDia) || !(interference > 0)) {
    return { lines: [], assumes: [], warning: 'The hub must be larger than the shaft, with a positive interference.' };
  }

  const ratio = shaftDia / hubOuter;

  // Same material both sides, solid shaft: p = (δ·E / d) · (1 − (d/D)²) / 2
  const pressure = ((interference * material.E) / shaftDia) * ((1 - ratio ** 2) / 2);

  const contactArea = Math.PI * shaftDia * length;
  const torque = (friction * pressure * contactArea * shaftDia) / 2 / 1000;
  const pressForce = friction * pressure * contactArea;

  // Hoop stress at the bore of the hub is the highest stress in the joint.
  const hoop = pressure * ((1 + ratio ** 2) / (1 - ratio ** 2));
  const factor = hoop > 0 ? material.yield / hoop : Infinity;

  return {
    lines: [
      { label: 'Interface pressure', value: mpa(pressure) },
      { label: 'Torque capacity', value: nm(torque), note: `µ = ${friction}` },
      { label: 'Press-in force', value: kn(pressForce) },
      { label: 'Hub hoop stress', value: mpa(hoop), note: 'at the bore — the highest in the joint' },
      { label: 'Against yield', value: `${factor.toFixed(1)}×`, note: material.name },
    ],
    assumes: [
      'Both parts the same material, solid shaft, thick-cylinder (Lamé) behaviour.',
      'The interference is the diametral figure, after any surface roughness has bedded down.',
      'No temperature difference in service — a hot hub loosens.',
    ],
    warning: factor < 1
      ? `The hub yields at the bore: ${mpa(hoop)} against ${mpa(material.yield)}. Reduce the `
        + 'interference or use a thicker hub.'
      : factor < 1.5
        ? `Only ${factor.toFixed(2)}× against yield at the hub bore.`
        : undefined,
  };
}

// ── buckling ─────────────────────────────────────────────────────────────────

export type EndCondition = 'pinned' | 'fixed' | 'fixed-free' | 'fixed-pinned';

const K_FACTOR: Record<EndCondition, number> = {
  pinned: 1.0, fixed: 0.5, 'fixed-free': 2.0, 'fixed-pinned': 0.699,
};

/**
 * Euler buckling of a column.
 *
 * With the slenderness check, because Euler is only valid for a slender column: a stubby one
 * fails by crushing long before it buckles, and Euler happily returns a load far above what the
 * material can take. Reporting the smaller of the two is the whole value of doing this at all.
 */
export function buckling(
  length: number, section: SectionProperties, material: Material, ends: EndCondition = 'pinned',
): Result {
  const k = K_FACTOR[ends];
  const effective = k * length;
  const radius = Math.sqrt(section.I / section.area);
  const slenderness = effective / radius;

  const euler = (Math.PI ** 2 * material.E * section.I) / effective ** 2;
  const crush = material.yield * section.area;

  // The transition: below this slenderness the column crushes rather than buckles.
  const transition = Math.PI * Math.sqrt(material.E / material.yield);
  const governs = slenderness < transition ? 'crushing' : 'buckling';
  const capacity = Math.min(euler, crush);

  return {
    lines: [
      { label: 'Critical load', value: kn(capacity), note: `governed by ${governs}` },
      { label: 'Euler buckling', value: kn(euler) },
      { label: 'Crushing', value: kn(crush) },
      { label: 'Slenderness', value: slenderness.toFixed(0), note: `transition at ${transition.toFixed(0)}` },
      { label: 'Effective length', value: mm(effective), note: `K = ${k}, ${ends}` },
    ],
    assumes: [
      'A perfectly straight column, loaded exactly on its axis.',
      'Real columns have an initial bow and eccentricity, and carry appreciably less.',
      'Euler alone is wrong for a stubby column — the crushing figure is why both are shown.',
    ],
    warning: slenderness < transition
      ? 'This column is too stubby to buckle in the Euler sense. It crushes first.'
      : undefined,
  };
}

// ── fits and tolerances ──────────────────────────────────────────────────────

/** ISO 286 fundamental tolerance grades, in micrometres, for nominal sizes to 500 mm. */
const IT_GRADE: Record<number, number[]> = {
  //         ≤3   ≤6  ≤10  ≤18  ≤30  ≤50  ≤80 ≤120 ≤180 ≤250 ≤315 ≤400 ≤500
  6: [6, 8, 9, 11, 13, 16, 19, 22, 25, 29, 32, 36, 40],
  7: [10, 12, 15, 18, 21, 25, 30, 35, 40, 46, 52, 57, 63],
  8: [14, 18, 22, 27, 33, 39, 46, 54, 63, 72, 81, 89, 97],
  9: [25, 30, 36, 43, 52, 62, 74, 87, 100, 115, 130, 140, 155],
  11: [60, 75, 90, 110, 130, 160, 190, 220, 250, 290, 320, 360, 400],
};

const BANDS = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500];

function itFor(nominal: number, grade: number): number | null {
  const row = IT_GRADE[grade];
  if (!row) return null;
  const at = BANDS.findIndex((b) => nominal <= b);
  return at >= 0 ? row[at]! / 1000 : null;
}

export type FitKind = 'H7/g6' | 'H7/h6' | 'H7/k6' | 'H7/p6' | 'H8/f7' | 'H11/c11';

/**
 * A standard hole-basis fit, worked out for a nominal size.
 *
 * The deviations are the ones the standard tabulates; the point of having this is not the
 * arithmetic but that it reports what the fit *does* — turns freely, needs a press — alongside
 * the clearance, because a table of four numbers does not tell anyone whether the parts go
 * together.
 */
export function fit(nominal: number, kind: FitKind = 'H7/g6'): Result {
  const grades: Record<FitKind, { hole: number; shaft: number; deviation: number; describes: string }> = {
    'H7/g6': { hole: 7, shaft: 6, deviation: -0.009, describes: 'Sliding fit — turns and slides freely, located accurately.' },
    'H7/h6': { hole: 7, shaft: 6, deviation: 0, describes: 'Locational clearance — assembles by hand, no shake.' },
    'H7/k6': { hole: 7, shaft: 6, deviation: 0.002, describes: 'Transition fit — light tap to assemble.' },
    'H7/p6': { hole: 7, shaft: 6, deviation: 0.018, describes: 'Interference — needs a press, transmits torque.' },
    'H8/f7': { hole: 8, shaft: 7, deviation: -0.020, describes: 'Running fit — for a plain bearing with oil.' },
    'H11/c11': { hole: 11, shaft: 11, deviation: -0.095, describes: 'Loose clearance — for rough parts and coarse assembly.' },
  };

  const g = grades[kind];
  const holeIT = itFor(nominal, g.hole);
  const shaftIT = itFor(nominal, g.shaft);

  if (holeIT === null || shaftIT === null) {
    return { lines: [], assumes: [], warning: 'That size is outside the tabulated range (to 500 mm).' };
  }

  // Hole basis: the hole runs from nominal upwards. The shaft's position comes from its
  // fundamental deviation, scaled with size.
  const scale = Math.cbrt(nominal / 25) || 1;
  const deviation = g.deviation * scale;

  const holeMin = nominal, holeMax = nominal + holeIT;
  const shaftMax = nominal + deviation, shaftMin = shaftMax - shaftIT;

  const maxClearance = holeMax - shaftMin;
  const minClearance = holeMin - shaftMax;

  return {
    lines: [
      { label: 'Hole', value: `${holeMin.toFixed(3)} to ${holeMax.toFixed(3)}`, note: `H${g.hole}` },
      { label: 'Shaft', value: `${shaftMin.toFixed(3)} to ${shaftMax.toFixed(3)}`, note: kind.split('/')[1] },
      { label: 'Clearance', value: `${(minClearance * 1000).toFixed(0)} to ${(maxClearance * 1000).toFixed(0)} µm` },
      { label: 'What it does', value: g.describes },
    ],
    assumes: [
      'Hole basis — the hole is made to size and the shaft is adjusted to suit, which is what a',
      'reamer or a standard drill gives you. Shaft basis exists for ground stock and is different.',
      'At 20 °C. Aluminium on steel moves about 12 µm per 100 mm per 10 °C.',
    ],
    warning: minClearance < 0
      ? `Interference of up to ${Math.abs(minClearance * 1000).toFixed(0)} µm — these parts will `
        + 'not assemble by hand.'
      : undefined,
  };
}

import { archetypeById } from '../../generate/archetypes';
import { box, cylinder } from '../../kernel/ops/build';
import {
  bounds, getTriangle, health, massProperties, surfaceArea, triCount, type Mesh,
} from '../../kernel/topo/mesh';

/**
 * Recovering a parametric part from a solid that has no history.
 *
 * This is the bridge between "we imported your library" and "we can learn from your library",
 * and the distinction is the whole reason it exists. An imported solid — traced from a
 * photograph, reconstructed from a drawing, or read from a neutral file — is a mesh. It is
 * measurable, exportable and correct, and it carries no record of the features that made it.
 * It can therefore be *searched*, and it cannot be *taught*: a training example is a plan, and
 * a plan is archetypes and primitives placed in space.
 *
 * So the mesh has to be read back into that vocabulary. That is what this does.
 *
 * **It proposes and then verifies; it does not classify.** The tempting design is a classifier
 * that looks at some features of the mesh and announces "this is a plate". That is guessing
 * with extra steps, and it is confidently wrong on the parts that matter. Instead each
 * candidate archetype *derives* its parameters from the mesh directly, the archetype is then
 * **rebuilt from those parameters**, and the rebuild is compared against the original. The
 * answer is only accepted when the two agree. A fit is therefore a claim that can be checked,
 * which is the same standard the rest of the product holds itself to.
 *
 * **It is expected to refuse.** A plate, a washer, a shaft and a pipe are recoverable because
 * a handful of numbers really do describe them. A hydroformed manifold is not, and returning
 * the nearest archetype for one would produce a training example that teaches the model to
 * answer "manifold" with "tube" — worse than having no example at all. Refusing is the
 * common, correct outcome and is reported with the best score achieved so the threshold can be
 * argued with.
 */

export interface Fit {
  archetypeId: string;
  /** Parameters read off the mesh, in the archetype's own vocabulary. */
  params: Record<string, number>;
  /** Agreement between the rebuilt archetype and the mesh given, 0 to 1. */
  agreement: number;
  /** What was compared and how closely, so a fit can be judged rather than trusted. */
  detail: string;
}

export interface FitResult {
  /** The accepted fit, or null when nothing agreed closely enough. */
  best: Fit | null;
  /** Every candidate tried, best first, whether accepted or not. */
  considered: Fit[];
  /** Why nothing was accepted. Present only on refusal. */
  reason?: string;
}

/**
 * The acceptance bar.
 *
 * Set from what the comparison can actually distinguish. Volume and surface area together
 * separate a cylinder from its bounding box by a wide margin — 79% and 85% respectively — so
 * a wrong archetype scores far below this rather than just under it. What sits between 0.9
 * and 0.97 is the *right* archetype missing a detail: a plate whose corner radii were not
 * recovered, a shaft with a chamfer. Those are refused too, because an example that omits a
 * feature teaches the model to omit it.
 */
const ACCEPT = 0.97;

/** Tessellation already costs about 0.4% of volume, so agreement is never measured tighter. */
const FLOOR = 0.004;

// ── what a mesh looks like from outside ─────────────────────────────────────

interface Signature {
  /** Bounding box along X, Y, Z as modelled. */
  raw: [number, number, number];
  /** The same three, largest first, so orientation is not part of the reasoning. */
  sorted: [number, number, number];
  volume: number;
  area: number;
  /** Volume ÷ bounding-box volume. A box is 1, a cylinder about 0.785, a torus far less. */
  fill: number;
  /** The axis index whose two perpendicular extents match, or -1 when none do. */
  axis: number;
  /**
   * Handles through the solid: 0 for a block, 1 for a washer, 4 for a plate with four holes.
   *
   * An exact topological invariant, and the cheapest decisive test available. Volume barely
   * notices four 9 mm holes in a 200 mm plate — a 1% difference, which passes any tolerance
   * loose enough to allow for tessellation — while the genus goes from 0 to 4 and cannot be
   * argued with.
   */
  genus: number;
  /**
   * The axis of a hexagonal prism, or -1.
   *
   * A hex across-corners is its across-flats divided by cos 30°, so the two extents differ by
   * 15% and the round-axis test never fires on a nut. Detected separately because a hex nut is
   * one of the most common parts in any library and would otherwise be invisible.
   */
  hexAxis: number;
  /**
   * Principal moments of inertia, made scale-free.
   *
   * The only measure here that knows about the *inside* of the solid. Volume, surface and
   * envelope are all blind to where material sits once the totals agree — two plates with the
   * same four holes drilled in different places are identical on every other term. Inertia is
   * exact, already computed by the kernel, and separates them.
   */
  inertia: [number, number, number];
  /**
   * The solid's width, band by band along its longest axis.
   *
   * What separates shapes that agree on every aggregate. A bottle and a length of tube can
   * have the same volume, the same surface area and the same envelope; they differ in *where*
   * the material is, and the bottle's neck shows up here as a step no tube has. Same for the
   * groove in a pulley, and the taper in a funnel.
   */
  profile: number[];
}

function signatureOf(mesh: Mesh): Signature {
  const b = bounds(mesh);
  const raw: [number, number, number] = [
    b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2],
  ];
  const mass = massProperties(mesh);
  const volume = Math.abs(mass.volume);
  const boxVolume = Math.max(1e-9, raw[0] * raw[1] * raw[2]);

  // Inertia scales as length^5, so dividing by volume^(5/3) leaves a pure shape descriptor —
  // a 20 mm cube and a 200 mm cube give the same three numbers.
  const scale = Math.max(volume ** (5 / 3), 1e-12);
  const inertia = mass.principal.map((v) => v / scale) as [number, number, number];

  // A body of revolution has equal extents across its axis. Found rather than assumed,
  // because an imported part arrives in whatever orientation the drawing was drawn in.
  let axis = -1;
  for (let i = 0; i < 3; i++) {
    const [p, q] = [raw[(i + 1) % 3]!, raw[(i + 2) % 3]!];
    if (Math.abs(p - q) / Math.max(p, q, 1e-9) < 0.02) { axis = i; break; }
  }

  // Banded along the axis of revolution where there is one, and along the longest axis
  // otherwise. The distinction matters: a pulley's longest extent is its diameter, and bands
  // cut diametrically straddle the groove instead of crossing it, so the feature that makes
  // it a pulley rather than a washer averages away to nothing.
  const banding = axis >= 0 ? axis : raw.indexOf(Math.max(...raw));

  // Across-corners ÷ across-flats for a regular hexagon is 1 / cos 30° = 1.1547.
  let hexAxis = -1;
  for (let i = 0; i < 3; i++) {
    const [p, q] = [raw[(i + 1) % 3]!, raw[(i + 2) % 3]!];
    const ratio = Math.max(p, q) / Math.max(Math.min(p, q), 1e-9);
    if (Math.abs(ratio - 2 / Math.sqrt(3)) < 0.03) { hexAxis = i; break; }
  }

  return {
    raw,
    hexAxis,
    inertia,
    sorted: [...raw].sort((x, y) => y - x) as [number, number, number],
    volume,
    area: surfaceArea(mesh),
    fill: volume / boxVolume,
    axis,
    genus: health(mesh).genus,
    profile: sectionProfile(mesh, banding),
  };
}

/** Bands along one axis; twelve resolves a neck or a groove without being noise-sensitive. */
const BANDS = 12;

/**
 * Half-width per band, normalised so the comparison is of *shape* rather than size.
 *
 * Measured by spanning triangles rather than by bucketing vertices, and the difference is not
 * a refinement — the vertex version was wrong. A revolved side wall carries vertices only on
 * its two end rings, so a plain 180 mm shaft produced a profile that was 1.0 at each end and
 * zero everywhere between: bands with no vertices in them read as empty space. Shapes only
 * compared correctly when they happened to be tessellated alike.
 *
 * A triangle instead contributes its widest radius to every band its axial extent covers, so
 * one long quad on a cylinder wall fills the length the way the solid actually does.
 */
function sectionProfile(mesh: Mesh, axis: number): number[] {
  const widest = new Array<number>(BANDS).fill(0);
  const n = triCount(mesh);
  if (n === 0) return widest;

  const b = bounds(mesh);
  const lo = b.min[axis]!;
  const span = Math.max(1e-9, b.max[axis]! - lo);
  const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
  const centreU = (b.min[u]! + b.max[u]!) / 2;
  const centreV = (b.min[v]! + b.max[v]!) / 2;

  for (let t = 0; t < n; t++) {
    const corners = getTriangle(mesh, t);

    let lowBand = BANDS - 1;
    let highBand = 0;
    let radius = 0;

    for (const c of corners) {
      const at = Math.min(BANDS - 1, Math.max(0, Math.floor(((c[axis]! - lo) / span) * BANDS)));
      if (at < lowBand) lowBand = at;
      if (at > highBand) highBand = at;
      const r = Math.hypot(c[u]! - centreU, c[v]! - centreV);
      if (r > radius) radius = r;
    }

    for (let band = lowBand; band <= highBand; band++) {
      if (radius > widest[band]!) widest[band] = radius;
    }
  }

  const scale = Math.max(...widest, 1e-9);
  return widest.map((w) => w / scale);
}

// ── proposing ───────────────────────────────────────────────────────────────

/**
 * A candidate reads the signature and offers parameters, or declines.
 *
 * Declining early matters: building a washer from a solid block and then scoring it wastes
 * a tessellation, and there are enough archetypes that trying all of them on every import
 * would be felt.
 */
type Proposer = (s: Signature) => { archetypeId: string; params: Record<string, number> } | null;

const PROPOSERS: Proposer[] = [
  // A solid block. Proposed only when the part nearly fills its own bounding box, which is
  // what "box" means.
  (s) => (s.fill > 0.9
    ? { archetypeId: 'box', params: { length: s.raw[0]!, width: s.raw[1]!, height: s.raw[2]! } }
    : null),

  // A plate is a box read the other way up: the thin axis is the thickness, whatever axis it
  // happens to lie along. Corner radius and holes stay at zero: a radius guessed from a
  // bounding box is a radius invented, and the verification below will reject a plate that
  // really has one rather than accept a wrong number for it.
  (s) => (s.fill > 0.9 && s.sorted[2]! < s.sorted[0]! / 4
    ? {
        archetypeId: 'plate',
        params: {
          length: s.sorted[0]!, width: s.sorted[1]!, thickness: s.sorted[2]!,
          cornerRadius: 0, holeDia: 0, holeInset: 18,
        },
      }
    : null),

  // A solid of revolution filling about π/4 of its box is a plain cylinder.
  (s) => {
    if (s.axis < 0 || Math.abs(s.fill - Math.PI / 4) > 0.06) return null;
    const height = s.raw[s.axis]!;
    const diameter = s.raw[(s.axis + 1) % 3]!;
    return { archetypeId: 'cylinder', params: { diameter, height } };
  },

  // Annular: round outside, and hollow enough that a bore is the only explanation. Short ones
  // are washers, long ones are pipes, and the ratio is where the two archetypes divide.
  (s) => {
    if (s.axis < 0 || s.fill >= Math.PI / 4 - 0.02 || s.fill < 0.05) return null;

    const height = s.raw[s.axis]!;
    const outerDia = s.raw[(s.axis + 1) % 3]!;

    // The bore follows from the volume: V = π/4 (D² − d²) h, so d² = D² − 4V/(πh).
    const inner2 = outerDia ** 2 - (4 * s.volume) / (Math.PI * Math.max(height, 1e-9));
    if (inner2 <= 0) return null;
    const boreDia = Math.sqrt(inner2);
    if (boreDia >= outerDia) return null;

    const params: Record<string, number> = height < outerDia
      ? { outerDia, boreDia, thickness: height }
      : { outerDia, length: height, wall: (outerDia - boreDia) / 2, bendRadius: 0, bendAngle: 90 };

    return { archetypeId: height < outerDia ? 'washer' : 'pipe', params };
  },
  // A stepped shaft: round, solid, and with a reduced diameter over part of its length. The
  // step comes straight out of the section profile — it is the one place a turned part's shape
  // is written down in a form a mesh can be read for.
  (s) => {
    if (s.axis < 0 || s.genus !== 0) return null;

    const length = s.raw[s.axis]!;
    const diameter = s.raw[(s.axis + 1) % 3]!;
    if (length < diameter) return null;                    // a disc, not a shaft

    // Bands narrower than the full diameter, and they have to be contiguous and at one end —
    // a waist in the middle is a different part, and offering a shaft for it would be a guess
    // dressed as a reading.
    const narrow = s.profile.map((v, i) => (v < 0.97 ? i : -1)).filter((i) => i >= 0);
    if (narrow.length === 0 || narrow.length >= BANDS) return null;

    const contiguous = narrow.every((b, i) => i === 0 || b === narrow[i - 1]! + 1);
    const atOneEnd = narrow[0] === 0 || narrow[narrow.length - 1] === BANDS - 1;
    if (!contiguous || !atOneEnd) return null;

    const stepRatio = Math.min(...narrow.map((b) => s.profile[b]!));

    return {
      archetypeId: 'shaft',
      params: {
        diameter,
        length,
        stepDia: round2(diameter * stepRatio),
        stepLength: round2((narrow.length / BANDS) * length),
        chamfer: 0, keywayWidth: 0, keywayDepth: 0, keywayLength: 0,
      },
    };
  },

  // A hex nut: six flats, one bore, and a thickness. The bore follows from the volume, the
  // same way a washer's does, over a hexagonal area rather than a circular one.
  (s) => {
    if (s.hexAxis < 0 || s.genus !== 1) return null;

    const thickness = s.raw[s.hexAxis]!;
    const acrossFlats = Math.min(s.raw[(s.hexAxis + 1) % 3]!, s.raw[(s.hexAxis + 2) % 3]!);
    if (thickness > acrossFlats) return null;              // a hex bar, not a nut

    // Area of a regular hexagon across its flats is (√3 / 2) S².
    const hexArea = (Math.sqrt(3) / 2) * acrossFlats ** 2;
    const boreArea = hexArea - s.volume / Math.max(thickness, 1e-9);
    if (boreArea <= 0) return null;

    const boreDia = 2 * Math.sqrt(boreArea / Math.PI);
    if (boreDia >= acrossFlats) return null;

    return {
      archetypeId: 'nut',
      params: {
        acrossFlats: round2(acrossFlats),
        thickness: round2(thickness),
        boreDia: round2(boreDia),
        chamfer: 0,
      },
    };
  },
];

const round2 = (v: number) => Math.round(v * 100) / 100;

// ── verifying ───────────────────────────────────────────────────────────────

/** Agreement between two measurements, 1 when equal and 0 when one is twice the other. */
function agree(a: number, b: number): number {
  const hi = Math.max(Math.abs(a), Math.abs(b));
  if (hi < 1e-9) return 1;
  const error = Math.abs(a - b) / hi;
  return Math.max(0, 1 - Math.max(0, error - FLOOR));
}

/**
 * Builds the candidate and measures how well it reproduces the original.
 *
 * Volume and area are compared rather than points, and the pair is what makes the cheap test
 * sound. Volume alone accepts any shape of the right size; area alone accepts any size of the
 * right shape. Together they pin both, and the two disagree sharply for the confusions that
 * actually happen — a cylinder mistaken for its bounding box is 21% out on volume and 15% out
 * on area at once. Bounding box is included so a part cannot pass by being the right shape in
 * the wrong proportions.
 */
function score(
  s: Signature, candidate: { archetypeId: string; params: Record<string, number> },
): Fit | null {
  const archetype = archetypeById(candidate.archetypeId);
  const result = archetype?.build(candidate.params);

  // An archetype that reports itself invalid is not a fit, whatever it measures. A build that
  // silently failed halfway can still have a plausible bounding box.
  if (archetype && (!result || !result.valid)) return null;

  const built = result ? result.mesh : primitive(candidate.archetypeId, candidate.params);
  if (!built || triCount(built) === 0) return null;

  const rebuilt = signatureOf(built);

  const volume = agree(s.volume, rebuilt.volume);
  const area = agree(s.area, rebuilt.area);
  const size = s.sorted.reduce((acc, v, i) => acc + agree(v, rebuilt.sorted[i]!), 0) / 3;
  const shape = s.profile.reduce((acc, v, i) => acc + agree(v, rebuilt.profile[i]!), 0) / BANDS;
  const inside = s.inertia.reduce((acc, v, i) => acc + agree(v, rebuilt.inertia[i]!), 0) / 3;

  // Volume carries the most weight because it is the measurement the kernel computes exactly,
  // by the divergence theorem, rather than by summing tessellated facets. The section profile
  // is next, because it is the only term that knows *where* the material is.
  const agreement = volume * 0.3 + shape * 0.2 + inside * 0.2 + area * 0.15 + size * 0.15;

  // Genus is a gate rather than a term. A part with four holes and a part with none are not
  // 99% the same part however closely they weigh, and no weighting of continuous measures
  // expresses that — a plate with four ⌀9 holes differs from a solid block by 1% of volume.
  const topology = s.genus === rebuilt.genus;

  return {
    archetypeId: candidate.archetypeId,
    params: candidate.params,
    agreement: topology ? agreement : Math.min(agreement, 0.5),
    detail:
      `volume ${(volume * 100).toFixed(1)}%, section ${(shape * 100).toFixed(1)}%, ` +
      `inertia ${(inside * 100).toFixed(1)}%, surface ${(area * 100).toFixed(1)}%, ` +
      `envelope ${(size * 100).toFixed(1)}%` +
      (topology ? '' : `; ${s.genus} through-holes against ${rebuilt.genus}`),
  };
}

/** The two primitives that are not archetypes, built the way the document builds them. */
function primitive(kind: string, p: Record<string, number>): Mesh | null {
  if (kind === 'box') return box(p.length!, p.width!, p.height!, [0, 0, 0], 'Fitted');
  if (kind === 'cylinder') return cylinder(p.diameter! / 2, p.height!, [0, 0, 0], [0, 0, 1], 'Fitted');
  return null;
}

// ── the entry point ─────────────────────────────────────────────────────────

export interface FitOptions {
  /** Override the acceptance bar. Lowering it is a decision to accept looser examples. */
  accept?: number;
}

export function fitArchetype(mesh: Mesh, options: FitOptions = {}): FitResult {
  const accept = options.accept ?? ACCEPT;

  if (triCount(mesh) === 0) {
    return { best: null, considered: [], reason: 'There is no geometry to read.' };
  }

  const s = signatureOf(mesh);
  const considered: Fit[] = [];

  for (const propose of PROPOSERS) {
    const candidate = propose(s);
    if (!candidate) continue;
    const fit = score(s, candidate);
    if (fit) considered.push(fit);
  }

  considered.sort((a, b) => b.agreement - a.agreement);
  const best = considered[0];

  if (!best || best.agreement < accept) {
    return {
      best: null,
      considered,
      reason: best
        ? `The closest match is a ${best.archetypeId} at ${(best.agreement * 100).toFixed(1)}% ` +
          `agreement (${best.detail}), below the ${(accept * 100).toFixed(0)}% needed. ` +
          'The shape has detail no catalogue parameter describes.'
        : 'This shape is not close to anything in the catalogue.',
    };
  }

  return { best, considered };
}

// ── turning a fit into a feature ────────────────────────────────────────────

/**
 * The document feature a fit describes.
 *
 * Here rather than at the call sites because there are two of them — recognising the part on
 * screen, and recognising a folder of them in bulk — and the rule that a box and a cylinder
 * are primitives while everything else is an archetype is exactly the kind of detail that
 * gets written twice and then diverges.
 */
export function featureFromFit(fit: Fit): {
  kind: 'box' | 'cylinder' | 'archetype';
  params: Record<string, number | string>;
  name: string;
} {
  const primitive = fit.archetypeId === 'box' ? 'box'
    : fit.archetypeId === 'cylinder' ? 'cylinder'
    : null;

  const params: Record<string, number | string> = { ...fit.params, operation: 'add' };
  if (!primitive) params.archetypeId = fit.archetypeId;

  return {
    kind: primitive ?? 'archetype',
    params,
    name: archetypeById(fit.archetypeId)?.label ?? fit.archetypeId,
  };
}

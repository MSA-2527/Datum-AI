/**
 * Proposing how two parts go together.
 *
 * `solveMates` can position parts once it is told which faces relate to which. Deciding
 * *that* is the missing half, and it is the half that makes assembly generation useful
 * rather than a pile of parts at the origin. A generator that emits ten components and no
 * mates has produced a drawing, not a model: nothing updates when a part changes size, and
 * a person still has to click through thirty mate dialogues.
 *
 * ── What this does and does not decide ───────────────────────────────────────
 *
 * It proposes, ranked, with a reason attached to each proposal. It does not choose. Every
 * candidate carries a `why` in the words a reviewer needs — "⌀6.00 shaft in ⌀6.60 bore,
 * 0.60 mm clearance (ISO 273 medium)" — because an automatic mate nobody can interrogate
 * gets used once and then switched off.
 *
 * That split is deliberate and matches the rest of the system: geometry decides what is
 * *possible*, ranking decides what is *likely*, and a person decides what is *right*. If a
 * learned model is ever added here it belongs on the ranking, never on the generation —
 * a model cannot propose a mate against a face that does not exist, and it should not be
 * able to suppress one that does.
 *
 * ── Placement-free by design ─────────────────────────────────────────────────
 *
 * Inference works in each part's own coordinates and never looks at where the instances
 * currently sit. Proximity is a tempting signal and a bad one: it is exactly wrong for the
 * case that matters, where the generator has just dropped every component at the origin and
 * nothing is near anything on purpose.
 */

import { dot3, len3, mul3, norm3, sub3, type Vec3 } from '../math/vec';
import type { InstanceId, MateKind, MateRef } from './assembly';
import type { FaceGraph, FaceInfo } from '../topo/facegraph';
import type { Hole, HolePattern } from '../topo/holes';

export interface PartFaces {
  instance: InstanceId;
  graph: FaceGraph;
  holes: Hole[];
  patterns: HolePattern[];
}

export interface MateCandidate {
  kind: MateKind;
  a: MateRef;
  b: MateRef;
  value?: number;
  /** 0..1. Above 0.8 is worth applying without asking; below 0.4 is a suggestion. */
  score: number;
  /** The justification, phrased for a person deciding whether to accept it. */
  why: string;
  /** Faces involved on each side, so the viewport can highlight what was matched. */
  faces: { a: number[]; b: number[] };
  /**
   * Set when the proposal is only partial because the mate vocabulary cannot express the
   * rest of it. See the note on seat mates below.
   */
  incomplete?: string;
}

export interface InferOptions {
  /** Candidates below this are dropped rather than shown. */
  minScore?: number;
  /** Most candidates to return. */
  limit?: number;
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * Every plausible way these two parts relate, best first.
 *
 * Bolt patterns are checked before individual holes on purpose. Four holes that match
 * another part's four holes is a far stronger statement than any one of those holes taken
 * alone, and reporting the pattern once beats reporting four coincidences that a person
 * then has to recognise as the same fact.
 */
export function inferMates(a: PartFaces, b: PartFaces, opts: InferOptions = {}): MateCandidate[] {
  const minScore = opts.minScore ?? 0.25;
  const limit = opts.limit ?? 12;

  const out: MateCandidate[] = [
    ...patternMates(a, b),
    ...pinInHoleMates(a, b),
    ...seatMates(a, b),
  ];

  return out
    .filter((c) => c.score >= minScore)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

// ── bolt patterns ────────────────────────────────────────────────────────────

/**
 * Matching hole patterns.
 *
 * Two parts carrying the same bolt circle, with the same number of holes at the same
 * diameter, are meant to bolt together. It is close to the strongest inference available
 * from geometry alone — a coincidence at that specificity is rare enough to act on.
 *
 * Two mates come out of one match: concentric on the pattern axis, which aligns and centres
 * them, and concentric on one hole pair, which clocks the rotation the first one leaves
 * free. Without the second the flange spins.
 */
function patternMates(a: PartFaces, b: PartFaces): MateCandidate[] {
  const out: MateCandidate[] = [];

  for (const pa of a.patterns) {
    for (const pb of b.patterns) {
      if (pa.kind !== pb.kind) continue;
      if (pa.holes.length !== pb.holes.length) continue;
      if (!close(pa.diameter, pb.diameter, 0.05)) continue;

      let score: number;
      let why: string;

      if (pa.kind === 'circular') {
        if (pa.boltCircle === undefined || pb.boltCircle === undefined) continue;
        if (!close(pa.boltCircle, pb.boltCircle, 0.01)) continue;
        score = 0.95;
        why = `${pa.holes.length}× ⌀${pa.diameter.toFixed(2)} on a ${pa.boltCircle.toFixed(1)} mm `
          + `bolt circle, matching on both parts`;
      } else {
        if (pa.pitch === undefined || pb.pitch === undefined) continue;
        if (!close(pa.pitch, pb.pitch, 0.01)) continue;
        score = 0.85;
        why = `${pa.holes.length}× ⌀${pa.diameter.toFixed(2)} at ${pa.pitch.toFixed(1)} mm pitch, `
          + `matching on both parts`;
      }

      const axisA = patternAxis(a, pa);
      const axisB = patternAxis(b, pb);
      if (!axisA || !axisB) continue;

      out.push({
        kind: 'concentric',
        a: { instance: a.instance, point: pa.centre, direction: axisA },
        b: { instance: b.instance, point: pb.centre, direction: axisB },
        score,
        why: `Pattern axes aligned — ${why}.`,
        faces: { a: patternFaces(a, pa), b: patternFaces(b, pb) },
      });

      // Clocking. One hole pair from each pattern removes the spin the pattern axis leaves.
      const ha = a.holes.find((h) => h.id === pa.holes[0]);
      const hb = b.holes.find((h) => h.id === pb.holes[0]);
      if (ha && hb) {
        out.push({
          kind: 'concentric',
          a: { instance: a.instance, point: ha.entry, direction: ha.axis },
          b: { instance: b.instance, point: hb.entry, direction: hb.axis },
          score: score - 0.05,
          why: 'One hole pair aligned, to clock the pattern. Without it the joint can spin.',
          faces: { a: ha.faces, b: hb.faces },
        });
      }
    }
  }

  return out;
}

/** A pattern's axis, taken from its first member; every member is parallel by construction. */
function patternAxis(p: PartFaces, pattern: HolePattern): Vec3 | null {
  const first = p.holes.find((h) => h.id === pattern.holes[0]);
  return first ? first.axis : null;
}

const patternFaces = (p: PartFaces, pattern: HolePattern): number[] =>
  pattern.holes.flatMap((id) => p.holes.find((h) => h.id === id)?.faces ?? []);

// ── shafts in bores ──────────────────────────────────────────────────────────

/**
 * A cylindrical feature on one part that fits a cylindrical feature on the other.
 *
 * Checked both ways round, because which part carries the pin and which carries the bore is
 * not something the caller should have to sort out first.
 */
function pinInHoleMates(a: PartFaces, b: PartFaces): MateCandidate[] {
  return [...fits(a, b), ...fits(b, a)];
}

function fits(shaftSide: PartFaces, boreSide: PartFaces): MateCandidate[] {
  const out: MateCandidate[] = [];

  const shafts = [...shaftSide.graph.faces.values()].filter((f) => f.role === 'shaft' && f.radius);
  const bores = [...boreSide.graph.faces.values()].filter((f) => f.role === 'bore' && f.radius);

  for (const shaft of shafts) {
    for (const bore of bores) {
      const rated = rateFit(shaft.radius! * 2, bore.radius! * 2);
      if (!rated) continue;

      out.push({
        kind: 'concentric',
        a: { instance: shaftSide.instance, point: axisPoint(shaft), direction: shaft.axis },
        b: { instance: boreSide.instance, point: axisPoint(bore), direction: bore.axis },
        score: rated.score,
        why: rated.why,
        faces: { a: [shaft.id], b: [bore.id] },
      });
    }
  }

  return out;
}

const axisPoint = (f: FaceInfo): Vec3 => f.origin ?? f.centroid;

/**
 * How good a fit is, on diametral clearance.
 *
 * The bands are the ones a machinist would name. A clearance of a few hundredths is a
 * location fit; a few tenths is the ISO 273 medium clearance hole that most bolted joints
 * use; several millimetres is two unrelated cylinders that happen to be round.
 *
 * Interference beyond a light press is rejected outright rather than scored low. A 20 mm pin
 * cannot go in a 6 mm hole, and offering it at low confidence is noise in a list whose whole
 * value is that everything in it is worth reading.
 */
function rateFit(shaftDia: number, boreDia: number): { score: number; why: string } | null {
  const clearance = boreDia - shaftDia;
  const d = `⌀${shaftDia.toFixed(2)} in ⌀${boreDia.toFixed(2)}`;

  if (clearance < -0.05) return null;

  if (clearance < 0.02) {
    return { score: 0.9, why: `${d} — interference or transition fit, ${clearance.toFixed(3)} mm. A press fit.` };
  }
  if (clearance <= 0.2) {
    return { score: 0.88, why: `${d} — ${clearance.toFixed(2)} mm clearance, a location fit.` };
  }
  if (clearance <= 1.0) {
    return { score: 0.82, why: `${d} — ${clearance.toFixed(2)} mm clearance, the usual bolt hole (ISO 273 medium).` };
  }
  if (clearance <= 3.0 && clearance < shaftDia * 0.5) {
    return { score: 0.45, why: `${d} — ${clearance.toFixed(1)} mm clearance. Loose; check this is the intended pair.` };
  }

  // Far enough apart that roundness is the only thing these two have in common.
  return null;
}

// ── seating faces ────────────────────────────────────────────────────────────

/**
 * Large flat faces that could bear against each other.
 *
 * ── A gap in the mate vocabulary ─────────────────────────────────────────────
 *
 * Seating one flat face on another is the most common mate in mechanical assembly, and it
 * is not expressible with the kinds `solveMates` currently understands. It needs a
 * point-on-plane constraint: one residual, removing a single translation and leaving the
 * two in-plane slides and the spin free.
 *
 * `coincident` is point-to-point and removes all three translations, which is wrong — used
 * for a face mate it pins the two centroids together and will fight any bolt-pattern mate
 * applied alongside it. So these candidates carry only the orientation half, as an `angle`
 * of 180° between the outward normals, and say so in `incomplete`.
 *
 * Adding an `onPlane` kind to the solver is the fix; it is a handful of lines in the
 * residual switch. Emitting a wrong mate that happens to type-check is not.
 */
function seatMates(a: PartFaces, b: PartFaces): MateCandidate[] {
  const out: MateCandidate[] = [];

  const seatsA = topSeats(a.graph);
  const seatsB = topSeats(b.graph);

  for (const fa of seatsA) {
    for (const fb of seatsB) {
      // Similar size is the only evidence available without placement. Two faces an order
      // of magnitude apart in area are a boss on a baseplate, not a joint.
      const ratio = Math.min(fa.area, fb.area) / Math.max(fa.area, fb.area);
      if (ratio < 0.25) continue;

      out.push({
        kind: 'angle',
        value: 180,
        a: { instance: a.instance, point: fa.centroid, direction: fa.axis },
        b: { instance: b.instance, point: fb.centroid, direction: fb.axis },
        score: 0.4 + 0.3 * ratio,
        why: `Flat faces of similar size (${fa.area.toFixed(0)} and ${fb.area.toFixed(0)} mm²) `
          + 'turned to face each other.',
        faces: { a: [fa.id], b: [fb.id] },
        incomplete: 'Orientation only. Seating the faces together needs a point-on-plane mate, '
          + 'which the solver does not yet have.',
      });
    }
  }

  return out;
}

/** The biggest flat faces, one per direction, since opposite faces of a plate are one seat. */
function topSeats(g: FaceGraph, limit = 3): FaceInfo[] {
  const flat = g.byArea
    .map((id) => g.faces.get(id)!)
    .filter((f) => f.role === 'seat');

  const out: FaceInfo[] = [];
  for (const f of flat) {
    if (out.some((k) => Math.abs(dot3(k.axis, f.axis)) > 0.999)) continue;
    out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Relative comparison, so a tolerance means the same thing at 6 mm and at 600 mm. */
function close(x: number, y: number, rel: number): boolean {
  const scale = Math.max(Math.abs(x), Math.abs(y), 1e-9);
  return Math.abs(x - y) / scale <= rel;
}

/**
 * A one-line summary of what was proposed, for a log or a confirmation dialogue.
 *
 * Deliberately leads with the reason rather than the mate type: a person accepting a mate
 * is deciding whether the *reason* holds, not whether they wanted a concentric.
 */
export function describeCandidate(c: MateCandidate): string {
  const pct = Math.round(c.score * 100);
  const flag = c.incomplete ? ' [partial]' : '';
  return `${pct}% ${c.kind}${flag} — ${c.why}`;
}

/** Distance between two parallel axis lines, for callers checking a proposal by hand. */
export function axisOffset(pointA: Vec3, pointB: Vec3, axis: Vec3): number {
  const n = norm3(axis);
  const d = sub3(pointA, pointB);
  return len3(sub3(d, mul3(n, dot3(d, n))));
}

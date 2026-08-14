/**
 * Turning bore faces into holes, and holes into patterns.
 *
 * A counterbored hole is not one face. It is a large cylinder, a flat shoulder, a small
 * cylinder, and sometimes a conical bottom — four surfaces that a person calls "an M6
 * counterbore" without hesitating. Every feature that reasons about holes needs that name,
 * not the four surfaces:
 *
 *   - A drawing dimensions a hole once, as ⌀6.6 ⌵⌀11×6.5, not four times.
 *   - Position tolerance applies to a *pattern*. Four holes on a bolt circle share one
 *     feature control frame; four unrelated cylinders get four, which is both wrong and
 *     an immediate tell that the software does not understand the part.
 *   - A fastener mates to the hole's axis. Which of the four faces the axis came from is
 *     not something the caller should have to care about.
 *
 * Grouping is by axis *line*, not by axis direction. Two parallel holes 30 mm apart share a
 * direction and are emphatically not the same hole; conflating them is the failure that
 * turns a four-hole pattern into one hole with an impossible depth.
 *
 * Nothing here guesses. A group that does not read cleanly as a hole is reported as `simple`
 * with whatever was measured, and callers can see the face list and disagree.
 */

import { dot3, len3, mul3, norm3, sub3, type Vec3 } from '../math/vec';
import type { Mesh } from './mesh';
import { spanAlong, type FaceGraph, type FaceInfo } from './facegraph';

export type HoleKind = 'simple' | 'counterbore' | 'countersink';

export interface Hole {
  id: string;
  kind: HoleKind;
  /** Unit vector pointing *into* the material, from the opening. */
  axis: Vec3;
  /** A point on the axis at the mouth of the hole. */
  entry: Vec3;
  /** Working diameter — the one a fastener passes through. */
  diameter: number;
  /** Axial length of the whole feature. */
  depth: number;
  /** True when the hole exits the far side of the body. */
  through: boolean;
  /** Counterbore or countersink opening, when there is one. */
  headDiameter?: number;
  headDepth?: number;
  /** The faces this hole was recovered from, largest radius first. */
  faces: number[];
}

export type PatternKind = 'linear' | 'circular' | 'grid';

export interface HolePattern {
  id: string;
  kind: PatternKind;
  holes: string[];
  /** Nominal diameter shared by every member. */
  diameter: number;
  /** Bolt-circle diameter, for circular patterns. */
  boltCircle?: number;
  /** Centre of the bolt circle, or the first hole for a linear run. */
  centre: Vec3;
  /** Direction of a linear run. */
  direction?: Vec3;
  /** Spacing between adjacent members of a linear run. */
  pitch?: number;
}

/** Radii within this relative tolerance are the same nominal size. */
const R_TOL = 2e-3;

/** Axes within this angle are parallel. */
const PARALLEL = 0.9995;

// ── holes ────────────────────────────────────────────────────────────────────

export function findHoles(mesh: Mesh, graph: FaceGraph): Hole[] {
  const bores = [...graph.faces.values()].filter((f) => f.role === 'bore' && f.radius && f.origin);
  const groups = groupCoaxial(bores, graph.scale);

  return groups.map((group, i) => describeHole(mesh, group, `h${i + 1}`));
}

/**
 * Buckets bores that lie on the same axis line.
 *
 * Two conditions, both necessary. The axes must be parallel — checked on |dot| so that a
 * bore tagged with a reversed axis still joins its own counterbore — and the perpendicular
 * distance between the two axis *lines* must be near zero. Dropping the second condition is
 * the classic bug: every hole drilled in the same direction collapses into one.
 */
function groupCoaxial(bores: FaceInfo[], scale: number): FaceInfo[][] {
  const tol = Math.max(scale * 1e-3, 1e-4);
  const groups: FaceInfo[][] = [];

  for (const face of bores) {
    const axis = norm3(face.axis);
    const origin = face.origin!;

    const hit = groups.find((g) => {
      const ref = g[0];
      if (Math.abs(dot3(norm3(ref.axis), axis)) < PARALLEL) return false;

      // Perpendicular offset between the two axis lines.
      const d = sub3(origin, ref.origin!);
      const along = mul3(norm3(ref.axis), dot3(d, norm3(ref.axis)));
      return len3(sub3(d, along)) <= tol;
    });

    if (hit) hit.push(face);
    else groups.push([face]);
  }

  return groups;
}

/**
 * Reads one coaxial group as a hole.
 *
 * The working diameter is the *smallest* bore in the group, because that is the one a
 * fastener has to pass. The largest is the head recess, if it is meaningfully larger — a
 * 2% difference is tessellation noise, not a counterbore.
 *
 * Orientation is chosen so the axis points from the mouth into the material. Callers use it
 * to place fasteners, and a hole that reports its axis pointing out of the part puts every
 * screw in backwards.
 */
function describeHole(mesh: Mesh, group: FaceInfo[], id: string): Hole {
  const ref = group[0];
  const axis = norm3(ref.axis);
  const origin = ref.origin!;

  const sorted = [...group].sort((a, b) => (b.radius ?? 0) - (a.radius ?? 0));
  const rMax = sorted[0].radius!;
  const rMin = sorted[sorted.length - 1].radius!;

  // Axial span of the whole group, in the reference face's axis frame.
  let lo = Infinity, hi = -Infinity;
  for (const f of group) {
    const o = dot3(sub3(f.origin!, origin), axis);
    const [a, b] = f.extent ?? [0, 0];
    lo = Math.min(lo, o + a, o + b);
    hi = Math.max(hi, o + a, o + b);
  }

  const [bodyLo, bodyHi] = spanAlong(mesh, axis);
  const base = dot3(origin, axis);
  const slack = Math.max((bodyHi - bodyLo) * 1e-3, 1e-4);
  const through = base + lo <= bodyLo + slack && base + hi >= bodyHi - slack;

  // The wide end is the mouth. With no counterbore the group is one cylinder and either end
  // will do, so the end nearer the body surface is used.
  const wide = sorted[0];
  const wideMid = dot3(sub3(wide.origin!, origin), axis)
    + ((wide.extent?.[0] ?? 0) + (wide.extent?.[1] ?? 0)) / 2;
  const mouthAtHigh = wideMid > (lo + hi) / 2;

  const dir: Vec3 = mouthAtHigh ? mul3(axis, -1) : axis;
  const entryOffset = mouthAtHigh ? hi : lo;
  const entry = addAlong(origin, axis, entryOffset);

  const counterbored = rMax > rMin * (1 + 10 * R_TOL);
  let kind: HoleKind = 'simple';
  if (counterbored) {
    // A countersink tapers; the group then contains a conical face rather than a second
    // cylinder. Without one, a wider top is a counterbore.
    kind = group.some((f) => f.tag.kind === 'conical') ? 'countersink' : 'counterbore';
  }

  const hole: Hole = {
    id,
    kind,
    axis: dir,
    entry,
    diameter: rMin * 2,
    depth: hi - lo,
    through,
    faces: sorted.map((f) => f.id),
  };

  if (counterbored) {
    hole.headDiameter = rMax * 2;
    hole.headDepth = Math.abs((wide.extent?.[1] ?? 0) - (wide.extent?.[0] ?? 0));
  }

  return hole;
}

const addAlong = (p: Vec3, axis: Vec3, d: number): Vec3 =>
  [p[0] + axis[0] * d, p[1] + axis[1] * d, p[2] + axis[2] * d];

// ── patterns ─────────────────────────────────────────────────────────────────

/**
 * Groups holes into the patterns a drawing would dimension as one.
 *
 * Only same-size, same-direction holes are considered. Mixed sizes on one bolt circle do
 * happen, but calling them one pattern would put a single position tolerance on features
 * that need different ones, and being silent is better than being confidently wrong.
 *
 * Circular is tested before linear because three holes on a large bolt circle are very
 * nearly collinear, and a fit that explains all of them beats one that explains most.
 */
export function findPatterns(holes: Hole[]): HolePattern[] {
  const out: HolePattern[] = [];
  const used = new Set<string>();

  const families = new Map<string, Hole[]>();
  for (const h of holes) {
    const key = `${h.diameter.toFixed(3)}|${canonicalAxis(h.axis).map((v) => v.toFixed(3)).join(',')}`;
    const list = families.get(key);
    if (list) list.push(h); else families.set(key, [h]);
  }

  for (const family of families.values()) {
    if (family.length < 3) continue;

    const circular = fitCircle(family);
    if (circular) {
      out.push({ ...circular, id: `p${out.length + 1}`, kind: 'circular' });
      family.forEach((h) => used.add(h.id));
      continue;
    }

    const linear = fitLine(family);
    if (linear) {
      out.push({ ...linear, id: `p${out.length + 1}`, kind: 'linear' });
      family.forEach((h) => used.add(h.id));
    }
  }

  return out;
}

/** ±axis collapse, so holes drilled from opposite faces still count as one family. */
function canonicalAxis(a: Vec3): Vec3 {
  const n = norm3(a);
  const biggest = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0
    : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
  return n[biggest] < 0 ? mul3(n, -1) : n;
}

/**
 * A bolt circle, if every member sits on one.
 *
 * The centroid is the circle centre for any equally-spaced pattern, and near enough for an
 * unequal one that the radius check will still catch a member that does not belong. The
 * tolerance is relative to the radius: an absolute one rejects a good 200 mm bolt circle and
 * accepts a bad 5 mm one.
 */
function fitCircle(holes: Hole[]): Omit<HolePattern, 'id' | 'kind'> | null {
  const pts = holes.map((h) => h.entry);
  const centre = mul3(pts.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]] as Vec3, [0, 0, 0] as Vec3), 1 / pts.length);

  const radii = pts.map((p) => len3(sub3(p, centre)));
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  if (mean < 1e-6) return null;

  for (const r of radii) if (Math.abs(r - mean) / mean > 5e-3) return null;

  return {
    holes: holes.map((h) => h.id),
    diameter: holes[0].diameter,
    boltCircle: mean * 2,
    centre,
  };
}

/** A straight, evenly-pitched run. Uneven spacing is not a pattern; it is several holes. */
function fitLine(holes: Hole[]): Omit<HolePattern, 'id' | 'kind'> | null {
  const pts = holes.map((h) => h.entry);
  const dir = norm3(sub3(pts[pts.length - 1], pts[0]));
  if (len3(dir) < 0.5) return null;

  const projected = pts.map((p) => dot3(sub3(p, pts[0]), dir));
  for (let i = 0; i < pts.length; i++) {
    const along = mul3(dir, projected[i]);
    if (len3(sub3(sub3(pts[i], pts[0]), along)) > 1e-3) return null;
  }

  const order = [...projected].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < order.length; i++) gaps.push(order[i] - order[i - 1]);

  const pitch = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (pitch <= 1e-6) return null;
  for (const g of gaps) if (Math.abs(g - pitch) / pitch > 5e-3) return null;

  return {
    holes: holes.map((h) => h.id),
    diameter: holes[0].diameter,
    centre: pts[0],
    direction: dir,
    pitch,
  };
}

/** One line per hole, in the notation a drawing would use. */
export function describeHole_(h: Hole): string {
  const d = `⌀${h.diameter.toFixed(2)}`;
  const depth = h.through ? 'THRU' : `↧${h.depth.toFixed(2)}`;
  if (h.kind === 'counterbore') return `${d} ${depth} ⌵⌀${h.headDiameter?.toFixed(2)}↧${h.headDepth?.toFixed(2)}`;
  if (h.kind === 'countersink') return `${d} ${depth} ⌵⌀${h.headDiameter?.toFixed(2)}`;
  return `${d} ${depth}`;
}

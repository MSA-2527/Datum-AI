/**
 * Looking at what was actually built, before handing it over.
 *
 * ── The hole this fills ──
 *
 * `critique.ts` inspects an `AssemblyPlan`: it finds parts floating in space, parts swallowed
 * inside other parts, parts that missed the joint they were meant to make. It is good, and it
 * only ever ran on one of the four ways this application produces geometry. The plan route has a
 * plan; the script route, the edit route and the image route produce a *document* and no plan at
 * all — so the three newest and least predictable paths were the three that nothing inspected.
 *
 * That is the wrong way round. A plan is a list of named parts with stated placements, written by
 * a model that was given a schema; a script is free-form text. If only one of them is going to be
 * checked, it should be the script.
 *
 * ── What it measures, and against what ──
 *
 * Each component is rebuilt on its own — the same way the detail sheets recover them — so what is
 * measured is the part as it was made, not the part as it survives the union. Then:
 *
 *   - **Position**, by whether a component touches anything. A part floating clear of every other
 *     part is the single commonest way a generated assembly is wrong, and it is invisible in the
 *     text: every dimension is right, every material is right, and the boss is two millimetres off
 *     the face it should sit on.
 *   - **Containment**, by whether a component is wholly inside another. Sometimes deliberate — a
 *     core inside a casting — and usually a placement that lost its offset.
 *   - **Rotation**, by how near an angle is to a right angle without being one. `89.4°` is not a
 *     design decision; it is a number that came from somewhere else.
 *   - **Dimension**, against what the user asked for, where they asked for anything at all.
 *
 * ── What it does not do ──
 *
 * Reject. Every finding is reported with the measurement that produced it and the part is handed
 * over regardless. A part that is wrong in a way the user intended is common — an exploded view
 * has every component floating — and a checker that refuses to hand it over is a checker people
 * turn off. Being told is the useful part.
 */

import { bounds, triCount, type Mesh } from '../kernel/topo/mesh';
import type { Box3, Vec3 } from '../kernel/math/vec';
import { componentMeshes } from '../drafting/details';
import type { Document, EvaluatedDocument } from '../model/document';

export type InspectionKind =
  | 'floating'
  | 'swallowed'
  | 'askew'
  | 'oversize'
  | 'undersize';

export interface Inspection {
  kind: InspectionKind;
  /** The feature it is about. */
  feature: string;
  /** What is wrong, with the measurement that says so. */
  detail: string;
  severity: 'blocker' | 'warning' | 'advisory';
}

export interface InspectOptions {
  /**
   * Dimensions the user asked for, in millimetres, to check the result against.
   *
   * Only what they actually said. Checking against a size nobody asked for invents a requirement
   * and then reports the part for failing it.
   */
  wanted?: { length?: number; width?: number; height?: number };
  /** How far out a stated dimension may be before it is worth saying, as a fraction. */
  tolerance?: number;
}

/** A tenth off is a different part; a hundredth is rounding. */
const DEFAULT_TOLERANCE = 0.05;

/**
 * Everything worth saying about a built document.
 *
 * Empty means nothing was found, which is not the same as "correct" and is not reported as such
 * anywhere this is used.
 */
export function inspectDocument(
  doc: Document, evaluated: EvaluatedDocument, options: InspectOptions = {},
): Inspection[] {
  if (triCount(evaluated.mesh) === 0) return [];

  const parts = componentMeshes(doc, evaluated)
    .map((p) => ({ name: p.name, box: bounds(p.mesh), mesh: p.mesh }));

  const found: Inspection[] = [];

  /*
   * Scale-relative, because a tolerance in millimetres is right for exactly one size of part.
   * A tenth of a millimetre is a joint on a watch and a rounding error on a chassis, and a
   * fixed figure calls one of them wrong every time.
   */
  const whole = bounds(evaluated.mesh);
  const scale = Math.max(1e-6, longest(whole));
  const tol = scale * 1e-3;

  /*
   * Connected to the body, or off on its own.
   *
   * Asked pairwise — "does this part touch any other" — two parts that miss each other are both
   * reported, which is one problem stated twice and names the base plate as the thing in the
   * wrong place as readily as the boss. What a person means by "floating" is *not attached to
   * the main body*, so the parts are grouped by what touches what, the largest group is taken as
   * the body, and only what is outside it is reported.
   *
   * Largest by count rather than by volume, because a chassis is one part and its forty fasteners
   * are forty: the group with the most members is the one everything else was built around.
   */
  if (parts.length > 1) {
    const groups = connectedGroups(parts.map((p) => p.box), tol);
    const body = groups.reduce((a, b) => (b.length > a.length ? b : a), groups[0] ?? []);
    const attached = new Set(body);

    parts.forEach((part, i) => {
      if (attached.has(i)) return;

      found.push({
        kind: 'floating',
        feature: part.name,
        detail:
          `${part.name} touches nothing else. Its nearest neighbour is `
          + `${nearest(part.box, parts.filter((_, j) => j !== i).map((p) => p.box)).toFixed(1)} mm away, `
          + `against a part ${longest(whole).toFixed(0)} mm across.`,
        severity: 'warning',
      });
    });
  }

  for (const part of parts) {
    if (parts.length > 1) {
      const inside = parts.find((other) => other !== part && contains(other.box, part.box, tol));
      if (inside) {
        found.push({
          kind: 'swallowed',
          feature: part.name,
          detail: `${part.name} sits entirely inside ${inside.name}, so none of it can be seen.`,
          severity: 'advisory',
        });
      }
    }
  }

  // ── rotation ──
  for (const feature of doc.features) {
    if (feature.suppressed || !feature.placement) continue;

    for (const [axis, angle] of [
      ['RX', feature.placement.rx], ['RY', feature.placement.ry], ['RZ', feature.placement.rz],
    ] as const) {
      const off = offRightAngle(angle);
      if (off === null) continue;

      found.push({
        kind: 'askew',
        feature: feature.name,
        detail:
          `${feature.name} is turned ${angle.toFixed(2)}° about ${axis}, which is ${off.toFixed(2)}° `
          + 'off square. A deliberate angle is usually a round number; this one looks like it came '
          + 'from somewhere else.',
        severity: 'advisory',
      });
    }
  }

  // ── size against what was asked ──
  const wanted = options.wanted ?? {};
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const size: [number, number, number] = [
    whole.max[0] - whole.min[0], whole.max[1] - whole.min[1], whole.max[2] - whole.min[2],
  ];

  for (const [key, index, label] of [
    ['length', 0, 'long'], ['width', 1, 'wide'], ['height', 2, 'tall'],
  ] as const) {
    const asked = wanted[key];
    if (asked === undefined || !(asked > 0)) continue;

    const got = size[index]!;
    const off = (got - asked) / asked;
    if (Math.abs(off) <= tolerance) continue;

    found.push({
      kind: off > 0 ? 'oversize' : 'undersize',
      feature: doc.name,
      detail:
        `Asked for ${asked} mm ${label}; built ${got.toFixed(1)} mm — `
        + `${Math.abs(off * 100).toFixed(0)}% ${off > 0 ? 'over' : 'under'}.`,
      severity: 'warning',
    });
  }

  return found;
}

/** The findings as a sentence, or nothing when there were none. */
export function describeInspection(found: Inspection[]): string {
  if (found.length === 0) return '';

  const worst = found.filter((f) => f.severity !== 'advisory');
  const shown = (worst.length > 0 ? worst : found).slice(0, 3);

  return `${found.length} thing${found.length === 1 ? '' : 's'} to check: `
    + `${shown.map((f) => f.detail).join(' ')}`;
}

// ── the measurements ─────────────────────────────────────────────────────────

const longest = (b: Box3): number =>
  Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);

/**
 * Which parts are joined to which, as groups of indices.
 *
 * A plain flood fill over the "touches" relation. Quadratic in the number of parts and that is
 * the right trade: an assembly of sixty components is 3,600 box comparisons, which is nothing,
 * and anything cleverer would need a spatial index that has to be kept in step with the geometry.
 */
function connectedGroups(boxes: Box3[], tol: number): number[][] {
  const seen = new Set<number>();
  const groups: number[][] = [];

  for (let start = 0; start < boxes.length; start++) {
    if (seen.has(start)) continue;

    const group: number[] = [];
    const stack = [start];
    seen.add(start);

    while (stack.length > 0) {
      const i = stack.pop()!;
      group.push(i);

      for (let j = 0; j < boxes.length; j++) {
        if (seen.has(j) || !touches(boxes[i]!, boxes[j]!, tol)) continue;
        seen.add(j);
        stack.push(j);
      }
    }

    groups.push(group);
  }

  return groups;
}

/** True when two boxes meet or overlap, with touching counted as meeting. */
function touches(a: Box3, b: Box3, tol: number): boolean {
  for (let i = 0; i < 3; i++) {
    if (a.min[i]! - tol > b.max[i]! || b.min[i]! - tol > a.max[i]!) return false;
  }
  return true;
}

/** True when `outer` encloses `inner` on every axis. */
function contains(outer: Box3, inner: Box3, tol: number): boolean {
  for (let i = 0; i < 3; i++) {
    if (inner.min[i]! < outer.min[i]! - tol || inner.max[i]! > outer.max[i]! + tol) return false;
  }
  return true;
}

/** The gap to the nearest of a set of boxes, zero when it already touches one. */
function nearest(box: Box3, others: Box3[]): number {
  let best = Infinity;

  for (const other of others) {
    let d = 0;
    for (let i = 0; i < 3; i++) {
      const apart = Math.max(0, Math.max(box.min[i]! - other.max[i]!, other.min[i]! - box.max[i]!));
      d += apart * apart;
    }
    best = Math.min(best, Math.sqrt(d));
  }

  return Number.isFinite(best) ? best : 0;
}

/**
 * How far an angle is from the nearest right angle, when it is *near* one without being one.
 *
 * Null for an angle that is square, and null for one that is frankly oblique — 30° is a design
 * decision and 45° is a chamfer. What this catches is 89.4°, which nobody chose: it is a number
 * that arrived from a calculation, a transcription, or a model filling in a field.
 */
export function offRightAngle(deg: number): number | null {
  const wrapped = ((deg % 360) + 360) % 360;
  const nearestSquare = Math.round(wrapped / 90) * 90;
  const off = Math.abs(wrapped - nearestSquare);

  // Exactly square, or far enough away to be deliberate.
  if (off < 1e-6 || off > 5) return null;
  return off;
}

/** The overall size of a built document, for a caller that wants to state it. */
export function sizeOf(mesh: Mesh): Vec3 {
  const b = bounds(mesh);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

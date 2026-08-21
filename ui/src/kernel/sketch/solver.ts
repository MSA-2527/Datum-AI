/**
 * 2D sketch constraint solver.
 *
 * This is the mathematical heart of parametric CAD and the thing that most distinguishes a
 * real modeller from a drawing program. A sketch is a system of non-linear equations: each
 * constraint says something must be true (these points coincide, this line is 40 mm long,
 * these two are perpendicular) and the solver finds the geometry satisfying all of them at
 * once. Get it right and the model is *driven* by dimensions; get it wrong and the user is
 * pushing lines around by hand.
 *
 * ── The method ──
 *
 * Constraints are written as residual functions r(x) that are zero when satisfied. The
 * solver drives |r| to zero by Gauss-Newton with Levenberg-Marquardt damping:
 *
 *     (JᵀJ + λI) Δx = -Jᵀr
 *
 * The Jacobian J is derived analytically, not by finite differences. That is not an
 * optimisation — a numerical Jacobian loses half the available precision, and near a
 * tangency constraint (where the residual is already a difference of nearly equal lengths)
 * that is enough to stop the solver converging at all.
 *
 * The damping λ is what makes it robust. Pure Gauss-Newton takes the full linearised step,
 * which is superb near a solution and wildly divergent far from one — and "far from one" is
 * exactly where a user drags a point across the sketch. λ interpolates between Newton and
 * gradient descent: it is reduced on a successful step to regain quadratic convergence, and
 * increased on a failed one to fall back to a short, safe move.
 *
 * ── Degrees of freedom ──
 *
 * The solver also has to *diagnose*, not just solve, because the useful message is not
 * "failed" but "these two constraints contradict each other" or "this line can still slide".
 * Both come from the rank of J: comparing it to the variable count gives the remaining
 * degrees of freedom, comparing it to the constraint count reveals redundancy, and the null
 * space says which motions are still free — so the UI can show the user exactly what is
 * loose rather than just counting it.
 */

import { mat, nullSpace, rank, set, dampedNormalSolve, norm as vecNorm, type Matrix } from '../math/linalg';
import { type Vec2 } from '../math/vec';

// ── entities ─────────────────────────────────────────────────────────────────

export type EntityId = string;

export interface SketchPoint {
  id: EntityId;
  kind: 'point';
  x: number;
  y: number;
  /** Fixed points are excluded from the variable set entirely. */
  fixed?: boolean;
}

export interface SketchLine {
  id: EntityId;
  kind: 'line';
  start: EntityId;
  end: EntityId;
  construction?: boolean;
}

export interface SketchCircle {
  id: EntityId;
  kind: 'circle';
  centre: EntityId;
  radius: number;
  construction?: boolean;
}

export interface SketchArc {
  id: EntityId;
  kind: 'arc';
  centre: EntityId;
  start: EntityId;
  end: EntityId;
  construction?: boolean;
}

export type SketchEntity = SketchPoint | SketchLine | SketchCircle | SketchArc;

// ── constraints ──────────────────────────────────────────────────────────────

/**
 * Every relation the solver can hold.
 *
 * A runtime array rather than a bare type union, so the count is derivable from the code
 * instead of restated by hand in prose. The README said sixteen while this listed seventeen;
 * a number a document keeps separately is a number that drifts.
 */
export const CONSTRAINT_KINDS = [
  'coincident',      // two points occupy the same place
  'distance',        // two points a given distance apart
  'horizontal',      // a line is horizontal
  'vertical',        // a line is vertical
  'parallel',        // two lines are parallel
  'perpendicular',   // two lines meet at 90 degrees
  'equal',           // two lines the same length, or two circles the same radius
  'angle',           // two lines at a given angle
  'pointOnLine',     // a point lies on a line's infinite extension
  'pointOnCircle',   // a point lies on a circle
  'tangent',         // a line is tangent to a circle
  'concentric',      // two circles share a centre
  'symmetric',       // two points mirror across a line
  'radius',          // a circle has a given radius
  'fixX',            // a point's x is pinned
  'fixY',            // a point's y is pinned
  'sameRadius',      // two points equidistant from a third — what makes an arc an arc
] as const;

export type ConstraintKind = typeof CONSTRAINT_KINDS[number];

export interface Constraint {
  id: string;
  kind: ConstraintKind;
  /** Entity ids the constraint acts on; meaning depends on the kind. */
  entities: EntityId[];
  /** Driving value for dimensional constraints: length in mm, angle in degrees. */
  value?: number;
  /** Constraints from the user outrank ones inferred by the tool when resolving conflicts. */
  driven?: boolean;
}

// ── the sketch ───────────────────────────────────────────────────────────────

export interface Sketch {
  entities: Map<EntityId, SketchEntity>;
  constraints: Constraint[];
}

export function emptySketch(): Sketch {
  return { entities: new Map(), constraints: [] };
}

export type SolveStatus =
  | 'solved'          // every constraint satisfied
  | 'under'           // satisfied, but degrees of freedom remain
  | 'over'            // redundant constraints present, still satisfied
  | 'conflict'        // constraints cannot all be satisfied
  | 'diverged';       // the iteration did not settle

export interface SolveResult {
  status: SolveStatus;
  /** Entity positions after solving. */
  sketch: Sketch;
  iterations: number;
  /** Largest remaining residual, in mm or radians. */
  residual: number;
  /** How many independent motions the geometry still has. */
  degreesOfFreedom: number;
  /** Human-readable description of each remaining freedom. */
  freeDirections: string[];
  /** Constraint ids that are redundant or contradictory. */
  problemConstraints: string[];
  message: string;
}

// ── variable mapping ─────────────────────────────────────────────────────────

interface VarMap {
  /** Variable index for each point's x; -1 when the point is fixed. */
  index: Map<EntityId, number>;
  /** Ordered list of (entityId, component) for reporting. */
  labels: { id: EntityId; comp: 'x' | 'y' | 'r' }[];
  count: number;
}

function buildVarMap(sketch: Sketch): VarMap {
  const index = new Map<EntityId, number>();
  const labels: { id: EntityId; comp: 'x' | 'y' | 'r' }[] = [];
  let n = 0;

  for (const e of sketch.entities.values()) {
    if (e.kind === 'point' && !e.fixed) {
      index.set(e.id, n);
      labels.push({ id: e.id, comp: 'x' }, { id: e.id, comp: 'y' });
      n += 2;
    }
  }
  // Radii are variables too, so an "equal radius" constraint can move them.
  for (const e of sketch.entities.values()) {
    if (e.kind === 'circle') {
      index.set(`${e.id}#r`, n);
      labels.push({ id: e.id, comp: 'r' });
      n += 1;
    }
  }

  return { index, labels, count: n };
}

function readState(sketch: Sketch, vm: VarMap): Float64Array {
  const x = new Float64Array(vm.count);
  for (const e of sketch.entities.values()) {
    if (e.kind === 'point' && !e.fixed) {
      const i = vm.index.get(e.id)!;
      x[i] = e.x;
      x[i + 1] = e.y;
    }
    if (e.kind === 'circle') x[vm.index.get(`${e.id}#r`)!] = e.radius;
  }
  return x;
}

function writeState(sketch: Sketch, vm: VarMap, x: Float64Array): Sketch {
  const entities = new Map(sketch.entities);
  for (const e of sketch.entities.values()) {
    if (e.kind === 'point' && !e.fixed) {
      const i = vm.index.get(e.id)!;
      entities.set(e.id, { ...e, x: x[i], y: x[i + 1] });
    }
    if (e.kind === 'circle') {
      entities.set(e.id, { ...e, radius: Math.max(1e-6, x[vm.index.get(`${e.id}#r`)!]) });
    }
  }
  return { entities, constraints: sketch.constraints };
}

/** Reads a point's current coordinates, whether it is fixed or free. */
function pointAt(sketch: Sketch, vm: VarMap, x: Float64Array, id: EntityId): Vec2 {
  const e = sketch.entities.get(id);
  if (!e || e.kind !== 'point') return [0, 0];
  if (e.fixed) return [e.x, e.y];
  const i = vm.index.get(id)!;
  return [x[i], x[i + 1]];
}

/** Variable index of a point's x, or -1 when fixed. */
const px = (sketch: Sketch, vm: VarMap, id: EntityId): number => {
  const e = sketch.entities.get(id);
  return !e || e.kind !== 'point' || e.fixed ? -1 : vm.index.get(id)!;
};

// ── residuals and Jacobian ───────────────────────────────────────────────────

interface Row {
  residual: number;
  /** Partial derivatives: variable index to value. */
  grad: Map<number, number>;
  constraintId: string;
}

/**
 * Builds one residual row per scalar equation.
 *
 * Every derivative below is written out by hand. The temptation is to difference the
 * residual numerically and skip this, but a finite-difference Jacobian has roughly half the
 * significant digits of the residual itself, and several of these constraints (tangency,
 * perpendicularity near alignment) already involve subtracting nearly equal quantities. The
 * solver would then stall short of the tolerance and report a conflict where none exists.
 */
function buildRows(sketch: Sketch, vm: VarMap, x: Float64Array): Row[] {
  const rows: Row[] = [];

  const add = (constraintId: string, residual: number, grad: Map<number, number>) =>
    rows.push({ residual, grad, constraintId });

  for (const c of sketch.constraints) {
    switch (c.kind) {
      case 'coincident': {
        const [a, b] = c.entities;
        const pa = pointAt(sketch, vm, x, a), pb = pointAt(sketch, vm, x, b);
        const ia = px(sketch, vm, a), ib = px(sketch, vm, b);

        const gx = new Map<number, number>();
        if (ia >= 0) gx.set(ia, 1);
        if (ib >= 0) gx.set(ib, -1);
        add(c.id, pa[0] - pb[0], gx);

        const gy = new Map<number, number>();
        if (ia >= 0) gy.set(ia + 1, 1);
        if (ib >= 0) gy.set(ib + 1, -1);
        add(c.id, pa[1] - pb[1], gy);
        break;
      }

      case 'distance': {
        const [a, b] = c.entities;
        const pa = pointAt(sketch, vm, x, a), pb = pointAt(sketch, vm, x, b);
        const dx = pa[0] - pb[0], dy = pa[1] - pb[1];
        const d = Math.hypot(dx, dy);
        const target = c.value ?? 0;

        // Residual on distance itself rather than on squared distance: the squared form has
        // a vanishing gradient at zero separation, so coincident points could never be
        // pushed apart to reach a required spacing.
        //
        // At *exactly* zero separation even this form has no gradient, because the direction
        // to separate along is genuinely undefined — the residual is |p - q| and every
        // direction is equally valid. Picking +x breaks the symmetry so the solver has
        // somewhere to go; the first step moves the points apart and every step after that
        // uses the true direction. Leaving the row at zero instead would silently return the
        // points still coincident, which is what happened before.
        const degenerate = d < 1e-9;
        const ux = degenerate ? 1 : dx / d;
        const uy = degenerate ? 0 : dy / d;

        const g = new Map<number, number>();
        const ia = px(sketch, vm, a), ib = px(sketch, vm, b);
        if (ia >= 0) { g.set(ia, ux); g.set(ia + 1, uy); }
        if (ib >= 0) { g.set(ib, -ux); g.set(ib + 1, -uy); }
        add(c.id, d - target, g);
        break;
      }

      case 'horizontal':
      case 'vertical': {
        const line = sketch.entities.get(c.entities[0]);
        if (!line || line.kind !== 'line') break;
        const pa = pointAt(sketch, vm, x, line.start), pb = pointAt(sketch, vm, x, line.end);
        const ia = px(sketch, vm, line.start), ib = px(sketch, vm, line.end);

        const comp = c.kind === 'horizontal' ? 1 : 0;
        const g = new Map<number, number>();
        if (ia >= 0) g.set(ia + comp, 1);
        if (ib >= 0) g.set(ib + comp, -1);
        add(c.id, pa[comp] - pb[comp], g);
        break;
      }

      case 'parallel':
      case 'perpendicular': {
        const l1 = sketch.entities.get(c.entities[0]);
        const l2 = sketch.entities.get(c.entities[1]);
        if (!l1 || l1.kind !== 'line' || !l2 || l2.kind !== 'line') break;

        const a1 = pointAt(sketch, vm, x, l1.start), b1 = pointAt(sketch, vm, x, l1.end);
        const a2 = pointAt(sketch, vm, x, l2.start), b2 = pointAt(sketch, vm, x, l2.end);
        const u = [b1[0] - a1[0], b1[1] - a1[1]];
        const v = [b2[0] - a2[0], b2[1] - a2[1]];

        const ia1 = px(sketch, vm, l1.start), ib1 = px(sketch, vm, l1.end);
        const ia2 = px(sketch, vm, l2.start), ib2 = px(sketch, vm, l2.end);
        const g = new Map<number, number>();

        if (c.kind === 'parallel') {
          // Cross product zero. Normalising would introduce a singularity at zero length.
          const r = u[0] * v[1] - u[1] * v[0];
          if (ia1 >= 0) { bump(g, ia1, -v[1]); bump(g, ia1 + 1, v[0]); }
          if (ib1 >= 0) { bump(g, ib1, v[1]); bump(g, ib1 + 1, -v[0]); }
          if (ia2 >= 0) { bump(g, ia2, u[1]); bump(g, ia2 + 1, -u[0]); }
          if (ib2 >= 0) { bump(g, ib2, -u[1]); bump(g, ib2 + 1, u[0]); }
          add(c.id, r, g);
        } else {
          // Dot product zero.
          const r = u[0] * v[0] + u[1] * v[1];
          if (ia1 >= 0) { bump(g, ia1, -v[0]); bump(g, ia1 + 1, -v[1]); }
          if (ib1 >= 0) { bump(g, ib1, v[0]); bump(g, ib1 + 1, v[1]); }
          if (ia2 >= 0) { bump(g, ia2, -u[0]); bump(g, ia2 + 1, -u[1]); }
          if (ib2 >= 0) { bump(g, ib2, u[0]); bump(g, ib2 + 1, u[1]); }
          add(c.id, r, g);
        }
        break;
      }

      case 'angle': {
        const l1 = sketch.entities.get(c.entities[0]);
        const l2 = sketch.entities.get(c.entities[1]);
        if (!l1 || l1.kind !== 'line' || !l2 || l2.kind !== 'line') break;

        const a1 = pointAt(sketch, vm, x, l1.start), b1 = pointAt(sketch, vm, x, l1.end);
        const a2 = pointAt(sketch, vm, x, l2.start), b2 = pointAt(sketch, vm, x, l2.end);
        const u = [b1[0] - a1[0], b1[1] - a1[1]];
        const v = [b2[0] - a2[0], b2[1] - a2[1]];

        const cross = u[0] * v[1] - u[1] * v[0];
        const dotp = u[0] * v[0] + u[1] * v[1];
        const current = Math.atan2(cross, dotp);
        const target = ((c.value ?? 0) * Math.PI) / 180;

        // d(atan2(cross, dot)) folded through the quotient rule. Using atan2 rather than
        // acos keeps the sign of the angle, so 30 and -30 degrees are distinguishable.
        const denom = cross * cross + dotp * dotp;
        const s = denom < 1e-18 ? 0 : 1 / denom;

        const ia1 = px(sketch, vm, l1.start), ib1 = px(sketch, vm, l1.end);
        const ia2 = px(sketch, vm, l2.start), ib2 = px(sketch, vm, l2.end);
        const g = new Map<number, number>();

        const dCross = { u0: v[1], u1: -v[0], v0: -u[1], v1: u[0] };
        const dDot = { u0: v[0], u1: v[1], v0: u[0], v1: u[1] };
        const partial = (dc: number, dd: number) => s * (dotp * dc - cross * dd);

        if (ib1 >= 0) { bump(g, ib1, partial(dCross.u0, dDot.u0)); bump(g, ib1 + 1, partial(dCross.u1, dDot.u1)); }
        if (ia1 >= 0) { bump(g, ia1, -partial(dCross.u0, dDot.u0)); bump(g, ia1 + 1, -partial(dCross.u1, dDot.u1)); }
        if (ib2 >= 0) { bump(g, ib2, partial(dCross.v0, dDot.v0)); bump(g, ib2 + 1, partial(dCross.v1, dDot.v1)); }
        if (ia2 >= 0) { bump(g, ia2, -partial(dCross.v0, dDot.v0)); bump(g, ia2 + 1, -partial(dCross.v1, dDot.v1)); }

        // Wrap the residual into (-pi, pi] so the solver takes the short way round.
        let r = current - target;
        while (r > Math.PI) r -= 2 * Math.PI;
        while (r < -Math.PI) r += 2 * Math.PI;
        add(c.id, r, g);
        break;
      }

      case 'equal': {
        const e1 = sketch.entities.get(c.entities[0]);
        const e2 = sketch.entities.get(c.entities[1]);
        if (!e1 || !e2) break;

        if (e1.kind === 'circle' && e2.kind === 'circle') {
          const i1 = vm.index.get(`${e1.id}#r`)!, i2 = vm.index.get(`${e2.id}#r`)!;
          const g = new Map<number, number>([[i1, 1], [i2, -1]]);
          add(c.id, x[i1] - x[i2], g);
          break;
        }
        if (e1.kind === 'line' && e2.kind === 'line') {
          const a1 = pointAt(sketch, vm, x, e1.start), b1 = pointAt(sketch, vm, x, e1.end);
          const a2 = pointAt(sketch, vm, x, e2.start), b2 = pointAt(sketch, vm, x, e2.end);
          const d1 = Math.max(1e-9, Math.hypot(b1[0] - a1[0], b1[1] - a1[1]));
          const d2 = Math.max(1e-9, Math.hypot(b2[0] - a2[0], b2[1] - a2[1]));

          const g = new Map<number, number>();
          const ia1 = px(sketch, vm, e1.start), ib1 = px(sketch, vm, e1.end);
          const ia2 = px(sketch, vm, e2.start), ib2 = px(sketch, vm, e2.end);
          if (ib1 >= 0) { bump(g, ib1, (b1[0] - a1[0]) / d1); bump(g, ib1 + 1, (b1[1] - a1[1]) / d1); }
          if (ia1 >= 0) { bump(g, ia1, -(b1[0] - a1[0]) / d1); bump(g, ia1 + 1, -(b1[1] - a1[1]) / d1); }
          if (ib2 >= 0) { bump(g, ib2, -(b2[0] - a2[0]) / d2); bump(g, ib2 + 1, -(b2[1] - a2[1]) / d2); }
          if (ia2 >= 0) { bump(g, ia2, (b2[0] - a2[0]) / d2); bump(g, ia2 + 1, (b2[1] - a2[1]) / d2); }
          add(c.id, d1 - d2, g);
        }
        break;
      }

      case 'pointOnLine': {
        const p = c.entities[0];
        const line = sketch.entities.get(c.entities[1]);
        if (!line || line.kind !== 'line') break;

        const pp = pointAt(sketch, vm, x, p);
        const a = pointAt(sketch, vm, x, line.start), b = pointAt(sketch, vm, x, line.end);
        // Twice the signed triangle area: zero exactly when collinear.
        const r = (b[0] - a[0]) * (pp[1] - a[1]) - (b[1] - a[1]) * (pp[0] - a[0]);

        const g = new Map<number, number>();
        const ip = px(sketch, vm, p), ia = px(sketch, vm, line.start), ib = px(sketch, vm, line.end);
        if (ip >= 0) { bump(g, ip, -(b[1] - a[1])); bump(g, ip + 1, b[0] - a[0]); }
        if (ia >= 0) { bump(g, ia, b[1] - pp[1]); bump(g, ia + 1, pp[0] - b[0]); }
        if (ib >= 0) { bump(g, ib, pp[1] - a[1]); bump(g, ib + 1, a[0] - pp[0]); }
        add(c.id, r, g);
        break;
      }

      case 'pointOnCircle': {
        const p = c.entities[0];
        const circ = sketch.entities.get(c.entities[1]);
        if (!circ || circ.kind !== 'circle') break;

        const pp = pointAt(sketch, vm, x, p);
        const cc = pointAt(sketch, vm, x, circ.centre);
        const ir = vm.index.get(`${circ.id}#r`)!;
        const dx = pp[0] - cc[0], dy = pp[1] - cc[1];
        const d = Math.max(1e-9, Math.hypot(dx, dy));

        const g = new Map<number, number>();
        const ip = px(sketch, vm, p), ic = px(sketch, vm, circ.centre);
        if (ip >= 0) { bump(g, ip, dx / d); bump(g, ip + 1, dy / d); }
        if (ic >= 0) { bump(g, ic, -dx / d); bump(g, ic + 1, -dy / d); }
        bump(g, ir, -1);
        add(c.id, d - x[ir], g);
        break;
      }

      case 'tangent': {
        const line = sketch.entities.get(c.entities[0]);
        const circ = sketch.entities.get(c.entities[1]);
        if (!line || line.kind !== 'line' || !circ || circ.kind !== 'circle') break;

        const a = pointAt(sketch, vm, x, line.start), b = pointAt(sketch, vm, x, line.end);
        const cc = pointAt(sketch, vm, x, circ.centre);
        const ir = vm.index.get(`${circ.id}#r`)!;

        const ux = b[0] - a[0], uy = b[1] - a[1];
        const L = Math.max(1e-9, Math.hypot(ux, uy));

        // Perpendicular distance from the centre to the line, minus the radius:
        //   cross = ux (cy - ay) - uy (cx - ax),  f = |cross| / L - r
        const cross = ux * (cc[1] - a[1]) - uy * (cc[0] - a[0]);
        const dist = cross / L;
        const sgn = dist >= 0 ? 1 : -1;

        const g = new Map<number, number>();
        const ia = px(sketch, vm, line.start), ib = px(sketch, vm, line.end);
        const ic = px(sketch, vm, circ.centre);

        // Quotient rule on cross / L, with dL/dpoint folded in. Every one of these terms
        // had its sign inverted at first, and the symptom was not a failure to converge but
        // convergence to a *plausible wrong answer* — a line 33 mm from a 20 mm circle. A
        // Jacobian that points the wrong way still finds a stationary point of something,
        // just not of the constraint that was asked for.
        if (ic >= 0) {
          bump(g, ic, (sgn * -uy) / L);
          bump(g, ic + 1, (sgn * ux) / L);
        }
        if (ia >= 0) {
          // d(cross)/dax = by - cy;  d(cross)/day = cx - bx;  dL/da = -u / L
          bump(g, ia, sgn * ((b[1] - cc[1]) / L + (dist * ux) / (L * L)));
          bump(g, ia + 1, sgn * ((cc[0] - b[0]) / L + (dist * uy) / (L * L)));
        }
        if (ib >= 0) {
          // d(cross)/dbx = cy - ay;  d(cross)/dby = ax - cx;  dL/db = +u / L
          bump(g, ib, sgn * ((cc[1] - a[1]) / L - (dist * ux) / (L * L)));
          bump(g, ib + 1, sgn * ((a[0] - cc[0]) / L - (dist * uy) / (L * L)));
        }
        bump(g, ir, -1);
        add(c.id, sgn * dist - x[ir], g);
        break;
      }

      case 'concentric': {
        const c1 = sketch.entities.get(c.entities[0]);
        const c2 = sketch.entities.get(c.entities[1]);
        if (!c1 || !c2) break;
        const id1 = c1.kind === 'circle' || c1.kind === 'arc' ? c1.centre : null;
        const id2 = c2.kind === 'circle' || c2.kind === 'arc' ? c2.centre : null;
        if (!id1 || !id2) break;

        const p1 = pointAt(sketch, vm, x, id1), p2 = pointAt(sketch, vm, x, id2);
        const i1 = px(sketch, vm, id1), i2 = px(sketch, vm, id2);

        const gx = new Map<number, number>();
        if (i1 >= 0) gx.set(i1, 1);
        if (i2 >= 0) gx.set(i2, -1);
        add(c.id, p1[0] - p2[0], gx);

        const gy = new Map<number, number>();
        if (i1 >= 0) gy.set(i1 + 1, 1);
        if (i2 >= 0) gy.set(i2 + 1, -1);
        add(c.id, p1[1] - p2[1], gy);
        break;
      }

      case 'symmetric': {
        const [pa, pb, lineId] = c.entities;
        const line = sketch.entities.get(lineId);
        if (!line || line.kind !== 'line') break;

        const p1 = pointAt(sketch, vm, x, pa), p2 = pointAt(sketch, vm, x, pb);
        const a = pointAt(sketch, vm, x, line.start), b = pointAt(sketch, vm, x, line.end);
        const ux = b[0] - a[0], uy = b[1] - a[1];

        const i1 = px(sketch, vm, pa), i2 = px(sketch, vm, pb);
        const iaAx = px(sketch, vm, line.start), ibAx = px(sketch, vm, line.end);

        // Two conditions: the midpoint lies on the axis, and the chord is perpendicular
        // to it. Together those are exactly mirror symmetry.
        //
        // The axis endpoints are variables too, and omitting their derivatives is not a
        // harmless simplification — the solver would be free to move the axis without the
        // residual appearing to respond, so a symmetric pair about a movable centreline
        // would settle somewhere that is not symmetric at all.
        const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;

        const g1 = new Map<number, number>();
        const rMid = ux * (my - a[1]) - uy * (mx - a[0]);
        if (i1 >= 0) { bump(g1, i1, -uy / 2); bump(g1, i1 + 1, ux / 2); }
        if (i2 >= 0) { bump(g1, i2, -uy / 2); bump(g1, i2 + 1, ux / 2); }
        if (iaAx >= 0) {
          bump(g1, iaAx, uy - (my - a[1]));
          bump(g1, iaAx + 1, (mx - a[0]) - ux);
        }
        if (ibAx >= 0) {
          bump(g1, ibAx, my - a[1]);
          bump(g1, ibAx + 1, -(mx - a[0]));
        }
        add(c.id, rMid, g1);

        const g2 = new Map<number, number>();
        const dxp = p2[0] - p1[0], dyp = p2[1] - p1[1];
        const rPerp = ux * dxp + uy * dyp;
        if (i1 >= 0) { bump(g2, i1, -ux); bump(g2, i1 + 1, -uy); }
        if (i2 >= 0) { bump(g2, i2, ux); bump(g2, i2 + 1, uy); }
        if (iaAx >= 0) { bump(g2, iaAx, -dxp); bump(g2, iaAx + 1, -dyp); }
        if (ibAx >= 0) { bump(g2, ibAx, dxp); bump(g2, ibAx + 1, dyp); }
        add(c.id, rPerp, g2);
        break;
      }

      case 'radius': {
        const circ = sketch.entities.get(c.entities[0]);
        if (!circ || circ.kind !== 'circle') break;
        const ir = vm.index.get(`${circ.id}#r`)!;
        add(c.id, x[ir] - (c.value ?? 0), new Map([[ir, 1]]));
        break;
      }

      /*
       * The two ends of an arc are the same distance from its centre.
       *
       * One constraint, and exactly the right number: a centre, a start and an end are six
       * coordinates, and an arc has five degrees of freedom — centre, radius, and the two
       * angles. Without this the "arc" is three loose points that happen to be drawn with a
       * curve through them, and dragging any of them turns it into something that is not an
       * arc at all.
       *
       * On squared radii rather than radii. The gradient of the squared form never vanishes
       * where this is used — a point sitting exactly on the centre would be a zero-radius arc,
       * which is not a thing anyone draws — and it avoids two square roots and their
       * derivatives in the inner loop.
       */
      case 'sameRadius': {
        const [centre, start, end] = c.entities;
        const pc = pointAt(sketch, vm, x, centre);
        const ps = pointAt(sketch, vm, x, start);
        const pe = pointAt(sketch, vm, x, end);

        const sx = ps[0] - pc[0], sy = ps[1] - pc[1];
        const ex = pe[0] - pc[0], ey = pe[1] - pc[1];

        const g = new Map<number, number>();
        const ic = px(sketch, vm, centre);
        const is = px(sketch, vm, start);
        const ie = px(sketch, vm, end);

        if (is >= 0) { g.set(is, 2 * sx); g.set(is + 1, 2 * sy); }
        if (ie >= 0) { g.set(ie, -2 * ex); g.set(ie + 1, -2 * ey); }
        if (ic >= 0) {
          g.set(ic, -2 * sx + 2 * ex);
          g.set(ic + 1, -2 * sy + 2 * ey);
        }

        add(c.id, (sx * sx + sy * sy) - (ex * ex + ey * ey), g);
        break;
      }

      case 'fixX':
      case 'fixY': {
        const p = c.entities[0];
        const i = px(sketch, vm, p);
        if (i < 0) break;
        const comp = c.kind === 'fixX' ? 0 : 1;
        const pp = pointAt(sketch, vm, x, p);
        add(c.id, pp[comp] - (c.value ?? 0), new Map([[i + comp, 1]]));
        break;
      }
    }
  }

  return rows;
}

const bump = (g: Map<number, number>, i: number, v: number): void => {
  g.set(i, (g.get(i) ?? 0) + v);
};

// ── the solve ────────────────────────────────────────────────────────────────

export interface SolveOptions {
  maxIterations?: number;
  /** Convergence threshold on the largest residual. */
  tolerance?: number;
}

export function solve(sketch: Sketch, opts: SolveOptions = {}): SolveResult {
  const maxIter = opts.maxIterations ?? 100;
  const tol = opts.tolerance ?? 1e-9;

  const vm = buildVarMap(sketch);

  if (vm.count === 0) {
    return {
      status: 'solved', sketch, iterations: 0, residual: 0,
      degreesOfFreedom: 0, freeDirections: [], problemConstraints: [],
      message: 'Every entity is fixed, so there was nothing to solve.',
    };
  }

  let x = readState(sketch, vm);
  let rows = buildRows(sketch, vm, x);

  if (rows.length === 0) {
    const dof = vm.count;
    return {
      status: 'under', sketch, iterations: 0, residual: 0,
      degreesOfFreedom: dof,
      freeDirections: ['Nothing is constrained yet.'],
      problemConstraints: [],
      message: `${dof} degrees of freedom and no constraints. The sketch can move freely.`,
    };
  }

  // Levenberg-Marquardt. λ starts small so the first step is close to full Newton, which is
  // right for the common case of a small edit to an already-solved sketch.
  let lambda = 1e-6;
  let iterations = 0;
  let residual = maxAbs(rows);

  while (iterations < maxIter && residual > tol) {
    iterations++;

    const J = jacobian(rows, vm.count);
    const r = Float64Array.from(rows.map((row) => row.residual));

    let stepped = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const delta = dampedNormalSolve(J, negate(r), lambda);
      if (!delta) { lambda *= 10; continue; }

      const trial = new Float64Array(x.length);
      for (let i = 0; i < x.length; i++) trial[i] = x[i] + delta[i];

      const trialRows = buildRows(writeState(sketch, vm, trial), vm, trial);
      const trialResidual = maxAbs(trialRows);

      if (trialResidual < residual) {
        // The step helped: accept it and trust the linearisation more next time.
        x = trial;
        rows = trialRows;
        residual = trialResidual;
        lambda = Math.max(1e-12, lambda * 0.3);
        stepped = true;
        break;
      }

      // It did not: distrust the linearisation and take a shorter, more gradient-like step.
      lambda *= 10;
      if (lambda > 1e12) break;
    }

    if (!stepped) break;
  }

  const solved = writeState(sketch, vm, x);
  const J = jacobian(rows, vm.count);
  const rk = rank(J);
  const dof = vm.count - rk;
  const redundant = rows.length - rk;

  const converged = residual <= Math.max(tol, 1e-7);

  // Diagnose. The order matters: an unsatisfied system is a conflict regardless of how many
  // degrees of freedom remain, because reporting "under-defined" for a sketch that cannot be
  // satisfied would send the user looking for the wrong thing.
  if (!converged) {
    return {
      status: iterations >= maxIter ? 'diverged' : 'conflict',
      sketch: solved, iterations, residual,
      degreesOfFreedom: dof,
      freeDirections: describeFreedoms(J, vm, solved),
      problemConstraints: worstConstraints(rows),
      message: iterations >= maxIter
        ? `Did not settle after ${iterations} iterations; the largest error is still ` +
          `${residual.toExponential(2)}. This usually means two constraints are fighting.`
        : `These constraints cannot all be satisfied at once. The largest remaining error is ` +
          `${residual.toExponential(2)}.`,
    };
  }

  if (dof > 0) {
    return {
      status: 'under', sketch: solved, iterations, residual,
      degreesOfFreedom: dof,
      freeDirections: describeFreedoms(J, vm, solved),
      problemConstraints: [],
      message: `Solved, with ${dof} degree${dof === 1 ? '' : 's'} of freedom still free.`,
    };
  }

  if (redundant > 0) {
    return {
      status: 'over', sketch: solved, iterations, residual,
      degreesOfFreedom: 0,
      freeDirections: [],
      problemConstraints: redundantConstraints(rows, vm.count),
      message:
        `Solved, but ${redundant} constraint${redundant === 1 ? ' is' : 's are'} redundant — ` +
        `already implied by the others. They are harmless here, but they will conflict the ` +
        `moment a dimension changes.`,
    };
  }

  return {
    status: 'solved', sketch: solved, iterations, residual,
    degreesOfFreedom: 0, freeDirections: [], problemConstraints: [],
    message: `Fully defined. Solved in ${iterations} iteration${iterations === 1 ? '' : 's'}.`,
  };
}

function jacobian(rows: Row[], nVars: number): Matrix {
  const J = mat(rows.length, nVars);
  for (let i = 0; i < rows.length; i++) {
    for (const [col, v] of rows[i].grad) set(J, i, col, v);
  }
  return J;
}

const negate = (v: Float64Array): Float64Array => {
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = -v[i];
  return out;
};

const maxAbs = (rows: Row[]): number => {
  let m = 0;
  for (const r of rows) { const a = Math.abs(r.residual); if (a > m) m = a; }
  return m;
};

/**
 * Turns the Jacobian's null space into sentences.
 *
 * "3 degrees of freedom" tells a user they are not finished. "The top edge can still slide
 * horizontally" tells them what to do next, and that is the difference between a solver that
 * is merely correct and one that is usable.
 */
function describeFreedoms(J: Matrix, vm: VarMap, sketch: Sketch): string[] {
  const ns = nullSpace(J);
  if (ns.cols === 0) return [];

  const out: string[] = [];

  for (let c = 0; c < Math.min(ns.cols, 6); c++) {
    // Find which variables participate most in this free motion.
    const contributions: { label: string; weight: number }[] = [];
    for (let r = 0; r < ns.rows; r++) {
      const w = Math.abs(ns.data[r * ns.cols + c]);
      if (w < 0.05) continue;
      const lab = vm.labels[r];
      if (!lab) continue;
      const e = sketch.entities.get(lab.id);
      const name = e ? lab.id : lab.id;
      contributions.push({ label: `${name}.${lab.comp}`, weight: w });
    }

    contributions.sort((a, b) => b.weight - a.weight);
    if (contributions.length === 0) continue;

    const named = contributions.slice(0, 3).map((x) => x.label).join(', ');
    const more = contributions.length > 3 ? ` and ${contributions.length - 3} more` : '';
    out.push(`${named}${more} can still move together.`);
  }

  return out;
}

/** Constraint ids with the largest residuals — the likely culprits in a conflict. */
function worstConstraints(rows: Row[]): string[] {
  const byConstraint = new Map<string, number>();
  for (const r of rows) {
    byConstraint.set(r.constraintId, Math.max(byConstraint.get(r.constraintId) ?? 0, Math.abs(r.residual)));
  }
  return [...byConstraint.entries()]
    .filter(([, v]) => v > 1e-7)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => id);
}

/**
 * Identifies which constraints are redundant.
 *
 * A row is redundant when removing it does not reduce the rank — its equation was already
 * implied by the others. Testing each in turn is O(n) rank computations, which is acceptable
 * for sketch-sized systems and gives an exact answer rather than a heuristic guess.
 */
function redundantConstraints(rows: Row[], nVars: number): string[] {
  const full = rank(jacobian(rows, nVars));
  const out: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    if (seen.has(rows[i].constraintId)) continue;
    const without = rows.filter((_, j) => j !== i);
    if (rank(jacobian(without, nVars)) === full) {
      out.push(rows[i].constraintId);
      seen.add(rows[i].constraintId);
    }
  }
  return out.slice(0, 8);
}

// ── construction helpers ─────────────────────────────────────────────────────

let uid = 0;
const nextId = (prefix: string) => `${prefix}${++uid}`;

export function addPoint(s: Sketch, x: number, y: number, fixed = false): SketchPoint {
  const p: SketchPoint = { id: nextId('p'), kind: 'point', x, y, fixed };
  s.entities.set(p.id, p);
  return p;
}

export function addLine(s: Sketch, a: SketchPoint, b: SketchPoint, construction = false): SketchLine {
  const l: SketchLine = { id: nextId('l'), kind: 'line', start: a.id, end: b.id, construction };
  s.entities.set(l.id, l);
  return l;
}

export function addCircle(s: Sketch, centre: SketchPoint, radius: number): SketchCircle {
  const c: SketchCircle = { id: nextId('c'), kind: 'circle', centre: centre.id, radius };
  s.entities.set(c.id, c);
  return c;
}

/**
 * An arc from `start` to `end` about `centre`, swept counter-clockwise.
 *
 * Counter-clockwise by convention, because three points do not say which way round the arc
 * goes and something has to. Drawing tools order their clicks to suit.
 *
 * The radius equality is added with it rather than left to the user. An arc whose ends are not
 * the same distance from its centre is not an arc, and making that the modeller's problem is
 * how a sketch ends up looking right and solving to something else.
 */
export function addArc(
  s: Sketch, centre: SketchPoint, start: SketchPoint, end: SketchPoint, construction = false,
): SketchArc {
  const a: SketchArc = {
    id: nextId('a'), kind: 'arc',
    centre: centre.id, start: start.id, end: end.id, construction,
  };
  s.entities.set(a.id, a);
  constrain(s, 'sameRadius', [centre, start, end]);
  return a;
}

export function constrain(
  s: Sketch, kind: ConstraintKind, entities: (SketchEntity | EntityId)[], value?: number,
): Constraint {
  const c: Constraint = {
    id: nextId('k'),
    kind,
    entities: entities.map((e) => (typeof e === 'string' ? e : e.id)),
    value,
    driven: true,
  };
  s.constraints.push(c);
  return c;
}

/** Current coordinates of a point, for reading results out of a solved sketch. */
export function coordsOf(s: Sketch, id: EntityId): Vec2 {
  const e = s.entities.get(id);
  return e && e.kind === 'point' ? [e.x, e.y] : [0, 0];
}

export function radiusOf(s: Sketch, id: EntityId): number {
  const e = s.entities.get(id);
  return e && e.kind === 'circle' ? e.radius : 0;
}

/** Converts a solved closed loop of lines into a profile the kernel can build from. */
export function toPolyline(s: Sketch, lineIds: EntityId[]): Vec2[] {
  const pts: Vec2[] = [];
  for (const id of lineIds) {
    const l = s.entities.get(id);
    if (!l || l.kind !== 'line') continue;
    pts.push(coordsOf(s, l.start));
  }
  return pts;
}

export { vecNorm };

// ── verification hooks ───────────────────────────────────────────────────────

/**
 * Exposes the residual vector and the analytic Jacobian, for tests.
 *
 * Every derivative in this file is written by hand, and a wrong one does not announce
 * itself: the solver still converges, just to the wrong geometry. The tangent constraint
 * shipped with all four of its line-endpoint signs inverted and produced a line 33 mm from
 * a 20 mm circle — a completely plausible-looking result. The only reliable defence is to
 * differentiate the residuals numerically and compare, which is what this exists for.
 */
export function __analyticJacobian(sketch: Sketch): {
  residuals: number[];
  rows: { constraintId: string; grad: Map<number, number> }[];
  varCount: number;
  /** Perturbs variable `i` by `h` and returns the resulting residual vector. */
  residualsAt: (i: number, h: number) => number[];
} {
  const vm = buildVarMap(sketch);
  const x = readState(sketch, vm);
  const rows = buildRows(sketch, vm, x);

  return {
    residuals: rows.map((r) => r.residual),
    rows: rows.map((r) => ({ constraintId: r.constraintId, grad: r.grad })),
    varCount: vm.count,
    residualsAt: (i: number, h: number) => {
      const t = Float64Array.from(x);
      t[i] += h;
      return buildRows(writeState(sketch, vm, t), vm, t).map((r) => r.residual);
    },
  };
}

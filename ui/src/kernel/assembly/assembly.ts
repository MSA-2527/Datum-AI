/**
 * Assemblies: instance trees, mates and interference.
 *
 * An assembly is a set of part instances plus the relationships that position them. The
 * relationships are the point — placing components by typing coordinates is a drawing, not a
 * model, because nothing updates when a part changes size.
 *
 * Mates are solved by the same Newton iteration as the sketch constraint solver, over a
 * different variable set: each free instance contributes six variables (three translation,
 * three rotation), and each mate contributes residuals that vanish when it is satisfied.
 * Reusing the solver rather than writing a second one means the damping, the rank analysis
 * and the degree-of-freedom reporting all come for free — and, more usefully, a bug fixed in
 * one is fixed in both.
 *
 * Rotations are represented as an axis-angle *increment* from the instance's current
 * orientation rather than as absolute Euler angles. Euler angles gimbal-lock, and a solver
 * that hits gimbal lock does not fail loudly — it silently loses a degree of freedom and
 * settles somewhere wrong.
 */

import {
  add3, boxOverlaps, cross3, dot3, len3, mul3, norm3, quatFromAxisAngle, quatMul,
  quatToMat4, matMul, sub3, translation, xformPoint, type Mat4, type Quat, type Vec3,
} from '../math/vec';
import { dampedNormalSolve, mat, nullSpace, pseudoInverseSolve, rank, set } from '../math/linalg';
import {
  bounds, massProperties, transformMesh, triCount, type Mesh,
} from '../topo/mesh';
import { boolean } from '../ops/boolean';

// ── instances ────────────────────────────────────────────────────────────────

export type InstanceId = string;

export interface PartInstance {
  id: InstanceId;
  /** Which part this instantiates; several instances can share one. */
  partId: string;
  name: string;
  position: Vec3;
  orientation: Quat;
  /** Fixed instances are excluded from the solve, and every assembly needs at least one. */
  fixed: boolean;
  /** Suppressed instances are kept in the tree but ignored by solving and interference. */
  suppressed?: boolean;
}

export interface Part {
  id: string;
  name: string;
  mesh: Mesh;
  /** g/cm³, for assembly mass. */
  density: number;
  material: string;
}

export type MateKind =
  | 'coincident'   // two points occupy the same place
  | 'concentric'   // two axes share a line
  | 'distance'     // two points a set distance apart
  | 'parallel'     // two directions are parallel
  | 'perpendicular'
  | 'angle'        // two directions at a set angle
  | 'lock';        // two instances rigidly fixed relative to each other

export interface MateRef {
  instance: InstanceId;
  /** Point in the part's own coordinates. */
  point?: Vec3;
  /** Direction in the part's own coordinates. */
  direction?: Vec3;
}

export interface Mate {
  id: string;
  kind: MateKind;
  a: MateRef;
  b: MateRef;
  /** Distance in mm, or angle in degrees. */
  value?: number;
  suppressed?: boolean;
}

export interface Assembly {
  parts: Map<string, Part>;
  instances: PartInstance[];
  mates: Mate[];
}

export function emptyAssembly(): Assembly {
  return { parts: new Map(), instances: [], mates: [] };
}

/** World transform of an instance. */
export function instanceTransform(i: PartInstance): Mat4 {
  return matMul(translation(i.position), quatToMat4(i.orientation));
}

/** An instance's mesh placed in assembly coordinates. */
export function placedMesh(asm: Assembly, i: PartInstance): Mesh | null {
  const part = asm.parts.get(i.partId);
  return part ? transformMesh(part.mesh, instanceTransform(i)) : null;
}

const worldPoint = (i: PartInstance, p: Vec3): Vec3 => xformPoint(instanceTransform(i), p);

const worldDir = (i: PartInstance, d: Vec3): Vec3 => {
  const m = quatToMat4(i.orientation);
  return norm3([
    m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
    m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
    m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
  ]);
};

// ── solving ──────────────────────────────────────────────────────────────────

export type MateStatus = 'solved' | 'under' | 'over' | 'conflict' | 'diverged';

export interface MateSolveResult {
  status: MateStatus;
  assembly: Assembly;
  iterations: number;
  residual: number;
  degreesOfFreedom: number;
  /** Instances that can still move, and roughly how. */
  freeInstances: string[];
  problemMates: string[];
  message: string;
}

interface VarMap {
  /** First variable index for each movable instance; six per instance. */
  index: Map<InstanceId, number>;
  order: InstanceId[];
  count: number;
}

function buildVarMap(asm: Assembly): VarMap {
  const index = new Map<InstanceId, number>();
  const order: InstanceId[] = [];
  let n = 0;

  for (const i of asm.instances) {
    if (i.fixed || i.suppressed) continue;
    index.set(i.id, n);
    order.push(i.id);
    n += 6;
  }
  return { index, order, count: n };
}

/**
 * Applies a solver state to the assembly.
 *
 * The three rotation variables are an axis-angle increment applied to the orientation the
 * instance had when the solve started, not absolute angles. That keeps every step a small
 * rotation about a well-defined axis and sidesteps gimbal lock entirely.
 */
function applyState(asm: Assembly, vm: VarMap, base: PartInstance[], x: Float64Array): Assembly {
  const instances = asm.instances.map((inst) => {
    const at = vm.index.get(inst.id);
    if (at === undefined) return inst;

    const original = base.find((b) => b.id === inst.id) ?? inst;
    const dx: Vec3 = [x[at], x[at + 1], x[at + 2]];
    const rot: Vec3 = [x[at + 3], x[at + 4], x[at + 5]];

    const angle = len3(rot);
    const orientation = angle < 1e-12
      ? original.orientation
      : quatMul(quatFromAxisAngle(mul3(rot, 1 / angle), angle), original.orientation);

    return { ...inst, position: add3(original.position, dx), orientation };
  });

  return { ...asm, instances };
}

interface Row {
  residual: number;
  grad: Map<number, number>;
  mateId: string;
}

/**
 * Residuals for every mate.
 *
 * The Jacobian here is computed by central differences rather than analytically. That is the
 * opposite of the choice made in the sketch solver, and deliberately so: a rigid-body
 * rotation derivative involves the quaternion chain rule through every referenced point, the
 * expressions are long, and a sign error in one of them is close to undetectable. There are
 * only six variables per instance and assemblies are small, so the extra evaluations cost
 * little — whereas a sketch has hundreds of variables and needs the precision an analytic
 * Jacobian gives.
 */
function buildRows(asm: Assembly, vm: VarMap, base: PartInstance[], x: Float64Array): Row[] {
  const residualsAt = (state: Float64Array): { value: number; mateId: string }[] => {
    const a = applyState(asm, vm, base, state);
    return mateResiduals(a);
  };

  const at = residualsAt(x);
  const rows: Row[] = at.map((r) => ({ residual: r.value, grad: new Map<number, number>(), mateId: r.mateId }));

  const h = 1e-6;
  for (let v = 0; v < vm.count; v++) {
    const plus = Float64Array.from(x); plus[v] += h;
    const minus = Float64Array.from(x); minus[v] -= h;

    const rp = residualsAt(plus);
    const rm = residualsAt(minus);

    for (let r = 0; r < rows.length; r++) {
      const d = (rp[r].value - rm[r].value) / (2 * h);
      if (Math.abs(d) > 1e-12) rows[r].grad.set(v, d);
    }
  }

  return rows;
}

/** Scalar residuals for every active mate, in a stable order. */
function mateResiduals(asm: Assembly): { value: number; mateId: string }[] {
  const byId = new Map(asm.instances.map((i) => [i.id, i]));
  const out: { value: number; mateId: string }[] = [];

  for (const m of asm.mates) {
    if (m.suppressed) continue;
    const ia = byId.get(m.a.instance);
    const ib = byId.get(m.b.instance);
    if (!ia || !ib) continue;

    switch (m.kind) {
      case 'coincident': {
        const pa = worldPoint(ia, m.a.point ?? [0, 0, 0]);
        const pb = worldPoint(ib, m.b.point ?? [0, 0, 0]);
        out.push({ value: pa[0] - pb[0], mateId: m.id });
        out.push({ value: pa[1] - pb[1], mateId: m.id });
        out.push({ value: pa[2] - pb[2], mateId: m.id });
        break;
      }

      case 'distance': {
        const pa = worldPoint(ia, m.a.point ?? [0, 0, 0]);
        const pb = worldPoint(ib, m.b.point ?? [0, 0, 0]);
        out.push({ value: len3(sub3(pa, pb)) - (m.value ?? 0), mateId: m.id });
        break;
      }

      case 'concentric': {
        // Two conditions: the axes are parallel, and a point on one lies on the other.
        const da = worldDir(ia, m.a.direction ?? [0, 0, 1]);
        const db = worldDir(ib, m.b.direction ?? [0, 0, 1]);
        const c = cross3(da, db);
        out.push({ value: c[0], mateId: m.id });
        out.push({ value: c[1], mateId: m.id });
        out.push({ value: c[2], mateId: m.id });

        const pa = worldPoint(ia, m.a.point ?? [0, 0, 0]);
        const pb = worldPoint(ib, m.b.point ?? [0, 0, 0]);
        const rel = sub3(pa, pb);
        // The component of the offset perpendicular to the axis must vanish; the component
        // along it is free, which is exactly the sliding freedom a concentric mate leaves.
        const perp = sub3(rel, mul3(db, dot3(rel, db)));
        out.push({ value: perp[0], mateId: m.id });
        out.push({ value: perp[1], mateId: m.id });
        out.push({ value: perp[2], mateId: m.id });
        break;
      }

      case 'parallel': {
        const c = cross3(worldDir(ia, m.a.direction ?? [0, 0, 1]), worldDir(ib, m.b.direction ?? [0, 0, 1]));
        out.push({ value: c[0], mateId: m.id });
        out.push({ value: c[1], mateId: m.id });
        out.push({ value: c[2], mateId: m.id });
        break;
      }

      case 'perpendicular': {
        const d = dot3(worldDir(ia, m.a.direction ?? [0, 0, 1]), worldDir(ib, m.b.direction ?? [0, 0, 1]));
        out.push({ value: d, mateId: m.id });
        break;
      }

      case 'angle': {
        const da = worldDir(ia, m.a.direction ?? [0, 0, 1]);
        const db = worldDir(ib, m.b.direction ?? [0, 0, 1]);
        const target = Math.cos(((m.value ?? 0) * Math.PI) / 180);
        out.push({ value: dot3(da, db) - target, mateId: m.id });
        break;
      }

      case 'lock': {
        const pa = worldPoint(ia, m.a.point ?? [0, 0, 0]);
        const pb = worldPoint(ib, m.b.point ?? [0, 0, 0]);
        out.push({ value: pa[0] - pb[0], mateId: m.id });
        out.push({ value: pa[1] - pb[1], mateId: m.id });
        out.push({ value: pa[2] - pb[2], mateId: m.id });

        const da = worldDir(ia, m.a.direction ?? [0, 0, 1]);
        const db = worldDir(ib, m.b.direction ?? [0, 0, 1]);
        const c = cross3(da, db);
        out.push({ value: c[0], mateId: m.id });
        out.push({ value: c[1], mateId: m.id });
        out.push({ value: c[2], mateId: m.id });
        break;
      }
    }
  }

  return out;
}

export function solveMates(asm: Assembly, maxIterations = 80, tolerance = 1e-8): MateSolveResult {
  const vm = buildVarMap(asm);
  const base = asm.instances.map((i) => ({ ...i }));

  const active = asm.mates.filter((m) => !m.suppressed);

  if (vm.count === 0) {
    return {
      status: 'solved', assembly: asm, iterations: 0, residual: 0,
      degreesOfFreedom: 0, freeInstances: [], problemMates: [],
      message: asm.instances.length === 0
        ? 'The assembly is empty.'
        : 'Every component is fixed, so there was nothing to solve.',
    };
  }

  if (active.length === 0) {
    return {
      status: 'under', assembly: asm, iterations: 0, residual: 0,
      degreesOfFreedom: vm.count,
      freeInstances: vm.order,
      problemMates: [],
      message:
        `${vm.order.length} component${vm.order.length === 1 ? ' is' : 's are'} unconstrained. ` +
        `Add mates, or fix a component to anchor the assembly.`,
    };
  }

  let x: Float64Array = new Float64Array(vm.count);
  let rows = buildRows(asm, vm, base, x);
  let residual = maxAbs(rows);
  let lambda = 1e-6;
  let iterations = 0;
  let stalls = 0;

  while (iterations < maxIterations && residual > tolerance) {
    iterations++;

    const J = jacobian(rows, vm.count);
    const r = Float64Array.from(rows.map((row) => row.residual));

    const tryStep = (delta: Float64Array | null): { rows: Row[]; residual: number; x: Float64Array } | null => {
      if (!delta) return null;
      const trial = new Float64Array(x.length);
      for (let i = 0; i < x.length; i++) trial[i] = x[i] + delta[i];
      if (!trial.every(Number.isFinite)) return null;

      const trialRows = buildRows(asm, vm, base, trial);
      const trialResidual = maxAbs(trialRows);
      return trialResidual < residual ? { rows: trialRows, residual: trialResidual, x: trial } : null;
    };

    // Minimum-norm Gauss-Newton first.
    //
    // An assembly system is almost always rank-deficient: six variables per component and
    // usually far fewer equations, because most mates deliberately leave freedoms. Solving
    // that through the damped normal equations means factoring a matrix whose condition
    // number is the damping ratio — around 1e12 once lambda has been reduced a few times —
    // and the step comes back too inaccurate to converge. The pseudo-inverse handles rank
    // deficiency exactly and returns the step that moves the components least, which is also
    // the one a user expects.
    let taken = tryStep(pseudoInverseSolve(J, negate(r)));

    // Fall back to progressively heavier damping when the full step overshoots.
    for (let attempt = 0; !taken && attempt < 12; attempt++) {
      taken = tryStep(dampedNormalSolve(J, negate(r), lambda));
      if (!taken) { lambda *= 10; if (lambda > 1e12) break; }
    }

    if (taken) {
      x = taken.x; rows = taken.rows; residual = taken.residual;
      lambda = Math.max(1e-12, lambda * 0.3);
      stalls = 0;
      continue;
    }

    // Stationary point.
    //
    // Some mates have a vanishing gradient at exactly the configuration a user starts from.
    // Two directions at precisely 90 degrees is the common one: the parallel residual is
    // cos(theta), whose derivative is zero at theta = 90, so every step is zero and the
    // solve reports a conflict for a mate that is perfectly satisfiable. Nudging the state
    // breaks the symmetry and lets the iteration find the descent direction that genuinely
    // exists a little way off.
    //
    // The nudge is a fixed pattern, not random, so the same assembly always solves to the
    // same answer — a solver whose result depends on chance is unusable in a parametric model.
    if (stalls < 3) {
      const nudge = new Float64Array(vm.count);
      const size = 0.01 * (stalls + 1);
      for (let i = 0; i < vm.count; i++) {
        // Rotation variables get the nudge; translations are never the stuck ones.
        nudge[i] = i % 6 >= 3 ? size * (((i * 7919) % 13) / 13 - 0.5) : 0;
      }
      for (let i = 0; i < x.length; i++) x[i] += nudge[i];
      rows = buildRows(asm, vm, base, x);
      residual = maxAbs(rows);
      lambda = 1e-6;
      stalls++;
      continue;
    }

    break;
  }

  const solved = applyState(asm, vm, base, x);
  const J = jacobian(rows, vm.count);
  const rk = rank(J);
  const dof = vm.count - rk;
  const redundant = rows.length - rk;
  const converged = residual <= Math.max(tolerance, 1e-6);

  if (!converged) {
    return {
      status: iterations >= maxIterations ? 'diverged' : 'conflict',
      assembly: solved, iterations, residual,
      degreesOfFreedom: dof,
      freeInstances: describeFree(J, vm),
      problemMates: worstMates(rows),
      message:
        `These mates cannot all be satisfied at once. The largest remaining error is ` +
        `${residual.toExponential(2)}. Check the ones listed — one of them is probably ` +
        `positioning a component that another mate has already fixed.`,
    };
  }

  if (dof > 0) {
    const free = describeFree(J, vm);
    return {
      status: 'under', assembly: solved, iterations, residual,
      degreesOfFreedom: dof, freeInstances: free, problemMates: [],
      message:
        `Mates solved, with ${dof} degree${dof === 1 ? '' : 's'} of freedom remaining. ` +
        (free.length > 0 ? `${free.join(', ')} can still move.` : ''),
    };
  }

  if (redundant > 0) {
    return {
      status: 'over', assembly: solved, iterations, residual,
      degreesOfFreedom: 0, freeInstances: [], problemMates: redundantMates(rows, vm.count),
      message:
        `Mates solved, but ${redundant} constraint${redundant === 1 ? ' is' : 's are'} ` +
        `redundant. They agree now, and they will fight each other as soon as a dimension ` +
        `changes.`,
    };
  }

  return {
    status: 'solved', assembly: solved, iterations, residual,
    degreesOfFreedom: 0, freeInstances: [], problemMates: [],
    message: `Fully constrained. Solved in ${iterations} iteration${iterations === 1 ? '' : 's'}.`,
  };
}

function jacobian(rows: Row[], n: number) {
  const J = mat(rows.length, n);
  for (let i = 0; i < rows.length; i++) for (const [c, v] of rows[i].grad) set(J, i, c, v);
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

/** Which instances participate in the assembly's remaining freedoms. */
function describeFree(J: ReturnType<typeof mat>, vm: VarMap): string[] {
  const ns = nullSpace(J);
  if (ns.cols === 0) return [];

  const moving = new Set<string>();
  for (let c = 0; c < ns.cols; c++) {
    for (let r = 0; r < ns.rows; r++) {
      if (Math.abs(ns.data[r * ns.cols + c]) < 0.05) continue;
      const id = vm.order[Math.floor(r / 6)];
      if (id) moving.add(id);
    }
  }
  return [...moving];
}

function worstMates(rows: Row[]): string[] {
  const worst = new Map<string, number>();
  for (const r of rows) worst.set(r.mateId, Math.max(worst.get(r.mateId) ?? 0, Math.abs(r.residual)));
  return [...worst.entries()].filter(([, v]) => v > 1e-6).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
}

function redundantMates(rows: Row[], n: number): string[] {
  const full = rank(jacobian(rows, n));
  const out: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    if (seen.has(rows[i].mateId)) continue;
    if (rank(jacobian(rows.filter((_, j) => j !== i), n)) === full) {
      out.push(rows[i].mateId);
      seen.add(rows[i].mateId);
    }
  }
  return out.slice(0, 8);
}

// ── interference ─────────────────────────────────────────────────────────────

export interface Interference {
  a: InstanceId;
  b: InstanceId;
  /** Overlapping volume, mm³. */
  volume: number;
  /** Overlap as a fraction of the smaller component's own volume. */
  fraction: number;
  /** True when the overlap is small enough to be a press fit rather than a mistake. */
  likelyPressFit: boolean;
}

/**
 * Finds components that occupy the same space.
 *
 * Bounding boxes are checked first, so the expensive boolean only runs on pairs that could
 * actually overlap. Without that an assembly of fifty parts would run 1,225 booleans, nearly
 * all of them on components at opposite ends of the machine.
 *
 * A small interference is reported separately from a large one because a few hundredths of a
 * millimetre is an interference *fit* — deliberate, and how bearings and dowels are
 * retained — while a large one is a mistake. Flagging both identically trains users to
 * ignore the check.
 *
 * The two are told apart by the overlap as a *fraction of the smaller component's volume*,
 * not by its absolute size. A pin pressed into a bore overlaps along a thin annular shell
 * whose absolute volume is small but whose extent is not — the cube root of that volume is
 * millimetres, so any depth-like measure classifies it as a collision. The fraction is a few
 * tenths of a percent for a genuine fit and tens of percent for a real clash, which
 * separates them cleanly at any scale.
 */
export function findInterference(asm: Assembly, pressFitFraction = 0.01): Interference[] {
  const active = asm.instances.filter((i) => !i.suppressed);
  const placed = active
    .map((i) => ({ inst: i, mesh: placedMesh(asm, i) }))
    .filter((p): p is { inst: PartInstance; mesh: Mesh } => p.mesh !== null && triCount(p.mesh) > 0);

  const boxes = placed.map((p) => bounds(p.mesh));
  const out: Interference[] = [];

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (!boxOverlaps(boxes[i], boxes[j], -1e-6)) continue;

      const r = boolean(placed[i].mesh, placed[j].mesh, 'intersection');
      const volume = Math.abs(massProperties(r.mesh).volume);
      if (volume < 1e-6) continue;

      const volA = Math.abs(massProperties(placed[i].mesh).volume);
      const volB = Math.abs(massProperties(placed[j].mesh).volume);
      const smaller = Math.min(volA, volB);
      const fraction = smaller > 1e-9 ? volume / smaller : 1;

      out.push({
        a: placed[i].inst.id,
        b: placed[j].inst.id,
        volume,
        fraction,
        likelyPressFit: fraction < pressFitFraction,
      });
    }
  }

  return out.sort((a, b) => b.volume - a.volume);
}

// ── properties ───────────────────────────────────────────────────────────────

export interface AssemblyProperties {
  massGrams: number;
  centreOfMass: Vec3;
  volume: number;
  instanceCount: number;
  uniquePartCount: number;
  byPart: { partId: string; name: string; count: number; eachGrams: number; totalGrams: number }[];
}

/**
 * Mass and centre of mass of the whole assembly.
 *
 * Centre of mass is the mass-weighted mean of the components' own centres, transformed into
 * assembly coordinates. Averaging the geometric centres instead — which is the easy mistake —
 * puts the answer badly wrong the moment one steel part sits among aluminium ones.
 */
export function assemblyProperties(asm: Assembly): AssemblyProperties {
  let totalMass = 0;
  let totalVolume = 0;
  let cx = 0, cy = 0, cz = 0;

  const counts = new Map<string, number>();

  for (const inst of asm.instances) {
    if (inst.suppressed) continue;
    const part = asm.parts.get(inst.partId);
    if (!part) continue;

    counts.set(inst.partId, (counts.get(inst.partId) ?? 0) + 1);

    const mp = massProperties(part.mesh);
    const volume = Math.abs(mp.volume);
    const mass = (volume / 1000) * part.density;

    const centre = xformPoint(instanceTransform(inst), mp.centroid);
    cx += centre[0] * mass;
    cy += centre[1] * mass;
    cz += centre[2] * mass;

    totalMass += mass;
    totalVolume += volume;
  }

  const byPart = [...counts.entries()].map(([partId, count]) => {
    const part = asm.parts.get(partId)!;
    const each = (Math.abs(massProperties(part.mesh).volume) / 1000) * part.density;
    return { partId, name: part.name, count, eachGrams: each, totalGrams: each * count };
  }).sort((a, b) => b.totalGrams - a.totalGrams);

  return {
    massGrams: totalMass,
    centreOfMass: totalMass > 0 ? [cx / totalMass, cy / totalMass, cz / totalMass] : [0, 0, 0],
    volume: totalVolume,
    instanceCount: asm.instances.filter((i) => !i.suppressed).length,
    uniquePartCount: counts.size,
    byPart,
  };
}

/** Bill of materials, rolled up by part. */
export function billOfMaterials(asm: Assembly): {
  item: number; quantity: number; partNumber: string; description: string;
  material: string; massGrams: number;
}[] {
  return assemblyProperties(asm).byPart.map((p, i) => {
    const part = asm.parts.get(p.partId)!;
    return {
      item: i + 1,
      quantity: p.count,
      partNumber: p.partId,
      description: p.name,
      material: part.material,
      massGrams: p.eachGrams,
    };
  });
}

// ── construction helpers ─────────────────────────────────────────────────────

let uid = 0;
const nextId = (prefix: string) => `${prefix}${++uid}`;

export function addPart(asm: Assembly, mesh: Mesh, name: string, material = 'Aluminium 6061-T6', density = 2.7): Part {
  const part: Part = { id: nextId('part'), name, mesh, density, material };
  asm.parts.set(part.id, part);
  return part;
}

export function addInstance(
  asm: Assembly, part: Part, position: Vec3 = [0, 0, 0], fixed = false, name?: string,
): PartInstance {
  const inst: PartInstance = {
    id: nextId('inst'),
    partId: part.id,
    name: name ?? `${part.name}<${asm.instances.filter((i) => i.partId === part.id).length + 1}>`,
    position,
    orientation: [0, 0, 0, 1],
    fixed,
  };
  asm.instances.push(inst);
  return inst;
}

export function addMate(asm: Assembly, kind: MateKind, a: MateRef, b: MateRef, value?: number): Mate {
  const m: Mate = { id: nextId('mate'), kind, a, b, value };
  asm.mates.push(m);
  return m;
}

/** Combines every placed instance into one mesh, for export or drawing. */
export function flattenAssembly(asm: Assembly): Mesh[] {
  return asm.instances
    .filter((i) => !i.suppressed)
    .map((i) => placedMesh(asm, i))
    .filter((m): m is Mesh => m !== null);
}

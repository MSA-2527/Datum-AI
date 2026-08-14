/**
 * Boolean operations on solids: union, difference, intersection.
 *
 * This is the operation everything else is built from. A pocket is a difference, a boss is
 * a union, a trim is an intersection, and a shell is a difference against an offset copy.
 * If booleans are unreliable the whole kernel is unreliable, so this file is written for
 * correctness first.
 *
 * ── Vertex classification, and why it is not the exact predicate ──
 *
 * The obvious way to make a BSP robust is to classify vertices with an exact orientation
 * predicate. That was the first thing tried here and it does not work, for a reason worth
 * recording so nobody re-introduces it.
 *
 * Splitting an edge that crosses a plane creates a new vertex by interpolation. That vertex
 * is only *approximately* on the plane — in floating point it cannot be otherwise. Ask an
 * exact predicate which side it lies on and the honest answer is "very slightly in front"
 * or "very slightly behind", never "on". So the piece that was just cut is still classified
 * as spanning the very plane that cut it, gets split again, produces another
 * almost-on-the-plane vertex, and recurses until the stack overflows. Exactness makes this
 * worse, not better: an epsilon test would have terminated.
 *
 * So classification uses the signed plane distance against a scale-relative epsilon. This
 * keeps the two properties that actually matter:
 *
 *   - **Termination.** A freshly interpolated split point sits within ~1e-14 mm of its
 *     plane, far inside the epsilon, so it classifies as coplanar and the piece does not
 *     span. Every split strictly reduces the work remaining.
 *   - **Consistency.** The test is a deterministic function of the point and the plane, so
 *     two triangles sharing a vertex always get the same answer for it. That is what
 *     prevents cracks, and an exact predicate was never required for it.
 *
 * The epsilon is 1e-11 mm scaled by coordinate magnitude — about ten picometres at unit
 * scale. It is comfortably above the ~1e-14 mm rounding error and comfortably below any
 * feature that could be manufactured, so nothing real is ever collapsed by it.
 *
 * Exact predicates remain in use where the inputs are original vertices rather than derived
 * ones: the profile triangulator relies on `orient2d` throughout, and there the exactness
 * genuinely does prevent failures.
 */

import {
  add3, cross3, dot3, lerp3, mul3, norm3, sub3, boxOverlaps, type Vec3,
} from '../math/vec';
import {
  MeshBuilder, bounds, compact, concatMeshes, getTriangle, health, repairTJunctions, triCount,
  type FaceTag, type Mesh,
} from '../topo/mesh';
import { manifoldBoolean, manifoldReady } from './manifold';

// ── polygons ─────────────────────────────────────────────────────────────────

interface Poly {
  /** Vertices in order, forming a convex or simple planar polygon. */
  v: Vec3[];
  /** Three points defining the plane. `pa` doubles as the reference point for `side`. */
  pa: Vec3;
  pb: Vec3;
  pc: Vec3;
  /** Unit normal, for coplanar orientation tests and for output winding. */
  n: Vec3;
  faceId: number;
  /** True once the polygon has been flipped, so its face tag normal can be corrected. */
  flipped: boolean;
}

function polyFromTriangle(a: Vec3, b: Vec3, c: Vec3, faceId: number): Poly | null {
  const n = cross3(sub3(b, a), sub3(c, a));
  const l = Math.hypot(n[0], n[1], n[2]);
  // Degenerate triangles carry no plane, so they cannot split anything and must not be
  // allowed to define a BSP node. Dropping them is safe: they have zero area.
  if (l < 1e-20) return null;
  return { v: [a, b, c], pa: a, pb: b, pc: c, n: [n[0] / l, n[1] / l, n[2] / l], faceId, flipped: false };
}

function flipPoly(p: Poly): Poly {
  return {
    v: [...p.v].reverse(),
    // Swapping two defining points reverses the plane's orientation with no arithmetic,
    // so the flipped plane is exactly the negation of the original rather than a
    // recomputation that could round differently.
    pa: p.pa, pb: p.pc, pc: p.pb,
    n: mul3(p.n, -1),
    faceId: p.faceId,
    flipped: !p.flipped,
  };
}

/**
 * Which side of `poly`'s plane the point `p` lies on.
 *
 * See the note at the top of the file: this deliberately uses a scale-relative epsilon
 * rather than an exact predicate, because interpolated split points are never exactly on
 * their plane and an exact test makes the recursion non-terminating.
 */
function side(poly: Poly, p: Vec3): -1 | 0 | 1 {
  const d = dot3(poly.n, sub3(p, poly.pa));

  // Scale the tolerance with the coordinates so a model in metres and the same model in
  // millimetres classify identically.
  const scale = Math.max(
    1,
    Math.abs(poly.pa[0]), Math.abs(poly.pa[1]), Math.abs(poly.pa[2]),
    Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]),
  );
  const eps = PLANE_EPS * scale;

  return d > eps ? 1 : d < -eps ? -1 : 0;
}

/** Ten picometres at unit scale: above the rounding error, below anything manufacturable. */
const PLANE_EPS = 1e-11;

/**
 * Classification codes.
 *
 * These are bit flags, not signs, and that matters: the spanning test below ORs two vertex
 * codes together and checks for 3. Using -1 for BACK would make `1 | -1` evaluate to -1,
 * the crossing case would never fire, and no split vertices would be inserted — the two
 * solids would interpenetrate with no new edges and the result would leak.
 */
const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;

/**
 * Depth cap for the tree.
 *
 * A healthy BSP over a few thousand polygons is twenty to forty deep. Anything approaching
 * this number means the splitter choice has degenerated, and the cap stops that becoming a
 * hang.
 *
 * Set high enough not to truncate a legitimately deep tree — an eight-hole flange needs more
 * than a couple of hundred — and low enough that `clipPolygons` and `clipTo`, which walk the
 * tree recursively, cannot exhaust the interpreter's own stack.
 */
const MAX_BSP_DEPTH = 600;

/**
 * Splits `poly` by the plane of `by`, appending the pieces to the four output lists.
 *
 * Coplanar polygons are routed by whether their normals agree with the splitting plane.
 * This is the case that decides whether two solids sharing a face produce a clean joint or
 * a doubled surface, and getting it wrong is why so many CSG implementations fail on the
 * simplest possible test — two cubes stacked exactly face to face.
 */
function splitPoly(
  by: Poly, poly: Poly,
  coplanarFront: Poly[], coplanarBack: Poly[], front: Poly[], back: Poly[],
): void {
  let polyType = 0;
  const types: number[] = new Array(poly.v.length);

  for (let i = 0; i < poly.v.length; i++) {
    const s = side(by, poly.v[i]);
    const t = s > 0 ? FRONT : s < 0 ? BACK : COPLANAR;
    polyType |= t;
    types[i] = t;
  }

  switch (polyType) {
    case COPLANAR:
      (dot3(by.n, poly.n) > 0 ? coplanarFront : coplanarBack).push(poly);
      break;
    case FRONT:
      front.push(poly);
      break;
    case BACK:
      back.push(poly);
      break;
    default: {
      const f: Vec3[] = [];
      const b: Vec3[] = [];
      for (let i = 0; i < poly.v.length; i++) {
        const j = (i + 1) % poly.v.length;
        const ti = types[i], tj = types[j];
        const vi = poly.v[i], vj = poly.v[j];

        if (ti !== BACK) f.push(vi);
        if (ti !== FRONT) b.push(vi);

        // Both flags present means this edge crosses the plane and needs a split vertex.
        if ((ti | tj) === SPANNING) {
          // The edge crosses the plane. Solve for the crossing parameter using the signed
          // plane distances; this is the only place a new vertex is created.
          const di = planeDistance(by, vi);
          const dj = planeDistance(by, vj);
          const denom = di - dj;
          const t = Math.abs(denom) < 1e-300 ? 0.5 : di / denom;
          const mid = lerp3(vi, vj, t);
          f.push(mid);
          b.push(mid);
        }
      }
      if (f.length >= 3) front.push({ ...poly, v: f });
      if (b.length >= 3) back.push({ ...poly, v: b });
      break;
    }
  }
}

/** Signed distance used only to place a split point, never to classify. */
function planeDistance(poly: Poly, p: Vec3): number {
  return dot3(poly.n, sub3(p, poly.pa));
}

// ── BSP tree ─────────────────────────────────────────────────────────────────

class Node {
  plane: Poly | null = null;
  front: Node | null = null;
  back: Node | null = null;
  polygons: Poly[] = [];

  /**
   * Depth below the root, fixed when the node is created.
   *
   * Held on the node rather than passed down through `build`, because `build` is called
   * again on an *existing* tree when two solids are merged. A parameter restarts at zero on
   * every such call, so the guard measured only the current descent and the real depth grew
   * without limit — which is how a tree deep enough to exhaust the interpreter's stack got
   * past a cap that was supposed to prevent exactly that.
   */
  constructor(polygons?: Poly[], readonly depth = 0) {
    if (polygons && polygons.length) this.build(polygons);
  }

  /**
   * Builds the tree.
   *
   * Splitter choice is the difference between a tree with n nodes and one with n^2. Rather
   * than always taking the first polygon — which on axis-aligned CAD geometry produces a
   * degenerate linear chain — this samples candidates and picks the one that splits fewest
   * others, the standard heuristic from the BSP literature.
   */
  build(polygons: Poly[]): void {
    if (!polygons.length) return;

    // Safety net. The epsilon classification makes non-termination impossible in theory, but
    // a boolean that hangs takes the whole UI thread with it, and no geometric result is
    // worth that. Beyond this depth the remaining polygons are kept as coplanar leaves: the
    // result may be imperfect, `health()` will say so, and the application survives.
    if (this.depth >= MAX_BSP_DEPTH) {
      this.polygons.push(...polygons);
      return;
    }

    if (!this.plane) this.plane = chooseSplitter(polygons);

    const front: Poly[] = [];
    const back: Poly[] = [];
    for (const p of polygons) {
      splitPoly(this.plane, p, this.polygons, this.polygons, front, back);
    }

    if (front.length) {
      if (!this.front) this.front = new Node(undefined, this.depth + 1);
      this.front.build(front);
    }
    if (back.length) {
      if (!this.back) this.back = new Node(undefined, this.depth + 1);
      this.back.build(back);
    }
  }

  /** Removes the parts of `polygons` that lie inside this solid. */
  clipPolygons(polygons: Poly[]): Poly[] {
    if (!this.plane) return [...polygons];

    let front: Poly[] = [];
    let back: Poly[] = [];
    for (const p of polygons) splitPoly(this.plane, p, front, back, front, back);

    if (this.front) front = this.front.clipPolygons(front);
    // No back child means everything behind this plane is inside the solid, so it goes.
    back = this.back ? this.back.clipPolygons(back) : [];

    return front.concat(back);
  }

  clipTo(other: Node): void {
    this.polygons = other.clipPolygons(this.polygons);
    this.front?.clipTo(other);
    this.back?.clipTo(other);
  }

  invert(): void {
    this.polygons = this.polygons.map(flipPoly);
    if (this.plane) this.plane = flipPoly(this.plane);
    const t = this.front;
    this.front = this.back ? this.back : null;
    this.back = t;
    this.front?.invert();
    this.back?.invert();
  }

  /**
   * Every polygon in the tree.
   *
   * Walked with an explicit stack rather than by recursion. This is called on the whole tree
   * at the end of every boolean, so it is the traversal most likely to hit the engine's own
   * stack limit — and unlike the split itself, it does no arithmetic that would justify the
   * risk.
   */
  allPolygons(out: Poly[] = []): Poly[] {
    const stack: Node[] = [this];
    while (stack.length > 0) {
      const node = stack.pop()!;
      out.push(...node.polygons);
      // Pushed back-first so front is popped first, preserving the order the recursive
      // version produced. The order is not cosmetic: `chooseSplitter` samples this list by
      // stride, so a different order picks different splitting planes and produces a
      // differently-shaped tree — which is enough to turn a working eight-hole flange into
      // an open solid.
      if (node.back) stack.push(node.back);
      if (node.front) stack.push(node.front);
    }
    return out;
  }
}

function chooseSplitter(polys: Poly[]): Poly {
  // Sampling a bounded number of candidates keeps build time linear while still avoiding
  // the pathological chains that a fixed choice produces on rectilinear parts.
  const sampleCount = Math.min(polys.length, 12);
  const stride = Math.max(1, Math.floor(polys.length / sampleCount));

  let best = polys[0];
  let bestScore = Infinity;

  for (let i = 0; i < polys.length; i += stride) {
    const candidate = polys[i];
    let splits = 0, front = 0, back = 0;

    for (let j = 0; j < polys.length; j += stride) {
      if (i === j) continue;
      let hasFront = false, hasBack = false;
      for (const v of polys[j].v) {
        const s = side(candidate, v);
        if (s > 0) hasFront = true;
        else if (s < 0) hasBack = true;
      }
      if (hasFront && hasBack) splits++;
      else if (hasFront) front++;
      else back++;
    }

    // Weight splits heavily: a split costs a permanent extra polygon, imbalance costs
    // only depth.
    const score = splits * 8 + Math.abs(front - back);
    if (score < bestScore) { bestScore = score; best = candidate; }
  }

  return best;
}

// ── mesh <-> polygon conversion ──────────────────────────────────────────────

function meshToPolys(m: Mesh): Poly[] {
  const out: Poly[] = [];
  for (let t = 0; t < triCount(m); t++) {
    const [a, b, c] = getTriangle(m, t);
    const p = polyFromTriangle(a, b, c, m.faceIds[t] ?? 0);
    if (p) out.push(p);
  }
  return out;
}

function polysToMesh(polys: Poly[], tagsA: Map<number, FaceTag>, tagsB: Map<number, FaceTag>, shift: number): Mesh {
  const mb = new MeshBuilder();

  const merged = new Map<number, FaceTag>();
  for (const [id, tag] of tagsA) merged.set(id, tag);
  for (const [id, tag] of tagsB) merged.set(id + shift, { ...tag, id: id + shift });

  for (const [id, tag] of merged) mb.tags.set(id, tag);

  for (const p of polys) {
    // Every polygon here is convex: it began as a triangle and every subsequent operation
    // was a plane cut, which preserves convexity.
    for (let i = 1; i + 1 < p.v.length; i++) {
      mb.triangle(p.v[0], p.v[i], p.v[i + 1], p.faceId);
    }
  }

  return mb.build();
}

// ── public operations ────────────────────────────────────────────────────────

export interface BooleanResult {
  mesh: Mesh;
  /** True when the result is a closed, orientable, manifold solid. */
  valid: boolean;
  /** Human-readable reason when `valid` is false. */
  diagnostic?: string;
}

export type BooleanOp = 'union' | 'difference' | 'intersection';

/**
 * Runs a boolean and checks the result.
 *
 * The check is not optional decoration. A boolean that silently returns an open mesh
 * produces a part with no defined volume, which then flows into mass, cost and the export
 * — and the user finds out at the machine shop. Reporting failure here means the feature
 * can be marked in error in the tree, which is what SOLIDWORKS does and what users expect.
 */
export function boolean(a: Mesh, b: Mesh, op: BooleanOp): BooleanResult {
  if (triCount(a) === 0) {
    // Union and difference with nothing are identities; intersection with nothing is empty.
    if (op === 'union') return finish(b, op);
    if (op === 'difference') return finish(a, op);
    return finish({ ...a }, op);
  }
  if (triCount(b) === 0) {
    return op === 'intersection' ? finish({ ...b, indices: new Uint32Array(0), faceIds: new Uint32Array(0) }, op) : finish(a, op);
  }

  // Manifold first, where it has loaded.
  //
  // It is guaranteed manifold by construction rather than by hoping the epsilons work out,
  // which is precisely where the BSP below runs out of road: a fillet stuck at ten edges of
  // twelve, a spoked wheel that would not merge, a bore through a fifty-tooth gear coming
  // back with two hundred open edges.
  //
  // Placed after the trivial cases and before the disjoint check so the cheap answers stay
  // cheap — there is no sense paying a WASM round trip to union two boxes that never touch.
  //
  // Falling through on null is the whole safety story. A missing WASM file, an environment
  // that cannot instantiate it, or a result Manifold itself flags as untrustworthy all end
  // up on the BSP path, which is where every one of these operations ran until now.
  const viaManifold = manifoldReady() ? manifoldBoolean(a, b, op) : null;
  if (viaManifold) return finish(viaManifold.mesh, op);

  // Disjoint bounding boxes: a union is a concatenation, a difference is a no-op, and an
  // intersection is empty. Skipping the BSP here is a large win on assemblies, where most
  // pairs never touch.
  const ba = bounds(a), bb = bounds(b);
  if (!boxOverlaps(ba, bb, 1e-9)) {
    if (op === 'difference') return finish(a, op);
    if (op === 'intersection') {
      return finish({ positions: new Float64Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0), tags: new Map() }, op);
    }
    // Disjoint union is just concatenation. Worth special-casing rather than leaving to the
    // general path, because combining many separated cutters — a bolt pattern, a set of
    // fillet tools — is a common operation and running a full BSP for each pair when none of
    // them touch is pure waste.
    return finish(concatMeshes([a, b]), op);
  }

  const shift = maxTagId(a) + 1;
  const polysA = meshToPolys(a);
  const polysB = meshToPolys(b).map((p) => ({ ...p, faceId: p.faceId + shift }));

  const A = new Node(polysA);
  const B = new Node(polysB);

  switch (op) {
    case 'union':
      // Remove each solid's interior portion of the other, then merge the shells.
      A.clipTo(B);
      B.clipTo(A);
      // B's remaining surface may still include faces coincident with A's; inverting,
      // re-clipping and inverting back removes exactly those duplicates.
      B.invert();
      B.clipTo(A);
      B.invert();
      A.build(B.allPolygons());
      break;

    case 'difference':
      // A - B is A intersected with the complement of B.
      A.invert();
      A.clipTo(B);
      B.clipTo(A);
      B.invert();
      B.clipTo(A);
      B.invert();
      A.build(B.allPolygons());
      A.invert();
      break;

    case 'intersection':
      // By De Morgan: A & B = !(!A | !B).
      A.invert();
      B.clipTo(A);
      B.invert();
      A.clipTo(B);
      B.clipTo(A);
      A.build(B.allPolygons());
      A.invert();
      break;
  }

  // Repair before validating. The BSP cuts each solid's faces at the points where the
  // other's edges cross them, and neighbouring faces get cut by different planes, so the
  // raw output is riddled with T-junctions — geometrically correct, topologically open.
  const mesh = compact(repairTJunctions(polysToMesh(A.allPolygons(), a.tags, b.tags, shift)));
  return finish(mesh, op);
}

function finish(mesh: Mesh, op: BooleanOp): BooleanResult {
  const h = health(mesh);
  if (h.closed && h.manifold) return { mesh, valid: true };

  const problems: string[] = [];
  if (h.boundaryEdges > 0) problems.push(`${h.boundaryEdges} open edge${h.boundaryEdges === 1 ? '' : 's'}`);
  if (h.nonManifoldEdges > 0) problems.push(`${h.nonManifoldEdges} non-manifold edge${h.nonManifoldEdges === 1 ? '' : 's'}`);

  return {
    mesh,
    valid: false,
    diagnostic:
      `The ${op} produced an open solid (${problems.join(', ')}). ` +
      'This usually means the two bodies touch along an edge or a face without overlapping ' +
      'in volume. Offsetting one of them slightly, or making the cut pass fully through, ' +
      'resolves it.',
  };
}

function maxTagId(m: Mesh): number {
  let max = 0;
  for (const id of m.tags.keys()) if (id > max) max = id;
  return max;
}

// ── convenience wrappers ─────────────────────────────────────────────────────

export const union = (a: Mesh, b: Mesh): BooleanResult => boolean(a, b, 'union');
export const subtract = (a: Mesh, b: Mesh): BooleanResult => boolean(a, b, 'difference');
export const intersect = (a: Mesh, b: Mesh): BooleanResult => boolean(a, b, 'intersection');

/**
 * Unions many solids.
 *
 * Folding left is quadratic in the worst case because the accumulator keeps growing. Pairing
 * up instead keeps each individual boolean small, which matters for a bolt pattern where
 * forty identical cutters are combined before a single subtraction.
 */
export function unionAll(meshes: Mesh[]): BooleanResult {
  if (meshes.length === 0) {
    return { mesh: { positions: new Float64Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0), tags: new Map() }, valid: true };
  }
  if (meshes.length === 1) return { mesh: meshes[0], valid: true };

  let level = meshes;
  let lastDiagnostic: string | undefined;

  while (level.length > 1) {
    const next: Mesh[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) { next.push(level[i]); continue; }
      const r = boolean(level[i], level[i + 1], 'union');
      if (!r.valid) lastDiagnostic = r.diagnostic;
      next.push(r.mesh);
    }
    level = next;
  }

  // Only report a problem if the *final* result has one. A pairwise step can be
  // momentarily open — two halves of a shape that a later union closes — and surfacing
  // that as a warning trains users to ignore warnings, which is worse than saying nothing.
  const h = health(level[0]);
  const valid = h.closed && h.manifold;
  return { mesh: level[0], valid, diagnostic: valid ? undefined : lastDiagnostic };
}

/** Subtracts many cutters from one body, combining them first so the BSP is built once. */
export function subtractAll(base: Mesh, cutters: Mesh[]): BooleanResult {
  if (cutters.length === 0) return { mesh: base, valid: true };
  const combined = unionAll(cutters);
  return boolean(base, combined.mesh, 'difference');
}

// ── half-space clipping ──────────────────────────────────────────────────────

/**
 * Cuts a solid with an infinite plane, keeping the half below the normal and capping the
 * opening so the result stays closed.
 *
 * Used by section views and by "cut with plane". Capping is the part that matters: an
 * uncapped cut leaves an open shell, and a section view of an open shell shows the inside
 * of the far wall rather than solid material, which is exactly backwards from what a
 * section is meant to communicate.
 */
export function clipByPlane(m: Mesh, origin: Vec3, normal: Vec3, capFaceId?: number): Mesh {
  const n = norm3(normal);
  const mb = new MeshBuilder();
  for (const [id, tag] of m.tags) mb.tags.set(id, tag);
  const capId = capFaceId ?? mb.addTag({ feature: 'section', kind: 'planar', normal: n, origin });

  const capEdges: [Vec3, Vec3][] = [];

  for (let t = 0; t < triCount(m); t++) {
    const tri = getTriangle(m, t);
    const fid = m.faceIds[t] ?? 0;
    const d = tri.map((p) => dot3(n, sub3(p, origin)));

    if (d[0] <= 0 && d[1] <= 0 && d[2] <= 0) {
      mb.triangle(tri[0], tri[1], tri[2], fid);
      continue;
    }
    if (d[0] >= 0 && d[1] >= 0 && d[2] >= 0) continue;

    const below: Vec3[] = [];
    const onPlane: Vec3[] = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if (d[i] <= 0) below.push(tri[i]);
      if ((d[i] < 0 && d[j] > 0) || (d[i] > 0 && d[j] < 0)) {
        const t01 = d[i] / (d[i] - d[j]);
        const mid = lerp3(tri[i], tri[j], t01);
        below.push(mid);
        onPlane.push(mid);
      }
    }

    for (let i = 1; i + 1 < below.length; i++) mb.triangle(below[0], below[i], below[i + 1], fid);
    if (onPlane.length === 2) capEdges.push([onPlane[0], onPlane[1]]);
  }

  // Stitch the cut edges into loops and fill them. The loops are the cross-section outline.
  for (const loop of chainEdges(capEdges)) {
    if (loop.length < 3) continue;
    const centre = loop.reduce((acc, p) => add3(acc, p), [0, 0, 0] as Vec3);
    const c = mul3(centre, 1 / loop.length);
    for (let i = 0; i < loop.length; i++) {
      const j = (i + 1) % loop.length;
      // Wind the cap so its normal points along +n, i.e. out of the solid.
      mb.triangle(c, loop[j], loop[i], capId);
    }
  }

  return compact(mb.build());
}

/** Joins loose segments into closed loops by matching endpoints on a spatial hash. */
function chainEdges(edges: [Vec3, Vec3][], tol = 1e-6): Vec3[][] {
  const key = (p: Vec3) => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)},${Math.round(p[2] / tol)}`;
  const adj = new Map<string, { pt: Vec3; links: string[] }>();

  for (const [a, b] of edges) {
    const ka = key(a), kb = key(b);
    if (ka === kb) continue;
    if (!adj.has(ka)) adj.set(ka, { pt: a, links: [] });
    if (!adj.has(kb)) adj.set(kb, { pt: b, links: [] });
    adj.get(ka)!.links.push(kb);
    adj.get(kb)!.links.push(ka);
  }

  const seen = new Set<string>();
  const loops: Vec3[][] = [];

  for (const start of adj.keys()) {
    if (seen.has(start)) continue;

    const loop: Vec3[] = [];
    let current = start;
    let previous = '';

    // Walk the chain until it returns to the start or dead-ends. A dead end means the
    // section cut was not closed, which happens on an already-open input mesh.
    for (let guard = 0; guard < adj.size + 1; guard++) {
      if (seen.has(current)) break;
      seen.add(current);
      const node = adj.get(current);
      if (!node) break;
      loop.push(node.pt);

      const next = node.links.find((l) => l !== previous && !seen.has(l))
        ?? node.links.find((l) => l === start && loop.length > 2);
      if (!next || next === start) break;
      previous = current;
      current = next;
    }

    if (loop.length >= 3) loops.push(loop);
  }

  return loops;
}

/**
 * Modifying operations: shell, fillet, chamfer, draft and patterns.
 *
 * These act on an existing solid rather than creating one. Between them and the four
 * builders in `build.ts` they cover the feature vocabulary a mechanical designer actually
 * uses day to day.
 *
 * A word on what fillet is and is not here. A true B-rep fillet replaces a face's edge with
 * an analytic blend surface and re-knits the topology; that requires surface-surface
 * intersection machinery this kernel does not have. What it does instead is the rolling-ball
 * construction executed with booleans: the material a ball of radius r cannot reach as it
 * rolls along the edge is precisely the material a fillet removes, so that region is built
 * and subtracted. The result is geometrically a genuine constant-radius fillet, not an
 * approximation of one — but it is tessellated rather than analytic, and it treats the edge
 * as a swept path rather than a topological entity.
 *
 * Edges are grouped into chains before any of this happens, because a tessellated circular
 * rim is fifty mesh edges and one design edge. The limits are stated on `filletEdges` and
 * enforced, rather than left for the user to discover.
 */

import {
  add3, cross3, dot3, len3, mul3, norm3, rotationAbout, sub3, distSq3,
  matMul, norm2, reflection, rotation, translation, xformPoint,
  type Mat4, type Vec2, type Vec3,
} from '../math/vec';
import {
  bounds, getTriangle, getVertex, health, orientOutward,
  transformMesh, triCount, triangleNormal, vertCount, type Mesh,
} from '../topo/mesh';
import { boolean, subtractAll, unionAll, type BooleanResult } from './boolean';
import { cylinder, extrude, linePath, planeFrom, revolve, sphere, sweep, torus, type Plane } from './build';
import {
  circleProfile, makeProfile, minimumFeatureSize, offsetProfile, type Profile,
} from '../sketch/profile';

// ── shell ────────────────────────────────────────────────────────────────────

export interface ShellOptions {
  /** Wall thickness, millimetres. Positive hollows inward. */
  thickness: number;
  /** Face tag ids to remove, leaving the interior open. */
  openFaces?: number[];
  feature?: string;
}

/**
 * Hollows a solid, optionally leaving faces open.
 *
 * The inner surface is built by moving every vertex inward along its own angle-weighted
 * normal, then the two shells are combined. Angle weighting rather than area weighting
 * matters at a corner: three faces meet at a box corner and the inner corner must land at
 * the intersection of the three offset planes, which the angle-weighted normal approximates
 * closely and the area-weighted one does not.
 *
 * Thickness is checked against the solid's own thinnest dimension first. Offsetting a wall
 * inward by more than half its thickness turns the surface inside out, and the boolean then
 * produces a self-intersecting body that looks plausible and has negative volume in places.
 * Refusing is the only honest answer, so the caller gets a diagnostic rather than a
 * corrupted part.
 */
export function shell(solid: Mesh, opts: ShellOptions): BooleanResult {
  const t = Math.abs(opts.thickness);
  if (t < 1e-6) return { mesh: solid, valid: true };

  const bb = bounds(solid);
  const size = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]];
  const smallest = Math.min(...size);

  if (t * 2 >= smallest) {
    return {
      mesh: solid,
      valid: false,
      diagnostic:
        `A wall of ${t} mm cannot fit: the body is only ${smallest.toFixed(2)} mm across at its ` +
        `narrowest, so two walls plus a cavity need more room than there is. ` +
        `Use less than ${(smallest / 2).toFixed(2)} mm.`,
    };
  }

  const inner = offsetSurface(solid, -t, opts.feature ?? 'Shell');
  if (triCount(inner) === 0) {
    return { mesh: solid, valid: false, diagnostic: 'The inner wall collapsed; the thickness is too large for this shape.' };
  }

  const open = new Set(opts.openFaces ?? []);

  if (open.size === 0) {
    // Closed shell: a cavity inside the solid. The inner surface is reversed so it bounds
    // a void rather than a second body.
    return boolean(solid, inner, 'difference');
  }

  // Open shell. Cut the cavity with a tool that extends out through the open faces, so the
  // opening is a real hole rather than a thin membrane left behind by the offset.
  const cutters: Mesh[] = [inner];
  for (const faceId of open) {
    const tool = openingTool(solid, faceId, t);
    if (tool) cutters.push(tool);
  }

  const combined = unionAll(cutters);
  const r = boolean(solid, combined.mesh, 'difference');
  return r;
}

/**
 * Builds the inner surface of a shell by offsetting vertices along their normals.
 *
 * Returns a solid bounded by that surface, wound the same way as the input so it can be
 * used directly as a subtraction tool.
 */
function offsetSurface(m: Mesh, distance: number, feature: string): Mesh {
  const n = vertCount(m);
  const accum = new Float64Array(n * 3);

  for (let t = 0; t < triCount(m); t++) {
    const ia = m.indices[t * 3], ib = m.indices[t * 3 + 1], ic = m.indices[t * 3 + 2];
    const a = getVertex(m, ia), b = getVertex(m, ib), c = getVertex(m, ic);
    const fn = triangleNormal(a, b, c);

    // Angle weighting: each face contributes in proportion to how much of the vertex's
    // solid angle it occupies, which is what makes the offset corner land in the right place.
    const corners: [number, Vec3, Vec3, Vec3][] = [[ia, a, b, c], [ib, b, c, a], [ic, c, a, b]];
    for (const [idx, p, q, r] of corners) {
      const e1 = sub3(q, p), e2 = sub3(r, p);
      const l1 = len3(e1), l2 = len3(e2);
      if (l1 < 1e-12 || l2 < 1e-12) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, dot3(e1, e2) / (l1 * l2))));
      accum[idx * 3] += fn[0] * ang;
      accum[idx * 3 + 1] += fn[1] * ang;
      accum[idx * 3 + 2] += fn[2] * ang;
    }
  }

  const positions = new Float64Array(m.positions.length);
  for (let i = 0; i < n; i++) {
    const nx = accum[i * 3], ny = accum[i * 3 + 1], nz = accum[i * 3 + 2];
    const l = Math.hypot(nx, ny, nz);
    const p = getVertex(m, i);
    if (l < 1e-12) {
      positions[i * 3] = p[0]; positions[i * 3 + 1] = p[1]; positions[i * 3 + 2] = p[2];
      continue;
    }
    positions[i * 3] = p[0] + (nx / l) * distance;
    positions[i * 3 + 1] = p[1] + (ny / l) * distance;
    positions[i * 3 + 2] = p[2] + (nz / l) * distance;
  }

  const tags = new Map(m.tags);
  for (const [id, tag] of tags) tags.set(id, { ...tag, feature });

  return orientOutward({ positions, indices: m.indices, faceIds: m.faceIds, tags });
}

/** A prism that punches out through an open face so the cavity actually opens. */
function openingTool(m: Mesh, faceId: number, thickness: number): Mesh | null {
  const pts: Vec3[] = [];
  for (let t = 0; t < triCount(m); t++) {
    if (m.faceIds[t] !== faceId) continue;
    pts.push(...getTriangle(m, t));
  }
  if (pts.length < 3) return null;

  const tag = m.tags.get(faceId);
  const normal = tag?.normal ?? faceNormalFromPoints(m, faceId);
  if (!normal) return null;

  // Project the face's points into its own plane and take their outline, inset by the wall
  // thickness so the rim survives.
  const pl = planeFrom(pts[0], normal);
  const local: Vec2[] = pts.map((p) => {
    const rel = sub3(p, pl.origin);
    return [dot3(rel, pl.u), dot3(rel, pl.v)];
  });

  const hull = convexHull2(local);
  if (hull.length < 3) return null;

  const inset = offsetProfile(makeProfile(hull), -thickness);
  if (inset.outer.length < 3) return null;

  // Extend well past the face so the cut is unambiguous, and start slightly inside so the
  // tool and the face are never exactly coplanar.
  const bb = bounds(m);
  const reach = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) + 10;

  return extrude(inset, { ...pl, origin: add3(pl.origin, mul3(normal, -reach / 2)) }, {
    distance: reach,
    feature: 'ShellOpening',
  });
}

function faceNormalFromPoints(m: Mesh, faceId: number): Vec3 | null {
  for (let t = 0; t < triCount(m); t++) {
    if (m.faceIds[t] !== faceId) continue;
    const [a, b, c] = getTriangle(m, t);
    return triangleNormal(a, b, c);
  }
  return null;
}

/** Andrew's monotone chain. */
function convexHull2(pts: Vec2[]): Vec2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;

  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// ── edge extraction ──────────────────────────────────────────────────────────

export interface SolidEdge {
  a: Vec3;
  b: Vec3;
  /** Dihedral angle in degrees. Above 180 is concave. */
  angleDeg: number;
  convex: boolean;
  faceA: number;
  faceB: number;
  /**
   * Outward normals of the two triangles meeting here.
   *
   * Taken from the triangles rather than from the face tags, because a face tag can only
   * carry one normal and a curved face does not have one — the tag for a cylindrical wall
   * stores its axis, which is not a surface normal at all. Every fillet and chamfer needs
   * the true normals *at this edge*, so they are captured where they are known.
   */
  normalA: Vec3;
  normalB: Vec3;
}

/**
 * Extracts the sharp edges of a solid — the ones a user would select to fillet.
 *
 * An edge is "sharp" when the two faces meeting along it turn by more than the crease
 * angle. Below that the edge is an artefact of tessellation, not a design feature, and
 * offering to fillet a cylinder's 50 internal wall seams would be useless.
 */
export function sharpEdges(m: Mesh, creaseDeg = 20): SolidEdge[] {
  const map = new Map<string, { tris: number[]; a: number; b: number }>();

  for (let t = 0; t < triCount(m); t++) {
    const idx = [m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2]];
    for (let e = 0; e < 3; e++) {
      const u = idx[e], v = idx[(e + 1) % 3];
      const k = u < v ? `${u},${v}` : `${v},${u}`;
      const hit = map.get(k);
      if (hit) hit.tris.push(t);
      else map.set(k, { tris: [t], a: Math.min(u, v), b: Math.max(u, v) });
    }
  }

  const out: SolidEdge[] = [];
  const cos = Math.cos((creaseDeg * Math.PI) / 180);

  for (const { tris, a, b } of map.values()) {
    if (tris.length !== 2) continue;

    const [p, q, r] = getTriangle(m, tris[0]);
    const [s, u, v] = getTriangle(m, tris[1]);
    const n0 = triangleNormal(p, q, r);
    const n1 = triangleNormal(s, u, v);

    const d = dot3(n0, n1);
    if (d > cos) continue;

    const pa = getVertex(m, a), pb = getVertex(m, b);

    // Convexity: does the second face's far vertex lie behind the first face's plane?
    const far = [s, u, v].find((w) => distSq3(w, pa) > 1e-12 && distSq3(w, pb) > 1e-12) ?? s;
    const convex = dot3(n0, sub3(far, pa)) < 0;

    out.push({
      a: pa, b: pb,
      angleDeg: (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI,
      convex,
      faceA: m.faceIds[tris[0]] ?? 0,
      faceB: m.faceIds[tris[1]] ?? 0,
      normalA: n0,
      normalB: n1,
    });
  }

  return out;
}

/** Sharp edges shared by the two given faces — the usual way a user picks a fillet. */
export function edgesBetweenFaces(m: Mesh, faceA: number, faceB: number): SolidEdge[] {
  return sharpEdges(m, 1).filter(
    (e) => (e.faceA === faceA && e.faceB === faceB) || (e.faceA === faceB && e.faceB === faceA),
  );
}

/**
 * Groups edges into connected chains sharing the same pair of faces.
 *
 * This is what makes filleting practical rather than merely possible. The rim of a revolved
 * cup is one edge to the user, but the tessellated mesh presents it as fifty separate
 * segments. Filleting each in turn costs fifty boolean operations against a growing solid —
 * tens of seconds — and leaves visible facet joints where consecutive tools meet. Treated as
 * one chain it is a single operation and a single continuous blend.
 */
export function edgeChains(edges: SolidEdge[], tol = 1e-6): SolidEdge[][] {
  const key = (p: Vec3) => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)},${Math.round(p[2] / tol)}`;

  const byPoint = new Map<string, number[]>();
  edges.forEach((e, i) => {
    for (const p of [e.a, e.b]) {
      const k = key(p);
      const list = byPoint.get(k);
      if (list) list.push(i); else byPoint.set(k, [i]);
    }
  });

  const used = new Array(edges.length).fill(false);
  const chains: SolidEdge[][] = [];

  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;
    used[start] = true;

    const chain = [edges[start]];

    // Walk outward from both ends. Only continue through a point where exactly two edges
    // meet and both share the same face pair — a junction of three edges is a corner, and
    // running a single blend through it would gouge the third face.
    for (const forward of [true, false]) {
      let tip = forward ? edges[start].b : edges[start].a;
      let guard = edges.length;

      while (guard-- > 0) {
        const candidates = (byPoint.get(key(tip)) ?? []).filter((i) => !used[i]);
        const next = candidates.find(
          (i) =>
            (edges[i].faceA === chain[0].faceA && edges[i].faceB === chain[0].faceB) ||
            (edges[i].faceA === chain[0].faceB && edges[i].faceB === chain[0].faceA),
        );
        if (next === undefined) break;

        used[next] = true;
        const e = edges[next];

        // Orient the edge so `a` is where the walk arrived and `b` is where it continues.
        // Without this the chain is merely a *set* of connected edges, and any consumer
        // that treats it as an ordered polygon — the plane fit in `circularChain`, the sweep
        // spine in the fillet — gets a scrambled vertex order and a meaningless answer.
        const sameEnd = key(e.a) === key(tip);
        const oriented = sameEnd ? e : { ...e, a: e.b, b: e.a };
        tip = oriented.b;

        if (forward) chain.push(oriented);
        else chain.unshift({ ...oriented, a: oriented.b, b: oriented.a });
      }
    }

    // The backward walk was prepended in reverse, so re-orient the whole chain end to end.
    chains.push(orientChain(chain, key));
  }

  return chains;
}

/** Makes a connected chain into a consistently directed path: each edge's `b` is the next's `a`. */
function orientChain(chain: SolidEdge[], key: (p: Vec3) => string): SolidEdge[] {
  if (chain.length < 2) return chain;

  const out: SolidEdge[] = [];
  let first = chain[0];

  // Decide the first edge's direction from whichever of its ends touches the second edge.
  const second = chain[1];
  if (key(first.a) === key(second.a) || key(first.a) === key(second.b)) {
    first = { ...first, a: first.b, b: first.a };
  }
  out.push(first);

  let tip = first.b;
  for (let i = 1; i < chain.length; i++) {
    const e = chain[i];
    const oriented = key(e.a) === key(tip) ? e : { ...e, a: e.b, b: e.a };
    out.push(oriented);
    tip = oriented.b;
  }

  return out;
}

/**
 * Recognises a chain that lies on a circle, and recovers its axis.
 *
 * Every revolved feature produces one, so this fast path covers cups, bottles, flanges,
 * shafts and pulleys — most of what gets filleted in practice.
 */
export function circularChain(chain: SolidEdge[]): { centre: Vec3; axis: Vec3; radius: number } | null {
  if (chain.length < 6) return null;

  const pts = chain.map((e) => e.a);
  const centre = mul3(pts.reduce((s, p) => add3(s, p), [0, 0, 0] as Vec3), 1 / pts.length);

  // Fit a plane through the points: the axis is the direction of least variance.
  let n: Vec3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const p = sub3(pts[i], centre);
    const q = sub3(pts[(i + 1) % pts.length], centre);
    n = add3(n, cross3(p, q));
  }
  if (len3(n) < 1e-9) return null;
  const axis = norm3(n);

  // Every point must be the same distance from the centre, and in the same plane.
  let rSum = 0;
  const radii: number[] = [];
  const offsets: number[] = [];
  for (const p of pts) {
    const rel = sub3(p, centre);
    offsets.push(Math.abs(dot3(rel, axis)));
    const r = len3(rel);
    radii.push(r);
    rSum += r;
  }

  const rMean = rSum / pts.length;
  if (rMean < 1e-6) return null;

  // Both tolerances are relative to the radius. An absolute planarity bound would reject a
  // perfectly good 500 mm circle for a deviation that is proportionally negligible, and
  // accept a 0.5 mm one that is visibly out of plane.
  for (const o of offsets) if (o / rMean > 1e-3) return null;
  for (const r of radii) if (Math.abs(r - rMean) / rMean > 2e-3) return null;

  return { centre, axis, radius: rMean };
}

// ── fillet and chamfer ───────────────────────────────────────────────────────

export interface FilletOptions {
  radius: number;
  /** Restrict to these faces. Omitted means every sharp edge on the body. */
  faces?: number[];
  /**
   * How `faces` is interpreted.
   *
   * `bounding` takes every edge that touches a listed face, which is what a user means by
   * "round this face" — they have clicked one thing and want its outline softened.
   * `between` takes only edges where *both* sides are listed, which is what they mean when
   * they have picked two faces and want the seam between them.
   */
  faceMatch?: 'bounding' | 'between';
  /**
   * Restrict to outside or inside edges. Both by default.
   *
   * A bracket's "inside fillet" means the concave corner where it is loaded, not every edge
   * on the part; asking for one and getting the other is a different component.
   */
  convexity?: 'convex' | 'concave';
  /** Only edges turning by at least this much. */
  minAngleDeg?: number;
  feature?: string;
}

/**
 * Rounds edges by the rolling-ball construction.
 *
 * The material a ball of radius r rolling along an edge cannot reach is, by definition,
 * exactly the material a fillet removes. So the tool is that unreachable region: the corner
 * block around the edge, minus the volume the ball sweeps out. Subtracting it on a convex
 * edge rounds the corner; on a concave edge the same region is added instead.
 *
 * Edges are processed as *chains*, not individually. A tessellated circular rim is fifty
 * mesh edges but one design edge, and treating them separately costs fifty boolean
 * operations against a growing solid and leaves facet joints where the tools meet. A closed
 * circular chain is recognised and handled with a single revolve, which is both exact and
 * roughly two orders of magnitude faster.
 *
 * Limitations, enforced rather than assumed:
 *   - The radius must be smaller than the chain it runs along, or the blend overruns its own
 *     edge and gouges the neighbouring face.
 *   - Chains meeting at a corner are blended independently. The result is a valid solid, but
 *     not the single spherical corner patch a B-rep kernel would construct there.
 */
export function filletEdges(solid: Mesh, opts: FilletOptions): BooleanResult {
  const r = Math.abs(opts.radius);
  if (r < 1e-6) return { mesh: solid, valid: true };

  const faceSet = opts.faces && opts.faces.length > 0 ? new Set(opts.faces) : null;
  const minAngle = opts.minAngleDeg ?? 20;
  const between = opts.faceMatch === 'between';

  const wanted = opts.convexity;

  const edges = sharpEdges(solid, minAngle).filter((e) => {
    if (wanted === 'convex' && !e.convex) return false;
    if (wanted === 'concave' && e.convex) return false;
    if (!faceSet) return true;
    return between
      ? faceSet.has(e.faceA) && faceSet.has(e.faceB)
      : faceSet.has(e.faceA) || faceSet.has(e.faceB);
  });

  if (edges.length === 0) {
    return {
      mesh: solid,
      valid: true,
      // Name every filter that was applied, because with two of them active the useful
      // information is which one emptied the set — "no edges matched" sends someone hunting
      // through a face selection when the answer is that they asked for inside corners on a
      // body that has none.
      diagnostic: describeNoEdges(faceSet, wanted),
    };
  }

  const chains = edgeChains(edges);
  const feature = opts.feature ?? 'Fillet';

  // Chain length, not individual edge length, is what bounds the radius: a rim made of
  // fifty 5 mm segments comfortably takes a 20 mm fillet, and rejecting it because one
  // segment is short would be wrong.
  const chainLengths = chains.map((c) => c.reduce((s, e) => s + len3(sub3(e.b, e.a)), 0));
  const longest = Math.max(...chainLengths);
  if (r >= longest / 2) {
    return {
      mesh: solid,
      valid: false,
      diagnostic:
        `A ${r} mm radius is too large: the longest edge available is ${longest.toFixed(2)} mm, ` +
        `and a blend cannot be wider than half the edge it runs along. ` +
        `Use less than ${(longest / 2).toFixed(2)} mm.`,
    };
  }

  let firstProblem: string | undefined;

  let tooShort = 0;
  let noTool = 0;
  let absorbed = 0;

  // Bound the work. Filleting is the most expensive thing this kernel does, and a part with
  // hundreds of chains would lock the interface for minutes with no way to stop it. The
  // longest chains are the ones a user cares about, so those are the ones kept.
  const MAX_CHAINS = 40;
  const order = chains
    .map((chain, i) => ({ chain, length: chainLengths[i] }))
    .sort((a, b) => b.length - a.length);
  const overflow = Math.max(0, order.length - MAX_CHAINS);

  let current = solid;
  let rounded = 0;
  let rejected = 0;

  // Each chain is re-found on the *current* solid immediately before it is cut, rather than
  // every tool being built up front from the original.
  //
  // This is the difference between filleting a box and failing to. A tool's end caps sit
  // exactly on the edge's endpoints — the corners of the part. Once a neighbouring edge has
  // been rounded, those corners no longer exist: the material there has been replaced by a
  // blend surface. A tool built from the original geometry then ends flush against a face
  // the previous cut created, the difference has to resolve two near-coincident planes, and
  // the BSP produces slivers instead of a solid. Nine of a box's twelve edges were being
  // rejected for exactly this reason.
  //
  // Re-finding the edge costs one pass over the triangles per chain and gets the shortened
  // endpoints for free, because the previous cut already trimmed them.
  for (const { chain } of order.slice(0, MAX_CHAINS)) {
    const live = current === solid ? chain : refindChain(current, chain, minAngle);

    if (live.length === 0) {
      // The whole chain was consumed by neighbouring blends. Not a failure: there is no
      // sharp edge left to round. Counted so the totals reported below still add up.
      absorbed++;
      continue;
    }

    const length = live.reduce((sum, e) => sum + len3(sub3(e.b, e.a)), 0);
    if (length < r * 2) { tooShort++; continue; }

    const circle = circularChain(live);

    // Each tool is applied on its own rather than being combined first.
    //
    // Combining looks cheaper — one boolean instead of many — but the tools for adjacent
    // edges meet at every corner, so unioning them is a pile of three-way intersections
    // between slivers, which is the worst input a BSP can be given. Filleting a plain box
    // that way produced four thousand triangles from twelve and left the solid open.
    //
    // Applied one at a time, every operation is a simple well-conditioned cut of a small
    // prism from a large body, and each one is checked before it is kept.
    const tool = circle
      ? revolvedFilletTool(current, live, circle, r, feature, TOOL_CLEARANCE)
      : sweptFilletTool(current, live, r, feature, TOOL_CLEARANCE);

    if (!tool) { noTool++; continue; }

    const res = boolean(current, tool, live[0].convex ? 'difference' : 'union');

    if (!res.valid) {
      rejected++;
      // A tool that would break the solid is discarded rather than applied. Leaving one edge
      // sharp is a far better outcome than an unusable body.
      if (!firstProblem) firstProblem = res.diagnostic;
      continue;
    }
    if (triCount(res.mesh) > 0) { current = res.mesh; rounded++; }
  }

  const h = health(current);

  // Say plainly what happened. A fillet that quietly rounds nothing is the worst outcome:
  // the user believes the part has the radius they asked for, and finds out at inspection.
  const notes: string[] = [];
  if (rounded > 0) notes.push(`Rounded ${rounded} of ${chains.length} edge groups.`);
  else notes.push(`No edges were rounded (${chains.length} groups were found).`);

  if (rejected > 0) {
    notes.push(
      `${rejected} would have left the solid open and were skipped, so those edges are still sharp.`,
    );
  }
  if (tooShort > 0) notes.push(`${tooShort} were shorter than twice the radius.`);
  if (noTool > 0) notes.push(`${noTool} had no usable blend geometry.`);
  if (absorbed > 0) {
    notes.push(`${absorbed} were absorbed by a neighbouring blend and no longer exist as edges.`);
  }
  if (overflow > 0) notes.push(`${overflow} shorter groups were left out to keep the rebuild responsive.`);

  // The boolean's own explanation of the first failure, which is more specific than the
  // count. Without it the user is told a number and left to guess at the cause.
  if (firstProblem) notes.push(firstProblem);

  return {
    mesh: current,
    valid: h.closed && h.manifold,
    diagnostic: rounded === chains.length && rejected === 0 ? undefined : notes.join(' '),
  };
}

/** Explains an empty edge set in terms of the filters that produced it. */
function describeNoEdges(
  faceSet: Set<number> | null, wanted: 'convex' | 'concave' | undefined,
): string {
  const kind = wanted === 'convex' ? 'outside' : 'inside';

  if (faceSet && wanted) {
    return `The selected face${faceSet.size === 1 ? ' has' : 's have'} no ${kind} edges. ` +
      `Set "Which edges" to both, or pick different faces.`;
  }
  if (faceSet) {
    return `No sharp edges were found on the selected face${faceSet.size === 1 ? '' : 's'}.`;
  }
  if (wanted) return `This solid has no ${kind} edges to round.`;
  return 'No edges matched, so nothing was rounded.';
}

/**
 * Finds what is left of a design edge on a solid that has since been cut.
 *
 * Rounding one edge shortens the two that meet it at each corner, and the boolean also
 * fragments the surrounding flat faces, so the single mesh edge that was there at the start
 * may now be several collinear pieces with different endpoints. Matching by identity is
 * therefore impossible; matching by *geometry* is not, because a blend never lies along the
 * edge that produced it.
 *
 * An edge of the current solid belongs to the target if both its endpoints lie on one of the
 * target's segments — on the line, and within the span. Anything created by an earlier cut
 * curves away from that line immediately and is excluded.
 */
function refindChain(current: Mesh, target: SolidEdge[], creaseDeg: number): SolidEdge[] {
  const b = bounds(current);
  const diagonal = len3(sub3(b.max, b.min));
  // Relative, because a 0.5 mm connector and a 4 m chassis are both normal inputs here and a
  // fixed tolerance is wrong for one of them.
  const tol = Math.max(1e-9, diagonal * 1e-6);

  const segments = target
    .map((e) => {
      const d = sub3(e.b, e.a);
      const length = len3(d);
      return length < 1e-12 ? null : { a: e.a, dir: mul3(d, 1 / length), length };
    })
    .filter((s): s is { a: Vec3; dir: Vec3; length: number } => s !== null);

  if (segments.length === 0) return [];

  const onSegment = (p: Vec3): boolean =>
    segments.some((seg) => {
      const rel = sub3(p, seg.a);
      const along = dot3(rel, seg.dir);
      // The span check is generous by a tolerance at each end so a vertex sitting exactly on
      // a segment join is accepted by both of the segments that share it.
      if (along < -tol || along > seg.length + tol) return false;
      const perp = sub3(rel, mul3(seg.dir, along));
      return len3(perp) <= tol;
    });

  const surviving = sharpEdges(current, creaseDeg).filter(
    (e) => onSegment(e.a) && onSegment(e.b),
  );
  if (surviving.length === 0) return [];

  // Re-chain the pieces. A design edge broken into collinear fragments must be handed to the
  // tool builder as one run, or each fragment becomes its own prism and they meet end to end
  // in exactly the near-coincident arrangement this whole approach exists to avoid.
  const chains = edgeChains(surviving);
  let longest = chains[0];
  let best = -1;
  for (const c of chains) {
    const length = c.reduce((sum, e) => sum + len3(sub3(e.b, e.a)), 0);
    if (length > best) { best = length; longest = c; }
  }
  return mergeCollinear(longest, tol);
}

/**
 * Fuses consecutive collinear edges back into one.
 *
 * A boolean splits the triangles around its cut, and that leaves a straight mesh edge as
 * several collinear pieces with a new vertex between them. Geometrically nothing changed, but
 * the *count* did, and two things downstream read the count as meaning something:
 *
 *   - `circularChain` fits a circle through the chain's start points. Points added at the
 *     middle of a chord sit inside the true radius, the fit is rejected, and a cylinder's rim
 *     stops being recognised as a rim. It then goes down the general path, which builds one
 *     prism per edge and unions them — fifty thousand triangles for a blend that as a revolve
 *     is twelve hundred.
 *   - The revolve's segment count is taken from the chain, so an over-sampled rim produces a
 *     tool finer than the geometry it is cutting, which is the mismatch that made this slow in
 *     the first place.
 *
 * Merging restores what the edge was before the cut, which is what both of them assume.
 */
function mergeCollinear(chain: SolidEdge[], tol: number): SolidEdge[] {
  if (chain.length < 2) return chain;

  const out: SolidEdge[] = [];
  let run = chain[0];

  const direction = (e: SolidEdge): Vec3 | null => {
    const d = sub3(e.b, e.a);
    const length = len3(d);
    return length < 1e-12 ? null : mul3(d, 1 / length);
  };

  for (let i = 1; i < chain.length; i++) {
    const next = chain[i];
    const dRun = direction(run);
    const dNext = direction(next);

    // Continue the run only when the pieces are collinear *and* actually joined. Two
    // parallel edges on opposite sides of a part are not one edge.
    const joined = dRun && dNext
      && dot3(dRun, dNext) > 1 - 1e-9
      && len3(sub3(run.b, next.a)) <= tol;

    if (joined) {
      run = { ...run, b: next.b };
    } else {
      out.push(run);
      run = next;
    }
  }
  out.push(run);

  // A closed loop's last piece may continue into the first.
  if (out.length > 2) {
    const first = out[0], last = out[out.length - 1];
    const dFirst = direction(first), dLast = direction(last);
    if (dFirst && dLast && dot3(dFirst, dLast) > 1 - 1e-9 && len3(sub3(last.b, first.a)) <= tol) {
      out[0] = { ...last, b: first.b };
      out.pop();
    }
  }

  return out;
}

/**
 * The 2D cross-section of the material a fillet removes.
 *
 * This is the whole trick that makes filleting affordable. The obvious construction is to
 * build a corner block and a swept ball as solids and subtract one from the other — but for
 * a circular edge both are coaxial revolves sharing every angular plane, and asking a BSP to
 * resolve dozens of near-coincident planes is precisely the case that makes it blow up in
 * time and memory.
 *
 * The same region has a closed form in 2D: bounded by the two face lines from their tangent
 * points to the corner, and by the arc of radius r between those tangent points. Computing
 * it in the section plane and sweeping or revolving it *once* produces the identical solid
 * with no boolean at all, leaving only the single subtraction from the part.
 *
 * The corner sits at the origin; `nA` and `nB` are the two faces' outward normals in the
 * section frame.
 */
function filletSection(nA: Vec2, nB: Vec2, r: number, arcSegs = 10, clearance = 0): Vec2[] | null {
  const na = norm2(nA), nb = norm2(nB);

  // The bisector points into the material, which is opposite the summed outward normals.
  const sum: Vec2 = [na[0] + nb[0], na[1] + nb[1]];
  const mag = Math.hypot(sum[0], sum[1]);
  if (mag < 1e-9) return null; // faces are anti-parallel: no corner to round

  const bis: Vec2 = [-sum[0] / mag, -sum[1] / mag];

  // Place the ball centre so it is exactly r from both faces.
  const cosA = na[0] * bis[0] + na[1] * bis[1];
  if (cosA > -1e-9) return null; // bisector does not head into the material
  const d = -r / cosA;
  const centre: Vec2 = [bis[0] * d, bis[1] * d];

  // Tangent points: step from the centre back out to each face along its normal.
  const tA: Vec2 = [centre[0] + na[0] * r, centre[1] + na[1] * r];
  const tB: Vec2 = [centre[0] + nb[0] * r, centre[1] + nb[1] * r];

  // Arc from tA to tB, taking the way round that passes nearest the corner.
  const angA = Math.atan2(tA[1] - centre[1], tA[0] - centre[0]);
  const angB = Math.atan2(tB[1] - centre[1], tB[0] - centre[0]);
  let sweepAng = angB - angA;
  while (sweepAng > Math.PI) sweepAng -= 2 * Math.PI;
  while (sweepAng < -Math.PI) sweepAng += 2 * Math.PI;

  // The two straight legs run from the corner to the tangent points — which means they lie
  // *exactly in* the two faces they are cutting from. Two coincident planes is the one input
  // a BSP handles worst: the classification of a polygon lying in the splitting plane is a
  // tie, broken by a tolerance, and on a box seven of twelve cuts came back as open solids
  // with non-manifold edges.
  //
  // Lifting the legs a hair outward removes the tie. The tool then pokes into empty space
  // instead of sitting flush, every plane it carries is strictly outside the material, and
  // the volume removed is identical because the extra sliver contains no material. This is
  // the standard remedy, and it is the one the boolean's own diagnostic recommends.
  const pts: Vec2[] = [];

  if (clearance > 0) {
    // Corner of the two outward-offset face lines. Both are `clearance` from their face, so
    // the intersection sits along the outward bisector, scaled from the ball centre's own
    // offset by the same ratio.
    const t = (clearance * d) / r;
    pts.push([-bis[0] * t, -bis[1] * t]);
    pts.push([tA[0] + na[0] * clearance, tA[1] + na[1] * clearance]);
  } else {
    pts.push([0, 0]);
  }

  pts.push([tA[0], tA[1]]);
  for (let i = 1; i < arcSegs; i++) {
    const t = angA + (sweepAng * i) / arcSegs;
    pts.push([centre[0] + r * Math.cos(t), centre[1] + r * Math.sin(t)]);
  }
  pts.push([tB[0], tB[1]]);

  if (clearance > 0) pts.push([tB[0] + nb[0] * clearance, tB[1] + nb[1] * clearance]);

  return pts;
}

/** The two surface normals at an edge, as measured on the triangles that meet there. */
function faceNormalsAt(_solid: Mesh, e: SolidEdge): { nA: Vec3; nB: Vec3 } | null {
  return { nA: e.normalA, nB: e.normalB };
}

/**
 * Fillet tool for a chain lying on a circle, built as a single revolve of the 2D section.
 */
function revolvedFilletTool(
  solid: Mesh, chain: SolidEdge[], circle: { centre: Vec3; axis: Vec3; radius: number },
  r: number, feature: string, clearance: number,
): Mesh | null {
  const normals = faceNormalsAt(solid, chain[0]);
  if (!normals) return null;

  const onAxis = add3(circle.centre, mul3(circle.axis, dot3(sub3(chain[0].a, circle.centre), circle.axis)));
  const radialDir = norm3(sub3(chain[0].a, onAxis));
  if (len3(radialDir) < 1e-9) return null;

  // Express both face normals in the (radial, axial) section frame.
  const nA2: Vec2 = [dot3(normals.nA, radialDir), dot3(normals.nA, circle.axis)];
  const nB2: Vec2 = [dot3(normals.nB, radialDir), dot3(normals.nB, circle.axis)];

  const section = filletSection(nA2, nB2, r, 10, r * clearance);
  if (!section) return null;

  // Shift the section from the origin to where the edge actually is.
  const cx = circle.radius;
  const cy = dot3(sub3(chain[0].a, circle.centre), circle.axis);
  const placed = section.map(([x, y]) => [cx + x, cy + y] as Vec2);

  // A section crossing the axis would revolve into a self-intersecting body.
  if (placed.some(([x]) => x < 1e-6)) return null;

  const sectionPlane: Plane = {
    origin: circle.centre, u: radialDir, v: circle.axis,
    normal: cross3(radialDir, circle.axis),
  };

  // The tool is tessellated to exactly the chain it follows, so its facet boundaries land on
  // the rim's own vertices instead of a fraction of a degree away from them.
  return revolve(makeProfile(placed), sectionPlane, {
    axisOrigin: circle.centre, axisDir: circle.axis, angleDeg: 360, feature,
    segments: chain.length,
  });
}

/**
 * Fillet tool for a straight chain, built by extruding the 2D section along it.
 *
 * Chains that are neither circular nor straight are handled edge by edge — every edge is
 * straight in a triangle mesh, so the construction always applies. The pieces are collected
 * and subtracted together, and because they are mostly disjoint the union that combines them
 * takes the concatenation fast path rather than running a BSP per pair.
 */
/**
 * How far a fillet tool is lifted off the faces it cuts, as a fraction of the radius.
 *
 * Small enough that the sliver of empty space it adds is far below any manufacturable
 * tolerance, large enough to sit well clear of the boolean's classification epsilon.
 */
/**
 * How far a cutting tool is lifted off the faces it cuts, as a fraction of the radius or
 * setback.
 *
 * Small enough that the sliver of empty space it adds is orders of magnitude below any
 * manufacturable tolerance, large enough to sit well clear of the boolean's classification
 * epsilon. A ladder of several values, retried until one succeeded, was tried and abandoned:
 * on the edges that fail, every clearance fails, so it bought nothing and doubled the cost of
 * the failing case.
 */
const TOOL_CLEARANCE = 0.02;

function sweptFilletTool(
  solid: Mesh, chain: SolidEdge[], r: number, feature: string, clearance: number,
): Mesh | null {
  const pieces: Mesh[] = [];

  for (const e of chain) {
    const normals = faceNormalsAt(solid, e);
    if (!normals) continue;

    const edgeVec = sub3(e.b, e.a);
    const len = len3(edgeVec);
    if (len < 1e-9) continue;
    const dir = norm3(edgeVec);

    // Section frame perpendicular to the edge.
    const u = norm3(sub3(normals.nA, mul3(dir, dot3(normals.nA, dir))));
    if (len3(u) < 1e-9) continue;
    const v = cross3(dir, u);

    const nA2: Vec2 = [dot3(normals.nA, u), dot3(normals.nA, v)];
    const nB2: Vec2 = [dot3(normals.nB, u), dot3(normals.nB, v)];

    const section = filletSection(nA2, nB2, r, 10, r * clearance);
    if (!section) continue;

    // The tool stops exactly at the edge's ends rather than overshooting.
    //
    // Overshooting seems safer — it guarantees consecutive pieces meet with no ridge — but
    // at a corner where three edges converge each tool then reaches past its own edge and
    // cuts into the face the *other* two belong to. Twelve tools on a box remove far more
    // than they should, the result is no longer closed, and the triangle count explodes as
    // the boolean tries to resolve the overlaps.
    //
    // Abutting exactly leaves each corner with a small unblended notch, which is honest and
    // valid, rather than a fast-growing mess that is neither.
    // The tool stops exactly at the edge's ends rather than overshooting.
    //
    // Overshooting seems safer — it guarantees consecutive pieces meet with no ridge — but at
    // a corner where three edges converge each tool then reaches past its own edge and cuts
    // into the face the *other* two belong to. Measured on a box, overshoot rounded fewer
    // edges at every length tried, not more.
    const plane: Plane = { origin: e.a, u, v, normal: dir };
    pieces.push(extrude(makeProfile(section), plane, { distance: len, feature }));
  }

  if (pieces.length === 0) return null;
  if (pieces.length === 1) return pieces[0];

  const merged = unionAll(pieces);
  return triCount(merged.mesh) > 0 ? merged.mesh : null;
}

export interface ChamferOptions {
  distance: number;
  /** Restrict to these faces. Omitted means every convex sharp edge. */
  faces?: number[];
  faceMatch?: 'bounding' | 'between';
  minAngleDeg?: number;
  feature?: string;
}

/**
 * Cuts edges back at 45 degrees.
 *
 * Same construction as the fillet, with a flat cutting plane instead of a rolling cylinder,
 * so it inherits the same limits and the same edge selection.
 */
export function chamferEdges(solid: Mesh, opts: ChamferOptions): BooleanResult {
  const d = Math.abs(opts.distance);
  if (d < 1e-6) return { mesh: solid, valid: true };

  const faceSet = opts.faces && opts.faces.length > 0 ? new Set(opts.faces) : null;
  const minAngle = opts.minAngleDeg ?? 20;
  const between = opts.faceMatch === 'between';
  const feature = opts.feature ?? 'Chamfer';

  const edges = sharpEdges(solid, minAngle).filter((e) => {
    // Only convex edges. Chamfering a concave one would add a wedge of material, which is a
    // different operation with a different name.
    if (!e.convex) return false;
    if (!faceSet) return true;
    return between
      ? faceSet.has(e.faceA) && faceSet.has(e.faceB)
      : faceSet.has(e.faceA) || faceSet.has(e.faceB);
  });

  if (edges.length === 0) {
    return {
      mesh: solid,
      valid: true,
      diagnostic: faceSet
        ? `No convex edges were found on the selected face${faceSet.size === 1 ? '' : 's'}.`
        : 'No convex edges matched, so nothing was chamfered.',
    };
  }

  const chains = edgeChains(edges);
  const chainLengths = chains.map((c) => c.reduce((sum, e) => sum + len3(sub3(e.b, e.a)), 0));

  const order = chains
    .map((chain, i) => ({ chain, length: chainLengths[i] }))
    .sort((a, b) => b.length - a.length);

  const MAX_CHAINS = 40;
  const overflow = Math.max(0, order.length - MAX_CHAINS);

  let current = solid;
  let cut = 0;
  let rejected = 0;
  let tooShort = 0;
  let noTool = 0;
  let absorbed = 0;
  let firstProblem: string | undefined;

  // Applied one chain at a time against the current body, each one re-found first, for the
  // same reasons as `filletEdges` — which this deliberately mirrors. Building every cutter up
  // front from the original solid and subtracting them together left a chamfered box open.
  for (const { chain } of order.slice(0, MAX_CHAINS)) {
    const live = current === solid ? chain : refindChain(current, chain, minAngle);
    if (live.length === 0) { absorbed++; continue; }

    const length = live.reduce((sum, e) => sum + len3(sub3(e.b, e.a)), 0);
    if (length < d * 2) { tooShort++; continue; }

    const tool = chamferTool(live, d, feature, TOOL_CLEARANCE);
    if (!tool) { noTool++; continue; }

    const res = boolean(current, tool, 'difference');
    if (!res.valid) {
      rejected++;
      if (!firstProblem) firstProblem = res.diagnostic;
      continue;
    }
    if (triCount(res.mesh) > 0) { current = res.mesh; cut++; }
  }

  const h = health(current);

  const notes: string[] = [];
  if (cut > 0) notes.push(`Chamfered ${cut} of ${chains.length} edge groups.`);
  else notes.push(`No edges were chamfered (${chains.length} groups were found).`);

  if (rejected > 0) {
    notes.push(
      `${rejected} would have left the solid open and were skipped, so those edges are still sharp.`,
    );
  }
  if (tooShort > 0) notes.push(`${tooShort} were shorter than twice the chamfer.`);
  if (noTool > 0) notes.push(`${noTool} had no usable cutter geometry.`);
  if (absorbed > 0) notes.push(`${absorbed} were absorbed by a neighbouring chamfer.`);
  if (overflow > 0) notes.push(`${overflow} shorter groups were left out to keep the rebuild responsive.`);
  if (firstProblem) notes.push(firstProblem);

  return {
    mesh: current,
    valid: h.closed && h.manifold,
    diagnostic: cut === chains.length && rejected === 0 ? undefined : notes.join(' '),
  };
}

/**
 * The 2D cross-section of the material a chamfer removes.
 *
 * The equal-distance chamfer: set back `d` from the edge along each face and cut straight
 * across. The corner is at the origin and `nA`, `nB` are the faces' outward normals — the
 * same frame `filletSection` uses, and like it the two legs are lifted clear of the faces
 * they cut so the boolean is never asked to classify a polygon lying exactly in its own
 * splitting plane.
 *
 * The previous construction used a fixed 45-degree triangle built from the corner bisector.
 * That is correct on a right-angled edge and wrong on every other one: the setback came out
 * unequal between the two faces and matched the requested distance on neither.
 */
function chamferSection(nA: Vec2, nB: Vec2, d: number, clearance = 0): Vec2[] | null {
  const na = norm2(nA), nb = norm2(nB);

  const sum: Vec2 = [na[0] + nb[0], na[1] + nb[1]];
  const mag = Math.hypot(sum[0], sum[1]);
  if (mag < 1e-9) return null; // anti-parallel faces: no corner to cut

  const bis: Vec2 = [-sum[0] / mag, -sum[1] / mag];
  const cosA = na[0] * bis[0] + na[1] * bis[1];
  if (cosA > -1e-9) return null; // the bisector does not head into the material

  // Along each face, away from the other. Of the two in-plane directions perpendicular to a
  // face normal, the one heading away from the opposite face is the one that stays on the
  // surface being set back.
  const alongA = perpAwayFrom(na, nb);
  const alongB = perpAwayFrom(nb, na);
  if (!alongA || !alongB) return null;

  const setA: Vec2 = [alongA[0] * d, alongA[1] * d];
  const setB: Vec2 = [alongB[0] * d, alongB[1] * d];

  if (clearance <= 0) return [[0, 0], setA, setB];

  // The corner of the two outward-offset face lines, plus each setback point lifted off its
  // own face. The segment between the two setback points — the chamfer surface itself — is
  // left exactly where it was, so the cut still measures what was asked for.
  const t = clearance / -cosA;
  return [
    [-bis[0] * t, -bis[1] * t],
    [setA[0] + na[0] * clearance, setA[1] + na[1] * clearance],
    setA,
    setB,
    [setB[0] + nb[0] * clearance, setB[1] + nb[1] * clearance],
  ];
}

/** Unit vector perpendicular to `n`, chosen to head away from the face whose normal is `other`. */
function perpAwayFrom(n: Vec2, other: Vec2): Vec2 | null {
  const p: Vec2 = [-n[1], n[0]];
  const towards = p[0] * other[0] + p[1] * other[1];
  if (Math.abs(towards) < 1e-12) return null;
  return towards < 0 ? p : [-p[0], -p[1]];
}

/** Cutter for one chamfer chain: a revolve for a circular rim, an extrude along anything else. */
function chamferTool(
  chain: SolidEdge[], d: number, feature: string, clearanceFraction: number,
): Mesh | null {
  const circle = circularChain(chain);
  const clearance = d * clearanceFraction;

  if (circle) {
    const first = chain[0];
    const onAxis = add3(
      circle.centre,
      mul3(circle.axis, dot3(sub3(first.a, circle.centre), circle.axis)),
    );
    const radialDir = norm3(sub3(first.a, onAxis));
    if (len3(radialDir) < 1e-9) return null;

    const nA2: Vec2 = [dot3(first.normalA, radialDir), dot3(first.normalA, circle.axis)];
    const nB2: Vec2 = [dot3(first.normalB, radialDir), dot3(first.normalB, circle.axis)];

    const section = chamferSection(nA2, nB2, d, clearance);
    if (!section) return null;

    const cx = circle.radius;
    const cy = dot3(sub3(first.a, circle.centre), circle.axis);
    const placed = section.map(([x, y]) => [cx + x, cy + y] as Vec2);
    // A section crossing the axis would revolve into a self-intersecting body.
    if (placed.some(([x]) => x < 1e-6)) return null;

    return revolve(
      makeProfile(placed),
      {
        origin: circle.centre, u: radialDir, v: circle.axis,
        normal: cross3(radialDir, circle.axis),
      },
      {
        axisOrigin: circle.centre, axisDir: circle.axis, angleDeg: 360, feature,
        segments: chain.length,
      },
    );
  }

  const pieces: Mesh[] = [];

  for (const e of chain) {
    const edgeVec = sub3(e.b, e.a);
    const length = len3(edgeVec);
    if (length < 1e-9) continue;
    const dir = norm3(edgeVec);

    const u = norm3(sub3(e.normalA, mul3(dir, dot3(e.normalA, dir))));
    if (len3(u) < 1e-9) continue;
    const v = cross3(dir, u);

    const nA2: Vec2 = [dot3(e.normalA, u), dot3(e.normalA, v)];
    const nB2: Vec2 = [dot3(e.normalB, u), dot3(e.normalB, v)];

    const section = chamferSection(nA2, nB2, d, clearance);
    if (!section) continue;

    const plane: Plane = { origin: e.a, u, v, normal: dir };
    pieces.push(extrude(makeProfile(section), plane, { distance: length, feature }));
  }

  if (pieces.length === 0) return null;
  if (pieces.length === 1) return pieces[0];

  const merged = unionAll(pieces);
  return triCount(merged.mesh) > 0 ? merged.mesh : null;
}

// ── patterns ─────────────────────────────────────────────────────────────────

export interface LinearPatternOptions {
  direction: Vec3;
  spacing: number;
  count: number;
  /** Optional second direction for a grid. */
  direction2?: Vec3;
  spacing2?: number;
  count2?: number;
  feature?: string;
}

/**
 * Repeats a body along one or two directions and merges the copies.
 *
 * Copies are unioned rather than concatenated. Concatenation is faster and is what a mesh
 * viewer would do, but if two instances touch, the result has coincident internal faces,
 * no defined volume, and cannot be cut afterwards. Since patterned features very often
 * abut deliberately — a row of ribs, a perforated sheet — the union is not optional.
 */
export function linearPattern(body: Mesh, opts: LinearPatternOptions): BooleanResult {
  const dir = norm3(opts.direction);
  const n1 = Math.max(1, Math.round(opts.count));
  const n2 = opts.direction2 && opts.count2 ? Math.max(1, Math.round(opts.count2)) : 1;
  const dir2 = opts.direction2 ? norm3(opts.direction2) : [0, 0, 0] as Vec3;

  const copies: Mesh[] = [];
  for (let i = 0; i < n1; i++) {
    for (let j = 0; j < n2; j++) {
      if (i === 0 && j === 0) { copies.push(body); continue; }
      const offset = add3(mul3(dir, i * opts.spacing), mul3(dir2, j * (opts.spacing2 ?? 0)));
      copies.push(transformMesh(body, translation(offset)));
    }
  }

  return unionAll(copies);
}

export interface CircularPatternOptions {
  axisOrigin: Vec3;
  axisDir: Vec3;
  count: number;
  /** Total sweep in degrees; 360 spaces copies evenly all the way round. */
  angleDeg?: number;
  feature?: string;
}

export function circularPattern(body: Mesh, opts: CircularPatternOptions): BooleanResult {
  const n = Math.max(1, Math.round(opts.count));
  const total = opts.angleDeg ?? 360;
  // A full circle must not place a copy at both 0 and 360, which would be two coincident
  // bodies and an instantly non-manifold union.
  const full = Math.abs(total - 360) < 1e-9;
  const step = ((full ? 360 / n : total / Math.max(1, n - 1)) * Math.PI) / 180;

  const copies: Mesh[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) { copies.push(body); continue; }
    copies.push(transformMesh(body, rotationAbout(opts.axisOrigin, norm3(opts.axisDir), i * step)));
  }

  return unionAll(copies);
}

/** Mirrors a body across a plane and unions it with the original. */
export function mirrorBody(body: Mesh, planePoint: Vec3, planeNormal: Vec3, merge = true): BooleanResult {
  const mirrored = transformMesh(body, reflection(planePoint, planeNormal));
  return merge ? boolean(body, mirrored, 'union') : { mesh: mirrored, valid: health(mirrored).closed };
}

// ── holes ────────────────────────────────────────────────────────────────────

export type HoleKind = 'simple' | 'counterbore' | 'countersink' | 'tapped';

export interface HoleOptions {
  kind: HoleKind;
  diameter: number;
  depth: number;
  /** Through-hole; `depth` is ignored. */
  through?: boolean;
  /** Counterbore diameter, or countersink major diameter. */
  headDiameter?: number;
  /** Counterbore depth. */
  headDepth?: number;
  /** Countersink included angle, degrees. */
  csinkAngleDeg?: number;
  /** Position on the entry face. */
  at: Vec3;
  /** Direction the drill travels. */
  direction: Vec3;
  feature?: string;
}

/**
 * Cuts a hole, including the head recess for counterbored and countersunk types.
 *
 * The drill is deliberately started slightly above the surface. Starting it exactly on the
 * face makes the cutter's end cap coplanar with the face being cut, which is the one
 * configuration most likely to leave a zero-thickness sliver.
 */
export function drillHole(solid: Mesh, opts: HoleOptions): BooleanResult {
  const dir = norm3(opts.direction);
  const bb = bounds(solid);
  const span = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) + 20;

  const r = opts.diameter / 2;
  const depth = opts.through ? span : opts.depth;
  const feature = opts.feature ?? 'Hole';

  const tools: Mesh[] = [];

  // Overshoot the entry by a clear margin so no coplanar cap remains.
  const lift = 1;
  const start = add3(opts.at, mul3(dir, -lift));
  const shaftLen = depth + lift + (opts.through ? lift : 0);
  tools.push(cylinder(r, shaftLen, add3(start, mul3(dir, shaftLen / 2)), dir, feature));

  if (opts.kind === 'counterbore' && opts.headDiameter && opts.headDepth) {
    const hr = opts.headDiameter / 2;
    const hl = opts.headDepth + lift;
    tools.push(cylinder(hr, hl, add3(start, mul3(dir, hl / 2)), dir, feature));
  }

  if (opts.kind === 'countersink' && opts.headDiameter) {
    const hr = opts.headDiameter / 2;
    const angle = ((opts.csinkAngleDeg ?? 90) * Math.PI) / 180;
    // Cone depth from the geometry of the included angle.
    const coneDepth = (hr - r) / Math.tan(angle / 2);
    const prof = makeProfile([
      [0, 0], [hr, 0], [r, coneDepth], [0, coneDepth],
    ]);
    const pl = planeFrom(opts.at, dir);
    tools.push(
      // Revolve the countersink profile about the drill axis.
      revolveAbout(prof, pl, opts.at, dir, feature),
    );
  }

  const r2 = subtractAll(solid, tools);
  return r2;
}

/**
 * Revolves a section profile about an arbitrary axis.
 *
 * The section plane must contain the axis, so it is built with `u` radial and `v` along the
 * axis. `revolve` then handles the caps, the degeneracy where the profile meets the axis,
 * and the outward orientation.
 */
function revolveAbout(prof: Profile, pl: Plane, origin: Vec3, axis: Vec3, feature: string): Mesh {
  const w = norm3(axis);
  const radial = norm3(sub3(pl.u, mul3(w, dot3(pl.u, w))));
  const sectionPlane: Plane = { origin, u: radial, v: w, normal: cross3(radial, w) };
  return revolve(prof, sectionPlane, { axisOrigin: origin, axisDir: axis, angleDeg: 360, feature });
}

// ── measurement helpers used by DFM and drawings ─────────────────────────────

/** Thinnest wall in a solid, sampled by ray casting from each face inward. */
export function minimumWallThickness(m: Mesh, samples = 200): number {
  const tris = triCount(m);
  if (tris === 0) return 0;

  let min = Infinity;
  const step = Math.max(1, Math.floor(tris / samples));

  for (let t = 0; t < tris; t += step) {
    const [a, b, c] = getTriangle(m, t);
    const centre = mul3(add3(add3(a, b), c), 1 / 3);
    const n = triangleNormal(a, b, c);

    // Cast inward and measure to the first surface the ray meets.
    const origin = add3(centre, mul3(n, -1e-4));
    let best = Infinity;

    for (let u = 0; u < tris; u++) {
      if (u === t) continue;
      const [p, q, r] = getTriangle(m, u);
      const hit = rayTriangle(origin, mul3(n, -1), p, q, r);
      if (hit !== null && hit > 1e-6 && hit < best) best = hit;
    }
    if (best < min) min = best;
  }

  return min === Infinity ? 0 : min;
}

function rayTriangle(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = sub3(b, a), e2 = sub3(c, a);
  const h = cross3(d, e2);
  const det = dot3(e1, h);
  if (Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  const s = sub3(o, a);
  const u = inv * dot3(s, h);
  if (u < 0 || u > 1) return null;
  const q = cross3(s, e1);
  const v = inv * dot3(d, q);
  if (v < 0 || u + v > 1) return null;
  const t = inv * dot3(e2, q);
  return t > 0 ? t : null;
}

/** Re-exported so callers can build a fillet tool without importing `build` as well. */
export { sphere, torus, cylinder, sweep, linePath, minimumFeatureSize };
export type { Mat4 };
export { matMul, rotation, translation, xformPoint, circleProfile };

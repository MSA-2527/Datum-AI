/**
 * Triangle mesh with half-edge adjacency, and exact mass properties.
 *
 * The kernel's solid representation is an indexed triangle mesh carrying face tags that
 * remember which modelling face each triangle came from. That tagging is what makes this a
 * CAD representation rather than a graphics one: selecting a face, filleting an edge and
 * dimensioning to a surface all need "these 340 triangles are one planar face", and a bare
 * triangle soup cannot answer that.
 *
 * Vertices are welded on a spatial hash. Un-welded meshes are the second great source of
 * silent failure after inexact predicates: two triangles that visually share an edge but
 * reference different vertex indices leave a crack, the solid is not closed, and volume
 * and boolean results are then meaningless while still looking perfectly fine on screen.
 */

import {
  add3, boxDiagonal, cross3, distSq3, dot3, emptyBox, expandBox, len3, mul3, norm3, sub3,
  xformPoint, flipsOrientation, type Box3, type Mat4, type Vec3,
} from '../math/vec';

/** A face of the modelling solid — the thing a user can click, dimension or fillet. */
export interface FaceTag {
  id: number;
  /** Which construction step produced it, so the feature tree can highlight its geometry. */
  feature: string;
  kind: 'planar' | 'cylindrical' | 'conical' | 'spherical' | 'toroidal' | 'freeform';
  /** Outward normal for planar faces; axis direction for the analytic ones. */
  normal?: Vec3;
  /** A point on the surface — plane origin, or a point on the axis. */
  origin?: Vec3;
  /**
   * Radius, for the analytic kinds.
   *
   * A cylinder's radius, a sphere's radius, a torus's *major* radius, or a cone's radius at
   * `origin`.
   */
  radius?: number;
  /** Half-angle between axis and surface, for a cone. Radians. */
  halfAngle?: number;
  /** Tube radius, for a torus. */
  minorRadius?: number;
}

export interface Mesh {
  /** Flat xyz triples. */
  positions: Float64Array;
  /** Flat vertex-index triples, three per triangle. */
  indices: Uint32Array;
  /** Face tag id per triangle; length = indices.length / 3. */
  faceIds: Uint32Array;
  tags: Map<number, FaceTag>;
}

export const triCount = (m: Mesh): number => m.indices.length / 3;
export const vertCount = (m: Mesh): number => m.positions.length / 3;

export function getVertex(m: Mesh, i: number): Vec3 {
  return [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
}

export function getTriangle(m: Mesh, t: number): [Vec3, Vec3, Vec3] {
  const a = m.indices[t * 3], b = m.indices[t * 3 + 1], c = m.indices[t * 3 + 2];
  return [getVertex(m, a), getVertex(m, b), getVertex(m, c)];
}

export function emptyMesh(): Mesh {
  return {
    positions: new Float64Array(0),
    indices: new Uint32Array(0),
    faceIds: new Uint32Array(0),
    tags: new Map(),
  };
}

// ── builder ──────────────────────────────────────────────────────────────────

/**
 * Incremental mesh builder that welds as it goes.
 *
 * Welding during construction rather than as a post-pass matters for correctness, not just
 * speed: an extrusion's side wall and its cap must share vertices, and they are emitted by
 * different code paths minutes apart in the same build. Welding at the point of insertion
 * means they cannot fail to meet.
 */
export class MeshBuilder {
  private pos: number[] = [];
  private idx: number[] = [];
  private fids: number[] = [];
  private map = new Map<string, number>();
  private nextTag = 1;

  readonly tags = new Map<number, FaceTag>();

  /** Quantisation for the weld hash, in millimetres. */
  constructor(private readonly weldTol = 1e-7) {}

  addTag(tag: Omit<FaceTag, 'id'>): number {
    const id = this.nextTag++;
    this.tags.set(id, { ...tag, id });
    return id;
  }

  vertex(p: Vec3): number {
    // Quantise to a lattice, then check the 27 neighbouring cells. Checking neighbours is
    // what makes this correct: two points 1e-12 apart can still land in different cells,
    // and hashing alone would leave them un-welded exactly at the tolerance boundary.
    const q = 1 / this.weldTol;
    const kx = Math.round(p[0] * q), ky = Math.round(p[1] * q), kz = Math.round(p[2] * q);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const hit = this.map.get(`${kx + dx},${ky + dy},${kz + dz}`);
          if (hit === undefined) continue;
          const ex = this.pos[hit * 3], ey = this.pos[hit * 3 + 1], ez = this.pos[hit * 3 + 2];
          const d2 = (ex - p[0]) ** 2 + (ey - p[1]) ** 2 + (ez - p[2]) ** 2;
          if (d2 <= this.weldTol * this.weldTol) return hit;
        }
      }
    }

    const id = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    this.map.set(`${kx},${ky},${kz}`, id);
    return id;
  }

  triangle(a: Vec3, b: Vec3, c: Vec3, faceId: number): void {
    const ia = this.vertex(a), ib = this.vertex(b), ic = this.vertex(c);
    // A triangle with a repeated vertex has zero area. Emitting it would break normal
    // computation and add a spurious edge to the half-edge structure.
    if (ia === ib || ib === ic || ia === ic) return;
    this.idx.push(ia, ib, ic);
    this.fids.push(faceId);
  }

  triangleIdx(ia: number, ib: number, ic: number, faceId: number): void {
    if (ia === ib || ib === ic || ia === ic) return;
    this.idx.push(ia, ib, ic);
    this.fids.push(faceId);
  }

  /** Fan-triangulates a convex polygon. Callers must not pass non-convex loops. */
  convexPolygon(pts: Vec3[], faceId: number, reverse = false): void {
    if (pts.length < 3) return;
    const p = reverse ? [...pts].reverse() : pts;
    for (let i = 1; i + 1 < p.length; i++) this.triangle(p[0], p[i], p[i + 1], faceId);
  }

  build(): Mesh {
    return {
      positions: Float64Array.from(this.pos),
      indices: Uint32Array.from(this.idx),
      faceIds: Uint32Array.from(this.fids),
      tags: new Map(this.tags),
    };
  }
}

// ── geometry queries ─────────────────────────────────────────────────────────

export function triangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return norm3(cross3(sub3(b, a), sub3(c, a)));
}

export function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  return len3(cross3(sub3(b, a), sub3(c, a))) / 2;
}

export function bounds(m: Mesh): Box3 {
  const b = emptyBox();
  for (let i = 0; i < m.positions.length; i += 3) {
    expandBox(b, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]);
  }
  return b;
}

export function surfaceArea(m: Mesh): number {
  let a = 0;
  for (let t = 0; t < triCount(m); t++) {
    const [p, q, r] = getTriangle(m, t);
    a += triangleArea(p, q, r);
  }
  return a;
}

/** Per-vertex normals, area-weighted so large triangles dominate as they should. */
export function vertexNormals(m: Mesh): Float32Array {
  const n = new Float32Array(m.positions.length);
  for (let t = 0; t < triCount(m); t++) {
    const ia = m.indices[t * 3], ib = m.indices[t * 3 + 1], ic = m.indices[t * 3 + 2];
    const a = getVertex(m, ia), b = getVertex(m, ib), c = getVertex(m, ic);
    // Un-normalised cross product is already area-weighted, which is what we want.
    const cr = cross3(sub3(b, a), sub3(c, a));
    for (const i of [ia, ib, ic]) {
      n[i * 3] += cr[0]; n[i * 3 + 1] += cr[1]; n[i * 3 + 2] += cr[2];
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (l > 1e-20) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
  }
  return n;
}

/**
 * Per-vertex normals split at sharp edges.
 *
 * Smoothing across a 90-degree edge makes a machined block look like a pillow. Splitting
 * above a crease angle is what gives CAD its characteristic crisp shading, and it must be
 * done by duplicating vertices for rendering only — the solid keeps its welded topology.
 */
export function shadingMesh(m: Mesh, creaseDeg = 35): {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceIds: Uint32Array;
} {
  const cos = Math.cos((creaseDeg * Math.PI) / 180);
  const tris = triCount(m);

  const faceNormals: Vec3[] = [];
  for (let t = 0; t < tris; t++) {
    const [a, b, c] = getTriangle(m, t);
    faceNormals.push(triangleNormal(a, b, c));
  }

  // Accumulate only from neighbouring triangles whose normal is within the crease angle.
  const incident = new Map<number, number[]>();
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const v = m.indices[t * 3 + k];
      const list = incident.get(v);
      if (list) list.push(t); else incident.set(v, [t]);
    }
  }

  const positions = new Float32Array(tris * 9);
  const normals = new Float32Array(tris * 9);
  const indices = new Uint32Array(tris * 3);
  const faceIds = new Uint32Array(tris * 3);

  for (let t = 0; t < tris; t++) {
    const fn = faceNormals[t];
    for (let k = 0; k < 3; k++) {
      const vi = m.indices[t * 3 + k];
      const p = getVertex(m, vi);
      const o = t * 9 + k * 3;
      positions[o] = p[0]; positions[o + 1] = p[1]; positions[o + 2] = p[2];

      let nx = 0, ny = 0, nz = 0;
      for (const nt of incident.get(vi) ?? [t]) {
        const on = faceNormals[nt];
        if (dot3(fn, on) < cos) continue;
        const [a, b, c] = getTriangle(m, nt);
        const w = triangleArea(a, b, c);
        nx += on[0] * w; ny += on[1] * w; nz += on[2] * w;
      }
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-20) { nx /= l; ny /= l; nz /= l; } else { nx = fn[0]; ny = fn[1]; nz = fn[2]; }
      normals[o] = nx; normals[o + 1] = ny; normals[o + 2] = nz;

      indices[t * 3 + k] = t * 3 + k;
      faceIds[t * 3 + k] = m.faceIds[t] ?? 0;
    }
  }

  return { positions, normals, indices, faceIds };
}

// ── mass properties ──────────────────────────────────────────────────────────

export interface MassProperties {
  volume: number;
  area: number;
  centroid: Vec3;
  /** Inertia tensor about the centroid, in mm^5 (multiply by density for mass units). */
  inertia: [number, number, number, number, number, number];
  /** Principal moments, ascending. */
  principal: Vec3;
  /** Principal axes as columns, matching `principal`. */
  axes: [Vec3, Vec3, Vec3];
}

/**
 * Exact volume, centroid and inertia tensor of a closed triangle mesh.
 *
 * By the divergence theorem, a volume integral over a solid equals a surface integral over
 * its boundary, and for a triangulated boundary that surface integral has a closed form per
 * triangle. So these are *exact* for the mesh — not sampled, not approximated. Voxel or
 * Monte-Carlo estimates of mass properties are typically 0.1-1% out, and a 1% mass error is
 * a rejected part when the drawing calls out mass to three figures.
 *
 * The mesh must be closed and consistently outward-oriented. If it is not, volume comes out
 * wrong and `closed()` is the check that catches it.
 */
export function massProperties(m: Mesh): MassProperties {
  let vol = 0;
  let cx = 0, cy = 0, cz = 0;
  let ixx = 0, iyy = 0, izz = 0, ixy = 0, ixz = 0, iyz = 0;

  for (let t = 0; t < triCount(m); t++) {
    const [a, b, c] = getTriangle(m, t);

    // Signed volume of the tetrahedron from the origin to this triangle. Contributions
    // from triangles facing away cancel those facing towards, leaving the true volume.
    const d = dot3(a, cross3(b, c));
    vol += d / 6;

    cx += d * (a[0] + b[0] + c[0]);
    cy += d * (a[1] + b[1] + c[1]);
    cz += d * (a[2] + b[2] + c[2]);

    // Second moments over the tetrahedron, integrated in closed form.
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const p0 = a[i], p1 = b[i], p2 = c[i];
      const q0 = a[j], q1 = b[j], q2 = c[j];

      const sq = p0 * p0 + p1 * p1 + p2 * p2 + p0 * p1 + p1 * p2 + p2 * p0;
      const prod =
        2 * (p0 * q0 + p1 * q1 + p2 * q2) +
        p0 * q1 + p1 * q0 + p1 * q2 + p2 * q1 + p2 * q0 + p0 * q2;

      const diag = (d * sq) / 60;
      const off = (d * prod) / 120;

      if (i === 0) { ixx += diag; ixy += off; }
      else if (i === 1) { iyy += diag; iyz += off; }
      else { izz += diag; ixz += off; }
    }
  }

  const V = vol;
  const centroid: Vec3 = Math.abs(V) < 1e-18 ? [0, 0, 0] : [cx / (24 * V), cy / (24 * V), cz / (24 * V)];

  // Inertia about the origin, then shifted to the centroid by the parallel axis theorem.
  const Ixx = iyy + izz;
  const Iyy = ixx + izz;
  const Izz = ixx + iyy;

  const [gx, gy, gz] = centroid;
  const cIxx = Ixx - V * (gy * gy + gz * gz);
  const cIyy = Iyy - V * (gx * gx + gz * gz);
  const cIzz = Izz - V * (gx * gx + gy * gy);
  const cIxy = -(ixy - V * gx * gy);
  const cIyz = -(iyz - V * gy * gz);
  const cIxz = -(ixz - V * gx * gz);

  const { values, vectors } = symmetricEigen3(cIxx, cIyy, cIzz, cIxy, cIxz, cIyz);

  return {
    volume: V,
    area: surfaceArea(m),
    centroid,
    inertia: [cIxx, cIyy, cIzz, cIxy, cIxz, cIyz],
    principal: values,
    axes: vectors,
  };
}

/**
 * Eigen-decomposition of a symmetric 3x3 matrix by cyclic Jacobi rotation.
 *
 * Closed-form eigenvalues via the characteristic cubic are available but lose accuracy
 * badly when two moments are nearly equal — the case for every axisymmetric part, which in
 * mechanical design is most of them. Jacobi is iterative but unconditionally stable here.
 */
function symmetricEigen3(
  xx: number, yy: number, zz: number, xy: number, xz: number, yz: number,
): { values: Vec3; vectors: [Vec3, Vec3, Vec3] } {
  const a = [
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ];
  let v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let sweep = 0; sweep < 32; sweep++) {
    let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-16) break;

    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;

      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
    void off;
  }

  const pairs: { val: number; vec: Vec3 }[] = [
    { val: a[0][0], vec: [v[0][0], v[1][0], v[2][0]] },
    { val: a[1][1], vec: [v[0][1], v[1][1], v[2][1]] },
    { val: a[2][2], vec: [v[0][2], v[1][2], v[2][2]] },
  ];
  pairs.sort((x, y) => x.val - y.val);

  return {
    values: [pairs[0].val, pairs[1].val, pairs[2].val],
    vectors: [norm3(pairs[0].vec), norm3(pairs[1].vec), norm3(pairs[2].vec)],
  };
}

// ── validation ───────────────────────────────────────────────────────────────

export interface MeshHealth {
  closed: boolean;
  manifold: boolean;
  orientable: boolean;
  boundaryEdges: number;
  nonManifoldEdges: number;
  degenerateTriangles: number;
  duplicateTriangles: number;
  /** Euler characteristic V - E + F; 2 for a simple closed solid. */
  euler: number;
  genus: number;
}

/**
 * Structural check of a mesh.
 *
 * This is the assertion that a solid is actually solid. Every interior edge of a closed,
 * orientable surface is used exactly twice, once in each direction. An edge used once is a
 * hole; three times is a non-manifold junction. Either way volume is undefined and the part
 * cannot be manufactured, so this runs after every boolean rather than only on export —
 * the point is to catch the operation that broke it, not to discover the damage later.
 */
export function health(m: Mesh): MeshHealth {
  const edges = new Map<string, number>();
  const undirected = new Map<string, number>();
  let degenerate = 0;

  const triKeys = new Set<string>();
  let duplicates = 0;

  for (let t = 0; t < triCount(m); t++) {
    const ia = m.indices[t * 3], ib = m.indices[t * 3 + 1], ic = m.indices[t * 3 + 2];
    if (ia === ib || ib === ic || ia === ic) { degenerate++; continue; }

    const sorted = [ia, ib, ic].sort((x, y) => x - y).join(',');
    if (triKeys.has(sorted)) duplicates++;
    else triKeys.add(sorted);

    for (const [u, v] of [[ia, ib], [ib, ic], [ic, ia]] as const) {
      edges.set(`${u},${v}`, (edges.get(`${u},${v}`) ?? 0) + 1);
      const k = u < v ? `${u},${v}` : `${v},${u}`;
      undirected.set(k, (undirected.get(k) ?? 0) + 1);
    }
  }

  let boundary = 0, nonManifold = 0;
  for (const count of undirected.values()) {
    if (count === 1) boundary++;
    else if (count > 2) nonManifold++;
  }

  // Orientable when no directed edge is traversed twice the same way. A pair of triangles
  // that both list an edge as (u, v) are wound inconsistently, so one faces inwards.
  let orientable = true;
  for (const count of edges.values()) if (count > 1) { orientable = false; break; }

  const V = vertCount(m);
  const E = undirected.size;
  const F = triCount(m) - degenerate;
  const euler = V - E + F;

  return {
    closed: boundary === 0 && nonManifold === 0,
    manifold: nonManifold === 0,
    orientable,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    degenerateTriangles: degenerate,
    duplicateTriangles: duplicates,
    euler,
    genus: Math.max(0, Math.round((2 - euler) / 2)),
  };
}

// ── transforms and combination ───────────────────────────────────────────────

export function transformMesh(m: Mesh, mx: Mat4): Mesh {
  const positions = new Float64Array(m.positions.length);
  for (let i = 0; i < m.positions.length; i += 3) {
    const p = xformPoint(mx, [m.positions[i], m.positions[i + 1], m.positions[i + 2]]);
    positions[i] = p[0]; positions[i + 1] = p[1]; positions[i + 2] = p[2];
  }

  // A mirror or negative scale reverses handedness, which turns every triangle inside out.
  // Flipping the winding back is what keeps the mirrored copy a solid rather than a void.
  let indices = m.indices;
  if (flipsOrientation(mx)) {
    indices = new Uint32Array(m.indices.length);
    for (let t = 0; t < m.indices.length; t += 3) {
      indices[t] = m.indices[t];
      indices[t + 1] = m.indices[t + 2];
      indices[t + 2] = m.indices[t + 1];
    }
  }

  const tags = new Map<number, FaceTag>();
  for (const [id, tag] of m.tags) {
    tags.set(id, {
      ...tag,
      normal: tag.normal ? norm3(xformPoint(mx, add3(tag.origin ?? [0, 0, 0], tag.normal)).map((v, i) =>
        v - xformPoint(mx, tag.origin ?? [0, 0, 0])[i]) as Vec3) : undefined,
      origin: tag.origin ? xformPoint(mx, tag.origin) : undefined,
    });
  }

  return { positions, indices, faceIds: m.faceIds, tags };
}

/** Concatenates meshes without any intersection handling. For disjoint bodies only. */
export function concatMeshes(meshes: Mesh[]): Mesh {
  let np = 0, ni = 0;
  for (const m of meshes) { np += m.positions.length; ni += m.indices.length; }

  const positions = new Float64Array(np);
  const indices = new Uint32Array(ni);
  const faceIds = new Uint32Array(ni / 3);
  const tags = new Map<number, FaceTag>();

  let po = 0, io = 0, fo = 0, base = 0, tagShift = 0;
  for (const m of meshes) {
    positions.set(m.positions, po);
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + base;
    // Tag ids are only unique within a mesh, so shift them to keep them distinct.
    for (let i = 0; i < m.faceIds.length; i++) faceIds[fo + i] = m.faceIds[i] + tagShift;
    for (const [id, tag] of m.tags) tags.set(id + tagShift, { ...tag, id: id + tagShift });

    base += m.positions.length / 3;
    po += m.positions.length;
    io += m.indices.length;
    fo += m.faceIds.length;

    // Highest tag id, found by iteration rather than `Math.max(...keys)`.
    //
    // Spreading an array into a call passes one argument per element, and every engine has a
    // limit — around 64k in V8. A model that has accumulated a few thousand face tags through
    // successive operations therefore blew the stack *inside* this line, and the failure
    // surfaced as "Maximum call stack size exceeded" on whichever feature happened to be
    // next, with no visible connection to the real cause.
    let highest = 0;
    for (const id of m.tags.keys()) if (id > highest) highest = id;
    tagShift += highest + 1;
  }

  return { positions, indices, faceIds, tags };
}

/**
 * Splits triangles at T-junctions.
 *
 * A T-junction is a vertex sitting in the middle of another triangle's edge without being
 * one of its corners. Any algorithm that subdivides two surfaces independently produces
 * them, and BSP-based CSG produces them constantly: one solid's face gets cut at the points
 * where the other solid's edges cross it, while the neighbouring face — cut by a different
 * plane — gets its own, different set of points.
 *
 * The result is a mesh that is geometrically watertight but topologically open. Volume comes
 * out exactly right, because the divergence theorem only cares about the surface being
 * geometrically closed, and the part looks perfect on screen. But no edge is shared, so:
 * a second boolean against this body has no consistent topology to work from, smooth
 * shading breaks along every seam, STL export produces a mesh slicers reject, and the
 * validity check that is supposed to catch real failures cries wolf on every operation.
 *
 * The fix is to find each edge used only once and insert any vertex that lies on it,
 * re-fanning the triangle. Since every triangle here is convex, the fan is always valid.
 */
export function repairTJunctions(m: Mesh, tol = 1e-7): Mesh {
  let current = m;

  // Splitting one triangle can expose a further T-junction on a neighbour, so iterate.
  // Three passes settles every case seen in practice; the loop exits early when stable.
  for (let pass = 0; pass < 4; pass++) {
    const next = repairPass(current, tol);
    if (next === current) break;
    current = next;
  }
  return current;
}

function repairPass(m: Mesh, tol: number): Mesh {
  const tris = triCount(m);
  if (tris === 0) return m;

  // Directed edge use counts identify which undirected edges are unpaired.
  const undirected = new Map<string, number>();
  for (let t = 0; t < tris; t++) {
    const ia = m.indices[t * 3], ib = m.indices[t * 3 + 1], ic = m.indices[t * 3 + 2];
    for (const [u, v] of [[ia, ib], [ib, ic], [ic, ia]] as const) {
      const k = u < v ? `${u},${v}` : `${v},${u}`;
      undirected.set(k, (undirected.get(k) ?? 0) + 1);
    }
  }

  const boundary = new Set<string>();
  for (const [k, n] of undirected) if (n === 1) boundary.add(k);
  if (boundary.size === 0) return m;

  // Only vertices touching a boundary edge can be T-junction candidates, which keeps the
  // search small even on a dense mesh.
  const candidates = new Set<number>();
  for (const k of boundary) {
    const [a, b] = k.split(',').map(Number);
    candidates.add(a);
    candidates.add(b);
  }

  // The grid cell must be sized from the model, not from the weld tolerance. Sizing it at
  // ~1e-4 mm means walking a 60 mm edge takes 600,000 steps and the repair pass never
  // finishes — the search cost has nothing to do with how precisely points must match, only
  // with how far apart they are.
  const bb = bounds(m);
  const cell = Math.max(boxDiagonal(bb) / 48, 1e-3);

  const grid = new Map<string, number[]>();
  const key = (p: Vec3) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
  for (const v of candidates) {
    const k = key(getVertex(m, v));
    const list = grid.get(k);
    if (list) list.push(v); else grid.set(k, [v]);
  }

  const outIdx: number[] = [];
  const outFace: number[] = [];
  let changed = false;

  for (let t = 0; t < tris; t++) {
    const corner = [m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2]];
    const fid = m.faceIds[t] ?? 0;

    const poly: number[] = [];
    let split = false;

    for (let e = 0; e < 3; e++) {
      const a = corner[e], b = corner[(e + 1) % 3];
      poly.push(a);

      const k = a < b ? `${a},${b}` : `${b},${a}`;
      if (!boundary.has(k)) continue;

      const found = verticesOnSegment(m, grid, cell, a, b, tol);
      if (found.length === 0) continue;

      poly.push(...found);
      split = true;
    }

    if (!split) {
      outIdx.push(corner[0], corner[1], corner[2]);
      outFace.push(fid);
      continue;
    }

    changed = true;
    for (let i = 1; i + 1 < poly.length; i++) {
      if (poly[0] === poly[i] || poly[i] === poly[i + 1] || poly[0] === poly[i + 1]) continue;
      outIdx.push(poly[0], poly[i], poly[i + 1]);
      outFace.push(fid);
    }
  }

  if (!changed) return m;

  return {
    positions: m.positions,
    indices: Uint32Array.from(outIdx),
    faceIds: Uint32Array.from(outFace),
    tags: m.tags,
  };
}

/** Vertices lying strictly between `a` and `b`, ordered along the segment. */
function verticesOnSegment(
  m: Mesh, grid: Map<string, number[]>, cell: number, a: number, b: number, tol: number,
): number[] {
  const pa = getVertex(m, a), pb = getVertex(m, b);
  const d = sub3(pb, pa);
  const lenSq = dot3(d, d);
  if (lenSq < tol * tol) return [];

  // Walk the grid cells the segment passes through.
  const seen = new Set<number>();
  const hits: { v: number; t: number }[] = [];
  const steps = Math.max(1, Math.ceil(Math.sqrt(lenSq) / cell) + 1);

  for (let s = 0; s <= steps; s++) {
    const p = add3(pa, mul3(d, s / steps));
    const bx = Math.floor(p[0] / cell), by = Math.floor(p[1] / cell), bz = Math.floor(p[2] / cell);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const v of grid.get(`${bx + dx},${by + dy},${bz + dz}`) ?? []) {
            if (v === a || v === b || seen.has(v)) continue;
            seen.add(v);

            const pv = getVertex(m, v);
            const w = sub3(pv, pa);
            const t = dot3(w, d) / lenSq;
            // Strictly interior, so endpoints are never re-inserted.
            if (t <= 1e-9 || t >= 1 - 1e-9) continue;

            // Perpendicular distance from the segment.
            const closest = add3(pa, mul3(d, t));
            if (distSq3(pv, closest) > tol * tol) continue;

            hits.push({ v, t });
          }
        }
      }
    }
  }

  hits.sort((x, y) => x.t - y.t);
  return hits.map((h) => h.v);
}

/**
 * Signed volume alone, without the rest of the mass properties.
 *
 * Cheap enough to call after every construction step, which is what makes `orientOutward`
 * practical.
 */
export function signedVolume(m: Mesh): number {
  let v = 0;
  for (let t = 0; t < triCount(m); t++) {
    const [a, b, c] = getTriangle(m, t);
    v += dot3(a, cross3(b, c)) / 6;
  }
  return v;
}

/**
 * Ensures a closed solid's triangles face outward.
 *
 * Whether a builder's natural winding comes out outward or inward depends on the handedness
 * of the sketch plane relative to the sweep or revolve direction, and there is no single
 * ordering that is correct for every combination. Rather than encode a table of sign rules
 * that would be wrong for some case nobody tested, each builder produces a consistently
 * wound solid and this flips the whole thing if it came out inside out. Negative volume is
 * an unambiguous signal, so this cannot guess wrong.
 *
 * Open meshes are returned untouched: their volume is undefined, so the test is meaningless.
 */
export function orientOutward(m: Mesh): Mesh {
  if (triCount(m) === 0) return m;
  if (!health(m).closed) return m;
  return signedVolume(m) < 0 ? flipMesh(m) : m;
}

/** Reverses every triangle, turning a solid inside out. */
export function flipMesh(m: Mesh): Mesh {
  const indices = new Uint32Array(m.indices.length);
  for (let t = 0; t < m.indices.length; t += 3) {
    indices[t] = m.indices[t];
    indices[t + 1] = m.indices[t + 2];
    indices[t + 2] = m.indices[t + 1];
  }
  const tags = new Map<number, FaceTag>();
  for (const [id, tag] of m.tags) {
    tags.set(id, { ...tag, normal: tag.normal ? (mul3(tag.normal, -1) as Vec3) : undefined });
  }
  return { ...m, indices, tags };
}

/**
 * Removes vertices no triangle references, and re-packs the arrays.
 *
 * Boolean operations orphan large numbers of vertices. Left in place they inflate every
 * subsequent bounding box, spatial hash and export.
 */
export function compact(m: Mesh): Mesh {
  const used = new Int32Array(vertCount(m)).fill(-1);
  for (let i = 0; i < m.indices.length; i++) used[m.indices[i]] = 0;

  let n = 0;
  for (let i = 0; i < used.length; i++) if (used[i] === 0) used[i] = n++;

  const positions = new Float64Array(n * 3);
  for (let i = 0; i < used.length; i++) {
    if (used[i] < 0) continue;
    positions[used[i] * 3] = m.positions[i * 3];
    positions[used[i] * 3 + 1] = m.positions[i * 3 + 1];
    positions[used[i] * 3 + 2] = m.positions[i * 3 + 2];
  }

  const indices = new Uint32Array(m.indices.length);
  for (let i = 0; i < m.indices.length; i++) indices[i] = used[m.indices[i]];

  return { positions, indices, faceIds: m.faceIds, tags: m.tags };
}

/** Triangle indices grouped by the modelling face they belong to. */
export function trianglesByFace(m: Mesh): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let t = 0; t < triCount(m); t++) {
    const f = m.faceIds[t];
    const list = out.get(f);
    if (list) list.push(t); else out.set(f, [t]);
  }
  return out;
}

/**
 * Ray-mesh intersection, nearest hit.
 *
 * Moller-Trumbore. Used for picking in the viewport and for inside/outside classification
 * during booleans, so it returns the face tag as well as the distance.
 */
export function raycast(
  m: Mesh, origin: Vec3, dir: Vec3,
): { t: number; triangle: number; faceId: number; point: Vec3 } | null {
  const d = norm3(dir);
  let best = Infinity, bestTri = -1;

  for (let t = 0; t < triCount(m); t++) {
    const [a, b, c] = getTriangle(m, t);
    const e1 = sub3(b, a), e2 = sub3(c, a);
    const h = cross3(d, e2);
    const det = dot3(e1, h);
    if (Math.abs(det) < 1e-14) continue; // ray parallel to the triangle plane

    const inv = 1 / det;
    const s = sub3(origin, a);
    const u = inv * dot3(s, h);
    if (u < -1e-9 || u > 1 + 1e-9) continue;

    const q = cross3(s, e1);
    const v = inv * dot3(d, q);
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;

    const dist = inv * dot3(e2, q);
    if (dist > 1e-9 && dist < best) { best = dist; bestTri = t; }
  }

  if (bestTri < 0) return null;
  return {
    t: best,
    triangle: bestTri,
    faceId: m.faceIds[bestTri],
    point: add3(origin, mul3(d, best)),
  };
}

/**
 * Point-in-solid test by ray parity.
 *
 * The direction is deliberately irrational so the ray is vanishingly unlikely to graze an
 * edge or vertex, where the parity count would be ambiguous. A "nice" direction like +X
 * hits that degenerate case constantly on axis-aligned CAD geometry — which is nearly all
 * of it — and misclassifies points, which during a boolean means whole regions are kept
 * or dropped wrongly.
 */
export function pointInside(m: Mesh, p: Vec3): boolean {
  const dir: Vec3 = norm3([0.5773502691896258, 0.3717480344601846, 0.7269292390407131]);
  let crossings = 0;

  for (let t = 0; t < triCount(m); t++) {
    const [a, b, c] = getTriangle(m, t);
    const e1 = sub3(b, a), e2 = sub3(c, a);
    const h = cross3(dir, e2);
    const det = dot3(e1, h);
    if (Math.abs(det) < 1e-14) continue;

    const inv = 1 / det;
    const s = sub3(p, a);
    const u = inv * dot3(s, h);
    if (u < 0 || u > 1) continue;
    const q = cross3(s, e1);
    const v = inv * dot3(dir, q);
    if (v < 0 || u + v > 1) continue;
    if (inv * dot3(e2, q) > 1e-12) crossings++;
  }

  return (crossings & 1) === 1;
}

/**
 * What the faces of a solid *mean*.
 *
 * The mesh knows it has 47 tagged faces. It does not know that faces 12, 13 and 14 are one
 * counterbored M6 clearance hole, that faces 3 and 21 are the two surfaces a bracket bolts
 * between, or that the 0.5 mm cylinder at face 9 is a fillet rather than a pin. Every
 * downstream capability needs that reading:
 *
 *   - **Mating.** You cannot propose "concentric" without knowing which cylinder is a bore
 *     and which is a shaft. A bore and a shaft look identical in the tag — same kind, same
 *     radius, same axis — and differ only in which side the material is on.
 *   - **GD&T.** Datum selection is "the largest planar face that seats against something",
 *     and position tolerance applies to a *pattern* of holes, not to eleven unrelated
 *     cylinders.
 *   - **DFM.** "This wall is 0.8 mm" needs to know it is a wall.
 *
 * The classification is deliberately conservative and explainable. Every role is derived
 * from a geometric test that can be stated in one sentence, and anything that does not meet
 * a test stays `freeform` rather than being guessed at. A wrong role here becomes a wrong
 * mate or a wrong datum later, and both are worse than an absent one — the whole point of
 * the surrounding architecture is that the machine says what it does not know.
 *
 * Nothing in this file is a heuristic over pixels or a learned model. It is topology and
 * analytic surface data, so it gives the same answer every time and a reviewer can check it.
 */

import {
  dot3, len3, mul3, norm3, sub3, boxDiagonal, boxSize,
  type Box3, type Vec3,
} from '../math/vec';
import {
  bounds, getTriangle, getVertex, triangleArea, triangleNormal, trianglesByFace, triCount,
  type FaceTag, type Mesh,
} from './mesh';

// ── roles ────────────────────────────────────────────────────────────────────

/**
 * What a face is *for*, as opposed to what shape it is.
 *
 * `bore` and `shaft` are the same surface kind and differ only in which side the solid is
 * on; that distinction is the single most useful fact in the whole graph, because it is
 * what turns "two cylinders" into "a pin that goes in a hole".
 */
export type FaceRole =
  | 'planar'    // a flat face with nothing else notable about it
  | 'seat'      // a large flat face — a mounting surface and a datum candidate
  | 'bore'      // internal cylinder: material outside, so this is a hole wall
  | 'shaft'     // external cylinder: material inside, so this is a pin, boss or shaft
  | 'fillet'    // a small blend tangent to its neighbours on both sides
  | 'chamfer'   // a small flat or conical break between two faces
  | 'conical'
  | 'spherical'
  | 'toroidal'
  | 'freeform'; // understood as a surface, not understood as a feature

export interface FaceInfo {
  id: number;
  tag: FaceTag;
  role: FaceRole;
  /** Summed triangle area, mm². */
  area: number;
  /** Area-weighted centroid. */
  centroid: Vec3;
  /**
   * Plane normal for flat faces, axis direction for analytic ones.
   *
   * Recomputed from the triangles rather than trusted from the tag. Tags are optional, are
   * absent on boolean off-cuts, and survive transforms that should have flipped them.
   */
  axis: Vec3;
  /** Cylinder, cone-at-base, sphere or torus radius. */
  radius?: number;
  /** A point on the axis, for the analytic kinds. */
  origin?: Vec3;
  /** Axial span of the face measured from `origin` along `axis`. */
  extent?: [min: number, max: number];
  triangles: number[];
  /** Ids of the faces sharing at least one edge with this one. */
  neighbours: number[];
}

/**
 * A shared boundary between two faces.
 *
 * `smooth` is the load-bearing field. A blend meets its neighbours tangentially and a
 * genuine edge does not, so smoothness is what separates a fillet from a quarter-round boss
 * — and no amount of looking at the cylinder alone can tell you which it is.
 */
export interface FaceLink {
  a: number;
  b: number;
  /** Total length of the shared boundary. */
  length: number;
  /** Largest dihedral turn along the boundary, degrees. */
  angleDeg: number;
  convex: boolean;
  /** True when the faces meet tangentially — a blend, not an edge. */
  smooth: boolean;
}

export interface FaceGraph {
  faces: Map<number, FaceInfo>;
  links: FaceLink[];
  bounds: Box3;
  /** Body diagonal, used to scale every "is this small?" test. */
  scale: number;
  /** Face ids by descending area — datum and seat candidates, best first. */
  byArea: number[];
}

/** Faces meeting within this angle are treated as tangent rather than as an edge. */
const SMOOTH_DEG = 12;

/** A blend is small relative to the part; above this a cylinder is a real feature. */
const BLEND_FRACTION = 0.08;

/**
 * A flat face counts as a seat above this fraction of the largest flat face.
 *
 * Half, not a quarter. On a 40×30×10 plate the sides are 400 and 300 mm² against a 1200 mm²
 * face, and a quarter admitted all six — which makes the role meaningless, because a part
 * where everything is a seat has told you nothing about where it mounts.
 */
const SEAT_FRACTION = 0.5;

// ── construction ─────────────────────────────────────────────────────────────

export function buildFaceGraph(mesh: Mesh): FaceGraph {
  const box = bounds(mesh);
  const scale = boxDiagonal(box) || 1;

  const faces = describeFaces(mesh);
  const links = linkFaces(mesh, faces);

  for (const link of links) {
    faces.get(link.a)?.neighbours.push(link.b);
    faces.get(link.b)?.neighbours.push(link.a);
  }

  classify(mesh, faces, links, scale);

  const byArea = [...faces.values()].sort((x, y) => y.area - x.area).map((f) => f.id);

  return { faces, links, bounds: box, scale, byArea };
}

/**
 * Per-face geometry, measured from the triangles.
 *
 * Area weighting throughout: an unweighted centroid of a tessellated cylinder drifts toward
 * whichever end happened to get more triangles, which is enough to make two identical bores
 * disagree about where they are.
 */
function describeFaces(mesh: Mesh): Map<number, FaceInfo> {
  const out = new Map<number, FaceInfo>();

  for (const [id, triangles] of trianglesByFace(mesh)) {
    let area = 0;
    let cx = 0, cy = 0, cz = 0;
    let nx = 0, ny = 0, nz = 0;

    for (const t of triangles) {
      const [p, q, r] = getTriangle(mesh, t);
      const a = triangleArea(p, q, r);
      if (a <= 0) continue;

      area += a;
      cx += ((p[0] + q[0] + r[0]) / 3) * a;
      cy += ((p[1] + q[1] + r[1]) / 3) * a;
      cz += ((p[2] + q[2] + r[2]) / 3) * a;

      const n = triangleNormal(p, q, r);
      nx += n[0] * a; ny += n[1] * a; nz += n[2] * a;
    }

    if (area <= 0) continue;
    const centroid: Vec3 = [cx / area, cy / area, cz / area];

    const tag: FaceTag = mesh.tags.get(id) ?? { id, feature: 'unknown', kind: 'freeform' };

    // For a flat face the area-weighted normal is the normal. For a closed analytic face it
    // very nearly cancels, so the tag's stored axis is the only source — and where the tag
    // has none, the face is simply not analytic as far as we are concerned.
    const summed: Vec3 = [nx / area, ny / area, nz / area];
    const axis = tag.kind === 'planar' || len3(summed) > 0.9
      ? norm3(summed)
      : (tag.normal ? norm3(tag.normal) : norm3(summed));

    const info: FaceInfo = {
      id,
      tag,
      role: 'freeform',
      area,
      centroid,
      axis: len3(axis) > 0 ? axis : [0, 0, 1],
      radius: tag.radius,
      origin: tag.origin,
      triangles,
      neighbours: [],
    };

    if (tag.origin && tag.kind !== 'planar') {
      info.extent = axialExtent(mesh, triangles, tag.origin, info.axis);
    }

    out.set(id, info);
  }

  return out;
}

/** How far the face reaches along its own axis, relative to the axis origin. */
function axialExtent(mesh: Mesh, triangles: number[], origin: Vec3, axis: Vec3): [number, number] {
  let min = Infinity, max = -Infinity;

  for (const t of triangles) {
    for (let k = 0; k < 3; k++) {
      const p = getVertex(mesh, mesh.indices[t * 3 + k]);
      const d = dot3(sub3(p, origin), axis);
      if (d < min) min = d;
      if (d > max) max = d;
    }
  }

  return [min, max];
}

/**
 * Shared boundaries between differently-tagged faces.
 *
 * Every mesh edge is visited once. Edges interior to a face are skipped — they are
 * tessellation, not topology — and edges with anything other than two incident triangles are
 * skipped too, because a non-manifold edge has no meaningful dihedral angle and guessing one
 * would put a fictional convexity into the graph.
 */
function linkFaces(mesh: Mesh, faces: Map<number, FaceInfo>): FaceLink[] {
  interface Acc { length: number; angleDeg: number; convex: boolean; }
  const acc = new Map<string, Acc>();

  const edges = new Map<string, number[]>();
  for (let t = 0; t < triCount(mesh); t++) {
    for (let e = 0; e < 3; e++) {
      const u = mesh.indices[t * 3 + e];
      const v = mesh.indices[t * 3 + ((e + 1) % 3)];
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      const list = edges.get(key);
      if (list) list.push(t); else edges.set(key, [t]);
    }
  }

  for (const [key, tris] of edges) {
    if (tris.length !== 2) continue;

    const fa = mesh.faceIds[tris[0]] ?? 0;
    const fb = mesh.faceIds[tris[1]] ?? 0;
    if (fa === fb) continue;
    if (!faces.has(fa) || !faces.has(fb)) continue;

    const [ui, vi] = key.split(',').map(Number);
    const pa = getVertex(mesh, ui);
    const pb = getVertex(mesh, vi);

    const [p, q, r] = getTriangle(mesh, tris[0]);
    const [s, u2, v2] = getTriangle(mesh, tris[1]);
    const n0 = triangleNormal(p, q, r);
    const n1 = triangleNormal(s, u2, v2);

    const d = Math.max(-1, Math.min(1, dot3(n0, n1)));
    const angleDeg = (Math.acos(d) * 180) / Math.PI;

    // Convex when the far vertex of the second triangle lies behind the first's plane —
    // the same test the fillet code uses, kept identical on purpose so a fillet DATUM
    // recognises is a fillet DATUM can also build.
    const far = [s, u2, v2].find((w) => len3(sub3(w, pa)) > 1e-9 && len3(sub3(w, pb)) > 1e-9) ?? s;
    const convex = dot3(n0, sub3(far, pa)) < 0;

    const lo = Math.min(fa, fb), hi = Math.max(fa, fb);
    const id = `${lo},${hi}`;
    const length = len3(sub3(pb, pa));

    const existing = acc.get(id);
    if (existing) {
      existing.length += length;
      if (angleDeg > existing.angleDeg) {
        existing.angleDeg = angleDeg;
        existing.convex = convex;
      }
    } else {
      acc.set(id, { length, angleDeg, convex });
    }
  }

  return [...acc].map(([id, a]) => {
    const [x, y] = id.split(',').map(Number);
    return {
      a: x, b: y,
      length: a.length,
      angleDeg: a.angleDeg,
      convex: a.convex,
      smooth: a.angleDeg <= SMOOTH_DEG,
    };
  });
}

// ── classification ───────────────────────────────────────────────────────────

function classify(mesh: Mesh, faces: Map<number, FaceInfo>, links: FaceLink[], scale: number): void {
  const linksByFace = new Map<number, FaceLink[]>();
  for (const link of links) {
    for (const id of [link.a, link.b]) {
      const list = linksByFace.get(id);
      if (list) list.push(link); else linksByFace.set(id, [link]);
    }
  }

  let largestFlat = 0;
  for (const f of faces.values()) {
    if (f.tag.kind === 'planar' && f.area > largestFlat) largestFlat = f.area;
  }

  for (const f of faces.values()) {
    const own = linksByFace.get(f.id) ?? [];
    const small = (f.radius ?? Infinity) < scale * BLEND_FRACTION;

    // A blend is tangent to what it joins. Requiring *both* sides smooth is what keeps a
    // rounded external corner from being read as a shaft you could put a bearing on.
    const tangentSides = own.filter((l) => l.smooth).length;
    const blended = small && tangentSides >= 2;

    switch (f.tag.kind) {
      case 'planar':
        if (blended) f.role = 'chamfer';
        else if (largestFlat > 0 && f.area >= largestFlat * SEAT_FRACTION) f.role = 'seat';
        else f.role = 'planar';
        break;

      case 'cylindrical':
        if (blended) f.role = 'fillet';
        else f.role = enclosesMaterial(mesh, f) ? 'shaft' : 'bore';
        break;

      case 'conical':
        f.role = blended ? 'chamfer' : 'conical';
        break;

      case 'spherical': f.role = 'spherical'; break;
      case 'toroidal': f.role = blended ? 'fillet' : 'toroidal'; break;
      default: f.role = 'freeform'; break;
    }
  }
}

/**
 * True when the solid is *inside* this cylinder — a shaft — rather than outside it.
 *
 * The test is the only thing separating a pin from a hole, so it is done per triangle and
 * area-weighted rather than sampled: take the outward normal where it is known exactly, from
 * the winding, and compare it with the direction pointing away from the axis. A shaft's
 * outward normal points away from its own axis; a bore's points back toward it.
 *
 * Triangles lying near the axis contribute nothing, because their radial direction is
 * numerically meaningless.
 */
function enclosesMaterial(mesh: Mesh, face: FaceInfo): boolean {
  const origin = face.origin ?? face.centroid;
  let vote = 0;

  for (const t of face.triangles) {
    const [p, q, r] = getTriangle(mesh, t);
    const a = triangleArea(p, q, r);
    if (a <= 0) continue;

    const c: Vec3 = [(p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3, (p[2] + q[2] + r[2]) / 3];
    const rel = sub3(c, origin);
    const radial = sub3(rel, mul3(face.axis, dot3(rel, face.axis)));
    const rl = len3(radial);
    if (rl < 1e-9) continue;

    vote += dot3(triangleNormal(p, q, r), mul3(radial, 1 / rl)) * a;
  }

  return vote > 0;
}

// ── queries ──────────────────────────────────────────────────────────────────

export const facesWithRole = (g: FaceGraph, role: FaceRole): FaceInfo[] =>
  [...g.faces.values()].filter((f) => f.role === role);

/**
 * The faces a datum scheme would start from: flat, large, and facing different ways.
 *
 * Ordered by area, then filtered so no two candidates are parallel-and-coincident — the two
 * halves of a thin plate are not two independent datums, and offering both is how an
 * automatic datum scheme ends up with A and B meaning the same thing.
 */
export function seatCandidates(g: FaceGraph, limit = 6): FaceInfo[] {
  const flat = g.byArea
    .map((id) => g.faces.get(id)!)
    .filter((f) => f.role === 'seat' || f.role === 'planar');

  const out: FaceInfo[] = [];
  for (const f of flat) {
    if (out.some((k) => Math.abs(dot3(k.axis, f.axis)) > 0.999)) continue;
    out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}

/** Total surface area, for reporting and for sanity-checking a graph against its mesh. */
export const graphArea = (g: FaceGraph): number =>
  [...g.faces.values()].reduce((s, f) => s + f.area, 0);

/**
 * A one-line description of each face, for diagnostics and for showing a user *why* a mate
 * or a datum was proposed. An automatic decision nobody can interrogate does not get used
 * twice.
 */
export function describeGraph(g: FaceGraph): string[] {
  return g.byArea.map((id) => {
    const f = g.faces.get(id)!;
    const size = f.radius !== undefined ? `⌀${(f.radius * 2).toFixed(2)}` : `${f.area.toFixed(1)}mm²`;
    return `#${f.id} ${f.role} ${size} n=[${f.axis.map((v) => v.toFixed(2)).join(',')}]`;
  });
}

/** Extent of the solid along an arbitrary direction — used to decide whether a hole is through. */
export function spanAlong(mesh: Mesh, axis: Vec3): [min: number, max: number] {
  const a = norm3(axis);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const d = a[0] * mesh.positions[i] + a[1] * mesh.positions[i + 1] + a[2] * mesh.positions[i + 2];
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

/** Re-exported so callers can size their own tolerances the same way this module does. */
export const bodyScale = (mesh: Mesh): number => boxDiagonal(bounds(mesh)) || 1;

/** Convenience for tests and callers that only want the box. */
export const bodySize = (mesh: Mesh): Vec3 => boxSize(bounds(mesh));

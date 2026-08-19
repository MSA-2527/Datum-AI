/**
 * Uniform subdivision, and displacing a surface along its normal.
 *
 * Together these turn a flat face into a modelled one: refine it until the triangles are small
 * enough to carry the detail, then push each vertex out by however much the detail says.
 *
 * Every triangle is split, not just the ones being displaced. Splitting a subset is cheaper and
 * produces a mesh that is not closed: an edge divided on one side and left whole on the other
 * leaves a vertex sitting in the middle of its neighbour's edge, and a T-junction is a crack
 * that no amount of later repair recovers from — the solid stops being a solid, its volume
 * stops being computable, and it exports as something no CAM package will accept. Splitting
 * everything keeps the mesh watertight by construction, and the cost is triangles in places
 * that did not need them.
 */

import { getTriangle, triCount, type Mesh } from '../topo/mesh';
import { type Vec3 } from '../math/vec';

/** Above this a subdivision is refused rather than allowed to exhaust memory. */
export const MAX_TRIANGLES = 400_000;

/**
 * Splits every triangle into four, `levels` times.
 *
 * Midpoints are shared through a map keyed on the two endpoint indices, so an edge divided from
 * one side and from the other lands on exactly the same vertex — the same value computed twice
 * would differ in the last bit and leave a seam that reads as a crack.
 *
 * Face tags come through unchanged: a subdivided face is the same face, and renumbering it
 * would break selection, colouring and every feature scoped to it.
 */
export function subdivide(mesh: Mesh, levels = 1): Mesh {
  let current = mesh;

  for (let level = 0; level < levels; level++) {
    const tris = triCount(current);
    if (tris === 0 || tris * 4 > MAX_TRIANGLES) break;

    const positions: number[] = Array.from(current.positions);
    const indices: number[] = [];
    const faceIds: number[] = [];

    const midpoints = new Map<number, number>();

    const midpoint = (a: number, b: number): number => {
      // Ordered key, so the edge is the same edge whichever triangle asks for it.
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = lo * 0x100000 + hi;

      const seen = midpoints.get(key);
      if (seen !== undefined) return seen;

      const index = positions.length / 3;
      for (let k = 0; k < 3; k++) {
        positions.push((positions[lo * 3 + k]! + positions[hi * 3 + k]!) / 2);
      }
      midpoints.set(key, index);
      return index;
    };

    for (let t = 0; t < tris; t++) {
      const a = current.indices[t * 3]!;
      const b = current.indices[t * 3 + 1]!;
      const c = current.indices[t * 3 + 2]!;

      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);

      const face = current.faceIds[t]!;
      for (const tri of [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]) {
        indices.push(tri[0]!, tri[1]!, tri[2]!);
        faceIds.push(face);
      }
    }

    current = {
      positions: Float64Array.from(positions),
      indices: Uint32Array.from(indices),
      faceIds: Uint32Array.from(faceIds),
      tags: current.tags,
    };
  }

  return current;
}

/**
 * Moves the vertices of chosen faces along a direction, by however much `amount` says.
 *
 * `amount` is asked for the vertex's own position, so the caller can drive it from anything —
 * a height field read off a photograph, a formula, a texture. Vertices belonging to more than
 * one face move once, which matters where a displaced face meets one that is not: the shared
 * vertices are the seam, and moving them twice would tear it.
 */
export function displaceFaces(
  mesh: Mesh, faces: Set<number>, direction: Vec3, amount: (p: Vec3) => number,
): Mesh {
  const tris = triCount(mesh);
  if (tris === 0 || faces.size === 0) return mesh;

  const moving = new Set<number>();
  for (let t = 0; t < tris; t++) {
    if (!faces.has(mesh.faceIds[t]!)) continue;
    moving.add(mesh.indices[t * 3]!);
    moving.add(mesh.indices[t * 3 + 1]!);
    moving.add(mesh.indices[t * 3 + 2]!);
  }

  const positions = Float64Array.from(mesh.positions);
  for (const v of moving) {
    const p: Vec3 = [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
    const d = amount(p);
    if (!Number.isFinite(d) || d === 0) continue;

    positions[v * 3] = p[0] + direction[0] * d;
    positions[v * 3 + 1] = p[1] + direction[1] * d;
    positions[v * 3 + 2] = p[2] + direction[2] * d;
  }

  return { ...mesh, positions };
}

/** Face ids whose triangles all face within `toleranceDeg` of `direction`. */
export function facesFacing(mesh: Mesh, direction: Vec3, toleranceDeg = 15): Set<number> {
  const limit = Math.cos((toleranceDeg * Math.PI) / 180);
  const tris = triCount(mesh);

  // A face qualifies only if *every* one of its triangles faces the right way. Any single
  // triangle pointing elsewhere means the tag covers more than the flat top — displacing it
  // would drag part of a wall along with the surface.
  const verdict = new Map<number, boolean>();

  for (let t = 0; t < tris; t++) {
    const face = mesh.faceIds[t]!;
    if (verdict.get(face) === false) continue;

    const [a, b, c] = getTriangle(mesh, t);
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: Vec3 = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];

    const length = Math.hypot(n[0], n[1], n[2]);
    if (length < 1e-12) continue;   // a degenerate triangle says nothing about the face

    const towards = (n[0] * direction[0] + n[1] * direction[1] + n[2] * direction[2]) / length;
    verdict.set(face, (verdict.get(face) ?? true) && towards >= limit);
  }

  const out = new Set<number>();
  for (const [face, ok] of verdict) if (ok) out.add(face);
  return out;
}

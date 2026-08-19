/**
 * The outline of a face, taken from the triangles that make it.
 *
 * What push-pull needs. Dragging a face outwards has to build something with exactly that
 * face's shape, and the face is not stored as a shape anywhere — it is a set of triangles that
 * happen to share a tag. Its outline is the edges those triangles do not share with each other.
 *
 * Holes come out as separate loops, which matters immediately: pulling on the top face of a
 * plate that has been drilled must not fill the holes in.
 */

import { getTriangle, triCount, type Mesh } from './mesh';
import { type Vec3 } from '../math/vec';

export interface FaceBoundary {
  /** The outer loop, in order. */
  outer: Vec3[];
  /** Interior loops — holes in the face. */
  holes: Vec3[][];
}

/** Vertices snapped to this grid count as the same point. */
const WELD = 1e-6;

const keyOf = (p: Vec3): string =>
  `${Math.round(p[0] / WELD)},${Math.round(p[1] / WELD)},${Math.round(p[2] / WELD)}`;

/**
 * Boundary loops of one face.
 *
 * An edge shared by two triangles of the same face is interior; an edge belonging to only one
 * is on the boundary. Chaining those gives the outline — and because the triangles of a face
 * are consistently wound, following each edge from its start vertex walks the loop in order
 * without any geometric sorting.
 *
 * Returns null when the face has no closed loop, which happens on a degenerate or a
 * single-triangle sliver. Callers refuse rather than build something from half an outline.
 */
export function faceBoundary(mesh: Mesh, faceId: number): FaceBoundary | null {
  const tris = triCount(mesh);

  // Directed edges of this face, counted. An interior edge appears once in each direction.
  const seen = new Map<string, { from: Vec3; to: Vec3 }>();
  const points = new Map<string, Vec3>();

  const remember = (p: Vec3): string => {
    const k = keyOf(p);
    if (!points.has(k)) points.set(k, p);
    return k;
  };

  for (let t = 0; t < tris; t++) {
    if (mesh.faceIds[t] !== faceId) continue;

    const v = getTriangle(mesh, t);
    for (let i = 0; i < 3; i++) {
      const from = v[i]!;
      const to = v[(i + 1) % 3]!;

      const a = remember(from);
      const b = remember(to);
      if (a === b) continue;   // a degenerate edge is not a boundary

      // If the opposite direction is already present, the two triangles share this edge and
      // neither side of it is on the boundary.
      const opposite = `${b}|${a}`;
      if (seen.has(opposite)) { seen.delete(opposite); continue; }

      seen.set(`${a}|${b}`, { from, to });
    }
  }

  if (seen.size < 3) return null;

  // Chain the surviving edges into loops by following each one to the next that starts where
  // it ended.
  const next = new Map<string, string[]>();
  for (const key of seen.keys()) {
    const [a, b] = key.split('|') as [string, string];
    const list = next.get(a);
    if (list) list.push(b); else next.set(a, [b]);
  }

  const loops: Vec3[][] = [];
  const used = new Set<string>();

  for (const start of next.keys()) {
    if (used.has(start)) continue;

    const loop: Vec3[] = [];
    let at = start;

    // Bounded by the edge count: a malformed face must not spin here forever.
    for (let step = 0; step <= seen.size; step++) {
      if (used.has(at)) break;
      used.add(at);

      const point = points.get(at);
      if (!point) break;
      loop.push(point);

      const onward = next.get(at);
      if (!onward || onward.length === 0) break;
      at = onward[0]!;

      if (at === start) break;
    }

    if (loop.length >= 3) loops.push(loop);
  }

  if (loops.length === 0) return null;

  // The longest loop is the outer one. Length rather than area, because area needs a plane and
  // this is used on faces that are not always flat.
  const lengthOf = (loop: Vec3[]): number => {
    let total = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    return total;
  };

  loops.sort((a, b) => lengthOf(b) - lengthOf(a));
  return { outer: loops[0]!, holes: loops.slice(1) };
}

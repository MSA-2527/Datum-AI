/**
 * Recovering boundary representation from a triangle mesh.
 *
 * This is the half of STEP export that decides whether the result is CAD or a triangle dump
 * wearing a `.step` extension. Both import without error. Only one of them is usable.
 *
 * A naive exporter writes one `ADVANCED_FACE` per triangle. A 512-triangle bracket then
 * arrives in SOLIDWORKS as 512 faces, and every operation a user would want — select the top
 * face, offset it, put a hole through it, measure its area — has to be done 512 times or not
 * at all. The file is valid and worthless.
 *
 * So the facets are put back together first:
 *
 *  1. **Weld** coincident vertices, because booleans leave duplicates that split what should
 *     be one edge.
 *  2. **Group** triangles into maximal connected coplanar regions. The top of a plate becomes
 *     one face, not two hundred.
 *  3. **Trace** each region's boundary from its directed edges, which gives loops already
 *     wound correctly about the region normal — outer anticlockwise, holes clockwise.
 *  4. **Dissolve** vertices that lie in the middle of a straight edge, so a rectangle is four
 *     edges rather than forty. Done globally rather than per-face: a vertex is removed only
 *     when *every* face that meets there agrees, or the two sides of an edge end up
 *     subdivided differently and the shell is no longer conformal.
 *
 * The output is a topology where adjacent faces share edge identity, which is what makes a
 * closed shell a solid rather than a bag of loose faces.
 */

import {
  cross3, dot3, len3, norm3, sub3, type Vec3,
} from '../kernel/math/vec';
import { getVertex, repairTJunctions, triCount, type Mesh } from '../kernel/topo/mesh';
import { angleAbout, axisFrame, findRevolved, type FoundSurface } from './revolved';

/**
 * What a face lies on.
 *
 * A plane is what a triangle mesh gives you directly. A cylinder has to be recovered, and is
 * worth recovering: it turns a forty-five-facet hole into one face that a downstream package
 * can measure, counterbore and recognise as a drilling operation.
 */
export type BrepSurface =
  | { kind: 'plane'; normal: Vec3; origin: Vec3 }
  | {
      kind: 'cylinder';
      axis: Vec3;
      origin: Vec3;
      radius: number;
      /** True when the material is inside the surface — a shaft rather than a bore. */
      outward: boolean;
      /** Which part of the revolution this face covers, as angles about the axis. */
      from: number;
      to: number;
    }
  | {
      kind: 'cone';
      axis: Vec3;
      /** The point every tangent plane passes through. */
      apex: Vec3;
      /** Between the axis and the surface, in radians. */
      halfAngle: number;
      /** A point on the axis where the radius is known, and that radius. */
      origin: Vec3;
      radius: number;
      outward: boolean;
      from: number;
      to: number;
    };

/** What an edge lies on. A chord is not on a cylinder, so a curved face needs curved edges. */
export type BrepCurve =
  | { kind: 'line' }
  | { kind: 'circle'; axis: Vec3; centre: Vec3; radius: number };

export interface BrepEdge {
  /** Welded vertex indices. */
  a: number;
  b: number;
  curve: BrepCurve;
}

export interface BrepLoop {
  /** Welded vertex indices, in order, wound about the face normal. */
  vertices: number[];
  /** Directed edge ids, parallel to `vertices`; negative means the edge is reversed here. */
  edges: number[];
}

export interface BrepFace {
  surface: BrepSurface;
  /** Anticlockwise about the surface normal. */
  outer: BrepLoop;
  /** Holes, clockwise about the surface normal. */
  inner: BrepLoop[];
  /** Face tag this region came from, for naming. */
  tag: number;
  area: number;
}

export interface Brep {
  /** Welded, deduplicated. */
  vertices: Vec3[];
  /** Undirected, shared between the faces that meet along them. */
  edges: BrepEdge[];
  faces: BrepFace[];
  report: {
    trianglesIn: number;
    facesOut: number;
    verticesWelded: number;
    edgesDissolved: number;
    /** Regions whose boundary could not be traced into closed loops. */
    unclosedRegions: number;
    /**
     * Edges not used by exactly two face loops.
     *
     * The one number that predicts whether a receiving package will knit the shell into a
     * solid. Anything above zero means the faces disagree about where their shared boundary
     * runs, and the import lands as a surface body instead. Reported rather than hidden,
     * because "it opened but it is not a solid" is the worst way to find out.
     */
    nonConformalEdges: number;
    /** Analytic surfaces recovered, and the facets they replaced between them. */
    cylindersFound: number;
    conesFound: number;
    facetsReplaced: number;
  };
}

/**
 * Welds vertices onto a grid.
 *
 * Grid snapping rather than pairwise comparison: pairwise is O(n²) and a 20 000-triangle
 * assembly makes that visible. The grid is keyed at the tolerance, and neighbours are checked
 * too, so two points either side of a cell boundary still merge.
 */
function weld(m: Mesh, tol: number): { verts: Vec3[]; map: Uint32Array } {
  const n = m.positions.length / 3;
  const map = new Uint32Array(n);
  const verts: Vec3[] = [];
  const grid = new Map<string, number[]>();

  const key = (x: number, y: number, z: number) =>
    `${Math.round(x / tol)},${Math.round(y / tol)},${Math.round(z / tol)}`;

  for (let i = 0; i < n; i++) {
    const p = getVertex(m, i);
    let found = -1;

    // The cell and its 26 neighbours, so a point sitting just across a boundary from an
    // earlier one still finds it.
    outer:
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cell = grid.get(key(p[0] + dx * tol, p[1] + dy * tol, p[2] + dz * tol));
          if (!cell) continue;
          for (const c of cell) {
            const q = verts[c];
            if (Math.abs(q[0] - p[0]) <= tol && Math.abs(q[1] - p[1]) <= tol &&
                Math.abs(q[2] - p[2]) <= tol) {
              found = c;
              break outer;
            }
          }
        }
      }
    }

    if (found < 0) {
      found = verts.length;
      verts.push(p);
      const k = key(p[0], p[1], p[2]);
      const cell = grid.get(k);
      if (cell) cell.push(found); else grid.set(k, [found]);
    }
    map[i] = found;
  }

  return { verts, map };
}

/**
 * Groups triangles into maximal connected coplanar regions.
 *
 * Connectivity as well as coplanarity: the top and the bottom of a plate are parallel and
 * would merge on plane alone, producing one "face" made of two disjoint sheets that no
 * boundary trace can turn into loops. They are separate faces because they do not touch.
 *
 * The plane test compares against the *seed* triangle rather than the neighbour, so a long
 * run of slightly-off facets around a cylinder cannot drift into a single bent region one
 * tolerance at a time.
 */
function planarRegions(
  m: Mesh, map: Uint32Array, angleTol: number, planeTol: number,
): { tris: number[]; normal: Vec3; origin: Vec3 }[] {
  const count = triCount(m);
  const normals: Vec3[] = [];
  const centres: Vec3[] = [];

  for (let t = 0; t < count; t++) {
    const a = getVertex(m, m.indices[t * 3]);
    const b = getVertex(m, m.indices[t * 3 + 1]);
    const c = getVertex(m, m.indices[t * 3 + 2]);
    const n = cross3(sub3(b, a), sub3(c, a));
    const l = len3(n);
    normals.push(l > 1e-12 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 1]);
    centres.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
  }

  // Triangles sharing a welded edge are neighbours.
  const acrossEdge = new Map<string, number[]>();
  const edgeKey = (u: number, v: number) => (u < v ? `${u}_${v}` : `${v}_${u}`);
  for (let t = 0; t < count; t++) {
    for (let e = 0; e < 3; e++) {
      const u = map[m.indices[t * 3 + e]];
      const v = map[m.indices[t * 3 + ((e + 1) % 3)]];
      if (u === v) continue;
      const k = edgeKey(u, v);
      const list = acrossEdge.get(k);
      if (list) list.push(t); else acrossEdge.set(k, [t]);
    }
  }

  const cosTol = Math.cos(angleTol);
  const seen = new Uint8Array(count);
  const regions: { tris: number[]; normal: Vec3; origin: Vec3 }[] = [];

  for (let start = 0; start < count; start++) {
    if (seen[start]) continue;

    const seedN = normals[start];
    const seedC = centres[start];
    const tris: number[] = [];
    const stack = [start];
    seen[start] = 1;

    while (stack.length > 0) {
      const t = stack.pop()!;
      tris.push(t);

      for (let e = 0; e < 3; e++) {
        const u = map[m.indices[t * 3 + e]];
        const v = map[m.indices[t * 3 + ((e + 1) % 3)]];
        if (u === v) continue;

        for (const nb of acrossEdge.get(edgeKey(u, v)) ?? []) {
          if (seen[nb]) continue;
          // Same facet only when it faces the same way *and* lies in the same plane. The
          // second test is what stops two parallel walls a millimetre apart being fused.
          if (dot3(normals[nb], seedN) < cosTol) continue;
          if (Math.abs(dot3(sub3(centres[nb], seedC), seedN)) > planeTol) continue;

          seen[nb] = 1;
          stack.push(nb);
        }
      }
    }

    regions.push({ tris, normal: seedN, origin: seedC });
  }

  return regions;
}

/**
 * Traces a region's boundary into closed loops.
 *
 * Works on directed edges: an edge of the region that has no opposing twin inside the region
 * is on its boundary. Because the mesh is outward-oriented, following those directions gives
 * loops already wound anticlockwise about the region normal for the outer boundary and
 * clockwise for holes — so the winding never has to be guessed, and a hole is never mistaken
 * for an outline.
 */
function traceLoops(
  m: Mesh, map: Uint32Array, tris: number[],
): { loops: number[][]; closed: boolean } {
  const directed = new Set<string>();
  for (const t of tris) {
    for (let e = 0; e < 3; e++) {
      const u = map[m.indices[t * 3 + e]];
      const v = map[m.indices[t * 3 + ((e + 1) % 3)]];
      if (u !== v) directed.add(`${u}>${v}`);
    }
  }

  // A boundary edge is one whose reverse is not also in this region.
  const outgoing = new Map<number, number[]>();
  for (const key of directed) {
    const [u, v] = key.split('>').map(Number);
    if (directed.has(`${v}>${u}`)) continue;
    const list = outgoing.get(u);
    if (list) list.push(v); else outgoing.set(u, [v]);
  }

  const loops: number[][] = [];
  let closed = true;

  while (outgoing.size > 0) {
    const startKey = outgoing.keys().next().value as number;
    const loop: number[] = [];
    let at = startKey;

    for (;;) {
      const nexts = outgoing.get(at);
      if (!nexts || nexts.length === 0) { closed = false; break; }

      const next = nexts.pop()!;
      if (nexts.length === 0) outgoing.delete(at);
      loop.push(at);

      if (next === startKey) break;
      at = next;

      // A boundary that leaves the region and never returns is malformed input; bail rather
      // than spin.
      if (loop.length > 100000) { closed = false; break; }
    }

    if (loop.length >= 3) loops.push(loop);
  }

  return { loops, closed };
}

/** Signed area of a loop projected onto the plane, positive when wound about the normal. */
function loopArea(verts: Vec3[], loop: number[], normal: Vec3): number {
  let sum: Vec3 = [0, 0, 0];
  for (let i = 0; i < loop.length; i++) {
    const p = verts[loop[i]];
    const q = verts[loop[(i + 1) % loop.length]];
    const c = cross3(p, q);
    sum = [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]];
  }
  return dot3(sum, normal) / 2;
}

/**
 * Removes vertices that sit in the middle of a straight edge.
 *
 * Global, not per-loop, and that is the whole point. Two faces meet along an edge; if one of
 * them dissolves a vertex and the other does not, they no longer share the same edge and the
 * shell stops being conformal — which is exactly the kind of file that imports with
 * "unable to knit solid".
 *
 * So a vertex is dissolvable only when, across the entire model, it has exactly two incident
 * boundary edges, those two are collinear, and both separate the same pair of faces. Then
 * every face that touches it agrees, and removing it is safe everywhere at once.
 */
function dissolveCollinear(
  verts: Vec3[], faces: { loops: number[][]; }[], angleTol: number, keep: Set<number>,
): { removed: Set<number>; count: number } {
  // vertex -> the loops (face, loop index, position) it appears in
  const incidence = new Map<number, { f: number; l: number; i: number }[]>();
  faces.forEach((face, f) => {
    face.loops.forEach((loop, l) => {
      loop.forEach((v, i) => {
        const list = incidence.get(v);
        const entry = { f, l, i };
        if (list) list.push(entry); else incidence.set(v, [entry]);
      });
    });
  });

  const removed = new Set<number>();
  const cosTol = Math.cos(angleTol);

  for (const [v, uses] of incidence) {
    // A vertex on a straight edge between two faces appears exactly twice: once in each
    // face's loop. More than that and it is a corner where three or more faces meet, which
    // must stay.
    if (uses.length !== 2) continue;

    // A rim vertex anchors an arc. Dissolving one would leave the cap's boundary and the
    // bore's boundary describing different curves, which is the non-conformal case.
    if (keep.has(v)) continue;

    let collinearEverywhere = true;
    const neighbourSets: string[] = [];

    for (const u of uses) {
      const loop = faces[u.f].loops[u.l];
      if (loop.length <= 3) { collinearEverywhere = false; break; }

      const prev = loop[(u.i - 1 + loop.length) % loop.length];
      const next = loop[(u.i + 1) % loop.length];
      if (removed.has(prev) || removed.has(next)) { collinearEverywhere = false; break; }

      const d1 = norm3(sub3(verts[v], verts[prev]));
      const d2 = norm3(sub3(verts[next], verts[v]));
      if (dot3(d1, d2) < cosTol) { collinearEverywhere = false; break; }

      neighbourSets.push(prev < next ? `${prev}_${next}` : `${next}_${prev}`);
    }

    // Both faces must be spanning the *same* pair of neighbours, or they are describing
    // different subdivisions of the edge and dissolving would desynchronise them.
    if (!collinearEverywhere) continue;
    if (neighbourSets[0] !== neighbourSets[1]) continue;

    removed.add(v);
  }

  if (removed.size > 0) {
    for (const face of faces) {
      face.loops = face.loops
        .map((loop) => loop.filter((v) => !removed.has(v)))
        .filter((loop) => loop.length >= 3);
    }
  }

  return { removed, count: removed.size };
}

/**
 * How many arcs a full revolution is cut into.
 *
 * Three, not two, and the reason is identity rather than accuracy. Two 180° arcs of the same
 * circle share *both* endpoints, so an undirected vertex-pair key cannot tell them apart and
 * the two collapse into one edge — which is how the first attempt produced a cylinder with a
 * boundary that made no sense. Three arcs give every arc a distinct pair of ends. They are
 * also 120° each, well clear of the half-circle case where an importer has to decide which way
 * round the trim goes.
 */
const ARCS_PER_REVOLUTION = 3;

/**
 * The arcs one rim was cut into.
 *
 * `cuts[i]` → `cuts[i+1]` is `arcs[i]`, wrapping at the end, so together they close the
 * circle. A cap walks the same rim the opposite way round, which is why the cuts are kept in
 * order rather than as a set.
 */
interface RimArcs {
  cuts: number[];
  /** Signed edge ids, as `edgeIdFor` returns them. */
  arcs: number[];
}

/**
 * Rebuilds a cap's boundary loop out of the arcs of the rim it closes.
 *
 * The cap traverses the rim in the opposite direction to the bore, but "opposite" is not
 * something to assume — a cap can be either side. The direction is read off the loop itself:
 * walking forwards from the first cut, whichever other cut comes first tells you which way
 * this loop is going round.
 *
 * Returns null when the loop does not line up, in which case the caller keeps the polygon,
 * which is always correct and merely verbose.
 */
function rebuildAsArcs(loop: number[], rim: RimArcs): BrepLoop | null {
  const n = loop.length;
  const at = rim.cuts.map((v) => loop.indexOf(v));
  if (at.some((i) => i < 0)) return null;

  const stepTo = (i: number) => (i - at[0] + n) % n;
  const forwards = stepTo(at[1]) < stepTo(at[2]);

  if (forwards) {
    return { vertices: [...rim.cuts], edges: [...rim.arcs] };
  }

  // Backwards: visit the cuts in reverse and traverse each arc against its stored direction.
  return {
    vertices: [rim.cuts[0], rim.cuts[2], rim.cuts[1]],
    edges: [-rim.arcs[2], -rim.arcs[1], -rim.arcs[0]],
  };
}

/**
 * Turns one recognised cylinder into two half-faces and the arcs its rims now use.
 *
 * Both rims are split at the same two angles, so the seam runs straight along the axis rather
 * than spiralling around the face.
 */
function buildRevolvedFaces(
  found: FoundSurface,
  verts: Vec3[],
  edgeIdFor: (a: number, b: number, curve?: BrepCurve) => number,
  tag: number,
  /**
   * Rims already cut by an earlier surface.
   *
   * Two curved surfaces can meet along a rim — a funnel's cone runs into its spout — and if
   * each chooses its own three cut points they describe the same circle with six different
   * arcs and the shell comes apart. The first to reach a rim cuts it; the second reuses
   * exactly those arcs.
   */
  existing: Map<string, RimArcs>,
): { faces: BrepFace[]; rims: [string, RimArcs][] } | null {
  const surface = found.surface;
  const { u, v } = axisFrame(surface);
  const [rim0, rim1] = found.rims;

  const angleOf = (vid: number) => angleAbout(verts[vid], surface, u, v);
  const startAngle = angleOf(rim0.ring[0]);

  /** Smallest signed difference between two angles, in (-pi, pi]. */
  const angleGap = (a: number, b: number): number => {
    const d = (a - b) % (2 * Math.PI);
    return Math.abs(d > Math.PI ? d - 2 * Math.PI : d < -Math.PI ? d + 2 * Math.PI : d);
  };

  /**
   * Index of the ring vertex closest to a given angle.
   *
   * The comparison has to wrap properly. Subtracting raw angles and folding anything over pi
   * looks right and is not: the targets run past pi by construction (start + 120, start + 240),
   * so the naive fold produced negative distances and every cut after the first landed on the
   * same vertex. A bore came out with three coincident cuts and was rejected as untessellatable.
   */
  const nearest = (ring: number[], target: number): number => {
    let best = 0, bestGap = Infinity;
    for (let k = 0; k < ring.length; k++) {
      const d = angleGap(angleOf(ring[k]), target);
      if (d < bestGap) { bestGap = d; best = k; }
    }
    return best;
  };

  /** The ring walked forwards from one index to another, inclusive. */
  const span = (ring: number[], from: number, to: number): number[] => {
    const out: number[] = [];
    for (let k = from; ; k = (k + 1) % ring.length) {
      out.push(ring[k]);
      if (k === to) break;
      if (out.length > ring.length) break;
    }
    return out;
  };

  const N = ARCS_PER_REVOLUTION;
  const step = (2 * Math.PI) / N;

  // Cut both rims at the same angles, so the seams run straight along the axis rather than
  // spiralling around the face.
  const cutAngles = Array.from({ length: N }, (_, k) => startAngle + k * step);
  const idx0 = cutAngles.map((a) => nearest(rim0.ring, a));
  const idx1 = cutAngles.map((a) => nearest(rim1.ring, a));

  // Distinct cut points, and at least one intermediate vertex on every arc, or the rim is too
  // coarsely tessellated to be worth calling a circle.
  if (new Set(idx0).size !== N || new Set(idx1).size !== N) return null;
  for (let k = 0; k < N; k++) {
    if (span(rim0.ring, idx0[k], idx0[(k + 1) % N]).length < 2) return null;
    if (span(rim1.ring, idx1[k], idx1[(k + 1) % N]).length < 2) return null;
  }

  // Each rim carries its own radius. They are equal on a cylinder and differ on a cone, which
  // is the whole difference between the two as far as the boundary is concerned.
  const circle0: BrepCurve = { kind: 'circle', axis: surface.axis, centre: rim0.centre, radius: rim0.radius };
  const circle1: BrepCurve = { kind: 'circle', axis: surface.axis, centre: rim1.centre, radius: rim1.radius };

  const keyOf = (ring: number[]) => [...ring].sort((x, y) => x - y).join(',');
  const was0 = existing.get(keyOf(rim0.ring));
  const was1 = existing.get(keyOf(rim1.ring));

  // Reuse an already-cut rim rather than cutting it again, or the two surfaces meeting there
  // would describe one circle with two different sets of arcs.
  const cuts0 = was0 ? was0.cuts : idx0.map((i) => rim0.ring[i]);
  const cuts1 = was1 ? was1.cuts : idx1.map((i) => rim1.ring[i]);

  const bottom = was0 ? was0.arcs : cuts0.map((v, k) => edgeIdFor(v, cuts0[(k + 1) % N], circle0));
  const top = was1 ? was1.arcs : cuts1.map((v, k) => edgeIdFor(v, cuts1[(k + 1) % N], circle1));
  const seam = cuts0.map((v, k) => edgeIdFor(v, cuts1[k]));

  // Every arc and seam must be its own edge. A collision means two of them share both ends,
  // which cannot be represented and must not be silently merged.
  const ids = [...bottom, ...top, ...seam].map(Math.abs);
  if (new Set(ids).size !== ids.length) return null;

  // A reused rim's arcs run the other way round from this surface's point of view, because the
  // surface on the far side traversed them in the opposite direction.
  const orient = (arcs: number[], reused: boolean) => (reused ? arcs.map((a) => -a) : arcs);
  const bottomArcs = orient(bottom, !!was0);
  const topArcs = orient(top, !!was1);

  const height = Math.abs(rim1.along - rim0.along);
  const slant = surface.kind === 'cone' ? height / Math.cos(surface.halfAngle) : height;
  const meanRadius = (rim0.radius + rim1.radius) / 2;

  const patch = (from: number, to: number): BrepSurface =>
    surface.kind === 'cylinder'
      ? {
          kind: 'cylinder', axis: surface.axis, origin: surface.origin,
          radius: surface.radius, outward: surface.outward, from, to,
        }
      : {
          kind: 'cone', axis: surface.axis, apex: surface.apex,
          halfAngle: surface.halfAngle,
          // STEP states a cone by a radius at a named place on the axis rather than by its
          // apex, so one rim is carried as that reference.
          origin: rim0.centre, radius: rim0.radius,
          outward: surface.outward, from, to,
        };

  const faces: BrepFace[] = [];
  for (let k = 0; k < N; k++) {
    const next = (k + 1) % N;
    faces.push({
      surface: patch(cutAngles[k], cutAngles[k] + step),
      // Along the bottom arc, up the next seam, back along the top arc, down this seam.
      outer: {
        vertices: [cuts0[k], cuts0[next], cuts1[next], cuts1[k]],
        edges: [bottomArcs[k], seam[next], -topArcs[k], -seam[k]],
      },
      inner: [],
      tag,
      area: meanRadius * step * slant,
    });
  }

  return {
    faces,
    rims: [
      ...(was0 ? [] : [[keyOf(rim0.ring), { cuts: cuts0, arcs: bottom }] as [string, RimArcs]]),
      ...(was1 ? [] : [[keyOf(rim1.ring), { cuts: cuts1, arcs: top }] as [string, RimArcs]]),
    ],
  };
}

export interface BrepOptions {
  /** Distance below which two vertices are the same point. */
  weldTol?: number;
  /** Angle below which two facets are the same plane, in radians. */
  angleTol?: number;
  /** Distance a facet may sit off the region's plane. */
  planeTol?: number;
  /**
   * Distance a vertex may sit off a fitted analytic surface.
   *
   * Deliberately looser than the plane tolerance. A tessellated cylinder's vertices lie exactly
   * on the surface they sample, but a neighbouring strip is admitted by testing it against a
   * fit estimated from only the first three — so the working tolerance has to allow for that
   * estimate being slightly off, or a perfectly good bore is rejected one facet at a time.
   */
  surfaceTol?: number;
  /** Set false to export every curved surface as facets. */
  recogniseCylinders?: boolean;
}

/**
 * Turns a triangle mesh into faces, edges and vertices.
 *
 * Recognising analytic surfaces is an improvement, never a risk. If replacing facets with a
 * cylinder or a cone leaves the shell non-conformal — some edge no longer walked by exactly
 * two faces — the whole recognition pass is discarded and the mesh is re-read as plain
 * planes. A verbose solid that knits is worth far more than an elegant one that arrives as
 * loose surfaces, and no user should have to know which case they got.
 */
export function meshToBrep(m: Mesh, opts: BrepOptions = {}): Brep {
  const attempt = buildBrep(m, opts);
  if (attempt.report.nonConformalEdges === 0) return attempt;
  if (opts.recogniseCylinders === false) return attempt;
  if (attempt.report.cylindersFound === 0 && attempt.report.conesFound === 0) return attempt;

  const planar = buildBrep(m, { ...opts, recogniseCylinders: false });
  return planar.report.nonConformalEdges < attempt.report.nonConformalEdges ? planar : attempt;
}

function buildBrep(m: Mesh, opts: BrepOptions = {}): Brep {
  const tris = triCount(m);
  if (tris === 0) {
    return {
      vertices: [], edges: [], faces: [],
      report: {
        trianglesIn: 0, facesOut: 0, verticesWelded: 0, edgesDissolved: 0,
        unclosedRegions: 0, nonConformalEdges: 0,
        cylindersFound: 0, conesFound: 0, facetsReplaced: 0,
      },
    };
  }

  // Model scale, for relative tolerances.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < m.positions.length; i++) {
    if (m.positions[i] < lo) lo = m.positions[i];
    if (m.positions[i] > hi) hi = m.positions[i];
  }
  const scale = Math.max(1, hi - lo);

  const weldTol = opts.weldTol ?? scale * 1e-7;
  const angleTol = opts.angleTol ?? 1e-4;
  const planeTol = opts.planeTol ?? scale * 1e-6;

  // T-junctions have to go before anything else looks at the topology.
  //
  // A T-junction is a vertex lying partway along another face's edge. The two faces then
  // describe the edge between them differently — one as a single span, the other as two — and
  // no amount of care further down recovers a shared edge from that. The shell exports with
  // edges belonging to one face instead of two, and the importer says "unable to knit solid".
  //
  // The BSP boolean fallback leaves them routinely; Manifold does not. Repairing here rather
  // than trusting the source means the exporter is correct for either.
  const sound = repairTJunctions(m, weldTol);

  const { verts, map } = weld(sound, weldTol);
  const regions = planarRegions(sound, map, angleTol, planeTol);

  // Recover the surfaces of revolution before anything is committed to faces.
  //
  // Order matters: a cylinder consumes whole regions, and the planar pass must not already
  // have turned them into faces with polygonal boundaries. What comes back is the fit, the
  // facets it claims, and its two rims — and the rims are what let the caps that close them
  // be rebuilt with arcs instead of forty short chords.
  const surfaceTol = opts.surfaceTol ?? scale * 2e-3;
  const candidates = opts.recogniseCylinders === false ? [] : findRevolved(
    sound, map, verts, regions,
    (t) => traceLoops(sound, map, t),
    { tol: surfaceTol },
  );

  const ringKey = (ring: number[]) => [...ring].sort((x, y) => x - y).join(',');

  // Keep only the surfaces whose rims a neighbouring face actually shares.
  //
  // A rim is a boundary between the curved surface and whatever closes it. The curved side
  // describes it with three arcs; the flat side has to describe it with the same three, and it
  // can only do that if its own loop is exactly that ring of vertices. When it is not — the
  // rim runs into another feature, or the face beside it was split — the two sides disagree
  // and every edge along the rim ends up owned by one face instead of two.
  //
  // This is checked rather than hoped for. Recognising a flange's twelve bores left 673 of its
  // edges non-conformal, and the failure was silent right up to the point where a CAD package
  // refused to knit the result. Dropping a surface only returns regions to the planar pass, so
  // a couple of rounds settle it.
  let revolved = candidates;
  for (let pass = 0; pass < 3 && revolved.length > 0; pass++) {
    const taken = new Set(revolved.flatMap((r) => r.regions));

    const available = new Set<string>();
    regions.forEach((r, i) => {
      if (taken.has(i)) return;
      for (const loop of traceLoops(sound, map, r.tris).loops) available.add(ringKey(loop));
    });

    // A rim shared by two curved surfaces is legitimate and common — a funnel's cone runs
    // straight into its spout — and no planar face owns it. Those are counted separately, and
    // the pair reuses one set of arcs so the two sides cannot disagree.
    const shared = new Map<string, number>();
    for (const r of revolved) {
      for (const rim of r.rims) {
        const k = ringKey(rim.ring);
        shared.set(k, (shared.get(k) ?? 0) + 1);
      }
    }

    const kept = revolved.filter((r) => r.rims.every((rim) => {
      const k = ringKey(rim.ring);
      return available.has(k) || shared.get(k) === 2;
    }));
    if (kept.length === revolved.length) break;
    revolved = kept;
  }

  // Build the cylindrical faces first, and only then decide which regions they claim.
  //
  // Recognising a cylinder and being able to represent one are different things: a rim too
  // coarsely tessellated to cut into arcs is found but cannot be built. Claiming its regions
  // before knowing that deleted the facets and left a hole in the shell. A cylinder that
  // cannot be built simply does not claim anything, and its facets stay planar.
  const cylinderFaces: BrepFace[] = [];
  const arcsForRing = new Map<string, RimArcs>();
  const claimed = new Set<number>();

  // Shared edge table. Both faces along an edge look it up by the same undirected key, so
  // they come away referencing one edge rather than two coincident ones.
  const edges: BrepEdge[] = [];
  const edgeIndex = new Map<string, number>();
  const edgeIdFor = (a: number, b: number, curve: BrepCurve = { kind: 'line' }): number => {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    let id = edgeIndex.get(k);
    if (id === undefined) {
      id = edges.length;
      edges.push({ a: Math.min(a, b), b: Math.max(a, b), curve });
      edgeIndex.set(k, id);
    }
    // Positive when this use runs the same way the edge is stored.
    return a < b ? id + 1 : -(id + 1);
  };

  for (const cyl of revolved) {
    const built = buildRevolvedFaces(cyl, verts, edgeIdFor, sound.faceIds[cyl.tris[0]], arcsForRing);
    if (!built) continue;

    cylinderFaces.push(...built.faces);
    for (const [key, arcs] of built.rims) arcsForRing.set(key, arcs);
    for (const r of cyl.regions) claimed.add(r);
  }

  // Trace the regions no cylinder took.
  let unclosed = 0;
  const traced = regions
    .map((r, i) => ({ r, i }))
    .filter(({ i }) => !claimed.has(i))
    .map(({ r }) => {
      const { loops, closed } = traceLoops(sound, map, r.tris);
      if (!closed) unclosed++;
      return { loops, normal: r.normal, origin: r.origin, tag: sound.faceIds[r.tris[0]] };
    })
    .filter((r) => r.loops.length > 0);

  // A rim vertex anchors an arc, so it has to survive the dissolve pass.
  const rimVertices = new Set<number>();
  for (const key of arcsForRing.keys()) {
    for (const v of key.split(',')) rimVertices.add(Number(v));
  }

  const dissolved = dissolveCollinear(verts, traced, angleTol, rimVertices);

  const faces: BrepFace[] = [...cylinderFaces];

  // ── planar faces ──
  //
  // A loop that is exactly one of a cylinder's rims is rebuilt from that rim's arcs, so the
  // cap and the bore agree about the boundary they share. Everything else stays polygonal.
  const toLoop = (loop: number[]): BrepLoop => {
    const arcs = arcsForRing.get(ringKey(loop));
    const rebuilt = arcs && rebuildAsArcs(loop, arcs);
    if (rebuilt) return rebuilt;

    return {
      vertices: loop,
      edges: loop.map((v, i) => edgeIdFor(v, loop[(i + 1) % loop.length])),
    };
  };

  for (const r of traced) {
    const withArea = r.loops.map((loop) => ({ loop, area: loopArea(verts, loop, r.normal) }));

    // The outer boundary is the one with the largest positive area; anything else is a hole.
    withArea.sort((x, y) => y.area - x.area);
    const outer = withArea[0];
    if (!outer || outer.area <= 0) continue;

    faces.push({
      surface: { kind: 'plane', normal: r.normal, origin: verts[outer.loop[0]] },
      outer: toLoop(outer.loop),
      inner: withArea.slice(1).map((w) => toLoop(w.loop)),
      tag: r.tag,
      area: withArea.reduce((s, w) => s + w.area, 0),
    });
  }

  // Drop vertices nothing references any more.
  //
  // Recognising a cylinder leaves most of its rim vertices unused: forty-five points around a
  // bore collapse to the three the arcs are cut at. Carrying the rest would write forty-two
  // dead CARTESIAN_POINTs per hole and — worse — make Euler's formula report a solid that
  // looks broken when it is not.
  const referenced = new Set<number>();
  for (const e of edges) { referenced.add(e.a); referenced.add(e.b); }

  const remap = new Map<number, number>();
  const vertices: Vec3[] = [];
  for (const old of [...referenced].sort((a, b) => a - b)) {
    remap.set(old, vertices.length);
    vertices.push(verts[old]);
  }

  for (const e of edges) {
    e.a = remap.get(e.a)!;
    e.b = remap.get(e.b)!;
  }
  for (const face of faces) {
    for (const loop of [face.outer, ...face.inner]) {
      loop.vertices = loop.vertices.map((v) => remap.get(v) ?? 0);
    }
  }

  // Every edge of a closed solid is walked once by each of the two faces that meet along it.
  // Counting the uses is a direct check of that, and it is cheap next to having built them.
  const uses = new Uint32Array(edges.length);
  for (const face of faces) {
    for (const loop of [face.outer, ...face.inner]) {
      for (const signed of loop.edges) uses[Math.abs(signed) - 1]++;
    }
  }
  let nonConformal = 0;
  for (const u of uses) if (u !== 2) nonConformal++;

  return {
    vertices,
    edges,
    faces,
    report: {
      trianglesIn: tris,
      facesOut: faces.length,
      verticesWelded: (m.positions.length / 3) - verts.length,
      edgesDissolved: dissolved.count,
      unclosedRegions: unclosed,
      nonConformalEdges: nonConformal,
      cylindersFound: revolved.filter((r) => r.surface.kind === 'cylinder').length,
      conesFound: revolved.filter((r) => r.surface.kind === 'cone').length,
      facetsReplaced: revolved.reduce((n, c) => n + c.tris.length, 0),
    },
  };
}

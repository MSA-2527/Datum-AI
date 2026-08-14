/**
 * Recognising surfaces of revolution in a tessellated solid.
 *
 * A hole leaves the modeller as a ring of narrow flat strips, and a countersink or a chamfer
 * as a second ring of slightly different ones. Geometrically that is fine and semantically it
 * is empty: nothing downstream can read a diameter, match a drill, or tell a 90° countersink
 * from an arbitrary taper. Recovering the cylinder or cone those strips sample collapses
 * dozens of faces into three and removes the tessellation error entirely, because the analytic
 * surface *is* the surface the facets were approximating.
 *
 * The pass is deliberately reluctant. A fillet, a swept blend and a slightly-bowed plate are
 * all nearly cylindrical; a shallow dome is nearly conical. Accepting one would move geometry
 * the user never asked to move. So every candidate has to survive four separate tests — the
 * fit, the residual against the model's own scale, a consistent radial orientation, and
 * finally a boundary that is genuinely two circular rims. Anything that fails falls back to
 * planar facets, which is always correct and merely verbose.
 *
 * Cylinders are tried before cones. A cylinder is the degenerate cone with a half-angle of
 * zero and an apex at infinity, so a cone fit on cylindrical input is ill-conditioned rather
 * than wrong — better to let the well-posed fit claim it first.
 */

import { cross3, dot3, norm3, sub3, type Vec3 } from '../kernel/math/vec';
import { getVertex, type Mesh } from '../kernel/topo/mesh';
import { fitCone, fitCylinder, perpTo } from './fit';

/** A surface of revolution recovered from facets. */
export type Revolved =
  | { kind: 'cylinder'; axis: Vec3; origin: Vec3; radius: number; outward: boolean }
  | { kind: 'cone'; axis: Vec3; apex: Vec3; halfAngle: number; outward: boolean };

/** A region of coplanar facets, as produced by the planar pass. */
export interface Region {
  tris: number[];
  normal: Vec3;
  origin: Vec3;
}

export interface Rim {
  /** Welded vertex ids, in traced order. */
  ring: number[];
  /** Centre of the circle these lie on. */
  centre: Vec3;
  /** Distance along the axis from the surface's own origin. */
  along: number;
  /** Radius of this rim — the same for both rims of a cylinder, different for a cone. */
  radius: number;
}

export interface FoundSurface {
  surface: Revolved;
  /** Indices into the region array. */
  regions: number[];
  tris: number[];
  rims: [Rim, Rim];
}

/** A point on the axis, from which `along` is measured. */
export function axisOrigin(r: Revolved): Vec3 {
  return r.kind === 'cylinder' ? r.origin : r.apex;
}

/** The surface's radius at a given distance along the axis. */
export function radiusAt(r: Revolved, along: number): number {
  return r.kind === 'cylinder' ? r.radius : Math.max(0, along) * Math.tan(r.halfAngle);
}

/** Distance from a point to the surface, measured perpendicular to it. */
export function offSurface(p: Vec3, r: Revolved): number {
  const d = sub3(p, axisOrigin(r));
  const along = dot3(d, r.axis);
  const radial: Vec3 = [
    d[0] - r.axis[0] * along,
    d[1] - r.axis[1] * along,
    d[2] - r.axis[2] * along,
  ];
  const rho = Math.hypot(radial[0], radial[1], radial[2]);

  // For a cone the error is measured along the surface normal, which is tilted away from the
  // radius by the half-angle; ignoring that overstates the residual on a steep taper.
  return r.kind === 'cylinder'
    ? Math.abs(rho - r.radius)
    : Math.abs(rho - radiusAt(r, along)) * Math.cos(r.halfAngle);
}

/** Facet centre, normal and vertex ids for a set of triangles. */
function samplesFor(m: Mesh, map: Uint32Array, tris: number[], verts: Vec3[]) {
  const facetCentres: Vec3[] = [];
  const normals: Vec3[] = [];
  const vids = new Set<number>();

  for (const t of tris) {
    const ia = m.indices[t * 3], ib = m.indices[t * 3 + 1], ic = m.indices[t * 3 + 2];
    const a = getVertex(m, ia), b = getVertex(m, ib), c = getVertex(m, ic);
    const n = cross3(sub3(b, a), sub3(c, a));
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-12) continue;

    facetCentres.push([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]);
    normals.push([n[0] / l, n[1] / l, n[2] / l]);
    vids.add(map[ia]); vids.add(map[ib]); vids.add(map[ic]);
  }

  return { facetCentres, normals, vertices: [...vids].map((i) => verts[i]), tol: 0 };
}

/**
 * The surface a group of facets was *declared* to lie on, if they all agree.
 *
 * Far better than fitting when it is available. The kernel tags every face a primitive builds
 * with the surface it came from, and Manifold carries those tags through booleans untouched —
 * so a bore drilled through a plate still knows it is a 10 mm cylinder. Fitting rediscovers
 * that from the triangles and gets 10.000000006, because the boolean's intersection points
 * carry a few parts per billion of noise.
 *
 * It also works where fitting cannot. A surface trimmed until only a narrow band survives has
 * too little left to fit, but it still knows what it is.
 */
function declaredSurface(m: Mesh, tris: number[]): Revolved | null {
  let first: { kind: string; axis: Vec3; origin: Vec3; radius: number; halfAngle?: number } | null = null;

  for (const t of tris) {
    const tag = m.tags.get(m.faceIds[t]);
    if (!tag || !tag.normal || !tag.origin || tag.radius === undefined) return null;
    if (tag.kind !== 'cylindrical' && tag.kind !== 'conical') return null;
    if (tag.kind === 'conical' && tag.halfAngle === undefined) return null;

    const here = {
      kind: tag.kind, axis: norm3(tag.normal), origin: tag.origin,
      radius: tag.radius, halfAngle: tag.halfAngle,
    };

    if (!first) { first = here; continue; }

    // Every facet must name the *same* surface. Two coaxial bores of different diameter would
    // otherwise merge into one impossible face.
    if (here.kind !== first.kind) return null;
    if (Math.abs(here.radius - first.radius) > 1e-9) return null;
    if (Math.abs(Math.abs(dot3(here.axis, first.axis)) - 1) > 1e-9) return null;
    if (Math.abs((here.halfAngle ?? 0) - (first.halfAngle ?? 0)) > 1e-12) return null;

    // Same axis line, not merely the same direction.
    const d = sub3(here.origin, first.origin);
    const along = dot3(d, first.axis);
    const off = Math.hypot(
      d[0] - first.axis[0] * along, d[1] - first.axis[1] * along, d[2] - first.axis[2] * along);
    if (off > 1e-7) return null;
  }

  if (!first) return null;

  if (first.kind === 'cylindrical') {
    return {
      kind: 'cylinder', axis: first.axis, origin: first.origin,
      radius: first.radius,
      // Which side the material is on is a property of *this* body, not of the surface the
      // tag describes, so it is still read from the facets.
      outward: true,
    };
  }

  // A cone's tag gives a radius at a known place; the apex is where that radius reaches zero.
  const toApex = first.radius / Math.tan(first.halfAngle!);
  return {
    kind: 'cone',
    axis: first.axis,
    apex: [
      first.origin[0] - first.axis[0] * toApex,
      first.origin[1] - first.axis[1] * toApex,
      first.origin[2] - first.axis[2] * toApex,
    ],
    halfAngle: first.halfAngle!,
    outward: true,
  };
}

/** Reads which side the material is on, from the facets themselves. */
function orientationOf(m: Mesh, map: Uint32Array, tris: number[], verts: Vec3[], surface: Revolved): boolean | null {
  const s = samplesFor(m, map, tris, verts);
  const origin = axisOrigin(surface);
  let votes = 0;

  for (let i = 0; i < s.normals.length; i++) {
    const d = sub3(s.facetCentres[i], origin);
    const t = dot3(d, surface.axis);
    const radial = norm3([
      d[0] - surface.axis[0] * t, d[1] - surface.axis[1] * t, d[2] - surface.axis[2] * t,
    ]);
    votes += dot3(s.normals[i], radial) > 0 ? 1 : -1;
  }

  if (s.normals.length === 0) return null;
  return Math.abs(votes) === s.normals.length ? votes > 0 : null;
}

/** Tries the declared surface first, then a cylinder, then a cone. */
function fitRevolved(
  m: Mesh, map: Uint32Array, tris: number[], verts: Vec3[], tol: number,
): Revolved | null {
  const declared = declaredSurface(m, tris);
  if (declared) {
    const outward = orientationOf(m, map, tris, verts, declared);
    if (outward !== null) {
      const oriented = { ...declared, outward } as Revolved;
      // Trust but verify: the tag says what the surface is, and the vertices have to actually
      // be on it. A tag that survived an operation it should not have is caught here.
      const s0 = samplesFor(m, map, tris, verts);
      if (s0.vertices.every((v) => offSurface(v, oriented) <= tol)) return oriented;
    }
  }

  const s = { ...samplesFor(m, map, tris, verts), tol };

  const cyl = fitCylinder(s);
  if (cyl) {
    return {
      kind: 'cylinder', axis: cyl.axis, origin: cyl.origin,
      radius: cyl.radius, outward: cyl.outward,
    };
  }

  const cone = fitCone(s);
  if (cone) {
    return {
      kind: 'cone', axis: cone.axis, apex: cone.apex,
      halfAngle: cone.halfAngle, outward: cone.outward,
    };
  }

  return null;
}

/** Does every facet of this region sit on the surface, facing the same way round? */
function regionAgrees(
  m: Mesh, map: Uint32Array, verts: Vec3[], region: Region, surface: Revolved, tol: number,
): boolean {
  // A cylinder's normals are perpendicular to its axis; a cone's make a fixed angle with it.
  const along = dot3(region.normal, surface.axis);
  const expected = surface.kind === 'cylinder'
    ? 0
    : (surface.outward ? -1 : 1) * Math.sin(surface.halfAngle);
  if (Math.abs(along - expected) > 0.08) return false;

  const s = samplesFor(m, map, region.tris, verts);
  for (const v of s.vertices) if (offSurface(v, surface) > tol) return false;

  // The material must be on the same side as the rest of the surface, or a boss and the bore
  // running through it would merge into one impossible face.
  const origin = axisOrigin(surface);
  for (let i = 0; i < s.normals.length; i++) {
    const d = sub3(s.facetCentres[i], origin);
    const t = dot3(d, surface.axis);
    const radial = norm3([
      d[0] - surface.axis[0] * t,
      d[1] - surface.axis[1] * t,
      d[2] - surface.axis[2] * t,
    ]);
    if ((dot3(s.normals[i], radial) > 0) !== surface.outward) return false;
  }

  return true;
}

/**
 * Checks that a traced boundary loop really is a circle about the axis.
 *
 * This is the test that keeps the pass honest. A fit can succeed on a patch of a surface that
 * other features have trimmed — a hole broken open by a slot, a boss with a flat milled on it
 * — and replacing that with a whole surface of revolution would fill in geometry that was
 * deliberately removed. A boundary of two complete circular rims is the evidence that the
 * surface really is the entire revolution.
 */
function asRim(ring: number[], verts: Vec3[], surface: Revolved, tol: number): Rim | null {
  if (ring.length < 6) return null;

  const origin = axisOrigin(surface);
  let alongSum = 0;
  let alongMin = Infinity, alongMax = -Infinity;

  for (const v of ring) {
    if (offSurface(verts[v], surface) > tol) return null;
    const t = dot3(sub3(verts[v], origin), surface.axis);
    alongSum += t;
    if (t < alongMin) alongMin = t;
    if (t > alongMax) alongMax = t;
  }

  // A rim is planar: every vertex at the same height along the axis. A helical or stepped
  // boundary means the surface is trimmed by something that is not a plane.
  if (alongMax - alongMin > tol) return null;

  const along = alongSum / ring.length;
  const radius = radiusAt(surface, along);

  // A rim that has closed to a point is the apex of a cone, which is a vertex rather than a
  // circle and cannot carry arcs.
  if (radius <= tol) return null;

  return {
    ring,
    centre: [
      origin[0] + surface.axis[0] * along,
      origin[1] + surface.axis[1] * along,
      origin[2] + surface.axis[2] * along,
    ],
    along,
    radius,
  };
}

/**
 * Angle of a vertex about the axis, measured from the reference direction.
 *
 * Used to pair the two rims and to split each at matching places. Without the pairing the
 * seam runs diagonally across the face, which is legal and looks wrong.
 */
export function angleAbout(p: Vec3, surface: Revolved, u: Vec3, v: Vec3): number {
  const d = sub3(p, axisOrigin(surface));
  return Math.atan2(dot3(d, v), dot3(d, u));
}

/** Orthonormal frame across the axis, for angle measurement. */
export function axisFrame(surface: Revolved): { u: Vec3; v: Vec3 } {
  const u = perpTo(surface.axis);
  return { u, v: cross3(surface.axis, u) };
}

export interface FindOptions {
  /** Distance a vertex may sit off the fitted surface. */
  tol: number;
  /** Smallest number of facets worth treating as a surface of revolution. */
  minFacets?: number;
}

/**
 * Finds every surface of revolution in a set of planar regions.
 *
 * Seeds from small regions — a tessellated revolution arrives as many one- or two-triangle
 * strips, where a genuine planar face is one large region — then grows the cluster by testing
 * neighbours against the seed's own fit rather than refitting each time, and refits once at
 * the end over everything accepted.
 */
export function findRevolved(
  m: Mesh,
  map: Uint32Array,
  verts: Vec3[],
  regions: Region[],
  traceLoops: (tris: number[]) => { loops: number[][]; closed: boolean },
  opts: FindOptions,
): FoundSurface[] {
  const tol = opts.tol;
  const minFacets = opts.minFacets ?? 8;

  // Which region each triangle belongs to, and which regions touch which.
  const regionOf = new Map<number, number>();
  regions.forEach((r, i) => { for (const t of r.tris) regionOf.set(t, i); });

  const neighbours = new Map<number, Set<number>>();
  const edgeOwner = new Map<string, number[]>();
  for (const [t, ri] of regionOf) {
    for (let e = 0; e < 3; e++) {
      const a = map[m.indices[t * 3 + e]];
      const b = map[m.indices[t * 3 + ((e + 1) % 3)]];
      if (a === b) continue;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      const list = edgeOwner.get(k);
      if (list) list.push(ri); else edgeOwner.set(k, [ri]);
    }
  }
  for (const owners of edgeOwner.values()) {
    for (const x of owners) {
      for (const y of owners) {
        if (x === y) continue;
        const set = neighbours.get(x);
        if (set) set.add(y); else neighbours.set(x, new Set([y]));
      }
    }
  }

  // Collect whole smoothly-connected patches *before* fitting anything.
  //
  // The earlier version seeded from one strip plus its immediate neighbours, fitted that, and
  // grew against the result. That works for a cylinder, whose axis is fixed by any three
  // normals, and cannot work for a cone: three adjacent strips span a few degrees of the
  // revolution, which leaves the apex almost entirely unconstrained. Every cone was rejected
  // at the seed and fell back to facets.
  //
  // Gathering the patch first costs nothing — adjacency is already built — and gives the fit
  // the whole surface to work from. A patch that turns out not to be a cylinder or a cone
  // simply fails once, as a whole, instead of failing region by region.
  //
  // "Smooth" is a 40° gate between adjacent regions: it admits the neighbouring strips of
  // anything down to a nine-sided tessellation and stops dead at a cap, which meets the side
  // at 90°. Large regions are excluded outright — a planar face is one big region where a
  // revolution is many small ones.
  // Which regions can belong to a curved surface at all, judged by shape rather than size.
  //
  // Two earlier rules both failed. Counting triangles ("a strip has four or fewer") is true of
  // a primitive and false of anything a boolean has touched — cutting a countersink
  // re-triangulates its strips into five or six, so the cone was skipped before it was fitted.
  // Dropping the rule entirely was worse: large flat faces were then free to join a smooth
  // component, two spurious cylinders swallowed part of a flange, and 673 of its edges ended
  // up owned by one face instead of two.
  //
  // The property that actually distinguishes them is the *fan*. A facet of a tessellated
  // revolution sits between two neighbours turned a little way about the axis — the
  // tessellation step, always small and never zero. A genuine planar face has no such
  // neighbours: anything coplanar with it was already merged into it, and everything else
  // meets it at a real angle. So a region qualifies when at least two of its neighbours are
  // turned away from it by a small but non-zero amount.
  const fanned = regions.map((_, i) => {
    let n = 0;
    for (const nb of neighbours.get(i) ?? []) {
      const d = dot3(regions[i].normal, regions[nb].normal);
      if (d > Math.cos(0.7) && d < Math.cos(1e-3)) n++;
    }
    return n >= 2;
  });

  const claimed = new Set<number>();
  const found: FoundSurface[] = [];

  // Loosest gate first, then tighter ones over whatever is left.
  //
  // No single threshold works. A tessellated revolution steps by 2π/N between strips — 11° at
  // 32 sides, 45° at eight — so the gate has to be generous enough to keep a coarse cylinder
  // in one piece. But a real feature break is often gentler than that: a countersink meets its
  // bore at the cone's half-angle, 26° on a 90° csk, and a generous gate swallows the two into
  // one patch that is neither a cylinder nor a cone. Both then fell back to facets — the
  // countersink lost its cone *and* the bore lost its cylinder.
  //
  // Trying the tight gates afterwards costs a few cheap fits and resolves both cases: the
  // coarse cylinder is claimed whole on the first pass, and anything that failed because it
  // was really two surfaces gets separated on a later one.
  for (const gate of [0.7, 0.35, 0.18]) {
    const smoothGate = Math.cos(gate);
    const seen = new Set<number>();

    for (let start = 0; start < regions.length; start++) {
      if (claimed.has(start) || seen.has(start) || !fanned[start]) continue;

      const cluster = new Set<number>([start]);
      const queue = [start];
      seen.add(start);

      while (queue.length > 0) {
        const at = queue.pop()!;
        for (const nb of neighbours.get(at) ?? []) {
          if (claimed.has(nb) || seen.has(nb) || !fanned[nb]) continue;
          if (dot3(regions[nb].normal, regions[at].normal) < smoothGate) continue;

          seen.add(nb);
          cluster.add(nb);
          queue.push(nb);
        }
      }

      const tris = [...cluster].flatMap((r) => regions[r].tris);
      if (tris.length < minFacets) continue;

      const surface = fitRevolved(m, map, tris, verts, tol);
      if (!surface) continue;

      // Every facet must genuinely be on it, not merely most of them.
      if ([...cluster].some((r) => !regionAgrees(m, map, verts, regions[r], surface, tol))) continue;

    // The boundary decides it. Two complete circular rims, or this is a trimmed patch and
    // must stay as facets.
      // The boundary decides it. Two complete circular rims, or this is a trimmed patch and
      // must stay as facets.
      const traced = traceLoops(tris);
      if (!traced.closed || traced.loops.length !== 2) continue;

      const rimA = asRim(traced.loops[0], verts, surface, tol);
      const rimB = asRim(traced.loops[1], verts, surface, tol);
      if (!rimA || !rimB) continue;

      // The two rims need not carry the same number of vertices.
      //
      // Requiring that was a cylinder-era assumption: both rims of a primitive cylinder come
      // from one tessellation ring, so they match. Nothing else does. A conical boss has one
      // rim from its own mesh and one cut by a boolean against the face it stands on, and
      // those had 71 and 77 points — a correctly fitted cone, thrown away for a difference
      // that does not matter. The arcs are cut by *angle*, not by index, so the counts are
      // free to differ.
      if (Math.abs(rimA.along - rimB.along) < tol) continue;

      for (const r of cluster) claimed.add(r);
      found.push({ surface, regions: [...cluster], tris, rims: [rimA, rimB] });
    }
  }

  return found;
}

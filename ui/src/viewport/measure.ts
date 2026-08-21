/**
 * Measuring in the viewport.
 *
 * The one tool a CAD viewport cannot be without. Everything else it does — orbit, shade,
 * section — helps you *look* at a part; this is how you interrogate one. "How thick is that
 * wall", "how far apart are those bores", "what diameter is that hole" are the questions a
 * viewport is actually open for, and a viewer that cannot answer them is a picture.
 *
 * ── Snapping, and why it is the whole problem ──
 *
 * Clicking a triangle gives a point on a surface, which is very nearly useless: nobody wants
 * the distance between two arbitrary points on two faces, they want *the corner*, *the axis*,
 * *the edge*. So a click is snapped to the nearest thing worth measuring to, in a fixed order
 * of preference — vertex, then edge, then the surface itself — within a tolerance stated in
 * millimetres and derived from the zoom, so the snap radius is a constant number of pixels
 * however far in the user is.
 *
 * ── What it will not do ──
 *
 * Guess. Every measurement says what it snapped to, and a measurement between two things that
 * cannot be measured meaningfully — two skew axes, two non-parallel planes — says so instead of
 * returning the nearest number it can compute. A wrong dimension read confidently off a screen
 * is how a part gets made wrong.
 */

import {
  add3, cross3, dist3, dot3, len3, mul3, norm3, sub3,
  type Vec3,
} from '../kernel/math/vec';
import {
  getTriangle, raycast, triCount, type FaceTag, type Mesh,
} from '../kernel/topo/mesh';

// ── snapping ─────────────────────────────────────────────────────────────────

export type SnapKind = 'vertex' | 'edge' | 'centre' | 'surface';

export interface SnapPoint {
  point: Vec3;
  kind: SnapKind;
  /** Face tag under the cursor, which is what gives a hole its diameter. */
  faceId: number;
  tag?: FaceTag;
  /** How far the snap moved the raw hit, mm. Zero for a surface point. */
  movedMm: number;
}

/**
 * Where a click actually lands.
 *
 * `toleranceMm` should come from `mmPerPixel(camera, height) * radiusInPixels`, so the snap
 * feels the same at every zoom. Passing a fixed millimetre tolerance makes the tool grabby on
 * a watch part and useless on a chassis.
 */
export function snap(mesh: Mesh, origin: Vec3, direction: Vec3, toleranceMm: number): SnapPoint | null {
  const hit = raycast(mesh, origin, direction);
  if (!hit) return null;

  const tag = mesh.tags.get(hit.faceId);
  const base: SnapPoint = { point: hit.point, kind: 'surface', faceId: hit.faceId, tag, movedMm: 0 };

  const [a, b, c] = getTriangle(mesh, hit.triangle);

  // A vertex first: a corner is the most specific thing a click can mean, and two corners are
  // what a length is between.
  let best: { point: Vec3; kind: SnapKind; d: number } | null = null;
  for (const v of [a, b, c]) {
    const d = dist3(v, hit.point);
    if (d <= toleranceMm && (!best || d < best.d)) best = { point: v, kind: 'vertex', d };
  }

  // Then an edge. Only a real edge of the solid, not the diagonal a triangulator drew across a
  // flat face — measuring to one of those would give a number that changes when the mesh is
  // retriangulated, which is a number about the software rather than about the part.
  if (!best) {
    for (const [p, q] of [[a, b], [b, c], [c, a]] as [Vec3, Vec3][]) {
      if (!isRealEdge(mesh, p, q)) continue;

      const foot = closestOnSegment(hit.point, p, q);
      const d = dist3(foot, hit.point);
      if (d <= toleranceMm && (!best || d < best.d)) best = { point: foot, kind: 'edge', d };
    }
  }

  /*
   * A cylinder's axis, which is what "click the hole" means.
   *
   * Snapping the surface point onto the axis turns a click anywhere on a bore into the bore's
   * centre, so two clicks give a centre distance rather than a wall-to-wall distance that
   * depends on exactly where the user clicked. It is offered only when nothing sharper is
   * within tolerance, because a corner of the bore is still more specific.
   */
  if (!best && tag?.kind === 'cylindrical' && tag.origin && tag.normal) {
    const axisPoint = projectOnAxis(hit.point, tag.origin, tag.normal);
    return { point: axisPoint, kind: 'centre', faceId: hit.faceId, tag, movedMm: dist3(axisPoint, hit.point) };
  }

  if (!best) return base;
  return { point: best.point, kind: best.kind, faceId: hit.faceId, tag, movedMm: best.d };
}

/**
 * Whether two vertices span an edge of the part rather than a seam inside one surface.
 *
 * The test is the face tag, not the angle between the triangles. Both artefacts a measurement
 * must never snap to are seams *within* a single tagged surface — the diagonal a triangulator
 * draws across a flat face, and the vertical creases between the facets of a cylinder — and
 * both are invisible to an angle test done at any one threshold: the diagonal is at 0° and the
 * cylinder's facets are at 11°, so a tolerance loose enough to reject the second rejects real
 * shallow edges too.
 *
 * Where two different faces meet, there is an edge of the part. Where one face meets itself,
 * there is an artefact of how it happens to be tessellated, and a dimension taken to it would
 * change if the part were remeshed.
 */
function isRealEdge(mesh: Mesh, p: Vec3, q: Vec3): boolean {
  const faces = new Set<number>();

  for (let t = 0; t < triCount(mesh); t++) {
    const tri = getTriangle(mesh, t);
    const has = (v: Vec3) => tri.some((w) => dist3(v, w) < 1e-9);
    if (!has(p) || !has(q)) continue;

    faces.add(mesh.faceIds[t]!);
    if (faces.size > 1) return true;
  }

  // One face on both sides is a seam. No face at all cannot happen for an edge taken off a
  // triangle of this mesh, and is treated as a seam rather than invented into an edge.
  return false;
}

function closestOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = sub3(b, a);
  const lenSq = dot3(ab, ab);
  if (lenSq < 1e-18) return a;

  const t = Math.max(0, Math.min(1, dot3(sub3(p, a), ab) / lenSq));
  return add3(a, mul3(ab, t));
}

function projectOnAxis(p: Vec3, origin: Vec3, axis: Vec3): Vec3 {
  const a = norm3(axis);
  return add3(origin, mul3(a, dot3(sub3(p, origin), a)));
}

// ── measuring ────────────────────────────────────────────────────────────────

export interface Measurement {
  /** The number, mm. */
  distanceMm: number;
  /** Its components along the model axes, which is what a drawing dimensions in. */
  deltaMm: Vec3;
  /** Where to draw the label. */
  midpoint: Vec3;
  from: SnapPoint;
  to: SnapPoint;
  /** What this is a measurement *of*, in words. */
  description: string;
}

/**
 * The distance between two snapped points.
 *
 * Reported with its axis components as well as its length, because a designer reading a
 * viewport is usually about to type one of them into a drawing, and the one they want is as
 * often ΔX as it is the diagonal.
 */
export function measureBetween(from: SnapPoint, to: SnapPoint): Measurement {
  const deltaMm = sub3(to.point, from.point);

  return {
    distanceMm: len3(deltaMm),
    deltaMm,
    midpoint: mul3(add3(from.point, to.point), 0.5),
    from,
    to,
    description: describePair(from, to),
  };
}

function describePair(from: SnapPoint, to: SnapPoint): string {
  const noun = (s: SnapPoint): string =>
    s.kind === 'centre' ? 'axis' : s.kind === 'vertex' ? 'corner' : s.kind;

  if (from.kind === 'centre' && to.kind === 'centre') return 'centre to centre';
  return `${noun(from)} to ${noun(to)}`;
}

// ── measuring one thing ──────────────────────────────────────────────────────

export interface FaceMeasurement {
  faceId: number;
  kind: FaceTag['kind'] | 'unknown';
  areaMm2: number;
  /** Diameter for a cylinder, sphere or cone; undefined for anything else. */
  diameterMm?: number;
  radiusMm?: number;
  normal?: Vec3;
  /** Ready to show: "⌀12.00 mm bore, 226.19 mm²". */
  label: string;
}

/**
 * Everything the model knows about one face.
 *
 * The face tags carry the analytic surface a face came from — a cylinder knows it is a
 * cylinder and knows its radius — so a click on a bore can report ⌀12.00 rather than a
 * measurement taken off its triangles. That distinction matters: a radius measured off a
 * 32-sided approximation of a cylinder is short by half a percent, and half a percent of a
 * fit is the difference between a press fit and a slip fit.
 */
export function measureFace(mesh: Mesh, faceId: number): FaceMeasurement {
  const tag = mesh.tags.get(faceId);
  let areaMm2 = 0;

  for (let t = 0; t < triCount(mesh); t++) {
    if (mesh.faceIds[t] !== faceId) continue;
    const [a, b, c] = getTriangle(mesh, t);
    areaMm2 += len3(cross3(sub3(b, a), sub3(c, a))) / 2;
  }

  const radiusMm = tag?.radius;
  const diameterMm = radiusMm === undefined ? undefined : radiusMm * 2;

  return {
    faceId,
    kind: tag?.kind ?? 'unknown',
    areaMm2,
    diameterMm,
    radiusMm,
    normal: tag?.normal,
    label: faceLabel(tag?.kind, diameterMm, areaMm2),
  };
}

function faceLabel(
  kind: FaceTag['kind'] | undefined, diameterMm: number | undefined, areaMm2: number,
): string {
  const area = `${areaMm2.toFixed(2)} mm²`;

  if (diameterMm !== undefined && (kind === 'cylindrical' || kind === 'spherical')) {
    return `⌀${diameterMm.toFixed(2)} mm ${kind === 'spherical' ? 'sphere' : 'cylinder'}, ${area}`;
  }
  if (kind === 'planar') return `flat face, ${area}`;
  return `${kind ?? 'face'}, ${area}`;
}

// ── measuring between two faces ──────────────────────────────────────────────

export interface FacePairMeasurement {
  kind: 'thickness' | 'centres' | 'angle' | 'none';
  /** Millimetres for a distance, degrees for an angle. Null when there is nothing to say. */
  value: number | null;
  label: string;
}

/**
 * Two faces, measured the way the pair deserves.
 *
 * Two parallel planes have a thickness. Two parallel cylinders have a centre distance. Two
 * planes at an angle have an angle. Two skew cylinders have none of those, and this says so —
 * the shortest distance between two skew axes is a real number that answers nobody's question,
 * and offering it would be the confident wrong answer this whole file exists to avoid.
 */
export function measureFacePair(mesh: Mesh, aId: number, bId: number): FacePairMeasurement {
  const a = mesh.tags.get(aId);
  const b = mesh.tags.get(bId);
  const none: FacePairMeasurement = {
    kind: 'none', value: null,
    label: 'These two faces have no single dimension between them. Measure point to point instead.',
  };

  if (!a || !b || !a.normal || !b.normal) return none;

  const na = norm3(a.normal);
  const nb = norm3(b.normal);
  const parallel = Math.abs(dot3(na, nb)) > Math.cos(0.5 * Math.PI / 180);

  if (a.kind === 'planar' && b.kind === 'planar') {
    /*
     * An angle needs only the two normals, and a distance needs a point on each plane. Not
     * every planar tag carries one — the side walls of an extrusion are tagged with a
     * direction and no origin — so the angle is answered first and the distance is
     * attempted only where there is something to measure from.
     */
    if (!parallel) {
      const deg = (Math.acos(Math.min(1, Math.abs(dot3(na, nb)))) * 180) / Math.PI;
      return { kind: 'angle', value: deg, label: `${deg.toFixed(2)}° between the faces` };
    }
    if (!a.origin || !b.origin) return none;
    const thickness = Math.abs(dot3(sub3(b.origin, a.origin), na));
    return { kind: 'thickness', value: thickness, label: `${thickness.toFixed(3)} mm across` };
  }

  if (a.kind === 'cylindrical' && b.kind === 'cylindrical') {
    if (!parallel || !a.origin || !b.origin) return none;

    // Perpendicular distance between two parallel axes.
    const between = sub3(b.origin, a.origin);
    const along = mul3(na, dot3(between, na));
    const centres = len3(sub3(between, along));

    return { kind: 'centres', value: centres, label: `${centres.toFixed(3)} mm centre to centre` };
  }

  return none;
}

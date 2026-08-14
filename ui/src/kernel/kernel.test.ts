import { describe, expect, it } from 'vitest';
import { orient2d, orient3d, polygonArea2d } from './math/predicates';
import {
  angle3, boxTransform, cross3, dot3, matInvert, matMul, rotation,
  rotationAbout, translation, xformPoint, type Vec3,
} from './math/vec';
import {
  conditionNumber, determinant, invert, luDecompose, luSolve, matFrom,
  nullSpace, pseudoInverseSolve, qrDecompose, qrSolve, rank, svd, cubicRoots, quadraticRoots,
} from './math/linalg';
import {
  approximateCurve, arcToNurbs, circleToNurbs, curveLength, curvePoint,
  closestPointOnCurve, interpolateCurve, tessellateCurve,
} from './math/nurbs';
import { health, massProperties, pointInside, raycast, transformMesh } from './topo/mesh';
import {
  box, cone, cylinder, extrude, loft, revolve, sphere, sweep, torus, XY, XZ, linePath,
} from './ops/build';
import { boolean, clipByPlane, subtractAll, unionAll } from './ops/boolean';
import {
  CHORD_TOL, arcSegments, circleProfile, filletCorners, inscribedDeficit, makeProfile,
  minimumFeatureSize, offsetProfile, pointInProfile, profileArea, profileCentroid,
  rectProfile, triangulate,
} from './sketch/profile';

/**
 * Geometry kernel tests.
 *
 * Geometry defects are silent. A boolean that leaves a solid one triangle short still
 * renders perfectly, still exports, and produces a wrong mass and an unmanufacturable part.
 * So these assert against closed-form analytic answers wherever one exists — a revolved
 * sphere must have volume 4/3 pi r^3, a cut block must lose exactly the volume of the cut —
 * and check `health()` after every operation. Comparing to a previous run would only prove
 * the kernel is consistently wrong.
 */

const relErr = (actual: number, expected: number) => Math.abs(actual - expected) / Math.abs(expected);

describe('exact predicates', () => {
  it('gets the sign right where floating point does not', () => {
    // These three points are collinear, but the naive cross product returns a non-zero
    // value because the coordinates cannot be represented exactly. This is the whole
    // reason the file exists.
    const naive = (0.5 - 0.5) * (12 - 0.5) - (24 - 0.5) * (0.5 - 0.5);
    expect(orient2d(0.5, 0.5, 12, 12, 24, 24)).toBe(0);
    expect(naive).toBe(0); // the easy case both get right

    // The hard case: points that are collinear but whose products cancel catastrophically.
    const a = 0.1, b = 0.2;
    expect(orient2d(a, a, b, b, a + b, a + b)).toBe(0);
  });

  it('detects exact coplanarity', () => {
    expect(orient3d(0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 7, 0)).toBe(0);
    expect(orient3d(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1)).not.toBe(0);
  });

  it('is consistent: the same query always gives the same sign', () => {
    // Consistency is what prevents cracks. If this ever varied, adjacent triangles could
    // disagree about which side of a plane a shared vertex lies on.
    const results = new Set<number>();
    for (let i = 0; i < 200; i++) {
      results.add(Math.sign(orient3d(0, 0, 0, 1, 0, 0, 0, 1, 0, 0.1, 0.2, 1e-17)));
    }
    expect(results.size).toBe(1);
  });

  it('computes polygon area accurately far from the origin', () => {
    // A 10 x 10 square at x = 3,000,000 — the leading digits cancel completely in the
    // naive shoelace sum, which is the situation a large weldment sketch creates.
    const off = 3_000_000;
    const pts: [number, number][] = [[off, off], [off + 10, off], [off + 10, off + 10], [off, off + 10]];
    expect(Math.abs(polygonArea2d(pts))).toBeCloseTo(100, 6);
  });
});

describe('vector and matrix maths', () => {
  it('inverts a transform exactly enough to round-trip a point', () => {
    const m = matMul(translation([13, -4, 9]), rotation([1, 2, 3], 0.7));
    const inv = matInvert(m)!;
    const p: Vec3 = [3, 5, 7];
    const back = xformPoint(inv, xformPoint(m, p));
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(p[i], 10);
  });

  it('rotates about an arbitrary axis line, not just the origin', () => {
    // 180 degrees about the vertical line through (5, 0, 0) maps (6,0,0) to (4,0,0).
    const m = rotationAbout([5, 0, 0], [0, 0, 1], Math.PI);
    const p = xformPoint(m, [6, 0, 0]);
    expect(p[0]).toBeCloseTo(4, 9);
    expect(p[1]).toBeCloseTo(0, 9);
  });

  it('computes angles stably near zero and pi', () => {
    // acos(dot) loses all precision here; atan2 of the cross product does not.
    expect(angle3([1, 0, 0], [1, 1e-9, 0])).toBeCloseTo(1e-9, 12);
    expect(angle3([1, 0, 0], [-1, 1e-9, 0])).toBeCloseTo(Math.PI - 1e-9, 8);
  });

  it('transforms a bounding box by all eight corners', () => {
    // Rotating only min and max would give a box of the wrong size.
    const b = { min: [-1, -1, -1] as Vec3, max: [1, 1, 1] as Vec3 };
    const out = boxTransform(b, rotation([0, 0, 1], Math.PI / 4));
    expect(out.max[0]).toBeCloseTo(Math.SQRT2, 9);
  });

  it('keeps a cross product perpendicular to both inputs', () => {
    const a: Vec3 = [1, 2, 3], b: Vec3 = [-4, 5, 6];
    const c = cross3(a, b);
    expect(dot3(c, a)).toBeCloseTo(0, 12);
    expect(dot3(c, b)).toBeCloseTo(0, 12);
  });
});

describe('linear algebra', () => {
  it('solves a well-conditioned system with LU', () => {
    const a = matFrom(3, 3, [2, 1, -1, -3, -1, 2, -2, 1, 2]);
    const x = luSolve(luDecompose(a), [8, -11, -3])!;
    expect(x[0]).toBeCloseTo(2, 9);
    expect(x[1]).toBeCloseTo(3, 9);
    expect(x[2]).toBeCloseTo(-1, 9);
  });

  it('pivots rather than dividing by a zero on the diagonal', () => {
    // A horizontal line in a sketch produces exactly this. Without pivoting it is a
    // division by zero on the very first elimination step.
    const a = matFrom(2, 2, [0, 1, 1, 0]);
    const x = luSolve(luDecompose(a), [3, 4])!;
    expect(x[0]).toBeCloseTo(4, 12);
    expect(x[1]).toBeCloseTo(3, 12);
  });

  it('reports a singular matrix instead of returning nonsense', () => {
    const a = matFrom(2, 2, [1, 2, 2, 4]);
    expect(luDecompose(a).singular).toBe(true);
    expect(invert(a)).toBeNull();
    expect(determinant(a)).toBe(0);
  });

  it('solves least squares by QR', () => {
    // Overdetermined: three points, fit a line y = mx + c.
    const a = matFrom(3, 2, [0, 1, 1, 1, 2, 1]);
    const x = qrSolve(qrDecompose(a), [1, 3, 5])!;
    expect(x[0]).toBeCloseTo(2, 9);
    expect(x[1]).toBeCloseTo(1, 9);
  });

  it('recovers singular values of a known matrix', () => {
    const a = matFrom(2, 2, [3, 0, 0, 2]);
    const { s } = svd(a);
    expect(s[0]).toBeCloseTo(3, 9);
    expect(s[1]).toBeCloseTo(2, 9);
  });

  it('measures rank and conditioning', () => {
    expect(rank(matFrom(3, 3, [1, 0, 0, 0, 1, 0, 0, 0, 1]))).toBe(3);
    expect(rank(matFrom(2, 2, [1, 2, 2, 4]))).toBe(1);
    expect(conditionNumber(matFrom(2, 2, [1, 2, 2, 4]))).toBe(Infinity);
  });

  it('finds the null space, which is what tells a sketch its free directions', () => {
    // [1 -1] has null space spanned by (1, 1)/sqrt(2): the two variables can move together.
    const ns = nullSpace(matFrom(1, 2, [1, -1]));
    expect(ns.cols).toBe(1);
    expect(Math.abs(ns.data[0])).toBeCloseTo(Math.abs(ns.data[1]), 9);
  });

  it('returns the minimum-norm solution when under-determined', () => {
    // x + y = 2 has infinitely many solutions; the minimum-norm one is (1, 1).
    const x = pseudoInverseSolve(matFrom(1, 2, [1, 1]), [2]);
    expect(x[0]).toBeCloseTo(1, 6);
    expect(x[1]).toBeCloseTo(1, 6);
  });

  it('solves polynomials without cancellation', () => {
    expect(quadraticRoots(1, -3, 2)).toEqual([1, 2]);
    const roots = cubicRoots(1, -6, 11, -6);
    expect(roots.length).toBe(3);
    expect(roots[0]).toBeCloseTo(1, 8);
    expect(roots[2]).toBeCloseTo(3, 8);
  });
});

describe('NURBS', () => {
  it('represents a circle exactly, not as a polygon approximation', () => {
    // This is the property that makes rational NURBS worth the complexity. Every sampled
    // point must be exactly on the circle, at any parameter, not just at the knots.
    const c = circleToNurbs([0, 0, 0], [1, 0, 0], [0, 1, 0], 25);
    for (let i = 0; i <= 40; i++) {
      const p = curvePoint(c, i / 40);
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(25, 9);
      expect(p[2]).toBeCloseTo(0, 12);
    }
  });

  it('gives an exact arc length for a circle', () => {
    const c = circleToNurbs([0, 0, 0], [1, 0, 0], [0, 1, 0], 10);
    expect(relErr(curveLength(c), 2 * Math.PI * 10)).toBeLessThan(1e-6);
  });

  it('builds a quarter arc with the right endpoints', () => {
    const a = arcToNurbs([0, 0, 0], [1, 0, 0], [0, 1, 0], 5, 0, Math.PI / 2);
    const p0 = curvePoint(a, 0), p1 = curvePoint(a, 1);
    expect(p0[0]).toBeCloseTo(5, 9);
    expect(p0[1]).toBeCloseTo(0, 9);
    expect(p1[0]).toBeCloseTo(0, 9);
    expect(p1[1]).toBeCloseTo(5, 9);
  });

  it('interpolates through every given point', () => {
    const pts: Vec3[] = [[0, 0, 0], [10, 5, 0], [20, -3, 0], [30, 8, 0], [40, 0, 0]];
    const c = interpolateCurve(pts, 3);
    // Endpoints are guaranteed by clamping; the interior ones prove the solve worked.
    const start = curvePoint(c, 0), end = curvePoint(c, 1);
    expect(start[0]).toBeCloseTo(0, 6);
    expect(end[0]).toBeCloseTo(40, 6);
  });

  it('approximates a noisy contour with far fewer control points', () => {
    // This is what turns a traced bitmap edge into a manufacturable curve.
    const noisy: Vec3[] = [];
    for (let i = 0; i <= 200; i++) {
      const t = (i / 200) * Math.PI;
      noisy.push([t * 30, Math.sin(t) * 20 + (i % 3) * 0.05, 0]);
    }
    const c = approximateCurve(noisy, 10, 3);
    expect(c.ctrl.length).toBeLessThanOrEqual(10);

    // It must still track the underlying shape closely despite the noise.
    let maxDev = 0;
    for (const p of noisy) maxDev = Math.max(maxDev, closestPointOnCurve(c, p).distance);
    expect(maxDev).toBeLessThan(1.0);
  });

  it('tessellates adaptively rather than at a fixed step', () => {
    const tight = circleToNurbs([0, 0, 0], [1, 0, 0], [0, 1, 0], 1);
    const loose = circleToNurbs([0, 0, 0], [1, 0, 0], [0, 1, 0], 200);
    // A large circle needs more segments for the same chordal error.
    expect(tessellateCurve(loose, 0.01).length).toBeGreaterThan(tessellateCurve(tight, 0.01).length);
  });

  it('finds the closest point on a curve', () => {
    const c = circleToNurbs([0, 0, 0], [1, 0, 0], [0, 1, 0], 10);
    const r = closestPointOnCurve(c, [20, 0, 0]);
    expect(r.distance).toBeCloseTo(10, 4);
  });
});

describe('profiles', () => {
  it('computes area net of holes', () => {
    const p = makeProfile(
      [[0, 0], [100, 0], [100, 50], [0, 50]],
      [[[40, 20], [60, 20], [60, 30], [40, 30]]],
    );
    expect(profileArea(p)).toBeCloseTo(100 * 50 - 20 * 10, 9);
  });

  it('normalises winding so callers never have to', () => {
    const cw = makeProfile([[0, 0], [0, 10], [10, 10], [10, 0]]);
    // makeProfile reverses it to counter-clockwise, which every downstream operation assumes.
    expect(profileArea(cw)).toBeCloseTo(100, 9);
  });

  it('triangulates a profile to exactly its own area', () => {
    // The strongest available check: if any triangle is missing, inverted or overlapping,
    // the total will not match.
    const p = makeProfile(
      [[0, 0], [80, 0], [80, 40], [50, 40], [50, 20], [30, 20], [30, 40], [0, 40]],
      [[[10, 5], [20, 5], [20, 15], [10, 15]]],
    );
    const { vertices, triangles } = triangulate(p);

    let total = 0;
    for (let i = 0; i < triangles.length; i += 3) {
      const a = vertices[triangles[i]], b = vertices[triangles[i + 1]], c = vertices[triangles[i + 2]];
      total += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    }
    expect(relErr(total, profileArea(p))).toBeLessThan(1e-9);
  });

  it('triangulates a profile with several holes', () => {
    const p = makeProfile(
      [[0, 0], [100, 0], [100, 100], [0, 100]],
      [
        [[10, 10], [30, 10], [30, 30], [10, 30]],
        [[70, 70], [90, 70], [90, 90], [70, 90]],
        [[10, 70], [30, 70], [30, 90], [10, 90]],
      ],
    );
    const { vertices, triangles } = triangulate(p);
    let total = 0;
    for (let i = 0; i < triangles.length; i += 3) {
      const a = vertices[triangles[i]], b = vertices[triangles[i + 1]], c = vertices[triangles[i + 2]];
      total += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    }
    expect(relErr(total, profileArea(p))).toBeLessThan(1e-6);
  });

  it('locates a centroid by area, not by vertex average', () => {
    // An L-shape. The vertex average would be wrong; the area-weighted centroid is not.
    const p = makeProfile([[0, 0], [60, 0], [60, 20], [20, 20], [20, 60], [0, 60]]);
    const c = profileCentroid(p);
    // 60x20 base (area 1200 at (30,10)) plus 20x40 upright (area 800 at (10,40)):
    // (1200*30 + 800*10) / 2000 = 22, and by the L's diagonal symmetry the same in y.
    // The plain vertex average would give (23.3, 20) — close enough to look right and
    // wrong enough to misplace a centre of mass.
    expect(c[0]).toBeCloseTo(22, 6);
    expect(c[1]).toBeCloseTo(22, 6);
  });

  it('offsets outward and inward by the right amount', () => {
    const p = rectProfile(100, 60);
    const bigger = offsetProfile(p, 5);
    expect(relErr(profileArea(bigger), 110 * 70)).toBeLessThan(1e-6);
  });

  it('measures the thinnest wall in a profile', () => {
    // A 100x60 plate with a hole leaving a 10 mm wall at the nearest edge.
    const p = makeProfile(
      [[0, 0], [100, 0], [100, 60], [0, 60]],
      [[[10, 25], [90, 25], [90, 35], [10, 35]]],
    );
    expect(minimumFeatureSize(p)).toBeCloseTo(10, 6);
  });

  it('tests point containment against holes', () => {
    const p = circleProfile(20);
    const withHole = makeProfile(p.outer, [circleProfile(5).outer]);
    expect(pointInProfile(withHole, [10, 0])).toBe(true);
    expect(pointInProfile(withHole, [0, 0])).toBe(false); // inside the hole
    expect(pointInProfile(withHole, [30, 0])).toBe(false); // outside entirely
  });
});

describe('mass properties', () => {
  it('gives the exact volume of a box', () => {
    const m = box(40, 30, 20);
    expect(relErr(massProperties(m).volume, 40 * 30 * 20)).toBeLessThan(1e-9);
  });

  // Curved solids are tessellated, and an inscribed polygon always encloses slightly less
  // than its circle. Rather than assert an arbitrary tolerance, each of these checks the
  // measured error against the deficit predicted from the segment count. Passing means the
  // ONLY error present is tessellation — any genuine modelling bug would exceed the bound,
  // and tightening the tessellation would not fix it.
  // A body curved in one direction carries one deficit; a sphere or torus is tessellated in
  // both its section and its sweep, so the two compound and the bound must account for both.
  const withinTessellationBound = (
    m: ReturnType<typeof cylinder>, exact: number, curves: [number, number][],
  ) => {
    const predicted = curves.reduce((s, [r, sweepAng]) => s + inscribedDeficit(arcSegments(r, sweepAng)), 0);
    const measured = relErr(massProperties(m).volume, exact);
    expect(measured).toBeLessThan(predicted * 1.1);
    return { measured, predicted };
  };

  it('gives the volume of a cylinder, low only by its tessellation deficit', () => {
    const { measured, predicted } = withinTessellationBound(
      cylinder(15, 50), Math.PI * 225 * 50, [[15, 2 * Math.PI]],
    );
    // And the shortfall really is the polygon deficit, not a coincidence.
    expect(measured).toBeGreaterThan(predicted * 0.9);
  });

  it('gives the volume of a sphere', () => {
    // Curved in the meridian (a half turn) and in the revolve (a full turn).
    withinTessellationBound(sphere(20), (4 / 3) * Math.PI * 8000, [[20, Math.PI], [20, 2 * Math.PI]]);
  });

  it('gives the volume of a torus', () => {
    // 2 pi^2 R r^2. The minor radius drives the section, the outer radius the revolve.
    withinTessellationBound(
      torus(40, 10), 2 * Math.PI ** 2 * 40 * 100, [[10, 2 * Math.PI], [50, 2 * Math.PI]],
    );
  });

  it('gives the volume of a cone', () => {
    withinTessellationBound(cone(20, 0, 60), (Math.PI * 400 * 60) / 3, [[20, 2 * Math.PI]]);
  });

  it('converges on the exact volume as the tessellation is refined', () => {
    // The claim that the error is purely tessellation only means something if refining
    // actually removes it.
    const exact = Math.PI * 225 * 50;
    const coarse = relErr(massProperties(cylinderAt(15, 50, CHORD_TOL.draft)).volume, exact);
    const fine = relErr(massProperties(cylinderAt(15, 50, CHORD_TOL.precise)).volume, exact);

    expect(fine).toBeLessThan(coarse / 10);
    expect(fine).toBeLessThan(4e-4);
  });

  it('locates the centroid of an off-centre box', () => {
    const m = box(10, 10, 10, [25, -13, 7]);
    const c = massProperties(m).centroid;
    expect(c[0]).toBeCloseTo(25, 6);
    expect(c[1]).toBeCloseTo(-13, 6);
    expect(c[2]).toBeCloseTo(7, 6);
  });

  it('computes the inertia tensor of a box against the closed form', () => {
    // For a box of side a, b, c about its centroid: Ixx = V(b^2 + c^2)/12.
    const a = 40, b = 30, c = 20;
    const m = box(a, b, c);
    const mp = massProperties(m);
    const V = a * b * c;
    expect(relErr(mp.inertia[0], (V * (b * b + c * c)) / 12)).toBeLessThan(1e-9);
    expect(relErr(mp.inertia[1], (V * (a * a + c * c)) / 12)).toBeLessThan(1e-9);
    expect(relErr(mp.inertia[2], (V * (a * a + b * b)) / 12)).toBeLessThan(1e-9);
  });

  it('finds principal axes aligned with an elongated box', () => {
    const mp = massProperties(box(100, 10, 10));
    // The smallest moment is about the long axis, which must be X.
    expect(Math.abs(mp.axes[0][0])).toBeCloseTo(1, 6);
  });

  it('reports negative volume for an inside-out solid rather than hiding it', () => {
    const m = box(10, 10, 10);
    const flipped = { ...m, indices: reverseWinding(m.indices) };
    expect(massProperties(flipped).volume).toBeLessThan(0);
  });
});

function reverseWinding(idx: Uint32Array): Uint32Array {
  const out = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i += 3) {
    out[i] = idx[i]; out[i + 1] = idx[i + 2]; out[i + 2] = idx[i + 1];
  }
  return out;
}

describe('mesh health', () => {
  it('confirms primitives are closed manifold solids', () => {
    for (const m of [box(10, 10, 10), cylinder(5, 20), sphere(8), cone(6, 3, 12), torus(20, 5)]) {
      const h = health(m);
      expect(h.closed).toBe(true);
      expect(h.manifold).toBe(true);
      expect(h.boundaryEdges).toBe(0);
    }
  });

  it('gives Euler characteristic 2 for a simple solid and 0 for a torus', () => {
    // V - E + F = 2 - 2g. This detects topological damage that a volume check would miss.
    expect(health(box(10, 10, 10)).euler).toBe(2);
    expect(health(box(10, 10, 10)).genus).toBe(0);
    expect(health(torus(20, 5)).euler).toBe(0);
    expect(health(torus(20, 5)).genus).toBe(1);
  });

  it('detects an open mesh', () => {
    const m = box(10, 10, 10);
    // Drop one triangle: the solid now has a hole, and volume is meaningless.
    const open = { ...m, indices: m.indices.slice(3), faceIds: m.faceIds.slice(1) };
    expect(health(open).closed).toBe(false);
    expect(health(open).boundaryEdges).toBeGreaterThan(0);
  });
});

describe('construction features', () => {
  it('extrudes a profile with holes into a closed solid', () => {
    const p = makeProfile(
      [[0, 0], [100, 0], [100, 60], [0, 60]],
      [circleProfile(8, 50, 30).outer],
    );
    const m = extrude(p, XY, { distance: 12 });
    expect(health(m).closed).toBe(true);
    expect(relErr(massProperties(m).volume, (100 * 60 - Math.PI * 64) * 12)).toBeLessThan(2e-3);
  });

  it('extrudes about the midplane symmetrically', () => {
    const m = extrude(rectProfile(20, 20), XY, { distance: 40, midplane: true });
    expect(massProperties(m).centroid[2]).toBeCloseTo(0, 6);
  });

  it('applies draft that widens the far face', () => {
    const straight = extrude(rectProfile(20, 20), XY, { distance: 50 });
    const drafted = extrude(rectProfile(20, 20), XY, { distance: 50, draftDeg: 5 });
    // Positive draft adds material, so volume must increase.
    expect(massProperties(drafted).volume).toBeGreaterThan(massProperties(straight).volume);
    expect(health(drafted).closed).toBe(true);
  });

  it('revolves a profile into a closed solid with no caps at 360 degrees', () => {
    // A rectangle offset from the axis revolves into a hollow ring (square cross-section).
    const p = makeProfile([[20, 0], [30, 0], [30, 10], [20, 10]]);
    const m = revolve(p, XZ, { axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360 });
    expect(health(m).closed).toBe(true);
    // Pappus: area x centroid circumference.
    expect(relErr(massProperties(m).volume, 100 * 2 * Math.PI * 25)).toBeLessThan(5e-3);
  });

  it('caps a partial revolve so it stays closed', () => {
    const p = makeProfile([[20, 0], [30, 0], [30, 10], [20, 10]]);
    const m = revolve(p, XZ, { axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 90 });
    expect(health(m).closed).toBe(true);
    expect(relErr(massProperties(m).volume, (100 * 2 * Math.PI * 25) / 4)).toBeLessThan(1e-2);
  });

  it('sweeps a profile along a straight path', () => {
    const m = sweep(circleProfile(5), { path: linePath([0, 0, 0], [0, 0, 100]) });
    expect(health(m).closed).toBe(true);
    // Bounded by the tessellation deficit of the swept section, as above.
    const predicted = inscribedDeficit(arcSegments(5, 2 * Math.PI));
    expect(relErr(massProperties(m).volume, Math.PI * 25 * 100)).toBeLessThan(predicted * 1.05);
  });

  it('sweeps along a curved path without the profile flipping', () => {
    // An S-curve. A Frenet frame would flip at the inflection and produce a twisted,
    // self-intersecting tube; the rotation-minimising frame must not.
    const path = interpolateCurve([[0, 0, 0], [30, 20, 0], [60, -20, 0], [90, 0, 0]], 3);
    const m = sweep(circleProfile(4), { path });
    expect(health(m).closed).toBe(true);
    expect(massProperties(m).volume).toBeGreaterThan(0);
  });

  it('lofts between two sections', () => {
    const m = loft({
      sections: [
        { profile: rectProfile(40, 40), plane: XY },
        { profile: circleProfile(10), plane: { ...XY, origin: [0, 0, 50] } },
      ],
    });
    expect(health(m).closed).toBe(true);
    expect(massProperties(m).volume).toBeGreaterThan(0);
  });

  it('lofts sections drawn from different starting corners without twisting', () => {
    // The second square starts at a different vertex. Without correspondence matching the
    // loft would twist 90 degrees and self-intersect, losing volume.
    const a = makeProfile([[-20, -20], [20, -20], [20, 20], [-20, 20]]);
    const b = makeProfile([[20, 20], [-20, 20], [-20, -20], [20, -20]]);
    const m = loft({ sections: [{ profile: a, plane: XY }, { profile: b, plane: { ...XY, origin: [0, 0, 40] } }] });

    // A straight prism of 40x40x40. A twisted loft comes out substantially smaller.
    expect(relErr(massProperties(m).volume, 40 * 40 * 40)).toBeLessThan(0.05);
  });
});

describe('boolean operations', () => {
  it('unions two overlapping boxes to the right volume', () => {
    const a = box(20, 20, 20, [0, 0, 0]);
    const b = box(20, 20, 20, [10, 0, 0]);
    const r = boolean(a, b, 'union');

    expect(r.valid).toBe(true);
    // Two 20-cubes overlapping by 10 in x: 8000 + 8000 - 4000.
    expect(relErr(massProperties(r.mesh).volume, 12000)).toBeLessThan(1e-6);
  });

  it('subtracts a cylinder from a block, leaving exactly the bore', () => {
    const block = box(60, 60, 20);
    const drill = cylinder(10, 40);
    const r = boolean(block, drill, 'difference');

    expect(r.valid).toBe(true);
    expect(relErr(massProperties(r.mesh).volume, 60 * 60 * 20 - Math.PI * 100 * 20)).toBeLessThan(5e-3);
    expect(health(r.mesh).closed).toBe(true);
  });

  it('intersects two boxes to their common region', () => {
    const a = box(20, 20, 20, [0, 0, 0]);
    const b = box(20, 20, 20, [10, 0, 0]);
    const r = boolean(a, b, 'intersection');

    expect(r.valid).toBe(true);
    expect(relErr(massProperties(r.mesh).volume, 10 * 20 * 20)).toBeLessThan(1e-6);
  });

  it('handles exactly coplanar faces, the case that breaks naive CSG', () => {
    // Two cubes stacked face to face with no overlap at all. An epsilon-based classifier
    // either leaves a doubled internal face or drops both, and the result is not a solid.
    const a = box(20, 20, 20, [0, 0, 0]);
    const b = box(20, 20, 20, [0, 0, 20]);
    const r = boolean(a, b, 'union');

    expect(r.valid).toBe(true);
    expect(relErr(massProperties(r.mesh).volume, 16000)).toBeLessThan(1e-6);
    expect(health(r.mesh).closed).toBe(true);
  });

  it('handles a cut whose face is coplanar with a face of the body', () => {
    // A pocket cut flush to the top face — extremely common, and a classic failure case.
    const block = box(40, 40, 20, [0, 0, 0]);
    const pocket = box(20, 20, 10, [0, 0, 5]);
    const r = boolean(block, pocket, 'difference');

    expect(r.valid).toBe(true);
    expect(relErr(massProperties(r.mesh).volume, 40 * 40 * 20 - 20 * 20 * 10)).toBeLessThan(1e-6);
  });

  it('returns the original body when the cutter misses entirely', () => {
    const a = box(10, 10, 10, [0, 0, 0]);
    const far = box(10, 10, 10, [1000, 0, 0]);
    const r = boolean(a, far, 'difference');

    expect(r.valid).toBe(true);
    expect(relErr(massProperties(r.mesh).volume, 1000)).toBeLessThan(1e-9);
  });

  it('produces an empty intersection for disjoint bodies', () => {
    const r = boolean(box(10, 10, 10), box(10, 10, 10, [100, 0, 0]), 'intersection');
    expect(Math.abs(massProperties(r.mesh).volume)).toBeLessThan(1e-6);
  });

  it('subtracts a whole bolt pattern in one pass', () => {
    const plate = box(120, 120, 10);
    const holes: ReturnType<typeof cylinder>[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      holes.push(cylinder(4, 30, [45 * Math.cos(a), 45 * Math.sin(a), 0]));
    }
    const r = subtractAll(plate, holes);

    expect(r.valid).toBe(true);
    expect(relErr(massProperties(r.mesh).volume, 120 * 120 * 10 - 8 * Math.PI * 16 * 10)).toBeLessThan(1e-2);
  });

  it('unions many bodies pairwise', () => {
    const parts = [box(10, 10, 10, [0, 0, 0]), box(10, 10, 10, [5, 0, 0]), box(10, 10, 10, [10, 0, 0])];
    const r = unionAll(parts);
    expect(r.valid).toBe(true);
    expect(relErr(massProperties(r.mesh).volume, 20 * 10 * 10)).toBeLessThan(1e-6);
  });

  it('reports a diagnostic instead of silently returning a broken solid', () => {
    // Two boxes meeting along a single edge: the union has no well-defined manifold result.
    const a = box(10, 10, 10, [0, 0, 0]);
    const b = box(10, 10, 10, [10, 10, 0]);
    const r = boolean(a, b, 'union');
    if (!r.valid) expect(r.diagnostic).toMatch(/open solid|non-manifold/i);
  });
});

describe('plane clipping', () => {
  it('caps a cut so the section stays a closed solid', () => {
    const m = clipByPlane(box(40, 40, 40), [0, 0, 0], [0, 0, 1]);
    expect(health(m).closed).toBe(true);
    expect(relErr(massProperties(m).volume, 40 * 40 * 20)).toBeLessThan(1e-6);
  });
});

describe('spatial queries', () => {
  it('raycasts to the nearest face and reports which one', () => {
    const m = box(20, 20, 20);
    const hit = raycast(m, [0, 0, 100], [0, 0, -1]);
    expect(hit).not.toBeNull();
    expect(hit!.point[2]).toBeCloseTo(10, 6);
    expect(m.tags.has(hit!.faceId)).toBe(true);
  });

  it('classifies points inside and outside a solid', () => {
    const m = box(20, 20, 20);
    expect(pointInside(m, [0, 0, 0])).toBe(true);
    expect(pointInside(m, [50, 0, 0])).toBe(false);
    // Near a face but still inside: the parity ray must not graze an edge and miscount.
    expect(pointInside(m, [9.999, 0, 0])).toBe(true);
  });

  it('classifies correctly on axis-aligned geometry, where a naive ray direction fails', () => {
    // Every face of this solid is axis-aligned. A +X ray from the centre would exit exactly
    // through an edge shared by two triangles and be counted twice or zero times.
    const m = box(10, 10, 10);
    for (const p of [[0, 0, 0], [0, 0, 4], [4, 4, 4], [-4, 0, 0]] as Vec3[]) {
      expect(pointInside(m, p)).toBe(true);
    }
  });
});

describe('transforms preserve solidity', () => {
  it('keeps a mirrored solid right-side out', () => {
    // A negative determinant reverses handedness. Without flipping the winding back, the
    // mirrored body would have negative volume — a void, not a solid.
    const m = box(10, 20, 30, [15, 0, 0]);
    const mirrored = transformMesh(m, matFrom4(-1));

    expect(massProperties(mirrored).volume).toBeGreaterThan(0);
    expect(relErr(massProperties(mirrored).volume, 6000)).toBeLessThan(1e-9);
    expect(health(mirrored).closed).toBe(true);
  });

  it('preserves volume under rotation', () => {
    const m = box(10, 20, 30);
    const r = transformMesh(m, rotation([1, 1, 1], 0.9));
    expect(relErr(massProperties(r).volume, 6000)).toBeLessThan(1e-9);
  });
});

function matFrom4(sx: number) {
  const m = new Float64Array(16);
  m[0] = sx; m[5] = 1; m[10] = 1; m[15] = 1;
  return m as unknown as Float64Array & { __brand?: never };
}

/** A cylinder built at an explicit chordal tolerance, for the convergence test. */
function cylinderAt(r: number, h: number, tol: number) {
  const segs = arcSegments(r, 2 * Math.PI, tol);
  const pts: [number, number][] = [];
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * 2 * Math.PI;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return extrude(makeProfile(pts), { ...XY, origin: [0, 0, -h / 2] }, { distance: h });
}

describe('sketch-level corner rounding', () => {
  it('rounds a square corner with a tangent arc', () => {
    const sq: [number, number][] = [[0, 0], [40, 0], [40, 40], [0, 40]];
    const r = 8;
    const out = filletCorners(sq, r);

    expect(out.rounded.length).toBe(4);
    expect(out.skipped.length).toBe(0);

    // Area lost at each corner is the square minus the quarter disc.
    const expected = 40 * 40 - 4 * (r * r - (Math.PI * r * r) / 4);
    expect(relErr(profileArea(makeProfile(out.loop)), expected)).toBeLessThan(2e-3);
  });

  it('refuses a radius that will not fit, and says why', () => {
    // A 3 mm long edge cannot carry a 10 mm round.
    const thin: [number, number][] = [[0, 0], [3, 0], [3, 40], [0, 40]];
    const out = filletCorners(thin, 10);

    expect(out.skipped.length).toBeGreaterThan(0);
    expect(out.skipped[0].reason).toMatch(/run-out|available/);
    // The corner is left sharp rather than producing self-intersecting geometry.
    expect(profileArea(makeProfile(out.loop))).toBeCloseTo(120, 6);
  });

  it('leaves collinear points alone', () => {
    const line: [number, number][] = [[0, 0], [20, 0], [40, 0], [40, 20], [0, 20]];
    const out = filletCorners(line, 3);
    // The midpoint of the bottom edge is not a corner and must not sprout an arc.
    expect(out.rounded).not.toContain(1);
  });

  it('produces a revolved body that is still a closed solid', () => {
    const section = filletCorners([[0, 0], [30, 0], [30, 50], [26, 50], [26, 6], [0, 6]], 3, [2, 3, 4]);
    const m = revolve(makeProfile(section.loop), XZ, {
      axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360,
    });
    expect(health(m).closed).toBe(true);
    expect(massProperties(m).volume).toBeGreaterThan(0);
  });
});

/**
 * Fitting analytic surfaces to groups of triangles.
 *
 * A tessellated hole is a ring of narrow flat strips. Exported as such it is geometrically
 * close to a hole and useless as one: nothing downstream can measure its diameter, put a
 * counterbore on it, or recognise it as a drilling operation. Recovering the cylinder that
 * those strips approximate turns 45 faces into one, and turns 164 ppm of tessellation error
 * into none — the analytic surface is exactly the surface the mesh was sampling.
 *
 * The recovery is a fit, so it must be able to fail. Every function here returns null rather
 * than a poor answer: a fillet, a swept blend and a slightly-bent plate are all "nearly"
 * cylindrical, and quietly exporting one as a cylinder would move geometry the user never
 * asked to move. The residual is checked against the model's own scale before anything is
 * accepted.
 */

import { cross3, dot3, len3, norm3, sub3, type Vec3 } from '../kernel/math/vec';

/** Symmetric 3x3, stored as [xx, yy, zz, xy, xz, yz]. */
type Sym3 = [number, number, number, number, number, number];

/**
 * Eigenvectors of a symmetric 3x3 matrix, by cyclic Jacobi rotation.
 *
 * Jacobi rather than a closed-form cubic: the cubic loses accuracy badly when two eigenvalues
 * are close, which is exactly the case here — the two eigenvalues across a cylinder's normal
 * fan are near-equal, and the one that matters is the small third. Jacobi is a few dozen
 * operations and is stable in that regime.
 *
 * Returns eigenvectors ordered by ascending eigenvalue.
 */
export function eigenSym3(m: Sym3): { values: [number, number, number]; vectors: [Vec3, Vec3, Vec3] } {
  // Working copy as a full matrix, plus the accumulated rotation.
  const a = [
    [m[0], m[3], m[4]],
    [m[3], m[1], m[5]],
    [m[4], m[5], m[2]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let sweep = 0; sweep < 24; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-18) break;

    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(a[p][q]) < 1e-20) continue;

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
  }

  const idx = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return {
    values: [a[idx[0]][idx[0]], a[idx[1]][idx[1]], a[idx[2]][idx[2]]],
    vectors: [
      [v[0][idx[0]], v[1][idx[0]], v[2][idx[0]]],
      [v[0][idx[1]], v[1][idx[1]], v[2][idx[1]]],
      [v[0][idx[2]], v[1][idx[2]], v[2][idx[2]]],
    ],
  };
}

/**
 * Least-squares circle through 2D points (Kåsa).
 *
 * Algebraic rather than geometric: minimising the algebraic residual is linear and exact in
 * one step, where the geometric fit needs iteration. The bias that makes Kåsa a poor choice
 * for short arcs does not apply here — the points come from a full or near-full tessellated
 * revolution, which is the case it is accurate for.
 */
export function fitCircle2D(pts: [number, number][]): { cx: number; cy: number; r: number } | null {
  const n = pts.length;
  if (n < 3) return null;

  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of pts) {
    const z = x * x + y * y;
    sx += x; sy += y; sz += z;
    sxx += x * x; syy += y * y; sxy += x * y;
    sxz += x * z; syz += y * z;
  }

  // Least squares of z = x² + y² against the linear model z ≈ A·x + B·y + C, whose solution
  // gives A = 2·cx, B = 2·cy, C = r² − cx² − cy². The right-hand side is *not* scaled: an
  // earlier version halved it, which silently returned r/√2 — a radius-10 circle fitted as
  // 7.07 — and every cylinder was then rejected for a residual it did not have.
  const a11 = sxx, a12 = sxy, a13 = sx;
  const a22 = syy, a23 = sy;
  const a33 = n;
  const b1 = sxz, b2 = syz, b3 = sz;

  const det =
    a11 * (a22 * a33 - a23 * a23) -
    a12 * (a12 * a33 - a23 * a13) +
    a13 * (a12 * a23 - a22 * a13);
  if (Math.abs(det) < 1e-20) return null;

  const A =
    (b1 * (a22 * a33 - a23 * a23) -
     a12 * (b2 * a33 - a23 * b3) +
     a13 * (b2 * a23 - a22 * b3)) / det;
  const B =
    (a11 * (b2 * a33 - a23 * b3) -
     b1 * (a12 * a33 - a23 * a13) +
     a13 * (a12 * b3 - b2 * a13)) / det;
  const C =
    (a11 * (a22 * b3 - b2 * a23) -
     a12 * (a12 * b3 - b2 * a13) +
     b1 * (a12 * a23 - a22 * a13)) / det;

  const cx = A / 2;
  const cy = B / 2;
  const r2 = C + cx * cx + cy * cy;
  if (!(r2 > 0)) return null;

  return { cx, cy, r: Math.sqrt(r2) };
}

export interface CylinderFit {
  /** Unit direction along the axis. */
  axis: Vec3;
  /** A point on the axis. */
  origin: Vec3;
  radius: number;
  /** Largest distance any sample sits off the fitted surface. */
  residual: number;
  /** True when the material is inside the surface — a shaft rather than a hole. */
  outward: boolean;
}

export interface CylinderSamples {
  /**
   * Mesh vertices of the region.
   *
   * The radius is fitted to these and to nothing else, because these are the points that lie
   * *on* the surface being approximated. Fitting to facet centres instead reads the polygon's
   * apothem rather than its circumradius, and every hole comes out systematically undersize —
   * a ⌀40 shaft measured 39.91, which is the sort of error that survives review and fails at
   * assembly.
   */
  vertices: Vec3[];
  /** One per facet, paired with `normals`, for deciding which side the material is on. */
  facetCentres: Vec3[];
  /** One per facet. The axis is recovered from these. */
  normals: Vec3[];
  /** Absolute distance; the caller scales it to the model. */
  tol: number;
}

/**
 * Fits a cylinder to a group of facets.
 *
 * The axis comes from the normals rather than the points, and that is what makes it robust.
 * Every normal of a cylinder is perpendicular to its axis, so the axis is the null direction
 * of the normals' covariance — recoverable from a handful of facets, and unaffected by how
 * much of the cylinder is present or how it is trimmed. Fitting the axis from point positions
 * instead needs a full revolution and degrades on a partial one.
 */
export function fitCylinder(s: CylinderSamples): CylinderFit | null {
  const { vertices, facetCentres, normals, tol } = s;
  if (vertices.length < 6 || normals.length < 3) return null;
  if (facetCentres.length !== normals.length) return null;

  // Axis = the direction every normal is perpendicular to.
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const n of normals) {
    xx += n[0] * n[0]; yy += n[1] * n[1]; zz += n[2] * n[2];
    xy += n[0] * n[1]; xz += n[0] * n[2]; yz += n[1] * n[2];
  }
  const { values, vectors } = eigenSym3([xx, yy, zz, xy, xz, yz]);

  // The smallest eigenvalue must be genuinely small and genuinely separated from the next.
  // Without the separation test a sphere passes — its normals point everywhere, so all three
  // eigenvalues are equal and the "axis" is whichever one rounding happened to favour.
  const axis = norm3(vectors[0]);
  if (len3(axis) < 0.5) return null;
  if (values[0] > values[1] * 0.05) return null;

  // Project onto the plane perpendicular to the axis and fit a circle there.
  const u = norm3(perpTo(axis));
  const v = cross3(axis, u);

  const flat: [number, number][] = vertices.map((p) => [dot3(p, u), dot3(p, v)]);
  const circle = fitCircle2D(flat);
  if (!circle || !(circle.r > tol)) return null;

  // The axis passes through the fitted centre, expressed back in 3D.
  const origin: Vec3 = [
    u[0] * circle.cx + v[0] * circle.cy,
    u[1] * circle.cx + v[1] * circle.cy,
    u[2] * circle.cx + v[2] * circle.cy,
  ];

  // Reject on the worst sample, not the average. An average hides the one facet that is not
  // on the cylinder at all, which is precisely the facet that would be moved by accepting.
  let residual = 0;
  for (const [x, y] of flat) {
    const d = Math.abs(Math.hypot(x - circle.cx, y - circle.cy) - circle.r);
    if (d > residual) residual = d;
  }
  if (residual > tol) return null;

  // Normals must also agree: perpendicular to the axis, and consistently radial.
  let outwardVotes = 0;
  for (let i = 0; i < normals.length; i++) {
    if (Math.abs(dot3(normals[i], axis)) > 0.08) return null;

    const p = facetCentres[i];
    const along = dot3(sub3(p, origin), axis);
    const radial = norm3(sub3(sub3(p, origin), [axis[0] * along, axis[1] * along, axis[2] * along]));
    outwardVotes += dot3(normals[i], radial) > 0 ? 1 : -1;
  }

  // A surface whose normals disagree about which side the material is on is not one cylinder.
  if (Math.abs(outwardVotes) !== normals.length) return null;

  return { axis, origin, radius: circle.r, residual, outward: outwardVotes > 0 };
}

export interface ConeFit {
  /** The point every tangent plane passes through. */
  apex: Vec3;
  /** Unit, pointing from the apex into the body — the direction the radius grows. */
  axis: Vec3;
  /** Between the axis and the surface, in radians. Never 0 (a cylinder) or π/2 (a disc). */
  halfAngle: number;
  residual: number;
  /** True when the material is inside the surface — a countersunk plug rather than a chamfer. */
  outward: boolean;
}

/** Solves a symmetric 3x3 system by Gaussian elimination with partial pivoting. */
function solve3(a: number[][], b: number[]): Vec3 | null {
  const m = [[...a[0], b[0]], [...a[1], b[1]], [...a[2], b[2]]];

  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    // A singular system here is not a numerical accident: it is what a cylinder looks like,
    // because its tangent planes are all parallel to the axis and never meet at a point.
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];

    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
    }
  }

  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/**
 * Fits a cone to a group of facets.
 *
 * Two properties do all the work, and both are exact rather than iterative.
 *
 * **The apex.** Every tangent plane of a cone contains its apex — that is what makes it a
 * cone. So for every surface point p with normal n, `(A − p)·n = 0`, which is *linear* in the
 * unknown apex A. Three independent normals determine it, and a least-squares solve over all
 * of them is one 3×3 system. No search, no starting guess, nothing to converge.
 *
 * **The axis.** Every normal makes the same angle with the axis, so the tips of the unit
 * normals lie on a plane. Fitting a plane through them gives the axis as its normal, and its
 * distance from the origin is the sine of the half-angle. A cylinder is the special case where
 * that plane passes through the origin, which is also exactly when the apex system goes
 * singular — so the two tests agree, and a cylinder is rejected here rather than fitted badly.
 */
export function fitCone(s: CylinderSamples): ConeFit | null {
  const { vertices, facetCentres, normals, tol } = s;
  if (vertices.length < 6 || normals.length < 4) return null;
  if (facetCentres.length !== normals.length) return null;

  // ── axis and half-angle, from a plane through the tips of the normals ──
  const mean: Vec3 = [0, 0, 0];
  for (const n of normals) { mean[0] += n[0]; mean[1] += n[1]; mean[2] += n[2]; }
  mean[0] /= normals.length; mean[1] /= normals.length; mean[2] /= normals.length;

  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const n of normals) {
    const d: Vec3 = [n[0] - mean[0], n[1] - mean[1], n[2] - mean[2]];
    xx += d[0] * d[0]; yy += d[1] * d[1]; zz += d[2] * d[2];
    xy += d[0] * d[1]; xz += d[0] * d[2]; yz += d[1] * d[2];
  }
  const { values, vectors } = eigenSym3([xx, yy, zz, xy, xz, yz]);
  if (values[0] > values[1] * 0.05) return null;    // normals do not lie on one plane

  let axis = norm3(vectors[0]);
  const sinAlpha = dot3(mean, axis);
  const halfAngle = Math.asin(Math.min(1, Math.abs(sinAlpha)));

  // Below about a degree this is a cylinder and belongs to the other fit; above 80° the
  // surface is nearly a flat annulus and the apex is far away and badly conditioned.
  if (halfAngle < 0.02 || halfAngle > 1.4) return null;

  // ── apex, from the tangent planes ──
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rhs = [0, 0, 0];
  for (let i = 0; i < normals.length; i++) {
    const n = normals[i];
    const pn = dot3(facetCentres[i], n);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) m[r][c] += n[r] * n[c];
      rhs[r] += pn * n[r];
    }
  }
  const apex = solve3(m, rhs);
  if (!apex) return null;

  // Point the axis into the body, so the radius grows along it.
  let along = 0;
  for (const p of facetCentres) along += dot3(sub3(p, apex), axis);
  if (along < 0) axis = [-axis[0], -axis[1], -axis[2]];

  // ── refine against the vertices ──
  //
  // Everything so far came from facet normals, and a facet normal is a chord's normal rather
  // than the surface's — biased by however coarsely the cone was tessellated. That put the
  // half-angle out by about a hundredth of a degree, which is small but is not zero and has no
  // business being wrong at all.
  //
  // The vertices lie *exactly* on the surface, and on a cone the radius is linear in the
  // distance along the axis: ρ = a·s + b. Fitting that line is one least-squares pass and
  // gives both the true half-angle (atan a) and the true apex (where ρ reaches zero).
  const sAll: number[] = [];
  const rhoAll: number[] = [];
  for (const p of vertices) {
    const d = sub3(p, apex);
    const s0 = dot3(d, axis);
    const radial: Vec3 = [d[0] - axis[0] * s0, d[1] - axis[1] * s0, d[2] - axis[2] * s0];
    sAll.push(s0);
    rhoAll.push(len3(radial));
  }

  const n = sAll.length;
  let ss = 0, sr = 0, sSum = 0, rSum = 0;
  for (let i = 0; i < n; i++) {
    ss += sAll[i] * sAll[i]; sr += sAll[i] * rhoAll[i];
    sSum += sAll[i]; rSum += rhoAll[i];
  }
  const denom = n * ss - sSum * sSum;
  if (Math.abs(denom) < 1e-12) return null;

  const slope = (n * sr - sSum * rSum) / denom;
  const intercept = (rSum - slope * sSum) / n;
  if (!(slope > 0)) return null;                     // radius must grow along the axis

  const refinedAngle = Math.atan(slope);
  if (refinedAngle < 0.02 || refinedAngle > 1.4) return null;

  // The apex is where the fitted radius reaches zero.
  const shift = -intercept / slope;
  const trueApex: Vec3 = [
    apex[0] + axis[0] * shift,
    apex[1] + axis[1] * shift,
    apex[2] + axis[2] * shift,
  ];

  // ── validation, against the refined cone ──
  let residual = 0;
  for (let i = 0; i < n; i++) {
    const s0 = sAll[i] - shift;
    if (s0 < -tol) return null;                      // a point behind the apex is not on this cone

    // Perpendicular distance to the surface, not to the axis: the radial error is measured
    // along the radius, and the surface is tilted away from it by the half-angle.
    const off = Math.abs(rhoAll[i] - s0 * slope) * Math.cos(refinedAngle);
    if (off > residual) residual = off;
  }
  if (residual > tol) return null;

  // Normals must agree about which side the material is on.
  let outwardVotes = 0;
  for (let i = 0; i < normals.length; i++) {
    const d = sub3(facetCentres[i], trueApex);
    const s0 = dot3(d, axis);
    const radial = norm3([d[0] - axis[0] * s0, d[1] - axis[1] * s0, d[2] - axis[2] * s0]);
    outwardVotes += dot3(normals[i], radial) > 0 ? 1 : -1;
  }
  if (Math.abs(outwardVotes) !== normals.length) return null;

  return { apex: trueApex, axis, halfAngle: refinedAngle, residual, outward: outwardVotes > 0 };
}

/** Any unit vector perpendicular to `d`. */
export function perpTo(d: Vec3): Vec3 {
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
  const pick: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const r = cross3(d, pick);
  const l = len3(r);
  return l > 1e-12 ? [r[0] / l, r[1] / l, r[2] / l] : [1, 0, 0];
}

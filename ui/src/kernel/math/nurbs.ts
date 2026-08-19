/**
 * NURBS curves and surfaces.
 *
 * Non-uniform rational B-splines are the representation every serious CAD kernel settles
 * on, for one decisive reason: they exactly represent both freeform shapes and the conic
 * sections. A circle in NURBS form is a *circle*, not a fine polygon approximating one, so
 * a fillet tangent to it is exactly tangent and a revolve of it is exactly a sphere. Systems
 * that approximate arcs with polylines accumulate error at every operation, and the error
 * shows up as visible facets and as surfaces that refuse to knit.
 *
 * Everything here follows Piegl & Tiller, "The NURBS Book" (2nd ed., Springer 1997), whose
 * algorithm numbering is referenced in the comments so the code can be checked against it.
 */

import type { Vec2, Vec3 } from './vec';
import { add3, cross3, dist3, mul3, norm3, sub3, len3 } from './vec';
import { mat, qrDecompose, qrSolve, set, type Matrix } from './linalg';

/**
 * A NURBS curve.
 *
 * Control points carry weights; weight 1 throughout gives a plain non-rational B-spline.
 * The knot vector has `ctrl.length + degree + 1` entries and must be non-decreasing.
 */
export interface NurbsCurve {
  degree: number;
  /** Control points in 3D. */
  ctrl: Vec3[];
  /** Homogeneous weights, one per control point. */
  weights: number[];
  /** Knot vector, non-decreasing, length = ctrl.length + degree + 1. */
  knots: number[];
}

export interface NurbsSurface {
  degreeU: number;
  degreeV: number;
  /** Control net, indexed [u][v]. */
  ctrl: Vec3[][];
  weights: number[][];
  knotsU: number[];
  knotsV: number[];
}

// ── knot vectors ─────────────────────────────────────────────────────────────

/**
 * Clamped uniform knot vector.
 *
 * "Clamped" means the first and last knots are repeated `degree + 1` times, which forces
 * the curve to pass through its first and last control points. Unclamped curves float away
 * from their endpoints, which is never what a CAD user means when they place a point.
 */
export function clampedKnots(count: number, degree: number): number[] {
  const n = count - 1;
  const m = n + degree + 1;
  const knots: number[] = new Array(m + 1);
  for (let i = 0; i <= degree; i++) knots[i] = 0;
  for (let i = m - degree; i <= m; i++) knots[i] = 1;
  const inner = n - degree;
  for (let i = 1; i <= inner; i++) knots[degree + i] = i / (inner + 1);
  return knots;
}

/** Index of the knot span containing `u`. Piegl & Tiller A2.1, binary search. */
export function findSpan(n: number, degree: number, u: number, knots: number[]): number {
  // The last span is half-open everywhere except at the very end, where the clamped
  // knot repeats; special-casing it avoids returning an out-of-range span at u = 1.
  if (u >= knots[n + 1]) return n;
  if (u <= knots[degree]) return degree;

  let low = degree, high = n + 1, mid = Math.floor((low + high) / 2);
  while (u < knots[mid] || u >= knots[mid + 1]) {
    if (u < knots[mid]) high = mid;
    else low = mid;
    mid = Math.floor((low + high) / 2);
  }
  return mid;
}

/**
 * The `degree + 1` non-zero basis functions at `u`. Piegl & Tiller A2.2.
 *
 * Uses the triangular recurrence rather than the textbook Cox-de Boor definition: the
 * direct form divides by knot differences that are zero at repeated knots, and repeated
 * knots are exactly what clamping and sharp corners produce.
 */
export function basisFunctions(span: number, u: number, degree: number, knots: number[]): number[] {
  const N: number[] = new Array(degree + 1).fill(0);
  const left: number[] = new Array(degree + 1).fill(0);
  const right: number[] = new Array(degree + 1).fill(0);
  N[0] = 1;

  for (let j = 1; j <= degree; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const temp = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

/** Basis functions and their derivatives up to order `n`. Piegl & Tiller A2.3. */
export function basisDerivatives(
  span: number, u: number, degree: number, knots: number[], n: number,
): number[][] {
  const ndu: number[][] = Array.from({ length: degree + 1 }, () => new Array(degree + 1).fill(0));
  const left: number[] = new Array(degree + 1).fill(0);
  const right: number[] = new Array(degree + 1).fill(0);
  ndu[0][0] = 1;

  for (let j = 1; j <= degree; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const temp = ndu[r][j - 1] / ndu[j][r];
      ndu[r][j] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j][j] = saved;
  }

  const ders: number[][] = Array.from({ length: n + 1 }, () => new Array(degree + 1).fill(0));
  for (let j = 0; j <= degree; j++) ders[0][j] = ndu[j][degree];

  const a: number[][] = [new Array(degree + 1).fill(0), new Array(degree + 1).fill(0)];
  for (let r = 0; r <= degree; r++) {
    let s1 = 0, s2 = 1;
    a[0][0] = 1;
    for (let k = 1; k <= n; k++) {
      let d = 0;
      const rk = r - k, pk = degree - k;
      if (r >= k) { a[s2][0] = a[s1][0] / ndu[pk + 1][rk]; d = a[s2][0] * ndu[rk][pk]; }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? k - 1 : degree - r;
      for (let j = j1; j <= j2; j++) {
        a[s2][j] = (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][rk + j];
        d += a[s2][j] * ndu[rk + j][pk];
      }
      if (r <= pk) { a[s2][k] = -a[s1][k - 1] / ndu[pk + 1][r]; d += a[s2][k] * ndu[r][pk]; }
      ders[k][r] = d;
      const t = s1; s1 = s2; s2 = t;
    }
  }

  let r = degree;
  for (let k = 1; k <= n; k++) {
    for (let j = 0; j <= degree; j++) ders[k][j] *= r;
    r *= degree - k;
  }
  return ders;
}

// ── curve evaluation ─────────────────────────────────────────────────────────

/** Point on a NURBS curve at parameter `u` in [0, 1]. Piegl & Tiller A4.1. */
export function curvePoint(c: NurbsCurve, u: number): Vec3 {
  const n = c.ctrl.length - 1;
  const t = Math.min(1, Math.max(0, u));
  const span = findSpan(n, c.degree, t, c.knots);
  const N = basisFunctions(span, t, c.degree, c.knots);

  // Accumulate in homogeneous coordinates, then project. Projecting each control point
  // first and blending afterwards gives a different (and wrong) curve for rational cases.
  let x = 0, y = 0, z = 0, w = 0;
  for (let i = 0; i <= c.degree; i++) {
    const idx = span - c.degree + i;
    const wt = c.weights[idx] * N[i];
    x += c.ctrl[idx][0] * wt;
    y += c.ctrl[idx][1] * wt;
    z += c.ctrl[idx][2] * wt;
    w += wt;
  }
  return w === 0 ? [0, 0, 0] : [x / w, y / w, z / w];
}

/**
 * Curve derivatives up to order `d`. Piegl & Tiller A4.2.
 *
 * The rational case needs the quotient rule applied recursively, because the curve is
 * a ratio of two polynomials. Skipping that and differentiating the numerator alone is
 * a common shortcut that produces subtly wrong tangents on any weighted curve — which
 * includes every exact arc.
 */
export function curveDerivatives(c: NurbsCurve, u: number, d: number): Vec3[] {
  const n = c.ctrl.length - 1;
  const t = Math.min(1, Math.max(0, u));
  const span = findSpan(n, c.degree, t, c.knots);
  const du = Math.min(d, c.degree);
  const ders = basisDerivatives(span, t, c.degree, c.knots, du);

  // Homogeneous derivatives A^(k) and w^(k).
  const A: Vec3[] = [];
  const w: number[] = [];
  for (let k = 0; k <= du; k++) {
    let x = 0, y = 0, z = 0, wk = 0;
    for (let i = 0; i <= c.degree; i++) {
      const idx = span - c.degree + i;
      const b = ders[k][i] * c.weights[idx];
      x += c.ctrl[idx][0] * b;
      y += c.ctrl[idx][1] * b;
      z += c.ctrl[idx][2] * b;
      wk += b;
    }
    A.push([x, y, z]);
    w.push(wk);
  }

  const out: Vec3[] = [];
  for (let k = 0; k <= du; k++) {
    let v: Vec3 = [...A[k]] as Vec3;
    for (let i = 1; i <= k; i++) {
      v = sub3(v, mul3(out[k - i], binomial(k, i) * w[i]));
    }
    out.push(w[0] === 0 ? [0, 0, 0] : mul3(v, 1 / w[0]));
  }
  for (let k = du + 1; k <= d; k++) out.push([0, 0, 0]);
  return out;
}

export function curveTangent(c: NurbsCurve, u: number): Vec3 {
  return norm3(curveDerivatives(c, u, 1)[1]);
}

/** Curvature magnitude, |C' x C''| / |C'|^3. */
export function curveCurvature(c: NurbsCurve, u: number): number {
  const d = curveDerivatives(c, u, 2);
  const speed = len3(d[1]);
  if (speed < 1e-12) return 0;
  return len3(cross3(d[1], d[2])) / speed ** 3;
}

function binomial(n: number, k: number): number {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

// ── surface evaluation ───────────────────────────────────────────────────────

export function surfacePoint(s: NurbsSurface, u: number, v: number): Vec3 {
  const nu = s.ctrl.length - 1;
  const nv = s.ctrl[0].length - 1;
  const cu = Math.min(1, Math.max(0, u));
  const cv = Math.min(1, Math.max(0, v));

  const spanU = findSpan(nu, s.degreeU, cu, s.knotsU);
  const spanV = findSpan(nv, s.degreeV, cv, s.knotsV);
  const Nu = basisFunctions(spanU, cu, s.degreeU, s.knotsU);
  const Nv = basisFunctions(spanV, cv, s.degreeV, s.knotsV);

  let x = 0, y = 0, z = 0, w = 0;
  for (let i = 0; i <= s.degreeU; i++) {
    const iu = spanU - s.degreeU + i;
    for (let j = 0; j <= s.degreeV; j++) {
      const iv = spanV - s.degreeV + j;
      const wt = s.weights[iu][iv] * Nu[i] * Nv[j];
      x += s.ctrl[iu][iv][0] * wt;
      y += s.ctrl[iu][iv][1] * wt;
      z += s.ctrl[iu][iv][2] * wt;
      w += wt;
    }
  }
  return w === 0 ? [0, 0, 0] : [x / w, y / w, z / w];
}

/** Surface normal from the cross product of the partial derivatives. */
export function surfaceNormal(s: NurbsSurface, u: number, v: number): Vec3 {
  const h = 1e-6;
  const p = surfacePoint(s, u, v);
  // One-sided differences at the boundary, where stepping outside the domain would clamp
  // and silently return a zero-length derivative.
  const du = u + h > 1
    ? sub3(p, surfacePoint(s, u - h, v))
    : sub3(surfacePoint(s, u + h, v), p);
  const dv = v + h > 1
    ? sub3(p, surfacePoint(s, u, v - h))
    : sub3(surfacePoint(s, u, v + h), p);
  return norm3(cross3(du, dv));
}

// ── construction ─────────────────────────────────────────────────────────────

/** Straight line as a degree-1 NURBS. */
export function lineToNurbs(a: Vec3, b: Vec3): NurbsCurve {
  return { degree: 1, ctrl: [a, b], weights: [1, 1], knots: [0, 0, 1, 1] };
}

/**
 * Exact circular arc as a rational quadratic NURBS. Piegl & Tiller A7.1.
 *
 * The weights are what make this exact. A quadratic Bezier with weight cos(theta/2) on the
 * middle control point traces a true circular arc — no approximation, no matter how the
 * curve is later subdivided or intersected. This single function is why the kernel can
 * revolve a profile into an exact cylinder.
 */
export function arcToNurbs(
  centre: Vec3, xAxis: Vec3, yAxis: Vec3, radius: number, startAngle: number, endAngle: number,
): NurbsCurve {
  let theta = endAngle - startAngle;
  if (theta <= 0) theta += 2 * Math.PI;

  // Each rational quadratic segment covers at most 90 degrees; beyond that the weight
  // becomes negative and the arc turns inside out.
  const narcs = theta > (3 * Math.PI) / 2 ? 4 : theta > Math.PI ? 3 : theta > Math.PI / 2 ? 2 : 1;
  const dtheta = theta / narcs;
  const w1 = Math.cos(dtheta / 2);

  const X = norm3(xAxis), Y = norm3(yAxis);
  const P = (ang: number): Vec3 =>
    add3(centre, add3(mul3(X, radius * Math.cos(ang)), mul3(Y, radius * Math.sin(ang))));
  const T = (ang: number): Vec3 =>
    add3(mul3(X, -Math.sin(ang)), mul3(Y, Math.cos(ang)));

  const n = 2 * narcs;
  const ctrl: Vec3[] = new Array(n + 1);
  const weights: number[] = new Array(n + 1);

  let ang = startAngle;
  ctrl[0] = P(ang);
  weights[0] = 1;
  let T0 = T(ang);

  for (let i = 1, index = 0; i <= narcs; i++) {
    ang += dtheta;
    const P2 = P(ang);
    const T2 = T(ang);

    // The intermediate control point is where the end tangents meet.
    const inter = intersectLines(ctrl[index], T0, P2, T2);
    ctrl[index + 1] = inter;
    weights[index + 1] = w1;
    ctrl[index + 2] = P2;
    weights[index + 2] = 1;

    index += 2;
    T0 = T2;
  }

  const knots: number[] = new Array(n + 3 + 1).fill(0);
  for (let i = 0; i < 3; i++) { knots[i] = 0; knots[i + n + 1] = 1; }
  switch (narcs) {
    case 2: knots[3] = knots[4] = 0.5; break;
    case 3: knots[3] = knots[4] = 1 / 3; knots[5] = knots[6] = 2 / 3; break;
    case 4: knots[3] = knots[4] = 0.25; knots[5] = knots[6] = 0.5; knots[7] = knots[8] = 0.75; break;
  }

  return { degree: 2, ctrl, weights, knots };
}

/** Full circle as an exact rational NURBS. */
export function circleToNurbs(centre: Vec3, xAxis: Vec3, yAxis: Vec3, radius: number): NurbsCurve {
  return arcToNurbs(centre, xAxis, yAxis, radius, 0, 2 * Math.PI);
}

function intersectLines(p0: Vec3, t0: Vec3, p2: Vec3, t2: Vec3): Vec3 {
  // Closest approach of two lines; for arc construction they always meet exactly, but
  // solving in least-squares form keeps it stable when they are nearly parallel.
  const w = sub3(p0, p2);
  const a = t0[0] * t0[0] + t0[1] * t0[1] + t0[2] * t0[2];
  const b = t0[0] * t2[0] + t0[1] * t2[1] + t0[2] * t2[2];
  const c = t2[0] * t2[0] + t2[1] * t2[1] + t2[2] * t2[2];
  const d = t0[0] * w[0] + t0[1] * w[1] + t0[2] * w[2];
  const e = t2[0] * w[0] + t2[1] * w[1] + t2[2] * w[2];
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-14) return mul3(add3(p0, p2), 0.5);
  const s = (b * e - c * d) / denom;
  return add3(p0, mul3(t0, s));
}

/**
 * Global cubic interpolation through the given points. Piegl & Tiller A9.1.
 *
 * Chord-length parameterisation. Uniform parameterisation looks fine on evenly spaced
 * points and produces visible overshoot the moment spacing varies, which for traced
 * contours from an image it always does.
 */
export function interpolateCurve(points: Vec3[], degree = 3): NurbsCurve {
  const n = points.length - 1;
  if (n < 1) throw new Error('interpolateCurve: need at least two points');
  const p = Math.min(degree, n);
  if (p === 1) {
    const knots = [0, 0];
    let total = 0;
    const d: number[] = [0];
    for (let i = 1; i <= n; i++) { total += dist3(points[i], points[i - 1]); d.push(total); }
    for (let i = 1; i < n; i++) knots.push(total > 0 ? d[i] / total : i / n);
    knots.push(1, 1);
    return { degree: 1, ctrl: [...points], weights: points.map(() => 1), knots };
  }

  let total = 0;
  const chord: number[] = [0];
  for (let i = 1; i <= n; i++) { total += dist3(points[i], points[i - 1]); chord.push(total); }
  const uk: number[] = chord.map((c) => (total > 0 ? c / total : 0));
  if (total === 0) for (let i = 0; i <= n; i++) uk[i] = i / n;

  // Averaging knot placement guarantees every basis function has a point in its support,
  // which is the condition for the interpolation matrix to be non-singular.
  const m = n + p + 1;
  const knots: number[] = new Array(m + 1).fill(0);
  for (let i = m - p; i <= m; i++) knots[i] = 1;
  for (let j = 1; j <= n - p; j++) {
    let s = 0;
    for (let i = j; i <= j + p - 1; i++) s += uk[i];
    knots[j + p] = s / p;
  }

  const A = mat(n + 1, n + 1);
  for (let i = 0; i <= n; i++) {
    const span = findSpan(n, p, uk[i], knots);
    const N = basisFunctions(span, uk[i], p, knots);
    for (let j = 0; j <= p; j++) set(A, i, span - p + j, N[j]);
  }

  const qr = qrDecompose(A);
  const ctrl: Vec3[] = [];
  const coords: Vec3[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const rhs = points.map((pt) => pt[axis]);
    const sol = qrSolve(qr, rhs);
    // A singular interpolation matrix means duplicate parameters, i.e. duplicate points.
    // Falling back to the input points is a valid (if unsmoothed) curve, and is far better
    // than returning NaN control points that poison everything downstream.
    if (!sol) return { degree: 1, ctrl: [...points], weights: points.map(() => 1), knots: clampedKnots(points.length, 1) };
    coords.push(sol as unknown as Vec3);
    void axis;
  }
  for (let i = 0; i <= n; i++) {
    ctrl.push([
      (coords[0] as unknown as Float64Array)[i],
      (coords[1] as unknown as Float64Array)[i],
      (coords[2] as unknown as Float64Array)[i],
    ]);
  }

  return { degree: p, ctrl, weights: ctrl.map(() => 1), knots };
}

/**
 * Least-squares curve fit with a fixed control point budget. Piegl & Tiller A9.6.
 *
 * Interpolation through every traced pixel would produce a curve with thousands of control
 * points that reproduces the scanning noise faithfully. Approximation is what turns a noisy
 * contour into a clean manufacturable edge, so the image importer uses this, not the
 * interpolator.
 */
export function approximateCurve(points: Vec3[], numCtrl: number, degree = 3): NurbsCurve {
  const m = points.length - 1;
  const n = Math.min(numCtrl, points.length) - 1;
  const p = Math.min(degree, n);
  if (n < 1 || m < 1) return interpolateCurve(points, degree);
  if (n >= m) return interpolateCurve(points, degree);

  let total = 0;
  const chord: number[] = [0];
  for (let i = 1; i <= m; i++) { total += dist3(points[i], points[i - 1]); chord.push(total); }
  const uk = chord.map((c) => (total > 0 ? c / total : 0));
  if (total === 0) for (let i = 0; i <= m; i++) uk[i] = i / m;

  const knots: number[] = new Array(n + p + 2).fill(0);
  for (let i = n + 1; i <= n + p + 1; i++) knots[i] = 1;
  const d = (m + 1) / (n - p + 1);
  for (let j = 1; j <= n - p; j++) {
    const i = Math.floor(j * d);
    const alpha = j * d - i;
    knots[p + j] = (1 - alpha) * uk[Math.max(0, i - 1)] + alpha * uk[Math.min(m, i)];
  }

  // Endpoints are interpolated exactly and removed from the least-squares system, so a
  // fitted profile still starts and ends where the user's contour did.
  const rows = m - 1;
  const cols = n - 1;
  if (rows < 1 || cols < 1) return interpolateCurve(points, degree);

  const N = mat(rows, cols);
  const R: Vec3[] = [];
  for (let k = 1; k < m; k++) {
    const span = findSpan(n, p, uk[k], knots);
    const funcs = basisFunctions(span, uk[k], p, knots);
    const N0 = basisAt(0, span, funcs, p, n);
    const Nn = basisAt(n, span, funcs, p, n);
    R.push(sub3(sub3(points[k], mul3(points[0], N0)), mul3(points[m], Nn)));
    for (let i = 1; i < n; i++) set(N, k - 1, i - 1, basisAt(i, span, funcs, p, n));
  }

  const NT = transposeM(N);
  const NTN = mulM(NT, N);
  const qr = qrDecompose(NTN);

  const ctrl: Vec3[] = new Array(n + 1);
  ctrl[0] = points[0];
  ctrl[n] = points[m];

  const solved: Float64Array[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const rhs = new Float64Array(rows);
    for (let k = 0; k < rows; k++) rhs[k] = R[k][axis];
    const b = matTVecLocal(N, rhs);
    const sol = qrSolve(qr, b);
    if (!sol) return interpolateCurve(points, degree);
    solved.push(sol);
  }
  for (let i = 1; i < n; i++) ctrl[i] = [solved[0][i - 1], solved[1][i - 1], solved[2][i - 1]];

  return { degree: p, ctrl, weights: ctrl.map(() => 1), knots };
}

function basisAt(i: number, span: number, funcs: number[], p: number, _n: number): number {
  const lo = span - p;
  return i >= lo && i <= span ? funcs[i - lo] : 0;
}

function transposeM(m: Matrix): Matrix {
  const o = mat(m.cols, m.rows);
  for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) o.data[c * m.rows + r] = m.data[r * m.cols + c];
  return o;
}

function mulM(a: Matrix, b: Matrix): Matrix {
  const o = mat(a.rows, b.cols);
  for (let i = 0; i < a.rows; i++) {
    for (let k = 0; k < a.cols; k++) {
      const aik = a.data[i * a.cols + k];
      if (aik === 0) continue;
      for (let j = 0; j < b.cols; j++) o.data[i * b.cols + j] += aik * b.data[k * b.cols + j];
    }
  }
  return o;
}

function matTVecLocal(m: Matrix, x: Float64Array): Float64Array {
  const out = new Float64Array(m.cols);
  for (let r = 0; r < m.rows; r++) {
    const xr = x[r];
    if (xr === 0) continue;
    for (let c = 0; c < m.cols; c++) out[c] += m.data[r * m.cols + c] * xr;
  }
  return out;
}

// ── tessellation ─────────────────────────────────────────────────────────────

/**
 * Adaptive tessellation to a chordal tolerance.
 *
 * Fixed-step sampling is the obvious approach and is wrong in both directions at once: it
 * wastes triangles on the straight parts and still facets the tight corners. Recursing on
 * the actual sagitta spends points where curvature demands them, so a part with one small
 * fillet does not need thousands of segments everywhere else to look right.
 */
export function tessellateCurve(c: NurbsCurve, tol = 0.01, maxDepth = 18): Vec3[] {
  /*
   * Subdivided span by span, not over the whole parameter range at once.
   *
   * The flatness test compares the midpoint against the chord, and that test is only sound
   * where the curve is a single polynomial piece. Applied across the whole of a curve that
   * loops — a helix is the plain case — it aliases catastrophically: for a four-turn helix
   * the start, middle and end points are nearly collinear up the axis, the sagitta is tiny,
   * and the recursion stops immediately. The curve tessellated to three points, so a spring
   * swept along it came out 6 mm tall instead of 54 mm and weighed a fortieth of the wire it
   * is made from.
   *
   * Between two distinct knots the curve is one polynomial and cannot fold back on itself, so
   * the test means there what it is supposed to mean.
   */
  const knots = c.knots;
  const first = knots[c.degree]!;
  const last = knots[knots.length - c.degree - 1]!;

  const breaks: number[] = [first];
  for (let i = c.degree + 1; i < knots.length - c.degree - 1; i++) {
    const u = knots[i]!;
    if (u > breaks[breaks.length - 1]! + 1e-12 && u < last - 1e-12) breaks.push(u);
  }
  breaks.push(last);

  const out: Vec3[] = [curvePoint(c, first)];
  for (let i = 0; i < breaks.length - 1; i++) {
    const u0 = breaks[i]!;
    const u1 = breaks[i + 1]!;
    recurse(c, u0, u1, curvePoint(c, u0), curvePoint(c, u1), tol, out, 0, maxDepth);
    out.push(curvePoint(c, u1));
  }
  return out;
}

function recurse(
  c: NurbsCurve, u0: number, u1: number, p0: Vec3, p1: Vec3,
  tol: number, out: Vec3[], depth: number, maxDepth: number,
): void {
  if (depth >= maxDepth) return;
  const um = (u0 + u1) / 2;
  const pm = curvePoint(c, um);

  // Deviation of the true midpoint from the chord — the sagitta.
  const chord = sub3(p1, p0);
  const chordLen = len3(chord);
  let dev: number;
  if (chordLen < 1e-12) {
    dev = dist3(pm, p0);
  } else {
    const t = sub3(pm, p0);
    const proj = (t[0] * chord[0] + t[1] * chord[1] + t[2] * chord[2]) / (chordLen * chordLen);
    dev = dist3(pm, add3(p0, mul3(chord, proj)));
  }

  if (dev <= tol && depth >= 1) return;

  recurse(c, u0, um, p0, pm, tol, out, depth + 1, maxDepth);
  out.push(pm);
  recurse(c, um, u1, pm, p1, tol, out, depth + 1, maxDepth);
}

/** Arc length by adaptive Gauss-Legendre quadrature on the speed |C'(u)|. */
export function curveLength(c: NurbsCurve, segments = 64): number {
  // 5-point Gauss-Legendre is exact for polynomials to degree 9; per sub-interval that is
  // far more accurate than sampling, at a fraction of the evaluations.
  const nodes = [0, -0.5384693101056831, 0.5384693101056831, -0.906179845938664, 0.906179845938664];
  const wts = [0.5688888888888889, 0.47862867049936647, 0.47862867049936647, 0.23692688505618908, 0.23692688505618908];

  let total = 0;
  for (let i = 0; i < segments; i++) {
    const a = i / segments, b = (i + 1) / segments;
    const half = (b - a) / 2, mid = (a + b) / 2;
    let sum = 0;
    for (let k = 0; k < nodes.length; k++) {
      const d = curveDerivatives(c, mid + half * nodes[k], 1)[1];
      sum += wts[k] * len3(d);
    }
    total += sum * half;
  }
  return total;
}

/** Closest point on the curve to `p`, by sampling then Newton refinement. */
export function closestPointOnCurve(c: NurbsCurve, p: Vec3, samples = 64): { u: number; point: Vec3; distance: number } {
  let bestU = 0, bestD = Infinity;
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    const d = dist3(curvePoint(c, u), p);
    if (d < bestD) { bestD = d; bestU = u; }
  }

  // Newton on f(u) = (C(u) - p) . C'(u) = 0, the stationarity condition for distance.
  let u = bestU;
  for (let it = 0; it < 24; it++) {
    const d = curveDerivatives(c, u, 2);
    const r = sub3(d[0], p);
    const f = r[0] * d[1][0] + r[1] * d[1][1] + r[2] * d[1][2];
    const fp =
      d[1][0] * d[1][0] + d[1][1] * d[1][1] + d[1][2] * d[1][2] +
      r[0] * d[2][0] + r[1] * d[2][1] + r[2] * d[2][2];
    if (Math.abs(fp) < 1e-14) break;
    const step = f / fp;
    const next = Math.min(1, Math.max(0, u - step));
    if (Math.abs(next - u) < 1e-12) { u = next; break; }
    u = next;
  }

  const point = curvePoint(c, u);
  return { u, point, distance: dist3(point, p) };
}

/** Converts a planar 2D polyline into a 3D NURBS on the XY plane. */
export function polylineToNurbs(pts: Vec2[], closed: boolean, degree = 3, smooth = true): NurbsCurve {
  const p3: Vec3[] = pts.map((q) => [q[0], q[1], 0]);
  if (closed && p3.length > 1) p3.push([...p3[0]] as Vec3);
  return smooth && p3.length > degree
    ? interpolateCurve(p3, degree)
    : { degree: 1, ctrl: p3, weights: p3.map(() => 1), knots: clampedKnots(p3.length, 1) };
}

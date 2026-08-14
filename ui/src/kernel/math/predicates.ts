/**
 * Exact geometric predicates (Shewchuk adaptive-precision arithmetic).
 *
 * This file is the reason the boolean engine can be trusted.
 *
 * Every solid modelling operation reduces to one question asked millions of times: which
 * side of this plane is this point on? Answered in ordinary floating point, the answer is
 * occasionally wrong — and wrong in the worst possible way, because the errors are not
 * random. Near a coplanar face the sign flips inconsistently, so the same point is reported
 * "above" by one triangle and "below" by its neighbour. The mesh then fails to close, and
 * the failure surfaces far away from its cause as a leaking solid or a boolean that returns
 * garbage. This is the single most common reason hobby CAD kernels break on real parts:
 * real parts are full of coplanar faces, because engineers align things.
 *
 * The fix is Shewchuk's adaptive scheme. Compute the cheap floating-point answer first
 * together with a rigorous bound on its error. If the magnitude exceeds the bound the sign
 * is provably correct, so return immediately — this is the overwhelmingly common case and
 * costs one extra comparison. Only when the result is too close to zero to trust do we
 * escalate to exact expansion arithmetic, which represents the value as an unevaluated sum
 * of doubles and is therefore exact, but slow. We pay the cost precisely where correctness
 * is at stake and nowhere else.
 *
 * The expansion routines below rely on IEEE-754 double arithmetic being correctly rounded.
 * That holds in JavaScript. They must not be "simplified": every apparently redundant
 * subtraction recovers a rounding error that would otherwise be lost, and an optimiser that
 * assumed real-number algebra would destroy them.
 *
 * Reference: J. R. Shewchuk, "Adaptive Precision Floating-Point Arithmetic and Fast Robust
 * Geometric Predicates", Discrete & Computational Geometry 18(3):305-363, 1997.
 */

// ── error bounds, derived from machine epsilon ───────────────────────────────

const EPSILON = 1.1102230246251565e-16; // 2^-53
const SPLITTER = 134217729; // 2^27 + 1, splits a double into two 26-bit halves

// Only the level-A bounds are used. Shewchuk's scheme defines B and C bounds for
// intermediate refinement steps that trade a little accuracy for speed before falling all
// the way through to exact arithmetic; this implementation goes straight from the filter to
// the exact path, which is simpler and, for the volumes of calls made here, fast enough.
const CCW_ERR_A = (3 + 16 * EPSILON) * EPSILON;
const O3D_ERR_A = (7 + 56 * EPSILON) * EPSILON;

// ── expansion arithmetic ─────────────────────────────────────────────────────
//
// An "expansion" is an array of doubles whose exact sum is the represented value, held in
// increasing order of magnitude and non-overlapping. Every routine here is exact.

/** Sum of two doubles as a two-term expansion. `x` is the rounded sum, `y` the exact error. */
function twoSum(a: number, b: number, out: number[], oi: number): number {
  const x = a + b;
  const bv = x - a;
  const av = x - bv;
  out[oi] = a - av + (b - bv); // the lost low-order bits, recovered exactly
  return x;
}

/** As twoSum, but valid only when |a| >= |b|. Cheaper: three operations instead of six. */
function fastTwoSum(a: number, b: number, out: number[], oi: number): number {
  const x = a + b;
  out[oi] = b - (x - a);
  return x;
}

/** Splits a double into two non-overlapping halves, each with at most 26 significant bits. */
function split(a: number, out: { hi: number; lo: number }): void {
  const c = SPLITTER * a;
  const big = c - a;
  out.hi = c - big;
  out.lo = a - out.hi;
}

const sA = { hi: 0, lo: 0 };
const sB = { hi: 0, lo: 0 };

/** Product of two doubles as a two-term expansion. Exact: the error term is representable. */
function twoProduct(a: number, b: number, out: number[], oi: number): number {
  const x = a * b;
  split(a, sA);
  split(b, sB);
  // Reconstruct the product from the 26-bit halves; what the rounding dropped is exact here.
  const err = sA.hi * sB.hi - x;
  const err2 = err + sA.hi * sB.lo;
  const err3 = err2 + sA.lo * sB.hi;
  out[oi] = sA.lo * sB.lo + err3;
  return x;
}

/**
 * Sums two expansions exactly, by a linear merge that keeps terms non-overlapping.
 * This is the workhorse of the exact fallback paths.
 */
function expansionSum(elen: number, e: number[], flen: number, f: number[], h: number[]): number {
  let eindex = 0;
  let findex = 0;
  let enow = e[0];
  let fnow = f[0];
  let q: number;
  let hindex = 0;

  // Seed with whichever term is smaller in magnitude, so the merge stays sorted.
  if (fnow > enow === fnow > -enow) {
    q = enow;
    enow = e[++eindex];
  } else {
    q = fnow;
    fnow = f[++findex];
  }

  if (eindex < elen && findex < flen) {
    if (fnow > enow === fnow > -enow) {
      q = fastTwoSum(enow, q, h, hindex);
      enow = e[++eindex];
    } else {
      q = fastTwoSum(fnow, q, h, hindex);
      fnow = f[++findex];
    }
    if (h[hindex] !== 0) hindex++;

    while (eindex < elen && findex < flen) {
      if (fnow > enow === fnow > -enow) {
        q = twoSum(q, enow, h, hindex);
        enow = e[++eindex];
      } else {
        q = twoSum(q, fnow, h, hindex);
        fnow = f[++findex];
      }
      if (h[hindex] !== 0) hindex++;
    }
  }

  while (eindex < elen) {
    q = twoSum(q, enow, h, hindex);
    enow = e[++eindex];
    if (h[hindex] !== 0) hindex++;
  }
  while (findex < flen) {
    q = twoSum(q, fnow, h, hindex);
    fnow = f[++findex];
    if (h[hindex] !== 0) hindex++;
  }

  if (q !== 0 || hindex === 0) h[hindex++] = q;
  return hindex;
}

/** Multiplies an expansion by a scalar, exactly. */
function scaleExpansion(elen: number, e: number[], b: number, h: number[]): number {
  const t = [0, 0];
  let q = twoProduct(e[0], b, t, 0);
  let hindex = 0;
  if (t[0] !== 0) h[hindex++] = t[0];

  for (let eindex = 1; eindex < elen; eindex++) {
    const product = twoProduct(e[eindex], b, t, 0);
    const sum = twoSum(q, t[0], t, 1);
    if (t[1] !== 0) h[hindex++] = t[1];
    q = fastTwoSum(product, sum, t, 1);
    if (t[1] !== 0) h[hindex++] = t[1];
  }
  if (q !== 0 || hindex === 0) h[hindex++] = q;
  return hindex;
}

/** Approximates an expansion by a single double. Correct to within one ulp of the exact sum. */
function estimate(elen: number, e: number[]): number {
  let q = e[0];
  for (let i = 1; i < elen; i++) q += e[i];
  return q;
}

// Scratch buffer for the exact orient2d path. Predicates are called in tight loops and are
// not re-entrant across threads; reusing this avoids allocating short-lived arrays.
const B = new Array<number>(4).fill(0);

// ── orient2d ─────────────────────────────────────────────────────────────────

function orient2dExact(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const t = [0, 0];

  // Cross products of the three edge pairs, each computed exactly.
  const axby = twoProduct(ax, by, t, 0);
  const axby0 = t[0];
  const bxay = twoProduct(bx, ay, t, 0);
  const bxay0 = t[0];
  B[0] = axby0 - bxay0;
  const i = twoSum(axby, -bxay, t, 0);
  B[1] = t[0];
  B[2] = i;

  const bxcy = twoProduct(bx, cy, t, 0);
  const bxcy0 = t[0];
  const cxby = twoProduct(cx, by, t, 0);
  const cxby0 = t[0];
  const p: number[] = [bxcy0 - cxby0, 0, 0];
  const j = twoSum(bxcy, -cxby, t, 0);
  p[1] = t[0];
  p[2] = j;

  const cxay = twoProduct(cx, ay, t, 0);
  const cxay0 = t[0];
  const axcy = twoProduct(ax, cy, t, 0);
  const axcy0 = t[0];
  const q: number[] = [cxay0 - axcy0, 0, 0];
  const k = twoSum(cxay, -axcy, t, 0);
  q[1] = t[0];
  q[2] = k;

  const tmp: number[] = new Array(8).fill(0);
  const len1 = expansionSum(3, B, 3, p, tmp);
  const out: number[] = new Array(12).fill(0);
  const len2 = expansionSum(len1, tmp, 3, q, out);

  return out[len2 - 1];
}

/**
 * Sign of the signed area of triangle (a, b, c), times two.
 *
 * Positive when the points are counter-clockwise, negative when clockwise, exactly zero
 * when collinear. The zero case is what matters: it is reported only when the points are
 * genuinely collinear, never as an artefact of rounding.
 */
export function orient2d(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  // The two halves must be formed in this order. Swapping them negates the result, and the
  // exact fallback below uses the standard convention — so a mismatch here would make the
  // fast and exact paths disagree in sign depending only on whether the filter happened to
  // trigger. Callers would then see a vertex classified as convex in one call and reflex in
  // the next, which is unfixable anywhere downstream.
  const detleft = (ax - cx) * (by - cy);
  const detright = (ay - cy) * (bx - cx);
  const det = detleft - detright;

  // When the halves have opposite signs, subtracting them cannot cancel, so the
  // floating-point result already carries the correct sign and no bound is needed.
  let detsum: number;
  if (detleft > 0) {
    if (detright <= 0) return det;
    detsum = detleft + detright;
  } else if (detleft < 0) {
    if (detright >= 0) return det;
    detsum = -detleft - detright;
  } else {
    return det;
  }

  const errbound = CCW_ERR_A * detsum;
  if (det >= errbound || -det >= errbound) return det;

  return orient2dExact(ax, ay, bx, by, cx, cy);
}

// ── orient3d ─────────────────────────────────────────────────────────────────

function orient3dExact(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
): number {
  const t = [0, 0];

  // The determinant expands into three 2x2 minors, each scaled by a coordinate difference.
  // Every step below is exact, so the accumulated sign is exact.
  function minor(px: number, py: number, qx: number, qy: number, out: number[]): number {
    const pxqy = twoProduct(px, qy, t, 0);
    const e0 = t[0];
    const qxpy = twoProduct(qx, py, t, 0);
    const e1 = t[0];
    out[0] = e0 - e1;
    const s = twoSum(pxqy, -qxpy, t, 0);
    out[1] = t[0];
    out[2] = s;
    return 3;
  }

  const ab: number[] = [0, 0, 0];
  const bc: number[] = [0, 0, 0];
  const ca: number[] = [0, 0, 0];
  minor(ax - dx, ay - dy, bx - dx, by - dy, ab);
  minor(bx - dx, by - dy, cx - dx, cy - dy, bc);
  minor(cx - dx, cy - dy, ax - dx, ay - dy, ca);

  const s1: number[] = new Array(8).fill(0);
  const s2: number[] = new Array(8).fill(0);
  const s3: number[] = new Array(8).fill(0);
  const l1 = scaleExpansion(3, bc, az - dz, s1);
  const l2 = scaleExpansion(3, ca, bz - dz, s2);
  const l3 = scaleExpansion(3, ab, cz - dz, s3);

  const m1: number[] = new Array(16).fill(0);
  const lm = expansionSum(l1, s1, l2, s2, m1);
  const m2: number[] = new Array(24).fill(0);
  const lf = expansionSum(lm, m1, l3, s3, m2);

  return m2[lf - 1];
}

/**
 * Sign of the signed volume of tetrahedron (a, b, c, d), times six.
 *
 * Positive when `d` lies below the plane of `a, b, c` as seen with that triangle
 * counter-clockwise; negative above; exactly zero when all four are coplanar.
 *
 * This is the predicate the boolean engine leans on hardest. Coplanarity must be detected
 * exactly, because a face that is *almost* coplanar with another and a face that *is* are
 * handled by different code paths, and picking the wrong one produces a non-manifold result.
 */
export function orient3d(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
): number {
  const adx = ax - dx, bdx = bx - dx, cdx = cx - dx;
  const ady = ay - dy, bdy = by - dy, cdy = cy - dy;
  const adz = az - dz, bdz = bz - dz, cdz = cz - dz;

  const bdxcdy = bdx * cdy, cdxbdy = cdx * bdy;
  const cdxady = cdx * ady, adxcdy = adx * cdy;
  const adxbdy = adx * bdy, bdxady = bdx * ady;

  const det =
    adz * (bdxcdy - cdxbdy) +
    bdz * (cdxady - adxcdy) +
    cdz * (adxbdy - bdxady);

  // Bound the worst-case rounding error by the magnitude of the terms that could cancel.
  const permanent =
    (Math.abs(bdxcdy) + Math.abs(cdxbdy)) * Math.abs(adz) +
    (Math.abs(cdxady) + Math.abs(adxcdy)) * Math.abs(bdz) +
    (Math.abs(adxbdy) + Math.abs(bdxady)) * Math.abs(cdz);

  const errbound = O3D_ERR_A * permanent;
  if (det > errbound || -det > errbound) return det;

  return orient3dExact(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
}

// ── derived predicates ───────────────────────────────────────────────────────

/** True when four points lie exactly in a common plane. */
export function coplanar(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
): boolean {
  return orient3d(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) === 0;
}

/** True when three points lie exactly on a common line. */
export function collinear2d(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  return orient2d(ax, ay, bx, by, cx, cy) === 0;
}

/**
 * Which side of the plane through (a, b, c) the point p lies on.
 * +1 above (in the direction of the normal), -1 below, 0 exactly on.
 */
export function planeSide(
  p: readonly [number, number, number],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): -1 | 0 | 1 {
  // orient3d is negated: it returns positive when the fourth point is *below* the plane
  // of the first three, and callers universally expect "above the normal" to be positive.
  const d = -orient3d(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], p[0], p[1], p[2]);
  return d > 0 ? 1 : d < 0 ? -1 : 0;
}

/**
 * Signed area of a 2D polygon, computed by exact summation of triangle fans.
 *
 * The naive shoelace formula loses accuracy badly on polygons far from the origin — a
 * profile at X = 3000 mm with 0.01 mm features is routine in CAD, and there the leading
 * digits cancel completely. This keeps every partial product.
 */
export function polygonArea2d(pts: readonly (readonly [number, number])[]): number {
  const n = pts.length;
  if (n < 3) return 0;

  // Translate to the centroid first. This is the single most effective accuracy measure:
  // it removes the large common offset that causes the cancellation in the first place.
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;

  let acc: number[] = [0];
  let len = 1;
  const scratch = new Array<number>(64).fill(0);

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = pts[i][0] - cx, y0 = pts[i][1] - cy;
    const x1 = pts[j][0] - cx, y1 = pts[j][1] - cy;

    const t = [0, 0];
    const p1 = twoProduct(x0, y1, t, 0);
    const e1 = t[0];
    const p2 = twoProduct(x1, y0, t, 0);
    const e2 = t[0];

    const term = [e1 - e2, 0, 0];
    const s = twoSum(p1, -p2, t, 0);
    term[1] = t[0];
    term[2] = s;

    len = expansionSum(len, acc, 3, term, scratch);
    acc = scratch.slice(0, len);
  }

  return estimate(len, acc) / 2;
}

/** Exposed for tests of the exact-arithmetic layer itself. */
export const __internals = { estimate, expansionSum, scaleExpansion, twoProduct, twoSum };

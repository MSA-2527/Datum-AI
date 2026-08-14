/**
 * Dense linear algebra: LU, QR, SVD and least squares.
 *
 * This exists because the constraint solver and the curve fitters need to solve systems
 * that are routinely rank-deficient, and the textbook answer — form the normal equations
 * and invert — is the wrong one. Normal equations square the condition number, so a sketch
 * that is merely awkward becomes numerically unsolvable. Every solve here goes through an
 * orthogonal factorisation instead.
 *
 * Matrices are row-major Float64Array with explicit dimensions. Row-major keeps a matrix
 * row contiguous, and every hot loop below walks along rows.
 */

export interface Matrix {
  rows: number;
  cols: number;
  data: Float64Array;
}

export function mat(rows: number, cols: number, fill = 0): Matrix {
  const data = new Float64Array(rows * cols);
  if (fill !== 0) data.fill(fill);
  return { rows, cols, data };
}

export function matFrom(rows: number, cols: number, values: number[]): Matrix {
  if (values.length !== rows * cols) {
    throw new Error(`matFrom: expected ${rows * cols} values, received ${values.length}`);
  }
  return { rows, cols, data: Float64Array.from(values) };
}

export const at = (m: Matrix, r: number, c: number): number => m.data[r * m.cols + c];
export const set = (m: Matrix, r: number, c: number, v: number): void => { m.data[r * m.cols + c] = v; };
export const addAt = (m: Matrix, r: number, c: number, v: number): void => { m.data[r * m.cols + c] += v; };

export function identity(n: number): Matrix {
  const m = mat(n, n);
  for (let i = 0; i < n; i++) m.data[i * n + i] = 1;
  return m;
}

export function matVec(m: Matrix, x: Float64Array | number[]): Float64Array {
  const out = new Float64Array(m.rows);
  for (let r = 0; r < m.rows; r++) {
    let s = 0;
    const base = r * m.cols;
    for (let c = 0; c < m.cols; c++) s += m.data[base + c] * x[c];
    out[r] = s;
  }
  return out;
}

/** A^T * x. Kept separate rather than transposing, which would copy the whole matrix. */
export function matTVec(m: Matrix, x: Float64Array | number[]): Float64Array {
  const out = new Float64Array(m.cols);
  for (let r = 0; r < m.rows; r++) {
    const xr = x[r];
    if (xr === 0) continue;
    const base = r * m.cols;
    for (let c = 0; c < m.cols; c++) out[c] += m.data[base + c] * xr;
  }
  return out;
}

export function transpose(m: Matrix): Matrix {
  const o = mat(m.cols, m.rows);
  for (let r = 0; r < m.rows; r++) {
    for (let c = 0; c < m.cols; c++) o.data[c * m.rows + r] = m.data[r * m.cols + c];
  }
  return o;
}

export function matMul(a: Matrix, b: Matrix): Matrix {
  if (a.cols !== b.rows) throw new Error(`matMul: ${a.rows}x${a.cols} times ${b.rows}x${b.cols}`);
  const o = mat(a.rows, b.cols);
  for (let i = 0; i < a.rows; i++) {
    for (let k = 0; k < a.cols; k++) {
      const aik = a.data[i * a.cols + k];
      if (aik === 0) continue;
      const brow = k * b.cols;
      const orow = i * b.cols;
      for (let j = 0; j < b.cols; j++) o.data[orow + j] += aik * b.data[brow + j];
    }
  }
  return o;
}

export const norm = (x: Float64Array | number[]): number => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s);
};

export const normInf = (x: Float64Array | number[]): number => {
  let s = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > s) s = a; }
  return s;
};

// ── LU with partial pivoting ─────────────────────────────────────────────────

export interface LU {
  lu: Matrix;
  piv: Int32Array;
  sign: number;
  singular: boolean;
}

/**
 * LU decomposition with partial pivoting, in place.
 *
 * Pivoting is not optional. Without it a zero on the diagonal — which happens whenever a
 * sketch has a horizontal line, i.e. constantly — divides by zero on the first step.
 */
export function luDecompose(a: Matrix): LU {
  if (a.rows !== a.cols) throw new Error('luDecompose: matrix must be square');
  const n = a.rows;
  const lu = { rows: n, cols: n, data: Float64Array.from(a.data) };
  const piv = new Int32Array(n);
  for (let i = 0; i < n; i++) piv[i] = i;
  let sign = 1;
  let singular = false;

  for (let k = 0; k < n; k++) {
    let p = k;
    let maxv = Math.abs(lu.data[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(lu.data[i * n + k]);
      if (v > maxv) { maxv = v; p = i; }
    }

    if (maxv < 1e-300) { singular = true; continue; }

    if (p !== k) {
      for (let c = 0; c < n; c++) {
        const t = lu.data[k * n + c];
        lu.data[k * n + c] = lu.data[p * n + c];
        lu.data[p * n + c] = t;
      }
      const t = piv[k]; piv[k] = piv[p]; piv[p] = t;
      sign = -sign;
    }

    const pivot = lu.data[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const f = (lu.data[i * n + k] /= pivot);
      if (f === 0) continue;
      for (let c = k + 1; c < n; c++) lu.data[i * n + c] -= f * lu.data[k * n + c];
    }
  }

  return { lu, piv, sign, singular };
}

export function luSolve(f: LU, b: Float64Array | number[]): Float64Array | null {
  if (f.singular) return null;
  const n = f.lu.rows;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = b[f.piv[i]];

  for (let i = 1; i < n; i++) {
    let s = x[i];
    for (let j = 0; j < i; j++) s -= f.lu.data[i * n + j] * x[j];
    x[i] = s;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let j = i + 1; j < n; j++) s -= f.lu.data[i * n + j] * x[j];
    x[i] = s / f.lu.data[i * n + i];
  }
  return x;
}

export function determinant(a: Matrix): number {
  const f = luDecompose(a);
  if (f.singular) return 0;
  let d = f.sign;
  for (let i = 0; i < a.rows; i++) d *= f.lu.data[i * a.rows + i];
  return d;
}

export function invert(a: Matrix): Matrix | null {
  const f = luDecompose(a);
  if (f.singular) return null;
  const n = a.rows;
  const inv = mat(n, n);
  const e = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    e.fill(0); e[c] = 1;
    const col = luSolve(f, e);
    if (!col) return null;
    for (let r = 0; r < n; r++) inv.data[r * n + c] = col[r];
  }
  return inv;
}

// ── Householder QR ───────────────────────────────────────────────────────────

export interface QR {
  qr: Matrix;
  rdiag: Float64Array;
  rankDeficient: boolean;
}

/**
 * Householder QR of an m x n matrix, m >= n.
 *
 * Householder reflections rather than Gram-Schmidt: Gram-Schmidt loses orthogonality
 * catastrophically on nearly dependent columns, which is exactly the state of a sketch
 * one constraint away from over-defined — the case the solver most needs to diagnose
 * correctly rather than crash on.
 */
export function qrDecompose(a: Matrix): QR {
  const m = a.rows, n = a.cols;
  const qr = { rows: m, cols: n, data: Float64Array.from(a.data) };
  const rdiag = new Float64Array(n);
  let rankDeficient = false;

  for (let k = 0; k < Math.min(m, n); k++) {
    let nrm = 0;
    for (let i = k; i < m; i++) nrm = Math.hypot(nrm, qr.data[i * n + k]);

    if (nrm === 0) { rdiag[k] = 0; rankDeficient = true; continue; }

    // Choose the sign that avoids cancellation when forming the reflector.
    if (qr.data[k * n + k] < 0) nrm = -nrm;
    for (let i = k; i < m; i++) qr.data[i * n + k] /= nrm;
    qr.data[k * n + k] += 1;

    for (let j = k + 1; j < n; j++) {
      let s = 0;
      for (let i = k; i < m; i++) s += qr.data[i * n + k] * qr.data[i * n + j];
      s = -s / qr.data[k * n + k];
      for (let i = k; i < m; i++) qr.data[i * n + j] += s * qr.data[i * n + k];
    }
    rdiag[k] = -nrm;
  }

  return { qr, rdiag, rankDeficient };
}

/** Least-squares solve of A x = b via QR. Returns null when A is rank deficient. */
export function qrSolve(f: QR, b: Float64Array | number[]): Float64Array | null {
  const m = f.qr.rows, n = f.qr.cols;
  for (let j = 0; j < n; j++) if (f.rdiag[j] === 0) return null;

  const y = Float64Array.from(b);

  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = k; i < m; i++) s += f.qr.data[i * n + k] * y[i];
    s = -s / f.qr.data[k * n + k];
    for (let i = k; i < m; i++) y[i] += s * f.qr.data[i * n + k];
  }

  const x = new Float64Array(n);
  for (let k = n - 1; k >= 0; k--) {
    let s = y[k];
    for (let j = k + 1; j < n; j++) s -= f.qr.data[k * n + j] * x[j];
    x[k] = s / f.rdiag[k];
  }
  return x;
}

// ── Jacobi SVD ───────────────────────────────────────────────────────────────

export interface SVD {
  /** Singular values, descending. */
  s: Float64Array;
  /** Right singular vectors, as columns of an n x n matrix. */
  v: Matrix;
  /** Left singular vectors scaled by s, as columns of an m x n matrix. */
  u: Matrix;
}

/**
 * One-sided Jacobi SVD.
 *
 * Slower than bidiagonalisation, but it computes small singular values to high *relative*
 * accuracy, and small singular values are the entire point here — they are how the solver
 * detects that a sketch is one redundant constraint away from singular. A method that
 * reports 1e-16 as "roughly zero, could be anything" cannot tell a redundant constraint
 * from a conflicting one, and those need opposite messages to the user.
 */
export function svd(input: Matrix, maxSweeps = 60): SVD {
  // One-sided Jacobi orthogonalises the *columns*, which requires at least as many rows as
  // columns. A wide matrix is the normal case for an under-constrained sketch — more
  // degrees of freedom than constraints — so it has to be handled, not rejected. Padding
  // with zero rows changes neither the singular values nor V, and the extra rows of U are
  // simply unused.
  const a = input.rows >= input.cols
    ? input
    : (() => {
        const p = mat(input.cols, input.cols);
        p.data.set(input.data, 0);
        return p;
      })();

  const m = a.rows, n = a.cols;
  const u = { rows: m, cols: n, data: Float64Array.from(a.data) };
  const v = identity(n);
  const tol = 1e-14;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        let alpha = 0, beta = 0, gamma = 0;
        for (let i = 0; i < m; i++) {
          const up = u.data[i * n + p], uq = u.data[i * n + q];
          alpha += up * up;
          beta += uq * uq;
          gamma += up * uq;
        }
        if (Math.abs(gamma) < tol * Math.sqrt(alpha * beta) || gamma === 0) continue;
        off += gamma * gamma;

        // Rotate columns p and q so they become orthogonal.
        // When the two columns have equal norm, zeta is exactly zero and Math.sign(0) is 0
        // — which would make the rotation angle zero, so the sweep would spin forever
        // without ever orthogonalising anything. Equal norms are the *most* symmetric case
        // and need a full 45-degree rotation, so the sign defaults to +1.
        const zeta = (beta - alpha) / (2 * gamma);
        const t = (Math.sign(zeta) || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = c * t;

        for (let i = 0; i < m; i++) {
          const up = u.data[i * n + p], uq = u.data[i * n + q];
          u.data[i * n + p] = c * up - s * uq;
          u.data[i * n + q] = s * up + c * uq;
        }
        for (let i = 0; i < n; i++) {
          const vp = v.data[i * n + p], vq = v.data[i * n + q];
          v.data[i * n + p] = c * vp - s * vq;
          v.data[i * n + q] = s * vp + c * vq;
        }
      }
    }
    if (off < tol) break;
  }

  const s = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let i = 0; i < m; i++) sum += u.data[i * n + j] ** 2;
    s[j] = Math.sqrt(sum);
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => s[y] - s[x]);
  const sS = new Float64Array(n);
  const uS = mat(m, n);
  const vS = mat(n, n);
  for (let j = 0; j < n; j++) {
    const src = order[j];
    sS[j] = s[src];
    for (let i = 0; i < m; i++) uS.data[i * n + j] = u.data[i * n + src];
    for (let i = 0; i < n; i++) vS.data[i * n + j] = v.data[i * n + src];
  }

  return { s: sS, u: uS, v: vS };
}

/** Numerical rank: singular values above a relative threshold. */
export function rank(a: Matrix, relTol = 1e-10): number {
  const { s } = svd(a);
  if (s.length === 0 || s[0] === 0) return 0;
  const cut = s[0] * relTol;
  let r = 0;
  for (let i = 0; i < s.length; i++) if (s[i] > cut) r++;
  return r;
}

/** Ratio of largest to smallest singular value. Infinite when singular. */
export function conditionNumber(a: Matrix): number {
  const { s } = svd(a);
  const last = s[s.length - 1];
  return last <= 0 ? Infinity : s[0] / last;
}

/**
 * Minimum-norm least-squares solution via the pseudo-inverse.
 *
 * This is what makes an under-defined sketch behave sanely. With fewer constraints than
 * degrees of freedom there are infinitely many solutions, and the minimum-norm one is the
 * one that moves the geometry least from where the user put it. Any other choice makes the
 * sketch jump around when a constraint is added, which users experience as the solver
 * fighting them.
 */
export function pseudoInverseSolve(a: Matrix, b: Float64Array | number[], relTol = 1e-10): Float64Array {
  const { s, u, v } = svd(a);
  const n = a.cols;
  const cut = s.length > 0 && s[0] > 0 ? s[0] * relTol : 0;

  // U here has unit-norm columns only after dividing by s, so fold that in.
  const utb = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    if (s[j] <= cut) continue;
    let dot = 0;
    for (let i = 0; i < a.rows; i++) dot += (u.data[i * n + j] / s[j]) * b[i];
    utb[j] = dot / s[j];
  }

  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += v.data[i * n + j] * utb[j];
    x[i] = sum;
  }
  return x;
}

/**
 * Solves (A^T A + lambda I) x = A^T b — the Levenberg-Marquardt step.
 *
 * Damping is what keeps Newton from diverging when it starts far from a solution, which
 * for a sketch means the moment a user drags a point across the geometry. Cholesky is
 * safe here because the damped normal matrix is positive definite by construction, whatever
 * the rank of A.
 */
export function dampedNormalSolve(
  a: Matrix,
  b: Float64Array | number[],
  lambda: number,
): Float64Array | null {
  const n = a.cols;
  const ata = mat(n, n);
  for (let r = 0; r < a.rows; r++) {
    const base = r * a.cols;
    for (let i = 0; i < n; i++) {
      const ai = a.data[base + i];
      if (ai === 0) continue;
      for (let j = i; j < n; j++) ata.data[i * n + j] += ai * a.data[base + j];
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) ata.data[i * n + j] = ata.data[j * n + i];
    ata.data[i * n + i] += lambda;
  }

  const atb = matTVec(a, b);
  return choleskySolve(ata, atb);
}

/** Cholesky solve for symmetric positive-definite A. Returns null when not positive definite. */
export function choleskySolve(a: Matrix, b: Float64Array | number[]): Float64Array | null {
  const n = a.rows;
  const l = mat(n, n);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a.data[i * n + j];
      for (let k = 0; k < j; k++) s -= l.data[i * n + k] * l.data[j * n + k];
      if (i === j) {
        if (s <= 0) return null;
        l.data[i * n + j] = Math.sqrt(s);
      } else {
        l.data[i * n + j] = s / l.data[j * n + j];
      }
    }
  }

  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= l.data[i * n + k] * y[k];
    y[i] = s / l.data[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= l.data[k * n + i] * x[k];
    x[i] = s / l.data[i * n + i];
  }
  return x;
}

/**
 * Null space basis of A, as columns.
 *
 * The dimension of this space is the sketch's remaining degrees of freedom, and the vectors
 * themselves say *which* motions are still free — that is what lets the UI show a user
 * exactly what is under-defined instead of just telling them a number.
 */
export function nullSpace(a: Matrix, relTol = 1e-10): Matrix {
  const { s, v } = svd(a);
  const n = a.cols;
  const cut = s.length > 0 && s[0] > 0 ? s[0] * relTol : 0;

  const cols: number[] = [];
  for (let j = 0; j < n; j++) if (s[j] <= cut) cols.push(j);

  const out = mat(n, cols.length);
  for (let c = 0; c < cols.length; c++) {
    for (let r = 0; r < n; r++) out.data[r * cols.length + c] = v.data[r * n + cols[c]];
  }
  return out;
}

// ── polynomial roots ─────────────────────────────────────────────────────────

/** Real roots of a x^2 + b x + c, using the cancellation-free quadratic formula. */
export function quadraticRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-14) return Math.abs(b) < 1e-14 ? [] : [-c / b];
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  if (disc === 0) return [-b / (2 * a)];
  // Computing both roots as (-b +/- sqrt)/2a loses precision in whichever numerator
  // cancels; forming one root from the product of the roots avoids it.
  const q = -0.5 * (b + Math.sign(b || 1) * Math.sqrt(disc));
  return [q / a, c / q].sort((x, y) => x - y);
}

/** Real roots of a cubic, via the trigonometric solution for three real roots. */
export function cubicRoots(a: number, b: number, c: number, d: number): number[] {
  if (Math.abs(a) < 1e-14) return quadraticRoots(b, c, d);
  b /= a; c /= a; d /= a;

  const p = c - (b * b) / 3;
  const q = (2 * b * b * b) / 27 - (b * c) / 3 + d;
  const shift = -b / 3;
  const disc = (q * q) / 4 + (p * p * p) / 27;

  if (Math.abs(disc) < 1e-14) {
    if (Math.abs(q) < 1e-14) return [shift];
    const u = Math.cbrt(-q / 2);
    return [2 * u + shift, -u + shift].sort((x, y) => x - y);
  }
  if (disc > 0) {
    const s = Math.sqrt(disc);
    return [Math.cbrt(-q / 2 + s) + Math.cbrt(-q / 2 - s) + shift];
  }
  const r = Math.sqrt(-(p * p * p) / 27);
  const phi = Math.acos(Math.min(1, Math.max(-1, -q / (2 * r))));
  const t = 2 * Math.cbrt(r);
  return [
    t * Math.cos(phi / 3) + shift,
    t * Math.cos((phi + 2 * Math.PI) / 3) + shift,
    t * Math.cos((phi + 4 * Math.PI) / 3) + shift,
  ].sort((x, y) => x - y);
}

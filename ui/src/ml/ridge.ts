/**
 * Ridge regression, solved in closed form.
 *
 * The learning this application can honestly do. There is no GPU here, no server, and a corpus
 * measured in dozens of parts rather than millions — so the useful model is a small one that
 * trains in milliseconds on the user's own library, ships as a few hundred numbers, and gets
 * better every time they save a part.
 *
 * Ridge rather than ordinary least squares because with a few dozen examples and a few hundred
 * features the system is hopelessly underdetermined: XᵀX is singular, ordinary least squares
 * has infinitely many exact solutions, and every one of them memorises the training set. The
 * λI term makes the matrix invertible and, more to the point, makes the answer the smallest
 * set of weights that explains the data rather than an arbitrary one.
 *
 * Closed form rather than gradient descent because for this size it is both faster and exact:
 * no learning rate, no epochs, no run that comes out differently the second time.
 */

/**
 * Cholesky decomposition of a symmetric positive-definite matrix, in place.
 *
 * `A = LLᵀ`. Chosen over LU because XᵀX + λI is symmetric positive definite by construction —
 * for λ > 0 — so half the arithmetic is redundant, and because Cholesky *fails* rather than
 * quietly producing nonsense when the matrix is not what it was promised to be. That failure
 * is a useful signal: it means λ was too small for the data.
 */
export function cholesky(a: number[][]): number[][] | null {
  const n = a.length;
  const l: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i]![j]!;
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!;

      if (i === j) {
        // A non-positive pivot means the matrix is not positive definite. Taking the square
        // root anyway gives NaN, which then spreads silently through every later weight.
        if (!(sum > 0)) return null;
        l[i]![j] = Math.sqrt(sum);
      } else {
        l[i]![j] = sum / l[j]![j]!;
      }
    }
  }

  return l;
}

/** Solves `LLᵀx = b` by forward then back substitution. */
export function solveCholesky(l: number[][], b: number[]): number[] {
  const n = l.length;
  const y = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    let sum = b[i]!;
    for (let k = 0; k < i; k++) sum -= l[i]![k]! * y[k]!;
    y[i] = sum / l[i]![i]!;
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]!;
    for (let k = i + 1; k < n; k++) sum -= l[k]![i]! * x[k]!;
    x[i] = sum / l[i]![i]!;
  }

  return x;
}

export interface RidgeModel {
  /** One weight per feature. */
  weights: number[];
  /** Fitted separately and never penalised — see `fitRidge`. */
  intercept: number;
}

/**
 * Fits `y ≈ Xw + b` minimising `‖Xw + b − y‖² + λ‖w‖²`.
 *
 * The intercept is fitted by centring rather than by adding a column of ones, because a column
 * of ones would be penalised along with everything else. Shrinking the intercept towards zero
 * shrinks the *predictions* towards zero, which for a model of log-millimetres means every
 * part quietly gets smaller the more you regularise. Centring keeps the penalty on the shape
 * of the relationship and off its level, which is what ridge is supposed to do.
 */
export function fitRidge(x: number[][], y: number[], lambda: number): RidgeModel | null {
  const rows = x.length;
  if (rows === 0 || y.length !== rows) return null;
  const cols = x[0]!.length;
  if (cols === 0) return null;

  const meanY = y.reduce((s, v) => s + v, 0) / rows;
  const meanX = new Array(cols).fill(0);
  for (const row of x) for (let j = 0; j < cols; j++) meanX[j]! += row[j]! / rows;

  // XᵀX + λI, on the centred data.
  const gram: number[][] = Array.from({ length: cols }, () => new Array(cols).fill(0));
  const xty = new Array(cols).fill(0);

  for (let r = 0; r < rows; r++) {
    const row = x[r]!;
    const dy = y[r]! - meanY;
    for (let i = 0; i < cols; i++) {
      const di = row[i]! - meanX[i]!;
      xty[i]! += di * dy;
      for (let j = 0; j <= i; j++) {
        const v = di * (row[j]! - meanX[j]!);
        gram[i]![j]! += v;
        if (i !== j) gram[j]![i]! += v;
      }
    }
  }

  for (let i = 0; i < cols; i++) gram[i]![i]! += lambda;

  const l = cholesky(gram);
  if (!l) return null;

  const weights = solveCholesky(l, xty);
  if (weights.some((w) => !Number.isFinite(w))) return null;

  let intercept = meanY;
  for (let j = 0; j < cols; j++) intercept -= weights[j]! * meanX[j]!;

  return { weights, intercept };
}

/**
 * The same fit, solved in the dual.
 *
 * Ridge has two equivalent forms, and which one to use is decided by shape rather than by
 * taste. The primal above inverts a `cols x cols` matrix; this inverts a `rows x rows` one,
 * via `w = Xᵀ(XXᵀ + λI)⁻¹y`. They minimise the same objective and give the same weights.
 *
 * It matters here because the interesting regime is a dozen parts and a few hundred text
 * features. A 256x256 Cholesky is about five million operations and a 12x12 one is about six
 * hundred — four orders of magnitude, which is the difference between being able to afford
 * nested cross-validation and not. Being unable to afford it is how a model ends up reporting
 * an error it chose its own hyperparameter to minimise.
 */
export function fitRidgeDual(x: number[][], y: number[], lambda: number): RidgeModel | null {
  const rows = x.length;
  if (rows === 0 || y.length !== rows) return null;
  const cols = x[0]!.length;
  if (cols === 0) return null;

  const meanY = y.reduce((s, v) => s + v, 0) / rows;
  const meanX = new Array(cols).fill(0);
  for (const row of x) for (let j = 0; j < cols; j++) meanX[j]! += row[j]! / rows;

  // Centred rows, held explicitly: every entry of the Gram matrix reads them.
  const c: number[][] = x.map((row) => row.map((v, j) => v - meanX[j]!));

  const k: number[][] = Array.from({ length: rows }, () => new Array(rows).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let t = 0; t < cols; t++) sum += c[i]![t]! * c[j]![t]!;
      k[i]![j] = sum;
      k[j]![i] = sum;
    }
    k[i]![i]! += lambda;
  }

  const l = cholesky(k);
  if (!l) return null;

  const alpha = solveCholesky(l, y.map((v) => v - meanY));
  if (alpha.some((a) => !Number.isFinite(a))) return null;

  const weights = new Array(cols).fill(0);
  for (let i = 0; i < rows; i++) {
    const a = alpha[i]!;
    if (a === 0) continue;
    for (let j = 0; j < cols; j++) weights[j]! += a * c[i]![j]!;
  }

  let intercept = meanY;
  for (let j = 0; j < cols; j++) intercept -= weights[j]! * meanX[j]!;

  return { weights, intercept };
}

/** Whichever form is cheaper for the shape of the data. The answer is the same either way. */
export function fit(x: number[][], y: number[], lambda: number): RidgeModel | null {
  const rows = x.length;
  const cols = rows > 0 ? x[0]!.length : 0;
  return cols > rows ? fitRidgeDual(x, y, lambda) : fitRidge(x, y, lambda);
}

export function predict(model: RidgeModel, features: number[]): number {
  let sum = model.intercept;
  for (let j = 0; j < model.weights.length; j++) sum += model.weights[j]! * (features[j] ?? 0);
  return sum;
}

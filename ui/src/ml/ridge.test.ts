import { describe, expect, it } from 'vitest';
import { cholesky, fit, fitRidge, fitRidgeDual, predict, solveCholesky } from './ridge';

/**
 * The arithmetic underneath the learned model.
 *
 * Tested against relationships whose answer is known in advance, because a regression that is
 * only checked against its own predictions will agree with itself while being wrong. If this
 * is not exact on data that is exactly linear, nothing built on it means anything.
 */

describe('cholesky', () => {
  it('factors a symmetric positive-definite matrix', () => {
    const a = [[4, 2], [2, 3]];
    const l = cholesky(a)!;

    // LLᵀ must reproduce A.
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        let sum = 0;
        for (let k = 0; k < 2; k++) sum += l[i]![k]! * l[j]![k]!;
        expect(sum).toBeCloseTo(a[i]![j]!, 10);
      }
    }
  });

  it('refuses a matrix that is not positive definite instead of returning NaN', () => {
    // Taking the root of a non-positive pivot gives NaN, which then spreads silently through
    // every weight and produces a model that predicts NaN for everything.
    expect(cholesky([[0, 0], [0, 0]])).toBeNull();
    expect(cholesky([[1, 2], [2, 1]])).toBeNull();
  });

  it('solves the system it factored', () => {
    const a = [[4, 2], [2, 3]];
    const l = cholesky(a)!;
    const x = solveCholesky(l, [10, 11]);

    expect(a[0]![0]! * x[0]! + a[0]![1]! * x[1]!).toBeCloseTo(10, 10);
    expect(a[1]![0]! * x[0]! + a[1]![1]! * x[1]!).toBeCloseTo(11, 10);
  });
});

describe('fitting', () => {
  it('recovers an exactly linear relationship when nothing is penalised', () => {
    // y = 3a - 2b + 5.
    const x = [[1, 0], [0, 1], [2, 1], [3, 4], [1, 2]];
    const y = x.map(([a, b]) => 3 * a! - 2 * b! + 5);

    const m = fitRidge(x, y, 1e-9)!;

    expect(m.weights[0]!).toBeCloseTo(3, 5);
    expect(m.weights[1]!).toBeCloseTo(-2, 5);
    expect(m.intercept).toBeCloseTo(5, 5);
  });

  it('does not shrink the intercept towards zero', () => {
    // The intercept is fitted by centring, not by a column of ones. A penalised intercept
    // drags every prediction towards zero — which for a model of log-millimetres means every
    // part quietly gets smaller the harder you regularise.
    const x = [[1], [2], [3], [4]];
    const y = [1000, 1001, 1002, 1003];

    const gentle = fitRidge(x, y, 1e-6)!;
    const heavy = fitRidge(x, y, 1e6)!;

    expect(gentle.intercept).toBeCloseTo(999, 3);
    // The slope is crushed, as it should be, but the level survives.
    expect(Math.abs(heavy.weights[0]!)).toBeLessThan(0.01);
    expect(heavy.intercept).toBeCloseTo(1001.5, 3);
  });

  it('shrinks the weights as the penalty grows', () => {
    const x = [[1, 5], [2, 3], [3, 9], [4, 1], [5, 7]];
    const y = [10, 14, 21, 15, 27];

    const size = (l: number) => {
      const m = fitRidge(x, y, l)!;
      return Math.hypot(...m.weights);
    };

    expect(size(100)).toBeLessThan(size(0.01));
  });

  it('fits when there are more features than examples', () => {
    // The situation this exists for: a handful of parts and a few hundred text features.
    // Ordinary least squares has infinitely many exact solutions here and memorises the data.
    const x = [
      [1, 0, 0, 1, 0], [0, 1, 0, 1, 0], [0, 0, 1, 0, 1],
    ];
    const y = [2, 3, 4];

    const m = fitRidge(x, y, 0.5)!;
    expect(m.weights.every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(m.intercept)).toBe(true);
  });

  it('predicts what it was fitted on', () => {
    const x = [[1, 0], [0, 1], [2, 1], [3, 4]];
    const y = x.map(([a, b]) => 3 * a! - 2 * b! + 5);
    const m = fitRidge(x, y, 1e-9)!;

    for (let i = 0; i < x.length; i++) expect(predict(m, x[i]!)).toBeCloseTo(y[i]!, 5);
  });

  it('treats a missing feature as zero rather than as NaN', () => {
    // Prediction happens on text the model has never seen, so a shorter vector is normal.
    const m = fitRidge([[1, 0], [0, 1], [1, 1]], [1, 2, 3], 0.01)!;
    expect(Number.isFinite(predict(m, [1]))).toBe(true);
  });

  it('says no rather than guessing when there is nothing to fit', () => {
    expect(fitRidge([], [], 1)).toBeNull();
    expect(fitRidge([[]], [1], 1)).toBeNull();
    expect(fitRidge([[1]], [1, 2], 1)).toBeNull();
  });
});

describe('the dual form', () => {
  /** Wide data: more features than examples, which is the regime this exists for. */
  const x = [
    [1, 0, 0, 1, 0, 1], [0, 1, 0, 1, 1, 0], [0, 0, 1, 0, 1, 1], [1, 1, 0, 0, 0, 1],
  ];
  const y = [2, 3, 4, 5];

  it('gives the same answer as the primal', () => {
    // Two ways of minimising one objective. If they disagree, one of them is wrong, and the
    // fast one is the one that would be trusted without being checked.
    for (const lambda of [0.01, 0.5, 10]) {
      const a = fitRidge(x, y, lambda)!;
      const b = fitRidgeDual(x, y, lambda)!;

      expect(b.intercept).toBeCloseTo(a.intercept, 8);
      for (let j = 0; j < a.weights.length; j++) {
        expect(b.weights[j]!).toBeCloseTo(a.weights[j]!, 8);
      }
    }
  });

  it('agrees on tall data too, where the primal is the cheaper one', () => {
    const tall = [[1, 2], [2, 1], [3, 5], [4, 2], [5, 7], [6, 1]];
    const ty = [10, 9, 21, 15, 30, 12];

    const a = fitRidge(tall, ty, 0.3)!;
    const b = fitRidgeDual(tall, ty, 0.3)!;

    expect(b.intercept).toBeCloseTo(a.intercept, 8);
    expect(b.weights[0]!).toBeCloseTo(a.weights[0]!, 8);
  });

  it('is what `fit` picks when the data is wider than it is tall', () => {
    const chosen = fit(x, y, 0.5)!;
    const dual = fitRidgeDual(x, y, 0.5)!;
    expect(chosen.weights).toEqual(dual.weights);
  });

  it('is far faster in the regime it was written for', () => {
    // A dozen parts and a few hundred text features. The primal inverts 256x256 and the dual
    // inverts 12x12 — the difference between affording nested cross-validation and not.
    const wide = Array.from({ length: 12 }, (_, i) =>
      Array.from({ length: 256 }, (_, j) => ((i * 31 + j * 17) % 7 === 0 ? 1 : 0)));
    const wy = wide.map((_, i) => Math.log(10 + i));

    const t0 = performance.now();
    for (let i = 0; i < 20; i++) fitRidgeDual(wide, wy, 0.5);
    const dualMs = performance.now() - t0;

    const t1 = performance.now();
    for (let i = 0; i < 20; i++) fitRidge(wide, wy, 0.5);
    const primalMs = performance.now() - t1;

    expect(dualMs).toBeLessThan(primalMs);
  });
});

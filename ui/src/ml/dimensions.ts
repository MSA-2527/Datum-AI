/**
 * Learning what size a part should be, from the parts you already have.
 *
 * A generator that has never seen your work produces textbook dimensions: a bracket 100 mm
 * long because 100 is a round number. Your library knows better — it knows your plate is 6 mm
 * because that is what you stock, and your bosses are 12 mm because that is the cutter you
 * own. This learns that from the parts you have saved and taught, and from nothing else.
 *
 * Three decisions carry the whole thing:
 *
 * Trained in *log* millimetres. Real parts span four orders of magnitude — a 6 mm dowel and a
 * 37 m airliner sit in the same corpus — and a model fitted on raw millimetres spends all its
 * capacity on the airliner, because that is where the squared error is. In log space the error
 * is proportional, which is also how being wrong about size actually hurts: 20% out matters
 * about the same on a bracket and on a wing.
 *
 * Features are *hashed* text, not a vocabulary. A vocabulary has to be stored, versioned and
 * migrated, and it cannot represent a word it has never seen. Hashing into a fixed width
 * handles a new word on the day it is typed and keeps the model a fixed size forever.
 *
 * It *declines* when it has not learned anything. The dangerous failure of a model this small
 * is not a wrong answer, it is a confident one — so the fit is scored against the simplest
 * thing it could possibly beat, predicting the median of the corpus, and if it cannot beat
 * that it says so and offers no number at all.
 */

import { fit, predict, type RidgeModel } from './ridge';

/** One part the model can learn from: what it was called, and how big it turned out. */
export interface SizedPart {
  text: string;
  /** Bounding box in millimetres, in any axis order — the model sorts them. */
  sizeMm: [number, number, number];
}

export interface SizeModel {
  /** One ridge model per sorted dimension: largest, middle, smallest. */
  axes: [RidgeModel, RidgeModel, RidgeModel];
  /** How many parts it was trained on. */
  examples: number;
  /**
   * Typical proportional error, from cross-validation. 0.2 means predictions land within
   * about 20% of the truth.
   */
  typicalError: number;
  /** The same measure for predicting the corpus median, which is what it has to beat. */
  baselineError: number;
}

export interface SizePrediction {
  /** Largest, middle, smallest, in millimetres. */
  sizeMm: [number, number, number];
  /** Proportional error to expect, from cross-validation on the corpus. */
  typicalError: number;
  examples: number;
}

/**
 * Feature width.
 *
 * A power of two, and wide enough that collisions between the few hundred distinct words a
 * parts library actually uses stay rare.
 */
const WIDTH = 256;

/** Below this there is not enough to learn from, and a fit would be memorisation. */
export const MIN_EXAMPLES = 8;

/**
 * Two gates a model has to pass before its numbers are shown, not one.
 *
 * Beating the baseline was the only test at first, and it was not enough. On a corpus with no
 * relationship in it at all — descriptions that are just distinct words — the model still won
 * by about 9%, because for an unfamiliar word it predicts the mean of the training sizes while
 * the baseline predicts the median, and on ten samples which of those lands closer is a coin
 * flip. It was 190% out and being offered as useful.
 *
 * So it must also be *good in absolute terms*. A size typically 190% out is not a worse
 * version of a useful prediction, it is a number with no information in it, and putting it in
 * a field someone is about to build a part from is worse than leaving the field empty.
 *
 * The two thresholds sit in a wide gap rather than on the edge of one: a corpus with a real
 * relationship in it scores about 30% error and 87% better than the baseline, and the noise
 * corpus scores 190% and 9%. Neither number is tuned to a test.
 */
const MAX_USEFUL_ERROR = 0.5;
const MIN_IMPROVEMENT = 0.25;

/**
 * FNV-1a, folded into the feature width.
 *
 * Any well-mixed hash would do; this one is four lines, has no dependencies, and gives the
 * same answer in every JavaScript engine — a model trained in one browser and read in another
 * has to agree about which bucket a word lands in.
 */
function bucket(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % WIDTH;
}

/** Words, lowercased, digits kept — "m6" and "6061" are among the informative tokens. */
export function tokenise(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/**
 * A description as a feature vector.
 *
 * Term presence rather than count, and normalised to unit length. Counting would let a
 * description that says "plate" three times pull three times as hard as one that says it once,
 * which is a fact about how someone wrote the sentence and not about the part. Normalising
 * stops a long description outweighing a short one for the same reason.
 */
export function featurise(text: string): number[] {
  const v = new Array(WIDTH).fill(0);
  const seen = new Set<string>();

  for (const token of tokenise(text)) {
    if (seen.has(token)) continue;
    seen.add(token);
    v[bucket(token)] = 1;
  }

  const norm = Math.hypot(...v);
  if (norm > 0) for (let i = 0; i < WIDTH; i++) v[i]! /= norm;
  return v;
}

/**
 * Largest to smallest.
 *
 * The model learns proportions, and a part does not care which axis the modeller happened to
 * call X. Two identical brackets saved in different orientations are one lesson, not two
 * contradictory ones.
 */
function sorted(size: [number, number, number]): [number, number, number] {
  const s = [...size].sort((a, b) => b - a);
  return [s[0]!, s[1]!, s[2]!];
}

const usable = (p: SizedPart): boolean =>
  p.text.trim().length > 0 && p.sizeMm.every((v) => Number.isFinite(v) && v > 0);

/** Mean absolute error in log space, read back as a proportion: 0.2 is about 20% out. */
function meanLogError(actual: number[], predicted: number[]): number {
  if (actual.length === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < actual.length; i++) sum += Math.abs(actual[i]! - predicted[i]!);
  return Math.expm1(sum / actual.length);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const LAMBDAS = [0.01, 0.03, 0.1, 0.3, 1, 3, 10];

/**
 * Leave-one-out cross-validation over a small grid of penalties.
 *
 * Leave-one-out rather than k-fold because the corpus is tiny: with twelve parts, holding back
 * three to score on leaves nine to learn from, and the result says more about which three were
 * held back than about the model. Refitting twelve times costs nothing at this size.
 */
function crossValidate(x: number[][], y: number[]): { lambda: number; error: number } {
  let best = { lambda: LAMBDAS[LAMBDAS.length - 1]!, error: Infinity };

  for (const lambda of LAMBDAS) {
    const actual: number[] = [];
    const predicted: number[] = [];

    for (let held = 0; held < x.length; held++) {
      const tx = x.filter((_, i) => i !== held);
      const ty = y.filter((_, i) => i !== held);
      const m = fit(tx, ty, lambda);
      if (!m) continue;

      actual.push(y[held]!);
      predicted.push(predict(m, x[held]!));
    }

    const error = meanLogError(actual, predicted);
    if (error < best.error) best = { lambda, error };
  }

  return best;
}

/**
 * The error to *report*, scored without letting the model choose its own mark.
 *
 * The inner cross-validation picks λ by minimising held-out error. Reporting that same number
 * as the model's accuracy is scoring it on the exam it was allowed to see: with seven penalties
 * to choose from and a dozen examples, the minimum of seven noisy numbers is optimistically
 * biased, and on a corpus with no signal in it at all that bias was enough to beat the median
 * baseline and have the model offered as useful.
 *
 * So λ is re-chosen inside every fold, on that fold's training data alone, and the prediction
 * for the held-out part is made by a model that has never seen it in any capacity. Affordable
 * only because the dual solve made a single fit cost a 12x12 factorisation instead of a
 * 256x256 one.
 */
function nestedError(x: number[][], y: number[]): number {
  const actual: number[] = [];
  const predicted: number[] = [];

  for (let held = 0; held < x.length; held++) {
    const tx = x.filter((_, i) => i !== held);
    const ty = y.filter((_, i) => i !== held);

    const { lambda } = crossValidate(tx, ty);
    const m = fit(tx, ty, lambda);
    if (!m) continue;

    actual.push(y[held]!);
    predicted.push(predict(m, x[held]!));
  }

  return meanLogError(actual, predicted);
}

/** The same measure for the thing the model has to beat: always predicting the median. */
function baselineFor(y: number[]): number {
  const actual: number[] = [];
  const predicted: number[] = [];
  for (let held = 0; held < y.length; held++) {
    actual.push(y[held]!);
    predicted.push(median(y.filter((_, i) => i !== held)));
  }
  return meanLogError(actual, predicted);
}

/**
 * Trains on a corpus, or returns nothing.
 *
 * Returning null rather than a weak model is the point. A size prediction worse than the
 * corpus median is not a lesser version of a good one — it is a confident wrong number in a
 * field the user will not think to check, and the part gets built to it.
 */
export function trainSizeModel(parts: SizedPart[]): SizeModel | null {
  const clean = parts.filter(usable);
  if (clean.length < MIN_EXAMPLES) return null;

  const x = clean.map((p) => featurise(p.text));
  const axes: RidgeModel[] = [];
  let totalError = 0;
  let totalBaseline = 0;

  for (let axis = 0; axis < 3; axis++) {
    const y = clean.map((p) => Math.log(sorted(p.sizeMm)[axis]!));

    // λ for the model that ships is chosen on all the data, which is right — it is the model
    // that will be used. The error *reported* comes from the nested pass, which is the only
    // one that has not seen the part it is being scored on.
    const { lambda } = crossValidate(x, y);
    const model = fit(x, y, lambda);
    if (!model) return null;

    axes.push(model);
    totalError += nestedError(x, y);
    totalBaseline += baselineFor(y);
  }

  const typicalError = totalError / 3;
  const baselineError = totalBaseline / 3;

  // Both gates, and nothing borderline gets through: it must be usefully accurate on its own
  // terms *and* clearly better than the simplest thing it could have done instead.
  const improvement = 1 - typicalError / baselineError;
  if (!(typicalError < MAX_USEFUL_ERROR)) return null;
  if (!(improvement > MIN_IMPROVEMENT)) return null;

  return {
    axes: axes as [RidgeModel, RidgeModel, RidgeModel],
    examples: clean.length,
    typicalError,
    baselineError,
  };
}

/** Predicts the size of a part from its description. */
export function predictSize(model: SizeModel, text: string): SizePrediction {
  const f = featurise(text);
  const raw = model.axes.map((m) => Math.exp(predict(m, f)));

  // Sorted again after exponentiating. The three axes are fitted independently, and nothing
  // stops the middle coming out above the largest on a description none of them recognises —
  // a part whose width exceeds its length. Not wrong by much, but visibly nonsense in a field
  // someone is reading.
  const size = sorted([raw[0]!, raw[1]!, raw[2]!]);

  return { sizeMm: size, typicalError: model.typicalError, examples: model.examples };
}

/** What the model says about itself, for the panel that shows it. */
export function describeModel(model: SizeModel | null): string {
  if (!model) {
    return `Nothing learned from your parts yet. At least ${MIN_EXAMPLES} are needed, and a ` +
      `size is only offered when it lands within ${Math.round(MAX_USEFUL_ERROR * 100)}% and ` +
      'clearly beats simply taking the middle of your library.';
  }

  const improvement = Math.round((1 - model.typicalError / model.baselineError) * 100);
  return `Trained on ${model.examples} of your parts. Sizes land within about ` +
    `${Math.round(model.typicalError * 100)}%, which is ${improvement}% better than ` +
    'guessing the middle of your library.';
}

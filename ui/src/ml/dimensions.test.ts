import { describe, expect, it } from 'vitest';
import {
  MIN_EXAMPLES, describeModel, featurise, predictSize, tokenise, trainSizeModel,
  type SizedPart,
} from './dimensions';

/**
 * The learned size model.
 *
 * What has to be true for this to be worth having, rather than a number generator with a
 * confident tone:
 *
 *   - it learns a relationship that is really in the data;
 *   - it beats the obvious baseline, and knows when it does not;
 *   - it says nothing at all when it has learned nothing.
 *
 * The last is the one that matters most. A wrong size in a field nobody thinks to check is
 * worse than an empty field, because the part gets built to it.
 */

/** A corpus where the words genuinely predict the size: plates are flat, shafts are long. */
function realCorpus(): SizedPart[] {
  const plates: SizedPart[] = [
    { text: 'aluminium mounting plate', sizeMm: [200, 120, 6] },
    { text: 'steel base plate', sizeMm: [180, 140, 8] },
    { text: 'thin cover plate', sizeMm: [220, 110, 4] },
    { text: 'plate with fixing holes', sizeMm: [190, 130, 6] },
    { text: 'backing plate', sizeMm: [210, 125, 5] },
    { text: 'plate bracket blank', sizeMm: [205, 118, 7] },
  ];
  const shafts: SizedPart[] = [
    { text: 'drive shaft', sizeMm: [400, 25, 25] },
    { text: 'stainless shaft', sizeMm: [380, 20, 20] },
    { text: 'long output shaft', sizeMm: [420, 22, 22] },
    { text: 'shaft for pulley', sizeMm: [390, 24, 24] },
    { text: 'shaft blank', sizeMm: [410, 21, 21] },
    { text: 'splined shaft', sizeMm: [395, 26, 26] },
  ];
  return [...plates, ...shafts];
}

describe('turning a description into features', () => {
  it('keeps the digits, because they are the informative part', () => {
    expect(tokenise('M6 washer in 6061')).toEqual(['m6', 'washer', 'in', '6061']);
  });

  it('does not let a repeated word pull harder than a single one', () => {
    // How often someone typed a word is a fact about the sentence, not about the part.
    expect(featurise('plate plate plate')).toEqual(featurise('plate'));
  });

  it('normalises, so a long description does not outweigh a short one', () => {
    const short = Math.hypot(...featurise('plate'));
    const long = Math.hypot(...featurise('a long aluminium mounting plate with fixing holes'));

    expect(short).toBeCloseTo(1, 9);
    expect(long).toBeCloseTo(1, 9);
  });

  it('has room for a word it has never seen', () => {
    // Hashed rather than a vocabulary: a new word works on the day it is typed.
    expect(featurise('unobtainium flange').some((v) => v > 0)).toBe(true);
  });

  it('is empty for text with nothing in it', () => {
    expect(featurise('   ').every((v) => v === 0)).toBe(true);
  });
});

describe('what it learns', () => {
  it('tells a plate from a shaft', () => {
    const model = trainSizeModel(realCorpus())!;
    expect(model).not.toBeNull();

    const plate = predictSize(model, 'aluminium mounting plate');
    const shaft = predictSize(model, 'stainless drive shaft');

    // A plate is wide and thin; a shaft is long and narrow. The model has to have picked up
    // the *proportion*, not just the average size of everything in the library.
    expect(plate.sizeMm[2]!).toBeLessThan(20);
    expect(shaft.sizeMm[0]!).toBeGreaterThan(300);
    expect(shaft.sizeMm[1]! / shaft.sizeMm[0]!).toBeLessThan(0.2);
    expect(plate.sizeMm[1]! / plate.sizeMm[0]!).toBeGreaterThan(0.4);
  });

  it('lands within the error it claims', () => {
    const model = trainSizeModel(realCorpus())!;
    const p = predictSize(model, 'steel base plate');

    // 180 x 140 x 8 in the corpus. Within the model's own stated tolerance, generously.
    const within = (got: number, want: number) => Math.abs(got - want) / want;
    expect(within(p.sizeMm[0]!, 180)).toBeLessThan(0.4);
    expect(within(p.sizeMm[2]!, 8)).toBeLessThan(0.8);
  });

  it('clears both bars it has to clear to be offered at all', () => {
    // Usefully accurate on its own terms, and clearly better than the baseline. Beating the
    // baseline alone is not enough — pure noise manages that by a few percent.
    const model = trainSizeModel(realCorpus())!;

    expect(model.typicalError).toBeLessThan(0.5);
    expect(1 - model.typicalError / model.baselineError).toBeGreaterThan(0.25);
  });

  it('never reports a middle dimension larger than the largest', () => {
    // The three axes are fitted independently, so on an unfamiliar description nothing stops
    // them crossing. A part whose width exceeds its length is visible nonsense.
    const model = trainSizeModel(realCorpus())!;

    for (const text of ['gearbox housing', 'zzz', 'a', 'turbine blade assembly']) {
      const [a, b, c] = predictSize(model, text).sizeMm;
      expect(a).toBeGreaterThanOrEqual(b);
      expect(b).toBeGreaterThanOrEqual(c);
    }
  });

  it('predicts a positive size for a description it has never seen', () => {
    const model = trainSizeModel(realCorpus())!;
    for (const v of predictSize(model, 'something entirely unfamiliar').sizeMm) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });
});

describe('when it should say nothing', () => {
  it('refuses below the minimum corpus', () => {
    const few = realCorpus().slice(0, MIN_EXAMPLES - 1);
    expect(trainSizeModel(few)).toBeNull();
  });

  it('refuses when the words carry no information about the size', () => {
    // Descriptions unrelated to the dimensions: the honest answer is that there is nothing to
    // learn, and a model fitted here would be memorising which noun went with which number.
    const noise: SizedPart[] = [];
    const sizes = [[100, 50, 10], [220, 80, 4], [30, 30, 30], [500, 12, 12],
                   [75, 60, 45], [900, 40, 40], [15, 15, 3], [340, 210, 90],
                   [60, 55, 20], [12, 9, 9]];
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo',
                   'foxtrot', 'golf', 'hotel', 'india', 'juliett'];
    for (let i = 0; i < sizes.length; i++) {
      noise.push({ text: words[i]!, sizeMm: sizes[i] as [number, number, number] });
    }

    // Every description is a distinct word, so the only thing to learn is the training set
    // itself. This corpus scores about 190% error against a 208% baseline — it "beats" the
    // baseline by a few percent purely because an unseen word falls back on the mean while
    // the baseline uses the median, and the model must still decline.
    expect(trainSizeModel(noise)).toBeNull();
  });

  it('ignores parts with no description or an impossible size', () => {
    const corpus = [
      ...realCorpus(),
      { text: '', sizeMm: [10, 10, 10] as [number, number, number] },
      { text: 'broken', sizeMm: [0, 5, 5] as [number, number, number] },
      { text: 'worse', sizeMm: [NaN, 5, 5] as [number, number, number] },
    ];

    const model = trainSizeModel(corpus)!;
    expect(model.examples).toBe(realCorpus().length);
  });

  it('says why it has nothing to offer', () => {
    expect(describeModel(null)).toMatch(/Nothing learned from your parts/);
    expect(describeModel(null)).toContain(String(MIN_EXAMPLES));
  });
});

describe('what it says about itself', () => {
  it('reports the corpus size and how much better it is than the baseline', () => {
    const model = trainSizeModel(realCorpus())!;
    const said = describeModel(model);

    expect(said).toContain('12 of your parts');
    expect(said).toMatch(/within about \d+%/);
    expect(said).toMatch(/\d+% better/);
  });

  it('improves as the corpus grows', () => {
    // The claim the whole thing rests on: it gets better with your data. A model that does not
    // is a lookup table with extra steps.
    const base = realCorpus();
    const more: SizedPart[] = [
      ...base,
      { text: 'machined plate', sizeMm: [195, 122, 6] },
      { text: 'plate for cover', sizeMm: [215, 128, 5] },
      { text: 'ground shaft', sizeMm: [405, 23, 23] },
      { text: 'shaft stub', sizeMm: [385, 25, 25] },
    ];

    const small = trainSizeModel(base)!;
    const large = trainSizeModel(more)!;

    expect(large.examples).toBeGreaterThan(small.examples);
    expect(large.typicalError).toBeLessThanOrEqual(small.typicalError);
  });
});

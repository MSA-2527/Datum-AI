import { describe, expect, it } from 'vitest';
import {
  DEFAULT_K, angleBracket, bendAllowance, bendDeduction, channel, checkSheet, describeFlat,
  flatPattern,
} from './sheetmetal';

/**
 * Sheet metal, checked against figures a fabricator would recognise.
 *
 * The flat pattern is what makes sheet metal its own discipline: the part exists twice, as the
 * folded shape and as the blank a laser cuts, and the two are related by how much the material
 * stretches round each bend. Getting that relation wrong is the commonest and most expensive
 * mistake in the trade — the part comes back the wrong length and the batch is scrap.
 *
 * So most of these test the allowance itself, against hand calculations and against relations
 * that must hold whatever the numbers.
 */

describe('bend allowance', () => {
  it('matches the hand calculation', () => {
    // 90° bend, 2 mm inside radius, 2 mm material, K = 0.44.
    // BA = (π/2) × (2 + 0.44 × 2) = 1.5708 × 2.88 = 4.524 mm.
    expect(bendAllowance(90, 2, 2, 0.44)).toBeCloseTo(4.524, 3);
  });

  it('is the arc length of the neutral axis, so it doubles with the angle', () => {
    const ninety = bendAllowance(90, 3, 1.5, DEFAULT_K);
    const oneEighty = bendAllowance(180, 3, 1.5, DEFAULT_K);

    expect(oneEighty / ninety).toBeCloseTo(2, 6);
  });

  it('grows with the radius, because the arc is longer', () => {
    expect(bendAllowance(90, 6, 2, DEFAULT_K))
      .toBeGreaterThan(bendAllowance(90, 2, 2, DEFAULT_K));
  });

  it('is unaffected by which way the bend goes', () => {
    expect(bendAllowance(-90, 2, 2, DEFAULT_K)).toBeCloseTo(bendAllowance(90, 2, 2, DEFAULT_K), 9);
  });

  it('a higher K factor gives a longer allowance', () => {
    // K is how far through the thickness the neutral axis sits. Further out, longer arc.
    expect(bendAllowance(90, 2, 3, 0.5)).toBeGreaterThan(bendAllowance(90, 2, 3, 0.33));
  });
});

describe('bend deduction', () => {
  it('matches the hand calculation', () => {
    // 90°, r = 2, t = 2, K = 0.44. Setback = (2 + 2) × tan(45°) = 4.
    // BD = 2 × 4 − 4.524 = 3.476 mm.
    expect(bendDeduction(90, 2, 2, 0.44)).toBeCloseTo(3.476, 3);
  });

  it('is the difference between going round the outside and round the neutral axis', () => {
    // Which is why a fabricator working in outside dimensions needs it: the blank is shorter
    // than the dimensions on the drawing add up to.
    const t = 3, r = 3, angle = 90;
    const setback = (r + t) * Math.tan((angle * Math.PI) / 360);

    expect(bendDeduction(angle, r, t, DEFAULT_K))
      .toBeCloseTo(2 * setback - bendAllowance(angle, r, t, DEFAULT_K), 9);
  });
});

describe('the flat pattern', () => {
  it('is the flats plus the allowance for each bend', () => {
    // A 50 + 30 bracket in 2 mm with a 2 mm radius: 50 + 30 + 4.524 = 84.524.
    const pattern = flatPattern(angleBracket(50, 30, 2, 2, 0.44));
    expect(pattern.length).toBeCloseTo(84.524, 3);
  });

  it('puts the bend line where the tooling centres, not at the end of a flat', () => {
    // Half the allowance past the first flat. Nobody can work this out by looking at the
    // folded part, and it is exactly what the press operator marks.
    const pattern = flatPattern(angleBracket(50, 30, 2, 2, 0.44));

    expect(pattern.bendLines).toHaveLength(1);
    expect(pattern.bendLines[0]!.at).toBeCloseTo(50 + 4.524 / 2, 3);
  });

  it('is shorter than the outside dimensions add up to', () => {
    // The whole reason bend deduction exists. A blank cut to the outside dimensions is long.
    const pattern = flatPattern(angleBracket(50, 30, 2, 2, 0.44));

    expect(pattern.length).toBeLessThan(pattern.outsideLength);
    expect(pattern.totalDeduction).toBeCloseTo(3.476, 2);
  });

  it('handles a channel with two bends', () => {
    const pattern = flatPattern(channel(100, 25, 2, 2, 0.44));

    expect(pattern.bendLines).toHaveLength(2);
    expect(pattern.length).toBeCloseTo(25 + 100 + 25 + 2 * 4.524, 3);
  });

  it('places the second bend line past the first bend, not past the first flat', () => {
    // The error that puts every bend after the first in the wrong place: the allowance already
    // consumed has to carry forward.
    const pattern = flatPattern(channel(100, 25, 2, 2, 0.44));
    const [first, second] = pattern.bendLines;

    expect(second!.at - first!.at).toBeCloseTo(100 + 4.524, 3);
  });

  it('a part with no bends is just its own length', () => {
    const pattern = flatPattern({ thickness: 2, kFactor: DEFAULT_K, flats: [120], bends: [] });

    expect(pattern.length).toBe(120);
    expect(pattern.bendLines).toEqual([]);
    expect(pattern.totalDeduction).toBe(0);
  });
});

describe('what a press brake will not do', () => {
  it('refuses a radius tighter than the material takes', () => {
    const problems = checkSheet(angleBracket(50, 30, 3, 0.5), 'steel');

    expect(problems[0]!.problem).toMatch(/tighter than the material/);
    expect(problems[0]!.fix).toMatch(/1\.5 mm/);
  });

  it('is stricter on aluminium than on steel, because it cracks sooner', () => {
    const alu = checkSheet(angleBracket(50, 30, 3, 2), 'aluminium');
    const steel = checkSheet(angleBracket(50, 30, 3, 2), 'steel');

    expect(alu.length).toBeGreaterThan(steel.length);
  });

  it('refuses a flange the tooling cannot grip', () => {
    const problems = checkSheet(angleBracket(50, 5, 3), 'steel');
    expect(problems.some((p) => /cannot grip/.test(p.problem))).toBe(true);
  });

  it('refuses a K factor outside anything physical', () => {
    // The neutral axis lies between the inside face and the middle, so K is between 0 and 0.5.
    const problems = checkSheet({ ...angleBracket(50, 30, 2), kFactor: 0.8 });
    expect(problems.some((p) => /outside anything physical/.test(p.problem))).toBe(true);
  });

  it('passes a part a shop would actually make', () => {
    expect(checkSheet(angleBracket(60, 40, 2, 2), 'steel')).toEqual([]);
  });
});

describe('what it tells the user', () => {
  it('gives the blank length and where to mark the bends', () => {
    const spec = angleBracket(50, 30, 2, 2, 0.44);
    const said = describeFlat(spec, flatPattern(spec)).join(' ');

    expect(said).toMatch(/Blank 84\.5 mm long/);
    expect(said).toMatch(/1 bend at 52\.3 mm/);
  });

  it('says how much shorter the blank is, and at what K', () => {
    // Because a fabricator with their own measured K will want to change it, and needs to see
    // which number it moved.
    const spec = angleBracket(50, 30, 2, 2, 0.44);
    const said = describeFlat(spec, flatPattern(spec)).join(' ');

    expect(said).toMatch(/3\.48 mm shorter/);
    expect(said).toMatch(/K = 0\.44/);
  });
});

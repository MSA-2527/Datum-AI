import { describe, expect, it } from 'vitest';
import { checkRequirements, describeChecks, readRequirements, scaleToMeet } from './requirements';
import { box, cylinder } from '../kernel/ops/build';

/**
 * Reading what was asked for, and checking whether it was delivered.
 *
 * The failure this exists to stop is specific and was easy to miss: ask for "a 400 mm long
 * bracket" with no language model configured, and the offline route matched the word
 * "bracket", built the standard one at 180 mm, and reported success. The number was read,
 * understood, and discarded.
 */

const kinds = (text: string) => readRequirements(text).map((r) => `${r.kind}=${r.value}`).sort();

describe('reading a request', () => {
  it('takes a dimension whether the word comes before or after the number', () => {
    expect(kinds('a 400 mm long bracket')).toContain('length=400');
    expect(kinds('a bracket with a length of 400 mm')).toContain('length=400');
  });

  it('reads every dimension in one request', () => {
    expect(kinds('a plate 200 mm long, 120 mm wide and 6 mm thick'))
      .toEqual(['height=6', 'length=200', 'width=120']);
  });

  it('converts units rather than taking the number as millimetres', () => {
    expect(kinds('a 2 inch diameter shaft')).toContain('diameter=50.8');
    expect(kinds('a 1.5 m long beam')).toContain('length=1500');
  });

  it('reads a mass, and does not also read it as a length', () => {
    // "2 kg" contains the number 2, and taking it as a 2 mm dimension would be a part four
    // hundred times too small that nothing downstream would question.
    const r = readRequirements('a bracket to hold 2 kg');
    expect(r.filter((x) => x.kind === 'mass')[0]!.value).toBe(2000);
    expect(r.some((x) => x.kind === 'length' && x.value === 2)).toBe(false);
  });

  it('reads a material', () => {
    const r = readRequirements('a mounting plate in 6061');
    expect(r.find((x) => x.kind === 'material')!.text).toBe('6061');
  });

  it('does not read an alloy designation as a dimension', () => {
    // "a 400 mm long bracket in 6061" came back with a length of 6061 mm. The alloy number is a
    // bare number, "long" sits just before it, and being stated later it beat the 400 that was
    // actually asked for.
    const r = readRequirements('a 400 mm long bracket in 6061');

    expect(r.find((x) => x.kind === 'length')!.value).toBe(400);
    expect(r.find((x) => x.kind === 'material')!.text).toBe('6061');
  });

  it('still reads a thickness stated after "in"', () => {
    // "in 25 mm plate" names a thickness, not an alloy. A capture that is itself a measurement
    // is handed back to the dimension pass rather than swallowed as a material.
    const r = readRequirements('a bracket in 25 mm thick plate');
    expect(r.find((x) => x.kind === 'height')!.value).toBe(25);
  });

  it('prefers a number with a unit over a bare one', () => {
    // A bare number is far more often something else that happens to be numeric — a model
    // number, a quantity, a grade.
    const r = readRequirements('a 300 mm long rail, type 7075');
    expect(r.find((x) => x.kind === 'length')!.value).toBe(300);
  });

  it('asks for nothing when nothing was stated', () => {
    // A request silent about mass leaves the part free on that axis. Inventing a default and
    // then checking against it manufactures failures out of things nobody asked for.
    expect(readRequirements('a bracket')).toEqual([]);
  });

  it('takes the last of two conflicting statements, which is the correction', () => {
    expect(kinds('a 200 mm long bracket, no, 300 mm long')).toEqual(['length=300']);
  });

  it('keeps the words it read, so what was understood can be shown', () => {
    expect(readRequirements('a 400 mm long bracket')[0]!.source).toBe('400 mm');
  });
});

describe('checking the part against the request', () => {
  const plate = () => box(180, 120, 6, [0, 0, 0], 'P');

  it('passes a dimension that came out right', () => {
    const checks = checkRequirements(readRequirements('180 mm long'), plate(), 100, 'Aluminium');

    expect(checks[0]!.met).toBe(true);
    expect(checks[0]!.note).toMatch(/as asked/);
  });

  it('fails one that did not, and says both numbers', () => {
    const checks = checkRequirements(readRequirements('400 mm long'), plate(), 100, 'Aluminium');

    expect(checks[0]!.met).toBe(false);
    expect(checks[0]!.note).toContain('400');
    expect(checks[0]!.note).toContain('180');
  });

  it('measures the solid, not the parameters that were meant to produce it', () => {
    // A parameter says what was intended; the mesh says what happened. The cases worth
    // catching are exactly the ones where those differ.
    const checks = checkRequirements(readRequirements('50 mm diameter'), cylinder(25, 40, [0, 0, 0], [0, 0, 1], 'C'), 10, 'Steel');
    expect(checks[0]!.met).toBe(true);
  });

  it('reads a dimension off the part however it was built', () => {
    // "400 mm long" means the part's longest measurement, whichever axis the modeller used.
    const onY = box(6, 400, 20, [0, 0, 0], 'B');
    expect(checkRequirements(readRequirements('400 mm long'), onY, 1, 'Steel')[0]!.met).toBe(true);
  });

  it('checks the material by name', () => {
    const yes = checkRequirements(readRequirements('in 6061'), plate(), 1, 'Aluminium 6061-T6');
    const no = checkRequirements(readRequirements('in brass'), plate(), 1, 'Aluminium 6061-T6');

    expect(yes[0]!.met).toBe(true);
    expect(no[0]!.met).toBe(false);
    expect(no[0]!.note).toContain('brass');
  });

  it('checks a mass', () => {
    const checks = checkRequirements(readRequirements('about 500 g'), plate(), 505, 'Aluminium');
    expect(checks[0]!.met).toBe(true);
  });
});

describe('working out how much to scale', () => {
  const plate = () => box(180, 120, 6, [0, 0, 0], 'P');

  it('finds the factor that meets a single dimension', () => {
    const checks = checkRequirements(readRequirements('360 mm long'), plate(), 1, 'Steel');
    expect(scaleToMeet(checks)).toBeCloseTo(2, 6);
  });

  it('splits the difference between dimensions that disagree', () => {
    // One factor, not one per axis: a recipe's proportions are the part of it that was
    // designed, and an airliner stretched only along its length is no longer an airliner.
    const checks = checkRequirements(readRequirements('360 mm long and 120 mm wide'), plate(), 1, 'Steel');
    const factor = scaleToMeet(checks);

    expect(factor).toBeGreaterThan(1);
    expect(factor).toBeLessThan(2);
  });

  it('treats too big and too small as the same size of mistake', () => {
    // Fitted in log space. Averaging the raw ratios would let "twice as big" outweigh "half
    // as big" and drift every part upwards.
    const twice = checkRequirements(readRequirements('360 mm long'), plate(), 1, 'S');
    const half = checkRequirements(readRequirements('90 mm long'), plate(), 1, 'S');

    expect(scaleToMeet(twice) * scaleToMeet(half)).toBeCloseTo(1, 6);
  });

  it('leaves a part alone when nothing dimensional was asked', () => {
    expect(scaleToMeet(checkRequirements(readRequirements('in brass'), plate(), 1, 'Brass'))).toBe(1);
  });
});

describe('what it says', () => {
  const plate = () => box(180, 120, 6, [0, 0, 0], 'P');

  it('says nothing when nothing was asked', () => {
    expect(describeChecks([])).toBe('');
  });

  it('names how many came out wrong rather than burying it', () => {
    const checks = checkRequirements(readRequirements('400 mm long'), plate(), 1, 'Steel');
    expect(describeChecks(checks)).toMatch(/1 of 1 did not come out right/);
  });
});

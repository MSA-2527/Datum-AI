import { describe, expect, it } from 'vitest';
import {
  beam, bolt, buckling, fit, materialById, pressFit,
  rectangleSection, roundSection, tubeSection,
} from './engineering';

/**
 * The engineering equations, checked against results that are known independently.
 *
 * Every case here is one where the answer can be had another way — a textbook example, a hand
 * calculation, or a relation that must hold whatever the numbers. Checking a formula against
 * itself proves nothing, and a wrong answer that looks authoritative is worse than no answer.
 */

const value = (r: ReturnType<typeof beam>, label: string) =>
  r.lines.find((l) => l.label === label)?.value;

const num = (s: string | undefined) => Number((s ?? '').replace(/[^\d.-]/g, ''));

describe('section properties', () => {
  it('a rectangle is bh cubed over twelve', () => {
    // 20 wide, 40 deep: 20 x 64000 / 12 = 106 667 mm^4.
    expect(rectangleSection(20, 40).I).toBeCloseTo(106666.67, 1);
  });

  it('a round bar is pi d to the fourth over sixty-four', () => {
    expect(roundSection(50).I).toBeCloseTo((Math.PI * 50 ** 4) / 64, 6);
  });

  it('a tube is the difference of two rounds', () => {
    const t = tubeSection(50, 5);
    expect(t.I).toBeCloseTo((Math.PI * (50 ** 4 - 40 ** 4)) / 64, 6);
    expect(t.area).toBeCloseTo((Math.PI * (2500 - 1600)) / 4, 6);
  });

  it('a tube is far stiffer than a solid bar of the same weight', () => {
    // The reason anything is built from tube: the same material, much further from the axis.
    // Equal area by construction: a 30 mm solid is 707 mm², and a 50 mm tube reaches the same
    // with a 5 mm wall (inner 40).
    const solid = roundSection(30);
    const tube = tubeSection(50, 5);

    expect(Math.abs(tube.area - solid.area) / solid.area).toBeLessThan(0.15);
    expect(tube.I).toBeGreaterThan(solid.I * 2.5);
  });
});

describe('beams', () => {
  const steel = materialById('1018');

  it('a cantilever matches the hand calculation', () => {
    // 1000 N at the end of a 500 mm steel bar, 20 x 40 section.
    // I = 106667, E = 205000. Deflection = 1000 x 500^3 / (3 x 205000 x 106667) = 1.905 mm.
    const r = beam('cantilever-end', 1000, 500, rectangleSection(20, 40), steel);
    expect(num(value(r, 'Deflection'))).toBeCloseTo(1.905, 2);
  });

  it('a simply supported beam deflects a sixteenth of the same cantilever', () => {
    // PL^3/48EI against PL^3/3EI — a relation that holds whatever the numbers are.
    const section = rectangleSection(20, 40);
    const c = num(value(beam('cantilever-end', 1000, 500, section, steel), 'Deflection'));
    const s = num(value(beam('simple-centre', 1000, 500, section, steel), 'Deflection'));

    expect(c / s).toBeCloseTo(16, 1);
  });

  it('reports the stress against yield rather than on its own', () => {
    const r = beam('cantilever-end', 1000, 500, rectangleSection(20, 40), steel);
    expect(value(r, 'Against yield')).toMatch(/x|×/);
    expect(r.lines.find((l) => l.label === 'Against yield')!.note).toContain('370');
  });

  it('warns when the beam would take a permanent set', () => {
    const r = beam('cantilever-end', 50000, 500, rectangleSection(20, 40), steel);
    expect(r.warning).toMatch(/exceeds yield/);
  });

  it('warns on a thin margin even when it has not yielded', () => {
    // Stress = P x 500 x 20 / 106667 = 0.09375 P. A factor of 1.2 against 370 MPa needs
    // about 3 290 N, which is safely inside the band this warning is for.
    const r = beam('cantilever-end', 3300, 500, rectangleSection(20, 40), steel);
    expect(r.warning).toMatch(/1\.5/);
  });

  it('says what it assumes, always', () => {
    const r = beam('simple-udl', 500, 800, roundSection(25), steel);
    expect(r.assumes.length).toBeGreaterThan(0);
    expect(r.assumes.join(' ')).toMatch(/spread evenly/);
  });

  it('deflection grows with the cube of the length', () => {
    const section = roundSection(20);
    // 200 and 400 rather than 100 and 200: at 100 mm the deflection is 0.02 mm, and the
    // displayed figure is rounded hard enough that the ratio reads 7.9 rather than 8.
    const short = num(value(beam('cantilever-end', 100, 200, section, steel), 'Deflection'));
    const long = num(value(beam('cantilever-end', 100, 400, section, steel), 'Deflection'));

    expect(long / short).toBeCloseTo(8, 1);
  });
});

describe('bolts', () => {
  it('an M8 8.8 preloads to about 16.5 kN', () => {
    // 0.75 x 600 MPa x 36.6 mm^2 = 16.5 kN, which every handbook agrees with.
    expect(num(value(bolt(8, '8.8'), 'Preload'))).toBeCloseTo(16.5, 0);
  });

  it('the torque follows T = K F d', () => {
    // 0.2 x 16470 N x 8 mm = 26.4 N.m, the usual published figure for M8 8.8.
    expect(num(value(bolt(8, '8.8'), 'Tightening torque'))).toBeCloseTo(26.4, 0);
  });

  it('states the spread on the torque rather than a single number', () => {
    // A torque wrench gets within about a quarter of the intended preload. One number invites
    // people to trust a setting further than it deserves.
    expect(bolt(8, '8.8').lines.find((l) => l.label === 'Tightening torque')!.note)
      .toContain('25%');
  });

  it('a 12.9 holds appreciably more than a 4.6 of the same size', () => {
    expect(num(value(bolt(10, '12.9'), 'Preload')))
      .toBeGreaterThan(num(value(bolt(10, '4.6'), 'Preload')) * 3);
  });

  it('warns when the joint would slip', () => {
    expect(bolt(6, '8.8', 2, 40000).warning).toMatch(/would slip/);
  });

  it('refuses a size it does not have rather than inventing one', () => {
    expect(bolt(7, '8.8').warning).toMatch(/not in the table/);
  });
});

describe('press fits', () => {
  const steel = materialById('1018');

  it('pressure rises in proportion with interference', () => {
    const light = pressFit(30, 60, 0.02, steel, 40);
    const heavy = pressFit(30, 60, 0.06, steel, 40);

    expect(num(value(heavy, 'Interface pressure')))
      .toBeCloseTo(num(value(light, 'Interface pressure')) * 3, 0);
  });

  it('names the hub bore as the highest stress, which is what people get wrong', () => {
    // The shaft looks like the loaded part and is not.
    expect(pressFit(30, 60, 0.04, steel, 40).lines
      .find((l) => l.label === 'Hub hoop stress')!.note).toMatch(/highest/);
  });

  it('warns when the hub would yield', () => {
    expect(pressFit(30, 34, 0.15, steel, 40).warning).toMatch(/yields/);
  });

  it('refuses a hub smaller than its shaft', () => {
    expect(pressFit(50, 30, 0.02, steel, 40).warning).toMatch(/larger than the shaft/);
  });
});

describe('buckling', () => {
  const steel = materialById('1018');

  it('a slender column matches the Euler formula', () => {
    const section = tubeSection(50, 3);
    const r = buckling(2000, section, steel, 'pinned');

    const expected = (Math.PI ** 2 * steel.E * section.I) / 2000 ** 2;
    expect(num(value(r, 'Euler buckling')) * 1000).toBeCloseTo(expected, -2);
  });

  it('fixed ends carry four times a pinned column', () => {
    // K = 0.5, and the load goes as one over K squared.
    const section = tubeSection(50, 3);
    const pinned = num(value(buckling(2000, section, steel, 'pinned'), 'Euler buckling'));
    const fixed = num(value(buckling(2000, section, steel, 'fixed'), 'Euler buckling'));

    expect(fixed / pinned).toBeCloseTo(4, 1);
  });

  it('reports crushing for a stubby column, not an Euler load far above it', () => {
    // The whole value of doing this: Euler happily returns a load the material cannot take.
    const r = buckling(60, roundSection(50), steel);

    expect(r.warning).toMatch(/too stubby/);
    expect(r.lines.find((l) => l.label === 'Critical load')!.note).toContain('crushing');
    expect(num(value(r, 'Critical load'))).toBeLessThan(num(value(r, 'Euler buckling')));
  });
});

describe('fits', () => {
  it('an H7 hole on 30 mm is 21 micrometres wide, per ISO 286', () => {
    const hole = fit(30, 'H7/h6').lines.find((l) => l.label === 'Hole')!.value;
    const [lo, hi] = hole.split(' to ').map(Number);

    expect(hi! - lo!).toBeCloseTo(0.021, 4);
  });

  it('says what the fit does, not only its numbers', () => {
    // Four numbers do not tell anyone whether the parts go together.
    expect(fit(25, 'H7/g6').lines.find((l) => l.label === 'What it does')!.value)
      .toMatch(/turns and slides freely/);
  });

  it('a press fit is reported as interference and warned about', () => {
    expect(fit(40, 'H7/p6').warning).toMatch(/will not assemble by hand/);
  });

  it('a clearance fit has none', () => {
    expect(fit(40, 'H11/c11').warning).toBeUndefined();
  });

  it('refuses a size beyond the table rather than extrapolating', () => {
    expect(fit(900).warning).toMatch(/outside the tabulated range/);
  });

  it('mentions temperature, because a fit is only a fit at one', () => {
    expect(fit(50).assumes.join(' ')).toMatch(/20/);
  });
});

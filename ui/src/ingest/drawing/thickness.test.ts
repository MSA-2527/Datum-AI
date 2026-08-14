import { describe, expect, it } from 'vitest';
import {
  fastenerThickness, inferThickness, snapToStock, statedThickness,
} from './thickness';

/**
 * Tests for recovering the third dimension of a one-view drawing.
 *
 * The bar these have to clear is not "produces a number" — the old code did that, by taking a
 * tenth of the plan size. It is that the number has a reason, that the reason is reported, and
 * that a value read off the drawing is never confused with one the app invented.
 */

describe('reading a thickness the drawing states', () => {
  it('reads the forms drafters actually write', () => {
    expect(statedThickness(['THK 6'])).toBe(6);
    expect(statedThickness(['THK. 2.5'])).toBe(2.5);
    expect(statedThickness(['THICKNESS: 10'])).toBe(10);
    expect(statedThickness(['6mm THICK'])).toBe(6);
    expect(statedThickness(['3 MM THK'])).toBe(3);
    expect(statedThickness(['t=3'])).toBe(3);
    expect(statedThickness(['T = 1.5'])).toBe(1.5);
    expect(statedThickness(['PLATE 10'])).toBe(10);
    expect(statedThickness(['MATERIAL: 3MM MS'])).toBe(3);
    expect(statedThickness(['12MM SS304'])).toBe(12);
  });

  it('sees through MTEXT formatting codes', () => {
    // MTEXT wraps its content in font and height directives. Left in place, no pattern
    // matches and a stated dimension is silently lost.
    expect(statedThickness(['{\\fISOCPEUR|b0|i0|c0|p34;THK 6}'])).toBe(6);
    expect(statedThickness(['\\H2.5x;\\C1;THK 8'])).toBe(8);
    expect(statedThickness(['NOTES:\\PTHK 4\\PDEBURR ALL EDGES'])).toBe(4);
  });

  it('refuses text that merely contains a number', () => {
    // A false "stated" reading is worse than no reading: it carries an authority it has not
    // earned, and the caller stops warning the user about it.
    expect(statedThickness(['SCALE 1:2'])).toBeUndefined();
    expect(statedThickness(['PART 1234'])).toBeUndefined();
    expect(statedThickness(['DRAWN BY A. KHAN 2024'])).toBeUndefined();
    expect(statedThickness(['QTY 4'])).toBeUndefined();
    expect(statedThickness([])).toBeUndefined();
  });

  it('rejects a stated value outside any plausible plate', () => {
    expect(statedThickness(['THK 0.01'])).toBeUndefined();
    expect(statedThickness(['THK 5000'])).toBeUndefined();
  });

  it('converts from the drawing units', () => {
    // A drawing in inches saying THK 0.25 is 6.35 mm, not 0.25 mm.
    expect(statedThickness(['THK 0.25'], 25.4)).toBeCloseTo(6.35, 6);
  });

  it('takes the first matching note when a sheet has several', () => {
    expect(statedThickness(['SCALE 1:1', 'THK 5', 'THK 9'])).toBe(5);
  });
});

describe('inferring a thickness from the fastener pattern', () => {
  it('recognises a repeated clearance hole as its thread', () => {
    expect(fastenerThickness([5.5, 5.5, 5.5, 5.5])).toEqual({ mm: 4, thread: 5 });
    expect(fastenerThickness([9, 9, 9, 9])?.thread).toBe(8);
    expect(fastenerThickness([3.4, 3.4])?.thread).toBe(3);
  });

  it('ignores a single large bore, which says nothing about thickness', () => {
    // One ⌀20 hole is a shaft or a cable passage. Only a repeated hole is a fixing pattern.
    expect(fastenerThickness([20])).toBeUndefined();
  });

  it('prefers the smallest repeated hole', () => {
    // The big repeated bore is a feature; the small repeated one holds the part on.
    expect(fastenerThickness([40, 40, 5.5, 5.5, 5.5, 5.5])?.thread).toBe(5);
  });

  it('refuses a hole that is not near any clearance size', () => {
    expect(fastenerThickness([7.3, 7.3])).toBeUndefined();
  });
});

describe('snapping to material that exists', () => {
  it('lands on stocked flat sizes', () => {
    expect(snapToStock(6.4)).toBe(6);
    expect(snapToStock(2.7)).toBe(2.5);
    expect(snapToStock(11.4)).toBe(12);
  });

  it('never returns less than the thinnest stocked sheet', () => {
    expect(snapToStock(0.01)).toBe(0.5);
    expect(snapToStock(-5)).toBe(0.5);
  });
});

describe('the whole decision', () => {
  it('prefers what the drawing says over any rule', () => {
    const r = inferThickness({
      annotations: ['THK 3'],
      holeDiametersMm: [9, 9, 9, 9],   // would imply 6 mm on its own
      planMm: 200,                      // would imply 20 mm on its own
    });

    expect(r.mm).toBe(3);
    expect(r.source).toBe('stated');
    expect(r.authoritative).toBe(true);
  });

  it('falls to the fastener rule when nothing is written', () => {
    const r = inferThickness({ annotations: ['SCALE 1:1'], holeDiametersMm: [9, 9, 9, 9], planMm: 200 });

    expect(r.source).toBe('fastener');
    expect(r.mm).toBe(6);
    expect(r.authoritative).toBe(false);
    expect(r.because).toContain('M8');
  });

  it('falls to a proportion only when it knows nothing else, and says so', () => {
    const r = inferThickness({ annotations: [], holeDiametersMm: [], planMm: 80 });

    expect(r.source).toBe('proportion');
    expect(r.authoritative).toBe(false);
    // The one honest word for this path. It must not be dressed up as a measurement.
    expect(r.because).toContain('guess');
  });

  it('always returns a thickness a supplier could actually cut', () => {
    // Whatever route was taken, the answer has to be orderable. A 6.37 mm plate is not.
    for (const plan of [12, 80, 200, 1500]) {
      for (const holes of [[], [5.5, 5.5], [11, 11, 11]]) {
        const r = inferThickness({ annotations: [], holeDiametersMm: holes, planMm: plan });
        expect(snapToStock(r.mm)).toBe(r.mm);
        expect(r.mm).toBeGreaterThan(0);
      }
    }
  });
});

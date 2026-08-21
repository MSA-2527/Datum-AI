import { describe, expect, it } from 'vitest';
import { dropHiddenDetail } from './hidden';
import type { Vec2 } from '../../kernel/math/vec';

/**
 * Telling a hidden-detail line from the geometry it hides behind.
 *
 * A tracer has no idea a line is dashed: it finds each dash as its own closed contour, and the
 * reconstruction receives a view containing its outline plus forty confetti — every one of them
 * material as far as the hull is concerned. A bore drawn as two hidden lines through a boss comes
 * back as two rows of little solid blocks *inside* the part, with the bore filled in.
 *
 * The risk in fixing it is the opposite mistake, and it is the worse one: dropping small loops to
 * catch the dashes would drop the bolt pattern too.
 */

/** A rectangle as a closed loop. */
function rect(x: number, y: number, w: number, h: number): Vec2[] {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

/** A run of dashes along a line: n slivers, evenly spaced, all the same size. */
function dashes(x: number, y: number, n: number, pitch: number, dash = 6): Vec2[][] {
  return Array.from({ length: n }, (_, i) => rect(x + i * pitch, y, dash, 1.2));
}

const SHEET = 200;

describe('what it drops', () => {
  it('drops a run of dashes and keeps the outline', () => {
    const outline = rect(10, 10, 180, 120);
    const loops = [outline, ...dashes(30, 60, 6, 12)];

    const result = dropHiddenDetail(loops, SHEET);

    expect(result.dropped).toHaveLength(6);
    expect(result.kept).toEqual([outline]);
    expect(result.runs).toBe(1);
  });

  it('drops two separate hidden lines as two runs', () => {
    // A bore through a boss is drawn as two hidden lines, one for each wall.
    const loops = [
      rect(10, 10, 180, 120),
      ...dashes(40, 50, 5, 12),
      ...dashes(40, 90, 5, 12),
    ];

    const result = dropHiddenDetail(loops, SHEET);

    expect(result.runs).toBe(2);
    expect(result.dropped).toHaveLength(10);
  });

  it('drops a run running the other way', () => {
    // Vertical hidden lines are as common as horizontal ones and nothing here is axis-aligned.
    const vertical = Array.from({ length: 5 }, (_, i) => rect(60, 30 + i * 12, 1.2, 6));
    const result = dropHiddenDetail([rect(10, 10, 180, 120), ...vertical], SHEET);

    expect(result.dropped).toHaveLength(5);
  });

  it('drops a run at an angle, because drawings have those too', () => {
    const diagonal = Array.from({ length: 5 }, (_, i) => rect(40 + i * 9, 40 + i * 9, 5, 1.2));
    const result = dropHiddenDetail([rect(10, 10, 180, 120), ...diagonal], SHEET);

    expect(result.dropped).toHaveLength(5);
  });
});

describe('what it keeps', () => {
  it('keeps a bolt pattern, which is small loops that are not in a run', () => {
    /*
     * The mistake worth more than the fix. Four holes on a bolt circle are small, similar and
     * regularly spaced — everything a dash is except collinear, and collinearity is the only
     * thing that separates them.
     */
    const holes = [
      rect(50, 50, 6, 6), rect(140, 50, 6, 6),
      rect(50, 100, 6, 6), rect(140, 100, 6, 6),
    ];
    const result = dropHiddenDetail([rect(10, 10, 180, 120), ...holes], SHEET);

    expect(result.dropped).toEqual([]);
    expect(result.kept).toHaveLength(5);
  });

  it('keeps a single slot, which is a sliver on its own', () => {
    const result = dropHiddenDetail([rect(10, 10, 180, 120), rect(60, 60, 40, 3)], SHEET);
    expect(result.dropped).toEqual([]);
  });

  it('keeps two slivers, because two is not a run', () => {
    // Two collinear slots is a real thing somebody draws. Three at one pitch is a hidden edge.
    const result = dropHiddenDetail(
      [rect(10, 10, 180, 120), rect(40, 60, 6, 1.2), rect(60, 60, 6, 1.2)], SHEET,
    );

    expect(result.dropped).toEqual([]);
  });

  it('keeps a row of features too big to be dashes', () => {
    // Five ribs in a row are collinear, evenly spaced and identical — and each is a tenth of the
    // sheet, which no dash ever is.
    const ribs = Array.from({ length: 5 }, (_, i) => rect(20 + i * 30, 40, 20, 20));
    const result = dropHiddenDetail([rect(10, 10, 180, 120), ...ribs], SHEET);

    expect(result.dropped).toEqual([]);
  });

  it('leaves a drawing with no hidden detail exactly as it was', () => {
    const loops = [rect(10, 10, 180, 120), rect(50, 50, 20, 20)];
    const result = dropHiddenDetail(loops, SHEET);

    expect(result.kept).toEqual(loops);
    expect(result.runs).toBe(0);
  });

  it('does nothing to a sheet with too little on it to judge', () => {
    const loops = [rect(10, 10, 50, 50)];
    expect(dropHiddenDetail(loops, SHEET).kept).toEqual(loops);
  });
});

describe('what it reports', () => {
  it('hands back what it dropped, so it can be shown rather than vanish', () => {
    const result = dropHiddenDetail([rect(10, 10, 180, 120), ...dashes(30, 60, 5, 12)], SHEET);

    expect(result.dropped).toHaveLength(5);
    // The loops themselves, not a count: a caller that wants to draw them faintly can.
    expect(result.dropped[0]).toHaveLength(4);
  });
});

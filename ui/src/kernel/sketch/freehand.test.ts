import { describe, expect, it } from 'vitest';
import { addFreehand, freehandToEntities } from './freehand';
import { emptySketch } from './solver';
import type { Vec2 } from '../math/vec';

/**
 * Drawing freely, and getting geometry.
 *
 * Every stroke here is a shape whose answer is known: a square drawn by hand is four lines, a
 * circle drawn by hand is an arc or two, and a shape drawn with a deliberate kink in it keeps the
 * kink. What is being checked is that drawing produces something the rest of the application can
 * dimension, constrain and extrude — not a four-hundred-segment scribble that only looks right.
 */

/** Points along a straight run, as a hand would leave them. */
function run(from: Vec2, to: Vec2, n = 20): Vec2[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t] as Vec2;
  });
}

/** A hand-drawn square, with a little wobble on every point. */
function square(side = 60, wobble = 0): Vec2[] {
  const jitter = (p: Vec2, i: number): Vec2 => (wobble === 0
    ? p
    : [p[0] + Math.sin(i * 2.7) * wobble, p[1] + Math.cos(i * 3.1) * wobble]);

  const path = [
    ...run([0, 0], [side, 0]),
    ...run([side, 0], [side, side]),
    ...run([side, side], [0, side]),
    ...run([0, side], [0, 0]),
  ];
  return path.map(jitter);
}

/** A hand-drawn circle. */
function circle(r = 40, n = 64): Vec2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [r * Math.cos(a), r * Math.sin(a)] as Vec2;
  });
}

describe('a stroke becomes geometry', () => {
  it('reads a hand-drawn square as four lines, not four hundred', () => {
    /*
     * The whole point. Keeping the drawn path would give a curve that cannot be dimensioned,
     * cannot be constrained and cannot be quoted — and the shop would ask what R it is.
     */
    const drawn = freehandToEntities(square(), { tolerance: 1 })!;

    expect(drawn.lines).toBe(4);
    expect(drawn.arcs).toBe(0);
  });

  it('reads a hand-drawn circle as arcs', () => {
    const drawn = freehandToEntities(circle(), { tolerance: 1 })!;

    expect(drawn.arcs).toBeGreaterThan(0);
    // And not as sixty-four little lines.
    expect(drawn.lines).toBeLessThan(8);
  });

  it('survives a wobbly hand', () => {
    // The same square, drawn badly. Simplification is what makes a hand-drawn straight edge
    // come out as one line rather than forty.
    const drawn = freehandToEntities(square(60, 0.6), { tolerance: 2 })!;

    expect(drawn.lines).toBeLessThanOrEqual(6);
    expect(drawn.closed).toBe(true);
  });

  it('joins the ends when the stroke comes back to where it started', () => {
    const drawn = freehandToEntities(square(), { tolerance: 1 })!;
    expect(drawn.closed).toBe(true);
  });

  it('leaves an open stroke open', () => {
    const drawn = freehandToEntities(run([0, 0], [80, 0]), { tolerance: 1 })!;

    expect(drawn.closed).toBe(false);
    expect(drawn.lines).toBe(1);
  });

  it('says what it made, in the words a person would use', () => {
    expect(freehandToEntities(square(), { tolerance: 1 })!.summary).toBe('4 lines, closed');
  });
});

describe('the entities it produces', () => {
  it('shares the point where two segments meet', () => {
    /*
     * The property that decides whether the sketch can be extruded at all. Two segments meeting
     * at a corner must reference the *same* point entity — two points at one coordinate look
     * identical, drag apart, and leave a profile that is open.
     */
    const drawn = freehandToEntities(square(), { tolerance: 1 })!;

    const points = drawn.entities.filter((e) => e.kind === 'point');
    const lines = drawn.entities.filter((e) => e.kind === 'line');

    // Four lines round a closed loop share four corners between them.
    expect(lines).toHaveLength(4);
    expect(points).toHaveLength(4);
  });

  it('gives an arc a centre, a start and an end the solver can move', () => {
    // Not a radius as a number: a stored radius is a fact nothing can adjust, and a constraint
    // that wants to change it has nowhere to write.
    const drawn = freehandToEntities(circle(), { tolerance: 1 })!;
    const arc = drawn.entities.find((e) => e.kind === 'arc')!;

    expect(arc.kind).toBe('arc');
    if (arc.kind !== 'arc') return;

    for (const id of [arc.centre, arc.start, arc.end]) {
      expect(drawn.entities.some((e) => e.id === id && e.kind === 'point'), `${id} is not a point`)
        .toBe(true);
    }
  });

  it('places an arc’s ends on the arc', () => {
    const drawn = freehandToEntities(circle(40), { tolerance: 1 })!;
    const arc = drawn.entities.find((e) => e.kind === 'arc')!;
    if (arc.kind !== 'arc') throw new Error('no arc');

    const at = (id: string) => {
      const p = drawn.entities.find((e) => e.id === id);
      if (!p || p.kind !== 'point') throw new Error(`${id} is not a point`);
      return [p.x, p.y] as Vec2;
    };

    const centre = at(arc.centre);
    const start = at(arc.start);
    const end = at(arc.end);

    // Both ends the same distance from the centre, which is what makes it an arc.
    const ra = Math.hypot(start[0] - centre[0], start[1] - centre[1]);
    const rb = Math.hypot(end[0] - centre[0], end[1] - centre[1]);

    expect(ra).toBeCloseTo(rb, 6);
    expect(ra).toBeGreaterThan(1);
  });

  it('numbers its entities so two strokes never collide', () => {
    const first = addFreehand(emptySketch(), square())!;
    const second = addFreehand(first.sketch, circle())!;

    // Every id in the second stroke is new: nothing from the first was overwritten.
    expect(second.sketch.entities.size)
      .toBe(first.sketch.entities.size + second.result.entities.length);
  });
});

describe('what it declines to do', () => {
  it('has nothing to say about a tap', () => {
    expect(freehandToEntities([[10, 10]])).toBeNull();
    expect(freehandToEntities([])).toBeNull();
  });

  it('has nothing to say about a stroke that never moved', () => {
    expect(freehandToEntities(Array.from({ length: 30 }, () => [5, 5] as Vec2))).toBeNull();
  });

  it('keeps a shape it cannot recognise rather than smoothing it away', () => {
    /*
     * A tight zig-zag is not a line and not an arc. The honest answer is the points that were
     * drawn — a faithful polyline in the one place it is warranted beats a confident arc through
     * a shape nobody drew.
     */
    const zigzag: Vec2[] = [];
    for (let i = 0; i < 12; i++) zigzag.push([i * 6, i % 2 === 0 ? 0 : 14]);

    const drawn = freehandToEntities(zigzag, { tolerance: 0.5 })!;

    expect(drawn.lines).toBeGreaterThan(6);
    expect(drawn.arcs).toBe(0);
  });

  it('adds nothing to the sketch when there was nothing to add', () => {
    expect(addFreehand(emptySketch(), [[1, 1]])).toBeNull();
  });
});

describe('adding to a sketch', () => {
  it('leaves what was already there alone', () => {
    const before = addFreehand(emptySketch(), square())!.sketch;
    const after = addFreehand(before, run([100, 0], [180, 0]))!.sketch;

    for (const [id, entity] of before.entities) {
      expect(after.entities.get(id)).toEqual(entity);
    }
  });

  it('keeps the constraints that were already on it', () => {
    const sketch = emptySketch();
    sketch.constraints.push({ id: 'c1', kind: 'horizontal', entities: ['x'] });

    const after = addFreehand(sketch, square())!.sketch;
    expect(after.constraints).toHaveLength(1);
  });
});

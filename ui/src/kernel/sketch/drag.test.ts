import { describe, expect, it } from 'vitest';
import { addLine, addPoint, constrain, emptySketch, solve } from './solver';

/**
 * Dragging a constrained sketch.
 *
 * The behaviour that makes a sketcher feel like one: move a corner and the rest follows the
 * rules you gave it. The mechanism is that the dragged point is pinned for the length of the
 * drag, so the solver satisfies everything else *around* it.
 *
 * Without the pin the solver is free to satisfy the constraints by putting the point back where
 * it started — which it will, because that is the nearest solution — and the sketch sits there
 * refusing to be dragged with no indication why. That is what these tests are really about.
 */

const at = (s: ReturnType<typeof emptySketch>, id: string) => {
  const e = s.entities.get(id)!;
  if (e.kind !== 'point') throw new Error('not a point');
  return [e.x, e.y] as const;
};

describe('a pinned point stays where it was put', () => {
  it('and the rest of the sketch moves to suit it', () => {
    // A horizontal line. Drag one end up; the constraint has to bring the other end with it,
    // rather than dropping the dragged end back down.
    const s = emptySketch();
    const a = addPoint(s, 0, 0);
    const b = addPoint(s, 50, 0);
    const line = addLine(s, a, b);
    constrain(s, 'horizontal', [line]);

    // The drag: move `a` up and pin it there.
    const moved = s.entities.get(a.id)!;
    if (moved.kind !== 'point') throw new Error('bad');
    moved.y = 20;
    moved.fixed = true;

    const solved = solve(s);
    expect(at(solved.sketch, a.id)[1]).toBeCloseTo(20, 6);
    expect(at(solved.sketch, b.id)[1]).toBeCloseTo(20, 6);
  });

  it('without the pin, the solver puts it back and nothing appears to happen', () => {
    // The failure this guards against, written out so it cannot come back silently.
    const s = emptySketch();
    const a = addPoint(s, 0, 0);
    const b = addPoint(s, 50, 0);
    constrain(s, 'horizontal', [addLine(s, a, b)]);
    constrain(s, 'fixY', [b], 0);

    const moved = s.entities.get(a.id)!;
    if (moved.kind !== 'point') throw new Error('bad');
    moved.y = 20;
    // deliberately not pinned

    // `b` is held at y=0 and the line must stay horizontal, so `a` is dragged back to 0.
    expect(at(solve(s).sketch, a.id)[1]).toBeCloseTo(0, 6);
  });

  it('a dimension survives the drag', () => {
    // Dragging must not quietly break what was dimensioned. A 50 mm line stays 50 mm long
    // however its end is pulled about.
    const s = emptySketch();
    const a = addPoint(s, 0, 0);
    const b = addPoint(s, 50, 0);
    addLine(s, a, b);
    constrain(s, 'distance', [a, b], 50);

    const moved = s.entities.get(a.id)!;
    if (moved.kind !== 'point') throw new Error('bad');
    moved.x = -30; moved.y = 40;
    moved.fixed = true;

    const solved = solve(s);
    const [ax, ay] = at(solved.sketch, a.id);
    const [bx, by] = at(solved.sketch, b.id);

    expect(Math.hypot(bx - ax, by - ay)).toBeCloseTo(50, 4);
    expect([ax, ay]).toEqual([-30, 40]);
  });

  it('a rectangle stays a rectangle when a corner is pulled', () => {
    // The reason a rectangle is drawn with two horizontals and two verticals rather than as
    // four loose lines: dragging a corner resizes it instead of shearing it.
    const s = emptySketch();
    const p1 = addPoint(s, 0, 0);
    const p2 = addPoint(s, 40, 0);
    const p3 = addPoint(s, 40, 30);
    const p4 = addPoint(s, 0, 30);

    constrain(s, 'horizontal', [addLine(s, p1, p2)]);
    constrain(s, 'vertical', [addLine(s, p2, p3)]);
    constrain(s, 'horizontal', [addLine(s, p3, p4)]);
    constrain(s, 'vertical', [addLine(s, p4, p1)]);

    const corner = s.entities.get(p3.id)!;
    if (corner.kind !== 'point') throw new Error('bad');
    corner.x = 70; corner.y = 55;
    corner.fixed = true;

    const solved = solve(s);
    const c1 = at(solved.sketch, p1.id);
    const c2 = at(solved.sketch, p2.id);
    const c3 = at(solved.sketch, p3.id);
    const c4 = at(solved.sketch, p4.id);

    // Still axis-aligned: the two horizontals and two verticals all still hold.
    expect(c1[1]).toBeCloseTo(c2[1], 4);
    expect(c3[1]).toBeCloseTo(c4[1], 4);
    expect(c2[0]).toBeCloseTo(c3[0], 4);
    expect(c4[0]).toBeCloseTo(c1[0], 4);

    // And it grew to where the corner was taken.
    expect(c3).toEqual([70, 55]);
  });
});

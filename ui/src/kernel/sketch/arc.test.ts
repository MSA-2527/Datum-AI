import { describe, expect, it } from 'vitest';
import { addArc, addLine, addPoint, constrain, emptySketch, solve } from './solver';
import { loopsOf, profileFromSketch } from './document';
import { signedArea2 } from './profile';

/**
 * Arcs in a sketch.
 *
 * The arc entity existed as a type with nothing behind it: no builder, no residual in the
 * solver, and no handling in the walk that turns a sketch into a profile. A sketch containing
 * one could be drawn, solved and saved, and then reported as having no closed outline — so a
 * curved side was not something the editor could produce at all.
 */

describe('what makes an arc an arc', () => {
  it('holds both ends the same distance from the centre', () => {
    const s = emptySketch();
    const c = addPoint(s, 0, 0);
    const a = addPoint(s, 10, 0);
    // Deliberately at the wrong radius: the constraint has to pull it in.
    const b = addPoint(s, 0, 17);
    addArc(s, c, a, b);

    const solved = solve(s);
    const cc = solved.sketch.entities.get(c.id)!;
    const aa = solved.sketch.entities.get(a.id)!;
    const bb = solved.sketch.entities.get(b.id)!;
    if (cc.kind !== 'point' || aa.kind !== 'point' || bb.kind !== 'point') throw new Error('bad');

    const r1 = Math.hypot(aa.x - cc.x, aa.y - cc.y);
    const r2 = Math.hypot(bb.x - cc.x, bb.y - cc.y);
    expect(r1).toBeCloseTo(r2, 6);
  });

  it('leaves the five degrees of freedom an arc actually has', () => {
    // Centre, radius and two angles. Three loose points would be six.
    const s = emptySketch();
    const c = addPoint(s, 0, 0);
    addArc(s, c, addPoint(s, 10, 0), addPoint(s, 0, 10));

    expect(solve(s).degreesOfFreedom).toBe(5);
  });

  it('can be dimensioned like anything else', () => {
    const s = emptySketch();
    const c = addPoint(s, 0, 0);
    const a = addPoint(s, 10, 0);
    const b = addPoint(s, 0, 10);
    addArc(s, c, a, b);
    constrain(s, 'distance', [c, a], 25);

    const solved = solve(s);
    const cc = solved.sketch.entities.get(c.id)!;
    const bb = solved.sketch.entities.get(b.id)!;
    if (cc.kind !== 'point' || bb.kind !== 'point') throw new Error('bad');

    // The dimension is on one end; the arc's own constraint carries it to the other.
    expect(Math.hypot(bb.x - cc.x, bb.y - cc.y)).toBeCloseTo(25, 4);
  });
});

describe('an arc as a side of the outline', () => {
  /** A rectangle with its top edge replaced by an arc bulging upwards. */
  function tombstone() {
    const s = emptySketch();
    const bl = addPoint(s, -20, 0);
    const br = addPoint(s, 20, 0);
    const tr = addPoint(s, 20, 30);
    const tl = addPoint(s, -20, 30);
    const centre = addPoint(s, 0, 30);

    addLine(s, bl, br);
    addLine(s, br, tr);
    addArc(s, centre, tr, tl);   // counter-clockwise, over the top
    addLine(s, tl, bl);
    return s;
  }

  it('closes the loop, where it used to report no outline at all', () => {
    const { closed, openChains } = loopsOf(solve(tombstone()).sketch);

    expect(closed).toHaveLength(1);
    expect(openChains).toBe(0);
  });

  it('contributes its curve, not a straight jump across it', () => {
    // A straight top would give four corners. The arc has to put points between them.
    const { closed } = loopsOf(solve(tombstone()).sketch);
    expect(closed[0]!.length).toBeGreaterThan(10);
  });

  it('encloses the area of the rectangle plus the half-round on top', () => {
    const { closed } = loopsOf(solve(tombstone()).sketch);
    const area = Math.abs(signedArea2(closed[0]!)) / 2;

    // 40 x 30 rectangle, plus a half-disc of radius 20.
    expect(area).toBeCloseTo(40 * 30 + (Math.PI * 400) / 2, -1);
  });

  it('becomes a profile that can be extruded', () => {
    const { profile, reason } = profileFromSketch(solve(tombstone()).sketch);

    expect(reason).toBeUndefined();
    expect(profile).not.toBeNull();
    expect(profile!.outer.length).toBeGreaterThan(10);
  });
});

describe('a full round of arcs', () => {
  it('closes a shape made only of arcs', () => {
    // Two half-arcs back to back: a circle drawn as two entities, which is how a slot's ends
    // are drawn and the case a line-only walk could never close.
    const s = emptySketch();
    const c = addPoint(s, 0, 0);
    const right = addPoint(s, 15, 0);
    const left = addPoint(s, -15, 0);

    addArc(s, c, right, left);
    addArc(s, c, left, right);

    const { closed, openChains } = loopsOf(solve(s).sketch);
    expect(openChains).toBe(0);
    expect(closed).toHaveLength(1);
    expect(Math.abs(signedArea2(closed[0]!)) / 2).toBeCloseTo(Math.PI * 225, -1);
  });
});

describe('what it refuses', () => {
  it('ignores a construction arc when reading the outline', () => {
    const s = emptySketch();
    const c = addPoint(s, 0, 0);
    addArc(s, c, addPoint(s, 10, 0), addPoint(s, 0, 10), true);

    expect(loopsOf(solve(s).sketch).closed).toHaveLength(0);
  });

  it('contributes nothing from a zero-radius arc rather than dividing by it', () => {
    const s = emptySketch();
    const c = addPoint(s, 0, 0);
    addArc(s, c, addPoint(s, 0, 0), addPoint(s, 0, 0));

    expect(() => loopsOf(solve(s).sketch)).not.toThrow();
  });
});

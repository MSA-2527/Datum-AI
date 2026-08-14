import { describe, expect, it } from 'vitest';
import {
  __analyticJacobian, addCircle, addLine, addPoint, constrain, coordsOf, emptySketch,
  radiusOf, solve,
} from './solver';

/**
 * Constraint solver tests.
 *
 * These check three separate things, and all three matter.
 *
 * That it *solves*: the geometry actually satisfies the constraints afterwards, verified by
 * measuring the geometry rather than by trusting the reported residual.
 *
 * That it *diagnoses*: under-defined, fully defined, over-defined and contradictory are four
 * different states needing four different messages, and a solver that lumps them together is
 * useless in a real sketch. This is where most home-grown solvers fall down — they converge
 * or they do not, and the user is left guessing which of thirty constraints is wrong.
 *
 * That it *converges from a bad start*: a user dragging a point puts the solver a long way
 * from the answer, which is exactly where undamped Newton diverges.
 */

const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('solving', () => {
  it('brings two points together', () => {
    const s = emptySketch();
    const a = addPoint(s, 0, 0, true);
    const b = addPoint(s, 37, -12);
    constrain(s, 'coincident', [a, b]);

    const r = solve(s);
    expect(r.status).toBe('solved');
    expect(dist(coordsOf(r.sketch, b.id), [0, 0])).toBeLessThan(1e-7);
  });

  it('sets a distance exactly', () => {
    const s = emptySketch();
    const a = addPoint(s, 0, 0, true);
    const b = addPoint(s, 10, 0);
    constrain(s, 'distance', [a, b], 40);

    const r = solve(s);
    expect(dist(coordsOf(r.sketch, a.id), coordsOf(r.sketch, b.id))).toBeCloseTo(40, 7);
  });

  it('pushes coincident points apart to reach a distance', () => {
    // The residual is written on distance rather than squared distance precisely so this
    // works: the squared form has zero gradient here and the solver could never move.
    const s = emptySketch();
    const a = addPoint(s, 5, 5, true);
    const b = addPoint(s, 5, 5);
    constrain(s, 'distance', [a, b], 25);

    const r = solve(s);
    expect(dist(coordsOf(r.sketch, a.id), coordsOf(r.sketch, b.id))).toBeCloseTo(25, 6);
  });

  it('makes a line horizontal', () => {
    const s = emptySketch();
    const a = addPoint(s, 0, 0, true);
    const b = addPoint(s, 30, 17);
    const l = addLine(s, a, b);
    constrain(s, 'horizontal', [l]);

    const r = solve(s);
    expect(coordsOf(r.sketch, b.id)[1]).toBeCloseTo(0, 7);
  });

  it('makes two lines perpendicular', () => {
    const s = emptySketch();
    const o = addPoint(s, 0, 0, true);
    const a = addPoint(s, 50, 0, true);
    const b = addPoint(s, 30, 20);
    const l1 = addLine(s, o, a);
    const l2 = addLine(s, o, b);
    constrain(s, 'perpendicular', [l1, l2]);

    const r = solve(s);
    const pb = coordsOf(r.sketch, b.id);
    // l1 runs along +x, so a perpendicular l2 must have no x component.
    expect(pb[0]).toBeCloseTo(0, 6);
  });

  it('holds an angle between two lines', () => {
    const s = emptySketch();
    const o = addPoint(s, 0, 0, true);
    const a = addPoint(s, 50, 0, true);
    const b = addPoint(s, 40, 5);
    const l1 = addLine(s, o, a);
    const l2 = addLine(s, o, b);
    constrain(s, 'angle', [l1, l2], 30);

    const r = solve(s);
    const pb = coordsOf(r.sketch, b.id);
    const ang = (Math.atan2(pb[1], pb[0]) * 180) / Math.PI;
    expect(Math.abs(ang)).toBeCloseTo(30, 4);
  });

  it('makes two lines equal in length', () => {
    const s = emptySketch();
    const a = addPoint(s, 0, 0, true);
    const b = addPoint(s, 60, 0, true);
    const c = addPoint(s, 0, 10, true);
    const d = addPoint(s, 20, 10);
    const l1 = addLine(s, a, b);
    const l2 = addLine(s, c, d);
    constrain(s, 'equal', [l1, l2]);

    const r = solve(s);
    expect(dist(coordsOf(r.sketch, c.id), coordsOf(r.sketch, d.id))).toBeCloseTo(60, 5);
  });

  it('puts a point on a line', () => {
    const s = emptySketch();
    const a = addPoint(s, 0, 0, true);
    const b = addPoint(s, 100, 100, true);
    const l = addLine(s, a, b);
    const p = addPoint(s, 50, 10);
    constrain(s, 'pointOnLine', [p, l]);

    const r = solve(s);
    const pp = coordsOf(r.sketch, p.id);
    expect(pp[1]).toBeCloseTo(pp[0], 5); // the line is y = x
  });

  it('makes a line tangent to a circle', () => {
    const s = emptySketch();
    const centre = addPoint(s, 0, 0, true);
    const c = addCircle(s, centre, 20);
    constrain(s, 'radius', [c], 20);

    const a = addPoint(s, -50, 30);
    const b = addPoint(s, 50, 30);
    const l = addLine(s, a, b);
    constrain(s, 'horizontal', [l]);
    constrain(s, 'tangent', [l, c]);

    const r = solve(s);
    // A horizontal tangent to a circle of radius 20 at the origin sits at y = +/-20.
    expect(Math.abs(coordsOf(r.sketch, a.id)[1])).toBeCloseTo(20, 5);
  });

  it('makes two circles concentric and equal', () => {
    const s = emptySketch();
    const c1 = addCircle(s, addPoint(s, 0, 0, true), 10);
    const c2 = addCircle(s, addPoint(s, 30, 40), 25);
    constrain(s, 'concentric', [c1, c2]);
    constrain(s, 'equal', [c1, c2]);
    constrain(s, 'radius', [c1], 10);

    const r = solve(s);
    expect(radiusOf(r.sketch, c2.id)).toBeCloseTo(10, 5);
    expect(dist(coordsOf(r.sketch, c2.centre), [0, 0])).toBeLessThan(1e-5);
  });

  it('mirrors two points across an axis', () => {
    const s = emptySketch();
    const o = addPoint(s, 0, 0, true);
    const up = addPoint(s, 0, 100, true);
    const axis = addLine(s, o, up);

    const a = addPoint(s, -30, 20, true);
    const b = addPoint(s, 10, 45);
    constrain(s, 'symmetric', [a, b, axis]);

    const r = solve(s);
    const pb = coordsOf(r.sketch, b.id);
    expect(pb[0]).toBeCloseTo(30, 5);
    expect(pb[1]).toBeCloseTo(20, 5);
  });
});

describe('a fully constrained rectangle', () => {
  /** Four corners, four lines, and enough constraints to pin it completely. */
  function rect() {
    const s = emptySketch();
    const p0 = addPoint(s, 0, 0, true);      // origin, pinned
    const p1 = addPoint(s, 40, 3);
    const p2 = addPoint(s, 43, 25);
    const p3 = addPoint(s, -2, 22);

    const bottom = addLine(s, p0, p1);
    const right = addLine(s, p1, p2);
    const top = addLine(s, p2, p3);
    const left = addLine(s, p3, p0);

    constrain(s, 'horizontal', [bottom]);
    constrain(s, 'horizontal', [top]);
    constrain(s, 'vertical', [left]);
    constrain(s, 'vertical', [right]);
    constrain(s, 'distance', [p0, p1], 60);
    constrain(s, 'distance', [p1, p2], 35);

    return { s, p0, p1, p2, p3 };
  }

  it('solves to the requested dimensions', () => {
    const { s, p0, p1, p2, p3 } = rect();
    const r = solve(s);

    expect(r.status).toBe('solved');
    expect(r.degreesOfFreedom).toBe(0);

    const a = coordsOf(r.sketch, p0.id), b = coordsOf(r.sketch, p1.id);
    const c = coordsOf(r.sketch, p2.id), d = coordsOf(r.sketch, p3.id);

    expect(dist(a, b)).toBeCloseTo(60, 6);
    expect(dist(b, c)).toBeCloseTo(35, 6);
    expect(dist(c, d)).toBeCloseTo(60, 6);
    expect(dist(d, a)).toBeCloseTo(35, 6);

    // And the corners really are square.
    expect(Math.abs(b[1] - a[1])).toBeLessThan(1e-6);
    expect(Math.abs(c[0] - b[0])).toBeLessThan(1e-6);
  });

  it('reports the sketch as fully defined', () => {
    const r = solve(rect().s);
    expect(r.message).toMatch(/fully defined/i);
  });

  it('converges from a badly displaced start, as a drag would produce', () => {
    // Undamped Gauss-Newton diverges from here; the Levenberg-Marquardt damping is what
    // makes dragging a corner across the sketch a recoverable operation.
    const { s, p2 } = rect();
    const moved = s.entities.get(p2.id)!;
    if (moved.kind === 'point') s.entities.set(p2.id, { ...moved, x: -4000, y: 9000 });

    const r = solve(s);
    expect(r.status).toBe('solved');
    expect(r.residual).toBeLessThan(1e-7);
  });
});

describe('diagnosis', () => {
  it('reports remaining degrees of freedom, and what can still move', () => {
    const s = emptySketch();
    const a = addPoint(s, 0, 0, true);
    const b = addPoint(s, 30, 0);
    const l = addLine(s, a, b);
    constrain(s, 'horizontal', [l]);
    // Length is never given, so b can still slide along x.

    const r = solve(s);
    expect(r.status).toBe('under');
    expect(r.degreesOfFreedom).toBe(1);
    expect(r.freeDirections.length).toBeGreaterThan(0);
    expect(r.message).toMatch(/degree/i);
  });

  it('counts degrees of freedom correctly for a free point', () => {
    const s = emptySketch();
    addPoint(s, 5, 5);
    const r = solve(s);
    expect(r.degreesOfFreedom).toBe(2);
  });

  it('detects a redundant constraint without failing the solve', () => {
    const s = emptySketch();
    const a = addPoint(s, 0, 0, true);
    const b = addPoint(s, 50, 0);
    const l = addLine(s, a, b);

    constrain(s, 'horizontal', [l]);
    constrain(s, 'fixY', [b], 0);      // says the same thing as horizontal
    constrain(s, 'distance', [a, b], 50);

    const r = solve(s);
    expect(r.status).toBe('over');
    expect(r.problemConstraints.length).toBeGreaterThan(0);
    expect(r.message).toMatch(/redundant/i);
    // The geometry is still correct — redundancy is not an error, only a warning.
    expect(dist(coordsOf(r.sketch, a.id), coordsOf(r.sketch, b.id))).toBeCloseTo(50, 6);
  });

  it('detects contradictory constraints and names the culprits', () => {
    const s = emptySketch();
    const a = addPoint(s, 0, 0, true);
    const b = addPoint(s, 30, 0);

    constrain(s, 'distance', [a, b], 40);
    constrain(s, 'distance', [a, b], 90);   // cannot both be true

    const r = solve(s);
    expect(r.status).toBe('conflict');
    expect(r.problemConstraints.length).toBeGreaterThan(0);
    expect(r.message).toMatch(/cannot all be satisfied/i);
  });

  it('does not call an unsatisfiable sketch merely under-defined', () => {
    // A conflict with degrees of freedom left over must still read as a conflict, or the
    // user goes looking for the wrong problem entirely.
    const s = emptySketch();
    const a = addPoint(s, 0, 0, true);
    const b = addPoint(s, 30, 0);
    addPoint(s, 99, 99);                     // unconstrained, adds 2 DOF

    constrain(s, 'distance', [a, b], 40);
    constrain(s, 'distance', [a, b], 90);

    const r = solve(s);
    expect(r.status).toBe('conflict');
    expect(r.degreesOfFreedom).toBeGreaterThan(0);
  });

  it('handles a sketch with nothing in it', () => {
    const r = solve(emptySketch());
    expect(r.status).toBe('solved');
    expect(r.degreesOfFreedom).toBe(0);
  });

  it('handles geometry with no constraints at all', () => {
    const s = emptySketch();
    addPoint(s, 1, 2);
    addPoint(s, 3, 4);
    const r = solve(s);
    expect(r.status).toBe('under');
    expect(r.degreesOfFreedom).toBe(4);
  });
});

describe('numerical behaviour', () => {
  it('leaves an already-solved sketch untouched', () => {
    // Re-solving must not drift. A sketch that wanders by a micron on every rebuild
    // destroys the repeatability the whole parametric model depends on.
    const s = emptySketch();
    const a = addPoint(s, 0, 0, true);
    const b = addPoint(s, 50, 0);
    constrain(s, 'distance', [a, b], 50);
    constrain(s, 'fixY', [b], 0);

    const first = solve(s);
    const second = solve(first.sketch);

    const p1 = coordsOf(first.sketch, b.id);
    const p2 = coordsOf(second.sketch, b.id);
    expect(dist(p1, p2)).toBeLessThan(1e-12);
    expect(second.iterations).toBeLessThanOrEqual(1);
  });

  it('is deterministic', () => {
    const build = () => {
      const s = emptySketch();
      const a = addPoint(s, 0, 0, true);
      const b = addPoint(s, 13, 29);
      const c = addPoint(s, -7, 41);
      const l1 = addLine(s, a, b);
      const l2 = addLine(s, b, c);
      constrain(s, 'perpendicular', [l1, l2]);
      constrain(s, 'distance', [a, b], 40);
      constrain(s, 'distance', [b, c], 25);
      constrain(s, 'horizontal', [l1]);
      return s;
    };

    const r1 = solve(build());
    const r2 = solve(build());
    expect(coordsOf(r1.sketch, [...r1.sketch.entities.keys()][1]))
      .toEqual(coordsOf(r2.sketch, [...r2.sketch.entities.keys()][1]));
  });

  it('solves a moderately sized sketch quickly', () => {
    // A chain of twenty segments constrained end to end: enough to exercise the linear
    // algebra without being a benchmark.
    const s = emptySketch();
    let prev = addPoint(s, 0, 0, true);
    for (let i = 1; i <= 20; i++) {
      const next = addPoint(s, i * 10 + Math.sin(i) * 4, Math.cos(i) * 6);
      const l = addLine(s, prev, next);
      constrain(s, 'horizontal', [l]);
      constrain(s, 'distance', [prev, next], 10);
      prev = next;
    }

    const t = Date.now();
    const r = solve(s);
    expect(Date.now() - t).toBeLessThan(4000);
    expect(r.status).toBe('solved');
    expect(coordsOf(r.sketch, prev.id)[0]).toBeCloseTo(200, 4);
  });
});

describe('the analytic Jacobian matches numerical differentiation', () => {
  /**
   * Every partial derivative in the solver is hand-written, and a wrong one is close to
   * invisible: the iteration still converges, just to geometry that does not satisfy the
   * constraint. The tangent constraint shipped with all four of its line-endpoint signs
   * flipped and produced a line 33 mm from a 20 mm circle, which looks entirely reasonable
   * until measured.
   *
   * So each constraint is checked against a central difference of its own residual. This is
   * the test that would have caught it, and it covers every constraint type at once.
   */
  const check = (name: string, build: () => ReturnType<typeof emptySketch>) => {
    it(name, () => {
      const s = build();
      const j = __analyticJacobian(s);
      const h = 1e-6;

      expect(j.rows.length).toBeGreaterThan(0);

      for (let v = 0; v < j.varCount; v++) {
        const plus = j.residualsAt(v, h);
        const minus = j.residualsAt(v, -h);

        for (let r = 0; r < j.rows.length; r++) {
          const numeric = (plus[r] - minus[r]) / (2 * h);
          const analytic = j.rows[r].grad.get(v) ?? 0;

          // Scale the tolerance with the magnitude: a derivative of 1e4 cannot be checked
          // to the same absolute precision as one of 0.1.
          const scale = Math.max(1, Math.abs(numeric), Math.abs(analytic));
          expect(
            Math.abs(numeric - analytic),
            `${name}: d(row ${r} of ${j.rows[r].constraintId})/d(var ${v}) — ` +
            `analytic ${analytic}, numeric ${numeric}`,
          ).toBeLessThan(1e-4 * scale);
        }
      }
    });
  };

  check('coincident', () => {
    const s = emptySketch();
    constrain(s, 'coincident', [addPoint(s, 3, 7), addPoint(s, -11, 4)]);
    return s;
  });

  check('distance', () => {
    const s = emptySketch();
    constrain(s, 'distance', [addPoint(s, 3, 7), addPoint(s, -11, 4)], 30);
    return s;
  });

  check('horizontal and vertical', () => {
    const s = emptySketch();
    const a = addPoint(s, 2, 9), b = addPoint(s, 31, -4), c = addPoint(s, 17, 22);
    constrain(s, 'horizontal', [addLine(s, a, b)]);
    constrain(s, 'vertical', [addLine(s, b, c)]);
    return s;
  });

  check('parallel and perpendicular', () => {
    const s = emptySketch();
    const a = addPoint(s, 1, 2), b = addPoint(s, 21, 9);
    const c = addPoint(s, -4, 13), d = addPoint(s, 18, 31);
    constrain(s, 'parallel', [addLine(s, a, b), addLine(s, c, d)]);
    constrain(s, 'perpendicular', [addLine(s, a, c), addLine(s, b, d)]);
    return s;
  });

  check('angle', () => {
    const s = emptySketch();
    const o = addPoint(s, 1, 1), a = addPoint(s, 34, 6), b = addPoint(s, 12, 27);
    constrain(s, 'angle', [addLine(s, o, a), addLine(s, o, b)], 37);
    return s;
  });

  check('equal lines and equal circles', () => {
    const s = emptySketch();
    const a = addPoint(s, 0, 1), b = addPoint(s, 23, 5);
    const c = addPoint(s, 4, 19), d = addPoint(s, 30, 26);
    constrain(s, 'equal', [addLine(s, a, b), addLine(s, c, d)]);
    constrain(s, 'equal', [addCircle(s, addPoint(s, 5, 5), 9), addCircle(s, addPoint(s, 40, 12), 14)]);
    return s;
  });

  check('pointOnLine', () => {
    const s = emptySketch();
    const a = addPoint(s, 2, 3), b = addPoint(s, 29, 17);
    constrain(s, 'pointOnLine', [addPoint(s, 14, 6), addLine(s, a, b)]);
    return s;
  });

  check('pointOnCircle', () => {
    const s = emptySketch();
    const c = addCircle(s, addPoint(s, 4, 6), 17);
    constrain(s, 'pointOnCircle', [addPoint(s, 22, 15), c]);
    return s;
  });

  check('tangent', () => {
    const s = emptySketch();
    const c = addCircle(s, addPoint(s, 3, 5), 12);
    const a = addPoint(s, -30, 21), b = addPoint(s, 40, 26);
    constrain(s, 'tangent', [addLine(s, a, b), c]);
    return s;
  });

  check('tangent from the other side of the line', () => {
    // The residual carries an absolute value, so the sign of the perpendicular distance
    // flips the whole derivative. Both branches need checking.
    const s = emptySketch();
    const c = addCircle(s, addPoint(s, 3, 40), 12);
    const a = addPoint(s, -30, 4), b = addPoint(s, 40, 9);
    constrain(s, 'tangent', [addLine(s, a, b), c]);
    return s;
  });

  check('concentric', () => {
    const s = emptySketch();
    constrain(s, 'concentric', [
      addCircle(s, addPoint(s, 2, 3), 8),
      addCircle(s, addPoint(s, 19, 24), 15),
    ]);
    return s;
  });

  check('symmetric', () => {
    const s = emptySketch();
    const o = addPoint(s, 1, 0), up = addPoint(s, 3, 40);
    constrain(s, 'symmetric', [addPoint(s, -19, 13), addPoint(s, 26, 21), addLine(s, o, up)]);
    return s;
  });

  check('radius and fixed coordinates', () => {
    const s = emptySketch();
    constrain(s, 'radius', [addCircle(s, addPoint(s, 6, 2), 11)], 20);
    const p = addPoint(s, 8, 14);
    constrain(s, 'fixX', [p], 5);
    constrain(s, 'fixY', [p], -3);
    return s;
  });
});

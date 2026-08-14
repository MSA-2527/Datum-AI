import { describe, expect, it } from 'vitest';
import { addCircle, addLine, addPoint, constrain, emptySketch } from './solver';
import { loopsOf, profileFromSketch, sketchFromJson, sketchToJson, solveForProfile } from './document';
import { addFeature, emptyDocument, evaluateDocument } from '../../model/document';
import { triCount } from '../topo/mesh';

/**
 * Sketches as document data, and the loop that makes a modeller parametric.
 *
 * The constraint solver has existed here for a long time with nothing calling it, which is the
 * gap between this and a CAD package stated plainly: real parametric modelling is *draw
 * roughly, constrain, extrude*, and a dimension propagates through every relation depending on
 * it. Picking a primitive and typing numbers changes one value in isolation.
 *
 * These check that the propagation actually happens — that a rectangle drawn by eye becomes
 * exactly 100 × 60, and that changing the 100 afterwards moves everything that should move.
 */

/** A deliberately sloppy rectangle: no corner is square and no side is the right length. */
function roughRectangle() {
  const s = emptySketch();
  const a = addPoint(s, 0, 0, true);
  const b = addPoint(s, 97, 4);
  const c = addPoint(s, 101, 58);
  const d = addPoint(s, -3, 61);
  const l1 = addLine(s, a, b);
  const l2 = addLine(s, b, c);
  const l3 = addLine(s, c, d);
  const l4 = addLine(s, d, a);
  return { s, a, b, c, d, l1, l2, l3, l4 };
}

/** Squares it up and dimensions it 100 × 60. */
function constrainedRectangle() {
  const r = roughRectangle();
  constrain(r.s, 'horizontal', [r.l1.id]);
  constrain(r.s, 'horizontal', [r.l3.id]);
  constrain(r.s, 'vertical', [r.l2.id]);
  constrain(r.s, 'vertical', [r.l4.id]);
  constrain(r.s, 'distance', [r.a.id, r.b.id], 100);
  constrain(r.s, 'distance', [r.b.id, r.c.id], 60);
  return r;
}

describe('constraints drive the geometry', () => {
  it('reports the degrees of freedom as they are removed', () => {
    // The readout that separates knowing a dimension will hold from hoping it will.
    const r = roughRectangle();
    expect(solveForProfile(r.s).result.degreesOfFreedom).toBe(6);

    constrain(r.s, 'horizontal', [r.l1.id]);
    constrain(r.s, 'horizontal', [r.l3.id]);
    constrain(r.s, 'vertical', [r.l2.id]);
    constrain(r.s, 'vertical', [r.l4.id]);
    expect(solveForProfile(r.s).result.degreesOfFreedom).toBe(2);

    constrain(r.s, 'distance', [r.a.id, r.b.id], 100);
    constrain(r.s, 'distance', [r.b.id, r.c.id], 60);

    const solved = solveForProfile(r.s);
    expect(solved.result.degreesOfFreedom).toBe(0);
    expect(solved.summary).toBe('Fully constrained.');
  });

  it('moves a hand-drawn outline onto its exact dimensions', () => {
    // Nobody typed these corners. They are where the solver put them.
    const { s } = constrainedRectangle();
    const outer = solveForProfile(s).profile!.outer;

    expect(outer).toHaveLength(4);
    const sorted = [...outer].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    expect(sorted[0][0]).toBeCloseTo(0, 9);
    expect(sorted[3][0]).toBeCloseTo(100, 9);
    expect(Math.max(...outer.map((p) => p[1]))).toBeCloseTo(60, 9);
  });

  it('re-drives the whole profile when one dimension changes', () => {
    // The property the whole feature exists for. Editing 100 to 150 does not move one corner;
    // it moves both corners on that side, because the constraints say they belong together.
    const { s } = constrainedRectangle();
    const dim = s.constraints.find((c) => c.kind === 'distance' && c.value === 100)!;
    dim.value = 150;

    const outer = solveForProfile(s).profile!.outer;
    expect(Math.max(...outer.map((p) => p[0]))).toBeCloseTo(150, 9);
    expect(Math.max(...outer.map((p) => p[1]))).toBeCloseTo(60, 9);
  });

  it('treats a circle inside the outline as a hole', () => {
    const { s } = constrainedRectangle();
    const centre = addPoint(s, 50, 30);
    const bore = addCircle(s, centre, 12);
    constrain(s, 'radius', [bore.id], 12);

    const profile = solveForProfile(s).profile!;
    expect(profile.holes).toHaveLength(1);
    expect(profile.outer).toHaveLength(4);
  });

  it('reports a conflict rather than silently picking one constraint', () => {
    const { s, a, b } = constrainedRectangle();
    constrain(s, 'distance', [a.id, b.id], 250);   // already constrained to 100

    const solved = solveForProfile(s);
    expect(solved.result.status).toBe('conflict');
    expect(solved.summary).toMatch(/conflict/i);
  });
});

describe('reading the outline out of a sketch', () => {
  it('closes a loop through shared point identity, not proximity', () => {
    // Two lines whose ends merely coincide on screen are not joined. Saying otherwise would
    // silently accept a profile that falls apart the moment a constraint moves one of them.
    const s = emptySketch();
    const a = addPoint(s, 0, 0);
    const b = addPoint(s, 50, 0);
    const c = addPoint(s, 50, 50);
    const alsoA = addPoint(s, 0, 0);          // same place, different point
    addLine(s, a, b);
    addLine(s, b, c);
    addLine(s, c, alsoA);

    expect(loopsOf(s).closed).toHaveLength(0);
    expect(profileFromSketch(s).profile).toBeNull();
    expect(profileFromSketch(s).reason).toMatch(/do not join up/i);
  });

  it('says what is wrong with an empty sketch', () => {
    expect(profileFromSketch(emptySketch()).reason).toMatch(/empty/i);
  });

  it('picks the largest ring as the outline whatever order it was drawn in', () => {
    // The bore is drawn first here. Drawing order must not decide which loop is the outside.
    const s = emptySketch();
    const centre = addPoint(s, 50, 30);
    addCircle(s, centre, 12);

    const a = addPoint(s, 0, 0);
    const b = addPoint(s, 100, 0);
    const c = addPoint(s, 100, 60);
    const d = addPoint(s, 0, 60);
    addLine(s, a, b); addLine(s, b, c); addLine(s, c, d); addLine(s, d, a);

    const profile = profileFromSketch(s).profile!;
    expect(profile.outer).toHaveLength(4);
    expect(profile.holes).toHaveLength(1);
  });

  it('ignores construction geometry', () => {
    const s = emptySketch();
    const a = addPoint(s, 0, 0);
    const b = addPoint(s, 100, 0);
    const c = addPoint(s, 100, 60);
    const d = addPoint(s, 0, 60);
    addLine(s, a, b); addLine(s, b, c); addLine(s, c, d); addLine(s, d, a);
    addLine(s, a, c, true);                   // a diagonal, for reference only

    expect(profileFromSketch(s).profile!.outer).toHaveLength(4);
  });
});

describe('surviving the document', () => {
  it('round-trips through the parameter form', () => {
    const { s } = constrainedRectangle();
    const back = sketchFromJson(sketchToJson(s));

    expect(back.entities.size).toBe(s.entities.size);
    expect(back.constraints).toHaveLength(s.constraints.length);
    expect(solveForProfile(back).summary).toBe('Fully constrained.');
  });

  it('returns an empty sketch rather than throwing on damaged data', () => {
    // One unreadable feature must not stop a document opening — the rest is the user's work.
    expect(sketchFromJson('{not json').entities.size).toBe(0);
    expect(sketchFromJson('').entities.size).toBe(0);
    expect(sketchFromJson('{"v":1}').entities.size).toBe(0);
    expect(sketchFromJson('[1,2,3]').entities.size).toBe(0);
  });
});

describe('the sketch feature', () => {
  const build = (json: string, distance = 20) => {
    const doc = addFeature(emptyDocument(), 'sketch', { sketch: json, distance, plane: 'XY' }, 'Sketch1');
    return { doc, evaluated: evaluateDocument(doc) };
  };

  it('extrudes the constrained profile to an exact volume', () => {
    // 100 × 60 × 20 to the millimetre, from a rectangle nobody measured.
    const { s } = constrainedRectangle();
    const { evaluated } = build(sketchToJson(s));

    expect(evaluated.errors.size).toBe(0);
    expect(evaluated.volume).toBeCloseTo(100 * 60 * 20, 6);
    expect(evaluated.health.closed).toBe(true);
    expect(triCount(evaluated.mesh)).toBe(12);
  });

  it('follows the dimension when it is edited', () => {
    const { s } = constrainedRectangle();
    const dim = s.constraints.find((c) => c.kind === 'distance' && c.value === 100)!;
    dim.value = 150;

    expect(build(sketchToJson(s)).evaluated.volume).toBeCloseTo(150 * 60 * 20, 6);
  });

  it('cuts the bore through', () => {
    const { s } = constrainedRectangle();
    const centre = addPoint(s, 50, 30);
    const bore = addCircle(s, centre, 12);
    constrain(s, 'radius', [bore.id], 12);

    const { evaluated } = build(sketchToJson(s));

    // Relative, not absolute. The bore is drawn as a 64-sided polygon, so it removes slightly
    // less material than a true circle — about 130 parts per million on this part. That is
    // tessellation, and it is the reason the STEP exporter refits the cylinder analytically.
    const exact = (100 * 60 - Math.PI * 144) * 20;
    expect(Math.abs(evaluated.volume - exact) / exact).toBeLessThan(5e-4);
    expect(evaluated.health.closed).toBe(true);
  });

  it('explains an unusable sketch instead of building nothing quietly', () => {
    const { evaluated } = build(sketchToJson(emptySketch()));

    expect(triCount(evaluated.mesh)).toBe(0);
    expect([...evaluated.errors.values()][0]).toMatch(/empty/i);
  });

  it('warns while under-constrained but still builds', () => {
    // Most sketches are under-constrained most of the time. That is worth saying and is not a
    // reason to refuse — a dimension that does not hold is a surprise later, not now.
    const { s } = roughRectangle();
    const { evaluated } = build(sketchToJson(s));

    expect(evaluated.errors.size).toBe(0);
    expect(triCount(evaluated.mesh)).toBeGreaterThan(0);
    expect([...evaluated.warnings.values()][0]).toMatch(/degrees of freedom/i);
  });

  it('refuses to build a conflicting sketch', () => {
    const { s, a, b } = constrainedRectangle();
    constrain(s, 'distance', [a.id, b.id], 250);

    const { evaluated } = build(sketchToJson(s));
    expect([...evaluated.errors.values()][0]).toMatch(/conflict/i);
  });
});

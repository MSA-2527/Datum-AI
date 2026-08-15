import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { featuresFromPrismatic, fitPrismatic } from './prismatic';
import { readStep } from '../step/read';
import { box, cylinder } from '../../kernel/ops/build';
import { boolean } from '../../kernel/ops/boolean';
import { archetypeById } from '../../generate/archetypes';

/**
 * Recovering an extruded profile.
 *
 * This exists because the archetype fitter, run against a real library of machined clips and
 * bases, correctly recognised none of it. Those parts are not catalogue shapes; they are an
 * outline cut to a thickness, which is what most of a mechanical library is and what no fixed
 * catalogue can cover — the outline is different every time.
 *
 * Two properties are asserted, and the second matters as much as the first. It must recover a
 * part that really is one extrusion, closely enough that the profile *is* the part's outline.
 * And it must refuse everything else with a reason naming what stopped it, because a part
 * rebuilt from a wrong profile is a different part, and one taught from it teaches that.
 */

const real = (name: string) => {
  const r = readStep(readFileSync(`src/ingest/step/fixtures/${name}`, 'utf8'));
  if ('error' in r) throw new Error(r.error);
  return r.mesh;
};

describe('recovering a profile', () => {
  it('reads a plain block as one layer with a rectangular outline', () => {
    const fit = fitPrismatic(box(80, 50, 30, [0, 0, 0], 'Block')).best!;

    expect(fit).not.toBeNull();
    expect(fit.layers).toHaveLength(1);
    expect(fit.holes).toHaveLength(0);
    expect(fit.thickness).toBeCloseTo(30, 3);
    expect(fit.agreement).toBeGreaterThan(0.99);

    // Sectioning gives a point per triangle edge crossed, so a rectangle comes back with
    // collinear points along its sides. It is the same rectangle; simplifying it would be
    // work for no gain, since the extrusion is identical either way.
    const xs = fit.outer.map((p) => p[0]);
    const ys = fit.outer.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(80, 3);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(50, 3);
  });

  it('reads a stepped part as a stack of layers', () => {
    // A pad on a base: two constant sections, one on top of the other. Describing it as a
    // stack is what lets half a real library be read at all — a single profile cannot.
    const stepped = boolean(
      box(100, 60, 10, [0, 0, 0], 'Base'),
      box(50, 30, 10, [0, 0, 10], 'Pad'),
      'union',
    ).mesh;

    const fit = fitPrismatic(stepped).best!;

    expect(fit).not.toBeNull();
    expect(fit.layers.length).toBeGreaterThan(1);
    expect(fit.agreement).toBeGreaterThan(0.99);
  });

  it('recovers a drilled hole as a circle, with its diameter', () => {
    // The difference between a part whose holes can be re-dimensioned, counted by the
    // manufacturability rules and matched to stock drills, and one carrying anonymous
    // line segments.
    const drilled = boolean(
      box(200, 120, 8, [0, 0, 0], 'Plate'),
      cylinder(4.5, 40, [60, 30, 0], [0, 0, 1], 'Hole'),
      'difference',
    ).mesh;

    const fit = fitPrismatic(drilled).best!;

    expect(fit.holes).toHaveLength(1);
    expect(fit.holes[0]!.circle).toBeDefined();
    expect(fit.holes[0]!.circle!.r).toBeCloseTo(4.5, 1);
    expect(Math.hypot(fit.holes[0]!.circle!.cx, fit.holes[0]!.circle!.cy))
      .toBeCloseTo(Math.hypot(60, 30), 0);
  });

  it('recovers a plate with four holes, rounded corners and all', () => {
    const fit = fitPrismatic(archetypeById('plate')!.build({}).mesh).best!;

    expect(fit.thickness).toBeCloseTo(8, 3);
    expect(fit.holes).toHaveLength(4);
    expect(fit.holes.every((h) => h.circle)).toBe(true);
    // The corner radii survive as outline points rather than being squared off.
    expect(fit.outer.length).toBeGreaterThan(20);
    expect(fit.agreement).toBeGreaterThan(0.99);
  });

  it('reads a turned bar as its circular outline', () => {
    const fit = fitPrismatic(cylinder(15, 90, [0, 0, 0], [0, 0, 1], 'Bar')).best!;

    expect(fit.thickness).toBeCloseTo(90, 3);
    expect(fit.outer.length).toBeGreaterThan(20);
  });

  it('reports what it left out when the part has chamfers', () => {
    const fit = fitPrismatic(real('100-0194.step')).best!;
    expect(fit.detail).toMatch(/chamfer or blend, not represented/);
  });
});

describe('refusing what one profile cannot describe', () => {
  it('blames the import, not the profile, when the solid is not sound', () => {
    // 423-0292 imports non-manifold. Slicing counts surface crossings, so on a solid with a
    // doubled face the section comes back the wrong size with nothing looking wrong — it read
    // as "poor fit" at 68% when the truth was that the input was not a solid. Which of the two
    // it is decides where the next work goes.
    const result = fitPrismatic(real('423-0292.STEP'));

    expect(result.best).toBeNull();
    expect(result.reason).toMatch(/not sound/);
    expect(result.reason).toMatch(/non-manifold/);
  });

  it('refuses a revolved part, which has no extrusion axis at all', () => {
    const result = fitPrismatic(archetypeById('cup')!.build({}).mesh);

    expect(result.best).toBeNull();
    expect(result.reason).toMatch(/not a prismatic part/);
  });

  it('refuses an empty mesh and says so', () => {
    const result = fitPrismatic({
      positions: new Float64Array(0), indices: new Uint32Array(0),
      faceIds: new Uint32Array(0), tags: new Map(),
    });

    expect(result.best).toBeNull();
    expect(result.reason).toContain('no geometry');
  });
});

describe('against the real library', () => {
  /*
   * Three of the four are recovered: two as a single extrusion, one as a five-level stack.
   * The fourth imports non-manifold and is refused on that ground rather than scored low.
   * That ratio is the measurement, not a target — and it is the first time any of this
   * library could be read into an editable, teachable form at all.
   */
  it('recovers 100-0194 as a 0.25 inch profile', () => {
    const fit = fitPrismatic(real('100-0194.step')).best!;

    expect(fit).not.toBeNull();
    expect(fit.thickness / 25.4).toBeCloseTo(0.25, 3);
    expect(fit.outer.length).toBeGreaterThan(20);
    expect(fit.agreement).toBeGreaterThan(0.97);
  });

  it('recovers 100-0587_0 as a 0.30 inch profile', () => {
    const fit = fitPrismatic(real('100-0587_0.step')).best!;

    expect(fit.thickness / 25.4).toBeCloseTo(0.30, 3);
    expect(fit.agreement).toBeGreaterThan(0.99);
  });

  it('recovers 423-0293, a five-level part, as a stack of regions', () => {
    // The part that motivated layers. Five levels, and at three of them the section is in
    // several pieces — which is why solid and void are told apart by winding rather than by
    // size: the second lobe is material, and subtracting it rebuilt the part at two thirds
    // of its volume.
    const fit = fitPrismatic(real('423-0293.STEP')).best!;

    expect(fit).not.toBeNull();
    expect(fit.layers.length).toBeGreaterThan(5);
    expect(new Set(fit.layers.map((l) => l.from)).size).toBe(5);
    expect(fit.thickness / 25.4).toBeCloseTo(0.5, 3);
    expect(fit.agreement).toBeGreaterThan(0.97);
  });

  it('reads three of the four, and says why the fourth cannot be read', () => {
    const outcomes = ['100-0194.step', '100-0587_0.step', '423-0293.STEP', '423-0292.STEP']
      .map((name) => [name, fitPrismatic(real(name)).best !== null] as const);

    expect(outcomes.filter(([, ok]) => ok)).toHaveLength(3);
    expect(fitPrismatic(real('423-0292.STEP')).reason).toMatch(/not sound/);
  });
});

describe('from an imported file to a training example', () => {
  /*
   * The chain this whole piece exists for, end to end on a part from a real library:
   *
   *   STEP in inches → solid in millimetres → recovered profile → document feature →
   *   assembly plan → stored example.
   *
   * Before this, that chain stopped at the third step for every part in the library, and
   * "train the system on my models" had no answer for a folder of clips and bases.
   */
  it('recovers, rebuilds, expresses as a plan, and teaches', async () => {
    const { addFeature, emptyDocument, evaluateDocument } = await import('../../model/document');
    const { planFromDocument } = await import('../../assembly/plan');
    const { addFromDocument, clearExamples, listExamples } = await import('../../lib/training');
    const { massProperties, triCount } = await import('../../kernel/topo/mesh');

    clearExamples();

    const original = real('100-0194.step');
    const fit = fitPrismatic(original).best!;
    const features = featuresFromPrismatic(fit);
    expect(features).toHaveLength(fit.layers.length);

    let doc = emptyDocument('100-0194');
    for (const f of features) {
      doc = addFeature(doc, f.kind, f.params as Record<string, string | number>, f.name);
    }

    // It rebuilds, and to the volume the original had less the chamfers the profile does not
    // carry — which the fit reported rather than left to be discovered.
    const rebuilt = evaluateDocument(doc);
    expect(triCount(rebuilt.mesh)).toBeGreaterThan(0);

    const before = Math.abs(massProperties(original).volume);
    const after = Math.abs(massProperties(rebuilt.mesh).volume);
    expect(Math.abs(after - before) / before).toBeLessThan(0.05);

    // It is expressible in the plan vocabulary with nothing left out — which is what makes it
    // teachable, and what a sketch being admitted to that vocabulary bought.
    const { plan, excluded } = planFromDocument(doc);
    expect(excluded).toEqual([]);
    expect(plan.components).toHaveLength(1);
    expect(plan.components[0]!.shape).toBe('sketch');
    expect(String(plan.components[0]!.params.sketch)).toContain('"kind":"line"');

    const taught = addFromDocument('a 0.25 inch retaining clip', doc, 'imported');
    expect(taught.ok, taught.problem).toBe(true);
    expect(listExamples()).toHaveLength(1);

    clearExamples();
  });
});

import { describe, expect, it } from 'vitest';
import { analyseDfm, estimateCost, materialFor } from './dfm';
import { createFeature, evaluate, setGlobal, type PartDoc } from './partModel';

/**
 * Manufacturability and cost tests.
 *
 * The DFM rules exist to stop someone machining a part that cannot be made, so the
 * important assertions here are the ones that prove a rule FIRES when it should — a
 * linter that silently passes everything is worse than none, because it is trusted.
 */

function plate(overrides: Partial<PartDoc> = {}): PartDoc {
  return {
    path: 'C:\\test\\plate.SLDPRT',
    title: 'plate.SLDPRT',
    configuration: 'Default',
    configurations: ['Default'],
    units: 'mm',
    material: '6061-T6',
    density: 2.7,
    writable: true,
    lastRebuildMs: 100,
    globals: [
      { name: 'Length', value: 100, units: 'mm' },
      { name: 'Width', value: 50, units: 'mm' },
      { name: 'Thickness', value: 10, units: 'mm' },
      { name: 'BoltCircle', value: 40, units: 'mm' },
    ],
    properties: { PartNo: 'P-1', Revision: 'A', Description: 'Test plate' },
    features: [],
    ...overrides,
  };
}

describe('material lookup', () => {
  it('resolves by id fragment', () => {
    expect(materialFor('6061-T6 (SS)').id).toBe('6061');
    expect(materialFor('304 stainless').id).toBe('304');
  });

  it('falls back rather than throwing on an unknown material', () => {
    expect(materialFor('unobtanium').id).toBeTruthy();
  });
});

describe('DFM rules', () => {
  it('passes a sane plate', () => {
    const doc = plate();
    const blockers = analyseDfm(doc, evaluate(doc)).filter((f) => f.severity === 'blocker');
    expect(blockers).toHaveLength(0);
  });

  it('flags a hole that breaches the part outline', () => {
    // Bolt circle 40 on a 50-wide plate leaves 5 mm to the edge; a ⌀12 hole overruns it.
    const doc = createFeature(plate(), 'holePattern', { diameter: 12, boltCircleVar: 'BoltCircle' });
    const found = analyseDfm(doc, evaluate(doc));
    expect(found.some((f) => f.rule === 'dfm.hole.off-part' || f.rule === 'dfm.hole.edge-distance')).toBe(true);
  });

  it('flags a hole deeper than 10× its diameter as unmachinable', () => {
    let doc = plate();
    doc = setGlobal(doc, 'Thickness', 60);
    doc = createFeature(doc, 'holePattern', { diameter: 3, boltCircle: 20 });

    const deep = analyseDfm(doc, evaluate(doc)).find((f) => f.rule === 'dfm.drill.depth-ratio');
    expect(deep).toBeDefined();
    expect(deep!.severity).toBe('blocker');
  });

  it('flags an internal radius below the smallest cutter', () => {
    // A 1 mm wide slot implies a 0.5 mm internal radius; the shop's floor is ⌀3.
    const doc = createFeature(plate(), 'slot', { width: 20, height: 1 });
    const found = analyseDfm(doc, evaluate(doc));
    expect(found.some((f) => f.rule === 'dfm.mill.internal-radius')).toBe(true);
  });

  it('flags a non-standard drill size', () => {
    const doc = createFeature(plate(), 'holePattern', { diameter: 7.37, boltCircle: 20 });
    const found = analyseDfm(doc, evaluate(doc));
    expect(found.some((f) => f.rule === 'dfm.drill.standard-size')).toBe(true);
  });

  it('flags missing identity properties that block quoting', () => {
    const doc = plate({ properties: {} });
    const found = analyseDfm(doc, evaluate(doc));
    expect(found.filter((f) => f.rule === 'dfm.metadata.required').length).toBeGreaterThan(0);
  });

  it('collapses identical findings across a pattern into one', () => {
    const doc = createFeature(plate(), 'holePattern', { diameter: 7.37, boltCircle: 20 });
    const nonStandard = analyseDfm(doc, evaluate(doc)).filter((f) => f.rule === 'dfm.drill.standard-size');

    // Four identical holes are one design problem, not four cards.
    expect(nonStandard).toHaveLength(1);
    expect(nonStandard[0]!.occurrences).toBe(4);
  });

  it('sorts blockers ahead of warnings', () => {
    let doc = plate({ properties: {} });
    doc = setGlobal(doc, 'Thickness', 60);
    doc = createFeature(doc, 'holePattern', { diameter: 3, boltCircle: 20 });

    const found = analyseDfm(doc, evaluate(doc));
    const firstWarning = found.findIndex((f) => f.severity === 'warning');
    const lastBlocker = found.map((f) => f.severity).lastIndexOf('blocker');
    if (firstWarning >= 0 && lastBlocker >= 0) expect(lastBlocker).toBeLessThan(firstWarning);
  });
});

describe('cost model', () => {
  it('breaks the estimate into lines that sum to the unit cost', () => {
    const doc = plate();
    const geom = evaluate(doc);
    const cost = estimateCost(doc, geom, [], 1);

    const sum = cost.lines.reduce((s, l) => s + l.amount, 0);
    expect(cost.unitCost).toBeCloseTo(sum, 6);
    expect(cost.lines.length).toBeGreaterThan(3);
  });

  it('amortises setup across quantity', () => {
    const doc = plate();
    const geom = evaluate(doc);

    const one = estimateCost(doc, geom, [], 1);
    const hundred = estimateCost(doc, geom, [], 100);

    // Setup dominates a one-off and nearly vanishes at volume.
    expect(hundred.unitCost).toBeLessThan(one.unitCost);
    expect(hundred.totalCost).toBeCloseTo(hundred.unitCost * 100, 6);
  });

  it('charges more for a slower-cutting material', () => {
    const alu = plate();
    const steel = plate({ material: '304 stainless', density: 8.0 });

    const a = estimateCost(alu, evaluate(alu), [], 10);
    const s = estimateCost(steel, evaluate(steel), [], 10);
    expect(s.unitCost).toBeGreaterThan(a.unitCost);
  });

  it('adds the surcharge carried by DFM findings', () => {
    const doc = plate();
    const geom = evaluate(doc);

    const clean = estimateCost(doc, geom, [], 1);
    const surcharged = estimateCost(doc, geom, [
      { id: 'x', severity: 'advisory', rule: 'r', title: 't', detail: 'd', remedy: 'm', costImpact: 25 },
    ], 1);

    expect(surcharged.unitCost).toBeCloseTo(clean.unitCost + 25, 6);
  });

  it('publishes the basis so the number can be argued with', () => {
    const doc = plate();
    const cost = estimateCost(doc, evaluate(doc), [], 1);
    expect(cost.basis.length).toBeGreaterThan(2);
    expect(cost.basis.join(' ')).toContain('Shop rate');
  });
});

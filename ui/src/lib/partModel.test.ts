import { describe, expect, it } from 'vitest';
import {
  applyOps,
  createFeature,
  deleteFeature,
  evaluate,
  massGrams,
  moveFeature,
  setGlobal,
  setSuppressed,
  shapeArea,
  updateFeature,
  type PartDoc,
} from './partModel';
import type { Operation } from '../types';

/**
 * Geometry evaluator tests.
 *
 * These assert the arithmetic, not just that a function returns. A modeller that
 * silently computes the wrong mass or drops a hole is worse than one that throws, so the
 * numbers here are hand-checked against closed-form area formulae.
 */

function blank(): PartDoc {
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
    properties: {},
    features: [],
  };
}

describe('shapeArea', () => {
  it('computes a plain rectangle', () => {
    expect(shapeArea({ kind: 'rect', cx: 0, cy: 0, w: 10, h: 4 })).toBeCloseTo(40, 6);
  });

  it('subtracts the corner material a fillet removes', () => {
    // 10×10 with R2 corners: 100 − (4 − π)·4 ≈ 96.566
    const a = shapeArea({ kind: 'rect', cx: 0, cy: 0, w: 10, h: 10, cornerR: 2 });
    expect(a).toBeCloseTo(100 - (4 - Math.PI) * 4, 6);
  });

  it('treats a slot as a stadium, not a rectangle', () => {
    // 20 long × 8 wide: 20·8 + π·4² = 160 + 50.265
    expect(shapeArea({ kind: 'slot', cx: 0, cy: 0, w: 20, h: 8 })).toBeCloseTo(160 + Math.PI * 16, 6);
  });

  it('computes a regular polygon', () => {
    // Hexagon, circumradius 10: 0.5·6·100·sin(60°)
    expect(shapeArea({ kind: 'polygon', cx: 0, cy: 0, r: 10, sides: 6 }))
      .toBeCloseTo(0.5 * 6 * 100 * Math.sin(Math.PI / 3), 6);
  });
});

describe('evaluate', () => {
  it('derives the base envelope from globals', () => {
    const g = evaluate(blank());
    expect(g.L).toBe(100);
    expect(g.W).toBe(50);
    expect(g.T).toBe(10);
    expect(g.cuts).toHaveLength(0);
  });

  it('clamps a fillet to half the shortest side', () => {
    // R80 on a 100×50 plate is impossible; the largest valid radius is 25.
    const doc = createFeature(blank(), 'fillet', { radius: 80 });
    expect(evaluate(doc).cornerR).toBe(25);
  });

  it('places a hole pattern on the bolt-circle global', () => {
    const doc = createFeature(blank(), 'holePattern', { diameter: 5, boltCircleVar: 'BoltCircle' });
    const g = evaluate(doc);
    expect(g.holes).toHaveLength(4);
    // BoltCircle 40 → corners at ±20
    expect(Math.abs(g.holes[0]!.x)).toBe(20);
    expect(g.holes[0]!.d).toBe(5);
  });

  it('moves the holes when the driving global changes — the point of being parametric', () => {
    let doc = createFeature(blank(), 'holePattern', { diameter: 5, boltCircleVar: 'BoltCircle' });
    doc = setGlobal(doc, 'BoltCircle', 60);
    expect(Math.abs(evaluate(doc).holes[0]!.x)).toBe(30);
  });

  it('skips suppressed features entirely', () => {
    let doc = createFeature(blank(), 'holePattern', { diameter: 5 });
    const id = doc.features[0]!.id;
    expect(evaluate(doc).holes).toHaveLength(4);

    doc = setSuppressed(doc, id, true);
    expect(evaluate(doc).holes).toHaveLength(0);
  });

  it('multiplies seed cuts through a linear pattern', () => {
    let doc = createFeature(blank(), 'holePattern', { diameter: 5 });
    const seed = doc.features[0]!.id;
    doc = createFeature(doc, 'patternLinear', { seed, count: 3, dx: 10, dy: 0 });

    // 4 seeds, 2 extra instances → 12
    expect(evaluate(doc).holes).toHaveLength(12);
  });

  it('mirrors cuts about the requested axis', () => {
    let doc = createFeature(blank(), 'slot', { cx: 10, cy: 5, width: 8, height: 4 });
    const seed = doc.features[0]!.id;
    doc = createFeature(doc, 'mirror', { seed, axis: 'y' });

    const slots = evaluate(doc).cuts.filter((c) => c.kind === 'slot');
    expect(slots).toHaveLength(2);
    expect(slots[1]!.cx).toBe(-10);
    expect(slots[1]!.cy).toBe(5);
  });

  it('honours tree order — a pattern before its seed produces nothing', () => {
    let doc = createFeature(blank(), 'holePattern', { diameter: 5 });
    const seed = doc.features[0]!.id;
    doc = createFeature(doc, 'patternLinear', { seed, count: 3, dx: 10 });
    const pattern = doc.features[1]!.id;

    expect(evaluate(doc).holes).toHaveLength(12);

    // Move the pattern above its seed: it can no longer see anything to copy.
    doc = moveFeature(doc, pattern, -1);
    expect(evaluate(doc).holes).toHaveLength(4);
  });
});

describe('mass', () => {
  it('matches the closed-form solid volume', () => {
    // 100×50×10 mm = 50 000 mm³ = 50 cm³ × 2.7 = 135 g
    expect(massGrams(blank(), evaluate(blank()))).toBeCloseTo(135, 6);
  });

  it('drops by exactly the volume the holes remove', () => {
    const doc = createFeature(blank(), 'holePattern', { diameter: 10 });
    const removed = 4 * Math.PI * 25 * 10; // 4 holes, r=5, depth 10
    expect(massGrams(doc, evaluate(doc))).toBeCloseTo(135 - (removed / 1000) * 2.7, 6);
  });

  it('never goes negative when cuts exceed the profile', () => {
    const doc = createFeature(blank(), 'pocket', { width: 500, height: 500 });
    expect(massGrams(doc, evaluate(doc))).toBeGreaterThanOrEqual(0);
  });
});

describe('feature CRUD', () => {
  it('names features uniquely', () => {
    let doc = createFeature(blank(), 'fillet', {});
    doc = createFeature(doc, 'fillet', {});
    expect(doc.features.map((f) => f.name)).toEqual(['Fillet1', 'Fillet2']);
  });

  it('edits parameters in place', () => {
    let doc = createFeature(blank(), 'fillet', { radius: 3 });
    doc = updateFeature(doc, doc.features[0]!.id, { radius: 6 });
    expect(evaluate(doc).cornerR).toBe(6);
  });

  it('deletes dependents so the tree never references missing geometry', () => {
    let doc = createFeature(blank(), 'holePattern', { diameter: 5 });
    const seed = doc.features[0]!.id;
    doc = createFeature(doc, 'patternLinear', { seed, count: 3 });
    expect(doc.features).toHaveLength(2);

    doc = deleteFeature(doc, seed);
    expect(doc.features).toHaveLength(0);
  });

  it('refuses to move a feature off either end', () => {
    let doc = createFeature(blank(), 'fillet', {});
    doc = createFeature(doc, 'shell', {});
    const first = doc.features[0]!.id;

    expect(moveFeature(doc, first, -1)).toBe(doc);
    expect(moveFeature(doc, first, 1).features[1]!.id).toBe(first);
  });
});

describe('applyOps', () => {
  const op = (o: string, params: Record<string, unknown>): Operation =>
    ({ id: 'op1', op: o, params } as unknown as Operation);

  it('creates a hole feature with the correct ISO clearance', () => {
    const doc = applyOps(blank(), [op('feature.hole_wizard', { fastener: 'M6' })]);
    // M6 normal-fit clearance is ⌀6.6
    expect(evaluate(doc).holes[0]!.d).toBe(6.6);
  });

  it('drives a global from param.set_global', () => {
    const doc = applyOps(blank(), [op('param.set_global', { name: 'Length', value: 250 })]);
    expect(evaluate(doc).L).toBe(250);
  });

  it('ignores operations that do not affect part geometry', () => {
    const before = evaluate(blank());
    const doc = applyOps(blank(), [op('query.mass_properties', {}), op('drw.export', { format: 'PDF' })]);
    const after = evaluate(doc);
    expect(after.cuts).toHaveLength(before.cuts.length);
    expect(after.L).toBe(before.L);
  });

  it('clears the under-defined flag when a repair plan runs', () => {
    let doc = createFeature(blank(), 'holePattern', {});
    expect(doc.features[0]!.underDefined).toBe(true);

    doc = applyOps(doc, [op('sketch.fully_define', {})]);
    expect(doc.features[0]!.underDefined).toBe(false);
  });
});

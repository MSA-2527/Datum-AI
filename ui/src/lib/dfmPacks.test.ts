import { describe, expect, it } from 'vitest';
import { analyseAdditive, analyseMoulding, analyseSheetMetal, analysePack, PACK_DEFAULTS } from './dfmPacks';
import { createFeature, evaluate, setGlobal, type PartDoc } from './partModel';

/**
 * Process rule-pack tests.
 *
 * The assertions that matter are the ones proving a rule FIRES on bad geometry. A pack
 * that silently passes everything is worse than no pack, because it is trusted.
 */

function part(thickness = 10): PartDoc {
  return {
    path: 'C:\\t\\p.SLDPRT',
    title: 'p.SLDPRT',
    configuration: 'Default',
    configurations: ['Default'],
    units: 'mm',
    material: '6061-T6',
    density: 2.7,
    writable: true,
    lastRebuildMs: 100,
    globals: [
      { name: 'Length', value: 100, units: 'mm' },
      { name: 'Width', value: 60, units: 'mm' },
      { name: 'Thickness', value: thickness, units: 'mm' },
      { name: 'BoltCircle', value: 40, units: 'mm' },
    ],
    properties: { PartNo: 'P-1', Revision: 'A', Description: 'test' },
    features: [],
  };
}

describe('sheet metal', () => {
  it('passes a sane 1.5 mm part bent at 1×t', () => {
    const d = part(1.5);
    const found = analyseSheetMetal(d, evaluate(d), { t: 1.5, bendRadius: 1.5, bendCount: 2 });
    expect(found.filter((f) => f.severity === 'blocker')).toHaveLength(0);
  });

  it('blocks a bend radius tighter than the material', () => {
    const d = part(2);
    const found = analyseSheetMetal(d, evaluate(d), { t: 2, bendRadius: 0.5, bendCount: 2 });
    const r = found.find((f) => f.rule === 'dfm.sheet.min-bend-radius');
    expect(r?.severity).toBe('blocker');
  });

  it('warns when a hole falls inside the bend zone', () => {
    // 40 bolt circle on a 60-wide part leaves 20 − 2.5 = 17.5 mm; the zone is 2.5t + r.
    let d = part(2);
    d = createFeature(d, 'holePattern', { diameter: 5, boltCircleVar: 'BoltCircle' });
    d = setGlobal(d, 'BoltCircle', 52);

    const found = analyseSheetMetal(d, evaluate(d), { t: 2, bendRadius: 2, bendCount: 2 });
    expect(found.some((f) => f.rule === 'dfm.sheet.hole-to-bend')).toBe(true);
  });

  it('raises one finding for a whole hole pattern, not one per hole', () => {
    let d = part(2);
    d = createFeature(d, 'holePattern', { diameter: 5, boltCircleVar: 'BoltCircle' });
    d = setGlobal(d, 'BoltCircle', 52);

    const found = analyseSheetMetal(d, evaluate(d), { t: 2, bendRadius: 2, bendCount: 2 });
    expect(found.filter((f) => f.rule === 'dfm.sheet.hole-to-bend')).toHaveLength(1);
  });

  it('blocks a wall that differs from the sheet thickness', () => {
    const d = createFeature(part(2), 'shell', { thickness: 5 });
    const found = analyseSheetMetal(d, evaluate(d), { t: 2, bendRadius: 2, bendCount: 1 });
    expect(found.some((f) => f.rule === 'dfm.sheet.uniform-thickness')).toBe(true);
  });
});

describe('additive', () => {
  it('blocks a wall below two extrusion widths', () => {
    const d = createFeature(part(10), 'shell', { thickness: 0.5 });
    const found = analyseAdditive(d, evaluate(d), PACK_DEFAULTS.additive);
    const w = found.find((f) => f.rule === 'dfm.additive.min-wall');
    expect(w?.severity).toBe('blocker');
  });

  it('warns about a hole that will print undersize', () => {
    const d = createFeature(part(10), 'holePattern', { diameter: 1.2, boltCircle: 30 });
    const found = analyseAdditive(d, evaluate(d), PACK_DEFAULTS.additive);
    expect(found.some((f) => f.rule === 'dfm.additive.min-hole')).toBe(true);
  });

  it('warns about warp on a wide thin plate', () => {
    const d = part(1); // 100 × 60 × 1 → aspect 100
    const found = analyseAdditive(d, evaluate(d), PACK_DEFAULTS.additive);
    expect(found.some((f) => f.rule === 'dfm.additive.warp-risk')).toBe(true);
  });

  it('blocks a shelled part with no escape hole', () => {
    const d = createFeature(part(10), 'shell', { thickness: 2 });
    const found = analyseAdditive(d, evaluate(d), PACK_DEFAULTS.additive);
    const t = found.find((f) => f.rule === 'dfm.additive.trapped-cavity');
    expect(t?.severity).toBe('blocker');
  });

  it('clears the trapped-cavity finding once a hole is added', () => {
    let d = createFeature(part(10), 'shell', { thickness: 2 });
    d = createFeature(d, 'holePattern', { diameter: 6, boltCircle: 30 });
    const found = analyseAdditive(d, evaluate(d), PACK_DEFAULTS.additive);
    expect(found.some((f) => f.rule === 'dfm.additive.trapped-cavity')).toBe(false);
  });
});

describe('injection moulding', () => {
  it('blocks a part with no draft', () => {
    const d = part(2.5);
    const found = analyseMoulding(d, evaluate(d), { nominalWall: 2.5, draft: 0 });
    const dr = found.find((f) => f.rule === 'dfm.mould.draft');
    expect(dr?.severity).toBe('blocker');
  });

  it('warns when a section exceeds the nominal wall', () => {
    const d = part(6);
    const found = analyseMoulding(d, evaluate(d), { nominalWall: 2.5, draft: 1 });
    expect(found.some((f) => f.rule === 'dfm.mould.wall-variation')).toBe(true);
  });

  it('warns about a corner radius that is sharp for the wall', () => {
    const d = createFeature(part(4), 'fillet', { radius: 0.5 });
    const found = analyseMoulding(d, evaluate(d), { nominalWall: 4, draft: 1 });
    expect(found.some((f) => f.rule === 'dfm.mould.corner-radius')).toBe(true);
  });

  it('warns about a feature too thin to fill', () => {
    const d = createFeature(part(4), 'slot', { width: 20, height: 1 });
    const found = analyseMoulding(d, evaluate(d), { nominalWall: 4, draft: 1 });
    expect(found.some((f) => f.rule === 'dfm.mould.rib-proportion')).toBe(true);
  });
});

describe('pack dispatch', () => {
  it('routes to the requested pack', () => {
    const d = createFeature(part(1), 'shell', { thickness: 0.2 });
    const geom = evaluate(d);

    // The same geometry produces different findings per process — that is the point.
    const additive = analysePack('additive', d, geom).map((f) => f.rule);
    const sheet = analysePack('sheet', d, geom).map((f) => f.rule);

    expect(additive.some((r) => r.startsWith('dfm.additive'))).toBe(true);
    expect(sheet.some((r) => r.startsWith('dfm.sheet'))).toBe(true);
    expect(additive).not.toEqual(sheet);
  });

  it('returns an array for every pack without throwing', () => {
    const d = part();
    const geom = evaluate(d);
    for (const pack of ['sheet', 'additive', 'moulding'] as const) {
      expect(Array.isArray(analysePack(pack, d, geom))).toBe(true);
    }
  });
});

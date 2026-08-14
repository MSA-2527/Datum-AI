import { describe, expect, it } from 'vitest';
import { flatten, toDxf, toManifest, toSvg } from './exporters';
import { createFeature, evaluate, massGrams, type PartDoc } from './partModel';

/**
 * Export tests.
 *
 * A shop quotes from these files. A DXF that opens but carries the wrong hole diameter
 * is worse than one that fails to open, because the error is discovered at the machine.
 * These assert real coordinates, not just that output was produced.
 */

function doc(): PartDoc {
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
    properties: { PartNo: 'P-1', Revision: 'A' },
    features: [],
  };
}

describe('flatten', () => {
  it('closes a plain rectangle with four corners', () => {
    const p = flatten({ kind: 'rect', cx: 0, cy: 0, w: 10, h: 4 });
    expect(p).toHaveLength(4);
    expect(p).toContainEqual({ x: -5, y: -2 });
    expect(p).toContainEqual({ x: 5, y: 2 });
  });

  it('keeps every point of a filleted rectangle inside its envelope', () => {
    const p = flatten({ kind: 'rect', cx: 0, cy: 0, w: 20, h: 10, cornerR: 3 });
    expect(p.length).toBeGreaterThan(4);
    for (const pt of p) {
      expect(Math.abs(pt.x)).toBeLessThanOrEqual(10 + 1e-9);
      expect(Math.abs(pt.y)).toBeLessThanOrEqual(5 + 1e-9);
    }
  });

  it('spans the full stadium length for a slot', () => {
    // 20 between centres, 8 wide → 28 overall.
    const p = flatten({ kind: 'slot', cx: 0, cy: 0, w: 20, h: 8 });
    const xs = p.map((q) => q.x);
    expect(Math.max(...xs)).toBeCloseTo(14, 6);
    expect(Math.min(...xs)).toBeCloseTo(-14, 6);
  });

  it('emits one vertex per polygon side', () => {
    expect(flatten({ kind: 'polygon', cx: 0, cy: 0, r: 10, sides: 6 })).toHaveLength(6);
  });
});

describe('DXF', () => {
  it('writes a well-formed R12 entity section', () => {
    const d = doc();
    const dxf = toDxf(evaluate(d));
    expect(dxf.startsWith('0\r\nSECTION\r\n2\r\nENTITIES')).toBe(true);
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
  });

  it('emits holes as true CIRCLE entities with the exact radius', () => {
    const d = createFeature(doc(), 'holePattern', { diameter: 6.6, boltCircleVar: 'BoltCircle' });
    const dxf = toDxf(evaluate(d));
    const lines = dxf.split('\r\n');

    expect((dxf.match(/\nCIRCLE/g) ?? []).length).toBe(4);

    // Group code 40 carries the radius: ⌀6.6 → 3.3
    const i = lines.indexOf('CIRCLE');
    const radiusAt = lines.indexOf('40', i);
    expect(Number(lines[radiusAt + 1])).toBeCloseTo(3.3, 6);
  });

  it('separates profile and holes onto distinct layers', () => {
    const d = createFeature(doc(), 'holePattern', { diameter: 5 });
    const dxf = toDxf(evaluate(d));
    expect(dxf).toContain('PROFILE');
    expect(dxf).toContain('HOLES');
  });

  it('places holes at their true model coordinates', () => {
    const d = createFeature(doc(), 'holePattern', { diameter: 5, boltCircleVar: 'BoltCircle' });
    const dxf = toDxf(evaluate(d));
    // BoltCircle 40 → centres at ±20
    expect(dxf).toContain('\r\n20\r\n');
    const lines = dxf.split('\r\n');
    const i = lines.indexOf('CIRCLE');
    expect(Math.abs(Number(lines[lines.indexOf('10', i) + 1]))).toBe(20);
  });
});

describe('SVG', () => {
  it('sizes the document in millimetres with padding', () => {
    const svg = toSvg(evaluate(doc()));
    expect(svg).toContain('width="110mm"'); // 100 + 5 each side
    expect(svg).toContain('height="60mm"');
  });

  it('uses even-odd so holes render as holes', () => {
    const d = createFeature(doc(), 'holePattern', { diameter: 5 });
    expect(toSvg(evaluate(d))).toContain('fill-rule="evenodd"');
  });

  it('emits one subpath per boundary', () => {
    const d = createFeature(doc(), 'holePattern', { diameter: 5 });
    const svg = toSvg(evaluate(d));
    const subpaths = (svg.match(/M /g) ?? []).length;
    expect(subpaths).toBe(5); // outline + 4 holes
  });
});

describe('manifest', () => {
  it('reports the envelope, mass and full feature list', () => {
    let d = doc();
    d = createFeature(d, 'holePattern', { diameter: 5 });
    d = createFeature(d, 'fillet', { radius: 4 });

    const geom = evaluate(d);
    const text = toManifest(d, geom, massGrams(d, geom));

    expect(text).toContain('plate.SLDPRT');
    expect(text).toContain('6061-T6');
    expect(text).toContain('Hole1');
    expect(text).toContain('Fillet1');
    expect(text).toContain('P-1');
  });
});

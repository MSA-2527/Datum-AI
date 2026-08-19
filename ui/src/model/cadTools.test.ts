import { describe, expect, it } from 'vitest';
import {
  addFeature, defaultParams, emptyDocument, evaluateDocument, paramFields,
  type Document, type FeatureKind, type ParamValue,
} from './document';
import { bounds, triCount } from '../kernel/topo/mesh';

/**
 * The features a standard CAD package has and this one did not.
 *
 * Each is tested by what it removes or adds rather than by whether it ran. An operation that
 * reports success and hands back the solid it was given is the failure that hides, and this
 * application has already shipped one of those — fillet and chamfer were both no-ops on a plain
 * box for as long as primitives carried an automatic edge break.
 */

function on(kind: FeatureKind, params: Record<string, ParamValue> = {}): Document {
  let doc = emptyDocument();
  doc = addFeature(doc, 'box', { ...defaultParams('box'), length: 80, width: 60, height: 30 }, 'Base');
  doc = addFeature(doc, kind, { ...defaultParams(kind), ...params }, kind);
  return doc;
}

const solid = (doc: Document) => evaluateDocument(doc);
const BLOCK = 80 * 60 * 30;

describe('holes', () => {
  it('a through hole goes all the way through', () => {
    const ev = solid(on('hole', { holeType: 'through', diameter: 10 }));

    expect(ev.errors.size).toBe(0);
    expect(ev.health.closed).toBe(true);
    expect(BLOCK - ev.volume).toBeCloseTo(Math.PI * 25 * 30, -2);
  });

  it('a blind hole stops where it was told to', () => {
    const ev = solid(on('hole', { holeType: 'blind', diameter: 10, depth: 12 }));

    expect(ev.health.closed).toBe(true);
    expect(BLOCK - ev.volume).toBeCloseTo(Math.PI * 25 * 12, -2);
  });

  it('a counterbore removes the hole and the recess', () => {
    const ev = solid(on('hole', {
      holeType: 'counterbore', diameter: 8, counterDiameter: 14, counterDepth: 8,
    }));

    expect(ev.health.closed).toBe(true);

    const through = Math.PI * 16 * 30;
    const recess = (Math.PI * 49 - Math.PI * 16) * 8;
    expect(BLOCK - ev.volume).toBeCloseTo(through + recess, -2);
  });

  it('a countersink takes its depth from the head angle, not from a free number', () => {
    // At 90° included, the sink depth is exactly the difference in radii — a 16 mm sink on an
    // 8 mm hole is 4 mm deep. Offering the depth separately would let someone draw a
    // countersink no drill could cut.
    const ev = solid(on('hole', {
      holeType: 'countersink', diameter: 8, counterDiameter: 16, counterAngle: 90,
    }));

    expect(ev.health.closed).toBe(true);

    const through = Math.PI * 16 * 30;
    // A frustum from r=4 to r=8 over 4 mm, less the hole already through it.
    const frustum = (Math.PI * 4 / 3) * (16 + 64 + 32);
    expect(BLOCK - ev.volume).toBeCloseTo(through + frustum - Math.PI * 16 * 4, -2);
  });

  it('a tapped hole is drilled at the tapping size, not the thread size', () => {
    // An M6 tapped hole is a 5 mm drill. Cutting it at 6 mm leaves no material for the thread,
    // and the part looks right until someone tries to tap it.
    const m6 = solid(on('hole', { holeType: 'tapped', diameter: 6, depth: 20 }));
    const plain = solid(on('hole', { holeType: 'blind', diameter: 6, depth: 20 }));

    expect(BLOCK - m6.volume).toBeLessThan(BLOCK - plain.volume);
    expect(BLOCK - m6.volume).toBeCloseTo(Math.PI * 2.5 * 2.5 * 20, -2);
  });

  it('offers only the dimensions the chosen kind uses', () => {
    const sink = paramFields('hole', { ...defaultParams('hole'), holeType: 'countersink' }).map((x) => x.key);
    const bore = paramFields('hole', { ...defaultParams('hole'), holeType: 'counterbore' }).map((x) => x.key);

    expect(sink).toContain('counterAngle');
    expect(sink).not.toContain('counterDepth');
    expect(bore).toContain('counterDepth');
    expect(bore).not.toContain('counterAngle');
  });

  it('still drills a bolt circle', () => {
    const ev = solid(on('hole', {
      holeType: 'through', pattern: 'boltCircle', diameter: 6, boltCircle: 50, count: 6,
    }));

    expect(ev.health.closed).toBe(true);
    // Within 3%: six small holes are tessellated with fewer segments each, so the faceted
    // volume falls a little short of the true cylinder more visibly than one large hole does.
    const removed = BLOCK - ev.volume;
    expect(removed).toBeGreaterThan(Math.PI * 9 * 30 * 6 * 0.97);
    expect(removed).toBeLessThan(Math.PI * 9 * 30 * 6 * 1.03);
  });
});

describe('rib', () => {
  it('adds material standing on the part', () => {
    const ev = solid(on('rib', { length: 60, thickness: 5, height: 20, draft: 0 }));

    expect(ev.errors.size).toBe(0);
    expect(ev.health.closed).toBe(true);
    expect(ev.volume).toBeGreaterThan(BLOCK);
  });

  it('reaches the height it was given', () => {
    const ev = solid(on('rib', { length: 60, thickness: 5, height: 25, draft: 0 }));
    const bb = bounds(ev.mesh);

    // The block is 30 tall; the rib stands on it, sunk 2 mm in so the fusion has real overlap.
    expect(bb.max[2]! - bb.min[2]!).toBeCloseTo(30 + 25 - 2, 0);
  });

  it('is drafted, because a rib with parallel sides cannot leave a mould', () => {
    const straight = solid(on('rib', { length: 60, thickness: 6, height: 20, draft: 0 }));
    const drafted = solid(on('rib', { length: 60, thickness: 6, height: 20, draft: 3 }));

    expect(drafted.volume).toBeLessThan(straight.volume);
    expect(drafted.health.closed).toBe(true);
  });

  it('refuses to stand on nothing', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'rib', defaultParams('rib'), 'Rib');
    expect([...evaluateDocument(doc).errors.values()][0]).toMatch(/stand on/);
  });
});

describe('draft', () => {
  it('tapers the walls and removes material', () => {
    const ev = solid(on('draft', { angle: 3 }));

    expect(ev.errors.size).toBe(0);
    expect(ev.health.closed).toBe(true);
    expect(ev.volume).toBeLessThan(BLOCK);
    expect(ev.volume).toBeGreaterThan(BLOCK * 0.8);
  });

  it('leaves the footprint and the height alone, and pulls the top in', () => {
    const ev = solid(on('draft', { angle: 5 }));
    const bb = bounds(ev.mesh);

    expect(bb.max[0]! - bb.min[0]!).toBeCloseTo(80, 1);
    expect(bb.max[2]! - bb.min[2]!).toBeCloseTo(30, 1);
  });

  it('takes more material off at a steeper angle', () => {
    expect(solid(on('draft', { angle: 6 })).volume)
      .toBeLessThan(solid(on('draft', { angle: 2 })).volume);
  });

  it('does nothing at zero rather than rebuilding the solid', () => {
    expect(solid(on('draft', { angle: 0 })).volume).toBeCloseTo(BLOCK, 6);
  });

  it('refuses when there is nothing to taper', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'draft', defaultParams('draft'), 'Draft');
    expect([...evaluateDocument(doc).errors.values()][0]).toMatch(/nothing to draft/);
  });
});

describe('cutting with the swept and lofted features', () => {
  it('a loft set to cut removes material', () => {
    const ev = solid(on('loft', {
      operation: 'cut', height: 40, baseLength: 30, baseWidth: 30, topDiameter: 10,
    }));

    expect(ev.errors.size).toBe(0);
    expect(ev.volume).toBeLessThan(BLOCK);
    expect(triCount(ev.mesh)).toBeGreaterThan(0);
  });

  it('a sweep set to cut removes material', () => {
    const ev = solid(on('sweep', {
      operation: 'cut', path: 'line', distance: 60, diameter: 12,
    }));

    expect(ev.errors.size).toBe(0);
    expect(ev.volume).toBeLessThan(BLOCK);
  });
});

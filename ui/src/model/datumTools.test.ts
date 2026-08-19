import { describe, expect, it } from 'vitest';
import {
  addFeature, datumPlane, datumsIn, defaultParams, emptyDocument, evaluateDocument, paramFields,
  type Document, type FeatureKind, type ParamValue,
} from './document';
import { bounds, triCount } from '../kernel/topo/mesh';

/**
 * Dome, split and datum planes.
 *
 * Each is checked by what it does to the solid rather than by whether it ran. An operation that
 * reports success and hands back the solid it was given is the failure that hides — fillet and
 * chamfer were both silently no-ops for as long as primitives carried an automatic edge break,
 * and draft did nothing at all until its taper envelope was rebuilt.
 */

function on(kind: FeatureKind, params: Record<string, ParamValue> = {}): Document {
  let doc = emptyDocument();
  doc = addFeature(doc, 'box', { ...defaultParams('box'), length: 80, width: 60, height: 30 }, 'Base');
  doc = addFeature(doc, kind, { ...defaultParams(kind), ...params }, kind);
  return doc;
}

const BLOCK = 80 * 60 * 30;

describe('dome', () => {
  it('adds material and leaves the solid closed', () => {
    const ev = evaluateDocument(on('dome', { height: 12 }));

    expect(ev.errors.size).toBe(0);
    expect(ev.health.closed).toBe(true);
    expect(ev.health.manifold).toBe(true);
    expect(ev.volume).toBeGreaterThan(BLOCK);
  });

  it('reaches the height it was given, and no further', () => {
    const bb = bounds(evaluateDocument(on('dome', { height: 12 })).mesh);
    expect(bb.max[2]! - bb.min[2]!).toBeCloseTo(42, 0);
  });

  it('is a dome and not a raised block', () => {
    // A face that simply moved up would add height x area. A dome adds appreciably less,
    // because it falls away to nothing at the edge.
    const ev = evaluateDocument(on('dome', { height: 12 }));
    const slab = 80 * 60 * 12;

    expect(ev.volume - BLOCK).toBeLessThan(slab * 0.8);
    expect(ev.volume - BLOCK).toBeGreaterThan(slab * 0.2);
  });

  it('leaves the footprint alone, because it falls to zero at the edge', () => {
    // That is also what keeps it watertight: the boundary vertices are shared with the walls.
    const bb = bounds(evaluateDocument(on('dome', { height: 12 })).mesh);

    expect(bb.max[0]! - bb.min[0]!).toBeCloseTo(80, 6);
    expect(bb.max[1]! - bb.min[1]!).toBeCloseTo(60, 6);
  });

  it('domes downwards when asked', () => {
    const bb = bounds(evaluateDocument(on('dome', { height: 10, face: 'bottom' })).mesh);
    expect(bb.min[2]!).toBeCloseTo(-25, 0);
  });

  it('does nothing at zero height', () => {
    expect(evaluateDocument(on('dome', { height: 0 })).volume).toBeCloseTo(BLOCK, 6);
  });

  it('does not blow up the mesh of a part that is already dense', () => {
    // Subdivision splits every triangle — it has to, or the mesh develops T-junctions and
    // stops being closed — so the price is set by the whole part rather than by the face being
    // domed. A fixed four levels took a tessellated sphere from 3 800 triangles to 242 000 to
    // raise a bump worth a third of a percent of its volume.
    let doc = emptyDocument();
    doc = addFeature(doc, 'sphere', defaultParams('sphere'), 'Ball');
    doc = addFeature(doc, 'dome', defaultParams('dome'), 'Dome');
    const after = evaluateDocument(doc);

    expect(triCount(after.mesh)).toBeLessThan(60_000);
    expect(after.health.closed).toBe(true);
  });

  it('refuses when there is nothing to dome at all', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'dome', defaultParams('dome'), 'Dome');
    expect([...evaluateDocument(doc).errors.values()][0]).toMatch(/nothing to dome/i);
  });
});

describe('split', () => {
  it('keeps both halves, and together they are the whole part', () => {
    const ev = evaluateDocument(on('split', { plane: 'YZ', at: 0.5 }));

    expect(ev.errors.size).toBe(0);
    expect(ev.volume).toBeCloseTo(BLOCK, -1);
    expect(triCount(ev.mesh)).toBeGreaterThan(12);
  });

  it('keeps only the near half when told to', () => {
    const ev = evaluateDocument(on('split', { plane: 'YZ', at: 0.25, keep: 'first' }));
    const bb = bounds(ev.mesh);

    expect(ev.volume).toBeCloseTo(BLOCK * 0.25, -1);
    expect(bb.max[0]! - bb.min[0]!).toBeCloseTo(20, 0);
  });

  it('keeps only the far half when told to', () => {
    const ev = evaluateDocument(on('split', { plane: 'YZ', at: 0.25, keep: 'second' }));
    expect(ev.volume).toBeCloseTo(BLOCK * 0.75, -1);
  });

  it('cuts along the axis it was given', () => {
    const z = evaluateDocument(on('split', { plane: 'XY', at: 0.3, keep: 'first' }));
    const bb = bounds(z.mesh);

    expect(bb.max[2]! - bb.min[2]!).toBeCloseTo(9, 0);
    expect(bb.max[0]! - bb.min[0]!).toBeCloseTo(80, 0);
  });

  it('refuses when there is nothing to split', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'split', defaultParams('split'), 'Split');
    expect([...evaluateDocument(doc).errors.values()][0]).toMatch(/nothing to split/);
  });
});

describe('datum planes', () => {
  function withDatum(params: Record<string, ParamValue> = {}): Document {
    let doc = emptyDocument();
    doc = addFeature(doc, 'datum', { ...defaultParams('datum'), ...params }, 'Deck');
    return doc;
  }

  it('builds no geometry of its own', () => {
    const ev = evaluateDocument(withDatum());
    expect(triCount(ev.mesh)).toBe(0);
    expect(ev.errors.size).toBe(0);
  });

  it('sits where the offset puts it', () => {
    const doc = withDatum({ basePlane: 'XY', offset: 45 });
    const plane = datumPlane(datumsIn(doc)[0]!, doc);

    expect(plane.origin[2]).toBeCloseTo(45, 6);
    expect(plane.normal[2]!).toBeCloseTo(1, 6);
  });

  it('tilts about its own in-plane axes', () => {
    // "Tilt about X" has to mean the same thing on a datum parallel to Front as on one
    // parallel to Top, or the control means something different every time it is used.
    const doc = withDatum({ basePlane: 'XY', offset: 0, tiltY: 30 });
    const plane = datumPlane(datumsIn(doc)[0]!, doc);

    expect(Math.abs(plane.normal[2]!)).toBeCloseTo(Math.cos(Math.PI / 6), 4);
    expect(Math.hypot(plane.normal[0]!, plane.normal[1]!)).toBeCloseTo(Math.sin(Math.PI / 6), 4);
  });

  it('an extrude built on it starts there', () => {
    let doc = withDatum({ basePlane: 'XY', offset: 40 });
    doc = addFeature(doc, 'extrude', {
      ...defaultParams('extrude'), plane: 'datum', datumRef: 'Deck', distance: 10,
    }, 'Boss');

    const bb = bounds(evaluateDocument(doc).mesh);
    expect(bb.min[2]!).toBeCloseTo(40, 4);
    expect(bb.max[2]!).toBeCloseTo(50, 4);
  });

  it('uses the first datum when none has been named yet', () => {
    // Choosing "a datum plane" and then building on Top because the second control had not
    // been touched is a feature that silently does nothing. The user has already said where
    // they want it.
    let doc = withDatum({ basePlane: 'XY', offset: 40 });
    doc = addFeature(doc, 'extrude', {
      ...defaultParams('extrude'), plane: 'datum', distance: 10,
    }, 'Boss');

    expect(bounds(evaluateDocument(doc).mesh).min[2]!).toBeCloseTo(40, 4);
  });

  it('falls back to the named plane when the datum is gone', () => {
    // An older document, or one whose datum was deleted, still builds somewhere sensible
    // rather than going blank.
    let doc = emptyDocument();
    doc = addFeature(doc, 'extrude', {
      ...defaultParams('extrude'), plane: 'datum', datumRef: 'Missing', distance: 10,
    }, 'Boss');

    const ev = evaluateDocument(doc);
    expect(ev.errors.size).toBe(0);
    expect(triCount(ev.mesh)).toBeGreaterThan(0);
  });

  it('is offered as a plane only once one exists', () => {
    const bare = emptyDocument();
    const withOne = withDatum();

    const without = paramFields('extrude', defaultParams('extrude'), bare)
      .find((f) => f.key === 'plane')!;
    const with_ = paramFields('extrude', defaultParams('extrude'), withOne)
      .find((f) => f.key === 'plane')!;

    expect(without.choices!.map((c) => c.value)).not.toContain('datum');
    expect(with_.choices!.map((c) => c.value)).toContain('datum');
  });

  it('names the datums that exist, so one can be chosen rather than typed', () => {
    const doc = withDatum();
    const fields = paramFields(
      'extrude', { ...defaultParams('extrude'), plane: 'datum' }, doc,
    );

    const picker = fields.find((f) => f.key === 'datumRef');
    expect(picker).toBeDefined();
    expect(picker!.choices!.map((c) => c.label)).toEqual(['Deck']);
  });
});

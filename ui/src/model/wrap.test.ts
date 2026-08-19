import { describe, expect, it } from 'vitest';
import { addFeature, defaultParams, emptyDocument, evaluateDocument, type Document } from './document';
import { bounds } from '../kernel/topo/mesh';

/**
 * Wrap: a band of features rolled around a round part.
 *
 * Knurling, a gripping pattern, a retaining groove, a ring of flats — the same shape repeated
 * around an axis at a constant radius, which is what people reach for wrap to do on a turned
 * part. What it deliberately does not attempt is text on a cone or a sketch on a doubly-curved
 * surface; those need a surface parameterisation this kernel does not carry, and approximating
 * them badly would be worse than the limitation.
 */

function shaft(params: Record<string, unknown> = {}): Document {
  let doc = emptyDocument();
  doc = addFeature(doc, 'cylinder', { ...defaultParams('cylinder'), diameter: 40, height: 60 }, 'Shaft');
  doc = addFeature(doc, 'wrap', { ...defaultParams('wrap'), ...params } as never, 'Wrap');
  return doc;
}

const SHAFT = Math.PI * 20 * 20 * 60;

describe('engraving', () => {
  it('takes material off and leaves a closed solid', () => {
    const ev = evaluateDocument(shaft({ count: 16, depth: 1.5, width: 2, height: 30 }));

    expect(ev.errors.size).toBe(0);
    expect(ev.health.closed).toBe(true);
    expect(ev.volume).toBeLessThan(SHAFT);
  });

  it('takes more off with more teeth', () => {
    const few = evaluateDocument(shaft({ count: 8, depth: 1.5, width: 2, height: 30 }));
    const many = evaluateDocument(shaft({ count: 24, depth: 1.5, width: 2, height: 30 }));

    expect(many.volume).toBeLessThan(few.volume);
  });

  it('takes more off with a deeper cut', () => {
    const shallow = evaluateDocument(shaft({ count: 12, depth: 0.5, width: 2, height: 30 }));
    const deep = evaluateDocument(shaft({ count: 12, depth: 3, width: 2, height: 30 }));

    expect(deep.volume).toBeLessThan(shallow.volume);
  });

  it('leaves the part its overall size, because it cuts inwards', () => {
    const bb = bounds(evaluateDocument(shaft({ count: 16, depth: 1.5, width: 2, height: 30 })).mesh);

    expect(bb.max[0]! - bb.min[0]!).toBeCloseTo(40, 0);
    expect(bb.max[2]! - bb.min[2]!).toBeCloseTo(60, 1);
  });

  it('confines the band to the height it was given', () => {
    // A band 10 mm tall centred on the middle must not reach the ends of a 60 mm shaft.
    const ev = evaluateDocument(shaft({ count: 16, depth: 3, width: 2, height: 10, z: 0 }));
    const bb = bounds(ev.mesh);

    expect(bb.max[2]! - bb.min[2]!).toBeCloseTo(60, 1);
    expect(ev.health.closed).toBe(true);
  });
});

describe('embossing', () => {
  it('adds material rather than removing it', () => {
    const ev = evaluateDocument(shaft({
      count: 8, depth: 2, width: 3, height: 30, operation: 'add',
    }));

    expect(ev.errors.size).toBe(0);
    expect(ev.volume).toBeGreaterThan(SHAFT);
    expect(ev.health.closed).toBe(true);
  });

  it('stands proud of the surface it was rolled onto', () => {
    const ev = evaluateDocument(shaft({
      count: 8, depth: 2, width: 3, height: 30, operation: 'add',
    }));
    const bb = bounds(ev.mesh);

    expect(bb.max[0]! - bb.min[0]!).toBeGreaterThan(40);
  });
});

describe('what it refuses', () => {
  it('will not wrap around nothing', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'wrap', defaultParams('wrap'), 'Wrap');
    expect([...evaluateDocument(doc).errors.values()][0]).toMatch(/nothing to wrap/);
  });

  it('measures the radius off the part when none was given', () => {
    // The common case needs no measuring: a 40 mm shaft is wrapped at 20 mm.
    const ev = evaluateDocument(shaft({ count: 12, depth: 2, width: 2, height: 30 }));
    expect(ev.volume).toBeLessThan(SHAFT);
    expect(ev.volume).toBeGreaterThan(SHAFT * 0.9);
  });
});

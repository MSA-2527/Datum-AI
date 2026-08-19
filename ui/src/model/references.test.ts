import { describe, expect, it } from 'vitest';
import {
  addFeature, defaultParams, emptyDocument, evaluateDocument, parametersOf,
  referenceName, referenceScope, referenceScopeAt, renameFeature, updateFeature, type Document,
} from './document';
import { bounds } from '../kernel/topo/mesh';

/**
 * One feature's dimension, driving another's.
 *
 * Parameters were a flat global table: a feature could be driven by a named quantity, but
 * nothing in the document could be driven by anything else in the document. A wall that has
 * to be twice the plate thickness could only be typed twice and kept in step by hand, which
 * is the exact job a parametric modeller exists to do.
 */

function twoBoxes(): Document {
  let doc = emptyDocument();
  doc = addFeature(doc, 'box', { ...defaultParams('box'), length: 60, width: 40, height: 25 }, 'Base');
  doc = addFeature(doc, 'box', { ...defaultParams('box'), length: 20, width: 20, height: 10 }, 'Boss');
  return doc;
}

const size = (doc: Document) => {
  const bb = bounds(evaluateDocument(doc).mesh);
  return [bb.max[0]! - bb.min[0]!, bb.max[1]! - bb.min[1]!, bb.max[2]! - bb.min[2]!];
};

describe('naming a feature in an expression', () => {
  it('resolves a dimension of an earlier feature', () => {
    let doc = twoBoxes();
    doc = updateFeature(doc, doc.features[1]!.id, { length: 'Base.length / 2' });

    expect(parametersOf(doc)['Boss.length']).toBe(30);
  });

  it('rebuilds the solid to match, not just the number', () => {
    let doc = twoBoxes();
    doc = updateFeature(doc, doc.features[1]!.id, { length: 'Base.length * 2' });

    // The boss is now 120 long against the base's 60, so the solid grows in X and nowhere
    // else. A reference that resolves but does not reach the geometry is not a reference.
    expect(size(doc)[0]).toBeCloseTo(120, 3);
    expect(size(doc)[1]).toBeCloseTo(40, 3);
  });

  it('follows when the feature it names is edited', () => {
    let doc = twoBoxes();
    doc = updateFeature(doc, doc.features[1]!.id, { length: 'Base.length' });
    expect(size(doc)[0]).toBeCloseTo(60, 3);

    doc = updateFeature(doc, doc.features[0]!.id, { length: 200 });
    expect(size(doc)[0]).toBeCloseTo(200, 3);
  });

  it('mixes feature dimensions with global parameters', () => {
    let doc = twoBoxes();
    doc = { ...doc, globals: [{ name: 'clearance', value: 5, units: 'mm' }] };
    doc = updateFeature(doc, doc.features[1]!.id, { length: 'Base.length - 2 * clearance' });

    expect(parametersOf(doc)['Boss.length']).toBe(50);
  });

  it('chains through a feature that is itself an expression', () => {
    let doc = twoBoxes();
    doc = addFeature(doc, 'box', { ...defaultParams('box') }, 'Cap');
    doc = updateFeature(doc, doc.features[1]!.id, { length: 'Base.length / 2' });
    doc = updateFeature(doc, doc.features[2]!.id, { length: 'Boss.length / 3' });

    expect(parametersOf(doc)['Cap.length']).toBe(10);
  });
});

describe('what a reference name is', () => {
  it('turns a name written for people into one an expression can hold', () => {
    expect(referenceName('Mid-frame')).toBe('Mid_frame');
    expect(referenceName('Camera lens 1')).toBe('Camera_lens_1');
    expect(referenceName('  Base  ')).toBe('Base');
  });

  it('does not produce a name starting with a digit', () => {
    // `3rd bracket` would tokenise as the number 3 followed by a name.
    expect(referenceName('3rd bracket')).toBe('_3rd_bracket');
  });

  it('follows a rename, because that is what anyone would expect', () => {
    let doc = twoBoxes();
    doc = renameFeature(doc, doc.features[0]!.id, 'Plate');

    expect(parametersOf(doc)['Plate.length']).toBe(60);
    expect(parametersOf(doc)['Base.length']).toBeUndefined();
  });

  it('gives the first of two features sharing a name the plain one', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'box', { ...defaultParams('box'), length: 60 }, 'Rib');
    doc = addFeature(doc, 'box', { ...defaultParams('box'), length: 90 }, 'Rib');

    const values = parametersOf(doc);
    expect(values['Rib.length']).toBe(60);
    expect(values['Rib_2.length']).toBe(90);
  });
});

describe('what it refuses', () => {
  it('cannot name a feature that comes later, so a cycle cannot be written', () => {
    // The tree builds each feature onto what precedes it. Keeping references to the same
    // direction makes circularity impossible rather than something to detect afterwards.
    let doc = twoBoxes();
    doc = updateFeature(doc, doc.features[0]!.id, { length: 'Boss.length' });

    expect(parametersOf(doc)['Base.length']).toBeUndefined();
  });

  it('leaves a feature on its default rather than at zero when a reference is unknown', () => {
    let doc = twoBoxes();
    doc = updateFeature(doc, doc.features[1]!.id, { length: 'Nonexistent.length' });

    // 60 from the base alone: the boss fell back to its own default, which is inside it.
    expect(size(doc)[0]).toBeCloseTo(60, 3);
    expect(evaluateDocument(doc).health.closed).toBe(true);
  });
});

describe('discovering what can be named', () => {
  it('lists parameters and feature dimensions with their values', () => {
    let doc = twoBoxes();
    doc = { ...doc, globals: [{ name: 'clearance', value: 5, units: 'mm' }] };

    const scope = referenceScope(doc);
    expect(scope.find((s) => s.name === 'clearance')).toEqual(
      { name: 'clearance', value: 5, from: 'parameter' },
    );
    expect(scope.find((s) => s.name === 'Base.height')).toEqual(
      { name: 'Base.height', value: 25, from: 'feature' },
    );
  });

  it('offers a feature only what comes before it', () => {
    // The editor must not suggest a name that will not resolve. A feature cannot be driven by
    // one that is built after it, so `Boss` is not on offer while editing `Base`.
    const doc = twoBoxes();

    const atBase = referenceScopeAt(doc, doc.features[0]!.id).map((r) => r.name);
    const atBoss = referenceScopeAt(doc, doc.features[1]!.id).map((r) => r.name);

    expect(atBase).not.toContain('Base.length');
    expect(atBase).not.toContain('Boss.length');
    expect(atBoss).toContain('Base.length');
    expect(atBoss).not.toContain('Boss.length');
  });

  it('puts the named parameters first, where someone would look', () => {
    let doc = twoBoxes();
    doc = { ...doc, globals: [{ name: 'clearance', value: 5, units: 'mm' }] };

    expect(referenceScope(doc)[0]!.from).toBe('parameter');
  });
});

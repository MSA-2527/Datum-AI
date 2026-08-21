import { describe, expect, it } from 'vitest';
import { applyEdit, readEdit, resolveTarget } from './edit';
import {
  addFeature, defaultParams, emptyDocument, evaluateDocument, type Document,
} from '../model/document';
import { bounds } from '../kernel/topo/mesh';

/**
 * Editing the model that is already open.
 *
 * Every request used to start a new document, so "make the wall 2 mm thicker" was impossible —
 * not because the modeller could not do it, but because the assistant had exactly one verb.
 *
 * The design rule these tests are mostly about: an edit that cannot be understood is refused
 * with the reason rather than applied approximately. A modeller that sometimes does something
 * *near* what you asked is worse than one that says it did not follow you.
 */

function bracket(): Document {
  let doc = emptyDocument('Bracket');
  doc = addFeature(doc, 'box', {
    ...defaultParams('box'), length: 100, width: 60, height: 8,
  }, 'Base plate');
  doc = addFeature(doc, 'hole', {
    ...defaultParams('hole'), diameter: 8, pattern: 'boltCircle', boltCircle: 40, count: 4,
  }, 'Bolt holes');
  return doc;
}

const size = (doc: Document) => {
  const bb = bounds(evaluateDocument(doc).mesh);
  return [bb.max[0]! - bb.min[0]!, bb.max[2]! - bb.min[2]!];
};

describe('finding what the user meant', () => {
  it('matches a feature by its exact name', () => {
    expect(resolveTarget(bracket(), 'Base plate').id).toBeTruthy();
  });

  it('matches a partial name when only one thing fits', () => {
    expect(resolveTarget(bracket(), 'holes').id).toBeTruthy();
  });

  it('refuses an ambiguous name rather than picking one', () => {
    // "the plate" on a model with `Base plate` and `Top plate` is genuinely ambiguous, and
    // choosing silently edits the wrong part of someone's model.
    let doc = bracket();
    doc = addFeature(doc, 'box', defaultParams('box'), 'Top plate');

    const r = resolveTarget(doc, 'plate');
    expect(r.id).toBeUndefined();
    expect(r.problem).toMatch(/could be/);
  });

  it('lists what does exist when nothing matches', () => {
    const r = resolveTarget(bracket(), 'flange');
    expect(r.problem).toContain('Base plate');
    expect(r.problem).toContain('Bolt holes');
  });
});

describe('changing a dimension', () => {
  it('reads and applies a thickness change', () => {
    const doc = bracket();
    const edit = readEdit('make the base plate 20 mm thick', doc)!;

    expect(edit).toMatchObject({ kind: 'set', parameter: 'height', value: 20 });

    const after = applyEdit(doc, edit);
    expect(after.ok).toBe(true);
    expect(size(after.doc)[1]).toBeCloseTo(20, 6);
  });

  it('changes a hole diameter', () => {
    const doc = bracket();
    const edit = readEdit('the bolt holes should be 12 mm diameter', doc)!;
    const after = applyEdit(doc, edit);

    expect(after.ok).toBe(true);
    expect(after.doc.features[1]!.params.diameter).toBe(12);
  });

  it('works out the target when only one feature has that parameter', () => {
    const doc = bracket();
    // Only the box has a width.
    const edit = readEdit('make it 90 mm wide', doc)!;
    expect(edit).toMatchObject({ kind: 'set', parameter: 'width', value: 90 });
  });

  it('refuses a parameter the feature does not have, rather than writing a key nothing reads', () => {
    // Writing an unknown key would look like success and change nothing at all.
    const doc = bracket();
    const r = applyEdit(doc, { kind: 'set', target: 'Base plate', parameter: 'pitch', value: 4 });

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/has no "pitch"/);
    expect(r.message).toContain('length');
  });
});

describe('the other verbs', () => {
  it('adds a feature', () => {
    const doc = bracket();
    const edit = readEdit('add a 3 mm fillet', doc)!;

    expect(edit).toMatchObject({ kind: 'add', feature: 'fillet' });
    const after = applyEdit(doc, edit);
    expect(after.doc.features).toHaveLength(3);
  });

  it('deletes a feature by name', () => {
    const doc = bracket();
    const after = applyEdit(doc, readEdit('delete the bolt holes', doc)!);

    expect(after.ok).toBe(true);
    expect(after.doc.features).toHaveLength(1);
  });

  it('suppresses without deleting, so it can come back', () => {
    const doc = bracket();
    const off = applyEdit(doc, readEdit('turn off the bolt holes', doc)!);

    expect(off.doc.features).toHaveLength(2);
    expect(off.doc.features[1]!.suppressed).toBe(true);

    const on = applyEdit(off.doc, readEdit('turn on the bolt holes', off.doc)!);
    expect(on.doc.features[1]!.suppressed).toBe(false);
  });

  it('renames', () => {
    const doc = bracket();
    const after = applyEdit(doc, readEdit('rename Base plate to Web', doc)!);

    expect(after.ok).toBe(true);
    expect(after.doc.features[0]!.name).toBe('Web');
  });
});

describe('what is not an edit', () => {
  it('an empty document has nothing to edit', () => {
    // The first request in a session is a build, not a change.
    expect(readEdit('make it 20 mm thick', emptyDocument())).toBeNull();
  });

  it('a fresh request is not read as an edit', () => {
    expect(readEdit('a gearbox', bracket())).toBeNull();
    expect(readEdit('build me a car', bracket())).toBeNull();
  });

  it('a dimension that could belong to two features is not guessed at', () => {
    // Both boxes have a length, so "make it 200 mm long" does not say which.
    let doc = bracket();
    doc = addFeature(doc, 'box', defaultParams('box'), 'Web');

    expect(readEdit('make it 200 mm long', doc)).toBeNull();
  });
});

describe('the edit reaches the geometry', () => {
  it('a thickness change rebuilds the solid', () => {
    // The test that matters: the parameter changed *and* the part is different.
    const doc = bracket();
    const before = evaluateDocument(doc).volume;

    const after = applyEdit(doc, readEdit('make the base plate 24 mm thick', doc)!);
    expect(evaluateDocument(after.doc).volume).toBeGreaterThan(before * 2);
  });
});

describe('the auto-numbered names features actually have', () => {
  it('matches "the fillet" against a feature called Fillet1', () => {
    // Features are auto-named Fillet1, Box2, Sheet metal1 — and nobody types the number.
    // "Turn off the fillet" fell through to building a new document, which is the worst
    // possible answer to a request to switch something off.
    let doc = emptyDocument();
    doc = addFeature(doc, 'box', defaultParams('box'));
    doc = addFeature(doc, 'fillet', defaultParams('fillet'));

    const edit = readEdit('turn off the fillet', doc);
    expect(edit).toMatchObject({ kind: 'suppress' });

    const after = applyEdit(doc, edit!);
    expect(after.ok).toBe(true);
    expect(after.doc.features[1]!.suppressed).toBe(true);
  });

  it('prefers the longer name when two could match', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'box', defaultParams('box'), 'Base');
    doc = addFeature(doc, 'box', defaultParams('box'), 'Base plate');

    expect(readEdit('delete the base plate', doc)).toMatchObject({
      kind: 'remove', target: 'Base plate',
    });
  });
});

describe('an edit is not rescaled afterwards', () => {
  it('changes only what it was asked to change', async () => {
    // The bug this guards: the requirement reader and the edit reader legitimately understand
    // the same words differently. "Make the bracket 5 mm thick" is a thickness parameter to
    // one and an overall height to the other, and the correction pass resolved that
    // disagreement by scaling a folded bracket from 11.6 cm³ to 0.05 cm³ — while reporting
    // that everything asked for had been met.
    const { useModel } = await import('../modelStore');
    const { emptyDocument: empty, evaluateDocument: evaluate } = await import('../model/document');

    const doc = empty();
    useModel.setState({
      doc, evaluated: evaluate(doc),
      selectedFeatureId: null, editingFeatureId: null, selectedFaces: [],
      undoStack: [], redoStack: [], notice: null,
    });

    useModel.getState().addFeature('sheet');
    const before = evaluate(useModel.getState().doc).volume;

    await useModel.getState().build('make the sheet metal 5 mm thick');
    const after = evaluate(useModel.getState().doc).volume;

    // Thicker material, so more of it — and emphatically not a two-hundredth of it.
    expect(after).toBeGreaterThan(before);
    expect(useModel.getState().doc.features[0]!.params.thickness).toBe(5);
  });
});

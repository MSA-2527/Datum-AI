import { describe, expect, it } from 'vitest';
import { bodyIndex, faceColours } from './ModelViewport';
import {
  addFeature, deserialise, emptyDocument, evaluateDocument, serialise, type Document,
} from '../model/document';
import { appearanceFor, toHex } from '../lib/appearance';

/**
 * What the viewport paints, decided from the document alone.
 *
 * The complaint this answers was that every part came out the same grey, which makes an
 * assembly unreadable — you cannot see where one component ends and the next begins. The
 * rules that fix it are easy to get subtly wrong in the other direction, so each is pinned:
 * a fillet must not be a different colour from the face it blends, and two components must
 * not be the same colour just because neither names a material.
 */

/** The colour of the first face the document actually has. */
function colourOf(doc: Document): string {
  const owner = evaluateDocument(doc).faceOwner;
  const rgb = faceColours(owner, doc)!;
  const face = [...owner.keys()][0]!;
  return toHex([rgb[face * 3]!, rgb[face * 3 + 1]!, rgb[face * 3 + 2]!]);
}

function twoBodies(): Document {
  let doc = emptyDocument();
  doc = addFeature(doc, 'box', { length: 40, width: 40, height: 10, operation: 'add' }, 'Base');
  doc = addFeature(doc, 'cylinder', { diameter: 20, height: 30, operation: 'place' }, 'Post');
  return doc;
}

describe('what counts as one body', () => {
  it('keeps a feature that modifies the solid with the solid it modifies', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'box', { length: 40, width: 40, height: 10, operation: 'add' }, 'Base');
    doc = addFeature(doc, 'fillet', { radius: 2 }, 'Edges');

    const bodies = bodyIndex(doc);
    expect(new Set(bodies.values()).size).toBe(1);
  });

  it('starts a new body at a placed feature', () => {
    const doc = twoBodies();
    const bodies = bodyIndex(doc);
    expect(bodies.get(doc.features[0]!.id)).toBe(0);
    expect(bodies.get(doc.features[1]!.id)).toBe(1);
  });

  it('does not open an empty body when the first feature is itself placed', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'box', { length: 10, width: 10, height: 10, operation: 'place' }, 'A');
    expect(bodyIndex(doc).get(doc.features[0]!.id)).toBe(0);
  });
});

describe('the colour each face gets', () => {
  it('paints a single part in its material, not an arbitrary hue', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'box', { length: 40, width: 40, height: 10, operation: 'add' }, 'Base');
    doc = { ...doc, material: 'Brass C360' };

    expect(colourOf(doc)).toBe(toHex(appearanceFor('brass').rgb));
  });

  it('gives a fillet the same colour as the part it belongs to', () => {
    // The bug this guards: colouring per feature, so the blend round an edge came out a
    // different shade from both faces it joins.
    let doc = emptyDocument();
    doc = addFeature(doc, 'box', { length: 40, width: 40, height: 10, operation: 'add' }, 'Base');
    doc = addFeature(doc, 'fillet', { radius: 2 }, 'Edges');

    const owner = evaluateDocument(doc).faceOwner;
    const rgb = faceColours(owner, doc)!;
    const seen = new Set<string>();
    for (const face of owner.keys()) {
      seen.add(toHex([rgb[face * 3]!, rgb[face * 3 + 1]!, rgb[face * 3 + 2]!]));
    }
    expect(seen.size).toBe(1);
  });

  it('tells two bodies apart when neither names a material', () => {
    const doc = twoBodies();
    const owner = evaluateDocument(doc).faceOwner;
    const bodies = bodyIndex(doc);
    const rgb = faceColours(owner, doc)!;

    const byBody = new Map<number, string>();
    for (const [face, id] of owner) {
      byBody.set(bodies.get(id)!, toHex([rgb[face * 3]!, rgb[face * 3 + 1]!, rgb[face * 3 + 2]!]));
    }

    expect(byBody.size).toBe(2);
    expect(byBody.get(0)).not.toBe(byBody.get(1));
  });

  it('uses the real material when the bodies are made of different things', () => {
    let doc = twoBodies();
    doc = {
      ...doc,
      features: doc.features.map((f, i) => ({
        ...f,
        params: { ...f.params, material: i === 0 ? 'aluminium' : 'brass' },
      })),
    };

    const owner = evaluateDocument(doc).faceOwner;
    const bodies = bodyIndex(doc);
    const rgb = faceColours(owner, doc)!;

    for (const [face, id] of owner) {
      const want = bodies.get(id) === 0 ? 'aluminium' : 'brass';
      expect(toHex([rgb[face * 3]!, rgb[face * 3 + 1]!, rgb[face * 3 + 2]!]))
        .toBe(toHex(appearanceFor(want).rgb));
    }
  });

  it('a chosen colour beats the material', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'box', { length: 40, width: 40, height: 10, operation: 'add' }, 'Base');
    doc = { ...doc, material: 'Brass C360' };
    doc = {
      ...doc,
      features: doc.features.map((f) => ({ ...f, params: { ...f.params, colour: '#ff0000' } })),
    };

    expect(colourOf(doc)).toBe('#ff0000');
  });

  it('ignores a colour that is not one, rather than painting the part black', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'box', { length: 40, width: 40, height: 10, operation: 'add' }, 'Base');
    doc = { ...doc, material: 'Brass C360' };
    doc = {
      ...doc,
      features: doc.features.map((f) => ({ ...f, params: { ...f.params, colour: 'red' } })),
    };

    expect(colourOf(doc)).toBe(toHex(appearanceFor('brass').rgb));
  });

  it('has an entry for every face the mesh reports', () => {
    // The shader indexes this array by face id. A short array reads zeros and paints black.
    const doc = twoBodies();
    const owner = evaluateDocument(doc).faceOwner;
    const rgb = faceColours(owner, doc)!;
    const highest = Math.max(...owner.keys());
    expect(rgb.length).toBe((highest + 1) * 3);
  });

  it('survives being saved and reopened', () => {
    // Appearance chosen in a session and lost on save would be worse than no control at all:
    // the assembly comes back as one grey mass and the work has to be done again.
    let doc = emptyDocument();
    doc = addFeature(doc, 'box', { length: 40, width: 40, height: 10, operation: 'add' }, 'Base');
    doc = {
      ...doc,
      features: doc.features.map((f) => ({ ...f, params: { ...f.params, colour: '#ff0000' } })),
    };

    const reopened = deserialise(serialise(doc))!;
    expect(colourOf(reopened)).toBe('#ff0000');
  });

  it('returns nothing for an empty document, so the renderer keeps its own colour', () => {
    expect(faceColours(new Map(), emptyDocument())).toBeNull();
  });
});

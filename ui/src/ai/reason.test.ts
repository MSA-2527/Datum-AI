import { describe, expect, it } from 'vitest';
import { decompose } from './decompose';
import { rescale, reasonAbout, stateRequirements } from './reason';
import { addFeature, defaultParams, emptyDocument, evaluateDocument } from '../model/document';
import { bounds } from '../kernel/topo/mesh';

/**
 * Reasoning about a request, offline.
 *
 * The assistant "just gives something generally found or one from the saved library" was a fair
 * description of the offline path. It matched a recipe by name, built it at its designed size,
 * and reported success — so "a 400 mm long bracket" came back at 180 mm. The number had been
 * read and then discarded, and nothing in the pipeline ever asked whether the answer matched
 * the question.
 */

const offline = { config: { id: 'none' } as never };
const size = (doc: Parameters<typeof evaluateDocument>[0]) => {
  const bb = bounds(evaluateDocument(doc).mesh);
  return [bb.max[0]! - bb.min[0]!, bb.max[1]! - bb.min[1]!, bb.max[2]! - bb.min[2]!];
};

describe('the request is checked against the result', () => {
  it('builds a cup to the height that was asked for', async () => {
    const r = await decompose('a cup 140 mm tall', offline);

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(size(r.doc)[2]).toBeCloseTo(140, 0);
    expect(r.reasoning.satisfied).toBe(true);
  });

  it('says so when a requirement could not be met, rather than looking finished', async () => {
    // The honest half. Not every request can be satisfied by scaling, and a part that quietly
    // comes out at half the stated size is worse than one that says it did.
    const r = await decompose('a cup 140 mm tall and 500 mm wide', offline);

    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Two dimensions demanding different factors cannot both be met by one scale.
    expect(r.reasoning.satisfied).toBe(false);
    expect(r.message).toMatch(/did not come out right/);
  });

  it('keeps the steps it took, so the conclusion can be inspected', async () => {
    const r = await decompose('a cup 140 mm tall', offline);
    if (!r.ok) return;

    const names = r.reasoning.steps.map((s) => s.name);
    expect(names).toContain('What was asked for');
    expect(names).toContain('Approach');
    expect(names).toContain('Check');
  });

  it('leaves a request that stated nothing exactly as designed', async () => {
    // Nothing was asked, so nothing is judged and nothing is scaled. Inventing a requirement
    // and then satisfying it would be reasoning about a question nobody put.
    const plain = await decompose('a cup', offline);
    const before = plain.ok ? size(plain.doc) : [];

    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.reasoning.requirements).toEqual([]);
    expect(before[2]).toBeGreaterThan(0);
  });

  it('holds a recipe to the same standard as anything else', async () => {
    const r = await decompose('a phone 200 mm long', offline);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route).toBe('recipe');
    expect(size(r.doc)[0]).toBeCloseTo(200, 0);
  });
});

describe('scaling a document', () => {
  function plate() {
    let doc = emptyDocument();
    doc = addFeature(doc, 'box', { ...defaultParams('box'), length: 100, width: 50, height: 10 }, 'P');
    return doc;
  }

  it('changes every dimension by the same factor', () => {
    const s = size(rescale(plate(), 2));
    expect(s).toEqual([200, 100, 20]);
  });

  it('moves placements too, so an assembly does not come apart', () => {
    let doc = plate();
    doc = addFeature(doc, 'box', { ...defaultParams('box'), operation: 'place' }, 'Q');
    doc = {
      ...doc,
      features: doc.features.map((f, i) =>
        i === 1 ? { ...f, placement: { x: 100, y: 0, z: 0, rx: 0, ry: 0, rz: 0 } } : f),
    };

    const scaled = rescale(doc, 2);
    expect(scaled.features[1]!.placement!.x).toBe(200);
  });

  it('does not scale angles or counts', () => {
    // The first draft multiplied everything numeric and turned a 4-bolt pattern into a
    // 6.8-bolt one.
    let doc = emptyDocument();
    doc = addFeature(doc, 'hole', {
      ...defaultParams('hole'), pattern: 'boltCircle', boltCircle: 60, count: 4,
    }, 'H');

    const scaled = rescale(doc, 1.7);
    expect(scaled.features[0]!.params.count).toBe(4);
    expect(scaled.features[0]!.params.boltCircle).toBeCloseTo(102, 6);
  });

  it('refuses a factor that is not a correction but a different part', () => {
    // A hundredfold scale is not an adjustment to what was asked for; it means something was
    // misread, and acting on it produces a part nobody can relate to their request.
    expect(size(rescale(plate(), 500))).toEqual(size(plate()));
    expect(size(rescale(plate(), 0))).toEqual(size(plate()));
  });

  it('drops a mass that no longer describes the part', () => {
    const doc = { ...plate(), knownMassGrams: 250 };
    expect(rescale(doc, 2).knownMassGrams).toBeUndefined();
  });
});

describe('stating the standard before building', () => {
  it('fixes what will be judged in advance', () => {
    // Decided before anything is built. Working out afterwards what the request "really meant"
    // is how a generator talks itself into accepting whatever it produced.
    const { requirements, step } = stateRequirements('a 400 mm long bracket in 6061');

    expect(requirements.map((r) => r.kind).sort()).toEqual(['length', 'material']);
    expect(step.finding).toContain('400 mm');
  });
});

describe('the chain over a document built elsewhere', () => {
  it('corrects it and records that it did', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'box', { ...defaultParams('box'), length: 100, width: 50, height: 10 }, 'P');

    const out = reasonAbout('a 200 mm long block', doc, 'A box.');

    expect(size(out.doc)[0]).toBeCloseTo(200, 6);
    expect(out.reasoning.satisfied).toBe(true);
    expect(out.reasoning.steps.some((s) => s.acted)).toBe(true);
  });
});

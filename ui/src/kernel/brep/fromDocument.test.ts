import { describe, expect, it } from 'vitest';
import { exactFromDocument, planExact } from './fromDocument';
import {
  addFeature, defaultParams, emptyDocument, evaluateDocument, type Document,
} from '../../model/document';

/**
 * Converting a DATUM document to exact geometry.
 *
 * The risk this guards against is a conversion that is exact and *not the part on screen*. Not
 * every feature has an exact counterpart yet, and a conversion that silently omitted a third of
 * a model would be worse than not offering one — it would be discovered at the machine.
 *
 * So most of these are about what it says it dropped, and about the numbers agreeing with the
 * mesh kernel to the accuracy the mesh kernel is capable of.
 */

const SLOW = { timeout: 300_000 };

function withBox(): Document {
  let doc = emptyDocument();
  doc = addFeature(doc, 'box', {
    ...defaultParams('box'), length: 60, width: 40, height: 25,
  }, 'Base');
  return doc;
}

describe('planning the conversion', () => {
  it('carries the primitives it can express', () => {
    let doc = withBox();
    doc = addFeature(doc, 'cylinder', {
      ...defaultParams('cylinder'), diameter: 10, height: 100, operation: 'cut',
    }, 'Bore');

    const plan = planExact(doc);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[1]!.op).toBe('cut');
    expect(plan.dropped).toEqual([]);
  });

  it('names what it cannot carry rather than dropping it quietly', () => {
    let doc = withBox();
    doc = addFeature(doc, 'sweep', defaultParams('sweep'), 'Spring');
    doc = addFeature(doc, 'wrap', defaultParams('wrap'), 'Knurl');

    expect(planExact(doc).dropped).toEqual(['Spring', 'Knurl']);
  });

  it('takes a datum as no loss, because it builds nothing', () => {
    let doc = withBox();
    doc = addFeature(doc, 'datum', defaultParams('datum'), 'Deck');

    expect(planExact(doc).dropped).toEqual([]);
  });

  it('skips a suppressed feature, as the mesh kernel does', () => {
    let doc = withBox();
    doc = addFeature(doc, 'cylinder', defaultParams('cylinder'), 'Boss');
    doc = { ...doc, features: doc.features.map((f, i) => (i === 1 ? { ...f, suppressed: true } : f)) };

    expect(planExact(doc).steps).toHaveLength(1);
  });

  it('resolves an expression to whatever it currently comes to', () => {
    let doc = emptyDocument();
    doc = { ...doc, globals: [{ name: 'side', value: 80, units: 'mm' }] };
    doc = addFeature(doc, 'box', {
      ...defaultParams('box'), length: 'side', width: 'side / 2', height: 10,
    }, 'Plate');

    expect(planExact(doc).steps[0]!.primitive.size).toEqual([80, 40, 10]);
  });

  it('keeps the larger of two fillets and says the other was dropped', () => {
    // The exact builder takes one blend at the end. Applying one radius everywhere and calling
    // it the model would be a quiet lie about what was converted.
    let doc = withBox();
    doc = addFeature(doc, 'fillet', { ...defaultParams('fillet'), radius: 2 }, 'Small');
    doc = addFeature(doc, 'fillet', { ...defaultParams('fillet'), radius: 6 }, 'Large');

    const plan = planExact(doc);
    expect(plan.fillet).toBe(6);
    expect(plan.dropped).toEqual(['Large']);
  });
});

describe('the conversion itself', () => {
  it('agrees with the mesh kernel, and is more accurate than it', SLOW, async () => {
    // A box has no curved surfaces, so both kernels get it exactly right and the two agree.
    const doc = withBox();
    const approximate = evaluateDocument(doc);
    const exact = (await exactFromDocument(doc))!;

    expect(exact.volume).toBeCloseTo(60 * 40 * 25, 6);
    expect(approximate.volume).toBeCloseTo(exact.volume, 3);
  });

  it('is measurably better where the mesh kernel has to approximate', SLOW, async () => {
    // A drilled hole is where the difference shows: the mesh kernel cuts a 24-sided prism.
    let doc = withBox();
    doc = addFeature(doc, 'cylinder', {
      ...defaultParams('cylinder'), diameter: 10, height: 100, operation: 'cut',
    }, 'Bore');

    const approximate = evaluateDocument(doc).volume;
    const exact = (await exactFromDocument(doc))!.volume;
    const truth = 60 * 40 * 25 - Math.PI * 25 * 25;

    expect(Math.abs(exact - truth)).toBeLessThan(Math.abs(approximate - truth));
    expect(exact).toBeCloseTo(truth, 3);
  });

  it('says what it carried and what it did not', SLOW, async () => {
    let doc = withBox();
    doc = addFeature(doc, 'wrap', defaultParams('wrap'), 'Knurl');

    const r = (await exactFromDocument(doc))!;
    expect(r.message).toMatch(/Rebuilt exactly/);
    expect(r.message).toMatch(/could not be carried across: Knurl/);
  });

  it('applies the fillet as a true blend', SLOW, async () => {
    let doc = withBox();
    doc = addFeature(doc, 'fillet', { ...defaultParams('fillet'), radius: 5 }, 'Round');

    const r = (await exactFromDocument(doc))!;

    // 6 faces, 12 edge blends, 8 corner patches — the corners the swept-tool approach cannot do.
    expect(r.faces).toBe(26);
    expect(r.problem).toBeUndefined();
  });

  it('returns nothing for a document with nothing it can build', SLOW, async () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'sweep', defaultParams('sweep'), 'Spring');

    expect(await exactFromDocument(doc)).toBeNull();
  });
});

/**
 * The number worth publishing.
 *
 * Every claim this project makes about accuracy reduces to one comparison: what the exact
 * kernel returns for a shape whose volume is known in closed form, against what the mesh
 * kernel returns for the same shape. It is the strongest figure in the repository and it was
 * visible only in a notice that appears after a user presses a button.
 *
 * Asserted here so it cannot drift, and so the README can quote it without anyone having to
 * re-measure by hand.
 */
describe('exact against the closed form', () => {
  const D = 50;
  const H = 80;
  const TRUTH = Math.PI * (D / 2) ** 2 * H;   // 157 079.63267… mm³

  it('returns a turned volume to five significant figures', SLOW, async () => {
    const doc = addFeature(
      emptyDocument('Cylinder'),
      'cylinder', { ...defaultParams('cylinder'), diameter: D, height: H }, 'Body',
    );

    const exact = (await exactFromDocument(doc))!;

    // Five significant figures on 157 079.63 is ±1.6 mm³.
    expect(Math.abs(exact.volume - TRUTH)).toBeLessThan(TRUTH * 1e-5);
  });

  it('beats the tessellated kernel by the margin the README states', SLOW, async () => {
    const doc = addFeature(
      emptyDocument('Cylinder'),
      'cylinder', { ...defaultParams('cylinder'), diameter: D, height: H }, 'Body',
    );

    const approximate = evaluateDocument(doc).volume;
    const exact = (await exactFromDocument(doc))!.volume;

    const meshError = Math.abs(approximate - TRUTH) / TRUTH;
    const exactError = Math.abs(exact - TRUTH) / TRUTH;

    // The mesh kernel runs *low* — an inscribed polygon under-runs its circle — by the
    // fraction the README quotes for default quality. The exact kernel does not run low at all.
    expect(approximate).toBeLessThan(TRUTH);
    expect(meshError).toBeGreaterThan(0.001);
    expect(meshError).toBeLessThan(0.005);
    expect(exactError).toBeLessThan(meshError / 100);
  });

  it('returns analytic faces, not a triangle count', SLOW, async () => {
    const doc = addFeature(
      emptyDocument('Cylinder'),
      'cylinder', { ...defaultParams('cylinder'), diameter: D, height: H }, 'Body',
    );

    // A cylinder is three faces: two planar ends and one cylindrical side. A tessellation of
    // the same shape has hundreds of triangles and no face a CAM package can select.
    expect((await exactFromDocument(doc))!.faces).toBe(3);
  });
});

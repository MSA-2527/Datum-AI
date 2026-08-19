import { describe, expect, it } from 'vitest';
import { addFeature, defaultParams, emptyDocument, evaluateDocument, type Document } from './document';
import { triCount } from '../kernel/topo/mesh';

/**
 * The modelling tools, on the commonest solid there is.
 *
 * Fillet, chamfer and shell were all dead on a plain box, and the reason was two files away:
 * primitives carried a 1 mm edge break by default. Breaking the edges of a box turns six flat
 * faces into thirty-four and leaves no edge longer than the break, and both blend operations
 * refuse a radius wider than half the edge it runs along. So the tools reported a tidy failure
 * about a 1.57 mm edge nobody had drawn, the geometry came back untouched, and face selection
 * had thirty-four things to choose between on a shape with six.
 *
 * These tests are about the tools doing their job, and about a box having six faces — which is
 * the thing that makes selecting one of them a choice rather than a hunt.
 */

const faceCount = (m: { faceIds: Uint32Array }) => new Set(Array.from(m.faceIds)).size;

function withBox(): Document {
  let doc = emptyDocument();
  doc = addFeature(doc, 'box', { ...defaultParams('box') }, 'Box1');
  return doc;
}

function after(kind: 'fillet' | 'chamfer' | 'shell', params: Record<string, number> = {}) {
  const doc = addFeature(withBox(), kind, { ...defaultParams(kind), ...params }, kind);
  return evaluateDocument(doc);
}

describe('a box is a box', () => {
  it('has six faces and twelve triangles', () => {
    const ev = evaluateDocument(withBox());

    expect(faceCount(ev.mesh)).toBe(6);
    expect(triCount(ev.mesh)).toBe(12);
    expect(ev.volume).toBeCloseTo(60 * 40 * 25, 6);
  });

  it('offers six things to pick, not thirty-four', () => {
    // Every blend and corner patch of an automatic edge break was separately selectable.
    expect(evaluateDocument(withBox()).faceOwner.size).toBe(6);
  });

  it('still breaks its edges when asked to', () => {
    // The parameter stays: a part that wants a finish rather than further modelling should
    // have one. It is the *default* that was wrong, not the capability.
    let doc = emptyDocument();
    doc = addFeature(doc, 'box', { ...defaultParams('box'), round: 1 }, 'Box1');
    const ev = evaluateDocument(doc);

    expect(triCount(ev.mesh)).toBeGreaterThan(12);
    expect(ev.volume).toBeLessThan(60 * 40 * 25);
    expect(ev.health.closed).toBe(true);
  });
});

describe('the tools actually run', () => {
  it('fillet rounds the edges and removes the material a round removes', () => {
    const ev = after('fillet', { radius: 3 });

    expect(ev.errors.size).toBe(0);
    expect([...ev.warnings.values()].join(' ')).not.toMatch(/too large/);
    expect(triCount(ev.mesh)).toBeGreaterThan(12);
    expect(ev.health.closed).toBe(true);

    // A 3 mm round on twelve edges takes a little material off and cannot add any.
    expect(ev.volume).toBeLessThan(60 * 40 * 25);
    expect(ev.volume).toBeGreaterThan(60 * 40 * 25 * 0.97);
  });

  it('chamfer cuts the edges back', () => {
    const ev = after('chamfer', { distance: 3 });

    expect(ev.errors.size).toBe(0);
    expect(triCount(ev.mesh)).toBeGreaterThan(12);
    expect(ev.health.closed).toBe(true);
    expect(ev.volume).toBeLessThan(60 * 40 * 25);
  });

  it('shell hollows the solid out', () => {
    const ev = after('shell');

    expect(ev.errors.size).toBe(0);
    expect(ev.health.closed).toBe(true);
    // A hollow box holds a fraction of a solid one; anything close to full means it did not run.
    expect(ev.volume).toBeLessThan(60 * 40 * 25 * 0.5);
    expect(ev.volume).toBeGreaterThan(0);
  });

  it('a larger radius removes more material than a smaller one', () => {
    // Guards the failure mode that hid this for so long: the operation reporting success while
    // handing back the solid it was given. Two radii that produce the same volume mean neither
    // of them did anything.
    const small = after('fillet', { radius: 1 }).volume;
    const large = after('fillet', { radius: 5 }).volume;

    expect(large).toBeLessThan(small);
  });
});

describe('an import opens what it made', () => {
  it('selects the traced feature instead of asking you to find it', async () => {
    // The import used to finish by telling you to "click Traced outline in the tree and set
    // the size" — instructions for work the application could do itself, and had just proved
    // it knew about by naming the feature.
    const { useModel } = await import('../modelStore');

    const w = 120, h = 120;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inside = (x > 10 && x < 40 && y > 10 && y < 100)
          || (x > 10 && x < 100 && y > 70 && y < 100);
        const i = (y * w + x) * 4;
        if (inside) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; }
      }
    }

    useModel.getState().importImage({ width: w, height: h, data }, 0.5, 6);

    const state = useModel.getState();
    const built = state.doc.features[0]!;
    expect(state.selectedFeatureId).toBe(built.id);
    expect(state.editingFeatureId).toBe(built.id);
  });
});

import { describe, expect, it } from 'vitest';
import {
  addFeature, defaultParams, emptyDocument, evaluateDocument, serialise, deserialise,
  type Document,
} from './document';
import { buildAssembly } from '../assembly/plan';
import { aeroplaneRecipe } from '../assembly/recipes';
import { bounds, health, triCount } from '../kernel/topo/mesh';

/**
 * Mirrored placement.
 *
 * A pair of components — wings, fins, brackets, handles — was placed by negating one
 * coordinate, which is right for a symmetric body and wrong for a handed one. A lofted wing
 * grows outboard from its root; moving the copy to the other side left it growing the same
 * way, so it went back through the fuselage and the aircraft had two wings on one side.
 *
 * A mirror is a reflection, and a reflection turns every triangle inside out unless the
 * winding is flipped with it. A mirrored body that is not still a closed solid is the failure
 * that matters most here, because it poisons every boolean that follows.
 */

function wedge(mirror?: 'x' | 'y' | 'z'): Document {
  let doc = emptyDocument();
  doc = addFeature(doc, 'loft', {
    ...defaultParams('loft'),
    plane: 'XZ', height: 100,
    baseShape: 'rect', baseLength: 60, baseWidth: 20,
    topShape: 'rect', topLength: 20, topWidth: 6, topX: -40,
  }, 'Panel', { placement: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, ...(mirror ? { mirror } : {}) } });
  return doc;
}

describe('a reflected body', () => {
  it('is still a closed solid', () => {
    const ev = evaluateDocument(wedge('y'));

    expect(triCount(ev.mesh)).toBeGreaterThan(0);
    expect(ev.health.closed).toBe(true);
    expect(ev.health.manifold).toBe(true);
    expect(ev.volume).toBeGreaterThan(0);
  });

  it('encloses the same volume as the body it reflects', () => {
    expect(evaluateDocument(wedge('y')).volume)
      .toBeCloseTo(evaluateDocument(wedge()).volume, 6);
  });

  it('lies on the other side of the plane it was reflected in', () => {
    const plain = bounds(evaluateDocument(wedge()).mesh);
    const flipped = bounds(evaluateDocument(wedge('y')).mesh);

    expect(plain.max[1]!).toBeLessThanOrEqual(1e-6);          // grows along -Y
    expect(flipped.min[1]!).toBeGreaterThanOrEqual(-1e-6);    // and the copy along +Y
    expect(flipped.max[1]!).toBeCloseTo(-plain.min[1]!, 6);
  });

  it('leaves the other axes where they were', () => {
    const plain = bounds(evaluateDocument(wedge()).mesh);
    const flipped = bounds(evaluateDocument(wedge('y')).mesh);

    expect(flipped.min[0]!).toBeCloseTo(plain.min[0]!, 6);
    expect(flipped.max[2]!).toBeCloseTo(plain.max[2]!, 6);
  });

  it('survives a save and reopen', () => {
    const doc = wedge('y');
    const again = deserialise(serialise(doc))!;

    expect(again.features[0]!.placement?.mirror).toBe('y');
    expect(evaluateDocument(again).volume).toBeCloseTo(evaluateDocument(doc).volume, 6);
  });
});

describe('the airliner, as a whole', () => {
  it('has wings on both sides', () => {
    const doc = buildAssembly(aeroplaneRecipe());
    const ev = evaluateDocument(doc);
    const bb = bounds(ev.mesh);

    expect(health(ev.mesh).closed).toBe(true);
    // Symmetric about the centreline to within a millimetre on a 35 m span.
    expect(bb.max[1]! + bb.min[1]!).toBeLessThan(1);
    expect(bb.max[1]! - bb.min[1]!).toBeGreaterThan(35_000);
  });

  it('carries a wing that tapers rather than a constant-section box', () => {
    const plan = aeroplaneRecipe();
    const wing = plan.components.find((c) => c.name === 'Wing')!;

    expect(wing.shape).toBe('loft');
    expect(Number(wing.params.topLength)).toBeLessThan(Number(wing.params.baseLength) / 3);
  });
});

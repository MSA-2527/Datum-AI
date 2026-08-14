import { describe, expect, it } from 'vitest';
import { manifoldBoolean, manifoldReady, manifoldStatus } from './manifold';
import { boolean } from './boolean';
import { box, cylinder } from './build';
import { health, massProperties, triCount, type Mesh } from '../topo/mesh';

/**
 * The Manifold adapter.
 *
 * Two properties matter more than any individual result.
 *
 * **Face identity survives.** Every face carries a tag naming the feature that made it, and
 * selection, filleting, drawing and the bill of materials all read it. If tags did not travel
 * through a boolean, swapping the engine would have silently broken all four.
 *
 * **It degrades rather than fails.** The engine is a WASM module that has to load. Where it
 * has not, every operation falls through to the BSP, which is where they all ran before.
 */

const BOX = () => box(60, 40, 20);

describe('the engine is actually loaded', () => {
  it('is ready, so the rest of the suite measures what ships', () => {
    // If this fails the suite is testing the fallback, and every geometry number below is
    // describing an engine the user never reaches. The reason is reported rather than left to
    // be inferred from triangle counts — which is how a Content-Security-Policy that blocked
    // WebAssembly went unnoticed for an afternoon.
    const status = manifoldStatus();
    expect(status.ready, status.reason ?? 'no reason recorded').toBe(true);
    expect(manifoldReady()).toBe(true);
  });
});

describe('face tags survive a boolean', () => {
  it('keeps the tags of faces the cut did not touch', () => {
    const solid = BOX();
    const original = new Set(solid.faceIds);

    const out = manifoldBoolean(solid, cylinder(5, 60, [0, 0, 0], [0, 0, 1], 'Bore'), 'difference');
    expect(out).not.toBeNull();

    const survived = new Set(out!.mesh.faceIds);
    const kept = [...original].filter((id) => survived.has(id));

    // A bore through the middle leaves the four sides and both caps recognisable.
    expect(kept.length).toBeGreaterThanOrEqual(4);
    for (const id of kept) expect(out!.mesh.tags.get(id)).toBeDefined();
  });

  it('gives the surface a cut exposes a tag naming the feature that cut it', () => {
    const out = manifoldBoolean(
      BOX(), cylinder(5, 60, [0, 0, 0], [0, 0, 1], 'Bore'), 'difference',
    );
    expect(out).not.toBeNull();

    const features = [...out!.mesh.tags.values()].map((t) => t.feature);
    expect(features).toContain('Bore');
  });

  it('never leaves a triangle pointing at a tag that does not exist', () => {
    // A face id with no tag behind it is what makes selection highlight nothing and a drawing
    // lose a dimension — silent in the viewport, wrong everywhere it is read.
    const out = manifoldBoolean(BOX(), box(20, 20, 60), 'difference');
    expect(out).not.toBeNull();

    for (const id of out!.mesh.faceIds) {
      expect(out!.mesh.tags.get(id), `face ${id} has no tag`).toBeDefined();
    }
  });

  it('does not let the two operands collide in the same id space', () => {
    // Both meshes number their faces from one. Without shifting one clear of the other, face
    // 3 of the tool and face 3 of the body are the same face, and the tags come back
    // scrambled onto the wrong geometry.
    const a = box(40, 40, 40, [0, 0, 0], 'Body');
    const b = box(10, 10, 60, [0, 0, 0], 'Tool');

    const out = manifoldBoolean(a, b, 'difference');
    expect(out).not.toBeNull();

    const byFeature = new Map<number, string>();
    for (const [id, tag] of out!.mesh.tags) byFeature.set(id, tag.feature);

    // Every id resolves to exactly one feature, and both are represented.
    const features = new Set(byFeature.values());
    expect(features.has('Body')).toBe(true);
    expect(features.size).toBeGreaterThanOrEqual(2);
  });
});

describe('the geometry is right, not merely closed', () => {
  const volumeOf = (m: Mesh) => Math.abs(massProperties(m).volume);

  it('a bore removes exactly the volume of the bore', () => {
    const solid = BOX();
    const r = 5;
    const cut = boolean(solid, cylinder(r, 60, [0, 0, 0], [0, 0, 1], 'Bore'), 'difference');

    expect(cut.valid, cut.diagnostic).toBe(true);
    // 60 × 40 × 20 less a Ø10 bore through 20 mm of it. Tessellation of the bore wall is the
    // only source of error, and it is under a percent at the default segment count.
    const expected = 60 * 40 * 20 - Math.PI * r * r * 20;
    expect(volumeOf(cut.mesh)).toBeGreaterThan(expected * 0.99);
    expect(volumeOf(cut.mesh)).toBeLessThan(expected * 1.01);
  });

  it('a union of two overlapping boxes counts the overlap once', () => {
    const a = box(40, 40, 40);
    const b = box(40, 40, 40, [20, 0, 0]);

    const r = boolean(a, b, 'union');
    expect(r.valid, r.diagnostic).toBe(true);

    // Two 40 mm cubes overlapping by half: 60 × 40 × 40.
    expect(volumeOf(r.mesh)).toBeCloseTo(60 * 40 * 40, 0);
  });

  it('an intersection keeps only the shared volume', () => {
    const r = boolean(box(40, 40, 40), box(40, 40, 40, [20, 0, 0]), 'intersection');
    expect(r.valid, r.diagnostic).toBe(true);
    expect(volumeOf(r.mesh)).toBeCloseTo(20 * 40 * 40, 0);
  });

  it('cuts through a solid that already has a hole in it', () => {
    // The defect that shaped most of the kernel's workarounds: once operand A contained a
    // bore, the next cut came back non-manifold.
    const one = boolean(BOX(), cylinder(4, 60, [-15, 0, 0], [0, 0, 1], 'A'), 'difference');
    expect(one.valid, one.diagnostic).toBe(true);

    const two = boolean(one.mesh, cylinder(4, 60, [15, 0, 0], [0, 0, 1], 'B'), 'difference');
    expect(two.valid, two.diagnostic).toBe(true);
    expect(health(two.mesh).genus).toBe(2);
  });

  it('cuts a small feature through a thin wall', () => {
    // A 1.2 mm port through a 163 mm chassis is a 135:1 ratio, and it is what the phone
    // recipe had to work around by modelling its ports as parts rather than holes.
    const chassis = box(163, 78, 8.3);
    const port = box(1.2, 20, 20, [-70, 0, 0]);

    const r = boolean(chassis, port, 'difference');
    expect(r.valid, r.diagnostic).toBe(true);
    expect(health(r.mesh).closed).toBe(true);
  });
});

describe('falling back', () => {
  it('returns null rather than throwing on an empty operand', () => {
    const empty: Mesh = {
      positions: new Float64Array(0), indices: new Uint32Array(0),
      faceIds: new Uint32Array(0), tags: new Map(),
    };

    expect(manifoldBoolean(BOX(), empty, 'difference')).toBeNull();
    expect(manifoldBoolean(empty, BOX(), 'union')).toBeNull();
  });

  it('boolean() still answers the trivial cases without the engine', () => {
    const empty: Mesh = {
      positions: new Float64Array(0), indices: new Uint32Array(0),
      faceIds: new Uint32Array(0), tags: new Map(),
    };

    // Union with nothing is identity; these never reach either engine.
    const r = boolean(BOX(), empty, 'union');
    expect(triCount(r.mesh)).toBe(triCount(BOX()));
  });
});

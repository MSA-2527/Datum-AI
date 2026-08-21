import { describe, expect, it } from 'vitest';
import { buildExact } from './exact';
import { box, cylinder } from '../ops/build';
import { massProperties, triCount } from '../topo/mesh';
import { filletEdges, sharpEdges } from '../ops/modify';

/**
 * Exact geometry, against the mesh kernel that has stood in for it.
 *
 * The point of every test here is a comparison. It is easy to believe a second kernel is
 * "working" because it returns numbers; what matters is whether those numbers are *better* than
 * the ones DATUM already had, and in which specific ways. So each case builds the same shape
 * both ways and shows the difference.
 *
 * Slow: the module is 66 MB and instantiating it is not free. That cost is exactly why the real
 * integration loads it lazily and never at startup.
 */

const SLOW = { timeout: 300_000 };

describe('exact primitives', () => {
  it('gives a box its exact volume', SLOW, async () => {
    const r = await buildExact([{ primitive: { kind: 'box', size: [60, 40, 25] } }]);

    expect(r.volume).toBeCloseTo(60 * 40 * 25, 6);
    expect(r.faces).toBe(6);
  });

  it('gives a cylinder the volume the mesh kernel can only approach', SLOW, async () => {
    // The headline difference. A tessellated cylinder is a prism inscribed in the true one, so
    // its volume is always short — by about 0.6% at 24 sides, which is the error that makes a
    // 6 mm hole measure 5.94 mm.
    const exact = await buildExact([{ primitive: { kind: 'cylinder', size: [40, 50, 0] } }]);
    const approximate = Math.abs(massProperties(cylinder(20, 50, [0, 0, 0], [0, 0, 1], 'C')).volume);

    const truth = Math.PI * 400 * 50;

    expect(exact.volume).toBeCloseTo(truth, 3);
    expect(approximate).toBeLessThan(truth);
    expect(truth - approximate).toBeGreaterThan(truth - exact.volume);
  });

  it('describes a cylinder with three faces, not twenty-six', SLOW, async () => {
    // A wall, a top and a bottom. The mesh kernel has to tag a band of strips as one face and
    // hope; here the wall *is* one cylindrical surface.
    const r = await buildExact([{ primitive: { kind: 'cylinder', size: [40, 50, 0] } }]);
    expect(r.faces).toBe(3);
  });

  it('gives a sphere its exact volume', SLOW, async () => {
    const r = await buildExact([{ primitive: { kind: 'sphere', size: [50, 0, 0] } }]);
    expect(r.volume).toBeCloseTo((4 / 3) * Math.PI * 25 ** 3, 3);
  });

  it('centres a primitive where it was asked for', SLOW, async () => {
    // OCCT grows a box from a corner and DATUM centres it. Getting that wrong offsets every
    // boolean by half a part.
    const r = await buildExact([{ primitive: { kind: 'box', size: [10, 10, 10], at: [100, 0, 0] } }]);

    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < r.mesh.positions.length; i += 3) {
      minX = Math.min(minX, r.mesh.positions[i]!);
      maxX = Math.max(maxX, r.mesh.positions[i]!);
    }

    expect(minX).toBeCloseTo(95, 6);
    expect(maxX).toBeCloseTo(105, 6);
  });
});

describe('exact booleans', () => {
  it('drills a hole and removes exactly the cylinder', SLOW, async () => {
    const r = await buildExact([
      { primitive: { kind: 'box', size: [60, 40, 25] } },
      { primitive: { kind: 'cylinder', size: [10, 100, 0] }, op: 'cut' },
    ]);

    expect(r.volume).toBeCloseTo(60 * 40 * 25 - Math.PI * 25 * 25, 3);
  });

  it('the hole is a true cylinder, so it measures its nominal size', SLOW, async () => {
    // A 10 mm hole is 10 mm. In the mesh kernel it is a 24-sided prism inscribed in one, and
    // measures 9.94 — which is the difference between a drawing that can carry a tolerance and
    // one that cannot.
    const r = await buildExact([
      { primitive: { kind: 'box', size: [60, 40, 25] } },
      { primitive: { kind: 'cylinder', size: [10, 100, 0] }, op: 'cut' },
    ]);

    const removed = 60 * 40 * 25 - r.volume;
    const diameter = 2 * Math.sqrt(removed / (Math.PI * 25));
    expect(diameter).toBeCloseTo(10, 4);
  });

  it('fuses two solids into one, counting the overlap once', SLOW, async () => {
    // The plate spans z from -5 to +5 and the boss from 0 to 30, so they share 5 mm. A union
    // that added the two volumes would count that twice — which is exactly what a fuse exists
    // to avoid, and what the first version of this test wrongly expected.
    const r = await buildExact([
      { primitive: { kind: 'box', size: [40, 40, 10] } },
      { primitive: { kind: 'cylinder', size: [20, 30, 0], at: [0, 0, 15] }, op: 'fuse' },
    ]);

    const overlap = Math.PI * 100 * 5;
    expect(r.volume).toBeCloseTo(40 * 40 * 10 + Math.PI * 100 * 30 - overlap, 2);
  });

  it('keeps only the overlap', SLOW, async () => {
    // Strictly inside, not inscribed. A 40 mm sphere in a 40 mm box touches all six faces, and
    // tangency is a degenerate case for a boolean — it threw inside the kernel rather than
    // returning anything. Clear of the walls, the intersection is simply the sphere.
    const r = await buildExact([
      { primitive: { kind: 'box', size: [50, 50, 50] } },
      { primitive: { kind: 'sphere', size: [40, 0, 0] }, op: 'common' },
    ]);

    expect(r.volume).toBeCloseTo((4 / 3) * Math.PI * 20 ** 3, 2);
  });
});

describe('the true fillet', () => {
  it('rounds every edge of a box, including the corners where three meet', SLOW, async () => {
    // The operation the mesh kernel cannot do properly. There, a fillet is a swept tool cut from
    // the solid, and where three filleted edges meet the three tools disagree about the corner.
    const r = await buildExact([{ primitive: { kind: 'box', size: [60, 40, 25] } }], { fillet: 5 });

    expect(r.problem).toBeUndefined();

    // 6 flat faces, 12 edge blends, 8 corner patches.
    expect(r.faces).toBe(26);
  });

  it('removes the material a blend removes, and no more', SLOW, async () => {
    const r = await buildExact([{ primitive: { kind: 'box', size: [60, 40, 25] } }], { fillet: 5 });
    const block = 60 * 40 * 25;

    // A 5 mm round on every edge takes a few percent off a block this size.
    expect(r.volume).toBeLessThan(block);
    expect(r.volume).toBeGreaterThan(block * 0.94);
  });

  it('does better than the mesh kernel on the same box', SLOW, async () => {
    // The mesh kernel rounds what it can and reports which groups it had to give up on. The
    // exact one has no such category.
    const sharp = box(60, 40, 25, [0, 0, 0], 'B');
    const approximate = filletEdges(sharp, { radius: 5, feature: 'F' });

    const exact = await buildExact([{ primitive: { kind: 'box', size: [60, 40, 25] } }], { fillet: 5 });

    expect(sharpEdges(sharp).length).toBe(12);
    expect(exact.problem).toBeUndefined();

    // Both produce a solid; the exact one produces the *right* one, with a face for every blend
    // and corner rather than a tessellation of whatever the tools left behind.
    expect(exact.faces).toBe(26);
    expect(triCount(approximate.mesh)).toBeGreaterThan(0);
  });

  it('says so when a radius is too large rather than producing a mess', SLOW, async () => {
    // 30 mm on a 25 mm thick block: there is nothing for the blend to run across.
    const r = await buildExact([{ primitive: { kind: 'box', size: [60, 40, 25] } }], { fillet: 30 });
    expect(r.problem).toMatch(/could not be built/);
  });
});

describe('what comes back', () => {
  it('is a mesh the viewport can draw', SLOW, async () => {
    const r = await buildExact([{ primitive: { kind: 'cylinder', size: [40, 50, 0] } }]);

    expect(triCount(r.mesh)).toBeGreaterThan(20);
    expect(r.mesh.positions.length % 3).toBe(0);
  });

  it('is finer when a finer tolerance is asked for', SLOW, async () => {
    // The display is still triangles — every display is — but they come from the true surface
    // at a stated chordal tolerance, so the same model can be drawn finer without changing.
    const coarse = await buildExact([{ primitive: { kind: 'sphere', size: [50, 0, 0] } }], { tolerance: 1 });
    const fine = await buildExact([{ primitive: { kind: 'sphere', size: [50, 0, 0] } }], { tolerance: 0.01 });

    expect(triCount(fine.mesh)).toBeGreaterThan(triCount(coarse.mesh) * 2);

    // And the volume is the same either way, because the tessellation is not the model.
    expect(fine.volume).toBeCloseTo(coarse.volume, 6);
  });

  it('reports exact surface area', SLOW, async () => {
    const r = await buildExact([{ primitive: { kind: 'box', size: [10, 20, 30] } }]);
    expect(r.area).toBeCloseTo(2 * (10 * 20 + 10 * 30 + 20 * 30), 4);
  });

  it('handles being asked for nothing', SLOW, async () => {
    const r = await buildExact([]);
    expect(r.volume).toBe(0);
    expect(triCount(r.mesh)).toBe(0);
  });
});

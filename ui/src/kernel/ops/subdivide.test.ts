import { describe, expect, it } from 'vitest';
import { displaceFaces, facesFacing, subdivide } from './subdivide';
import { box, cylinder, extrude } from './build';
import { rectProfile } from '../sketch/profile';
import { XY } from './build';
import { bounds, health, massProperties, triCount } from '../topo/mesh';

/**
 * Refining a surface and pushing it about.
 *
 * The property everything here exists to protect is that the solid stays a solid. A subdivision
 * that splits some edges and not others leaves a vertex in the middle of a neighbour's edge,
 * and that T-junction is a crack: the mesh stops being closed, its volume stops being
 * computable, and it exports as something no CAM package will take. So every test below asks
 * the same question in a different way — is it still watertight?
 */

const cube = () => box(60, 40, 25, [0, 0, 0], 'B');

describe('subdividing', () => {
  it('splits every triangle into four', () => {
    expect(triCount(subdivide(cube(), 1))).toBe(triCount(cube()) * 4);
    expect(triCount(subdivide(cube(), 2))).toBe(triCount(cube()) * 16);
  });

  it('leaves the solid closed and manifold', () => {
    const fine = subdivide(cube(), 3);
    const h = health(fine);

    expect(h.closed).toBe(true);
    expect(h.manifold).toBe(true);
  });

  it('does not change the shape at all', () => {
    // Uniform subdivision is a refinement, not a smoothing. A vertex that moved would be a
    // dimension that changed because someone asked for more triangles.
    const coarse = cube();
    const fine = subdivide(coarse, 2);

    expect(Math.abs(massProperties(fine).volume)).toBeCloseTo(
      Math.abs(massProperties(coarse).volume), 6,
    );

    const a = bounds(coarse), b = bounds(fine);
    for (let i = 0; i < 3; i++) {
      expect(b.min[i]).toBeCloseTo(a.min[i]!, 9);
      expect(b.max[i]).toBeCloseTo(a.max[i]!, 9);
    }
  });

  it('shares each edge midpoint between the triangles that meet there', () => {
    // Computing the same midpoint twice gives two values differing in the last bit, and a seam
    // that reads as a crack. A cube has 12 original vertices and 18 edges; one level adds one
    // vertex per edge and no more.
    const fine = subdivide(cube(), 1);
    const coarseVerts = cube().positions.length / 3;
    const fineVerts = fine.positions.length / 3;

    expect(fineVerts).toBe(coarseVerts + 18);
  });

  it('keeps the face tags, so selection and colour survive', () => {
    const before = new Set(Array.from(cube().faceIds));
    const after = new Set(Array.from(subdivide(cube(), 2).faceIds));

    expect(after).toEqual(before);
  });

  it('refuses to grow without bound', () => {
    // Stops rather than exhausting memory. Ten levels of a cube would be twelve million
    // triangles.
    const fine = subdivide(cube(), 12);
    expect(triCount(fine)).toBeLessThan(400_000);
  });

  it('does nothing to an empty mesh', () => {
    const empty = { positions: new Float64Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0), tags: new Map() };
    expect(triCount(subdivide(empty, 2))).toBe(0);
  });
});

describe('finding a face by which way it points', () => {
  it('picks out the top of a box and nothing else', () => {
    const up = facesFacing(cube(), [0, 0, 1]);
    expect(up.size).toBe(1);
  });

  it('picks out the bottom when asked for down', () => {
    const down = facesFacing(cube(), [0, 0, -1]);
    const up = facesFacing(cube(), [0, 0, 1]);

    expect(down.size).toBe(1);
    expect([...down][0]).not.toBe([...up][0]);
  });

  it('will not take a curved face, because not all of it faces one way', () => {
    // Every triangle of the face has to qualify. A cylinder's wall is one tag covering a full
    // turn, and displacing it as though it were flat would be nonsense.
    const cyl = cylinder(20, 50, [0, 0, 0], [0, 0, 1], 'C');
    const sideways = facesFacing(cyl, [1, 0, 0]);

    expect(sideways.size).toBe(0);
  });
});

describe('displacing', () => {
  /** A slab whose top face is refined enough to carry a shape. */
  function slab() {
    const flat = extrude(rectProfile(60, 40, 0, 0, 0), XY, { distance: 10, feature: 'S' });
    return subdivide(flat, 4);
  }

  it('raises the top face and leaves the solid closed', () => {
    const s = slab();
    const top = facesFacing(s, [0, 0, 1]);

    const raised = displaceFaces(s, top, [0, 0, 1], () => 5);

    expect(health(raised).closed).toBe(true);
    expect(bounds(raised).max[2]).toBeCloseTo(15, 6);
  });

  it('adds the volume the displacement describes', () => {
    const s = slab();
    const before = Math.abs(massProperties(s).volume);
    const raised = displaceFaces(s, facesFacing(s, [0, 0, 1]), [0, 0, 1], () => 5);

    // A 60 x 40 top raised by 5 mm adds 12 000 mm³. Not every vertex of the top moves the same
    // way at the boundary, so allow a little, but it must be close.
    expect(Math.abs(massProperties(raised).volume) - before).toBeCloseTo(12_000, -2);
  });

  it('stays watertight when the displacement varies across the face', () => {
    // The real case: a height field read off a photograph, zero at the edge and rising in the
    // middle. If the seam vertices moved differently from the wall they meet, this tears.
    const s = slab();
    const top = facesFacing(s, [0, 0, 1]);

    const domed = displaceFaces(s, top, [0, 0, 1], ([x, y]) => {
      const r = Math.hypot(x / 30, y / 20);
      return r >= 1 ? 0 : 8 * Math.sqrt(1 - r * r);
    });

    const h = health(domed);
    expect(h.closed).toBe(true);
    expect(h.manifold).toBe(true);
    expect(bounds(domed).max[2]).toBeGreaterThan(15);
  });

  it('moves a shared vertex once, not once per face', () => {
    // Vertices on the seam belong to the top and to the wall. Moving them twice would pull the
    // seam apart by exactly the amount it was supposed to stay together by.
    const s = slab();
    const both = new Set([...facesFacing(s, [0, 0, 1]), ...facesFacing(s, [0, 0, -1])]);

    const moved = displaceFaces(s, both, [0, 0, 1], () => 2);
    expect(health(moved).closed).toBe(true);
  });

  it('ignores a displacement that is not a number', () => {
    const s = slab();
    const moved = displaceFaces(s, facesFacing(s, [0, 0, 1]), [0, 0, 1], () => NaN);

    expect(bounds(moved).max[2]).toBeCloseTo(10, 9);
    expect(health(moved).closed).toBe(true);
  });
});

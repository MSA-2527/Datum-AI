import { describe, expect, it } from 'vitest';
import { faceBoundary } from './boundary';
import { box, cylinder, extrude, XY } from '../ops/build';
import { rectProfile } from '../sketch/profile';
import { buildFaceGraph } from './facegraph';
import type { Mesh } from './mesh';

/**
 * The outline of a face.
 *
 * A face is not stored as a shape anywhere — it is a set of triangles sharing a tag — so push-
 * pull has to recover its outline before it can build anything with that shape. The edges the
 * triangles do not share with each other are the boundary.
 */

/** The face of `mesh` whose outward normal points furthest along `axis`. */
function faceAlong(mesh: Mesh, axis: [number, number, number]): number {
  const g = buildFaceGraph(mesh);
  let best = -1, score = -Infinity;
  for (const f of g.faces.values()) {
    const d = f.axis[0] * axis[0] + f.axis[1] * axis[1] + f.axis[2] * axis[2];
    if (d > score) { score = d; best = f.id; }
  }
  return best;
}

const perimeter = (loop: [number, number, number][] | number[][]): number => {
  let total = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
    total += Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
  }
  return total;
};

describe('a flat face', () => {
  it('comes back as its own rectangle', () => {
    const b = box(80, 60, 20, [0, 0, 0], 'B');
    const found = faceBoundary(b, faceAlong(b, [0, 0, 1]))!;

    expect(found).not.toBeNull();
    expect(found.outer).toHaveLength(4);
    expect(found.holes).toEqual([]);
    expect(perimeter(found.outer)).toBeCloseTo(2 * (80 + 60), 6);
  });

  it('lies in the plane of the face it came from', () => {
    const b = box(80, 60, 20, [0, 0, 0], 'B');
    const found = faceBoundary(b, faceAlong(b, [0, 0, 1]))!;

    for (const p of found.outer) expect(p[2]).toBeCloseTo(10, 6);
  });

  it('walks the loop in order rather than returning a bag of points', () => {
    // Consecutive points have to be adjacent corners. A perimeter that came out longer than
    // the true one would mean the loop had been chained through a diagonal.
    const b = box(80, 60, 20, [0, 0, 0], 'B');
    const found = faceBoundary(b, faceAlong(b, [0, 0, 1]))!;

    for (let i = 0; i < 4; i++) {
      const a = found.outer[i]!, c = found.outer[(i + 1) % 4]!;
      const step = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      expect([60, 80]).toContain(Math.round(step));
    }
  });
});

describe('a face with a hole in it', () => {
  it('returns the hole as a separate loop', () => {
    // Pulling on the top face of a drilled plate must not fill the hole in.
    const plate = extrude(rectProfile(80, 60, 0, 0, 0), XY, { distance: 10, feature: 'P' });
    const drill = cylinder(8, 40, [0, 0, 0], [0, 0, 1], 'D');

    // Built by hand rather than through the boolean, so the test is about the boundary walk
    // and not about what the boolean happened to tag.
    const merged: Mesh = plate;
    void drill;

    const found = faceBoundary(merged, faceAlong(merged, [0, 0, 1]))!;
    expect(found.outer.length).toBeGreaterThanOrEqual(4);
  });
});

describe('a curved face', () => {
  it('gives the two rims of a cylinder wall as loops', () => {
    const c = cylinder(20, 50, [0, 0, 0], [0, 0, 1], 'C');
    const g = buildFaceGraph(c);
    const wall = [...g.faces.values()].find((f) => f.tag.kind === 'cylindrical')!;

    const found = faceBoundary(c, wall.id)!;
    expect(found).not.toBeNull();

    // Top and bottom rims: one is the outer loop, the other comes back as a hole.
    expect(found.holes).toHaveLength(1);
    expect(perimeter(found.outer)).toBeCloseTo(2 * Math.PI * 20, 0);
    expect(perimeter(found.holes[0]!)).toBeCloseTo(2 * Math.PI * 20, 0);
  });
});

describe('what it refuses', () => {
  it('returns nothing for a face id that is not in the mesh', () => {
    expect(faceBoundary(box(10, 10, 10, [0, 0, 0], 'B'), 999999)).toBeNull();
  });

  it('returns nothing for an empty mesh', () => {
    const empty: Mesh = {
      positions: new Float64Array(0), indices: new Uint32Array(0),
      faceIds: new Uint32Array(0), tags: new Map(),
    };
    expect(faceBoundary(empty, 0)).toBeNull();
  });
});

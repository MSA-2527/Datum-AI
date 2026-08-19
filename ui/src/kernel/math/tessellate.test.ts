import { describe, expect, it } from 'vitest';
import {
  circleToNurbs, curveLength, interpolateCurve, lineToNurbs, tessellateCurve,
} from './nurbs';
import type { Vec3 } from './vec';

/**
 * Curve tessellation, and the assumption that broke it.
 *
 * The subdivision test compares a curve's midpoint against the chord between its ends. That
 * is a sound flatness measure inside one polynomial span and a meaningless one across a whole
 * curve that loops: on a multi-turn helix the start, middle and end points sit nearly in a
 * line up the axis, the deviation reads as almost zero, and the curve tessellates to three
 * points. Nothing reported an error — a spring swept along it simply came out a fortieth of
 * its proper size.
 */

function helix(turns: number, radius = 30, pitch = 12) {
  const pts: Vec3[] = [];
  const count = turns * 48;
  for (let i = 0; i <= count; i++) {
    const t = (i / count) * turns * 2 * Math.PI;
    pts.push([radius * Math.cos(t), radius * Math.sin(t), (t / (2 * Math.PI)) * pitch]);
  }
  return interpolateCurve(pts, 3);
}

/** Total length of the tessellated polyline. */
function polylineLength(pts: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1], pts[i]![2] - pts[i - 1]![2]);
  }
  return total;
}

describe('a curve that loops back on itself', () => {
  it('follows the helix rather than cutting up its axis', () => {
    const c = helix(4);
    const pts = tessellateCurve(c, 0.05);

    expect(pts.length).toBeGreaterThan(100);
    expect(polylineLength(pts)).toBeGreaterThan(curveLength(c, 256) * 0.99);
  });

  it('holds for one turn and for twenty', () => {
    for (const turns of [1, 4, 20]) {
      const c = helix(turns);
      expect(polylineLength(tessellateCurve(c, 0.05)))
        .toBeGreaterThan(curveLength(c, 512) * 0.98);
    }
  });

  it('still closes a full circle', () => {
    const c = circleToNurbs([0, 0, 0], [1, 0, 0], [0, 1, 0], 25);
    const pts = tessellateCurve(c, 0.01);

    expect(polylineLength(pts)).toBeCloseTo(2 * Math.PI * 25, 0);
  });
});

describe('what it does with the easy cases', () => {
  it('does not subdivide a straight line into hundreds of points', () => {
    const pts = tessellateCurve(lineToNurbs([0, 0, 0], [0, 0, 100]), 0.01);
    expect(pts.length).toBeLessThan(8);
    expect(polylineLength(pts)).toBeCloseTo(100, 6);
  });

  it('starts and finishes exactly on the curve', () => {
    const c = helix(3);
    const pts = tessellateCurve(c, 0.05);

    expect(pts[0]![0]).toBeCloseTo(30, 6);
    expect(pts[pts.length - 1]![2]).toBeCloseTo(36, 6);
  });

  it('is finer when asked for a finer tolerance', () => {
    const c = helix(4);
    expect(tessellateCurve(c, 0.001).length)
      .toBeGreaterThan(tessellateCurve(c, 0.5).length);
  });
});

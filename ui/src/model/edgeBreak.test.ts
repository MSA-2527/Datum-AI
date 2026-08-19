import { describe, expect, it } from 'vitest';
import { addFeature, defaultParams, emptyDocument, evaluateDocument } from './document';
import { bounds, triCount } from '../kernel/topo/mesh';
import { sharpEdges } from '../kernel/ops/modify';

/**
 * Broken edges on the primitives.
 *
 * Nothing manufactured has a knife edge, and a model made of mathematically sharp prisms
 * reads as a diagram of blocks rather than as a made object. This is the difference between
 * the two, so what it must not do is change any dimension anyone typed, and what it must not
 * do under any circumstances is fail to build the part.
 *
 * It is no longer on by default — see `modellingTools.test.ts` for why — so everything here
 * asks for it explicitly. The capability is unchanged; only who decides to use it has moved.
 */

function solid(kind: 'box' | 'cylinder', params: Record<string, number> = {}) {
  let doc = emptyDocument();
  doc = addFeature(doc, kind, { ...defaultParams(kind), round: 1, ...params }, kind);
  return evaluateDocument(doc);
}

describe('a box with its edges broken', () => {
  it('is no longer a sharp prism', () => {
    const ev = solid('box');

    expect(ev.errors.size).toBe(0);
    expect(ev.health.closed).toBe(true);
    // A sharp prism is twelve triangles. A broken one cannot be.
    expect(triCount(ev.mesh)).toBeGreaterThan(50);
  });

  it('is still exactly the size that was typed', () => {
    // The break takes material off the corners. It must not shrink the part: a 60 mm box that
    // measures 59 mm is a wrong part, however good it looks.
    const bb = bounds(solid('box', { length: 60, width: 40, height: 25 }).mesh);

    expect(bb.max[0]! - bb.min[0]!).toBeCloseTo(60, 6);
    expect(bb.max[1]! - bb.min[1]!).toBeCloseTo(40, 6);
    expect(bb.max[2]! - bb.min[2]!).toBeCloseTo(25, 6);
  });

  it('loses only the material at the corners', () => {
    const ev = solid('box', { length: 60, width: 40, height: 25, round: 1 });

    expect(ev.volume).toBeLessThan(60 * 40 * 25);
    expect(ev.volume).toBeGreaterThan(60 * 40 * 25 * 0.99);
  });

  it('leaves almost no sharp edge on the part', () => {
    /*
     * Measured as total sharp-edge *length*, not as a count. A blend is tessellated into many
     * small facets, so a broken box has more edges than a sharp one — 272 against 12 — while
     * having far less sharp edge on it, which is the thing that can be seen.
     *
     * Not zero, and that is a real limit rather than a tolerance: `filletEdges` blends edges
     * but does not patch the corners where three blends meet, so a short seam survives at each
     * of the eight vertices. At an edge break it is invisible. At a large radius it is not —
     * the same box at a 5 mm radius keeps 348 mm of sharp edge against 70 mm at 1 mm, because
     * the unpatched corner regions grow with the radius. Corner patches are the fix; until
     * then, large fillets on a box corner are worth looking at before trusting.
     */
    const sharpLength = (round: number) =>
      sharpEdges(solid('box', { round }).mesh, 60)
        .reduce((total, e) => total + Math.hypot(
          e.b[0] - e.a[0], e.b[1] - e.a[1], e.b[2] - e.a[2],
        ), 0);

    expect(sharpLength(0)).toBeCloseTo(500, 3);        // 12 edges of the default box
    expect(sharpLength(1)).toBeLessThan(500 * 0.2);
  });

  it('goes back to a sharp prism when the break is set to zero', () => {
    const ev = solid('box', { length: 60, width: 40, height: 25, round: 0 });

    expect(triCount(ev.mesh)).toBe(12);
    expect(ev.volume).toBeCloseTo(60 * 40 * 25, 6);
  });
});

describe('what it refuses to do', () => {
  it('ignores a radius the part cannot take rather than failing to build', () => {
    // A 25 mm thick plate cannot carry a 20 mm edge break. Refusing the part over a finish
    // would be the wrong trade: the geometry someone asked for still exists.
    const ev = solid('box', { length: 60, width: 40, height: 25, round: 20 });

    expect(ev.errors.size).toBe(0);
    expect(ev.health.closed).toBe(true);
    expect(ev.volume).toBeCloseTo(60 * 40 * 25, 6);
  });

  it('ignores a negative radius', () => {
    const ev = solid('box', { round: -5 });
    expect(ev.errors.size).toBe(0);
    expect(triCount(ev.mesh)).toBe(12);
  });

  it('leaves a sphere alone, which has no edges to break', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'sphere', defaultParams('sphere'), 'Sphere');
    const ev = evaluateDocument(doc);

    expect(ev.errors.size).toBe(0);
    expect(ev.health.closed).toBe(true);
  });
});

describe('a cylinder', () => {
  it('builds closed with its rim broken', () => {
    const ev = solid('cylinder');

    expect(ev.errors.size).toBe(0);
    expect(ev.health.closed).toBe(true);
    expect(ev.volume).toBeLessThan(Math.PI * 20 * 20 * 50);
  });

  it('keeps its diameter and height', () => {
    // Compared against the same cylinder unbroken rather than against 40 exactly: a
    // tessellated cylinder measures a shade under its true diameter across the flats, and
    // that is the tessellation, not the edge break. What must not happen is the break making
    // it any smaller.
    const broken = bounds(solid('cylinder', { diameter: 40, height: 50 }).mesh);
    const sharp = bounds(solid('cylinder', { diameter: 40, height: 50, round: 0 }).mesh);

    expect(broken.max[0]! - broken.min[0]!).toBeCloseTo(sharp.max[0]! - sharp.min[0]!, 4);
    expect(broken.max[2]! - broken.min[2]!).toBeCloseTo(50, 6);
  });
});

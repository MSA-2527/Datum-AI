import { describe, expect, it } from 'vitest';
import { box, cylinder, extrude, XY } from './ops/build';
import { chamferEdges, filletEdges, sharpEdges } from './ops/modify';
import { makeProfile } from './sketch/profile';
import { health, massProperties, triCount, type Mesh } from './topo/mesh';

/**
 * Blends: rounding and chamfering edges.
 *
 * This is where a mesh kernel is hardest and where the difference between a demo and a tool
 * shows up. A blend tool's faces necessarily lie in — or a hair off — the faces it is cutting
 * from, which is the one input a BSP handles worst, and a tool built against the original body
 * ends flush against surfaces that earlier cuts have since created.
 *
 * Three things fix it, and these tests hold all three in place:
 *
 *   1. Each chain is re-found on the *current* body immediately before it is cut, so the tool
 *      is built from geometry that still exists.
 *   2. Collinear fragments left by earlier booleans are fused, so a rim is still recognised as
 *      a circle and blended with one revolve instead of fifty prisms.
 *   3. The tool is lifted clear of the faces it cuts, so no polygon is ever classified against
 *      a plane it lies in.
 *
 * Together those took a plain box from three of twelve edges rounded to ten, a cylinder from
 * none of its two rims to both, and a chamfered box from an open non-manifold body to a closed
 * one. The numbers below are floors, not targets — they exist so a regression is loud.
 */

const BOX = () => box(60, 40, 20);
const ROD = () => cylinder(20, 40);

/** How many of the edge groups a blend reported it actually completed. */
function completed(diagnostic: string | undefined): { done: number; total: number } | null {
  if (!diagnostic) return null; // no diagnostic means every group succeeded
  const m = diagnostic.match(/(?:Rounded|Chamfered) (\d+) of (\d+)/);
  if (m) return { done: Number(m[1]), total: Number(m[2]) };
  if (/^No edges were (rounded|chamfered) \((\d+) groups/.test(diagnostic)) {
    return { done: 0, total: Number(diagnostic.match(/\((\d+) groups/)![1]) };
  }
  return null;
}

function solid(m: Mesh) {
  const h = health(m);
  return { closed: h.closed, manifold: h.manifold };
}

describe('rounding a box', () => {
  it('produces a closed, manifold solid', () => {
    const r = filletEdges(BOX(), { radius: 3 });
    expect(solid(r.mesh)).toEqual({ closed: true, manifold: true });
    expect(r.valid).toBe(true);
  });

  it('rounds all twelve edges', () => {
    // The history of this one number is the history of the kernel. Three of twelve with the
    // tools combined before cutting; five once each chain was re-found on the current body;
    // ten once the tools were lifted clear of the faces they cut. All twelve since the
    // booleans went through Manifold, which is manifold by construction rather than by
    // getting the epsilons right.
    const r = filletEdges(BOX(), { radius: 3 });
    const c = completed(r.diagnostic);
    expect(c, r.diagnostic).toBeNull();
  });

  it('removes material rather than adding it', () => {
    const before = massProperties(BOX()).volume;
    const after = massProperties(filletEdges(BOX(), { radius: 3 }).mesh).volume;
    expect(after).toBeLessThan(before);
    // A 3 mm round on a 60×40×20 box takes off a fraction of a percent, not a chunk.
    expect(after).toBeGreaterThan(before * 0.97);
  });

  it('does not explode the triangle count', () => {
    // Twelve triangles in. Combining the tools before cutting gave 3814 and an open body;
    // the BSP at its best gave 994. Around 500 now, because there is no fragmentation to
    // clean up rather than because anything is being simplified afterwards.
    expect(triCount(filletEdges(BOX(), { radius: 3 }).mesh)).toBeLessThan(1000);
  });

  it('refuses a radius larger than the edge it runs along', () => {
    const r = filletEdges(BOX(), { radius: 40 });
    expect(r.valid).toBe(false);
    expect(r.diagnostic).toMatch(/too large/i);
    expect(triCount(r.mesh)).toBe(triCount(BOX()));
  });
});

describe('rounding a cylinder', () => {
  it('rounds both rims cleanly', () => {
    const r = filletEdges(ROD(), { radius: 3 });
    expect(solid(r.mesh)).toEqual({ closed: true, manifold: true });
    expect(r.diagnostic).toBeUndefined();
  });

  it('stays fast, because a rim is one revolve and not fifty prisms', () => {
    // A rim broken into collinear fragments by the first cut stops fitting a circle, falls to
    // the general path, and builds a fifty-thousand-triangle tool that takes seconds and then
    // fails. Fusing the fragments is what keeps this in the hundreds of milliseconds.
    const t = Date.now();
    const r = filletEdges(ROD(), { radius: 3 });
    expect(Date.now() - t).toBeLessThan(6000);
    expect(triCount(r.mesh)).toBeLessThan(12000);
  });
});

describe('scoping a blend to chosen faces', () => {
  it('rounds only the edges of the face given', () => {
    const base = BOX();
    const face = [...base.tags.keys()][0];

    const scoped = filletEdges(base, { radius: 3, faces: [face] });
    expect(solid(scoped.mesh)).toEqual({ closed: true, manifold: true });

    // A box face has four edges, so a scoped round must remove less than rounding all twelve.
    const scopedCut = massProperties(base).volume - massProperties(scoped.mesh).volume;
    const allCut = massProperties(base).volume
      - massProperties(filletEdges(base, { radius: 3 }).mesh).volume;
    expect(scopedCut).toBeGreaterThan(0);
    expect(scopedCut).toBeLessThan(allCut);
  });

  it('says so plainly when the chosen faces have no edges to round', () => {
    const r = filletEdges(BOX(), { radius: 3, faces: [99999] });
    expect(r.valid).toBe(true);
    expect(triCount(r.mesh)).toBe(triCount(BOX()));
    expect(r.diagnostic).toMatch(/no sharp edges/i);
  });

  it('between means the seam only, and two opposite faces have no seam', () => {
    const base = BOX();
    const tags = [...base.tags.keys()];
    // A box's first and second tags are its two caps — opposite, never adjacent.
    const r = filletEdges(base, { radius: 3, faces: [tags[0], tags[1]], faceMatch: 'between' });
    expect(triCount(r.mesh)).toBe(triCount(base));
  });
});

describe('choosing outside or inside edges', () => {
  /** An L-shaped prism: six convex edges per cap and one concave edge running the length. */
  const ELL = () => extrude(
    makeProfile([[0, 0], [60, 0], [60, 10], [10, 10], [10, 50], [0, 50]]),
    XY,
    { distance: 20, feature: 'L' },
  );

  it('an L has both kinds of edge', () => {
    const edges = sharpEdges(ELL(), 45);
    expect(edges.some((e) => e.convex)).toBe(true);
    expect(edges.some((e) => !e.convex)).toBe(true);
  });

  it('rounding the inside corner adds material', () => {
    // A concave blend fills the corner rather than cutting it. Getting this backwards is how
    // a bracket ends up weaker than the drawing says.
    const before = massProperties(ELL()).volume;
    const r = filletEdges(ELL(), { radius: 4, minAngleDeg: 45, convexity: 'concave' });
    expect(solid(r.mesh)).toEqual({ closed: true, manifold: true });
    expect(massProperties(r.mesh).volume).toBeGreaterThan(before);
  });

  it('rounding the outside edges removes material', () => {
    const before = massProperties(ELL()).volume;
    const r = filletEdges(ELL(), { radius: 3, minAngleDeg: 45, convexity: 'convex' });
    expect(solid(r.mesh)).toEqual({ closed: true, manifold: true });
    expect(massProperties(r.mesh).volume).toBeLessThan(before);
  });

  it('asking for inside edges on a body that has none changes nothing', () => {
    const r = filletEdges(BOX(), { radius: 3, convexity: 'concave' });
    expect(r.valid).toBe(true);
    expect(triCount(r.mesh)).toBe(triCount(BOX()));
    expect(r.diagnostic).toMatch(/no inside edges/i);
  });

  it('names both filters when a face scope and a convexity together match nothing', () => {
    // With two filters active, "no edges matched" sends someone hunting through their face
    // selection when the answer is that the faces they picked have no inside corners.
    const base = BOX();
    const face = [...base.tags.keys()][0];
    const r = filletEdges(base, { radius: 3, faces: [face], convexity: 'concave' });

    expect(r.diagnostic).toMatch(/selected face/i);
    expect(r.diagnostic).toMatch(/inside/i);
  });
});

describe('chamfering', () => {
  it('chamfers all twelve edges of a box', () => {
    // Every cutter built up front and subtracted together left five open edges; applying them
    // one at a time closed the body but still only cut seven of the twelve. All twelve now.
    const r = chamferEdges(BOX(), { distance: 2 });
    expect(solid(r.mesh)).toEqual({ closed: true, manifold: true });
    expect(r.valid).toBe(true);
    expect(completed(r.diagnostic), r.diagnostic).toBeNull();
  });

  it('cuts a cylinder rim cleanly', () => {
    const r = chamferEdges(ROD(), { distance: 2 });
    expect(solid(r.mesh)).toEqual({ closed: true, manifold: true });
    expect(r.diagnostic).toBeUndefined();
  });

  it('removes material in proportion to the square of the setback', () => {
    // A chamfer's section is a triangle with both legs equal to the distance, so its area —
    // and the volume it removes along a fixed edge — goes as the square. Doubling the setback
    // must therefore take roughly four times as much off, which is the check that the section
    // is built from the real face normals rather than a fixed 45-degree wedge.
    const base = BOX();
    const face = [...base.tags.keys()][0];
    const v0 = massProperties(base).volume;

    const small = v0 - massProperties(chamferEdges(base, { distance: 1, faces: [face] }).mesh).volume;
    const large = v0 - massProperties(chamferEdges(base, { distance: 2, faces: [face] }).mesh).volume;

    expect(small).toBeGreaterThan(0);
    expect(large / small).toBeGreaterThan(3);
    expect(large / small).toBeLessThan(5);
  });

  it('never chamfers a concave edge, which would add material', () => {
    const ell = extrude(
      makeProfile([[0, 0], [60, 0], [60, 10], [10, 10], [10, 50], [0, 50]]),
      XY,
      { distance: 20, feature: 'L' },
    );
    const before = massProperties(ell).volume;
    const r = chamferEdges(ell, { distance: 2, minAngleDeg: 45 });
    expect(massProperties(r.mesh).volume).toBeLessThan(before);
  });
});

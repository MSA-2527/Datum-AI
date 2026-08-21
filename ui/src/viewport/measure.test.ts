import { describe, expect, it } from 'vitest';
import { box, cylinder } from '../kernel/ops/build';
import { boolean } from '../kernel/ops/boolean';
import { raycast, type Mesh } from '../kernel/topo/mesh';
import { measureBetween, measureFace, measureFacePair, snap } from './measure';
import type { Vec3 } from '../kernel/math/vec';

/**
 * Measuring a part by clicking it.
 *
 * Every case here is a shape whose answer is known before the code runs — a 40 mm cube is
 * 40 mm across and a ⌀12 bore is ⌀12 — because the failure this file guards against is a
 * measurement that is plausible and wrong.
 */

/** A 40 mm cube, centred on the origin. */
const cube = (): Mesh => box(40, 40, 40);

/** The same cube with a ⌀12 bore through Z. */
function bored(): Mesh {
  return boolean(box(40, 40, 40), cylinder(6, 60), 'difference').mesh;
}

/** Fire a ray at the part from a long way off. */
function ray(from: Vec3, towards: Vec3): { origin: Vec3; direction: Vec3 } {
  return { origin: from, direction: towards };
}

describe('snapping', () => {
  it('takes a click near a corner to the corner', () => {
    const mesh = cube();
    // Aimed just inside the top face, close to the +X +Y corner.
    const { origin, direction } = ray([19.5, 19.5, 100], [0, 0, -1]);
    const s = snap(mesh, origin, direction, 2)!;

    expect(s.kind).toBe('vertex');
    expect(s.point.map((v) => Math.abs(v))).toEqual([20, 20, 20]);
  });

  it('takes a click near an edge to the edge, not to a corner across the face', () => {
    const mesh = cube();
    const { origin, direction } = ray([19.5, 0, 100], [0, 0, -1]);
    const s = snap(mesh, origin, direction, 2)!;

    expect(s.kind).toBe('edge');
    expect(s.point[0]).toBeCloseTo(20, 6);
    expect(s.point[2]).toBeCloseTo(20, 6);
    // It stayed where it was clicked along the edge rather than sliding to an end.
    expect(Math.abs(s.point[1])).toBeLessThan(1);
  });

  it('leaves a click in the middle of a face where it landed', () => {
    const mesh = cube();
    const s = snap(mesh, [0, 0, 100], [0, 0, -1], 2)!;

    expect(s.kind).toBe('surface');
    expect(s.movedMm).toBe(0);
    expect(s.point[2]).toBeCloseTo(20, 6);
  });

  it('does not snap across a triangulated flat face', () => {
    /*
     * The top of a cube is two triangles with a diagonal between them. That diagonal is not an
     * edge of the part — it moves if the mesh is retriangulated — so a click near it must stay
     * a surface point. A tool that snapped to it would report a dimension about the software.
     */
    const mesh = cube();
    const s = snap(mesh, [0.2, 0.2, 100], [0, 0, -1], 5)!;

    expect(s.kind).toBe('surface');
  });

  it('takes a click on a bore to the bore’s axis', () => {
    const mesh = bored();
    // Outward from the bore's own axis, so the first thing hit is the bore wall rather than
    // the outside of the block.
    const s = snap(mesh, [0, 0, 0], [1, 0, 0], 0.5)!;

    expect(s.kind).toBe('centre');
    expect(s.tag?.kind).toBe('cylindrical');
    // On the axis: x and y at the centre of the part.
    expect(Math.hypot(s.point[0], s.point[1])).toBeLessThan(1e-6);
  });

  it('does not snap to the facets of a curved surface', () => {
    /*
     * A cylinder is drawn as a many-sided prism, and the creases between its facets are as
     * geometrically real as the diagonal across a flat face and just as meaningless: neither
     * is an edge of the part, and a dimension taken to one changes when the part is remeshed
     * at a different tolerance. Snapping is by face rather than by angle for this reason.
     */
    const mesh = bored();
    const s = snap(mesh, [0, 0, 0], [1, 0, 0], 2)!;

    expect(s.kind).not.toBe('edge');
  });

  it('has nothing to say about a ray that misses', () => {
    expect(snap(cube(), [500, 500, 500], [1, 1, 1], 2)).toBeNull();
  });

  it('scales with the tolerance it is given, and not otherwise', () => {
    const mesh = cube();
    const near = ray([17, 17, 100], [0, 0, -1]);

    expect(snap(mesh, near.origin, near.direction, 1)!.kind).toBe('surface');
    expect(snap(mesh, near.origin, near.direction, 10)!.kind).toBe('vertex');
  });
});

describe('measuring between two points', () => {
  it('measures a cube across its corners', () => {
    const mesh = cube();
    const a = snap(mesh, [19.5, 19.5, 100], [0, 0, -1], 2)!;
    const b = snap(mesh, [-19.5, -19.5, -100], [0, 0, 1], 2)!;
    const m = measureBetween(a, b);

    // Corner to opposite corner of a 40 mm cube: 40√3.
    expect(m.distanceMm).toBeCloseTo(40 * Math.sqrt(3), 6);
    expect(m.deltaMm.map(Math.abs)).toEqual([40, 40, 40]);
  });

  it('gives the axis components, which is what a drawing dimensions in', () => {
    const mesh = cube();
    const a = snap(mesh, [0, 0, 100], [0, 0, -1], 0.1)!;
    const b = snap(mesh, [0, 0, -100], [0, 0, 1], 0.1)!;
    const m = measureBetween(a, b);

    expect(m.distanceMm).toBeCloseTo(40, 6);
    expect(m.deltaMm[0]).toBeCloseTo(0, 9);
    expect(m.deltaMm[1]).toBeCloseTo(0, 9);
    expect(Math.abs(m.deltaMm[2])).toBeCloseTo(40, 6);
  });

  it('puts the label between the two ends', () => {
    const mesh = cube();
    const a = snap(mesh, [0, 0, 100], [0, 0, -1], 0.1)!;
    const b = snap(mesh, [0, 0, -100], [0, 0, 1], 0.1)!;

    expect(measureBetween(a, b).midpoint[2]).toBeCloseTo(0, 6);
  });

  it('says what it measured to, so a number can be trusted', () => {
    const mesh = cube();
    const corner = snap(mesh, [19.5, 19.5, 100], [0, 0, -1], 2)!;
    const face = snap(mesh, [0, 0, -100], [0, 0, 1], 0.1)!;

    expect(measureBetween(corner, face).description).toBe('corner to surface');
  });
});

describe('measuring one face', () => {
  it('reads a bore’s diameter off the surface it came from, not off its facets', () => {
    const mesh = bored();
    const hit = raycast(mesh, [0, 0, 0], [1, 0, 0])!;
    const m = measureFace(mesh, hit.faceId);

    // Exactly 12, not the 11.94 a chord measurement across a faceted cylinder would give.
    expect(m.diameterMm).toBeCloseTo(12, 9);
    expect(m.kind).toBe('cylindrical');
    expect(m.label).toContain('⌀12.00');
  });

  it('measures a flat face’s area', () => {
    const mesh = cube();
    const hit = raycast(mesh, [0, 0, 100], [0, 0, -1])!;
    const m = measureFace(mesh, hit.faceId);

    expect(m.areaMm2).toBeCloseTo(1600, 6);
    expect(m.kind).toBe('planar');
    expect(m.label).toContain('flat face');
  });

  it('offers no diameter for a face that has none', () => {
    const mesh = cube();
    const hit = raycast(mesh, [0, 0, 100], [0, 0, -1])!;

    expect(measureFace(mesh, hit.faceId).diameterMm).toBeUndefined();
  });
});

describe('measuring between two faces', () => {
  it('measures the thickness across two parallel faces', () => {
    const mesh = cube();
    const top = raycast(mesh, [0, 0, 100], [0, 0, -1])!.faceId;
    const bottom = raycast(mesh, [0, 0, -100], [0, 0, 1])!.faceId;
    const m = measureFacePair(mesh, top, bottom);

    expect(m.kind).toBe('thickness');
    expect(m.value).toBeCloseTo(40, 6);
  });

  it('measures the angle between two faces that are not parallel', () => {
    const mesh = cube();
    const top = raycast(mesh, [0, 0, 100], [0, 0, -1])!.faceId;
    const side = raycast(mesh, [100, 0, 0], [-1, 0, 0])!.faceId;
    const m = measureFacePair(mesh, top, side);

    expect(m.kind).toBe('angle');
    expect(m.value).toBeCloseTo(90, 6);
  });

  it('measures centre to centre between two parallel bores', () => {
    const two = boolean(
      boolean(box(80, 40, 20), cylinder(5, 60, [-20, 0, 0]), 'difference').mesh,
      cylinder(5, 60, [20, 0, 0]), 'difference',
    ).mesh;

    // From each bore's own axis, outward: the first thing hit is that bore's wall.
    const a = raycast(two, [-20, 0, 0], [1, 0, 0])!;
    const b = raycast(two, [20, 0, 0], [1, 0, 0])!;
    const m = measureFacePair(two, a.faceId, b.faceId);

    expect(a.faceId).not.toBe(b.faceId);
    expect(m.kind).toBe('centres');
    expect(m.value).toBeCloseTo(40, 3);
  });

  it('declines to invent a dimension where the pair has none', () => {
    const mesh = cube();
    const top = raycast(mesh, [0, 0, 100], [0, 0, -1])!.faceId;

    // A face against nothing: an id no tag exists for.
    const m = measureFacePair(mesh, top, 999_999);
    expect(m.kind).toBe('none');
    expect(m.value).toBeNull();
    expect(m.label).toContain('point to point');
  });
});

import { describe, expect, it } from 'vitest';
import { box, cylinder, extrude, revolve, XY } from './build';
import { boolean } from './boolean';
import { raycast } from '../topo/mesh';
import type { Vec2, Vec3 } from '../math/vec';

/**
 * What a built solid says about itself.
 *
 * The geometry of a primitive is checked all over this suite — by volume, by closure, by what
 * a boolean does with it. What is checked here is the *tagging*: which face is which, and which
 * way each one points. A tag is metadata, so nothing downstream can tell a wrong one from a
 * right one, and every consumer of it — drawings, draft checks, sections, measurement — is
 * wrong in the same direction at once.
 */

describe('which way a face points', () => {
  /*
   * Every side wall of an extrusion used to be tagged with the extrusion direction, so an
   * extruded box reported +Z for all six faces: the lid's normal on the walls. Nothing failed,
   * because a tag that is present and well-formed passes every structural check there is — and
   * everything that reads a normal to decide which way a face looks was quietly wrong.
   */
  it('gives each face of a box its own outward normal', () => {
    const m = box(40, 40, 40);
    const cases: [Vec3, Vec3, Vec3][] = [
      [[100, 0, 0], [-1, 0, 0], [1, 0, 0]],
      [[-100, 0, 0], [1, 0, 0], [-1, 0, 0]],
      [[0, 100, 0], [0, -1, 0], [0, 1, 0]],
      [[0, -100, 0], [0, 1, 0], [0, -1, 0]],
      [[0, 0, 100], [0, 0, -1], [0, 0, 1]],
      [[0, 0, -100], [0, 0, 1], [0, 0, -1]],
    ];

    for (const [from, along, expected] of cases) {
      const hit = raycast(m, from, along)!;
      const normal = m.tags.get(hit.faceId)?.normal;

      expect(normal, `no normal on the face hit from ${from}`).toBeDefined();
      for (let i = 0; i < 3; i++) {
        expect(normal![i], `face hit from ${from} points the wrong way`)
          .toBeCloseTo(expected[i]!, 9);
      }
    }
  });

  it('points a bore’s wall inward, away from the material', () => {
    const bored = boolean(box(40, 40, 40), cylinder(6, 60), 'difference').mesh;
    const hit = raycast(bored, [0, 0, 0], [1, 0, 0])!;
    const tag = bored.tags.get(hit.faceId)!;

    // A cylinder's tag carries its axis rather than a surface normal, which is what makes a
    // diameter callout possible.
    expect(tag.kind).toBe('cylindrical');
    expect(tag.radius).toBeCloseTo(6, 9);
  });

  it('gives a partial revolve’s end caps a direction, not an absence', () => {
    /*
     * They were tagged planar with no normal and no origin at all. An absent normal misleads
     * nobody, which makes it less dangerous than a wrong one — and it is still a face whose
     * direction is perfectly knowable being reported as unknown, so a section cannot tell which
     * side of it to keep and a measurement to it has nothing to work with.
     *
     * A rectangle at radius 10–30, revolved 90° about Z: the start cap lies in the XZ plane
     * with the material on its +Y side, and the end cap is that face carried round a quarter
     * turn.
     */
    const profile = {
      outer: [[10, 0], [30, 0], [30, 20], [10, 20]] as Vec2[],
      holes: [],
    };
    const plane = {
      origin: [0, 0, 0] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 0, 1] as Vec3,
      normal: [0, -1, 0] as Vec3,
    };
    const m = revolve(profile, plane, { axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 90 });

    const normals = [...m.tags.values()]
      .filter((t) => t.kind === 'planar')
      .map((t) => t.normal);

    expect(normals.every((n) => n !== undefined), 'a flat face was left without a normal')
      .toBe(true);

    const has = (want: Vec3) => normals.some((n) =>
      n!.every((v, i) => Math.abs(v - want[i]!) < 1e-9));

    expect(has([0, -1, 0]), 'the start cap does not face out of the XZ plane').toBe(true);
    expect(has([-1, 0, 0]), 'the end cap was not carried round by the sweep').toBe(true);
  });

  it('gives every face of an L-shape a distinct direction', () => {
    // Six walls, no two of which share an outward direction except the two pairs that face
    // the same way. A profile whose walls all reported the sweep axis would give one.
    const profile = {
      outer: [[0, 0], [60, 0], [60, 20], [20, 20], [20, 60], [0, 60]] as Vec2[],
      holes: [],
    };
    const m = extrude(profile, XY, { distance: 10 });
    const normals = new Set<string>();

    for (const tag of m.tags.values()) {
      if (tag.kind !== 'planar' || !tag.normal) continue;
      normals.add(tag.normal.map((v) => Number(v.toFixed(6))).join(','));
    }

    // Four distinct wall directions (±X, ±Y) plus the lid and the floor.
    expect(normals.size).toBe(6);
  });
});

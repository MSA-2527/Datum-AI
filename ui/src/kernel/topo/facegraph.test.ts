import { describe, expect, it } from 'vitest';
import { box, cylinder } from '../ops/build';
import { boolean, union } from '../ops/boolean';
import { drillHole } from '../ops/modify';
import { surfaceArea, type Mesh } from './mesh';
import {
  buildFaceGraph, describeGraph, facesWithRole, graphArea, seatCandidates, spanAlong,
} from './facegraph';
import { findHoles, findPatterns } from './holes';

/** A 40×30×10 plate centred on the origin; top face at z = +5. */
const plate = (): Mesh => box(40, 30, 10);

function valid<T extends { mesh: Mesh; valid: boolean; diagnostic?: string }>(r: T): Mesh {
  expect(r.valid, r.diagnostic).toBe(true);
  return r.mesh;
}

/**
 * A plate with through holes, cut as ONE difference against unioned cutters.
 *
 * Not merely a style preference. `difference` currently returns a non-manifold solid
 * whenever its first operand already contains a through hole — see
 * scratch.boolean.test.ts — so drilling holes one after another produces garbage from the
 * second hole onward, whatever the tool shape. Unioning the cutters first sidesteps it and
 * is what the feature evaluator should be doing anyway: one boolean beats N.
 */
function plateWithHoles(
  w: number, d: number, t: number, at: [number, number][], diameter = 6,
): Mesh {
  let tools: Mesh | null = null;
  for (const [x, y] of at) {
    const c = cylinder(diameter / 2, t * 6, [x, y, 0], [0, 0, 1], `Tool_${x}_${y}`);
    tools = tools === null ? c : valid(union(tools, c));
  }
  return valid(boolean(box(w, d, t), tools!, 'difference'));
}

describe('face graph', () => {
  it('reads a box as six flat faces and loses no area', () => {
    const g = buildFaceGraph(plate());

    expect(g.faces.size).toBe(6);
    for (const f of g.faces.values()) expect(f.tag.kind).toBe('planar');

    // The graph must account for the whole surface: a face dropped here is a face that
    // silently cannot be selected, dimensioned or mated.
    expect(graphArea(g)).toBeCloseTo(surfaceArea(plate()), 6);
  });

  it('calls the two largest faces seats and the edges plain', () => {
    const g = buildFaceGraph(plate());
    const seats = facesWithRole(g, 'seat');

    // 40×30 = 1200 each; the 40×10 and 30×10 sides are well below the seat threshold.
    expect(seats).toHaveLength(2);
    for (const s of seats) expect(s.area).toBeCloseTo(1200, 4);

    // ...and they face opposite ways.
    expect(Math.abs(seats[0].axis[2])).toBeCloseTo(1, 6);
    expect(seats[0].axis[2] * seats[1].axis[2]).toBeLessThan(0);
  });

  it('offers each seat direction only once', () => {
    // Both faces of a plate are the same datum, not two. A scheme that offers A and B
    // meaning the same thing is worse than one that offers A alone.
    const seats = seatCandidates(buildFaceGraph(plate()));
    for (let i = 0; i < seats.length; i++) {
      for (let j = i + 1; j < seats.length; j++) {
        expect(Math.abs(seats[i].axis[0] * seats[j].axis[0]
          + seats[i].axis[1] * seats[j].axis[1]
          + seats[i].axis[2] * seats[j].axis[2])).toBeLessThan(0.999);
      }
    }
  });

  it('tells a shaft from a bore', () => {
    // The distinction the tag cannot make: same kind, same radius, same axis — the material
    // is simply on the other side.
    const pin = buildFaceGraph(cylinder(5, 20));
    expect(facesWithRole(pin, 'shaft').length).toBeGreaterThanOrEqual(1);
    expect(facesWithRole(pin, 'bore')).toHaveLength(0);

    const drilled = buildFaceGraph(plateWithHoles(40, 30, 10, [[0, 0]]));
    expect(facesWithRole(drilled, 'bore').length).toBeGreaterThanOrEqual(1);
  });

  it('measures the body span along an arbitrary axis', () => {
    const [lo, hi] = spanAlong(plate(), [0, 0, 1]);
    expect(hi - lo).toBeCloseTo(10, 6);
  });

  it('describes every face in one line each', () => {
    const lines = describeGraph(buildFaceGraph(plate()));
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^#\d+ \w+/);
  });
});

describe('hole recognition', () => {
  it('recovers a through hole with its diameter', () => {
    const mesh = plateWithHoles(40, 30, 10, [[0, 0]]);
    const holes = findHoles(mesh, buildFaceGraph(mesh));

    expect(holes).toHaveLength(1);
    expect(holes[0].diameter).toBeCloseTo(6, 1);
    expect(holes[0].through).toBe(true);
    // A through hole has no "into the material" end, so only the line is meaningful.
    expect(Math.abs(holes[0].axis[2])).toBeCloseTo(1, 3);
  });

  it('points a blind hole into the material', () => {
    // Here the direction *is* meaningful: a fastener placed on this axis has to go in
    // rather than out, and reporting the axis backwards puts every screw the wrong way.
    const r = drillHole(plate(), {
      kind: 'simple', diameter: 6, depth: 6,
      at: [0, 0, 5], direction: [0, 0, -1],
    });
    expect(r.valid, r.diagnostic).toBe(true);

    const holes = findHoles(r.mesh, buildFaceGraph(r.mesh));
    expect(holes).toHaveLength(1);
    expect(holes[0].through).toBe(false);
    expect(holes[0].axis[2]).toBeLessThan(0);
  });

  it('keeps two parallel holes apart', () => {
    // Grouping on axis direction alone — rather than on the axis *line* — merges these into
    // one hole of impossible depth. It is the single easiest mistake to make here.
    const mesh = plateWithHoles(40, 30, 10, [[-10, 0], [10, 0]]);

    const holes = findHoles(mesh, buildFaceGraph(mesh));
    expect(holes).toHaveLength(2);
  });

  it('reads a counterbore as one hole, not two', () => {
    const r = drillHole(plate(), {
      kind: 'counterbore', diameter: 6.6, depth: 20, through: true,
      headDiameter: 11, headDepth: 6.5,
      at: [0, 0, 5], direction: [0, 0, -1],
    });
    expect(r.valid, r.diagnostic).toBe(true);

    const holes = findHoles(r.mesh, buildFaceGraph(r.mesh));
    expect(holes).toHaveLength(1);
    expect(holes[0].kind).toBe('counterbore');
    expect(holes[0].diameter).toBeCloseTo(6.6, 1);
    expect(holes[0].headDiameter).toBeCloseTo(11, 1);
  });
});

describe('pattern recognition', () => {
  it('finds a bolt circle', () => {
    // Four M6 clearance holes on a 40 mm bolt circle — a drawing dimensions this once.
    const r = 20;
    const at = [0, 90, 180, 270].map((a): [number, number] => {
      const rad = (a * Math.PI) / 180;
      return [r * Math.cos(rad), r * Math.sin(rad)];
    });
    const mesh = plateWithHoles(70, 70, 10, at);

    const holes = findHoles(mesh, buildFaceGraph(mesh));
    expect(holes).toHaveLength(4);

    const patterns = findPatterns(holes);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].kind).toBe('circular');
    expect(patterns[0].boltCircle).toBeCloseTo(40, 1);
    expect(patterns[0].holes).toHaveLength(4);
  });

  it('finds an evenly pitched row', () => {
    const mesh = plateWithHoles(100, 20, 10, [[-30, 0], [-10, 0], [10, 0], [30, 0]]);

    const patterns = findPatterns(findHoles(mesh, buildFaceGraph(mesh)));
    expect(patterns).toHaveLength(1);
    expect(patterns[0].kind).toBe('linear');
    expect(patterns[0].pitch).toBeCloseTo(20, 1);
  });

  it('refuses to call an uneven row a pattern', () => {
    // Unevenly spaced holes are several holes. Reporting them as a pattern would put one
    // position tolerance on features that need three.
    const mesh = plateWithHoles(100, 20, 10, [[-30, 0], [-5, 0], [12, 0], [33, 0]]);

    expect(findPatterns(findHoles(mesh, buildFaceGraph(mesh)))).toHaveLength(0);
  });
});

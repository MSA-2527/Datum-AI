import { describe, expect, it } from 'vitest';
import { box, cylinder } from '../ops/build';
import { boolean, union } from '../ops/boolean';
import type { Mesh } from '../topo/mesh';
import { buildFaceGraph } from '../topo/facegraph';
import { findHoles, findPatterns } from '../topo/holes';
import { describeCandidate, inferMates, type PartFaces } from './mateinfer';

function valid<T extends { mesh: Mesh; valid: boolean; diagnostic?: string }>(r: T): Mesh {
  expect(r.valid, r.diagnostic).toBe(true);
  return r.mesh;
}

/** Everything inference needs about one part, derived the way a caller would. */
function part(instance: string, mesh: Mesh): PartFaces {
  const graph = buildFaceGraph(mesh);
  const holes = findHoles(mesh, graph);
  return { instance, graph, holes, patterns: findPatterns(holes) };
}

/** A plate with through holes, cut as one difference against unioned cutters. */
function plateWithHoles(
  w: number, d: number, t: number, at: [number, number][], diameter: number,
): Mesh {
  let tools: Mesh | null = null;
  for (const [x, y] of at) {
    const c = cylinder(diameter / 2, t * 6, [x, y, 0], [0, 0, 1], `Tool_${x}_${y}`);
    tools = tools === null ? c : valid(union(tools, c));
  }
  return valid(boolean(box(w, d, t), tools!, 'difference'));
}

const boltCircle = (r: number, n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i * 2 * Math.PI) / n;
    return [r * Math.cos(a), r * Math.sin(a)] as [number, number];
  });

describe('bolt pattern matching', () => {
  it('matches two flanges sharing a bolt circle, and clocks them', () => {
    const flangeA = part('A', plateWithHoles(80, 80, 10, boltCircle(25, 4), 6.6));
    const flangeB = part('B', plateWithHoles(80, 80, 8, boltCircle(25, 4), 6.6));

    expect(flangeA.patterns).toHaveLength(1);
    expect(flangeB.patterns).toHaveLength(1);

    const mates = inferMates(flangeA, flangeB);
    const pattern = mates.filter((m) => m.why.includes('bolt circle'));

    // One to align and centre the axes, one to stop the joint spinning.
    expect(pattern.length).toBeGreaterThanOrEqual(1);
    expect(pattern[0].kind).toBe('concentric');
    expect(pattern[0].score).toBeGreaterThan(0.9);
    expect(pattern[0].why).toContain('50.0 mm bolt circle');

    expect(mates.some((m) => m.why.includes('clock'))).toBe(true);
  });

  it('does not match flanges whose bolt circles differ', () => {
    const flangeA = part('A', plateWithHoles(80, 80, 10, boltCircle(25, 4), 6.6));
    const flangeB = part('B', plateWithHoles(80, 80, 10, boltCircle(32, 4), 6.6));

    const mates = inferMates(flangeA, flangeB);
    expect(mates.some((m) => m.why.includes('bolt circle'))).toBe(false);
  });

  it('does not match patterns with different hole counts', () => {
    const four = part('A', plateWithHoles(90, 90, 10, boltCircle(25, 4), 6.6));
    const six = part('B', plateWithHoles(90, 90, 10, boltCircle(25, 6), 6.6));

    const mates = inferMates(four, six);
    expect(mates.some((m) => m.why.includes('bolt circle'))).toBe(false);
  });
});

describe('shaft in bore', () => {
  it('proposes a concentric fit and names the clearance', () => {
    const pin = part('pin', cylinder(3, 30));
    const plate = part('plate', plateWithHoles(40, 40, 10, [[0, 0]], 6.6));

    const mates = inferMates(pin, plate);
    const fit = mates.find((m) => m.why.includes('clearance'));

    expect(fit).toBeDefined();
    expect(fit!.kind).toBe('concentric');
    expect(fit!.why).toContain('ISO 273');
    expect(fit!.score).toBeGreaterThan(0.75);
  });

  it('rates a location fit above a loose one', () => {
    const pin = part('pin', cylinder(5, 30));
    const snug = part('snug', plateWithHoles(40, 40, 10, [[0, 0]], 10.1));
    const sloppy = part('sloppy', plateWithHoles(40, 40, 10, [[0, 0]], 12.5));

    const tight = inferMates(pin, snug).find((m) => m.kind === 'concentric')!;
    const loose = inferMates(pin, sloppy).find((m) => m.kind === 'concentric')!;

    expect(tight.score).toBeGreaterThan(loose.score);
  });

  it('refuses a pin that cannot physically enter the bore', () => {
    // A 20 mm pin and a 6 mm hole are both round and have nothing else to do with each
    // other. Offering it even at low confidence is noise.
    const fat = part('fat', cylinder(10, 30));
    const small = part('small', plateWithHoles(60, 60, 10, [[0, 0]], 6.6));

    const mates = inferMates(fat, small);
    expect(mates.some((m) => m.why.includes('clearance') || m.why.includes('press'))).toBe(false);
  });

  it('works whichever part carries the pin', () => {
    const pin = part('pin', cylinder(3, 30));
    const plate = part('plate', plateWithHoles(40, 40, 10, [[0, 0]], 6.6));

    const forward = inferMates(pin, plate).filter((m) => m.kind === 'concentric');
    const reverse = inferMates(plate, pin).filter((m) => m.kind === 'concentric');

    expect(forward.length).toBeGreaterThan(0);
    expect(reverse.length).toBe(forward.length);
  });
});

describe('seating faces', () => {
  it('proposes orientation only, and says why that is not the whole mate', () => {
    const a = part('a', box(40, 30, 10));
    const b = part('b', box(40, 30, 6));

    const seat = inferMates(a, b).find((m) => m.kind === 'angle');

    expect(seat).toBeDefined();
    expect(seat!.value).toBe(180);
    // The vocabulary has no point-on-plane mate, and pretending otherwise by emitting a
    // point-to-point coincident would fight any bolt-pattern mate applied alongside it.
    expect(seat!.incomplete).toContain('point-on-plane');
  });

  it('ignores faces of wildly different size', () => {
    const plate = part('plate', box(200, 200, 10));
    const chip = part('chip', box(6, 6, 2));

    expect(inferMates(plate, chip).some((m) => m.kind === 'angle')).toBe(false);
  });
});

describe('ranking and reporting', () => {
  it('puts the pattern match above the individual hole fits it implies', () => {
    const flangeA = part('A', plateWithHoles(80, 80, 10, boltCircle(25, 4), 6.6));
    const flangeB = part('B', plateWithHoles(80, 80, 8, boltCircle(25, 4), 6.6));

    const mates = inferMates(flangeA, flangeB);

    expect(mates.length).toBeGreaterThan(0);
    expect(mates[0].why).toContain('bolt circle');
    // Sorted, best first.
    for (let i = 1; i < mates.length; i++) {
      expect(mates[i - 1].score).toBeGreaterThanOrEqual(mates[i].score);
    }
  });

  it('every candidate carries a reason a person can check', () => {
    const pin = part('pin', cylinder(3, 30));
    const plate = part('plate', plateWithHoles(40, 40, 10, [[0, 0]], 6.6));

    for (const c of inferMates(pin, plate)) {
      expect(c.why.length).toBeGreaterThan(10);
      expect(describeCandidate(c)).toMatch(/^\d+% \w+/);
    }
  });

  it('emits refs in part coordinates, which is what the solver consumes', () => {
    const pin = part('pin', cylinder(3, 30));
    const plate = part('plate', plateWithHoles(40, 40, 10, [[0, 0]], 6.6));

    const c = inferMates(pin, plate).find((m) => m.kind === 'concentric')!;

    expect(c.a.instance).toBe('pin');
    expect(c.b.instance).toBe('plate');
    expect(c.a.direction).toBeDefined();
    expect(c.a.point).toBeDefined();
    // A concentric needs both an axis and a point on it, or the solver's perpendicular
    // residual has nothing to work with.
    expect(c.b.direction).toBeDefined();
    expect(c.b.point).toBeDefined();
  });
});

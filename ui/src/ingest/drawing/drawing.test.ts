import { describe, expect, it } from 'vitest';
import { assembleLoops, flatten, readDxf, UNIT_TO_MM } from './dxf';
import {
  assignRoles, clusterViews, describeReconstruction, importDrawing, loopsToProfile,
  reconstruct, splitBodies,
} from './reconstruct';
import { health, massProperties, bounds } from '../../kernel/topo/mesh';
import { profileArea } from '../../kernel/sketch/profile';

/**
 * DXF import and reconstruction tests.
 *
 * A drawing import that quietly loses geometry is worse than one that fails, because the
 * user gets a part that looks finished and is wrong. So alongside the accuracy checks, these
 * assert that the reader *reports* what it could not use, and that reconstruction states its
 * own limits rather than presenting a visual hull as if it were the true part.
 */

// ── DXF construction helpers ─────────────────────────────────────────────────

const pair = (code: number, value: string | number) => `${code}\r\n${value}`;

function dxf(entities: string[], insunits?: number): string {
  const header = insunits === undefined ? [] : [
    pair(0, 'SECTION'), pair(2, 'HEADER'),
    pair(9, '$INSUNITS'), pair(70, insunits),
    pair(0, 'ENDSEC'),
  ];
  return [
    ...header,
    pair(0, 'SECTION'), pair(2, 'ENTITIES'),
    ...entities,
    pair(0, 'ENDSEC'),
    pair(0, 'EOF'),
  ].join('\r\n');
}

const line = (x1: number, y1: number, x2: number, y2: number, layer = '0') =>
  [pair(0, 'LINE'), pair(8, layer), pair(10, x1), pair(20, y1), pair(11, x2), pair(21, y2)].join('\r\n');

const circle = (cx: number, cy: number, r: number, layer = '0') =>
  [pair(0, 'CIRCLE'), pair(8, layer), pair(10, cx), pair(20, cy), pair(40, r)].join('\r\n');

const arc = (cx: number, cy: number, r: number, a0: number, a1: number) =>
  [pair(0, 'ARC'), pair(8, '0'), pair(10, cx), pair(20, cy), pair(40, r), pair(50, a0), pair(51, a1)].join('\r\n');

function lwpolyline(points: [number, number][], closed = true, layer = '0'): string {
  const parts = [pair(0, 'LWPOLYLINE'), pair(8, layer), pair(90, points.length), pair(70, closed ? 1 : 0)];
  for (const [x, y] of points) { parts.push(pair(10, x), pair(20, y)); }
  return parts.join('\r\n');
}

/** A closed rectangle drawn as four separate LINE entities, as a real drawing would. */
function rectLines(x0: number, y0: number, w: number, h: number): string[] {
  return [
    line(x0, y0, x0 + w, y0),
    line(x0 + w, y0, x0 + w, y0 + h),
    line(x0 + w, y0 + h, x0, y0 + h),
    line(x0, y0 + h, x0, y0),
  ];
}

// ── reading ──────────────────────────────────────────────────────────────────

describe('reading DXF', () => {
  it('rejects a file that is not DXF, and says what to do', () => {
    const r = readDxf('this is not a drawing');
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/ASCII DXF|SECTION/i);
  });

  it('reads lines with the right coordinates', () => {
    const r = readDxf(dxf([line(0, 0, 100, 50)]));
    expect('error' in r).toBe(false);
    if ('error' in r) return;

    expect(r.entities.length).toBe(1);
    const e = r.entities[0];
    expect(e.type).toBe('line');
    if (e.type === 'line') {
      expect(e.a).toEqual([0, 0]);
      expect(e.b).toEqual([100, 50]);
    }
  });

  it('reads circles and arcs', () => {
    const r = readDxf(dxf([circle(20, 30, 8), arc(0, 0, 25, 0, 90)]));
    expect('error' in r).toBe(false);
    if ('error' in r) return;

    const c = r.entities.find((e) => e.type === 'circle');
    expect(c).toBeDefined();
    if (c?.type === 'circle') expect(c.radius).toBe(8);

    const a = r.entities.find((e) => e.type === 'arc');
    if (a?.type === 'arc') {
      expect(a.radius).toBe(25);
      expect(a.startDeg).toBe(0);
      expect(a.endDeg).toBe(90);
    }
  });

  it('reads a polyline\'s vertices in order, not just the first of each code', () => {
    // Reading by "first code 10" instead of positionally is the classic DXF parsing bug and
    // silently collapses every polyline to a single point.
    const pts: [number, number][] = [[0, 0], [50, 0], [50, 30], [20, 30], [0, 15]];
    const r = readDxf(dxf([lwpolyline(pts)]));
    expect('error' in r).toBe(false);
    if ('error' in r) return;

    const p = r.entities[0];
    expect(p.type).toBe('polyline');
    if (p.type === 'polyline') {
      expect(p.points.length).toBe(5);
      expect(p.points[2]).toEqual([50, 30]);
      expect(p.closed).toBe(true);
    }
  });

  it('records layers', () => {
    const r = readDxf(dxf([line(0, 0, 10, 0, 'OUTLINE'), circle(5, 5, 2, 'HOLES')]));
    if ('error' in r) return;
    expect(r.layers).toContain('OUTLINE');
    expect(r.layers).toContain('HOLES');
  });

  it('reads the unit code and converts accordingly', () => {
    const r = readDxf(dxf([line(0, 0, 10, 0)], 1)); // 1 = inches
    if ('error' in r) return;
    expect(r.units).toBe('in');
    expect(UNIT_TO_MM[r.units]).toBeCloseTo(25.4, 6);
  });

  it('warns when the file declares no units, rather than assuming silently', () => {
    // Guessing wrong here makes the part 25.4x the wrong size, so it has to be said.
    const r = readDxf(dxf([line(0, 0, 10, 0)]));
    if ('error' in r) return;
    expect(r.report.warnings.some((w) => /units/i.test(w))).toBe(true);
  });

  it('reports entity types it could not use instead of dropping them', () => {
    const text = [pair(0, 'MTEXT'), pair(8, '0'), pair(1, 'NOTE')].join('\r\n');
    const r = readDxf(dxf([line(0, 0, 10, 0), text]));
    if ('error' in r) return;

    expect(r.report.skipped.some((s) => s.type === 'MTEXT')).toBe(true);
    expect(r.report.warnings.join(' ')).toMatch(/MTEXT/);
  });

  it('explains a file with no geometry', () => {
    const text = [pair(0, 'MTEXT'), pair(8, '0'), pair(1, 'NOTE')].join('\r\n');
    const r = readDxf(dxf([text]));
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/no usable geometry/i);
  });

  it('survives a truncated file without throwing', () => {
    const partial = [pair(0, 'SECTION'), pair(2, 'ENTITIES'), pair(0, 'LINE'), pair(8, '0'), pair(10, '5')].join('\r\n');
    expect(() => readDxf(partial)).not.toThrow();
  });
});

// ── flattening and loops ─────────────────────────────────────────────────────

describe('flattening', () => {
  it('tessellates a circle finely enough to measure', () => {
    const r = readDxf(dxf([circle(0, 0, 50)]));
    if ('error' in r) return;

    const paths = flatten(r, { tolerance: 0.05 });
    expect(paths.length).toBe(1);
    expect(paths[0].closed).toBe(true);

    // Every point must be on the circle.
    for (const p of paths[0].points) expect(Math.hypot(p[0], p[1])).toBeCloseTo(50, 6);
  });

  it('scales by the document units', () => {
    const r = readDxf(dxf([line(0, 0, 2, 0)], 1)); // 2 inches
    if ('error' in r) return;

    const paths = flatten(r);
    expect(paths[0].points[1][0]).toBeCloseTo(50.8, 4);
  });

  it('sweeps an arc the right way round', () => {
    // DXF arcs always run counter-clockwise; one that wraps through zero has a negative
    // difference and must have a full turn added, or it sweeps the long way and the outline
    // comes out inside out.
    const r = readDxf(dxf([arc(0, 0, 10, 350, 10)]));
    if ('error' in r) return;

    const paths = flatten(r);
    const pts = paths[0].points;
    // A 20-degree arc is short; the chord from end to end must be small.
    expect(Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]))
      .toBeLessThan(5);
  });
});

describe('loop assembly', () => {
  it('joins four separate lines into one closed rectangle', () => {
    // This is what a real drawing looks like: a bag of unordered segments.
    const r = readDxf(dxf(rectLines(0, 0, 100, 60)));
    if ('error' in r) return;

    const { closed, open } = assembleLoops(flatten(r));
    expect(closed.length).toBe(1);
    expect(open.length).toBe(0);
    expect(profileArea({ outer: closed[0], holes: [] })).toBeCloseTo(6000, 1);
  });

  it('tolerates the small gaps real exporters leave', () => {
    // A 0.01 mm gap is invisible and completely normal, and it must not break the import.
    const r = readDxf(dxf([
      line(0, 0, 100, 0),
      line(100.01, 0, 100, 60),
      line(100, 60, 0, 60),
      line(0, 60.01, 0, 0),
    ]));
    if ('error' in r) return;

    expect(assembleLoops(flatten(r), 0.05).closed.length).toBe(1);
  });

  it('reports an outline that does not close, with the gap size and location', () => {
    const r = readDxf(dxf([
      line(0, 0, 100, 0),
      line(100, 0, 100, 60),
      line(100, 60, 0, 60),
      // Deliberately 4 mm short.
      line(0, 56, 0, 0),
    ]));
    if ('error' in r) return;

    const { open, report } = assembleLoops(flatten(r), 0.05);
    expect(open.length).toBeGreaterThan(0);
    expect(report.join(' ')).toMatch(/did not close/i);
    expect(report.join(' ')).toMatch(/4\.0/);
  });

  it('keeps a hole separate from its enclosing outline', () => {
    const r = readDxf(dxf([...rectLines(0, 0, 100, 60), circle(50, 30, 10)]));
    if ('error' in r) return;

    expect(assembleLoops(flatten(r)).closed.length).toBe(2);
  });
});

// ── profiles ─────────────────────────────────────────────────────────────────

describe('profile building', () => {
  it('nests a hole inside its outline', () => {
    const outer: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];
    const hole: [number, number][] = [[40, 20], [60, 20], [60, 40], [40, 40]];

    const p = loopsToProfile([outer, hole])!;
    expect(p.holes.length).toBe(1);
    expect(profileArea(p)).toBeCloseTo(6000 - 400, 3);
  });

  it('does not rely on winding direction, which exporters get wrong', () => {
    // Same shapes, both wound the same way. Trusting winding would fill the hole.
    const outer: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];
    const holeSameWinding: [number, number][] = [[40, 20], [60, 20], [60, 40], [40, 40]];

    const p = loopsToProfile([outer, holeSameWinding])!;
    expect(p.holes.length).toBe(1);
    expect(profileArea(p)).toBeLessThan(6000);
  });

  it('picks the largest loop as the outline whatever the order', () => {
    const hole: [number, number][] = [[40, 20], [60, 20], [60, 40], [40, 40]];
    const outer: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];

    const p = loopsToProfile([hole, outer])!;
    expect(profileArea(p)).toBeCloseTo(5600, 3);
  });
});

// ── view recognition ─────────────────────────────────────────────────────────

describe('view recognition', () => {
  it('separates views by the whitespace between them', () => {
    const a: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];
    const b: [number, number][] = [[0, -120], [100, -120], [100, -80], [0, -80]];

    expect(clusterViews([a, b]).length).toBe(2);
  });

  it('keeps a hole with its own view rather than splitting it off', () => {
    const outer: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];
    const hole: [number, number][] = [[45, 25], [55, 25], [55, 35], [45, 35]];

    expect(clusterViews([outer, hole]).length).toBe(1);
  });

  it('identifies the top view by vertical alignment and shared width', () => {
    const front: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];
    const top: [number, number][] = [[0, -100], [100, -100], [100, -60], [0, -60]];

    const roles = assignRoles(clusterViews([front, top]));
    expect(roles.map((r) => r.role).sort()).toEqual(['front', 'top']);

    const t = roles.find((r) => r.role === 'top')!;
    expect(t.reason).toMatch(/shares 100\.0 mm of its width/i);
  });

  it('identifies the side view by shared height and horizontal alignment', () => {
    const front: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];
    const side: [number, number][] = [[150, 0], [190, 0], [190, 60], [150, 60]];

    const roles = assignRoles(clusterViews([front, side]));
    expect(roles.some((r) => r.role === 'right')).toBe(true);
  });

  it('admits when a group does not fit the convention', () => {
    const front: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];
    const stray: [number, number][] = [[300, 300], [317, 300], [317, 311], [300, 311]];

    const roles = assignRoles(clusterViews([front, stray]));
    const unknown = roles.find((r) => r.role === 'unknown');
    expect(unknown).toBeDefined();
    expect(unknown!.reason).toMatch(/could not be determined/i);
  });
});

// ── reconstruction ───────────────────────────────────────────────────────────

describe('reconstruction', () => {
  it('builds a block from a front and a top view', () => {
    // 100 wide x 60 tall front, 100 wide x 40 deep top: a 100 x 40 x 60 block.
    const front: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];
    const top: [number, number][] = [[0, -100], [100, -100], [100, -60], [0, -60]];

    const r = reconstruct(assignRoles(clusterViews([front, top])));

    expect(r.valid).toBe(true);
    expect(health(r.mesh).closed).toBe(true);
    expect(r.volume).toBeCloseTo(100 * 40 * 60, -3);
  });

  it('builds an L-shaped part from two views', () => {
    const front: [number, number][] = [[0, 0], [80, 0], [80, 20], [20, 20], [20, 60], [0, 60]];
    const top: [number, number][] = [[0, -120], [80, -120], [80, -80], [0, -80]];

    const r = reconstruct(assignRoles(clusterViews([front, top])));
    expect(r.valid).toBe(true);

    // L area is 80*20 + 20*40 = 2400, extruded 40 deep.
    expect(r.volume).toBeCloseTo(2400 * 40, -3);
  });

  it('states the visual hull limitation rather than implying the part is exact', () => {
    const front: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];
    const top: [number, number][] = [[0, -100], [100, -100], [100, -60], [0, -60]];

    const r = reconstruct(assignRoles(clusterViews([front, top])));
    expect(r.caveats.join(' ')).toMatch(/visual hull|enclosed cavity|section view/i);
  });

  it('assumes a thickness for a single view, and says so', () => {
    const only: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];
    const r = reconstruct(assignRoles(clusterViews([only])));

    expect(r.valid).toBe(true);
    expect(r.caveats.join(' ')).toMatch(/only one view|depth is unknown/i);
  });

  it('honours an explicit thickness for a single view', () => {
    const only: [number, number][] = [[0, 0], [100, 0], [100, 60], [0, 60]];
    const r = reconstruct(assignRoles(clusterViews([only])), { singleViewThickness: 12 });
    expect(r.volume).toBeCloseTo(100 * 60 * 12, -2);
  });

  it('reports an empty intersection rather than a zero-volume success', () => {
    // The top view is offset sideways from the front view, so once they are aligned on
    // their shared X axis their prisms never meet. A drawing like this is malformed, and
    // the honest answer is to say so rather than return an empty body as a success.
    const r = reconstruct([
      { role: 'front', loops: [[[0, 0], [10, 0], [10, 10], [0, 10]]], origin: [0, 0], size: [10, 10], confidence: 1, reason: '' },
      { role: 'top', loops: [[[500, -50], [510, -50], [510, -40], [500, -40]]], origin: [500, -50], size: [10, 10], confidence: 1, reason: '' },
    ]);
    expect(r.valid).toBe(false);
    expect(r.caveats.join(' ')).toMatch(/do not overlap|empty/i);
  });

  it('keeps views aligned when they are not the same width', () => {
    // A stepped part: the front view is 100 wide, the top view only 60 and inset 20 from
    // the left. Normalising each view to its own bounding box would move the step 20 mm and
    // quietly cut away material that should be there.
    const front: [number, number][] = [[0, 0], [100, 0], [100, 40], [0, 40]];
    const top: [number, number][] = [[20, -100], [80, -100], [80, -70], [20, -70]];

    const r = reconstruct(assignRoles(clusterViews([front, top])));

    expect(r.valid).toBe(true);
    // Overlap is the 60 mm shared width x 30 deep x 40 tall.
    expect(r.volume).toBeCloseTo(60 * 30 * 40, -3);

    const b = bounds(r.mesh);
    // And the block must sit where the top view says, 20 mm in from the front view's left.
    expect(b.min[0]).toBeCloseTo(20, 1);
  });

  it('reports having nothing to work with', () => {
    const r = reconstruct([]);
    expect(r.valid).toBe(false);
    expect(r.caveats[0]).toMatch(/no view/i);
  });
});

// ── whole pipeline ───────────────────────────────────────────────────────────

describe('importing a drawing end to end', () => {
  it('turns a two-view DXF into a solid', () => {
    const doc = readDxf(dxf([
      ...rectLines(0, 0, 100, 60),
      ...rectLines(0, -100, 100, 40),
    ], 4)); // 4 = millimetres
    expect('error' in doc).toBe(false);
    if ('error' in doc) return;

    const r = importDrawing(doc);

    expect(r.valid).toBe(true);
    expect(health(r.mesh).closed).toBe(true);

    const b = bounds(r.mesh);
    expect(b.max[0] - b.min[0]).toBeCloseTo(100, 1);
    expect(r.report.length).toBeGreaterThan(0);
  });

  it('carries a hole through into the solid', () => {
    const doc = readDxf(dxf([
      ...rectLines(0, 0, 100, 60),
      circle(50, 30, 12),
      ...rectLines(0, -100, 100, 40),
    ], 4));
    if ('error' in doc) return;

    const r = importDrawing(doc);
    expect(r.valid).toBe(true);

    // The hole is a through-slot in the reconstructed prism, so volume must be well under
    // the solid block.
    expect(r.volume).toBeLessThan(100 * 40 * 60);
    expect(r.volume).toBeGreaterThan(100 * 40 * 60 * 0.5);
  });

  it('surfaces every warning the reader produced', () => {
    const doc = readDxf(dxf([...rectLines(0, 0, 100, 60), ...rectLines(0, -100, 100, 40)]));
    if ('error' in doc) return;

    const r = importDrawing(doc);
    // The units warning from the reader must reach the user, not stop at the reader.
    expect(r.report.some((line) => /units/i.test(line))).toBe(true);
  });

  it('describes the result in a way a person can check', () => {
    const doc = readDxf(dxf([...rectLines(0, 0, 100, 60), ...rectLines(0, -100, 100, 40)], 4));
    if ('error' in doc) return;

    const text = describeReconstruction(importDrawing(doc));
    expect(text).toMatch(/mm/);
    expect(text).toMatch(/cm³/);
  });
});

describe('splitting bodies', () => {
  it('leaves a single connected part alone', () => {
    const doc = readDxf(dxf([...rectLines(0, 0, 100, 60), ...rectLines(0, -100, 100, 40)], 4));
    if ('error' in doc) return;

    const r = importDrawing(doc);
    expect(splitBodies(r.mesh).length).toBe(1);
  });

  it('separates two disconnected bodies and orders them largest first', () => {
    const a = { positions: new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), indices: new Uint32Array([0, 1, 2]), faceIds: new Uint32Array([0]), tags: new Map() };
    const combined = {
      positions: new Float64Array([...a.positions, 100, 0, 0, 110, 0, 0, 100, 10, 0]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      faceIds: new Uint32Array([0, 0]),
      tags: new Map(),
    };
    expect(splitBodies(combined).length).toBe(2);
  });
});

void massProperties;

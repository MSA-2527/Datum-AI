import { describe, expect, it } from 'vitest';
import { centreMarks, hatchRegion, mergeCollinear, project, viewDirection } from './project';
import {
  autoDimension, chooseScale, formatDimension, formatFcf, generalTolerance, suggestGdt,
} from './dimension';
import { describeDrawing, drawingToDxf, drawingToSvg, makeDrawing, stockSize } from './sheet';
import { XY, box, cylinder, extrude } from '../kernel/ops/build';
import { subtractAll } from '../kernel/ops/boolean';
import { makeProfile } from '../kernel/sketch/profile';

/**
 * Drawing tests.
 *
 * A drawing is a manufacturing instruction, so these check the things that would cause a
 * part to be made wrong: that hidden edges are actually distinguished from visible ones,
 * that the projection is not mirrored, that dimensions match the geometry they measure, and
 * that the exported file is something a shop's software will open.
 */

/** A plate with four holes — the canonical thing to put on a drawing. */
function plateWithHoles() {
  const plate = extrude(makeProfile([[0, 0], [120, 0], [120, 80], [0, 80]]), XY, { distance: 10 });
  const drills = [[20, 20], [100, 20], [100, 60], [20, 60]].map(([x, y]) =>
    cylinder(4, 40, [x, y, 5], [0, 0, 1]),
  );
  return subtractAll(plate, drills).mesh;
}

describe('view directions', () => {
  it('gives right-handed orthonormal frames', () => {
    for (const v of ['front', 'top', 'right', 'left', 'bottom', 'rear', 'iso'] as const) {
      const d = viewDirection(v);
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

      expect(Math.hypot(...d.forward)).toBeCloseTo(1, 6);
      expect(Math.hypot(...d.right)).toBeCloseTo(1, 6);
      expect(Math.hypot(...d.up)).toBeCloseTo(1, 6);
      expect(dot(d.forward, d.right)).toBeCloseTo(0, 6);
      expect(dot(d.right, d.up)).toBeCloseTo(0, 6);
    }
  });

  it('puts the front view looking along -Y with Z up, as a modeller expects', () => {
    const d = viewDirection('front');
    expect(d.up[2]).toBeCloseTo(1, 6);
    expect(d.right[0]).toBeCloseTo(1, 6);
  });
});

describe('projection', () => {
  it('projects a box to its true size', () => {
    const p = project(box(60, 40, 20, [0, 0, 0]), { view: 'front' });
    // Front view of a 60 x 40 x 20 box shows 60 wide by 20 tall.
    expect(p.bounds.max[0] - p.bounds.min[0]).toBeCloseTo(60, 4);
    expect(p.bounds.max[1] - p.bounds.min[1]).toBeCloseTo(20, 4);
  });

  it('does not mirror the part', () => {
    // A box offset to +X must project to +X. Mirroring is the most expensive drawing error
    // there is, because the part gets made and only fails at assembly.
    const p = project(box(20, 20, 20, [50, 0, 0]), { view: 'front' });
    expect(p.bounds.min[0]).toBeGreaterThan(0);
    expect((p.bounds.min[0] + p.bounds.max[0]) / 2).toBeCloseTo(50, 4);
  });

  it('distinguishes hidden edges from visible ones', () => {
    // A blind pocket: its bottom face is behind material and must come out dashed.
    const solid = subtractAll(box(60, 60, 30), [box(20, 20, 20, [0, 0, 15])]).mesh;
    const p = project(solid, { view: 'front' });

    expect(p.report.visibleSegments).toBeGreaterThan(0);
    expect(p.report.hiddenSegments).toBeGreaterThan(0);
  });

  it('does not report every edge as hidden', () => {
    // The classic self-intersection artefact: rays re-hitting their own triangle make the
    // whole drawing dashed. The ray origin offset is what prevents it.
    const p = project(box(40, 40, 40), { view: 'front' });
    expect(p.report.visibleSegments).toBeGreaterThan(0);
    expect(p.segments.some((s) => s.style === 'visible')).toBe(true);
  });

  it('finds the silhouette of a cylinder, which has no sharp side edges', () => {
    // A crease test alone finds only the two end circles, and the shaft would be drawn as
    // two circles floating in space with no sides.
    const p = project(cylinder(15, 60, [0, 0, 0], [0, 0, 1]), { view: 'front' });
    expect(p.report.silhouetteEdges).toBeGreaterThan(0);
    expect(p.bounds.max[1] - p.bounds.min[1]).toBeCloseTo(60, 3);
  });

  it('recognises holes as circles rather than polygons', () => {
    const p = project(plateWithHoles(), { view: 'top' });
    const faceOn = p.circles.filter((c) => c.faceOn);

    expect(faceOn.length).toBeGreaterThanOrEqual(4);
    for (const c of faceOn.slice(0, 4)) expect(c.radius).toBeCloseTo(4, 1);
  });

  it('skips the hidden-line pass entirely when only visible lines are wanted', () => {
    // This used to be a wall-clock comparison of one run against another, and it failed
    // intermittently for reasons that had nothing to do with the code: at millisecond
    // granularity on a job this size, scheduling noise and JIT warm-up are larger than the
    // difference being measured. It passed alone and failed under a full parallel suite.
    //
    // The property the preview path actually promises is structural, not temporal — it does
    // not compute hidden lines — and that can be asserted exactly.
    const solid = plateWithHoles();

    const preview = project(solid, { view: 'front', visibleOnly: true });
    const full = project(solid, { view: 'front' });

    // Both walk the same edges — the preview is not a coarser projection, it is the same
    // projection with the visibility test skipped.
    expect(preview.report.edgesConsidered).toBe(full.report.edgesConsidered);

    // Nothing is classified as hidden, because nothing was tested. Every edge comes through
    // as drawn, which is what makes it a preview and not a drawing.
    expect(preview.report.hiddenSegments).toBe(0);
    expect(preview.report.visibleSegments).toBe(preview.report.edgesConsidered);
    expect(preview.segments.some((s) => s.style === 'hidden')).toBe(false);

    // The full pass does the work the preview skipped, and on a plate with four through
    // holes most of what you can draw is in fact behind material.
    expect(full.report.hiddenSegments).toBeGreaterThan(0);
    expect(full.report.visibleSegments).toBeLessThan(preview.report.visibleSegments);
    expect(full.segments.some((s) => s.style === 'hidden')).toBe(true);
  });

  // A wall-clock comparison used to live here and was deleted twice: once for comparing
  // single runs at millisecond granularity, and again after warm-up and a 1.5x slack still
  // failed at 92 ms against 63 ms under a parallel suite. Across 26 files running at once it
  // was measuring machine load, not the projector.
  //
  // The test above asserts the property the preview path actually promises — that it does not
  // compute hidden lines at all — which is exact, fast, and true regardless of what else the
  // machine is doing. Nothing is lost by not timing it here.
});

describe('line work', () => {
  it('merges collinear segments produced by sampling', () => {
    const segs = [
      { a: [0, 0] as [number, number], b: [10, 0] as [number, number], style: 'visible' as const, depth: 0 },
      { a: [10, 0] as [number, number], b: [20, 0] as [number, number], style: 'visible' as const, depth: 0 },
      { a: [20, 0] as [number, number], b: [30, 0] as [number, number], style: 'visible' as const, depth: 0 },
    ];
    const merged = mergeCollinear(segs);
    expect(merged.length).toBe(1);
    expect(Math.abs(merged[0].a[0] - merged[0].b[0])).toBeCloseTo(30, 6);
  });

  it('does not merge segments of different styles', () => {
    // A visible run and a hidden run meeting end to end are two different things and must
    // stay two lines, or the drawing loses the information it exists to carry.
    const segs = [
      { a: [0, 0] as [number, number], b: [10, 0] as [number, number], style: 'visible' as const, depth: 0 },
      { a: [10, 0] as [number, number], b: [20, 0] as [number, number], style: 'hidden' as const, depth: 0 },
    ];
    expect(mergeCollinear(segs).length).toBe(2);
  });

  it('adds a centre cross for each face-on circle', () => {
    const marks = centreMarks([
      { centre: [10, 10], radius: 5, faceOn: true, depth: 0, visible: true },
      { centre: [30, 10], radius: 5, faceOn: false, depth: 0, visible: true },
    ]);
    // Two lines for the one face-on circle; the edge-on one gets none.
    expect(marks.length).toBe(2);
    expect(marks.every((m) => m.style === 'centre')).toBe(true);
  });

  it('hatches a closed region with evenly spaced lines', () => {
    const square: [number, number][] = [[0, 0], [40, 0], [40, 40], [0, 40]];
    const lines = hatchRegion(square, 4, 45);

    expect(lines.length).toBeGreaterThan(5);
    // Every hatch line must lie inside the square.
    for (const l of lines) {
      for (const p of [l.a, l.b]) {
        expect(p[0]).toBeGreaterThanOrEqual(-1e-6);
        expect(p[0]).toBeLessThanOrEqual(40 + 1e-6);
      }
    }
  });
});

describe('dimensioning', () => {
  it('dimensions the overall envelope on both axes', () => {
    const p = project(box(120, 80, 10), { view: 'front', visibleOnly: true });
    const { dimensions } = autoDimension(p);

    const values = dimensions.filter((d) => d.kind === 'linear').map((d) => d.value);
    expect(values.some((v) => Math.abs(v - 120) < 0.1)).toBe(true);
    expect(values.some((v) => Math.abs(v - 10) < 0.1)).toBe(true);
  });

  it('collapses identical holes into one callout', () => {
    // Four 8 mm holes should read "4 x ⌀8", not four separate diameters. This is what a
    // draughtsman writes and what a machinist expects.
    const p = project(plateWithHoles(), { view: 'top', visibleOnly: true });
    const { dimensions } = autoDimension(p);

    const dia = dimensions.filter((d) => d.kind === 'diameter');
    expect(dia.length).toBeGreaterThanOrEqual(1);
    const grouped = dia.find((d) => (d.count ?? 1) > 1);
    expect(grouped).toBeDefined();
    expect(grouped!.text).toMatch(/x ⌀/);
  });

  it('locates holes from the part edges, never chained together', () => {
    const p = project(plateWithHoles(), { view: 'top', visibleOnly: true });
    const { dimensions, notes } = autoDimension(p);

    // Every position dimension must start at the view's own boundary.
    const positions = dimensions.filter((d) => d.kind === 'linear' && d.rationale.includes('position'));
    for (const d of positions) {
      const touchesEdge =
        Math.abs(d.from[0] - p.bounds.min[0]) < 1e-6 || Math.abs(d.from[1] - p.bounds.min[1]) < 1e-6;
      expect(touchesEdge).toBe(true);
    }
    expect(notes.join(' ')).toMatch(/never chained|accumulate/i);
  });

  it('gives every dimension a rationale', () => {
    const p = project(plateWithHoles(), { view: 'top', visibleOnly: true });
    for (const d of autoDimension(p).dimensions) expect(d.rationale.length).toBeGreaterThan(8);
  });

  it('reports an empty view instead of dimensioning nothing', () => {
    const empty = {
      view: 'front' as const, segments: [], circles: [],
      bounds: { min: [0, 0] as [number, number], max: [0, 0] as [number, number] },
      report: { edgesConsidered: 0, visibleSegments: 0, hiddenSegments: 0, silhouetteEdges: 0, sampleSpacingMm: 0.5 },
    };
    const r = autoDimension(empty);
    expect(r.dimensions.length).toBe(0);
    expect(r.notes[0]).toMatch(/empty/i);
  });
});

describe('tolerances', () => {
  it('follows the ISO 2768-m bands', () => {
    expect(generalTolerance(5).plus).toBeCloseTo(0.1, 6);
    expect(generalTolerance(25).plus).toBeCloseTo(0.2, 6);
    expect(generalTolerance(100).plus).toBeCloseTo(0.3, 6);
    expect(generalTolerance(300).plus).toBeCloseTo(0.5, 6);
  });

  it('never leaves a dimension untoleranced', () => {
    const p = project(plateWithHoles(), { view: 'top', visibleOnly: true });
    for (const d of autoDimension(p).dimensions) expect(d.tolerance.kind).not.toBe('none');
  });

  it('formats each tolerance style correctly', () => {
    expect(formatDimension(40, 'linear', { kind: 'symmetric', plus: 0.2, minus: 0.2 })).toBe('40.0 ±0.2');
    expect(formatDimension(8, 'diameter', { kind: 'fit', fit: 'H7' })).toBe('⌀8.0 H7');
    expect(formatDimension(8, 'diameter', { kind: 'fit', fit: 'H7' }, 4)).toBe('4 x ⌀8.0 H7');
    expect(formatDimension(12, 'radius', { kind: 'none' })).toBe('R12.0');
  });

  it('writes a readable feature control frame', () => {
    const s = formatFcf({
      symbol: 'position', zone: 0.25, diametral: true, modifier: 'MMC',
      datums: ['A', 'B', 'C'], at: [0, 0],
    });
    expect(s).toContain('⌖');
    expect(s).toContain('⌀0.25');
    expect(s).toContain('A | B | C');
  });

  it('suggests position control when there is a hole pattern', () => {
    const p = project(plateWithHoles(), { view: 'top', visibleOnly: true });
    const { frames, notes } = suggestGdt(p);

    expect(frames.some((f) => f.symbol === 'position')).toBe(true);
    expect(notes.join(' ')).toMatch(/parallelogram|geometric/i);
  });
});

describe('sheet and scale', () => {
  it('picks a preferred scale that fits', () => {
    // 1500 mm of content will not fit on A3 at 1:1, so it must scale down.
    const s = chooseScale([1500, 900], 'A3');
    expect(s.scale).toBeLessThan(1);
    expect(s.label).toMatch(/^1:(2|2\.5|5|10|20|50|100|200|500|1000)$/);
  });

  it('uses 1:1 when the part fits', () => {
    expect(chooseScale([100, 60], 'A3').label).toBe('1:1');
  });

  it('only ever chooses a standard scale', () => {
    // 1:3.7 is expressible and useless — nobody can read a dimension off it.
    for (const size of [50, 200, 700, 3000]) {
      const label = chooseScale([size, size * 0.6], 'A3').label;
      expect(label).toMatch(/^(\d+:1|1:\d+)$/);
    }
  });
});

describe('the finished drawing', () => {
  it('assembles views, dimensions and a title block', () => {
    const d = makeDrawing(plateWithHoles(), {
      fast: true,
      titleBlock: { partNumber: 'BRK-1042', description: 'Mounting plate', material: 'Al 6061-T6' },
    });

    expect(d.views.length).toBe(4);
    expect(d.titleBlock.partNumber).toBe('BRK-1042');
    expect(d.views.some((v) => v.dimensions.length > 0)).toBe(true);
  });

  it('computes the mass for the title block', () => {
    const d = makeDrawing(box(100, 100, 10), { fast: true, density: 2.7 });
    // 100 x 100 x 10 mm of aluminium is 100 cm^3, so 270 g.
    expect(d.titleBlock.massGrams!).toBeCloseTo(270, 0);
  });

  it('does not dimension the isometric view', () => {
    // Dimensioning a pictorial view is meaningless: nothing on it is to true length.
    const d = makeDrawing(box(50, 40, 30), { fast: true });
    const iso = d.views.find((v) => v.view.view === 'iso');
    expect(iso?.dimensions.length).toBe(0);
  });

  it('marks a preview as not for manufacture', () => {
    // A drawing without hidden lines is ambiguous, and one that does not say so is
    // dangerous — someone will print it.
    const d = makeDrawing(box(40, 40, 40), { fast: true });
    expect(d.notes.join(' ')).toMatch(/not for manufacture/i);
  });

  it('reports the overall stock size', () => {
    const s = stockSize(box(120, 80, 15));
    expect(s.x).toBeCloseTo(120, 4);
    expect(s.y).toBeCloseTo(80, 4);
    expect(s.z).toBeCloseTo(15, 4);
  });

  it('summarises itself', () => {
    const d = makeDrawing(box(40, 40, 40), { fast: true });
    expect(describeDrawing(d)).toMatch(/view/);
  });
});

describe('SVG export', () => {
  it('produces a well-formed sheet at the right physical size', () => {
    const svg = drawingToSvg(makeDrawing(plateWithHoles(), { fast: true, sheet: 'A3' }));

    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('width="420mm"');
    expect(svg).toContain('height="297mm"');
  });

  it('draws hidden lines dashed and visible lines solid', () => {
    const solid = subtractAll(box(60, 60, 30), [box(20, 20, 20, [0, 0, 15])]).mesh;
    const svg = drawingToSvg(makeDrawing(solid, { views: ['front'] }));
    expect(svg).toContain('stroke-dasharray');
  });

  it('includes the title block fields', () => {
    const svg = drawingToSvg(makeDrawing(box(40, 40, 40), {
      fast: true,
      titleBlock: { partNumber: 'XYZ-9', material: 'Stainless 316' },
    }));
    expect(svg).toContain('XYZ-9');
    expect(svg).toContain('Stainless 316');
    expect(svg).toContain('ISO 2768-m');
  });

  it('escapes text so a part name cannot break the file', () => {
    const svg = drawingToSvg(makeDrawing(box(20, 20, 20), {
      fast: true,
      titleBlock: { description: 'Bracket <left> & "right"' },
    }));
    expect(svg).toContain('&lt;left&gt;');
    expect(svg).toContain('&amp;');
    expect(svg).not.toContain('<left>');
  });

  it('carries each dimension rationale for auditing', () => {
    const svg = drawingToSvg(makeDrawing(plateWithHoles(), { fast: true }));
    expect(svg).toContain('data-rationale');
  });
});

describe('DXF export', () => {
  it('produces a valid R12 structure', () => {
    const dxf = drawingToDxf(makeDrawing(plateWithHoles(), { fast: true }));

    expect(dxf).toContain('SECTION');
    expect(dxf).toContain('ENTITIES');
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);

    // Group codes come in pairs, one per line.
    const lines = dxf.split('\r\n').filter((l) => l.length > 0);
    expect(lines.length % 2).toBe(0);
  });

  it('separates outline, hidden and dimension layers', () => {
    // A shop needs to suppress dimensions and construction lines independently of the part.
    const solid = subtractAll(box(60, 60, 30), [box(20, 20, 20, [0, 0, 15])]).mesh;
    const dxf = drawingToDxf(makeDrawing(solid, { views: ['front'] }));

    expect(dxf).toContain('OUTLINE');
    expect(dxf).toContain('HIDDEN');
    expect(dxf).toContain('DIMENSIONS');
  });

  it('writes circles as CIRCLE entities, not as polygons', () => {
    // A laser cutter given a 64-sided polygon cuts 64 facets; given a CIRCLE it cuts a circle.
    const dxf = drawingToDxf(makeDrawing(plateWithHoles(), { fast: true, views: ['top'] }));
    expect(dxf).toContain('CIRCLE');
  });

  it('writes the dimension text so the drawing is readable on import', () => {
    const dxf = drawingToDxf(makeDrawing(plateWithHoles(), { fast: true, views: ['top'] }));
    expect(dxf).toContain('TEXT');
    expect(dxf).toMatch(/⌀|\d+\.\d/);
  });

  it('scales geometry by the drawing scale', () => {
    const big = makeDrawing(box(2000, 1200, 100), { fast: true, sheet: 'A3' });
    expect(big.scale.scale).toBeLessThan(1);

    const dxf = drawingToDxf(big);
    // Nothing may exceed the sheet, or it lands outside the border on import.
    const coords = [...dxf.matchAll(/\r\n(-?\d+\.\d{4})/g)].map((m) => Math.abs(Number(m[1])));
    expect(Math.max(...coords)).toBeLessThan(500);
  });
});

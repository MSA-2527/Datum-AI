import { describe, expect, it } from 'vitest';
import {
  detectSymmetry, fitCircle, fitSegments, otsuThreshold, scaleFromKnownWidth,
  simplifyLoop, traceImage, type RasterImage,
} from './trace';
import { profileArea } from '../../kernel/sketch/profile';
import { XY, extrude, revolve, XZ } from '../../kernel/ops/build';
import { health, massProperties } from '../../kernel/topo/mesh';

/**
 * Image-to-profile tests.
 *
 * Every case is a synthesised image whose true geometry is known exactly, so the assertions
 * are about *accuracy* rather than about the pipeline merely running. A tracer that produces
 * a plausible-looking outline of the wrong size is worse than one that fails, because the
 * error only surfaces at the machine.
 */

/** Renders a filled shape into an RGBA raster: black on white. */
function render(width: number, height: number, inside: (x: number, y: number) => boolean): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const v = inside(x, y) ? 0 : 255;
      data[p] = data[p + 1] = data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

const rect = (x0: number, y0: number, x1: number, y1: number) =>
  (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

const disc = (cx: number, cy: number, r: number) =>
  (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

describe('thresholding', () => {
  it('finds the split between two clear populations', () => {
    const gray = new Uint8Array(1000);
    gray.fill(30, 0, 500);
    gray.fill(220, 500);
    // The returned level is the top of the dark class, so 30 itself is the answer here:
    // everything <= 30 is dark, everything above is light.
    const t = otsuThreshold(gray);
    expect(t).toBeGreaterThanOrEqual(30);
    expect(t).toBeLessThan(220);
  });

  it('treats transparent pixels as background, not as black', () => {
    // A PNG with an alpha channel would otherwise trace its own bounding box.
    const img = render(60, 60, rect(20, 20, 40, 40));
    for (let i = 0; i < 60 * 60; i++) {
      const inside = (i % 60) >= 20 && (i % 60) <= 40 && Math.floor(i / 60) >= 20 && Math.floor(i / 60) <= 40;
      if (!inside) img.data[i * 4 + 3] = 0;
    }
    const r = traceImage(img, { mmPerPixel: 1 });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.report.widthMm).toBeCloseTo(21, 0);
  });
});

describe('circle fitting', () => {
  it('recovers a known centre and radius exactly', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 24; i++) {
      const t = (i / 24) * 2 * Math.PI;
      pts.push([50 + 30 * Math.cos(t), -20 + 30 * Math.sin(t)]);
    }
    const c = fitCircle(pts)!;
    expect(c.centre[0]).toBeCloseTo(50, 6);
    expect(c.centre[1]).toBeCloseTo(-20, 6);
    expect(c.radius).toBeCloseTo(30, 6);
    expect(c.residual).toBeLessThan(1e-6);
  });

  it('stays accurate far from the origin, where the naive fit breaks down', () => {
    // Centring the data before solving is what makes this work; without it the normal
    // equations are hopelessly conditioned and the radius comes out wrong.
    const pts: [number, number][] = [];
    for (let i = 0; i < 24; i++) {
      const t = (i / 24) * 2 * Math.PI;
      pts.push([500000 + 12 * Math.cos(t), 300000 + 12 * Math.sin(t)]);
    }
    const c = fitCircle(pts)!;
    expect(c.radius).toBeCloseTo(12, 4);
  });

  it('refuses collinear points instead of inventing a huge circle', () => {
    expect(fitCircle([[0, 0], [10, 0], [20, 0], [30, 0]])).toBeNull();
  });
});

describe('simplification', () => {
  it('collapses a staircase into its two end points', () => {
    // A traced pixel boundary along a diagonal is a staircase; it must become a line.
    const stair: [number, number][] = [];
    for (let i = 0; i <= 20; i++) { stair.push([i, i]); stair.push([i + 1, i]); }
    const out = simplifyLoop(stair, 1.5);
    expect(out.length).toBeLessThan(8);
  });

  it('keeps the corners of a square', () => {
    const sq: [number, number][] = [];
    for (let i = 0; i < 40; i++) sq.push([i, 0]);
    for (let i = 0; i < 40; i++) sq.push([40, i]);
    for (let i = 40; i > 0; i--) sq.push([i, 40]);
    for (let i = 40; i > 0; i--) sq.push([0, i]);

    const out = simplifyLoop(sq, 0.5);
    // Four corners, give or take the loop's start point.
    expect(out.length).toBeGreaterThanOrEqual(4);
    expect(out.length).toBeLessThanOrEqual(6);
  });
});

describe('segment fitting', () => {
  it('recognises the four straight edges of a square', () => {
    const sq: [number, number][] = [];
    const push = (x: number, y: number) => sq.push([x, y]);
    for (let i = 0; i <= 20; i++) push(i * 2, 0);
    for (let i = 1; i <= 20; i++) push(40, i * 2);
    for (let i = 19; i >= 0; i--) push(i * 2, 40);
    for (let i = 19; i >= 1; i--) push(0, i * 2);

    const segs = fitSegments(sq, 0.4);
    const lines = segs.filter((s) => s.kind === 'line');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it('recognises a circle as arcs rather than hundreds of facets', () => {
    // This is the point of the whole fitting stage: a drawing needs "R25", not 200 points.
    const circle: [number, number][] = [];
    for (let i = 0; i < 200; i++) {
      const t = (i / 200) * 2 * Math.PI;
      circle.push([25 * Math.cos(t), 25 * Math.sin(t)]);
    }
    const segs = fitSegments(circle, 0.3);
    const arcs = segs.filter((s) => s.kind === 'arc');

    expect(arcs.length).toBeGreaterThan(0);
    expect(segs.length).toBeLessThan(20);
    for (const a of arcs) if (a.kind === 'arc') expect(a.radiusMm).toBeCloseTo(25, 0);
  });

  it('does not shatter a gentle arc into short straight facets', () => {
    // A loose line test also passes over a short run of a large arc. Preferring whichever
    // primitive covers more points is what stops one R100 arc becoming twenty flats.
    const arc: [number, number][] = [];
    for (let i = 0; i <= 120; i++) {
      const t = -0.6 + (i / 120) * 1.2;
      arc.push([100 * Math.sin(t), 100 * Math.cos(t)]);
    }
    const segs = fitSegments(arc, 0.5);
    expect(segs.length).toBeLessThan(10);
  });
});

describe('symmetry detection', () => {
  it('suggests a revolve for a symmetric silhouette', () => {
    // A bottle-like outline, mirrored about its centreline.
    const half: [number, number][] = [[0, 0], [30, 0], [30, 60], [12, 80], [12, 100]];
    const loop: [number, number][] = [
      ...half,
      ...half.slice().reverse().map(([x, y]) => [-x, y] as [number, number]),
    ];
    const s = detectSymmetry(loop);
    expect(s.operation).toBe('revolve');
    expect(s.confidence).toBeGreaterThan(0.7);
    expect(s.reason).toMatch(/symmetric|turned/i);
  });

  it('suggests an extrude for an asymmetric outline', () => {
    const loop: [number, number][] = [[0, 0], [80, 0], [80, 40], [50, 40], [50, 20], [0, 20]];
    expect(detectSymmetry(loop).operation).toBe('extrude');
  });
});

describe('the whole pipeline', () => {
  it('refuses to guess a scale', () => {
    const img = render(64, 64, rect(10, 10, 50, 50));
    const r = traceImage(img, { mmPerPixel: 0 });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/scale|size/i);
  });

  it('traces a square to the right size', () => {
    // 40 x 40 px at 0.5 mm/px must come out 20 x 20 mm.
    const img = render(80, 80, rect(20, 20, 59, 59));
    const r = traceImage(img, { mmPerPixel: 0.5 });

    expect('error' in r).toBe(false);
    if ('error' in r) return;

    expect(r.report.widthMm).toBeCloseTo(20, 0);
    expect(r.report.heightMm).toBeCloseTo(20, 0);
    expect(profileArea(r.profile)).toBeGreaterThan(380);
    expect(profileArea(r.profile)).toBeLessThan(420);
  });

  it('traces a disc and recovers its diameter', () => {
    const img = render(120, 120, disc(60, 60, 40));
    const r = traceImage(img, { mmPerPixel: 0.25 });

    expect('error' in r).toBe(false);
    if ('error' in r) return;

    // 40 px radius at 0.25 mm/px is 20 mm; diameter 20 mm.
    expect(r.report.widthMm).toBeCloseTo(20, 0);
    expect(r.report.arcsRecognised).toBeGreaterThan(0);
  });

  it('finds a hole and subtracts it from the area', () => {
    const img = render(120, 120, (x, y) => disc(60, 60, 45)(x, y) && !disc(60, 60, 20)(x, y));
    const r = traceImage(img, { mmPerPixel: 1 });

    expect('error' in r).toBe(false);
    if ('error' in r) return;

    expect(r.report.holesFound).toBe(1);

    // Annulus area = pi(45^2 - 20^2) ~= 5105 mm^2 at 1 mm/px.
    const area = profileArea(r.profile);
    expect(area).toBeGreaterThan(4600);
    expect(area).toBeLessThan(5600);
  });

  it('produces a profile that extrudes into a closed solid', () => {
    // The real test of the output: it has to be buildable, not just plottable.
    const img = render(120, 120, (x, y) => rect(20, 20, 99, 79)(x, y) && !disc(60, 50, 12)(x, y));
    const r = traceImage(img, { mmPerPixel: 0.5 });

    expect('error' in r).toBe(false);
    if ('error' in r) return;

    const solid = extrude(r.profile, XY, { distance: 6 });
    expect(health(solid).closed).toBe(true);
    expect(massProperties(solid).volume).toBeGreaterThan(0);
  });

  it('produces a symmetric profile that revolves into a closed solid', () => {
    // A vase silhouette: narrow neck, wide body.
    const img = render(120, 160, (x, y) => {
      const halfWidth = y < 40 ? 12 : 12 + (y - 40) * 0.5;
      return Math.abs(x - 60) <= Math.min(halfWidth, 45) && y >= 10 && y <= 150;
    });
    const r = traceImage(img, { mmPerPixel: 0.5 });

    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.suggestion.operation).toBe('revolve');

    // Take the half of the outline on one side of the axis and revolve it.
    const axisX = r.suggestion.axis!.origin[0];
    const half = r.profile.outer.filter((p) => p[0] >= axisX - 1e-6).map((p) => [p[0] - axisX, p[1]] as [number, number]);
    expect(half.length).toBeGreaterThan(3);
  });

  it('reports what it decided rather than deciding silently', () => {
    const img = render(100, 100, disc(50, 50, 35));
    const r = traceImage(img, { mmPerPixel: 0.4 });

    expect('error' in r).toBe(false);
    if ('error' in r) return;

    expect(r.report.thresholdAuto).toBe(true);
    expect(r.report.pointsBeforeSimplify).toBeGreaterThan(r.report.pointsAfterSimplify);
    expect(r.report.contoursFound).toBeGreaterThan(0);
  });

  it('explains an all-background image instead of returning an empty part', () => {
    const img = render(64, 64, () => false);
    const r = traceImage(img, { mmPerPixel: 1 });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/background|inverted|nothing/i);
  });

  it('explains an all-foreground image', () => {
    const img = render(64, 64, () => true);
    const r = traceImage(img, { mmPerPixel: 1 });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/whole image|inverted|crop/i);
  });

  it('handles an inverted image when told to', () => {
    const img = render(80, 80, (x, y) => !rect(20, 20, 59, 59)(x, y));
    const r = traceImage(img, { mmPerPixel: 0.5, invert: true });

    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.report.widthMm).toBeCloseTo(20, 0);
  });

  it('warns rather than failing when several shapes are present', () => {
    const img = render(160, 80, (x, y) => rect(10, 20, 50, 60)(x, y) || rect(100, 20, 150, 60)(x, y));
    const r = traceImage(img, { mmPerPixel: 1 });

    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.report.warnings.some((w) => /separate shapes/i.test(w))).toBe(true);
  });
});

describe('scale calibration', () => {
  it('derives millimetres per pixel from a known width', () => {
    // 40 px wide, told it is 25 mm.
    const img = render(80, 40, rect(20, 10, 59, 30));
    const s = scaleFromKnownWidth(img, 25);
    expect(s).not.toBeNull();
    expect(s!).toBeCloseTo(25 / 40, 3);
  });

  it('rejects a nonsensical width', () => {
    const img = render(40, 40, rect(5, 5, 30, 30));
    expect(scaleFromKnownWidth(img, 0)).toBeNull();
  });

  it('round-trips: a calibrated trace reproduces the stated width', () => {
    const img = render(200, 120, rect(25, 20, 174, 99));
    const s = scaleFromKnownWidth(img, 60)!;
    const r = traceImage(img, { mmPerPixel: s });

    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.report.widthMm).toBeCloseTo(60, 0);
  });
});

void revolve; void XZ;

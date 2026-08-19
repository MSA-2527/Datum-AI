import { describe, expect, it } from 'vitest';
import { halfProfile, traceImage, type RasterImage } from './trace';
import { useModel } from '../../modelStore';
import { bounds, triCount } from '../../kernel/topo/mesh';

/**
 * A photograph of a round thing has to come back as a round thing.
 *
 * The importer used to extrude whatever it traced, so a picture of a bottle produced a flat
 * plate in the shape of a bottle — geometrically faithful to the silhouette and useless as a
 * model. The tracer already recognised the symmetry; nothing acted on it.
 */

/** A filled shape drawn into a white image, one byte per pixel decided by `hit`. */
function image(w: number, h: number, hit: (x: number, y: number) => boolean): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!hit(x, y)) continue;
      const p = (y * w + x) * 4;
      data[p] = 0; data[p + 1] = 0; data[p + 2] = 0;
    }
  }
  return { width: w, height: h, data };
}

describe('halving an outline about its axis', () => {
  it('keeps the far side and closes along the axis', () => {
    const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const half = halfProfile(square, 5);

    expect(half.length).toBeGreaterThanOrEqual(3);
    for (const [x] of half) expect(x).toBeGreaterThanOrEqual(-1e-9);
    expect(half.some(([x]) => Math.abs(x) < 1e-9)).toBe(true);   // it touches the axis
    expect(Math.max(...half.map(([x]) => x))).toBeCloseTo(5, 6); // and reaches the far edge
  });

  it('leaves no zero-length edges where the outline meets the axis', () => {
    const diamond: [number, number][] = [[5, 0], [10, 5], [5, 10], [0, 5]];
    const half = halfProfile(diamond, 5);

    for (let i = 0; i < half.length; i++) {
      const a = half[i]!;
      const b = half[(i + 1) % half.length]!;
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThan(1e-9);
    }
  });

  it('refuses rather than returning a degenerate profile', () => {
    expect(halfProfile([[0, 0], [1, 1]], 0)).toEqual([]);
    // Everything on the wrong side of the axis leaves nothing to revolve.
    expect(halfProfile([[0, 0], [2, 0], [2, 2], [0, 2]], 10)).toEqual([]);
  });
});

describe('what the tracer decides about a round thing', () => {
  it('recognises a circle as a turned part', () => {
    const img = image(120, 120, (x, y) => Math.hypot(x - 60, y - 60) < 45);
    const traced = traceImage(img, { mmPerPixel: 0.5 });

    expect('error' in traced).toBe(false);
    if ('error' in traced) return;
    expect(traced.suggestion.operation).toBe('revolve');
  });

  it('does not claim symmetry for a shape that has none', () => {
    // An L: symmetric about neither centreline, so it is a flat profile and stays one.
    const img = image(120, 120, (x, y) => (x > 10 && x < 40 && y > 10 && y < 100)
      || (x > 10 && x < 100 && y > 70 && y < 100));
    const traced = traceImage(img, { mmPerPixel: 0.5 });

    expect('error' in traced).toBe(false);
    if ('error' in traced) return;
    expect(traced.suggestion.operation).toBe('extrude');
  });
});

describe('importing a picture, end to end', () => {
  it('builds a solid of revolution from a symmetric silhouette', () => {
    const img = image(120, 120, (x, y) => Math.hypot(x - 60, y - 60) < 45);
    const r = useModel.getState().importImage(img, 0.5, 10);

    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/revolv/i);

    const doc = useModel.getState().doc;
    expect(doc.features).toHaveLength(1);
    expect(doc.features[0]!.kind).toBe('revolve');

    const ev = useModel.getState().evaluated;
    expect(triCount(ev.mesh)).toBeGreaterThan(0);
    expect(ev.health.closed).toBe(true);

    // Revolving the half-disc of a circle gives a sphere, not a disc: the model has depth in
    // the direction the picture had none.
    const bb = bounds(ev.mesh);
    const size = bb.max.map((v, i) => v - bb.min[i]!);
    expect(size[2]!).toBeGreaterThan(size[0]! * 0.5);
  });

  it('still extrudes a shape that is not a solid of revolution', () => {
    const img = image(120, 120, (x, y) => (x > 10 && x < 40 && y > 10 && y < 100)
      || (x > 10 && x < 100 && y > 70 && y < 100));
    const r = useModel.getState().importImage(img, 0.5, 10);

    expect(r.ok).toBe(true);
    expect(useModel.getState().doc.features[0]!.kind).toBe('extrude');
  });
});

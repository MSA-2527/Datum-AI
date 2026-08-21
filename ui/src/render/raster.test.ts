import { describe, expect, it } from 'vitest';
import { render, renderViews, VIEWS, REVIEW_VIEWS } from './raster';
import { encodePng } from './png';
import { box, cylinder, sphere } from '../kernel/ops/build';
import { subtract } from '../kernel/ops/boolean';

/**
 * Rendering without a GPU.
 *
 * A picture is normally checked by looking at it, which is exactly what a test cannot do. So
 * these assert the things a correct render implies and an incorrect one does not: a cube seen
 * square-on covers the fraction of the frame its fit implies, a bored part shows the hole as
 * background, a back face never paints over a front one, and the same part rendered twice is
 * the same bytes.
 */

const pixel = (r: { rgba: Uint8Array; width: number }, x: number, y: number) => {
  const at = (y * r.width + x) * 4;
  return [r.rgba[at]!, r.rgba[at + 1]!, r.rgba[at + 2]!] as const;
};

const BACKGROUND = [24, 26, 30] as const;
const isBackground = (p: readonly number[]) =>
  p[0] === BACKGROUND[0] && p[1] === BACKGROUND[1] && p[2] === BACKGROUND[2];

describe('what a render covers', () => {
  it('draws nothing for an empty mesh', () => {
    const r = render(
      { positions: new Float64Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0), tags: new Map() },
      VIEWS.front,
    );

    expect(r.covered).toBe(0);
    expect(isBackground(pixel(r, 100, 100))).toBe(true);
  });

  it('fills the fraction of the frame the fit asks for', () => {
    // A cube seen square-on is a square. Fitted to 82% of a 512 px frame, its side is 419.8 px
    // and it covers 419.8² ≈ 176 250 of 262 144 pixels — 67%.
    const r = render(box(50, 50, 50), VIEWS.front, { width: 512, height: 512, fill: 0.82 });
    const fraction = r.covered / (512 * 512);

    expect(fraction).toBeGreaterThan(0.66);
    expect(fraction).toBeLessThan(0.69);
  });

  it('leaves the corners as background and paints the centre', () => {
    const r = render(box(50, 50, 50), VIEWS.front);

    expect(isBackground(pixel(r, 2, 2))).toBe(true);
    expect(isBackground(pixel(r, 256, 256))).toBe(false);
  });

  it('shows a through bore as background at the centre', () => {
    // The check that the z-buffer and the back-face cull are both working: a hole is only
    // background if the far wall of the bore was culled and nothing else painted there.
    const bored = subtract(cylinder(30, 40), cylinder(12, 60)).mesh;
    const r = render(bored, VIEWS.top);

    expect(isBackground(pixel(r, 256, 256))).toBe(true);
    // And the material around it is not.
    expect(isBackground(pixel(r, 256, 60))).toBe(false);
  });

  it('fits a long part to the frame as readily as a compact one', () => {
    const long = render(box(400, 20, 20), VIEWS.front);
    const cube = render(box(50, 50, 50), VIEWS.front);

    expect(long.covered).toBeGreaterThan(0);
    // Both fitted, so neither runs off the edge: the extreme columns stay background.
    expect(isBackground(pixel(long, 1, 256))).toBe(true);
    expect(isBackground(pixel(cube, 1, 256))).toBe(true);
  });
});

describe('what a render shows', () => {
  it('lights faces differently, so form is readable rather than a silhouette', () => {
    const r = render(box(50, 50, 50), VIEWS.iso);

    // An isometric cube shows three faces at three angles to the light, so a horizontal scan
    // across the middle meets more than one shade.
    const shades = new Set<number>();
    for (let x = 40; x < 470; x += 3) {
      const p = pixel(r, x, 256);
      if (!isBackground(p)) shades.add(p[0]);
    }

    expect(shades.size).toBeGreaterThan(1);
  });

  it('never paints a back face over a front one', () => {
    // A sphere is the strongest case: every pixel has a near and a far surface.
    const near = render(sphere(40), VIEWS.front);
    const shaded = pixel(near, 256, 256);

    expect(isBackground(shaded)).toBe(false);
    // The lit front pole, not the unlit far side.
    expect(shaded[0]).toBeGreaterThan(60);
  });

  it('is deterministic — the same part twice is the same bytes', () => {
    const a = render(box(60, 40, 20), VIEWS.iso);
    const b = render(box(60, 40, 20), VIEWS.iso);

    expect(Array.from(a.rgba)).toEqual(Array.from(b.rgba));
  });

  it('renders every standard view without failing', () => {
    for (const name of Object.keys(VIEWS) as (keyof typeof VIEWS)[]) {
      const r = render(box(60, 40, 20), VIEWS[name]);
      expect(r.covered, `${name} rendered nothing`).toBeGreaterThan(1000);
    }
  });
});

describe('a set of views', () => {
  it('returns one render per view, named', () => {
    const views = renderViews(box(60, 40, 20));

    expect(views.map((v) => v.name)).toEqual(REVIEW_VIEWS);
    for (const v of views) expect(v.render.covered).toBeGreaterThan(0);
  });

  it('distinguishes views that would look identical on a symmetric part', () => {
    // 60 × 40 × 20: front, right and top all differ, and a renderer that ignored the camera
    // would return three identical images.
    const [, front, right, top] = renderViews(box(60, 40, 20));

    expect(front!.render.covered).not.toBe(right!.render.covered);
    expect(front!.render.covered).not.toBe(top!.render.covered);
  });
});

describe('the PNG it is written as', () => {
  it('starts with the signature every decoder checks', () => {
    const r = render(box(20, 20, 20), VIEWS.iso, { width: 64, height: 64 });
    const png = encodePng(r.rgba, 64, 64);

    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('declares the size and colour type it was given', () => {
    const png = encodePng(new Uint8Array(16 * 8 * 4), 16, 8);

    // IHDR: length, "IHDR", width, height, depth, colour type…
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR');
    expect((png[16]! << 24) | (png[17]! << 16) | (png[18]! << 8) | png[19]!).toBe(16);
    expect((png[20]! << 24) | (png[21]! << 16) | (png[22]! << 8) | png[23]!).toBe(8);
    expect(png[24]).toBe(8);        // 8 bits per channel
    expect(png[25]).toBe(6);        // RGBA
  });

  it('ends with IEND', () => {
    const png = encodePng(new Uint8Array(4 * 4 * 4), 4, 4);
    expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe('IEND');
  });

  it('refuses a buffer that is not the size it claims', () => {
    expect(() => encodePng(new Uint8Array(10), 16, 8)).toThrow(/Expected/);
  });

  it('handles an image larger than one stored deflate block', () => {
    // 65 535 bytes per block, so a 256 × 256 RGBA image needs several.
    const png = encodePng(new Uint8Array(256 * 256 * 4), 256, 256);
    expect(png.length).toBeGreaterThan(256 * 256 * 4);
  });
});

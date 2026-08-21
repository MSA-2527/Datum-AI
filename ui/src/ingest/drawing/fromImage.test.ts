import { describe, expect, it } from 'vitest';
import { reconstructFromImage } from './fromImage';
import { massProperties, bounds, triCount } from '../../kernel/topo/mesh';
import type { RasterImage } from '../image/trace';

/**
 * Reading a picture of an engineering drawing.
 *
 * The part is an L-bracket whose three views and whose volume are known before any code runs:
 * a 60 × 40 × 10 base with a 10 × 40 × 30 upright standing on one end, so 36 000 mm³ exactly.
 * The sheet below is what a draughtsman would draw of it — front, top above the front, right
 * beside it — and the reconstruction has to come back with that part and not something the
 * right size.
 *
 * That distinction is the whole test. Tracing the sheet as one outline also produces a closed
 * solid with a plausible volume; it is a slab in the shape of the *paper*, and the only way to
 * tell the two apart is to check the shape against a part whose shape is already known.
 */

const MM = 1;
const SHEET_W = 260;
const SHEET_H = 200;

/** A blank sheet, white. */
function sheet(): RasterImage {
  const data = new Uint8ClampedArray(SHEET_W * SHEET_H * 4);
  data.fill(255);
  return { width: SHEET_W, height: SHEET_H, data };
}

/** Fills a rectangle in pixel coordinates, y counting down as an image does. */
function ink(img: RasterImage, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = 30; img.data[i + 1] = 30; img.data[i + 2] = 30;
    }
  }
}

/**
 * The three views of the L-bracket, laid out as the convention has them.
 *
 * Sheet coordinates run up and image rows run down, so everything here is painted upside down on
 * purpose — the tracer flips it once on the way out, which is the only place that conversion is
 * allowed to happen.
 *
 *   TOP    a plain 60 × 40 rectangle, directly above the front
 *   FRONT  the L itself, 60 wide and 40 tall
 *   RIGHT  a plain 40 × 40 square, beside the front
 */
function bracketSheet(): RasterImage {
  const img = sheet();

  // FRONT: rows 120-160 → sheet y 40-80. The base, then the upright on its left.
  ink(img, 20, 150, 80, 160);     // base, 60 × 10
  ink(img, 20, 120, 30, 160);     // upright, 10 × 40

  // TOP: rows 60-100 → sheet y 100-140. Directly above the front, sharing its x.
  ink(img, 20, 60, 80, 100);      // 60 × 40

  // RIGHT: beside the front, sharing its y.
  ink(img, 110, 120, 150, 160);   // 40 × 40

  return img;
}

describe('a drawing read from a picture', () => {
  it('identifies the three views by how they line up', () => {
    const read = reconstructFromImage(bracketSheet(), { mmPerPixel: MM });
    expect('error' in read, 'error' in read ? read.error : '').toBe(false);
    if ('error' in read) return;

    const roles = read.views.map((v) => v.role).sort();
    expect(roles).toEqual(['front', 'right', 'top']);
  });

  it('reconstructs the part, not a slab the shape of the paper', () => {
    /*
     * The failure this exists for, reported from use: a four-view blueprint traced as one outline
     * and extruded, giving a flat solid in the shape of the whole sheet — every view and every
     * leader line, 7 mm thick. Closed, manifold, dimensioned, and not the part.
     */
    const read = reconstructFromImage(bracketSheet(), { mmPerPixel: MM });
    if ('error' in read) throw new Error(read.error);

    const volume = massProperties(read.result.mesh).volume;

    // 60 × 40 × 10 base plus a 10 × 40 × 30 upright: 36 000 mm³.
    expect(volume).toBeGreaterThan(30_000);
    expect(volume).toBeLessThan(42_000);
  });

  it('comes back at the size the views state', () => {
    const read = reconstructFromImage(bracketSheet(), { mmPerPixel: MM });
    if ('error' in read) throw new Error(read.error);

    const b = bounds(read.result.mesh);
    const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];

    /*
     * 60 long, 40 deep, 40 tall — read off three views that each state two of the three.
     *
     * To within a pixel, and that is the honest accuracy of reading a raster: a boundary tracer
     * walks pixel corners, so a filled span is a pixel wide or a pixel narrow depending on which
     * corner it starts from. Here that is a whole millimetre because the sheet is drawn at one
     * millimetre per pixel; on a 300 dpi scan it is 0.08 mm, which is finer than the line width
     * it was measuring.
     *
     * Worth stating rather than chasing: the fix for a dimension that has to be exact is to read
     * it off the dimension text, not to sharpen the tracer.
     */
    const pixel = MM * 1.5;
    expect(Math.abs(size[0] - 60)).toBeLessThanOrEqual(pixel);
    expect(Math.abs(size[1] - 40)).toBeLessThanOrEqual(pixel);
    expect(Math.abs(size[2] - 40)).toBeLessThanOrEqual(pixel);
  });

  it('comes back as a solid that closes', () => {
    const read = reconstructFromImage(bracketSheet(), { mmPerPixel: MM });
    if ('error' in read) throw new Error(read.error);

    expect(triCount(read.result.mesh)).toBeGreaterThan(0);
    expect(read.result.valid).toBe(true);
  });

  it('is not a rectangular block, which is what a careless hull would give', () => {
    /*
     * A hull that ignored the front view's L and used only the two rectangles would give a
     * 60 × 40 × 40 block: the right overall size, the right bounding box, and 96 000 mm³ of
     * material where there should be 36 000. Size alone cannot tell them apart, which is why
     * the volume is checked and not only the extents.
     */
    const read = reconstructFromImage(bracketSheet(), { mmPerPixel: MM });
    if ('error' in read) throw new Error(read.error);

    expect(massProperties(read.result.mesh).volume).toBeLessThan(60 * 40 * 40 * 0.7);
  });

  it('says what it read, so the reading can be checked rather than trusted', () => {
    const read = reconstructFromImage(bracketSheet(), { mmPerPixel: MM });
    if ('error' in read) throw new Error(read.error);

    expect(read.loops).toBeGreaterThanOrEqual(3);
    for (const view of read.views) {
      expect(view.reason.length, `${view.role} gave no reason`).toBeGreaterThan(20);
    }
    expect(read.message.length).toBeGreaterThan(20);
  });
});

describe('hidden detail on the sheet', () => {
  /*
   * A bore drawn as a hidden line through the front view. Read as outlines, its dashes become a
   * row of little solid blocks inside the part — and the bore they describe is filled in, which
   * is the opposite of what the drawing said.
   */
  function withHiddenBore(): RasterImage {
    const img = bracketSheet();

    /*
     * A dashed line across the front view, where a bore's wall would be.
     *
     * Drawn at a size a tracer will actually see: below about sixteen pixels a contour is noise
     * by the tracer's own reckoning and never reaches this at all, which is a perfectly good
     * outcome and not the one being tested here.
     */
    for (let i = 0; i < 6; i++) ink(img, 34 + i * 12, 140, 34 + i * 12 + 8, 146);
    return img;
  }

  it('sets the dashes aside instead of building them', () => {
    const read = reconstructFromImage(withHiddenBore(), { mmPerPixel: MM });
    if ('error' in read) throw new Error(read.error);

    expect(read.hidden.runs).toBe(1);
    expect(read.hidden.loops).toBe(6);
  });

  it('gives the same part it would have without them', () => {
    const plain = reconstructFromImage(bracketSheet(), { mmPerPixel: MM });
    const dashed = reconstructFromImage(withHiddenBore(), { mmPerPixel: MM });

    if ('error' in plain || 'error' in dashed) throw new Error('one of them failed');

    const volumeOf = (r: typeof plain) => massProperties(r.result.mesh).volume;
    expect(volumeOf(dashed)).toBeCloseTo(volumeOf(plain), 0);
  });

  it('reports none on a sheet that has none', () => {
    const read = reconstructFromImage(bracketSheet(), { mmPerPixel: MM });
    if ('error' in read) throw new Error(read.error);

    expect(read.hidden.runs).toBe(0);
    expect(read.hidden.loops).toBe(0);
  });
});

describe('a flat part, drawn in one view', () => {
  /*
   * The commonest drawing there is: a gasket, a shim, a laser-cut blank. One view, because one
   * view is all it needs. A gate demanding two views to prove the sheet is a drawing refuses
   * exactly the sheets this application is best at.
   */
  function oneView(): RasterImage {
    const img = sheet();
    ink(img, 60, 70, 180, 130);      // a 120 x 60 outline
    ink(img, 95, 90, 115, 110);      // and a window in it, so it is not a plain rectangle
    return img;
  }

  it('converts it rather than refusing it', () => {
    const read = reconstructFromImage(oneView(), { mmPerPixel: MM });
    expect('error' in read, 'error' in read ? read.error : '').toBe(false);
    if ('error' in read) return;

    expect(read.result.valid).toBe(true);
    expect(triCount(read.result.mesh)).toBeGreaterThan(0);
  });

  it('says the thickness was a default, not something the drawing stated', () => {
    const read = reconstructFromImage(oneView(), { mmPerPixel: MM });
    if ('error' in read) throw new Error(read.error);

    // The flag a caller needs to avoid presenting a guess as a measurement.
    expect(read.singleView).toBe(true);
  });

  it('gets the outline right, which is the part one view does fix', () => {
    const read = reconstructFromImage(oneView(), { mmPerPixel: MM });
    if ('error' in read) throw new Error(read.error);

    const b = bounds(read.result.mesh);
    expect(Math.abs((b.max[0] - b.min[0]) - 120)).toBeLessThanOrEqual(MM * 1.5);
  });

  it('does not claim a single view is three', () => {
    const three = reconstructFromImage(bracketSheet(), { mmPerPixel: MM });
    if ('error' in three) throw new Error(three.error);

    expect(three.singleView).toBe(false);
  });
});

describe('what it declines to read', () => {
  it('refuses a blank sheet rather than building nothing and calling it a part', () => {
    const read = reconstructFromImage(sheet(), { mmPerPixel: MM });
    expect('error' in read).toBe(true);
  });

  it('refuses an image too small to hold a drawing', () => {
    const tiny = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4).fill(255) };
    const read = reconstructFromImage(tiny, { mmPerPixel: MM });

    expect('error' in read).toBe(true);
  });

  it('takes the scale it is given rather than inventing one', () => {
    // A picture carries no scale. At half a millimetre per pixel the same sheet is the same part
    // at half the size — and if that is wrong, it is wrong because the caller said so.
    const full = reconstructFromImage(bracketSheet(), { mmPerPixel: 1 });
    const half = reconstructFromImage(bracketSheet(), { mmPerPixel: 0.5 });

    if ('error' in full || 'error' in half) throw new Error('one of them failed');

    const volumeOf = (r: typeof full) => massProperties(r.result.mesh).volume;
    expect(volumeOf(full) / volumeOf(half)).toBeCloseTo(8, 0);
  });
});

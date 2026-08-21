import { describe, expect, it } from 'vitest';
import { MODEL_INPUT, postprocess, preprocess } from './depthAnything';

/**
 * Feeding the model, and reading what it says.
 *
 * The session is a thin shell over the runtime and cannot be exercised without the weights. What
 * *can* be checked is everything either side of it, and that is where the damage would be: a
 * wrongly laid-out or wrongly normalised tensor is an image the network has never seen the like
 * of, and it answers with a depth map that is smooth, plausible and about nothing. The failure
 * looks exactly like a bad model, which is the worst place for a bug to hide.
 */

/** An image of one flat colour. */
function flat(width: number, height: number, rgb: [number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

describe('the tensor the model is given', () => {
  const { size, mean, std } = MODEL_INPUT;

  it('is the shape the network was built for', () => {
    const tensor = preprocess(flat(64, 40, [128, 128, 128]), size);

    expect(tensor.length).toBe(3 * size * size);
    // 518 is a multiple of the vision transformer's 14-pixel patch, which is why it is 518.
    expect(size % 14).toBe(0);
  });

  it('normalises the way the network was trained', () => {
    /*
     * ImageNet's mean and standard deviation, and not a convenient 0-1. Feeding raw values gives
     * the network an image unlike anything in its training set; it answers anyway, confidently.
     */
    const tensor = preprocess(flat(32, 32, [255, 0, 0]), size);
    const plane = size * size;

    expect(tensor[0]).toBeCloseTo((1 - mean[0]) / std[0], 5);
    expect(tensor[plane]).toBeCloseTo((0 - mean[1]) / std[1], 5);
    expect(tensor[2 * plane]).toBeCloseTo((0 - mean[2]) / std[2], 5);
  });

  it('lays the channels out planar, not interleaved', () => {
    /*
     * NCHW: every red, then every green, then every blue. Pixels arrive interleaved, and handing
     * them over that way is technically the same bytes and visually noise.
     */
    const tensor = preprocess(flat(16, 16, [255, 0, 0]), size);
    const plane = size * size;

    // The whole first plane is the red channel, so it is uniform and high.
    for (const at of [0, 17, plane - 1]) {
      expect(tensor[at]).toBeCloseTo((1 - mean[0]) / std[0], 5);
    }
    // And the whole second plane is green, so it is uniform and low.
    for (const at of [plane, plane + 300, 2 * plane - 1]) {
      expect(tensor[at]).toBeCloseTo((0 - mean[1]) / std[1], 5);
    }
  });

  it('keeps a flat image flat, whatever its shape', () => {
    // A wide image resampled to a square must not develop structure that was never in it.
    const tensor = preprocess(flat(400, 90, [64, 64, 64]), size);
    const first = tensor[0]!;

    for (let i = 0; i < size * size; i += 997) {
      expect(tensor[i]).toBeCloseTo(first, 5);
    }
  });

  it('samples at pixel centres, so the picture does not drift', () => {
    /*
     * Sampling at the corner shifts the image half a pixel towards the origin at every resize.
     * On one pass it is invisible; it is also exactly the kind of error that makes a depth map
     * disagree with the outline the tracer found from the same picture.
     */
    const image = flat(2, 1, [0, 0, 0]);
    image.data[4] = 255;
    image.data[5] = 255;
    image.data[6] = 255;   // right-hand pixel white, left black

    const tensor = preprocess(image, 2);

    // Two pixels into two: each keeps its own value, neither is a blend of both.
    expect(tensor[0]).toBeLessThan(tensor[1]!);
    expect(tensor[0]).toBeCloseTo((0 - MODEL_INPUT.mean[0]) / MODEL_INPUT.std[0], 5);
    expect(tensor[1]).toBeCloseTo((1 - MODEL_INPUT.mean[0]) / MODEL_INPUT.std[0], 5);
  });
});

describe('the depth that comes back', () => {
  it('lands at the size of the picture, not the size of the network', () => {
    const depth = postprocess(new Float32Array(16 * 16), 16, 16, 200, 120);
    expect(depth.length).toBe(200 * 120);
  });

  it('keeps a constant map constant', () => {
    const flatDepth = new Float32Array(8 * 8).fill(3.5);
    const out = postprocess(flatDepth, 8, 8, 40, 25);

    for (const v of out) expect(v).toBeCloseTo(3.5, 6);
  });

  it('keeps a gradient a gradient, running the same way', () => {
    // A ramp increasing to the right must still increase to the right afterwards, and the ends
    // must still be the ends: a flipped or transposed resample is a depth map of a mirror image.
    const w = 16, h = 4;
    const ramp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ramp[y * w + x] = x;

    const out = postprocess(ramp, w, h, 64, 16);

    const left = out[8 * 64 + 1]!;
    const right = out[8 * 64 + 62]!;

    expect(right).toBeGreaterThan(left);
    expect(left).toBeLessThan(2);
    expect(right).toBeGreaterThan(w - 3);
  });

  it('interpolates rather than stepping', () => {
    /*
     * Nearest-neighbour would give a depth map with visible terraces, and a height field built
     * from terraces is a solid with steps in a surface that is smooth.
     */
    const two = Float32Array.from([0, 10]);
    const out = postprocess(two, 2, 1, 8, 1);

    // Somewhere in the middle, a value between the two — not one of them.
    const middle = out[4]!;
    expect(middle).toBeGreaterThan(0.5);
    expect(middle).toBeLessThan(9.5);
  });

  it('never reads outside the map it was given', () => {
    // The edges are where an off-by-one shows up as a NaN, and a NaN in a height field
    // propagates into geometry that cannot be built.
    const out = postprocess(Float32Array.from([1, 2, 3, 4]), 2, 2, 33, 17);

    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });

  it('handles a map that is already the right size', () => {
    const same = Float32Array.from([1, 2, 3, 4]);
    const out = postprocess(same, 2, 2, 2, 2);

    expect([...out]).toEqual([1, 2, 3, 4]);
  });
});

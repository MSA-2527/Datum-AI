import { describe, expect, it } from 'vitest';
import { ASSUMED_DEPTH_FRACTION, depthToRelief, looksInverted } from './depth';

/**
 * Reading a depth map into a height field.
 *
 * The answers are known in advance because the depth maps are made from shapes: a hemisphere of
 * radius 40 is 40 tall, a cone of the same footprint is the same height with a different profile,
 * and a plate is flat. What is being checked is not that numbers come out — it is that the
 * numbers describe the shape that went in, the right way up.
 */

const SIZE = 128;
const R = 48;

/** A mask of the circle the shapes below occupy. */
function disc(size = SIZE, r = R): Uint8Array {
  const mask = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2, dy = y - size / 2;
      if (dx * dx + dy * dy <= r * r) mask[y * size + x] = 1;
    }
  }
  return mask;
}

/**
 * A depth map of a hemisphere sitting on a plane.
 *
 * `near` says which convention: `large` for inverse depth, where the top of the dome holds the
 * biggest number, and `small` for metric depth, where it holds the smallest.
 */
function hemisphere(near: 'large' | 'small', size = SIZE, r = R): Float32Array {
  const depth = new Float32Array(size * size).fill(near === 'large' ? 0 : 100);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2, dy = y - size / 2;
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;

      const rise = Math.sqrt(r * r - d2);
      depth[y * size + x] = near === 'large' ? rise : 100 - rise;
    }
  }
  return depth;
}

describe('reading a depth map', () => {
  it('turns a hemisphere into a height field as tall as the hemisphere', () => {
    const reading = depthToRelief(hemisphere('large'), SIZE, SIZE, disc(), 'test')!;

    expect(reading).not.toBeNull();
    // Standing off by the assumed depth, with the shape of the map behind it.
    expect(reading.relief.reliefRatio).toBe(ASSUMED_DEPTH_FRACTION);
  });

  it('states the depth rather than measuring it, because the map has no scale', () => {
    /*
     * The correction that mattered here. A monocular depth model is trained up to an unknown
     * factor: its output describes the *shape* of a surface and says nothing about how far the
     * near end is from the far one. Dividing the normalised peak by the part's pixel width — the
     * arithmetic that is correct one file away, where heights are solved in pixels — reconstructed
     * a hemisphere one ninety-sixth as deep as it is wide. A flat disc, from a perfect depth map,
     * by arithmetic that looks right.
     */
    const assumed = depthToRelief(hemisphere('large'), SIZE, SIZE, disc(), 'test')!;
    const deeper = depthToRelief(
      hemisphere('large'), SIZE, SIZE, disc(), 'test', { depthFraction: 1.2 },
    )!;

    expect(assumed.relief.reliefRatio).toBe(ASSUMED_DEPTH_FRACTION);
    expect(deeper.relief.reliefRatio).toBe(1.2);

    // The shape is the same either way — only how far it stands off changes.
    expect(deeper.relief.height[64 * SIZE + 64]).toBeCloseTo(
      assumed.relief.height[64 * SIZE + 64]!, 6,
    );
  });

  it('puts the peak in the middle, not at the rim', () => {
    const reading = depthToRelief(hemisphere('large'), SIZE, SIZE, disc(), 'test')!;
    const at = (x: number, y: number) => reading.relief.height[y * SIZE + x]!;

    expect(at(64, 64)).toBeGreaterThan(0.95);
    expect(at(64 + R - 2, 64)).toBeLessThan(0.2);
  });

  it('reads metric depth the same way up as inverse depth', () => {
    /*
     * The failure this exists for. Most monocular models emit inverse depth — larger is nearer —
     * and some emit metric depth, where larger is further. Nothing in the array says which, and
     * reading it the wrong way round turns a dome into a dish: smooth, closed, plausible, and
     * inside out. Nothing downstream can catch it, because a dish is a perfectly good solid.
     */
    const asInverse = depthToRelief(hemisphere('large'), SIZE, SIZE, disc(), 'test')!;
    const asMetric = depthToRelief(hemisphere('small'), SIZE, SIZE, disc(), 'test')!;

    expect(asMetric.inverted).toBe(!asInverse.inverted);

    const middle = (r: typeof asInverse) => r.relief.height[64 * SIZE + 64]!;
    expect(middle(asMetric)).toBeCloseTo(middle(asInverse), 5);
  });

  it('can be told which way round rather than guessing', () => {
    const forced = depthToRelief(
      hemisphere('large'), SIZE, SIZE, disc(), 'test', { orientation: 'near-is-small' },
    )!;

    // Overruled, and duly inside out: the caller asked for it.
    expect(forced.relief.height[64 * SIZE + 64]!).toBeLessThan(0.1);
  });

  it('normalises over the part, not over the whole frame', () => {
    /*
     * A photograph of a bracket on a bench is mostly bench, and the bench runs from the near edge
     * of the table to the far wall. Normalised over the frame, the bracket occupies a sliver of
     * the range and comes back flat — a real part, correctly detected, reconstructed as a sheet.
     */
    const depth = hemisphere('large');
    const mask = disc();

    // A far wall behind everything, well outside the part.
    for (let i = 0; i < depth.length; i++) if (!mask[i]) depth[i] = -900;

    const reading = depthToRelief(depth, SIZE, SIZE, mask, 'test')!;

    // The wall is excluded, so the dome uses the whole range: peak at the top, zero at the rim.
    expect(reading.relief.height[64 * SIZE + 64]).toBeGreaterThan(0.95);
    expect(reading.relief.height[64 * SIZE + (64 + R - 2)]).toBeLessThan(0.2);
  });

  it('leaves everything outside the part at zero', () => {
    const mask = disc();
    const reading = depthToRelief(hemisphere('large'), SIZE, SIZE, mask, 'test')!;

    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) expect(reading.relief.height[i]).toBe(0);
    }
  });

  it('says where the numbers came from', () => {
    const reading = depthToRelief(
      hemisphere('large'), SIZE, SIZE, disc(), 'Depth Anything V2 (small, ONNX)',
    )!;

    expect(reading.source).toContain('Depth Anything');
  });
});

describe('what it declines to read', () => {
  it('has nothing to say about a part at one depth', () => {
    // Flat is a fine answer and is not a height field. Returning a field of zeros would let a
    // caller build a plate and report it as a reconstruction.
    const flat = new Float32Array(SIZE * SIZE).fill(7);
    expect(depthToRelief(flat, SIZE, SIZE, disc(), 'test')).toBeNull();
  });

  it('has nothing to say when the mask covers almost nothing', () => {
    const mask = new Uint8Array(SIZE * SIZE);
    mask[0] = 1;
    expect(depthToRelief(hemisphere('large'), SIZE, SIZE, mask, 'test')).toBeNull();
  });

  it('refuses a map that is not the size of the image', () => {
    expect(depthToRelief(new Float32Array(10), SIZE, SIZE, disc(), 'test')).toBeNull();
  });

  it('ignores non-finite values rather than propagating them', () => {
    const depth = hemisphere('large');
    depth[64 * SIZE + 30] = Number.NaN;
    depth[64 * SIZE + 31] = Number.POSITIVE_INFINITY;

    const reading = depthToRelief(depth, SIZE, SIZE, disc(), 'test')!;
    expect(reading).not.toBeNull();
    expect(Number.isFinite(reading.relief.reliefRatio)).toBe(true);
  });
});

describe('deciding which way the numbers run', () => {
  it('sees that a dome is nearest in the middle', () => {
    const mask = disc();
    // Large-is-near needs no flip; large-is-far does.
    expect(looksInverted(hemisphere('large'), mask, SIZE, SIZE, 0, 48)).toBe(false);
    expect(looksInverted(hemisphere('small'), mask, SIZE, SIZE, 52, 48)).toBe(true);
  });

  it('answers rather than throwing when there is nothing to judge', () => {
    const empty = new Uint8Array(SIZE * SIZE);
    expect(looksInverted(hemisphere('large'), empty, SIZE, SIZE, 0, 48)).toBe(false);
  });
});

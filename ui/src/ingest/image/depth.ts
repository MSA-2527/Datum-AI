/**
 * A depth map, from wherever, turned into the height field this application already builds from.
 *
 * ── Why this is the whole of the integration ──
 *
 * `relief.ts` solves shape from shading: it reads the brightness across a lit surface and works
 * out the height that would produce it. That is a hard problem solved with a strong assumption —
 * one light, one Lambertian surface — and it breaks on anything textured, shiny, or lit from the
 * side. A monocular depth model does not have that problem, because it was trained on tens of
 * millions of photographs of real things rather than on an assumption about reflectance.
 *
 * What the two produce is the *same shape of answer*: a height per pixel. So the useful surface
 * for a depth model is not a new pipeline; it is one function that puts its output into the form
 * the rest of this application has always consumed, and everything downstream — the mask, the
 * feature, the mesh, the drawing — is unchanged and unaware.
 *
 * ── Which model ──
 *
 * Depth Anything V2, exported to ONNX, run through ONNX Runtime Web on WebAssembly. It is
 * Apache-2.0, about 50 MB for the small variant, downloads once and caches, and runs entirely on
 * the user's machine — no server, no upload, no key. That last point is not incidental: the parts
 * people bring here are often somebody's unreleased product, and a pipeline that posts them to an
 * API is one a shop cannot use whatever it costs.
 *
 * ── What is here and what is not ──
 *
 * Here: the conversion, the normalisation, the masking, and the sign convention — every part that
 * can be checked against an answer known in advance, and every part that would be wrong in a way
 * nobody notices. A depth map read with its sign inverted produces a perfectly smooth dish where
 * there should be a dome, and it looks entirely deliberate.
 *
 * Not here: the model weights and the runtime. `DepthSource` is the seam. Anything that can
 * produce a depth per pixel satisfies it — the ONNX model, a depth camera, a `.pfm` from a
 * renderer — and none of them needs this file to change.
 */

import type { Relief } from './relief';

/**
 * Anything that can say how far away each pixel is.
 *
 * Deliberately not "an ONNX session". A depth camera, a rendered depth buffer and a photogrammetry
 * pass all answer this question, and the reconstruction has no business knowing which one it got.
 */
export interface DepthSource {
  /** What produced this, for the report — "Depth Anything V2 (small, ONNX)". */
  readonly name: string;
  /**
   * Depth per pixel, row-major, one value each.
   *
   * The scale is not specified and must not be assumed: monocular models are trained up to an
   * unknown scale and most emit *inverse* depth. `depthToRelief` normalises and orients it, which
   * is why implementations of this interface can simply hand over what the model produced.
   */
  estimate(image: { width: number; height: number; data: Uint8ClampedArray }):
  Promise<{ depth: Float32Array; width: number; height: number }>;
}

export interface DepthReading {
  relief: Relief;
  /** Where the numbers came from, for the note on the feature. */
  source: string;
  /** True when the map was read as inverse depth and flipped. */
  inverted: boolean;
}

export interface DepthOptions {
  /**
   * Which way the numbers run.
   *
   * `auto` decides from the picture, and the decision is the one thing in this file that can be
   * silently wrong: read the wrong way round, a dome comes back as a dish — smooth, closed,
   * plausible, and inside out. See `looksInverted`.
   */
  orientation?: 'auto' | 'near-is-large' | 'near-is-small';
  /** Ignore this fraction at each end when normalising, against outliers. */
  trim?: number;
  /**
   * How deep the part is, as a fraction of how wide it is.
   *
   * A monocular depth map has no scale. Depth Anything and everything like it are trained up to
   * an unknown factor, so the map says a great deal about the *shape* of the surface and nothing
   * whatever about how far the near end is from the far one. There is no arithmetic that recovers
   * it and no honest way to pretend otherwise.
   *
   * So it is stated rather than computed, and stated the same way the importer already states the
   * width it could not know: assumed, said out loud, and left as a parameter on the feature for
   * the user to correct in one edit. Half the width by default, which is a part about as deep as
   * a hemisphere — wrong for a plate, wrong for a bottle, and wrong in a direction anyone looking
   * at the result can see.
   */
  depthFraction?: number;
}

const DEFAULT_TRIM = 0.02;

/** The assumed depth of a part, as a fraction of its width. See `DepthOptions.depthFraction`. */
export const ASSUMED_DEPTH_FRACTION = 0.5;

/**
 * A depth map, as a height field over the part.
 *
 * `mask` is the same foreground the tracer found, so the height field covers exactly the region
 * that will be built and nothing behind it. Without it, the background — which is *further away*
 * and therefore a legitimate depth — becomes part of the part.
 */
export function depthToRelief(
  depth: Float32Array,
  width: number,
  height: number,
  mask: Uint8Array,
  source: string,
  options: DepthOptions = {},
): DepthReading | null {
  if (depth.length !== width * height || mask.length !== width * height) return null;

  const inside: number[] = [];
  for (let i = 0; i < depth.length; i++) {
    if (mask[i] && Number.isFinite(depth[i]!)) inside.push(depth[i]!);
  }
  if (inside.length < 64) return null;

  /*
   * Normalised over the part, not over the frame.
   *
   * A photograph of a bracket on a bench is mostly bench, and the bench runs from the near edge
   * of the table to the far wall. Normalising over the whole frame spends the entire range on
   * the room and leaves the bracket occupying two percent of it — a part 0.02 units thick, which
   * comes back flat.
   */
  inside.sort((a, b) => a - b);
  const trim = Math.min(0.2, Math.max(0, options.trim ?? DEFAULT_TRIM));
  const at = (q: number) => inside[Math.min(inside.length - 1, Math.floor(inside.length * q))]!;

  const lo = at(trim);
  const hi = at(1 - trim);
  const span = hi - lo;

  // A part at one depth is a flat part, which is a fine answer and not a height field.
  if (!(span > 1e-9)) return null;

  const orientation = options.orientation ?? 'auto';
  const inverted = orientation === 'auto'
    ? looksInverted(depth, mask, width, height, lo, span)
    : orientation === 'near-is-small';

  const field = new Float32Array(depth.length);
  let peak = 0;

  for (let i = 0; i < depth.length; i++) {
    if (!mask[i]) continue;

    const unit = Math.max(0, Math.min(1, (depth[i]! - lo) / span));
    const value = inverted ? 1 - unit : unit;

    field[i] = value;
    if (value > peak) peak = value;
  }

  /*
   * How tall the result stands, which is assumed rather than measured — see `depthFraction`.
   *
   * `relief.ts` earns this number: shape from shading solves a surface in pixel units, so its
   * peak height and the part's width are on the same ruler and their ratio means something. A
   * depth model's output is on no ruler at all. Computing `peak / extent` here would have divided
   * a normalised height by a pixel count and produced 1/96 — a hemisphere reconstructed one
   * ninety-sixth as deep as it is wide, which is a flat disc, arrived at with arithmetic that
   * looks exactly like the arithmetic next door.
   */
  const scaled = Math.max(0, options.depthFraction ?? ASSUMED_DEPTH_FRACTION);

  return {
    relief: {
      height: field,
      width,
      height_: height,
      // A depth map carries no lighting, and saying otherwise would let a caller reason about a
      // light that was never estimated.
      light: { direction: [0, 0, 1], confidence: 0 },
      reliefRatio: peak > 0 ? scaled : 0,
      /*
       * Both reported at their most confident, and that is a statement about the method rather
       * than about this picture. `shading` and `obliquity` exist so a caller can tell whether a
       * shape-from-shading solution is trustworthy; a depth model does not infer from shading, so
       * neither quantity constrains it, and passing along a low confidence would make callers
       * discard good reconstructions for failing a test that does not apply to them.
       */
      shading: 1,
      obliquity: 0,
    },
    source,
    inverted,
  };
}

/**
 * Whether large numbers mean *near* rather than far.
 *
 * Almost every monocular model emits inverse depth — larger is nearer — and a few emit metric
 * depth, where larger is further. Nothing in the array says which, and reading it the wrong way
 * turns a dome into a dish: smooth, closed, plausible, and inside out.
 *
 * Decided by where the extreme values sit. A photographed object is nearest somewhere in its
 * middle and falls away towards its edges, whichever convention the numbers use. So if the
 * pixels near the centre hold *smaller* values than the ones around the rim, small means near —
 * the map is metric depth, and it has to be flipped before it can be a height. It is a weak
 * assumption and a much better one than a coin toss, and the caller can always overrule it.
 */
export function looksInverted(
  depth: Float32Array, mask: Uint8Array, width: number, height: number,
  lo: number, span: number,
): boolean {
  let cx = 0, cy = 0, n = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      cx += x; cy += y; n++;
    }
  }
  if (n === 0) return false;

  cx /= n; cy /= n;

  // The radius that splits the part into a core and a rim of roughly equal area.
  const half = Math.sqrt(n / Math.PI) * Math.SQRT1_2;

  let core = 0, coreN = 0, rim = 0, rimN = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i] || !Number.isFinite(depth[i]!)) continue;

      const unit = (depth[i]! - lo) / span;
      if (Math.hypot(x - cx, y - cy) <= half) { core += unit; coreN++; } else { rim += unit; rimN++; }
    }
  }

  if (coreN === 0 || rimN === 0) return false;

  // Centre further away than the rim means larger is further: metric depth, needing a flip.
  return core / coreN < rim / rimN;
}

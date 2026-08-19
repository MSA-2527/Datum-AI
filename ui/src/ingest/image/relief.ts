/**
 * Recovering shape from the shading in a photograph.
 *
 * The tracer turns a picture into an outline, and an outline extruded is a flat plate in the
 * shape of the object. That is the right answer for a laser-cut bracket and the wrong one for
 * anything with a surface — a photograph of a domed cover came back as a disc, and the reason
 * was that everything inside the silhouette had been thrown away by the threshold.
 *
 * The information is still there. A Lambertian surface lit from one direction has a brightness
 * that depends only on which way it faces, so the intensity inside the outline *is* a map of
 * the surface normals, and a normal field integrates to a height. That is shape from shading,
 * and it is classical computer vision rather than a learned model — worth saying plainly,
 * because this application has no server to run a network on and no dataset to train one with.
 * What it does have is a physical model of how light lands on a surface, which needs neither.
 *
 * Two things make it work here that do not hold in general:
 *
 *   - the silhouette gives the light direction for free. At the edge of a smooth object the
 *     surface turns away from the viewer, so the normal lies in the image plane and points
 *     out along the boundary. Brightness around the boundary is then a direct reading of the
 *     light's in-plane direction, with no statistics and no assumed constants.
 *
 *   - the silhouette gives the boundary condition. Height is zero on the outline, which is
 *     what pins down the integration — without it a shading field determines shape only up to
 *     an unknown surface, and the result drifts.
 *
 * What it cannot do is invent what the camera could not see. A photograph shows one side; this
 * recovers that side, as a relief on a base. It is not a scan.
 */

import { luminance, type RasterImage } from './trace';
import { type Vec2 } from '../../kernel/math/vec';

export interface Light {
  /** Unit vector towards the light, in image coordinates with +Z towards the viewer. */
  direction: [number, number, number];
  /**
   * How much of the brightness the fit actually explained, 0 to 1.
   *
   * Low means the boundary brightness did not vary the way a lit solid's would — a flat cut-out
   * on white, a drawing, a screenshot. Reported rather than hidden because it is the honest
   * signal for whether shape from shading has anything to work with at all.
   */
  confidence: number;
}

export interface Relief {
  /** Height per pixel, in the range 0 to 1, zero outside the mask. */
  height: Float32Array;
  width: number;
  height_: number;
  light: Light;
  /** Peak height as a fraction of the part's width, before any scaling. */
  reliefRatio: number;
  /** How much the brightness varies inside the outline — see `shadingStrength`. */
  shading: number;
  /**
   * How far off the view direction the light is, 0 to 1.
   *
   * Above about a third, the reconstruction is not trustworthy and the caller should build a
   * plain extrusion instead. Reported rather than acted on here so the decision, and the
   * reason for it, live with the thing that tells the user.
   */
  obliquity: number;
}

/** True where the part is. */
export type Mask = Uint8Array;

/**
 * Foreground from the traced outline rather than from the threshold again.
 *
 * The outline has already survived contour filtering, hole detection and simplification, so it
 * is a far better statement of where the part is than a fresh pass over the pixels — and it
 * guarantees that the region being integrated is exactly the region that will be extruded.
 */
export function maskFromProfile(
  outer: Vec2[], holes: Vec2[][], width: number, height: number, mmPerPixel: number,
): Mask {
  const mask = new Uint8Array(width * height);
  const toPx = (p: Vec2): Vec2 => [p[0] / mmPerPixel, p[1] / mmPerPixel];

  const inside = (loop: Vec2[], x: number, y: number): boolean => {
    let hit = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = toPx(loop[i]!);
      const b = toPx(loop[j]!);
      if ((a[1] > y) !== (b[1] > y)
        && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1] || 1e-12) + a[0]) hit = !hit;
    }
    return hit;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inside(outer, x + 0.5, y + 0.5)) continue;
      if (holes.some((h) => inside(h, x + 0.5, y + 0.5))) continue;
      mask[y * width + x] = 1;
    }
  }

  return mask;
}

/**
 * Where the light is, from where the brightness sits.
 *
 * Under a light along the view direction, brightness depends only on how much a surface faces
 * the camera, so on a symmetric part it is distributed symmetrically. Move the light off axis
 * and the bright region moves with it. The displacement of the brightness-weighted centroid
 * from the geometric one is therefore a direct measure of how oblique the light is, and points
 * at it.
 *
 * This replaced reading the brightness around the silhouette, which is exact in theory — at the
 * rim the surface is side-on, so its normal lies in the image plane and brightness there reads
 * the light directly — and fragile in practice. It requires the mask boundary to *be* the true
 * silhouette, and it is not: the outline has been simplified and smoothed by the time it gets
 * here, so "rim" pixels land some way inside the object where it is bright. A frontally lit
 * dome, whose rim is genuinely dark all the way round, came back as almost fully oblique.
 *
 * The centroid measure needs no such precision. It can be fooled the other way — an asymmetric
 * part under a frontal light has an off-centre bright region through its own shape — but that
 * error is in the safe direction: it declines a reconstruction that would have been fine, where
 * the opposite mistake builds a lopsided solid and says nothing.
 */
export function estimateLight(gray: Uint8Array, mask: Mask, w: number, h: number): Light {
  let area = 0, cx = 0, cy = 0;
  let weight = 0, bx = 0, by = 0;
  let peak = 1e-6;

  for (let i = 0; i < mask.length; i++) if (mask[i] && gray[i]! > peak) peak = gray[i]!;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;

      area++; cx += x; cy += y;

      // Weighted by brightness above the object's own darkest tone, so a uniform pedestal of
      // ambient light does not dilute the measure towards the geometric centre.
      const v = gray[i]! / peak;
      weight += v; bx += v * x; by += v * y;
    }
  }

  if (area < 16 || weight < 1e-6) return { direction: [0, 0, 1], confidence: 0 };

  cx /= area; cy /= area;
  bx /= weight; by /= weight;

  // Scaled by the radius of a disc of the same area, so the answer does not depend on how big
  // the part is in the frame.
  const radius = Math.sqrt(area / Math.PI);
  const dx = (bx - cx) / radius;
  const dy = (by - cy) / radius;

  const offset = Math.hypot(dx, dy);
  if (offset < 1e-4) return { direction: [0, 0, 1], confidence: 0 };

  // The constant maps the observed displacement onto an in-plane light component. Calibrated
  // on rendered spheres: a light 37° off axis displaces the brightness centroid by about a
  // fifth of the radius.
  const inPlane = Math.min(0.98, offset * 3);
  const lx = (dx / offset) * inPlane;
  const ly = (dy / offset) * inPlane;
  const lz = Math.sqrt(Math.max(0, 1 - inPlane * inPlane));

  return { direction: [lx, ly, lz], confidence: Math.min(1, offset * 3) };
}

/**
 * How much the brightness varies *inside* the outline.
 *
 * The question that decides whether to build a relief at all, and a different one from where
 * the light is. A flat cut-out, a screenshot or a line drawing is uniform inside its outline —
 * there is no surface to recover, and a relief built from it would be noise given a shape. A
 * photograph of a solid varies, because different parts of it face different ways.
 *
 * Conflating this with the light estimate was a mistake worth recording: a dome lit from
 * straight on has a completely uniform rim and is the *easiest* case to reconstruct, so judging
 * it by the rim would have refused exactly the pictures the method handles best.
 */
export function shadingStrength(gray: Uint8Array, mask: Mask): number {
  let sum = 0, sumSq = 0, n = 0, peak = 1e-6;

  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const v = gray[i]!;
    sum += v; sumSq += v * v; n++;
    if (v > peak) peak = v;
  }

  if (n < 16) return 0;

  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return Math.min(1, Math.sqrt(variance) / peak);
}

/**
 * How steep the surface is at each pixel, from how dark it is.
 *
 * Under a light along the view direction the reflectance is `1/sqrt(1 + |∇z|²)` — it depends on
 * the *magnitude* of the surface gradient and not at all on its direction. So brightness gives
 * the slope directly, `|∇z| = sqrt(1/I² − 1)`, with no iteration and nothing to converge.
 *
 * Two facts make this the right core rather than a special case. It is exact: for a sphere it
 * gives `d/sqrt(r² − d²)`, which is the true slope at every point. And the direction it cannot
 * determine is supplied by the thing it is solved with — the surface has to close onto its own
 * silhouette, which fixes which way the slope runs.
 */
function slopeField(intensity: Float32Array, mask: Mask): Float32Array {
  const g = new Float32Array(intensity.length);

  for (let i = 0; i < intensity.length; i++) {
    if (!mask[i]) continue;

    // Clamped away from zero and one. A pixel at full brightness is flat, and one at zero is
    // vertical — infinitely steep — which is not a number the solve can carry.
    const v = Math.min(0.999, Math.max(0.06, intensity[i]!));
    g[i] = Math.sqrt(Math.max(0, 1 / (v * v) - 1));
  }

  return g;
}

/**
 * Solves `|∇z| = g` with `z = 0` on the silhouette, by fast sweeping.
 *
 * Four alternating diagonal passes with the Godunov upwind update. Fast sweeping rather than
 * fast marching because it needs no priority queue and no heap — the information in an eikonal
 * problem travels along straight characteristics, and four sweep orders between them cover
 * every direction one can travel in.
 *
 * The boundary condition is the whole reason this is solvable. A shading field on its own fixes
 * a surface only up to an unknown one; pinning the height to zero where the object meets the
 * background is what turns it into a single answer, and it is also exactly the condition the
 * solid needs so its relief meets the walls built from the same outline.
 */
function fastSweep(g: Float32Array, mask: Mask, w: number, h: number, passes = 4): Float32Array {
  const BIG = 1e9;
  const z = new Float32Array(w * h).fill(BIG);

  const isEdge = (i: number, x: number, y: number): boolean =>
    x === 0 || y === 0 || x === w - 1 || y === h - 1
    || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) { z[i] = 0; continue; }
      if (isEdge(i, x, y)) z[i] = 0;
    }
  }

  const neighbour = (x: number, y: number): number =>
    (x < 0 || y < 0 || x >= w || y >= h || !mask[y * w + x]) ? BIG : z[y * w + x]!;

  const update = (x: number, y: number): void => {
    const i = y * w + x;
    if (!mask[i] || isEdge(i, x, y)) return;

    const a = Math.min(neighbour(x - 1, y), neighbour(x + 1, y));
    const b = Math.min(neighbour(x, y - 1), neighbour(x, y + 1));
    const f = g[i]!;

    // Godunov: when the two upwind values differ by more than one step of `f`, the
    // characteristic runs along a single axis and only the nearer neighbour contributes.
    let candidate: number;
    if (Math.abs(a - b) >= f) {
      candidate = Math.min(a, b) + f;
    } else {
      const disc = 2 * f * f - (a - b) * (a - b);
      candidate = (a + b + Math.sqrt(Math.max(0, disc))) / 2;
    }

    if (candidate < z[i]!) z[i] = candidate;
  };

  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) update(x, y);
    for (let y = 0; y < h; y++) for (let x = w - 1; x >= 0; x--) update(x, y);
    for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) update(x, y);
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) update(x, y);
  }

  for (let i = 0; i < z.length; i++) if (z[i]! >= BIG) z[i] = 0;
  return z;
}

/**
 * Height from shading.
 *
 * The eikonal solve, and deliberately nothing more.
 *
 * It assumes the light lies along the view direction, and in that case it is not an
 * approximation — brightness is exactly a reading of slope, and a rendered sphere comes back
 * with its peak on the centre pixel and its profile matching `sqrt(r² − d²)` to within a few
 * percent. Frontal and diffuse light covers most of what people photograph parts under: a
 * flash, a light box, an overcast bench, a flatbed scan.
 *
 * Strongly oblique light is a different problem and this does not pretend to solve it. Under a
 * side light a face turned *towards* the lamp is bright, the eikonal reads bright as flat, and
 * the surface comes back as a ridge leaning into the light. Dividing the light out by fixed
 * point was tried — solve, read the normals, convert the observed brightness to what it would
 * have been under a frontal light, solve again — and measured on a sphere lit 40° off axis it
 * moved the recovered peak from 33 pixels off-centre to 23, still nowhere near the middle, and
 * with the light estimated rather than known it was worse than doing nothing. So it is not
 * here. The obliquity is reported instead, and the caller declines: an honest flat extrusion
 * beats a confidently lopsided solid.
 */
export function solveHeight(
  gray: Uint8Array, mask: Mask, w: number, h: number,
): { height: Float32Array; peakPixels: number } {
  let brightest = 1e-6;
  for (let i = 0; i < mask.length; i++) if (mask[i] && gray[i]! > brightest) brightest = gray[i]!;

  const intensity = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) if (mask[i]) intensity[i] = gray[i]! / brightest;

  const z = fastSweep(slopeField(intensity, mask), mask, w, h);

  // The peak *before* normalising, in pixels, is the one physical number this produces. The
  // solve integrates a slope over a pixel grid, so its height is in the same units as its
  // width — which is what says a hemisphere is half as tall as it is wide. Normalising first
  // and reading the peak afterwards gives 1 every time, and the depth computed from it came
  // out half a millimetre on a part 46 mm across.
  let peakPixels = 0;
  for (let i = 0; i < z.length; i++) {
    if (!mask[i]) { z[i] = 0; continue; }
    if (z[i]! < 0) z[i] = 0;
    if (z[i]! > peakPixels) peakPixels = z[i]!;
  }

  const height = new Float32Array(z.length);
  if (peakPixels > 0) for (let i = 0; i < z.length; i++) height[i] = z[i]! / peakPixels;

  return { height, peakPixels };
}

/** The height field alone, normalised to run from zero to one. */
export function heightFromShading(
  gray: Uint8Array, mask: Mask, w: number, h: number,
): Float32Array {
  return solveHeight(gray, mask, w, h).height;
}

/** Averages each pixel with its neighbours, `passes` times, holding the outside at zero. */
export function smooth(field: Float32Array, mask: Mask, w: number, h: number, passes = 2): Float32Array {
  let src = field;
  for (let pass = 0; pass < passes; pass++) {
    const out = new Float32Array(src.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        out[i] = (src[i]! * 4 + src[i - 1]! + src[i + 1]! + src[i - w]! + src[i + w]!) / 8;
      }
    }
    src = out;
  }
  return src;
}

/** Bilinear sample of a height field at a pixel coordinate, zero outside. */
export function sampleHeight(field: Float32Array, w: number, h: number, x: number, y: number): number {
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return 0;

  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;

  const a = field[y0 * w + x0]! * (1 - fx) + field[y0 * w + x1]! * fx;
  const b = field[y1 * w + x0]! * (1 - fx) + field[y1 * w + x1]! * fx;
  return a * (1 - fy) + b * fy;
}

/**
 * The whole chain: picture and outline in, height field out.
 *
 * `reliefRatio` is how tall the recovered surface is relative to the part's width, which is the
 * number that decides whether this was worth doing. A photograph of a flat plate integrates to
 * a nearly flat field, and building a relief from it would add noise where the truth is a
 * plane — so the caller is given the figure and can decline.
 */
export function reliefFromImage(
  img: RasterImage, outer: Vec2[], holes: Vec2[][], mmPerPixel: number,
): Relief | null {
  const w = img.width;
  const h = img.height;
  if (w < 8 || h < 8) return null;

  const gray = luminance(img);
  const mask = maskFromProfile(outer, holes, w, h, mmPerPixel);

  let covered = 0;
  for (let i = 0; i < mask.length; i++) covered += mask[i]!;
  if (covered < 64) return null;

  const light = estimateLight(gray, mask, w, h);
  const solved = solveHeight(gray, mask, w, h);

  // Smoothed at a scale set by the picture, not by a fixed count. Fast sweeping propagates
  // along the grid axes, which leaves faint ridges running out from the centre of a dome, and
  // a fixed two passes of a five-point average is a two-pixel kernel — invisible on a 300 pixel
  // photograph. Tied to the image size, the same code removes them at any resolution.
  const passes = Math.max(2, Math.round(Math.min(w, h) / 48));
  const height = smooth(solved.height, mask, w, h, passes);

  // Peak height against the part's width in pixels, both measured on the same grid so the
  // ratio is independent of resolution and of the assumed scale.
  let widthPx = 0;
  let minX = w, maxX = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  widthPx = Math.max(1, maxX - minX);

  return {
    height, width: w, height_: h, light,
    // How tall the recovered surface is against how wide the part is, both in pixels. For a
    // hemisphere this is a half, which is the number that makes the depth come out right.
    reliefRatio: solved.peakPixels / widthPx,
    shading: shadingStrength(gray, mask),
    obliquity: Math.hypot(light.direction[0], light.direction[1]),
  };
}

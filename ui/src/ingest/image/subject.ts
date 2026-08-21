/**
 * What kind of picture is this?
 *
 * The question the image importer never asked, and the reason it could be confidently,
 * spectacularly wrong. `trace.ts` says plainly what it is for — "a photograph, scan or
 * screenshot of *a 2D shape*" — and it does that job well: threshold, trace the boundary, fit
 * lines and arcs, extrude or revolve. Hand it a flat gasket and it gives you a gasket.
 *
 * Hand it a perspective render of a rotary kiln on concrete piers, with a stack, a preheater
 * and half a building in frame, and it does exactly the same thing: finds the outline of
 * everything in the picture and extrudes it. What comes out is a flat slab shaped like the
 * silhouette of a scene — geometrically valid, closed, manifold, dimensioned, and nothing to do
 * with what the user imported. No check downstream can catch it, because every one of them asks
 * whether the solid is sound, and it is.
 *
 * ── Why classify rather than improve the tracer ──
 *
 * Because no amount of tracing can recover a kiln from one perspective view. The information is
 * not in the silhouette; it is in the interior — the shading, the edges, the way the cylinders
 * foreshorten — and reading that is what a vision model is for. The tracer is not broken and
 * does not need fixing. It needs to stop being handed work that is not its own.
 *
 * ── What the question actually is ──
 *
 * Not "is this three-dimensional". Almost every useful photograph is. The importer has two ways
 * to read a picture and both are legitimate:
 *
 *   - **an outline**, traced and extruded or revolved — for a flat part square on;
 *   - **the shading**, solved for a height field — for one object facing the camera, which is
 *     how a domed cover photographed from above becomes a dome rather than a disc.
 *
 * Both need the same thing: **one object, seen face on**. Neither can do anything with a picture
 * of a machine standing in a room. So the question is whether there is one subject here or a
 * scene, and that is what is measured.
 *
 * An earlier version of this file asked the broader question and got the narrower one wrong: it
 * scored a picture by how much its tones varied, which is high for any lit solid, and duly
 * refused the shaded dome the relief path handles correctly. Tonal spread says a surface is
 * curved. It does not say a picture is unusable. It is kept below as evidence and no longer
 * decides anything.
 *
 * ── The evidence, and what each is worth ──
 *
 *   **How many separate things are in frame.** One part is one region. A kiln, its piers, its
 *   stack and half a building are four or more. This is the signal that most directly answers
 *   the question being asked, and it convicts on its own.
 *
 *   **Interior detail** — the fraction of interior pixels on a hard gradient. Measured: zero for
 *   every flat case, 0.9% for a rendered cylinder whose shading is smooth, and 5.7% for a
 *   rendered assembly, where every join between components is an edge. Smooth shading scores
 *   near nothing, which is exactly the distinction wanted: hard interior edges are *structure*,
 *   and structure is several parts.
 *
 *   **How much of its own bounding box the outline fills.** A machine running diagonally across
 *   a frame on legs is mostly empty box. On its own this convicts nothing — an L-bracket is
 *   perfectly flat and fills a third of its box — so it only ever corroborates.
 *
 *   **Tonal spread** is reported and unused. It belongs to the question of whether the shading
 *   is worth solving, which `relief.ts` asks for itself.
 *
 * ── When it is wrong ──
 *
 * A part photographed on a cluttered bench reads as several objects, because it is. So this
 * classifies and explains; it does not overrule. The caller is told what was measured and can
 * say "trace it anyway". What it will not do any more is silently extrude a photograph of a
 * factory into a slab shaped like the outline of a factory.
 */

import type { RasterImage } from './trace';

export type ImageSubject = 'flat-part' | 'scene' | 'drawing';

export interface SubjectVerdict {
  subject: ImageSubject;
  /** 0 to 1. How strongly the evidence points where it points. */
  confidence: number;
  /** Why, in a sentence a user can act on. */
  reason: string;
  evidence: SubjectEvidence;
}

export interface SubjectEvidence {
  /**
   * How much of the subject survives being eroded by a couple of pixels.
   *
   * The measurement that finds a line drawing. A filled silhouette loses only its rim and keeps
   * nearly all of itself; a drawing is strokes one to three pixels wide and almost nothing is
   * left. Near zero means the "shape" is ink rather than an object.
   */
  strokeSurvival: number;
  /**
   * Range of interior brightness, 10th to 90th percentile, in levels of grey.
   *
   * The measurement that separates a solid from a face: several surfaces at several angles to
   * the light against one surface at one angle.
   */
  tonalSpread: number;
  /** Fraction of pixels inside the silhouette that lie on a strong edge. */
  interiorDetail: number;
  /** Separate foreground regions worth counting. */
  regions: number;
  /** Foreground area as a fraction of its own bounding box. */
  fillRatio: number;
  /** Foreground as a fraction of the whole frame. */
  coverage: number;
}

/**
 * Above this fraction of hard interior steps, the picture has structure in it.
 *
 * Placed in a measured gap rather than chosen. The fraction of interior pixels sitting on a step,
 * measured a margin inside the outline so an antialiased edge cannot contribute:
 *
 *     plain blank, evenly lit ..............  0
 *     grey disc, antialiased rim ...........  0      (3% before the margin was eroded)
 *     shaded dome, photographed from above ..  0.001
 *     shaded render of one cylinder .........  0.008
 *     flat plate with an engraved mark ......  0.021
 *     shaded render of a four-part machine ..  0.041
 *     wireframe render of a machine ......... 0.125
 *
 * The limit sits between the engraved plate and the machine, because the engraved plate is the
 * case that constrains it from below: it is unambiguously a flat part and it is the busiest one.
 * Note where the dome falls — a strongly curved surface is *smoother* by this measure than a
 * flat-faced single part, which is the point of measuring steps rather than slopes.
 */
const DETAIL_LIMIT = 0.03;

/** Enough separate things in frame that it is a scene rather than a part. */
const REGION_LIMIT = 3;

/** Below this, the outline is mostly empty box — legs, gaps, a diagonal run. */
const FILL_LIMIT = 0.35;

/**
 * Below this fraction surviving erosion, the marked area is ink and not an object.
 *
 * Measured: a filled silhouette keeps 80-95% of itself when thinned by two pixels, and a
 * technical drawing keeps a few per cent. The gap is enormous, which is what makes a single
 * threshold safe here.
 */
const STROKE_SURVIVAL_LIMIT = 0.35;

/**
 * And it has to be sparse, or a heavily textured photograph could be mistaken for line work.
 *
 * A drawing is mostly paper. A photograph of a part fills a good share of its frame with part.
 */
const INK_COVERAGE_LIMIT = 0.5;

/**
 * Classifies an image before anything is built from it.
 *
 * `foreground` is the mask the tracer already computed, so this costs one pass over the pixels
 * and never disagrees with the shape that would actually be traced.
 */
export function classifySubject(
  image: RasterImage, foreground: Uint8Array,
): SubjectVerdict {
  const { width, height } = image;
  const gray = luminanceOf(image);

  const box = boundsOf(foreground, width, height);
  const area = countOf(foreground);

  // Nothing to judge. The tracer will refuse it on its own terms, and guessing here would put
  // a second opinion in front of a better one.
  if (area === 0 || !box) {
    return {
      subject: 'flat-part',
      confidence: 0,
      reason: 'Nothing stood out from the background.',
      evidence: {
        strokeSurvival: 0, tonalSpread: 0, interiorDetail: 0, regions: 0, fillRatio: 0, coverage: 0,
      },
    };
  }

  /*
   * Measured a margin inside the outline, not right up to it.
   *
   * Every real image is antialiased, so the silhouette is not a step — it is a band a pixel or
   * two wide where the subject fades into the background. Excluding only pixels *on* the
   * boundary leaves that band inside the measurement, and the band is nothing but steep
   * gradient: a plain grey disc on white measured 3% hard interior steps and was refused as a
   * picture of a machine. The synthetic tests never saw it because a rectangle filled by hand
   * has no soft edge, and no real photograph is like that.
   *
   * The margin grows with the part, because a soft edge in a 4000-pixel photograph is wider than
   * one in a 160-pixel thumbnail.
   */
  const margin = Math.max(2, Math.round(Math.max(
    box.maxX - box.minX + 1, box.maxY - box.minY + 1,
  ) / 64));
  const eroded = erode(foreground, width, height, margin);
  const interior = interiorOf(gray, eroded, width, height);
  const strokeSurvival = countOf(eroded) / Math.max(1, area);

  const evidence: SubjectEvidence = {
    strokeSurvival,
    tonalSpread: interior.spread,
    interiorDetail: interior.detail,
    regions: countRegions(foreground, width, height, area),
    fillRatio: area / Math.max(1, (box.maxX - box.minX + 1) * (box.maxY - box.minY + 1)),
    coverage: area / (width * height),
  };

  /*
   * A drawing, before anything else is asked.
   *
   * This was the blind spot, and it produced the worst output this importer has ever made: a
   * four-view blueprint of a car was traced as one shape and extruded, giving a flat slab in the
   * outline of the whole *sheet* — every view, every leader line and the word MARKINGS, 7 mm
   * thick. Confident, closed, dimensioned, and not a car.
   *
   * It slipped through because the tests before it are about the *inside* of a silhouette, and a
   * drawing has no inside: the mask is strokes, so eroding it to exclude the antialiased rim
   * removed nearly the whole thing and left an interior of a few dozen pixels that were, quite
   * correctly, smooth and featureless.
   *
   * The same erosion is the test. Ink one to three pixels wide does not survive it; an object
   * loses only its rim. Asked first because it is the most specific question — a drawing is not
   * a scene and not a flat part, and reading it needs the views understood, not the outline
   * traced.
   */
  if (strokeSurvival < STROKE_SURVIVAL_LIMIT && evidence.coverage < INK_COVERAGE_LIMIT) {
    return {
      subject: 'drawing',
      confidence: 0.9,
      reason:
        'This looks like a line drawing rather than a photograph: only '
        + `${(strokeSurvival * 100).toFixed(0)}% of the marked area survives being thinned by a `
        + `couple of pixels, so it is ink rather than an object, and it covers just `
        + `${(evidence.coverage * 100).toFixed(0)}% of the sheet.`,
      evidence,
    };
  }

  const reasons: string[] = [];
  let score = 0;

  if (evidence.regions >= REGION_LIMIT) {
    // Convicts alone: several separate objects in frame is a scene by definition, and neither
    // reading an outline nor solving shading has anything to say about which one to build.
    score += 2;
    reasons.push(`${evidence.regions} separate objects are in frame`);
  }

  if (evidence.interiorDetail > DETAIL_LIMIT) {
    /*
     * Hard edges inside the outline are structure, not shading.
     *
     * A smoothly lit dome scores near zero here however curved it is — the gradient across it is
     * gentle everywhere. A machine scores high, because every place one component meets the next
     * is a step. That is why this measures the *hardness* of interior gradients rather than the
     * range of interior tones: the range is high for anything solid, and only the hardness
     * distinguishes one solid from an assembly of them.
     */
    score += 2;
    reasons.push(
      `${(evidence.interiorDetail * 100).toFixed(0)}% of the interior is hard edges rather than `
      + 'smooth shading, which is what the join between one component and the next looks like',
    );
  }

  if (evidence.fillRatio < FILL_LIMIT) {
    score += 1;
    reasons.push(
      `the outline fills only ${(evidence.fillRatio * 100).toFixed(0)}% of its own bounding box, `
      + 'so it runs diagonally or stands on legs rather than lying flat',
    );
  }

  const scene = score >= 2;

  return {
    subject: scene ? 'scene' : 'flat-part',
    confidence: Math.min(1, score / 4),
    reason: scene
      ? `This looks like a picture of a scene rather than of one part: ${reasons.join('; ')}.`
      : 'This looks like one object seen face on, which is what an outline or its shading can be read from.',
    evidence,
  };
}

// ── the measurements ─────────────────────────────────────────────────────────

function luminanceOf(image: RasterImage): Uint8Array {
  const out = new Uint8Array(image.width * image.height);
  for (let i = 0; i < out.length; i++) {
    const r = image.data[i * 4]!, g = image.data[i * 4 + 1]!, b = image.data[i * 4 + 2]!;
    out[i] = (r * 77 + g * 150 + b * 29) >> 8;
  }
  return out;
}

/**
 * What the inside of the shape looks like: how varied its tones are, and how busy it is.
 *
 * Both in one pass over the same pixels, because they answer the same question from two
 * directions and disagreeing about which pixels are "inside" would make them incomparable.
 *
 * Only strictly interior pixels count — all four neighbours foreground — and the reason is
 * worth stating: the silhouette's own boundary is the strongest edge in any image by
 * definition, so a measurement that includes it fires on every picture and is really only
 * reporting that the shape has an outline. They all do.
 */
function interiorOf(
  gray: Uint8Array, foreground: Uint8Array, width: number, height: number,
): { spread: number; detail: number } {
  const tones: number[] = [];
  let edges = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!foreground[i]) continue;
      if (!foreground[i - 1] || !foreground[i + 1]
        || !foreground[i - width] || !foreground[i + width]) continue;

      tones.push(gray[i]!);

      /*
       * A step, not a slope.
       *
       * The second difference, because that is what "hard edge" means and the first difference
       * is not it. A small dome shaded across ninety pixels has a steep gradient everywhere near
       * its rim — steeper, in levels per pixel, than the joins in a picture of a machine — so
       * scoring by gradient magnitude called a smooth dome busier than an assembly and refused
       * it. Curvature is a slope that changes gently; a join between two components is a slope
       * that changes all at once, and only the second difference tells them apart.
       */
      const step = Math.abs(
        4 * gray[i]! - gray[i - 1]! - gray[i + 1]! - gray[i - width]! - gray[i + width]!,
      );
      if (step > EDGE_STRENGTH) edges++;
    }
  }

  if (tones.length === 0) return { spread: 0, detail: 0 };

  /*
   * Percentiles rather than the full range, so one blown highlight cannot decide it.
   * A single specular pixel at 255 in an otherwise flat grey part would otherwise report a
   * spread of two hundred levels and send a perfectly flat gasket to the wrong route.
   */
  tones.sort((a, b) => a - b);
  const at = (q: number) => tones[Math.min(tones.length - 1, Math.floor(tones.length * q))]!;

  return { spread: at(0.9) - at(0.1), detail: edges / tones.length };
}

/**
 * How abrupt a brightness change has to be to count as an edge.
 *
 * A second difference, in levels of an 8-bit grey: four times the pixel less its four
 * neighbours. Low enough to catch the thin lines where one component meets the next, and — being
 * a second difference — blind to smooth shading however steep, which is the whole distinction
 * being drawn.
 */
const EDGE_STRENGTH = 24;

/** Separate foreground regions, ignoring specks. */
function countRegions(
  foreground: Uint8Array, width: number, height: number, total: number,
): number {
  const seen = new Uint8Array(foreground.length);
  const stack: number[] = [];

  // A region has to be worth counting: a hundredth of the foreground, so dust and antialiasing
  // do not add up to "a scene".
  const floor = Math.max(16, total * 0.01);
  let regions = 0;

  for (let start = 0; start < foreground.length; start++) {
    if (!foreground[start] || seen[start]) continue;

    let size = 0;
    stack.push(start);
    seen[start] = 1;

    while (stack.length > 0) {
      const i = stack.pop()!;
      size++;

      const x = i % width;
      const y = (i - x) / width;

      if (x > 0) push(i - 1);
      if (x < width - 1) push(i + 1);
      if (y > 0) push(i - width);
      if (y < height - 1) push(i + width);
    }

    if (size >= floor) regions++;
  }

  return regions;

  function push(j: number): void {
    if (foreground[j] && !seen[j]) {
      seen[j] = 1;
      stack.push(j);
    }
  }
}

/**
 * The mask pulled in by `margin` pixels on every side.
 *
 * A Chebyshev distance rather than Euclidean — a square neighbourhood — because the thing being
 * removed is a soft boundary of roughly uniform width, and a square kernel is separable and
 * exact enough for that at a fraction of the cost.
 */
function erode(mask: Uint8Array, width: number, height: number, margin: number): Uint8Array {
  if (margin <= 0) return mask;

  // Horizontally, then vertically: a square erosion is two one-dimensional passes.
  const once = (source: Uint8Array, horizontal: boolean): Uint8Array => {
    const out = new Uint8Array(source.length);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!source[i]) continue;

        let keep = 1;
        for (let d = -margin; d <= margin && keep; d++) {
          const nx = horizontal ? x + d : x;
          const ny = horizontal ? y : y + d;

          if (nx < 0 || ny < 0 || nx >= width || ny >= height || !source[ny * width + nx]) keep = 0;
        }
        out[i] = keep;
      }
    }
    return out;
  };

  return once(once(mask, true), false);
}

function countOf(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

function boundsOf(
  mask: Uint8Array, width: number, height: number,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = width, minY = height, maxX = -1, maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

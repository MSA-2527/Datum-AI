/**
 * Raster image to manufacturable profile.
 *
 * Turns a photograph, scan or screenshot of a 2D shape into a closed profile the kernel can
 * extrude or revolve. The chain is: threshold, trace the boundaries, work out which contours
 * are holes inside which, simplify, then fit straight lines and circular arcs.
 *
 * The last step is the one that matters and the one most image-to-CAD tools skip. A traced
 * bitmap boundary is a staircase of pixel steps; extruding it directly gives a part with
 * several thousand microscopic facets that no machinist can quote, no toolpath can follow
 * cleanly, and no engineer can dimension. Recognising that a run of points is *a straight
 * line* or *an arc of radius 12.4 mm* is what converts a picture into geometry, because a
 * drawing needs "R12.4", not four hundred coordinates.
 *
 * Nothing here guesses silently. Every fit reports its own residual, the caller is told what
 * was recognised and what was left as a polyline, and the pixel-to-millimetre scale is always
 * an explicit input — an image carries no size, and inventing one would produce a part that
 * is confidently the wrong dimensions.
 */

import { type Vec2 } from '../../kernel/math/vec';
import { makeProfile, offsetPolygon, signedArea2, type Profile } from '../../kernel/sketch/profile';

// ── input ────────────────────────────────────────────────────────────────────

/** Matches the browser's ImageData, so a canvas can be passed straight in. */
export interface RasterImage {
  width: number;
  height: number;
  /** RGBA, four bytes per pixel, row-major from the top left. */
  data: Uint8ClampedArray;
}

export interface TraceOptions {
  /** Millimetres per pixel. Required: an image has no inherent size. */
  mmPerPixel: number;
  /** Override the automatic threshold, 0-255. */
  threshold?: number;
  /** Treat light pixels as material instead of dark ones. */
  invert?: boolean;
  /** Contours enclosing fewer pixels than this are noise and are dropped. */
  minAreaPx?: number;
  /** Simplification tolerance in millimetres. */
  simplifyMm?: number;
  /** Maximum deviation for a run of points to be accepted as a line or arc, in mm. */
  fitToleranceMm?: number;
}

export interface TracedShape {
  profile: Profile;
  /** Recognised segments of the outer loop, in order. */
  segments: FittedSegment[];
  /** Suggested build operation, with the reasoning shown to the user. */
  suggestion: BuildSuggestion;
  /** Everything the pipeline decided, so a user can check rather than trust. */
  report: TraceReport;
}

export interface TraceReport {
  thresholdUsed: number;
  thresholdAuto: boolean;
  contoursFound: number;
  contoursKept: number;
  holesFound: number;
  pointsBeforeSimplify: number;
  pointsAfterSimplify: number;
  linesRecognised: number;
  arcsRecognised: number;
  /** Points left as a freeform polyline because nothing fitted. */
  freeformPoints: number;
  widthMm: number;
  heightMm: number;
  warnings: string[];
}

export type FittedSegment =
  | { kind: 'line'; start: Vec2; end: Vec2; lengthMm: number; residualMm: number }
  | { kind: 'arc'; centre: Vec2; radiusMm: number; startAngle: number; endAngle: number; residualMm: number }
  | { kind: 'polyline'; points: Vec2[] };

export interface BuildSuggestion {
  operation: 'extrude' | 'revolve';
  /** For a revolve: the detected axis in profile coordinates. */
  axis?: { origin: Vec2; direction: Vec2 };
  confidence: number;
  reason: string;
}

// ── thresholding ─────────────────────────────────────────────────────────────

/** Luminance, using the Rec. 601 weights that match perceived brightness. */
function luminance(img: RasterImage): Uint8Array {
  const out = new Uint8Array(img.width * img.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const alpha = img.data[p + 3];
    // Transparent pixels are background, not black — otherwise every PNG with an alpha
    // channel traces its own bounding box as the outline.
    if (alpha < 128) { out[i] = 255; continue; }
    out[i] = (img.data[p] * 299 + img.data[p + 1] * 587 + img.data[p + 2] * 114) / 1000;
  }
  return out;
}

/**
 * Otsu's method: the threshold maximising between-class variance.
 *
 * Chosen over a fixed value because scans and photographs vary enormously in exposure, and a
 * fixed threshold silently loses thin features on a dark scan or floods a bright one. Otsu
 * adapts to the image's own histogram and needs no tuning.
 *
 * The returned value is the *last level of the dark class*, so the test is `<=`, not `<`.
 * The distinction is not pedantic: on a clean black-on-white drawing the two populations are
 * exactly 0 and 255, Otsu returns 0, and a `<` test selects no pixels at all — the tracer
 * reports an empty image for the easiest possible input.
 */
export function otsuThreshold(gray: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (const v of gray) hist[v]++;

  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0, wB = 0, best = 0, bestVar = -1;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;

    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);

    if (between > bestVar) { bestVar = between; best = t; }
  }
  return best;
}

// ── contour tracing ──────────────────────────────────────────────────────────

interface Contour {
  points: Vec2[];
  /** Positive area means an outer boundary; negative means a hole. */
  signedArea: number;
  /** How many contours enclose this one. Even is solid, odd is a hole. */
  depth: number;
}

/**
 * Moore-neighbour boundary tracing with Jacob's stopping criterion.
 *
 * Walks the boundary of each connected region, producing a closed loop of pixel corners.
 * Jacob's criterion — stop when the start pixel is re-entered *from the same direction* —
 * matters for shapes with a one-pixel-wide neck, where simply "returned to start" terminates
 * after tracing only half the boundary.
 */
function traceContours(mask: Uint8Array, w: number, h: number, minArea: number): Contour[] {
  const visited = new Uint8Array(w * h);
  const contours: Contour[] = [];

  // Eight-connected neighbourhood, clockwise from due east.
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];

  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y) || visited[y * w + x]) continue;
      // Only start from a pixel whose left neighbour is background: that is a boundary.
      if (at(x - 1, y)) continue;

      const points: Vec2[] = [];
      let cx = x, cy = y;
      let dir = 6; // came from the west, so start searching north-west
      const startX = x, startY = y;
      let startDir = -1;
      let guard = w * h * 4;

      while (guard-- > 0) {
        visited[cy * w + cx] = 1;
        points.push([cx, cy]);

        let found = false;
        for (let k = 0; k < 8; k++) {
          const nd = (dir + k) % 8;
          const nx = cx + dx[nd], ny = cy + dy[nd];
          if (!at(nx, ny)) continue;

          if (startDir < 0) startDir = nd;
          else if (nx === startX && ny === startY && nd === startDir) { found = false; break; }

          cx = nx; cy = ny;
          // Resume the search from just behind where we came in, so the walk hugs the edge.
          dir = (nd + 6) % 8;
          found = true;
          break;
        }

        if (!found) break;
        if (cx === startX && cy === startY && points.length > 2) break;
      }

      if (points.length < 8) continue;
      const area = signedArea2(points) / 2;
      if (Math.abs(area) < minArea) continue;

      contours.push({ points, signedArea: area, depth: 0 });
    }
  }

  // Nesting depth by containment: a contour inside an odd number of others is a hole.
  for (let i = 0; i < contours.length; i++) {
    for (let j = 0; j < contours.length; j++) {
      if (i === j) continue;
      if (contains(contours[j].points, contours[i].points[0])) contours[i].depth++;
    }
  }

  return contours;
}

function contains(loop: Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    if (loop[i][1] > p[1] !== loop[j][1] > p[1]) {
      const x = loop[i][0] + ((p[1] - loop[i][1]) / (loop[j][1] - loop[i][1])) * (loop[j][0] - loop[i][0]);
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}

// ── simplification ───────────────────────────────────────────────────────────

/**
 * Douglas-Peucker on a closed loop.
 *
 * Applied before fitting rather than after: the raw trace has one point per pixel and
 * fitting over that is both slow and dominated by quantisation noise. Simplifying first
 * leaves the points that actually carry the shape.
 */
export function simplifyLoop(points: Vec2[], tol: number): Vec2[] {
  if (points.length < 4) return [...points];

  // A closed loop has no natural endpoints, so anchor on the two points furthest apart.
  // Splitting at an arbitrary index instead can cut through the middle of a smooth curve
  // and leave a visible flat there.
  let ai = 0, bi = 0, best = -1;
  for (let i = 0; i < points.length; i++) {
    const d = (points[i][0] - points[0][0]) ** 2 + (points[i][1] - points[0][1]) ** 2;
    if (d > best) { best = d; bi = i; }
  }
  best = -1;
  for (let i = 0; i < points.length; i++) {
    const d = (points[i][0] - points[bi][0]) ** 2 + (points[i][1] - points[bi][1]) ** 2;
    if (d > best) { best = d; ai = i; }
  }
  if (ai > bi) { const t = ai; ai = bi; bi = t; }

  const first = points.slice(ai, bi + 1);
  const second = [...points.slice(bi), ...points.slice(0, ai + 1)];

  const a = douglasPeucker(first, tol);
  const b = douglasPeucker(second, tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function douglasPeucker(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length < 3) return [...pts];

  let maxDist = 0, index = 0;
  const a = pts[0], b = pts[pts.length - 1];

  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpendicularDistance(pts[i], a, b);
    if (d > maxDist) { maxDist = d; index = i; }
  }

  if (maxDist <= tol) return [a, b];

  const left = douglasPeucker(pts.slice(0, index + 1), tol);
  const right = douglasPeucker(pts.slice(index), tol);
  return [...left.slice(0, -1), ...right];
}

function perpendicularDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

// ── primitive fitting ────────────────────────────────────────────────────────

/**
 * Least-squares circle through a set of points (Kåsa's algebraic fit).
 *
 * The geometric fit — minimising true radial distance — needs iteration and can fail to
 * converge on a short arc. Kåsa's linearisation solves in closed form by fitting the
 * equation `x² + y² + Dx + Ey + F = 0`, which is exact for points on a circle and biased
 * only when the points are noisy over a short arc. Since the residual is reported, a poor
 * fit is rejected rather than accepted with a wrong radius.
 */
export function fitCircle(pts: Vec2[]): { centre: Vec2; radius: number; residual: number } | null {
  const n = pts.length;
  if (n < 3) return null;

  // Centre the data first: without it the normal equations are badly conditioned for any
  // shape far from the origin, which after tracing an image is every shape.
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= n; my /= n;

  let sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (const p of pts) {
    const x = p[0] - mx, y = p[1] - my;
    const z = x * x + y * y;
    sxx += x * x; syy += y * y; sxy += x * y;
    sxz += x * z; syz += y * z;
  }

  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-12) return null; // the points are collinear

  const cx = (sxz * syy - syz * sxy) / (2 * det);
  const cy = (syz * sxx - sxz * sxy) / (2 * det);

  let rSum = 0;
  for (const p of pts) rSum += Math.hypot(p[0] - mx - cx, p[1] - my - cy);
  const radius = rSum / n;

  let residual = 0;
  for (const p of pts) {
    residual = Math.max(residual, Math.abs(Math.hypot(p[0] - mx - cx, p[1] - my - cy) - radius));
  }

  return { centre: [cx + mx, cy + my], radius, residual };
}

/** Largest perpendicular deviation of a run of points from the chord through its ends. */
function lineResidual(pts: Vec2[]): number {
  if (pts.length < 3) return 0;
  let worst = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) worst = Math.max(worst, perpendicularDistance(pts[i], a, b));
  return worst;
}

/**
 * Segments a loop into straight lines and circular arcs.
 *
 * Greedy longest-run: from each starting point, extend as far as a line still fits, then try
 * to extend an arc further. Preferring the longer of the two matters — a gentle arc also
 * passes a loose line test over a short run, and accepting that would fragment one R50 arc
 * into a dozen tiny facets, which is exactly the outcome this exists to prevent.
 */
export function fitSegments(loop: Vec2[], tol: number): FittedSegment[] {
  const n = loop.length;
  if (n < 3) return [{ kind: 'polyline', points: [...loop] }];

  const out: FittedSegment[] = [];
  let i = 0;

  while (i < n) {
    // How far can a straight line run from here?
    let lineEnd = i + 1;
    while (lineEnd < n) {
      const run = loop.slice(i, lineEnd + 2);
      if (run.length > n) break;
      if (lineResidual(run) > tol) break;
      lineEnd++;
    }
    const lineLen = lineEnd - i;

    // And an arc? Arcs need at least five points to be distinguishable from a line.
    let arcEnd = i + 4;
    let bestArc: ReturnType<typeof fitCircle> = null;
    while (arcEnd < n) {
      const run = loop.slice(i, arcEnd + 2);
      if (run.length > n) break;
      const c = fitCircle(run);
      if (!c || c.residual > tol) break;
      // A near-infinite radius is a straight line wearing a disguise.
      if (c.radius > 1e5) break;
      bestArc = c;
      arcEnd++;
    }
    const arcLen = bestArc ? arcEnd - i : 0;

    if (bestArc && arcLen > lineLen && arcLen >= 4) {
      const run = loop.slice(i, Math.min(n, arcEnd + 1));
      const start = run[0], end = run[run.length - 1];
      out.push({
        kind: 'arc',
        centre: bestArc.centre,
        radiusMm: bestArc.radius,
        startAngle: Math.atan2(start[1] - bestArc.centre[1], start[0] - bestArc.centre[0]),
        endAngle: Math.atan2(end[1] - bestArc.centre[1], end[0] - bestArc.centre[0]),
        residualMm: bestArc.residual,
      });
      i = arcEnd;
      continue;
    }

    if (lineLen >= 1) {
      const a = loop[i], b = loop[Math.min(n - 1, lineEnd)];
      out.push({
        kind: 'line',
        start: a, end: b,
        lengthMm: Math.hypot(b[0] - a[0], b[1] - a[1]),
        residualMm: lineResidual(loop.slice(i, lineEnd + 1)),
      });
      i = lineEnd;
      continue;
    }

    i++;
  }

  return out;
}

// ── symmetry detection ───────────────────────────────────────────────────────

/**
 * Decides whether the shape should be extruded or revolved.
 *
 * A silhouette that is mirror-symmetric about a vertical line is very often the section of a
 * turned part — a bottle, a vase, a shaft — and revolving it gives the object the user
 * photographed rather than a flat plate of its outline. The confidence is reported so the UI
 * can offer the alternative rather than committing silently.
 */
export function detectSymmetry(loop: Vec2[]): BuildSuggestion {
  if (loop.length < 8) {
    return { operation: 'extrude', confidence: 0.5, reason: 'Too few points to judge symmetry.' };
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of loop) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  const width = maxX - minX, height = maxY - minY;
  if (width < 1e-9 || height < 1e-9) {
    return { operation: 'extrude', confidence: 0.5, reason: 'The outline has no area in one direction.' };
  }

  // Mirror every point about the vertical centreline and measure how far it is from the
  // nearest real point. A symmetric silhouette maps onto itself.
  const axisX = (minX + maxX) / 2;
  let worst = 0, total = 0;

  for (const p of loop) {
    const mirrored: Vec2 = [2 * axisX - p[0], p[1]];
    let nearest = Infinity;
    for (const q of loop) {
      const d = (q[0] - mirrored[0]) ** 2 + (q[1] - mirrored[1]) ** 2;
      if (d < nearest) nearest = d;
    }
    const d = Math.sqrt(nearest);
    worst = Math.max(worst, d);
    total += d;
  }

  const meanError = total / loop.length;
  const relative = meanError / Math.max(width, height);

  if (relative < 0.02) {
    return {
      operation: 'revolve',
      axis: { origin: [axisX, minY], direction: [0, 1] },
      confidence: Math.min(0.95, 1 - relative * 20),
      reason:
        `The outline is symmetric about its vertical centreline to within ` +
        `${meanError.toFixed(2)} mm, which usually means a turned part. ` +
        `Revolving half the outline reproduces the object; extruding it would give a flat plate.`,
    };
  }

  return {
    operation: 'extrude',
    confidence: Math.min(0.9, 0.5 + relative * 5),
    reason:
      `The outline is not symmetric (mirror error ${meanError.toFixed(2)} mm), ` +
      `so it is treated as a flat profile to extrude.`,
  };
}

// ── the pipeline ─────────────────────────────────────────────────────────────

export function traceImage(img: RasterImage, opts: TraceOptions): TracedShape | { error: string } {
  const warnings: string[] = [];

  if (!(opts.mmPerPixel > 0) || !Number.isFinite(opts.mmPerPixel)) {
    return {
      error:
        'A scale is required: an image records no physical size, so pixels cannot be turned ' +
        'into millimetres without one. Give the width of a known feature, or the overall ' +
        'width of the part.',
    };
  }
  if (img.width < 8 || img.height < 8) {
    return { error: `The image is only ${img.width} x ${img.height} pixels, which is too small to trace.` };
  }

  const gray = luminance(img);
  const thresholdAuto = opts.threshold === undefined;
  const threshold = opts.threshold ?? otsuThreshold(gray);

  const mask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const dark = gray[i] <= threshold;
    mask[i] = (opts.invert ? !dark : dark) ? 1 : 0;
  }

  let filled = 0;
  for (const v of mask) filled += v;
  const coverage = filled / mask.length;

  if (coverage < 0.001) {
    return {
      error:
        'Almost nothing was selected as material. The image may be mostly background, or the ' +
        'shape may be lighter than its surroundings — try the inverted option.',
    };
  }
  if (coverage > 0.98) {
    return {
      error:
        'Almost the whole image was selected as material, so there is no outline to trace. ' +
        'Try the inverted option, or crop to the part.',
    };
  }
  if (coverage > 0.75) {
    warnings.push(
      `${(coverage * 100).toFixed(0)}% of the image was read as material. If the result looks ` +
      `like the background rather than the part, use the inverted option.`,
    );
  }

  const minArea = opts.minAreaPx ?? Math.max(16, (img.width * img.height) / 4000);
  const contours = traceContours(mask, img.width, img.height, minArea);

  if (contours.length === 0) {
    return { error: 'No closed outline was found. The shape may be cut off at the edge of the image.' };
  }

  // The largest solid contour is the part; solid contours nested inside holes are ignored
  // rather than merged, because an island inside a hole is a separate body.
  const solids = contours.filter((c) => c.depth % 2 === 0);
  if (solids.length === 0) {
    return { error: 'Only hole outlines were found, with no enclosing shape.' };
  }
  solids.sort((a, b) => Math.abs(b.signedArea) - Math.abs(a.signedArea));
  const outerContour = solids[0];

  if (solids.length > 1) {
    warnings.push(
      `${solids.length} separate shapes were found; the largest was used. ` +
      `Crop to a single part to trace one of the others.`,
    );
  }

  const holeContours = contours.filter((c) => c.depth === 1 && contains(outerContour.points, c.points[0]));

  // Convert to millimetres, flipping Y so the profile is right-handed rather than
  // screen-handed. Without the flip every traced part comes out mirrored.
  const s = opts.mmPerPixel;
  const toMm = (pts: Vec2[]): Vec2[] => pts.map(([x, y]) => [x * s, (img.height - y) * s] as Vec2);

  const rawOuter = toMm(outerContour.points);
  const rawHoles = holeContours.map((c) => toMm(c.points));

  const simplifyTol = opts.simplifyMm ?? Math.max(s * 1.2, 0.15);

  // Boundary tracing walks pixel *centres*, but a pixel is a square with area: material
  // extends half a pixel beyond the centre of the outermost pixel in every direction. Left
  // uncorrected, a shape 40 pixels across measures 39 — a 2.5% error that scales with
  // resolution and would quietly undersize every traced part.
  //
  // So the outer loop grows by half a pixel and holes shrink by the same, both of which
  // grow the material to its true extent.
  const halfPx = s / 2;
  const outer = offsetPolygon(simplifyLoop(rawOuter, simplifyTol), halfPx);
  const holes = rawHoles
    .map((h) => offsetPolygon(simplifyLoop(h, simplifyTol), -halfPx))
    .filter((h) => h.length >= 3);

  const pointsBefore = rawOuter.length + rawHoles.reduce((n, h) => n + h.length, 0);
  const pointsAfter = outer.length + holes.reduce((n, h) => n + h.length, 0);

  const fitTol = opts.fitToleranceMm ?? Math.max(s * 2, 0.25);
  const segments = fitSegments(outer, fitTol);

  const lines = segments.filter((x) => x.kind === 'line').length;
  const arcs = segments.filter((x) => x.kind === 'arc').length;
  const freeform = segments
    .filter((x) => x.kind === 'polyline')
    .reduce((n, x) => n + (x.kind === 'polyline' ? x.points.length : 0), 0);

  if (arcs === 0 && lines === 0) {
    warnings.push('No straight lines or arcs were recognised; the outline was kept as a freeform curve.');
  }

  const suggestion = detectSymmetry(outer);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of outer) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }

  return {
    profile: makeProfile(outer, holes),
    segments,
    suggestion,
    report: {
      thresholdUsed: threshold,
      thresholdAuto,
      contoursFound: contours.length,
      contoursKept: 1 + holes.length,
      holesFound: holes.length,
      pointsBeforeSimplify: pointsBefore,
      pointsAfterSimplify: pointsAfter,
      linesRecognised: lines,
      arcsRecognised: arcs,
      freeformPoints: freeform,
      widthMm: maxX - minX,
      heightMm: maxY - minY,
      warnings,
    },
  };
}

/**
 * Derives the scale from a known dimension.
 *
 * Asking the user for "millimetres per pixel" is asking them to do arithmetic about a number
 * they do not have. Asking "how wide is this part?" is a question they can answer, so this
 * converts one into the other.
 */
export function scaleFromKnownWidth(img: RasterImage, knownWidthMm: number, threshold?: number): number | null {
  if (!(knownWidthMm > 0)) return null;

  const gray = luminance(img);
  const t = threshold ?? otsuThreshold(gray);

  let minX = img.width, maxX = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (gray[y * img.width + x] > t) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }

  const widthPx = maxX - minX + 1;
  return widthPx > 0 ? knownWidthMm / widthPx : null;
}

/** A one-line summary of what the trace did, for showing above the result. */
export function describeTrace(r: TraceReport): string {
  const parts = [
    `${r.widthMm.toFixed(1)} x ${r.heightMm.toFixed(1)} mm`,
    `${r.pointsBeforeSimplify} traced points reduced to ${r.pointsAfterSimplify}`,
  ];
  if (r.linesRecognised > 0) parts.push(`${r.linesRecognised} straight edge${r.linesRecognised === 1 ? '' : 's'}`);
  if (r.arcsRecognised > 0) parts.push(`${r.arcsRecognised} arc${r.arcsRecognised === 1 ? '' : 's'}`);
  if (r.holesFound > 0) parts.push(`${r.holesFound} hole${r.holesFound === 1 ? '' : 's'}`);
  return parts.join(', ') + '.';
}

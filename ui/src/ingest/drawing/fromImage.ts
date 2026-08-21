/**
 * A scanned or photographed engineering drawing, reconstructed as a solid.
 *
 * ── What was missing ──
 *
 * The reconstruction itself was already here and already good: `reconstruct.ts` clusters loose
 * geometry into view panels, works out which panel is the front, the top and the right by how
 * they line up and what dimensions they share, and intersects the three extrusions to recover
 * the solid. It has only ever been reachable from a DXF.
 *
 * A *picture* of the same drawing — a scan, a photograph, a PNG off a supplier's website, which
 * is how most drawings actually arrive — had no way in. It went to the photograph tracer, which
 * exists to answer "what one part is this a picture of", and duly answered: one outline
 * enclosing all four views and the title block, extruded. A flat slab in the shape of the sheet.
 *
 * This is the bridge, and it is deliberately thin. It traces the line work into loops and hands
 * them to the reconstructor. Everything that decides what a view *is* stays in one place, where
 * it is already tested, rather than being written a second time for raster input and drifting.
 *
 * ── Why the visual hull is the right method ──
 *
 * Three orthographic views of a part each say "the material lies within this outline, seen along
 * this axis". Extruding each outline along its own axis and intersecting the three gives the
 * largest solid consistent with all three — the visual hull. For a prismatic part it is not an
 * approximation, it is the part: a stepped block, an L-bracket, a plate with a boss all come
 * back exactly.
 *
 * It is also honest about what it cannot see. A blind pocket that never breaks a silhouette
 * leaves the hull unchanged, and so does anything hidden behind a hidden-detail line the tracer
 * read as an outline. `reconstruct.ts` reports both as caveats, and they travel with the result.
 */

import { traceLoops, type RasterImage, type TraceOptions } from '../image/trace';
import { dropHiddenDetail } from './hidden';
import {
  assignRoles, clusterViews, describeReconstruction, reconstruct,
  type ReconstructionResult, type ReconstructOptions,
} from './reconstruct';

export interface DrawingFromImageOptions extends ReconstructOptions {
  /**
   * Millimetres per pixel.
   *
   * A picture carries no scale, so this is an input and never a guess. The caller states what it
   * assumed and says so; inventing one here would produce a part that is confidently the wrong
   * size, which on a drawing is worse than on a photograph — a drawing looks like it came with
   * dimensions.
   */
  mmPerPixel: number;
  /** Passed through to the tracer, for a scan that needs a different threshold. */
  trace?: Partial<TraceOptions>;
}

export interface DrawingFromImageResult {
  result: ReconstructionResult;
  /**
   * True when the sheet held one view and the result is a plate of assumed thickness.
   *
   * A flat part is drawn in one view because one view is all it needs, and refusing it would
   * refuse the commonest drawing there is. But a plate whose thickness came from a default is a
   * different kind of answer from a solid three views agreed on, and a caller that cannot tell
   * them apart will present a guess as a measurement.
   */
  singleView: boolean;
  /** How many closed loops the line work gave, after hidden detail was set aside. */
  loops: number;
  /** Dashes recognised as hidden-detail lines and excluded, and how many runs they formed. */
  hidden: { loops: number; runs: number };
  /** What each view was taken to be, for showing next to the model. */
  views: { role: string; confidence: number; reason: string }[];
  message: string;
}

/**
 * Reads a raster drawing into a solid.
 *
 * Returns an error rather than a result when the sheet cannot be read as views — which is the
 * common case for a sheet that is not a multi-view drawing at all, and the right answer for it.
 *
 * One view is accepted and flagged, not refused. A flat part is drawn in one view because one
 * view is all it needs, and a gate demanding two refuses the commonest drawing there is. What
 * comes back is a plate at an assumed thickness, and `singleView` is how a caller knows to say
 * so — the thickness is a default, not something the drawing stated.
 */
export function reconstructFromImage(
  image: RasterImage, options: DrawingFromImageOptions,
): DrawingFromImageResult | { error: string } {
  const traced = traceLoops(image, { mmPerPixel: options.mmPerPixel, ...options.trace });
  if ('error' in traced) return traced;

  /*
   * Clustered by the gaps between them, which is how a draughtsman separates views and how a
   * reader tells them apart. Nothing here looks for a border, a title block or a scale note:
   * those vary by house standard, by country and by decade, and a rule that depends on them
   * fails on the next sheet.
   */
  /*
   * Hidden-detail lines out first, before anything is clustered.
   *
   * A tracer finds each dash as its own closed contour, and every one of them is material as far
   * as the hull is concerned — so a bore drawn as two hidden lines comes back as two rows of
   * little solid blocks inside the part, with the bore filled in. Removed before clustering
   * rather than after, because forty dashes strewn across a sheet also confuse the view
   * clustering itself: they bridge the gaps the clusterer separates views by.
   */
  const hidden = dropHiddenDetail(traced.loops, Math.max(traced.widthMm, traced.heightMm));
  const clusters = clusterViews(hidden.kept);
  if (clusters.length === 0) {
    return { error: 'The line work did not separate into views.' };
  }

  const views = assignRoles(clusters);

  /*
   * Two views with roles, or this is not a multi-view drawing.
   *
   * `reconstruct` will happily accept one view and give back a flat plate of assumed thickness,
   * and that is right when a caller has genuinely handed it one view. Reached from a picture it
   * is the old failure wearing a new name: any sheet at all has *something* that can be called a
   * front view, so accepting one would extrude whatever was on the paper and report it as a
   * reconstruction.
   *
   * Two views that line up is the evidence, and it is the same evidence a person uses. It is
   * also why this is tried on any sheet rather than only on one that looked like line work: the
   * proof that a drawing is a drawing is that its views agree, not how thick its lines are.
   */
  const roled = views.filter((v) => v.role !== 'unknown');
  if (roled.length === 0) {
    return { error: 'No view could be identified on this sheet.' };
  }

  const result = reconstruct(views, options);

  if (!result.valid) {
    return {
      error: result.caveats[0]
        ?? 'The views could not be reconstructed into a solid.',
    };
  }

  return {
    result,
    singleView: roled.length < 2,
    loops: hidden.kept.length,
    hidden: { loops: hidden.dropped.length, runs: hidden.runs },
    views: views.map((v) => ({ role: v.role, confidence: v.confidence, reason: v.reason })),
    message: describeReconstruction(result),
  };
}

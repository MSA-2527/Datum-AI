/**
 * The move-and-turn gizmo.
 *
 * Three arrows and three arcs at the selected part's origin: drag an arrow to slide it along
 * one axis, drag an arc to turn it about one. It is the control every CAD package puts on a
 * selected body, and the reason it is a gizmo rather than six number fields is that placing a
 * part is a spatial judgement — you know where it should go by looking at it, not by knowing
 * the coordinate.
 *
 * ── Why the maths lives here ──
 *
 * Everything that goes wrong with a gizmo is arithmetic done in the wrong space. A drag along
 * an axis that is nearly edge-on to the camera divides by something close to zero and throws the
 * part to the horizon. A rotation read off vertical pointer travel turns the wrong way as soon
 * as the model is orbited past ninety degrees. Neither shows up in a screenshot and both are
 * infuriating to use, so both are computed here, in functions with no DOM and no WebGL, and
 * checked against answers known in advance.
 *
 * ── The convention ──
 *
 * Screen positions are fractions of the viewport with the origin at the top left, matching
 * pointer events and `projectPoint`. Pointer deltas arrive in pixels, because that is what a
 * pointer reports. Everything returned is in millimetres or degrees, because that is what a
 * document stores.
 */

import { add3, dot3, mul3, type Vec3 } from '../kernel/math/vec';
import { basis, type CameraState } from './camera';
import { projectPoint } from './overlay';

export type GizmoAxis = 'x' | 'y' | 'z';
export type GizmoMode = 'move' | 'turn';

export interface GizmoHandle {
  axis: GizmoAxis;
  mode: GizmoMode;
  /** Where the handle is drawn, as a fraction of the viewport. */
  at: { x: number; y: number };
  /** The gizmo's centre, for drawing the shaft back to it. */
  from: { x: number; y: number };
  /**
   * How much of the axis lies across the screen: 1 fully across, 0 pointing at the viewer.
   *
   * A handle below `MIN_SCREEN_SPAN` is unusable rather than merely awkward — a pixel of
   * pointer travel would mean metres of part travel — so it is reported and the caller draws
   * it faded and refuses the drag.
   */
  span: number;
  usable: boolean;
}

/**
 * How far an axis has to lie across the screen before dragging it means anything.
 *
 * Below this the projected arrow is a few pixels long, so the conversion from pointer travel to
 * millimetres divides by nearly nothing: one pixel of jitter sends the part to the horizon. The
 * fix is not a bigger clamp on the result, it is refusing the gesture — the user cannot see
 * which way that axis goes either, which is why they orbit before they drag.
 */
export const MIN_SCREEN_SPAN = 0.12;

/** How far from the origin the handles sit, as a fraction of the viewport height. */
const HANDLE_REACH = 0.11;
const ARC_REACH = 0.155;

/**
 * Where the handles are, for a gizmo centred on `origin`.
 *
 * Sized in screen fractions rather than millimetres so the gizmo stays the same size at every
 * zoom, which is what makes it grabbable on a watch pinion and on a chassis rail alike.
 */
export function gizmoHandles(
  camera: CameraState, origin: Vec3, aspect: number,
): GizmoHandle[] {
  const centre = projectPoint(camera, origin, aspect);
  if (!centre) return [];

  const { right, up } = basis(camera);
  const axes: { axis: GizmoAxis; dir: Vec3 }[] = [
    { axis: 'x', dir: [1, 0, 0] },
    { axis: 'y', dir: [0, 1, 0] },
    { axis: 'z', dir: [0, 0, 1] },
  ];

  const out: GizmoHandle[] = [];

  for (const { axis, dir } of axes) {
    /*
     * The axis as it appears on screen, from the camera's own basis.
     *
     * Taken from the basis rather than by projecting a second point, because a second point
     * projected through a perspective camera picks up the foreshortening of wherever it happens
     * to land, and the direction of an axis is not supposed to depend on how far along it you
     * sampled.
     */
    const sx = dot3(dir, right);
    const sy = -dot3(dir, up);          // screen y counts downward
    const span = Math.hypot(sx, sy);

    // Aspect enters because x fractions span a wider distance than y fractions do.
    const reach = (ux: number, uy: number, r: number) => ({
      x: centre.x + (ux * r) / aspect,
      y: centre.y + uy * r,
    });

    /*
     * A turn handle sits *around* the axis, not along it.
     *
     * Placing it along the axis like the arrow puts it exactly on the gizmo centre whenever the
     * axis points at the viewer — which is the one orientation where turning about that axis is
     * easiest and reads most clearly. A drag that starts on the centre sweeps no angle at all,
     * so the best handle on the gizmo was the one that could not be used.
     *
     * Perpendicular to the projected axis instead, which is where its arc actually runs. When
     * the axis is too nearly end-on for that perpendicular to mean anything, the arc is a full
     * circle about the centre and any direction will do — so each axis takes its own, and the
     * three never stack.
     *
     * The threshold is the same `MIN_SCREEN_SPAN` used to decide an axis is pointing at the
     * viewer, not a token epsilon. A near-zero projection still has a direction, and it is the
     * direction of the rounding error: at 0.002 of a span the "perpendicular" for Z landed
     * exactly on Y's, and two handles at one point is one handle nobody can reach.
     */
    const spread = { x: 0, y: (2 * Math.PI) / 3, z: (4 * Math.PI) / 3 }[axis];
    const [tx, ty] = span >= MIN_SCREEN_SPAN
      ? [-sy / span, sx / span]
      : [Math.cos(spread), Math.sin(spread)];

    for (const [mode, r] of [['move', HANDLE_REACH], ['turn', ARC_REACH]] as const) {
      out.push({
        axis,
        mode,
        at: mode === 'move' ? reach(sx, sy, r) : reach(tx, ty, r),
        from: { x: centre.x, y: centre.y },
        span,
        // A turn handle is the opposite way round: an axis pointing *at* the viewer is the
        // easiest one to turn about, because its arc faces you.
        usable: mode === 'move' ? span >= MIN_SCREEN_SPAN : span <= 1 - MIN_SCREEN_SPAN * 0.5,
      });
    }
  }

  return out;
}

/**
 * Millimetres to slide along an axis, for a pointer that moved `dxPx, dyPx`.
 *
 * The pointer's travel projected onto the axis as it appears on screen, then converted through
 * the zoom. Projected rather than taken raw so that dragging *across* the arrow slides nothing
 * and dragging *along* it slides the full amount, which is what makes the handle feel attached
 * to the axis rather than to the mouse.
 */
export function dragAlongAxis(
  camera: CameraState, axis: GizmoAxis, dxPx: number, dyPx: number, viewportHeightPx: number,
): number {
  const { right, up } = basis(camera);
  const dir: Vec3 = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];

  const sx = dot3(dir, right);
  const sy = -dot3(dir, up);
  const span = Math.hypot(sx, sy);

  // Edge-on: refuse rather than divide by nearly nothing and fling the part out of the scene.
  if (span < MIN_SCREEN_SPAN) return 0;

  const alongPx = (dxPx * sx + dyPx * sy) / span;
  const mmPerPx = camera.fovMm / Math.max(1, viewportHeightPx);

  // Divided by the span a second time: an axis half turned away covers half the screen distance
  // per millimetre, so the same pointer travel has to mean twice the millimetres.
  return (alongPx * mmPerPx) / span;
}

/**
 * Degrees to turn about an axis, for a pointer that moved from one point to another.
 *
 * Measured as the angle swept about the gizmo's centre on screen, which is the gesture the arc
 * invites: you drag *around* it. Signed by which way the axis points relative to the viewer, so
 * an arc dragged clockwise turns the part clockwise as seen — including after the model has been
 * orbited to look at that axis from behind, where every naive implementation reverses.
 */
export function dragAboutAxis(
  camera: CameraState, axis: GizmoAxis, origin: Vec3, aspect: number,
  from: { x: number; y: number }, to: { x: number; y: number },
): number {
  const centre = projectPoint(camera, origin, aspect);
  if (!centre) return 0;

  // Back to square measure: an angle read off fractions of a non-square viewport is skewed.
  const at = (p: { x: number; y: number }) => ({
    x: (p.x - centre.x) * aspect,
    y: p.y - centre.y,
  });

  const a = at(from);
  const b = at(to);
  if (Math.hypot(a.x, a.y) < 1e-6 || Math.hypot(b.x, b.y) < 1e-6) return 0;

  let swept = Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x);
  while (swept > Math.PI) swept -= 2 * Math.PI;
  while (swept < -Math.PI) swept += 2 * Math.PI;

  const { forward } = basis(camera);
  const dir: Vec3 = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];

  // `forward` runs from the eye into the scene, so an axis aimed at the viewer opposes it.
  // Screen y counts downward, which flips the handedness of the swept angle once more.
  const towards = -dot3(dir, forward);
  const sign = towards >= 0 ? -1 : 1;

  return (sign * swept * 180) / Math.PI;
}

/**
 * The handle nearest a point, within a grab radius.
 *
 * Move handles win ties with turn handles at the same distance: they sit closer to the centre,
 * they are what most drags mean, and a turn started by accident is more surprising to undo than
 * a slide.
 */
export function grabHandle(
  handles: GizmoHandle[], x: number, y: number, aspect: number, radius = 0.028,
): GizmoHandle | null {
  let best: { handle: GizmoHandle; d: number } | null = null;

  for (const handle of handles) {
    if (!handle.usable) continue;

    const d = Math.hypot((handle.at.x - x) * aspect, handle.at.y - y);
    if (d > radius) continue;

    const better = !best
      || d < best.d - 1e-9
      || (Math.abs(d - best.d) <= 1e-9 && handle.mode === 'move');
    if (better) best = { handle, d };
  }

  return best?.handle ?? null;
}

/** The point a gizmo sits on: the centre of what is selected. */
export function gizmoOrigin(min: Vec3, max: Vec3): Vec3 {
  return mul3(add3(min, max), 0.5);
}

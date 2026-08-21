/**
 * The furniture a CAD viewport draws around the part.
 *
 * A grid, a scale bar, an origin triad and a view cube. None of it is the model, and all of it
 * is what makes a 3D view legible: without a grid a part floats in nothing and its size is
 * unknowable; without a scale bar a screenshot cannot be read; without a triad an orbited view
 * has no up; without a cube the user has to guess which of eight standard views they are
 * looking at.
 *
 * Every function here is pure geometry over a `CameraState`. Nothing touches WebGL, the DOM or
 * a canvas, because the parts of viewport furniture that actually go wrong are arithmetic — a
 * grid that subdivides into a moiré as you zoom out, a scale bar that says 37.4 mm, a cube face
 * that highlights the wrong side — and arithmetic can be checked.
 */

import {
  add3, cross3, dot3, mul3, norm3, sub3,
  type Vec2, type Vec3,
} from '../kernel/math/vec';
import { basis, eyeOf, mmPerPixel, type CameraState, type NamedView } from './camera';

// ── the grid ─────────────────────────────────────────────────────────────────

export interface GridSpec {
  /** Spacing of the fine lines, mm. Always 1, 2 or 5 times a power of ten. */
  spacingMm: number;
  /** Every nth line is drawn heavier. */
  majorEvery: number;
  /** Half-width of the grid, mm — it is drawn from -extent to +extent on both axes. */
  extentMm: number;
  /** Fine lines, as pairs of world-space endpoints on the Z = 0 plane. */
  minor: [Vec3, Vec3][];
  major: [Vec3, Vec3][];
  /** The two axis lines, X then Y, which are drawn in their axis colours. */
  axes: [Vec3, Vec3][];
}

/**
 * The 1-2-5 sequence, which is what a grid subdivides along.
 *
 * Not 1-2-4-8. A grid exists to be counted in, and people count in tens, halves and fifths;
 * every engineering rule, drawing scale and dial on a machine is graduated 1-2-5 for the same
 * reason. A grid on powers of two is readable by a computer and by nobody else.
 */
function niceSpacing(target: number): number {
  const decade = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, target))));
  const normalised = target / decade;

  if (normalised < 1.5) return decade;
  if (normalised < 3.5) return 2 * decade;
  if (normalised < 7.5) return 5 * decade;
  return 10 * decade;
}

/**
 * A ground grid sized to what is on screen.
 *
 * The spacing is chosen so a fine line lands roughly every `pixelsPerLine` pixels, which is the
 * property that matters: a fixed 10 mm grid is a useful backdrop on a bracket and an unreadable
 * grey wash on a chassis, and the same grid on a watch part is a single square. Recomputing it
 * from the camera means the grid always reads, at every zoom, without anyone choosing a number.
 */
export function gridFor(
  camera: CameraState, viewportHeightPx: number, pixelsPerLine = 32,
): GridSpec {
  const mmPerPx = mmPerPixel(camera, viewportHeightPx);
  const spacingMm = niceSpacing(mmPerPx * pixelsPerLine);
  const majorEvery = spacingMm.toString().startsWith('2') ? 5 : 10;

  /*
   * Big enough to fill the view, and no bigger.
   *
   * The line count is what costs, and it is bounded here rather than by the extent: a grid
   * that covers the view at every zoom would be four lines wide when zoomed in and forty
   * thousand when zoomed out. Cap the count and the far zoom simply shows a smaller carpet,
   * which is honest and cheap. Centred on the camera's target so the carpet is under whatever
   * the user is actually looking at.
   */
  const wanted = Math.ceil((camera.fovMm * 1.5) / spacingMm);
  const half = Math.min(wanted, MAX_GRID_LINES);
  const extentMm = half * spacingMm;

  const cx = Math.round(camera.target[0] / spacingMm) * spacingMm;
  const cy = Math.round(camera.target[1] / spacingMm) * spacingMm;

  const minor: [Vec3, Vec3][] = [];
  const major: [Vec3, Vec3][] = [];

  for (let i = -half; i <= half; i++) {
    const x = cx + i * spacingMm;
    const y = cy + i * spacingMm;
    const isMajor = Math.round((x / spacingMm)) % majorEvery === 0;
    const isMajorY = Math.round((y / spacingMm)) % majorEvery === 0;

    // The axes are drawn separately, in their own colours, so they are left out here.
    if (Math.abs(x) > 1e-9) {
      (isMajor ? major : minor).push([[x, cy - extentMm, 0], [x, cy + extentMm, 0]]);
    }
    if (Math.abs(y) > 1e-9) {
      (isMajorY ? major : minor).push([[cx - extentMm, y, 0], [cx + extentMm, y, 0]]);
    }
  }

  return {
    spacingMm,
    majorEvery,
    extentMm,
    minor,
    major,
    axes: [
      [[cx - extentMm, 0, 0], [cx + extentMm, 0, 0]],
      [[0, cy - extentMm, 0], [0, cy + extentMm, 0]],
    ],
  };
}

/** At most this many lines either side of centre, in each direction. */
const MAX_GRID_LINES = 120;

// ── the scale bar ────────────────────────────────────────────────────────────

export interface ScaleBar {
  /** The round length the bar represents, mm. */
  lengthMm: number;
  /** How wide to draw it, px. */
  widthPx: number;
  /** Ready to print: "50 mm", "2.5 mm", "1.2 m". */
  label: string;
}

/**
 * A bar of round length, and how many pixels it is.
 *
 * The other way round from how it is tempting to write it. Fixing the pixel width and labelling
 * whatever length that comes to gives "83.6 mm", which nobody can use; fixing a round length
 * and letting the width fall out gives a bar you can lay against the part and count. Only
 * orthographic views get one, because in perspective a bar is only true at one depth and a
 * ruler that is right in one plane and wrong everywhere else is worse than none.
 */
export function scaleBarFor(
  camera: CameraState, viewportHeightPx: number, targetPx = 120,
): ScaleBar | null {
  if (!camera.orthographic) return null;

  const mmPerPx = mmPerPixel(camera, viewportHeightPx);
  const lengthMm = niceSpacing(mmPerPx * targetPx);

  return {
    lengthMm,
    widthPx: lengthMm / mmPerPx,
    label: formatLength(lengthMm),
  };
}

function formatLength(mm: number): string {
  if (mm >= 1000) return `${trim(mm / 1000)} m`;
  if (mm >= 1) return `${trim(mm)} mm`;
  return `${trim(mm * 1000)} µm`;
}

const trim = (v: number): string => Number(v.toFixed(3)).toString();

// ── the origin triad ─────────────────────────────────────────────────────────

export interface TriadAxis {
  axis: 'X' | 'Y' | 'Z';
  /** Screen direction, unit length, with y counting downward as screen y does. */
  screen: Vec2;
  /** How much of the axis points at the camera: 1 straight at it, -1 straight away. */
  towards: number;
}

/**
 * Which way X, Y and Z lie on screen.
 *
 * Drawn as a corner gizmo. `towards` is what lets the drawing dim an axis pointing away from
 * the viewer, which is the cue that distinguishes a top view from a bottom view — without it
 * the two are the same picture and a part can be modelled upside down for an hour.
 */
export function triadFor(camera: CameraState): TriadAxis[] {
  const { right, up, forward } = basis(camera);
  const axes: { axis: 'X' | 'Y' | 'Z'; dir: Vec3 }[] = [
    { axis: 'X', dir: [1, 0, 0] },
    { axis: 'Y', dir: [0, 1, 0] },
    { axis: 'Z', dir: [0, 0, 1] },
  ];

  return axes.map(({ axis, dir }) => {
    const x = dot3(dir, right);
    // Screen y grows downward; world up grows upward.
    const y = -dot3(dir, up);
    const length = Math.hypot(x, y);

    return {
      axis,
      screen: (length > 1e-9 ? [x / length, y / length] : [0, 0]) as Vec2,
      // `forward` points from the eye into the scene, so an axis aimed at the viewer opposes it.
      towards: -dot3(dir, forward),
    };
  });
}

// ── the view cube ────────────────────────────────────────────────────────────

export interface CubeFace {
  view: NamedView;
  label: string;
  /** Outward normal in world space. */
  normal: Vec3;
  /** Centre of the face projected to the cube gizmo's own square, in [0,1]². */
  centre: Vec2;
  /** How square-on the face is: 1 facing the viewer, 0 edge-on, negative facing away. */
  facing: number;
  /** The four corners, projected, in order — for drawing the face as a quad. */
  corners: [Vec2, Vec2, Vec2, Vec2];
}

const CUBE_FACES: { view: NamedView; label: string; normal: Vec3 }[] = [
  { view: 'front', label: 'FRONT', normal: [0, -1, 0] },
  { view: 'back', label: 'BACK', normal: [0, 1, 0] },
  { view: 'right', label: 'RIGHT', normal: [1, 0, 0] },
  { view: 'left', label: 'LEFT', normal: [-1, 0, 0] },
  { view: 'top', label: 'TOP', normal: [0, 0, 1] },
  { view: 'bottom', label: 'BOT', normal: [0, 0, -1] },
];

/**
 * The view cube, projected.
 *
 * A small cube in the corner, orbiting with the camera, whose faces can be clicked to snap to a
 * standard view. It is the one piece of viewport furniture users reach for constantly, and it
 * earns that by answering two questions at once — which way am I looking, and how do I get to
 * the view I want — without a menu.
 *
 * It is drawn with the same rotation as the model but its own fixed scale, so it stays the same
 * size on screen at every zoom. Faces come back sorted back-to-front, so drawing them in order
 * gives a solid cube with no depth buffer.
 */
export function viewCubeFaces(camera: CameraState): CubeFace[] {
  const { right, up, forward } = basis(camera);

  // Into the gizmo's square: x right, y down, both in [0,1] with 0.5 at the centre.
  const project = (p: Vec3): Vec2 => [
    0.5 + dot3(p, right) * CUBE_SCALE,
    0.5 - dot3(p, up) * CUBE_SCALE,
  ];

  const faces = CUBE_FACES.map(({ view, label, normal }) => {
    // Two in-face directions, chosen from the normal so the quad is wound consistently.
    const u = norm3(cross3(normal, Math.abs(normal[2]) > 0.5 ? [0, 1, 0] : [0, 0, 1]));
    const v = cross3(normal, u);
    const c = mul3(normal, 0.5);

    const corner = (su: number, sv: number): Vec2 =>
      project(add3(c, add3(mul3(u, su * 0.5), mul3(v, sv * 0.5))));

    return {
      view,
      label,
      normal,
      centre: project(c),
      facing: -dot3(normal, forward),
      corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)] as
        [Vec2, Vec2, Vec2, Vec2],
    };
  });

  // Back to front: the face pointing most directly away is drawn first and covered.
  return faces.sort((a, b) => a.facing - b.facing);
}

/** How much of the gizmo square the cube fills. */
const CUBE_SCALE = 0.62;

/**
 * Which face was clicked, or null.
 *
 * `x` and `y` are fractions of the gizmo's square, origin top left — the same convention as
 * pointer events. Only faces turned towards the viewer can be hit: a click lands on what is
 * visible, and the far side of a solid cube is not.
 */
export function viewCubeHit(camera: CameraState, x: number, y: number): NamedView | null {
  const faces = viewCubeFaces(camera).filter((f) => f.facing > 1e-3);

  // Front to back, so an overlapping near face wins over the one behind it.
  for (const face of [...faces].reverse()) {
    if (pointInQuad([x, y], face.corners)) return face.view;
  }
  return null;
}

function pointInQuad(p: Vec2, quad: [Vec2, Vec2, Vec2, Vec2]): boolean {
  // A convex quad: the point is inside when it is on the same side of all four edges.
  let positive = false;
  let negative = false;

  for (let i = 0; i < 4; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const side = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

    if (side > 1e-9) positive = true;
    if (side < -1e-9) negative = true;
    if (positive && negative) return false;
  }
  return true;
}

// ── where a point lands on screen ────────────────────────────────────────────

/**
 * A world point as a screen fraction, or null when it is behind the camera.
 *
 * For labelling: a measurement, a face name, a dimension has to be drawn *at* something, and
 * that means knowing where the something is. Returned as fractions of the viewport rather than
 * pixels so the caller can scale them to a canvas or to a CSS overlay without either of them
 * having to know the other's size.
 */
export function projectPoint(
  camera: CameraState, p: Vec3, aspect: number,
): { x: number; y: number; depth: number } | null {
  const { right, up, forward } = basis(camera);
  const eye = eyeOf(camera);
  const rel = sub3(p, eye);
  const depth = dot3(rel, forward);

  if (camera.orthographic) {
    const halfH = camera.fovMm / 2;
    return {
      x: 0.5 + dot3(rel, right) / (halfH * aspect * 2),
      y: 0.5 - dot3(rel, up) / (halfH * 2),
      depth,
    };
  }

  // Behind the eye, or on the plane through it: there is no screen position to give.
  if (depth <= 1e-6) return null;

  const scale = camera.distance / depth;
  const halfH = camera.fovMm / 2;
  return {
    x: 0.5 + (dot3(rel, right) * scale) / (halfH * aspect * 2),
    y: 0.5 - (dot3(rel, up) * scale) / (halfH * 2),
    depth,
  };
}

/**
 * Orbit camera.
 *
 * Kept as pure maths with no WebGL and no DOM, so the parts that decide *where the camera
 * is* can be tested directly. Everything that goes wrong with a CAD camera — the model
 * vanishing off screen after a fit, orbit flipping upside down at the poles, zoom that
 * accelerates until the part is a dot — is arithmetic, not rendering.
 *
 * The convention is the one every mechanical CAD package uses: **Z is up**, and the camera
 * orbits a target point rather than flying freely. Free-flight cameras are right for games
 * and wrong here, because a designer's mental model is "the part sits on the bench and I
 * walk around it", and a camera that can lose the part violates that.
 */

import {
  cross3, dot3, len3, mul3, norm3, sub3, add3, clamp,
  type Box3, type Mat4, type Vec3,
} from '../kernel/math/vec';

export interface CameraState {
  /** Point the camera looks at, in model space. */
  target: Vec3;
  /** Distance from target to eye. */
  distance: number;
  /** Rotation about the world Z axis, radians. */
  azimuth: number;
  /** Angle above the XY plane, radians. Clamped away from the poles. */
  elevation: number;
  /** Vertical extent of the view at the target distance, in millimetres. */
  fovMm: number;
  /** True for an orthographic projection, which is what CAD uses by default. */
  orthographic: boolean;
}

/**
 * The default view.
 *
 * A trimetric-ish three-quarter view, because a part first shown face-on reads as flat and
 * a user cannot tell which way is up until they orbit it.
 */
export function defaultCamera(): CameraState {
  return {
    target: [0, 0, 0],
    distance: 400,
    azimuth: -Math.PI * 0.75,
    elevation: Math.PI * 0.18,
    fovMm: 200,
    orthographic: true,
  };
}

/** Eye position implied by the orbit parameters. */
export function eyeOf(c: CameraState): Vec3 {
  const ce = Math.cos(c.elevation);
  return add3(c.target, [
    c.distance * ce * Math.cos(c.azimuth),
    c.distance * ce * Math.sin(c.azimuth),
    c.distance * Math.sin(c.elevation),
  ]);
}

/**
 * Elevation is clamped just short of vertical.
 *
 * Looking exactly down the Z axis makes the up vector parallel to the view direction, the
 * cross product that builds the camera basis collapses, and the view snaps to a random
 * orientation. Every orbit camera has to handle this; stopping a hair short is the simplest
 * correct answer and is invisible to the user.
 */
const ELEV_LIMIT = Math.PI / 2 - 0.001;

export function orbit(c: CameraState, dAzimuth: number, dElevation: number): CameraState {
  return {
    ...c,
    azimuth: c.azimuth + dAzimuth,
    elevation: clamp(c.elevation + dElevation, -ELEV_LIMIT, ELEV_LIMIT),
  };
}

/**
 * Pans across the view plane.
 *
 * The distances are in screen fractions, scaled by the visible extent, so dragging by a
 * given number of pixels moves the model the same apparent amount whatever the zoom. Panning
 * in world units instead makes the model shoot off screen when zoomed in and barely move
 * when zoomed out.
 */
export function pan(c: CameraState, dxFraction: number, dyFraction: number, aspect: number): CameraState {
  const { right, up } = basis(c);
  const height = c.fovMm;
  const width = height * aspect;

  return {
    ...c,
    target: add3(c.target, add3(mul3(right, -dxFraction * width), mul3(up, dyFraction * height))),
  };
}

/**
 * Zooms by a multiplicative factor.
 *
 * Multiplicative rather than additive so each wheel notch changes the view by the same
 * proportion. An additive step is unusable: it crawls when zoomed out and overshoots
 * straight through the part when zoomed in.
 *
 * The bounds stop the two failure modes at the ends — zooming so far in that floating point
 * gives up, and so far out that the part is a single pixel with no way back.
 */
export function zoom(c: CameraState, factor: number): CameraState {
  return { ...c, fovMm: clamp(c.fovMm * factor, 0.01, 1e7) };
}

/**
 * Zooms toward the cursor rather than the centre.
 *
 * Wheel-zoom that ignores the pointer means a user zooming into a detail has to zoom, pan,
 * zoom, pan. Keeping the point under the cursor fixed is what every CAD package does and is
 * the difference between a viewport that feels precise and one that feels like a toy.
 */
export function zoomAt(
  c: CameraState, factor: number, cursorX: number, cursorY: number, aspect: number,
): CameraState {
  // Cursor position as a fraction from the centre, in [-0.5, 0.5].
  const fx = cursorX - 0.5;
  const fy = cursorY - 0.5;

  const before = c.fovMm;
  const zoomed = zoom(c, factor);
  const after = zoomed.fovMm;
  const delta = before - after;

  const { right, up } = basis(c);
  return {
    ...zoomed,
    target: add3(zoomed.target, add3(
      mul3(right, fx * delta * aspect),
      mul3(up, -fy * delta),
    )),
  };
}

/**
 * Frames a bounding box.
 *
 * The margin is a multiplier rather than a fixed distance so it scales with the part; 1.15
 * leaves a comfortable border without wasting the viewport. The degenerate cases matter more
 * than they look: an empty document and a perfectly flat part both produce a zero-size box,
 * and dividing by it puts the camera at infinity with nothing on screen and no way to
 * recover except reloading.
 */
export function fit(c: CameraState, box: Box3, aspect: number, margin = 1.15): CameraState {
  const valid = Number.isFinite(box.min[0]) && box.max[0] >= box.min[0];
  if (!valid) return { ...defaultCamera(), azimuth: c.azimuth, elevation: c.elevation };

  const size: Vec3 = [
    box.max[0] - box.min[0],
    box.max[1] - box.min[1],
    box.max[2] - box.min[2],
  ];
  const target: Vec3 = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];

  const diagonal = len3(size);
  // A flat or empty part still needs a usable view.
  const extent = diagonal > 1e-6 ? diagonal : 100;

  return {
    ...c,
    target,
    fovMm: (extent * margin) / Math.max(0.35, Math.min(1, aspect)),
    distance: extent * 4 + 100,
  };
}

/** Camera basis vectors: right and up on screen, and the forward view direction. */
export function basis(c: CameraState): { right: Vec3; up: Vec3; forward: Vec3 } {
  const eye = eyeOf(c);
  const forward = norm3(sub3(c.target, eye));
  const worldUp: Vec3 = [0, 0, 1];

  let right = cross3(forward, worldUp);
  if (len3(right) < 1e-6) right = [1, 0, 0]; // looking straight down; any right will do
  right = norm3(right);

  return { right, up: norm3(cross3(right, forward)), forward };
}

/** View matrix, column-major for WebGL. */
export function viewMatrix(c: CameraState): Mat4 {
  const eye = eyeOf(c);
  const { right, up, forward } = basis(c);
  const back = mul3(forward, -1);

  const m = new Float64Array(16) as Mat4;
  m[0] = right[0]; m[4] = right[1]; m[8] = right[2]; m[12] = -dot3(right, eye);
  m[1] = up[0];    m[5] = up[1];    m[9] = up[2];    m[13] = -dot3(up, eye);
  m[2] = back[0];  m[6] = back[1];  m[10] = back[2]; m[14] = -dot3(back, eye);
  m[15] = 1;
  return m;
}

/**
 * Projection matrix.
 *
 * Orthographic by default, and that is not a stylistic choice. In a perspective view two
 * equal features at different depths measure differently on screen, so a designer cannot
 * compare them by eye — which is exactly what they spend the day doing. Every mechanical CAD
 * package defaults to orthographic for this reason.
 */
export function projectionMatrix(c: CameraState, aspect: number): Mat4 {
  const m = new Float64Array(16) as Mat4;

  // Depth range spans well past the model so nothing clips as the user orbits.
  const far = c.distance * 4 + c.fovMm * 8 + 1000;
  const near = -far;

  if (c.orthographic) {
    const h = c.fovMm / 2;
    const w = h * aspect;
    m[0] = 1 / w;
    m[5] = 1 / h;
    m[10] = -2 / (far - near);
    m[14] = -(far + near) / (far - near);
    m[15] = 1;
    return m;
  }

  // Perspective, offered for presentation views.
  const fovY = 2 * Math.atan(c.fovMm / 2 / Math.max(1e-6, c.distance));
  const f = 1 / Math.tan(fovY / 2);
  const nearP = Math.max(0.01, c.distance * 0.01);
  const farP = c.distance * 100 + 1000;

  m[0] = f / aspect;
  m[5] = f;
  m[10] = (farP + nearP) / (nearP - farP);
  m[11] = -1;
  m[14] = (2 * farP * nearP) / (nearP - farP);
  return m;
}

// ── standard views ───────────────────────────────────────────────────────────

export type NamedView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' | 'dimetric';

/**
 * Named orientations.
 *
 * These match the drafting convention in `drafting/project.ts` so the front view in the
 * viewport is the front view on the drawing. A viewport and a drawing that disagree about
 * which side is the front is a genuine source of scrapped parts.
 */
export function namedView(c: CameraState, view: NamedView): CameraState {
  const set = (azimuth: number, elevation: number): CameraState => ({ ...c, azimuth, elevation });

  switch (view) {
    case 'front':  return set(-Math.PI / 2, 0);
    case 'back':   return set(Math.PI / 2, 0);
    case 'right':  return set(0, 0);
    case 'left':   return set(Math.PI, 0);
    case 'top':    return set(-Math.PI / 2, ELEV_LIMIT);
    case 'bottom': return set(-Math.PI / 2, -ELEV_LIMIT);
    case 'iso':    return set(-Math.PI * 0.75, Math.atan(Math.SQRT1_2));
    case 'dimetric': return set(-Math.PI * 0.75, Math.PI * 0.18);
  }
}

/** Which named view the camera is currently closest to, for highlighting the view cube. */
export function closestNamedView(c: CameraState, toleranceRad = 0.05): NamedView | null {
  const views: NamedView[] = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'];
  for (const v of views) {
    const t = namedView(c, v);
    const dAz = Math.abs(wrapPi(t.azimuth - c.azimuth));
    const dEl = Math.abs(t.elevation - c.elevation);
    if (dAz < toleranceRad && dEl < toleranceRad) return v;
  }
  return null;
}

const wrapPi = (a: number): number => {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
};

// ── picking ──────────────────────────────────────────────────────────────────

/**
 * A ray through a screen position, for picking.
 *
 * `x` and `y` are fractions of the viewport with the origin at the top left, matching how
 * pointer events report position.
 */
export function pickRay(
  c: CameraState, x: number, y: number, aspect: number,
): { origin: Vec3; direction: Vec3 } {
  const { right, up, forward } = basis(c);
  const eye = eyeOf(c);

  const fx = (x - 0.5) * c.fovMm * aspect;
  // Screen y counts downward, world up counts upward.
  const fy = (0.5 - y) * c.fovMm;

  if (c.orthographic) {
    // Parallel rays offset across the view plane.
    return {
      origin: add3(eye, add3(mul3(right, fx), mul3(up, fy))),
      direction: forward,
    };
  }

  const onPlane = add3(add3(c.target, mul3(right, fx)), mul3(up, fy));
  return { origin: eye, direction: norm3(sub3(onPlane, eye)) };
}

/** Millimetres per screen pixel at the target plane, for sizing hit tolerances. */
export function mmPerPixel(c: CameraState, viewportHeightPx: number): number {
  return viewportHeightPx > 0 ? c.fovMm / viewportHeightPx : 1;
}

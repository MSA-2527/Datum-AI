/**
 * Vectors, matrices and rigid transforms.
 *
 * Plain tuples rather than classes throughout. The kernel allocates millions of these
 * during tessellation and boolean work, and object headers plus megamorphic property
 * access cost more than the arithmetic does. Tuples stay in packed arrays in V8 and the
 * functions below inline cleanly.
 *
 * Units are millimetres and radians everywhere inside the kernel. Conversion happens once,
 * at the UI boundary — mixing unit systems inside a geometry engine is how parts end up
 * 25.4x too big.
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Column-major 4x4, matching WebGL and glTF so no transpose is needed on the way out. */
export type Mat4 = Float64Array;
/** Quaternion as [x, y, z, w]. */
export type Quat = [number, number, number, number];

export const EPS = 1e-9;
/** Distance below which two points are the same point, in millimetres. */
export const TOL = 1e-7;
/** Angular tolerance, radians. Roughly 0.00006 degrees. */
export const ANG_TOL = 1e-6;

// ── Vec3 ─────────────────────────────────────────────────────────────────────

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const neg3 = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];
export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const len3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const lenSq3 = (a: Vec3): number => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
export const dist3 = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const distSq3 = (a: Vec3, b: Vec3): number => {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};

export function norm3(a: Vec3): Vec3 {
  const l = len3(a);
  // A zero-length direction is a caller bug, but returning NaN propagates it silently
  // through an entire model. +X is wrong loudly, which is easier to find.
  return l < EPS ? [1, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export const eq3 = (a: Vec3, b: Vec3, tol = TOL): boolean => distSq3(a, b) <= tol * tol;

/** Scalar triple product a . (b x c) — six times the signed tetra volume. */
export const triple = (a: Vec3, b: Vec3, c: Vec3): number => dot3(a, cross3(b, c));

/**
 * Any unit vector perpendicular to `n`.
 *
 * Picking the axis least aligned with `n` before crossing avoids the near-parallel case
 * where the cross product loses all its significant digits.
 */
export function perp3(n: Vec3): Vec3 {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const axis: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  return norm3(cross3(n, axis));
}

/** Right-handed orthonormal frame with `n` as the third axis. */
export function frame(n: Vec3): { u: Vec3; v: Vec3; w: Vec3 } {
  const w = norm3(n);
  const u = perp3(w);
  return { u, v: cross3(w, u), w };
}

/** Angle between two vectors, numerically stable near 0 and pi where acos(dot) is not. */
export function angle3(a: Vec3, b: Vec3): number {
  return Math.atan2(len3(cross3(a, b)), dot3(a, b));
}

// ── Vec2 ─────────────────────────────────────────────────────────────────────

export const v2 = (x = 0, y = 0): Vec2 => [x, y];
export const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const mul2 = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot2 = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
export const cross2 = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const len2 = (a: Vec2): number => Math.hypot(a[0], a[1]);
export const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const perp2 = (a: Vec2): Vec2 => [-a[1], a[0]];
export const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export function norm2(a: Vec2): Vec2 {
  const l = len2(a);
  return l < EPS ? [1, 0] : [a[0] / l, a[1] / l];
}

export function rot2(a: Vec2, rad: number): Vec2 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
}

// ── Mat4 ─────────────────────────────────────────────────────────────────────

export function mat4(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function matClone(m: Mat4): Mat4 {
  return new Float64Array(m) as Mat4;
}

/** a * b, applying b first then a — the usual convention for composing transforms. */
export function matMul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16) as Mat4;
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

export function translation(t: Vec3): Mat4 {
  const m = mat4();
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
}

export function scaling(s: Vec3): Mat4 {
  const m = mat4();
  m[0] = s[0]; m[5] = s[1]; m[10] = s[2];
  return m;
}

/** Rotation of `rad` about a unit axis through the origin (Rodrigues). */
export function rotation(axis: Vec3, rad: number): Mat4 {
  const [x, y, z] = norm3(axis);
  const c = Math.cos(rad), s = Math.sin(rad), t = 1 - c;
  const m = mat4();
  m[0] = t * x * x + c;     m[1] = t * x * y + s * z; m[2] = t * x * z - s * y;
  m[4] = t * x * y - s * z; m[5] = t * y * y + c;     m[6] = t * y * z + s * x;
  m[8] = t * x * z + s * y; m[9] = t * y * z - s * x; m[10] = t * z * z + c;
  return m;
}

/** Rotation about an arbitrary axis line: translate to origin, rotate, translate back. */
export function rotationAbout(point: Vec3, axis: Vec3, rad: number): Mat4 {
  return matMul(matMul(translation(point), rotation(axis, rad)), translation(neg3(point)));
}

/** Basis matrix mapping local (u, v, w) coordinates at `origin` into world space. */
export function basisMatrix(origin: Vec3, u: Vec3, v: Vec3, w: Vec3): Mat4 {
  const m = mat4();
  m[0] = u[0]; m[1] = u[1]; m[2] = u[2];
  m[4] = v[0]; m[5] = v[1]; m[6] = v[2];
  m[8] = w[0]; m[9] = w[1]; m[10] = w[2];
  m[12] = origin[0]; m[13] = origin[1]; m[14] = origin[2];
  return m;
}

/** Reflection in the plane through `point` with unit normal `n` (Householder). */
export function reflection(point: Vec3, n: Vec3): Mat4 {
  const [a, b, c] = norm3(n);
  const d = -(a * point[0] + b * point[1] + c * point[2]);
  const m = mat4();
  m[0] = 1 - 2 * a * a; m[1] = -2 * a * b;    m[2] = -2 * a * c;
  m[4] = -2 * a * b;    m[5] = 1 - 2 * b * b; m[6] = -2 * b * c;
  m[8] = -2 * a * c;    m[9] = -2 * b * c;    m[10] = 1 - 2 * c * c;
  m[12] = -2 * a * d;   m[13] = -2 * b * d;   m[14] = -2 * c * d;
  return m;
}

/** Transforms a point (w = 1), applying translation. */
export function xformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Transforms a direction (w = 0), ignoring translation. */
export function xformDir(m: Mat4, d: Vec3): Vec3 {
  return [
    m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
    m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
    m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
  ];
}

/**
 * Transforms a normal.
 *
 * Normals transform by the inverse transpose, not by the matrix itself. Under a non-uniform
 * scale — which every "make this 2x wider" edit produces — using the matrix directly leaves
 * normals no longer perpendicular to their surface, and the shading and any offset built
 * from them are wrong.
 */
export function xformNormal(m: Mat4, n: Vec3): Vec3 {
  const inv = matInvert(m);
  if (!inv) return norm3(xformDir(m, n));
  return norm3([
    inv[0] * n[0] + inv[1] * n[1] + inv[2] * n[2],
    inv[4] * n[0] + inv[5] * n[1] + inv[6] * n[2],
    inv[8] * n[0] + inv[9] * n[1] + inv[10] * n[2],
  ]);
}

export function matDet(m: Mat4): number {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;

  return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
}

/** Full 4x4 inverse, or null when singular. */
export function matInvert(m: Mat4): Mat4 | null {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-300) return null;
  const d = 1 / det;

  const o = new Float64Array(16) as Mat4;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return o;
}

/** True when the transform flips handedness, which means triangle winding must be reversed. */
export const flipsOrientation = (m: Mat4): boolean => matDet(m) < 0;

// ── Quaternions ──────────────────────────────────────────────────────────────

export const quatIdentity = (): Quat => [0, 0, 0, 1];

export function quatFromAxisAngle(axis: Vec3, rad: number): Quat {
  const [x, y, z] = norm3(axis);
  const h = rad / 2, s = Math.sin(h);
  return [x * s, y * s, z * s, Math.cos(h)];
}

export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function quatToMat4(q: Quat): Mat4 {
  const [x, y, z, w] = q;
  const m = mat4();
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w);     m[2] = 2 * (x * z - y * w);
  m[4] = 2 * (x * y - z * w);     m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w);
  m[8] = 2 * (x * z + y * w);     m[9] = 2 * (y * z - x * w);     m[10] = 1 - 2 * (x * x + y * y);
  return m;
}

/** Shortest-arc rotation taking unit vector `from` to unit vector `to`. */
export function quatBetween(from: Vec3, to: Vec3): Quat {
  const a = norm3(from), b = norm3(to);
  const d = dot3(a, b);
  // Antiparallel: the rotation axis is undefined, so any perpendicular will do.
  if (d < -1 + 1e-9) return quatFromAxisAngle(perp3(a), Math.PI);
  const c = cross3(a, b);
  const q: Quat = [c[0], c[1], c[2], 1 + d];
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

// ── axis-aligned bounding box ────────────────────────────────────────────────

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

export const emptyBox = (): Box3 => ({
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
});

export function expandBox(b: Box3, p: Vec3): void {
  if (p[0] < b.min[0]) b.min[0] = p[0];
  if (p[1] < b.min[1]) b.min[1] = p[1];
  if (p[2] < b.min[2]) b.min[2] = p[2];
  if (p[0] > b.max[0]) b.max[0] = p[0];
  if (p[1] > b.max[1]) b.max[1] = p[1];
  if (p[2] > b.max[2]) b.max[2] = p[2];
}

export const boxSize = (b: Box3): Vec3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
export const boxCentre = (b: Box3): Vec3 => [
  (b.min[0] + b.max[0]) / 2,
  (b.min[1] + b.max[1]) / 2,
  (b.min[2] + b.max[2]) / 2,
];
export const boxValid = (b: Box3): boolean => b.min[0] <= b.max[0];
export const boxDiagonal = (b: Box3): number => (boxValid(b) ? len3(boxSize(b)) : 0);

export function boxOverlaps(a: Box3, b: Box3, tol = 0): boolean {
  return (
    a.min[0] <= b.max[0] + tol && a.max[0] >= b.min[0] - tol &&
    a.min[1] <= b.max[1] + tol && a.max[1] >= b.min[1] - tol &&
    a.min[2] <= b.max[2] + tol && a.max[2] >= b.min[2] - tol
  );
}

export function boxContains(b: Box3, p: Vec3, tol = 0): boolean {
  return (
    p[0] >= b.min[0] - tol && p[0] <= b.max[0] + tol &&
    p[1] >= b.min[1] - tol && p[1] <= b.max[1] + tol &&
    p[2] >= b.min[2] - tol && p[2] <= b.max[2] + tol
  );
}

export function boxUnion(a: Box3, b: Box3): Box3 {
  if (!boxValid(a)) return { min: [...b.min] as Vec3, max: [...b.max] as Vec3 };
  if (!boxValid(b)) return { min: [...a.min] as Vec3, max: [...a.max] as Vec3 };
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/** Transformed AABB. Transforms all eight corners — rotating the min/max pair alone is wrong. */
export function boxTransform(b: Box3, m: Mat4): Box3 {
  const out = emptyBox();
  if (!boxValid(b)) return out;
  for (let i = 0; i < 8; i++) {
    expandBox(out, xformPoint(m, [
      i & 1 ? b.max[0] : b.min[0],
      i & 2 ? b.max[1] : b.min[1],
      i & 4 ? b.max[2] : b.min[2],
    ]));
  }
  return out;
}

// ── misc ─────────────────────────────────────────────────────────────────────

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (d: number): number => (d * Math.PI) / 180;

/** Rounds to a decimal precision. Used only for display and hashing, never inside geometry. */
export const round = (x: number, dp = 6): number => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

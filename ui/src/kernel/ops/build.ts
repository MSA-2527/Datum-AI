/**
 * Solid construction: extrude, revolve, sweep and loft.
 *
 * These four cover essentially all of mechanical modelling. A boss is an extrude, a shaft
 * or a cup body is a revolve, a handle or a pipe run is a sweep, and a transition duct or
 * a turbine blade is a loft. Everything else is these plus booleans.
 *
 * Each one produces a closed solid directly — caps included, winding consistent — rather
 * than a surface that something else has to knit. Building closed from the start means the
 * validity check after each feature is meaningful: if it fails, the feature that broke it
 * is the one just applied, and the user can be told exactly that.
 */

import {
  ANG_TOL, add3, cross3, dot3, len3, mul3, norm3, perp3, rotationAbout,
  sub3, xformPoint, type Vec2, type Vec3,
} from '../math/vec';
import {
  MeshBuilder, compact, orientOutward, type FaceTag, type Mesh,
} from '../topo/mesh';
import {
  arcSegments, liftToPlane, offsetProfile, profileArea, triangulate, type Profile,
} from '../sketch/profile';
import { curvePoint, curveTangent, tessellateCurve, type NurbsCurve } from '../math/nurbs';

// ── plane definition ─────────────────────────────────────────────────────────

export interface Plane {
  origin: Vec3;
  /** In-plane axes; must be orthonormal and right-handed with `normal`. */
  u: Vec3;
  v: Vec3;
  normal: Vec3;
}

export function planeFrom(origin: Vec3, normal: Vec3, uHint?: Vec3): Plane {
  const n = norm3(normal);
  let u = uHint ? norm3(sub3(uHint, mul3(n, dot3(uHint, n)))) : perp3(n);
  if (len3(u) < 1e-9) u = perp3(n);
  return { origin, u, v: cross3(n, u), normal: n };
}

export const XY: Plane = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] };
export const XZ: Plane = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] };
export const YZ: Plane = { origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] };

const lift = (p: Vec2, pl: Plane): Vec3 => liftToPlane(p, pl.origin, pl.u, pl.v);

// ── extrude ──────────────────────────────────────────────────────────────────

export interface ExtrudeOptions {
  distance: number;
  /** Extrude both ways from the sketch plane, `distance` in total. */
  midplane?: boolean;
  /** Second distance, opposite the normal. Ignored when `midplane` is set. */
  distanceBack?: number;
  /** Draft angle in degrees, positive widening away from the sketch plane. */
  draftDeg?: number;
  /** Reverses the extrude direction. */
  reverse?: boolean;
  feature?: string;
}

/**
 * Extrudes a profile along its plane normal.
 *
 * Draft is applied by offsetting the far profile rather than by tilting the walls, because
 * offsetting keeps the top face planar and the correct size. Tilting each wall independently
 * leaves the corners not meeting, which is the classic way drafted bosses end up with
 * slivers along every vertical edge.
 */
export function extrude(profile: Profile, plane: Plane, opts: ExtrudeOptions): Mesh {
  const feature = opts.feature ?? 'Extrude';
  const dir = opts.reverse ? mul3(plane.normal, -1) : plane.normal;

  const front = opts.midplane ? opts.distance / 2 : opts.distance;
  const backDist = opts.midplane ? opts.distance / 2 : (opts.distanceBack ?? 0);

  const draft = opts.draftDeg ?? 0;
  // Positive draft widens with distance from the sketch plane.
  const frontOffset = Math.abs(front) * Math.tan((draft * Math.PI) / 180);
  const backOffset = Math.abs(backDist) * Math.tan((draft * Math.PI) / 180);

  const topProfile = Math.abs(frontOffset) > 1e-9 ? offsetProfile(profile, frontOffset) : profile;
  const botProfile = Math.abs(backOffset) > 1e-9 ? offsetProfile(profile, backOffset) : profile;

  const mb = new MeshBuilder();

  const topPlane: Plane = { ...plane, origin: add3(plane.origin, mul3(dir, front)) };
  const botPlane: Plane = { ...plane, origin: add3(plane.origin, mul3(dir, -backDist)) };

  const topId = mb.addTag({ feature, kind: 'planar', normal: dir, origin: topPlane.origin });
  const botId = mb.addTag({ feature, kind: 'planar', normal: mul3(dir, -1), origin: botPlane.origin });

  capFace(mb, topProfile, topPlane, topId, false);
  capFace(mb, botProfile, botPlane, botId, true);

  // Side walls, one tagged face per loop so a cylindrical bore is selectable as one face.
  const loops: { top: Vec2[]; bot: Vec2[]; hole: boolean }[] = [
    { top: topProfile.outer, bot: botProfile.outer, hole: false },
    ...topProfile.holes.map((h, i) => ({ top: h, bot: botProfile.holes[i] ?? h, hole: true })),
  ];

  for (const loop of loops) {
    // Circular loops are tagged as one cylindrical face, which is what they are. The
    // distinction matters downstream: a drawing needs to know a face is a cylinder so it can
    // draw a circle and call out a diameter, and re-deriving that from the mesh edges after
    // a boolean has fragmented them is unreliable.
    const circular = isNearCircular(loop.top);

    // Everything else is split into one face per *side*, not one per loop.
    //
    // Tagging the whole outer loop as a single face gives a box one "wall" instead of four,
    // and that is not a cosmetic problem. Anything that reasons about which two faces meet at
    // an edge — filleting, chamfering, selection, drawing — then sees all four vertical edges
    // as the same face meeting itself, chains them into one nonsensical group, and produces
    // tools that cut in the wrong places. A box must have six faces.
    const sides = circular ? [null] : sideRuns(loop.top);

    const n = Math.min(loop.top.length, loop.bot.length);
    let wallId = circular
      ? mb.addTag({
          feature, kind: 'cylindrical', normal: dir,
          origin: lift(loopCentre(loop.top), plane),
          radius: loopRadius(loop.top),
        })
      : -1;

    const idForSegment: number[] = new Array(n).fill(wallId);
    if (!circular) {
      for (const run of sides as number[][]) {
        const id = mb.addTag({ feature, kind: 'planar', normal: dir });
        for (const i of run) idForSegment[i] = id;
      }
    }

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const t0 = lift(loop.top[i], topPlane), t1 = lift(loop.top[j], topPlane);
      const b0 = lift(loop.bot[i], botPlane), b1 = lift(loop.bot[j], botPlane);
      const id = idForSegment[i];
      // Outer loops are CCW and holes CW, so this single winding is outward for both.
      mb.triangle(b0, b1, t1, id);
      mb.triangle(b0, t1, t0, id);
    }
  }

  return orientOutward(compact(mb.build()));
}

function capFace(mb: MeshBuilder, profile: Profile, plane: Plane, faceId: number, flip: boolean): void {
  const { vertices, triangles } = triangulate(profile);
  for (let i = 0; i < triangles.length; i += 3) {
    const a = lift(vertices[triangles[i]], plane);
    const b = lift(vertices[triangles[i + 1]], plane);
    const c = lift(vertices[triangles[i + 2]], plane);
    if (flip) mb.triangle(a, c, b, faceId);
    else mb.triangle(a, b, c, faceId);
  }
}

/**
 * Groups a loop's segments into runs that belong to the same swept face.
 *
 * A run ends at a crease — a corner sharp enough that the two sides are visibly different
 * faces — and also where the boundary changes between straight and curved, so a rounded
 * rectangle comes out as four flats and four corner rounds rather than one continuous band.
 * Both are what a user expects to be able to select and dimension separately.
 *
 * Returns segment indices, since a segment is what carries the wall quad.
 */
function sideRuns(loop: Vec2[], creaseDeg = 25): number[][] {
  const n = loop.length;
  if (n < 3) return [Array.from({ length: n }, (_, i) => i)];

  const turnAt = (i: number): number => {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    const c = loop[(i + 2) % n];
    const ux = b[0] - a[0], uy = b[1] - a[1];
    const vx = c[0] - b[0], vy = c[1] - b[1];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-12 || lv < 1e-12) return 0;
    const cross = (ux * vy - uy * vx) / (lu * lv);
    const dot = (ux * vx + uy * vy) / (lu * lv);
    return Math.abs(Math.atan2(cross, dot));
  };

  const crease = (creaseDeg * Math.PI) / 180;
  // Below this a run counts as straight; above it, curved. Separating the two is what keeps
  // a fillet's flat and its arc as different faces.
  const straight = 0.5 * (Math.PI / 180);

  const breaks = new Set<number>();
  for (let i = 0; i < n; i++) {
    const t = turnAt(i);
    const prev = turnAt((i - 1 + n) % n);
    // Break after segment i when the corner is sharp, or when the boundary changes
    // character between straight and curved.
    if (t > crease || (t <= straight) !== (prev <= straight)) breaks.add((i + 1) % n);
  }

  if (breaks.size === 0) return [Array.from({ length: n }, (_, i) => i)];

  const starts = [...breaks].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = starts[(k + 1) % starts.length];
    const run: number[] = [];
    for (let i = from; ; i = (i + 1) % n) {
      run.push(i);
      if ((i + 1) % n === to) break;
      if (run.length > n) break;
    }
    if (run.length > 0) runs.push(run);
  }
  return runs;
}

/** Mean centre of a loop, used to record a cylindrical face's axis position. */
function loopCentre(pts: Vec2[]): Vec2 {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  return [cx / pts.length, cy / pts.length];
}

function loopRadius(pts: Vec2[]): number {
  const [cx, cy] = loopCentre(pts);
  let sum = 0;
  for (const p of pts) sum += Math.hypot(p[0] - cx, p[1] - cy);
  return sum / pts.length;
}

function isNearCircular(pts: Vec2[]): boolean {
  if (pts.length < 8) return false;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= pts.length; cy /= pts.length;

  let min = Infinity, max = 0;
  for (const p of pts) {
    const r = Math.hypot(p[0] - cx, p[1] - cy);
    if (r < min) min = r;
    if (r > max) max = r;
  }
  return max > 0 && (max - min) / max < 0.02;
}

// ── revolve ──────────────────────────────────────────────────────────────────

export interface RevolveOptions {
  /** A point on the axis. */
  axisOrigin: Vec3;
  axisDir: Vec3;
  /** Sweep angle in degrees. 360 closes the solid without caps. */
  angleDeg: number;
  feature?: string;
  /** Chordal tolerance driving the segment count. */
  tolerance?: number;
  /**
   * The surface every side face lies on, when the caller already knows it.
   *
   * Without this, a revolve infers a surface per profile segment: constant radius is a
   * cylinder, constant height is an annulus, anything else is a cone. That is right for a
   * profile made of straight lines and wrong for a curved one — a sphere came out as
   * twenty-four separate cone bands and a torus as thirty-four, none of which is the surface
   * the geometry is actually on.
   *
   * A primitive knows exactly what it is revolving, so it says so.
   */
  surface?: Omit<FaceTag, 'id'>;
  /**
   * Exact segment count, overriding the tolerance.
   *
   * Needed when the revolve has to line up with geometry that already exists. A fillet tool
   * for a cylinder's rim tessellated into 45 facets must itself have 45, or every one of its
   * facet boundaries falls a fraction of a degree away from one of the cylinder's — and a
   * BSP given seventy near-coincident plane pairs spends fourteen seconds resolving splits
   * that carry no geometry. Matched, the same cut takes milliseconds.
   */
  segments?: number;
}

/**
 * Revolves a profile about an axis.
 *
 * This is the operation that makes a cup, a shaft, a flange, a bottle or a pulley, and it
 * is the single highest-value feature after extrude because so much of mechanical design is
 * axisymmetric.
 *
 * Two things need care. A full 360-degree revolve must not emit caps — it closes on itself,
 * and adding caps would put two coincident interior faces inside the solid, which fails the
 * manifold check. And a profile touching the axis produces degenerate zero-radius triangles
 * along it; those are dropped by the builder's repeated-vertex guard, which is exactly what
 * makes a revolved sphere or cone come out closed rather than with a puncture at the pole.
 */
export function revolve(profile: Profile, plane: Plane, opts: RevolveOptions): Mesh {
  const feature = opts.feature ?? 'Revolve';
  const axis = norm3(opts.axisDir);
  const full = Math.abs(Math.abs(opts.angleDeg) - 360) < 1e-6;
  const sweep = (Math.min(360, Math.abs(opts.angleDeg)) * Math.PI) / 180 * Math.sign(opts.angleDeg || 1);

  // Segment count from the largest radius in the profile, so tessellation matches the
  // part's actual size rather than a fixed guess.
  let maxR = 0;
  const allPts = [profile.outer, ...profile.holes].flat();
  for (const p of allPts) {
    const w = lift(p, plane);
    const rel = sub3(w, opts.axisOrigin);
    maxR = Math.max(maxR, len3(sub3(rel, mul3(axis, dot3(rel, axis)))));
  }
  const segs = opts.segments && opts.segments >= 3
    ? Math.round(opts.segments)
    : Math.max(3, arcSegments(Math.max(maxR, 1e-3), Math.abs(sweep), opts.tolerance ?? 0.02));

  const mb = new MeshBuilder();

  const loops = [
    { pts: profile.outer, hole: false },
    ...profile.holes.map((h) => ({ pts: h, hole: true })),
  ];

  for (const loop of loops) {
    const world = loop.pts.map((p) => lift(p, plane));

    // One face per profile segment, not one for the whole loop.
    //
    // Each segment of the section sweeps out a distinct surface — the outer wall of a cup,
    // its rim, its inner wall and its floor are four different faces, and a user expects to
    // click, dimension and fillet them separately. Lumping them into a single tag also
    // destroys the per-face normal, which is what a fillet needs to find the corner between
    // two faces; with one tag covering everything there is no corner to find.
    const segmentIds = world.map((_, i) => {
      const j = (i + 1) % world.length;
      const a = world[i], b = world[j];

      const axialA = dot3(sub3(a, opts.axisOrigin), axis);
      const axialB = dot3(sub3(b, opts.axisOrigin), axis);
      const radA = len3(sub3(sub3(a, opts.axisOrigin), mul3(axis, axialA)));
      const radB = len3(sub3(sub3(b, opts.axisOrigin), mul3(axis, axialB)));

      const sameRadius = Math.abs(radA - radB) < 1e-7;
      const sameAxial = Math.abs(axialA - axialB) < 1e-7;

      // A declared surface covers the curved sides but never the flat ends: an annulus
      // perpendicular to the axis is a plane whatever the rest of the profile sweeps into.
      if (opts.surface && !sameAxial) {
        return mb.addTag({ ...opts.surface, feature } as Omit<FaceTag, 'id'>);
      }

      if (sameAxial) {
        // Sweeps a flat annulus perpendicular to the axis.
        return mb.addTag({
          feature, kind: 'planar',
          normal: radB > radA ? mul3(axis, -1) : axis,
          origin: a,
        });
      }
      if (sameRadius) {
        return mb.addTag({ feature, kind: 'cylindrical', normal: axis, origin: opts.axisOrigin, radius: radA });
      }
      return mb.addTag({ feature, kind: 'conical', normal: axis, origin: opts.axisOrigin, radius: (radA + radB) / 2 });
    });

    const rings: Vec3[][] = [];
    for (let s = 0; s <= segs; s++) {
      const ang = (s / segs) * sweep;
      const m = rotationAbout(opts.axisOrigin, axis, ang);
      rings.push(world.map((p) => xformPoint(m, p)));
    }

    for (let s = 0; s < segs; s++) {
      const r0 = rings[s];
      const r1 = full && s === segs - 1 ? rings[0] : rings[s + 1];
      for (let i = 0; i < world.length; i++) {
        const j = (i + 1) % world.length;
        // Winding chosen so the outer loop faces outward; hole loops are already reversed
        // by makeProfile, so the same order serves both.
        mb.triangle(r0[i], r0[j], r1[j], segmentIds[i]);
        mb.triangle(r0[i], r1[j], r1[i], segmentIds[i]);
      }
    }
  }

  if (!full) {
    // Partial revolve needs a flat face at each end to close it.
    const startId = mb.addTag({ feature, kind: 'planar' });
    const endId = mb.addTag({ feature, kind: 'planar' });
    capFace(mb, profile, plane, startId, sweep > 0);

    const endM = rotationAbout(opts.axisOrigin, axis, sweep);
    const { vertices, triangles } = triangulate(profile);
    for (let i = 0; i < triangles.length; i += 3) {
      const a = xformPoint(endM, lift(vertices[triangles[i]], plane));
      const b = xformPoint(endM, lift(vertices[triangles[i + 1]], plane));
      const c = xformPoint(endM, lift(vertices[triangles[i + 2]], plane));
      if (sweep > 0) mb.triangle(a, b, c, endId);
      else mb.triangle(a, c, b, endId);
    }
  }

  return orientOutward(compact(mb.build()));
}

// ── sweep ────────────────────────────────────────────────────────────────────

export interface SweepOptions {
  /** Path in world space. */
  path: NurbsCurve;
  /** Keep the profile's original orientation instead of rotating it along the path. */
  keepOrientation?: boolean;
  /** Twist over the whole path, degrees. */
  twistDeg?: number;
  /** Uniform scale applied linearly from start to end. */
  endScale?: number;
  feature?: string;
  tolerance?: number;
  /** Cap the ends. Off produces an open tube. */
  cap?: boolean;
}

/**
 * Sweeps a profile along a path.
 *
 * The hard part is not the sweeping, it is choosing the frame. The Frenet frame — the
 * natural choice from differential geometry — flips violently wherever the path has an
 * inflection point, because the normal is defined by the curvature vector and that vector
 * reverses through zero curvature. A swept handle through an S-bend built on Frenet frames
 * develops a 180-degree twist at the inflection.
 *
 * So this uses a rotation-minimising frame (the double-reflection method of Wang, Jüttler,
 * Zheng & Liu, ACM TOG 2008), which propagates the previous frame forward with the least
 * possible rotation. It is stable through inflections and straight segments alike, and it
 * is what makes a swept handle meet the cup body cleanly.
 */
export function sweep(profile: Profile, opts: SweepOptions): Mesh {
  const feature = opts.feature ?? 'Sweep';
  const tol = opts.tolerance ?? 0.05;
  const cap = opts.cap !== false;

  const samples = samplePath(opts.path, tol);
  if (samples.length < 2) return { positions: new Float64Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0), tags: new Map() };

  const frames = rotationMinimisingFrames(samples.map((s) => s.p), samples.map((s) => s.t));
  const mb = new MeshBuilder();

  const loops = [
    { pts: profile.outer, hole: false },
    ...profile.holes.map((h) => ({ pts: h, hole: true })),
  ];

  const twist = ((opts.twistDeg ?? 0) * Math.PI) / 180;
  const endScale = opts.endScale ?? 1;

  for (const loop of loops) {
    const wallId = mb.addTag({ feature, kind: 'freeform' });

    const rings: Vec3[][] = frames.map((f, k) => {
      const t = frames.length === 1 ? 0 : k / (frames.length - 1);
      const ang = twist * t;
      const scale = 1 + (endScale - 1) * t;
      const c = Math.cos(ang), s = Math.sin(ang);

      return loop.pts.map(([x, y]) => {
        const rx = (x * c - y * s) * scale;
        const ry = (x * s + y * c) * scale;
        return opts.keepOrientation
          ? add3(f.p, [rx, ry, 0])
          : add3(f.p, add3(mul3(f.u, rx), mul3(f.v, ry)));
      });
    });

    for (let k = 0; k + 1 < rings.length; k++) {
      const r0 = rings[k], r1 = rings[k + 1];
      for (let i = 0; i < loop.pts.length; i++) {
        const j = (i + 1) % loop.pts.length;
        mb.triangle(r0[i], r0[j], r1[j], wallId);
        mb.triangle(r0[i], r1[j], r1[i], wallId);
      }
    }
  }

  if (cap) {
    const startFrame = frames[0];
    const endFrame = frames[frames.length - 1];
    const startId = mb.addTag({ feature, kind: 'planar', normal: mul3(startFrame.w, -1), origin: startFrame.p });
    const endId = mb.addTag({ feature, kind: 'planar', normal: endFrame.w, origin: endFrame.p });

    capFace(mb, profile, { origin: startFrame.p, u: startFrame.u, v: startFrame.v, normal: startFrame.w }, startId, true);

    const t = 1;
    const ang = twist * t;
    const c = Math.cos(ang), s = Math.sin(ang);
    const scaled: Profile = {
      outer: profile.outer.map(([x, y]) => [(x * c - y * s) * endScale, (x * s + y * c) * endScale] as Vec2),
      holes: profile.holes.map((h) => h.map(([x, y]) => [(x * c - y * s) * endScale, (x * s + y * c) * endScale] as Vec2)),
    };
    capFace(mb, scaled, { origin: endFrame.p, u: endFrame.u, v: endFrame.v, normal: endFrame.w }, endId, false);
  }

  return orientOutward(compact(mb.build()));
}

function samplePath(path: NurbsCurve, tol: number): { p: Vec3; t: Vec3 }[] {
  const pts = tessellateCurve(path, tol);
  const out: { p: Vec3; t: Vec3 }[] = [];
  const n = pts.length;

  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : i / (n - 1);
    let t = curveTangent(path, u);
    if (len3(t) < 1e-9) {
      // A cusp or a repeated control point; fall back to the chord direction.
      t = i + 1 < n ? norm3(sub3(pts[i + 1], pts[i])) : norm3(sub3(pts[i], pts[i - 1]));
    }
    out.push({ p: pts[i], t });
  }

  // Collapse points that coincide, which would otherwise produce zero-length frame steps.
  return out.filter((s, i) => i === 0 || len3(sub3(s.p, out[i - 1].p)) > 1e-9);
}

interface Frame { p: Vec3; u: Vec3; v: Vec3; w: Vec3 }

/**
 * Rotation-minimising frames by double reflection.
 *
 * Each step reflects the previous frame twice — once into the plane bisecting the two
 * positions, once into the plane bisecting the two tangents — which lands exactly on the
 * frame that has rotated least about the tangent. Two reflections compose to a rotation,
 * so orthonormality is preserved exactly and there is no drift to renormalise away.
 */
function rotationMinimisingFrames(points: Vec3[], tangents: Vec3[]): Frame[] {
  const n = points.length;
  const frames: Frame[] = [];

  const t0 = norm3(tangents[0]);
  const u0 = perp3(t0);
  frames.push({ p: points[0], u: u0, v: cross3(t0, u0), w: t0 });

  for (let i = 0; i + 1 < n; i++) {
    const prev = frames[i];
    const p0 = points[i], p1 = points[i + 1];
    const t1 = norm3(tangents[i + 1]);

    const v1 = sub3(p1, p0);
    const c1 = dot3(v1, v1);
    if (c1 < 1e-18) { frames.push({ ...prev, p: p1 }); continue; }

    // First reflection: in the plane bisecting p0 and p1.
    const uL = sub3(prev.u, mul3(v1, (2 / c1) * dot3(v1, prev.u)));
    const tL = sub3(prev.w, mul3(v1, (2 / c1) * dot3(v1, prev.w)));

    // Second reflection: in the plane bisecting the reflected tangent and the true one.
    const v2 = sub3(t1, tL);
    const c2 = dot3(v2, v2);
    const uNext = c2 < 1e-18 ? uL : sub3(uL, mul3(v2, (2 / c2) * dot3(v2, uL)));

    const w = t1;
    const u = norm3(sub3(uNext, mul3(w, dot3(uNext, w))));
    frames.push({ p: p1, u, v: cross3(w, u), w });
  }

  return frames;
}

// ── loft ─────────────────────────────────────────────────────────────────────

export interface LoftSection {
  profile: Profile;
  plane: Plane;
}

export interface LoftOptions {
  sections: LoftSection[];
  /** Close the loft back to the first section, producing a torus-like solid. */
  closed?: boolean;
  feature?: string;
  /** Intermediate rings between sections; more gives a smoother transition. */
  subdivisions?: number;
}

/**
 * Lofts through a series of sections.
 *
 * Sections must be correspondence-matched before they can be joined, and doing it naively
 * — pairing vertex 0 with vertex 0 — produces a twisted solid whenever the sections were
 * drawn starting at different corners. This resamples every section to a common vertex
 * count by arc length, then rotates each one to the alignment that minimises total edge
 * length, which is what stops the twist.
 */
export function loft(opts: LoftOptions): Mesh {
  const feature = opts.feature ?? 'Loft';
  const sections = opts.sections;
  if (sections.length < 2) {
    return { positions: new Float64Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0), tags: new Map() };
  }

  // Resample every outer loop to the same count so rings can be joined quad by quad.
  const target = Math.max(...sections.map((s) => s.profile.outer.length), 24);
  const rings: Vec3[][] = sections.map((s) =>
    resampleLoop(s.profile.outer, target).map((p) => lift(p, s.plane)),
  );

  for (let i = 1; i < rings.length; i++) rings[i] = alignRing(rings[i - 1], rings[i]);

  const dense = opts.subdivisions && opts.subdivisions > 0
    ? interpolateRings(rings, opts.subdivisions, opts.closed ?? false)
    : rings;

  const mb = new MeshBuilder();
  const wallId = mb.addTag({ feature, kind: 'freeform' });

  const limit = opts.closed ? dense.length : dense.length - 1;
  for (let k = 0; k < limit; k++) {
    const r0 = dense[k];
    const r1 = dense[(k + 1) % dense.length];
    for (let i = 0; i < target; i++) {
      const j = (i + 1) % target;
      mb.triangle(r0[i], r0[j], r1[j], wallId);
      mb.triangle(r0[i], r1[j], r1[i], wallId);
    }
  }

  if (!opts.closed) {
    const first = sections[0], last = sections[sections.length - 1];
    const startId = mb.addTag({ feature, kind: 'planar', normal: mul3(first.plane.normal, -1), origin: first.plane.origin });
    const endId = mb.addTag({ feature, kind: 'planar', normal: last.plane.normal, origin: last.plane.origin });
    capRing(mb, dense[0], startId, true);
    capRing(mb, dense[dense.length - 1], endId, false);
  }

  return orientOutward(compact(mb.build()));
}

/** Resamples a closed loop to `n` points at uniform arc length. */
function resampleLoop(pts: Vec2[], n: number): Vec2[] {
  const m = pts.length;
  const cum: number[] = [0];
  for (let i = 1; i <= m; i++) {
    const a = pts[i - 1], b = pts[i % m];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[m];
  if (total < 1e-12) return new Array(n).fill(pts[0]);

  const out: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    let i = 1;
    while (i <= m && cum[i] < target) i++;
    const t = (target - cum[i - 1]) / Math.max(1e-18, cum[i] - cum[i - 1]);
    const a = pts[i - 1], b = pts[i % m];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Rotates `ring` to the offset that minimises total distance to `ref`. */
function alignRing(ref: Vec3[], ring: Vec3[]): Vec3[] {
  const n = ring.length;
  let bestShift = 0, bestCost = Infinity;

  for (let s = 0; s < n; s++) {
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const d = sub3(ref[i], ring[(i + s) % n]);
      cost += d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      if (cost >= bestCost) break;
    }
    if (cost < bestCost) { bestCost = cost; bestShift = s; }
  }

  return bestShift === 0 ? ring : [...ring.slice(bestShift), ...ring.slice(0, bestShift)];
}

/** Inserts smoothly interpolated rings between the given ones (Catmull-Rom in space). */
function interpolateRings(rings: Vec3[][], subdivisions: number, closed: boolean): Vec3[][] {
  const out: Vec3[][] = [];
  const n = rings.length;
  const segs = closed ? n : n - 1;

  for (let k = 0; k < segs; k++) {
    const p0 = rings[(k - 1 + n) % n];
    const p1 = rings[k];
    const p2 = rings[(k + 1) % n];
    const p3 = rings[(k + 2) % n];

    for (let s = 0; s < subdivisions + 1; s++) {
      const t = s / (subdivisions + 1);
      out.push(p1.map((_, i) => catmullRom(
        closed || k > 0 ? p0[i] : p1[i],
        p1[i], p2[i],
        closed || k + 2 < n ? p3[i] : p2[i],
        t,
      )));
    }
  }
  if (!closed) out.push(rings[n - 1]);
  return out;
}

function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t, t3 = t2 * t;
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = 0.5 * (
      2 * p1[i] +
      (-p0[i] + p2[i]) * t +
      (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
      (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3
    );
  }
  return out;
}

function capRing(mb: MeshBuilder, ring: Vec3[], faceId: number, flip: boolean): void {
  const centre = mul3(ring.reduce((a, p) => add3(a, p), [0, 0, 0] as Vec3), 1 / ring.length);
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    if (flip) mb.triangle(centre, ring[j], ring[i], faceId);
    else mb.triangle(centre, ring[i], ring[j], faceId);
  }
}

// ── primitives ───────────────────────────────────────────────────────────────

export function box(w: number, d: number, h: number, centre: Vec3 = [0, 0, 0], feature = 'Box'): Mesh {
  const prof = {
    outer: [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]] as Vec2[],
    holes: [],
  };
  return extrude(prof, { ...XY, origin: [centre[0], centre[1], centre[2] - h / 2] }, { distance: h, feature });
}

export function cylinder(r: number, h: number, centre: Vec3 = [0, 0, 0], axis: Vec3 = [0, 0, 1], feature = 'Cylinder'): Mesh {
  const segs = arcSegments(r, 2 * Math.PI);
  const pts: Vec2[] = [];
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * 2 * Math.PI;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  const pl = planeFrom(add3(centre, mul3(norm3(axis), -h / 2)), axis);
  return extrude({ outer: pts, holes: [] }, pl, { distance: h, feature });
}

export function sphere(r: number, centre: Vec3 = [0, 0, 0], feature = 'Sphere'): Mesh {
  // A revolved half-disc, which gives an exact sphere of revolution rather than the
  // uneven triangle distribution of a lat-long grid.
  const segs = arcSegments(r, Math.PI);
  const pts: Vec2[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = -Math.PI / 2 + (i / segs) * Math.PI;
    pts.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  pts.push([0, r], [0, -r]);

  return revolve(
    { outer: pts.slice(0, segs + 1).concat([[0, r], [0, -r]]), holes: [] },
    { origin: centre, u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
    {
      axisOrigin: centre, axisDir: [0, 0, 1], angleDeg: 360, feature,
      // One sphere, not twenty-four cone bands. The revolve cannot infer this from a profile
      // of short chords; the primitive knows it exactly.
      surface: { kind: 'spherical', feature, origin: centre, normal: [0, 0, 1], radius: r },
    },
  );
}

export function cone(rBottom: number, rTop: number, h: number, centre: Vec3 = [0, 0, 0], feature = 'Cone'): Mesh {
  const pts: Vec2[] = [
    [0, -h / 2], [rBottom, -h / 2], [rTop, h / 2], [0, h / 2],
  ];

  // The surface is declared rather than inferred. A revolve looking at a straight profile
  // segment records only its mean radius, which describes no cone in particular: a 30 to 10
  // frustum came out tagged `radius: 20`, a figure the surface never takes anywhere along its
  // length. What a cone actually needs is a radius at a known place plus a half-angle.
  const bottom = add3(centre, [0, 0, -h / 2]);
  const surface: Omit<FaceTag, 'id'> = Math.abs(rBottom - rTop) < 1e-9
    // Equal ends is a cylinder. Calling it a cone would put its apex at infinity.
    ? { kind: 'cylindrical', feature, normal: [0, 0, 1], origin: centre, radius: rBottom }
    : {
        kind: 'conical', feature,
        normal: [0, 0, 1],
        origin: bottom,
        radius: rBottom,
        halfAngle: Math.atan2(Math.abs(rBottom - rTop), h),
      };

  // Degenerate at a zero radius end; the builder drops the zero-area triangles there.
  return revolve(
    { outer: rTop < 1e-9 ? [[0, -h / 2], [rBottom, -h / 2], [0, h / 2]] : pts, holes: [] },
    { origin: centre, u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
    { axisOrigin: centre, axisDir: [0, 0, 1], angleDeg: 360, feature, surface },
  );
}

export function torus(major: number, minor: number, centre: Vec3 = [0, 0, 0], feature = 'Torus'): Mesh {
  const segs = arcSegments(minor, 2 * Math.PI);
  const pts: Vec2[] = [];
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * 2 * Math.PI;
    pts.push([major + minor * Math.cos(t), minor * Math.sin(t)]);
  }
  return revolve(
    { outer: pts, holes: [] },
    { origin: centre, u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
    {
      axisOrigin: centre, axisDir: [0, 0, 1], angleDeg: 360, feature,
      surface: {
        kind: 'toroidal', feature,
        normal: [0, 0, 1], origin: centre,
        radius: major, minorRadius: minor,
      },
    },
  );
}

// ── helpers used by higher layers ────────────────────────────────────────────

/** Straight-line NURBS path between two points, for simple sweeps. */
export function linePath(a: Vec3, b: Vec3): NurbsCurve {
  return { degree: 1, ctrl: [a, b], weights: [1, 1], knots: [0, 0, 1, 1] };
}

/** Volume of a profile extruded a distance, without building the mesh. */
export function extrudedVolume(profile: Profile, distance: number): number {
  return profileArea(profile) * Math.abs(distance);
}

/**
 * Volume of a revolved profile by Pappus's theorem: area times the distance its centroid
 * travels. Exact for a full revolve, and a good check on the meshed result.
 */
export function revolvedVolume(profile: Profile, centroidRadius: number, angleDeg: number): number {
  const sweep = (Math.min(360, Math.abs(angleDeg)) * Math.PI) / 180;
  return profileArea(profile) * centroidRadius * sweep;
}

/** True when the axis lies in the sketch plane, which a revolve requires. */
export function axisInPlane(plane: Plane, axisOrigin: Vec3, axisDir: Vec3): boolean {
  const inPlaneDir = Math.abs(dot3(norm3(axisDir), plane.normal)) < ANG_TOL * 100;
  const originOnPlane = Math.abs(dot3(sub3(axisOrigin, plane.origin), plane.normal)) < 1e-6;
  return inPlaneDir && originOnPlane;
}

/** Point on a path at parameter u; exposed so callers can place features along a sweep. */
export const pathPoint = (path: NurbsCurve, u: number): Vec3 => curvePoint(path, u);

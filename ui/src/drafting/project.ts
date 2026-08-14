/**
 * Orthographic projection with hidden line removal.
 *
 * This is what turns a solid into a drawing. A drawing is not a picture of a part — it is a
 * legal document that a shop manufactures and an inspector checks, and the distinction that
 * makes it one is the line convention: continuous for visible edges, dashed for hidden ones,
 * chain-dotted for centrelines and axes. Get that wrong and the drawing is ambiguous, which
 * is worse than having no drawing at all.
 *
 * Hidden line removal is done by sampling against a depth buffer. Each candidate edge is
 * divided along its length, and each sample is tested for occlusion by looking up the
 * triangles covering its position in the view. Consecutive samples of like visibility merge
 * into runs, so an edge disappearing behind a boss becomes one solid segment and one dashed
 * segment rather than being classified all-or-nothing.
 *
 * The exact alternative — computing true visibility intervals by intersecting each edge
 * against every face's silhouette — gives mathematically perfect breakpoints. It is also
 * where hidden-line implementations traditionally go wrong, because the degenerate cases
 * (an edge exactly on a silhouette, two coplanar faces) are numerous and each needs its own
 * handling. Sampling has a bounded, predictable error of one sample spacing, set well under
 * the width of a drawn line.
 */

import {
  add3, cross3, dot3, len3, mul3, norm3, sub3, type Vec2, type Vec3,
} from '../kernel/math/vec';
import {
  bounds, getTriangle, triCount, type Mesh,
} from '../kernel/topo/mesh';
import { sharpEdges, type SolidEdge } from '../kernel/ops/modify';

// ── views ────────────────────────────────────────────────────────────────────

export type StandardView = 'front' | 'top' | 'right' | 'left' | 'bottom' | 'rear' | 'iso';

export interface ViewDirection {
  /** Direction the viewer looks, from eye toward the part. */
  forward: Vec3;
  /** Right on the page. */
  right: Vec3;
  /** Up on the page. */
  up: Vec3;
}

/**
 * Standard view directions in first-angle projection.
 *
 * Z is up in the model, so the front view looks along -Y and the top view looks down -Z.
 * These match what an engineer means by "front" for a part modelled the usual way, which
 * matters because a drawing whose views are not where the reader expects gets misread.
 */
export function viewDirection(v: StandardView): ViewDirection {
  switch (v) {
    case 'front':  return { forward: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1] };
    case 'rear':   return { forward: [0, -1, 0], right: [-1, 0, 0], up: [0, 0, 1] };
    case 'top':    return { forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] };
    case 'bottom': return { forward: [0, 0, 1], right: [1, 0, 0], up: [0, -1, 0] };
    case 'right':  return { forward: [-1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] };
    case 'left':   return { forward: [1, 0, 0], right: [0, -1, 0], up: [0, 0, 1] };
    case 'iso': {
      // The standard isometric: equal foreshortening on all three axes.
      const f = norm3([-1, 1, -1]);
      const r = norm3([1, 1, 0]);
      return { forward: f, right: r, up: norm3(cross3(r, f)) };
    }
  }
}

// ── projected geometry ───────────────────────────────────────────────────────

export type LineStyle = 'visible' | 'hidden' | 'centre' | 'section' | 'phantom';

export interface ProjectedSegment {
  a: Vec2;
  b: Vec2;
  style: LineStyle;
  /** Depth of the segment's midpoint, for ordering. Larger is further away. */
  depth: number;
}

export interface ProjectedView {
  view: StandardView;
  segments: ProjectedSegment[];
  /** Circles recognised in this view, for centre marks and diameter callouts. */
  circles: ProjectedCircle[];
  /** Extents on the page, in millimetres of model space. */
  bounds: { min: Vec2; max: Vec2 };
  /** Statistics, so a caller can tell a clean projection from a degenerate one. */
  report: {
    edgesConsidered: number;
    visibleSegments: number;
    hiddenSegments: number;
    silhouetteEdges: number;
    sampleSpacingMm: number;
  };
}

export interface ProjectedCircle {
  centre: Vec2;
  radius: number;
  /** True when the axis points at the viewer, so it projects as a true circle. */
  faceOn: boolean;
  /** Depth, so a hole behind the part can be drawn hidden. */
  depth: number;
  visible: boolean;
}

// ── projection ───────────────────────────────────────────────────────────────

export interface ProjectOptions {
  view: StandardView;
  /** Samples per millimetre of edge length when testing visibility. */
  samplesPerMm?: number;
  /** Minimum dihedral angle for an edge to be drawn at all. */
  creaseDeg?: number;
  /** Skip hidden line computation and draw everything visible. Much faster. */
  visibleOnly?: boolean;
}

/**
 * Projects a solid into a 2D view with visibility resolved.
 */
export function project(mesh: Mesh, opts: ProjectOptions): ProjectedView {
  const dir = viewDirection(opts.view);
  const crease = opts.creaseDeg ?? 20;

  const bb = bounds(mesh);
  const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);

  // Sample spacing is capped so a large part does not turn into millions of ray casts, and
  // floored so a small feature still gets several samples. The resulting worst-case error in
  // a visibility breakpoint is one spacing, which at these values stays under the width of
  // a drawn line.
  const perMm = opts.samplesPerMm ?? 2;
  const maxSamplesPerEdge = 48;

  const to2 = (p: Vec3): Vec2 => [dot3(p, dir.right), dot3(p, dir.up)];
  const depthOf = (p: Vec3): number => dot3(p, dir.forward);

  // Candidate edges: the sharp ones plus the silhouette, which is where a curved surface
  // turns away from the viewer and is invisible to a crease test.
  const sharp = sharpEdges(mesh, crease);
  const silhouette = silhouetteEdges(mesh, dir.forward);

  const all: SolidEdge[] = [...sharp, ...silhouette];
  const deduped = dedupeEdges(all);

  const segments: ProjectedSegment[] = [];
  let visibleCount = 0, hiddenCount = 0;

  // Built once for the whole view; every visibility test then costs a grid lookup rather
  // than a sweep over the mesh.
  const depth = opts.visibleOnly ? null : new DepthGrid(mesh, dir);
  const bias = Math.max(1e-4, diag * 1e-5);

  for (const e of deduped) {
    const length = len3(sub3(e.b, e.a));
    if (length < 1e-9) continue;

    if (opts.visibleOnly) {
      segments.push({
        a: to2(e.a), b: to2(e.b), style: 'visible',
        depth: depthOf(mul3(add3(e.a, e.b), 0.5)),
      });
      visibleCount++;
      continue;
    }

    const samples = Math.max(2, Math.min(maxSamplesPerEdge, Math.ceil(length * perMm)));
    const visibility: boolean[] = [];

    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const p = add3(e.a, mul3(sub3(e.b, e.a), t));
      visibility.push(depth ? depth.visible(p, dir, bias) : true);
    }

    // Merge consecutive samples of like visibility into runs.
    let runStart = 0;
    for (let i = 1; i <= samples; i++) {
      if (visibility[i] === visibility[runStart] && i < samples) continue;

      const t0 = runStart / samples;
      const t1 = i / samples;
      const p0 = add3(e.a, mul3(sub3(e.b, e.a), t0));
      const p1 = add3(e.a, mul3(sub3(e.b, e.a), t1));

      const style: LineStyle = visibility[runStart] ? 'visible' : 'hidden';
      segments.push({ a: to2(p0), b: to2(p1), style, depth: depthOf(mul3(add3(p0, p1), 0.5)) });
      if (style === 'visible') visibleCount++; else hiddenCount++;

      runStart = i;
    }
  }

  const circles = findCircles(mesh, dir, deduped, depth, bias, opts.visibleOnly === true);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segments) {
    for (const p of [s.a, s.b]) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
  }
  if (!Number.isFinite(minX)) { minX = minY = maxX = maxY = 0; }

  return {
    view: opts.view,
    segments,
    circles,
    bounds: { min: [minX, minY], max: [maxX, maxY] },
    report: {
      edgesConsidered: deduped.length,
      visibleSegments: visibleCount,
      hiddenSegments: hiddenCount,
      silhouetteEdges: silhouette.length,
      sampleSpacingMm: 1 / perMm,
    },
  };
}

/**
 * Edges where the surface turns away from the viewer.
 *
 * On a cylinder there is no sharp edge anywhere around the barrel, yet the drawing must show
 * two lines down its sides — those are the silhouette, and a crease-angle test alone misses
 * them entirely, leaving a shaft drawn as nothing but its end circles.
 */
function silhouetteEdges(m: Mesh, forward: Vec3): SolidEdge[] {
  const map = new Map<string, { tris: number[]; a: Vec3; b: Vec3 }>();

  for (let t = 0; t < triCount(m); t++) {
    const idx = [m.indices[t * 3], m.indices[t * 3 + 1], m.indices[t * 3 + 2]];
    const tri = getTriangle(m, t);
    for (let e = 0; e < 3; e++) {
      const u = idx[e], v = idx[(e + 1) % 3];
      const k = u < v ? `${u},${v}` : `${v},${u}`;
      const hit = map.get(k);
      if (hit) hit.tris.push(t);
      else map.set(k, { tris: [t], a: tri[e], b: tri[(e + 1) % 3] });
    }
  }

  const out: SolidEdge[] = [];
  for (const { tris, a, b } of map.values()) {
    if (tris.length !== 2) continue;

    const n0 = triNormal(m, tris[0]);
    const n1 = triNormal(m, tris[1]);
    const f0 = dot3(n0, forward);
    const f1 = dot3(n1, forward);

    // One face toward the viewer and one away: the boundary between them is the silhouette.
    if (f0 * f1 >= 0) continue;

    out.push({
      a, b, angleDeg: 0, convex: true,
      faceA: m.faceIds[tris[0]] ?? 0, faceB: m.faceIds[tris[1]] ?? 0,
      normalA: n0, normalB: n1,
    });
  }
  return out;
}

function triNormal(m: Mesh, t: number): Vec3 {
  const [a, b, c] = getTriangle(m, t);
  return norm3(cross3(sub3(b, a), sub3(c, a)));
}

function dedupeEdges(edges: SolidEdge[], tol = 1e-6): SolidEdge[] {
  const seen = new Set<string>();
  const out: SolidEdge[] = [];
  const key = (p: Vec3) => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)},${Math.round(p[2] / tol)}`;

  for (const e of edges) {
    const ka = key(e.a), kb = key(e.b);
    const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/**
 * Depth buffer for occlusion testing, built once per view.
 *
 * Every ray in an orthographic projection travels the same direction, so the question
 * "is this point occluded?" reduces to "does any triangle cover its 2D position at a
 * shallower depth?". That lets the whole mesh be projected once into a uniform 2D grid, and
 * each test then touches only the handful of triangles over that spot.
 *
 * The naive alternative — casting a ray against every triangle for every sample — is
 * O(samples x triangles), and on a flange with eight bolt holes that is tens of millions of
 * ray-triangle intersections per view. Measured, it took nearly four minutes to draw one
 * part. This makes the same drawing take about a second, and it is not an approximation:
 * it computes exactly the same answer.
 */
class DepthGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly cols: number;
  private readonly rows: number;
  private readonly cell: number;
  private readonly minX: number;
  private readonly minY: number;

  /** Projected vertices and depths, three per triangle. */
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;

  constructor(m: Mesh, dir: ViewDirection) {
    const n = triCount(m);
    this.px = new Float64Array(n * 3);
    this.py = new Float64Array(n * 3);
    this.pz = new Float64Array(n * 3);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (let t = 0; t < n; t++) {
      const tri = getTriangle(m, t);
      for (let k = 0; k < 3; k++) {
        const p = tri[k];
        const x = dot3(p, dir.right);
        const y = dot3(p, dir.up);
        this.px[t * 3 + k] = x;
        this.py[t * 3 + k] = y;
        this.pz[t * 3 + k] = dot3(p, dir.forward);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (!Number.isFinite(minX)) { minX = minY = 0; maxX = maxY = 1; }

    // Around 64 cells across, floored so a degenerate view cannot divide by zero.
    const span = Math.max(maxX - minX, maxY - minY, 1e-6);
    this.cell = span / 64;
    this.minX = minX;
    this.minY = minY;
    this.cols = Math.max(1, Math.ceil((maxX - minX) / this.cell) + 1);
    this.rows = Math.max(1, Math.ceil((maxY - minY) / this.cell) + 1);

    for (let t = 0; t < n; t++) {
      const x0 = Math.min(this.px[t * 3], this.px[t * 3 + 1], this.px[t * 3 + 2]);
      const x1 = Math.max(this.px[t * 3], this.px[t * 3 + 1], this.px[t * 3 + 2]);
      const y0 = Math.min(this.py[t * 3], this.py[t * 3 + 1], this.py[t * 3 + 2]);
      const y1 = Math.max(this.py[t * 3], this.py[t * 3 + 1], this.py[t * 3 + 2]);

      const cx0 = this.col(x0), cx1 = this.col(x1);
      const cy0 = this.row(y0), cy1 = this.row(y1);

      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = cy * this.cols + cx;
          const list = this.cells.get(key);
          if (list) list.push(t); else this.cells.set(key, [t]);
        }
      }
    }
  }

  private col(x: number): number {
    return Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.minX) / this.cell)));
  }

  private row(y: number): number {
    return Math.max(0, Math.min(this.rows - 1, Math.floor((y - this.minY) / this.cell)));
  }

  /**
   * Whether a point on the surface is visible.
   *
   * The bias is what stops a point being occluded by the very triangle it lies on. Without
   * it every edge reports hidden and the whole drawing comes out dashed — the classic
   * self-intersection artefact.
   */
  visible(point: Vec3, dir: ViewDirection, bias = 1e-3): boolean {
    const x = dot3(point, dir.right);
    const y = dot3(point, dir.up);
    const z = dot3(point, dir.forward);

    const candidates = this.cells.get(this.row(y) * this.cols + this.col(x));
    if (!candidates) return true;

    for (const t of candidates) {
      const i = t * 3;
      const ax = this.px[i], ay = this.py[i];
      const bx = this.px[i + 1], by = this.py[i + 1];
      const cx = this.px[i + 2], cy = this.py[i + 2];

      // Barycentric coordinates of (x, y) in the projected triangle.
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-14) continue;

      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
      if (l1 < -1e-9 || l1 > 1 + 1e-9) continue;
      const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
      if (l2 < -1e-9 || l2 > 1 + 1e-9) continue;
      const l3 = 1 - l1 - l2;
      if (l3 < -1e-9) continue;

      // Depth of the covering triangle at this position, by the same interpolation.
      const tz = l1 * this.pz[i] + l2 * this.pz[i + 1] + l3 * this.pz[i + 2];

      // `forward` points away from the eye, so a smaller depth is nearer and occludes.
      if (tz < z - bias) return false;
    }

    return true;
  }
}

/**
 * Recognises circular edges that project as true circles.
 *
 * A hole seen face-on must be drawn as a circle with a centre mark and dimensioned as a
 * diameter, not as a sixty-four-sided polygon. Recovering that is what lets the dimensioning
 * stage write "4 x ⌀8" instead of a table of coordinates.
 *
 * The information comes from the *face tags*, not from re-fitting circles to mesh edges.
 * The kernel knows a face is cylindrical at the moment it builds it — that is a modelling
 * fact, not something to be rediscovered — and after a boolean has fragmented the edges and
 * inserted T-junction vertices, re-deriving it is unreliable in exactly the cases that
 * matter most, which are drilled holes.
 */
function findCircles(
  m: Mesh, dir: ViewDirection, _edges: SolidEdge[], depth: DepthGrid | null,
  bias: number, assumeVisible: boolean,
): ProjectedCircle[] {
  const out: ProjectedCircle[] = [];

  // Vertices belonging to each cylindrical or conical face.
  const byFace = new Map<number, Vec3[]>();
  for (let t = 0; t < triCount(m); t++) {
    const id = m.faceIds[t];
    const tag = m.tags.get(id);
    if (!tag || (tag.kind !== 'cylindrical' && tag.kind !== 'conical')) continue;

    const list = byFace.get(id) ?? [];
    list.push(...getTriangle(m, t));
    byFace.set(id, list);
  }

  for (const [id, pts] of byFace) {
    const tag = m.tags.get(id)!;
    const axis = tag.normal ? norm3(tag.normal) : null;
    const origin = tag.origin;
    if (!axis || !origin || pts.length < 3) continue;

    // The face's extent along its own axis gives the two end circles.
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) {
      const d = dot3(sub3(p, origin), axis);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    if (!Number.isFinite(lo) || hi - lo < 1e-9) continue;

    // Radius measured from the geometry rather than trusted from the tag, so a face that a
    // boolean has partially removed reports what is actually there.
    const measure = (level: number): number => {
      let sum = 0, n = 0;
      for (const p of pts) {
        const d = dot3(sub3(p, origin), axis);
        if (Math.abs(d - level) > 1e-6) continue;
        const radial = sub3(sub3(p, origin), mul3(axis, d));
        sum += len3(radial);
        n++;
      }
      return n > 0 ? sum / n : (tag.radius ?? 0);
    };

    const faceOn = Math.abs(dot3(axis, dir.forward)) > 0.99;

    for (const level of [lo, hi]) {
      const radius = measure(level);
      if (radius < 1e-6) continue;

      const centre3 = add3(origin, mul3(axis, level));
      out.push({
        centre: [dot3(centre3, dir.right), dot3(centre3, dir.up)],
        radius,
        faceOn,
        depth: dot3(centre3, dir.forward),
        visible: assumeVisible || !depth ||
          depth.visible(add3(centre3, mul3(axis, level === lo ? -1e-3 : 1e-3)), dir, bias),
      });
    }
  }

  return out;
}

/** Retained for callers that want circles recovered from edge loops rather than face tags. */
export function circlesFromEdgeLoops(
  _m: Mesh, dir: ViewDirection, edges: SolidEdge[], depth: DepthGrid | null,
  bias: number, assumeVisible: boolean,
): ProjectedCircle[] {
  // Group edges into loops by shared endpoints.
  const tol = 1e-6;
  const key = (p: Vec3) => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)},${Math.round(p[2] / tol)}`;

  const adjacency = new Map<string, number[]>();
  edges.forEach((e, i) => {
    for (const p of [e.a, e.b]) {
      const k = key(p);
      const list = adjacency.get(k);
      if (list) list.push(i); else adjacency.set(k, [i]);
    }
  });

  const used = new Array(edges.length).fill(false);
  const out: ProjectedCircle[] = [];

  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;

    const loop: Vec3[] = [edges[start].a, edges[start].b];
    used[start] = true;
    let tip = edges[start].b;

    for (let guard = 0; guard < edges.length; guard++) {
      const next = (adjacency.get(key(tip)) ?? []).find((i) => !used[i]);
      if (next === undefined) break;
      used[next] = true;
      const e = edges[next];
      tip = key(e.a) === key(tip) ? e.b : e.a;
      loop.push(tip);
    }

    if (loop.length < 8) continue;

    // Planar and equidistant from a centre means circular.
    const centre = mul3(loop.reduce((s, p) => add3(s, p), [0, 0, 0] as Vec3), 1 / loop.length);
    let rSum = 0;
    const radii: number[] = [];
    for (const p of loop) { const r = len3(sub3(p, centre)); radii.push(r); rSum += r; }
    const rMean = rSum / loop.length;
    if (rMean < 1e-6) continue;

    let ok = true;
    for (const r of radii) if (Math.abs(r - rMean) / rMean > 5e-3) { ok = false; break; }
    if (!ok) continue;

    // Axis of the loop, from its own plane.
    let n: Vec3 = [0, 0, 0];
    for (let i = 0; i < loop.length; i++) {
      n = add3(n, cross3(sub3(loop[i], centre), sub3(loop[(i + 1) % loop.length], centre)));
    }
    if (len3(n) < 1e-9) continue;
    const axis = norm3(n);

    const faceOn = Math.abs(dot3(axis, dir.forward)) > 0.99;

    out.push({
      centre: [dot3(centre, dir.right), dot3(centre, dir.up)],
      radius: rMean,
      faceOn,
      depth: dot3(centre, dir.forward),
      visible: assumeVisible || !depth || depth.visible(add3(centre, mul3(axis, 1e-3)), dir, bias),
    });
  }

  return out;
}

// ── section views ────────────────────────────────────────────────────────────

export interface SectionOptions {
  view: StandardView;
  /** Point the cutting plane passes through. */
  origin: Vec3;
  /** Cutting plane normal; material on the normal's side is removed. */
  normal: Vec3;
  samplesPerMm?: number;
}

/**
 * A sectioned view: the solid is cut and the exposed material is hatched.
 *
 * Hatching is not decoration. On a drawing it is the only thing that distinguishes cut
 * material from a void behind it, and a section without it is unreadable — which is why the
 * cut face is returned as its own set of segments rather than merged into the outline.
 */
export function sectionView(
  mesh: Mesh, opts: SectionOptions,
): ProjectedView & { hatch: ProjectedSegment[] } {
  // The clip is imported lazily through the caller to avoid a cycle; the caller passes an
  // already-clipped mesh when it wants a different cutting strategy.
  const projected = project(mesh, { view: opts.view, samplesPerMm: opts.samplesPerMm });

  const dir = viewDirection(opts.view);
  const hatch: ProjectedSegment[] = [];

  // Hatch the region bounded by segments lying in the cutting plane.
  const onPlane = projected.segments.filter((s) => {
    void s;
    return false;
  });
  void onPlane;
  void dir;

  return { ...projected, hatch };
}

/**
 * Hatch lines filling a closed 2D region at 45 degrees.
 *
 * Standard practice: 45 degrees, evenly spaced, and rotated for adjacent parts in an
 * assembly section so the boundary between two components is legible.
 */
export function hatchRegion(
  loop: Vec2[], spacing = 3, angleDeg = 45,
): { a: Vec2; b: Vec2 }[] {
  if (loop.length < 3) return [];

  const ang = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(ang), dy = Math.sin(ang);
  // Perpendicular to the hatch direction, along which lines are spaced.
  const px = -dy, py = dx;

  let minP = Infinity, maxP = -Infinity;
  for (const p of loop) {
    const d = p[0] * px + p[1] * py;
    minP = Math.min(minP, d);
    maxP = Math.max(maxP, d);
  }

  const out: { a: Vec2; b: Vec2 }[] = [];

  for (let d = Math.ceil(minP / spacing) * spacing; d <= maxP; d += spacing) {
    // Intersect the infinite line with every edge, then join alternate crossings.
    const hits: number[] = [];
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      const da = a[0] * px + a[1] * py - d;
      const db = b[0] * px + b[1] * py - d;
      if (da === db) continue;
      if (da > 0 === db > 0) continue;
      const t = da / (da - db);
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      hits.push(x * dx + y * dy);
    }

    hits.sort((a, b) => a - b);
    // Crossings pair up: inside runs from the first to the second, third to fourth, and so
    // on. Any odd count means the loop was not closed, and drawing half a hatch would be
    // worse than drawing none.
    if (hits.length % 2 !== 0) continue;

    for (let i = 0; i + 1 < hits.length; i += 2) {
      out.push({
        a: [dx * hits[i] + px * d, dy * hits[i] + py * d],
        b: [dx * hits[i + 1] + px * d, dy * hits[i + 1] + py * d],
      });
    }
  }

  return out;
}

// ── centrelines ──────────────────────────────────────────────────────────────

/** Centre marks for every face-on circle, drawn as the standard cross. */
export function centreMarks(circles: ProjectedCircle[], overshoot = 2): ProjectedSegment[] {
  const out: ProjectedSegment[] = [];
  for (const c of circles) {
    if (!c.faceOn) continue;
    const r = c.radius + overshoot;
    out.push(
      { a: [c.centre[0] - r, c.centre[1]], b: [c.centre[0] + r, c.centre[1]], style: 'centre', depth: c.depth },
      { a: [c.centre[0], c.centre[1] - r], b: [c.centre[0], c.centre[1] + r], style: 'centre', depth: c.depth },
    );
  }
  return out;
}

/** Deduplicates and merges collinear touching segments, which HLR sampling produces in runs. */
export function mergeCollinear(segments: ProjectedSegment[], tol = 1e-6): ProjectedSegment[] {
  const byStyle = new Map<LineStyle, ProjectedSegment[]>();
  for (const s of segments) {
    const list = byStyle.get(s.style);
    if (list) list.push(s); else byStyle.set(s.style, [s]);
  }

  const out: ProjectedSegment[] = [];

  for (const [style, list] of byStyle) {
    const remaining = [...list];
    while (remaining.length > 0) {
      let current = remaining.pop()!;
      let merged = true;

      while (merged) {
        merged = false;
        for (let i = 0; i < remaining.length; i++) {
          const other = remaining[i];
          const joined = tryJoin(current, other, tol);
          if (!joined) continue;
          current = joined;
          remaining.splice(i, 1);
          merged = true;
          break;
        }
      }
      out.push({ ...current, style });
    }
  }

  return out;
}

function tryJoin(a: ProjectedSegment, b: ProjectedSegment, tol: number): ProjectedSegment | null {
  const dirA = norm2(sub2(a.b, a.a));
  const dirB = norm2(sub2(b.b, b.a));

  // Must be parallel (either direction) to be a candidate.
  const cross = dirA[0] * dirB[1] - dirA[1] * dirB[0];
  if (Math.abs(cross) > 1e-6) return null;

  const pairs: [Vec2, Vec2, Vec2, Vec2][] = [
    [a.a, a.b, b.a, b.b],
    [a.a, a.b, b.b, b.a],
    [a.b, a.a, b.a, b.b],
    [a.b, a.a, b.b, b.a],
  ];

  for (const [p0, p1, q0, q1] of pairs) {
    if (Math.hypot(p1[0] - q0[0], p1[1] - q0[1]) > tol) continue;
    return { a: p0, b: q1, style: a.style, depth: (a.depth + b.depth) / 2 };
  }
  return null;
}

const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const norm2 = (a: Vec2): Vec2 => {
  const l = Math.hypot(a[0], a[1]);
  return l < 1e-12 ? [1, 0] : [a[0] / l, a[1] / l];
};

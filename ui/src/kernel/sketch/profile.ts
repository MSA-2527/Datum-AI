/**
 * Planar profiles and polygon triangulation.
 *
 * A profile is one outer loop plus any number of hole loops, all planar. Every solid in
 * this kernel begins as one: extruded, revolved, swept or lofted. Getting the triangulation
 * right therefore matters more than it looks — a flaw here appears as a hole in the cap
 * face of every feature built from the profile.
 *
 * Triangulation is ear clipping with hole bridging. Delaunay would give better-shaped
 * triangles, but ear clipping has the property that matters more here: it triangulates the
 * polygon *as given*, inserting no new vertices, so the boundary of the result is exactly
 * the boundary of the profile. A cap face whose edge differs by even a micron from the side
 * wall it meets leaves a crack, and cracks are what make solids fail to close.
 */

import { orient2d } from '../math/predicates';
import { dist2, type Vec2, type Vec3 } from '../math/vec';

export interface Profile {
  /** Outer boundary, closed implicitly. Winding is normalised to counter-clockwise. */
  outer: Vec2[];
  /** Interior loops, normalised to clockwise. */
  holes: Vec2[][];
}

export function makeProfile(outer: Vec2[], holes: Vec2[][] = []): Profile {
  return {
    outer: ensureWinding(dedupe(outer), true),
    holes: holes.map((h) => ensureWinding(dedupe(h), false)).filter((h) => h.length >= 3),
  };
}

/** Removes consecutive duplicate points, including the wrap-around pair. */
function dedupe(pts: Vec2[], tol = 1e-9): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    if (out.length === 0 || dist2(out[out.length - 1], p) > tol) out.push(p);
  }
  while (out.length > 1 && dist2(out[0], out[out.length - 1]) <= tol) out.pop();
  return out;
}

/** Twice the signed area. Positive for counter-clockwise. */
export function signedArea2(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a;
}

export const area = (pts: Vec2[]): number => Math.abs(signedArea2(pts)) / 2;

/** Net area of a profile: outer boundary less its holes. */
export function profileArea(p: Profile): number {
  let a = area(p.outer);
  for (const h of p.holes) a -= area(h);
  return Math.max(0, a);
}

export function ensureWinding(pts: Vec2[], ccw: boolean): Vec2[] {
  if (pts.length < 3) return pts;
  const isCcw = signedArea2(pts) > 0;
  return isCcw === ccw ? pts : [...pts].reverse();
}

export function profileCentroid(p: Profile): Vec2 {
  // Area-weighted centroid, holes subtracting. The naive vertex average is wrong for any
  // profile with unevenly distributed vertices, which after arc tessellation is all of them.
  let cx = 0, cy = 0, total = 0;

  const accumulate = (pts: Vec2[], sign: number) => {
    const a2 = signedArea2(pts);
    if (Math.abs(a2) < 1e-18) return;
    let sx = 0, sy = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      const cr = pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
      sx += (pts[i][0] + pts[j][0]) * cr;
      sy += (pts[i][1] + pts[j][1]) * cr;
    }
    const a = a2 / 2;
    cx += sign * (sx / (3 * a2)) * Math.abs(a);
    cy += sign * (sy / (3 * a2)) * Math.abs(a);
    total += sign * Math.abs(a);
  };

  accumulate(p.outer, 1);
  for (const h of p.holes) accumulate(h, -1);

  return total === 0 ? [0, 0] : [cx / total, cy / total];
}

export function profileBounds(p: Profile): { min: Vec2; max: Vec2 } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of p.outer) {
    if (q[0] < minX) minX = q[0];
    if (q[1] < minY) minY = q[1];
    if (q[0] > maxX) maxX = q[0];
    if (q[1] > maxY) maxY = q[1];
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

// ── point containment ────────────────────────────────────────────────────────

/** Crossing-number test. Boundary points are reported inside. */
export function pointInPolygon(pts: Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const yi = pts[i][1], yj = pts[j][1];
    // Strict-on-one-side comparison so a vertex exactly at the test height counts once,
    // not twice or zero times.
    if (yi > p[1] !== yj > p[1]) {
      const x = pts[i][0] + ((p[1] - yi) / (yj - yi)) * (pts[j][0] - pts[i][0]);
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}

export function pointInProfile(prof: Profile, p: Vec2): boolean {
  if (!pointInPolygon(prof.outer, p)) return false;
  for (const h of prof.holes) if (pointInPolygon(h, p)) return false;
  return true;
}

// ── triangulation ────────────────────────────────────────────────────────────

/**
 * Triangulates a profile, returning index triples into a flat vertex list.
 *
 * Holes are bridged into the outer loop first, turning the multiply-connected profile into
 * one simple polygon with coincident bridge edges, which ear clipping can then handle
 * directly. This is the standard approach and is exact enough here because the bridge is
 * chosen between mutually visible vertices, so it never crosses the boundary.
 */
export function triangulate(prof: Profile): { vertices: Vec2[]; triangles: number[] } {
  if (prof.outer.length < 3) return { vertices: [], triangles: [] };

  const { vertices, ring } = bridgeHoles(prof);
  const triangles = earClip(vertices, ring);
  return { vertices, triangles };
}

/**
 * Merges hole loops into the outer loop via mutually visible bridge vertices.
 *
 * Holes are processed right-to-left by their rightmost point. Order matters: taking them in
 * this order guarantees that when a hole is bridged, no not-yet-bridged hole lies between
 * it and the outer boundary along the ray used to find the bridge, so the bridge cannot be
 * blocked by geometry that has not been considered yet.
 */
function bridgeHoles(prof: Profile): { vertices: Vec2[]; ring: number[] } {
  const vertices: Vec2[] = [...prof.outer];
  let ring: number[] = prof.outer.map((_, i) => i);

  const holes = [...prof.holes]
    .map((h) => ({ pts: h, rightmost: h.reduce((best, p, i) => (p[0] > h[best][0] ? i : best), 0) }))
    .sort((a, b) => b.pts[b.rightmost][0] - a.pts[a.rightmost][0]);

  for (const hole of holes) {
    const base = vertices.length;
    vertices.push(...hole.pts);
    const holeRing = hole.pts.map((_, i) => base + i);

    const bridgeHoleIdx = hole.rightmost;
    const holeVertex = hole.pts[bridgeHoleIdx];
    const outerIdx = findVisibleVertex(vertices, ring, holeVertex);
    if (outerIdx < 0) {
      // No visible vertex means the hole is not actually inside the outer loop — malformed
      // input. Dropping the hole is better than emitting a broken triangulation.
      vertices.length = base;
      continue;
    }

    // Splice: outer[0..k], hole[m..end][0..m], outer[k..end]. Both bridge vertices are
    // duplicated, which is what makes the bridge a zero-width channel rather than a cut.
    const rotated = [...holeRing.slice(bridgeHoleIdx), ...holeRing.slice(0, bridgeHoleIdx)];
    ring = [
      ...ring.slice(0, outerIdx + 1),
      ...rotated,
      rotated[0],
      ...ring.slice(outerIdx),
    ];
  }

  return { vertices, ring };
}

/** Finds an outer-ring vertex that the hole vertex can see without crossing the boundary. */
function findVisibleVertex(vertices: Vec2[], ring: number[], from: Vec2): number {
  let best = -1;
  let bestDist = Infinity;

  for (let i = 0; i < ring.length; i++) {
    const cand = vertices[ring[i]];
    if (cand[0] < from[0]) continue; // cast to the right, as the ordering assumes

    const d = dist2(cand, from);
    if (d >= bestDist) continue;
    if (segmentCrossesRing(vertices, ring, from, cand, i)) continue;

    bestDist = d;
    best = i;
  }

  if (best >= 0) return best;

  // Fall back to any visible vertex in any direction before giving up.
  for (let i = 0; i < ring.length; i++) {
    if (!segmentCrossesRing(vertices, ring, from, vertices[ring[i]], i)) return i;
  }
  return -1;
}

function segmentCrossesRing(vertices: Vec2[], ring: number[], a: Vec2, b: Vec2, skip: number): boolean {
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    if (i === skip || j === skip) continue;
    if (segmentsProperlyIntersect(a, b, vertices[ring[i]], vertices[ring[j]])) return true;
  }
  return false;
}

/** True only for a proper crossing; shared endpoints and touching do not count. */
function segmentsProperlyIntersect(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  const d1 = orient2d(p1[0], p1[1], p2[0], p2[1], q1[0], q1[1]);
  const d2 = orient2d(p1[0], p1[1], p2[0], p2[1], q2[0], q2[1]);
  const d3 = orient2d(q1[0], q1[1], q2[0], q2[1], p1[0], p1[1]);
  const d4 = orient2d(q1[0], q1[1], q2[0], q2[1], p2[0], p2[1]);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/**
 * Ear clipping.
 *
 * A vertex is an "ear" when the triangle it forms with its neighbours is convex and
 * contains no other vertex of the polygon. Clipping ears one at a time reduces the polygon
 * by one vertex each pass and terminates in O(n^2), which is more than fast enough for
 * profiles and avoids the substantial complexity of the O(n log n) methods.
 */
function earClip(vertices: Vec2[], ring: number[]): number[] {
  const n = ring.length;
  if (n < 3) return [];

  const triangles: number[] = [];
  const indices = [...ring];

  // Ear clipping requires counter-clockwise input; reverse if bridging produced clockwise.
  const poly = indices.map((i) => vertices[i]);
  if (signedArea2(poly) < 0) indices.reverse();

  // Only reflex vertices can lie inside a candidate ear, so the containment test only ever
  // needs to consider those. This is what makes the triangulator usable on real profiles:
  // a 200-tooth gear has around 5,600 points but only a few hundred reflex ones, and the
  // naive all-pairs version is O(n^3) — it does not finish.
  let reflex = reflexSet(vertices, indices);
  const duplicated = duplicatedIds(indices);

  let guard = indices.length * indices.length + 16;

  while (indices.length > 3 && guard-- > 0) {
    let clipped = false;

    for (let i = 0; i < indices.length; i++) {
      if (!isEar(vertices, indices, i, reflex)) continue;

      const n = indices.length;
      triangles.push(indices[(i - 1 + n) % n], indices[i], indices[(i + 1) % n]);
      indices.splice(i, 1);

      // Removing a vertex can only change the convexity of its two former neighbours,
      // so the reflex set is patched rather than rebuilt.
      const m = indices.length;
      const prevIdx = (i - 1 + m) % m;
      const currIdx = i % m;
      updateReflex(vertices, indices, prevIdx, reflex, duplicated);
      updateReflex(vertices, indices, currIdx, reflex, duplicated);

      clipped = true;
      break;
    }

    if (clipped) continue;

    // No ear found. On well-formed input this cannot happen — every simple polygon has at
    // least two ears — so reaching here means the profile self-intersects. Clipping the
    // most convex vertex anyway guarantees progress and keeps the output a covering of the
    // region. Bailing out to a fan instead would emit overlapping and inverted triangles,
    // which then become a visibly broken cap face on the solid.
    let bestIdx = 0;
    let bestTurn = -Infinity;
    for (let i = 0; i < indices.length; i++) {
      const n = indices.length;
      const a = vertices[indices[(i - 1 + n) % n]];
      const b = vertices[indices[i]];
      const c = vertices[indices[(i + 1) % n]];
      const turn = orient2d(a[0], a[1], b[0], b[1], c[0], c[1]);
      if (turn > bestTurn) { bestTurn = turn; bestIdx = i; }
    }

    const n = indices.length;
    triangles.push(indices[(bestIdx - 1 + n) % n], indices[bestIdx], indices[(bestIdx + 1) % n]);
    indices.splice(bestIdx, 1);
    reflex = reflexSet(vertices, indices);
  }

  for (let i = 1; i + 1 < indices.length; i++) {
    triangles.push(indices[0], indices[i], indices[i + 1]);
  }

  return triangles;
}

/** Vertex ids that are reflex (interior angle above 180 degrees) in the current ring. */
function reflexSet(vertices: Vec2[], indices: number[]): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < indices.length; i++) if (isReflex(vertices, indices, i)) s.add(indices[i]);
  return s;
}

function isReflex(vertices: Vec2[], indices: number[], i: number): boolean {
  const n = indices.length;
  if (n < 3) return false;
  const a = vertices[indices[(i - 1 + n) % n]];
  const b = vertices[indices[i]];
  const c = vertices[indices[(i + 1) % n]];
  return orient2d(a[0], a[1], b[0], b[1], c[0], c[1]) <= 0;
}

function updateReflex(
  vertices: Vec2[], indices: number[], i: number, reflex: Set<number>, duplicated: Set<number>,
): void {
  if (indices.length < 3) return;
  const id = indices[i];

  if (isReflex(vertices, indices, i)) { reflex.add(id); return; }

  // Hole bridging puts the same vertex id in the ring twice. One occurrence can be convex
  // while the other is reflex, and the set is keyed by id, so deleting on behalf of one
  // occurrence could drop a genuinely reflex vertex — and a missed reflex vertex means an
  // invalid ear is accepted and the triangulation overlaps itself. Keeping a duplicated id
  // in the set is merely conservative: it costs a few extra containment tests and cannot
  // produce a wrong result.
  if (!duplicated.has(id)) reflex.delete(id);
}

/** Vertex ids appearing more than once in the ring, i.e. the bridge twins. */
function duplicatedIds(indices: number[]): Set<number> {
  const seen = new Set<number>();
  const dup = new Set<number>();
  for (const id of indices) {
    if (seen.has(id)) dup.add(id);
    else seen.add(id);
  }
  return dup;
}

function isEar(vertices: Vec2[], indices: number[], i: number, reflex: Set<number>): boolean {
  const n = indices.length;
  const ia = indices[(i - 1 + n) % n];
  const ib = indices[i];
  const ic = indices[(i + 1) % n];
  const a = vertices[ia], b = vertices[ib], c = vertices[ic];

  // Reflex or collinear vertices cannot be ears.
  if (orient2d(a[0], a[1], b[0], b[1], c[0], c[1]) <= 0) return false;

  // Bounding box of the candidate triangle, used to reject most reflex vertices with three
  // comparisons instead of three exact orientation tests.
  const minX = Math.min(a[0], b[0], c[0]), maxX = Math.max(a[0], b[0], c[0]);
  const minY = Math.min(a[1], b[1], c[1]), maxY = Math.max(a[1], b[1], c[1]);

  for (const idx of reflex) {
    if (idx === ia || idx === ib || idx === ic) continue;

    const p = vertices[idx];
    if (p[0] < minX || p[0] > maxX || p[1] < minY || p[1] > maxY) continue;

    // Hole bridging deliberately duplicates two vertices so the bridge is a zero-width
    // channel rather than a cut. Those duplicates sit exactly on an ear corner, and
    // treating them as interior points blocks every ear that touches a bridge — which is
    // most of them. The polygon then runs out of ears and the triangulation collapses.
    // Comparing by position rather than by index is what distinguishes a genuine interior
    // vertex from a bridge twin.
    if (samePoint(p, a) || samePoint(p, b) || samePoint(p, c)) continue;

    if (pointInTriangle(p, a, b, c)) return false;
  }
  return true;
}

const samePoint = (p: Vec2, q: Vec2): boolean =>
  Math.abs(p[0] - q[0]) < 1e-12 && Math.abs(p[1] - q[1]) < 1e-12;

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = orient2d(a[0], a[1], b[0], b[1], p[0], p[1]);
  const d2 = orient2d(b[0], b[1], c[0], c[1], p[0], p[1]);
  const d3 = orient2d(c[0], c[1], a[0], a[1], p[0], p[1]);
  return d1 >= 0 && d2 >= 0 && d3 >= 0;
}

// ── primitives ───────────────────────────────────────────────────────────────

export function rectProfile(w: number, h: number, cx = 0, cy = 0, cornerR = 0): Profile {
  const hw = w / 2, hh = h / 2;
  const r = Math.min(cornerR, Math.min(hw, hh));

  if (r <= 1e-9) {
    return makeProfile([
      [cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh],
    ]);
  }

  const pts: Vec2[] = [];
  const segs = arcSegments(r);
  const corners: [number, number, number][] = [
    [cx + hw - r, cy - hh + r, -Math.PI / 2],
    [cx + hw - r, cy + hh - r, 0],
    [cx - hw + r, cy + hh - r, Math.PI / 2],
    [cx - hw + r, cy - hh + r, Math.PI],
  ];
  for (const [ax, ay, start] of corners) {
    for (let i = 0; i <= segs; i++) {
      const t = start + (i / segs) * (Math.PI / 2);
      pts.push([ax + r * Math.cos(t), ay + r * Math.sin(t)]);
    }
  }
  return makeProfile(pts);
}

export function circleProfile(r: number, cx = 0, cy = 0): Profile {
  const segs = arcSegments(r, 2 * Math.PI);
  const pts: Vec2[] = [];
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * 2 * Math.PI;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return makeProfile(pts);
}

export function slotProfile(length: number, width: number, cx = 0, cy = 0, rot = 0): Profile {
  const r = width / 2;
  const half = Math.max(0, length / 2 - r);
  const segs = arcSegments(r);
  const pts: Vec2[] = [];

  for (let i = 0; i <= segs; i++) {
    const t = -Math.PI / 2 + (i / segs) * Math.PI;
    pts.push([half + r * Math.cos(t), r * Math.sin(t)]);
  }
  for (let i = 0; i <= segs; i++) {
    const t = Math.PI / 2 + (i / segs) * Math.PI;
    pts.push([-half + r * Math.cos(t), r * Math.sin(t)]);
  }

  const c = Math.cos(rot), s = Math.sin(rot);
  return makeProfile(pts.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c] as Vec2));
}

export function polygonProfile(sides: number, circumradius: number, cx = 0, cy = 0, rot = 0): Profile {
  const n = Math.max(3, Math.round(sides));
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = rot + (i / n) * 2 * Math.PI;
    pts.push([cx + circumradius * Math.cos(t), cy + circumradius * Math.sin(t)]);
  }
  return makeProfile(pts);
}

/**
 * Segment count for an arc at a given chordal tolerance.
 *
 * Tying tessellation to radius rather than using a fixed count is what stops a 2 mm fillet
 * from looking like a hexagon while a 200 mm bore keeps a sane triangle budget.
 *
 * The default tolerance and the cap are both deliberate. Every segment on a revolved profile
 * becomes a distinct plane, and boolean cost grows superlinearly in the number of planes —
 * a 0.02 mm tolerance on an 80 mm cup gives 101 segments and turns a cavity cut into a
 * multi-second operation for a difference nobody can see. 0.05 mm gives 64 segments on the
 * same cup, which is smoother than a display can show, and the hard cap keeps a large radius
 * from silently producing a body that is expensive to work with for the rest of its life.
 */
export const DEFAULT_CHORD_TOL = 0.05;

/**
 * Named tessellation qualities.
 *
 * The trade is real and unavoidable, so it is exposed rather than hidden. An inscribed
 * n-gon always under-runs the circle it approximates, by a factor of
 * `1 - (n / 2π)·sin(2π/n)` ≈ `2π²/3n²` — about 0.43% at the default on a 15 mm radius.
 * Vertices sit exactly on the nominal radius, so *dimensions* are always exact; it is
 * volume, and therefore mass and material cost, that runs low.
 *
 * Coarser is not a mistake: boolean cost climbs steeply with the number of distinct planes,
 * and a part nobody can finish modelling is worth less than one whose mass is 0.4% light.
 * When the mass matters more than the wait — a quote, a stress input — rebuild at `fine`.
 */
export const CHORD_TOL = {
  /** Fast enough for dragging a parameter. ~0.9% volume deficit at 15 mm radius. */
  draft: 0.15,
  /** The default. ~0.43% at 15 mm radius. */
  normal: DEFAULT_CHORD_TOL,
  /** ~0.11% at 15 mm radius; roughly twice the triangles. */
  fine: 0.0125,
  /** ~0.03%; for mass properties that will be quoted. */
  precise: 0.003,
} as const;

export type TessellationQuality = keyof typeof CHORD_TOL;

/**
 * The relative volume deficit of an inscribed regular n-gon against its circle.
 *
 * Exposed so callers can state the accuracy of a computed mass rather than implying more
 * precision than the tessellation supports.
 */
export const inscribedDeficit = (segments: number): number =>
  segments < 3 ? 1 : 1 - (segments / (2 * Math.PI)) * Math.sin((2 * Math.PI) / segments);

export function arcSegments(radius: number, sweep = Math.PI / 2, tol = DEFAULT_CHORD_TOL): number {
  if (radius <= tol) return 4;
  // Sagitta of a chord subtending theta is r(1 - cos(theta/2)); invert for theta.
  const theta = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / radius)));
  const needed = Math.abs(sweep) / theta;

  // The cap scales with the requested tolerance rather than being a fixed number. At the
  // default it holds a full circle to 96 segments, which keeps booleans tractable; asking
  // for `precise` is an explicit request to pay for accuracy, and a cap that ignored that
  // would silently refuse to deliver the quality the caller selected. Segment count for a
  // given chordal error goes as 1/sqrt(tol), so the cap follows the same law.
  const fullCircleCap = Math.min(720, Math.max(24, Math.round(96 * Math.sqrt(DEFAULT_CHORD_TOL / tol))));
  const cap = Math.max(8, Math.ceil((fullCircleCap * Math.abs(sweep)) / (2 * Math.PI)));

  return Math.max(2, Math.min(cap, Math.ceil(needed)));
}

// ── 2D offset ────────────────────────────────────────────────────────────────

/**
 * Offsets a closed polygon by `d`, positive outward.
 *
 * Straight-skeleton offsetting handles self-intersection properly and is what a production
 * kernel uses. This is the simpler angle-bisector method with a mitre limit, which is
 * correct for convex regions and for the mild concavity of ordinary profiles, and degrades
 * to a rounded corner rather than a spike when the bisector blows up. Its limitation —
 * it does not remove self-intersections created by a large inward offset — is why `shell`
 * validates wall thickness against the profile's minimum feature size before calling it.
 */
export function offsetPolygon(pts: Vec2[], d: number, mitreLimit = 4): Vec2[] {
  const n = pts.length;
  if (n < 3 || Math.abs(d) < 1e-12) return [...pts];

  const ccw = signedArea2(pts) > 0;
  const sign = ccw ? 1 : -1;
  const out: Vec2[] = [];

  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];

    const e1x = curr[0] - prev[0], e1y = curr[1] - prev[1];
    const e2x = next[0] - curr[0], e2y = next[1] - curr[1];
    const l1 = Math.hypot(e1x, e1y), l2 = Math.hypot(e2x, e2y);
    if (l1 < 1e-12 || l2 < 1e-12) { out.push(curr); continue; }

    // Outward normals of the two adjacent edges.
    const n1x = (e1y / l1) * sign, n1y = (-e1x / l1) * sign;
    const n2x = (e2y / l2) * sign, n2y = (-e2x / l2) * sign;

    let bx = n1x + n2x, by = n1y + n2y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) {
      // A 180-degree reversal: the bisector is undefined, so offset along one normal.
      out.push([curr[0] + n1x * d, curr[1] + n1y * d]);
      continue;
    }
    bx /= bl; by /= bl;

    // Scale along the bisector so the offset edges stay parallel at distance d.
    const cosHalf = bx * n1x + by * n1y;
    const scale = Math.abs(cosHalf) < 1e-9 ? mitreLimit : Math.min(1 / cosHalf, mitreLimit);
    out.push([curr[0] + bx * d * scale, curr[1] + by * d * scale]);
  }

  return out;
}

/** Offsets an entire profile: outer outward, holes inward, so a positive `d` grows material. */
export function offsetProfile(p: Profile, d: number): Profile {
  return makeProfile(
    offsetPolygon(p.outer, d),
    p.holes.map((h) => offsetPolygon(h, d)),
  );
}

/** Smallest distance between any two non-adjacent edges — the profile's thinnest feature. */
export function minimumFeatureSize(p: Profile): number {
  const loops = [p.outer, ...p.holes];
  let min = Infinity;

  for (let li = 0; li < loops.length; li++) {
    for (let lj = li; lj < loops.length; lj++) {
      const A = loops[li], B = loops[lj];
      for (let i = 0; i < A.length; i++) {
        for (let j = 0; j < B.length; j++) {
          // Adjacent edges share a vertex, so their distance is always zero and would swamp
          // every real measurement. The wrap-around pair (last, first) is adjacent too, and
          // the check has to be symmetric — testing only `i === 0 && j === last` misses the
          // `i === last, j === 0` ordering, which is why this reported 0 for every closed
          // loop.
          if (li === lj) {
            const n = A.length;
            const gap = Math.abs(i - j);
            if (gap <= 1 || gap === n - 1) continue;
          }
          const d = segmentDistance(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length]);
          if (d < min) min = d;
        }
      }
    }
  }

  return min === Infinity ? 0 : min;
}

function segmentDistance(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): number {
  return Math.min(
    pointSegDistance(a1, b1, b2), pointSegDistance(a2, b1, b2),
    pointSegDistance(b1, a1, a2), pointSegDistance(b2, a1, a2),
  );
}

function pointSegDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-18) return dist2(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// ── corner rounding ──────────────────────────────────────────────────────────

export interface CornerFilletResult {
  loop: Vec2[];
  /** Corners that were rounded, by their index in the input loop. */
  rounded: number[];
  /** Corners skipped because the radius would not fit, with the reason. */
  skipped: { index: number; reason: string }[];
}

/**
 * Replaces sharp corners of a closed loop with tangent arcs.
 *
 * This is a *sketch* fillet, and preferring it over a solid fillet wherever the shape is
 * revolved or extruded is not a shortcut — it is the better construction, and it is what a
 * CAD user does by hand.
 *
 * Filleting a revolved body in 3D means a boolean between two coaxial tessellated revolves,
 * which is the worst case for any BSP: the two surfaces have dozens of nearly-but-not-quite
 * coincident planes, the classifier fragments everything it touches, and a cup rim that
 * should be instant takes over a minute and comes out non-manifold. Rounding the corner in
 * the section first and revolving once afterwards gives the identical geometry — exactly,
 * since the arc is tangent by construction — with no boolean at all.
 *
 * The solid fillet in `ops/modify.ts` remains for prismatic bodies, where the chains are
 * straight and the tools are cheap extrusions.
 */
export function filletCorners(loop: Vec2[], radius: number, indices?: number[]): CornerFilletResult {
  const n = loop.length;
  if (n < 3 || radius <= 1e-9) return { loop: [...loop], rounded: [], skipped: [] };

  const targets = new Set(indices ?? loop.map((_, i) => i));
  const out: Vec2[] = [];
  const rounded: number[] = [];
  const skipped: { index: number; reason: string }[] = [];

  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const curr = loop[i];
    const next = loop[(i + 1) % n];

    if (!targets.has(i)) { out.push(curr); continue; }

    const d1 = sub2(prev, curr);
    const d2 = sub2(next, curr);
    const l1 = len2(d1), l2 = len2(d2);
    if (l1 < 1e-9 || l2 < 1e-9) { out.push(curr); continue; }

    const u1 = norm2(d1), u2 = norm2(d2);

    // Interior angle at this corner.
    const cosT = Math.max(-1, Math.min(1, dot2(u1, u2)));
    const theta = Math.acos(cosT);

    // Nearly straight or fully doubled back: there is no corner to round.
    if (theta < 1e-3 || Math.PI - theta < 1e-3) { out.push(curr); continue; }

    // Distance from the corner to each tangent point.
    const tan = radius / Math.tan(theta / 2);

    // The arc must fit within both adjacent edges, and each edge is shared with its other
    // corner, so only half of it is available here.
    const available = Math.min(l1, l2) / 2;
    if (tan > available) {
      skipped.push({
        index: i,
        reason:
          `a ${radius} mm radius needs ${tan.toFixed(2)} mm of run-out but only ` +
          `${available.toFixed(2)} mm is available before the next corner`,
      });
      out.push(curr);
      continue;
    }

    const t1 = add2(curr, mul2(u1, tan));
    const t2 = add2(curr, mul2(u2, tan));

    // Arc centre lies along the bisector at r / sin(theta/2).
    const bis = norm2(add2(u1, u2));
    const centre = add2(curr, mul2(bis, radius / Math.sin(theta / 2)));

    const a1 = Math.atan2(t1[1] - centre[1], t1[0] - centre[0]);
    const a2 = Math.atan2(t2[1] - centre[1], t2[0] - centre[0]);
    let sweep = a2 - a1;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;

    const segs = arcSegments(radius, Math.abs(sweep));
    for (let k = 0; k <= segs; k++) {
      const t = a1 + (sweep * k) / segs;
      out.push([centre[0] + radius * Math.cos(t), centre[1] + radius * Math.sin(t)]);
    }
    rounded.push(i);
  }

  return { loop: out, rounded, skipped };
}

/** Corner rounding applied to a whole profile, outer loop and holes alike. */
export function filletProfile(p: Profile, radius: number): Profile {
  return makeProfile(
    filletCorners(p.outer, radius).loop,
    p.holes.map((h) => filletCorners(h, radius).loop),
  );
}

const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
const dot2 = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
const len2 = (a: Vec2): number => Math.hypot(a[0], a[1]);
const norm2 = (a: Vec2): Vec2 => {
  const l = len2(a);
  return l < 1e-12 ? [1, 0] : [a[0] / l, a[1] / l];
};

/** Lifts a 2D profile point onto a plane given its origin and in-plane axes. */
export function liftToPlane(p: Vec2, origin: Vec3, u: Vec3, v: Vec3): Vec3 {
  return [
    origin[0] + u[0] * p[0] + v[0] * p[1],
    origin[1] + u[1] * p[0] + v[1] * p[1],
    origin[2] + u[2] * p[0] + v[2] * p[1],
  ];
}

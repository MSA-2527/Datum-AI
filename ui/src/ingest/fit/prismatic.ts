import {
  add3, cross3, dot3, len3, mul3, norm3, sub3, type Vec2, type Vec3,
} from '../../kernel/math/vec';
import {
  bounds, concatMeshes, getTriangle, health, massProperties, surfaceArea, triCount, type Mesh,
} from '../../kernel/topo/mesh';
import { extrude, planeFrom } from '../../kernel/ops/build';
import { makeProfile, pointInPolygon } from '../../kernel/sketch/profile';

/**
 * Recovering an extruded profile from a solid that has no history.
 *
 * The archetype fitter answers "is this one of the catalogue shapes?" and, run against a real
 * library of machined clips and bases, correctly answered no to every part. Those parts are
 * not boxes or washers; they are **a flat outline cut to a thickness, with holes in it** —
 * which is what most of a real mechanical library is, and what no fixed catalogue of shapes
 * will ever cover, because the outline is different every time.
 *
 * So this recovers the outline itself rather than trying to name it. A prismatic solid is
 * exactly two things: a closed 2D profile and a distance. Both are in the mesh, and getting
 * them out turns an imported part into a feature that can be edited, dimensioned, drawn and —
 * because a profile is expressible in the plan vocabulary — **taught**.
 *
 * **What makes a solid prismatic, precisely.** Every one of its faces is either perpendicular
 * to one axis (the two caps) or parallel to it (the walls). That is a property the triangle
 * normals can be measured against directly, and it is a hard test rather than a heuristic: a
 * part with a chamfer, a draft angle or a fillet on a cap edge has area in neither bucket and
 * is refused. Refusing is right — the recovered profile would be the silhouette, and a part
 * rebuilt from it would be a different part.
 *
 * The recovered profile is then **extruded and compared** to the original, the same way the
 * archetype fitter verifies itself, so what comes back is a claim that has been checked.
 */

export interface RecoveredHole {
  /** The loop as traced, in profile coordinates. */
  loop: Vec2[];
  /** Set when the loop is round to within the tessellation — the common case, a drilled hole. */
  circle?: { cx: number; cy: number; r: number };
}

/** One slab of constant cross-section, between two heights along the axis. */
export interface Layer {
  /** Height of the underside, measured from the bottom of the part. */
  from: number;
  to: number;
  /** Outer boundary, anticlockwise. */
  outer: Vec2[];
  holes: RecoveredHole[];
}

export interface Prismatic {
  /** Extrusion direction, unit length. */
  axis: Vec3;
  /**
   * The part as a stack of constant-section slabs, bottom first.
   *
   * One layer is the plain case — an outline cut to a thickness. More than one is a stepped
   * part: a pad, a boss, a counterbore. Describing it as a stack rather than refusing it is
   * the difference between reading half a real library and reading most of it.
   */
  layers: Layer[];
  /** Overall thickness along the axis. */
  thickness: number;
  /** The widest layer's boundary — the part's outline, for the common single-layer case. */
  outer: Vec2[];
  holes: RecoveredHole[];
  /** Agreement between the profile re-extruded and the solid it came from, 0 to 1. */
  agreement: number;
  detail: string;
}

export interface PrismaticResult {
  best: Prismatic | null;
  reason?: string;
}

/** Same bar as the archetype fitter: what is taught has to be what was measured. */
const ACCEPT = 0.97;

/** Tessellation already costs about 0.4% of volume, so agreement is never measured tighter. */
const FLOOR = 0.004;

/**
 * How square to the axis a face has to be to count as a cap or a wall.
 *
 * Tight, and deliberately so. At 0.02 a 1° draft angle still passes and the profile recovered
 * is the wrong size by the draft over the thickness; the parts this is for are cut square.
 */
const SQUARE = 0.01;

/**
 * How much surface an axis may leave unexplained and still be worth trying.
 *
 * Not zero, because a real part has chamfers and edge breaks that no single extrusion
 * describes — the four parts measured from a working library leave between 0.0% and 2.3%.
 * Refusing those outright would refuse the whole library over features that change the volume
 * by a fraction of a percent.
 *
 * It is a gate on what gets *proposed*, not on what is accepted: the profile is re-extruded
 * and compared afterwards, and a part whose chamfers actually matter fails there. What was
 * left out is reported either way, so a fit is never silently approximate.
 */
const MAX_UNEXPLAINED = 0.05;

/**
 * Heights closer together than this are the same face.
 *
 * A tenth of a millimetre. Tessellation puts a fillet's facets at slightly different heights,
 * and treating each as its own level would make every filleted part a twelve-layer stack.
 */
const LEVEL_SNAP = 0.1;

/**
 * How many layers a part may be described in.
 *
 * Beyond a handful, "a stack of slabs" has stopped being a description and become a
 * voxelisation — it would rebuild the solid and teach nothing about how it was designed.
 */
const MAX_LAYERS = 6;

// ── finding the axis ────────────────────────────────────────────────────────

/** A triangle reduced to what the axis search needs. */
interface Facet { normal: Vec3; area: number }

function facetsOf(mesh: Mesh): { facets: Facet[]; total: number } {
  const facets: Facet[] = [];
  let total = 0;

  for (let t = 0; t < triCount(mesh); t++) {
    const [a, b, c] = getTriangle(mesh, t);
    const n = cross3(sub3(b, a), sub3(c, a));
    const area = len3(n) / 2;
    if (area < 1e-12) continue;
    facets.push({ normal: norm3(n), area });
    total += area;
  }

  return { facets, total };
}

/** How much of the surface an axis fails to explain, as cap or as wall. */
function unexplained(facets: Facet[], total: number, axis: Vec3): number {
  let other = 0;
  for (const f of facets) {
    const along = dot3(f.normal, axis);
    if (Math.abs(along) > 1 - SQUARE) continue;          // a cap
    if (Math.abs(along) < SQUARE) continue;              // a wall
    other += f.area;
  }
  return total < 1e-12 ? 1 : other / total;
}

/**
 * Directions worth testing as the extrusion axis, best first.
 *
 * The candidates are the face normals themselves: an extruded solid's caps are normal to its
 * axis, so if the solid is prismatic at all, its axis is already one of the directions its
 * triangles point in.
 *
 * They are ranked by **how well each one explains the solid**, not by how much area points
 * that way — and the difference is the whole of it. Ranking by area assumes the caps are the
 * biggest faces, which holds for a plate and fails for exactly the parts this exists to read:
 * on a real clip, thin and full of edge, the caps are 6% of the surface and the cap normal
 * ranked thirty-second. Taking the top few by area found nothing on three of four real parts
 * that are, in fact, prismatic to better than one percent.
 */
function candidateAxes(mesh: Mesh): { axes: Vec3[]; facets: Facet[]; total: number } {
  const { facets, total } = facetsOf(mesh);

  const directions: Vec3[] = [];
  for (const f of facets) {
    // Opposite normals are the same axis: the two caps of a plate point away from each other.
    if (!directions.some((d) => Math.abs(dot3(d, f.normal)) > 0.9999)) directions.push(f.normal);
  }

  const axes = directions
    .map((dir) => ({ dir, miss: unexplained(facets, total, dir) }))
    .filter((x) => x.miss <= MAX_UNEXPLAINED)
    .sort((x, y) => x.miss - y.miss)
    .slice(0, 4)
    .map((x) => x.dir);

  return { axes, facets, total };
}

// ── slicing ─────────────────────────────────────────────────────────────────

/**
 * The solid's cross-section at one height, as closed loops in the profile plane.
 *
 * This replaced tracing the boundary of the cap triangles, and the reason is stepped parts.
 * A cap trace answers "what is the outline of the top face", which is the whole part only
 * when the part has one top face; on a stepped part it silently returns the union of several
 * silhouettes at different heights. A slice answers "what is the cross-section *here*", which
 * is the right question at every height and the only one that generalises.
 *
 * It is also more robust: slicing needs no triangle adjacency, so a mesh with a crack in it —
 * which a real import sometimes is — still sections correctly.
 *
 * Every wall triangle spanning the height contributes one segment; the segments are then
 * chained end to end into loops. Holes fall out on their own, as loops of their own.
 */
function sliceAt(
  mesh: Mesh, axis: Vec3, height: number, toPlane: (p: Vec3) => Vec2, origin3: Vec3,
): Vec2[][] {
  const segments: [Vec2, Vec2][] = [];

  for (let t = 0; t < triCount(mesh); t++) {
    const tri = getTriangle(mesh, t);
    const h = tri.map((p) => dot3(p, axis));

    // Where the plane cuts each edge. A triangle lying in the plane contributes nothing: its
    // neighbours perpendicular to it carry the section, and including it would double the
    // segments along that stretch.
    const hits: Vec2[] = [];
    for (let k = 0; k < 3; k++) {
      const a = h[k]!;
      const b = h[(k + 1) % 3]!;
      if ((a > height) === (b > height)) continue;
      if (Math.abs(b - a) < 1e-12) continue;

      const f = (height - a) / (b - a);
      const p = tri[k]!;
      const q = tri[(k + 1) % 3]!;
      hits.push(toPlane([
        p[0] + (q[0] - p[0]) * f,
        p[1] + (q[1] - p[1]) * f,
        p[2] + (q[2] - p[2]) * f,
      ]));
    }

    if (hits.length !== 2) continue;

    /*
     * Pointed the way the boundary runs, not the way the edges happened to be indexed.
     *
     * A segment cut from a triangle comes out in whichever order that triangle's vertices were
     * written, which is arbitrary. Chained as they come, half the segments run backwards, the
     * ends do not meet, and the loops close on themselves early — a square sectioned into
     * eight fragments instead of one loop of four.
     *
     * The face's own outward normal fixes it. Turning that normal a quarter turn about the
     * axis gives the direction along the boundary with material on the left, which is the
     * convention the profile builder wants: outer loops anticlockwise, holes clockwise, and
     * both falling out of the same rule rather than being sorted out afterwards.
     */
    const n = cross3(sub3(tri[1]!, tri[0]!), sub3(tri[2]!, tri[0]!));
    if (len3(n) < 1e-12) continue;

    const tangent = cross3(axis, norm3(n));
    const along = toPlane([
      tangent[0] + origin3[0], tangent[1] + origin3[1], tangent[2] + origin3[2],
    ]);

    const delta: Vec2 = [hits[1]![0] - hits[0]![0], hits[1]![1] - hits[0]![1]];
    const forward = delta[0] * along[0] + delta[1] * along[1] >= 0;

    segments.push(forward ? [hits[0]!, hits[1]!] : [hits[1]!, hits[0]!]);
  }

  return chain(segments);
}

/**
 * Loose segments joined end to end into closed loops.
 *
 * Endpoints are matched on a quantised grid rather than by search: the segments come from
 * triangles that share vertices exactly, so their ends coincide to floating-point noise, and
 * a hash is both faster and less fragile than a nearest-neighbour test with a radius.
 */
function chain(segments: [Vec2, Vec2][]): Vec2[][] {
  const SNAP = 1e-6;
  const key = (p: Vec2) => `${Math.round(p[0] / SNAP)}:${Math.round(p[1] / SNAP)}`;

  const from = new Map<string, [Vec2, Vec2][]>();
  for (const seg of segments) {
    const k = key(seg[0]);
    const list = from.get(k);
    if (list) list.push(seg);
    else from.set(k, [seg]);
  }

  const used = new Set<[Vec2, Vec2]>();
  const loops: Vec2[][] = [];

  for (const seed of segments) {
    if (used.has(seed)) continue;

    const loop: Vec2[] = [seed[0]];
    let at = seed;
    used.add(at);

    for (let guard = 0; guard < segments.length + 1; guard++) {
      loop.push(at[1]);
      const onward = (from.get(key(at[1])) ?? []).find((c) => !used.has(c));
      if (!onward) break;
      used.add(onward);
      at = onward;
      if (key(at[0]) === key(seed[0])) break;
    }

    // Only closed loops describe a region. An open chain is the mark of a mesh with a gap,
    // and closing it by assumption would invent an edge the part does not have.
    if (loop.length >= 4 && key(loop[loop.length - 1]!) === key(loop[0]!)) {
      loops.push(loop.slice(0, -1));
    }
  }

  return loops;
}

const signedArea = (pts: Vec2[]): number => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j]![0] * pts[i]![1] - pts[i]![0] * pts[j]![1];
  }
  return a / 2;
};

/**
 * A loop as a circle, when it is one.
 *
 * Drilled holes are the overwhelmingly common interior feature and they arrive as polygons —
 * a ⌀5 mm hole is a dodecagon at this tessellation. Recovering the circle matters beyond
 * tidiness: it is the difference between a part whose holes can be re-dimensioned, counted by
 * the manufacturability rules and matched against stock drill sizes, and one carrying
 * forty-eight anonymous line segments.
 *
 * The radius is taken as the **circumradius**, not the mean: an inscribed polygon's vertices
 * sit on the true circle while its edges cut inside, so the vertices are the honest measure.
 */
function asCircle(loop: Vec2[]): RecoveredHole['circle'] {
  const n = loop.length;
  if (n < 6) return undefined;                     // too few sides to call it round

  const cx = loop.reduce((s, p) => s + p[0], 0) / n;
  const cy = loop.reduce((s, p) => s + p[1], 0) / n;

  const radii = loop.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
  const max = Math.max(...radii);
  const min = Math.min(...radii);
  if (max < 1e-9) return undefined;

  // Vertices of a regular polygon are all at the circumradius; anything else is not a circle.
  if ((max - min) / max > 0.02) return undefined;

  return { cx, cy, r: max };
}

// ── the entry point ─────────────────────────────────────────────────────────

export interface PrismaticOptions {
  accept?: number;
}

export function fitPrismatic(mesh: Mesh, options: PrismaticOptions = {}): PrismaticResult {
  const accept = options.accept ?? ACCEPT;
  const total = triCount(mesh);
  if (total === 0) return { best: null, reason: 'There is no geometry to read.' };

  /*
   * A section is only as trustworthy as the solid it is cut from.
   *
   * Slicing counts how many times the plane crosses the surface, so on a solid with a doubled
   * or missing face the count is wrong and the cross-section comes back the wrong size — with
   * nothing about it looking wrong. One part from a real library imports non-manifold and
   * sections to two thirds of its true area, which reads as "the profile is a poor fit" when
   * the truth is that the input was not a solid.
   *
   * Saying which it is matters: one is a limit of this reader, the other points at the import.
   */
  const state = health(mesh);
  if (!state.closed || !state.manifold) {
    return {
      best: null,
      reason:
        `This solid is not sound — ${state.boundaryEdges} open and `
        + `${state.nonManifoldEdges} non-manifold edges — so a section through it cannot be `
        + 'trusted and neither can a profile traced from one. The part needs to import '
        + 'cleanly before it can be recognised.',
    };
  }

  const measured = {
    volume: Math.abs(massProperties(mesh).volume),
    area: surfaceArea(mesh),
    inertia: normalisedInertia(mesh),
  };

  const { axes, facets, total: totalArea } = candidateAxes(mesh);
  let closest: Prismatic | null = null;
  let stepped = 0;

  for (const axis of axes) {
    const attempt = tryAxis(mesh, axis, measured, unexplained(facets, totalArea, axis));
    if (!attempt) continue;

    if (isStepped(attempt)) { stepped = Math.max(stepped, attempt.stepped); continue; }
    if (!closest || attempt.agreement > closest.agreement) closest = attempt;
    if (attempt.agreement >= accept) return { best: attempt };
  }

  if (closest) {
    return {
      best: null,
      reason:
        `The closest extruded profile agrees ${(closest.agreement * 100).toFixed(1)}% `
        + `(${closest.detail}), below the ${(accept * 100).toFixed(0)}% needed.`,
    };
  }

  if (stepped > 1) {
    return {
      best: null,
      reason:
        `This part sections into ${stepped} slabs of differing shape along the one axis its `
        + 'walls are square to. Past a handful, a stack of slabs has stopped describing how '
        + 'the part was designed and become a voxelisation of it.',
    };
  }

  return {
    best: null,
    reason:
      'This is not a prismatic part: its faces are neither square to one axis nor parallel to '
      + 'it, so there is no direction it could have been extruded along.',
  };
}

/** A stepped part is refused with the fact that refused it, not with a low score. */
type Attempt = Prismatic | { stepped: number } | null;

const isStepped = (a: Attempt): a is { stepped: number } =>
  a !== null && 'stepped' in a;

function tryAxis(
  mesh: Mesh, axis: Vec3,
  measured: { volume: number; area: number; inertia: [number, number, number] },
  ignored: number,
): Attempt {
  // The heights at which the cross-section changes are the heights of the faces square to the
  // axis: nothing else can change it, because every other face is parallel to the axis.
  const levels: number[] = [];
  for (let t = 0; t < triCount(mesh); t++) {
    const tri = getTriangle(mesh, t);
    const n = cross3(sub3(tri[1]!, tri[0]!), sub3(tri[2]!, tri[0]!));
    if (len3(n) / 2 < 1e-12) continue;
    if (Math.abs(dot3(norm3(n), axis)) < 1 - SQUARE) continue;

    const h = dot3(tri[0]!, axis);
    if (!levels.some((l) => Math.abs(l - h) < LEVEL_SNAP)) levels.push(h);
  }

  if (levels.length < 2) return null;
  levels.sort((a, b) => a - b);

  /*
   * Levels closer together than a fiftieth of the part are the same level.
   *
   * An absolute tolerance cannot serve here: 0.1 mm is generous on a 6 mm clip and invisible
   * on a 300 mm panel. Measured against a real part, the fixed value turned the two 0.17 mm
   * bands of an edge break into layers of their own — a fifteen-millimetre part described as
   * four slabs, two of which were chamfers, and a union of them that failed outright.
   *
   * A chamfer is not a step. Snapping relatively says so at every scale.
   */
  const span = levels[levels.length - 1]! - levels[0]!;
  const snap = Math.max(LEVEL_SNAP, span * 0.02);

  const merged: number[] = [levels[0]!];
  for (const h of levels.slice(1)) {
    if (h - merged[merged.length - 1]! >= snap) merged.push(h);
  }
  levels.length = 0;
  levels.push(...merged);
  if (levels.length < 2) return null;

  const b = bounds(mesh);
  const away: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm3(sub3(away, mul3(axis, dot3(away, axis))));
  const v = cross3(axis, u);
  const origin = mul3(axis, dot3(b.min, axis));

  const toPlane = (p: Vec3): Vec2 => {
    const d = sub3(p, origin);
    return [dot3(d, u), dot3(d, v)];
  };

  // One layer per gap between consecutive levels, sectioned at its middle. A gap with no
  // material sections to nothing and is dropped, which is what an undercut or a through
  // opening between two solid layers looks like.
  const layers: Layer[] = [];
  const base = dot3(b.min, axis);

  for (let i = 0; i < levels.length - 1; i++) {
    const from = levels[i]!;
    const to = levels[i + 1]!;
    if (to - from < LEVEL_SNAP) continue;

    const loops = sliceAt(mesh, axis, (from + to) / 2, toPlane, origin);
    if (loops.length === 0) continue;

    /*
     * Solid regions and holes are told apart by **winding**, not by size.
     *
     * Taking the biggest loop as the outline and everything else as a hole is the obvious
     * rule and it is wrong on any part whose section is in two pieces — a clip with two
     * lobes, a bracket with two feet. The second lobe is solid, and subtracting it removed
     * material instead of adding it: two real parts rebuilt at a quarter and two-thirds of
     * their true volume, which is exactly what that mistake looks like.
     *
     * The slice already knows. Every segment is turned so material lies to its left, so an
     * outer boundary comes back anticlockwise and a hole clockwise. Reading the sign is both
     * simpler than comparing areas and right in the cases comparing areas gets wrong.
     */
    const solid = loops.filter((l) => signedArea(l) > 0);
    const voids = loops.filter((l) => signedArea(l) < 0);
    if (solid.length === 0) continue;

    for (const outer of solid) {
      // A hole belongs to the region that contains it. With one region this is every hole;
      // with two it is the difference between a bored lobe and a bored neighbour.
      const mine = voids.filter((v) => v[0] && pointInPolygon(outer, v[0]!));

      layers.push({
        from: from - base,
        to: to - base,
        outer,
        holes: mine.map((loop) => {
          const circle = asCircle(loop);
          return circle ? { loop, circle } : { loop };
        }),
      });
    }
  }

  if (layers.length === 0) return null;
  const bands = new Set(layers.map((l) => l.from)).size;
  if (bands > MAX_LAYERS) return { stepped: bands };

  /*
   * ── verify: rebuild every layer and compare the stack to the solid it came from ──
   *
   * The slabs are **concatenated, not unioned**, and that is not a shortcut.
   *
   * Stacked slabs meet face to face, and where a pad sits flush with the edge of its base
   * their side walls are coplanar too. A union across coplanar faces is the case every
   * boolean engine finds hardest, and on a real two-step part it produced an open solid with
   * five hundred non-manifold edges — so the part was reported unreadable when it had in fact
   * been read correctly. Nudging the slabs apart along the axis does not help, because the
   * coplanarity is in the side walls, and nudging them sideways would change the part.
   *
   * A union is not needed. The slabs occupy disjoint volumes, so volume and inertia are
   * *additive* — both come from the divergence theorem, which sums over closed bodies — and
   * concatenating gives exactly the right figures for both.
   *
   * What concatenation does not give is surface area: the interfaces between slabs are
   * present twice and are not on the outside of anything. So area is only weighed for a
   * single-layer part, where there are no interfaces, and the multi-layer score rests on the
   * two measures that stay exact.
   */
  const slabs: Mesh[] = [];

  for (const layer of layers) {
    const profile = makeProfile(layer.outer, layer.holes.map((h) => h.loop));
    const at = add3(origin, mul3(axis, layer.from));

    const slab = extrude(profile, planeFrom(at, axis, u), {
      distance: layer.to - layer.from, feature: 'Recovered',
    });
    if (!slab || triCount(slab) === 0) return null;
    slabs.push(slab);
  }

  const rebuilt = slabs.length === 1 ? slabs[0]! : concatMeshes(slabs);
  if (!rebuilt || triCount(rebuilt) === 0) return null;

  const single = layers.length === 1;
  const volume = agree(measured.volume, Math.abs(massProperties(rebuilt).volume));
  const rebuiltInertia = normalisedInertia(rebuilt);
  const inside = measured.inertia.reduce((acc, x, i) => acc + agree(x, rebuiltInertia[i]!), 0) / 3;
  const area = single ? agree(measured.area, surfaceArea(rebuilt)) : 1;

  const holes = layers.reduce((n, l) => n + l.holes.length, 0);
  const round = layers.reduce((n, l) => n + l.holes.filter((h) => h.circle).length, 0);
  const first = layers.reduce((biggest, l) =>
    (Math.abs(signedArea(l.outer)) > Math.abs(signedArea(biggest.outer)) ? l : biggest));

  return {
    axis,
    layers,
    outer: first.outer,
    holes: first.holes,
    thickness: Math.max(...layers.map((l) => l.to)) - Math.min(...layers.map((l) => l.from)),
    agreement: single ? volume * 0.45 + inside * 0.3 + area * 0.25 : volume * 0.6 + inside * 0.4,
    detail:
      `volume ${(volume * 100).toFixed(1)}%, inertia ${(inside * 100).toFixed(1)}%, `
      + (single ? `surface ${(area * 100).toFixed(1)}%; ` : '')
      + (layers.length === 1
        ? `${first.outer.length} outline points`
        : `${new Set(layers.map((l) => l.from)).size} levels in ${layers.length} regions, `
          + `${first.outer.length} points at the widest`)
      + `, ${holes} hole${holes === 1 ? '' : 's'} (${round} round)`
      // Said whether or not it mattered to the score. A profile is a claim that the part is
      // this outline cut to this thickness, and anything the outline does not carry is part
      // of the claim being wrong.
      + (ignored > 0.001
        ? `; ${(ignored * 100).toFixed(1)}% of the surface is chamfer or blend, not represented`
        : ''),
  };
}

function agree(a: number, b: number): number {
  const hi = Math.max(Math.abs(a), Math.abs(b));
  if (hi < 1e-9) return 1;
  return Math.max(0, 1 - Math.max(0, Math.abs(a - b) / hi - FLOOR));
}

function normalisedInertia(mesh: Mesh): [number, number, number] {
  const m = massProperties(mesh);
  const scale = Math.max(Math.abs(m.volume) ** (5 / 3), 1e-12);
  return m.principal.map((x) => x / scale) as [number, number, number];
}

// ── turning a recovered profile into a feature ──────────────────────────────

/**
 * The sketch a recovered profile describes, as the document's own wire form.
 *
 * Points and lines for the outline, circles for the holes that are round. Written through the
 * sketch model rather than as a bespoke parameter because that is what makes the result a
 * *part* rather than a picture of one: the outline can be dragged, the holes re-dimensioned,
 * constraints added, and the whole thing rebuilt — and a sketch is already storable in a
 * document parameter, which is what lets a recovered part be taught.
 */
export function sketchJsonFor(layer: Layer): string {
  const entities: unknown[] = [];
  const constraints: unknown[] = [];
  let next = 0;
  const id = (prefix: string) => `${prefix}${++next}`;

  const polyline = (loop: Vec2[]) => {
    const points = loop.map((p) => {
      const pid = id('p');
      // Fixed, because a traced point is a *measurement*. Left free, the solver reports the
      // profile as under-constrained with dozens of degrees of freedom — true of a sketch
      // somebody drew and meaningless for one read off a solid, and it surfaced as a warning
      // in place of the result. Nothing here is undetermined; it was all measured.
      entities.push({ id: pid, kind: 'point', x: p[0], y: p[1], fixed: true });
      return pid;
    });

    for (let i = 0; i < points.length; i++) {
      entities.push({
        id: id('l'),
        kind: 'line',
        start: points[i]!,
        end: points[(i + 1) % points.length]!,
      });
    }
  };

  polyline(layer.outer);

  for (const hole of layer.holes) {
    if (hole.circle) {
      const centre = id('p');
      entities.push({
        id: centre, kind: 'point', x: hole.circle.cx, y: hole.circle.cy, fixed: true,
      });

      const circle = id('c');
      entities.push({ id: circle, kind: 'circle', centre, radius: hole.circle.r });

      // A measured diameter, stated as a constraint rather than left as a free variable, so
      // the profile comes back fully determined — and so changing it is an edit to a
      // dimension rather than a drag.
      constraints.push({
        id: id('k'), kind: 'radius', entities: [circle], value: hole.circle.r,
      });
    } else {
      // A shaped cut-out — a slot, a keyway — kept as its traced outline.
      polyline(hole.loop);
    }
  }

  return JSON.stringify({ v: 1, entities, constraints });
}

export interface RecoveredFeature {
  kind: 'sketch';
  params: Record<string, number | string>;
  name: string;
  /** Where the slab sits along the axis, measured from the bottom of the part. */
  offset: number;
}

/**
 * The document features a recovered part describes — one per layer.
 *
 * A plain part is one feature. A stepped one is a base and the pads on top of it, in the
 * order they stack, which is how somebody would have modelled it in the first place: a
 * profile, then another profile on the face it left.
 */
export function featuresFromPrismatic(fit: Prismatic): RecoveredFeature[] {
  return fit.layers.map((layer, i) => ({
    kind: 'sketch' as const,
    params: {
      plane: 'XY',
      sketch: sketchJsonFor(layer),
      distance: layer.to - layer.from,
      draft: 0,
      operation: 'add',
    },
    name: fit.layers.length === 1
      ? `Profile ${layer.outer.length} pts, ${layer.holes.length} holes`
      : `Layer ${i + 1} of ${fit.layers.length} — ${layer.holes.length} holes`,
    offset: layer.from,
  }));
}

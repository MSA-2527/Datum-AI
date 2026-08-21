/**
 * Drawing freely, and getting geometry rather than a scribble.
 *
 * ── The complaint this answers ──
 *
 * The sketch editor offered a line, a rectangle, a circle, an arc, a hexagon and a slot, and
 * nothing else. Every one of those is a shape you *choose*, and between them they cover most of
 * what a mechanical part is — which is why the editor was built that way and why it stays. But
 * they do not cover the way people actually start: you drag a shape you have in your head, then
 * you make it exact. Told to pick a rectangle first, you are being asked to have finished
 * thinking before you begin.
 *
 * ── Why this is not a polyline tool ──
 *
 * The obvious implementation records the pointer's path and keeps it. That gives a curve made of
 * four hundred segments: it cannot be dimensioned, cannot be constrained, cannot be filleted,
 * cannot be quoted, and the moment it is exported the shop asks what R it is. A freehand tool
 * that produces that has not made the editor freer, it has added a way to produce something the
 * rest of the application cannot work with.
 *
 * So a stroke is *recognised*, using the same fitting that turns a traced photograph into a
 * manufacturable profile: simplify the path, then find the runs of points that are a straight
 * line and the runs that are an arc of a definite radius. What comes out is lines and arcs —
 * ordinary sketch entities, joined end to end, each dimensionable and constrainable like any
 * other. You draw the shape; the sketch holds real geometry.
 *
 * ── What it will not do ──
 *
 * Smooth a stroke into something you did not draw. The tolerance is stated in sketch units and
 * a run of points only becomes a line or an arc when it fits within it; anything that does not
 * stays as the points that were drawn, joined by short lines. Better a faithful polyline in the
 * one place it is warranted than a confident arc through a shape nobody drew.
 */

import { fitSegments, simplifyLoop } from '../../ingest/image/trace';
import type { Vec2 } from '../math/vec';
import type { Sketch, SketchEntity, EntityId } from './solver';

export interface FreehandOptions {
  /**
   * How far a drawn point may sit from the line or arc that replaces it, in sketch units.
   *
   * The one number that decides whether this is a recogniser or a smoother. Too tight and every
   * stroke stays a polyline; too loose and a deliberate dog-leg becomes a gentle arc. Scaled by
   * the caller to the sketch's own size, because a millimetre is a lot on a watch part.
   */
  tolerance?: number;
  /** Close the stroke back to its start when the ends come within this distance. */
  closeWithin?: number;
  /** Prefix for generated entity ids, so a caller can keep them apart. */
  prefix?: string;
}

export interface FreehandResult {
  entities: SketchEntity[];
  /** Ids of the entities in drawing order, for selecting what was just drawn. */
  order: EntityId[];
  lines: number;
  arcs: number;
  /** True when the ends were joined, so the stroke encloses an area. */
  closed: boolean;
  /** Ready to show: "3 lines and 1 arc, closed". */
  summary: string;
}

const DEFAULT_TOLERANCE = 1.5;

/**
 * Turns a drawn path into sketch entities.
 *
 * The path is in sketch coordinates already: the caller knows about the canvas and this does not.
 */
export function freehandToEntities(
  path: Vec2[], options: FreehandOptions = {},
): FreehandResult | null {
  const cleaned = dedupe(path);
  if (cleaned.length < 2) return null;

  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const prefix = options.prefix ?? 'fh';

  /*
   * Closed before fitting, not after.
   *
   * A stroke whose ends nearly meet is a closed outline that was drawn by hand, and joining it
   * afterwards leaves a short segment across the gap that no one drew — usually at an angle to
   * both its neighbours, and always the first thing anyone tries to delete. Closing first lets
   * the fitter see the join as part of the run it belongs to.
   */
  const gap = distance(cleaned[0]!, cleaned[cleaned.length - 1]!);
  const closeWithin = options.closeWithin ?? tolerance * 4;
  const closed = cleaned.length > 3 && gap <= closeWithin;

  const loop = closed ? [...cleaned, cleaned[0]!] : cleaned;

  // Simplified first so the fitter sees a run of meaningful points rather than pointer jitter,
  // which is what makes a hand-drawn straight edge come out as one line instead of forty.
  const simplified = simplifyLoop(loop, tolerance * 0.5);
  if (simplified.length < 2) return null;

  const segments = fitSegments(simplified, tolerance);

  const entities: SketchEntity[] = [];
  const order: EntityId[] = [];
  const points = new Map<string, EntityId>();
  let next = 0;

  const id = () => `${prefix}${next++}`;

  /*
   * Shared endpoints, so the chain is a chain.
   *
   * Two segments that meet must reference *the same point entity*, or the sketch has two points
   * at one coordinate and dragging one leaves a gap — and the profile it makes is open, so it
   * cannot be extruded. Keyed on the rounded coordinate, which is exactly the tolerance at which
   * the fitter itself considers two positions the same.
   */
  const pointAt = (p: Vec2): EntityId => {
    const key = `${round(p[0])},${round(p[1])}`;
    const seen = points.get(key);
    if (seen) return seen;

    const pid = id();
    points.set(key, pid);
    entities.push({ id: pid, kind: 'point', x: p[0], y: p[1] });
    return pid;
  };

  let lines = 0;
  let arcs = 0;

  for (const segment of segments) {
    if (segment.kind === 'line') {
      const eid = id();
      entities.push({
        id: eid, kind: 'line', start: pointAt(segment.start), end: pointAt(segment.end),
      });
      order.push(eid);
      lines++;
      continue;
    }

    if (segment.kind === 'arc') {
      /*
       * An arc is three points, not a centre and two angles.
       *
       * The solver holds an arc as a centre, a start and an end — all of them point entities it
       * can move — because that is what makes an arc *solvable*: a radius stored as a number is
       * a fact nothing can adjust, and a constraint that wants to change it has nowhere to write.
       * The fitter reports a centre and two angles, so the ends are placed on the circle here.
       */
      const at = (angle: number): Vec2 => [
        segment.centre[0] + segment.radiusMm * Math.cos(angle),
        segment.centre[1] + segment.radiusMm * Math.sin(angle),
      ];

      const eid = id();
      entities.push({
        id: eid,
        kind: 'arc',
        centre: pointAt(segment.centre),
        start: pointAt(at(segment.startAngle)),
        end: pointAt(at(segment.endAngle)),
      });
      order.push(eid);
      arcs++;
      continue;
    }

    // Nothing fitted: keep what was drawn, as short lines between the points that were drawn.
    // A faithful polyline is the honest answer where no line and no arc describes the stroke.
    for (let i = 0; i + 1 < segment.points.length; i++) {
      const eid = id();
      entities.push({
        id: eid,
        kind: 'line',
        start: pointAt(segment.points[i]!),
        end: pointAt(segment.points[i + 1]!),
      });
      order.push(eid);
      lines++;
    }
  }

  /*
   * The closing edge, added rather than implied.
   *
   * `simplifyLoop` returns a loop with its closing point *implied* — four corners for a square —
   * and `fitSegments` reads a list as an open run, so it fits three segments between four points.
   * A hand-drawn square came back as three lines with one side missing: complete on screen, and
   * not a closed profile, so it will not extrude.
   *
   * Joined here with one line rather than by repeating the first point before fitting. Repeating
   * it gives the fitter a five-point ring that its circle fit is only too happy to accept, and a
   * hand-drawn square comes back as one arc — which is worse, and worse in the confident way.
   */
  if (closed && order.length > 0) {
    const first = simplified[0]!;
    const last = simplified[simplified.length - 1]!;

    if (distance(first, last) > 1e-9) {
      const eid = id();
      entities.push({ id: eid, kind: 'line', start: pointAt(last), end: pointAt(first) });
      order.push(eid);
      lines++;
    }
  }

  if (order.length === 0) return null;

  return {
    entities,
    order,
    lines,
    arcs,
    closed,
    summary: describe(lines, arcs, closed),
  };
}

/** Adds a drawn stroke to a sketch, returning the sketch with it in. */
export function addFreehand(
  sketch: Sketch, path: Vec2[], options: FreehandOptions = {},
): { sketch: Sketch; result: FreehandResult } | null {
  // A prefix from the sketch's own size, so two strokes never collide on an id.
  const drawn = freehandToEntities(path, {
    ...options,
    prefix: options.prefix ?? `f${sketch.entities.size}_`,
  });
  if (!drawn) return null;

  const entities = new Map(sketch.entities);
  for (const entity of drawn.entities) entities.set(entity.id, entity);

  return { sketch: { entities, constraints: [...sketch.constraints] }, result: drawn };
}

// ── odds and ends ────────────────────────────────────────────────────────────

const round = (v: number): number => Math.round(v * 1000) / 1000;
const distance = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Drops repeated points, which a pointer produces whenever it pauses. */
function dedupe(path: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of path) {
    const last = out[out.length - 1];
    if (!last || distance(last, p) > 1e-9) out.push(p);
  }
  return out;
}

function describe(lines: number, arcs: number, closed: boolean): string {
  const parts: string[] = [];
  if (lines > 0) parts.push(`${lines} line${lines === 1 ? '' : 's'}`);
  if (arcs > 0) parts.push(`${arcs} arc${arcs === 1 ? '' : 's'}`);

  const what = parts.length === 2 ? parts.join(' and ') : parts[0] ?? 'nothing';
  return `${what}${closed ? ', closed' : ''}`;
}

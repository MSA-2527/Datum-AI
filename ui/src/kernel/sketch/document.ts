/**
 * Sketches as document data.
 *
 * The constraint solver has been in this codebase for a long time and nothing has ever called
 * it. That is the gap between DATUM and a CAD package, stated as plainly as it can be: real
 * parametric modelling is *draw a profile, constrain it, extrude it, and let the constraints
 * keep driving it*. Picking a primitive and typing numbers into a box is not that. A dimension
 * you type into a primitive changes one number; a dimension on a sketch propagates through
 * every relation that depends on it.
 *
 * This file is the bridge. It turns a sketch into something a document can carry — parameters
 * are plain JSON by design, so the sketch travels as a JSON string rather than as a Map — and
 * turns a solved sketch back into a profile the kernel can extrude.
 */

import { type Vec2 } from '../math/vec';
import { makeProfile, signedArea2, type Profile } from './profile';
import {
  emptySketch, solve,
  type Constraint, type EntityId, type Sketch, type SketchEntity, type SolveResult,
} from './solver';

/** The wire form: arrays and plain objects, safe to put in a document parameter. */
interface StoredSketch {
  v: 1;
  entities: SketchEntity[];
  constraints: Constraint[];
}

export function sketchToJson(s: Sketch): string {
  const stored: StoredSketch = {
    v: 1,
    entities: [...s.entities.values()],
    constraints: s.constraints,
  };
  return JSON.stringify(stored);
}

/**
 * Reads a sketch back.
 *
 * Returns an empty sketch rather than throwing on anything malformed. A document that fails to
 * open because one feature's data is unreadable is far worse than one feature building nothing
 * and saying so — the rest of the tree is still the user's work.
 */
export function sketchFromJson(text: string): Sketch {
  const s = emptySketch();
  if (!text) return s;

  try {
    const raw = JSON.parse(text) as Partial<StoredSketch>;
    if (!Array.isArray(raw.entities)) return s;

    for (const e of raw.entities) {
      if (e && typeof e.id === 'string') s.entities.set(e.id, e);
    }
    if (Array.isArray(raw.constraints)) {
      for (const c of raw.constraints) {
        if (c && typeof c.id === 'string' && Array.isArray(c.entities)) s.constraints.push(c);
      }
    }
  } catch {
    return emptySketch();
  }

  return s;
}

/**
 * Chains a sketch's lines into closed loops.
 *
 * Walks the line graph rather than assuming the user drew in order, because they did not: a
 * rectangle is often four separate lines placed clockwise, anticlockwise, or in whatever
 * order the corners were clicked. Two lines join where they share a point *identity* — not
 * merely a position — which is what the coincident constraint establishes, so a loop that
 * looks closed on screen but is not actually joined is correctly reported as open.
 */
export function loopsOf(s: Sketch): { closed: Vec2[][]; openChains: number } {
  const point = (id: EntityId): Vec2 | null => {
    const e = s.entities.get(id);
    return e && e.kind === 'point' ? [e.x, e.y] : null;
  };

  /*
   * Adjacency over point ids, through both lines and arcs.
   *
   * An arc is an edge of the outline exactly as a line is — it joins two points, and a profile
   * that walks only the lines silently drops every curved side. Until this existed the arc
   * entity was a type with nothing behind it: a sketch containing one could be drawn, solved
   * and saved, and then reported as having no closed outline.
   *
   * Each edge carries the points to emit while traversing it, so an arc contributes its curve
   * and a line contributes nothing but its endpoint.
   */
  const at = new Map<EntityId, { edge: EntityId; to: EntityId; via: Vec2[] }[]>();
  const edges: { id: EntityId; a: EntityId; b: EntityId }[] = [];

  const link = (id: EntityId, a: EntityId, b: EntityId, forward: Vec2[], backward: Vec2[]) => {
    edges.push({ id, a, b });
    for (const [from, to, via] of [[a, b, forward], [b, a, backward]] as const) {
      const list = at.get(from);
      const entry = { edge: id, to, via };
      if (list) list.push(entry); else at.set(from, [entry]);
    }
  };

  for (const e of s.entities.values()) {
    if (e.kind === 'point' || e.kind === 'circle') continue;
    if (e.construction) continue;

    if (e.kind === 'line') {
      link(e.id, e.start, e.end, [], []);
      continue;
    }

    if (e.kind === 'arc') {
      const c = point(e.centre), a = point(e.start), b = point(e.end);
      if (!c || !a || !b) continue;

      const forward = arcPoints(c, a, b);
      link(e.id, e.start, e.end, forward, [...forward].reverse());
    }
  }

  const used = new Set<EntityId>();
  const closed: Vec2[][] = [];
  let openChains = 0;

  for (const seed of edges) {
    if (used.has(seed.id)) continue;

    const startPoint = seed.a;
    const ring: Vec2[] = [];

    const first = point(startPoint);
    if (!first) continue;
    ring.push(first);

    // The seed edge's own curve, then its far end.
    const seedEntry = (at.get(startPoint) ?? []).find((x) => x.edge === seed.id);
    if (seedEntry) ring.push(...seedEntry.via);

    let current = seed.b;
    used.add(seed.id);
    let ok = true;

    while (current !== startPoint) {
      const here = point(current);
      if (!here) { ok = false; break; }
      ring.push(here);

      const next = (at.get(current) ?? []).find((x) => !used.has(x.edge));
      if (!next) { ok = false; break; }

      used.add(next.edge);
      ring.push(...next.via);
      current = next.to;

      // A malformed graph must not spin.
      if (ring.length > edges.length * 80 + 8) { ok = false; break; }
    }

    if (!ok || ring.length < 3) { openChains++; continue; }
    closed.push(ring);
  }

  return { closed, openChains };
}

/**
 * The curve of an arc, excluding both endpoints.
 *
 * Counter-clockwise from start to end, which is the convention `addArc` records. Endpoints are
 * left out because the walk already emits them — including them would put a duplicate point at
 * every arc junction, and a zero-length edge is not something the kernel accepts.
 *
 * The radius is averaged over the two ends rather than taken from one. They are held equal by
 * the arc's own constraint, but a sketch that has not converged, or one being dragged, can have
 * them differ by a little, and favouring one end would make the curve visibly leave the other.
 */
function arcPoints(centre: Vec2, start: Vec2, end: Vec2): Vec2[] {
  const r0 = Math.hypot(start[0] - centre[0], start[1] - centre[1]);
  const r1 = Math.hypot(end[0] - centre[0], end[1] - centre[1]);
  const r = (r0 + r1) / 2;
  if (!(r > 1e-9)) return [];

  const a0 = Math.atan2(start[1] - centre[1], start[0] - centre[0]);
  const a1 = Math.atan2(end[1] - centre[1], end[0] - centre[0]);

  let sweep = a1 - a0;
  while (sweep <= 1e-9) sweep += Math.PI * 2;

  // Enough segments that the chordal error stays under a thousandth of the radius, which is
  // finer than anything downstream can see, and bounded so a full turn is not free.
  const segments = Math.max(2, Math.min(64, Math.ceil(sweep / 0.09)));

  const out: Vec2[] = [];
  for (let i = 1; i < segments; i++) {
    const t = a0 + (sweep * i) / segments;
    out.push([centre[0] + r * Math.cos(t), centre[1] + r * Math.sin(t)]);
  }
  return out;
}

/** A circle as a polygon, fine enough that the chordal error is below a thousandth. */
function circlePoints(centre: Vec2, radius: number, segments = 64): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    pts.push([centre[0] + radius * Math.cos(t), centre[1] + radius * Math.sin(t)]);
  }
  return pts;
}

export interface SketchProfile {
  profile: Profile | null;
  /** Why there is no profile, when there is none. */
  reason?: string;
}

/**
 * Turns a solved sketch into a profile.
 *
 * The largest loop by area is the outer boundary and everything inside it is a hole, which is
 * the convention every CAD package uses and the one a user expects without being told. Circles
 * participate on the same footing as line loops: a plate with a bored centre is one rectangle
 * and one circle, and which is the outline is decided by size rather than by drawing order.
 */
export function profileFromSketch(s: Sketch): SketchProfile {
  const { closed, openChains } = loopsOf(s);

  const rings: Vec2[][] = [...closed];
  for (const e of s.entities.values()) {
    if (e.kind !== 'circle' || e.construction) continue;
    const c = s.entities.get(e.centre);
    if (c && c.kind === 'point' && e.radius > 0) {
      rings.push(circlePoints([c.x, c.y], e.radius));
    }
  }

  if (rings.length === 0) {
    return {
      profile: null,
      reason: openChains > 0
        ? 'The sketch has no closed outline — its lines do not join up. Add coincident ' +
          'constraints at the corners, or draw the profile as one connected chain.'
        : 'The sketch is empty. Draw a closed outline before extruding it.',
    };
  }

  const withArea = rings
    .map((ring) => ({ ring, area: Math.abs(signedArea2(ring)) / 2 }))
    .sort((x, y) => y.area - x.area);

  const outer = withArea[0];
  if (outer.area <= 0) {
    return { profile: null, reason: 'The outline encloses no area.' };
  }

  return {
    profile: makeProfile(outer.ring, withArea.slice(1).map((w) => w.ring)),
  };
}

export interface SolvedSketch {
  result: SolveResult;
  profile: Profile | null;
  reason?: string;
  /** One line for the user: what state the sketch is in. */
  summary: string;
}

/**
 * Solves a sketch and reads a profile out of it.
 *
 * The summary is the part that makes constraints usable rather than mysterious. "Fully
 * constrained" and "two degrees of freedom left" are the difference between knowing a
 * dimension will hold and hoping it will, and every CAD package puts that on screen for
 * exactly that reason.
 */
export function solveForProfile(s: Sketch): SolvedSketch {
  const result = solve(s);
  const { profile, reason } = profileFromSketch(result.sketch);

  const dof = result.degreesOfFreedom;
  const summary =
    result.status === 'conflict'
      ? `Conflicting constraints — ${result.problemConstraints.length} cannot all hold at once.`
      : result.status === 'diverged'
        ? 'The constraints did not settle. Try removing the last one added.'
        : result.status === 'over'
          ? 'Fully constrained, with redundant constraints.'
          : dof === 0
            ? 'Fully constrained.'
            : `Under-constrained: ${dof} degree${dof === 1 ? '' : 's'} of freedom left.`;

  return { result, profile, reason, summary };
}

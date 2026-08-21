import { useCallback, useMemo, useRef, useState } from 'react';
import {
  addArc, addCircle, addLine, addPoint, constrain, emptySketch,
  type ConstraintKind, type EntityId, type Sketch,
} from '../kernel/sketch/solver';
import { sketchFromJson, sketchToJson, solveForProfile } from '../kernel/sketch/document';
import { addFreehand } from '../kernel/sketch/freehand';
import type { Vec2 } from '../kernel/math/vec';

/**
 * The sketch editor.
 *
 * This is the loop that makes a modeller parametric rather than a shape generator: draw the
 * profile roughly, say what must be *true* about it, and let the solver work out where the
 * geometry actually goes. A rectangle drawn by eye becomes exactly 100 × 60 because it was
 * told to be horizontal, vertical and 100 wide — not because anyone typed four corner
 * coordinates. Change the 100 afterwards and every relation that depends on it follows.
 *
 * The degrees-of-freedom readout is not decoration. It is the difference between knowing a
 * dimension will hold and hoping it will, which is why every CAD package puts it on screen.
 */

type Tool = 'select' | 'freehand' | 'line' | 'rect' | 'circle' | 'arc' | 'polygon' | 'slot';

/** Constraints offered, and how many entities each needs. */
const CONSTRAINTS: {
  kind: ConstraintKind; label: string; needs: number; on: 'point' | 'line' | 'circle' | 'any';
  dimensional?: boolean; hint: string;
}[] = [
  { kind: 'horizontal', label: 'Horizontal', needs: 1, on: 'line', hint: 'Lock a line parallel to X' },
  { kind: 'vertical', label: 'Vertical', needs: 1, on: 'line', hint: 'Lock a line parallel to Y' },
  { kind: 'parallel', label: 'Parallel', needs: 2, on: 'line', hint: 'Two lines stay parallel' },
  { kind: 'perpendicular', label: 'Perpendicular', needs: 2, on: 'line', hint: 'Two lines meet at 90°' },
  { kind: 'tangent', label: 'Tangent', needs: 2, on: 'any', hint: 'A line runs tangent to a circle' },
  { kind: 'angle', label: 'Angle', needs: 2, on: 'line', hint: 'Two lines at a set angle' },
  { kind: 'symmetric', label: 'Symmetric', needs: 3, on: 'any', hint: 'Two points mirror across a line' },
  { kind: 'pointOnLine', label: 'Point on line', needs: 2, on: 'any', hint: 'A point rides on a line' },
  { kind: 'pointOnCircle', label: 'Point on circle', needs: 2, on: 'any', hint: 'A point rides on a circle' },
  { kind: 'fixX', label: 'Fix X', needs: 1, on: 'point', hint: 'Pin a point along X' },
  { kind: 'fixY', label: 'Fix Y', needs: 1, on: 'point', hint: 'Pin a point along Y' },
  { kind: 'equal', label: 'Equal', needs: 2, on: 'any', hint: 'Same length, or same radius' },
  { kind: 'coincident', label: 'Coincident', needs: 2, on: 'point', hint: 'Two points become one' },
  { kind: 'distance', label: 'Distance', needs: 2, on: 'point', dimensional: true, hint: 'Set the span between two points' },
  { kind: 'radius', label: 'Radius', needs: 1, on: 'circle', dimensional: true, hint: 'Set a circle’s radius' },
  { kind: 'concentric', label: 'Concentric', needs: 2, on: 'circle', hint: 'Two circles share a centre' },
];

interface Props {
  /** The sketch as stored on the feature, as JSON. */
  value: string;
  onChange: (json: string) => void;
}

/** World millimetres across the canvas. */
const VIEW = 260;

/**
 * How far off an axis a line may be drawn and still be taken as on it.
 *
 * Five degrees. Wide enough that nobody has to draw accurately with a mouse, narrow enough
 * that a deliberate shallow angle survives — and a deliberate 4° taper is rare next to an
 * accidental 4° that was meant to be flat.
 */
const SNAP_DEGREES = 5;

/**
 * Sides on the polygon tool.
 *
 * Six, because a hexagon is what a polygon is nearly always drawn for — a nut, a bar section,
 * a socket. Anything else is an equal-sided shape someone can build from lines with the equal
 * constraint the tool itself uses.
 */
const POLYGON_SIDES = 6;

/**
 * How close a click has to be to an existing point to land on it instead.
 *
 * In millimetres of sketch space, not pixels, so the behaviour does not change with the zoom
 * the canvas happens to be at.
 */
const SNAP_MM = 4;

/**
 * The sketch's vertical axis, as a construction line, created the first time it is needed.
 *
 * `symmetric` takes a line to mirror across, so mirroring needs one to exist. Made as
 * construction geometry and pinned at both ends, so it holds still and stays out of the
 * outline.
 */
function pointOnAxis(s: Sketch): EntityId {
  // Recognised by what it is rather than by its id: `addLine` numbers its entities and knows
  // nothing about axes, so looking for a name prefix would never match and every mirror would
  // stack another axis on the last one.
  for (const e of s.entities.values()) {
    if (e.kind !== 'line' || !e.construction) continue;

    const a = s.entities.get(e.start), b = s.entities.get(e.end);
    if (a?.kind !== 'point' || b?.kind !== 'point') continue;
    if (a.fixed && b.fixed && Math.abs(a.x) < 1e-9 && Math.abs(b.x) < 1e-9) return e.id;
  }

  const a = addPoint(s, 0, -1000, true);
  const b = addPoint(s, 0, 1000, true);
  const line = addLine(s, a, b, true);
  return line.id;
}

const TOOL_LABEL: Record<Tool, string> = {
  select: 'Select', freehand: 'Draw', line: 'Line', rect: 'Rectangle', circle: 'Circle',
  arc: 'Arc', polygon: 'Hexagon', slot: 'Slot',
};

export function SketchEditor({ value, onChange }: Props) {
  const [tool, setTool] = useState<Tool>('rect');

  /**
   * The stroke being drawn, in sketch coordinates.
   *
   * Held here rather than committed point by point: a stroke is one edit, and writing a document
   * change per pointer move would leave four hundred undo steps behind a single line.
   */
  const [stroke, setStroke] = useState<Vec2[] | null>(null);

  /*
   * The stroke as it accumulates, in a ref as well as in state.
   *
   * A pointer emits moves faster than React re-renders, and several in one batch all read the
   * same rendered value of `stroke` — so each replaces the last and a fast drag records one
   * point. Slow, careful drawing worked and a quick flick produced a dot, which is the worst
   * possible way round.
   */
  const strokeRef = useRef<Vec2[] | null>(null);

  /**
   * Clicks collected so far for a tool that needs more than two.
   *
   * An arc is centre, start, end; a slot is the two ends of its axis and then its width. Kept
   * separately from `pending` so a half-finished arc cannot be mistaken for a half-finished
   * rectangle when the tool is switched.
   */
  const [clicks, setClicks] = useState<[number, number][]>([]);
  const [picked, setPicked] = useState<EntityId[]>([]);
  const [pending, setPending] = useState<[number, number] | null>(null);
  const [dimension, setDimension] = useState('100');
  /** The line or circle whose size is being typed, and the box it is typed into. */
  const [sizing, setSizing] = useState<{ id: EntityId; kind: 'line' | 'circle'; value: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * The point being dragged, and the sketch as it looks mid-drag.
   *
   * Held locally rather than pushed through `onChange` on every pointer move: each of those is
   * a document edit and an undo step, and one drag across the canvas would leave a hundred of
   * them in the history. The document is written once, on release.
   */
  const [drag, setDrag] = useState<{ id: EntityId; sketch: Sketch } | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);

  const sketch = useMemo(() => sketchFromJson(value), [value]);

  // Mid-drag the draft is what gets solved, so the rest of the sketch follows the point being
  // moved — which is the whole point of dragging a constrained sketch rather than editing
  // numbers.
  const solved = useMemo(
    () => solveForProfile(drag ? drag.sketch : sketch),
    [sketch, drag],
  );

  // Everything is drawn from the *solved* sketch, so the canvas shows where the geometry
  // actually is rather than where it was dragged to.
  const view = solved.result.sketch;

  const commit = useCallback((next: Sketch) => {
    onChange(sketchToJson(next));
    setPicked([]);
  }, [onChange]);

  /**
   * The nearest existing point to a place on the canvas, if one is close enough to mean it.
   *
   * Snapping is what makes a drawn sketch actually join up. Two lines that end a tenth of a
   * millimetre apart look joined, solve as two open chains, and report no closed outline — and
   * the user has no way to see why. Landing on the existing point instead makes the corner
   * shared by construction, so the loop closes because it *is* closed.
   */
  const snapTo = useCallback((at: [number, number], exclude?: EntityId): [number, number] => {
    let best: { d: number; at: [number, number] } | null = null;

    for (const e of solved.result.sketch.entities.values()) {
      if (e.kind !== 'point' || e.id === exclude) continue;
      const d = Math.hypot(e.x - at[0], e.y - at[1]);
      if (d <= SNAP_MM && (!best || d < best.d)) best = { d, at: [e.x, e.y] };
    }

    return best ? best.at : at;
  }, [solved]);

  /** Canvas pixels to sketch millimetres. */
  const toWorld = useCallback((e: { clientX: number; clientY: number }): [number, number] => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return [0, 0];
    const x = ((e.clientX - box.left) / box.width) * VIEW - VIEW / 2;
    // Y is flipped: sketches are drawn in engineering orientation, Y upwards.
    const y = VIEW / 2 - ((e.clientY - box.top) / box.height) * VIEW;
    return [Math.round(x * 2) / 2, Math.round(y * 2) / 2];
  }, []);

  const onCanvasClick = useCallback((e: React.MouseEvent) => {
    if (tool === 'select') { setPicked([]); return; }

    const at = snapTo(toWorld(e));
    const next = sketchFromJson(value);

    if (tool === 'circle') {
      if (!pending) { setPending(at); return; }
      const r = Math.hypot(at[0] - pending[0], at[1] - pending[1]);
      if (r > 0.5) {
        addCircle(next, addPoint(next, pending[0], pending[1]), r);
        commit(next);
      }
      setPending(null);
      return;
    }

    if (tool === 'arc') {
      // Centre, then start, then end — counter-clockwise from start to end, which is what
      // `addArc` records and what every package's centre-point arc does.
      const taken = [...clicks, at];
      if (taken.length < 3) { setClicks(taken); return; }

      const [c, a, b] = taken as [[number, number], [number, number], [number, number]];
      const r = Math.hypot(a[0] - c[0], a[1] - c[1]);

      if (r > 0.5) {
        const centre = addPoint(next, c[0], c[1]);
        const start = addPoint(next, a[0], a[1]);

        // The end is pulled onto the radius as it is placed, so the arc starts life as an arc
        // rather than as three points the solver has to drag into shape.
        const angle = Math.atan2(b[1] - c[1], b[0] - c[0]);
        const end = addPoint(next, c[0] + r * Math.cos(angle), c[1] + r * Math.sin(angle));

        addArc(next, centre, start, end);
        commit(next);
      }
      setClicks([]);
      return;
    }

    if (tool === 'polygon') {
      if (!pending) { setPending(at); return; }

      const r = Math.hypot(at[0] - pending[0], at[1] - pending[1]);
      if (r > 0.5) {
        // Sides equal by construction and by constraint: the shape is right when drawn, and
        // stays right when a vertex is dragged.
        const corners = [];
        for (let i = 0; i < POLYGON_SIDES; i++) {
          const t = (i / POLYGON_SIDES) * Math.PI * 2 + Math.PI / 2;
          corners.push(addPoint(next, pending[0] + r * Math.cos(t), pending[1] + r * Math.sin(t)));
        }

        const sides = [];
        for (let i = 0; i < POLYGON_SIDES; i++) {
          sides.push(addLine(next, corners[i]!, corners[(i + 1) % POLYGON_SIDES]!));
        }
        for (let i = 1; i < POLYGON_SIDES; i++) constrain(next, 'equal', [sides[0]!, sides[i]!]);

        commit(next);
      }
      setPending(null);
      return;
    }

    if (tool === 'slot') {
      // Two ends of the axis, then a third click for the width.
      const taken = [...clicks, at];
      if (taken.length < 3) { setClicks(taken); return; }

      const [a, b, w] = taken as [[number, number], [number, number], [number, number]];
      const axis = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (axis < 1) { setClicks([]); return; }

      // Width taken as the third click's distance from the axis line, which is the gesture
      // people expect: drag out from the centreline to set how fat the slot is.
      const ux = (b[0] - a[0]) / axis, uy = (b[1] - a[1]) / axis;
      const across = Math.abs(-(w[0] - a[0]) * uy + (w[1] - a[1]) * ux);
      const r = Math.max(0.5, across);

      const nx = -uy * r, ny = ux * r;

      const ca = addPoint(next, a[0], a[1]);
      const cb = addPoint(next, b[0], b[1]);
      const a1 = addPoint(next, a[0] + nx, a[1] + ny);
      const b1 = addPoint(next, b[0] + nx, b[1] + ny);
      const b2 = addPoint(next, b[0] - nx, b[1] - ny);
      const a2 = addPoint(next, a[0] - nx, a[1] - ny);

      const side1 = addLine(next, a1, b1);
      const side2 = addLine(next, b2, a2);
      addArc(next, cb, b1, b2);
      addArc(next, ca, a2, a1);
      constrain(next, 'equal', [side1, side2]);
      constrain(next, 'parallel', [side1, side2]);

      commit(next);
      setClicks([]);
      return;
    }

    if (tool === 'rect') {
      if (!pending) { setPending(at); return; }
      const [x0, y0] = pending, [x1, y1] = at;
      if (Math.abs(x1 - x0) < 1 || Math.abs(y1 - y0) < 1) { setPending(null); return; }

      // Four corners sharing point identity, so the loop is closed by construction rather
      // than by four coincident constraints the user would otherwise have to add.
      const a = addPoint(next, x0, y0);
      const b = addPoint(next, x1, y0);
      const c = addPoint(next, x1, y1);
      const d = addPoint(next, x0, y1);
      const bottom = addLine(next, a, b);
      const right = addLine(next, b, c);
      const top = addLine(next, c, d);
      const left = addLine(next, d, a);

      // A rectangle *is* two horizontals and two verticals, and saying so is what leaves it
      // with the four degrees of freedom it actually has — origin, width and height — instead
      // of eight loose coordinates. Drawn without them, dragging one corner turns the
      // rectangle into a quadrilateral, which is not what anybody drew.
      constrain(next, 'horizontal', [bottom]);
      constrain(next, 'horizontal', [top]);
      constrain(next, 'vertical', [right]);
      constrain(next, 'vertical', [left]);

      commit(next);
      setPending(null);
      return;
    }

    // A single line, from the last click to this one.
    if (!pending) { setPending(at); return; }
    const a = addPoint(next, pending[0], pending[1]);
    const b = addPoint(next, at[0], at[1]);
    const line = addLine(next, a, b);

    // Automatic relations, the way every CAD package infers them: a line drawn within a few
    // degrees of an axis was meant to be on it. Inferring is not guessing — the alternative
    // is a sketch that looks square and is 0.4° out, which survives every visual check and
    // fails at the machine.
    const dx = Math.abs(at[0] - pending[0]);
    const dy = Math.abs(at[1] - pending[1]);
    const slope = Math.atan2(dy, dx) * (180 / Math.PI);
    if (slope < SNAP_DEGREES) constrain(next, 'horizontal', [line]);
    else if (slope > 90 - SNAP_DEGREES) constrain(next, 'vertical', [line]);

    commit(next);
    setPending(at);
  }, [tool, pending, clicks, toWorld, snapTo, value, commit]);

  /**
   * Starts dragging a point.
   *
   * Only in Select, because while a drawing tool is active a press on the canvas is the start
   * of the next entity — and a gesture that means two different things depending on what is
   * underneath the cursor is the kind of thing that makes a tool feel unreliable.
   */
  const startDrag = useCallback((id: EntityId, e: React.PointerEvent) => {
    if (tool !== 'select') return;
    e.stopPropagation();
    // Capture is an optimisation — it keeps the drag alive if the pointer leaves the point —
    // and it throws when there is no active pointer with that id. Letting that propagate would
    // abort the handler before the drag is registered, so the point simply would not move.
    try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch { /* not fatal */ }

    setDrag({ id, sketch: sketchFromJson(value) });
  }, [tool, value]);

  /**
   * Starts a freehand stroke.
   *
   * Only for the Draw tool: every other tool is click-to-place, and taking the pointer down for
   * them would break the gesture people already have.
   */
  const onCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    if (tool !== 'freehand' || e.button !== 0) return;

    strokeRef.current = [toWorld(e)];
    setStroke(strokeRef.current);
    e.preventDefault();
  }, [tool, toWorld]);

  const onCanvasPointerMove = useCallback((e: React.PointerEvent) => {
    if (strokeRef.current) {
      strokeRef.current = [...strokeRef.current, toWorld(e)];
      setStroke(strokeRef.current);
      return;
    }

    if (!drag) return;

    const at = snapTo(toWorld(e), drag.id);
    const next = sketchFromJson(sketchToJson(drag.sketch));
    const point = next.entities.get(drag.id);
    if (!point || point.kind !== 'point') return;

    point.x = at[0];
    point.y = at[1];

    /*
     * The dragged point is pinned for the length of the drag, so the solver moves everything
     * *else* to suit it.
     *
     * Without this the solver is free to satisfy the constraints by moving the point straight
     * back where it came from, which it will, because that is the nearest solution — and the
     * sketch would sit there refusing to be dragged with no indication why.
     */
    point.fixed = true;
    setDrag({ id: drag.id, sketch: next });
  }, [drag, snapTo, toWorld, stroke]);

  const endDrag = useCallback(() => {
    if (!drag) return;

    const settled = sketchFromJson(sketchToJson(drag.sketch));
    const point = settled.entities.get(drag.id);

    // The pin was for the drag only. Leaving it would silently fix every point the user had
    // ever moved, and the sketch would gradually stop responding to its own dimensions.
    if (point && point.kind === 'point') point.fixed = false;

    setDrag(null);
    commit(settled);
  }, [drag, commit]);

  /**
   * Ends a stroke, and turns it into geometry.
   *
   * The recognition happens here, once, on the finished path — not per move. What goes into the
   * sketch is lines and arcs, so the shape you drew can be dimensioned and constrained like
   * anything else you could have placed.
   */
  const endStroke = useCallback(() => {
    const path = strokeRef.current;

    if (path) {
      strokeRef.current = null;
      setStroke(null);

      if (path.length >= 3) {
        // A tolerance in sketch units, taken from the view so it is the same distance on screen
        // whatever the sketch is scaled to.
        // The canvas is a 0-100 box, so a little over a unit is about a pixel of hand wobble.
          const added = addFreehand(view, path, { tolerance: 1.2 });
        if (added) {
          commit(added.sketch);
        }
      }
      return;
    }

    endDrag();
  }, [view, commit, endDrag]);

  /**
   * Marks the selection as construction geometry, or takes the mark off.
   *
   * Construction lines guide a sketch without being part of its outline — a centreline to
   * mirror about, a bolt circle to place holes on, a diagonal that holds a proportion. The
   * profile walk already skips them; this is what lets a user say which ones they are.
   */
  const toggleConstruction = useCallback(() => {
    const next = sketchFromJson(value);
    let turnedOn = false;

    for (const id of picked) {
      const e = next.entities.get(id);
      if (!e || e.kind === 'point') continue;
      e.construction = !e.construction;
      if (e.construction) turnedOn = true;
    }

    setNotice(turnedOn
      ? 'Construction geometry — it guides the sketch but stays out of the outline.'
      : 'Back to real geometry.');
    commit(next);
  }, [picked, value, commit]);

  /**
   * Mirrors the selected lines across the vertical axis.
   *
   * Across X = 0 rather than across a chosen line, because choosing the line needs a selection
   * mode of its own and the vertical axis is what the great majority of mirrors are about — a
   * symmetric part drawn once. The copies are joined to the originals by `symmetric`
   * constraints, so editing one side moves the other; a mirror that produced loose duplicates
   * would be a copy-paste, not a relation.
   */
  const mirrorPicked = useCallback(() => {
    const next = sketchFromJson(value);
    const axis = pointOnAxis(next);
    const made = new Map<EntityId, EntityId>();

    const reflect = (id: EntityId): EntityId | null => {
      const seen = made.get(id);
      if (seen) return seen;

      const e = next.entities.get(id);
      if (!e || e.kind !== 'point') return null;

      const copy = addPoint(next, -e.x, e.y);
      made.set(id, copy.id);
      constrain(next, 'symmetric', [id, copy.id, axis]);
      return copy.id;
    };

    let count = 0;
    for (const id of picked) {
      const e = next.entities.get(id);
      if (!e || e.kind !== 'line') continue;

      const a = reflect(e.start), b = reflect(e.end);
      if (!a || !b) continue;

      const pa = next.entities.get(a), pb = next.entities.get(b);
      if (pa?.kind !== 'point' || pb?.kind !== 'point') continue;

      addLine(next, pa, pb, e.construction);
      count++;
    }

    if (count === 0) { setNotice('Select one or more lines to mirror.'); return; }
    setNotice(`Mirrored ${count} line${count === 1 ? '' : 's'}. The copies stay symmetric.`);
    commit(next);
  }, [picked, value, commit]);

  /**
   * Offsets the selected lines outwards by a distance.
   *
   * Each line gets a parallel copy, tied to the original by a `parallel` constraint so the pair
   * stays parallel when either is moved. The offset itself is a one-off placement rather than a
   * live relation — a true offset that tracks its parent needs an entity type of its own, and
   * saying which this is beats implying the other.
   */
  const offsetPicked = useCallback(() => {
    const by = Number(dimension);
    if (!Number.isFinite(by) || Math.abs(by) < 1e-6) {
      setNotice('Type an offset distance in the value box first.');
      return;
    }

    const next = sketchFromJson(value);
    let count = 0;

    for (const id of picked) {
      const e = next.entities.get(id);
      if (!e || e.kind !== 'line') continue;

      const a = next.entities.get(e.start), b = next.entities.get(e.end);
      if (a?.kind !== 'point' || b?.kind !== 'point') continue;

      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;

      // Normal to the line, on its left. Which side is a convention; a negative distance takes
      // the other one, which is the control a user already has.
      const nx = (-dy / len) * by, ny = (dx / len) * by;

      const pa = addPoint(next, a.x + nx, a.y + ny);
      const pb = addPoint(next, b.x + nx, b.y + ny);
      const copy = addLine(next, pa, pb, e.construction);
      constrain(next, 'parallel', [e.id, copy.id]);
      count++;
    }

    if (count === 0) { setNotice('Select one or more lines to offset.'); return; }
    setNotice(`Offset ${count} line${count === 1 ? '' : 's'} by ${by} mm.`);
    commit(next);
  }, [picked, dimension, value, commit]);

  const togglePick = useCallback((id: EntityId, e: React.MouseEvent) => {
    e.stopPropagation();
    setNotice(null);
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const kindOf = (id: EntityId) => view.entities.get(id)?.kind;

  const apply = useCallback((c: typeof CONSTRAINTS[number]) => {
    if (picked.length !== c.needs) {
      setNotice(`${c.label} needs ${c.needs} selected, not ${picked.length}.`);
      return;
    }
    if (c.on !== 'any' && picked.some((id) => kindOf(id) !== c.on)) {
      setNotice(`${c.label} applies to ${c.on}s. Select ${c.needs} ${c.on}${c.needs === 1 ? '' : 's'}.`);
      return;
    }

    const next = sketchFromJson(value);
    const size = c.dimensional ? Number(dimension) : undefined;
    if (c.dimensional && (!Number.isFinite(size) || (size as number) <= 0)) {
      setNotice('Give the dimension a positive value first.');
      return;
    }

    constrain(next, c.kind, picked, size);

    // Refuse a constraint that makes the sketch unsolvable, rather than leaving the user with
    // a broken sketch and no clue which addition broke it.
    const after = solveForProfile(next);
    if (after.result.status === 'conflict') {
      setNotice(`That conflicts with a constraint already there. ${c.label} was not added.`);
      return;
    }

    setNotice(null);
    commit(next);
  }, [picked, value, dimension, commit, view]);

  const clearAll = useCallback(() => {
    onChange(sketchToJson(emptySketch()));
    setPicked([]);
    setPending(null);
    setNotice(null);
  }, [onChange]);

  const removeSelected = useCallback(() => {
    if (picked.length === 0) return;
    const next = sketchFromJson(value);
    const gone = new Set(picked);

    for (const id of picked) next.entities.delete(id);
    // A line whose endpoint went, or a constraint referring to anything removed, goes too.
    for (const [id, e] of [...next.entities]) {
      if (e.kind === 'line' && (gone.has(e.start) || gone.has(e.end))) next.entities.delete(id);
      if (e.kind === 'circle' && gone.has(e.centre)) next.entities.delete(id);
      // An arc dies with any of its three points, or it is left referring to something that
      // no longer exists and the solver reads a coordinate out of nothing.
      if (e.kind === 'arc' && (gone.has(e.centre) || gone.has(e.start) || gone.has(e.end))) {
        next.entities.delete(id);
      }
    }
    next.constraints = next.constraints.filter(
      (c) => c.entities.every((id) => next.entities.has(id)));

    commit(next);
  }, [picked, value, commit]);

  /**
   * Drives a length or a diameter to a typed value.
   *
   * This is the act that separates a drawing from a design. Until a dimension is *driving*,
   * the geometry is wherever the mouse left it and the number beside it is a readout; once it
   * is, the number is the input and the geometry follows — which is what makes a change to it
   * a change to the part rather than a redraw of it.
   *
   * Applied to the line's own endpoints, so it survives whatever else moves.
   */
  const applySize = useCallback(() => {
    if (!sizing) return;
    const wanted = Number(sizing.value);
    if (!Number.isFinite(wanted) || wanted <= 0) { setSizing(null); return; }

    const next = sketchFromJson(value);
    const entity = next.entities.get(sizing.id);
    if (!entity) { setSizing(null); return; }

    // A second dimension on the same thing is a contradiction, not an update. The old one is
    // replaced so typing a new number means what a user expects it to mean.
    const targets = entity.kind === 'line' ? [entity.start, entity.end] : [sizing.id];
    next.constraints = next.constraints.filter((c) => {
      if (entity.kind === 'line') {
        return !(c.kind === 'distance' && c.entities.length === 2
          && c.entities.includes(entity.start) && c.entities.includes(entity.end));
      }
      return !(c.kind === 'radius' && c.entities[0] === sizing.id);
    });

    if (entity.kind === 'line') constrain(next, 'distance', targets, wanted);
    else constrain(next, 'radius', targets, wanted / 2);      // typed as a diameter

    commit(next);
    setSizing(null);
  }, [sizing, value, commit]);

  // ── drawing ──
  const px = (worldX: number) => ((worldX + VIEW / 2) / VIEW) * 100;
  const py = (worldY: number) => ((VIEW / 2 - worldY) / VIEW) * 100;

  const points = [...view.entities.values()].filter((e) => e.kind === 'point');
  const lines = [...view.entities.values()].filter((e) => e.kind === 'line');
  const circles = [...view.entities.values()].filter((e) => e.kind === 'circle');
  const arcs = [...view.entities.values()].filter((e) => e.kind === 'arc');

  const xy = (id: EntityId): [number, number] => {
    const e = view.entities.get(id);
    return e && e.kind === 'point' ? [e.x, e.y] : [0, 0];
  };

  const dof = solved.result.degreesOfFreedom;
  const tone = solved.result.status === 'conflict' ? 'error' : dof === 0 ? 'ok' : 'warn';

  return (
    <div className="sk">
      <div className="sk-tools" role="group" aria-label="Sketch tools">
        {(['select', 'freehand', 'line', 'rect', 'circle', 'arc', 'polygon', 'slot'] as Tool[]).map((t) => (
          <button
            key={t}
            className={tool === t ? 'is-on' : undefined}
            aria-pressed={tool === t}
            onClick={() => { setTool(t); setPending(null); setClicks([]); }}
          >
            {TOOL_LABEL[t]}
          </button>
        ))}
        <span className="sk-gap" />
        <button
          onClick={toggleConstruction}
          disabled={picked.length === 0}
          title="Construction geometry guides the sketch without becoming part of the outline"
        >
          Construction
        </button>
        <button
          onClick={mirrorPicked}
          disabled={picked.length === 0}
          title="Mirror the selected entities across the vertical axis"
        >
          Mirror
        </button>
        <button
          onClick={offsetPicked}
          disabled={picked.length === 0}
          title="Offset the selected lines outwards by a distance"
        >
          Offset
        </button>
        <span className="sk-gap" />
        <button onClick={removeSelected} disabled={picked.length === 0}>Delete</button>
        <button onClick={clearAll} disabled={view.entities.size === 0}>Clear</button>
      </div>

      <svg
        ref={svgRef}
        className="sk-canvas"
        viewBox={`0 0 100 100`}
        preserveAspectRatio="xMidYMid meet"
        onClick={onCanvasClick}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={endStroke}
        onPointerLeave={endStroke}
        role="img"
        aria-label="Sketch canvas"
      >
        <defs>
          <pattern id="sk-grid" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M10 0H0V10" fill="none" stroke="currentColor" strokeWidth="0.15" opacity="0.18" />
          </pattern>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill="url(#sk-grid)" />
        <line x1="0" y1="50" x2="100" y2="50" stroke="currentColor" strokeWidth="0.25" opacity="0.45" />
        <line x1="50" y1="0" x2="50" y2="100" stroke="currentColor" strokeWidth="0.25" opacity="0.45" />

        {lines.map((l) => {
          if (l.kind !== 'line') return null;
          const [ax, ay] = xy(l.start), [bx, by] = xy(l.end);
          return (
            <line
              key={l.id}
              x1={px(ax)} y1={py(ay)} x2={px(bx)} y2={py(by)}
              className={picked.includes(l.id) ? 'sk-line is-picked' : 'sk-line'}
              onClick={(e) => togglePick(l.id, e)}
            />
          );
        })}

        {arcs.map((a) => {
          if (a.kind !== 'arc') return null;
          const [cx, cy] = xy(a.centre);
          const [sx, sy] = xy(a.start);
          const [ex, ey] = xy(a.end);

          const r = Math.hypot(sx - cx, sy - cy);
          if (!(r > 1e-6)) return null;

          // Counter-clockwise from start to end, matching what `addArc` records. In SVG that
          // is sweep-flag 0, because the Y axis is flipped between sketch space and screen
          // space and the handedness flips with it.
          let sweep = Math.atan2(ey - cy, ex - cx) - Math.atan2(sy - cy, sx - cx);
          while (sweep <= 0) sweep += Math.PI * 2;
          const large = sweep > Math.PI ? 1 : 0;

          const rr = (r / VIEW) * 100;
          const d = `M ${px(sx)} ${py(sy)} A ${rr} ${rr} 0 ${large} 0 ${px(ex)} ${py(ey)}`;

          return (
            <path
              key={a.id}
              d={d}
              fill="none"
              className={picked.includes(a.id) ? 'sk-line is-picked' : 'sk-line'}
              onClick={(e) => togglePick(a.id, e)}
            />
          );
        })}

        {circles.map((c) => {
          if (c.kind !== 'circle') return null;
          const [cx, cy] = xy(c.centre);
          return (
            <circle
              key={c.id}
              cx={px(cx)} cy={py(cy)} r={(c.radius / VIEW) * 100}
              className={picked.includes(c.id) ? 'sk-circle is-picked' : 'sk-circle'}
              onClick={(e) => togglePick(c.id, e)}
            />
          );
        })}

        {/*
          Every size on the drawing, and clickable.

          A sketch without its dimensions on it is a picture. Showing them turns the canvas
          into the document an engineer reads — and making them the control as well as the
          readout removes the step where you select a line, find a constraint button, and type
          into a box somewhere else.

          A driven dimension is drawn differently from a measured one, because "this is 100
          because I said so" and "this happens to be 100" are different facts about a design.
        */}
        {lines.map((l) => {
          if (l.kind !== 'line') return null;
          const [ax, ay] = xy(l.start), [bx, by] = xy(l.end);
          const length = Math.hypot(bx - ax, by - ay);
          if (length < VIEW * 0.06) return null;          // no room to read it

          const driven = view.constraints.some((c) => c.kind === 'distance'
            && c.entities.includes(l.start) && c.entities.includes(l.end));

          return (
            <text
              key={`d-${l.id}`}
              className={driven ? 'sk-dimtext is-driven' : 'sk-dimtext'}
              x={px((ax + bx) / 2)} y={py((ay + by) / 2) - 1.4}
              textAnchor="middle"
              onClick={(e) => {
                e.stopPropagation();
                setSizing({ id: l.id, kind: 'line', value: length.toFixed(1) });
              }}
            >
              {length.toFixed(1)}
            </text>
          );
        })}

        {circles.map((c) => {
          if (c.kind !== 'circle') return null;
          const [cx, cy] = xy(c.centre);
          const driven = view.constraints.some((k) => k.kind === 'radius' && k.entities[0] === c.id);
          return (
            <text
              key={`d-${c.id}`}
              className={driven ? 'sk-dimtext is-driven' : 'sk-dimtext'}
              x={px(cx)} y={py(cy) + 1}
              textAnchor="middle"
              onClick={(e) => {
                e.stopPropagation();
                setSizing({ id: c.id, kind: 'circle', value: (c.radius * 2).toFixed(1) });
              }}
            >
              {`⌀${(c.radius * 2).toFixed(1)}`}
            </text>
          );
        })}

        {points.map((p) => {
          if (p.kind !== 'point') return null;
          return (
            <circle
              key={p.id}
              cx={px(p.x)} cy={py(p.y)} r={picked.includes(p.id) ? 1.5 : 1}
              className={
                `sk-point${picked.includes(p.id) ? ' is-picked' : ''}${p.fixed ? ' is-fixed' : ''}`
                + (tool === 'select' ? ' is-grabbable' : '')
              }
              onPointerDown={(e) => startDrag(p.id, e)}
              onClick={(e) => togglePick(p.id, e)}
            />
          );
        })}

        {pending && (
          <circle cx={px(pending[0])} cy={py(pending[1])} r="1.2" className="sk-pending" />
        )}
      </svg>

      {sizing && (
        <div className="sk-size">
          <label htmlFor="sk-size-value">
            {sizing.kind === 'circle' ? 'Diameter' : 'Length'}
          </label>
          <input
            id="sk-size-value"
            type="number"
            autoFocus
            value={sizing.value}
            min={0}
            step={0.5}
            onChange={(e) => setSizing({ ...sizing, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applySize();
              if (e.key === 'Escape') setSizing(null);
            }}
          />
          <span>mm</span>
          <button className="primary" onClick={applySize}>Set</button>
          <button onClick={() => setSizing(null)}>Cancel</button>
        </div>
      )}

      <div className="sk-status" data-tone={tone}>
        {solved.summary}
        {picked.length > 0 && <span className="sk-picked">{picked.length} selected</span>}
      </div>

      <div className="sk-dim">
        <label htmlFor="sk-value">Dimension</label>
        <input
          id="sk-value"
          type="number"
          value={dimension}
          min={0}
          step={0.5}
          onChange={(e) => setDimension(e.target.value)}
        />
        <span>mm / deg</span>
      </div>

      <div className="sk-constraints" role="group" aria-label="Constraints">
        {CONSTRAINTS.map((c) => (
          <button
            key={c.kind}
            title={`${c.hint} — select ${c.needs} ${c.on === 'any' ? 'entities' : `${c.on}s`}`}
            onClick={() => apply(c)}
            disabled={picked.length !== c.needs}
          >
            {c.label}
            {c.dimensional && <em> ⌀</em>}
          </button>
        ))}
      </div>

      {notice && <p className="sk-notice">{notice}</p>}

      {!solved.profile && view.entities.size > 0 && (
        <p className="sk-notice">{solved.reason}</p>
      )}

      <p className="sk-help">
        Draw roughly, then constrain. Click a line or circle to select it; the constraint
        buttons light up when the right number is chosen.
      </p>
    </div>
  );
}

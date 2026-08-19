import { useCallback, useMemo, useRef, useState } from 'react';
import {
  addCircle, addLine, addPoint, constrain, emptySketch,
  type ConstraintKind, type EntityId, type Sketch,
} from '../kernel/sketch/solver';
import { sketchFromJson, sketchToJson, solveForProfile } from '../kernel/sketch/document';

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

type Tool = 'select' | 'line' | 'rect' | 'circle';

/** Constraints offered, and how many entities each needs. */
const CONSTRAINTS: {
  kind: ConstraintKind; label: string; needs: number; on: 'point' | 'line' | 'circle' | 'any';
  dimensional?: boolean; hint: string;
}[] = [
  { kind: 'horizontal', label: 'Horizontal', needs: 1, on: 'line', hint: 'Lock a line parallel to X' },
  { kind: 'vertical', label: 'Vertical', needs: 1, on: 'line', hint: 'Lock a line parallel to Y' },
  { kind: 'parallel', label: 'Parallel', needs: 2, on: 'line', hint: 'Two lines stay parallel' },
  { kind: 'perpendicular', label: 'Perpendicular', needs: 2, on: 'line', hint: 'Two lines meet at 90°' },
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

export function SketchEditor({ value, onChange }: Props) {
  const [tool, setTool] = useState<Tool>('rect');
  const [picked, setPicked] = useState<EntityId[]>([]);
  const [pending, setPending] = useState<[number, number] | null>(null);
  const [dimension, setDimension] = useState('100');
  /** The line or circle whose size is being typed, and the box it is typed into. */
  const [sizing, setSizing] = useState<{ id: EntityId; kind: 'line' | 'circle'; value: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const sketch = useMemo(() => sketchFromJson(value), [value]);
  const solved = useMemo(() => solveForProfile(sketch), [sketch]);

  // Everything is drawn from the *solved* sketch, so the canvas shows where the geometry
  // actually is rather than where it was dragged to.
  const view = solved.result.sketch;

  const commit = useCallback((next: Sketch) => {
    onChange(sketchToJson(next));
    setPicked([]);
  }, [onChange]);

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

    const at = toWorld(e);
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
  }, [tool, pending, toWorld, value, commit]);

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

  const xy = (id: EntityId): [number, number] => {
    const e = view.entities.get(id);
    return e && e.kind === 'point' ? [e.x, e.y] : [0, 0];
  };

  const dof = solved.result.degreesOfFreedom;
  const tone = solved.result.status === 'conflict' ? 'error' : dof === 0 ? 'ok' : 'warn';

  return (
    <div className="sk">
      <div className="sk-tools" role="group" aria-label="Sketch tools">
        {(['select', 'line', 'rect', 'circle'] as Tool[]).map((t) => (
          <button
            key={t}
            className={tool === t ? 'is-on' : undefined}
            aria-pressed={tool === t}
            onClick={() => { setTool(t); setPending(null); }}
          >
            {t === 'select' ? 'Select' : t === 'rect' ? 'Rectangle' : t === 'line' ? 'Line' : 'Circle'}
          </button>
        ))}
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
              }
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

import { useMemo, useState } from 'react';
import { useStore } from '../store';
import type { FeatureNode } from '../types';
import { Viewport } from './Viewport';

/* ── Model Explorer ───────────────────────────────────────────────────────── */

const TYPE_GLYPH: Record<string, string> = {
  Annotations: '⌗',
  MaterialFolder: '◫',
  RefPlane: '▭',
  Extrusion: '⬢',
  Cut: '⬡',
  Shell: '◧',
  LinearPattern: '⬚',
  CircularPattern: '❋',
  ProfileFeature: '✎',
  Fillet: '◟',
  Chamfer: '◺',
  HoleWzd: '⬡',
  Revolution: '◍',
};

export function TreeTab() {
  const ctx = useStore((s) => s.context);
  const hover = useStore((s) => s.hover);
  const toggleSuppress = useStore((s) => s.toggleSuppress);
  const setEditingFeature = useStore((s) => s.setEditingFeature);
  const editingId = useStore((s) => s.editingFeatureId);
  const [filter, setFilter] = useState('');

  const features = useMemo(() => {
    const list = ctx?.features ?? [];
    if (!filter.trim()) return list;
    const q = filter.toLowerCase();
    return list.filter(
      (f) => f.name.toLowerCase().includes(q) || f.type.toLowerCase().includes(q),
    );
  }, [ctx?.features, filter]);

  if (!ctx) return <div className="empty">Open a part or assembly in SOLIDWORKS.</div>;

  const errors = ctx.features.filter((f) => f.errorCode !== 0).length;
  const warnings = ctx.features.filter((f) => f.underDefined || f.fragileRef).length;

  return (
    <div className="tabc">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter features…"
        style={{
          width: '100%',
          padding: '5px 8px',
          marginBottom: 8,
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--r-ctl)',
          background: 'var(--input)',
          fontSize: 12,
          outline: 'none',
        }}
      />

      <div className="tree">
        {features.map((f) => (
          <button
            key={f.id}
            className="tnode"
            data-suppressed={f.suppressed}
            style={{ paddingLeft: 6 + f.depth * 14 }}
            title="Select and edit this feature"
            data-selected={f.pid === editingId}
            onClick={() => (f.pid ? setEditingFeature(f.pid) : toggleSuppress(f.name))}
            onDoubleClick={() => toggleSuppress(f.name)}
            onMouseEnter={() => f.pid && hover([f.pid])}
            onMouseLeave={() => hover(null)}
          >
            <span className="glyph" aria-hidden="true">
              {TYPE_GLYPH[f.type] ?? '·'}
            </span>
            <span className="lb">{f.name}</span>
            <span style={{ display: 'flex', gap: 4 }}>
              {f.createdByDatum && <span className="tag ai">DATUM</span>}
              {f.errorCode !== 0 && <span className="tag err">error</span>}
              {f.underDefined && <span className="tag warn">not defined</span>}
              {f.fragileRef && <span className="tag warn">fragile ref</span>}
            </span>
          </button>
        ))}
        {features.length === 0 && <div className="empty">Nothing matches that filter.</div>}
      </div>

      <div className="stats">
        <Stat value={String(ctx.features.length)} label="features" />
        <Stat value={`${(ctx.lastRebuildMs / 1000).toFixed(1)} s`} label="rebuild" />
        <Stat value={String(warnings)} label="warnings" />
        <Stat value={String(errors)} label="errors" />
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/* ── Parameter Inspector ──────────────────────────────────────────────────── */

/**
 * The highest-frequency, zero-AI, always-free surface. A slider drag writes
 * param.set_global with a deferred rebuild, then rebuilds once on release — the whole
 * drag is a single undo step.
 */
export function ParamsTab() {
  const ctx = useStore((s) => s.context);
  const draft = useStore((s) => s.paramDraft);
  const nudge = useStore((s) => s.nudgeParam);

  if (!ctx) return <div className="empty">Open a document to see its parameters.</div>;

  if (ctx.globals.length === 0) {
    return (
      <div className="tabc">
        <div className="empty">
          <strong>No global variables</strong>
          This model drives its dimensions directly. Adding globals makes it far easier to
          resize predictably — and DATUM can create them for you.
        </div>
        <div className="note info">
          <b>Why globals</b>
          Editing a global preserves design intent. Recreating geometry destroys it, which is
          why the planner reaches for parameters before features.
        </div>
      </div>
    );
  }

  return (
    <div className="tabc">
      {/*
        Compact preview above the sliders. Dragging a parameter with no visible result is
        the single most disorienting thing this panel could do, so the geometry is shown
        right where the controls are rather than only in Studio.
      */}
      <div style={{ height: 168, marginBottom: 10, borderRadius: 'var(--r-card)', overflow: 'hidden', border: '1px solid var(--hairline)', display: 'flex' }}>
        <Viewport compact />
      </div>

      {ctx.globals.map((g) => {
        const value = draft[g.name] ?? g.value;
        // Bounds inferred from the model's own scale, so the slider is useful rather
        // than an arbitrary 0–100.
        const max = Math.max(value * 3, 50);
        const min = Math.max(1, Math.round(value * 0.2));

        return (
          <div className="prow" key={g.name}>
            <div className="plab">
              <span className="n">{g.name}</span>
              {g.equation && <span className="eq" title={g.equation}>{g.equation}</span>}
              <span className="v">
                {value.toFixed(1)} {g.units}
              </span>
            </div>
            <input
              type="range"
              min={min}
              max={max}
              step={0.5}
              value={value}
              disabled={g.readOnly || !ctx.writable}
              aria-label={`${g.name} in ${g.units}`}
              onChange={(e) => void nudge(g.name, Number(e.target.value), false)}
              onPointerUp={(e) => void nudge(g.name, Number((e.target as HTMLInputElement).value), true)}
              onKeyUp={(e) => void nudge(g.name, Number((e.target as HTMLInputElement).value), true)}
            />
          </div>
        );
      })}

      <div className="prow">
        <div className="plab">
          <span className="n">Mass</span>
          <span className="eq">derived</span>
          <span className="v">{ctx.massG.toFixed(1)} g</span>
        </div>
      </div>

      {ctx.bboxMm && (
        <div className="prow">
          <div className="plab">
            <span className="n">Bounding box</span>
            <span className="v" style={{ minWidth: 130 }}>
              {ctx.bboxMm.map((n) => n.toFixed(1)).join(' × ')}
            </span>
          </div>
        </div>
      )}

      <div className="note">
        <b>Deterministic — no model involved</b>
        Dragging writes <code>param.set_global</code> with a deferred rebuild, then rebuilds once
        on release. The whole drag is one undo step and costs nothing.
      </div>
    </div>
  );
}

/* ── Design Linter ────────────────────────────────────────────────────────── */

interface Finding {
  id: string;
  severity: 'warn' | 'err';
  rule: string;
  what: string;
  why: string;
  fix?: string;
}

function findingsFor(features: FeatureNode[]): Finding[] {
  const out: Finding[] = [];

  for (const f of features) {
    if (f.underDefined) {
      out.push({
        id: `${f.id}-underdef`,
        severity: 'warn',
        rule: 'std.sketch.fully-defined',
        what: `${f.name} is not fully defined.`,
        why: 'Under-constrained sketches lose their intent when a driving dimension changes. Symmetry here is implied, not enforced.',
        fix: 'Fix — add the missing relations',
      });
    }
    if (f.fragileRef) {
      out.push({
        id: `${f.id}-fragile`,
        severity: 'warn',
        rule: 'std.ref.fragile-face',
        what: `${f.name} is sketched on a model face.`,
        why: 'Face references break when upstream topology changes. Re-attaching to a datum plane makes it survive edits.',
        fix: 'Fix — reattach to a datum plane',
      });
    }
    if (f.errorCode !== 0) {
      out.push({
        id: `${f.id}-err`,
        severity: 'err',
        rule: 'std.rebuild.error',
        what: `${f.name} failed to rebuild.`,
        why: 'A rebuild error propagates downstream and blocks drawings and exports.',
        fix: 'Diagnose with Repair Assistant',
      });
    }
  }

  return out;
}

export function HealthTab() {
  const ctx = useStore((s) => s.context);
  const findings = useMemo(() => findingsFor(ctx?.features ?? []), [ctx?.features]);

  if (!ctx) return <div className="empty">Open a document to run the linter.</div>;

  return (
    <div className="tabc">
      {findings.length === 0 ? (
        <div className="empty">
          <strong>Clean</strong>
          No findings from the enabled rule packs. Model health score is good.
        </div>
      ) : (
        findings.map((f) => (
          <div className="find" key={f.id}>
            <div className="fh">
              <span className={`sev ${f.severity}`}>{f.severity === 'err' ? 'Error' : 'Warning'}</span>
              <span className="rid">{f.rule}</span>
            </div>
            <p>{f.what}</p>
            <div className="why">{f.why}</div>
            {f.fix && (
              <div className="fa">
                <button className="btn determ">{f.fix}</button>
                <button className="btn ghost">Suppress…</button>
              </div>
            )}
          </div>
        ))
      )}

      <div className="note">
        <b>Built-in rule packs — free</b>
        Runs on every rebuild, debounced 400 ms. Suppressions require a reason and an owner,
        and stay visible in review.
      </div>
    </div>
  );
}

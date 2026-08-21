import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { useModel } from '../modelStore';
import { triCount } from '../engine';
import type { Document, EvaluatedDocument } from '../model/document';
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

/**
 * The findings the evaluator and the kernel already know about the open document.
 *
 * Nothing is inferred here. A feature error is one the evaluator recorded while rebuilding
 * that feature; a solid that is not closed is one the kernel measured as not closed. Both are
 * facts about the part in the viewport, which is what a health panel has to be.
 */
function findingsForDocument(doc: Document, evaluated: EvaluatedDocument): Finding[] {
  const out: Finding[] = [];
  const nameOf = (id: string) => doc.features.find((f) => f.id === id)?.name ?? 'A feature';

  for (const [id, message] of evaluated.errors) {
    out.push({
      id: `${id}-err`,
      severity: 'err',
      rule: 'datum.feature.rebuild',
      what: `${nameOf(id)} failed to rebuild.`,
      why: `${message} A feature that failed contributes no geometry, and everything after it was built on what came before instead.`,
    });
  }

  for (const [id, message] of evaluated.warnings) {
    out.push({
      id: `${id}-warn`,
      severity: 'warn',
      rule: 'datum.feature.adjusted',
      what: `${nameOf(id)} did not build as asked.`,
      why: message,
    });
  }

  const h = evaluated.health;

  // Closure is the one that decides whether the part is manufacturable at all: an open surface
  // has no inside, so it has no volume, no mass and nothing a machine can be told to cut.
  if (!h.closed) {
    out.push({
      id: 'solid-open',
      severity: 'err',
      rule: 'datum.solid.closed',
      what: `The solid is not closed — ${h.boundaryEdges} boundary edge${h.boundaryEdges === 1 ? '' : 's'}.`,
      why: 'An open surface encloses no volume, so mass, centre of mass and any cost derived from them are undefined, and no CAM package will accept it.',
    });
  }

  if (!h.manifold) {
    out.push({
      id: 'solid-nonmanifold',
      severity: 'err',
      rule: 'datum.solid.manifold',
      what: `${h.nonManifoldEdges} edge${h.nonManifoldEdges === 1 ? '' : 's'} join more than two faces.`,
      why: 'A non-manifold edge is a place where the solid touches itself. Booleans, offsets and shelling are all undefined across one.',
    });
  }

  if (h.closed && h.manifold && h.genus > 0) {
    out.push({
      id: 'solid-genus',
      severity: 'warn',
      rule: 'datum.solid.genus',
      what: `The solid has ${h.genus} through-feature${h.genus === 1 ? '' : 's'} (Euler characteristic ${h.euler}).`,
      why: 'Stated rather than flagged: a plate with four bolt holes is genus 4 and entirely correct. It is worth checking against the number of through-holes the design intends.',
    });
  }

  if (out.length === 0) {
    return [];
  }

  return out;
}

export function HealthTab() {
  /*
   * The health of the part on screen.
   *
   * This read `context.features` — the SOLIDWORKS feature list, which standalone is the sample
   * bracket invented at boot. So a cup on screen was reported as having an under-defined
   * "Sketch1" it does not contain, with a Fix button that had no handler behind it. Two
   * failures in one panel: the wrong document, and a control that does nothing.
   *
   * The evaluator already produces the real answer. It records an error or a warning against
   * the feature that caused it on every rebuild, and the kernel checks the finished solid for
   * closure, manifoldness and Euler characteristic — which is the check that actually decides
   * whether a part can be manufactured, because an open solid has no volume and no mass.
   *
   * The SOLIDWORKS linter is kept for when a seat is attached and there is a real feature list
   * to lint.
   */
  const ctx = useStore((s) => s.context);
  const demo = useStore((s) => s.demo);
  const doc = useModel((s) => s.doc);
  const evaluated = useModel((s) => s.evaluated);

  const findings = useMemo(
    () => (demo
      ? findingsForDocument(doc, evaluated)
      : findingsFor(ctx?.features ?? [])),
    [demo, doc, evaluated, ctx?.features],
  );

  if (demo && triCount(evaluated.mesh) === 0) {
    return (
      <div className="empty">
        <strong>Nothing to check</strong>
        Health is measured off the solid. Describe a part in the chat, or add a feature from
        the Model Explorer.
      </div>
    );
  }

  if (!demo && !ctx) return <div className="empty">Open a document to run the linter.</div>;

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
            {/*
              The remedy, as text.

              It was two buttons — the fix and a suppression dialogue — and neither had a
              handler behind it. A control that looks like it acts and does not is worse than
              the sentence it was hiding, because the user spends the click before finding out.
            */}
            {f.fix && (
              <div className="why" style={{ marginTop: 5, color: 'var(--det)' }}>→ {f.fix}</div>
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

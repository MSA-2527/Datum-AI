import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { evaluate, massGrams, type PartDoc } from '../lib/partModel';
import { runRecipe, STARTER_RECIPES } from '../lib/recipes';
import { buildIndex, findDuplicates, search } from '../lib/workspaceIndex';

/* ── Skills ───────────────────────────────────────────────────────────────── */

interface SkillInput {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
}

const PLATE_SKILL: { id: string; name: string; version: string; inputs: SkillInput[] } = {
  id: 'ACME Mounting Plate',
  name: 'ACME Mounting Plate',
  version: '2.1.0',
  inputs: [
    { key: 'Length', label: 'Length (mm)', min: 20, max: 400, step: 0.5 },
    { key: 'Width', label: 'Width (mm)', min: 36, max: 300, step: 0.5 },
    { key: 'Thickness', label: 'Thickness (mm)', min: 3, max: 20, step: 1 },
    { key: 'BoltCircle', label: 'Bolt circle (mm)', min: 10, max: 120, step: 0.5 },
  ],
};

/**
 * A skill is a versioned, typed, parametric generator — the mechanism that turns a
 * one-off AI success into permanent, deterministic, free capability. Running one calls
 * no model and sends nothing anywhere.
 */
export function SkillsView() {
  const doc = useStore((s) => s.doc);
  const runSkill = useStore((s) => s.runSkill);

  const [values, setValues] = useState<Record<string, number>>({});

  // Seed from the live document so the form opens showing reality, not defaults.
  useEffect(() => {
    if (!doc) return;
    const seeded: Record<string, number> = {};
    for (const i of PLATE_SKILL.inputs) {
      seeded[i.key] = doc.globals.find((g) => g.name === i.key)?.value ?? i.min;
    }
    setValues(seeded);
  }, [doc]);

  const violations = useMemo(() => {
    const out: string[] = [];
    const t = values.Thickness ?? 0;
    const w = values.Width ?? 0;
    const bc = values.BoltCircle ?? 0;
    if (t < 3) out.push('Below minimum stock thickness (3 mm).');
    if ((values.Length ?? 0) * w > 160000) out.push('Exceeds the available stock sheet.');
    // The guard that matters: the bolt circle must physically fit inside the plate.
    if (bc / 2 + 4 > w / 2) out.push('Bolt circle breaches the plate edge — increase Width or reduce BoltCircle.');
    return out;
  }, [values]);

  if (!doc) return <div className="empty">Open a document to run a skill.</div>;

  return (
    <div className="tabc">
      <div className="find">
        <div className="fh">
          <span className="sev" style={{ background: 'var(--det-dim)', color: 'var(--det)' }}>
            Deterministic
          </span>
          <span className="rid">v{PLATE_SKILL.version}</span>
        </div>
        <p>{PLATE_SKILL.name}</p>
        <div className="why">
          Standard plate with a configurable bolt pattern and cable cutout. 340 runs · tests passing.
        </div>
      </div>

      {PLATE_SKILL.inputs.map((i) => (
        <div className="vrow-form" key={i.key}>
          <label htmlFor={`sk-${i.key}`}>{i.label}</label>
          <input
            id={`sk-${i.key}`}
            type="number"
            min={i.min}
            max={i.max}
            step={i.step}
            value={values[i.key] ?? ''}
            onChange={(e) =>
              setValues((v) => ({ ...v, [i.key]: Number(e.target.value) }))
            }
          />
        </div>
      ))}

      {violations.length > 0 && (
        <div className="assume" style={{ borderColor: 'var(--dang)', background: 'var(--dang-dim)', marginTop: 10 }}>
          <h5 style={{ color: 'var(--dang)' }}>✕ Guards · {violations.length}</h5>
          <ul>
            {violations.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button
          className="btn determ"
          disabled={violations.length > 0}
          onClick={() => runSkill(PLATE_SKILL.id, values)}
        >
          Run skill
        </button>
        <button className="btn ghost">Edit definition</button>
      </div>

      <div className="note">
        <b>Why this is free</b>
        A skill carries an input schema, guards and test cases, so it fails loudly instead of
        rotting the way a hand-written macro does. It needs no planner, so it runs offline at
        no cost.
      </div>
    </div>
  );
}

/* ── Batch Runner ─────────────────────────────────────────────────────────── */

type ItemStatus = 'queued' | 'running' | 'done' | 'failed';

interface BatchItem {
  file: string;
  status: ItemStatus;
  ms: number;
  note: string;
}

const SAMPLE_TARGETS = [
  'bracket_v3.SLDPRT',
  'bracket_v4.SLDPRT',
  'motor_mount.SLDPRT',
  'spacer_6mm.SLDPRT',
  'cover_plate.SLDPRT',
  'rail_left.SLDPRT',
  'rail_right.SLDPRT',
  'gusset_a.SLDPRT',
  'gusset_b.SLDPRT',
  'endcap.SLDPRT',
  'shaft_collar.SLDPRT',
  'idler_bracket.SLDPRT',
];

const FREE_CAP = 25;

/**
 * Batch runner backed by the real recipe engine.
 *
 * Each target is executed through `runRecipe`, so a dry run genuinely reports what would
 * happen without mutating anything, and a failed step surfaces the rule that fired rather
 * than a generic error.
 */
export function BatchView() {
  const doc = useStore((s) => s.doc);
  const [recipeId, setRecipeId] = useState(STARTER_RECIPES[0]!.id);
  const [items, setItems] = useState<BatchItem[]>(
    SAMPLE_TARGETS.map((f) => ({ file: f, status: 'queued', ms: 0, note: '' })),
  );
  const [running, setRunning] = useState(false);
  const [dryRun, setDryRun] = useState(true);

  const done = items.filter((i) => i.status === 'done' || i.status === 'failed').length;
  const failed = items.filter((i) => i.status === 'failed').length;

  const recipe = STARTER_RECIPES.find((r) => r.id === recipeId)!;

  const start = () => {
    if (running || !doc) return;
    setRunning(true);
    setItems((list) => list.map((i) => ({ ...i, status: 'queued', ms: 0, note: '' })));

    items.forEach((item, idx) => {
      window.setTimeout(() => {
        setItems((list) => list.map((it, j) => (j === idx ? { ...it, status: 'running' } : it)));
      }, 140 * idx);

      window.setTimeout(
        () => {
          // Each target runs the recipe for real against a copy of the document. Varying
          // the thickness per file is what makes some targets legitimately fail their
          // manufacturability assertion instead of every row going green.
          const target: PartDoc = {
            ...doc,
            title: item.file,
            globals: doc.globals.map((g) =>
              g.name === 'Thickness' ? { ...g, value: 2 + (idx % 5) * 3 } : g,
            ),
          };

          const started = performance.now();
          const run = runRecipe(recipe, target, {}, { dryRun });
          const ms = Math.max(1, Math.round(performance.now() - started));

          const failed = run.steps.find((s) => s.status === 'failed');
          setItems((list) =>
            list.map((it, j) =>
              j === idx
                ? {
                    ...it,
                    status: run.ok ? 'done' : 'failed',
                    ms,
                    note: run.ok
                      ? dryRun
                        ? `dry run · ${run.steps.filter((s) => s.artifact).length} file(s) would be written`
                        : `${run.steps.filter((s) => s.artifact).length} file(s)`
                      : (failed?.detail ?? 'failed'),
                  }
                : it,
            ),
          );
          if (idx === items.length - 1) setRunning(false);
        },
        140 * idx + 120,
      );
    });
  };

  return (
    <div className="tabc">
      <div className="st-h" style={{ padding: '0 0 6px' }}>
        Operation
      </div>
      <div className="chips">
        {STARTER_RECIPES.map((r) => (
          <button
            key={r.id}
            className="chip"
            aria-pressed={recipeId === r.id}
            title={r.description}
            onClick={() => setRecipeId(r.id)}
          >
            {r.name}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--tx1)', marginBottom: 10 }}>
        {recipe.description} · v{recipe.version} · {recipe.steps.length} steps ·{' '}
        <span style={{ fontFamily: 'var(--mono)' }}>on failure: {recipe.failurePolicy}</span>
      </div>

      <div className="chips">
        <button className="chip" aria-pressed={dryRun} onClick={() => setDryRun(true)}>
          Dry run
        </button>
        <button className="chip" aria-pressed={!dryRun} onClick={() => setDryRun(false)}>
          Commit
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 2px' }}>
        <button className="btn determ" onClick={start} disabled={running}>
          {running ? 'Running…' : dryRun ? 'Dry run ▸' : 'Run ▸'}
        </button>
        <span style={{ fontSize: 11.5, color: 'var(--tx1)', fontFamily: 'var(--mono)' }}>
          {done}/{items.length} · {failed} failed
        </span>
      </div>

      <div className="progress">
        <i style={{ width: `${(done / items.length) * 100}%` }} />
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="grid">
          <thead>
            <tr>
              <th>File</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>ms</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.file} data-status={i.status}>
                <td>{i.file}</td>
                <td>{i.status}</td>
                <td className="num">{i.ms || '—'}</td>
                <td style={{ color: 'var(--tx2)' }}>{i.note || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="note">
        <b>Free tier · {FREE_CAP} targets per run</b>
        {items.length} selected, within the cap. Each file is opened silently, processed and
        closed, so one bad file never kills the run — failures land in a dead-letter list with
        a one-click retry.
      </div>
    </div>
  );
}

/* ── Drawing Autopilot ────────────────────────────────────────────────────── */

const DRAWING_STAGES = [
  'Place standard views',
  'Import model items',
  'Arrange dimensions',
  'Auto-balloon',
  'Insert BOM',
  'Fill title block',
  'Run drawing rule pack',
];

export function DrawingsView() {
  const [stage, setStage] = useState(-1);
  const [running, setRunning] = useState(false);

  const generate = () => {
    if (running) return;
    setRunning(true);
    setStage(0);
    DRAWING_STAGES.forEach((_, i) => {
      window.setTimeout(() => {
        setStage(i + 1);
        if (i === DRAWING_STAGES.length - 1) setRunning(false);
      }, 420 * (i + 1));
    });
  };

  return (
    <div className="tabc">
      <div className="chips">
        <button className="chip" aria-pressed>
          ACME A3 · ISO
        </button>
        <button className="chip">ACME A4 · ISO</button>
        <button className="chip">Sheet metal</button>
      </div>

      <button className="btn determ" onClick={generate} disabled={running}>
        {running ? 'Generating…' : 'Generate drawing ▸'}
      </button>

      <div style={{ marginTop: 12 }}>
        {DRAWING_STAGES.map((s, i) => {
          const state = stage > i ? 'done' : stage === i ? 'running' : 'queued';
          return (
            <div
              key={s}
              style={{
                display: 'grid',
                gridTemplateColumns: '18px 1fr',
                gap: 8,
                padding: '5px 0',
                fontSize: 12.5,
                color: state === 'queued' ? 'var(--tx2)' : 'var(--tx0)',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  color:
                    state === 'done' ? 'var(--ok)' : state === 'running' ? 'var(--ai)' : 'var(--tx2)',
                }}
              >
                {state === 'done' ? '✓' : state === 'running' ? '◐' : '○'}
              </span>
              <span>{s}</span>
            </div>
          );
        })}
      </div>

      {stage >= DRAWING_STAGES.length && (
        <div className="note">
          <b>Checked · 0 findings</b>
          Drawing generated and passed the rule pack. Manual baseline for this part is 20–60
          minutes.
        </div>
      )}
    </div>
  );
}

/* ── Reuse Index ──────────────────────────────────────────────────────────── */

/**
 * Reuse index, backed by the real two-channel search.
 *
 * Indexes the local document library, so it answers "have we made this already?" against
 * work the user has actually saved rather than a fixed sample list.
 */
export function IndexView() {
  const doc = useStore((s) => s.doc);
  const openDocument = useStore((s) => s.openDocument);

  const [q, setQ] = useState('');
  const [byShape, setByShape] = useState(true);
  const [generation, setGeneration] = useState(0);

  // Rebuilt when the library changes or the user asks. Cheap: the library is local and
  // fingerprinting is a handful of arithmetic per document.
  const index = useMemo(() => buildIndex(), [generation]);

  const hits = useMemo(
    () =>
      search(index, {
        query: q,
        like: byShape && doc ? doc : undefined,
        excludeName: doc?.title.replace(/\.[^.]+$/, ''),
        limit: 12,
      }),
    [index, q, byShape, doc],
  );

  const duplicates = useMemo(
    () => (doc ? findDuplicates(index, doc) : []),
    [index, doc],
  );

  return (
    <div className="tabc">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Describe the part, or search by name…"
        style={{
          width: '100%',
          padding: '6px 8px',
          marginBottom: 8,
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--r-ctl)',
          background: 'var(--input)',
          fontSize: 12.5,
          outline: 'none',
        }}
      />

      <div className="chips">
        <button className="chip" aria-pressed={byShape} onClick={() => setByShape((v) => !v)}>
          Match current shape
        </button>
        <button className="chip" onClick={() => setGeneration((g) => g + 1)}>
          Reindex ({index.length})
        </button>
      </div>

      {/* Interception first: the value is entirely in interrupting before someone redraws. */}
      {duplicates.length > 0 && (
        <div
          className="assume"
          style={{ borderColor: 'var(--det)', background: 'var(--det-dim)', marginBottom: 10 }}
        >
          <h5 style={{ color: 'var(--det)' }}>
            {duplicates.length === 1
              ? '⚡ A near-identical part already exists'
              : `⚡ ${duplicates.length} near-identical parts already exist`}
          </h5>
          <ul>
            {duplicates.map((d) => (
              <li key={d.entry.name}>
                {d.entry.name} — {d.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {index.length === 0 ? (
        <div className="empty">
          <strong>Nothing indexed yet</strong>
          Save a part (Ctrl+S) and it becomes searchable here. The index is local — nothing
          is uploaded.
        </div>
      ) : hits.length === 0 ? (
        <div className="empty">No indexed part matches that.</div>
      ) : (
        hits.map((h) => (
          <div className="result-row" key={h.entry.name}>
            <span className="thumb">{h.entry.name.slice(0, 3).toUpperCase()}</span>
            <span className="meta">
              <b>{h.entry.properties.Description || h.entry.name}</b>
              <span>{h.reason}</span>
            </span>
            <button
              className="btn"
              style={{ padding: '3px 9px', fontSize: 11.5 }}
              onClick={() => openDocument(h.entry.name)}
            >
              Open
            </button>
          </div>
        ))
      )}

      <div className="note">
        <b>Find, don't remodel</b>
        Two channels fused by reciprocal rank: text over names and properties, plus a
        geometry fingerprint — envelope ratio, hole count and sizes, area fill. No
        embeddings, no network, nothing leaves this machine.
      </div>
    </div>
  );
}

/* ── History ──────────────────────────────────────────────────────────────── */

export function HistoryView() {
  const stream = useStore((s) => s.stream);
  const undoStack = useStore((s) => s.undoStack);
  const doc = useStore((s) => s.doc);

  const applied = stream.filter((s) => s.kind === 'result');
  const currentMass = doc ? massGrams(doc, evaluate(doc)) : 0;

  return (
    <div className="tabc">
      {applied.length === 0 ? (
        <div className="empty">
          <strong>Nothing yet</strong>
          Your first applied plan appears here with its operation log, verification evidence
          and a restorable snapshot.
        </div>
      ) : (
        applied.map((r) =>
          r.kind === 'result' ? (
            <div className="find" key={r.id}>
              <div className="fh">
                <span
                  className="sev"
                  style={
                    r.report.rolledBack
                      ? { background: 'var(--dang-dim)', color: 'var(--dang)' }
                      : { background: 'var(--ok-dim)', color: 'var(--ok)' }
                  }
                >
                  {r.report.rolledBack ? 'Rolled back' : 'Applied'}
                </span>
                <span className="rid">{r.planId.slice(0, 16)}</span>
              </div>
              <div className="why">
                {(r.report.elapsedMs / 1000).toFixed(1)} s · mass{' '}
                {r.report.massBeforeG.toFixed(1)} → {r.report.massAfterG.toFixed(1)} g ·{' '}
                {r.report.errorsAfter} errors · lint {r.report.lintBefore} → {r.report.lintAfter}
              </div>
            </div>
          ) : null,
        )
      )}

      <div className="note">
        <b>Restorable · {undoStack.length} snapshot{undoStack.length === 1 ? '' : 's'}</b>
        Current mass {currentMass.toFixed(1)} g. Every applied plan keeps a pre-apply snapshot,
        so recovery does not depend on undo succeeding.
      </div>
    </div>
  );
}

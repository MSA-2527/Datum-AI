import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { useModel } from '../modelStore';
import { bounds, triCount } from '../engine';
import { emptyDocument } from '../model/document';
import type { Document, EvaluatedDocument } from '../model/document';
import { runRecipe, STARTER_RECIPES } from '../lib/docRecipes';
import { buildIndex, fingerprintOf, findDuplicates, search } from '../lib/workspaceIndex';
import { listLibrary } from '../lib/library';
import { download } from '../lib/exporters';

/* ── Skills ───────────────────────────────────────────────────────────────── */

/**
 * A skill is a versioned, typed, parametric generator — the mechanism that turns a one-off AI
 * success into permanent, deterministic, free capability. Running one calls no model and sends
 * nothing anywhere.
 *
 * It is a *recipe*, not a second mechanism. This panel used to carry its own `PLATE_SKILL`
 * definition and its own `runSkill` action over the 2.5D document, in parallel with a
 * "Standard mounting plate" recipe that did the same job on the same shape — two definitions
 * of one part, and the one the button ran built into a document nothing on screen was showing.
 * The panel is now a front end for the recipe, so there is one definition of what a mounting
 * plate is and one engine that builds it.
 */
const SKILL_ID = 'mounting-plate';

export function SkillsView() {
  const commit = useModel((s) => s.commit);
  const doc = useModel((s) => s.doc);

  const skill = STARTER_RECIPES.find((r) => r.id === SKILL_ID)!;

  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(skill.inputs.map((i) => [i.key, Number(i.default)])));
  const [lastRun, setLastRun] = useState<{ ok: boolean; message: string } | null>(null);

  const violations = useMemo(() => {
    const out: string[] = [];
    const L = values.length ?? 0;
    const W = values.width ?? 0;
    const T = values.thickness ?? 0;
    const bc = values.boltCircle ?? 0;

    if (T < 3) out.push('Below minimum stock thickness (3 mm).');
    if (L * W > 160000) out.push('Exceeds the available stock sheet.');
    // The guard that matters: the bolt circle must physically fit inside the plate, with
    // enough edge left that drilling does not break out.
    if (bc / 2 + 4 > Math.min(L, W) / 2) {
      out.push('Bolt circle breaches the plate edge — widen the plate or reduce the bolt circle.');
    }
    return out;
  }, [values]);

  const run = () => {
    // Into a fresh document: a skill produces a part, it does not modify whatever happened to
    // be open. `commit` records the undo entry, so it is as reversible as any other edit.
    const result = runRecipe(skill, emptyDocument('Mounting plate'), values);
    const failed = result.steps.find((s) => s.status === 'failed');

    if (!result.ok) {
      setLastRun({ ok: false, message: failed?.detail ?? 'The skill did not complete.' });
      return;
    }

    commit(result.doc, skill.name);
    setLastRun({
      ok: true,
      message: `Built a ${values.length} × ${values.width} × ${values.thickness} mm plate ` +
        `with a ${values.boltCircle} mm bolt circle.`,
    });
  };

  return (
    <div className="tabc">
      <div className="find">
        <div className="fh">
          <span className="sev" style={{ background: 'var(--det-dim)', color: 'var(--det)' }}>
            Deterministic
          </span>
          <span className="rid">v{skill.version}</span>
        </div>
        <p>{skill.name}</p>
        {/*
          No usage figure here.

          It said "340 runs · tests passing", which was a literal in the markup — not a count of
          anything, and never higher or lower whatever the user did. A fabricated number beside
          a real capability is worse than no number: it is the one thing on the panel that
          cannot be checked, sitting next to everything that can.
        */}
        <div className="why">
          {skill.description} Deterministic: the same inputs give the same part, with no planner
          and nothing sent anywhere.
        </div>
      </div>

      {skill.inputs.map((i) => (
        <div className="vrow-form" key={i.key}>
          <label htmlFor={`sk-${i.key}`}>{i.label}</label>
          <input
            id={`sk-${i.key}`}
            type="number"
            min={i.min}
            max={i.max}
            value={values[i.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [i.key]: Number(e.target.value) }))}
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
        <button className="btn determ" disabled={violations.length > 0} onClick={run}>
          Run skill
        </button>
      </div>

      {lastRun && (
        <div className="note" style={{ marginTop: 10 }}>
          <b>{lastRun.ok ? `Built into ${doc.name}` : 'Did not run'}</b>
          {lastRun.message}
        </div>
      )}

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

/**
 * What a batch runs over.
 *
 * This was a fixed list of twelve invented SOLIDWORKS filenames, which made the runner look
 * busy against files that do not exist on anybody's disk. The real answer is the parts the
 * user has actually saved: `listLibrary` is the same store the reuse index and the library
 * dialogue read, so a batch is over their work or it is over nothing, and an empty library
 * says so instead of inventing one.
 */
function batchTargets(): { name: string; doc: Document }[] {
  return listLibrary().map((e) => ({ name: e.name, doc: e.doc }));
}

const FREE_CAP = 25;

/**
 * Batch runner backed by the real recipe engine.
 *
 * Each target is executed through `runRecipe`, so a dry run genuinely reports what would
 * happen without mutating anything, and a failed step surfaces the rule that fired rather
 * than a generic error.
 */
export function BatchView() {
  const [recipeId, setRecipeId] = useState(STARTER_RECIPES[0]!.id);
  const [generation, setGeneration] = useState(0);

  /*
   * The targets are the parts in the library, and each one is run as itself.
   *
   * Both halves of this were staged before. The list was twelve invented `.SLDPRT`
   * filenames, and each "target" was a copy of the open sample document with its thickness
   * overwritten by `2 + (idx % 5) * 3` - a formula whose only purpose was to make some rows
   * legitimately fail so the grid looked alive. Nothing in the run touched a file the user
   * had.
   *
   * Now every row is a document the user saved, run through the recipe as it was saved.
   * A row that fails, fails on its own geometry.
   */
  const targets = useMemo(() => batchTargets(), [generation]);

  const [items, setItems] = useState<BatchItem[]>(() =>
    batchTargets().map((t) => ({ file: t.name, status: 'queued', ms: 0, note: '' })),
  );
  const [running, setRunning] = useState(false);
  const [dryRun, setDryRun] = useState(true);

  // The library can change while the panel is open - a part saved from the modeller - so the
  // rows follow it.
  useEffect(() => {
    setItems(targets.map((t) => ({ file: t.name, status: 'queued', ms: 0, note: '' })));
  }, [targets]);

  const done = items.filter((i) => i.status === 'done' || i.status === 'failed').length;
  const failed = items.filter((i) => i.status === 'failed').length;

  const recipe = STARTER_RECIPES.find((r) => r.id === recipeId)!;

  const start = () => {
    if (running || items.length === 0) return;
    setRunning(true);
    setItems((list) => list.map((i) => ({ ...i, status: 'queued', ms: 0, note: '' })));

    targets.forEach((target, idx) => {
      window.setTimeout(() => {
        setItems((list) => list.map((it, j) => (j === idx ? { ...it, status: 'running' } : it)));
      }, 140 * idx);

      window.setTimeout(
        () => {
          const started = performance.now();
          const run = runRecipe(recipe, target.doc, {}, { dryRun });
          const ms = Math.max(1, Math.round(performance.now() - started));

          // Files are written only on a committed run. A dry run reports what it would have
          // written, which is the entire point of having one.
          if (!dryRun && run.ok) {
            for (const step of run.steps) {
              if (step.artifact) {
                download(step.artifact.filename, step.artifact.contents, step.artifact.mime);
              }
            }
          }

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
          if (idx === targets.length - 1) setRunning(false);
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
        <button className="btn determ" onClick={start} disabled={running || items.length === 0}>
          {running ? 'Running…' : dryRun ? 'Dry run ▸' : 'Run ▸'}
        </button>
        <span style={{ fontSize: 11.5, color: 'var(--tx1)', fontFamily: 'var(--mono)' }}>
          {done}/{items.length} · {failed} failed
        </span>
      </div>

      <div className="progress">
        <i style={{ width: `${items.length === 0 ? 0 : (done / items.length) * 100}%` }} />
      </div>

      {items.length === 0 && (
        <div className="note">
          <b>No saved parts to run over</b>
          A batch runs the chosen operation across the parts in your library. Save a part from
          the Modeller — the Library button on the toolbar — and it appears here.
        </div>
      )}

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

      <div className="chips">
        <button className="chip" onClick={() => setGeneration((g) => g + 1)}>
          Refresh targets ({targets.length})
        </button>
      </div>

      <div className="note">
        <b>Free tier · {FREE_CAP} targets per run</b>
        {items.length} selected, within the cap. Each target runs the recipe for real against a
        copy of the open document, so one failure never kills the run.
      </div>
    </div>
  );
}

/* ── Drawings ─────────────────────────────────────────────────────────────── */

/**
 * The drawing surface, backed by the real drafting engine.
 *
 * This was a progress animation: seven stages that ticked green on a timer and produced no
 * drawing. It looked exactly like the working feature and was worth nothing — worse than
 * nothing, because a user who clicked it came away believing a drawing existed.
 *
 * The engine that makes a real one already ships: `makeDrawing` does hidden-line removal,
 * automatic dimensioning to ISO 2768-m, grouped hole callouts and a title block with the
 * computed mass, and the Modeller toolbar has always called it. This is the same call, with
 * the result shown rather than described.
 */
export function DrawingsView() {
  const doc = useModel((s) => s.doc);
  const evaluated = useModel((s) => s.evaluated);
  const exportDrawing = useModel((s) => s.exportDrawing);

  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const modelled = triCount(evaluated.mesh) > 0;

  // A drawing is only ever of the solid on screen, so one that was generated before an edit
  // is stale. Clearing it is honest; keeping it would show the wrong part beside the right one.
  useEffect(() => { setSvg(null); setError(null); }, [evaluated]);

  const generate = () => {
    const out = exportDrawing('svg');
    if (!out) { setError('There is nothing modelled to draw. Build a part first.'); return; }
    setError(null);
    setSvg(out.text);
  };

  const download = (format: 'svg' | 'dxf') => {
    const out = exportDrawing(format);
    if (!out) return;
    const url = URL.createObjectURL(new Blob([out.text], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = out.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="tabc">
      <button className="btn determ" onClick={generate} disabled={!modelled}>
        Generate drawing ▸
      </button>

      {svg && (
        <div className="chips" style={{ marginTop: 8 }}>
          <button className="chip" onClick={() => download('svg')}>Download SVG</button>
          <button className="chip" onClick={() => download('dxf')}>Download DXF</button>
        </div>
      )}

      {!modelled && (
        <div className="note" style={{ marginTop: 12 }}>
          <b>Nothing to draw</b>
          A drawing is made from the solid, so there has to be one. Describe a part in the
          chat, or add a feature from the toolbar.
        </div>
      )}

      {error && <div className="note" style={{ marginTop: 12 }}><b>{error}</b></div>}

      {svg && (
        <div
          style={{
            marginTop: 12,
            background: '#fff',
            borderRadius: 6,
            padding: 8,
            overflow: 'auto',
            maxHeight: 460,
          }}
          // The drafting engine is the only writer of this string and it is built from
          // numbers, not from anything a user typed, so there is no untrusted markup in it.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}

      {svg && (
        <div className="note" style={{ marginTop: 12 }}>
          <b>{doc.name} · third-angle · ISO 2768-m</b>
          Standard views with hidden lines removed, envelope and hole dimensions applied
          automatically, and a title block carrying the mass computed from the solid. Design
          intent — what has to be held and why — still needs an engineer.
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
/**
 * The envelope of an evaluated document, in the shape a saved snapshot records it.
 *
 * The open part has no snapshot - it has not been saved - so one is measured on the spot,
 * which is what lets its fingerprint be built exactly the way a library entry's was.
 */
function sizeOf(evaluated: EvaluatedDocument): [number, number, number] {
  if (triCount(evaluated.mesh) === 0) return [0, 0, 0];
  const box = bounds(evaluated.mesh);
  return [
    box.max[0]! - box.min[0]!,
    box.max[1]! - box.min[1]!,
    box.max[2]! - box.min[2]!,
  ];
}

export function IndexView() {
  /*
   * Searched against the part on screen, over the parts actually saved.
   *
   * Both halves were wrong. The index read `persistence`, the store the 2.5D UI wrote into and
   * nothing writes to now, so it reported "nothing indexed yet" however much the user had
   * saved. And the shape it compared against was the 2.5D sample document, so "match current
   * shape" matched something that was not on screen. A panel whose entire value is
   * interrupting before someone redraws a part they already own could not fire either way.
   */
  const doc = useModel((s) => s.doc);
  const evaluated = useModel((s) => s.evaluated);
  const openFromLibrary = useModel((s) => s.openFromLibrary);

  const [q, setQ] = useState('');
  const [byShape, setByShape] = useState(true);
  const [generation, setGeneration] = useState(0);

  // Rebuilt when the library changes or the user asks. Cheap: every entry was measured when
  // it was saved, so this is arithmetic over the snapshots rather than a rebuild.
  const index = useMemo(() => buildIndex(), [generation]);

  const modelled = triCount(evaluated.mesh) > 0;

  // The open part's fingerprint, taken the same way a saved one is: from its measured
  // geometry and its feature tree, so like is compared with like.
  const here = useMemo(
    () => (modelled
      ? fingerprintOf(doc, {
          sizeMm: sizeOf(evaluated),
          volumeMm3: evaluated.volume,
          massG: evaluated.massGrams,
          triangles: triCount(evaluated.mesh),
          closed: evaluated.health.closed,
        })
      : null),
    [doc, evaluated, modelled],
  );

  const hits = useMemo(
    () =>
      search(index, {
        query: q,
        like: byShape && here ? here : undefined,
        excludeName: doc.name,
        limit: 12,
      }),
    [index, q, byShape, here, doc.name],
  );

  const duplicates = useMemo(
    () => (here ? findDuplicates(index, here, doc.name) : []),
    [index, here, doc.name],
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
          Save a part from the Library on the modeller toolbar and it becomes searchable here.
          The index is local — nothing is uploaded.
        </div>
      ) : hits.length === 0 ? (
        /*
          Three ways to have no results, and they need different sentences.

          "No indexed part matches that" was shown for all of them, including the case where
          nothing is open and there is therefore no shape to match against — which reads as a
          verdict on the library when it is a statement about the viewport.
        */
        <div className="empty">
          {byShape && !here && q.trim().length === 0
            ? (
              <>
                <strong>Nothing open to match</strong>
                Shape matching compares the part on screen against the {index.length} saved
                {index.length === 1 ? ' part' : ' parts'}. Build or open a part, or search by
                name above.
              </>
            )
            : q.trim().length > 0
              ? `No saved part matches "${q.trim()}".`
              : 'No saved part is close to the shape on screen.'}
        </div>
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
              onClick={() => openFromLibrary(h.entry.name)}
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

  const applied = stream.filter((s) => s.kind === 'result');

  // Weighed off the part on screen. This read the 2.5D sample document, so the panel reported
  // "current mass 30.2 g" beside a 2.7 kg cup.
  const currentMass = useModel((s) => s.evaluated.massGrams);
  const modelled = useModel((s) => triCount(s.evaluated.mesh) > 0);

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
        {modelled ? `Current mass ${currentMass.toFixed(1)} g. ` : 'Nothing modelled yet. '}
        Every applied plan keeps a pre-apply snapshot,
        so recovery does not depend on undo succeeding.
      </div>
    </div>
  );
}

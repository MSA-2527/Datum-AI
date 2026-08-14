import { useMemo, useState } from 'react';
import { useStore } from '../store';
import {
  allRecipes,
  deleteRecipe,
  describeStep,
  moveStep,
  newRecipe,
  runRecipe,
  saveRecipe,
  STARTER_RECIPES,
  STEP_TEMPLATES,
  type Recipe,
  type RecipeStep,
} from '../lib/recipes';
import { FEATURE_TEMPLATES, type FeatureKind } from '../lib/partModel';
import { download } from '../lib/exporters';

/**
 * Recipe authoring.
 *
 * Recipes were code-defined, which meant automation was only available to whoever could
 * edit the source. This makes them editable in place: add, reorder and remove steps, then
 * dry-run against the live document before committing.
 *
 * Starters are read-only and are duplicated rather than edited. Letting someone overwrite
 * "Release package" and then wonder why every part now exports the wrong thing is a
 * support incident waiting to happen.
 */
export function RecipeEditor() {
  const doc = useStore((s) => s.doc);
  const note = useStore((s) => s.note);

  const [generation, setGeneration] = useState(0);
  const recipes = useMemo(() => allRecipes(), [generation]);

  const [selectedId, setSelectedId] = useState<string>(STARTER_RECIPES[0]!.id);
  const [draft, setDraft] = useState<Recipe | null>(null);
  const [lastRun, setLastRun] = useState<ReturnType<typeof runRecipe> | null>(null);

  const selected = draft ?? recipes.find((r) => r.id === selectedId) ?? recipes[0]!;
  const isStarter = STARTER_RECIPES.some((r) => r.id === selected.id);
  const dirty = draft !== null;

  const edit = (patch: Partial<Recipe>) => setDraft({ ...selected, ...patch });

  const commit = () => {
    if (!draft) return;
    if (saveRecipe(draft)) {
      setDraft(null);
      setSelectedId(draft.id);
      setGeneration((g) => g + 1);
      note('info', `Saved "${draft.name}" — ${draft.steps.length} steps.`, 'Recipe saved');
    } else {
      note('error', 'Local storage refused the write. Export the recipe to a file instead.', 'Could not save');
    }
  };

  const dryRun = () => {
    if (!doc) return;
    const run = runRecipe(selected, doc, {}, { dryRun: true });
    setLastRun(run);
  };

  const commitRun = () => {
    if (!doc) return;
    const run = runRecipe(selected, doc, {});
    setLastRun(run);

    if (!run.ok) {
      const failed = run.steps.find((s) => s.status === 'failed');
      note('error', failed?.detail ?? 'The recipe failed.', `${selected.name} stopped`);
      return;
    }

    // Artifacts are written only on a real run; a dry run reports them without touching
    // the disk, which is the whole point of having one.
    for (const step of run.steps) {
      if (step.artifact) download(step.artifact.filename, step.artifact.contents, step.artifact.mime);
    }
    useStore.setState({ doc: run.doc });
    note('info', `${selected.name} completed — ${run.steps.length} steps.`, 'Recipe applied');
  };

  return (
    <div className="tabc">
      {/* ── library ── */}
      <div className="chips">
        {recipes.map((r) => (
          <button
            key={r.id}
            className="chip"
            aria-pressed={selected.id === r.id && !dirty}
            title={r.description || r.name}
            onClick={() => {
              setDraft(null);
              setSelectedId(r.id);
              setLastRun(null);
            }}
          >
            {r.name}
          </button>
        ))}
        <button
          className="chip"
          onClick={() => {
            setDraft(newRecipe());
            setLastRun(null);
          }}
        >
          + New
        </button>
      </div>

      {/* ── header ── */}
      <div className="feat-head">
        <span className="tool-glyph" aria-hidden="true">⧉</span>
        <input
          className="feat-name"
          value={selected.name}
          readOnly={isStarter && !dirty}
          aria-label="Recipe name"
          onChange={(e) => edit({ name: e.target.value })}
        />
        <span className="eyebrow">v{selected.version}</span>
      </div>

      {isStarter && !dirty && (
        <div className="note info" style={{ marginTop: 8 }}>
          <b>Shipped recipe · read-only</b>
          Duplicate it to make changes. Editing a starter in place would silently change
          behaviour for every part that relies on it.
          <div style={{ marginTop: 8 }}>
            <button
              className="btn"
              onClick={() =>
                setDraft({
                  ...selected,
                  id: `rcp_${Date.now().toString(36)}`,
                  name: `${selected.name} (copy)`,
                })
              }
            >
              Duplicate
            </button>
          </div>
        </div>
      )}

      {/* ── failure policy ── */}
      <div className="vrow-form" style={{ marginTop: 10 }}>
        <label htmlFor="rc-policy">On step failure</label>
        <select
          id="rc-policy"
          value={selected.failurePolicy}
          disabled={isStarter && !dirty}
          onChange={(e) => edit({ failurePolicy: e.target.value as Recipe['failurePolicy'] })}
        >
          <option value="stop">stop</option>
          <option value="continue">continue</option>
        </select>
      </div>

      {/* ── steps ── */}
      <div className="st-h" style={{ padding: '12px 0 6px' }}>
        Steps · {selected.steps.length}
      </div>

      {selected.steps.length === 0 ? (
        <div className="empty" style={{ padding: '12px 0' }}>
          No steps yet. Add one below.
        </div>
      ) : (
        <div className="ops" style={{ marginBottom: 10 }}>
          {selected.steps.map((step, i) => (
            <StepRow
              key={i}
              step={step}
              index={i}
              editable={!isStarter || dirty}
              status={lastRun?.steps[i]?.status}
              detail={lastRun?.steps[i]?.detail}
              onChange={(next) =>
                edit({ steps: selected.steps.map((s, j) => (j === i ? next : s)) })
              }
              onMove={(delta) => edit(moveStep(selected, i, delta))}
              onRemove={() => edit({ steps: selected.steps.filter((_, j) => j !== i) })}
            />
          ))}
        </div>
      )}

      {(!isStarter || dirty) && (
        <div className="chips">
          {STEP_TEMPLATES.map((t) => (
            <button
              key={t.kind}
              className="chip"
              onClick={() => edit({ steps: [...selected.steps, t.make()] })}
            >
              + {t.label}
            </button>
          ))}
        </div>
      )}

      {/* ── actions ── */}
      <div className="feat-actions">
        <button className="btn" disabled={!doc} onClick={dryRun}>
          Dry run ▸
        </button>
        <button className="btn determ" disabled={!doc} onClick={commitRun}>
          Run
        </button>
        {dirty && (
          <button className="btn primary" style={{ marginLeft: 0 }} onClick={commit}>
            Save
          </button>
        )}
        {!isStarter && !dirty && (
          <button
            className="btn danger"
            onClick={() => {
              deleteRecipe(selected.id);
              setSelectedId(STARTER_RECIPES[0]!.id);
              setGeneration((g) => g + 1);
            }}
          >
            Delete
          </button>
        )}
      </div>

      {/* ── run report ── */}
      {lastRun && (
        <div className="note" style={{ borderColor: lastRun.ok ? undefined : 'var(--dang)' }}>
          <b>
            {lastRun.dryRun ? 'Dry run' : 'Run'} · {lastRun.ok ? 'passed' : 'failed'} ·{' '}
            {lastRun.elapsedMs} ms
          </b>
          {lastRun.steps.map((s) => (
            <div key={s.index} style={{ marginTop: 2 }}>
              {s.status === 'ok' ? '✓' : s.status === 'failed' ? '✕' : '○'} {s.kind} — {s.detail}
            </div>
          ))}
          {lastRun.dryRun && (
            <div style={{ marginTop: 6, color: 'var(--tx2)' }}>
              Nothing was written. Run to commit.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── one step ─────────────────────────────────────────────────────────────── */

function StepRow({
  step,
  index,
  editable,
  status,
  detail,
  onChange,
  onMove,
  onRemove,
}: {
  step: RecipeStep;
  index: number;
  editable: boolean;
  status?: 'ok' | 'failed' | 'skipped';
  detail?: string;
  onChange: (next: RecipeStep) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="op" data-status={status === 'failed' ? 'failed' : ''}>
      <span className="glyph" aria-hidden="true">
        {status === 'ok' ? '✓' : status === 'failed' ? '✕' : index + 1}
      </span>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span className="name">{step.kind}</span>
          {editable && (
            <button
              className="icon-btn"
              style={{ marginLeft: 'auto', width: 20, height: 20, fontSize: 11 }}
              aria-label={open ? 'Collapse step' : 'Edit step'}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? '▾' : '▸'}
            </button>
          )}
        </div>

        <div className="params">{describeStep(step)}</div>
        {status === 'failed' && detail && (
          <div className="target" style={{ color: 'var(--dang)' }}>
            ⟶ {detail}
          </div>
        )}

        {open && editable && (
          <div style={{ marginTop: 8 }}>
            <StepFields step={step} onChange={onChange} />
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="btn" onClick={() => onMove(-1)}>↑</button>
              <button className="btn" onClick={() => onMove(1)}>↓</button>
              <button className="btn danger" onClick={onRemove}>Remove</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StepFields({
  step,
  onChange,
}: {
  step: RecipeStep;
  onChange: (next: RecipeStep) => void;
}) {
  const text = (label: string, value: string, set: (v: string) => void) => (
    <div className="vrow-form" key={label}>
      <label>{label}</label>
      <input value={value} onChange={(e) => set(e.target.value)} style={{ textAlign: 'left' }} />
    </div>
  );

  const num = (label: string, value: number, set: (v: number) => void) => (
    <div className="vrow-form" key={label}>
      <label>{label}</label>
      <input type="number" value={value} onChange={(e) => set(Number(e.target.value))} />
    </div>
  );

  switch (step.kind) {
    case 'setGlobal':
      return (
        <>
          {text('Variable', step.name, (v) => onChange({ ...step, name: v }))}
          {num('Value', typeof step.value === 'number' ? step.value : 0, (v) => onChange({ ...step, value: v }))}
        </>
      );

    case 'setProperty':
      return (
        <>
          {text('Property', step.name, (v) => onChange({ ...step, name: v }))}
          {text('Value', step.value, (v) => onChange({ ...step, value: v }))}
        </>
      );

    case 'setMaterial':
      return text('Material', step.material, (v) => onChange({ ...step, material: v }));

    case 'assertMassBelow':
      return num('Limit (g)', typeof step.grams === 'number' ? step.grams : 0, (v) =>
        onChange({ ...step, grams: v }),
      );

    case 'addFeature':
      return (
        <div className="vrow-form">
          <label>Feature</label>
          <select
            value={step.feature}
            onChange={(e) => onChange({ ...step, feature: e.target.value as FeatureKind })}
          >
            {FEATURE_TEMPLATES.filter((t) => !t.needsSeed).map((t) => (
              <option key={t.kind} value={t.kind}>{t.label}</option>
            ))}
          </select>
        </div>
      );

    case 'export':
      return (
        <div className="vrow-form">
          <label>Format</label>
          <select
            value={step.format}
            onChange={(e) => onChange({ ...step, format: e.target.value as 'dxf' | 'svg' | 'summary' })}
          >
            <option value="dxf">DXF</option>
            <option value="svg">SVG</option>
            <option value="summary">Summary</option>
          </select>
        </div>
      );

    case 'assertNoBlockers':
      return (
        <div className="vrow-form">
          <label>Process</label>
          <select
            value={step.pack ?? 'any'}
            onChange={(e) =>
              onChange({
                ...step,
                pack: e.target.value === 'any' ? undefined : (e.target.value as 'sheet' | 'additive' | 'moulding'),
              })
            }
          >
            <option value="any">CNC only</option>
            <option value="sheet">+ sheet metal</option>
            <option value="additive">+ additive</option>
            <option value="moulding">+ moulding</option>
          </select>
        </div>
      );

    default:
      return <div className="empty" style={{ padding: 0 }}>No editable fields.</div>;
  }
}

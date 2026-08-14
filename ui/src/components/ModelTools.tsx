import { useMemo, useState } from 'react';
import { useStore } from '../store';
import {
  evaluate,
  massGrams,
  FEATURE_TEMPLATES,
  templateFor,
  type DocFeature,
  type FeatureKind,
  type ParamValue,
} from '../lib/partModel';
import { download, toDxf, toManifest, toSvg } from '../lib/exporters';

/**
 * Modelling toolbar.
 *
 * Every button creates a real feature in the document model. There are no decorative
 * controls here — if a button is visible it performs the operation, the viewport and the
 * feature tree both move, and the edit is undoable.
 *
 * Pattern and mirror features need a seed to act on, so they disable themselves until a
 * cut exists rather than failing silently after the click.
 */
export function ModelToolbar() {
  const doc = useStore((s) => s.doc);
  const addFeature = useStore((s) => s.addFeature);
  const undoLast = useStore((s) => s.undoLast);
  const redoLast = useStore((s) => s.redoLast);
  const undoStack = useStore((s) => s.undoStack);
  const redoStack = useStore((s) => s.redoStack);

  const exportAs = (format: 'dxf' | 'svg' | 'txt') => {
    if (!doc) return;
    const geom = evaluate(doc);
    const base = doc.title.replace(/\.[^.]+$/, '');

    if (format === 'dxf') download(`${base}.dxf`, toDxf(geom), 'application/dxf');
    else if (format === 'svg') download(`${base}.svg`, toSvg(geom), 'image/svg+xml');
    else download(`${base}-summary.txt`, toManifest(doc, geom, massGrams(doc, geom)), 'text/plain');
  };

  // The most recent material-removing feature is the natural seed for a pattern.
  const seedId = useMemo(() => {
    if (!doc) return undefined;
    for (let i = doc.features.length - 1; i >= 0; i--) {
      const k = doc.features[i]!.kind;
      if (k === 'holePattern' || k === 'slot' || k === 'pocket') return doc.features[i]!.id;
    }
    return undefined;
  }, [doc]);

  if (!doc) return null;

  return (
    <div className="toolbar" role="toolbar" aria-label="Modelling features">
      {FEATURE_TEMPLATES.map((t) => {
        const blocked = t.needsSeed && !seedId;
        return (
          <button
            key={t.kind}
            className="tool"
            disabled={blocked}
            title={blocked ? `${t.label} — add a hole, slot or pocket first` : t.label}
            onClick={() => addFeature(t.kind, t.needsSeed ? { seed: seedId } : {})}
          >
            <span className="tool-glyph" aria-hidden="true">{t.glyph}</span>
            <span className="tool-label">{t.label}</span>
          </button>
        );
      })}

      <span className="toolbar-sep" />

      <button
        className="tool"
        disabled={undoStack.length === 0}
        title="Undo (Ctrl+Z)"
        onClick={() => void undoLast()}
      >
        <span className="tool-glyph" aria-hidden="true">↺</span>
        <span className="tool-label">Undo</span>
      </button>
      <button
        className="tool"
        disabled={redoStack.length === 0}
        title="Redo (Ctrl+Y)"
        onClick={redoLast}
      >
        <span className="tool-glyph" aria-hidden="true">↻</span>
        <span className="tool-label">Redo</span>
      </button>

      <span className="toolbar-sep" />

      <button className="tool" title="Export DXF — profile and holes, for laser or waterjet"
              onClick={() => exportAs('dxf')}>
        <span className="tool-glyph" aria-hidden="true">⤓</span>
        <span className="tool-label">DXF</span>
      </button>
      <button className="tool" title="Export SVG — scaled vector drawing"
              onClick={() => exportAs('svg')}>
        <span className="tool-glyph" aria-hidden="true">⤓</span>
        <span className="tool-label">SVG</span>
      </button>
      <button className="tool" title="Export a manufacturing summary"
              onClick={() => exportAs('txt')}>
        <span className="tool-glyph" aria-hidden="true">▤</span>
        <span className="tool-label">Summary</span>
      </button>
    </div>
  );
}

/* ── feature editor ───────────────────────────────────────────────────────── */

interface FieldSpec {
  key: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  kind?: 'number' | 'choice';
  choices?: string[];
}

/** Which parameters are meaningful per feature kind, and their sane bounds. */
function fieldsFor(kind: FeatureKind): FieldSpec[] {
  switch (kind) {
    case 'plate':
      return [{ key: 'shape', label: 'Profile', kind: 'choice', choices: ['rect', 'circle', 'polygon'] },
              { key: 'radius', label: 'Radius (mm)', min: 5, max: 300, step: 0.5 },
              { key: 'sides', label: 'Sides', min: 3, max: 12, step: 1 }];
    case 'holePattern':
      return [{ key: 'diameter', label: 'Diameter (mm)', min: 1, max: 40, step: 0.1 },
              { key: 'boltCircle', label: 'Bolt circle (mm)', min: 5, max: 300, step: 0.5 }];
    case 'slot':
      return [{ key: 'width', label: 'Length (mm)', min: 1, max: 300, step: 0.5 },
              { key: 'height', label: 'Width (mm)', min: 1, max: 100, step: 0.5 },
              { key: 'cx', label: 'X (mm)', min: -200, max: 200, step: 0.5 },
              { key: 'cy', label: 'Y (mm)', min: -200, max: 200, step: 0.5 }];
    case 'pocket':
      return [{ key: 'width', label: 'Width (mm)', min: 1, max: 300, step: 0.5 },
              { key: 'height', label: 'Height (mm)', min: 1, max: 300, step: 0.5 },
              { key: 'cornerR', label: 'Corner R (mm)', min: 0, max: 40, step: 0.5 },
              { key: 'cx', label: 'X (mm)', min: -200, max: 200, step: 0.5 },
              { key: 'cy', label: 'Y (mm)', min: -200, max: 200, step: 0.5 }];
    case 'fillet':
      return [{ key: 'radius', label: 'Radius (mm)', min: 0, max: 60, step: 0.5 }];
    case 'chamfer':
      return [{ key: 'distance', label: 'Distance (mm)', min: 0, max: 30, step: 0.5 },
              { key: 'angle', label: 'Angle (°)', min: 5, max: 85, step: 1 }];
    case 'shell':
      return [{ key: 'thickness', label: 'Wall (mm)', min: 0.4, max: 30, step: 0.1 }];
    case 'patternLinear':
      return [{ key: 'count', label: 'Instances', min: 2, max: 60, step: 1 },
              { key: 'dx', label: 'Spacing X (mm)', min: -100, max: 100, step: 0.5 },
              { key: 'dy', label: 'Spacing Y (mm)', min: -100, max: 100, step: 0.5 }];
    case 'patternCircular':
      return [{ key: 'count', label: 'Instances', min: 2, max: 60, step: 1 },
              { key: 'angle', label: 'Total angle (°)', min: 10, max: 360, step: 5 }];
    case 'mirror':
      return [{ key: 'axis', label: 'Mirror about', kind: 'choice', choices: ['x', 'y'] }];
    default:
      return [];
  }
}

export function FeatureEditor() {
  const doc = useStore((s) => s.doc);
  const editingId = useStore((s) => s.editingFeatureId);
  const editFeature = useStore((s) => s.editFeature);
  const renameFeatureById = useStore((s) => s.renameFeatureById);
  const removeFeature = useStore((s) => s.removeFeature);
  const reorderFeature = useStore((s) => s.reorderFeature);
  const suppressFeature = useStore((s) => s.suppressFeature);
  const setEditingFeature = useStore((s) => s.setEditingFeature);

  const feature: DocFeature | undefined = doc?.features.find((f) => f.id === editingId);

  if (!doc || !feature) {
    return (
      <div className="empty">
        <strong>No feature selected</strong>
        Pick a feature in the tree, or add one from the toolbar, to edit its parameters.
      </div>
    );
  }

  const fields = fieldsFor(feature.kind);
  const tpl = templateFor(feature.kind);
  const index = doc.features.findIndex((f) => f.id === feature.id);

  return (
    <div className="feat-editor">
      <div className="feat-head">
        <span className="tool-glyph" aria-hidden="true">{tpl?.glyph ?? '·'}</span>
        <input
          className="feat-name"
          value={feature.name}
          aria-label="Feature name"
          onChange={(e) => renameFeatureById(feature.id, e.target.value)}
        />
        <button className="icon-btn" title="Close editor" aria-label="Close editor"
                onClick={() => setEditingFeature(null)}>✕</button>
      </div>

      <div className="feat-meta">
        <span className="eyebrow">{feature.swType}</span>
        {feature.suppressed && <span className="tag warn">suppressed</span>}
      </div>

      {fields.length === 0 ? (
        <div className="empty" style={{ padding: '10px 0' }}>This feature has no editable parameters.</div>
      ) : (
        fields.map((f) => {
          const raw = feature.params[f.key];

          if (f.kind === 'choice') {
            const current = typeof raw === 'string' ? raw : (f.choices?.[0] ?? '');
            return (
              <div className="vrow-form" key={f.key}>
                <label htmlFor={`fe-${f.key}`}>{f.label}</label>
                <select
                  id={`fe-${f.key}`}
                  value={current}
                  onChange={(e) => editFeature(feature.id, { [f.key]: e.target.value })}
                >
                  {f.choices?.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            );
          }

          const value = typeof raw === 'number' ? raw : 0;
          return (
            <div className="prow" key={f.key}>
              <div className="plab">
                <span className="n">{f.label}</span>
                <span className="v">{value.toFixed(f.step === 1 ? 0 : 1)}</span>
              </div>
              <input
                type="range"
                min={f.min ?? 0}
                max={f.max ?? 100}
                step={f.step ?? 0.5}
                value={value}
                aria-label={f.label}
                onChange={(e) => editFeature(feature.id, { [f.key]: Number(e.target.value) })}
              />
            </div>
          );
        })
      )}

      <div className="feat-actions">
        <button className="btn" disabled={index <= 0}
                title="Move earlier in the tree"
                onClick={() => reorderFeature(feature.id, -1)}>↑ Earlier</button>
        <button className="btn" disabled={index < 0 || index >= doc.features.length - 1}
                title="Move later in the tree"
                onClick={() => reorderFeature(feature.id, 1)}>↓ Later</button>
        <button className="btn" onClick={() => suppressFeature(feature.id, !feature.suppressed)}>
          {feature.suppressed ? 'Unsuppress' : 'Suppress'}
        </button>
        <button className="btn danger" onClick={() => removeFeature(feature.id)}>Delete</button>
      </div>

      <div className="note">
        <b>Deterministic · offline</b>
        Editing rebuilds the document on the next frame. Mass, bounding box, linter findings
        and the cost estimate all recompute from the same evaluation the viewport draws.
      </div>
    </div>
  );
}

/* ── quick-add used by the tree's empty state ─────────────────────────────── */

export function QuickAdd() {
  const addFeature = useStore((s) => s.addFeature);
  const [kind, setKind] = useState<FeatureKind>('holePattern');

  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
      <select value={kind} onChange={(e) => setKind(e.target.value as FeatureKind)} style={{ flex: 1 }}>
        {FEATURE_TEMPLATES.filter((t) => !t.needsSeed).map((t) => (
          <option key={t.kind} value={t.kind}>{t.label}</option>
        ))}
      </select>
      <button className="btn determ" onClick={() => addFeature(kind, {} as Record<string, ParamValue>)}>
        Add
      </button>
    </div>
  );
}

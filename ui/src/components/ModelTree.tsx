import { useEffect, useMemo, useRef, useState } from 'react';
import { useModel, archetypeFieldsFor, selectedFeature } from '../modelStore';
import {
  defaultParams, featureLabel, parametersOf, paramFields, referenceScopeAt,
  type FeatureKind, type ParamValue,
} from '../model/document';
import { readNumber } from '../model/expr';
import { appearanceFor, toHex } from '../lib/appearance';
import { SketchEditor } from './SketchEditor';
import { AssemblyPanel } from './AssemblyPanel';
import { ParametersPanel } from './ParametersPanel';

/**
 * Feature tree and parameter editor.
 *
 * Two things distinguish this from a list of names.
 *
 * Selection is bidirectional: choosing a feature here highlights its faces in the viewport,
 * and picking a face there scrolls to and selects the feature here. Without that a user
 * cannot tell which entry in the tree produced the thing they are looking at, which on a
 * part with thirty features makes the tree ornamental.
 *
 * Every parameter is live. Editing a value rebuilds the model immediately rather than
 * waiting for an apply, because the reason parametric CAD is worth using is the tight loop
 * between changing a number and seeing what it does.
 */

/**
 * Every feature the kernel can build, in the order a part is usually made.
 *
 * Exported because the command palette offers the same list: one definition, so a feature
 * added here is reachable from the keyboard without anyone remembering to add it twice.
 */
export const KINDS: { kind: FeatureKind; label: string; glyph: string; hint: string }[] = [
  { kind: 'box', label: 'Box', glyph: '▭', hint: 'Rectangular block' },
  { kind: 'cylinder', label: 'Cylinder', glyph: '⬭', hint: 'Cylinder or disc' },
  { kind: 'sphere', label: 'Sphere', glyph: '◯', hint: 'Sphere' },
  { kind: 'sketch', label: 'Sketch', glyph: '✎', hint: 'Draw a profile, constrain it, extrude it' },
  { kind: 'extrude', label: 'Extrude', glyph: '⬒', hint: 'Extrude a profile' },
  { kind: 'revolve', label: 'Revolve', glyph: '◑', hint: 'Revolve a section about an axis' },
  { kind: 'loft', label: 'Loft', glyph: '⧨', hint: 'Blend one section into another — transitions, tapers, aerofoils' },
  { kind: 'sweep', label: 'Sweep', glyph: '➰', hint: 'Drive a section along a path — springs, threads, tubes, handles' },
  { kind: 'hole', label: 'Hole', glyph: '⊙', hint: 'Through, blind, counterbore, countersink or tapped — single, bolt circle or grid' },
  { kind: 'rib', label: 'Rib', glyph: '⊤', hint: 'Stand a stiffening wall on the part' },
  { kind: 'draft', label: 'Draft', glyph: '◿', hint: 'Taper the walls so the part can leave its mould' },
  { kind: 'dome', label: 'Dome', glyph: '◠', hint: 'Bulge a flat face into a curved one' },
  { kind: 'split', label: 'Split', glyph: '◫', hint: 'Cut the solid into two bodies with a plane' },
  { kind: 'datum', label: 'Datum', glyph: '⌗', hint: 'A reference plane to build on, offset or tilted' },
  { kind: 'wrap', label: 'Wrap', glyph: '◎', hint: 'Knurl, groove or flats rolled around a round part' },
  { kind: 'sheet', label: 'Sheet metal', glyph: '⌐', hint: 'A folded sheet part — angle, channel or Z' },
  { kind: 'pocket', label: 'Pocket', glyph: '▣', hint: 'Mill a pocket' },
  { kind: 'slot', label: 'Slot', glyph: '▬', hint: 'Cut a slot' },
  { kind: 'fillet', label: 'Fillet', glyph: '◜', hint: 'Round sharp edges' },
  { kind: 'chamfer', label: 'Chamfer', glyph: '◺', hint: 'Cut edges back at 45°' },
  { kind: 'shell', label: 'Shell', glyph: '◘', hint: 'Hollow the solid' },
  { kind: 'patternLinear', label: 'Linear pattern', glyph: '⣿', hint: 'Repeat along a direction' },
  { kind: 'patternCircular', label: 'Circular pattern', glyph: '❋', hint: 'Repeat around an axis' },
  { kind: 'mirror', label: 'Mirror', glyph: '◫', hint: 'Mirror across a plane' },
];

export function ModelTree() {
  const doc = useModel((s) => s.doc);
  const evaluated = useModel((s) => s.evaluated);
  const selectedId = useModel((s) => s.selectedFeatureId);
  const edit = useModel((s) => s.edit);
  const remove = useModel((s) => s.remove);
  const toggleSuppressed = useModel((s) => s.toggleSuppressed);
  const move = useModel((s) => s.move);
  const addFeature = useModel((s) => s.addFeature);

  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? doc.features.filter((f) => f.name.toLowerCase().includes(q)) : doc.features;
  }, [doc.features, filter]);

  // Scroll the selection into view when it changes from outside — a viewport pick on a
  // feature that has scrolled off is otherwise invisible.
  useEffect(() => {
    if (!selectedId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-feature="${selectedId}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  return (
    <div className="tabc mt">
      <div className="mt-add" role="group" aria-label="Add a feature">
        {KINDS.map((k) => (
          <button key={k.kind} title={k.hint} onClick={() => addFeature(k.kind)}>
            <span aria-hidden="true">{k.glyph}</span>
            <em>{k.label}</em>
          </button>
        ))}
      </div>

      {doc.features.length > 4 && (
        <input
          className="mt-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter features…"
          aria-label="Filter features"
        />
      )}

      <div className="mt-list" ref={listRef} role="tree" aria-label="Feature tree">
        {doc.features.length === 0 && (
          <div className="empty">
            <strong>No features yet</strong>
            Describe a part in the chat, or add one above.
          </div>
        )}

        {visible.map((f, i) => {
          const error = evaluated.errors.get(f.id);
          const warning = evaluated.warnings.get(f.id);
          const faces = evaluated.featureFaceRange.get(f.id);

          return (
            <div
              key={f.id}
              data-feature={f.id}
              className="mt-row"
              role="treeitem"
              aria-selected={selectedId === f.id}
              data-selected={selectedId === f.id ? 'true' : undefined}
              data-suppressed={f.suppressed ? 'true' : undefined}
              data-state={error ? 'error' : warning ? 'warn' : undefined}
            >
              <button className="mt-name" onClick={() => edit(f.id)} title={error ?? warning ?? f.name}>
                <span className="mt-index">{i + 1}</span>
                <span className="mt-label">{f.name}</span>
                <span className="mt-kind">{featureLabel(f.kind)}</span>
                {error && <span className="mt-badge err" title={error}>!</span>}
                {!error && warning && <span className="mt-badge warn" title={warning}>⚠</span>}
                {!error && !warning && faces && <span className="mt-badge ok">{faces[1] - faces[0] + 1}</span>}
              </button>

              <div className="mt-ops">
                <button title="Move up" onClick={() => move(f.id, -1)} disabled={i === 0}>↑</button>
                <button title="Move down" onClick={() => move(f.id, 1)} disabled={i === doc.features.length - 1}>↓</button>
                <button
                  title={f.suppressed ? 'Include this feature' : 'Suppress this feature'}
                  aria-pressed={f.suppressed}
                  onClick={() => toggleSuppressed(f.id)}
                >
                  {f.suppressed ? '○' : '●'}
                </button>
                <button title="Delete" onClick={() => remove(f.id)}>✕</button>
              </div>
            </div>
          );
        })}
      </div>

      <FeatureEditor />
      <ParametersPanel />
      <AssemblyPanel />
    </div>
  );
}

/**
 * Parameter editor for the selected feature.
 *
 * Every control shows the number and a slider. The slider is for exploring — dragging it
 * rebuilds live, which is how a designer finds the right value — and the number is for
 * committing to one, because "about there" is not a dimension anybody can manufacture to.
 */
export function FeatureEditor() {
  const feature = useModel(selectedFeature);
  const doc = useModel((s) => s.doc);
  const setParams = useModel((s) => s.setParams);
  const rename = useModel((s) => s.rename);
  const evaluated = useModel((s) => s.evaluated);

  const archetypeFields = useModel((s) => {
    const f = s.doc.features.find((x) => x.id === s.editingFeatureId);
    return f ? archetypeFieldsFor(f) : null;
  });

  if (!feature) {
    return (
      <div className="mt-editor empty-editor">
        <span>Select a feature to edit its parameters.</span>
      </div>
    );
  }

  // Everything this feature may name, offered to the browser's own completion. A reference
  // language whose vocabulary is invisible is one nobody uses: until this existed, driving one
  // feature from another required knowing that `Base.length` was even a thing you could type.
  const references = referenceScopeAt(doc, feature.id);

  const error = evaluated.errors.get(feature.id);
  const warning = evaluated.warnings.get(feature.id);
  const values = parametersOf(doc);

  // Archetypes describe their own parameters, including a note explaining each default;
  // built-in features use the static field table.
  const fields = archetypeFields
    ? archetypeFields.map((d) => ({
        key: d.key, label: d.label, unit: d.unit === 'count' ? '' : d.unit,
        min: d.min, max: d.max, step: d.unit === 'count' ? 1 : (d.max - d.min) / 200,
        kind: 'number' as const, note: d.note,
      }))
    : paramFields(feature.kind, feature.params, doc).map((f) => ({ ...f, note: undefined as string | undefined }));

  return (
    <div className="mt-editor">
      <div className="mt-editor-head">
        <input
          value={feature.name}
          onChange={(e) => rename(feature.id, e.target.value)}
          aria-label="Feature name"
        />
        <span className="mt-kind">{featureLabel(feature.kind)}</span>
      </div>

      <datalist id="mt-refs">
        {references.map((r) => (
          <option key={r.name} value={r.name} label={`${Number(r.value.toFixed(4))} — ${r.from}`} />
        ))}
      </datalist>

      {error && <div className="note" style={{ borderColor: 'var(--dang)' }}><b>Cannot build</b>{error}</div>}
      {!error && warning && <div className="note"><b>Note</b>{warning}</div>}

      <Placement />
      <Appearance />

      {feature.kind === 'sketch' && (
        <SketchEditor
          value={typeof feature.params.sketch === 'string' ? feature.params.sketch : ''}
          onChange={(json) => setParams(feature.id, { sketch: json })}
        />
      )}

      {(feature.kind === 'fillet' || feature.kind === 'chamfer') && <FaceScope />}

      {fields.length === 0 && <div className="empty-editor"><span>This feature has no editable parameters.</span></div>}

      {fields.map((field) => {
        const raw = feature.params[field.key];

        if (field.kind === 'choice' && 'choices' in field && field.choices) {
          return (
            <div className="mt-field" key={field.key}>
              <label htmlFor={`p-${field.key}`}>{field.label}</label>
              <select
                id={`p-${field.key}`}
                value={typeof raw === 'string' ? raw : field.choices[0].value}
                onChange={(e) => setParams(feature.id, { [field.key]: e.target.value })}
              >
                {field.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
          );
        }

        // A feature need not carry every parameter its kind can take — one built from a trace
        // or a plan only stores what it was given, and the evaluator fills the rest from the
        // defaults. Falling back to the slider's *minimum* here made the editor claim a value
        // the model was not using: a traced outline showed Draft as -20°, the extreme of the
        // range, when it was actually being built at 0. Show what the build is really using.
        const fallback = defaultParams(feature.kind)[field.key];

        // A parameter may be an expression over the document's driving dimensions. When it is,
        // the field becomes text — a slider cannot represent "plateLength / 2" — and shows
        // what the expression currently comes to underneath.
        //
        // Without this the loop is only half open: the assistant can emit expressions and a
        // person cannot type one, which makes the parameters panel something you can read and
        // not something you can build with.
        const isExpression = typeof raw === 'string';
        const resolved = isExpression ? readNumber(raw, values, field.min) : null;
        const value = typeof raw === 'number' ? raw
          : resolved && !resolved.error ? resolved.value
          : typeof fallback === 'number' ? fallback
          : field.min;

        return (
          <div className="mt-field" key={field.key} title={field.note}>
            <label htmlFor={`p-${field.key}`}>
              {field.label}
              {field.unit && <em> {field.unit}</em>}
              <button
                type="button"
                className={isExpression ? 'mt-fx is-on' : 'mt-fx'}
                title={isExpression
                  ? 'Back to a fixed number'
                  : 'Drive this from a parameter or another feature, e.g. Base.length / 2'}
                aria-pressed={isExpression}
                onClick={() => setParams(feature.id, {
                  [field.key]: isExpression ? Number(value.toFixed(4)) : String(value),
                })}
              >
                ƒx
              </button>
            </label>

            {isExpression ? (
              <input
                id={`p-${field.key}`}
                type="text"
                className="mt-expr"
                value={raw}
                spellCheck={false}
                onChange={(e) => setParams(feature.id, { [field.key]: e.target.value })}
                aria-label={`${field.label} expression`}
                list="mt-refs"
              />
            ) : (
              <div className="mt-field-row">
                <input
                  type="range"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={value}
                  onChange={(e) => setParams(feature.id, { [field.key]: Number(e.target.value) })}
                  aria-label={`${field.label} slider`}
                />
                <input
                  id={`p-${field.key}`}
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={Number(value.toFixed(4))}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) setParams(feature.id, { [field.key]: n });
                  }}
                />
              </div>
            )}

            {isExpression && (
              <span className={resolved?.error ? 'mt-expr-err' : 'mt-expr-ok'}>
                {resolved?.error ?? `= ${Number(value.toFixed(4))} ${field.unit}`}
              </span>
            )}

            {field.note && <span className="mt-note">{field.note}</span>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The face-scope control for fillet and chamfer.
 *
 * Without this, rounding means rounding every edge on the body, which on anything real is
 * either not what was wanted or not possible — one bad edge fails and the whole feature
 * reports nothing happened. Picking faces in the viewport narrows it to the edges that
 * matter.
 *
 * The applied scope and the current pick are shown separately on purpose: clicking around
 * the model must not silently change the feature under you.
 */
function FaceScope() {
  const picked = useModel((s) => s.selectedFaces);
  const clearFaces = useModel((s) => s.clearFaces);
  const apply = useModel((s) => s.applyFacesToFeature);
  const applied = useModel((s) => {
    const f = s.doc.features.find((x) => x.id === s.editingFeatureId);
    const raw = f?.params.faces;
    return Array.isArray(raw) ? raw.length : 0;
  });

  const dirty = picked.length > 0;

  return (
    <div className="mt-scope">
      <div className="mt-scope-head">
        <span>Face scope</span>
        <b>{applied === 0 ? 'whole body' : `${applied} face${applied === 1 ? '' : 's'}`}</b>
      </div>

      <p className="mt-note">
        {dirty
          ? `${picked.length} face${picked.length === 1 ? '' : 's'} picked in the viewport.`
          : 'Click a face in the viewport, shift-click to add more.'}
      </p>

      <div className="mt-scope-row">
        <button type="button" onClick={apply} disabled={!dirty && applied === 0}>
          {dirty ? 'Apply picked faces' : 'Reset to whole body'}
        </button>
        <button type="button" onClick={clearFaces} disabled={!dirty}>Clear pick</button>
      </div>
    </div>
  );
}

/**
 * Where the selected part sits, and which way it faces.
 *
 * Every assembly already carried a placement per component and there was no way to change one:
 * the tree could resize a part and the viewport could only move the camera, so a battery in
 * the wrong place stayed there. Six numbers is the whole of rigid-body position, and typing
 * one is how a part gets put somewhere exact — dragging is for finding roughly where it goes.
 *
 * Shown for every feature rather than only for assembly components, because a box added from
 * the toolbar needs moving as much as a generated one does.
 */
/**
 * Material and colour for the selected feature.
 *
 * Appearance is a document property, not a viewer setting: an assembly whose components are
 * told apart only by a colour someone chose in a session loses that the moment it is saved.
 * So both land in the feature's parameters and travel with the file.
 *
 * Colour only, not material. Material sets density and therefore mass, and a single-part
 * document carries one density — letting a feature claim brass here would recolour it and
 * silently make the weight on the status line wrong. Component materials come from the bill
 * of materials, which weighs each one at its own density, and colour follows them.
 */
function Appearance() {
  const feature = useModel(selectedFeature);
  const doc = useModel((s) => s.doc);
  const setParams = useModel((s) => s.setParams);

  if (!feature) return null;

  const material = typeof feature.params.material === 'string' ? feature.params.material : '';
  const chosen = typeof feature.params.colour === 'string' ? feature.params.colour : '';
  const look = appearanceFor(material || doc.material);
  const swatch = chosen || toHex(look.rgb);

  return (
    <div className="mt-place">
      <div className="mt-place-head">
        <span>Appearance</span>
        {chosen && (
          <button
            type="button"
            title={`Back to ${look.label.toLowerCase()}`}
            onClick={() => setParams(feature.id, { colour: '' })}
          >
            Reset
          </button>
        )}
      </div>

      <div className="mt-field">
        <label htmlFor="ap-colour">Colour</label>
        <input
          id="ap-colour"
          type="color"
          value={swatch}
          onChange={(e) => setParams(feature.id, { colour: e.target.value })}
        />
        <span className="mt-swatch-note">
          {chosen ? 'chosen' : `from ${(material || doc.material).toLowerCase()}`}
        </span>
      </div>
    </div>
  );
}

function Placement() {
  const feature = useModel(selectedFeature);
  const place = useModel((s) => s.place);

  if (!feature) return null;

  const at = feature.placement ?? { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };

  const axes: { key: 'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz'; label: string; unit: string; step: number }[] = [
    { key: 'x', label: 'X', unit: 'mm', step: 1 },
    { key: 'y', label: 'Y', unit: 'mm', step: 1 },
    { key: 'z', label: 'Z', unit: 'mm', step: 1 },
    { key: 'rx', label: 'RX', unit: '°', step: 5 },
    { key: 'ry', label: 'RY', unit: '°', step: 5 },
    { key: 'rz', label: 'RZ', unit: '°', step: 5 },
  ];

  const moved = axes.some((a) => Math.abs(at[a.key]) > 1e-9);

  return (
    <div className="mt-place">
      <div className="mt-place-head">
        <span>Position</span>
        {moved && (
          <button
            type="button"
            title="Back to the origin"
            onClick={() => place(feature.id, { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 })}
          >
            Reset
          </button>
        )}
      </div>

      <div className="mt-place-grid">
        {axes.map((a) => (
          <label key={a.key} title={`${a.label} in ${a.unit}`}>
            <span>{a.label}</span>
            <input
              type="number"
              step={a.step}
              value={Number(at[a.key].toFixed(3))}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) place(feature.id, { [a.key]: v });
              }}
            />
          </label>
        ))}
      </div>

      <span className="mt-note">
        Drag in the 3D view with the right mouse button to move the selected part.
      </span>
    </div>
  );
}

export type { ParamValue };

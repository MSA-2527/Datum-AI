import { useMemo, useState } from 'react';
import { useModel } from '../modelStore';
import { parameterErrors, parametersOf } from '../model/document';
import { evaluateExpr } from '../model/expr';

/**
 * The design's driving dimensions.
 *
 * This is the difference between a model that was generated and a model that was *designed*.
 * Without it, an assistant's output is thirty components at literal coordinates: changing the
 * wheelbase means asking again and getting a different car. With it, the wheelbase is a number
 * on this panel, and every part written in terms of it follows when you edit it.
 *
 * Each row shows what it resolves to as well as what it says, because an expression whose value
 * you cannot see is a number you cannot check.
 */
export function ParametersPanel() {
  const doc = useModel((s) => s.doc);
  const setParameter = useModel((s) => s.setParameter);
  const renameParameter = useModel((s) => s.renameParameter);
  const addParameter = useModel((s) => s.addParameter);
  const removeParameter = useModel((s) => s.removeParameter);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const values = useMemo(() => parametersOf(doc), [doc]);
  const errors = useMemo(() => parameterErrors(doc), [doc]);

  /** Which parameters are actually referenced, so an unused one is visibly unused. */
  const used = useMemo(() => {
    const count = new Map<string, number>();
    const scan = (v: unknown) => {
      if (typeof v !== 'string') return;
      for (const name of evaluateExpr(v, values).uses) {
        count.set(name, (count.get(name) ?? 0) + 1);
      }
    };

    for (const g of doc.globals) scan(g.value);
    for (const f of doc.features) {
      for (const v of Object.values(f.params)) scan(v);
      for (const v of Object.values(f.placementExpr ?? {})) scan(v);
    }
    return count;
  }, [doc, values]);

  if (doc.globals.length === 0) {
    return (
      <div className="par">
        <div className="st-h">Parameters</div>
        <p className="par-help">
          None yet. A parameter is a dimension the design is built around — a wheelbase, a bore,
          a plate thickness — that other dimensions are written in terms of. Anything the
          assistant generates with driving dimensions will list them here.
        </p>
        <button className="par-add" onClick={addParameter}>Add a parameter</button>
      </div>
    );
  }

  return (
    <div className="par">
      <div className="st-h">
        Parameters
        <span className="par-count">{doc.globals.length}</span>
      </div>

      {doc.globals.map((g) => {
        const error = errors.get(g.name);
        const resolved = values[g.name];
        const references = used.get(g.name) ?? 0;
        const isExpression = typeof g.value === 'string';

        return (
          <div className="par-row" key={g.name} data-state={error ? 'error' : undefined}>
            <div className="par-head">
              {editing === g.name ? (
                <input
                  className="par-name-edit"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => { if (draft !== g.name) renameParameter(g.name, draft); setEditing(null); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') { setEditing(null); }
                  }}
                  aria-label="Parameter name"
                />
              ) : (
                <button
                  className="par-name"
                  title="Rename — every expression using it is rewritten"
                  onClick={() => { setEditing(g.name); setDraft(g.name); }}
                >
                  {g.name}
                </button>
              )}

              <span className="par-uses" title={`Used by ${references} expression${references === 1 ? '' : 's'}`}>
                {references > 0 ? `${references}×` : 'unused'}
              </span>
              <button className="par-del" title="Remove" onClick={() => removeParameter(g.name)}>✕</button>
            </div>

            <div className="par-value">
              <input
                type={isExpression ? 'text' : 'number'}
                value={String(g.value)}
                step={0.5}
                onChange={(e) => {
                  const raw = e.target.value;
                  const asNumber = Number(raw);
                  // A bare number stays a number; anything else is kept as an expression, so
                  // typing `track / 2` into the box does what it looks like it should.
                  setParameter(g.name, raw.trim() !== '' && Number.isFinite(asNumber) ? asNumber : raw);
                }}
                aria-label={`${g.name} value`}
              />
              <span className="par-units">{g.units}</span>
            </div>

            {isExpression && !error && (
              <span className="par-resolved">= {round(resolved)} {g.units}</span>
            )}
            {error && <span className="par-error">{error}</span>}
            {g.note && !error && <span className="par-note">{g.note}</span>}
          </div>
        );
      })}

      <button className="par-add" onClick={addParameter}>Add a parameter</button>
    </div>
  );
}

/** Enough places to be useful, few enough to read. */
function round(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3).replace(/\.?0+$/, '');
}

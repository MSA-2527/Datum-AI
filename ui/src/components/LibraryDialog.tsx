import { useMemo, useState } from 'react';
import { useModel } from '../modelStore';
import { filterLibrary } from '../lib/reuse';

/**
 * The part library.
 *
 * This exists because the reuse gate cannot work without it. Nothing can be offered back to
 * someone before they build unless it was first put somewhere the application can enumerate,
 * and "Save" writing a file to a downloads folder is not that — a file the product cannot
 * see is a file the product cannot spare you from redrawing.
 *
 * Saving a part therefore has a second meaning that is stated on the screen rather than left
 * to be discovered: it is how the part enters the set that later requests are checked
 * against. That is also why the name matters more here than for a file. The name is the
 * strongest evidence the gate has about what a part *is*, so the field is a first-class
 * input with the document's own name offered as the default rather than imposed.
 *
 * Delete asks. Everything else in this dialog is reversible by doing it again; deleting the
 * only copy of a feature tree is not.
 */
export function LibraryDialog({ onClose }: { onClose: () => void }) {
  const docName = useModel((s) => s.doc.name);
  const featureCount = useModel((s) => s.doc.features.length);
  const library = useModel((s) => s.library);
  const saveToLibrary = useModel((s) => s.saveToLibrary);
  const openFromLibrary = useModel((s) => s.openFromLibrary);
  const removeFromLibrary = useModel((s) => s.removeFromLibrary);

  // Bumped after every write so the listing re-reads storage. The library is deliberately
  // not mirrored into the store — see `ModelState.library` for why — so the component needs
  // an explicit reason to ask again.
  const [revision, setRevision] = useState(0);
  const [name, setName] = useState(docName);
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const entries = useMemo(() => library(), [library, revision]);
  const shown = useMemo(() => filterLibrary(entries, query), [entries, query]);

  const clean = name.trim();
  const replacing = entries.some((e) => e.name === clean);

  const save = () => {
    const r = saveToLibrary(clean);
    setResult({ ok: r.ok, text: r.message });
    if (r.ok) setRevision((n) => n + 1);
  };

  const open = (entryName: string) => {
    const r = openFromLibrary(entryName);
    if (r.ok) onClose();
    else setResult({ ok: false, text: r.message });
  };

  const remove = (entryName: string) => {
    const r = removeFromLibrary(entryName);
    setConfirming(null);
    setResult({ ok: r.ok, text: r.message });
    if (r.ok) setRevision((n) => n + 1);
  };

  return (
    <div className="ai-overlay" role="dialog" aria-label="Part library" aria-modal="true">
      <div className="ai-panel">
        <div className="ai-head">
          <strong>Part library</strong>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>

        <p className="ai-intro">
          Saved parts stay on this machine. They are also what makes reuse possible: when a
          request matches one of these, DATUM offers it before building anything new.
        </p>

        <div className="ai-field">
          <label htmlFor="lib-name">Save the open part as</label>
          <div className="lib-save">
            <input
              id="lib-name"
              value={name}
              onChange={(e) => { setName(e.target.value); setResult(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && clean) save(); }}
              placeholder="Part name"
              spellCheck={false}
            />
            <button type="button" className="primary" onClick={save} disabled={!clean}>
              {replacing ? 'Replace' : 'Save'}
            </button>
          </div>
          <span className="ai-note">
            {featureCount === 0
              ? 'This part has no features yet — it will be saved as an empty tree.'
              : `${featureCount} feature${featureCount === 1 ? '' : 's'}, saved as the tree rather than the mesh, so it reopens editable.`}
            {replacing && ' A part of this name already exists and will be replaced.'}
          </span>
        </div>

        {result && <div className="ai-result" data-ok={result.ok ? 'true' : 'false'}>{result.text}</div>}

        <div className="ai-field">
          <label htmlFor="lib-search">Saved parts</label>
          <input
            id="lib-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={entries.length > 0 ? `Search ${entries.length} saved part${entries.length === 1 ? '' : 's'}…` : 'Nothing saved yet'}
            spellCheck={false}
            disabled={entries.length === 0}
          />
        </div>

        {entries.length === 0 ? (
          <p className="ai-note">
            Nothing is saved yet. Save the part you have open and DATUM will offer it back the
            next time a request matches it.
          </p>
        ) : shown.length === 0 ? (
          <p className="ai-note">Nothing saved matches “{query}”.</p>
        ) : (
          <ul className="lib-list">
            {shown.map((entry) => {
              const [x, y, z] = entry.snapshot.sizeMm;
              const sized = x > 0 || y > 0 || z > 0;
              return (
                <li key={entry.name}>
                  <div className="lib-item">
                    <div className="lib-item-text">
                      <strong>{entry.name}</strong>
                      <span>
                        {entry.doc.features.length} feature{entry.doc.features.length === 1 ? '' : 's'}
                        {sized && ` · ${x.toFixed(0)} × ${y.toFixed(0)} × ${z.toFixed(0)} mm`}
                        {entry.snapshot.massG > 0 && ` · ${mass(entry.snapshot.massG)}`}
                        {' · '}{new Date(entry.savedAtUtc).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="lib-item-actions">
                      <button type="button" onClick={() => open(entry.name)}>Open</button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => setConfirming(confirming === entry.name ? null : entry.name)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {confirming === entry.name && (
                    <div className="lib-confirm">
                      <span>Delete “{entry.name}”? This cannot be undone.</span>
                      <button type="button" className="danger" onClick={() => remove(entry.name)}>
                        Delete it
                      </button>
                      <button type="button" onClick={() => setConfirming(null)}>Keep</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="ai-foot">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function mass(g: number): string {
  if (g >= 1e6) return `${(g / 1e6).toFixed(2)} t`;
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg`;
  return `${g.toFixed(g < 10 ? 1 : 0)} g`;
}

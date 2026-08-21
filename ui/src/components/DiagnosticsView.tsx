import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { useModel } from '../modelStore';
import { triCount } from '../engine';
import { buildSupportBundle, collect, type DiagnosticsInput } from '../lib/diagnostics';
import { download } from '../lib/exporters';
import { brand } from '../brand';

/**
 * Diagnostics and support bundle (spec §20).
 *
 * The export defaults to redacted and the toggle to include identifiers is deliberately
 * a separate, labelled decision. A support bundle that quietly carried a customer's
 * project names would be used once and then never again.
 */
export function DiagnosticsView() {
  const doc = useStore((s) => s.doc);
  const context = useStore((s) => s.context);
  const providers = useStore((s) => s.providers);
  const providerId = useStore((s) => s.providerId);
  const connected = useStore((s) => s.connected);
  const demo = useStore((s) => s.demo);
  const undoStack = useStore((s) => s.undoStack);
  const redoStack = useStore((s) => s.redoStack);
  const stream = useStore((s) => s.stream);
  const note = useStore((s) => s.note);

  // The open DATUM document, which is what "the document" means with no seat attached.
  const modelDoc = useModel((s) => s.doc);
  const evaluated = useModel((s) => s.evaluated);

  const [includeIdentifiers, setIncludeIdentifiers] = useState(false);

  const input: DiagnosticsInput = useMemo(
    () => ({
      doc,
      context,
      open: demo
        ? {
            features: modelDoc.features.length,
            rebuildErrors: evaluated.errors.size,
            rebuildWarnings: evaluated.warnings.size,
            rebuildMs: evaluated.rebuildMs,
            massGrams: evaluated.massGrams,
            triangles: triCount(evaluated.mesh),
          }
        : null,
      providers,
      providerId,
      connected,
      demo,
      undoDepth: undoStack.length,
      redoDepth: redoStack.length,
      streamLength: stream.length,
    }),
    [doc, context, modelDoc, evaluated, providers, providerId, connected, demo,
     undoStack.length, redoStack.length, stream.length],
  );

  const sections = useMemo(() => collect(input), [input]);

  // Errors already surfaced in the transcript are the ones worth shipping.
  const errors = useMemo(
    () =>
      stream
        .filter((s) => s.kind === 'notice' && s.tone === 'error')
        .map((s) => (s.kind === 'notice' ? `${s.title ?? 'Error'}: ${s.text}` : ''))
        .filter(Boolean),
    [stream],
  );

  const exportBundle = () => {
    const contents = buildSupportBundle(input, errors, { includeIdentifiers });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    download(`${brand.name.toLowerCase()}-support-${stamp}.txt`, contents, 'text/plain');

    note(
      'info',
      includeIdentifiers
        ? 'Bundle exported WITH identifiers. It contains document paths, feature names and property values — check it before sending.'
        : 'Bundle exported with paths, feature names and property values redacted. Nothing was transmitted; send the file yourself.',
      'Support bundle',
    );
  };

  return (
    <div className="tabc">
      {sections.map((section) => (
        <div key={section.title}>
          <div className="st-h" style={{ padding: '10px 0 4px' }}>
            {section.title}
          </div>
          <div className="verify">
            {section.rows.map((row) => (
              <div className="vrow" key={row.label} data-tone={row.tone ?? ''}>
                <span className="g" aria-hidden="true">
                  {row.tone === 'ok' ? '✓' : row.tone === 'warn' ? '⚠' : row.tone === 'bad' ? '✕' : '·'}
                </span>
                <span>{row.label}</span>
                <span className="v">{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {errors.length > 0 && (
        <>
          <div className="st-h" style={{ padding: '12px 0 4px' }}>
            Recent errors · {errors.length}
          </div>
          {errors.slice(-5).map((e, i) => (
            <div className="find" key={i}>
              <div className="why" style={{ color: 'var(--dang)' }}>{e}</div>
            </div>
          ))}
        </>
      )}

      <div className="st-h" style={{ padding: '14px 0 6px' }}>
        Support bundle
      </div>

      <div className="chips">
        <button
          className="chip"
          aria-pressed={!includeIdentifiers}
          onClick={() => setIncludeIdentifiers(false)}
        >
          Redacted
        </button>
        <button
          className="chip"
          aria-pressed={includeIdentifiers}
          onClick={() => setIncludeIdentifiers(true)}
        >
          Include identifiers
        </button>
      </div>

      <button className="btn determ" onClick={exportBundle}>
        Export support bundle
      </button>

      <div className={includeIdentifiers ? 'note' : 'note info'} style={
        includeIdentifiers
          ? { borderColor: 'var(--warn)', background: 'var(--warn-dim)' }
          : undefined
      }>
        <b>{includeIdentifiers ? 'Identifiers included' : 'Redacted by default'}</b>
        {includeIdentifiers
          ? 'The bundle will contain document paths, feature names and property values. Read it before sending it to anyone outside your organisation.'
          : 'Shapes, counts, versions and timings are kept — that is what diagnoses a fault. Paths, feature names and property values are removed. The file is generated locally and never transmitted.'}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useModel } from '../modelStore';
import { printScript, runScript, type ScriptError } from '../generate/script';
import { evaluateDocument } from '../model/document';
import { triCount } from '../engine';
import { download } from '../lib/exporters';

/**
 * The part, as a program.
 *
 * ── Why this is a view and not a mode ──
 *
 * A script and a feature tree are the same thing written two ways, so this is not an
 * alternative modeller — it is the same document, printed. Edit here and the tree changes;
 * edit the tree and the text follows. Neither is the source of truth, which is what makes the
 * language a *format* rather than an input.
 *
 * That matters beyond convenience. A model that writes a part writes it as this, and a user
 * who cannot read what was written has no way to check it — the difference between a tool an
 * engineer signs off and one they have to trust. Printing the tree rather than echoing what
 * the model typed also means what is shown is what was *built*, not what was asked for.
 *
 * ── What it will not do ──
 *
 * Run something the kernel could not build. Every statement is checked against the same
 * feature schema the sliders are drawn from before anything is committed, and the errors come
 * back by line rather than as a rebuild that quietly does nothing.
 */
export function ScriptView() {
  const doc = useModel((s) => s.doc);
  const commit = useModel((s) => s.commit);

  const printed = useMemo(() => printScript(doc), [doc]);

  const [draft, setDraft] = useState(printed);
  const [errors, setErrors] = useState<ScriptError[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const edited = useRef(false);

  /*
   * Follow the document, unless the user is mid-edit.
   *
   * Overwriting a half-written script because a rebuild finished elsewhere would lose work
   * that took thought to write. Once anything has been typed the text belongs to the user
   * until they run it or discard it.
   */
  useEffect(() => {
    if (edited.current) return;
    setDraft(printed);
    setErrors([]);
  }, [printed]);

  const dirty = draft !== printed;

  const run = () => {
    const result = runScript(draft);
    setErrors(result.errors);

    if (!result.ok) {
      setNote(null);
      return;
    }

    const evaluated = evaluateDocument(result.doc);
    if (triCount(evaluated.mesh) === 0) {
      // Parsing is not building. A script with no body, or one that cuts everything away, is
      // well-formed and produces nothing — and replacing the open part with nothing on the
      // strength of a clean parse is the worst thing this button could do.
      setErrors([{
        line: 1,
        message: 'That script is valid but builds no solid. The part on screen has been left alone.',
        source: '',
      }]);
      return;
    }

    const failed = [...evaluated.errors.entries()];
    if (failed.length > 0) {
      setErrors(failed.map(([id, message]) => ({
        line: Math.max(1, result.doc.features.findIndex((f) => f.id === id) + 1),
        message,
        source: result.doc.features.find((f) => f.id === id)?.name ?? '',
      })));
      return;
    }

    edited.current = false;
    commit(result.doc, 'script');
    setNote(`Built ${result.doc.features.length} feature${result.doc.features.length === 1 ? '' : 's'}.`);
  };

  const revert = () => {
    edited.current = false;
    setDraft(printed);
    setErrors([]);
    setNote(null);
  };

  const lines = draft.split('\n').length;

  return (
    <div className="tabc">
      <div className="chips">
        <button className="chip" onClick={run} disabled={!dirty}>Run ▸</button>
        <button className="chip" onClick={revert} disabled={!dirty}>Revert</button>
        <button
          className="chip"
          onClick={() => download(`${doc.name}.datum`, draft, 'text/plain')}
        >
          Download
        </button>
      </div>

      <textarea
        className="script-editor"
        value={draft}
        spellCheck={false}
        aria-label="The part as a script"
        onChange={(e) => { edited.current = true; setDraft(e.target.value); setNote(null); }}
        style={{
          width: '100%',
          minHeight: 320,
          marginTop: 10,
          padding: 10,
          fontFamily: 'var(--mono)',
          fontSize: 12.5,
          lineHeight: 1.5,
          tabSize: 2,
          border: `1px solid ${errors.length > 0 ? 'var(--dang)' : 'var(--hairline)'}`,
          borderRadius: 'var(--r-ctl)',
          background: 'var(--input)',
          color: 'var(--tx0)',
          resize: 'vertical',
        }}
      />

      <div style={{ fontSize: 11.5, color: 'var(--tx2)', fontFamily: 'var(--mono)', marginTop: 4 }}>
        {lines} line{lines === 1 ? '' : 's'}{dirty ? ' · edited' : ''}
      </div>

      {errors.length > 0 && (
        <div
          className="assume"
          style={{ borderColor: 'var(--dang)', background: 'var(--dang-dim)', marginTop: 10 }}
        >
          <h5 style={{ color: 'var(--dang)' }}>
            ✕ {errors.length} problem{errors.length === 1 ? '' : 's'} · nothing was changed
          </h5>
          <ul>
            {errors.map((e, i) => (
              <li key={`${e.line}-${i}`}>
                <span style={{ fontFamily: 'var(--mono)' }}>line {e.line}</span> — {e.message}
                {e.source && (
                  <div style={{ fontFamily: 'var(--mono)', color: 'var(--tx2)', marginTop: 2 }}>
                    {e.source.trim()}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {note && <div className="note" style={{ marginTop: 10 }}><b>Ran</b>{note}</div>}

      <div className="note">
        <b>The same part, written down</b>
        A script and the feature tree are one document in two forms — edit either and the other
        follows. Every statement names a feature the kernel implements and every argument is
        checked against that feature’s own schema, so a script that could not be built does not
        run. Millimetres and degrees throughout; Z is up.
      </div>
    </div>
  );
}

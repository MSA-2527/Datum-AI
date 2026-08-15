import { useMemo, useRef, useState } from 'react';
import { useModel } from '../modelStore';
import { buildSystemPrompt } from '../ai/decompose';
import { exemplarsFor, fromFile, toJsonl, type Example } from '../lib/training';
import { type FileResult } from '../lib/bulk';
import { download } from '../lib/exporters';

/**
 * Teaching the planner from your own parts.
 *
 * The screen has one job beyond the buttons: being honest about what this does. "Train the
 * AI" means four different things to four people, and three of them are not what happens
 * here. So the panel says, in the product rather than only in a document, that examples are
 * retrieved and shown to the model at request time, that nothing is sent anywhere until a
 * request is made, and that the export exists for the day there is enough material for a
 * real fine-tune.
 *
 * The prompt field is the important control and is deliberately not optional. A part is only
 * half an example; the sentence someone would actually type is the half a model has to learn
 * to recognise, and it cannot be recovered from the part afterwards.
 */
export function TrainingDialog({ onClose }: { onClose: () => void }) {
  const docName = useModel((s) => s.doc.name);
  const featureCount = useModel((s) => s.doc.features.length);
  const lastRequest = useModel((s) => s.lastRequest);
  const aiId = useModel((s) => s.ai.id);
  const teach = useModel((s) => s.teach);
  const examples = useModel((s) => s.examples);
  const forget = useModel((s) => s.forget);
  const teachFolder = useModel((s) => s.teachFolder);

  const [revision, setRevision] = useState(0);
  const [prompt, setPrompt] = useState(lastRequest ?? '');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<FileResult[] | null>(null);

  const corpus = useMemo(() => examples(), [examples, revision]);

  // What would actually be used if this request were made now. Shown live, because "three
  // examples saved" and "one example would be used" are different facts and only the second
  // one affects the answer.
  const preview = useMemo(
    () => (prompt.trim() ? exemplarsFor(prompt, corpus) : { examples: [], skipped: [] }),
    [prompt, corpus],
  );

  const clean = prompt.trim();

  const add = () => {
    const r = teach(clean);
    setResult({ ok: r.ok, text: r.message });
    if (r.ok) setRevision((n) => n + 1);
  };

  const remove = (id: string) => {
    const r = forget(id);
    setConfirming(null);
    setResult({ ok: r.ok, text: r.message });
    if (r.ok) setRevision((n) => n + 1);
  };

  const exportJsonl = () => {
    if (corpus.length === 0) return;
    // Exported against the live system prompt: a model fine-tuned on a stale one has been
    // tuned to follow instructions it will never be sent again.
    download('datum-training.jsonl', toJsonl(corpus, buildSystemPrompt()), 'application/jsonl');
    setResult({
      ok: true,
      text:
        `Exported ${corpus.length} example${corpus.length === 1 ? '' : 's'} as ` +
        'datum-training.jsonl, with the system prompt each one was answered under.',
    });
  };

  /**
   * A folder of exports, taught in one pass.
   *
   * The manifest is picked out of the selection rather than asked for separately: it is
   * written beside the geometry by the export macro, so it is already in the folder the user
   * chose, and asking for it twice is asking them to know something the tool can find out.
   */
  const onFolder = async (chosen: FileList) => {
    setBusy(true);
    setReport(null);
    try {
      const all = [...chosen];
      const manifestFile = all.find((f) => /manifest\.csv$/i.test(f.name));
      const steps = all.filter((f) => /\.(stp|step)$/i.test(f.name));

      if (steps.length === 0) {
        setResult({ ok: false, text: 'No STEP files in that selection. Export the library first — see tools/solidworks.' });
        return;
      }

      const files = await Promise.all(
        steps.map(async (f) => ({ name: f.name, text: await f.text() })),
      );

      const r = teachFolder(files, manifestFile ? await manifestFile.text() : undefined);
      setResult({ ok: r.ok, text: r.message + (manifestFile ? '' : ' No manifest.csv was included, so nothing had a request to be paired with.') });
      setReport(r.result.results);
      setRevision((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File) => {
    const r = fromFile(await file.text());
    setRevision((n) => n + 1);
    setResult({
      ok: r.added > 0,
      text: r.problem
        ? r.problem
        : `Imported ${r.added} example${r.added === 1 ? '' : 's'}.` +
          (r.rejected.length > 0
            ? ` ${r.rejected.length} line${r.rejected.length === 1 ? '' : 's'} were not usable: ` +
              `${r.rejected.slice(0, 3).map((x) => `line ${x.line} (${x.reason})`).join(', ')}.`
            : ''),
    });
  };

  return (
    <div className="ai-overlay" role="dialog" aria-label="Training set" aria-modal="true">
      <div className="ai-panel">
        <div className="ai-head">
          <strong>Teach it your parts</strong>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>

        <p className="ai-intro">
          Each example is a request and the part that correctly answers it. When a new request
          comes in, the closest examples are shown to the model as worked answers, so it builds
          in your vocabulary, at your dimensions, with your conventions.
        </p>

        <details className="tr-what">
          <summary>What this does and does not do</summary>
          <ul>
            <li>
              <strong>It steers the model at request time.</strong> Examples are retrieved by
              relevance and put in the prompt. The effect is immediate, and every example used
              is named in the reply — so a bad one can be found and deleted.
            </li>
            <li>
              <strong>It does not change a model’s weights.</strong> That is fine-tuning, it
              runs on a provider’s infrastructure, and it needs hundreds of examples before it
              beats good prompting. Export builds that dataset for the day you have the volume.
            </li>
            <li>
              <strong>It cannot teach shapes the kernel has no vocabulary for.</strong> An
              example is a plan — archetypes and primitives placed in space. A part using
              sketches or fillets is refused rather than stored half-learnt.
            </li>
            <li>
              <strong>Nothing leaves this machine on its own.</strong> Examples are stored
              locally and are sent only as part of a request you make, to the provider you
              configured.
            </li>
          </ul>
        </details>

        <div className="ai-field">
          <label htmlFor="tr-prompt">Teach “{docName}” as the answer to</label>
          <div className="lib-save">
            <input
              id="tr-prompt"
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setResult(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && clean) add(); }}
              placeholder="e.g. a 6-hole mounting bracket for a NEMA 23"
              spellCheck={false}
            />
            <button type="button" className="primary" onClick={add} disabled={!clean || featureCount === 0}>
              Teach
            </button>
          </div>
          <span className="ai-note">
            {featureCount === 0
              ? 'Build or open a part first — there is nothing to learn from yet.'
              : 'Write it the way someone would ask, not the way the part is named. ' +
                'The request is what the model has to learn to recognise.'}
          </span>
        </div>

        {result && <div className="ai-result" data-ok={result.ok ? 'true' : 'false'}>{result.text}</div>}

        {clean.length > 0 && corpus.length > 0 && (
          <p className="ai-note">
            {preview.examples.length === 0
              ? 'No saved example is close enough to this request to be used.'
              : `${preview.examples.length} example${preview.examples.length === 1 ? '' : 's'} ` +
                `would be used for this request: ${preview.examples.map((e) => `“${e.prompt}”`).join(', ')}.`}
            {preview.skipped.length > 0 &&
              ` ${preview.skipped.length} more matched but were too large for the prompt budget.`}
          </p>
        )}

        <div className="ai-field">
          <label>Examples ({corpus.length})</label>
          {corpus.length === 0 ? (
            <span className="ai-note">
              Nothing taught yet. Open one of your own parts, write the request it answers, and
              press Teach.
            </span>
          ) : (
            <ul className="lib-list">
              {corpus.map((example) => (
                <li key={example.id}>
                  <div className="lib-item">
                    <div className="lib-item-text">
                      <strong>{example.prompt}</strong>
                      <span>
                        {example.plan.name} · {example.plan.components.length} component
                        {example.plan.components.length === 1 ? '' : 's'} · {originLabel(example)}
                        {' · '}{new Date(example.savedAtUtc).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="lib-item-actions">
                      <button
                        type="button"
                        className="danger"
                        onClick={() => setConfirming(confirming === example.id ? null : example.id)}
                      >
                        Forget
                      </button>
                    </div>
                  </div>

                  {confirming === example.id && (
                    <div className="lib-confirm">
                      <span>Forget this example? It will stop steering what gets built.</span>
                      <button type="button" className="danger" onClick={() => remove(example.id)}>
                        Forget it
                      </button>
                      <button type="button" onClick={() => setConfirming(null)}>Keep</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {aiId === 'none' && corpus.length > 0 && (
          <span className="ai-note">
            No model is configured, so these examples are stored but not yet used — the
            deterministic catalogue does not consult them. Turn a model on in AI settings.
          </span>
        )}

        {report && (
          <details className="tr-report">
            <summary>What happened to each file ({report.length})</summary>
            <ul>
              {report.map((r) => (
                <li key={r.file} data-outcome={r.outcome}>
                  <strong>{r.file}</strong>
                  <span>{r.outcome} — {r.detail}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="ai-foot">
          <button onClick={() => folderRef.current?.click()} disabled={busy}>
            {busy ? 'Reading…' : 'Teach a folder…'}
          </button>
          <button onClick={() => fileRef.current?.click()}>Import…</button>
          <button onClick={exportJsonl} disabled={corpus.length === 0}>
            Export for fine-tuning
          </button>
          <button onClick={onClose}>Close</button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".jsonl,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = '';
          }}
        />

        {/* Select the whole export folder: the STEP files and the manifest beside them. */}
        <input
          ref={folderRef}
          type="file"
          accept=".stp,.step,.csv"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files?.length) void onFolder(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}

function originLabel(example: Example): string {
  switch (example.origin) {
    case 'correction': return 'from a correction';
    case 'imported': return 'imported';
    default: return 'taught';
  }
}

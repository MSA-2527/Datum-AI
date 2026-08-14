import { useState } from 'react';
import { useModel } from '../modelStore';
import {
  PROVIDERS, providerInfo, testConnection, type ProviderConfig, type ProviderId,
} from '../ai/providers';

/**
 * AI settings.
 *
 * Three things this screen has to be honest about, and each is stated on the screen rather
 * than only here.
 *
 * A model is optional. The application works with none, and the default is none.
 *
 * The key is stored in this browser and sent only to the provider it belongs to. There is no
 * backend to proxy it through. That also means anything able to run script on this page can
 * read it, which is a real consequence of having no server and is said plainly.
 *
 * The model id is free text. Providers rename and retire models constantly, and a fixed
 * dropdown goes stale the week after it ships — so the field accepts anything and the
 * provider's own error is shown when it does not recognise the name.
 */
export function AiSettings({ onClose }: { onClose: () => void }) {
  const config = useModel((s) => s.ai);
  const setAi = useModel((s) => s.setAi);

  const [draft, setDraft] = useState<ProviderConfig>(config);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [showKey, setShowKey] = useState(false);

  const info = providerInfo(draft.id);

  const pick = (id: ProviderId) => {
    const next = providerInfo(id);
    setDraft({
      ...draft,
      id,
      // Offer the provider's current first suggestion rather than carrying a model name
      // across providers, where it will certainly be wrong.
      model: next.suggestedModels[0] ?? '',
      allowWebSearch: next.supportsWebSearch ? draft.allowWebSearch : false,
    });
    setResult(null);
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await testConnection(draft);
      setResult(
        r.ok
          ? { ok: true, text: `Reached ${r.model} in ${(r.ms / 1000).toFixed(1)} s.` }
          : { ok: false, text: r.detail ? `${r.message} — ${r.detail.slice(0, 220)}` : r.message },
      );
    } finally {
      setTesting(false);
    }
  };

  const save = () => {
    setAi(draft);
    onClose();
  };

  return (
    <div className="ai-overlay" role="dialog" aria-label="AI settings" aria-modal="true">
      <div className="ai-panel">
        <div className="ai-head">
          <strong>AI settings</strong>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>

        <p className="ai-intro">
          Optional. Without a model the app uses a built-in matcher: offline, instant, and the
          same result every time. A model adds unusual phrasing and decomposing objects that
          are not in the catalogue.
        </p>

        <div className="ai-field">
          <label htmlFor="ai-provider">Provider</label>
          <select
            id="ai-provider"
            value={draft.id}
            onChange={(e) => pick(e.target.value as ProviderId)}
          >
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <span className="ai-note">{info.note}</span>
        </div>

        {draft.id !== 'none' && (
          <>
            <div className="ai-field">
              <label htmlFor="ai-model">Model id</label>
              <input
                id="ai-model"
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                placeholder={info.suggestedModels[0] ?? 'model name'}
                spellCheck={false}
              />
              <span className="ai-note">
                Free text — type whatever the provider currently calls it. Known to work:{' '}
                {info.suggestedModels.join(', ') || 'see the provider’s documentation'}. If the
                name is wrong the provider says so and it is shown here.
              </span>
              {info.suggestedModels.length > 0 && (
                <div className="ai-chips">
                  {info.suggestedModels.map((m) => (
                    <button key={m} onClick={() => setDraft({ ...draft, model: m })}>{m}</button>
                  ))}
                </div>
              )}
            </div>

            {info.needsKey && (
              <div className="ai-field">
                <label htmlFor="ai-key">API key</label>
                <div className="ai-key-row">
                  <input
                    id="ai-key"
                    type={showKey ? 'text' : 'password'}
                    value={draft.apiKey}
                    onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                    placeholder="Paste your key"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button onClick={() => setShowKey((v) => !v)} title={showKey ? 'Hide' : 'Show'}>
                    {showKey ? '🙈' : '👁'}
                  </button>
                </div>
                <span className="ai-note">
                  Stored in this browser and sent only to {info.label}. There is no server here
                  to proxy it through. Anything that can run script on this page could read it,
                  so use a key you can revoke.
                  {info.keyUrl && (
                    <> <a href={info.keyUrl} target="_blank" rel="noreferrer noopener">Get a key</a>.</>
                  )}
                </span>
              </div>
            )}

            <div className="ai-field">
              <label htmlFor="ai-base">Endpoint (optional)</label>
              <input
                id="ai-base"
                value={draft.baseUrl ?? ''}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                placeholder="Leave blank for the default"
                spellCheck={false}
              />
            </div>

            {info.supportsWebSearch && (
              <label className="ai-check">
                <input
                  type="checkbox"
                  checked={draft.allowWebSearch}
                  onChange={(e) => setDraft({ ...draft, allowWebSearch: e.target.checked })}
                />
                <span>
                  <strong>Let the model search the web</strong>
                  <em>
                    For looking up real dimensions. The search runs on {info.label}’s servers —
                    a web page cannot fetch arbitrary sites itself. Your request text is sent
                    to their search. Sources are cited on the result.
                  </em>
                </span>
              </label>
            )}

            <div className="ai-actions">
              <button onClick={test} disabled={testing}>
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              {draft.apiKey && (
                <button onClick={() => setDraft({ ...draft, apiKey: '' })}>Clear key</button>
              )}
            </div>

            {result && (
              <div className="ai-result" data-ok={result.ok}>{result.text}</div>
            )}
          </>
        )}

        <div className="ai-foot">
          <button onClick={onClose}>Cancel</button>
          <button className="btn determ" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

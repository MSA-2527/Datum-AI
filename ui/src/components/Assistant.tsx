import { useCallback, useEffect, useRef, useState } from 'react';
import { useModel } from '../modelStore';

/**
 * The build assistant.
 *
 * Pulled out of the modeller so Studio can use the same one. Studio had its own composer
 * writing into a separate legacy store, which is why typing a request there appeared to do
 * nothing — it built into a document nothing on screen was showing.
 *
 * Owns its own transcript. That is deliberate: the transcript is a record of this
 * conversation, not part of the document, and it should not survive a Save or be restored by
 * an Undo. Everything that *is* part of the document — the model, the pending questions, the
 * notice — comes from the store, so both copies of this component stay in step.
 */

interface Message {
  id: number;
  from: 'user' | 'app';
  text: string;
  tone?: 'info' | 'warn' | 'error';
}

let messageId = 0;

export function Assistant({ starters }: { starters?: string[] }) {
  const build = useModel((s) => s.build);
  const notice = useModel((s) => s.notice);
  const pending = useModel((s) => s.pending);
  const answer = useModel((s) => s.answer);
  const buildAnswered = useModel((s) => s.buildAnswered);
  const cancelPending = useModel((s) => s.cancelPending);

  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  const say = useCallback((from: Message['from'], text: string, tone?: Message['tone']) => {
    // The id is taken *before* the updater, not inside it.
    //
    // A state updater must be pure: React calls it more than once — twice under StrictMode,
    // and again on any re-render it decides to discard — and only keeps one result. With
    // `++messageId` inside, the counter advanced on invocations whose results were thrown
    // away, and two surviving messages could land on the same id. React then warned about
    // duplicate keys and was entitled to drop or duplicate a message in the transcript.
    const id = ++messageId;
    setMessages((m) => [...m, { id, from, text, tone }]);
  }, []);

  // Follow the conversation only when already at the bottom, so reading back through history
  // is not yanked away by a new message.
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const submit = useCallback(() => {
    const prompt = draft.trim();
    if (!prompt || busy) return;

    say('user', prompt);
    setDraft('');
    setBusy(true);

    // Yield once so the message paints before a heavy build starts. A timer rather than
    // requestAnimationFrame: rAF does not fire while the page is not being composited — a
    // background tab, a hidden panel — so a build queued behind it would never start.
    setTimeout(() => {
      void build(prompt)
        .then((r) => say('app', r.message, r.ok ? 'info' : 'warn'))
        .catch((e: unknown) =>
          say('app', e instanceof Error ? e.message : 'That could not be built.', 'error'))
        .finally(() => setBusy(false));
    }, 16);
  }, [draft, busy, build, say]);

  return (
    <>
      <div className="ms-stream" ref={streamRef}>
        {messages.length === 0 && (
          <div className="empty">
            <strong>Describe what to build</strong>
            Everything runs on this machine — no licence, no account, no network.
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={m.from === 'user' ? 'msg-user rise' : 'ms-reply'} data-tone={m.tone}>
            {m.text}
          </div>
        ))}

        {busy && <div className="ms-reply" data-tone="info">Building…</div>}
      </div>

      {pending && (
        <div className="ms-ask">
          <div className="ms-ask-head">
            <strong>Before I build it</strong>
            <span>Every question has a default. Answer none and press Build.</span>
          </div>

          {pending.clarification.questions.map((q) => {
            const chosen = pending.answers[q.key] ?? q.defaultIndex;
            return (
              <div className="ms-ask-q" key={q.key}>
                <p>{q.question}</p>
                <div className="ms-ask-choices">
                  {q.choices.map((c, i) => (
                    <button
                      key={c.label}
                      type="button"
                      title={c.note}
                      aria-pressed={i === chosen}
                      className={i === chosen ? 'is-chosen' : undefined}
                      onClick={() => answer(q.key, i)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                {q.choices[chosen]?.note && <span className="ms-ask-note">{q.choices[chosen].note}</span>}
              </div>
            );
          })}

          {pending.clarification.citations.length > 0 && (
            <div className="ms-ask-sources">
              <strong>Researched from</strong>
              <ul>
                {pending.clarification.citations.slice(0, 4).map((c) => (
                  <li key={c.uri}>
                    <a href={c.uri} target="_blank" rel="noreferrer noopener">{c.title || c.uri}</a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="ms-ask-actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void buildAnswered()
                  .then((r) => say('app', r.message, r.ok ? 'info' : 'warn'))
                  .finally(() => setBusy(false));
              }}
            >
              Build it
            </button>
            <button type="button" onClick={cancelPending}>Cancel</button>
          </div>
        </div>
      )}

      {messages.length === 0 && !pending && starters && starters.length > 0 && (
        <div className="ms-starters">
          {starters.map((s) => (
            <button key={s} onClick={() => setDraft(s)}>{s}</button>
          ))}
        </div>
      )}

      {notice && <div className="ms-notice" data-tone={notice.tone}>{notice.text}</div>}

      <div className="ms-composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder="Describe a part…"
          rows={2}
          aria-label="Describe a part"
        />
        <button className="btn determ" onClick={submit} disabled={busy || draft.trim().length === 0}>
          {busy ? 'Building…' : 'Build ⏎'}
        </button>
      </div>
    </>
  );
}

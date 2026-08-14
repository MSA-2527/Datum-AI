import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import type { PlanMode } from '../types';

const MODE_GLYPH: Record<PlanMode, string> = {
  Ask: '?',
  Build: '+',
  Edit: '~',
  Batch: '⧉',
};

const PLACEHOLDER: Record<PlanMode, string> = {
  Ask: 'Ask about this model…',
  Build: 'Describe what to create…',
  Edit: 'Describe the change…',
  Batch: 'Describe the change to apply across many files…',
};

const STARTERS = [
  'Add NEMA 17 mounting holes and R3 corner fillets',
  'Fill the missing custom properties from our naming rules',
  'Export every configuration as STEP and a shop PDF',
];

export function Composer() {
  const draft = useStore((s) => s.draft);
  const setDraft = useStore((s) => s.setDraft);
  const mode = useStore((s) => s.mode);
  const cycleMode = useStore((s) => s.cycleMode);
  const send = useStore((s) => s.send);
  const busy = useStore((s) => s.busy);
  const ctx = useStore((s) => s.context);
  const clearSelection = useStore((s) => s.clearSelection);
  const stream = useStore((s) => s.stream);
  const focusNonce = useStore((s) => s.composerFocusNonce);
  const focusComposer = useStore((s) => s.focusComposer);

  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow, capped so the composer never eats the conversation.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+Shift+K focuses the composer from anywhere, matching the shortcut the
      // add-in registers inside SOLIDWORKS itself.
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focusComposer();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusComposer]);

  // Both the keyboard shortcut and a right-click "Ask DATUM" inside SOLIDWORKS raise the
  // same counter, so there is one focus path rather than two that can disagree.
  useEffect(() => {
    if (focusNonce === 0) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusNonce]);

  // Drain the queue the moment the planner frees up, so a message typed mid-plan is
  // sent rather than silently lost.
  const queued = useStore((s) => s.queued);
  useEffect(() => {
    if (!busy && queued) {
      useStore.setState({ queued: null });
      void send(queued);
    }
  }, [busy, queued, send]);

  const selection = ctx?.selection ?? [];
  const showStarters = stream.filter((s) => s.kind !== 'notice').length === 0;

  return (
    <>
      {selection.length > 0 && (
        <div className="selchip">
          <span aria-hidden="true">⬡</span>
          <span>
            {selection.length === 1
              ? selection[0]!.label
              : `${selection.length} entities selected`}
          </span>
          <button type="button" className="x" aria-label="Ignore selection" onClick={clearSelection}>
            ✕
          </button>
        </div>
      )}

      <div className="composer">
        {showStarters && (
          <div className="starters">
            {STARTERS.map((s) => (
              <button type="button" key={s} className="starter" onClick={() => void send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}

        <div className="cbox" data-mode={mode}>
          <textarea
            ref={ref}
            rows={2}
            value={draft}
            placeholder={PLACEHOLDER[mode]}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              } else if (e.key === 'Tab') {
                // Tab cycles mode — mode is a safety control, so it needs to be one
                // keystroke away and impossible to miss visually.
                e.preventDefault();
                cycleMode();
              } else if (e.key === 'Escape') {
                setDraft('');
              }
            }}
          />

          <div className="crow">
            <button
              type="button"
              className="mode"
              data-mode={mode}
              onClick={cycleMode}
              aria-label={`Mode: ${mode}. Cycle with Tab.`}
              title="Cycle mode (Tab). Ask mode cannot modify the model."
            >
              {MODE_GLYPH[mode]} {mode}
            </button>

            {/*
              Spec'd input modalities that this build does not implement yet. They stay
              in the layout, disabled, and say so — a button that looks live and does
              nothing when clicked costs more trust than an honest one that is off.
            */}
            <button
              type="button"
              className="icon-btn"
              disabled
              title="Voice input (Ctrl+Space) — not in this build"
              aria-label="Voice input, not available in this build"
            >
              ◉
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled
              title="Attach a file, sketch photo, or datasheet — not in this build"
              aria-label="Attach a file, not available in this build"
            >
              ⎘
            </button>
            <button
              type="button"
              className="icon-btn"
              disabled
              title="Capture the SOLIDWORKS viewport and mark it up — not in this build"
              aria-label="Capture viewport, not available in this build"
            >
              ▣
            </button>

            <button
              type="button"
              className="send"
              disabled={draft.trim().length === 0}
              onClick={() => void send()}
            >
              {queued ? 'Queued' : busy ? 'Working…' : 'Send ⏎'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

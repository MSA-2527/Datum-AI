import { useEffect, useRef } from 'react';
import { brand } from '../brand';
import { api } from '../lib/api';
import { useStore } from '../store';
import type { Tab } from '../types';
import { CapabilityCard, NoticeCard, ResultCard } from './Cards';
import { Composer } from './Composer';
import { ContextBar } from './ContextBar';
import { PlanCard } from './PlanCard';
import { HealthTab, ParamsTab, TreeTab } from './Tabs';
import { ModelTree, FeatureEditor } from './ModelTree';

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: 'chat', label: 'Chat', glyph: '💬' },
  { id: 'tree', label: 'Tree', glyph: '⌗' },
  { id: 'params', label: 'Params', glyph: '⚙' },
  { id: 'health', label: 'Health', glyph: '⚠' },
];

/**
 * The Studio window is a second surface on the same bundle. Inside the task pane's
 * WebView2 the host blocks popups by design, so a blocked open is reported rather than
 * failing silently — the URL is still usable in a browser.
 */
function openStudio(note: (tone: 'info' | 'warn' | 'error', text: string, title?: string) => void) {
  const opened = window.open(api.studioUrl, 'datum-studio', 'noopener,noreferrer');
  if (!opened) {
    note('warn', `Studio could not be opened from here. Browse to ${api.studioUrl}`, 'Popup blocked');
  }
}

export function Panel() {
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const ctx = useStore((s) => s.context);
  const note = useStore((s) => s.note);

  /*
   * Which document the tree and the parameters describe.
   *
   * With a seat attached this panel is a view onto the live SOLIDWORKS document, and
   * `TreeTab` and `ParamsTab` read it. With no seat there is no such document, and they were
   * reading the 2.5D sample bracket instead - underneath a banner promising "every control
   * works and your work is saved locally as you go", which was true of the modeller and not of
   * anything on this screen.
   *
   * Standalone, the same tree and feature editor the modeller uses go here. They read the
   * document the assistant builds into, so the promise the banner makes is one the panel keeps.
   */
  const standalone = useStore((s) => s.demo);

  const warnings = (ctx?.features ?? []).filter((f) => f.underDefined || f.fragileRef).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // F8 opens Studio (keyboard map, docs/04-ux-spec.md §8).
      if (e.key === 'F8' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        openStudio(note);
        return;
      }

      if (!e.ctrlKey || e.shiftKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= TABS.length) {
        e.preventDefault();
        setTab(TABS[n - 1]!.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTab, note]);

  return (
    <div className="panel">
      <Header onOpenStudio={() => openStudio(note)} />
      <ContextBar />

      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="panel-body">
        {tab === 'chat' && <Stream />}
        {tab === 'tree' && (standalone ? <ModelTree /> : <TreeTab />)}
        {tab === 'params' && (
          standalone ? <div className="tabc"><FeatureEditor /></div> : <ParamsTab />
        )}
        {tab === 'health' && <HealthTab />}
      </div>

      {tab === 'chat' && <Composer />}

      <div className="rail" role="tablist" aria-label="Panel sections">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            id={`tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            // Only the selected panel is mounted, so only the selected tab may claim to
            // control one — a dangling aria-controls is worse than none.
            aria-controls={tab === t.id ? `panel-${t.id}` : undefined}
            // Roving tabindex: the tablist is a single tab stop and arrows move within it.
            tabIndex={tab === t.id ? 0 : -1}
            title={`${t.label} (Ctrl+${i + 1})`}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const delta =
                e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
              if (delta === 0) return;
              e.preventDefault();

              const next = TABS[(i + delta + TABS.length) % TABS.length]!;
              setTab(next.id);
              // Focus has to follow the roving tabindex, or the next arrow press starts
              // from the tab the user just left.
              document.getElementById(`tab-${next.id}`)?.focus();
            }}
          >
            <span aria-hidden="true">{t.glyph}</span> {t.label}
            {t.id === 'health' && warnings > 0 && (
              <span className="badge" aria-label={`${warnings} model-health warnings`}>
                {warnings}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function Header({ onOpenStudio }: { onOpenStudio: () => void }) {
  const providers = useStore((s) => s.providers);
  const providerId = useStore((s) => s.providerId);
  const setProvider = useStore((s) => s.setProvider);
  const connected = useStore((s) => s.connected);

  // Only an *available* provider is the active one. The chip is the one place that tells a
  // user where their geometry is going, so naming a planner that is not attached is the worst
  // thing it can do — worse than saying nothing.
  const active = providers.find((p) => p.id === providerId && p.available);

  /**
   * The provider chip is the most important status in the app: it tells the user
   * whether their model data is staying on this machine. Clicking cycles through the
   * available providers without leaving the panel.
   */
  const cycle = () => {
    const avail = providers.filter((p) => p.available);
    if (avail.length === 0) return;
    const i = avail.findIndex((p) => p.id === providerId);
    setProvider(avail[(i + 1) % avail.length]!.id);
  };

  return (
    <div className="p-head">
      <span className="mark" aria-hidden="true" />
      <span className="nm">{brand.name}</span>

      <div className="head-actions">
        <button
          type="button"
          className="prov"
          data-kind={active?.kind ?? 'Local'}
          data-offline={!connected}
          onClick={cycle}
          disabled={providers.filter((p) => p.available).length < 2}
          title="Switch planner. Local keeps everything on this machine."
        >
          <span className="dot" />
          <span>
            {active ? `${kindLabel(active.kind)} · ${shortModel(active.model)}` : 'No planner'}
          </span>
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled
          title="Settings — not in this build"
          aria-label="Settings, not available in this build"
        >
          ⚙
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Open Studio (F8)"
          aria-label="Open Studio"
          onClick={onOpenStudio}
        >
          ⤢
        </button>
      </div>
    </div>
  );
}

function kindLabel(kind: string): string {
  return kind === 'Managed' ? 'Pro' : kind === 'ByoKey' ? 'BYO' : 'Local';
}

function shortModel(model: string): string {
  return model
    .replace('claude-', '')
    .replace('-instruct', '')
    .replace(/-q\d.*$/, '')
    .replace('2.5-coder-', ' ');
}

function Stream() {
  const stream = useStore((s) => s.stream);
  const ctx = useStore((s) => s.context);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  /*
    Follow the conversation only while the user is already at the bottom.

    Unconditional auto-scroll is the classic chat bug: you scroll up to re-read an
    assumption on an earlier plan, a status update lands, and you are yanked back down.
    Track whether they are pinned to the bottom and honour that.
  */
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  useEffect(() => {
    if (pinnedRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [stream.length]);

  return (
    <div className="stream" ref={scrollRef} onScroll={onScroll}>
      {stream.length === 0 && ctx && <Welcome />}

      {stream.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div className="msg-user rise" key={item.id}>
                {item.text}
                {item.refs.length > 0 && (
                  <div className="refs">
                    {item.refs.map((r) => (
                      <span className="ref" key={r}>
                        ⬡ {r}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          case 'plan':
            return (
              <PlanCard
                key={item.id}
                itemId={item.id}
                plan={item.plan}
                issues={item.issues}
                state={item.state}
              />
            );
          case 'result':
            return <ResultCard key={item.id} report={item.report} />;
          case 'capability':
            return <CapabilityCard key={item.id} miss={item.miss} />;
          case 'notice':
            return <NoticeCard key={item.id} tone={item.tone} title={item.title} text={item.text} />;
        }
      })}

      <div ref={endRef} />
    </div>
  );
}

/**
 * Suggested starters derived from the ACTUAL open document rather than generic prompts —
 * the panel should already know what is wrong with your model before you ask.
 */
function Welcome() {
  const ctx = useStore((s) => s.context)!;
  const send = useStore((s) => s.send);

  const warnings = ctx.features.filter((f) => f.underDefined || f.fragileRef).length;
  const missingProps = ['PartNo', 'Revision', 'Description'].filter((k) => !ctx.properties[k]);

  return (
    <div className="card">
      <div className="c-body" style={{ fontSize: 12.5, color: 'var(--tx1)' }}>
        <strong style={{ display: 'block', marginBottom: 5, fontSize: 13, color: 'var(--tx0)' }}>
          Ready — {ctx.docTitle}
        </strong>
        {ctx.features.length} features · {ctx.rebuildErrors} errors · {warnings} warnings
        {missingProps.length > 0 && (
          <>
            {' · '}
            {missingProps.length} empty properties
          </>
        )}
        <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {warnings > 0 && (
            <button
              type="button"
              className="starter"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => void send('Fix the under-defined sketches and fragile references')}
            >
              Fix {warnings} model-health {warnings === 1 ? 'warning' : 'warnings'}
            </button>
          )}
          {missingProps.length > 0 && (
            <button
              type="button"
              className="starter"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => void send('Fill the missing custom properties from our naming rules')}
            >
              Fill {missingProps.length} empty {missingProps.length === 1 ? 'property' : 'properties'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

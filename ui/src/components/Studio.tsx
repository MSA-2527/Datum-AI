import { useState } from 'react';
import { ContextBar } from './ContextBar';
import { HealthTab } from './Tabs';
import { ModelTree, FeatureEditor as ModelFeatureEditor } from './ModelTree';
import { ModelViewport } from './ModelViewport';
import { Assistant } from './Assistant';
import { BatchView, DrawingsView, HistoryView, IndexView, SkillsView } from './StudioViews';
import { DfmView } from './DfmView';
import { ScriptView } from './ScriptView';
import { DocumentToolbar } from './DocumentToolbar';
import { RecipeEditor } from './RecipeEditor';
import { DiagnosticsView } from './DiagnosticsView';

type View =
  | 'chat'
  | 'tree'
  | 'params'
  | 'feature'
  | 'script'
  | 'dfm'
  | 'skills'
  | 'recipes'
  | 'batch'
  | 'drawings'
  | 'health'
  | 'index'
  | 'history'
  | 'diagnostics';

const RAIL: { id: View; glyph: string; label: string }[] = [
  { id: 'chat', glyph: '💬', label: 'Chat' },
  { id: 'tree', glyph: '⌗', label: 'Model Explorer' },
  { id: 'params', glyph: '⚙', label: 'Parameters' },
  { id: 'feature', glyph: '◈', label: 'Feature editor' },
  { id: 'script', glyph: '⌨', label: 'Script' },
  { id: 'dfm', glyph: '$', label: 'Manufacturability & cost' },
  { id: 'skills', glyph: '⚡', label: 'Skills' },
  { id: 'recipes', glyph: '⧉', label: 'Recipes' },
  { id: 'batch', glyph: '⧉', label: 'Batch' },
  { id: 'drawings', glyph: '▤', label: 'Drawings' },
  { id: 'health', glyph: '⚠', label: 'Health' },
  { id: 'index', glyph: '⌕', label: 'Reuse Index' },
  { id: 'history', glyph: '⏱', label: 'History' },
  { id: 'diagnostics', glyph: '⚕', label: 'Diagnostics' },
];

/**
 * Studio — same bundle as the task pane, different composition. It exists because a
 * 380 px pane cannot host a batch grid, a skill editor or an index browser.
 */
export function Studio() {
  const [view, setView] = useState<View>('tree');

  return (
    <div className="studio">
      <div className="st-rail" role="tablist" aria-label="Studio sections">
        {RAIL.map((r) => (
          <button
            key={r.id}
            role="tab"
            aria-selected={view === r.id}
            title={r.label}
            aria-label={r.label}
            onClick={() => setView(r.id)}
          >
            <span aria-hidden="true">{r.glyph}</span>
          </button>
        ))}
      </div>

      <div className="st-col">
        <div className="st-h">{RAIL.find((r) => r.id === view)?.label}</div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <LeftView view={view} />
        </div>
      </div>

      {/*
        The real 3D view and the real assistant, both reading the same document as the
        modeller.

        Studio used to render a flat SVG plan over a separate 2.5D model, with a composer that
        wrote into a different store again — so it looked two-dimensional and typing a request
        appeared to do nothing, because it built into a document nothing on screen was showing.
        Two pipelines, one of them invisible.
      */}
      <div className="st-col st-center">
        <DocumentToolbar />
        <ModelViewport />
      </div>

      <div className="st-col" style={{ borderRight: 'none' }}>
        <div className="st-h">Assistant</div>
        <ContextBar />
        <Assistant starters={['a car engine', 'an anodizing rack', 'a gearbox', 'make a cup']} />
      </div>
    </div>
  );
}

function LeftView({ view }: { view: View }) {
  switch (view) {
    // The tree, the parameters and the feature editor are the same components the modeller
    // uses, reading the same document. Studio had its own copies over the legacy store, so
    // building a gearbox filled the 3D view and left the explorer empty — the panels were
    // describing a document nobody was looking at.
    case 'tree':
      return <ModelTree />;
    case 'params':
    case 'feature':
      return (
        <div className="tabc">
          <ModelFeatureEditor />
        </div>
      );
    case 'script':
      return <ScriptView />;
    case 'health':
      return <HealthTab />;
    case 'dfm':
      return <DfmView />;
    case 'skills':
      return <SkillsView />;
    case 'recipes':
      return <RecipeEditor />;
    case 'batch':
      return <BatchView />;
    case 'drawings':
      return <DrawingsView />;
    case 'index':
      return <IndexView />;
    case 'history':
      return <HistoryView />;
    case 'diagnostics':
      return <DiagnosticsView />;
    default:
      return (
        <div className="tabc">
          <div className="empty">
            <strong>Chat</strong>
            Use the Copilot panel on the right.
          </div>
        </div>
      );
  }
}


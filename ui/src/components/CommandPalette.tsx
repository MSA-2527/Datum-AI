import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { FEATURE_TEMPLATES, evaluate, massGrams } from '../lib/partModel';
import { download, toDxf, toManifest, toSvg } from '../lib/exporters';

/**
 * Command palette (Ctrl+K) and the global keyboard map.
 *
 * Engineers live on the keyboard, and a docked panel competes with SOLIDWORKS for every
 * shortcut — so this binds only the ones the UX spec reserved, and only when focus is
 * inside the panel. It never swallows a keystroke meant for the CAD window.
 */

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const doc = useStore((s) => s.doc);
  const addFeature = useStore((s) => s.addFeature);
  const undoLast = useStore((s) => s.undoLast);
  const redoLast = useStore((s) => s.redoLast);
  const saveDocument = useStore((s) => s.saveDocument);
  const newDocument = useStore((s) => s.newDocument);
  const setTab = useStore((s) => s.setTab);
  const setMode = useStore((s) => s.setMode);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];

    for (const t of FEATURE_TEMPLATES) {
      if (t.needsSeed) continue; // a seedless pattern would fail on invoke
      list.push({
        id: `add.${t.kind}`,
        label: `Add ${t.label}`,
        group: 'Model',
        run: () => addFeature(t.kind, {}),
      });
    }

    list.push(
      { id: 'doc.new', label: 'New part', group: 'Document', hint: 'Ctrl+N', run: newDocument },
      { id: 'doc.save', label: 'Save part', group: 'Document', hint: 'Ctrl+S', run: () => saveDocument() },
      { id: 'edit.undo', label: 'Undo', group: 'Edit', hint: 'Ctrl+Z', run: () => void undoLast() },
      { id: 'edit.redo', label: 'Redo', group: 'Edit', hint: 'Ctrl+Y', run: redoLast },
      { id: 'view.chat', label: 'Go to Chat', group: 'View', run: () => setTab('chat') },
      { id: 'view.tree', label: 'Go to Model tree', group: 'View', run: () => setTab('tree') },
      { id: 'view.params', label: 'Go to Parameters', group: 'View', run: () => setTab('params') },
      { id: 'view.health', label: 'Go to Health', group: 'View', run: () => setTab('health') },
      { id: 'mode.ask', label: 'Mode: Ask (read-only)', group: 'Mode', run: () => setMode('Ask') },
      { id: 'mode.edit', label: 'Mode: Edit', group: 'Mode', run: () => setMode('Edit') },
      { id: 'mode.build', label: 'Mode: Build', group: 'Mode', run: () => setMode('Build') },
    );

    if (doc) {
      const base = doc.title.replace(/\.[^.]+$/, '');
      list.push(
        {
          id: 'export.dxf',
          label: 'Export DXF',
          group: 'Export',
          run: () => download(`${base}.dxf`, toDxf(evaluate(doc)), 'application/dxf'),
        },
        {
          id: 'export.svg',
          label: 'Export SVG',
          group: 'Export',
          run: () => download(`${base}.svg`, toSvg(evaluate(doc)), 'image/svg+xml'),
        },
        {
          id: 'export.summary',
          label: 'Export manufacturing summary',
          group: 'Export',
          run: () => {
            const g = evaluate(doc);
            download(`${base}-summary.txt`, toManifest(doc, g, massGrams(doc, g)), 'text/plain');
          },
        },
      );
    }

    return list;
  }, [doc, addFeature, newDocument, saveDocument, undoLast, redoLast, setTab, setMode]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    // Subsequence match, so "adfil" finds "Add Fillet" the way a palette should.
    return commands.filter((c) => {
      const hay = `${c.group} ${c.label}`.toLowerCase();
      let i = 0;
      for (const ch of q) {
        i = hay.indexOf(ch, i);
        if (i < 0) return false;
        i += 1;
      }
      return true;
    });
  }, [commands, query]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Global shortcuts. Deliberately narrow: only the bindings the UX spec reserved.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);

      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
        return;
      }
      // Never hijack undo/save while someone is editing a name or a value.
      if (typing) return;

      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void undoLast();
      } else if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        redoLast();
      } else if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveDocument();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, undoLast, redoLast, saveDocument]);

  if (!open) return null;

  const runAt = (i: number) => {
    const cmd = filtered[i];
    if (!cmd) return;
    setOpen(false);
    setQuery('');
    cmd.run();
  };

  return (
    <div className="palette-scrim" onClick={() => setOpen(false)} role="presentation">
      <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="Type a command…"
          aria-label="Command"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              runAt(cursor);
            }
          }}
        />

        <div className="palette-list">
          {filtered.length === 0 ? (
            <div className="palette-empty">No command matches “{query}”.</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                className="palette-item"
                data-active={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onClick={() => runAt(i)}
              >
                <span className="palette-group">{c.group}</span>
                <span className="palette-label">{c.label}</span>
                {c.hint && <span className="palette-hint">{c.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { useModel } from '../modelStore';
import { KINDS } from './ModelTree';
import { download } from '../lib/exporters';
import { triCount } from '../engine';

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

  /*
   * Bound to the document the user is looking at.
   *
   * These commands - and Ctrl+Z, Ctrl+Y and Ctrl+S with them - drove the 2.5D `store`, which
   * standalone holds a sample bracket nobody opened. So the palette's Undo, the palette's Save
   * and the *keyboard shortcuts the toolbar advertises in its own tooltips* all ran against a
   * document that is not on screen: pressing Ctrl+Z on a plate left the plate exactly where it
   * was, with no error and nothing to suggest the keystroke had gone somewhere else.
   *
   * The view and mode commands still belong to `store`. They navigate the SOLIDWORKS-facing
   * surfaces, which is what that store is for.
   */
  const doc = useModel((s) => s.doc);
  const evaluated = useModel((s) => s.evaluated);
  const addFeature = useModel((s) => s.addFeature);
  const undo = useModel((s) => s.undo);
  const redo = useModel((s) => s.redo);
  const clear = useModel((s) => s.clear);
  const save = useModel((s) => s.save);
  const exportDrawing = useModel((s) => s.exportDrawing);
  const exportStl = useModel((s) => s.exportStl);
  const exportStep = useModel((s) => s.exportStep);

  const setTab = useStore((s) => s.setTab);
  const setMode = useStore((s) => s.setMode);

  const saveDocument = useCallback(() => {
    download(`${doc.name}.datum.json`, save(), 'application/json');
    useModel.setState({
      notice: {
        tone: 'info',
        text: `Saved ${doc.name}.datum.json - the feature tree, not the mesh, so it stays editable.`,
      },
    });
  }, [doc.name, save]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];

    for (const k of KINDS) {
      list.push({
        id: `add.${k.kind}`,
        label: `Add ${k.label}`,
        group: 'Model',
        run: () => addFeature(k.kind),
      });
    }

    list.push(
      { id: 'doc.new', label: 'New part', group: 'Document', run: clear },
      { id: 'doc.save', label: 'Save part', group: 'Document', hint: 'Ctrl+S', run: saveDocument },
      { id: 'edit.undo', label: 'Undo', group: 'Edit', hint: 'Ctrl+Z', run: undo },
      { id: 'edit.redo', label: 'Redo', group: 'Edit', hint: 'Ctrl+Y', run: redo },
      { id: 'view.chat', label: 'Go to Chat', group: 'View', run: () => setTab('chat') },
      { id: 'view.tree', label: 'Go to Model tree', group: 'View', run: () => setTab('tree') },
      { id: 'view.params', label: 'Go to Parameters', group: 'View', run: () => setTab('params') },
      { id: 'view.health', label: 'Go to Health', group: 'View', run: () => setTab('health') },
      { id: 'mode.ask', label: 'Mode: Ask (read-only)', group: 'Mode', run: () => setMode('Ask') },
      { id: 'mode.edit', label: 'Mode: Edit', group: 'Mode', run: () => setMode('Edit') },
      { id: 'mode.build', label: 'Mode: Build', group: 'Mode', run: () => setMode('Build') },
    );

    // Nothing modelled means nothing to export, and a command that can only fail is worse
    // than one that is not offered.
    if (triCount(evaluated.mesh) > 0) {
      const write = (out: { name: string; text: string } | null, mime: string) => {
        if (out) download(out.name, out.text, mime);
      };

      list.push(
        {
          id: 'export.svg',
          label: 'Export drawing as SVG',
          group: 'Export',
          run: () => write(exportDrawing('svg'), 'image/svg+xml'),
        },
        {
          id: 'export.dxf',
          label: 'Export drawing as DXF',
          group: 'Export',
          run: () => write(exportDrawing('dxf'), 'application/dxf'),
        },
        {
          id: 'export.step',
          label: 'Export STEP',
          group: 'Export',
          run: () => write(exportStep(), 'application/step'),
        },
        {
          id: 'export.stl',
          label: 'Export STL',
          group: 'Export',
          run: () => write(exportStl(), 'text/plain'),
        },
      );
    }

    return list;
  }, [evaluated, addFeature, clear, saveDocument, undo, redo,
      exportDrawing, exportStl, exportStep, setTab, setMode]);

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
        undo();
      } else if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        redo();
      } else if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveDocument();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, undo, redo, saveDocument]);

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

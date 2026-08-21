import { useCallback } from 'react';
import { useModel } from '../modelStore';
import { download } from '../lib/exporters';
import { triCount } from '../engine';

/**
 * The toolbar over the Studio viewport.
 *
 * It replaces one that was wired to the *other* document.
 *
 * Two modelling stacks grew up here: `lib/partModel`, a 2.5D profile-and-cuts model that the
 * original SOLIDWORKS-facing UI was written against, and `model/document`, the feature tree
 * the kernel actually evaluates. The tree, the parameters, the viewport and the assistant were
 * migrated to the second one; this toolbar was not. So its buttons sat directly above the 3D
 * view, looked live, and edited a document nothing on screen was showing — clicking "Hole
 * wizard" left the mesh, the mass, the triangle count and the feature tree all unchanged, with
 * no error to explain why.
 *
 * A control that does nothing is worse than a missing one. These act on the document in the
 * viewport, and features are added from the Model Explorer beside it, which is the same tree
 * the modeller uses. One document, one place to edit it.
 */
export function DocumentToolbar() {
  const doc = useModel((s) => s.doc);
  const evaluated = useModel((s) => s.evaluated);
  const undo = useModel((s) => s.undo);
  const redo = useModel((s) => s.redo);
  const undoDepth = useModel((s) => s.undoStack.length);
  const redoDepth = useModel((s) => s.redoStack.length);
  const exportDrawing = useModel((s) => s.exportDrawing);
  const exportStl = useModel((s) => s.exportStl);
  const exportStep = useModel((s) => s.exportStep);
  const save = useModel((s) => s.save);
  const clear = useModel((s) => s.clear);

  const hasModel = triCount(evaluated.mesh) > 0;

  const note = (tone: 'info' | 'warn' | 'error', text: string) =>
    useModel.setState({ notice: { tone, text } });

  const doExport = useCallback((what: 'svg' | 'dxf' | 'stl' | 'step' | 'json') => {
    if (what === 'json') {
      download(`${doc.name}.datum.json`, save(), 'application/json');
      note('info', `Saved ${doc.name}.datum.json — the feature tree, not the mesh, so it stays editable.`);
      return;
    }

    if (what === 'step') {
      const step = exportStep();
      if (!step) return;                       // the store has already said why
      download(step.name, step.text, 'application/step');
      note('info', `Exported ${step.name} — ${step.note}`);
      return;
    }

    const out = what === 'stl' ? exportStl() : exportDrawing(what);
    if (!out) return;                          // likewise

    download(out.name, out.text, what === 'svg' ? 'image/svg+xml' : 'text/plain');
    note('info', `Exported ${out.name}.`);
  }, [doc.name, exportDrawing, exportStl, exportStep, save]);

  return (
    <div className="toolbar" role="toolbar" aria-label="Document">
      <button className="tool" disabled={undoDepth === 0} title="Undo (Ctrl+Z)" onClick={undo}>
        <span className="tool-glyph" aria-hidden="true">↺</span>
        <span className="tool-label">Undo</span>
      </button>
      <button className="tool" disabled={redoDepth === 0} title="Redo (Ctrl+Y)" onClick={redo}>
        <span className="tool-glyph" aria-hidden="true">↻</span>
        <span className="tool-label">Redo</span>
      </button>

      <span className="toolbar-sep" />

      <button
        className="tool" disabled={!hasModel}
        title="Dimensioned drawing as SVG — standard views, hidden lines removed, ISO 2768-m"
        onClick={() => doExport('svg')}
      >
        <span className="tool-glyph" aria-hidden="true">▤</span>
        <span className="tool-label">Drawing SVG</span>
      </button>
      <button
        className="tool" disabled={!hasModel}
        title="Dimensioned drawing as DXF"
        onClick={() => doExport('dxf')}
      >
        <span className="tool-glyph" aria-hidden="true">⤓</span>
        <span className="tool-label">Drawing DXF</span>
      </button>
      <button
        className="tool" disabled={!hasModel}
        title="STEP AP214 — a real solid with faces and edges, for any CAD or CAM package"
        onClick={() => doExport('step')}
      >
        <span className="tool-glyph" aria-hidden="true">◈</span>
        <span className="tool-label">STEP</span>
      </button>
      <button
        className="tool" disabled={!hasModel}
        title="Mesh for 3D printing"
        onClick={() => doExport('stl')}
      >
        <span className="tool-glyph" aria-hidden="true">△</span>
        <span className="tool-label">STL</span>
      </button>

      <span className="toolbar-sep" />

      <button className="tool" title="Write the feature tree to a file" onClick={() => doExport('json')}>
        <span className="tool-glyph" aria-hidden="true">⌸</span>
        <span className="tool-label">Save file</span>
      </button>
      <button className="tool" title="Start a new part" onClick={clear}>
        <span className="tool-glyph" aria-hidden="true">✧</span>
        <span className="tool-label">New</span>
      </button>
    </div>
  );
}

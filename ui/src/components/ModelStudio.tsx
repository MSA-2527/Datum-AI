import { useCallback, useRef, useState } from 'react';
import { useModel } from '../modelStore';
import { ModelTree } from './ModelTree';
import { ModelViewport } from './ModelViewport';
import { Assistant } from './Assistant';
import { AiSettings } from './AiSettings';
import { LibraryDialog } from './LibraryDialog';
import { TrainingDialog } from './TrainingDialog';
import { RackPanel } from './RackPanel';
import { catalogue } from '../ai/decompose';
import { corpusSummary } from '../reference/audit';
import { FACTS, sources } from '../reference/standards';
import { providerInfo } from '../ai/providers';
import { triCount } from '../kernel/topo/mesh';
import { download } from '../lib/exporters';
import { LIMITS, type ProcessId } from '../lib/limits';

/**
 * The main workspace.
 *
 * Built directly on the modelling store rather than threading geometry through the legacy
 * chat pipeline, which was written against a document model that could not represent
 * anything the kernel produces.
 *
 * The layout is the one every CAD package converges on, and for good reasons rather than
 * imitation: the tree on the left because features are read top to bottom, the model filling
 * the middle because it is what the work is about, and the input at the bottom where the
 * hands already are.
 */

/**
 * Milling first, because it is what an unqualified request means — the same order the
 * planner brief uses, so the screen and the prompt read alike.
 */
const PROCESS_ORDER: ProcessId[] = ['mill', 'laser', 'sheet', 'additive', 'moulding'];

const PROCESS_TITLE: Record<ProcessId, string> = {
  mill: 'Machined',
  laser: 'Laser cut',
  sheet: 'Sheet metal',
  additive: '3D printed',
  moulding: 'Injection moulded',
};

const STARTERS = [
  'a car engine',
  'an anodizing rack',
  'a phone',
  'Create a model of a car',
  'make a cup',
];

export function ModelStudio() {
  const evaluated = useModel((s) => s.evaluated);
  const doc = useModel((s) => s.doc);
  const ai = useModel((s) => s.ai);
  const undo = useModel((s) => s.undo);
  const redo = useModel((s) => s.redo);
  const undoDepth = useModel((s) => s.undoStack.length);
  const redoDepth = useModel((s) => s.redoStack.length);
  const clear = useModel((s) => s.clear);
  const exportDrawing = useModel((s) => s.exportDrawing);
  const exportStl = useModel((s) => s.exportStl);
  const exportStep = useModel((s) => s.exportStep);
  const importImage = useModel((s) => s.importImage);
  const importDxf = useModel((s) => s.importDxf);
  const importStep = useModel((s) => s.importStep);
  const save = useModel((s) => s.save);
  const load = useModel((s) => s.load);
  const recogniseShape = useModel((s) => s.recogniseShape);
  const designRackForPart = useModel((s) => s.designRackForPart);
  const hasImported = useModel((s) => s.doc.features.some((f) => f.kind === 'imported'));

  const [showAi, setShowAi] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showTraining, setShowTraining] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);

  const note = useCallback((tone: 'info' | 'warn' | 'error', text: string) => {
    useModel.setState({ notice: { tone, text } });
  }, []);




  const onFile = useCallback(async (file: File) => {
    try {
      // A saved document is a feature tree, so it reopens editable rather than as a mesh.
      if (/\.json$/i.test(file.name)) {
        const ok = load(await file.text());
        note(ok ? 'info' : 'error',
          ok ? `Opened ${file.name}.` : 'That file is not a DATUM document.');
        return;
      }

      if (/\.dxf$/i.test(file.name)) {
        const text = await file.text();
        importDxf(text);
        return;
      }

      // A neutral solid, which is how an existing CAD library gets here.
      if (/\.(stp|step)$/i.test(file.name)) {
        importStep(await file.text());
        return;
      }

      // Raster: decode through a canvas, which is the only way to get pixels in a browser.
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        const canvas = document.createElement('canvas');
        // Cap the working size: tracing a 40-megapixel photo is slow and adds no detail
        // that survives simplification.
        const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('This browser could not decode the image.');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        // An image carries no size, so a width has to be assumed and then said out loud.
        const assumedWidthMm = 100;
        const r = importImage(
          { width: data.width, height: data.height, data: data.data },
          assumedWidthMm / data.width,
          6,
        );
        // Naming the feature the user has to click matters, because it is not always the
        // same one: a symmetric silhouette comes back as a revolve, not an extrusion.
        const built = useModel.getState().doc.features[0]?.name ?? 'the traced feature';
        note(r.ok ? 'info' : 'error',
          `${r.message} The picture was taken as ${assumedWidthMm} mm across — if that is ` +
          `wrong, click ${built} in the tree and set the size.`);
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      note('error', e instanceof Error ? e.message : 'That file could not be read.');
    }
  }, [importDxf, importImage, importStep, load, note]);

  const doExport = useCallback((what: 'svg' | 'dxf' | 'stl' | 'step' | 'json') => {
    if (what === 'json') {
      download(`${doc.name}.datum.json`, save(), 'application/json');
      note('info', `Saved ${doc.name}.datum.json — the feature tree, not the mesh, so it stays editable.`);
      return;
    }

    // STEP reports what it recovered, because the face count is the difference between a
    // solid another package can work on and one it can only look at.
    if (what === 'step') {
      const step = exportStep();
      if (!step) return;                       // the store has already said why
      download(step.name, step.text, 'application/step');
      note('info', `Exported ${step.name} — ${step.note}`);
      return;
    }

    const out = what === 'stl' ? exportStl() : exportDrawing(what);
    if (!out) {
      note('warn', 'There is nothing modelled to export yet.');
      return;
    }

    download(out.name, out.text, what === 'svg' ? 'image/svg+xml' : 'text/plain');
    note('info', `Exported ${out.name}.`);
  }, [doc.name, exportDrawing, exportStl, exportStep, save, note]);

  const hasModel = triCount(evaluated.mesh) > 0;


  return (
    <div className="ms">
      <aside className="ms-left">
        <div className="st-h">
          Model
          <span className="ms-doc">{doc.name}</span>
        </div>
        <ModelTree />
      </aside>

      <main className="ms-centre">
        <div className="ms-bar">
          <button onClick={undo} disabled={undoDepth === 0} title="Undo (Ctrl+Z)">↶ Undo</button>
          <button onClick={redo} disabled={redoDepth === 0} title="Redo (Ctrl+Y)">↷ Redo</button>
          <span className="ms-sep" />
          <button onClick={() => fileRef.current?.click()} title="Open a saved part or a STEP solid, trace an image, or rebuild a DXF drawing">
            Open / Import…
          </button>
          <button
            onClick={() => imageRef.current?.click()}
            title="Photograph or screenshot of a part — traced to a profile, then revolved if it is a turned part or extruded if it is flat"
          >
            Image → 3D…
          </button>
          <button onClick={() => doExport('svg')} disabled={!hasModel} title="Dimensioned drawing as SVG">Drawing SVG</button>
          <button onClick={() => doExport('dxf')} disabled={!hasModel} title="Dimensioned drawing as DXF">Drawing DXF</button>
          <button
            onClick={() => doExport('step')}
            disabled={!hasModel}
            title="STEP AP214 — a real solid with faces and edges, for any CAD or CAM package"
          >
            STEP
          </button>
          <button onClick={() => doExport('stl')} disabled={!hasModel} title="Mesh for 3D printing">STL</button>
          <button onClick={() => doExport('json')} title="Write the feature tree to a file">Save file</button>
          <button
            onClick={() => setShowLibrary(true)}
            title="Save this part where DATUM can find it again, or open one you saved earlier"
          >
            Library…
          </button>
          <button
            onClick={() => setShowTraining(true)}
            title="Teach the planner from your own parts, so it builds in your conventions"
          >
            Teach…
          </button>
          {/*
            Only offered when there is something to recognise. An imported solid is a mesh with
            no recipe behind it: recovering the archetype makes it parametric, editable and
            teachable at once, which is what turns an imported library into training material.
          */}
          {hasImported && (
            <button
              onClick={recogniseShape}
              title="Read an imported solid back into the catalogue, so it becomes parametric and teachable"
            >
              Recognise
            </button>
          )}
          <span className="ms-sep" />
          <button
            onClick={() => designRackForPart()}
            disabled={!hasModel}
            title="Size an anodizing rack from this part — area, current, section, cooling and contacts"
          >
            Rack for this
          </button>
          <span className="ms-sep" />
          <button onClick={clear} title="Start a new part">New</button>
          <span className="ms-sep" />
          <button
            onClick={() => setShowAi(true)}
            title="Choose an optional language model"
            data-active={ai.id !== 'none' ? 'true' : undefined}
          >
            AI: {ai.id === 'none' ? 'off' : providerInfo(ai.id).label.split(' ')[0]}
          </button>

          {/*
            A second input, images only, so the picker opens on photographs rather than on a
            folder of STEP files. "Open / Import…" already accepted images; nobody found it,
            because nothing in the word "import" suggests you can photograph a part.
          */}
          <input
            ref={imageRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
              e.target.value = '';
            }}
          />

          <input
            ref={fileRef}
            type="file"
            accept=".dxf,.stp,.step,.json,image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
              e.target.value = '';
            }}
          />
        </div>

        <ModelViewport />
      </main>

      <aside className="ms-right">
        <div className="st-h">Assistant</div>
        <Assistant starters={STARTERS} />

        <RackPanel />

        <details className="ms-catalogue">
          <summary>What it can build offline</summary>
          <div>
            <strong>Assemblies</strong>
            <ul>{catalogue().assemblies.map((a) => <li key={a}>{a}</li>)}</ul>
            <strong>Single parts</strong>
            <p>{catalogue().parts.join(' \u00b7 ')}</p>

            {/*
              The rules the planner is told about before it designs anything.

              Shown for the same reason every DFM finding cites its rule: a limit the product
              enforces but will not show you is a limit you cannot design around. These are
              also exactly what goes into the prompt — same list, same numbers, one source —
              so what is on screen is what the model was told.
            */}
            <strong>Rules it designs to</strong>
            <ul className="ms-limits">
              {PROCESS_ORDER.map((process) => {
                const rules = LIMITS.filter((l) => l.brief && l.process === process);
                if (rules.length === 0) return null;
                return (
                  <li key={process}>
                    <em>{PROCESS_TITLE[process]}</em>
                    <ul>
                      {rules.map((l) => (
                        <li key={l.rule} title={`${l.basis}\n\nReported as ${l.rule}`}>
                          {l.requirement}
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
            <p className="ai-note">
              Checked again after the part is built, and a breach is reported with the rule
              that caught it.
            </p>

            <strong>Reference dimensions</strong>
            <p>
              {FACTS.length} published figures, used to size components and to check what a
              model proposes: {corpusSummary().map((c) => `${c.count} ${c.category}`).join(', ')}.
            </p>
            <p className="ai-note">From {sources().slice(0, 8).join(', ')} and others.</p>

            {ai.id === 'none' && (
              <p className="ai-note">
                Anything else needs a model — turn one on with the AI button.
              </p>
            )}
          </div>
        </details>
      </aside>

      {showAi && <AiSettings onClose={() => setShowAi(false)} />}
      {showLibrary && <LibraryDialog onClose={() => setShowLibrary(false)} />}
      {showTraining && <TrainingDialog onClose={() => setShowTraining(false)} />}
    </div>
  );
}

/**
 * Maps face ids to the *name* of their feature rather than its id.
 *
 * The viewport shows this on hover, and "Body" is useful where "f7" is not.
 */

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That image could not be decoded.'));
    img.src = url;
  });
}

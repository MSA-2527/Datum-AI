import { create } from 'zustand';
import {
  addFeature, defaultParams, deleteFeature, deserialise, emptyDocument, evaluateDocument,
  moveFeature, placeFeature, renameFeature, serialise, setSuppressed, updateFeature,
  type Document, type DocumentMate, type EvaluatedDocument, type Feature, type FeatureKind,
  type ParamValue, type Placement,
} from './model/document';
import { archetypeById } from './generate/archetypes';
import { decompose } from './ai/decompose';
import { generateFromText } from './generate/parse';
import { matchRecipe } from './assembly/recipes';
import {
  applyAnswers, clarify, describeAnswers, type Clarification,
} from './ai/clarify';
import { loadConfig, saveConfig, type ProviderConfig } from './ai/providers';
import { billOfMaterials, type AssemblyPlan, type BomLine } from './assembly/plan';
import { traceImage, type RasterImage } from './ingest/image/trace';
import { readDxf } from './ingest/drawing/dxf';
import { importDrawing } from './ingest/drawing/reconstruct';
import { makeDrawing, drawingToDxf, drawingToSvg } from './drafting/sheet';
import { bounds, massProperties, triCount } from './kernel/topo/mesh';
import { meshToStep, stepFileName } from './export/step';
import {
  findDocumentClashes, newMateId, solveDocumentMates,
  type ClashReport, type MateSolve,
} from './model/assembly';
import { type MateKind } from './kernel/assembly/assembly';
import { Evaluator } from './model/evaluator';

/**
 * The modelling store.
 *
 * Deliberately separate from the legacy `store.ts`, which owns the chat transcript, provider
 * routing and the SOLIDWORKS connection. That store was built around a 2.5D document that
 * could not represent anything the kernel produces, and threading real geometry through it
 * would have meant rewriting it while it was load-bearing.
 *
 * The rule here is the one that makes a parametric modeller work: **the feature tree is the
 * document; the mesh is a derivation.** Every mutation goes through the tree and triggers a
 * rebuild. Nothing writes to the mesh directly, because geometry that can be edited outside
 * the tree is geometry the tree can no longer reproduce.
 */

export interface HistoryEntry {
  doc: Document;
  label: string;
}

interface ModelState {
  doc: Document;
  evaluated: EvaluatedDocument;

  /** Feature selected in the tree or picked in the viewport. */
  selectedFeatureId: string | null;
  /** Faces picked in the viewport, for scoping a fillet or chamfer to them. */
  selectedFaces: number[];
  /** Feature open in the parameter editor. */
  editingFeatureId: string | null;

  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];

  /** True while a rebuild is running, so the UI can show it rather than appearing frozen. */
  building: boolean;
  /** Last thing that happened, for the status line. */
  notice: { tone: 'info' | 'warn' | 'error'; text: string } | null;

  /** Optional language model. 'none' means the deterministic path only. */
  ai: ProviderConfig;
  /** The assembly plan behind the current document, when it came from one. */
  plan: AssemblyPlan | null;

  /**
   * Questions waiting to be answered before a part is built.
   *
   * A request that names a whole family of parts — "an anodizing rack" — is answered with a
   * short conversation rather than a guess or a refusal. Held here rather than in the chat
   * component so that answering survives a re-render and can be driven from a test.
   */
  pending: { request: string; clarification: Clarification; answers: Record<string, number> } | null;

  // ── mutations ──
  commit: (doc: Document, label: string) => void;
  /** Schedules a background rebuild. The result arrives asynchronously. */
  rebuild: (doc: Document) => void;
  undo: () => void;
  redo: () => void;

  select: (id: string | null) => void;
  edit: (id: string | null) => void;
  /** Adds or removes a face from the picked set. */
  toggleFace: (faceId: number, additive: boolean) => void;
  clearFaces: () => void;
  /** Applies the picked faces to the feature being edited, when it takes them. */
  applyFacesToFeature: () => void;

  addFeature: (kind: FeatureKind) => void;
  setParams: (id: string, params: Record<string, ParamValue>) => void;
  rename: (id: string, name: string) => void;
  /** Moves or turns a part. Absolute, in millimetres and degrees. */
  place: (id: string, delta: Partial<Placement>) => void;
  remove: (id: string) => void;
  toggleSuppressed: (id: string) => void;
  move: (id: string, delta: number) => void;

  setMaterial: (material: string, density: number) => void;
  clear: () => void;

  setAi: (config: ProviderConfig) => void;

  // ── generation and import ──
  /**
   * Turns a request into geometry.
   *
   * Replaces the older single-shape `generate`: this tries a built-in assembly recipe first,
   * then the single-part catalogue, and only reaches for a model when neither matched. One
   * entry point, so a caller never has to know which route was taken.
   */
  build: (prompt: string) => Promise<{ ok: boolean; message: string }>;
  /** Records an answer to one of the pending questions. */
  answer: (key: string, choiceIndex: number) => void;
  /** Builds from the answers given so far, defaults filling the rest. */
  buildAnswered: () => Promise<{ ok: boolean; message: string }>;
  /** Abandons the questions without building. */
  cancelPending: () => void;
  bom: () => BomLine[];
  importImage: (image: RasterImage, mmPerPixel: number, thickness: number) => { ok: boolean; message: string };
  importDxf: (text: string) => { ok: boolean; message: string };

  /**
   * Edits a driving dimension.
   *
   * The single action that makes a generated model a design: everything written in terms of
   * this parameter moves or resizes when it changes.
   */
  setParameter: (name: string, value: number | string) => void;
  renameParameter: (from: string, to: string) => void;
  addParameter: () => void;
  removeParameter: (name: string) => void;

  // ── assembly ──
  /**
   * Relates two components, then solves and applies the result.
   *
   * Mates drive placements rather than replacing them: solving writes solved positions into
   * the features' own placements, so the tree stays an ordinary tree that saves and rebuilds
   * like any other. A solve that conflicts is reported and *not* applied — a broken
   * relationship must never silently rearrange somebody's model.
   */
  addMate: (kind: MateKind, a: string, b: string, value?: number) => { ok: boolean; message: string };
  removeMate: (id: string) => void;
  /** Re-solves the existing mates and moves components to match. */
  resolveMates: () => { ok: boolean; message: string };
  /** Components sharing space. */
  clashes: () => ClashReport;

  // ── export ──
  exportDrawing: (format: 'svg' | 'dxf') => { name: string; text: string } | null;
  exportStl: () => { name: string; text: string } | null;
  /**
   * STEP AP214 — the solid, as faces and edges rather than triangles.
   *
   * The one export that lets the work continue somewhere else: an STL cannot be opened as an
   * editable solid and no shop quotes milling from one.
   */
  exportStep: () => { name: string; text: string; note: string } | null;
  save: () => string;
  load: (text: string) => boolean;
}

const HISTORY_LIMIT = 60;

const initialDoc = emptyDocument();

/**
 * Applies a finished evaluation to the store.
 *
 * Kept separate from `commit` because the two now happen at different times: the document
 * changes immediately so the tree and the editor stay responsive, and the geometry catches up
 * when the worker replies. Until it does, the previous mesh stays on screen — which is what
 * every CAD package does and is far better than blanking the viewport mid-edit.
 */
function noticeFor(doc: Document, evaluated: EvaluatedDocument): ModelState['notice'] {
  if (evaluated.errors.size > 0) {
    const [id, message] = [...evaluated.errors.entries()][0];
    const feature = doc.features.find((f) => f.id === id);
    return { tone: 'error', text: `${feature?.name ?? 'A feature'}: ${message}` };
  }
  if (evaluated.warnings.size > 0) {
    const [id, message] = [...evaluated.warnings.entries()][0];
    const feature = doc.features.find((f) => f.id === id);
    return { tone: 'warn', text: `${feature?.name ?? 'A feature'}: ${message}` };
  }
  if (triCount(evaluated.mesh) > 0 && !evaluated.health.closed) {
    return {
      tone: 'warn',
      text:
        `The solid is not closed (${evaluated.health.boundaryEdges} open edges). ` +
        `Its volume and mass cannot be trusted until that is fixed.`,
    };
  }
  return null;
}

/**
 * Writes solved component positions back into the tree.
 *
 * Rotation is left alone. The solver returns an orientation as well, but the modeller's
 * placements carry Euler angles and every component the assistant produces is axis-aligned;
 * converting a quaternion back to Euler here would introduce a representation change that
 * shows up as a part quietly rotating on a solve that was only meant to move it.
 */
function applySolvedPositions(doc: Document, solved: MateSolve): Document {
  if (solved.positions.size === 0) return doc;

  return {
    ...doc,
    features: doc.features.map((f) => {
      const at = solved.positions.get(f.id);
      if (!at) return f;

      const p = f.placement ?? { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
      if (p.x === at[0] && p.y === at[1] && p.z === at[2]) return f;
      return { ...f, placement: { ...p, x: at[0], y: at[1], z: at[2] } };
    }),
  };
}

/** Grams, kilograms or tonnes, whichever reads naturally at that magnitude. */
function formatGrams(g: number): string {
  if (g >= 1e6) return `${(g / 1e6).toFixed(2)} t`;
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg`;
  return `${g.toFixed(1)} g`;
}

let evaluator: Evaluator | null = null;

export const useModel = create<ModelState>((set, get) => ({
  doc: initialDoc,
  evaluated: evaluateDocument(initialDoc),
  selectedFeatureId: null,
  selectedFaces: [],
  pending: null,
  editingFeatureId: null,
  undoStack: [],
  redoStack: [],
  building: false,
  notice: null,
  ai: loadConfig(),
  plan: null,

  commit(doc, label) {
    const previous = get().doc;

    // The document is applied at once and the geometry follows. Waiting for the rebuild
    // before updating the tree would make every edit feel laggy for no benefit — the feature
    // list, the parameter values and the undo stack are all knowable immediately.
    set({
      doc,
      building: true,
      undoStack: [...get().undoStack, { doc: previous, label }].slice(-HISTORY_LIMIT),
      redoStack: [],
    });

    get().rebuild(doc);
  },

  rebuild(doc) {
    if (!evaluator) {
      evaluator = new Evaluator({
        onResult: (evaluated) => {
          // A geometry problem replaces whatever was on screen, because it is the more
          // urgent thing to say. A clean rebuild leaves the existing message alone — it is
          // usually the summary of what was just built, and blanking it the moment the
          // worker replies would make that message flash and vanish.
          const problem = noticeFor(get().doc, evaluated);
          set(problem ? { evaluated, notice: problem } : { evaluated });
        },
        onError: (message) => set({ notice: { tone: 'error', text: message }, building: false }),
        onBusy: (busy) => set({ building: busy }),
      });
    }
    evaluator.evaluate(doc);
  },

  undo() {
    const { undoStack, doc } = get();
    const last = undoStack[undoStack.length - 1];
    if (!last) return;

    set({
      doc: last.doc,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...get().redoStack, { doc, label: last.label }],
      notice: { tone: 'info', text: `Undid ${last.label}.` },
    });
    get().rebuild(last.doc);
  },

  redo() {
    const { redoStack, doc } = get();
    const next = redoStack[redoStack.length - 1];
    if (!next) return;

    set({
      doc: next.doc,
      redoStack: redoStack.slice(0, -1),
      undoStack: [...get().undoStack, { doc, label: next.label }],
      notice: { tone: 'info', text: `Redid ${next.label}.` },
    });
    get().rebuild(next.doc);
  },

  select(id) {
    set({ selectedFeatureId: id });
    // Selecting in the viewport should open the same feature the tree would, so the two
    // never disagree about what is being worked on.
    if (id) set({ editingFeatureId: id });
  },

  edit(id) {
    set({ editingFeatureId: id, selectedFeatureId: id });
  },

  toggleFace(faceId, additive) {
    const current = get().selectedFaces;

    // A click on empty space is a clear, not a pick of face −1.
    if (faceId < 0) {
      if (current.length > 0) set({ selectedFaces: [] });
      return;
    }

    if (!additive) {
      set({ selectedFaces: current.includes(faceId) && current.length === 1 ? [] : [faceId] });
      return;
    }
    set({
      selectedFaces: current.includes(faceId)
        ? current.filter((f) => f !== faceId)
        : [...current, faceId],
    });
  },

  clearFaces() {
    set({ selectedFaces: [] });
  },

  /**
   * Hands the picked faces to the feature being edited.
   *
   * Only fillet and chamfer take them. Anything else silently ignoring a selection would be
   * worse than refusing it, so the caller is told when nothing happened.
   */
  applyFacesToFeature() {
    const { editingFeatureId, selectedFaces, doc } = get();
    const feature = doc.features.find((f) => f.id === editingFeatureId);

    if (!feature || (feature.kind !== 'fillet' && feature.kind !== 'chamfer')) {
      set({
        notice: {
          tone: 'warn',
          text: 'Select a fillet or chamfer feature first — those are the ones that take a face selection.',
        },
      });
      return;
    }

    get().setParams(feature.id, { faces: [...selectedFaces] });
    set({
      notice: {
        tone: 'info',
        text: selectedFaces.length === 0
          ? `${feature.name} now applies to every edge on the body.`
          : `${feature.name} now applies to ${selectedFaces.length} selected face${selectedFaces.length === 1 ? '' : 's'}.`,
      },
    });
  },

  addFeature(kind) {
    const doc = addFeature(get().doc, kind, defaultParams(kind));
    const added = doc.features[doc.features.length - 1];
    get().commit(doc, `add ${added.name}`);
    set({ selectedFeatureId: added.id, editingFeatureId: added.id });
  },

  setParams(id, params) {
    const doc = updateFeature(get().doc, id, params);
    const feature = doc.features.find((f) => f.id === id);
    get().commit(doc, `edit ${feature?.name ?? 'feature'}`);
  },

  place(id, delta) {
    const feature = get().doc.features.find((f) => f.id === id);
    if (!feature) return;

    // Coalesced into one undo entry per axis, the way a slider drag already is: dragging a
    // part twenty millimetres should be one step back, not twenty.
    const axis = Object.keys(delta)[0] ?? 'position';
    get().commit(placeFeature(get().doc, id, delta), `move ${feature.name} ${axis}`);
  },

  rename(id, name) {
    get().commit(renameFeature(get().doc, id, name), 'rename');
  },

  remove(id) {
    const feature = get().doc.features.find((f) => f.id === id);
    get().commit(deleteFeature(get().doc, id), `delete ${feature?.name ?? 'feature'}`);
    if (get().selectedFeatureId === id) set({ selectedFeatureId: null, editingFeatureId: null });
  },

  toggleSuppressed(id) {
    const feature = get().doc.features.find((f) => f.id === id);
    if (!feature) return;
    get().commit(
      setSuppressed(get().doc, id, !feature.suppressed),
      `${feature.suppressed ? 'unsuppress' : 'suppress'} ${feature.name}`,
    );
  },

  move(id, delta) {
    const feature = get().doc.features.find((f) => f.id === id);
    get().commit(moveFeature(get().doc, id, delta), `reorder ${feature?.name ?? 'feature'}`);
  },

  setMaterial(material, density) {
    get().commit({ ...get().doc, material, density }, 'change material');
  },

  setAi(config) {
    saveConfig(config);
    set({ ai: config });
  },

  /**
   * Decomposes a request and replaces the model with the result.
   *
   * This is the path that handles assemblies. It tries the built-in recipes first, then the
   * single-part catalogue, and only reaches for a model when neither matched — so the common
   * cases stay offline and instant, and a model is spent on the requests that need one.
   */
  async build(prompt) {
    set({ building: true, pending: null });
    try {
      // Only parts that are made to fit something else are worth asking about, and only when
      // the request did not already say. "Make a cup 90 mm tall" has been specified; asking
      // about it would be an obstacle, and an early version that asked every time broke a
      // dozen tests by refusing to build anything without a dialogue first.
      const single = generateFromText(prompt);
      const asks = single.ok
        && single.archetype.asksFirst
        && single.parsed.understood.length === 0;

      if (asks && !matchRecipe(prompt)) {
        const clarification = await clarify(single.archetype.id, prompt, { config: get().ai });

        if (clarification && clarification.questions.length > 0) {
          set({
            pending: { request: prompt, clarification, answers: {} },
            building: false,
            notice: { tone: 'info', text: clarification.reading },
          });

          const asked = clarification.questions.length;
          return {
            ok: true,
            message:
              `${clarification.reading} Before building, ${asked} question${asked === 1 ? '' : 's'} ` +
              `— every one has a default, so you can answer none of them and press Build.` +
              (clarification.researchNote ? ` ${clarification.researchNote}` : '') +
              (clarification.citations.length > 0
                ? ` Researched from ${clarification.citations.length} source${clarification.citations.length === 1 ? '' : 's'}.`
                : ''),
          };
        }
      }

      const result = await decompose(prompt, { config: get().ai });

      if (!result.ok) {
        const message = result.message;
        set({ notice: { tone: 'warn', text: message }, building: false });
        return { ok: false, message };
      }

      get().commit(result.doc, `build ${result.doc.name}`);
      set({
        plan: result.plan,
        selectedFeatureId: result.doc.features[0]?.id ?? null,
        editingFeatureId: result.doc.features[0]?.id ?? null,
      });

      // Corrections are surfaced, never swallowed. A dimension quietly clamped is a part
      // that is not what the user asked for and does not say so.
      const extra = result.corrections.length > 0
        ? ` Adjusted: ${result.corrections.slice(0, 3).join(' ')}`
        : '';

      const message = `${result.message}${extra}`;
      set({ notice: { tone: result.corrections.length > 0 ? 'warn' : 'info', text: message } });
      return { ok: true, message };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'That could not be built.';
      set({ notice: { tone: 'error', text: message }, building: false });
      return { ok: false, message };
    }
    // `building` is deliberately not cleared here. The rebuild `commit` scheduled is still
    // running in the worker, and the evaluator owns that flag; clearing it now would show
    // the model as finished while the geometry was still being computed.
  },

  answer(key, choiceIndex) {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: { ...pending, answers: { ...pending.answers, [key]: choiceIndex } } });
  },

  cancelPending() {
    set({ pending: null, notice: { tone: 'info', text: 'Left it unbuilt.' } });
  },

  async buildAnswered() {
    const pending = get().pending;
    if (!pending) return { ok: false, message: 'There is nothing waiting to be built.' };

    const { clarification, answers } = pending;
    const params: Record<string, ParamValue> = {
      archetypeId: clarification.archetype.id,
      ...applyAnswers(clarification, answers),
    };

    set({ building: true });
    try {
      const doc = addFeature(
        emptyDocument(clarification.archetype.label),
        'archetype', params, clarification.archetype.label,
      );

      const withMaterial = clarification.archetype.material
        ? {
            ...doc,
            material: clarification.archetype.material.name,
            density: clarification.archetype.material.density,
          }
        : doc;

      get().commit(withMaterial, `build ${clarification.archetype.label}`);

      const first = withMaterial.features[0]?.id ?? null;
      set({
        pending: null,
        plan: null,
        selectedFeatureId: first,
        editingFeatureId: first,
      });

      const summary = describeAnswers(clarification, answers);
      const built = clarification.archetype.build(
        applyAnswers(clarification, answers),
      );

      const message = [
        `Built a ${clarification.archetype.label.toLowerCase()}.`,
        summary,
        ...built.warnings.slice(0, 2),
      ].filter(Boolean).join(' ');

      set({ notice: { tone: 'info', text: message } });
      return { ok: true, message };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'That could not be built.';
      set({ notice: { tone: 'error', text: message }, pending: null });
      return { ok: false, message };
    } finally {
      set({ building: false });
    }
  },

  bom() {
    const plan = get().plan;
    return plan ? billOfMaterials(plan) : [];
  },

  clear() {
    const doc = emptyDocument();
    set({
      doc,
      selectedFeatureId: null,
      editingFeatureId: null,
      undoStack: [],
      redoStack: [],
      notice: null,
      plan: null,
    });
    get().rebuild(doc);
  },

  importImage(image, mmPerPixel, thickness) {
    const traced = traceImage(image, { mmPerPixel });
    if ('error' in traced) {
      set({ notice: { tone: 'error', text: traced.error } });
      return { ok: false, message: traced.error };
    }

    // Extrude here rather than storing a mesh, so the thickness stays editable.
    const points: number[] = [];
    for (const [x, y] of traced.profile.outer) points.push(x, y);

    // Holes come through too. The tracer has always found them — a washer traces as two
    // contours — and they were being dropped on the way to the extrusion, so every part
    // imported from a picture came out solid. A traced flange with a bolt circle is a very
    // different object from a disc.
    const holePoints: number[] = [];
    const holeLengths: number[] = [];
    for (const hole of traced.profile.holes) {
      holeLengths.push(hole.length);
      for (const [x, y] of hole) holePoints.push(x, y);
    }

    const base = emptyDocument('Traced part');
    const doc = addFeature(base, 'extrude', {
      plane: 'XY', shape: 'points', points, holePoints, holeLengths,
      distance: thickness, operation: 'add',
      // The width the points were traced at, and the width in force. They start equal; editing
      // the second rescales the outline about its own centre. A picture carries no scale, so
      // without these the assumed one was permanent.
      tracedWidth: traced.report.widthMm,
      width: traced.report.widthMm,
    }, 'Traced outline');

    get().commit(doc, 'trace image');

    const message =
      `Traced ${traced.report.widthMm.toFixed(1)} x ${traced.report.heightMm.toFixed(1)} mm: ` +
      `${traced.report.linesRecognised} straight edges, ${traced.report.arcsRecognised} arcs, ` +
      `${traced.report.holesFound} hole${traced.report.holesFound === 1 ? '' : 's'}.`;

    set({ notice: { tone: 'info', text: message } });
    return { ok: true, message };
  },

  importDxf(text) {
    const parsed = readDxf(text);
    if ('error' in parsed) {
      set({ notice: { tone: 'error', text: parsed.error } });
      return { ok: false, message: parsed.error };
    }

    const built = importDrawing(parsed);
    if (!built.valid || triCount(built.mesh) === 0) {
      const message = built.caveats[0] ?? 'The drawing could not be rebuilt into a solid.';
      set({ notice: { tone: 'error', text: message } });
      return { ok: false, message };
    }

    const base = emptyDocument('From drawing');
    const doc = addFeature(base, 'imported', { __mesh: built.mesh as unknown as ParamValue, operation: 'add' }, 'Reconstructed solid');
    get().commit(doc, 'import drawing');

    // Lead with what was built, then the caveats.
    //
    // This used to open with "Rebuilt from 1 views" and go straight into what was unknown,
    // rendered amber. Users read it as a failure — reasonably, since it looked like an error
    // and named a missing input in its first clause. It is a success with a stated
    // assumption, and it now says the size and mass first so that is obvious.
    const b = bounds(built.mesh);
    const size = [0, 1, 2].map((i) => (b.max[i] - b.min[i]).toFixed(1)).join(' × ');
    const viewCount = built.views.filter((v) => v.role !== 'unknown').length;
    const grams = (Math.abs(massProperties(built.mesh).volume) / 1000) * base.density;

    const message =
      `Built a solid ${size} mm, ${formatGrams(grams)}, from ` +
      `${viewCount} view${viewCount === 1 ? '' : 's'}. ` +
      built.caveats.join(' ');

    // Amber only when something is genuinely unresolved. A thickness the drawing stated is
    // not a caveat, and colouring it as one trains users to ignore the colour.
    const guessed = built.caveats.some((c) => /assumed|implies|is a guess/.test(c));
    set({ notice: { tone: guessed ? 'warn' : 'info', text: message } });
    return { ok: true, message };
  },

  exportDrawing(format) {
    const { doc, evaluated } = get();
    if (triCount(evaluated.mesh) === 0) {
      set({ notice: { tone: 'warn', text: 'There is nothing modelled to draw.' } });
      return null;
    }

    const drawing = makeDrawing(evaluated.mesh, {
      density: doc.density,
      titleBlock: {
        partNumber: doc.name.toUpperCase().replace(/\s+/g, '-'),
        description: doc.name,
        material: doc.material,
      },
    });

    return format === 'svg'
      ? { name: `${doc.name}.svg`, text: drawingToSvg(drawing) }
      : { name: `${doc.name}.dxf`, text: drawingToDxf(drawing) };
  },

  /**
   * STL export.
   *
   * ASCII rather than binary: it is larger, but every slicer and printer reads it, and a
   * malformed binary header fails in ways that are very hard for a user to diagnose.
   */
  setParameter(name, value) {
    const doc = get().doc;
    const globals = doc.globals.map((g) => (g.name === name ? { ...g, value } : g));
    get().commit({ ...doc, globals }, `set ${name}`);
  },

  renameParameter(from, to) {
    const clean = to.trim();
    const doc = get().doc;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(clean)) {
      set({ notice: { tone: 'warn', text:
        'A parameter name must start with a letter and contain only letters, digits and underscores.' } });
      return;
    }
    if (doc.globals.some((g) => g.name === clean)) {
      set({ notice: { tone: 'warn', text: `There is already a parameter called ${clean}.` } });
      return;
    }

    // Expressions refer to parameters by name, so a rename has to rewrite every reference or
    // the model breaks the moment the name changes. Whole-word only: renaming `bore` must not
    // corrupt `boreDepth`.
    const pattern = new RegExp(`\b${from}\b`, 'g');
    const rewrite = (v: unknown) =>
      typeof v === 'string' ? v.replace(pattern, clean) : v;

    get().commit({
      ...doc,
      globals: doc.globals.map((g) =>
        g.name === from ? { ...g, name: clean, value: rewrite(g.value) as number | string }
                        : { ...g, value: rewrite(g.value) as number | string }),
      features: doc.features.map((f) => ({
        ...f,
        params: Object.fromEntries(
          Object.entries(f.params).map(([k, v]) => [k, rewrite(v) as ParamValue])),
        placementExpr: f.placementExpr
          ? Object.fromEntries(
              Object.entries(f.placementExpr).map(([k, v]) => [k, rewrite(v) as string]))
          : undefined,
      })),
    }, `rename ${from}`);
  },

  addParameter() {
    const doc = get().doc;
    let n = doc.globals.length + 1;
    while (doc.globals.some((g) => g.name === `param${n}`)) n++;
    get().commit(
      { ...doc, globals: [...doc.globals, { name: `param${n}`, value: 10, units: 'mm' }] },
      'add parameter');
  },

  removeParameter(name) {
    const doc = get().doc;
    get().commit({ ...doc, globals: doc.globals.filter((g) => g.name !== name) }, `remove ${name}`);
  },

  addMate(kind, a, b, value) {
    const doc = get().doc;
    if (a === b) return { ok: false, message: 'A component cannot be mated to itself.' };

    const mate: DocumentMate = {
      id: newMateId(),
      kind,
      // Both refs use the component's own origin and Z axis. That is the honest subset: the
      // viewport picks features, not faces on them, so offering a mate to "that bore" would
      // be a control with nothing behind it.
      a: { feature: a, point: [0, 0, 0], direction: [0, 0, 1] },
      b: { feature: b, point: [0, 0, 0], direction: [0, 0, 1] },
      value,
    };

    const mates = [...(doc.mates ?? []), mate];
    const solved = solveDocumentMates(doc, mates);

    if (solved.result.status === 'conflict') {
      const message = `That mate conflicts with the ones already there, so it was not added.`;
      set({ notice: { tone: 'warn', text: message } });
      return { ok: false, message };
    }

    get().commit(applySolvedPositions({ ...doc, mates }, solved), `mate ${kind}`);
    set({ notice: { tone: 'info', text: `Mated: ${solved.summary}` } });
    return { ok: true, message: solved.summary };
  },

  removeMate(id) {
    const doc = get().doc;
    const mates = (doc.mates ?? []).filter((m) => m.id !== id);
    const solved = solveDocumentMates(doc, mates);
    get().commit(applySolvedPositions({ ...doc, mates }, solved), 'remove mate');
  },

  resolveMates() {
    const doc = get().doc;
    const mates = doc.mates ?? [];
    if (mates.length === 0) return { ok: true, message: 'No mates to solve.' };

    const solved = solveDocumentMates(doc, mates);
    if (solved.result.status === 'conflict') {
      set({ notice: { tone: 'warn', text: solved.summary } });
      return { ok: false, message: solved.summary };
    }

    get().commit(applySolvedPositions(doc, solved), 'solve mates');
    set({ notice: { tone: 'info', text: solved.summary } });
    return { ok: true, message: solved.summary };
  },

  clashes() {
    return findDocumentClashes(get().doc);
  },

  exportStep() {
    const { doc, evaluated } = get();
    const mesh = evaluated.mesh;
    if (triCount(mesh) === 0) {
      set({ notice: { tone: 'warn', text: 'There is nothing modelled to export.' } });
      return null;
    }

    const { text, report } = meshToStep(mesh, {
      name: doc.name,
      author: 'DATUM',
      description:
        `${doc.name} — ${doc.material}. B-rep recovered from a tessellated solid; ` +
        `planes and cylinders are analytic, other curved surfaces are faceted.`,
    });

    // Worth saying out loud, because these numbers are the point: the receiving package sees
    // this many selectable faces, not one per triangle, and every recovered cylinder is a
    // hole or a shaft it can measure rather than a ring of strips it cannot.
    const parts: string[] = [];
    if (report.cylindersFound > 0) {
      parts.push(`${report.cylindersFound} cylindrical`);
    }
    if (report.conesFound > 0) {
      parts.push(`${report.conesFound} conical`);
    }
    const cylinders = parts.length > 0
      ? `, including ${parts.join(' and ')} surface` +
        `${report.cylindersFound + report.conesFound === 1 ? '' : 's'} recovered from ` +
        `${report.facetsReplaced} facets`
      : '';

    const trouble = report.nonConformalEdges > 0 || report.unclosedRegions > 0
      ? `. The shell may not knit — ${report.nonConformalEdges} edge` +
        `${report.nonConformalEdges === 1 ? '' : 's'} are not shared by exactly two faces. ` +
        `Check the solid is closed first.`
      : '.';

    const note = `${report.facesOut} faces from ${report.trianglesIn} triangles${cylinders}${trouble}`;

    const shaky = report.nonConformalEdges > 0 || report.unclosedRegions > 0;
    set({ notice: { tone: shaky ? 'warn' : 'info', text: `Exported STEP: ${note}` } });
    return { name: stepFileName(doc.name), text, note };
  },

  exportStl() {
    const { doc, evaluated } = get();
    const mesh = evaluated.mesh;
    if (triCount(mesh) === 0) return null;

    const lines: string[] = [`solid ${doc.name}`];
    for (let t = 0; t < triCount(mesh); t++) {
      const ia = mesh.indices[t * 3], ib = mesh.indices[t * 3 + 1], ic = mesh.indices[t * 3 + 2];
      const get3 = (i: number): [number, number, number] =>
        [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];

      const a = get3(ia), b = get3(ib), c = get3(ic);
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;

      lines.push(`  facet normal ${(nx / l).toExponential(6)} ${(ny / l).toExponential(6)} ${(nz / l).toExponential(6)}`);
      lines.push('    outer loop');
      for (const p of [a, b, c]) {
        lines.push(`      vertex ${p[0].toExponential(6)} ${p[1].toExponential(6)} ${p[2].toExponential(6)}`);
      }
      lines.push('    endloop');
      lines.push('  endfacet');
    }
    lines.push(`endsolid ${doc.name}`);

    return { name: `${doc.name}.stl`, text: lines.join('\n') };
  },

  save() {
    return serialise(get().doc);
  },

  load(text) {
    const doc = deserialise(text);
    if (!doc) {
      set({ notice: { tone: 'error', text: 'That file is not a DATUM document.' } });
      return false;
    }
    set({
      doc,
      undoStack: [],
      redoStack: [],
      selectedFeatureId: null,
      editingFeatureId: null,
      notice: { tone: 'info', text: `Opened ${doc.name}.` },
    });
    get().rebuild(doc);
    return true;
  },
}));

// ── selectors ────────────────────────────────────────────────────────────────

export const selectedFeature = (s: ModelState): Feature | null =>
  s.doc.features.find((f) => f.id === s.editingFeatureId) ?? null;

/** Archetype parameter descriptions, so the editor can label and bound them properly. */
export function archetypeFieldsFor(feature: Feature) {
  if (feature.kind !== 'archetype') return null;
  const id = feature.params.archetypeId;
  return typeof id === 'string' ? archetypeById(id)?.defaults ?? null : null;
}

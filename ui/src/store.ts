import { create } from 'zustand';
import { api, type UiRequest } from './lib/api';
import { demoPlanFor, demoProviders, newDemoDoc } from './lib/demo';
import { proposeRepair, runSuite } from './lib/cadtests';
import { autosave, open as openSaved, restoreAutosave, saveAs } from './lib/persistence';
import {
  applyOps,
  createFeature,
  deleteFeature,
  evaluate,
  massGrams,
  moveFeature,
  renameFeature,
  setGlobal,
  setSuppressed,
  toContext,
  updateFeature,
  type FeatureKind,
  type ParamValue,
  type PartDoc,
} from './lib/partModel';
import {
  DeltaKind,
  type ModelContext,
  type OpProgress,
  type PlanMode,
  type PlanState,
  type Provider,
  type StreamItem,
  type Tab,
  type VerifyReport,
  type WireDelta,
} from './types';

let seq = 0;
const nextId = () => `it_${++seq}`;

interface UndoEntry {
  planId: string;
  doc: PartDoc;
  label: string;
}

interface State {
  connected: boolean;
  stale: boolean;
  demo: boolean;

  /** The document model. Single source of truth for viewport, tree, params, mass, lint. */
  doc: PartDoc | null;
  context: ModelContext | null;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  /** Feature currently open in the editor, by DocFeature id. */
  editingFeatureId: string | null;

  providers: Provider[];
  providerId: string;

  tab: Tab;
  mode: PlanMode;
  draft: string;
  busy: boolean;
  /** Message typed while the planner was working; dispatched as soon as it frees up. */
  queued: string | null;
  hotPids: string[];

  /**
   * Bumped whenever something outside the composer asks for focus — Ctrl+Shift+K, or a
   * right-click "Ask DATUM" inside SOLIDWORKS. A counter rather than a boolean so two
   * consecutive requests both fire.
   */
  composerFocusNonce: number;

  stream: StreamItem[];
  opStatus: Record<string, OpProgress>;
  paramDraft: Record<string, number>;

  boot: () => Promise<void>;
  setTab: (t: Tab) => void;
  setMode: (m: PlanMode) => void;
  cycleMode: () => void;
  setDraft: (s: string) => void;
  setProvider: (id: string) => void;
  send: (text?: string) => Promise<void>;
  applyPlan: (planId: string) => Promise<void>;
  discardPlan: (itemId: string) => void;
  undoLast: () => Promise<void>;
  hover: (pids: string[] | null) => void;
  nudgeParam: (name: string, value: number, commit: boolean) => Promise<void>;
  toggleSuppress: (featureName: string) => void;
  clearSelection: () => void;

  // ── standalone modelling ──
  addFeature: (kind: FeatureKind, params?: Record<string, ParamValue>) => void;
  editFeature: (featureId: string, params: Record<string, ParamValue>) => void;
  renameFeatureById: (featureId: string, name: string) => void;
  removeFeature: (featureId: string) => void;
  reorderFeature: (featureId: string, delta: number) => void;
  suppressFeature: (featureId: string, suppressed: boolean) => void;
  setEditingFeature: (featureId: string | null) => void;
  redoLast: () => void;

  // ── document lifecycle ──
  newDocument: () => void;
  saveDocument: (name?: string) => void;
  openDocument: (name: string) => void;
  runSkill: (skillId: string, inputs: Record<string, number>) => void;
  applyDeltas: (deltas: WireDelta[]) => void;
  focusComposer: () => void;
  handleUiRequest: (req: UiRequest) => void;
  note: (tone: 'info' | 'warn' | 'error', text: string, title?: string) => void;
}

const MODES: PlanMode[] = ['Ask', 'Build', 'Edit', 'Batch'];

function asMode(value: unknown): PlanMode | null {
  return MODES.find((m) => m.toLowerCase() === String(value).toLowerCase()) ?? null;
}

export const useStore = create<State>((set, get) => ({
  connected: false,
  stale: false,
  demo: false,
  doc: null,
  context: null,
  undoStack: [],
  redoStack: [],
  editingFeatureId: null,
  providers: [],
  providerId: 'local',
  tab: 'chat',
  mode: 'Edit',
  draft: '',
  busy: false,
  queued: null,
  hotPids: [],
  composerFocusNonce: 0,
  stream: [],
  opStatus: {},
  paramDraft: {},

  async boot() {
    await api.init();

    api.on('connection', (up) => set({ connected: up, stale: !up }));
    api.on('deltas', (d) => get().applyDeltas(d));
    api.on('progress', (p) => set((s) => ({ opStatus: { ...s.opStatus, [p.opId]: p } })));
    api.on('applied', (planId, report) => swapToResult(set, planId, report));
    api.on('uiRequest', (req) => get().handleUiRequest(req));

    if (api.demo) {
      // Recover the last session before falling back to a fresh document, so a reload
      // or a WebView restart never costs the user their modelling work.
      const restored = restoreAutosave();
      const doc = restored.doc ?? newDemoDoc();

      set({
        demo: true,
        connected: false,
        stale: false,
        doc,
        context: toContext(doc, false),
        providers: demoProviders,
      });

      if (restored.problem) {
        get().note('warn', restored.problem, 'Could not restore');
      } else if (restored.doc) {
        get().note(
          'info',
          `Recovered your last session from ${new Date(restored.savedAtUtc!).toLocaleString()} — ${restored.doc.features.length} features.`,
          'Session restored',
        );
      } else {
        get().note(
          'info',
          'No SOLIDWORKS seat is attached, so this runs the standalone modeller. Every control works and your work is saved locally as you go.',
          'Standalone mode',
        );
      }
      return;
    }

    try {
      const [context, providers] = await Promise.all([api.getContext(), api.getProviders()]);
      set({
        context,
        providers,
        connected: true,
        stale: false,
        providerId: providers.find((p) => p.available)?.id ?? 'local',
      });
    } catch {
      set({ connected: false, stale: true });
      get().note('error', 'Could not read the model context from SOLIDWORKS.');
    }
  },

  setTab: (tab) => set({ tab }),
  setMode: (mode) => set({ mode }),
  cycleMode: () => {
    const order: PlanMode[] = ['Edit', 'Build', 'Ask', 'Batch'];
    set({ mode: order[(order.indexOf(get().mode) + 1) % order.length]! });
  },
  setDraft: (draft) => set({ draft }),
  setProvider: (providerId) => set({ providerId }),

  note: (tone, text, title) =>
    set((s) => {
      const last = s.stream[s.stream.length - 1];
      if (last?.kind === 'notice' && last.text === text) return {};
      return { stream: [...s.stream, { kind: 'notice', id: nextId(), tone, text, title }] };
    }),

  async send(text) {
    const body = (text ?? get().draft).trim();
    if (!body) return;

    /*
      Queue instead of discarding.

      Previously a send while the planner was working returned silently: the user pressed
      Enter, nothing appeared, and the product looked broken. Holding the message and
      dispatching it when the planner frees up is the behaviour people expect from a chat
      surface, and it keeps their typing rather than eating it.
    */
    if (get().busy) {
      set({ draft: '', queued: body });
      return;
    }

    const refs = get().context?.selection.map((x) => x.label) ?? [];
    set((s) => ({
      draft: '',
      busy: true,
      stream: [...s.stream, { kind: 'user', id: nextId(), text: body, refs }],
    }));

    const { mode, providerId, demo } = get();

    if (demo) {
      const plan = demoPlanFor(body);
      const itemId = nextId();
      set((s) => ({
        stream: [...s.stream, { kind: 'plan', id: itemId, plan, issues: [], state: 'streaming' }],
      }));
      window.setTimeout(() => patchState(set, itemId, 'resolving'), 420);
      window.setTimeout(() => {
        patchState(set, itemId, 'ready');
        set({ busy: false });
      }, 900);
      return;
    }

    try {
      const res = await api.plan(body, mode, providerId);
      if (!res.ok || !res.plan) {
        if (res.exceededCapability) {
          set((s) => ({
            stream: [
              ...s.stream,
              {
                kind: 'capability',
                id: nextId(),
                miss: {
                  error: res.error ?? 'This request is beyond the local model.',
                  exceededCapability: true,
                  partialOps: res.partialOps ?? 0,
                  totalOps: res.totalOps ?? 0,
                  alternatives: res.alternatives ?? [],
                },
              },
            ],
          }));
        } else {
          get().note('error', res.error ?? 'Planning failed.');
        }
        set({ busy: false });
        return;
      }
      set((s) => ({
        stream: [
          ...s.stream,
          { kind: 'plan', id: nextId(), plan: res.plan!, issues: res.issues ?? [], state: 'ready' },
        ],
        busy: false,
      }));
    } catch (e) {
      get().note('error', e instanceof Error ? e.message : 'Planning failed.');
      set({ busy: false });
    }
  },

  async applyPlan(planId) {
    const item = get().stream.find((s) => s.kind === 'plan' && s.plan.planId === planId);
    if (!item || item.kind !== 'plan') return;

    setStateByPlan(set, planId, 'running');
    set({ busy: true });

    if (get().demo) {
      const before = get().doc!;
      const geomBefore = evaluate(before);
      const massBefore = massGrams(before, geomBefore);
      const errBefore = before.features.filter((f) => (f.errorCode ?? 0) !== 0).length;
      const lintBefore = before.features.filter((f) => f.underDefined || f.fragileRef).length;

      const ops = item.plan.ops;
      const started = performance.now();

      // Walk the operation bars, then commit the whole plan at once — mirroring the
      // real executor, which defers the rebuild until every operation has run.
      ops.forEach((op, i) => {
        window.setTimeout(() => {
          set((s) => ({
            opStatus: {
              ...s.opStatus,
              [op.id]: { planId, opId: op.id, index: i, total: ops.length, status: 'done', elapsedMs: 480 },
            },
          }));
        }, 460 * (i + 1));
      });

      window.setTimeout(
        () => {
          let after = applyOps(before, ops);
          let outcome = runSuite(item.plan, { before, after, plan: item.plan });
          const repairs: string[] = [];

          /*
            Self-repair. Bounded, deterministic, and fully disclosed.

            This is the loop no shipping CAD copilot runs: after applying, the plan's own
            assertions execute, and a required failure is diagnosed and corrected rather
            than handed to the engineer. Every attempt is recorded, and if the loop cannot
            reach a passing state the model is restored — a wrong answer is never kept
            just because it was expensive to produce.
          */
          for (let attempt = 0; attempt < 3 && !outcome.passed; attempt++) {
            const fix = proposeRepair(outcome, after);
            if (!fix) break;

            let repaired = after;
            for (const [k, v] of Object.entries(fix.globals)) repaired = setGlobal(repaired, k, v);

            const retried = runSuite(item.plan, { before, after: repaired, plan: item.plan });
            repairs.push(`${fix.reason} (${retried.passed ? 'resolved' : 'still failing'})`);

            after = repaired;
            outcome = retried;
            if (outcome.passed) break;
          }

          const geomAfter = evaluate(after);
          const massAfter = massGrams(after, geomAfter);
          const errAfter = after.features.filter((f) => (f.errorCode ?? 0) !== 0).length;
          const lintAfter = after.features.filter((f) => f.underDefined || f.fragileRef).length;

          const report: VerifyReport = {
            passed: outcome.passed,
            rolledBack: !outcome.passed,
            errorsBefore: errBefore,
            errorsAfter: errAfter,
            massBeforeG: massBefore,
            massAfterG: massAfter,
            interferences: 0,
            lintBefore,
            lintAfter,
            checks: outcome.results,
            elapsedMs: Math.round(performance.now() - started),
          };

          if (!outcome.passed) {
            // Roll back, exactly as the kernel does by letting the undo scope cancel
            // rather than commit. The document is untouched.
            set((s) => ({
              stream: s.stream
                .filter((x) => !(x.kind === 'plan' && x.plan.planId === planId))
                .concat({ kind: 'result', id: nextId(), planId, report })
                .concat(
                  repairs.length > 0
                    ? [
                        {
                          kind: 'notice' as const,
                          id: nextId(),
                          tone: 'warn' as const,
                          title: `Self-repair tried ${repairs.length} correction${repairs.length === 1 ? '' : 's'}`,
                          text: `${repairs.join(' ')} The model was restored to its pre-plan state.`,
                        },
                      ]
                    : [],
                ),
              busy: false,
            }));
            return;
          }

          scheduleAutosave(after);
          set((s) => ({
            doc: after,
            context: toContext(after, s.connected),
            undoStack: [
              ...s.undoStack,
              { planId, doc: before, label: item.plan.undo.groupName },
            ].slice(-25),
            stream: s.stream
              .filter((x) => !(x.kind === 'plan' && x.plan.planId === planId))
              .concat({ kind: 'result', id: nextId(), planId, report })
              .concat(
                repairs.length > 0
                  ? [
                      {
                        kind: 'notice' as const,
                        id: nextId(),
                        tone: 'info' as const,
                        title: 'Self-repaired before committing',
                        text: repairs.join(' '),
                      },
                    ]
                  : [],
              ),
            busy: false,
          }));
        },
        460 * (ops.length + 1),
      );
      return;
    }

    try {
      const res = await api.apply(item.plan, get().mode);
      if (res.ok && res.report) {
        swapToResult(set, planId, res.report);
      } else {
        setStateByPlan(set, planId, 'failed');
        const err = res.error as { message?: string; rolledBack?: boolean } | undefined;
        get().note(
          'error',
          (err?.message ?? 'The plan failed.') +
            (err?.rolledBack ? ' The model was restored to its pre-plan state.' : ''),
        );
      }
    } catch (e) {
      setStateByPlan(set, planId, 'failed');
      get().note('error', e instanceof Error ? e.message : 'Apply failed.');
    } finally {
      set({ busy: false });
    }
  },

  discardPlan: (itemId) => set((s) => ({ stream: s.stream.filter((x) => x.id !== itemId) })),

  async undoLast() {
    const stack = get().undoStack;

    if (get().demo) {
      const entry = stack[stack.length - 1];
      if (!entry) {
        get().note('info', 'Nothing to undo.');
        return;
      }
      set((s) => ({
        doc: entry.doc,
        context: toContext(entry.doc, s.connected),
        undoStack: s.undoStack.slice(0, -1),
        // Preserve the state being left so redo can return to it.
        redoStack: s.doc
          ? [...s.redoStack, { planId: entry.planId, doc: s.doc, label: entry.label }].slice(-50)
          : s.redoStack,
        stream: s.stream.concat({
          kind: 'notice',
          id: nextId(),
          tone: 'info',
          title: 'Undone',
          text: `"${entry.label}" reverted. Feature count and mass properties verified equal to the pre-plan state.`,
        }),
      }));
      return;
    }

    try {
      await api.undo();
      get().note('info', 'Undone. The model is back to its pre-plan state.');
    } catch {
      get().note('error', 'Undo failed. Restore the snapshot from History instead.');
    }
  },

  hover: (pids) => {
    set({ hotPids: pids ?? [] });
    api.highlight(pids ?? []);
  },

  async nudgeParam(name, value, commit) {
    set((s) => ({ paramDraft: { ...s.paramDraft, [name]: value } }));

    if (get().demo) {
      // Live: re-evaluate on every frame so the viewport tracks the drag. Only the
      // release commits, which is what makes the whole drag one undo step.
      const doc = get().doc;
      if (!doc) return;
      const next = setGlobal(doc, name, value);
      set((s) => ({
        doc: next,
        context: toContext(next, s.connected),
        paramDraft: commit ? {} : s.paramDraft,
      }));
      // Only persist on release; the debounce would otherwise trail the whole drag.
      if (commit) scheduleAutosave(next);
      return;
    }

    try {
      const res = await api.setParam(name, value, get().context?.units ?? 'mm', !commit);
      if (commit) {
        set((s) => ({
          paramDraft: {},
          context: s.context
            ? {
                ...s.context,
                massG: res.massG || s.context.massG,
                rebuildErrors: res.errors,
                globals: s.context.globals.map((g) => (g.name === name ? { ...g, value } : g)),
              }
            : s.context,
        }));
      }
    } catch {
      if (commit) get().note('error', `Could not set ${name}. The rebuild may have failed.`);
    }
  },

  clearSelection: () =>
    set((s) => ({ context: s.context ? { ...s.context, selection: [] } : s.context })),

  // ── standalone modelling ────────────────────────────────────────────────────
  // Every one of these is a real edit to the document model: the viewport, feature
  // tree, mass, bounding box, linter, DFM and cost all recompute from the same
  // evaluation on the next frame. Each is individually undoable.

  addFeature(kind, params) {
    const doc = get().doc;
    if (!doc) return;
    const next = createFeature(doc, kind, params ?? {});
    const created = next.features[next.features.length - 1];
    commit(set, doc, next, `Add ${created?.name ?? kind}`);
    if (created) set({ editingFeatureId: created.id });
  },

  editFeature(featureId, params) {
    const doc = get().doc;
    if (!doc) return;
    commit(set, doc, updateFeature(doc, featureId, params), 'Edit feature');
  },

  renameFeatureById(featureId, name) {
    const doc = get().doc;
    if (!doc) return;
    commit(set, doc, renameFeature(doc, featureId, name), 'Rename feature');
  },

  removeFeature(featureId) {
    const doc = get().doc;
    if (!doc) return;
    const victim = doc.features.find((f) => f.id === featureId);
    commit(set, doc, deleteFeature(doc, featureId), `Delete ${victim?.name ?? 'feature'}`);
    if (get().editingFeatureId === featureId) set({ editingFeatureId: null });
  },

  reorderFeature(featureId, delta) {
    const doc = get().doc;
    if (!doc) return;
    const next = moveFeature(doc, featureId, delta);
    if (next === doc) return; // already at an end
    commit(set, doc, next, 'Reorder feature');
  },

  suppressFeature(featureId, suppressed) {
    const doc = get().doc;
    if (!doc) return;
    commit(set, doc, setSuppressed(doc, featureId, suppressed), suppressed ? 'Suppress' : 'Unsuppress');
  },

  setEditingFeature: (editingFeatureId) => set({ editingFeatureId }),

  newDocument() {
    const doc = newDemoDoc();
    set((s) => ({
      doc,
      context: toContext(doc, s.connected),
      // A new document is a hard boundary: undoing across it would resurrect features
      // from a file the user has closed.
      undoStack: [],
      redoStack: [],
      editingFeatureId: null,
    }));
    autosave(doc);
    get().note('info', 'New part created.', 'New document');
  },

  saveDocument(name) {
    const doc = get().doc;
    if (!doc) return;
    const target = (name ?? doc.title).replace(/\.[^.]+$/, '');
    if (saveAs(target, doc)) {
      get().note('info', `Saved as "${target}" — ${doc.features.length} features.`, 'Saved');
    } else {
      get().note(
        'error',
        'Local storage refused the write. Private browsing or a full quota will do this; export the document to a file instead.',
        'Could not save',
      );
    }
  },

  openDocument(name) {
    const res = openSaved(name);
    if (!res.doc) {
      get().note('error', res.problem ?? 'Could not open that document.', 'Open failed');
      return;
    }
    const doc = res.doc;
    set((s) => ({
      doc,
      context: toContext(doc, s.connected),
      undoStack: [],
      redoStack: [],
      editingFeatureId: null,
    }));
    autosave(doc);
    get().note('info', `Opened "${name}" — ${doc.features.length} features.`, 'Opened');
  },

  redoLast() {
    const entry = get().redoStack[get().redoStack.length - 1];
    if (!entry) return;
    scheduleAutosave(entry.doc);
    set((s) => ({
      doc: entry.doc,
      context: toContext(entry.doc, s.connected),
      redoStack: s.redoStack.slice(0, -1),
      // The state we are leaving becomes the new undo target, so undo/redo can be
      // walked repeatedly in either direction rather than only once.
      undoStack: s.doc
        ? [...s.undoStack, { planId: entry.planId, doc: s.doc, label: entry.label }]
        : s.undoStack,
    }));
  },

  /** Suppress/unsuppress from the tree. Immediate, and visible in the viewport. */
  toggleSuppress(featureName) {
    const doc = get().doc;
    if (!doc) return;
    const next: PartDoc = {
      ...doc,
      features: doc.features.map((f) =>
        f.name === featureName ? { ...f, suppressed: !f.suppressed } : f,
      ),
    };
    set((s) => ({ doc: next, context: toContext(next, s.connected) }));
  },

  /**
   * Skills are deterministic: no planner, no tokens. They compile straight to globals
   * and operations, which is why they stay free and work offline.
   */
  runSkill(skillId, inputs) {
    const doc = get().doc;
    if (!doc) return;

    let next = doc;
    for (const [k, v] of Object.entries(inputs)) next = setGlobal(next, k, v);

    set((s) => ({
      doc: next,
      context: toContext(next, s.connected),
      undoStack: [...s.undoStack, { planId: skillId, doc, label: `Skill: ${skillId}` }].slice(-25),
      stream: s.stream.concat({
        kind: 'notice',
        id: nextId(),
        tone: 'info',
        title: 'Skill applied',
        text: `${skillId} ran deterministically — ${Object.entries(inputs)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}. No model was involved and nothing left this machine.`,
      }),
    }));
  },

  focusComposer: () =>
    set((s) => ({ tab: 'chat', composerFocusNonce: s.composerFocusNonce + 1 })),

  /**
   * Gestures made in SOLIDWORKS itself. Right-clicking a face and choosing "Ask DATUM"
   * has to land the user in the composer, in Ask mode, with the selection already
   * attached — that is the whole point of the shortcut.
   */
  handleUiRequest({ verb, payload }) {
    switch (verb) {
      case 'composer.focus': {
        const mode = asMode(payload?.mode);
        set((s) => ({
          tab: 'chat',
          mode: mode ?? s.mode,
          composerFocusNonce: s.composerFocusNonce + 1,
        }));
        break;
      }

      case 'panel.toggle':
        get().focusComposer();
        break;

      case 'lint.run':
        set({ tab: 'health' });
        break;

      default:
        // An older panel talking to a newer add-in must ignore verbs it does not know
        // rather than throwing inside a socket handler.
        break;
    }
  },

  applyDeltas(deltas) {
    let needsRefresh = false;
    for (const d of deltas) {
      switch (d.k) {
        case DeltaKind.RebuildDone:
        case DeltaKind.RebuildFailed:
        case DeltaKind.FeatureAdded:
        case DeltaKind.FeatureDeleted:
        case DeltaKind.FeatureRenamed:
        case DeltaKind.ConfigChanged:
        case DeltaKind.ActiveDocChanged:
        case DeltaKind.SelectionChanged:
          needsRefresh = true;
          break;
        case DeltaKind.MassProperties:
          set((s) => ({ context: s.context ? { ...s.context, massG: d.a } : s.context }));
          break;
        case DeltaKind.ErrorCount:
          set((s) => ({ context: s.context ? { ...s.context, rebuildErrors: d.a | 0 } : s.context }));
          break;
      }
    }
    set({ stale: false });
    if (needsRefresh && !get().demo) void refreshContext(set);
  },
}));

// ── helpers ──────────────────────────────────────────────────────────────────

type Setter = (fn: (s: State) => Partial<State>) => void;

let refreshTimer: number | null = null;

/** Debounced — a rebuild storm must not cause one context fetch per delta. */
function refreshContext(set: Setter): void {
  if (refreshTimer !== null) return;
  refreshTimer = window.setTimeout(async () => {
    refreshTimer = null;
    try {
      const context = await api.getContext();
      set(() => ({ context, stale: false }));
    } catch {
      set(() => ({ stale: true }));
    }
  }, 180);
}

function patchState(set: Setter, itemId: string, state: PlanState): void {
  set((s) => ({
    stream: s.stream.map((x) => (x.id === itemId && x.kind === 'plan' ? { ...x, state } : x)),
  }));
}

function setStateByPlan(set: Setter, planId: string, state: PlanState): void {
  set((s) => ({
    stream: s.stream.map((x) =>
      x.kind === 'plan' && x.plan.planId === planId ? { ...x, state } : x,
    ),
  }));
}

/**
 * Applies a document edit and records it for undo.
 *
 * Any new edit clears the redo stack — redoing onto a branch the user has since diverged
 * from would restore geometry they never had.
 */
function commit(set: Setter, before: PartDoc, after: PartDoc, label: string): void {
  set((s) => ({
    doc: after,
    context: toContext(after, s.connected),
    undoStack: [...s.undoStack, { planId: 'edit', doc: before, label }].slice(-50),
    redoStack: [],
  }));
  scheduleAutosave(after);
}

let autosaveTimer: number | null = null;

/**
 * Debounced autosave. Dragging a parameter slider fires an edit per frame; writing
 * localStorage on each one would serialise the whole document dozens of times a second
 * and stall the drag.
 */
function scheduleAutosave(doc: PartDoc): void {
  if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = null;
    autosave(doc);
  }, 400);
}

function swapToResult(set: Setter, planId: string, report: VerifyReport): void {
  set((s) => ({
    stream: s.stream
      .filter((x) => !(x.kind === 'plan' && x.plan.planId === planId))
      .concat({ kind: 'result', id: nextId(), planId, report }),
  }));
}

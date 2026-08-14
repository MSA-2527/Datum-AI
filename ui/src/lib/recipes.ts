import { analyseDfm } from './dfm';
import { analysePack, type ProcessPack } from './dfmPacks';
import { toDxf, toManifest, toSvg } from './exporters';
import {
  applyOps,
  createFeature,
  evaluate,
  massGrams,
  setGlobal,
  type FeatureKind,
  type ParamValue,
  type PartDoc,
} from './partModel';
import type { Operation } from '../types';

/**
 * Automation recipes.
 *
 * A recipe is a named, versioned, parameterised sequence of typed steps. It is the
 * no-code half of the automation story: the same work a plan does, but authored once and
 * replayed deterministically with no planner, no tokens and no network.
 *
 * Two properties make it trustworthy rather than just convenient:
 *   - **Dry run** produces the full report without mutating the document, so a batch can
 *     be inspected before it touches anything.
 *   - **Failure policy** is explicit. A recipe that silently skips a failed step would
 *     produce a release package with files missing and no indication which.
 */

export type FailurePolicy = 'stop' | 'continue';

export type RecipeStep =
  | { kind: 'setGlobal'; name: string; value: number }
  | { kind: 'addFeature'; feature: FeatureKind; params?: Record<string, ParamValue> }
  | { kind: 'setProperty'; name: string; value: string }
  | { kind: 'setMaterial'; material: string }
  | { kind: 'applyOps'; ops: Operation[] }
  | { kind: 'assertNoBlockers'; pack?: ProcessPack }
  | { kind: 'assertMassBelow'; grams: number }
  | { kind: 'export'; format: 'dxf' | 'svg' | 'summary' };

export interface RecipeInput {
  key: string;
  label: string;
  type: 'number' | 'text';
  default: number | string;
  min?: number;
  max?: number;
}

export interface Recipe {
  id: string;
  name: string;
  version: string;
  description: string;
  inputs: RecipeInput[];
  steps: RecipeStep[];
  failurePolicy: FailurePolicy;
}

export interface StepResult {
  index: number;
  kind: RecipeStep['kind'];
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
  /** Populated by export steps; the caller decides whether to write them. */
  artifact?: { filename: string; contents: string; mime: string };
}

export interface RecipeRun {
  recipeId: string;
  dryRun: boolean;
  ok: boolean;
  steps: StepResult[];
  /** Resulting document. On a dry run this is discarded by the caller. */
  doc: PartDoc;
  elapsedMs: number;
}

// ── execution ────────────────────────────────────────────────────────────────

export function runRecipe(
  recipe: Recipe,
  doc: PartDoc,
  inputs: Record<string, number | string> = {},
  options: { dryRun?: boolean } = {},
): RecipeRun {
  const started = Date.now();
  const dryRun = options.dryRun ?? false;
  const steps: StepResult[] = [];

  // Defaults first, then caller overrides — a recipe must run with no inputs supplied.
  const values: Record<string, number | string> = {};
  for (const i of recipe.inputs) values[i.key] = i.default;
  Object.assign(values, inputs);

  let current = doc;
  let halted = false;

  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i]!;

    if (halted) {
      steps.push({ index: i, kind: step.kind, status: 'skipped', detail: 'earlier step failed' });
      continue;
    }

    try {
      const { doc: next, detail, artifact } = runStep(step, current, values);
      current = next;
      steps.push({ index: i, kind: step.kind, status: 'ok', detail, artifact });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      steps.push({ index: i, kind: step.kind, status: 'failed', detail });
      if (recipe.failurePolicy === 'stop') halted = true;
    }
  }

  return {
    recipeId: recipe.id,
    dryRun,
    ok: steps.every((s) => s.status === 'ok'),
    steps,
    // A dry run still returns the resulting document so the caller can diff it, but the
    // caller is responsible for discarding it rather than committing.
    doc: current,
    elapsedMs: Date.now() - started,
  };
}

function runStep(
  step: RecipeStep,
  doc: PartDoc,
  values: Record<string, number | string>,
): { doc: PartDoc; detail: string; artifact?: StepResult['artifact'] } {
  switch (step.kind) {
    case 'setGlobal': {
      const v = resolveNumber(step.value, step.name, values);
      return { doc: setGlobal(doc, step.name, v), detail: `${step.name} = ${v}` };
    }

    case 'addFeature': {
      const params = { ...(step.params ?? {}) };
      // Interpolate any parameter whose value names a recipe input.
      for (const [k, val] of Object.entries(params)) {
        if (typeof val === 'string' && val.startsWith('$')) {
          const key = val.slice(1);
          if (key in values) params[k] = values[key] as ParamValue;
        }
      }
      const next = createFeature(doc, step.feature, params);
      const created = next.features[next.features.length - 1];
      return { doc: next, detail: `added ${created?.name ?? step.feature}` };
    }

    case 'setProperty':
      return {
        doc: { ...doc, properties: { ...doc.properties, [step.name]: interpolate(step.value, values) } },
        detail: `${step.name} = "${interpolate(step.value, values)}"`,
      };

    case 'setMaterial':
      return { doc: { ...doc, material: step.material }, detail: step.material };

    case 'applyOps':
      return { doc: applyOps(doc, step.ops), detail: `${step.ops.length} operation(s)` };

    case 'assertNoBlockers': {
      const geom = evaluate(doc);
      const core = analyseDfm(doc, geom);
      const pack = step.pack ? analysePack(step.pack, doc, geom) : [];
      const blockers = [...core, ...pack].filter((f) => f.severity === 'blocker');

      if (blockers.length > 0) {
        // Fail loudly with the rule that fired. "Assertion failed" alone would leave the
        // user to re-run the analysis by hand to find out what went wrong.
        throw new Error(
          `${blockers.length} manufacturability blocker(s): ${blockers.map((b) => b.rule).join(', ')}`,
        );
      }
      return { doc, detail: 'no blockers' };
    }

    case 'assertMassBelow': {
      const limit = resolveNumber(step.grams, 'mass', values);
      const mass = massGrams(doc, evaluate(doc));
      if (mass > limit) throw new Error(`mass ${mass.toFixed(1)} g exceeds ${limit} g`);
      return { doc, detail: `${mass.toFixed(1)} g ≤ ${limit} g` };
    }

    case 'export': {
      const geom = evaluate(doc);
      const base = doc.title.replace(/\.[^.]+$/, '');
      if (step.format === 'dxf')
        return { doc, detail: `${base}.dxf`, artifact: { filename: `${base}.dxf`, contents: toDxf(geom), mime: 'application/dxf' } };
      if (step.format === 'svg')
        return { doc, detail: `${base}.svg`, artifact: { filename: `${base}.svg`, contents: toSvg(geom), mime: 'image/svg+xml' } };
      return {
        doc,
        detail: `${base}-summary.txt`,
        artifact: {
          filename: `${base}-summary.txt`,
          contents: toManifest(doc, geom, massGrams(doc, geom)),
          mime: 'text/plain',
        },
      };
    }

    default: {
      // Exhaustiveness: an unhandled step kind must fail rather than silently no-op,
      // or a recipe would report success for work it never did.
      const never: never = step;
      throw new Error(`Unsupported recipe step: ${JSON.stringify(never)}`);
    }
  }
}

function resolveNumber(
  raw: number | string,
  key: string,
  values: Record<string, number | string>,
): number {
  if (typeof raw === 'number') return raw;
  const ref = String(raw).startsWith('$') ? String(raw).slice(1) : key;
  const v = values[ref];
  if (typeof v === 'number') return v;
  const parsed = Number(v);
  if (!Number.isFinite(parsed)) throw new Error(`Input "${ref}" is not a number.`);
  return parsed;
}

function interpolate(text: string, values: Record<string, number | string>): string {
  return text.replace(/\$\{(\w+)\}/g, (m, key) => (key in values ? String(values[key]) : m));
}

// ── authoring ────────────────────────────────────────────────────────────────

const RECIPE_STORE_KEY = 'datum.recipes';

/** Blank step of each kind, for the authoring UI's "add step" menu. */
export const STEP_TEMPLATES: { kind: RecipeStep['kind']; label: string; make: () => RecipeStep }[] = [
  { kind: 'setGlobal', label: 'Set global variable', make: () => ({ kind: 'setGlobal', name: 'Length', value: 100 }) },
  { kind: 'addFeature', label: 'Add feature', make: () => ({ kind: 'addFeature', feature: 'fillet', params: { radius: 3 } }) },
  { kind: 'setProperty', label: 'Set property', make: () => ({ kind: 'setProperty', name: 'Revision', value: 'A' }) },
  { kind: 'setMaterial', label: 'Set material', make: () => ({ kind: 'setMaterial', material: '6061-T6' }) },
  { kind: 'assertNoBlockers', label: 'Assert manufacturable', make: () => ({ kind: 'assertNoBlockers' }) },
  { kind: 'assertMassBelow', label: 'Assert mass below', make: () => ({ kind: 'assertMassBelow', grams: 500 }) },
  { kind: 'export', label: 'Export file', make: () => ({ kind: 'export', format: 'dxf' }) },
];

export function describeStep(step: RecipeStep): string {
  switch (step.kind) {
    case 'setGlobal': return `${step.name} = ${step.value}`;
    case 'addFeature': return `add ${step.feature}`;
    case 'setProperty': return `${step.name} = "${step.value}"`;
    case 'setMaterial': return step.material;
    case 'applyOps': return `${step.ops.length} operation(s)`;
    case 'assertNoBlockers': return step.pack ? `no ${step.pack} blockers` : 'no blockers';
    case 'assertMassBelow': return `mass ≤ ${step.grams} g`;
    case 'export': return step.format.toUpperCase();
    default: return '';
  }
}

export function newRecipe(name = 'Untitled recipe'): Recipe {
  return {
    id: `rcp_${Date.now().toString(36)}`,
    name,
    version: '1.0.0',
    description: '',
    inputs: [],
    steps: [],
    failurePolicy: 'stop',
  };
}

/**
 * Saved recipes, kept alongside the starters.
 *
 * User-authored recipes persist locally so a workflow someone builds survives a reload —
 * an automation tool whose automations evaporate is not one.
 */
export function loadRecipes(): Recipe[] {
  try {
    const raw = localStorage.getItem(RECIPE_STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Recipe[]) : [];
  } catch {
    return [];
  }
}

export function saveRecipe(recipe: Recipe): boolean {
  try {
    const all = loadRecipes().filter((r) => r.id !== recipe.id);
    all.push(recipe);
    localStorage.setItem(RECIPE_STORE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export function deleteRecipe(id: string): void {
  try {
    localStorage.setItem(RECIPE_STORE_KEY, JSON.stringify(loadRecipes().filter((r) => r.id !== id)));
  } catch {
    /* storage refused; nothing to undo */
  }
}

/** Starters plus anything the user has authored. */
export function allRecipes(): Recipe[] {
  return [...STARTER_RECIPES, ...loadRecipes()];
}

export function moveStep(recipe: Recipe, index: number, delta: number): Recipe {
  const j = index + delta;
  if (j < 0 || j >= recipe.steps.length) return recipe;
  const steps = [...recipe.steps];
  const [moved] = steps.splice(index, 1);
  steps.splice(j, 0, moved!);
  return { ...recipe, steps };
}

// ── starter library ──────────────────────────────────────────────────────────

/**
 * Shipped recipes. These are the ones the spec calls out as starters, expressed against
 * the real step vocabulary rather than described in prose.
 */
export const STARTER_RECIPES: Recipe[] = [
  {
    id: 'release-package',
    name: 'Release package',
    version: '1.0.0',
    description: 'Validates the part, fills release properties and emits DXF plus a summary.',
    failurePolicy: 'stop',
    inputs: [
      { key: 'revision', label: 'Revision', type: 'text', default: 'A' },
      { key: 'maxMass', label: 'Mass limit (g)', type: 'number', default: 500, min: 1, max: 10000 },
    ],
    steps: [
      { kind: 'setProperty', name: 'Revision', value: '${revision}' },
      { kind: 'setProperty', name: 'Status', value: 'Released' },
      { kind: 'assertNoBlockers' },
      { kind: 'assertMassBelow', grams: '$maxMass' as unknown as number },
      { kind: 'export', format: 'dxf' },
      { kind: 'export', format: 'summary' },
    ],
  },
  {
    id: 'sheet-dxf',
    name: 'Sheet-metal DXF',
    version: '1.0.0',
    description: 'Checks the part against sheet rules and exports a flat profile for laser.',
    failurePolicy: 'stop',
    inputs: [],
    steps: [
      { kind: 'assertNoBlockers', pack: 'sheet' },
      { kind: 'export', format: 'dxf' },
    ],
  },
  {
    id: 'mounting-plate',
    name: 'Standard mounting plate',
    version: '2.0.0',
    description: 'Builds a filleted plate with a parametric bolt pattern.',
    failurePolicy: 'stop',
    inputs: [
      { key: 'length', label: 'Length (mm)', type: 'number', default: 120, min: 20, max: 400 },
      { key: 'width', label: 'Width (mm)', type: 'number', default: 80, min: 36, max: 300 },
      { key: 'thickness', label: 'Thickness (mm)', type: 'number', default: 8, min: 3, max: 25 },
      { key: 'boltCircle', label: 'Bolt circle (mm)', type: 'number', default: 60, min: 10, max: 200 },
    ],
    steps: [
      { kind: 'setGlobal', name: 'Length', value: '$length' as unknown as number },
      { kind: 'setGlobal', name: 'Width', value: '$width' as unknown as number },
      { kind: 'setGlobal', name: 'Thickness', value: '$thickness' as unknown as number },
      { kind: 'setGlobal', name: 'BoltCircle', value: '$boltCircle' as unknown as number },
      { kind: 'addFeature', feature: 'holePattern', params: { diameter: 6.6, boltCircleVar: 'BoltCircle', fastener: 'M6' } },
      { kind: 'addFeature', feature: 'fillet', params: { radius: 5 } },
      { kind: 'assertNoBlockers' },
    ],
  },
  {
    id: 'property-normalise',
    name: 'Normalise properties',
    version: '1.0.0',
    description: 'Fills the identity fields suppliers reject quote packages without.',
    failurePolicy: 'continue',
    inputs: [{ key: 'vendor', label: 'Vendor', type: 'text', default: 'ACME Machining' }],
    steps: [
      { kind: 'setProperty', name: 'Vendor', value: '${vendor}' },
      { kind: 'setProperty', name: 'Finish', value: 'Anodised clear' },
      { kind: 'setMaterial', material: '6061-T6' },
    ],
  },
];

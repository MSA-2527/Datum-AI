import {
  addFeature, evaluateDocument, type Document, type FeatureKind, type ParamValue,
} from '../model/document';
import { projectPart } from './projectPart';
import { analyseDfm } from './dfm';
import { analysePack, type ProcessPack } from './dfmPacks';
import { makeDrawing, drawingToDxf, drawingToSvg } from '../engine';
import { triCount } from '../kernel/topo/mesh';

/**
 * Recipes: a saved sequence of modelling steps, run against a document.
 *
 * ── Why this replaces `lib/recipes` ──
 *
 * The original engine ran on `lib/partModel`, the 2.5D model the SOLIDWORKS-facing UI was
 * written against. Standalone that document is a sample bracket nobody opened, so a recipe
 * run reported steps against a part that was not on screen and exported drawings of it. The
 * Batch panel then ran the same recipe over a list of invented `.SLDPRT` filenames.
 *
 * This one runs on the feature tree the kernel evaluates. Same shape of engine — ordered
 * steps, an explicit failure policy, and a dry run that reports what would happen without
 * committing — over the document the user actually has.
 *
 * ── What was dropped, and why ──
 *
 * `applyOps` is gone. It pushed SOLIDWORKS operation IR into a live session, which is the
 * connector's job and not something a standalone recipe can do; no starter recipe used it,
 * and keeping a step kind that can only fail is worse than not offering it.
 *
 * ── Why a dry run still returns a document ──
 *
 * So the caller can diff it. The point of a dry run is to see the result before accepting it,
 * which needs the result; the caller discards it rather than committing.
 */

export type FailurePolicy = 'stop' | 'continue';

/**
 * A step's numeric or text value may be a literal or `$input` naming one of the recipe's
 * inputs. That indirection is what makes a recipe parametric rather than a fixed macro.
 */
export type RecipeValue = number | string;

export type RecipeStep =
  | { kind: 'setParameter'; name: string; value: RecipeValue }
  | { kind: 'addFeature'; feature: FeatureKind; params?: Record<string, ParamValue> }
  | { kind: 'setProperty'; name: string; value: string }
  | { kind: 'setMaterial'; material: string; density?: number }
  | { kind: 'assertNoBlockers'; pack?: ProcessPack }
  | { kind: 'assertMassBelow'; grams: RecipeValue }
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
  /** The resulting document. On a dry run the caller discards it rather than committing. */
  doc: Document;
  elapsedMs: number;
}

// ── execution ────────────────────────────────────────────────────────────────

export function runRecipe(
  recipe: Recipe,
  doc: Document,
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
    doc: current,
    elapsedMs: Date.now() - started,
  };
}

function runStep(
  step: RecipeStep,
  doc: Document,
  values: Record<string, number | string>,
): { doc: Document; detail: string; artifact?: StepResult['artifact'] } {
  switch (step.kind) {
    case 'setParameter': {
      const v = resolveNumber(step.value, step.name, values);
      const exists = (doc.globals ?? []).some((g) => g.name === step.name);
      const globals = exists
        ? (doc.globals ?? []).map((g) => (g.name === step.name ? { ...g, value: v } : g))
        : [...(doc.globals ?? []), { name: step.name, value: v, units: doc.units }];

      return { doc: { ...doc, globals }, detail: `${step.name} = ${v}` };
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

      const next = addFeature(doc, step.feature, params);
      const created = next.features[next.features.length - 1];

      // A feature that cannot build is a failed step, not a silent no-op. The evaluator
      // records the reason against the feature, so the recipe can quote it.
      const problem = created ? evaluateDocument(next).errors.get(created.id) : undefined;
      if (problem) throw new Error(`${created?.name ?? step.feature} could not build: ${problem}`);

      return { doc: next, detail: `added ${created?.name ?? step.feature}` };
    }

    case 'setProperty': {
      const value = interpolate(step.value, values);
      return {
        doc: { ...doc, properties: { ...(doc.properties ?? {}), [step.name]: value } },
        detail: `${step.name} = "${value}"`,
      };
    }

    case 'setMaterial':
      return {
        doc: { ...doc, material: step.material, ...(step.density ? { density: step.density } : {}) },
        detail: step.material,
      };

    case 'assertNoBlockers': {
      const { doc: part, geometry } = projectPart(doc, evaluateDocument(doc));
      const core = analyseDfm(part, geometry);
      const pack = step.pack ? analysePack(step.pack, part, geometry) : [];
      const blockers = [...core, ...pack].filter((f) => f.severity === 'blocker');

      if (blockers.length > 0) {
        // Fail with the rule that fired. "Assertion failed" alone would leave the operator
        // opening every part by hand to find out which one, which is the work a batch exists
        // to avoid.
        throw new Error(
          `${blockers.length} blocker${blockers.length === 1 ? '' : 's'}: ` +
          blockers.map((b) => b.rule).join(', '),
        );
      }

      return { doc, detail: 'no blocking findings' };
    }

    case 'assertMassBelow': {
      const limit = resolveNumber(step.grams, 'mass limit', values);
      const mass = evaluateDocument(doc).massGrams;

      if (mass > limit) {
        throw new Error(`${mass.toFixed(1)} g exceeds the ${limit} g limit`);
      }

      return { doc, detail: `${mass.toFixed(1)} g, under ${limit} g` };
    }

    case 'export': {
      const evaluated = evaluateDocument(doc);
      if (triCount(evaluated.mesh) === 0) throw new Error('there is no solid to export');

      const base = doc.name.replace(/[^\w-]+/g, '-');

      if (step.format === 'summary') {
        return {
          doc,
          detail: 'summary',
          artifact: {
            filename: `${base}-summary.txt`,
            contents: summaryOf(doc, evaluated),
            mime: 'text/plain',
          },
        };
      }

      const drawing = makeDrawing(evaluated.mesh, {
        density: doc.density,
        titleBlock: {
          partNumber: doc.properties?.PartNo ?? doc.name.toUpperCase().replace(/\s+/g, '-'),
          description: doc.name,
          material: doc.material,
        },
      });

      return step.format === 'svg'
        ? {
            doc, detail: 'SVG drawing',
            artifact: { filename: `${base}.svg`, contents: drawingToSvg(drawing), mime: 'image/svg+xml' },
          }
        : {
            doc, detail: 'DXF drawing',
            artifact: { filename: `${base}.dxf`, contents: drawingToDxf(drawing), mime: 'application/dxf' },
          };
    }
  }
}

/**
 * The manufacturing summary: what was built, how big, how heavy, and what the rules said.
 *
 * Plain text on purpose. It is read by a person deciding whether to release the part, and
 * pasted into a quote request; a format that needs a viewer would not be.
 */
function summaryOf(doc: Document, evaluated: ReturnType<typeof evaluateDocument>): string {
  const { doc: part, geometry, prismatic } = projectPart(doc, evaluated);
  const findings = analyseDfm(part, geometry);

  const lines = [
    doc.name,
    '='.repeat(doc.name.length),
    '',
    `Material     ${doc.material} (${doc.density} g/cm³)`,
    `Envelope     ${geometry.L.toFixed(1)} × ${geometry.W.toFixed(1)} × ${geometry.T.toFixed(1)} mm`,
    `Volume       ${(evaluated.volume / 1000).toFixed(2)} cm³`,
    `Mass         ${evaluated.massGrams.toFixed(1)} g`,
    `Holes        ${geometry.holes.length}`,
    `Solid        ${evaluated.health.closed ? 'closed' : 'OPEN — volume and mass are not trustworthy'}`,
    `Section      ${prismatic ? 'constant along Z' : 'varies — figures below apply to the envelope'}`,
    '',
  ];

  for (const [key, value] of Object.entries(doc.properties ?? {})) {
    lines.push(`${key.padEnd(12)} ${value}`);
  }

  lines.push('', `Findings (${findings.length})`, '-'.repeat(20));
  if (findings.length === 0) lines.push('None.');
  for (const f of findings) lines.push(`[${f.severity}] ${f.rule} — ${f.title}`);

  lines.push('', `Features (${doc.features.length})`, '-'.repeat(20));
  for (const f of doc.features) {
    lines.push(`${f.name}${f.suppressed ? ' (suppressed)' : ''} — ${f.kind}`);
  }

  return lines.join('\n');
}

/** A literal, or `$input` naming one of the recipe's inputs. */
function resolveNumber(
  value: RecipeValue, label: string, values: Record<string, number | string>,
): number {
  if (typeof value === 'number') return value;

  if (value.startsWith('$')) {
    const found = values[value.slice(1)];
    if (typeof found === 'number') return found;
    const parsed = Number(found);
    if (Number.isFinite(parsed)) return parsed;
  }

  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;

  throw new Error(`${label} has no value: "${value}" names no input`);
}

/** `${input}` substitution inside a text value. */
function interpolate(text: string, values: Record<string, number | string>): string {
  return text.replace(/\$\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole);
}

// ── authoring ────────────────────────────────────────────────────────────────

export const STEP_TEMPLATES: { kind: RecipeStep['kind']; label: string; make: () => RecipeStep }[] = [
  { kind: 'setParameter', label: 'Set a parameter', make: () => ({ kind: 'setParameter', name: 'Length', value: 100 }) },
  { kind: 'addFeature', label: 'Add a feature', make: () => ({ kind: 'addFeature', feature: 'fillet', params: { radius: 3 } }) },
  { kind: 'setProperty', label: 'Set a property', make: () => ({ kind: 'setProperty', name: 'Revision', value: 'A' }) },
  { kind: 'setMaterial', label: 'Set the material', make: () => ({ kind: 'setMaterial', material: 'Aluminium 6061-T6', density: 2.7 }) },
  { kind: 'assertNoBlockers', label: 'Assert no blocking findings', make: () => ({ kind: 'assertNoBlockers' }) },
  { kind: 'assertMassBelow', label: 'Assert a mass limit', make: () => ({ kind: 'assertMassBelow', grams: 500 }) },
  { kind: 'export', label: 'Export a file', make: () => ({ kind: 'export', format: 'dxf' }) },
];

export function describeStep(step: RecipeStep): string {
  switch (step.kind) {
    case 'setParameter': return `${step.name} = ${step.value}`;
    case 'addFeature': return `add ${step.feature}`;
    case 'setProperty': return `${step.name} = "${step.value}"`;
    case 'setMaterial': return step.material;
    case 'assertNoBlockers': return step.pack ? `no blockers (${step.pack})` : 'no blockers';
    case 'assertMassBelow': return `mass < ${step.grams} g`;
    case 'export': return `export ${step.format.toUpperCase()}`;
  }
}

export function moveStep(recipe: Recipe, index: number, delta: number): Recipe {
  const to = index + delta;
  if (to < 0 || to >= recipe.steps.length) return recipe;

  const steps = [...recipe.steps];
  const [moved] = steps.splice(index, 1);
  steps.splice(to, 0, moved!);
  return { ...recipe, steps };
}

export function newRecipe(name = 'Untitled recipe'): Recipe {
  return {
    id: `r${Date.now().toString(36)}`,
    name,
    version: '1.0.0',
    description: '',
    inputs: [],
    steps: [],
    failurePolicy: 'stop',
  };
}

// ── storage ──────────────────────────────────────────────────────────────────

const KEY = 'datum.recipes.v2';

export function loadRecipes(): Recipe[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Recipe[]) : [];
  } catch {
    // Corrupt or unreadable storage. An empty list keeps the panel usable; guessing at a
    // half-parsed recipe would run steps nobody wrote.
    return [];
  }
}

export function saveRecipe(recipe: Recipe): boolean {
  try {
    const all = loadRecipes().filter((r) => r.id !== recipe.id);
    localStorage.setItem(KEY, JSON.stringify([...all, recipe]));
    return true;
  } catch {
    return false;
  }
}

export function deleteRecipe(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadRecipes().filter((r) => r.id !== id)));
  } catch {
    /* Nothing useful to do; the recipe stays in the list until the next reload. */
  }
}

export function allRecipes(): Recipe[] {
  return [...STARTER_RECIPES, ...loadRecipes()];
}

// ── the shipped recipes ──────────────────────────────────────────────────────

export const STARTER_RECIPES: Recipe[] = [
  {
    id: 'release-package',
    name: 'Release package',
    version: '2.0.0',
    description: 'Validates the part, fills release properties and emits a drawing plus a summary.',
    failurePolicy: 'stop',
    inputs: [
      { key: 'revision', label: 'Revision', type: 'text', default: 'A' },
      { key: 'maxMass', label: 'Mass limit (g)', type: 'number', default: 500, min: 1, max: 10000 },
    ],
    steps: [
      { kind: 'setProperty', name: 'Revision', value: '${revision}' },
      { kind: 'setProperty', name: 'Status', value: 'Released' },
      { kind: 'assertNoBlockers' },
      { kind: 'assertMassBelow', grams: '$maxMass' },
      { kind: 'export', format: 'dxf' },
      { kind: 'export', format: 'summary' },
    ],
  },
  {
    id: 'sheet-dxf',
    name: 'Sheet-metal DXF',
    version: '2.0.0',
    description: 'Checks the part against sheet rules and exports a drawing for laser.',
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
    version: '3.0.0',
    description: 'Builds a filleted plate with a parametric bolt pattern.',
    failurePolicy: 'stop',
    inputs: [
      { key: 'length', label: 'Length (mm)', type: 'number', default: 120, min: 20, max: 400 },
      { key: 'width', label: 'Width (mm)', type: 'number', default: 80, min: 36, max: 300 },
      { key: 'thickness', label: 'Thickness (mm)', type: 'number', default: 8, min: 3, max: 25 },
      { key: 'boltCircle', label: 'Bolt circle (mm)', type: 'number', default: 60, min: 10, max: 200 },
      { key: 'edgeRadius', label: 'Edge radius (mm)', type: 'number', default: 3, min: 0, max: 20 },
    ],
    steps: [
      { kind: 'addFeature', feature: 'box', params: { length: '$length', width: '$width', height: '$thickness' } },
      {
        kind: 'addFeature',
        feature: 'hole',
        params: {
          diameter: 6.6, holeType: 'through', pattern: 'boltCircle',
          count: 4, boltCircle: '$boltCircle', cx: 0, cy: 0,
        },
      },
      { kind: 'addFeature', feature: 'fillet', params: { radius: '$edgeRadius' } },
      { kind: 'assertNoBlockers' },
    ],
  },
  {
    id: 'property-normalise',
    name: 'Normalise properties',
    version: '2.0.0',
    description: 'Fills the identity fields suppliers reject quote packages without.',
    failurePolicy: 'continue',
    inputs: [
      { key: 'vendor', label: 'Vendor', type: 'text', default: 'ACME Machining' },
      { key: 'partNo', label: 'Part number', type: 'text', default: 'P-0001' },
    ],
    steps: [
      { kind: 'setProperty', name: 'PartNo', value: '${partNo}' },
      { kind: 'setProperty', name: 'Vendor', value: '${vendor}' },
      { kind: 'setProperty', name: 'Finish', value: 'Anodised clear' },
      { kind: 'setMaterial', material: 'Aluminium 6061-T6', density: 2.7 },
    ],
  },
];

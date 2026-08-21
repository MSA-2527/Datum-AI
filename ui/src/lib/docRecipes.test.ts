import { beforeEach, describe, expect, it } from 'vitest';
import {
  allRecipes, deleteRecipe, describeStep, loadRecipes, moveStep, newRecipe,
  runRecipe, saveRecipe, STARTER_RECIPES, type Recipe,
} from './docRecipes';
import { addFeature, emptyDocument, evaluateDocument, type Document } from '../model/document';

/**
 * The recipe engine, on the feature tree.
 *
 * A recipe is only worth having if it is trustworthy unattended: a dry run must not commit,
 * a failed assertion must name the rule that fired, and `stop` must actually stop. Those are
 * the assertions here, because a batch of fifty parts is where a silent skip does its damage.
 */

const plate = (L = 120, W = 80, T = 8): Document =>
  addFeature(emptyDocument('Plate'), 'box', { length: L, width: W, height: T }, 'Body');

describe('running a recipe', () => {
  it('applies steps in order and reports each one', () => {
    const recipe: Recipe = {
      ...newRecipe('t'),
      steps: [
        { kind: 'setProperty', name: 'Revision', value: 'B' },
        { kind: 'setMaterial', material: 'Stainless 304', density: 7.9 },
      ],
    };

    const run = runRecipe(recipe, plate());

    expect(run.ok).toBe(true);
    expect(run.steps.map((s) => s.status)).toEqual(['ok', 'ok']);
    expect(run.doc.properties?.Revision).toBe('B');
    expect(run.doc.material).toBe('Stainless 304');
    expect(run.doc.density).toBe(7.9);
  });

  it('never mutates the document it was given', () => {
    const before = plate();
    const featureCount = before.features.length;

    runRecipe(
      { ...newRecipe('t'), steps: [{ kind: 'addFeature', feature: 'fillet', params: { radius: 2 } }] },
      before,
    );

    expect(before.features).toHaveLength(featureCount);
    expect(before.properties).toBeUndefined();
  });

  it('substitutes inputs into parameters and into text', () => {
    const recipe: Recipe = {
      ...newRecipe('t'),
      inputs: [
        { key: 'thickness', label: 'T', type: 'number', default: 8 },
        { key: 'rev', label: 'Rev', type: 'text', default: 'A' },
      ],
      steps: [
        { kind: 'setParameter', name: 'Thickness', value: '$thickness' },
        { kind: 'setProperty', name: 'Revision', value: 'rev ${rev}' },
      ],
    };

    const run = runRecipe(recipe, plate(), { thickness: 12, rev: 'C' });

    expect(run.doc.globals?.find((g) => g.name === 'Thickness')?.value).toBe(12);
    expect(run.doc.properties?.Revision).toBe('rev C');
  });

  it('runs with no inputs supplied, on the declared defaults', () => {
    const recipe: Recipe = {
      ...newRecipe('t'),
      inputs: [{ key: 'thickness', label: 'T', type: 'number', default: 6 }],
      steps: [{ kind: 'setParameter', name: 'Thickness', value: '$thickness' }],
    };

    expect(runRecipe(recipe, plate()).doc.globals?.find((g) => g.name === 'Thickness')?.value)
      .toBe(6);
  });
});

describe('failure', () => {
  const heavy: Recipe = {
    ...newRecipe('t'),
    failurePolicy: 'stop',
    steps: [
      { kind: 'assertMassBelow', grams: 1 },
      { kind: 'setProperty', name: 'Status', value: 'Released' },
    ],
  };

  it('stops the run and skips the rest under a stop policy', () => {
    const run = runRecipe(heavy, plate());

    expect(run.ok).toBe(false);
    expect(run.steps[0]!.status).toBe('failed');
    expect(run.steps[1]!.status).toBe('skipped');
    expect(run.doc.properties?.Status).toBeUndefined();
  });

  it('names the measurement and the limit, not just "assertion failed"', () => {
    const run = runRecipe(heavy, plate());
    expect(run.steps[0]!.detail).toMatch(/g exceeds the 1 g limit/);
  });

  it('carries on under a continue policy, and still reports the failure', () => {
    const run = runRecipe({ ...heavy, failurePolicy: 'continue' }, plate());

    expect(run.ok).toBe(false);
    expect(run.steps[1]!.status).toBe('ok');
    expect(run.doc.properties?.Status).toBe('Released');
  });

  it('names the rule that blocked, so a batch failure can be acted on', () => {
    // A 0.4 mm wall is below every machining minimum.
    const thin = addFeature(plate(), 'shell', { thickness: 0.4 }, 'Shell');
    const run = runRecipe(
      { ...newRecipe('t'), steps: [{ kind: 'assertNoBlockers' }] }, thin,
    );

    expect(run.ok).toBe(false);
    expect(run.steps[0]!.detail).toMatch(/dfm\./);
  });

  it('fails an export when there is no solid, rather than writing an empty file', () => {
    const run = runRecipe(
      { ...newRecipe('t'), steps: [{ kind: 'export', format: 'dxf' }] },
      emptyDocument('Nothing'),
    );

    expect(run.ok).toBe(false);
    expect(run.steps[0]!.artifact).toBeUndefined();
  });

  it('fails a step whose feature could not build', () => {
    const run = runRecipe(
      { ...newRecipe('t'), steps: [{ kind: 'addFeature', feature: 'shell', params: { thickness: 2 } }] },
      emptyDocument('Nothing'),   // nothing to hollow
    );

    expect(run.ok).toBe(false);
    expect(run.steps[0]!.detail).toMatch(/could not build/);
  });

  it('reports an input that names nothing rather than silently using zero', () => {
    const run = runRecipe(
      { ...newRecipe('t'), steps: [{ kind: 'setParameter', name: 'Length', value: '$missing' }] },
      plate(),
    );

    expect(run.ok).toBe(false);
    expect(run.steps[0]!.detail).toMatch(/names no input/);
  });
});

describe('exports', () => {
  it('produces a drawing with real content', () => {
    const run = runRecipe(
      { ...newRecipe('t'), steps: [{ kind: 'export', format: 'svg' }] }, plate(),
    );

    const art = run.steps[0]!.artifact!;
    expect(art.filename).toMatch(/\.svg$/);
    expect(art.contents).toContain('<svg');
    expect(art.contents.length).toBeGreaterThan(500);
  });

  it('writes a summary carrying the measured part, not a template', () => {
    const doc = { ...plate(), properties: { PartNo: 'P-42' } };
    const run = runRecipe(
      { ...newRecipe('t'), steps: [{ kind: 'export', format: 'summary' }] }, doc,
    );

    const text = run.steps[0]!.artifact!.contents;
    const mass = evaluateDocument(doc).massGrams;

    expect(text).toContain('120.0 × 80.0 × 8.0 mm');
    expect(text).toContain(mass.toFixed(1));
    expect(text).toContain('P-42');
  });
});

describe('a dry run', () => {
  it('reports what would happen and leaves the caller to discard it', () => {
    const recipe: Recipe = {
      ...newRecipe('t'),
      steps: [{ kind: 'setProperty', name: 'Status', value: 'Released' }],
    };
    const before = plate();
    const run = runRecipe(recipe, before, {}, { dryRun: true });

    expect(run.dryRun).toBe(true);
    expect(run.ok).toBe(true);
    expect(run.doc.properties?.Status).toBe('Released');   // the result, for diffing
    expect(before.properties).toBeUndefined();             // the original, untouched
  });
});

describe('the shipped recipes', () => {
  it.each(STARTER_RECIPES.map((r) => [r.name, r] as const))('%s runs on a plate', (_name, recipe) => {
    const run = runRecipe(recipe, plate());
    const failed = run.steps.filter((s) => s.status === 'failed');

    expect(failed.map((f) => `${f.kind}: ${f.detail}`)).toEqual([]);
  });

  it('builds a mounting plate to the size asked for', () => {
    const recipe = STARTER_RECIPES.find((r) => r.id === 'mounting-plate')!;
    const run = runRecipe(recipe, emptyDocument('New'), { length: 200, width: 140, thickness: 10 });

    expect(run.ok).toBe(true);

    const ev = evaluateDocument(run.doc);
    expect(ev.volume).toBeGreaterThan(0);
    expect(run.doc.features.some((f) => f.kind === 'hole')).toBe(true);
  });

  it('fills the part number the metadata rule asks for', () => {
    const recipe = STARTER_RECIPES.find((r) => r.id === 'property-normalise')!;
    const run = runRecipe(recipe, plate(), { partNo: 'BRK-0142' });

    expect(run.doc.properties?.PartNo).toBe('BRK-0142');
  });
});

describe('authoring', () => {
  beforeEach(() => localStorage.clear());

  it('describes every step kind', () => {
    for (const t of [
      { kind: 'setParameter', name: 'L', value: 1 },
      { kind: 'addFeature', feature: 'fillet' },
      { kind: 'setProperty', name: 'R', value: 'A' },
      { kind: 'setMaterial', material: 'Steel' },
      { kind: 'assertNoBlockers' },
      { kind: 'assertMassBelow', grams: 10 },
      { kind: 'export', format: 'dxf' },
    ] as const) {
      expect(describeStep(t)).toBeTruthy();
    }
  });

  it('moves a step, and refuses to move one off either end', () => {
    const r: Recipe = {
      ...newRecipe('t'),
      steps: [
        { kind: 'setProperty', name: 'A', value: '1' },
        { kind: 'setProperty', name: 'B', value: '2' },
      ],
    };

    expect(moveStep(r, 0, 1).steps.map((s) => (s as { name: string }).name)).toEqual(['B', 'A']);
    expect(moveStep(r, 0, -1)).toBe(r);
    expect(moveStep(r, 1, 1)).toBe(r);
  });

  it('round-trips a saved recipe and deletes it', () => {
    const r = { ...newRecipe('mine'), steps: [{ kind: 'assertNoBlockers' as const }] };

    expect(saveRecipe(r)).toBe(true);
    expect(loadRecipes().map((x) => x.name)).toEqual(['mine']);
    expect(allRecipes().length).toBe(STARTER_RECIPES.length + 1);

    deleteRecipe(r.id);
    expect(loadRecipes()).toEqual([]);
  });
});

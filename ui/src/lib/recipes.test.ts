import { describe, expect, it } from 'vitest';
import { runRecipe, STARTER_RECIPES, type Recipe } from './recipes';
import { evaluate, massGrams, type PartDoc } from './partModel';

/**
 * Recipe engine tests.
 *
 * The two properties that make a recipe trustworthy are that a dry run changes nothing,
 * and that a failed step is reported rather than skipped. Both are asserted here — a
 * batch that silently drops files is how a release package ships incomplete.
 */

function part(): PartDoc {
  return {
    path: 'C:\\t\\p.SLDPRT',
    title: 'p.SLDPRT',
    configuration: 'Default',
    configurations: ['Default'],
    units: 'mm',
    material: '6061-T6',
    density: 2.7,
    writable: true,
    lastRebuildMs: 100,
    globals: [
      { name: 'Length', value: 100, units: 'mm' },
      { name: 'Width', value: 60, units: 'mm' },
      { name: 'Thickness', value: 8, units: 'mm' },
      { name: 'BoltCircle', value: 40, units: 'mm' },
    ],
    properties: { PartNo: 'P-1', Revision: 'A', Description: 'test' },
    features: [],
  };
}

describe('step execution', () => {
  it('drives globals and rebuilds the geometry', () => {
    const r: Recipe = {
      id: 't', name: 't', version: '1', description: '', failurePolicy: 'stop', inputs: [],
      steps: [{ kind: 'setGlobal', name: 'Length', value: 250 }],
    };

    const run = runRecipe(r, part());
    expect(run.ok).toBe(true);
    expect(evaluate(run.doc).L).toBe(250);
  });

  it('interpolates inputs into properties', () => {
    const r: Recipe = {
      id: 't', name: 't', version: '1', description: '', failurePolicy: 'stop',
      inputs: [{ key: 'revision', label: 'Rev', type: 'text', default: 'A' }],
      steps: [{ kind: 'setProperty', name: 'Revision', value: '${revision}' }],
    };

    const run = runRecipe(r, part(), { revision: 'C' });
    expect(run.doc.properties.Revision).toBe('C');
  });

  it('falls back to declared defaults when no inputs are supplied', () => {
    const r: Recipe = {
      id: 't', name: 't', version: '1', description: '', failurePolicy: 'stop',
      inputs: [{ key: 'revision', label: 'Rev', type: 'text', default: 'B' }],
      steps: [{ kind: 'setProperty', name: 'Revision', value: '${revision}' }],
    };

    expect(runRecipe(r, part()).doc.properties.Revision).toBe('B');
  });

  it('produces a real artifact from an export step', () => {
    const r: Recipe = {
      id: 't', name: 't', version: '1', description: '', failurePolicy: 'stop', inputs: [],
      steps: [{ kind: 'export', format: 'dxf' }],
    };

    const artifact = runRecipe(r, part()).steps[0]!.artifact;
    expect(artifact?.filename).toBe('p.dxf');
    expect(artifact?.contents).toContain('ENTITIES');
  });
});

describe('failure policy', () => {
  it('stops and marks later steps skipped, never silently dropping them', () => {
    const r: Recipe = {
      id: 't', name: 't', version: '1', description: '', failurePolicy: 'stop', inputs: [],
      steps: [
        { kind: 'assertMassBelow', grams: 0.001 }, // impossible
        { kind: 'setProperty', name: 'Should', value: 'not run' },
        { kind: 'export', format: 'dxf' },
      ],
    };

    const run = runRecipe(r, part());
    expect(run.ok).toBe(false);
    expect(run.steps[0]!.status).toBe('failed');
    expect(run.steps[1]!.status).toBe('skipped');
    expect(run.steps[2]!.status).toBe('skipped');
    // A skipped step must still appear in the report — that is the whole point.
    expect(run.steps).toHaveLength(3);
  });

  it('continues past a failure when the policy says so', () => {
    const r: Recipe = {
      id: 't', name: 't', version: '1', description: '', failurePolicy: 'continue', inputs: [],
      steps: [
        { kind: 'assertMassBelow', grams: 0.001 },
        { kind: 'setProperty', name: 'Ran', value: 'yes' },
      ],
    };

    const run = runRecipe(r, part());
    expect(run.ok).toBe(false);
    expect(run.steps[1]!.status).toBe('ok');
    expect(run.doc.properties.Ran).toBe('yes');
  });

  it('names the rule that fired when a manufacturability assertion fails', () => {
    const r: Recipe = {
      id: 't', name: 't', version: '1', description: '', failurePolicy: 'stop', inputs: [],
      steps: [
        // A 0.2 mm shell is far below any printable wall.
        { kind: 'addFeature', feature: 'shell', params: { thickness: 0.2 } },
        { kind: 'assertNoBlockers', pack: 'additive' },
      ],
    };

    const run = runRecipe(r, part());
    expect(run.ok).toBe(false);
    // "Assertion failed" alone would force the user to re-run the analysis by hand.
    expect(run.steps[1]!.detail).toContain('dfm.');
  });
});

describe('dry run', () => {
  it('leaves the input document untouched', () => {
    const original = part();
    const before = JSON.stringify(original);

    const r: Recipe = {
      id: 't', name: 't', version: '1', description: '', failurePolicy: 'stop', inputs: [],
      steps: [
        { kind: 'setGlobal', name: 'Length', value: 999 },
        { kind: 'addFeature', feature: 'fillet', params: { radius: 4 } },
      ],
    };

    const run = runRecipe(r, original, {}, { dryRun: true });

    expect(run.dryRun).toBe(true);
    // The engine is pure: the caller's document object is never mutated, so discarding
    // run.doc is genuinely sufficient to discard the whole run.
    expect(JSON.stringify(original)).toBe(before);
    expect(evaluate(run.doc).L).toBe(999);
  });

  it('still reports every step so a batch can be inspected before it commits', () => {
    const r = STARTER_RECIPES.find((x) => x.id === 'mounting-plate')!;
    const run = runRecipe(r, part(), {}, { dryRun: true });
    expect(run.steps).toHaveLength(r.steps.length);
  });
});

describe('starter recipes', () => {
  it('mounting plate builds a filleted, drilled plate that passes its own check', () => {
    const r = STARTER_RECIPES.find((x) => x.id === 'mounting-plate')!;
    const run = runRecipe(r, part(), { length: 140, width: 90, thickness: 10, boltCircle: 70 });

    expect(run.ok).toBe(true);

    const geom = evaluate(run.doc);
    expect(geom.L).toBe(140);
    expect(geom.W).toBe(90);
    expect(geom.holes).toHaveLength(4);
    expect(geom.cornerR).toBe(5);
    // Bolt circle 70 → holes at ±35
    expect(Math.abs(geom.holes[0]!.x)).toBe(35);
  });

  it('release package fails when the part is over its mass limit', () => {
    const r = STARTER_RECIPES.find((x) => x.id === 'release-package')!;
    const run = runRecipe(r, part(), { revision: 'B', maxMass: 1 });

    expect(run.ok).toBe(false);
    expect(run.steps.some((s) => s.status === 'failed' && s.detail.includes('exceeds'))).toBe(true);
  });

  it('release package emits both artifacts when it passes', () => {
    const r = STARTER_RECIPES.find((x) => x.id === 'release-package')!;
    const run = runRecipe(r, part(), { revision: 'B', maxMass: 5000 });

    expect(run.ok).toBe(true);
    const files = run.steps.filter((s) => s.artifact).map((s) => s.artifact!.filename);
    expect(files).toContain('p.dxf');
    expect(files).toContain('p-summary.txt');
    expect(run.doc.properties.Revision).toBe('B');
    expect(run.doc.properties.Status).toBe('Released');
  });

  it('every shipped recipe runs without throwing', () => {
    for (const r of STARTER_RECIPES) {
      const run = runRecipe(r, part(), {}, { dryRun: true });
      expect(run.steps).toHaveLength(r.steps.length);
      // Whether it passes depends on the part; what matters is it never explodes.
      expect(typeof run.ok).toBe('boolean');
    }
  });

  it('mass assertion reads the real evaluated mass', () => {
    const d = part();
    const actual = massGrams(d, evaluate(d));

    const pass: Recipe = {
      id: 't', name: 't', version: '1', description: '', failurePolicy: 'stop', inputs: [],
      steps: [{ kind: 'assertMassBelow', grams: actual + 1 }],
    };
    const fail: Recipe = { ...pass, steps: [{ kind: 'assertMassBelow', grams: actual - 1 }] };

    expect(runRecipe(pass, d).ok).toBe(true);
    expect(runRecipe(fail, d).ok).toBe(false);
  });
});

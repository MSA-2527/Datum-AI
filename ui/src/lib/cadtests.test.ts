import { describe, expect, it } from 'vitest';
import { proposeRepair, runSuite, suiteFor } from './cadtests';
import { createFeature, setGlobal, type PartDoc } from './partModel';
import type { Plan } from '../types';

/**
 * Verification-suite tests.
 *
 * This is the layer that decides whether a plan is allowed to stand, so its own failure
 * modes matter more than most. The critical assertion is that a bad plan FAILS — a
 * verifier that passes everything gives false assurance, which is worse than none.
 */

function doc(): PartDoc {
  return {
    path: 'C:\\test\\plate.SLDPRT',
    title: 'plate.SLDPRT',
    configuration: 'Default',
    configurations: ['Default'],
    units: 'mm',
    material: '6061-T6',
    density: 2.7,
    writable: true,
    lastRebuildMs: 100,
    globals: [
      { name: 'Length', value: 100, units: 'mm' },
      { name: 'Width', value: 50, units: 'mm' },
      { name: 'Thickness', value: 10, units: 'mm' },
      { name: 'BoltCircle', value: 40, units: 'mm' },
    ],
    properties: { PartNo: 'P-1', Revision: 'A', Description: 'Test' },
    features: [],
  };
}

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: 'pln_test',
    irVersion: '1.4',
    target: { docPath: 'C:\\test\\plate.SLDPRT' },
    intent: 'test',
    assumptions: [],
    ops: [],
    verify: [],
    undo: { groupName: 'test', snapshot: true },
    ...overrides,
  };
}

describe('suite derivation', () => {
  it('always asserts the invariants, even for an empty plan', () => {
    const ids = suiteFor(plan()).map((t) => t.id);
    expect(ids).toContain('rebuild_errors');
    expect(ids).toContain('holes_inside_outline');
    expect(ids).toContain('no_dfm_blockers');
  });

  it('requires geometry-creating plans to actually create geometry', () => {
    const p = plan({ ops: [{ id: 'op1', op: 'feature.fillet', params: { radius: 3 } }] });
    const t = suiteFor(p).find((x) => x.id === 'feature_added');
    expect(t).toBeDefined();
    expect(t!.required).toBe(true);
  });

  it('picks up declared checks from the plan', () => {
    const p = plan({ verify: [{ check: 'mass_delta_pct', max: 5 }] });
    expect(suiteFor(p).some((t) => t.id === 'mass_delta_pct')).toBe(true);
  });
});

describe('suite execution', () => {
  it('passes a clean edit', () => {
    const before = doc();
    const after = createFeature(before, 'fillet', { radius: 3 });
    const p = plan({ ops: [{ id: 'op1', op: 'feature.fillet', params: { radius: 3 } }] });

    const outcome = runSuite(p, { before, after, plan: p });
    expect(outcome.passed).toBe(true);
    expect(outcome.score).toBe(1);
  });

  it('fails when a plan claims to add geometry but adds none', () => {
    const before = doc();
    const p = plan({ ops: [{ id: 'op1', op: 'feature.fillet', params: { radius: 3 } }] });

    // after === before: the executor produced nothing.
    const outcome = runSuite(p, { before, after: before, plan: p });
    expect(outcome.passed).toBe(false);
    expect(outcome.blocking.length).toBeGreaterThan(0);
  });

  it('fails when holes are driven outside the outline', () => {
    const before = doc();
    let after = createFeature(before, 'holePattern', { diameter: 5, boltCircleVar: 'BoltCircle' });
    after = setGlobal(after, 'BoltCircle', 300); // far outside a 100×50 plate

    const p = plan({ ops: [{ id: 'op1', op: 'feature.hole_wizard', params: {} }] });
    const outcome = runSuite(p, { before, after, plan: p });

    expect(outcome.passed).toBe(false);
    expect(outcome.blocking.some((b) => /hole/i.test(b.check))).toBe(true);
  });

  it('enforces a declared mass-delta limit', () => {
    const before = doc();
    // Removing a huge pocket blows well past a 1% budget.
    const after = createFeature(before, 'pocket', { width: 80, height: 40 });
    const p = plan({
      ops: [{ id: 'op1', op: 'feature.extrude_cut', params: {} }],
      verify: [{ check: 'mass_delta_pct', max: 1 }],
    });

    const outcome = runSuite(p, { before, after, plan: p });
    expect(outcome.passed).toBe(false);
  });

  it('reports a partial score rather than a bare boolean', () => {
    const before = doc();
    const p = plan({ ops: [{ id: 'op1', op: 'feature.fillet', params: {} }] });
    const outcome = runSuite(p, { before, after: before, plan: p });
    expect(outcome.score).toBeGreaterThan(0);
    expect(outcome.score).toBeLessThan(1);
  });
});

describe('self-repair', () => {
  it('proposes widening the plate when holes breach the edge', () => {
    const before = doc();
    let after = createFeature(before, 'holePattern', { diameter: 6, boltCircleVar: 'BoltCircle' });
    after = setGlobal(after, 'BoltCircle', 46); // 50-wide plate, holes at ±23

    const p = plan({ ops: [{ id: 'op1', op: 'feature.hole_wizard', params: {} }] });
    const outcome = runSuite(p, { before, after, plan: p });
    expect(outcome.passed).toBe(false);

    const fix = proposeRepair(outcome, after);
    expect(fix).not.toBeNull();
    // Either open the plate up or pull the pattern in — both are legitimate.
    expect(Object.keys(fix!.globals).some((k) => k === 'Width' || k === 'BoltCircle')).toBe(true);
    expect(fix!.reason).toBeTruthy();
  });

  it('actually resolves the failure it diagnosed', () => {
    const before = doc();
    let after = createFeature(before, 'holePattern', { diameter: 6, boltCircleVar: 'BoltCircle' });
    after = setGlobal(after, 'BoltCircle', 46);

    const p = plan({ ops: [{ id: 'op1', op: 'feature.hole_wizard', params: {} }] });
    let outcome = runSuite(p, { before, after, plan: p });

    const fix = proposeRepair(outcome, after)!;
    let repaired = after;
    for (const [k, v] of Object.entries(fix.globals)) repaired = setGlobal(repaired, k, v);

    outcome = runSuite(p, { before, after: repaired, plan: p });
    expect(outcome.passed).toBe(true);
  });

  it('returns null when it has no honest fix, rather than guessing', () => {
    const before = doc();
    const p = plan({ ops: [{ id: 'op1', op: 'feature.fillet', params: {} }] });
    const outcome = runSuite(p, { before, after: before, plan: p });

    // "You said you would add geometry and did not" has no parametric remedy.
    expect(proposeRepair(outcome, before)).toBeNull();
  });
});

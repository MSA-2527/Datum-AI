import { analyseDfm } from './dfm';
import { evaluate, massGrams, type PartDoc } from './partModel';
import type { Plan, VerifyResult } from '../types';

/**
 * CADTests — executable assertions over the produced model.
 *
 * The 2026 text-to-CAD literature converged on test-based evaluation (CADTestBench,
 * BenchCAD, Text2CAD-Bench) for one reason: compilation success and visual similarity
 * both fail to catch a model that is subtly wrong. What distinguishes a usable result is
 * whether it satisfies stated geometric and topological requirements.
 *
 * No shipping CAD copilot runs assertions against its own output. This is where DATUM
 * differs: every plan carries tests, the tests execute after apply, and a failure rolls
 * the model back rather than leaving the engineer to discover it at the machine.
 *
 * Tests are pure functions of the document, so they are equally valid as an acceptance
 * gate here and as a scoring harness in the evaluation runner.
 */

export type TestId =
  | 'rebuild_errors'
  | 'mass_delta_pct'
  | 'mass_between'
  | 'no_interference'
  | 'hole_count'
  | 'holes_inside_outline'
  | 'min_wall'
  | 'envelope_fits'
  | 'no_dfm_blockers'
  | 'fully_defined'
  | 'no_fragile_refs'
  | 'feature_added';

export interface CadTest {
  id: TestId;
  /** Human sentence shown in the result card. */
  label: string;
  params?: Record<string, number | string>;
  /** A failed required test rolls the plan back; an advisory one only reports. */
  required: boolean;
}

export interface TestContext {
  before: PartDoc;
  after: PartDoc;
  plan: Plan;
}

/**
 * Derives the test suite for a plan: the assertions the planner declared, plus the
 * invariants that apply to every plan whether it asked for them or not.
 */
export function suiteFor(plan: Plan): CadTest[] {
  const tests: CadTest[] = [
    { id: 'rebuild_errors', label: 'No new rebuild errors', required: true },
    { id: 'holes_inside_outline', label: 'Every hole lies inside the part outline', required: true },
    { id: 'no_dfm_blockers', label: 'No manufacturability blockers introduced', required: true },
  ];

  for (const v of plan.verify) {
    switch (v.check) {
      case 'mass_delta_pct':
        tests.push({
          id: 'mass_delta_pct',
          label: `Mass change within ${v.max ?? 100}%`,
          params: { max: v.max ?? 100 },
          required: true,
        });
        break;
      case 'no_interference':
        tests.push({ id: 'no_interference', label: 'No interference', required: true });
        break;
      default:
        break;
    }
  }

  // Plans that create geometry must actually create it. This catches the failure mode
  // where a planner emits a syntactically valid plan that resolves to nothing.
  const creates = plan.ops.filter(
    (o) => o.op.startsWith('feature.') && !o.op.startsWith('feature.edit.'),
  );
  if (creates.length > 0) {
    tests.push({
      id: 'feature_added',
      label: `${creates.length} feature${creates.length === 1 ? '' : 's'} added to the tree`,
      params: { expected: creates.length },
      required: true,
    });
  }

  const holeOps = plan.ops.filter((o) => o.op === 'feature.hole_wizard' || o.op === 'feature.simple_hole');
  if (holeOps.length > 0) {
    tests.push({ id: 'min_wall', label: 'Adequate wall beside every hole', required: false });
  }

  // Repair plans assert the thing they claim to repair.
  if (plan.ops.some((o) => o.op === 'sketch.fully_define' || o.op === 'sketch.add_relation')) {
    tests.push({ id: 'fully_defined', label: 'All sketches fully defined', required: true });
  }
  if (plan.ops.some((o) => o.op === 'feature.edit.reattach_reference')) {
    tests.push({ id: 'no_fragile_refs', label: 'No fragile face references remain', required: true });
  }

  return tests;
}

export function runTest(test: CadTest, ctx: TestContext): VerifyResult {
  const { before, after } = ctx;
  const gBefore = evaluate(before);
  const gAfter = evaluate(after);

  switch (test.id) {
    case 'rebuild_errors': {
      const b = countErrors(before);
      const a = countErrors(after);
      return result(test, a <= b, `${b} → ${a}`);
    }

    case 'mass_delta_pct': {
      const mb = massGrams(before, gBefore);
      const ma = massGrams(after, gAfter);
      const pct = Math.abs(mb) < 1e-9 ? 0 : Math.abs((ma - mb) / mb) * 100;
      const max = Number(test.params?.max ?? 100);
      return result(test, pct <= max, `${pct.toFixed(1)}% (limit ${max}%)`);
    }

    case 'mass_between': {
      const m = massGrams(after, gAfter);
      const lo = Number(test.params?.min ?? 0);
      const hi = Number(test.params?.max ?? Infinity);
      return result(test, m >= lo && m <= hi, `${m.toFixed(1)} g`);
    }

    case 'holes_inside_outline': {
      const bad = gAfter.holes.filter(
        (h) =>
          Math.abs(h.x) + h.d / 2 > gAfter.L / 2 || Math.abs(h.y) + h.d / 2 > gAfter.W / 2,
      );
      return result(
        test,
        bad.length === 0,
        bad.length === 0 ? `${gAfter.holes.length} checked` : `${bad.length} breach the edge`,
      );
    }

    case 'min_wall': {
      if (gAfter.holes.length === 0) return result(test, true, 'no holes');
      const worst = Math.min(
        ...gAfter.holes.map((h) =>
          Math.min(gAfter.L / 2 - Math.abs(h.x) - h.d / 2, gAfter.W / 2 - Math.abs(h.y) - h.d / 2),
        ),
      );
      const required = Math.max(...gAfter.holes.map((h) => h.d * 0.5));
      return result(test, worst >= required, `${worst.toFixed(1)} mm min (need ${required.toFixed(1)})`);
    }

    case 'envelope_fits': {
      const lim = [
        Number(test.params?.x ?? Infinity),
        Number(test.params?.y ?? Infinity),
        Number(test.params?.z ?? Infinity),
      ];
      const ok = gAfter.L <= lim[0]! && gAfter.W <= lim[1]! && gAfter.T <= lim[2]!;
      return result(test, ok, `${gAfter.L}×${gAfter.W}×${gAfter.T} mm`);
    }

    case 'no_dfm_blockers': {
      const bBlockers = analyseDfm(before, gBefore).filter((f) => f.severity === 'blocker').length;
      const aBlockers = analyseDfm(after, gAfter).filter((f) => f.severity === 'blocker').length;
      return result(test, aBlockers <= bBlockers, `${bBlockers} → ${aBlockers}`);
    }

    case 'hole_count': {
      const expected = Number(test.params?.expected ?? 0);
      return result(test, gAfter.holes.length === expected, `${gAfter.holes.length} of ${expected}`);
    }

    case 'feature_added': {
      const added = after.features.length - before.features.length;
      const expected = Number(test.params?.expected ?? 1);
      return result(test, added >= expected, `${added} added, expected ${expected}`);
    }

    case 'fully_defined': {
      const n = after.features.filter((f) => f.underDefined).length;
      return result(test, n === 0, n === 0 ? 'all defined' : `${n} still under-defined`);
    }

    case 'no_fragile_refs': {
      const n = after.features.filter((f) => f.fragileRef).length;
      return result(test, n === 0, n === 0 ? 'none' : `${n} remaining`);
    }

    case 'no_interference':
      // Single-part documents cannot self-interfere; the assembly path evaluates this
      // through the kernel's interference detection manager.
      return result(test, true, 'not applicable to a part');

    default:
      return { check: test.id, ok: true, detail: 'not evaluated' };
  }
}

function result(test: CadTest, ok: boolean, detail: string): VerifyResult {
  return { check: test.label, ok, detail };
}

function countErrors(doc: PartDoc): number {
  return doc.features.filter((f) => (f.errorCode ?? 0) !== 0).length;
}

export interface SuiteOutcome {
  results: VerifyResult[];
  passed: boolean;
  /** Tests that failed and are required — these are what force a rollback. */
  blocking: VerifyResult[];
  /**
   * Machine ids of the blocking failures.
   *
   * VerifyResult.check carries the human label because it is rendered straight into the
   * result card, so the repair loop cannot match on it. Carrying the ids alongside keeps
   * the card readable and the diagnosis reliable — matching on display text silently
   * disabled self-repair once already.
   */
  blockingIds: TestId[];
  score: number;
}

export function runSuite(plan: Plan, ctx: TestContext): SuiteOutcome {
  const tests = suiteFor(plan);
  const results = tests.map((t) => runTest(t, ctx));

  const blocking: VerifyResult[] = [];
  const blockingIds: TestId[] = [];
  results.forEach((r, i) => {
    if (!r.ok && tests[i]!.required) {
      blocking.push(r);
      blockingIds.push(tests[i]!.id);
    }
  });

  const passedCount = results.filter((r) => r.ok).length;

  return {
    results,
    passed: blocking.length === 0,
    blocking,
    blockingIds,
    score: results.length === 0 ? 1 : passedCount / results.length,
  };
}

// ── repair ───────────────────────────────────────────────────────────────────

export interface RepairProposal {
  reason: string;
  /** Parameter nudges that would satisfy the failing test. */
  globals: Record<string, number>;
}

/**
 * Diagnoses a failing suite and proposes a concrete correction.
 *
 * This is the self-repair loop's brain, and it is deliberately deterministic: a repair
 * derived from geometry is reproducible and explainable, whereas asking a model to guess
 * again produces a different wrong answer at random. The planner is only consulted when
 * the failure is not one of these known shapes.
 */
export function proposeRepair(outcome: SuiteOutcome, after: PartDoc): RepairProposal | null {
  const geom = evaluate(after);

  for (const failId of outcome.blockingIds) {
    if (failId === 'holes_inside_outline' || failId === 'min_wall') {
      // Widen the plate just enough to give every hole its required edge distance.
      const needed = Math.max(
        ...geom.holes.map((h) => (Math.abs(h.y) + h.d) * 2),
        geom.W,
      );
      const rounded = Math.ceil(needed / 0.5) * 0.5;
      if (rounded > geom.W) {
        return {
          reason: `Holes need ${(rounded - geom.W).toFixed(1)} mm more width to keep a half-diameter wall.`,
          globals: { Width: rounded },
        };
      }

      // If width is not the constraint, pull the bolt circle in instead.
      const maxBc = Math.min(geom.L, geom.W) - 4 * (geom.holes[0]?.d ?? 3.4);
      if (maxBc > 0) {
        return {
          reason: `Bolt circle reduced to ${maxBc.toFixed(1)} mm so the pattern clears the edge.`,
          globals: { BoltCircle: Math.floor(maxBc * 2) / 2 },
        };
      }
    }

    if (failId === 'no_dfm_blockers') {
      const blockers = analyseDfm(after, geom).filter((f) => f.severity === 'blocker');
      const deep = blockers.find((b) => b.rule === 'dfm.drill.depth-ratio');
      if (deep) {
        const target = Math.max(3, Math.ceil(geom.T / 8));
        return {
          reason: `Thickness reduced to ${target} mm to bring the hole depth ratio under 8:1.`,
          globals: { Thickness: target },
        };
      }
    }
  }

  return null;
}

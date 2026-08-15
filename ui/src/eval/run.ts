import { decompose } from '../ai/decompose';
import { critique } from '../ai/critique';
import { evaluateDocument } from '../model/document';
import { bounds, triCount } from '../kernel/topo/mesh';
import { type EvalCase } from './cases';

/**
 * The scoring runner.
 *
 * Two jobs, and keeping them apart is what makes the number worth publishing.
 *
 * It **runs a request the way the product runs it** — through `decompose`, the same entry the
 * composer uses — rather than through a shortcut that exercises the archetype directly. A
 * harness that bypasses the routing measures the kernel and reports it as a measure of the
 * system, which is how a benchmark ends up flattering the thing it tests.
 *
 * And it **reports every check, not a verdict**. "7/9 passed" tells you nothing you can act
 * on; "the bicycle is 340 mm tall where a bicycle is 1050 mm" tells you the wheels are lying
 * flat. A regression gate that cannot say what broke gets suppressed the first busy week.
 */

export interface Check {
  name: string;
  ok: boolean;
  /** What was expected and what happened, in one line. Present whether it passed or not. */
  detail: string;
}

export interface CaseResult {
  id: string;
  prompt: string;
  passed: boolean;
  checks: Check[];
  ms: number;
}

export interface Report {
  results: CaseResult[];
  passed: number;
  total: number;
  /** Fraction of *checks* passed, not of cases — a case failing one check of six is not a zero. */
  score: number;
  ms: number;
}

const ok = (name: string, detail: string): Check => ({ name, ok: true, detail });
const bad = (name: string, detail: string): Check => ({ name, ok: false, detail });

/** Within a fractional tolerance of a target. */
function near(actual: number, target: number, tol: number): boolean {
  if (target === 0) return Math.abs(actual) <= tol;
  return Math.abs(actual - target) / Math.abs(target) <= tol;
}

export async function runCase(testCase: EvalCase): Promise<CaseResult> {
  const started = Date.now();
  const checks: Check[] = [];

  const result = await decompose(testCase.prompt, {
    // No model. The deterministic routes are what CI can score without a key, a network or
    // run-to-run variance, and they are also the free tier — so this is the number that
    // describes what every user gets.
    config: { id: 'none', model: '', apiKey: '', allowWebSearch: false },
  });

  const expect = testCase.expect;

  // ── did it build at all ──
  if (!expect.builds) {
    // A refusal case. Getting geometry here is the failure: approximating an unbuildable
    // request with the nearest archetype hands someone a part that is not what they asked for.
    checks.push(result.ok
      ? bad('refuses', 'produced geometry for a request nothing in the catalogue covers')
      : ok('refuses', `refused: ${result.message.slice(0, 80)}`));

    return finish(testCase, checks, started);
  }

  if (!result.ok) {
    checks.push(bad('builds', `refused: ${result.message.slice(0, 120)}`));
    return finish(testCase, checks, started);
  }
  checks.push(ok('builds', `built via the ${result.route} route`));

  const evaluated = evaluateDocument(result.doc);

  if (triCount(evaluated.mesh) === 0) {
    checks.push(bad('geometry', 'the plan resolved to no geometry at all'));
    return finish(testCase, checks, started);
  }

  // ── physical invariants ──
  if (expect.closed !== undefined) {
    checks.push(evaluated.health.closed === expect.closed
      ? ok('closed', `solid is ${evaluated.health.closed ? 'watertight' : 'open'}, as expected`)
      : bad('closed', `${evaluated.health.boundaryEdges} open edges; volume and mass cannot be trusted`));
  }

  if (expect.components) {
    const [lo, hi] = expect.components;
    const n = result.doc.features.length;
    checks.push(n >= lo && n <= hi
      ? ok('components', `${n} components, within ${lo}–${hi}`)
      : bad('components', `${n} components, outside ${lo}–${hi}`));
  }

  // ── published and stated figures ──
  if (expect.sizeMm) {
    const b = bounds(evaluated.mesh);
    const actual = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
      .sort((x, y) => y - x);
    const target = [...expect.sizeMm].sort((x, y) => y - x);
    const tol = expect.sizeTol ?? 0.05;

    const agrees = actual.every((v, i) => near(v, target[i]!, tol));
    const shown = `${actual.map((v) => v.toFixed(1)).join(' × ')} mm`;
    const wanted = `${target.map((v) => v.toFixed(1)).join(' × ')} mm ±${(tol * 100).toFixed(0)}%`;

    checks.push(agrees
      ? ok('size', `${shown}, within ${wanted}`)
      : bad('size', `${shown}, expected ${wanted}`));
  }

  if (expect.largestMm !== undefined) {
    const b = bounds(evaluated.mesh);
    const largest = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    const tol = expect.sizeTol ?? 0.05;

    checks.push(near(largest, expect.largestMm, tol)
      ? ok('overall', `${largest.toFixed(1)} mm, within ${expect.largestMm} mm ±${(tol * 100).toFixed(0)}%`)
      : bad('overall', `${largest.toFixed(1)} mm, expected ${expect.largestMm} mm ±${(tol * 100).toFixed(0)}%`));
  }

  if (expect.massG) {
    const [lo, hi] = expect.massG;
    const mass = evaluated.massGrams;
    checks.push(mass >= lo && mass <= hi
      ? ok('mass', `${mass.toFixed(0)} g, within ${lo}–${hi} g`)
      : bad('mass', `${mass.toFixed(0)} g, outside ${lo}–${hi} g`));
  }

  // ── the inspection the product runs on itself ──
  if (expect.noCritiqueErrors) {
    const errors = result.plan ? critique(result.plan).filter((c) => c.severity === 'error') : [];
    checks.push(errors.length === 0
      ? ok('inspection', 'no errors found by the geometric inspection')
      : bad('inspection', `${errors.length} errors: ${errors.slice(0, 2).map((e) => e.message).join('; ')}`));
  }

  return finish(testCase, checks, started);
}

function finish(testCase: EvalCase, checks: Check[], started: number): CaseResult {
  return {
    id: testCase.id,
    prompt: testCase.prompt,
    passed: checks.every((c) => c.ok),
    checks,
    ms: Date.now() - started,
  };
}

export async function runAll(cases: EvalCase[]): Promise<Report> {
  const started = Date.now();
  const results: CaseResult[] = [];

  // Sequential rather than parallel. The kernel is CPU-bound and the timings are part of the
  // report; running eight at once measures the machine's core count.
  for (const testCase of cases) results.push(await runCase(testCase));

  const allChecks = results.flatMap((r) => r.checks);

  return {
    results,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    score: allChecks.length === 0 ? 0 : allChecks.filter((c) => c.ok).length / allChecks.length,
    ms: Date.now() - started,
  };
}

/** The report as a terminal table. Failures are printed in full; passes are one line. */
export function formatReport(report: Report): string {
  const lines: string[] = [
    '',
    'DATUM evaluation — deterministic routes, no model configured',
    '─'.repeat(72),
  ];

  for (const result of report.results) {
    const failed = result.checks.filter((c) => !c.ok);
    lines.push(
      `${failed.length === 0 ? 'PASS' : 'FAIL'}  ${result.id.padEnd(16)} ` +
      `${String(result.ms).padStart(6)} ms  ${result.prompt}`,
    );
    // Only failures are expanded. A report where every line is expanded is a report nobody
    // reads to the end, and the point of it is to make the failures obvious.
    for (const check of failed) lines.push(`        ${check.name}: ${check.detail}`);
  }

  lines.push('─'.repeat(72));
  lines.push(
    `${report.passed}/${report.total} cases, ` +
    `${(report.score * 100).toFixed(1)}% of checks, in ${(report.ms / 1000).toFixed(1)} s`,
  );
  lines.push('');

  return lines.join('\n');
}

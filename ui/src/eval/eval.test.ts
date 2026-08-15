import { describe, expect, it } from 'vitest';
import baseline from './baseline.json';
import { CASES, deterministicCases } from './cases';
import { formatReport, runAll, runCase, type Report } from './run';

/**
 * The regression gate.
 *
 * This is the piece that makes the benchmark worth having. A score printed on demand tells
 * you how the system is today; a score checked against a committed baseline on every build
 * tells you the moment it stops being that — which is the only version of the number anyone
 * acts on.
 *
 * Two rules, and the asymmetry between them is deliberate:
 *
 *   - a case that passed in the baseline and fails now **breaks the build**, by name;
 *   - a case that failed and now passes does not, but the baseline is expected to be raised.
 *
 * The baseline may be raised freely and must never be lowered to make a build green. Lowering
 * it is how a suite becomes a record of what the product used to do.
 *
 * Runs offline with no model configured, so it costs nothing, needs no key, and returns the
 * same answer twice. A benchmark that needs a paid API is a benchmark that gets skipped in CI
 * and then rots.
 */

type Baseline = { score: number; cases: Record<string, boolean> };
const base = baseline as unknown as Baseline;

let cached: Report | null = null;
const report = async (): Promise<Report> => (cached ??= await runAll(deterministicCases()));

describe('the deterministic benchmark', () => {
  it('has a baseline entry for every case', async () => {
    // Adding a case without recording it would let it fail silently forever, which is the
    // failure mode of every benchmark that has ever quietly stopped meaning anything.
    const missing = CASES.filter((c) => c.deterministic && !(c.id in base.cases)).map((c) => c.id);
    expect(missing, 'add these to baseline.json').toEqual([]);
  }, 120_000);

  it('states the basis for every expectation', () => {
    // A number nobody can justify is a number that gets re-baselined the first time it fails.
    for (const c of CASES) expect(c.basis.length, c.id).toBeGreaterThan(40);
  });

  it('has not regressed against the committed baseline', async () => {
    const result = await report();
    const now = new Map(result.results.map((r) => [r.id, r.passed]));

    const regressed = Object.entries(base.cases)
      .filter(([id, wasPassing]) => wasPassing && now.get(id) === false)
      .map(([id]) => {
        const failed = result.results.find((r) => r.id === id)!.checks.filter((c) => !c.ok);
        return `${id}: ${failed.map((c) => `${c.name} — ${c.detail}`).join('; ')}`;
      });

    // Printed in full on failure. A gate that says only "score dropped" is a gate people
    // disable rather than diagnose.
    if (regressed.length > 0) console.log(formatReport(result));
    expect(regressed).toEqual([]);
  }, 120_000);

  it('scores at least as well as the baseline', async () => {
    const result = await report();
    expect(result.score).toBeGreaterThanOrEqual(base.score);
  }, 120_000);
});

describe('the gate itself can fail', () => {
  /*
   * A benchmark that cannot go red is decoration. These run the real runner against
   * expectations that are deliberately wrong, and assert it notices — so a future change that
   * accidentally makes every check pass (a swallowed exception, a check that reads the wrong
   * field) is caught by the suite rather than celebrated as a perfect score.
   */

  it('catches a part that is the wrong size', async () => {
    const result = await runCase({
      id: 'wrong-size', prompt: '200 x 120 x 8 plate', deterministic: true,
      basis: 'Deliberately wrong, to prove the size check can fail.',
      expect: { builds: true, sizeMm: [50, 50, 50], sizeTol: 0.02 },
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === 'size')?.detail).toContain('expected');
  }, 60_000);

  it('catches a part that weighs the wrong amount', async () => {
    const result = await runCase({
      id: 'wrong-mass', prompt: 'make a cup', deterministic: true,
      basis: 'Deliberately wrong, to prove the mass check can fail.',
      expect: { builds: true, massG: [1, 2] },
    });

    expect(result.passed).toBe(false);
  }, 60_000);

  it('catches an assembly returned as too few parts', async () => {
    const result = await runCase({
      id: 'too-few', prompt: 'a phone', deterministic: true,
      basis: 'Deliberately wrong, to prove the component-count check can fail.',
      expect: { builds: true, components: [400, 500] },
    });

    expect(result.passed).toBe(false);
  }, 60_000);

  it('catches a request that was refused when it should have built', async () => {
    const result = await runCase({
      id: 'should-build', prompt: 'a hydroformed titanium turbine volute', deterministic: true,
      basis: 'Deliberately wrong, to prove a refusal is not mistaken for a pass.',
      expect: { builds: true, closed: true },
    });

    expect(result.passed).toBe(false);
    expect(result.checks[0]!.detail).toContain('refused');
  }, 60_000);

  it('catches geometry produced for a request that should have been refused', async () => {
    const result = await runCase({
      id: 'should-refuse', prompt: 'make a cup', deterministic: true,
      basis: 'Deliberately wrong, to prove the refusal check is not vacuous.',
      expect: { builds: false },
    });

    expect(result.passed).toBe(false);
  }, 60_000);
});

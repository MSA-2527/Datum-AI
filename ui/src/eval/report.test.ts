import { it } from 'vitest';
import { deterministicCases } from './cases';
import { formatReport, runAll } from './run';

/**
 * `npm run eval` — the readable report.
 *
 * A test file rather than a script because the harness imports the kernel, which is TypeScript
 * with a WASM dependency the vitest setup already loads. A standalone node script would need
 * its own build step and its own copy of that setup, and would then be a second way to run the
 * same code that could drift from the first.
 *
 * It asserts nothing. `eval.test.ts` is the gate; this prints the number a person asks for,
 * and is excluded from the ordinary suite so it does not print a table on every commit.
 */
it('evaluation report', async () => {
  console.log(formatReport(await runAll(deterministicCases())));
}, 300_000);

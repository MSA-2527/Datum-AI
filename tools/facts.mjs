#!/usr/bin/env node
/**
 * Regenerates `docs/FACTS.md` — every figure this project states about itself, counted.
 *
 * Run it with `npm --prefix ui run facts`. CI runs the same command and fails if the file
 * changes, so a figure can never be stale by more than one commit.
 *
 * ── Why a generated file ──
 *
 * Five documents here once stated five different sets of figures: 451 tests, 627 tests, 1,549
 * cases; 15 archetypes, 27, 54; 16 constraint types, 17, 22. Every one was true when it was
 * typed. A number kept by hand beside the thing it describes is a number that drifts, and in a
 * technical review a stale count is not read as staleness — it reads as a claim that did not
 * survive checking, which puts every other claim in the document in question.
 *
 * The counts that can be taken from the running code are asserted continuously by
 * `ui/src/lib/facts.test.ts`. The two that cannot — how many tests there are, and how much
 * code — need the suite to run and the tree to be walked, so they are produced here.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'ui', 'src');

/** Lines of TypeScript, split by whether they are the product or the tests of it. */
function countLines() {
  let product = 0;
  let tests = 0;
  let files = 0;

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        walk(path);
        continue;
      }

      if (!['.ts', '.tsx'].includes(extname(entry))) continue;

      const lines = readFileSync(path, 'utf8').split('\n').length;
      files += 1;
      if (entry.includes('.test.')) tests += lines;
      else product += lines;
    }
  };

  walk(src);
  return { product, tests, files };
}

/**
 * How many tests there are, taken from the runner rather than from a grep.
 *
 * Counting `it(` in the source is wrong in both directions: `it.each` is one call and many
 * tests, and a skipped test is a line that never runs. The runner is the only thing that
 * knows.
 */
function countTests() {
  // Vitest's own entry point through this Node, rather than through npx: spawning a .cmd
  // shim needs a shell on Windows, and a shell is a portability problem nobody needs here.
  const out = execFileSync(
    process.execPath,
    [join(root, 'ui', 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--reporter=basic'],
    { cwd: join(root, 'ui'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  const stripped = out.replace(/\[[0-9;]*m/g, '');
  const tests = /Tests\s+(\d+) passed/.exec(stripped);
  const files = /Test Files\s+(\d+) passed/.exec(stripped);

  if (!tests || !files) throw new Error('could not read the test count from the runner output');
  return { tests: Number(tests[1]), files: Number(files[1]) };
}

/** The counts the product itself can report, read out of the source it runs on. */
function countFromSource() {
  const read = (rel) => readFileSync(join(src, rel), 'utf8');
  const ids = (text) => new Set([...text.matchAll(/^\s*id: '([a-zA-Z0-9_-]+)'/gm)].map((m) => m[1]));

  const constraints = /export const CONSTRAINT_KINDS = \[([\s\S]*?)\] as const;/
    .exec(read('kernel/sketch/solver.ts'));

  const features = /export const KINDS[\s\S]*?= \[([\s\S]*?)\n\];/.exec(read('components/ModelTree.tsx'));
  const cases = read('eval/cases.ts');

  return {
    archetypes: ids(read('generate/archetypes.ts')).size,
    recipes: ids(read('assembly/recipes.ts')).size,
    constraintKinds: (constraints?.[1].match(/'[a-zA-Z]+',/g) ?? []).length,
    featureKinds: (features?.[1].match(/kind: '/g) ?? []).length,
    evalCases: (cases.match(/^\s{4}id: '/gm) ?? []).length,
  };
}

const lines = countLines();
const source = countFromSource();
const suite = countTests();

const stamp = new Date().toISOString().slice(0, 10);

const body = `# What DATUM contains, counted

<!--
  GENERATED. Do not edit by hand.
  Run \`npm --prefix ui run facts\` to regenerate; CI fails if this file is out of date.

  Every figure any document in this repository states about the product is derived here, from
  the code itself. Nothing in this file is maintained by a person.
-->

Counted on ${stamp}, from the source as committed.

## The product

| | Count |
|---|---|
| Parametric archetypes | ${source.archetypes} |
| Assembly recipes | ${source.recipes} |
| Sketch constraint types | ${source.constraintKinds} |
| Modelling features | ${source.featureKinds} |
| TypeScript files | ${lines.files} |
| Lines of product code | ${lines.product.toLocaleString('en-GB')} |

## The evidence

| | Count |
|---|---|
| Tests | ${suite.tests.toLocaleString('en-GB')} |
| Test files | ${suite.files} |
| Lines of test code | ${lines.tests.toLocaleString('en-GB')} |
| Benchmark cases | ${source.evalCases} |

Tests are counted by the runner, not by grepping for \`it(\` — \`it.each\` is one call and many
tests, and a skipped test is a line that never runs.

The benchmark is separate from the test suite on purpose. A test asserts that a function does
what it was written to do; a benchmark case asserts that a *request* produces the right object,
against a figure defensible without running the product — a physical invariant, or a published
standard. Cases that assert a **refusal** are counted here too: declining a request nothing can
build correctly is a result, and it is measured like any other.
`;

writeFileSync(join(root, 'docs', 'FACTS.md'), body);

console.log(`docs/FACTS.md written — ${source.archetypes} archetypes, ${source.recipes} recipes, ` +
  `${source.constraintKinds} constraints, ${source.featureKinds} features, ` +
  `${suite.tests} tests, ${source.evalCases} benchmark cases, ` +
  `${lines.product.toLocaleString('en-GB')} lines of product code.`);

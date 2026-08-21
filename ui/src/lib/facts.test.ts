import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { facts, staleClaims } from './facts';

/**
 * Documentation that cannot drift from the code.
 *
 * A stale count in a technical document is not read as staleness. It is read as a claim that
 * did not survive checking, and it puts every other claim in the document in question — which
 * is expensive out of all proportion to the mistake.
 *
 * So every figure a document is allowed to state is derived here from the arrays the product
 * runs on, and stating a different one fails the build. The fix when this test fails is never
 * to edit the number in the test; it is to edit the document, or to accept that the product
 * changed.
 */

const root = join(__dirname, '..', '..', '..');

const documents = [
  'README.md',
  'docs/07-status-report.md',
  'docs/ROADMAP.md',
  'docs/MANUAL.md',
];

describe('the counts the code reports', () => {
  it('are all positive, so a broken import cannot pass as zero', () => {
    for (const [name, value] of Object.entries(facts())) {
      expect(value, `${name} counted ${value}`).toBeGreaterThan(0);
    }
  });

  it('match what the code actually holds', () => {
    const f = facts();

    // Not hard-coded expectations — a spot check that the arrays being counted are the ones
    // that matter, so a refactor that empties one is caught here rather than in a document.
    expect(f.archetypes).toBeGreaterThanOrEqual(20);
    expect(f.recipes).toBeGreaterThanOrEqual(8);
    expect(f.constraintKinds).toBeGreaterThanOrEqual(16);
    expect(f.featureKinds).toBeGreaterThanOrEqual(20);
    expect(f.evalCases).toBeGreaterThanOrEqual(22);
  });
});

describe('every document states the truth', () => {
  it.each(documents)('%s has no stale count', (name) => {
    let text: string;
    try {
      text = readFileSync(join(root, name), 'utf8');
    } catch {
      // A document that has been renamed or removed is not a failure of this test.
      return;
    }

    const stale = staleClaims(text);
    const report = stale
      .map((s) => `${name} says ${s.stated} ${s.label}; the code has ${s.actual}`)
      .join('\n');

    expect(stale, report).toEqual([]);
  });
});

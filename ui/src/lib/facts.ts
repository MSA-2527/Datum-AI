import { ARCHETYPES } from '../generate/archetypes';
import { RECIPES } from '../assembly/recipes';
import { CONSTRAINT_KINDS } from '../kernel/sketch/solver';
import { CASES } from '../eval/cases';
import { KINDS as FEATURE_KINDS } from '../components/ModelTree';

/**
 * What the product actually contains, counted from the code.
 *
 * ── Why this exists ──
 *
 * Five documents in this repository stated five different sets of figures. The README claimed
 * 451 tests and 16 constraint types; the status report claimed 627 tests; the roadmap claimed
 * 1,549 cases, 54 catalogue shapes and 9 recipes; the code had 27 archetypes, 8 recipes, 17
 * constraint types and 1,768 tests. Every one of those numbers was true on the day someone
 * typed it and false by the next commit.
 *
 * A figure a document keeps separately from the thing it describes is a figure that drifts,
 * and in a technical review a stale count is not read as staleness — it is read as a claim
 * that did not survive checking, which puts every other claim in the document in question.
 *
 * So the counts live here, derived from the same arrays the product runs on, and
 * `facts.test.ts` fails the build if a document states one that no longer matches. Nothing is
 * hand-maintained: adding an archetype changes this number, and nobody has to remember.
 */

export interface Facts {
  /** Named parametric shapes the catalogue can build from a request. */
  archetypes: number;
  /** Hand-written multi-part assemblies. */
  recipes: number;
  /** Relations the sketch solver can hold simultaneously. */
  constraintKinds: number;
  /** Modelling features the kernel evaluates. */
  featureKinds: number;
  /** Cases in the deterministic benchmark. */
  evalCases: number;
}

export function facts(): Facts {
  return {
    archetypes: ARCHETYPES.length,
    recipes: RECIPES.length,
    constraintKinds: CONSTRAINT_KINDS.length,
    featureKinds: FEATURE_KINDS.length,
    evalCases: CASES.length,
  };
}

/**
 * Every figure a document is allowed to state, with the phrasing it must use.
 *
 * The pattern is matched against the document text; the count is the truth. Adding a claim
 * here is how a new number becomes checkable — and a number not listed here is one no document
 * should be stating, because nothing is verifying it.
 */
export const CLAIMS: { label: string; pattern: RegExp; value: (f: Facts) => number }[] = [
  { label: 'archetypes', pattern: /(\d+) parametric archetypes/g, value: (f) => f.archetypes },
  { label: 'assembly recipes', pattern: /(\d+) assembly recipes/g, value: (f) => f.recipes },
  { label: 'constraint types', pattern: /(\d+) constraint types/g, value: (f) => f.constraintKinds },
  { label: 'modelling features', pattern: /(\d+) modelling features/g, value: (f) => f.featureKinds },
  { label: 'benchmark cases', pattern: /(\d+) benchmark cases/g, value: (f) => f.evalCases },
];

/** Every mismatch between a document's stated figures and the code's. */
export function staleClaims(text: string): { label: string; stated: number; actual: number }[] {
  const f = facts();
  const out: { label: string; stated: number; actual: number }[] = [];

  for (const claim of CLAIMS) {
    const actual = claim.value(f);
    // A fresh regex per pass: a /g literal carries lastIndex between calls, and reusing one
    // silently skips the first match of every document after the first.
    for (const m of text.matchAll(new RegExp(claim.pattern.source, 'g'))) {
      const stated = Number(m[1]);
      if (stated !== actual) out.push({ label: claim.label, stated, actual });
    }
  }

  return out;
}

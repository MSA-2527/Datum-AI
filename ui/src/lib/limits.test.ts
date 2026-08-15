import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ADDITIVE, DRILL, LASER, LIMITS, MILL, MOULDING, SHEET, TOOLING,
  briefedRules, constraintBrief,
} from './limits';

/**
 * Manufacturing limits tests.
 *
 * Most of these exist for one reason: to make it impossible to tell a planner a rule the
 * product does not enforce, or to enforce one it never mentioned. That is the failure this
 * whole module is built to prevent, and it is a failure that only appears months later, as a
 * linter contradicting the prompt that produced the part.
 *
 * So the central test reads the checkers' own source and compares rule ids in both
 * directions. It is an unusual thing for a unit test to do, and it is the only way to assert
 * a property that spans a prompt and a rule engine which share no runtime call.
 */

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

/** Every rule id the checkers can actually report. */
function enforcedRules(): string[] {
  const text = `${source('./dfm.ts')}\n${source('./dfmPacks.ts')}`;
  return [...new Set([...text.matchAll(/rule: '(dfm\.[a-z0-9.-]+)'/g)].map((m) => m[1]!))];
}

describe('the prompt and the linter cannot disagree', () => {
  it('every limit that is stated is also enforced', () => {
    const enforced = new Set(enforcedRules());
    const stated = LIMITS.map((l) => l.rule);

    expect(stated.filter((r) => !enforced.has(r))).toEqual([]);
  });

  it('every rule that is enforced is also described here', () => {
    const described = new Set(LIMITS.map((l) => l.rule));

    // A rule the checker reports but this file has never heard of is a rule the planner is
    // never told about — the part gets built wrong and corrected afterwards, every time.
    expect(enforcedRules().filter((r) => !described.has(r))).toEqual([]);
  });

  it('names each rule once', () => {
    const seen = new Set<string>();
    const duplicates = LIMITS.filter((l) => (seen.has(l.rule) ? true : (seen.add(l.rule), false)));
    expect(duplicates.map((d) => d.rule)).toEqual([]);
  });
});

describe('every limit is usable by an engineer', () => {
  it('states what must hold and why', () => {
    for (const limit of LIMITS) {
      expect(limit.requirement.length, limit.rule).toBeGreaterThan(20);
      expect(limit.basis.length, limit.rule).toBeGreaterThan(20);
    }
  });

  it('ends its requirement as a sentence rather than a fragment', () => {
    for (const limit of LIMITS) {
      expect(limit.requirement.trim().endsWith('.'), limit.rule).toBe(true);
    }
  });
});

describe('the numbers come from one place', () => {
  it('the brief quotes the constants the checkers use', () => {
    const brief = constraintBrief();

    // If a threshold is ever edited in `dfm.ts` instead of here, the constant and the brief
    // separate and this fails.
    expect(brief).toContain(`${MILL.recommendedWallMm} mm`);
    expect(brief).toContain(`${DRILL.maxDepthRatio}×`);
    expect(brief).toContain(`${MILL.maxPlateAspect}×`);
    expect(brief).toContain(`${LASER.maxThicknessMm} mm`);
    expect(brief).toContain(`${SHEET.minFlangeThicknesses}× thickness`);
    expect(brief).toContain(`${ADDITIVE.minWallNozzles} nozzle diameters`);
    expect(brief).toContain(`${MOULDING.recommendedDraftDeg}°`);
    expect(brief).toContain(`${TOOLING.maxDistinctHoleSizes} distinct hole diameters`);
  });

  it('lists the stock drill sizes the linter checks against', () => {
    const brief = constraintBrief();
    for (const d of [3, 6, 10, 20]) expect(brief).toContain(String(d));
    expect(DRILL.standardSizesMm).toContain(6.8);          // the M8 tapping size
  });

  it('keeps the recommended value clear of the hard limit', () => {
    // A brief that tells a designer to sit exactly on the blocker produces parts that fail
    // the check on any rounding.
    expect(MILL.recommendedWallMm).toBeGreaterThan(MILL.minWallMm);
    expect(MOULDING.recommendedDraftDeg).toBeGreaterThan(MOULDING.minDraftDeg);
    expect(MOULDING.recommendedCornerRadiusRatio).toBeGreaterThan(MOULDING.minCornerRadiusRatio);
  });
});

describe('the brief itself', () => {
  it('leads with milling, because that is what an unqualified request means', () => {
    const brief = constraintBrief();
    const mill = brief.indexOf('Machined');
    const moulded = brief.indexOf('Injection moulded');

    expect(mill).toBeGreaterThan(-1);
    expect(moulded).toBeGreaterThan(mill);
  });

  it('covers every process, so "a 3D printed bracket" is answerable', () => {
    const brief = constraintBrief();
    for (const label of ['Machined', 'Laser cut', 'Sheet metal', '3D printed', 'Injection moulded']) {
      expect(brief).toContain(label);
    }
  });

  it('narrows to the processes asked for', () => {
    const brief = constraintBrief(['additive']);
    expect(brief).toContain('3D printed');
    expect(brief).not.toContain('Injection moulded');
  });

  it('leaves out findings that are not design constraints', () => {
    // "Stainless removes slowly" is a true and useful thing to say about a part that exists.
    // It is not a rule to design against, and in a list of rules it is noise.
    expect(briefedRules()).not.toContain('dfm.material.machinability');
    expect(briefedRules()).not.toContain('dfm.metadata.required');
    expect(constraintBrief()).not.toContain('Part number, revision');
  });

  it('says what to do when the request itself asks for something outside a limit', () => {
    // Silently overriding the user is the wrong failure. Building it and saying so is right.
    expect(constraintBrief()).toMatch(/follow the\nrequest and say in "notes"/);
  });

  it('is empty rather than a bare heading when nothing is selected', () => {
    expect(constraintBrief([])).toBe('');
  });

  it('gives every rule its reason', () => {
    // A rule without one is the first thing a model trades away when the prompt conflicts
    // with itself, and unlike a person it will not mention that it did.
    for (const line of constraintBrief().split('\n').filter((l) => l.startsWith('- '))) {
      expect(line, line).toMatch(/\(.+\)$/);
    }
  });
});

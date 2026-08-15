import { describe, expect, it } from 'vitest';
import {
  archetypesIn, conflictsWith, dimension, filterLibrary, readRequest, structureScore,
  textScore, tokenise, tokensFor, triage,
} from './reuse';
import type { GeometrySnapshot, LibraryEntry } from './library';
import { addFeature, emptyDocument, type Document } from '../model/document';
import { archetypeById } from '../generate/archetypes';

/**
 * Reuse triage tests.
 *
 * The mechanism only earns its interruption if it is right. So the assertions are in two
 * groups and the second group is the important one: a genuine duplicate must be caught, and
 * everything that is *not* a duplicate must be waved through in silence. A gate that stops
 * people who were right to be modelling gets dismissed unread, and then it stops nobody.
 *
 * The acceptance arithmetic is pinned deliberately. These are judgement calls about how much
 * evidence is enough, and a judgement call nobody can see is a judgement call that drifts.
 */

const SNAPSHOT: GeometrySnapshot = {
  sizeMm: [200, 120, 8],
  volumeMm3: 192_000,
  massG: 518,
  triangles: 240,
  closed: true,
};

/** A saved part built from an archetype, as `decompose` would have written it. */
function saved(name: string, archetypeId: string, params: Record<string, number> = {}): LibraryEntry {
  const archetype = archetypeById(archetypeId)!;
  const full: Record<string, number | string> = { archetypeId };
  for (const spec of archetype.defaults) full[spec.key] = params[spec.key] ?? spec.value;

  return {
    name,
    savedAtUtc: '2026-03-01T00:00:00.000Z',
    doc: addFeature(emptyDocument(name), 'archetype', full, archetype.label),
    snapshot: SNAPSHOT,
  };
}

/** A saved part with no archetype behind it — an imported or hand-built tree. */
function handBuilt(name: string): LibraryEntry {
  return {
    name,
    savedAtUtc: '2026-03-01T00:00:00.000Z',
    doc: addFeature(emptyDocument(name), 'box', { length: 60, width: 40, height: 25 }, 'Body'),
    snapshot: SNAPSHOT,
  };
}

describe('reading the words', () => {
  it('drops the imperative wrapper the composer invites', () => {
    expect(tokenise('make me a cup')).toEqual(['cup']);
    expect(tokenise('Create a model of a bracket')).toEqual(['bracket']);
  });

  it('drops numbers and unit words — those are the dimension channel', () => {
    expect(tokenise('200 x 120 x 8 mm plate')).toEqual(['plate']);
  });

  it('folds regular plurals so "brackets" finds "bracket"', () => {
    expect(tokenise('brackets')).toEqual(['bracket']);
    expect(tokenise('bushes')).toEqual(['bush']);
  });

  it('leaves mechanical nouns alone rather than over-stemming them', () => {
    // A stemmer would fold these to "hous" and "bear", which is how a bearing starts
    // matching a bear.
    expect(tokenise('housing')).toEqual(['housing']);
    expect(tokenise('bearing')).toEqual(['bearing']);
  });

  it('reads a saved part through its archetype\'s aliases, not only its name', () => {
    const tokens = tokensFor(saved('Cup', 'cup').doc);
    expect(tokens).toContain('mug');
    expect(tokens).toContain('tumbler');
  });

  it('scores over the request\'s words, so a richly described part is not penalised', () => {
    expect(textScore(['plate'], ['plate', 'hole', 'aluminium', 'mounting'])).toBe(1);
    expect(textScore(['plate', 'flange'], ['plate'])).toBe(0.5);
    expect(textScore([], ['plate'])).toBe(0);
  });
});

describe('reading the structure', () => {
  it('finds the archetypes a saved document was built from', () => {
    expect(archetypesIn(saved('Plate', 'plate').doc)).toEqual(['plate']);
    expect(archetypesIn(handBuilt('Block').doc)).toEqual([]);
  });

  it('agrees when the request routes to an archetype the part was built from', () => {
    expect(structureScore(readRequest('a plate'), saved('Plate', 'plate').doc)).toBe(1);
  });

  it('disagrees when the request routes somewhere else entirely', () => {
    expect(structureScore(readRequest('a cup'), saved('Plate', 'plate').doc)).toBe(0);
  });

  it('agrees when a recipe request meets the assembly that recipe builds', () => {
    const phone: LibraryEntry = {
      name: 'Phone',
      savedAtUtc: '2026-03-01T00:00:00.000Z',
      doc: emptyDocument('Phone'),
      snapshot: SNAPSHOT,
    };
    expect(structureScore(readRequest('a phone'), phone.doc)).toBe(1);
  });

  it('stays silent rather than condemning when the saved part has no archetypes', () => {
    // An imported drawing carries no archetype because it *cannot*, not because it is a
    // different kind of thing. Scoring that as disagreement made the gate useless for exactly
    // the library it exists to search — one imported from an existing CAD system.
    expect(structureScore(readRequest('a bracket'), handBuilt('Bracket').doc)).toBe(0.5);
  });

  it('still condemns a part that was built as something else', () => {
    // Having archetypes and not this one is real disagreement, not missing evidence.
    expect(structureScore(readRequest('a plate'), saved('Plate', 'cup').doc)).toBe(0);
  });

  it('offers an imported part whose name matches the request', () => {
    // The end-to-end consequence of the rule above, and the reason it matters.
    const { match } = triage([handBuilt('Mounting bracket')], 'a mounting bracket');
    expect(match?.entry.name).toBe('Mounting bracket');
  });

  it('stays silent rather than condemning when the request routes nowhere', () => {
    // Neither channel has evidence about a request only a model could answer.
    const shape = readRequest('a hydroformed intake manifold');
    expect(shape.archetypeId).toBeNull();
    expect(shape.recipeLabel).toBeNull();
    expect(structureScore(shape, handBuilt('Block').doc)).toBe(0.5);
  });
});

describe('the dimension veto', () => {
  it('finds a stated dimension the saved part does not meet', () => {
    const entry = saved('Plate', 'plate', { length: 200 });
    const conflicts = conflictsWith(readRequest('a 300 mm long plate'), entry.doc);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.key).toBe('length');
    expect(conflicts[0]!.wanted).toBe(300);
    expect(conflicts[0]!.saved).toBe(200);
  });

  it('accepts a dimension that agrees within two percent', () => {
    const entry = saved('Plate', 'plate', { length: 200 });
    expect(conflictsWith(readRequest('a 201 mm long plate'), entry.doc)).toHaveLength(0);
  });

  it('says nothing about dimensions the request did not state', () => {
    // Silence is not a requirement. A request that never mentions thickness is leaving the
    // decision open, not demanding the default.
    const entry = saved('Plate', 'plate', { thickness: 25 });
    expect(conflictsWith(readRequest('a plate'), entry.doc)).toHaveLength(0);
  });

  it('has nothing to compare when the saved part was not built from that archetype', () => {
    expect(conflictsWith(readRequest('a 300 mm long plate'), handBuilt('Block').doc)).toHaveLength(0);
  });

  it('writes a dimension the way a drawing would', () => {
    expect(dimension(200, 'mm')).toBe('200 mm');
    expect(dimension(45, 'deg')).toBe('45 deg');
    expect(dimension(4, '')).toBe('4');
  });
});

describe('triage: what it offers', () => {
  it('offers the part when the name and the archetype both agree', () => {
    const { match } = triage([saved('Plate', 'plate')], 'a plate');
    expect(match?.entry.name).toBe('Plate');
    expect(match?.score).toBeCloseTo(1, 6);
  });

  it('offers a part found through an alias rather than the exact word used', () => {
    const { match } = triage([saved('Cup', 'cup')], 'make me a mug');
    expect(match?.entry.name).toBe('Cup');
  });

  it('explains itself in words rather than a number', () => {
    const { match } = triage([saved('Plate', 'plate')], 'a plate');
    expect(match?.reason).toContain('the name matches');
    expect(match?.reason).toContain('same archetype');
    expect(match?.reason).toContain('200 × 120 × 8 mm');
  });

  it('prefers the higher-scoring part, then the more recent one', () => {
    const older = { ...saved('Plate', 'plate'), name: 'Old plate', savedAtUtc: '2025-01-01T00:00:00.000Z' };
    const newer = { ...saved('Plate', 'plate'), name: 'New plate', savedAtUtc: '2026-09-01T00:00:00.000Z' };
    expect(triage([older, newer], 'a plate').match?.entry.name).toBe('New plate');
  });
});

describe('triage: what it stays out of', () => {
  it('says nothing about an unrelated part', () => {
    expect(triage([saved('Cup', 'cup')], 'a flange').match).toBeNull();
  });

  it('says nothing when the library is empty', () => {
    expect(triage([], 'a plate').match).toBeNull();
  });

  it('says nothing when the request is only noise words', () => {
    expect(triage([saved('Plate', 'plate')], 'make me one please').match).toBeNull();
  });

  it('refuses a part whose name matches but which was built as something else', () => {
    // A part called "Plate" that is actually a cup is not this plate, whatever it is called.
    const misnamed = { ...saved('Plate', 'cup'), name: 'Plate' };
    expect(triage([misnamed], 'a plate').match).toBeNull();
  });

  it('refuses on a contradicted dimension and reports it as a near miss', () => {
    const entry = saved('Plate', 'plate', { length: 200 });
    const { match, nearMisses } = triage([entry], 'a 300 mm long plate');

    expect(match).toBeNull();
    expect(nearMisses).toHaveLength(1);
    expect(nearMisses[0]!.conflicts[0]!.label).toBe('Length');
    expect(nearMisses[0]!.conflicts[0]!.saved).toBe(200);
  });

  it('a near miss is only recorded for a part that would otherwise have been offered', () => {
    // The cup contradicts nothing about a plate request; it is simply irrelevant, and
    // listing it as "close" would be noise.
    const { nearMisses } = triage([saved('Cup', 'cup')], 'a 300 mm long plate');
    expect(nearMisses).toHaveLength(0);
  });
});

describe('the acceptance arithmetic, pinned', () => {
  const bar = 0.75;

  it('perfect words with the wrong archetype falls short at 0.55', () => {
    expect(1 * 0.55 + 0 * 0.45).toBeLessThan(bar);
  });

  it('perfect words with nothing to compare clears it at 0.775', () => {
    expect(1 * 0.55 + 0.5 * 0.45).toBeGreaterThanOrEqual(bar);
  });

  it('half the words with the right archetype falls short at 0.725', () => {
    expect(0.5 * 0.55 + 1 * 0.45).toBeLessThan(bar);
  });

  it('offers a hand-built part on the name alone when the request routes nowhere', () => {
    // 0.775: the name is the only evidence there is, and it is enough to ask.
    const { match } = triage([handBuilt('Intake manifold')], 'an intake manifold');
    expect(match?.entry.name).toBe('Intake manifold');
    expect(match?.score).toBeCloseTo(0.775, 6);
  });

  it('a qualifier the saved part does not answer for pulls it back under the bar', () => {
    // "hydroformed" is a real requirement, and two words out of three is not the same part.
    // 0.667 × 0.55 + 0.5 × 0.45 = 0.592.
    expect(triage([handBuilt('Intake manifold')], 'a hydroformed intake manifold').match).toBeNull();
  });
});

describe('filtering the library list', () => {
  const index = [saved('Plate', 'plate'), saved('Cup', 'cup'), saved('Flange', 'flange')];

  it('keeps the library\'s own order when nothing is typed', () => {
    expect(filterLibrary(index, '').map((e) => e.name)).toEqual(['Plate', 'Cup', 'Flange']);
  });

  it('ranks by the same text channel the gate uses', () => {
    expect(filterLibrary(index, 'mug').map((e) => e.name)).toEqual(['Cup']);
  });

  it('returns nothing rather than everything when nothing matches', () => {
    expect(filterLibrary(index, 'gearbox')).toHaveLength(0);
  });
});

describe('a document with no archetype behind it', () => {
  it('still carries its own words', () => {
    const doc: Document = addFeature(emptyDocument('Sump baffle'), 'box', {}, 'Body');
    expect(tokensFor(doc)).toContain('sump');
    expect(tokensFor(doc)).toContain('baffle');
  });
});

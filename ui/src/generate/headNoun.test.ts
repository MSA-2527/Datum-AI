import { describe, expect, it } from 'vitest';
import { generateFromText, headNoun, parseRequest } from './parse';
import { matchRecipe } from '../assembly/recipes';

/**
 * The head-noun gate.
 *
 * A parser that scores every word in a sentence will answer "a crankshaft for a 4 cylinder
 * engine" with a plain cylinder and call it a success. That failure mode — confidently
 * wrong, and indistinguishable at a glance from having worked — is the one a CAD tool can
 * least afford, because the user has no signal that the solid on screen is not their part.
 *
 * These cases are the boundary: what the catalogue is allowed to answer, and what it must
 * refuse rather than approximate.
 */

describe('the head noun of a request', () => {
  it.each([
    ['make a cup', 'cup'],
    ['a crankshaft for a 4 cylinder engine', 'crankshaft'],
    ['a ball bearing 6205', 'bearing'],
    ['a socket head cap screw M6 x 20', 'screw'],
    ['a cylinder head with valve seats', 'head'],
    ['a wing rib with lightening holes', 'rib'],
    ['a car chassis', 'chassis'],
    ['Create a model of a car', 'car'],
  ])('reads %s as a request for a %s', (text, head) => {
    expect(headNoun(text)).toBe(head);
  });

  it('walks past a designation to the noun before it', () => {
    // HTD 5M is a belt profile, not the thing being asked for.
    const known = (w: string) => w === 'pulley';
    expect(headNoun('a timing belt pulley 20 teeth HTD 5M', known)).toBe('pulley');
  });

  it('ignores the size trailing the noun', () => {
    expect(headNoun('make a cup 90 mm tall')).toBe('cup');
    expect(headNoun('a rack arm length 400')).toBe('rack');
  });
});

describe('a request the catalogue cannot answer', () => {
  it.each([
    'a crankshaft for a 4 cylinder engine',
    'a camshaft with 8 lobes',
    'a ball bearing 6205',
    'a socket head cap screw M6 x 20',
    'a cylinder head with valve seats',
    'a suspension wishbone',
    'a brake caliper',
    'a car chassis',
    'a landing gear strut',
    'a turbine blade with a twisted aerofoil',
  ])('refuses %s rather than building the nearest thing', (text) => {
    const out = generateFromText(text);
    expect(out.ok, `"${text}" was answered with a part`).toBe(false);
  });

  it('names the noun it does not have, and what it does have', () => {
    const parsed = parseRequest('a crankshaft for a 4 cylinder engine');
    expect(parsed.archetype).toBeNull();
    if (parsed.archetype !== null) return;
    expect(parsed.message).toContain('crankshaft');
    expect(parsed.suggestions.length).toBeGreaterThan(0);
  });
});

describe('a request the catalogue can answer is still answered', () => {
  it.each([
    ['make a cup', 'cup'],
    ['M10 hex nut', 'nut'],
    ['200 x 120 x 8 plate with 9 mm holes', 'plate'],
    ['an involute spur gear, 24 teeth, module 2, 20 degree pressure angle', 'gear'],
    ['a timing belt pulley 20 teeth HTD 5M', 'pulley'],
    ['a threaded rod M12', 'shaft'],
    ['Create a model of a car', 'car'],
  ])('%s builds a %s', (text, id) => {
    const out = generateFromText(text);
    expect(out.ok, `"${text}" was refused`).toBe(true);
    if (!out.ok) return;
    expect(out.archetype.id).toBe(id);
  });
});

describe('an assembly recipe answers only what it names', () => {
  it.each(['a phone', 'a gearbox', 'a rocket', 'an airliner', 'a bicycle please'])(
    'still matches %s', (text) => { expect(matchRecipe(text)).not.toBeNull(); });

  it.each(['a rocket nozzle with a bell contour', 'a bicycle crank', 'a phone case bracket'])(
    'does not answer %s with the whole assembly', (text) => {
      expect(matchRecipe(text)).toBeNull();
    });
});

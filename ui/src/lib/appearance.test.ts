import { describe, expect, it } from 'vitest';
import { appearanceFor, fallbackColour, materialChoices, parseHex, toHex } from './appearance';

/**
 * Colour is the fastest thing a person reads off a model. Everything here is about it being
 * *right* rather than merely present: the wrong colour is a claim about what a part is made
 * of, and a model where every part is the same shade is the grey lump this replaced.
 */

describe('material colours', () => {
  it('recognises a material by any of the words used for it', () => {
    for (const name of ['6061', 'Aluminium 6061-T6', 'aluminum plate']) {
      expect(appearanceFor(name).label).toBe('Aluminium');
    }
  });

  it('prefers the longest match, so a grade is not read as its base metal', () => {
    // '304 stainless' contains 'steel'-adjacent words in real documents; the specific alloy
    // has to win or every stainless part comes out mild-steel grey.
    expect(appearanceFor('304 stainless steel').label).toBe('Stainless');
    expect(appearanceFor('cast iron').label).toBe('Cast iron');
    expect(appearanceFor('mild steel').label).toBe('Steel');
  });

  it('says it does not know rather than guessing', () => {
    expect(appearanceFor('').label).toBe('Unspecified');
    expect(appearanceFor('unobtainium').label).toBe('Unspecified');
  });

  it('gives brass and copper visibly different colours', () => {
    const a = appearanceFor('brass').rgb;
    const b = appearanceFor('copper').rgb;
    const apart = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(apart).toBeGreaterThan(0.1);
  });

  it('offers every material it knows for a picker, without duplicates', () => {
    const choices = materialChoices();
    expect(choices.length).toBeGreaterThan(10);
    expect(new Set(choices.map((c) => c.value)).size).toBe(choices.length);
    for (const c of choices) expect(appearanceFor(c.value).label).toBe(c.label);
  });
});

describe('colours for parts with nothing to distinguish them', () => {
  it('keeps consecutive parts far apart in hue', () => {
    // Successive components in a tree are the ones most likely to touch, so they are the ones
    // that must not come out the same colour.
    for (let i = 0; i < 12; i++) {
      const a = fallbackColour(i);
      const b = fallbackColour(i + 1);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(0.08);
    }
  });

  it('is stable, so a part does not change colour between builds', () => {
    expect(fallbackColour(5)).toEqual(fallbackColour(5));
  });

  it('stays in range', () => {
    for (let i = 0; i < 40; i++) {
      for (const c of fallbackColour(i)) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('hex, as the UI stores it', () => {
  it('round-trips', () => {
    expect(toHex(parseHex('#4a9eff')!)).toBe('#4a9eff');
  });

  it('accepts what a colour input produces, with or without the hash', () => {
    expect(parseHex('4A9EFF')).toEqual(parseHex('#4a9eff'));
  });

  it('refuses what is not a colour rather than returning black', () => {
    // Returning black on bad input would paint a part black and look deliberate.
    for (const bad of ['', '#abc', 'red', '#12345g']) expect(parseHex(bad)).toBeNull();
  });

  it('clamps rather than wrapping when writing out of range', () => {
    expect(toHex([2, -1, 0.5])).toBe('#ff0080');
  });
});

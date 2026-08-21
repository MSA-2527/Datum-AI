import { describe, expect, it } from 'vitest';
import { wantsRackForOpenPart } from './modelStore';

/**
 * Asking for a rack for the part that is open.
 *
 * The button has always existed and the sentence never worked. Someone who had just imported a
 * customer's lid and typed "design an anodising rack for this part" got a generic rack from the
 * catalogue — and lost the lid, because the build route replaces what is open.
 *
 * The risk in fixing it is the opposite mistake: hijacking a sentence that was not about this at
 * all. "A 19-inch server rack" is a request to build a rack, and answering it by measuring
 * whatever happened to be on screen would be worse than the bug.
 */

describe('when it takes the request', () => {
  const takes = (text: string) => wantsRackForOpenPart(text, true);

  it('takes the plain ways of asking', () => {
    expect(takes('design an anodising rack for this part')).toBe(true);
    expect(takes('make an anodizing rack for it')).toBe(true);
    expect(takes('anodising rack for the part I just imported')).toBe(true);
    expect(takes('build a plating rack for this')).toBe(true);
  });

  it('does not care about spelling or case', () => {
    // Both spellings are correct English and a shop uses whichever it grew up with.
    expect(takes('ANODIZING RACK FOR THIS PART')).toBe(true);
    expect(takes('Anodising Rack For This')).toBe(true);
  });

  it('does not care about punctuation', () => {
    expect(takes('rack, anodising — for this part.')).toBe(true);
  });
});

describe('when it leaves the request alone', () => {
  it('leaves a rack that is not for anodising', () => {
    /*
     * A rack is also a shelf, a gear rack and a server rack, and only one kind is measured off
     * the part on screen. Taking these would answer "build me a 19-inch rack" by designing
     * plating tooling for whatever was open.
     */
    expect(wantsRackForOpenPart('a 19 inch server rack for this cabinet', true)).toBe(false);
    expect(wantsRackForOpenPart('a rack and pinion for this gearbox', true)).toBe(false);
    expect(wantsRackForOpenPart('a bike rack for it', true)).toBe(false);
  });

  it('leaves a rack request that points at nothing', () => {
    // "An anodising rack" with nothing open is a request to build a rack, which the catalogue
    // answers. Measuring one for an empty document would design a rack for nothing.
    expect(wantsRackForOpenPart('design an anodising rack', true)).toBe(false);
    expect(wantsRackForOpenPart('a titanium anodizing rack, 6 stations', true)).toBe(false);
  });

  it('leaves everything alone when nothing is open', () => {
    expect(wantsRackForOpenPart('an anodising rack for this part', false)).toBe(false);
  });

  it('leaves an ordinary part request alone', () => {
    expect(wantsRackForOpenPart('a bracket for this motor', true)).toBe(false);
    expect(wantsRackForOpenPart('make it 20 mm thick', true)).toBe(false);
  });

  it('is not fooled by the word appearing inside another', () => {
    // "Bracket" contains no "rack" once the words are separated, and "tracking" is not a rack.
    expect(wantsRackForOpenPart('an anodising bracket for this part', true)).toBe(false);
    expect(wantsRackForOpenPart('anodising tracking for this part', true)).toBe(false);
  });
});

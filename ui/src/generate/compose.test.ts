import { describe, expect, it } from 'vitest';
import { compose, readModifiers } from './compose';
import { evaluateDocument } from '../model/document';
import { health, massProperties } from '../kernel/topo/mesh';

/**
 * Composition tests.
 *
 * These assert against closed-form answers wherever one exists — a 80 × 60 × 40 block is
 * 192 cm³, and a 3 mm shell of it is the difference between that and the 74 × 54 × 37 void —
 * because the failure being fixed was a part that measured *exactly* right for the base shape
 * and had silently lost everything else the request asked for. Comparing against a previous
 * run would have passed the whole time.
 */

const built = (text: string) => {
  const r = compose(text);
  if (!r.ok) throw new Error(`"${text}" did not compose: ${r.reason}`);
  const ev = evaluateDocument(r.doc);
  return { ...r, ev, volume: massProperties(ev.mesh).volume, cm3: massProperties(ev.mesh).volume / 1000 };
};

describe('the base shape', () => {
  it('reads a dimension triple exactly', () => {
    const b = built('a block 80 x 60 x 40');
    expect(b.cm3).toBeCloseTo(192, 3);
  });

  it('reads one edge of a cube as all three', () => {
    expect(built('a 40 mm cube').cm3).toBeCloseTo(64, 3);
  });

  it('reads a named length, width and height in any order', () => {
    const b = built('a block 30 mm thick, 100 mm long, 50 mm wide');
    expect(b.cm3).toBeCloseTo(150, 3);
  });

  it('reads a cylinder as diameter then length', () => {
    const b = built('a 50 mm cylinder 80 mm long');
    // π × 25² × 80 = 157 080 mm³, under-run slightly by tessellation.
    expect(b.cm3).toBeGreaterThan(154);
    expect(b.cm3).toBeLessThan(157.1);
  });

  it('reads a sphere', () => {
    const b = built('a 30 mm sphere');
    // 4/3 π 15³ = 14 137 mm³.
    expect(b.cm3).toBeGreaterThan(13.6);
    expect(b.cm3).toBeLessThan(14.14);
  });

  it('builds a tube as a body with a real bore, not one solid', () => {
    const b = built('a tube 40 mm od 20 mm bore 100 mm long');
    // π(20² − 10²) × 100 = 94 248 mm³.
    expect(b.cm3).toBeGreaterThan(92);
    expect(b.cm3).toBeLessThan(94.25);
    expect(b.doc.features.some((f) => f.kind === 'hole')).toBe(true);
  });

  it('refuses a request that names no shape it can build on', () => {
    const r = compose('a crankshaft for a 4 cylinder engine');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/block, a cylinder, a tube or a sphere/);
  });
});

describe('the modifiers the catalogue used to drop', () => {
  /*
   * Each of these built the bare base shape before, to the millimetre, and reported success.
   */
  it('hollows a box that asked to be hollow', () => {
    const b = built('a hollow box 80 x 60 x 40 with 3 mm walls');

    // Solid would be 192 cm³. A 3 mm shell leaves the walls and the floor.
    expect(b.cm3).toBeLessThan(60);
    expect(b.cm3).toBeGreaterThan(20);
    expect(health(b.ev.mesh).closed).toBe(true);
  });

  it('drills the hole a block asked for', () => {
    const b = built('a 60 x 40 x 10 block with an 8 mm hole in the middle');

    // 24 000 mm³ less π × 4² × 10 = 502 mm³.
    expect(b.volume).toBeGreaterThan(24000 - 520);
    expect(b.volume).toBeLessThan(24000 - 480);
  });

  it('rounds the edges a cube asked to have rounded', () => {
    const b = built('a 40 mm cube with all edges rounded 4 mm');

    expect(b.cm3).toBeLessThan(64);
    expect(b.cm3).toBeGreaterThan(62);
    expect(health(b.ev.mesh).closed).toBe(true);
  });

  it('chamfers when asked', () => {
    const plain = built('a 40 mm cube').volume;
    const b = built('a 40 mm cube with a 3 mm chamfer');

    expect(b.volume).toBeLessThan(plain);
    expect(health(b.ev.mesh).closed).toBe(true);
  });

  it('cuts a pocket to the size and depth stated', () => {
    const b = built('a plate 100 x 100 x 10 with a 40 x 30 pocket 4 mm deep');

    // 100 000 mm³ less 40 × 30 × 4 = 4 800 mm³.
    expect(b.volume).toBeGreaterThan(100000 - 4900);
    expect(b.volume).toBeLessThan(100000 - 4700);
  });

  it('cuts a slot', () => {
    const plain = built('a block 80 x 40 x 10').volume;
    const b = built('a block 80 x 40 x 10 with a 30 x 8 slot');

    expect(b.volume).toBeLessThan(plain);
    expect(health(b.ev.mesh).closed).toBe(true);
  });

  it('applies several modifiers at once', () => {
    const b = built('a 60 x 60 x 20 block with a 10 mm hole, a 20 x 20 pocket 5 mm deep and a 2 mm chamfer');

    expect(b.doc.features.map((f) => f.kind)).toEqual(
      expect.arrayContaining(['box', 'hole', 'pocket', 'chamfer']),
    );
    expect(health(b.ev.mesh).closed).toBe(true);
  });
});

describe('order of operations', () => {
  it('cuts, then hollows, then blends — whatever order the sentence used', () => {
    const b = built('a block 60 x 60 x 30 with a 4 mm fillet and a 10 mm hole');
    const kinds = b.doc.features.map((f) => f.kind);

    expect(kinds.indexOf('hole')).toBeLessThan(kinds.indexOf('fillet'));
  });

  it('shells before it blends', () => {
    const b = built('a block 60 x 60 x 30 with a 3 mm fillet and 2 mm walls');
    const kinds = b.doc.features.map((f) => f.kind);

    expect(kinds.indexOf('shell')).toBeLessThan(kinds.indexOf('fillet'));
  });
});

describe('what it will not do', () => {
  it('reports a clause it cannot build instead of dropping it', () => {
    const r = compose('a 50 mm cylinder with an involute spline');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.unhandled).toEqual(['an involute spline']);
  });

  it('says what it did read, in the terms it read them', () => {
    const r = compose('a block 80 x 60 x 40 with 3 mm walls');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.understood.join(' ')).toContain('80 × 60 × 40');
    expect(r.understood.join(' ')).toContain('3 mm wall');
  });

  it('keeps the request on the document, so the file records what was asked', () => {
    const r = compose('a 40 mm cube with a 6 mm hole');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.doc.properties?.Request).toBe('a 40 mm cube with a 6 mm hole');
  });
});

describe('reading modifiers on their own', () => {
  it('extracts them without a base, for adding to an archetype', () => {
    const { modifiers, unhandled } = readModifiers('a cup with a 3 mm fillet and 2 mm walls');

    expect(modifiers.map((m) => m.kind).sort()).toEqual(['fillet', 'shell']);
    expect(unhandled).toEqual([]);
  });

  it('finds nothing in a request that asked for nothing extra', () => {
    expect(readModifiers('make a cup').modifiers).toEqual([]);
  });
});

describe('every composed part is manufacturable', () => {
  it.each([
    'a 40 mm cube',
    'a 50 mm cylinder 80 mm long',
    'a 30 mm sphere',
    'a tube 40 mm od 20 mm bore 100 mm long',
    'a hollow box 80 x 60 x 40 with 3 mm walls',
    'a 60 x 40 x 10 block with an 8 mm hole',
    'a 100 x 100 x 10 plate with a 40 x 30 pocket 4 mm deep',
    'a block 60 x 60 x 30 with a 3 mm fillet',
    'a 40 mm cube with a 2 mm chamfer',
  ])('%s closes and has positive volume', (text) => {
    const b = built(text);
    const h = health(b.ev.mesh);

    expect(h.closed, `${text} is not closed`).toBe(true);
    expect(h.manifold, `${text} is not manifold`).toBe(true);
    expect(b.volume).toBeGreaterThan(0);
    expect([...b.ev.errors.values()]).toEqual([]);
  });
});

describe('several holes', () => {
  /*
   * A count with no circle to put the holes on used to stack all of them on the origin: the
   * cuts coincided, the part came back with one hole, and nothing said so.
   */
  it('spreads a stated count onto a circle that fits inside the part', () => {
    const one = built('a 100 x 100 x 10 plate with a 6 mm hole');
    const four = built('a 100 x 100 x 10 plate with four 6 mm holes');

    // Four holes remove close to four times what one does.
    const removedByOne = 100000 - one.volume;
    const removedByFour = 100000 - four.volume;

    expect(removedByFour / removedByOne).toBeGreaterThan(3.5);
    expect(removedByFour / removedByOne).toBeLessThan(4.5);
  });

  it('reads a digit count as well as a word', () => {
    const b = built('a 120 mm cylinder 10 mm long with 6 holes of 8 mm');
    const plain = built('a 120 mm cylinder 10 mm long');

    const removed = plain.volume - b.volume;
    // Six ⌀8 holes through 10 mm: 6 × π × 16 × 10 = 3016 mm³.
    expect(removed).toBeGreaterThan(2800);
    expect(removed).toBeLessThan(3100);
  });

  it('honours a bolt circle when the request states one', () => {
    const r = compose('a 100 mm disc 8 mm thick with four 6 mm holes on a 70 mm bolt circle');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const holes = r.doc.features.find((f) => f.kind === 'hole');
    expect(holes?.params.boltCircle).toBe(70);
  });
});

describe('the whole build path, end to end', () => {
  /*
   * These are the requests that used to come back as the bare base shape, measured exactly
   * right for what was built and wrong for what was asked. Each is checked against its
   * closed-form answer.
   */
  it.each([
    // request, cm³, tolerance
    ['a hollow box 80 x 60 x 40 with 3 mm walls', 33.9, 1.5],
    ['a 60 x 40 x 10 block with an 8 mm hole in the middle', 23.5, 0.1],
    ['a 100 mm long bar 20 mm square with 5 mm chamfers', 34.0, 0.5],
    ['a 25 mm bushing 40 mm long with a 15 mm bore', 12.57, 0.15],
    ['a 50 mm cylinder 80 mm long with a 12 mm hole through it', 148.0, 0.5],
  ])('%s comes out at about %s cm³', async (text, expected, tolerance) => {
    const { decompose } = await import('../ai/decompose');
    const { defaultConfig } = await import('../ai/providers');

    const r = await decompose(text as string, { config: defaultConfig() });
    expect(r.ok, `"${text}" was refused`).toBe(true);
    if (!r.ok) return;

    const cm3 = massProperties(evaluateDocument(r.doc).mesh).volume / 1000;
    expect(cm3, `${text} came out at ${cm3.toFixed(2)} cm³`)
      .toBeGreaterThan((expected as number) - (tolerance as number));
    expect(cm3, `${text} came out at ${cm3.toFixed(2)} cm³`)
      .toBeLessThan((expected as number) + (tolerance as number));
  }, 30000);

  it('does not rescale a part whose dimensions the builder already bound', async () => {
    const { decompose } = await import('../ai/decompose');
    const { defaultConfig } = await import('../ai/providers');

    /*
     * "12 mm long" on a flat turned part means its thickness. Measured off the bounding box it
     * was read as the largest extent — the 20 mm diameter — and the correction pass shrank the
     * whole washer by 0.6 to close a gap that did not exist.
     */
    const r = await decompose('a spacer 20 mm od 8 mm id 12 mm long', { config: defaultConfig() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const volume = massProperties(evaluateDocument(r.doc).mesh).volume;
    expect(volume).toBeGreaterThan(3000);   // π(10² − 4²) × 12 = 3167 mm³
    expect(volume).toBeLessThan(3200);
  }, 30000);
});

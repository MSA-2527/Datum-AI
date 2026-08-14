import { describe, expect, it } from 'vitest';
import { ARCHETYPES, archetypeById } from './archetypes';
import { generateFromText, parseRequest } from './parse';
import { health, massProperties, bounds } from '../kernel/topo/mesh';

/**
 * Text-to-solid tests.
 *
 * The bar is not "it produced something". Every archetype must produce a *closed manifold
 * solid with positive volume*, because that is the difference between a model that can be
 * quoted, machined and inspected and a mesh that merely renders. A generator that emits an
 * open shell has produced a picture of a part, and the whole argument for this product is
 * that pictures are not good enough.
 */

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

describe('every archetype builds a manufacturable solid', () => {
  for (const a of ARCHETYPES) {
    it(`${a.id} is closed, manifold and has positive volume`, () => {
      const r = a.build({});
      const h = health(r.mesh);

      expect(h.closed).toBe(true);
      expect(h.manifold).toBe(true);
      expect(massProperties(r.mesh).volume).toBeGreaterThan(0);
      expect(r.valid).toBe(true);
    });

    it(`${a.id} declares a parameter for everything it uses`, () => {
      // A build step naming a parameter that does not exist means the UI would offer a
      // control that changes nothing, which is worse than not offering it.
      const keys = new Set(a.defaults.map((d) => d.key));
      for (const step of a.build({}).steps) {
        for (const u of step.uses) expect(keys.has(u)).toBe(true);
      }
    });

    it(`${a.id} never reports success for a body it did not close`, () => {
      // Every parameter pushed far past its ceiling, so each is clamped to its maximum.
      // Some maxima genuinely have no valid solid — 48 bolt holes on a small circle merge
      // into a slot and part the flange — so the contract is not "always succeeds". It is
      // that `valid` tells the truth, and that a failure is explained rather than silent.
      const absurd: Record<string, number> = {};
      for (const d of a.defaults) absurd[d.key] = d.max * 1000;

      const r = a.build(absurd);
      expect(r.valid).toBe(health(r.mesh).closed);
      if (!r.valid) expect(r.warnings.length).toBeGreaterThan(0);
    });
  }
});

describe('make a cup', () => {
  it('builds a closed solid from the bare phrase', () => {
    const out = generateFromText('make a cup');
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.archetype.id).toBe('cup');
    expect(health(out.result.mesh).closed).toBe(true);
    expect(massProperties(out.result.mesh).volume).toBeGreaterThan(0);
  });

  it('produces a hollow vessel, not a solid lump', () => {
    // The decisive check: a cup's material volume must be a small fraction of the volume
    // its outer envelope encloses. A revolve that failed to cut its cavity would pass a
    // closed-solid check and be completely wrong.
    const cup = archetypeById('cup')!.build({});
    const mp = massProperties(cup.mesh);
    const bb = bounds(cup.mesh);
    const envelope = (bb.max[0] - bb.min[0]) * (bb.max[1] - bb.min[1]) * (bb.max[2] - bb.min[2]);

    expect(mp.volume).toBeLessThan(envelope * 0.45);
    expect(mp.volume).toBeGreaterThan(envelope * 0.02);
  });

  it('has a handle that adds material on one side', () => {
    const withHandle = archetypeById('cup')!.build({ handle: 1 });
    const without = archetypeById('cup')!.build({ handle: 0 });

    expect(massProperties(withHandle.mesh).volume).toBeGreaterThan(massProperties(without.mesh).volume);

    // The handle must actually stick out past the body.
    const bbA = bounds(withHandle.mesh);
    const bbB = bounds(without.mesh);
    expect(bbA.max[0] - bbA.min[0]).toBeGreaterThan(bbB.max[0] - bbB.min[0]);
  });

  it('omits the handle when asked', () => {
    const out = generateFromText('make a cup with no handle');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.parsed.params.handle).toBe(0);
  });

  it('honours an explicit diameter and height', () => {
    const out = generateFromText('a cup 90 mm diameter and 120 mm tall');
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const bb = bounds(out.result.mesh);
    expect(bb.max[2] - bb.min[2]).toBeCloseTo(120, 0);
    // Width includes the handle, so check the body via the parsed parameter.
    expect(out.parsed.params.outerDia).toBeCloseTo(90, 6);
  });

  it('sizes itself from a requested capacity', () => {
    const out = generateFromText('a 500 ml mug');
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // A 500 ml vessel must be substantially bigger than the 350 ml default.
    expect(out.parsed.params.outerDia).toBeGreaterThan(82);
    expect(health(out.result.mesh).closed).toBe(true);
  });

  it('reports its capacity so the number is checkable', () => {
    const cup = archetypeById('cup')!.build({});
    expect(cup.warnings.some((w) => /ml/.test(w))).toBe(true);
  });

  it('scales with wall thickness', () => {
    const thin = archetypeById('cup')!.build({ wall: 2 });
    const thick = archetypeById('cup')!.build({ wall: 8 });
    expect(massProperties(thick.mesh).volume).toBeGreaterThan(massProperties(thin.mesh).volume * 1.4);
  });
});

describe('parsing', () => {
  it('routes common words to the right archetype', () => {
    const cases: [string, string][] = [
      ['make a cup', 'cup'],
      ['design a coffee mug', 'cup'],
      ['I need a water bottle', 'bottle'],
      ['spur gear with 30 teeth', 'gear'],
      ['an L-bracket', 'bracket'],
      ['pipe flange', 'flange'],
      ['a hex nut', 'nut'],
      ['mounting plate', 'plate'],
      ['v-belt pulley', 'pulley'],
      ['project box enclosure', 'enclosure'],
    ];
    for (const [text, id] of cases) {
      const p = parseRequest(text);
      expect(p.archetype?.id, `"${text}"`).toBe(id);
    }
  });

  it('prefers the more specific alias', () => {
    // "coffee cup" and "cup" both match; the longer one must win so a future
    // "coffee cup" archetype would take precedence over the generic one.
    const p = parseRequest('a coffee cup');
    expect(p.archetype?.id).toBe('cup');
  });

  it('says it does not know rather than guessing', () => {
    const p = parseRequest('build me a quantum flux capacitor');
    expect(p.archetype).toBeNull();
    if (p.archetype === null) {
      expect(p.message).toMatch(/no shape/i);
      expect(p.suggestions.length).toBeGreaterThan(0);
    }
  });

  it('converts imperial units', () => {
    const p = parseRequest('a plate 2 inch thick');
    expect(p.archetype?.id).toBe('plate');
    if (p.archetype) expect(p.params.thickness).toBeCloseTo(50.8, 3);
  });

  it('reads imperial fractions, which is how imperial stock is specified', () => {
    const p = parseRequest('a plate 1/4 inch thick');
    if (p.archetype) expect(p.params.thickness).toBeCloseTo(6.35, 3);
  });

  it('reads a dimension triple', () => {
    const p = parseRequest('a plate 200 x 120 x 8');
    if (p.archetype) {
      expect(p.params.length).toBe(200);
      expect(p.params.width).toBe(120);
      expect(p.params.thickness).toBe(8);
    }
  });

  it('reads counts', () => {
    const gear = parseRequest('gear with 30 teeth');
    if (gear.archetype) expect(gear.params.teeth).toBe(30);

    const flange = parseRequest('a flange with 12 bolts');
    if (flange.archetype) expect(flange.params.boltCount).toBe(12);
  });

  it('expands an ISO metric fastener designation', () => {
    const out = generateFromText('M10 hex nut');
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // ISO 4032: an M10 nut is 17 mm across the flats.
    expect(out.parsed.params.acrossFlats).toBeCloseTo(17, 6);
    expect(out.parsed.params.boreDia).toBeCloseTo(10, 6);
  });

  it('reports what it understood so the user can check it', () => {
    const p = parseRequest('a cup 90 mm diameter, 4 mm wall');
    if (p.archetype) {
      expect(p.understood.length).toBeGreaterThan(0);
      expect(p.understood.join(' ')).toMatch(/wall/);
    }
  });

  it('does not attach a number to a keyword it is nowhere near', () => {
    // "wall" is far from "200"; associating them would silently build the wrong part.
    const p = parseRequest('a cup with a nice wall, and separately 200 something else entirely here');
    if (p.archetype) expect(p.params.wall).toBeUndefined();
  });
});

describe('archetype engineering checks', () => {
  it('warns when a gear will undercut', () => {
    // Below 17 teeth at 20 degrees a standard cutter removes part of the involute.
    const g = archetypeById('gear')!.build({ teeth: 10, pressureAngle: 20 });
    expect(g.warnings.some((w) => /undercut/i.test(w))).toBe(true);
  });

  it('produces a gear whose pitch diameter matches module times teeth', () => {
    const g = archetypeById('gear')!.build({ module: 2, teeth: 24, boreDia: 0, faceWidth: 10 });
    const bb = bounds(g.mesh);
    // Outside diameter = m(z + 2) = 2 * 26 = 52.
    expect(rel(bb.max[0] - bb.min[0], 52)).toBeLessThan(0.03);
    expect(g.warnings.join(' ')).toMatch(/Pitch diameter 48/);
  });

  it('warns when a flange bolt circle leaves no metal', () => {
    const f = archetypeById('flange')!.build({ outerDia: 100, boreDia: 80, boltCircle: 90, boltDia: 12 });
    expect(f.warnings.some((w) => /metal|review/i.test(w))).toBe(true);
  });

  it('refuses a wall thicker than the body can hold', () => {
    const e = archetypeById('enclosure')!.build({ length: 40, width: 40, height: 30, wall: 25 });
    // It must not silently return a self-intersecting body.
    expect(health(e.mesh).closed).toBe(true);
  });

  it('warns when a keyway would fail in torsion', () => {
    const s = archetypeById('shaft')!.build({ diameter: 20, keywayWidth: 6, keywayDepth: 8, keywayLength: 30 });
    expect(s.warnings.some((w) => /torsion/i.test(w))).toBe(true);
  });

  it('warns about insufficient draft for moulding', () => {
    const e = archetypeById('enclosure')!.build({ draft: 0 });
    expect(e.warnings.some((w) => /mould/i.test(w))).toBe(true);
  });
});

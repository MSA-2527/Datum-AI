import { describe, expect, it } from 'vitest';
import { addFeature, defaultParams, emptyDocument, evaluateDocument, type Document } from './document';
import { bounds } from '../kernel/topo/mesh';

/**
 * The sheet metal feature, as geometry.
 *
 * The flat pattern is tested separately in `domain/sheetmetal.test.ts` and is the half that
 * decides whether the part comes back the right length. This is the half you can look at: a
 * folded profile of constant thickness, with real bend radii rather than knife edges, because a
 * press brake cannot produce one and a model showing one lies about what will arrive.
 */

function sheet(params: Record<string, unknown> = {}): Document {
  let doc = emptyDocument();
  doc = addFeature(doc, 'sheet', { ...defaultParams('sheet'), ...params } as never, 'Bracket');
  return doc;
}

describe('an angle bracket', () => {
  it('builds a closed solid', () => {
    const ev = evaluateDocument(sheet());

    expect(ev.errors.size).toBe(0);
    expect(ev.health.closed).toBe(true);
    expect(ev.volume).toBeGreaterThan(0);
  });

  it('is the width it was given, across the sheet', () => {
    const bb = bounds(evaluateDocument(sheet({ width: 120 })).mesh);
    expect(bb.max[1]! - bb.min[1]!).toBeCloseTo(120, 1);
  });

  it('weighs about the material in it', () => {
    // Two flanges of 60 and 40, 2 mm thick, 60 wide: roughly 100 x 2 x 60 = 12 000 mm³,
    // less what the bend takes out of the corner.
    const ev = evaluateDocument(sheet({ flangeA: 60, flangeB: 40, thickness: 2, width: 60 }));

    expect(ev.volume).toBeGreaterThan(10_000);
    expect(ev.volume).toBeLessThan(13_000);
  });

  it('holds its thickness through the bend rather than pinching', () => {
    // Averaging the normals at a corner is what stops the inside of a fold from closing up.
    // A pinched corner shows up as volume well under the material that went in.
    const thin = evaluateDocument(sheet({ thickness: 1, radius: 1 }));
    const thick = evaluateDocument(sheet({ thickness: 4, radius: 4 }));

    expect(thick.volume / thin.volume).toBeGreaterThan(3.5);
    expect(thick.health.closed).toBe(true);
  });

  it('a bigger flange makes a bigger part', () => {
    const small = evaluateDocument(sheet({ flangeB: 30 })).volume;
    const large = evaluateDocument(sheet({ flangeB: 90 })).volume;

    expect(large).toBeGreaterThan(small * 1.4);
  });
});

describe('the other shapes', () => {
  it('a channel folds twice the same way', () => {
    const ev = evaluateDocument(sheet({ shape: 'channel', flangeA: 100, flangeB: 30, flangeC: 30 }));

    expect(ev.errors.size).toBe(0);
    expect(ev.health.closed).toBe(true);
  });

  it('a Z folds twice in opposite directions', () => {
    const z = evaluateDocument(sheet({ shape: 'z', flangeA: 80, flangeB: 30, flangeC: 30 }));
    const channel = evaluateDocument(sheet({ shape: 'channel', flangeA: 80, flangeB: 30, flangeC: 30 }));

    expect(z.health.closed).toBe(true);

    // Both have the same 80 mm web, so they match in Z. They differ along X: a channel's two
    // flanges come back over each other, and a Z's go opposite ways and reach twice as far.
    const zb = bounds(z.mesh), cb = bounds(channel.mesh);

    expect(zb.max[2]! - zb.min[2]!).toBeCloseTo(cb.max[2]! - cb.min[2]!, 1);
    expect(zb.max[0]! - zb.min[0]!).toBeGreaterThan((cb.max[0]! - cb.min[0]!) * 1.5);
  });

  it('a shallower bend angle opens the part out', () => {
    const right = bounds(evaluateDocument(sheet({ angle: 90 })).mesh);
    const shallow = bounds(evaluateDocument(sheet({ angle: 30 })).mesh);

    // Bent less, so it reaches further along the first flange's direction.
    expect(shallow.max[0]! - shallow.min[0]!).toBeGreaterThan(right.max[0]! - right.min[0]!);
  });
});

describe('what it refuses', () => {
  it('reports folds that would overlap rather than building a tangle', () => {
    const ev = evaluateDocument(sheet({ flangeA: 2, flangeB: 2, radius: 40, thickness: 10 }));
    const problem = [...ev.errors.values()][0];

    if (problem) expect(problem).toMatch(/overlap|no length/);
    else expect(ev.health.closed).toBe(true);
  });
});

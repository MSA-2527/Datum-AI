import { describe, expect, it } from 'vitest';
import { projectPart } from './projectPart';
import { addFeature, emptyDocument, evaluateDocument, type Document } from '../model/document';
import { analyseDfm } from './dfm';

/**
 * The projection from the feature tree to the 2.5D model the analysis code speaks.
 *
 * The bug it exists to close: the manufacturability tab read a sample bracket invented at
 * boot, so every finding, cost line and rule citation described a part the user had never
 * asked for. These tests assert the numbers come off the real solid, and that the projection
 * says so when the 2.5D reading is only an envelope.
 */

const build = (doc: Document) => projectPart(doc, evaluateDocument(doc));

const plate = (): Document =>
  addFeature(emptyDocument('Plate'), 'box', { length: 200, width: 120, height: 8 }, 'Plate');

describe('what the projection measures', () => {
  it('takes the envelope off the solid, not off a stored parameter', () => {
    const { geometry } = build(plate());

    expect(geometry.L).toBeCloseTo(200, 3);
    expect(geometry.W).toBeCloseTo(120, 3);
    expect(geometry.T).toBeCloseTo(8, 3);
  });

  it('carries the material and density the document was built in', () => {
    const doc = { ...plate(), material: 'Stainless 304', density: 7.9 };
    const { doc: part } = build(doc);

    expect(part.material).toBe('Stainless 304');
    expect(part.density).toBe(7.9);
    expect(part.title).toBe('Plate');
  });

  it('publishes Length, Width and Thickness, because the rules look them up by name', () => {
    const { doc: part } = build(plate());
    const named = Object.fromEntries(part.globals.map((g) => [g.name, g.value]));

    expect(named.Length).toBeCloseTo(200, 3);
    expect(named.Width).toBeCloseTo(120, 3);
    expect(named.Thickness).toBeCloseTo(8, 3);
  });

  it('reports the material removed as the gap between envelope and solid', () => {
    const doc = addFeature(
      plate(), 'hole', { diameter: 20, x: 0, y: 0, holeType: 'through', pattern: 'single' }, 'Hole');
    const { geometry } = build(doc);

    // A 20 mm hole through 8 mm of plate.
    expect(geometry.removedMm3).toBeGreaterThan(2000);
    expect(geometry.removedMm3).toBeLessThan(2800);
  });
});

describe('holes', () => {
  it('reads them from the tree when the tree has them', () => {
    const doc = addFeature(plate(), 'hole', {
      diameter: 9, holeType: 'through', pattern: 'grid',
      cols: 2, rows: 2, spacingX: 160, spacingY: 80, cx: 0, cy: 0,
    }, 'Bolt holes');
    const { geometry } = build(doc);

    expect(geometry.holes).toHaveLength(4);
    for (const h of geometry.holes) expect(h.d).toBeCloseTo(9, 3);
  });

  /*
   * The case that made the cost model read "0 holes" on a plate full of them: an archetype
   * builds its holes inside one feature, so the tree has no hole feature to find. The faces do
   * know, and this is what the drilling line is costed from.
   */
  it('recovers them from the solid when the tree has none', () => {
    const doc = addFeature(emptyDocument('Plate'), 'archetype', { archetypeId: 'plate' }, 'Plate');
    const { geometry } = build(doc);

    expect(geometry.holes.length).toBeGreaterThan(0);
    for (const h of geometry.holes) expect(h.d).toBeGreaterThan(0);
  });

  it('does not mistake a boss for a hole', () => {
    // A cylinder standing on a plate has a Z-parallel cylindrical face and solid on its axis.
    const doc = addFeature(
      plate(), 'cylinder', { diameter: 30, height: 20, z: 14 }, 'Boss');
    const { geometry } = build(doc);

    expect(geometry.holes).toHaveLength(0);
  });
});

describe('whether the 2.5D reading is fair', () => {
  it('calls a plate prismatic', () => {
    expect(build(plate()).prismatic).toBe(true);
  });

  it('calls a plate with a vertical hole prismatic — the section is still constant', () => {
    const doc = addFeature(
      plate(), 'hole', { diameter: 12, x: 0, y: 0, holeType: 'through', pattern: 'single' }, 'Hole');
    expect(build(doc).prismatic).toBe(true);
  });

  it('does not call a sphere prismatic', () => {
    const doc = addFeature(emptyDocument('Ball'), 'sphere', { diameter: 50 }, 'Ball');
    expect(build(doc).prismatic).toBe(false);
  });

  it('does not call a revolved cup prismatic', () => {
    const doc = addFeature(emptyDocument('Cup'), 'archetype', { archetypeId: 'cup' }, 'Cup');
    expect(build(doc).prismatic).toBe(false);
  });

  it('says nothing is prismatic when nothing is modelled', () => {
    expect(build(emptyDocument('Empty')).prismatic).toBe(false);
  });
});

describe('the rules run on it', () => {
  it('produces findings about the part that was built', () => {
    // 0.5 mm is below the 0.8 mm machining minimum, so the rules must object to *this* part.
    const doc = addFeature(
      addFeature(emptyDocument('Box'), 'box', { length: 80, width: 60, height: 40 }, 'Body'),
      'shell', { thickness: 0.5 }, 'Shell');

    const { doc: part, geometry } = build(doc);
    const findings = analyseDfm(part, geometry, 'mill3axis');

    expect(findings.some((f) => f.rule === 'dfm.mill.min-wall')).toBe(true);
  });

  it('costs a part from its own volume, so a bigger part costs more', () => {
    const small = build(plate());
    const big = build(addFeature(
      emptyDocument('Plate'), 'box', { length: 400, width: 240, height: 16 }, 'Plate'));

    expect(big.geometry.areaMm2).toBeGreaterThan(small.geometry.areaMm2);
  });
});

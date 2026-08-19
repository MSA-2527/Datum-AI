import { describe, expect, it } from 'vitest';
import {
  addFeature, defaultParams, emptyDocument, evaluateDocument, paramFields,
  deserialise, serialise, type Document, type ParamValue,
} from './document';
import { bounds, health, triCount } from '../kernel/topo/mesh';

/**
 * Loft and sweep, as document features.
 *
 * Both operations have been in the kernel from the start and neither could be reached from
 * the application, which is most of what "there are not enough options like a CAD software"
 * meant. A round-to-square transition, a tapered boss, an aerofoil section, a spring, a worm
 * and a screw thread were all simply unbuildable — not approximated badly, unbuildable.
 *
 * The tests are about the solids being real: closed, manifold, positive volume, and actually
 * the shape asked for rather than something the right size.
 */

function build(kind: 'loft' | 'sweep', params: Record<string, ParamValue> = {}) {
  let doc: Document = emptyDocument();
  doc = addFeature(doc, kind, { ...defaultParams(kind), ...params }, kind);
  return { doc, evaluated: evaluateDocument(doc) };
}

describe('loft', () => {
  it('builds a closed solid between two different sections', () => {
    const { evaluated } = build('loft');

    expect(evaluated.errors.size).toBe(0);
    expect(triCount(evaluated.mesh)).toBeGreaterThan(0);
    expect(evaluated.health.closed).toBe(true);
    expect(evaluated.health.manifold).toBe(true);
    expect(evaluated.volume).toBeGreaterThan(0);
  });

  it('is the height it was asked for', () => {
    const { evaluated } = build('loft', { height: 120 });
    const bb = bounds(evaluated.mesh);
    expect(bb.max[2]! - bb.min[2]!).toBeCloseTo(120, 3);
  });

  it('lies between the volumes of the two prisms it blends', () => {
    // A 60 mm square to a 40 mm circle over 60 mm. Neither end's prism is the answer, but the
    // answer has to sit between them — that is what "blend" means, and a loft that ignored
    // one of its sections would fall outside.
    const { evaluated } = build('loft');
    const squarePrism = 60 * 60 * 60;
    const circlePrism = Math.PI * 20 * 20 * 60;

    expect(evaluated.volume).toBeLessThan(squarePrism);
    expect(evaluated.volume).toBeGreaterThan(circlePrism);
  });

  it('leans when the sections are offset, rather than shearing into itself', () => {
    const { evaluated } = build('loft', { topX: 40 });
    const bb = bounds(evaluated.mesh);

    expect(evaluated.health.closed).toBe(true);
    // The top circle's centre moved 40 mm, so the solid must reach past the base footprint.
    expect(bb.max[0]!).toBeGreaterThan(31);
  });

  it('refuses a zero height rather than building a flat sheet', () => {
    const { evaluated } = build('loft', { height: 0 });
    expect([...evaluated.errors.values()][0]).toMatch(/height/i);
  });

  it('offers only the dimensions each end actually uses', () => {
    const round = paramFields('loft', { ...defaultParams('loft'), baseShape: 'circle' });
    const keys = round.map((f) => f.key);

    expect(keys).toContain('baseDiameter');
    expect(keys).not.toContain('baseLength');   // a circle has no length to edit
    expect(keys).toContain('topDiameter');
  });
});

describe('sweep', () => {
  it('builds a spring from a circle on a helix', () => {
    const { evaluated } = build('sweep');

    expect(evaluated.errors.size).toBe(0);
    expect(evaluated.health.closed).toBe(true);
    expect(evaluated.volume).toBeGreaterThan(0);
  });

  it('has the coil diameter and free length the parameters describe', () => {
    const { evaluated } = build('sweep', {
      diameter: 6, pathRadius: 30, turns: 4, pitch: 12,
    });
    const bb = bounds(evaluated.mesh);

    // Across the coil: 2 x 30 mm radius plus the 6 mm wire.
    expect(bb.max[0]! - bb.min[0]!).toBeCloseTo(66, 0);
    // Along the axis: four turns at 12 mm plus the wire.
    expect(bb.max[2]! - bb.min[2]!).toBeCloseTo(54, 0);
  });

  it('weighs about what the wire weighs', () => {
    // A sweep is its section area times its path length. Getting this wrong by the frame
    // twisting or the ends being capped twice would show up here before it showed up as a
    // quote for the wrong amount of material.
    const { evaluated } = build('sweep', { diameter: 6, pathRadius: 30, turns: 4, pitch: 12 });

    const perTurn = Math.hypot(2 * Math.PI * 30, 12);
    const expected = Math.PI * 3 * 3 * perTurn * 4;
    expect(evaluated.volume).toBeGreaterThan(expected * 0.9);
    expect(evaluated.volume).toBeLessThan(expected * 1.1);
  });

  it('builds a straight tube', () => {
    const { evaluated } = build('sweep', { path: 'line', distance: 100, diameter: 20 });
    const bb = bounds(evaluated.mesh);

    expect(evaluated.health.closed).toBe(true);
    expect(bb.max[2]! - bb.min[2]!).toBeCloseTo(100, 1);
    expect(evaluated.volume).toBeCloseTo(Math.PI * 100 * 100, -3);
  });

  it('builds a bend that starts where a straight path starts', () => {
    // Changing the path from straight to arc must not teleport the feature somewhere else:
    // an editable feature is one whose other parameters still mean what they meant.
    const { evaluated } = build('sweep', { path: 'arc', pathRadius: 60, pathAngle: 90, diameter: 20 });
    const bb = bounds(evaluated.mesh);

    expect(evaluated.health.closed).toBe(true);
    expect(bb.min[2]!).toBeCloseTo(0, 0);            // still starts at the origin
    // -10 to 60: the section spans x at the start, where the path points along Z, and spans
    // y at the finish, where it points along X. A quarter bend is not symmetric in x.
    expect(bb.max[0]! - bb.min[0]!).toBeCloseTo(70, 0);
  });

  it('tapers when an end scale is given', () => {
    const full = build('sweep', { path: 'line', distance: 100, diameter: 20 });
    const tapered = build('sweep', { path: 'line', distance: 100, diameter: 20, endScale: 0.5 });

    expect(tapered.evaluated.volume).toBeLessThan(full.evaluated.volume * 0.75);
    expect(tapered.evaluated.health.closed).toBe(true);
  });

  it('offers the parameters of the path in force, and no others', () => {
    const helix = paramFields('sweep', { ...defaultParams('sweep'), path: 'helix' }).map((f) => f.key);
    const line = paramFields('sweep', { ...defaultParams('sweep'), path: 'line' }).map((f) => f.key);

    expect(helix).toContain('turns');
    expect(helix).not.toContain('distance');
    expect(line).toContain('distance');
    expect(line).not.toContain('turns');
  });

  it('refuses a path with no length rather than building nothing quietly', () => {
    const { evaluated } = build('sweep', { path: 'line', distance: 0 });
    expect([...evaluated.errors.values()][0]).toMatch(/path/i);
  });
});

describe('both survive a save and reopen', () => {
  it('rebuilds to the same solid', () => {
    for (const kind of ['loft', 'sweep'] as const) {
      const { doc, evaluated } = build(kind);
      const again = evaluateDocument(deserialise(serialise(doc))!);

      expect(again.volume).toBeCloseTo(evaluated.volume, 6);
      expect(health(again.mesh).closed).toBe(true);
    }
  });
});

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOps, createFeature, evaluate, type PartDoc } from './partModel';
import type { Operation } from '../types';

/**
 * Cross-engine drift guard — TypeScript side.
 *
 * Asserts the same fixture the C# suite reads (tests/DATUM.Tests/DriftGuardTests.cs), from
 * the opposite direction: every operation the fixture claims the standalone modeller
 * handles must actually change the document, and every operation it lists as kernel-only
 * must be a no-op here rather than silently half-implemented.
 *
 * Half-implementing a kernel operation offline is the dangerous case: the rehearsal would
 * show geometry SOLIDWORKS never produces, and the user would trust it.
 */

function loadFixture(): { irVersion: string; handledByStandaloneModeller: string[]; kernelOnly: string[] } {
  // Walk up to the repository root; the fixture is deliberately not copied next to either
  // engine, so the two sides cannot end up reading different files.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      return JSON.parse(readFileSync(join(dir, 'tests', 'fixtures', 'op-vocabulary.json'), 'utf8'));
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error('op-vocabulary.json not found walking up from ' + process.cwd());
}

function part(): PartDoc {
  return {
    path: 'C:\\t\\p.SLDPRT',
    title: 'p.SLDPRT',
    configuration: 'Default',
    configurations: ['Default'],
    units: 'mm',
    material: '6061-T6',
    density: 2.7,
    writable: true,
    lastRebuildMs: 100,
    globals: [
      { name: 'Length', value: 100, units: 'mm' },
      { name: 'Width', value: 60, units: 'mm' },
      { name: 'Thickness', value: 8, units: 'mm' },
      { name: 'BoltCircle', value: 40, units: 'mm' },
    ],
    properties: {},
    features: [],
  };
}

/** Minimal but valid parameters per operation, so each one can actually do something. */
const SAMPLE_PARAMS: Record<string, Record<string, unknown>> = {
  'feature.hole_wizard': { fastener: 'M4' },
  'feature.simple_hole': { fastener: 'M4' },
  'feature.fillet': { radius: 4 },
  'feature.chamfer': { distance: 2, angle: 45 },
  'feature.shell': { thickness: 2 },
  'feature.extrude_cut': { width: 20, height: 6 },
  'feature.pattern_linear': { count: 3, spacing: 15 },
  'feature.pattern_circular': { count: 4, angle: 360 },
  'feature.mirror': {},
  'feature.edit.suppress': {},
  'feature.edit.unsuppress': {},
  'feature.edit.delete': {},
  'param.set_global': { name: 'Length', value: 222 },
  'param.add_global': { name: 'NewVar', value: 5 },
  'doc.set_property': { name: 'PartNo', value: 'X-1' },
  'doc.set_properties_bulk': { properties: { Vendor: 'ACME' } },
  'doc.set_material': { material: '7075-T6' },
  'sketch.fully_define': {},
  'sketch.add_relation': {},
  'feature.edit.reattach_reference': {},
};

const op = (name: string, params: Record<string, unknown> = {}): Operation =>
  ({ id: 'op1', op: name, params } as unknown as Operation);

/** A document with something to suppress, delete, pattern or repair. */
function seeded(): PartDoc {
  let d = createFeature(part(), 'holePattern', { diameter: 5, boltCircleVar: 'BoltCircle' });
  d = createFeature(d, 'slot', { width: 20, height: 6 });
  return d;
}

function fingerprint(d: PartDoc): string {
  const g = evaluate(d);
  return JSON.stringify({
    features: d.features.map((f) => [f.name, f.kind, f.suppressed, f.underDefined, f.fragileRef]),
    globals: d.globals.map((x) => [x.name, x.value]),
    properties: d.properties,
    material: d.material,
    geom: [g.L, g.W, g.T, g.cornerR, g.holes.length, g.cuts.length, g.shellWall],
  });
}

describe('drift guard', () => {
  const fixture = loadFixture();

  it('targets the current IR version', () => {
    expect(fixture.irVersion).toBe('1.4');
  });

  it('handles every operation the fixture claims, with an observable effect', () => {
    const unhandled: string[] = [];

    for (const name of fixture.handledByStandaloneModeller) {
      // Some operations need the document staged so they have work to do — unsuppress on
      // an already-live feature is legitimately a no-op, and asserting otherwise would be
      // testing the harness rather than the engine.
      let base = seeded();
      if (name === 'feature.edit.unsuppress') {
        base = { ...base, features: base.features.map((f, i) => (i === 0 ? { ...f, suppressed: true } : f)) };
      }

      const params = { ...(SAMPLE_PARAMS[name] ?? {}) };

      // Name-targeted edits need a real target from the seeded document.
      const target =
        name.startsWith('feature.edit.') && name !== 'feature.edit.reattach_reference'
          ? { kind: 'Name' as const, name: base.features[0]!.name }
          : undefined;

      const operation = { ...op(name, params), target } as Operation;
      const after = applyOps(base, [operation]);

      if (fingerprint(after) === fingerprint(base)) unhandled.push(name);
    }

    expect(
      unhandled,
      `The fixture claims these are handled offline but they changed nothing: ${unhandled.join(', ')}. ` +
        'Either implement them in partModel.applyOps or remove them from the fixture.',
    ).toEqual([]);
  });

  it('treats kernel-only operations as no-ops rather than half-implementing them', () => {
    const leaked: string[] = [];

    for (const name of fixture.kernelOnly) {
      const base = seeded();
      const after = applyOps(base, [op(name, { radius: 5, angle: 90, thickness: 3 })]);

      // Geometry must be untouched. A partial implementation would show the user geometry
      // SOLIDWORKS never produces — the worst possible failure for a rehearsal.
      const a = JSON.parse(fingerprint(after));
      const b = JSON.parse(fingerprint(base));
      if (JSON.stringify(a.geom) !== JSON.stringify(b.geom)) leaked.push(name);
    }

    expect(
      leaked,
      `These need a geometric kernel but changed offline geometry: ${leaked.join(', ')}.`,
    ).toEqual([]);
  });

  it('never lists an operation as both offline and kernel-only', () => {
    const both = fixture.handledByStandaloneModeller.filter((o) => fixture.kernelOnly.includes(o));
    expect(both).toEqual([]);
  });

  it('leaves an unknown operation completely alone', () => {
    const base = seeded();
    const after = applyOps(base, [op('feature.does_not_exist', { radius: 9 })]);
    expect(fingerprint(after)).toBe(fingerprint(base));
  });
});

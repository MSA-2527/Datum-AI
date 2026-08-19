import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readStep } from './read';
import { fitArchetype } from '../fit/archetype';
import { fitPrismatic } from '../fit/prismatic';
import { bounds, massProperties } from '../../kernel/topo/mesh';

/**
 * Parts from a real SOLIDWORKS library.
 *
 * Four files exported by SOLIDWORKS 2025 (`SwSTEP 2.0`, AP214) from a working library of
 * clips and bases. They are here because every earlier test in this folder round-trips
 * through *this project's own exporter*, which is a narrow dialect — and the first contact
 * with a real translator found three defects that the round trip could never have shown.
 *
 * The most serious was units. Every one of these files is modelled in **inches** and says so
 * in a `CONVERSION_BASED_UNIT` four hundred entities away from any coordinate. Read without
 * it, a 0.75 inch clip arrives 0.75 mm across: every dimension, the mass, the area, the cost
 * estimate and every manufacturability check wrong by a factor of 25.4, with nothing about
 * the result looking wrong.
 *
 * The assertions below are dimensional and independent of this reader: the parts are clips
 * and bases from a 423-series drawing set, so they are tens of millimetres across and weigh
 * grams. A file that comes back in the wrong unit fails them by a factor of 25.
 */

const read = (name: string) => {
  const result = readStep(readFileSync(`src/ingest/step/fixtures/${name}`, 'utf8'));
  if ('error' in result) throw new Error(`${name}: ${result.error}`);
  return result;
};

const sizeOf = (mesh: Parameters<typeof bounds>[0]) => {
  const b = bounds(mesh);
  return [0, 1, 2].map((i) => b.max[i]! - b.min[i]!).sort((a, c) => c - a);
};

describe('reading a real SOLIDWORKS export', () => {
  const cases: [string, [number, number, number]][] = [
    ['100-0194.step', [0.750, 0.647, 0.250]],
    ['100-0587_0.step', [1.238, 1.128, 0.300]],
    ['423-0293.STEP', [2.707, 1.752, 0.500]],
    ['423-0292.STEP', [2.810, 2.301, 0.600]],
  ];

  for (const [name, inches] of cases) {
    it(`${name} comes back at its real size`, () => {
      const result = read(name);
      const measured = sizeOf(result.mesh).map((mm) => mm / 25.4);

      inches.forEach((inch, i) => expect(measured[i], `axis ${i}`).toBeCloseTo(inch, 2));
      expect(result.notes.join(' ')).toMatch(/INCH/);
    });
  }

  it('gives every part a stock thickness, which no unit error could', () => {
    // The thinnest axis of each of these comes out at exactly 0.250, 0.300, 0.500 and 0.600
    // inches — the sheet and plate stock they are cut from. Nothing about the reader knows
    // that, so it is a check on the conversion from outside it: a file read as millimetres
    // would give 0.0098 inches, and a file read at any wrong factor would give numbers that
    // are not stock sizes at all.
    const STOCK = [0.125, 0.187, 0.25, 0.3, 0.375, 0.5, 0.6, 0.75, 1];

    for (const [name] of cases) {
      const thinnest = sizeOf(read(name).mesh).pop()! / 25.4;
      const nearest = STOCK.reduce((best, s) =>
        (Math.abs(s - thinnest) < Math.abs(best - thinnest) ? s : best));

      expect(Math.abs(nearest - thinnest), `${name}: ${thinnest.toFixed(4)} in`)
        .toBeLessThan(0.005);
    }
  });

  it('reads every face of the parts that use no freeform surfaces', () => {
    for (const [name] of cases) {
      const result = read(name);
      expect(result.skipped, name).toEqual([]);
      expect(result.faces, name).toBeGreaterThan(10);
    }
  });

  it('closes all four, once a multi-body part is read as several bodies', () => {
    // 423-0292 is two solids — "Mirror1" and "Convert-Solid2". Merging them into one mesh put
    // four triangles on every shared edge and reported a perfectly sound part as non-manifold,
    // which is a fact about the merge rather than about the part.
    for (const [name] of cases) {
      const result = read(name);
      expect(result.closed, name).toBe(true);
      expect(result.bodies.every((b) => b.closed), name).toBe(true);
    }
  });

  it('reads a multi-body part as its separate bodies, named', () => {
    const result = read('423-0292.STEP');

    expect(result.bodies).toHaveLength(2);
    expect(result.bodies.map((b) => b.name).sort()).toEqual(['Convert-Solid2', 'Mirror1']);
    expect(result.notes.join(' ')).toMatch(/2 separate bodies/);
  });

  it('weighs grams, not milligrams — the check a unit error cannot pass', () => {
    for (const [name] of cases) {
      const mm3 = Math.abs(massProperties(read(name).mesh).volume);
      const grams = (mm3 / 1000) * 2.7;          // as aluminium

      expect(grams, name).toBeGreaterThan(0.3);
      expect(grams, name).toBeLessThan(200);
    }
  });

  it('recognises three of the four as editable profiles', () => {
    // Not a catalogue shape between them — these are machined clips and bases — so they are
    // read as profiles instead. The fourth is two bodies, and neither is a single stack.
    const recovered = cases
      .map(([name]) => fitPrismatic(read(name).mesh).best !== null)
      .filter(Boolean);

    expect(recovered).toHaveLength(3);
    for (const [name] of cases) expect(fitArchetype(read(name).mesh).best, name).toBeNull();
  });
});

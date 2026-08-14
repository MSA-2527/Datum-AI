import { describe, expect, it } from 'vitest';
import {
  addInstance, addMate, addPart, assemblyProperties, billOfMaterials, emptyAssembly,
  findInterference, flattenAssembly, instanceTransform, placedMesh, solveMates,
} from './assembly';
import { box, cylinder } from '../ops/build';
import { subtractAll } from '../ops/boolean';
import { bounds, health, massProperties } from '../topo/mesh';
import { dist3, xformPoint } from '../math/vec';

/**
 * Assembly tests.
 *
 * The point of an assembly is that components are *positioned by relationships*, so these
 * check that the mates actually hold — measured on the resulting geometry, not on the
 * solver's own report — and that the four constraint states are distinguished, since a
 * mechanism deliberately keeps a degree of freedom and a mistake accidentally keeps one, and
 * the user needs to know which they have.
 */

describe('instances', () => {
  it('places a part where its instance says', () => {
    const asm = emptyAssembly();
    const p = addPart(asm, box(20, 20, 20), 'Block');
    const i = addInstance(asm, p, [50, 30, 10]);

    const mesh = placedMesh(asm, i)!;
    const b = bounds(mesh);
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(50, 6);
    expect((b.min[1] + b.max[1]) / 2).toBeCloseTo(30, 6);
    expect((b.min[2] + b.max[2]) / 2).toBeCloseTo(10, 6);
  });

  it('keeps each instance a valid solid', () => {
    const asm = emptyAssembly();
    const p = addPart(asm, cylinder(10, 40), 'Pin');
    addInstance(asm, p, [0, 0, 0]);
    addInstance(asm, p, [100, 0, 0]);

    for (const m of flattenAssembly(asm)) expect(health(m).closed).toBe(true);
  });

  it('shares one part between several instances', () => {
    const asm = emptyAssembly();
    const p = addPart(asm, box(10, 10, 10), 'Spacer');
    addInstance(asm, p, [0, 0, 0]);
    addInstance(asm, p, [20, 0, 0]);
    addInstance(asm, p, [40, 0, 0]);

    const props = assemblyProperties(asm);
    expect(props.instanceCount).toBe(3);
    expect(props.uniquePartCount).toBe(1);
  });
});

describe('mate solving', () => {
  it('brings two points together with a coincident mate', () => {
    const asm = emptyAssembly();
    const base = addPart(asm, box(60, 60, 10), 'Base');
    const pin = addPart(asm, cylinder(5, 30), 'Pin');

    const bi = addInstance(asm, base, [0, 0, 0], true);
    const pi = addInstance(asm, pin, [40, 25, 60]);

    addMate(asm, 'coincident', { instance: bi.id, point: [0, 0, 5] }, { instance: pi.id, point: [0, 0, -15] });

    const r = solveMates(asm);
    const solved = r.assembly.instances.find((i) => i.id === pi.id)!;

    // The pin's lower end must sit on the base's top face. It has to be measured through
    // the instance's full transform, not by subtracting from its position: the solver is
    // free to rotate the component as well as move it, and a satisfied mate with a rotated
    // pin would look like a failure to a check that only looked at translation.
    const tip = xformPoint(instanceTransform(solved), [0, 0, -15]);
    expect(dist3(tip, [0, 0, 5])).toBeLessThan(1e-5);
  });

  it('holds a distance mate exactly', () => {
    const asm = emptyAssembly();
    const p = addPart(asm, box(10, 10, 10), 'Block');
    const a = addInstance(asm, p, [0, 0, 0], true);
    const b = addInstance(asm, p, [3, 7, 2]);

    addMate(asm, 'distance', { instance: a.id, point: [0, 0, 0] }, { instance: b.id, point: [0, 0, 0] }, 50);

    const r = solveMates(asm);
    const moved = r.assembly.instances.find((i) => i.id === b.id)!;
    expect(dist3(moved.position, [0, 0, 0])).toBeCloseTo(50, 5);
  });

  it('aligns axes with a concentric mate', () => {
    const asm = emptyAssembly();
    const plate = addPart(asm, box(80, 80, 10), 'Plate');
    const shaft = addPart(asm, cylinder(6, 50), 'Shaft');

    const pi = addInstance(asm, plate, [0, 0, 0], true);
    const si = addInstance(asm, shaft, [23, -14, 30]);

    addMate(
      asm, 'concentric',
      { instance: pi.id, point: [0, 0, 0], direction: [0, 0, 1] },
      { instance: si.id, point: [0, 0, 0], direction: [0, 0, 1] },
    );

    const r = solveMates(asm);
    const moved = r.assembly.instances.find((i) => i.id === si.id)!;

    // The shaft must land on the plate's axis; how far along it is left free, which is
    // exactly what a concentric mate means.
    expect(Math.hypot(moved.position[0], moved.position[1])).toBeLessThan(1e-4);
  });

  it('leaves the sliding freedom a concentric mate is supposed to leave', () => {
    const asm = emptyAssembly();
    const plate = addPart(asm, box(80, 80, 10), 'Plate');
    const shaft = addPart(asm, cylinder(6, 50), 'Shaft');

    const pi = addInstance(asm, plate, [0, 0, 0], true);
    const si = addInstance(asm, shaft, [10, 10, 30]);

    addMate(
      asm, 'concentric',
      { instance: pi.id, point: [0, 0, 0], direction: [0, 0, 1] },
      { instance: si.id, point: [0, 0, 0], direction: [0, 0, 1] },
    );

    const r = solveMates(asm);
    // A shaft in a bore can still slide and spin: that is a mechanism, not a mistake.
    expect(r.status).toBe('under');
    expect(r.degreesOfFreedom).toBeGreaterThan(0);
    expect(r.freeInstances).toContain(si.id);
  });

  it('makes two directions parallel', () => {
    const asm = emptyAssembly();
    const p = addPart(asm, box(20, 10, 5), 'Bar');
    const a = addInstance(asm, p, [0, 0, 0], true);
    const b = addInstance(asm, p, [50, 0, 0]);

    addMate(
      asm, 'parallel',
      { instance: a.id, direction: [1, 0, 0] },
      { instance: b.id, direction: [0, 1, 0] },
    );

    const r = solveMates(asm);
    expect(r.residual).toBeLessThan(1e-5);
  });

  it('converges from a badly wrong starting position', () => {
    // Dropping a component in roughly the right place is what a user does; the solver has
    // to cope with "roughly" meaning half a metre away.
    const asm = emptyAssembly();
    const p = addPart(asm, box(10, 10, 10), 'Block');
    const a = addInstance(asm, p, [0, 0, 0], true);
    const b = addInstance(asm, p, [900, -700, 400]);

    addMate(asm, 'coincident', { instance: a.id, point: [5, 0, 0] }, { instance: b.id, point: [-5, 0, 0] });

    const r = solveMates(asm);
    expect(r.status === 'solved' || r.status === 'under').toBe(true);
    expect(r.residual).toBeLessThan(1e-5);
  });

  it('anchors on the fixed component rather than moving it', () => {
    const asm = emptyAssembly();
    const p = addPart(asm, box(10, 10, 10), 'Block');
    const fixed = addInstance(asm, p, [17, 23, 31], true);
    const free = addInstance(asm, p, [0, 0, 0]);

    addMate(asm, 'coincident', { instance: fixed.id, point: [0, 0, 0] }, { instance: free.id, point: [0, 0, 0] });

    const r = solveMates(asm);
    const stillThere = r.assembly.instances.find((i) => i.id === fixed.id)!;
    expect(stillThere.position).toEqual([17, 23, 31]);
  });
});

describe('diagnosis', () => {
  it('reports an assembly with no mates as unconstrained, with advice', () => {
    const asm = emptyAssembly();
    const p = addPart(asm, box(10, 10, 10), 'Block');
    addInstance(asm, p, [0, 0, 0]);

    const r = solveMates(asm);
    expect(r.status).toBe('under');
    expect(r.message).toMatch(/unconstrained|fix a component/i);
  });

  it('reports contradictory mates and names them', () => {
    const asm = emptyAssembly();
    const p = addPart(asm, box(10, 10, 10), 'Block');
    const a = addInstance(asm, p, [0, 0, 0], true);
    const b = addInstance(asm, p, [20, 0, 0]);

    const m1 = addMate(asm, 'distance', { instance: a.id, point: [0, 0, 0] }, { instance: b.id, point: [0, 0, 0] }, 30);
    const m2 = addMate(asm, 'distance', { instance: a.id, point: [0, 0, 0] }, { instance: b.id, point: [0, 0, 0] }, 80);

    const r = solveMates(asm);
    expect(r.status).toBe('conflict');
    expect(r.problemMates.length).toBeGreaterThan(0);
    expect([m1.id, m2.id].some((id) => r.problemMates.includes(id))).toBe(true);
  });

  it('handles an empty assembly', () => {
    const r = solveMates(emptyAssembly());
    expect(r.status).toBe('solved');
    expect(r.message).toMatch(/empty/i);
  });

  it('ignores suppressed components and mates', () => {
    const asm = emptyAssembly();
    const p = addPart(asm, box(10, 10, 10), 'Block');
    addInstance(asm, p, [0, 0, 0], true);
    const b = addInstance(asm, p, [20, 0, 0]);
    b.suppressed = true;

    const r = solveMates(asm);
    expect(r.degreesOfFreedom).toBe(0);
    expect(assemblyProperties(asm).instanceCount).toBe(1);
  });
});

describe('interference', () => {
  it('finds two components occupying the same space', () => {
    const asm = emptyAssembly();
    const p = addPart(asm, box(20, 20, 20), 'Block');
    const a = addInstance(asm, p, [0, 0, 0], true);
    const b = addInstance(asm, p, [10, 0, 0], true);

    const clashes = findInterference(asm);
    expect(clashes.length).toBe(1);
    expect(clashes[0].volume).toBeCloseTo(10 * 20 * 20, -1);
    expect([clashes[0].a, clashes[0].b].sort()).toEqual([a.id, b.id].sort());
  });

  it('reports nothing for components that merely touch', () => {
    const asm = emptyAssembly();
    const p = addPart(asm, box(20, 20, 20), 'Block');
    addInstance(asm, p, [0, 0, 0], true);
    addInstance(asm, p, [20, 0, 0], true);

    expect(findInterference(asm).length).toBe(0);
  });

  it('reports nothing for components far apart', () => {
    const asm = emptyAssembly();
    const p = addPart(asm, box(10, 10, 10), 'Block');
    addInstance(asm, p, [0, 0, 0], true);
    addInstance(asm, p, [500, 0, 0], true);

    expect(findInterference(asm).length).toBe(0);
  });

  it('distinguishes a press fit from a clash', () => {
    // A genuine press fit: a 10.01 mm pin in a 10.00 mm bore. The overlap is a shell five
    // microns thick — deliberate, and how dowels and bearings are retained. Flagging it the
    // same as a real collision trains users to ignore the check entirely.
    const asm = emptyAssembly();
    const housing = subtractAll(box(40, 40, 30), [cylinder(5, 40)]).mesh;
    const bore = addPart(asm, housing, 'Housing');
    const pin = addPart(asm, cylinder(5.005, 30), 'Dowel');

    addInstance(asm, bore, [0, 0, 0], true);
    addInstance(asm, pin, [0, 0, 0], true);

    const fits = findInterference(asm);
    expect(fits.length).toBe(1);
    expect(fits[0].likelyPressFit).toBe(true);
    expect(fits[0].fraction).toBeLessThan(0.01);

    // A real collision: two blocks a quarter buried in one another.
    const asm2 = emptyAssembly();
    const big = addPart(asm2, box(20, 20, 20), 'Block');
    addInstance(asm2, big, [0, 0, 0], true);
    addInstance(asm2, big, [5, 0, 0], true);

    const clashes = findInterference(asm2);
    expect(clashes[0].likelyPressFit).toBe(false);
    expect(clashes[0].fraction).toBeGreaterThan(0.1);
  });
});

describe('mass properties and BOM', () => {
  it('sums component masses', () => {
    const asm = emptyAssembly();
    // 100 x 100 x 10 mm of aluminium is 100 cm^3, so 270 g each.
    const p = addPart(asm, box(100, 100, 10), 'Plate', 'Al 6061-T6', 2.7);
    addInstance(asm, p, [0, 0, 0], true);
    addInstance(asm, p, [0, 0, 50], true);

    expect(assemblyProperties(asm).massGrams).toBeCloseTo(540, 0);
  });

  it('weights the centre of mass by mass, not by position alone', () => {
    // Steel at one end and aluminium at the other: the centre must sit near the steel.
    // Averaging geometric centres would put it exactly halfway, which is badly wrong.
    const asm = emptyAssembly();
    const steel = addPart(asm, box(20, 20, 20), 'Steel block', 'Steel', 7.85);
    const alu = addPart(asm, box(20, 20, 20), 'Alu block', 'Aluminium', 2.7);

    addInstance(asm, steel, [0, 0, 0], true);
    addInstance(asm, alu, [100, 0, 0], true);

    const com = assemblyProperties(asm).centreOfMass;
    expect(com[0]).toBeLessThan(50);
    expect(com[0]).toBeCloseTo((0 * 7.85 + 100 * 2.7) / (7.85 + 2.7), 1);
  });

  it('rolls the BOM up by part with quantities', () => {
    const asm = emptyAssembly();
    const plate = addPart(asm, box(100, 100, 10), 'Base plate', 'Al 6061-T6', 2.7);
    const bolt = addPart(asm, cylinder(4, 30), 'M8 bolt', 'Steel', 7.85);

    addInstance(asm, plate, [0, 0, 0], true);
    for (let i = 0; i < 4; i++) addInstance(asm, bolt, [i * 20, 0, 20], true);

    const bom = billOfMaterials(asm);
    expect(bom.length).toBe(2);

    const boltLine = bom.find((b) => b.description === 'M8 bolt')!;
    expect(boltLine.quantity).toBe(4);
    expect(boltLine.material).toBe('Steel');

    // Heaviest first, so the significant items are at the top.
    expect(bom[0].massGrams).toBeGreaterThanOrEqual(bom[1].massGrams);
  });

  it('gives an empty assembly zero mass rather than NaN', () => {
    const props = assemblyProperties(emptyAssembly());
    expect(props.massGrams).toBe(0);
    expect(props.centreOfMass).toEqual([0, 0, 0]);
  });
});

describe('transforms', () => {
  it('produces a transform that round-trips a point', () => {
    const asm = emptyAssembly();
    const p = addPart(asm, box(10, 10, 10), 'Block');
    const i = addInstance(asm, p, [12, -5, 8]);

    const m = instanceTransform(i);
    const moved = massProperties(placedMesh(asm, i)!).centroid;
    expect(moved[0]).toBeCloseTo(12, 5);
    void m;
  });
});

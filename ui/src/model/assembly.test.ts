import { beforeAll, describe, expect, it } from 'vitest';
import {
  documentToAssembly, findDocumentClashes, isComponent, newMateId, solveDocumentMates,
} from './assembly';
import {
  addFeature, emptyDocument, placeFeature, type Document, type DocumentMate,
} from './document';
import { initManifold } from '../kernel/ops/manifold';

/**
 * The feature tree as an assembly.
 *
 * The kernel's mates, mate solver and interference check had never been called by anything.
 * Wiring them up is mostly a question of getting the *bridge* right, and every test here
 * guards a way the bridge was wrong first.
 */

beforeAll(async () => { await initManifold(); });

/** A box, a cavity cut into it, and a cylinder sitting apart. */
function gearboxLike(): Document {
  let doc = emptyDocument('Assembly');
  doc = addFeature(doc, 'box', { length: 100, width: 80, height: 60, operation: 'place' }, 'Case');
  doc = addFeature(doc, 'box', { length: 90, width: 70, height: 50, operation: 'cut' }, 'Case cavity');
  doc = addFeature(doc, 'cylinder', { diameter: 20, height: 40, operation: 'place' }, 'Shaft');
  return doc;
}

/**
 * The same assembly with its shaft moved off-axis.
 *
 * Built once and then placed. Calling the factory twice — once for the document and once to
 * look up an id — produces two documents with different feature ids, so the placement targets
 * nothing and silently does nothing. That made the "a mate moves the part" test pass for the
 * wrong reason: the shaft was already at the origin it was supposed to be pulled to.
 */
function offsetGearbox() {
  const base = gearboxLike();
  const doc = placeFeature(base, base.features[2].id, { x: 40, y: 25, z: 0 });
  return { doc, caseF: doc.features[0], shaft: doc.features[2] };
}

describe('deciding what is a component', () => {
  it('counts a placed body, not a cut and not a modifier', () => {
    const doc = gearboxLike();
    const [caseF, cavity, shaft] = doc.features;

    expect(isComponent(caseF)).toBe(true);
    expect(isComponent(shaft)).toBe(true);
    // A cavity is a tool that hollows the case, not a part sitting inside it.
    expect(isComponent(cavity)).toBe(false);
  });

  it('accepts the "place" operation an assembly actually uses', () => {
    // Generated assemblies use `place` — a separate body rather than a union — for every
    // component. Accepting only `add` found nothing in a phone, a gearbox or a bicycle:
    // sixteen features and zero instances.
    const doc = addFeature(emptyDocument(), 'box', { operation: 'place' }, 'Part');
    expect(isComponent(doc.features[0])).toBe(true);
  });

  it('ignores a suppressed component', () => {
    const doc = gearboxLike();
    expect(isComponent({ ...doc.features[0], suppressed: true })).toBe(false);
  });
});

describe('building the assembly', () => {
  it('makes one instance per component', () => {
    const { assembly } = documentToAssembly(gearboxLike());

    expect(assembly.instances).toHaveLength(2);          // case and shaft; the cavity is a tool
    expect(assembly.instances.map((i) => i.name)).toEqual(['Case', 'Shaft']);
  });

  it('fixes exactly one instance, so a solve has something to move against', () => {
    const { assembly } = documentToAssembly(gearboxLike());
    expect(assembly.instances.filter((i) => i.fixed)).toHaveLength(1);
    expect(assembly.instances[0].fixed).toBe(true);
  });

  it('applies a cut to the bodies before it', () => {
    // This is what made the check trustworthy. Built independently, the case is a solid block
    // and every part inside it "clashes" — a gearbox reported fourteen, all artefacts.
    const hollow = documentToAssembly(gearboxLike());
    const solid = documentToAssembly({
      ...gearboxLike(),
      features: gearboxLike().features.filter((f) => f.name !== 'Case cavity'),
    });

    const volumeOf = (a: ReturnType<typeof documentToAssembly>, name: string) => {
      const inst = a.assembly.instances.find((i) => i.name === name)!;
      return a.assembly.parts.get(inst.partId)!.mesh;
    };

    // The hollowed case has more triangles and less material than the solid one.
    expect(volumeOf(hollow, 'Case').indices.length)
      .toBeGreaterThan(volumeOf(solid, 'Case').indices.length);
  });

  it('maps features and instances both ways', () => {
    const doc = gearboxLike();
    const { featureOf, instanceOf } = documentToAssembly(doc);

    const shaftId = doc.features[2].id;
    const inst = instanceOf.get(shaftId)!;
    expect(featureOf.get(inst)).toBe(shaftId);
  });
});

describe('mates', () => {
  const concentric = (a: string, b: string): DocumentMate => ({
    id: newMateId(),
    kind: 'concentric',
    a: { feature: a, point: [0, 0, 0], direction: [0, 0, 1] },
    b: { feature: b, point: [0, 0, 0], direction: [0, 0, 1] },
  });

  it('moves a component onto the axis it is mated to', () => {
    const { doc, caseF, shaft } = offsetGearbox();
    // It starts genuinely off-axis, or the assertion below proves nothing.
    expect(doc.features[2].placement!.x).toBe(40);

    const solved = solveDocumentMates(doc, [concentric(caseF.id, shaft.id)]);
    const at = solved.positions.get(shaft.id)!;

    expect(at[0]).toBeCloseTo(0, 6);
    expect(at[1]).toBeCloseTo(0, 6);
  });

  it('is keyed by feature, so it survives the assembly being rebuilt', () => {
    // Instance ids are minted fresh on every build. A mate holding one refers to an instance
    // that no longer exists the moment anything is edited — the first version did exactly
    // that, silently solved nothing, and reported six untouched degrees of freedom.
    const { doc, caseF, shaft } = offsetGearbox();
    const mate = concentric(caseF.id, shaft.id);

    // Solve twice from scratch: the second build has entirely different instance ids.
    const first = solveDocumentMates(doc, [mate]);
    const second = solveDocumentMates(doc, [mate]);

    expect(second.positions.get(shaft.id)).toEqual(first.positions.get(shaft.id));
    expect(second.orphaned).toHaveLength(0);
  });

  it('reports a mate onto a component that is gone', () => {
    const doc = gearboxLike();
    const solved = solveDocumentMates(doc, [concentric(doc.features[0].id, 'deleted')]);

    expect(solved.orphaned).toHaveLength(1);
    expect(solved.summary).toMatch(/no longer in the tree/i);
  });

  it('ignores a suppressed mate', () => {
    const { doc, caseF, shaft } = offsetGearbox();

    const solved = solveDocumentMates(doc, [{ ...concentric(caseF.id, shaft.id), suppressed: true }]);
    expect(solved.positions.get(shaft.id)![0]).toBeCloseTo(40, 6);
  });

  it('reports how much freedom is left', () => {
    const doc = gearboxLike();
    const none = solveDocumentMates(doc, []);

    // One free component with six degrees of freedom, and nothing holding it.
    expect(none.result.degreesOfFreedom).toBe(6);
    expect(none.summary).toMatch(/6 degrees of freedom/);
  });
});

describe('clash checking', () => {
  it('finds two bodies in the same place', () => {
    let doc = emptyDocument('Clashing');
    doc = addFeature(doc, 'box', { length: 60, width: 60, height: 60, operation: 'place' }, 'Block');
    doc = addFeature(doc, 'box', { length: 40, width: 40, height: 40, operation: 'place' }, 'Insert');

    const report = findDocumentClashes(doc);
    const real = report.clashes.filter((c) => !c.likelyPressFit);

    expect(real).toHaveLength(1);
    expect(real[0].fraction).toBeGreaterThan(0.5);
    expect(report.summary).toMatch(/1 clash/);
  });

  it('says so plainly when nothing overlaps', () => {
    let doc = emptyDocument('Apart');
    doc = addFeature(doc, 'box', { length: 20, width: 20, height: 20, operation: 'place' }, 'A');
    doc = addFeature(doc, 'box', { length: 20, width: 20, height: 20, operation: 'place' }, 'B');
    doc = placeFeature(doc, doc.features[1].id, { x: 200, y: 0, z: 0 });

    const report = findDocumentClashes(doc);
    expect(report.clashes).toHaveLength(0);
    expect(report.summary).toMatch(/No components share space/i);
  });

  it('does not report a part against the cavity that made room for it', () => {
    // The case is hollowed before the shaft is compared to it, so the two do not overlap.
    const doc = gearboxLike();
    const report = findDocumentClashes(doc);

    expect(report.nameOf.size).toBe(2);
    expect([...report.nameOf.values()]).not.toContain('Case cavity');
  });

  it('names the components rather than internal ids', () => {
    let doc = emptyDocument('Named');
    doc = addFeature(doc, 'box', { length: 60, width: 60, height: 60, operation: 'place' }, 'Housing');
    doc = addFeature(doc, 'box', { length: 40, width: 40, height: 40, operation: 'place' }, 'Rotor');

    const report = findDocumentClashes(doc);
    const first = report.clashes[0];
    expect(report.nameOf.get(first.a)).toBe('Housing');
    expect(report.nameOf.get(first.b)).toBe('Rotor');
  });
});

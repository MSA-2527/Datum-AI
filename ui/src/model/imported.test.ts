import { describe, expect, it } from 'vitest';
import {
  addFeature, deserialise, emptyDocument, evaluateDocument, serialise, type ParamValue,
} from './document';
import { box } from '../kernel/ops/build';
import {
  deserialiseMesh, massProperties, serialiseMesh, triCount, type Mesh,
} from '../kernel/topo/mesh';

/**
 * Imported geometry survives a save.
 *
 * Schema 2 discarded an imported mesh on serialise, on the reasoning that geometry is derived
 * and the tree is the document. That is right for every feature with a tree to rebuild from
 * and exactly wrong for the one kind that has none: a traced photograph or a reconstructed
 * drawing has no recipe behind it, so the mesh *is* the feature.
 *
 * The effect was that importing a drawing worked, and saving it silently produced a file that
 * reopened empty — which made the entire import path useless for the thing it exists to do,
 * bringing an existing library of parts in.
 */

function importedDoc(name = 'From drawing'): { doc: ReturnType<typeof emptyDocument>; mesh: Mesh } {
  const mesh = box(80, 40, 12, [0, 0, 0], 'Imported');
  const doc = addFeature(
    emptyDocument(name),
    'imported',
    { __mesh: mesh as unknown as ParamValue, operation: 'add' },
    'Reconstructed solid',
  );
  return { doc, mesh };
}

describe('a mesh through JSON', () => {
  it('comes back as typed arrays, not index-keyed objects', () => {
    const mesh = box(10, 20, 30, [0, 0, 0], 'Test');
    const back = deserialiseMesh(JSON.parse(JSON.stringify(serialiseMesh(mesh))))!;

    expect(back).not.toBeNull();
    expect(back.positions).toBeInstanceOf(Float64Array);
    expect(back.indices).toBeInstanceOf(Uint32Array);
    expect(triCount(back)).toBe(triCount(mesh));
  });

  it('keeps the volume to well inside any machining tolerance', () => {
    const mesh = box(10, 20, 30, [0, 0, 0], 'Test');
    const back = deserialiseMesh(JSON.parse(JSON.stringify(serialiseMesh(mesh))))!;

    // Positions are rounded to 1e-4 mm, which cannot move a 6000 mm³ volume measurably.
    expect(Math.abs(massProperties(back).volume)).toBeCloseTo(6000, 3);
  });

  it('keeps the face tags, so the solid stays selectable rather than becoming a soup', () => {
    const mesh = box(10, 20, 30, [0, 0, 0], 'Test');
    const back = deserialiseMesh(JSON.parse(JSON.stringify(serialiseMesh(mesh))))!;

    expect(back.tags.size).toBe(mesh.tags.size);
    expect([...back.tags.values()][0]!.kind).toBe([...mesh.tags.values()][0]!.kind);
  });

  it('refuses anything that is not a mesh rather than returning a half-built one', () => {
    expect(deserialiseMesh(null)).toBeNull();
    expect(deserialiseMesh({ positions: [1, 2], indices: [] })).toBeNull();   // not a multiple of 3
    expect(deserialiseMesh({ nope: true })).toBeNull();
  });
});

describe('an imported part through save and reopen', () => {
  it('still has its geometry', () => {
    const { doc } = importedDoc();
    const before = evaluateDocument(doc);
    expect(triCount(before.mesh)).toBeGreaterThan(0);

    const reopened = deserialise(serialise(doc))!;
    const after = evaluateDocument(reopened);

    expect(triCount(after.mesh)).toBe(triCount(before.mesh));
    expect(after.errors.size).toBe(0);
  });

  it('weighs the same afterwards', () => {
    const { doc } = importedDoc();
    const before = evaluateDocument(doc).massGrams;
    const after = evaluateDocument(deserialise(serialise(doc))!).massGrams;

    expect(after).toBeCloseTo(before, 3);
  });

  it('survives two round trips, so a re-save does not degrade it', () => {
    const { doc } = importedDoc();
    const once = deserialise(serialise(doc))!;
    const twice = deserialise(serialise(once))!;

    expect(triCount(evaluateDocument(twice).mesh)).toBe(triCount(evaluateDocument(doc).mesh));
  });

  it('is written under schema 3, so an older build does not misread it', () => {
    const { doc } = importedDoc();
    expect(JSON.parse(serialise(doc)).schema).toBe(3);
  });

  it('reports geometry as missing for a schema-2 file rather than pretending', () => {
    // Those files really did lose the mesh. Saying so is the only honest answer.
    const legacy = JSON.stringify({
      schema: 2,
      name: 'Old import',
      units: 'mm',
      material: 'Aluminium 6061-T6',
      density: 2.7,
      globals: [],
      features: [{
        id: 'f1', name: 'Reconstructed solid', kind: 'imported', suppressed: false,
        params: { __dropped: true, operation: 'add' },
      }],
    });

    const doc = deserialise(legacy)!;
    expect(doc.features).toHaveLength(1);
    expect(evaluateDocument(doc).errors.size).toBe(1);
  });

  it('leaves ordinary features alone — they are still rebuilt from the tree', () => {
    const doc = addFeature(emptyDocument('Block'), 'box', { length: 60, width: 40, height: 25 }, 'Body');
    const text = serialise(doc);

    // The whole point of a feature tree is that it does not store triangles.
    expect(text).not.toContain('positions');
    expect(text.length).toBeLessThan(600);
  });
});

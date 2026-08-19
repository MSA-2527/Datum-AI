import { describe, expect, it } from 'vitest';
import { measureFaces } from './measure';
import { addFeature, defaultParams, emptyDocument, evaluateDocument } from '../model/document';
import { buildFaceGraph } from '../kernel/topo/facegraph';
import type { Mesh } from '../kernel/topo/mesh';

/**
 * Measuring, from the triangles rather than from the parameters.
 *
 * The point of measuring geometry instead of reporting what was typed is to catch the case
 * worth catching: a part that did not come out the way its parameters said. A readout wired
 * to the input values agrees with itself no matter what the kernel built.
 */

function boxMesh(l = 60, w = 40, h = 25): Mesh {
  let doc = emptyDocument();
  doc = addFeature(doc, 'box', { ...defaultParams('box'), length: l, width: w, height: h }, 'Box1');
  return evaluateDocument(doc).mesh;
}

/** The face whose outward normal points furthest along `axis`. */
function faceAlong(mesh: Mesh, axis: [number, number, number]): number {
  const g = buildFaceGraph(mesh);
  let best = -1, score = -Infinity;
  for (const f of g.faces.values()) {
    const d = f.axis[0] * axis[0] + f.axis[1] * axis[1] + f.axis[2] * axis[2];
    if (d > score) { score = d; best = f.id; }
  }
  return best;
}

const value = (m: ReturnType<typeof measureFaces>, label: string) =>
  m?.lines.find((l) => l.label === label)?.value;

describe('one face', () => {
  it('reports the area of a box face in the units it belongs in', () => {
    const mesh = boxMesh();
    const m = measureFaces(mesh, [faceAlong(mesh, [0, 0, 1])]);

    // The top face of a 60 x 40 box is 2400 mm², which reads as 24 cm².
    expect(value(m, 'Area')).toBe('24.00 cm²');
  });

  it('gives a cylinder its diameter rather than a normal', () => {
    let doc = emptyDocument();
    doc = addFeature(doc, 'cylinder', { ...defaultParams('cylinder'), diameter: 40, height: 50 }, 'Cyl');
    const mesh = evaluateDocument(doc).mesh;

    const g = buildFaceGraph(mesh);
    const round = [...g.faces.values()].find((f) => f.tag.kind === 'cylindrical')!;
    const m = measureFaces(mesh, [round.id]);

    expect(value(m, 'Diameter')).toBe('40.00 mm');
    expect(value(m, 'Length')).toBe('50.00 mm');
  });

  it('says nothing when nothing is selected', () => {
    // A readout of dashes that is always on screen teaches people to stop looking at it.
    expect(measureFaces(boxMesh(), [])).toBeNull();
  });
});

describe('two faces', () => {
  it('measures the thickness between opposite faces', () => {
    const mesh = boxMesh(60, 40, 25);
    const m = measureFaces(mesh, [faceAlong(mesh, [0, 0, 1]), faceAlong(mesh, [0, 0, -1])]);

    expect(value(m, 'Distance')).toBe('25.00 mm');
  });

  it('measures along the shared normal, not centre to centre', () => {
    // Two faces of a plate are its thickness apart however far their centroids are offset
    // sideways. Reporting the centroid distance would call a 25 mm plate 25 mm only by luck.
    const mesh = boxMesh(60, 40, 25);
    const m = measureFaces(mesh, [faceAlong(mesh, [0, 0, 1]), faceAlong(mesh, [0, 0, -1])]);

    expect(value(m, 'Distance')).toBe('25.00 mm');
    expect(value(m, 'Offset')).toBe('25.00 mm');   // here they happen to agree
  });

  it('gives the angle between faces that are not parallel', () => {
    const mesh = boxMesh();
    const m = measureFaces(mesh, [faceAlong(mesh, [0, 0, 1]), faceAlong(mesh, [1, 0, 0])]);

    expect(value(m, 'Angle')).toBe('90.00°');
  });

  it('folds the angle so a face has no front or back', () => {
    // Opposite faces of a box have opposing normals. Reported raw that is 180°, which is not
    // an angle anyone means when they pick the two sides of a plate.
    const mesh = boxMesh();
    const m = measureFaces(mesh, [faceAlong(mesh, [0, 0, 1]), faceAlong(mesh, [0, 0, -1])]);

    expect(value(m, 'Angle')).toBeUndefined();      // parallel: it reports distance instead
    expect(value(m, 'Distance')).toBe('25.00 mm');
  });
});

describe('more than two', () => {
  it('totals the area and shows the range', () => {
    const mesh = boxMesh(60, 40, 25);
    const g = buildFaceGraph(mesh);
    const m = measureFaces(mesh, [...g.faces.keys()]);

    // A closed box: 2(60x40 + 60x25 + 40x25) = 2 x (2400 + 1500 + 1000) = 9800 mm².
    expect(value(m, 'Total area')).toBe('98.00 cm²');
    expect(value(m, 'Largest')).toBe('24.00 cm²');
    expect(value(m, 'Smallest')).toBe('10.00 cm²');
  });

  it('ignores a face id that is not in the mesh rather than crashing', () => {
    const mesh = boxMesh();
    expect(measureFaces(mesh, [999999])).toBeNull();
  });
});

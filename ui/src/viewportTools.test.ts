import { describe, expect, it, beforeEach } from 'vitest';
import { useModel } from './modelStore';
import { facesInBand } from './components/Viewport3D';
import { emptyDocument, evaluateDocument } from './model/document';
import { buildFaceGraph } from './kernel/topo/facegraph';
import { viewMatrix, projectionMatrix, defaultCamera, fit } from './viewport/camera';
import { bounds, triCount } from './kernel/topo/mesh';

/**
 * The viewport as a modelling surface rather than a picture of one.
 *
 * Three things separate a viewer from a CAD window: you can sweep a selection over several
 * faces at once, you can act on what you picked without going to look for a panel, and you can
 * build on the face you are looking at. The first two are interaction; the third is geometry,
 * and it is the one that decides whether the model is any good — everything real is built on
 * the part it sits on, not on Top, Front or Right and then dragged into place.
 */

function reset() {
  const doc = emptyDocument();
  useModel.setState({
    doc, evaluated: evaluateDocument(doc),
    selectedFeatureId: null, editingFeatureId: null, selectedFaces: [],
    undoStack: [], redoStack: [], notice: null,
  });
}

/** A box, built and evaluated through the store so face ids are the real ones. */
function box() {
  useModel.getState().addFeature('box');
  const doc = useModel.getState().doc;
  return { doc, evaluated: evaluateDocument(doc) };
}

describe('sweeping a band over faces', () => {
  it('takes every face the band covers, front and back', () => {
    // Not depth-tested, so a sweep reaches the far side too. That is what a crossing selection
    // does everywhere else, and it is what makes it useful for taking a whole boss at once.
    const { evaluated } = box();
    const camera = fit(defaultCamera(), bounds(evaluated.mesh), 1);

    const swept = facesInBand(
      evaluated.mesh, viewMatrix(camera), projectionMatrix(camera, 1),
      { x0: 0, y0: 0, x1: 800, y1: 800 }, 800, 800,
    );

    expect(swept.length).toBe(6);
  });

  it('takes nothing when the band is off the part', () => {
    const { evaluated } = box();
    const camera = fit(defaultCamera(), bounds(evaluated.mesh), 1);

    const swept = facesInBand(
      evaluated.mesh, viewMatrix(camera), projectionMatrix(camera, 1),
      { x0: 0, y0: 0, x1: 4, y1: 4 }, 800, 800,
    );

    expect(swept).toEqual([]);
  });

  it('reports each face once however many triangles it has', () => {
    const { evaluated } = box();
    const camera = fit(defaultCamera(), bounds(evaluated.mesh), 1);

    const swept = facesInBand(
      evaluated.mesh, viewMatrix(camera), projectionMatrix(camera, 1),
      { x0: 0, y0: 0, x1: 800, y1: 800 }, 800, 800,
    );

    expect(new Set(swept).size).toBe(swept.length);
  });
});

describe('building on a face', () => {
  beforeEach(reset);

  it('puts a sketch on the face that was picked, not on Top', () => {
    const { evaluated } = box();
    const graph = buildFaceGraph(evaluated.mesh);

    // The +X face of the default 60 x 40 x 25 box: its plane is x = 30, normal along +X.
    const side = [...graph.faces.values()].find((f) => f.axis[0] > 0.99)!;

    const r = useModel.getState().sketchOnFace(side.id, 'sketch');
    expect(r.ok).toBe(true);

    const added = useModel.getState().doc.features.at(-1)!;
    expect(added.kind).toBe('sketch');
    expect(added.params.planeNormal).toEqual([side.axis[0], side.axis[1], side.axis[2]]);
    expect((added.params.planeOrigin as number[])[0]).toBeCloseTo(30, 6);
  });

  it('an extrude started on a side face grows out of that side', () => {
    // The test that matters: the plane has to reach the geometry, not just the parameters.
    const { evaluated } = box();
    const graph = buildFaceGraph(evaluated.mesh);
    const side = [...graph.faces.values()].find((f) => f.axis[0] > 0.99)!;

    useModel.getState().sketchOnFace(side.id, 'extrude');
    const after = evaluateDocument(useModel.getState().doc);
    const bb = bounds(after.mesh);

    // The box ends at x = 30. An extrude on that face adds material beyond it.
    expect(bb.max[0]!).toBeGreaterThan(30.5);
    expect(triCount(after.mesh)).toBeGreaterThan(12);
  });

  it('refuses a curved face and says why', () => {
    reset();
    useModel.getState().addFeature('cylinder');
    const evaluated = evaluateDocument(useModel.getState().doc);
    const graph = buildFaceGraph(evaluated.mesh);
    const round = [...graph.faces.values()].find((f) => f.tag.kind === 'cylindrical')!;

    const r = useModel.getState().sketchOnFace(round.id, 'sketch');

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/curved|flat/i);
    // And it did not add a feature that could not have worked.
    expect(useModel.getState().doc.features).toHaveLength(1);
  });

  it('refuses a face that is not in the model rather than throwing', () => {
    box();
    const r = useModel.getState().sketchOnFace(999999, 'sketch');
    expect(r.ok).toBe(false);
  });
});

describe('acting on what is picked', () => {
  beforeEach(reset);

  it('adds a fillet already scoped to the faces, not an empty one to fill in', () => {
    const { evaluated } = box();
    const faces = [...buildFaceGraph(evaluated.mesh).faces.keys()].slice(0, 2);

    useModel.getState().addScoped('fillet', faces);

    const added = useModel.getState().doc.features.at(-1)!;
    expect(added.kind).toBe('fillet');
    expect(added.params.faces).toEqual(faces);
  });

  it('the scoped fillet rounds only what it was given', () => {
    const { evaluated } = box();
    const all = [...buildFaceGraph(evaluated.mesh).faces.keys()];

    useModel.getState().addScoped('fillet', all.slice(0, 1));
    const one = evaluateDocument(useModel.getState().doc);

    reset();
    box();
    useModel.getState().addScoped('fillet', all);
    const every = evaluateDocument(useModel.getState().doc);

    // Rounding every face removes more material than rounding one of them.
    expect(every.volume).toBeLessThan(one.volume);
    expect(one.volume).toBeLessThan(60 * 40 * 25);
  });
});

describe('the new features, from the viewport', () => {
  beforeEach(reset);

  it('drills at the centre of the face that was picked', () => {
    const { evaluated } = box();
    const graph = buildFaceGraph(evaluated.mesh);
    const top = [...graph.faces.values()].find((f) => f.axis[2] > 0.99)!;

    const r = useModel.getState().drillOnFace(top.id);
    expect(r.ok).toBe(true);

    const added = useModel.getState().doc.features.at(-1)!;
    expect(added.kind).toBe('hole');
    expect(added.params.x).toBeCloseTo(top.centroid[0], 1);

    const after = evaluateDocument(useModel.getState().doc);
    expect(after.volume).toBeLessThan(evaluated.volume);
    expect(after.health.closed).toBe(true);
  });

  it('refuses a face it cannot drill into, rather than drilling the wrong one', () => {
    // The hole feature cuts downwards from the top. Putting a hole through some other face
    // because that was the only one it could manage would be worse than saying so.
    const { evaluated } = box();
    const graph = buildFaceGraph(evaluated.mesh);
    const side = [...graph.faces.values()].find((f) => f.axis[0] > 0.99)!;

    const r = useModel.getState().drillOnFace(side.id);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/downwards from the top/);
    expect(useModel.getState().doc.features).toHaveLength(1);
  });

  it('stands a rib on the face and adds material', () => {
    const { evaluated } = box();
    const graph = buildFaceGraph(evaluated.mesh);
    const top = [...graph.faces.values()].find((f) => f.axis[2] > 0.99)!;

    expect(useModel.getState().ribOnFace(top.id).ok).toBe(true);

    const after = evaluateDocument(useModel.getState().doc);
    expect(useModel.getState().doc.features.at(-1)!.kind).toBe('rib');
    expect(after.volume).toBeGreaterThan(evaluated.volume);
    expect(after.health.closed).toBe(true);
  });

  it('will not stand a rib on a curved face', () => {
    reset();
    useModel.getState().addFeature('cylinder');
    const graph = buildFaceGraph(evaluateDocument(useModel.getState().doc).mesh);
    const round = [...graph.faces.values()].find((f) => f.tag.kind === 'cylindrical')!;

    expect(useModel.getState().ribOnFace(round.id).ok).toBe(false);
  });
});

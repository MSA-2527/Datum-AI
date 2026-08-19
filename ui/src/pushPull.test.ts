import { describe, expect, it, beforeEach } from 'vitest';
import { useModel } from './modelStore';
import { emptyDocument, evaluateDocument } from './model/document';
import { buildFaceGraph } from './kernel/topo/facegraph';
import { bounds } from './kernel/topo/mesh';

/**
 * Grabbing a face and dragging it.
 *
 * The gesture people arrive with, and until now everything had to go through the tree: choose
 * the operation, then describe in numbers the thing you were already pointing at.
 *
 * The property that matters most is not that it works but that it stays parametric. The drag
 * does not move vertices — it adds an extrude whose profile is the face's own outline, so the
 * result is a feature you can reopen, re-dimension, suppress or delete. Direct manipulation
 * that quietly produced unparameterised geometry would be a worse trade than the tree.
 */

function reset() {
  const doc = emptyDocument();
  useModel.setState({
    doc, evaluated: evaluateDocument(doc),
    selectedFeatureId: null, editingFeatureId: null, selectedFaces: [],
    undoStack: [], redoStack: [], notice: null,
  });
}

function block() {
  useModel.getState().addFeature('box');
  return evaluateDocument(useModel.getState().doc);
}

const faceAlong = (mesh: Parameters<typeof buildFaceGraph>[0], axis: [number, number, number]) => {
  let best = -1, score = -Infinity;
  for (const f of buildFaceGraph(mesh).faces.values()) {
    const d = f.axis[0] * axis[0] + f.axis[1] * axis[1] + f.axis[2] * axis[2];
    if (d > score) { score = d; best = f.id; }
  }
  return best;
};

const BLOCK = 60 * 40 * 25;

describe('pulling a face out', () => {
  beforeEach(reset);

  it('adds material of exactly the face times the distance', () => {
    const ev = block();
    const top = faceAlong(ev.mesh, [0, 0, 1]);

    expect(useModel.getState().pushPull(top, 10).ok).toBe(true);

    const after = evaluateDocument(useModel.getState().doc);
    expect(after.volume).toBeCloseTo(BLOCK + 60 * 40 * 10, -1);
    expect(after.health.closed).toBe(true);
  });

  it('grows the part in the direction of the face', () => {
    const ev = block();
    useModel.getState().pushPull(faceAlong(ev.mesh, [0, 0, 1]), 10);

    const bb = bounds(evaluateDocument(useModel.getState().doc).mesh);
    expect(bb.max[2]!).toBeCloseTo(22.5, 1);
  });

  it('works on a side face, not just the top', () => {
    const ev = block();
    useModel.getState().pushPull(faceAlong(ev.mesh, [1, 0, 0]), 15);

    const bb = bounds(evaluateDocument(useModel.getState().doc).mesh);
    expect(bb.max[0]!).toBeCloseTo(45, 1);
  });
});

describe('pushing a face in', () => {
  beforeEach(reset);

  it('cuts material away', () => {
    const ev = block();
    expect(useModel.getState().pushPull(faceAlong(ev.mesh, [0, 0, 1]), -8).ok).toBe(true);

    const after = evaluateDocument(useModel.getState().doc);
    expect(after.volume).toBeCloseTo(BLOCK - 60 * 40 * 8, -1);
    expect(after.health.closed).toBe(true);
  });

  it('shortens the part rather than moving it', () => {
    const ev = block();
    useModel.getState().pushPull(faceAlong(ev.mesh, [0, 0, 1]), -8);

    const bb = bounds(evaluateDocument(useModel.getState().doc).mesh);
    expect(bb.max[2]!).toBeCloseTo(4.5, 1);
    expect(bb.min[2]!).toBeCloseTo(-12.5, 1);
  });
});

describe('it stays parametric', () => {
  beforeEach(reset);

  it('leaves a feature that can be re-dimensioned afterwards', () => {
    const ev = block();
    useModel.getState().pushPull(faceAlong(ev.mesh, [0, 0, 1]), 10);

    const added = useModel.getState().doc.features.at(-1)!;
    expect(added.kind).toBe('extrude');
    expect(added.params.distance).toBe(10);

    useModel.getState().setParams(added.id, { distance: 25 });
    const after = evaluateDocument(useModel.getState().doc);
    expect(after.volume).toBeCloseTo(BLOCK + 60 * 40 * 25, -1);
  });

  it('can be undone like any other edit', () => {
    const ev = block();
    useModel.getState().pushPull(faceAlong(ev.mesh, [0, 0, 1]), 10);
    expect(useModel.getState().doc.features).toHaveLength(2);

    useModel.getState().undo();
    expect(useModel.getState().doc.features).toHaveLength(1);
  });

  it('opens the new feature in the editor', () => {
    const ev = block();
    useModel.getState().pushPull(faceAlong(ev.mesh, [0, 0, 1]), 10);

    const added = useModel.getState().doc.features.at(-1)!;
    expect(useModel.getState().editingFeatureId).toBe(added.id);
  });
});

describe('what it refuses', () => {
  beforeEach(reset);

  it('will not push a curved face, and says why', () => {
    useModel.getState().addFeature('cylinder');
    const mesh = evaluateDocument(useModel.getState().doc).mesh;
    const wall = [...buildFaceGraph(mesh).faces.values()].find((f) => f.tag.kind === 'cylindrical')!;

    const r = useModel.getState().pushPull(wall.id, 5);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/curved/);
    expect(useModel.getState().doc.features).toHaveLength(1);
  });

  it('ignores a drag too small to mean anything', () => {
    const ev = block();
    expect(useModel.getState().pushPull(faceAlong(ev.mesh, [0, 0, 1]), 0).ok).toBe(false);
    expect(useModel.getState().doc.features).toHaveLength(1);
  });

  it('refuses a face that is no longer in the model', () => {
    block();
    expect(useModel.getState().pushPull(999999, 5).ok).toBe(false);
  });
});

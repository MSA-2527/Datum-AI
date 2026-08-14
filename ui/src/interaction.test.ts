import { beforeEach, describe, expect, it } from 'vitest';
import { useModel } from './modelStore';
import { addFeature, defaultParams, emptyDocument, evaluateDocument, faceList, paramFields, type FeatureKind } from './model/document';
import { box } from './kernel/ops/build';
import { filletEdges } from './kernel/ops/modify';
import { health, massProperties, triCount } from './kernel/topo/mesh';

/**
 * Tests for the interaction layer — picking faces, scoping a feature to them, and rebuilding
 * without blocking the window.
 *
 * These matter more than their size suggests. A modeller that can only round *every* edge is
 * a demo: on any real part one bad edge fails and the whole feature reports that nothing
 * happened. Being able to say "these four faces" is the difference between a toy and a tool,
 * and it is entirely an interaction problem — the kernel has taken a face list for a while.
 */

function reset() {
  useModel.setState({
    doc: emptyDocument(),
    evaluated: evaluateDocument(emptyDocument()),
    selectedFaces: [],
    selectedFeatureId: null,
    editingFeatureId: null,
    undoStack: [],
    redoStack: [],
    notice: null,
  });
}

describe('picking faces in the viewport', () => {
  beforeEach(reset);

  it('a plain click selects one face', () => {
    useModel.getState().toggleFace(4, false);
    expect(useModel.getState().selectedFaces).toEqual([4]);
  });

  it('a plain click on a different face replaces the selection', () => {
    useModel.getState().toggleFace(4, false);
    useModel.getState().toggleFace(9, false);
    expect(useModel.getState().selectedFaces).toEqual([9]);
  });

  it('an additive click accumulates', () => {
    useModel.getState().toggleFace(4, true);
    useModel.getState().toggleFace(9, true);
    useModel.getState().toggleFace(1, true);
    expect(useModel.getState().selectedFaces).toEqual([4, 9, 1]);
  });

  it('an additive click on an already-picked face removes it', () => {
    useModel.getState().toggleFace(4, true);
    useModel.getState().toggleFace(9, true);
    useModel.getState().toggleFace(4, true);
    expect(useModel.getState().selectedFaces).toEqual([9]);
  });

  it('clicking the one selected face again deselects it', () => {
    useModel.getState().toggleFace(4, false);
    useModel.getState().toggleFace(4, false);
    expect(useModel.getState().selectedFaces).toEqual([]);
  });

  it('clicking empty space clears the selection rather than picking face −1', () => {
    // The viewport reports −1 for a miss. Storing that would scope the feature to a face
    // that cannot exist, and the fillet would silently round nothing.
    useModel.getState().toggleFace(4, true);
    useModel.getState().toggleFace(9, true);
    useModel.getState().toggleFace(-1, false);
    expect(useModel.getState().selectedFaces).toEqual([]);
  });
});

describe('scoping a feature to picked faces', () => {
  beforeEach(reset);

  function openFillet() {
    const doc = addFeature(emptyDocument(), 'fillet', { radius: 3, faces: [] });
    const f = doc.features[doc.features.length - 1];
    useModel.setState({ doc, editingFeatureId: f.id, selectedFeatureId: f.id });
    return f.id;
  }

  it('hands the picked faces to the open fillet', () => {
    const id = openFillet();
    useModel.getState().toggleFace(2, true);
    useModel.getState().toggleFace(5, true);
    useModel.getState().applyFacesToFeature();

    const f = useModel.getState().doc.features.find((x) => x.id === id);
    expect(f?.params.faces).toEqual([2, 5]);
  });

  it('an empty pick resets the feature to the whole body', () => {
    const id = openFillet();
    useModel.getState().toggleFace(2, true);
    useModel.getState().applyFacesToFeature();
    useModel.getState().clearFaces();
    useModel.getState().applyFacesToFeature();

    const f = useModel.getState().doc.features.find((x) => x.id === id);
    expect(f?.params.faces).toEqual([]);
    expect(useModel.getState().notice?.text).toContain('every edge');
  });

  it('copies the list rather than aliasing it', () => {
    // Sharing the array would make later viewport clicks silently rewrite an applied
    // feature — an edit with no undo entry and no rebuild.
    const id = openFillet();
    useModel.getState().toggleFace(2, true);
    useModel.getState().applyFacesToFeature();
    useModel.getState().toggleFace(7, true);

    const f = useModel.getState().doc.features.find((x) => x.id === id);
    expect(f?.params.faces).toEqual([2]);
  });

  it('refuses when the open feature cannot take a face selection', () => {
    const doc = addFeature(emptyDocument(), 'extrude', {});
    const f = doc.features[doc.features.length - 1];
    useModel.setState({ doc, editingFeatureId: f.id });

    useModel.getState().toggleFace(2, true);
    useModel.getState().applyFacesToFeature();

    expect(useModel.getState().notice?.tone).toBe('warn');
    expect(useModel.getState().doc.features[0].params.faces).toBeUndefined();
  });
});

describe('reading a face list off a feature', () => {
  it('accepts a list of face ids', () => {
    expect(faceList({ faces: [1, 4, 9] })).toEqual([1, 4, 9]);
  });

  it('treats an empty list as no scope, meaning the whole body', () => {
    expect(faceList({ faces: [] })).toBeUndefined();
  });

  it('treats a missing list as no scope', () => {
    expect(faceList({})).toBeUndefined();
  });

  it('drops entries that are not usable face ids', () => {
    // Face lists survive a save/reload and can come back from a language model, so a
    // negative or fractional id is a real possibility rather than a theoretical one.
    expect(faceList({ faces: [1, -2, 3.5, 4] })).toEqual([1, 4]);
  });
});

describe('a face-scoped fillet reaches the kernel', () => {
  it('carries the picked faces from the store through to the geometry', () => {
    // The point of the whole selection path: the list the viewport builds has to end up
    // narrowing what the kernel actually cuts. Triangle count is not the measure — the
    // boolean re-triangulates whatever it touches — so this compares material removed.
    const solid = box(60, 40, 20);
    const v0 = massProperties(solid).volume;

    const all = filletEdges(solid, { radius: 3 });
    const scoped = filletEdges(solid, {
      radius: 3,
      faces: [...solid.tags.keys()].slice(0, 1),
    });

    expect(health(all.mesh).closed).toBe(true);
    expect(health(scoped.mesh).closed).toBe(true);
    expect(v0 - massProperties(scoped.mesh).volume).toBeGreaterThan(0);
    expect(v0 - massProperties(scoped.mesh).volume)
      .toBeLessThan(v0 - massProperties(all.mesh).volume);
  });

  it('leaves the solid untouched when the scope names no real face', () => {
    const solid = box(60, 40, 20);
    const scoped = filletEdges(solid, { radius: 3, faces: [99999] });

    expect(triCount(scoped.mesh)).toBe(triCount(solid));
    expect(health(scoped.mesh).closed).toBe(true);
  });
});

/**
 * A picture has no scale, so tracing one has to assume a width and then let you correct it.
 *
 * For a while it did only the first half. The importer said "set it on the Traced outline
 * feature", and the editor obligingly showed Length and Width — but a traced profile is a point
 * list, and `profileFrom` builds those straight from the points, so both fields were read by
 * nothing. Every edit appeared to work, the model rebuilt, and the part stayed exactly 100 mm
 * across. A control that silently does nothing is worse than a missing one, because it costs
 * the user the time to discover it.
 */
describe('rescaling a traced outline', () => {
  beforeEach(reset);

  /** A ring, traced: an outer square with a square hole, so scaling has to carry the hole. */
  function tracedRing(width: number) {
    const half = width / 2;
    const outer = [-half, -half, half, -half, half, half, -half, half];
    const q = width / 4;
    const hole = [-q, -q, q, -q, q, q, -q, q];

    return addFeature(emptyDocument('Traced part'), 'extrude', {
      plane: 'XY', shape: 'points', points: outer,
      holePoints: hole, holeLengths: [4],
      distance: 5, operation: 'add',
      tracedWidth: width, width,
    }, 'Traced outline');
  }

  it('offers a width the profile actually reads, and no fields it ignores', () => {
    const doc = tracedRing(100);
    const labels = paramFields('extrude', doc.features[0]!.params).map((f) => f.label);

    expect(labels).toContain('Overall width');
    // Length and Corner radius belong to a rectangle profile. On a point list they would be
    // edits that do nothing, which is the defect this guards.
    expect(labels).not.toContain('Length');
    expect(labels).not.toContain('Corner radius');
  });

  it('rescales the outline and its holes together', () => {
    const at100 = evaluateDocument(tracedRing(100));

    const doubled = tracedRing(100);
    doubled.features[0]!.params.width = 200;
    const at200 = evaluateDocument(doubled);

    const size = (e: ReturnType<typeof evaluateDocument>) => {
      const b = e.mesh.positions;
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < b.length; i += 3) {
        if (b[i]! < min) min = b[i]!;
        if (b[i]! > max) max = b[i]!;
      }
      return max - min;
    };

    expect(size(at100)).toBeCloseTo(100, 6);
    expect(size(at200)).toBeCloseTo(200, 6);

    // Area scales with the square of the factor only if the hole scaled too — a hole left at
    // its original size would leave more material than 4x behind.
    expect(at200.volume / at100.volume).toBeCloseTo(4, 3);
    expect(at200.health.closed).toBe(true);
  });

  it('scales about the profile centre, so correcting the size does not move the part', () => {
    const off = tracedRing(100);
    // Push the whole outline away from the origin, as a trace of an off-centre picture is.
    const p = off.features[0]!.params;
    p.points = (p.points as number[]).map((v, i) => (i % 2 === 0 ? v + 250 : v + 80));
    p.holePoints = (p.holePoints as number[]).map((v, i) => (i % 2 === 0 ? v + 250 : v + 80));

    const before = evaluateDocument(off);
    off.features[0]!.params.width = 60;
    const after = evaluateDocument(off);

    expect(after.centroid[0]).toBeCloseTo(before.centroid[0], 6);
    expect(after.centroid[1]).toBeCloseTo(before.centroid[1], 6);
  });

  it('leaves a profile alone when the width matches what it was traced at', () => {
    const a = evaluateDocument(tracedRing(100));

    const same = tracedRing(100);
    same.features[0]!.params.width = 100;

    expect(evaluateDocument(same).volume).toBeCloseTo(a.volume, 9);
  });
});

/**
 * The editor must never show a number the model is not using.
 *
 * A feature stores only the parameters it was given; the evaluator fills the rest from the
 * kind's defaults. The editor used to fall back to the *slider's minimum* for anything absent,
 * so a traced outline — which stores no draft — displayed `Draft -20°`, the extreme of the
 * range, while being built at 0. Nothing was wrong with the geometry, which is exactly what
 * made it dangerous: the part on screen disagreed with the number beside it.
 */
describe('the parameter editor shows what is being built', () => {
  const KINDS: FeatureKind[] = [
    'box', 'cylinder', 'sphere', 'extrude', 'revolve', 'hole', 'pocket', 'slot',
    'fillet', 'chamfer', 'shell', 'patternLinear', 'patternCircular', 'mirror',
  ];

  it('gives every editable field a default to fall back on', () => {
    for (const kind of KINDS) {
      const defaults = defaultParams(kind);
      const orphans = paramFields(kind)
        .filter((f) => defaults[f.key] === undefined)
        .map((f) => f.key);

      // An editable field with no default is the shape of the bug: the editor has nothing
      // truthful to show, so it invents a value from the slider's range.
      expect({ kind, orphans }).toEqual({ kind, orphans: [] });
    }
  });

  it('defaults draft to none rather than to the extreme of its range', () => {
    const field = paramFields('extrude').find((f) => f.key === 'draft')!;

    expect(defaultParams('extrude').draft).toBe(0);
    expect(field.min).toBeLessThan(0);
    expect(defaultParams('extrude').draft).not.toBe(field.min);
  });
});

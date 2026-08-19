import { describe, expect, it, beforeEach } from 'vitest';
import { useModel } from '../../modelStore';
import { emptyDocument, evaluateDocument } from '../../model/document';
import { bounds, triCount } from '../../kernel/topo/mesh';
import type { RasterImage } from './trace';

/**
 * A photograph in, a shaped solid out.
 *
 * The complaint this answers, in the words it was made in: the importer "just makes the high
 * contrast and makes it boxy". Both halves were true. The threshold threw away everything
 * inside the outline, so a domed cover became a disc; and worse, on a shaded object the
 * threshold cut *through* the part, so the bright crown of a dome was classified as background
 * and the thing traced as a ring.
 *
 * So there are two questions here, and the second is the one that used to fail silently:
 * does a curved object come back curved, and does a flat one still come back flat?
 */

/** Renders a surface as a Lambertian solid on a white background, lit along the view. */
function render(
  size: number, normal: (x: number, y: number) => [number, number, number] | null,
): RasterImage {
  const data = new Uint8ClampedArray(size * size * 4).fill(255);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = normal(x + 0.5, y + 0.5);
      if (!n) continue;
      const v = Math.round(Math.max(0, Math.min(1, n[2])) * 0.75 * 255);
      const p = (y * size + x) * 4;
      data[p] = v; data[p + 1] = v; data[p + 2] = v;
    }
  }

  return { width: size, height: size, data };
}

const dome = (size: number, r: number) => (x: number, y: number): [number, number, number] | null => {
  const c = size / 2;
  const d2 = (x - c) ** 2 + (y - c) ** 2;
  if (d2 > r * r) return null;
  const z = Math.sqrt(r * r - d2);
  return [(x - c) / r, (y - c) / r, z / r];
};

const disc = (size: number, r: number) => (x: number, y: number): [number, number, number] | null =>
  (x - size / 2) ** 2 + (y - size / 2) ** 2 <= r * r ? [0, 0, 1] : null;

function reset() {
  const doc = emptyDocument();
  useModel.setState({
    doc, evaluated: evaluateDocument(doc),
    selectedFeatureId: null, editingFeatureId: null, selectedFaces: [],
    undoStack: [], redoStack: [], notice: null,
  });
}

describe('a photograph of a curved part', () => {
  beforeEach(reset);

  it('comes back curved, not as a flat disc', () => {
    const size = 128, r = 46;
    const r2 = useModel.getState().importImage(render(size, dome(size, r)), 0.5, 6);

    expect(r2.ok).toBe(true);
    expect(r2.message).toMatch(/Recovered a surface/);

    const ev = evaluateDocument(useModel.getState().doc);
    const bb = bounds(ev.mesh);
    const thickness = bb.max[2]! - bb.min[2]!;

    // Thicker than the 6 mm base it was extruded to: the relief stands proud of it.
    expect(thickness).toBeGreaterThan(8);
  });

  it('is a dome rather than a step, so the volume sits between a plate and a block', () => {
    // A shape that merely got taller could be a cylinder. A dome holds appreciably less than
    // the block that contains it and appreciably more than the base alone.
    const size = 128, r = 46;
    useModel.getState().importImage(render(size, dome(size, r)), 0.5, 6);

    const ev = evaluateDocument(useModel.getState().doc);
    const bb = bounds(ev.mesh);
    const enclosing = (bb.max[0]! - bb.min[0]!) * (bb.max[1]! - bb.min[1]!) * (bb.max[2]! - bb.min[2]!);

    expect(ev.volume).toBeLessThan(enclosing * 0.75);
    expect(ev.volume).toBeGreaterThan(enclosing * 0.2);
  });

  it('is still a closed solid afterwards', () => {
    // The displacement moves thousands of vertices of the top face. If the seam where it meets
    // the wall moved differently, the part would tear and stop being a solid at all.
    const size = 128, r = 46;
    useModel.getState().importImage(render(size, dome(size, r)), 0.5, 6);

    const ev = evaluateDocument(useModel.getState().doc);
    expect(ev.health.closed).toBe(true);
    expect(ev.health.manifold).toBe(true);
    expect(triCount(ev.mesh)).toBeGreaterThan(100);
  });

  it('keeps the depth as a parameter that can be changed', () => {
    // A reconstruction you cannot argue with is not a model. The shading proposes a depth; the
    // number stays in the tree.
    const size = 128, r = 46;
    useModel.getState().importImage(render(size, dome(size, r)), 0.5, 6);

    const feature = useModel.getState().doc.features[0]!;
    const depth = feature.params.reliefDepth as number;
    expect(depth).toBeGreaterThan(0);

    const before = evaluateDocument(useModel.getState().doc).volume;
    useModel.getState().setParams(feature.id, { reliefDepth: depth * 2 });
    const after = evaluateDocument(useModel.getState().doc).volume;

    expect(after).toBeGreaterThan(before);
  });
});

describe('a photograph of a flat part', () => {
  beforeEach(reset);

  it('stays flat, and says why', () => {
    const size = 128, r = 46;
    const r2 = useModel.getState().importImage(render(size, disc(size, r)), 0.5, 6);

    expect(r2.ok).toBe(true);
    expect(r2.message).toMatch(/Left flat/);

    const ev = evaluateDocument(useModel.getState().doc);
    const bb = bounds(ev.mesh);
    expect(bb.max[2]! - bb.min[2]!).toBeCloseTo(6, 1);
  });

  it('does not carry a relief it is not using', () => {
    const size = 128, r = 46;
    useModel.getState().importImage(render(size, disc(size, r)), 0.5, 6);

    expect(useModel.getState().doc.features[0]!.params.reliefField).toBeUndefined();
  });
});

describe('the segmentation that used to cut the part in half', () => {
  beforeEach(reset);

  it('traces a shaded dome as one solid region, not as a ring', () => {
    // Otsu put the bright crown of the dome on the background side, so the part traced as an
    // annulus with a hole where its brightest region had been — and every measurement taken
    // from it was wrong in a way that looked deliberate.
    const size = 128, r = 46;
    useModel.getState().importImage(render(size, dome(size, r)), 0.5, 6);

    const feature = useModel.getState().doc.features[0]!;
    const holeLengths = feature.params.holeLengths;

    expect(Array.isArray(holeLengths) ? holeLengths.length : 0).toBe(0);
  });
});

describe('a face we can see against a symmetry we inferred', () => {
  beforeEach(reset);

  it('reads the shading of a dome seen from above rather than revolving its circle', () => {
    // A circle is symmetric about both centrelines, so the revolve heuristic fires and builds a
    // sphere — a guess about the half nobody photographed, in place of the half sitting right
    // there in the shading.
    const size = 128, r = 46;
    useModel.getState().importImage(render(size, dome(size, r)), 0.5, 6);

    const feature = useModel.getState().doc.features[0]!;
    expect(feature.kind).toBe('extrude');
    expect(feature.params.reliefField).toBeDefined();
  });

  it('still revolves a profile that has no surface to read', () => {
    // A bottle silhouette: symmetric about the vertical centreline only, and flat inside. The
    // revolve is the right answer and stays the right answer.
    const size = 160;
    const data = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const half = Math.abs(x + 0.5 - size / 2);
        const width = y < 50 ? 12 : y < 70 ? 12 + (y - 50) * 1.6 : 44;
        if (y < 20 || y > 150 || half > width) continue;
        const p = (y * size + x) * 4;
        data[p] = 40; data[p + 1] = 40; data[p + 2] = 40;
      }
    }

    useModel.getState().importImage({ width: size, height: size, data }, 0.5, 6);
    expect(useModel.getState().doc.features[0]!.kind).toBe('revolve');
  });
});

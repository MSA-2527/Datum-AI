import { beforeEach, describe, expect, it } from 'vitest';
import { useModel } from '../../modelStore';
import { emptyDocument, evaluateDocument } from '../../model/document';
import { bounds, massProperties, triCount } from '../../kernel/topo/mesh';
import type { DepthSource } from './depth';
import type { RasterImage } from './trace';

/**
 * The depth model's whole path, with the model itself stood in for.
 *
 * `depth.test.ts` checks the arithmetic that reads a depth map, and `depthAnything.test.ts`
 * checks the tensor going in and the map coming out. Neither checks that the pieces are joined
 * up: that the image the tracer masked is the image the model was given, that the height field
 * reaches the feature, that the feature builds a solid with the depth in it.
 *
 * A stub source answers with a hemisphere, which is a shape whose reconstruction is known before
 * anything runs. What is being tested is the plumbing, and the plumbing is what breaks silently —
 * every piece can be right while the height field goes to a feature nobody builds.
 */

const SIZE = 160;
const RADIUS = 60;

/** A flatly-lit disc: an outline the tracer reads and no shading to solve. */
function flatDisc(): RasterImage {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4).fill(255);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - SIZE / 2, dy = y - SIZE / 2;
      if (dx * dx + dy * dy > RADIUS * RADIUS) continue;

      const i = (y * SIZE + x) * 4;
      data[i] = 100; data[i + 1] = 100; data[i + 2] = 100;
    }
  }
  return { width: SIZE, height: SIZE, data };
}

/** Answers with a hemisphere, as an inverse-depth model would: nearest in the middle. */
function domeSource(name = 'stub'): DepthSource {
  return {
    name,
    async estimate(image) {
      const depth = new Float32Array(image.width * image.height);

      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          const dx = x - image.width / 2, dy = y - image.height / 2;
          const d2 = dx * dx + dy * dy;
          depth[y * image.width + x] = d2 > RADIUS * RADIUS
            ? 0
            : Math.sqrt(RADIUS * RADIUS - d2);
        }
      }
      return { depth, width: image.width, height: image.height };
    },
  };
}

function reset() {
  const doc = emptyDocument();
  useModel.setState({
    doc, evaluated: evaluateDocument(doc),
    selectedFeatureId: null, editingFeatureId: null, selectedFaces: [],
    undoStack: [], redoStack: [], notice: null,
  });
}

describe('reading a picture with a depth model', () => {
  beforeEach(reset);

  it('builds a solid from the depth it was given', async () => {
    const result = await useModel.getState()
      .importImageWithDepth(flatDisc(), 0.5, 6, domeSource());

    expect(result.ok, result.message).toBe(true);

    const built = evaluateDocument(useModel.getState().doc);
    expect(triCount(built.mesh)).toBeGreaterThan(0);
    expect(massProperties(built.mesh).volume).toBeGreaterThan(0);
  });

  it('builds something domed rather than a prism of the same height', async () => {
    /*
     * Tested against the shape itself, not against what another route would have given.
     *
     * The first version of this compared the depth build with an ordinary import of the same
     * picture, on the assumption that a flatly-lit disc gives a plate. It does not: shape from
     * shading finds relief in the hard rim and builds a dome of its own. So the comparison was
     * between two domes and proved nothing about either.
     *
     * A dome of a given footprint and height holds about two thirds of the prism that would
     * enclose it, and a great deal more than nothing. Between those two bounds is a shape that
     * rises in the middle — which is the claim being made.
     */
    await useModel.getState().importImageWithDepth(flatDisc(), 0.5, 6, domeSource());

    const built = evaluateDocument(useModel.getState().doc);
    const b = bounds(built.mesh);

    const width = b.max[0] - b.min[0];
    const depth = b.max[1] - b.min[1];
    const height = b.max[2] - b.min[2];
    const prism = width * depth * height;

    const volume = massProperties(built.mesh).volume;

    expect(volume).toBeLessThan(prism * 0.8);
    expect(volume).toBeGreaterThan(prism * 0.15);
  });

  it('stands the part off by the depth, not by the plate thickness', async () => {
    await useModel.getState().importImageWithDepth(flatDisc(), 0.5, 6, domeSource());

    const b = bounds(evaluateDocument(useModel.getState().doc).mesh);
    const height = b.max[2] - b.min[2];

    // The disc is 60 mm across at 0.5 mm per pixel; a dome on it stands well clear of 6 mm.
    expect(height).toBeGreaterThan(10);
  });

  it('says which model the depth came from', async () => {
    const result = await useModel.getState()
      .importImageWithDepth(flatDisc(), 0.5, 6, domeSource('Depth Anything V2 (small)'));

    expect(result.message).toContain('Depth Anything V2 (small)');
  });

  it('says a picture carries no scale, every time', async () => {
    const result = await useModel.getState()
      .importImageWithDepth(flatDisc(), 0.5, 6, domeSource());

    expect(result.message).toMatch(/no scale/i);
  });
});

describe('when the model has nothing to say', () => {
  beforeEach(reset);

  it('falls back to the flat outline rather than failing', async () => {
    /*
     * A depth map with no variation across the part is a real answer — the model looked and
     * found a flat thing. The outline is still worth building, and refusing the import because
     * the depth was uninteresting would throw away a perfectly good part.
     */
    const flatSource: DepthSource = {
      name: 'stub',
      async estimate(image) {
        return {
          depth: new Float32Array(image.width * image.height).fill(5),
          width: image.width,
          height: image.height,
        };
      },
    };

    const result = await useModel.getState()
      .importImageWithDepth(flatDisc(), 0.5, 6, flatSource);

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/no variation in depth|flat outline/i);
    expect(triCount(evaluateDocument(useModel.getState().doc).mesh)).toBeGreaterThan(0);
  });

  it('reports a model that throws rather than leaving the viewport empty', async () => {
    const broken: DepthSource = {
      name: 'stub',
      async estimate() { throw new Error('the weights are corrupt'); },
    };

    const result = await useModel.getState().importImageWithDepth(flatDisc(), 0.5, 6, broken);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('corrupt');
  });
});

import { bounds, getTriangle, triCount, type Mesh } from '../kernel/topo/mesh';
import { cross3, norm3, sub3, type Vec3 } from '../kernel/math/vec';

/**
 * A software rasteriser, so a part can be looked at without a GPU.
 *
 * ── Why this exists ──
 *
 * The application renders with WebGL, which needs a browser and a canvas. That leaves the two
 * cases where seeing the part matters most with no way to see it: a command line checking a
 * build, and a **model reviewing what it just wrote**. The second is the one that changes
 * quality — a plan that has been described is not the same as a part that has been looked at,
 * and a model that can only read its own script cannot tell that the boss it placed is
 * floating half a millimetre off the face.
 *
 * So: an orthographic z-buffer rasteriser with Lambert shading, in plain arithmetic. No
 * context, no extension, no platform. It runs identically in Node and in a browser, which also
 * makes it testable — a cube seen from the front is a square of known area, and that is an
 * assertion rather than a screenshot to eyeball.
 *
 * ── Orthographic, deliberately ──
 *
 * A perspective view is prettier and worse to judge from: parallel edges converge, equal
 * features differ in size with depth, and a model asked whether two bosses match cannot tell.
 * Engineering drawings are orthographic for the same reason.
 */

export type ViewName = 'iso' | 'front' | 'right' | 'top' | 'back' | 'left' | 'bottom';

export interface View {
  /** Direction the camera looks along, from eye to target. */
  forward: Vec3;
  /** Which way is up on the image. */
  up: Vec3;
}

/**
 * The standard views, in the orientation the rest of the application uses: Z up, Y into the
 * screen on the front view.
 */
export const VIEWS: Record<ViewName, View> = {
  iso: { forward: norm3([-1, 1, -1]), up: [0, 0, 1] },
  front: { forward: [0, 1, 0], up: [0, 0, 1] },
  back: { forward: [0, -1, 0], up: [0, 0, 1] },
  right: { forward: [-1, 0, 0], up: [0, 0, 1] },
  left: { forward: [1, 0, 0], up: [0, 0, 1] },
  top: { forward: [0, 0, -1], up: [0, 1, 0] },
  bottom: { forward: [0, 0, 1], up: [0, 1, 0] },
};

export interface RenderOptions {
  width?: number;
  height?: number;
  /** Fraction of the frame the part fills. Under one so nothing touches the edge. */
  fill?: number;
  background?: [number, number, number];
  /** Base colour before shading. */
  colour?: [number, number, number];
}

export interface Render {
  rgba: Uint8Array;
  width: number;
  height: number;
  /** How many pixels the part covered. Zero means nothing was drawn. */
  covered: number;
}

const DEFAULTS = {
  width: 512,
  height: 512,
  fill: 0.82,
  background: [24, 26, 30] as [number, number, number],
  colour: [176, 186, 198] as [number, number, number],
};

export function render(mesh: Mesh, view: View, options: RenderOptions = {}): Render {
  const { width, height, fill, background, colour } = { ...DEFAULTS, ...options };

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = background[0];
    rgba[i * 4 + 1] = background[1];
    rgba[i * 4 + 2] = background[2];
    rgba[i * 4 + 3] = 255;
  }

  const triangles = triCount(mesh);
  if (triangles === 0) return { rgba, width, height, covered: 0 };

  // The camera frame. `right` is forward × up, and `up` is re-derived so the three are
  // orthogonal even when the caller hands in an up that is not perpendicular.
  const forward = norm3(view.forward);
  const right = norm3(cross3(forward, view.up));
  const up = norm3(cross3(right, forward));

  const project = (p: Vec3): [number, number, number] => [
    p[0] * right[0] + p[1] * right[1] + p[2] * right[2],
    p[0] * up[0] + p[1] * up[1] + p[2] * up[2],
    p[0] * forward[0] + p[1] * forward[1] + p[2] * forward[2],
  ];

  // Fit the projected bounding box, so a part fills the frame whatever its size or aspect.
  const box = bounds(mesh);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;

  for (let i = 0; i < 8; i++) {
    const corner: Vec3 = [
      i & 1 ? box.max[0]! : box.min[0]!,
      i & 2 ? box.max[1]! : box.min[1]!,
      i & 4 ? box.max[2]! : box.min[2]!,
    ];
    const [u, v] = project(corner);
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }

  const span = Math.max(maxU - minU, maxV - minV, 1e-9);
  const scale = (Math.min(width, height) * fill) / span;
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;

  const toPixel = (p: Vec3): [number, number, number] => {
    const [u, v, d] = project(p);
    return [
      width / 2 + (u - cu) * scale,
      // Screen y grows downward; the world's up does not.
      height / 2 - (v - cv) * scale,
      d,
    ];
  };

  const depth = new Float64Array(width * height).fill(Infinity);

  /*
   * The light.
   *
   * Fixed to the camera rather than to the world, so every view is lit the same way and two
   * renders of the same part can be compared. A world-fixed light leaves the back view in
   * darkness, which reads as a hole rather than as a shadow.
   */
  const light = norm3([-0.4, -0.5, 0.76]);
  const lightDir = norm3([
    right[0] * light[0] + up[0] * light[1] - forward[0] * light[2],
    right[1] * light[0] + up[1] * light[1] - forward[1] * light[2],
    right[2] * light[0] + up[2] * light[1] - forward[2] * light[2],
  ]);

  for (let t = 0; t < triangles; t++) {
    const [a, b, c] = getTriangle(mesh, t);

    const normal = norm3(cross3(sub3(b, a), sub3(c, a)));
    const facing = -(normal[0] * forward[0] + normal[1] * forward[1] + normal[2] * forward[2]);
    if (facing <= 0) continue;               // back-facing: the far side of a closed solid

    const lambert = Math.max(0, normal[0] * lightDir[0] + normal[1] * lightDir[1] + normal[2] * lightDir[2]);
    // Ambient plus diffuse. Never fully black: an unlit face still has to show its silhouette.
    const shade = 0.28 + 0.72 * lambert;

    const pa = toPixel(a), pb = toPixel(b), pc = toPixel(c);

    const loX = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])));
    const hiX = Math.min(width - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
    const loY = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])));
    const hiY = Math.min(height - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));

    const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1]);
    if (Math.abs(area) < 1e-12) continue;    // degenerate on screen

    for (let y = loY; y <= hiY; y++) {
      for (let x = loX; x <= hiX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;

        // Barycentric coordinates, which give the inside test and the depth in one step.
        const w0 = ((pb[0] - px) * (pc[1] - py) - (pc[0] - px) * (pb[1] - py)) / area;
        const w1 = ((pc[0] - px) * (pa[1] - py) - (pa[0] - px) * (pc[1] - py)) / area;
        const w2 = 1 - w0 - w1;

        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        const d = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
        const at = y * width + x;
        if (d >= depth[at]!) continue;

        depth[at] = d;
        rgba[at * 4] = Math.min(255, Math.round(colour[0] * shade));
        rgba[at * 4 + 1] = Math.min(255, Math.round(colour[1] * shade));
        rgba[at * 4 + 2] = Math.min(255, Math.round(colour[2] * shade));
        rgba[at * 4 + 3] = 255;
      }
    }
  }

  let covered = 0;
  for (let i = 0; i < width * height; i++) if (depth[i]! < Infinity) covered += 1;

  return { rgba, width, height, covered };
}

/**
 * Several views of one part, at one scale.
 *
 * The set a person asks for when they want to know whether a part is right, and the set worth
 * putting in front of a model for the same reason: an isometric to read the form, and three
 * orthographic views to judge proportion against.
 */
export const REVIEW_VIEWS: ViewName[] = ['iso', 'front', 'right', 'top'];

export function renderViews(
  mesh: Mesh, views: ViewName[] = REVIEW_VIEWS, options: RenderOptions = {},
): { name: ViewName; render: Render }[] {
  return views.map((name) => ({ name, render: render(mesh, VIEWS[name], options) }));
}

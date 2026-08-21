import { describe, expect, it } from 'vitest';
import { defaultCamera, namedView, orbit, zoom, type CameraState } from './camera';
import {
  gridFor, projectPoint, scaleBarFor, triadFor, viewCubeFaces, viewCubeHit,
} from './overlay';

const HEIGHT = 800;

/** The camera, looking at a named view, with a stated view height. */
function at(view: Parameters<typeof namedView>[1], fovMm = 200): CameraState {
  return namedView({ ...defaultCamera(), fovMm }, view);
}

describe('the grid', () => {
  it('subdivides in 1, 2 and 5, because that is how people count', () => {
    const seen = new Set<number>();

    for (let fov = 1; fov < 100_000; fov *= 1.07) {
      seen.add(gridFor({ ...defaultCamera(), fovMm: fov }, HEIGHT).spacingMm);
    }

    for (const spacing of seen) {
      const mantissa = spacing / Math.pow(10, Math.floor(Math.log10(spacing)));
      expect([1, 2, 5], `${spacing} mm is not a 1-2-5 spacing`)
        .toContain(Math.round(mantissa));
    }
  });

  it('keeps the lines about the same distance apart on screen at every zoom', () => {
    for (let fov = 2; fov < 20_000; fov *= 1.3) {
      const camera = { ...defaultCamera(), fovMm: fov };
      const pxPerLine = gridFor(camera, HEIGHT).spacingMm / (fov / HEIGHT);

      // A 1-2-5 sequence cannot hit a target exactly; it can stay inside a factor of about
      // two and a half of it, which is what keeps a grid readable rather than a grey wash.
      expect(pxPerLine, `${fov} mm view put lines ${pxPerLine.toFixed(0)} px apart`)
        .toBeGreaterThan(13);
      expect(pxPerLine).toBeLessThan(80);
    }
  });

  it('never draws an unbounded number of lines', () => {
    for (const fov of [1, 100, 10_000, 1e6]) {
      const g = gridFor({ ...defaultCamera(), fovMm: fov }, HEIGHT);
      expect(g.minor.length + g.major.length).toBeLessThan(600);
    }
  });

  it('follows the camera, so the carpet is under what is being looked at', () => {
    const away = gridFor({ ...defaultCamera(), target: [5000, 5000, 0] }, HEIGHT);
    const centres = away.minor.map((l) => l[0][0]);

    expect(Math.max(...centres)).toBeGreaterThan(4000);
  });

  it('leaves the two axes out of the ordinary lines, to colour them separately', () => {
    const g = gridFor(defaultCamera(), HEIGHT);

    // A line lying on an axis would be drawn twice, once grey and once coloured, and the grey
    // one would win or lose depending on draw order.
    for (const [a, b] of [...g.minor, ...g.major]) {
      const isXAxis = a[1] === 0 && b[1] === 0;
      const isYAxis = a[0] === 0 && b[0] === 0;
      expect(isXAxis || isYAxis, `a grid line duplicates an axis at ${a}`).toBe(false);
    }
    expect(g.axes).toHaveLength(2);
    expect(g.axes[0]![0][1]).toBe(0);      // the X axis lies at y = 0
    expect(g.axes[1]![0][0]).toBe(0);      // the Y axis lies at x = 0
  });

  it('lies on Z = 0, because that is the bench', () => {
    for (const [a, b] of gridFor(defaultCamera(), HEIGHT).minor) {
      expect(a[2]).toBe(0);
      expect(b[2]).toBe(0);
    }
  });
});

describe('the scale bar', () => {
  it('is a round number of millimetres, never a measured one', () => {
    for (let fov = 0.5; fov < 50_000; fov *= 1.11) {
      const bar = scaleBarFor({ ...defaultCamera(), fovMm: fov }, HEIGHT)!;
      const mantissa = bar.lengthMm / Math.pow(10, Math.floor(Math.log10(bar.lengthMm)));

      expect([1, 2, 5], `${bar.lengthMm} is not round`).toContain(Math.round(mantissa));
    }
  });

  it('measures what it says it measures', () => {
    const camera = { ...defaultCamera(), fovMm: 200 };
    const bar = scaleBarFor(camera, HEIGHT)!;

    // The bar's pixel width times the millimetres each pixel covers is its stated length.
    expect(bar.widthPx * (camera.fovMm / HEIGHT)).toBeCloseTo(bar.lengthMm, 9);
  });

  it('labels small and large views in units a person would use', () => {
    expect(scaleBarFor({ ...defaultCamera(), fovMm: 20_000 }, HEIGHT)!.label).toMatch(/m$/);
    expect(scaleBarFor({ ...defaultCamera(), fovMm: 200 }, HEIGHT)!.label).toMatch(/mm$/);
    expect(scaleBarFor({ ...defaultCamera(), fovMm: 0.5 }, HEIGHT)!.label).toMatch(/µm$/);
  });

  it('refuses to draw one in perspective, where it would be a lie', () => {
    expect(scaleBarFor({ ...defaultCamera(), orthographic: false }, HEIGHT)).toBeNull();
  });
});

describe('the triad', () => {
  it('puts Z up the screen in every side view', () => {
    for (const view of ['front', 'back', 'left', 'right'] as const) {
      const z = triadFor(at(view)).find((a) => a.axis === 'Z')!;
      expect(z.screen[1], `Z did not point up in the ${view} view`).toBeLessThan(-0.99);
    }
  });

  it('tells a top view from a bottom view', () => {
    const top = triadFor(at('top')).find((a) => a.axis === 'Z')!;
    const bottom = triadFor(at('bottom')).find((a) => a.axis === 'Z')!;

    // The same picture otherwise. Only which way Z points separates them.
    expect(top.towards).toBeGreaterThan(0.99);
    expect(bottom.towards).toBeLessThan(-0.99);
  });

  it('points X to the right in the front view, as the drawing convention has it', () => {
    const x = triadFor(at('front')).find((a) => a.axis === 'X')!;
    expect(x.screen[0]).toBeGreaterThan(0.99);
  });

  it('gives every axis a unit screen direction', () => {
    for (const axis of triadFor(orbit(defaultCamera(), 0.3, 0.2))) {
      expect(Math.hypot(...axis.screen)).toBeCloseTo(1, 9);
    }
  });
});

describe('the view cube', () => {
  it('shows exactly the three faces a solid cube can show', () => {
    const visible = viewCubeFaces(at('iso')).filter((f) => f.facing > 1e-6);
    expect(visible).toHaveLength(3);
  });

  it('shows one face square on when looking down an axis', () => {
    const faces = viewCubeFaces(at('front'));
    const front = faces.find((f) => f.view === 'front')!;

    expect(front.facing).toBeCloseTo(1, 6);
    expect(faces.filter((f) => f.facing > 1e-6)).toHaveLength(1);
  });

  it('draws back to front, so the near face covers the far one', () => {
    const facings = viewCubeFaces(at('iso')).map((f) => f.facing);
    expect([...facings].sort((a, b) => a - b)).toEqual(facings);
  });

  it('returns the view you clicked on', () => {
    for (const view of ['front', 'back', 'left', 'right', 'top', 'bottom'] as const) {
      const camera = at(view);
      // Dead centre of the gizmo is the face turned towards the viewer.
      expect(viewCubeHit(camera, 0.5, 0.5), `centre of the ${view} view did not hit it`)
        .toBe(view);
    }
  });

  it('misses when the click is outside the cube', () => {
    expect(viewCubeHit(at('front'), 0.02, 0.02)).toBeNull();
    expect(viewCubeHit(at('iso'), 0.99, 0.5)).toBeNull();
  });

  it('never returns a face pointing away from the viewer', () => {
    const camera = at('iso');

    for (let x = 0; x <= 1; x += 0.02) {
      for (let y = 0; y <= 1; y += 0.02) {
        const hit = viewCubeHit(camera, x, y);
        if (!hit) continue;

        const face = viewCubeFaces(camera).find((f) => f.view === hit)!;
        expect(face.facing, `clicking ${x},${y} hit ${hit}, which faces away`)
          .toBeGreaterThan(0);
      }
    }
  });

  it('turns with the camera', () => {
    const before = viewCubeFaces(at('front')).find((f) => f.view === 'front')!.facing;
    const after = viewCubeFaces(orbit(at('front'), Math.PI / 2, 0))
      .find((f) => f.view === 'front')!.facing;

    expect(before).toBeGreaterThan(0.99);
    expect(after).toBeLessThan(0.01);
  });

  it('stays the same size however far the camera is from the part', () => {
    const near = viewCubeFaces(at('iso', 10));
    const far = viewCubeFaces(zoom(at('iso', 10), 100));

    expect(far[0]!.corners[0]![0]).toBeCloseTo(near[0]!.corners[0]![0], 9);
  });
});

describe('projecting a point', () => {
  it('puts the target at the centre of the screen', () => {
    const camera = { ...defaultCamera(), target: [10, 20, 30] as [number, number, number] };
    const p = projectPoint(camera, camera.target, 1.5)!;

    expect(p.x).toBeCloseTo(0.5, 9);
    expect(p.y).toBeCloseTo(0.5, 9);
  });

  it('agrees with the view height: a point half a view up is at the top edge', () => {
    const camera = at('front', 200);
    const p = projectPoint(camera, [0, 0, 100], 1)!;

    expect(p.y).toBeCloseTo(0, 6);
  });

  it('accounts for the aspect ratio across the screen', () => {
    const camera = at('front', 200);
    const wide = projectPoint(camera, [100, 0, 0], 2)!;
    const square = projectPoint(camera, [100, 0, 0], 1)!;

    // The same point sits nearer the middle of a wider viewport.
    expect(wide.x - 0.5).toBeCloseTo((square.x - 0.5) / 2, 9);
  });

  it('has nothing to say about a point behind a perspective camera', () => {
    const camera = { ...at('front'), orthographic: false };
    const behind = projectPoint(camera, [0, -10_000, 0], 1);

    expect(behind).toBeNull();
  });

  it('still projects a point behind an orthographic camera, because it is still on screen', () => {
    const camera = at('front');
    expect(projectPoint(camera, [0, -10_000, 0], 1)).not.toBeNull();
  });
});

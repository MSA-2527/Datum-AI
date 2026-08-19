import { describe, expect, it } from 'vitest';
import {
  estimateLight, heightFromShading, maskFromProfile, reliefFromImage, sampleHeight, shadingStrength,
} from './relief';
import { luminance, traceImage, type RasterImage } from './trace';
import type { Vec2 } from '../../kernel/math/vec';

/**
 * Shape from shading, checked against surfaces whose answer is known before the test runs.
 *
 * This is the only honest way to test a reconstruction. Scoring a recovered surface against
 * itself, or against how it looks, tells you nothing — so every case here is a synthetic render
 * of a shape with a closed-form height, lit from a direction chosen in the test, and the
 * question is whether the algorithm gets back what was put in.
 */

/**
 * Renders a surface as a Lambertian solid lit from `light`, on a white background.
 *
 * Takes the *normal* rather than the height, and that is not a convenience. Deriving normals by
 * finite differences of the height gets the silhouette wrong: there are no neighbours outside
 * the object to difference against, the gradient falls back to zero, and the rim renders as
 * though it faced the viewer. It does not — at the edge of a smooth solid the surface has
 * turned exactly side-on. Since reading the light off that rim is the whole basis of the
 * estimator being tested, a renderer that fakes it tests nothing.
 *
 * The forward model is written out here rather than shared with the solver, so the two cannot
 * agree with each other while both being wrong about how light works.
 */
function render(
  w: number, h: number,
  normal: (x: number, y: number) => [number, number, number] | null,
  light: [number, number, number] = [0, 0, 1],
): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Sampled at the pixel *centre*, which is where `maskFromProfile` tests too. Rendering
      // at the integer corner instead put the image half a pixel out from the mask, so rim
      // pixels of the mask landed on background and the estimator read the white bench as part
      // of the object.
      const n = normal(x + 0.5, y + 0.5);
      if (!n) continue;   // background stays white: the tracer takes dark pixels as material

      const shade = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);

      // Albedo below one, so even the brightest point of the object is darker than the
      // background it stands on and the tracer can separate the two.
      const v = Math.round(Math.min(1, shade) * 0.75 * 255);
      const p = (y * w + x) * 4;
      data[p] = v; data[p + 1] = v; data[p + 2] = v;
    }
  }

  return { width: w, height: h, data };
}

/** True height of a dome of radius `r`, as a fraction of `r`. Zero at the rim, one at the top. */
function domeHeight(size: number, r: number, x: number, y: number): number {
  const c = size / 2;
  const d2 = (x - c) ** 2 + (y - c) ** 2;
  return d2 <= r * r ? Math.sqrt(r * r - d2) / r : 0;
}

/**
 * Exact normals of a dome: `n = (x − c, y − c, z) / r`.
 *
 * At the rim `z` is zero, so the normal lies in the image plane — which is the fact the light
 * estimator reads, and the fact a finite-difference renderer destroys.
 */
function dome(size: number, r: number) {
  const c = size / 2;
  return (x: number, y: number): [number, number, number] | null => {
    const d2 = (x - c) ** 2 + (y - c) ** 2;
    if (d2 > r * r) return null;
    const z = Math.sqrt(r * r - d2);
    return [(x - c) / r, (y - c) / r, z / r];
  };
}

/** A flat disc: every normal faces the viewer, so nothing varies around the rim. */
function disc(size: number, r: number) {
  const c = size / 2;
  return (x: number, y: number): [number, number, number] | null =>
    (x - c) ** 2 + (y - c) ** 2 <= r * r ? [0, 0, 1] : null;
}

/** A circle as a polygon, in millimetres at `mmPerPixel`. */
function circleLoop(size: number, r: number, mmPerPixel: number): Vec2[] {
  const c = size / 2;
  const loop: Vec2[] = [];
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    loop.push([(c + r * Math.cos(a)) * mmPerPixel, (c + r * Math.sin(a)) * mmPerPixel]);
  }
  return loop;
}

describe('the mask', () => {
  it('covers the outline and nothing outside it', () => {
    const size = 64, r = 20, mm = 0.5;
    const mask = maskFromProfile(circleLoop(size, r, mm), [], size, size, mm);

    let covered = 0;
    for (const v of mask) covered += v;

    // A disc of radius 20 holds about 1257 pixels. Polygonal, so allow a few percent.
    expect(covered).toBeGreaterThan(Math.PI * r * r * 0.95);
    expect(covered).toBeLessThan(Math.PI * r * r * 1.05);

    // Corners are outside a centred disc.
    expect(mask[0]).toBe(0);
    expect(mask[size * size - 1]).toBe(0);
  });

  it('excludes holes, so a washer is not integrated across its bore', () => {
    const size = 64, mm = 0.5;
    const mask = maskFromProfile(
      circleLoop(size, 24, mm), [circleLoop(size, 8, mm)], size, size, mm,
    );

    expect(mask[(size / 2) * size + size / 2]).toBe(0);   // the centre is the bore
    expect(mask[(size / 2) * size + size / 2 + 16]).toBe(1);
  });
});

describe('how oblique the light is', () => {
  const size = 96, r = 34, mm = 0.5;
  const mask = () => maskFromProfile(circleLoop(size, r, mm), [], size, size, mm);

  it('calls a light along the view direction not oblique', () => {
    const img = render(size, size, dome(size, r), [0, 0, 1]);
    const light = estimateLight(luminance(img), mask(), size, size);

    expect(Math.hypot(light.direction[0], light.direction[1])).toBeLessThan(0.2);
    expect(light.direction[2]).toBeGreaterThan(0.95);
  });

  it('points at a light from the left', () => {
    const img = render(size, size, dome(size, r), [-0.6, 0, 0.8]);
    const light = estimateLight(luminance(img), mask(), size, size);

    expect(light.direction[0]).toBeLessThan(-0.2);
    expect(Math.abs(light.direction[1])).toBeLessThan(0.2);
  });

  it('points at a light from below', () => {
    const img = render(size, size, dome(size, r), [0, 0.6, 0.8]);
    const light = estimateLight(luminance(img), mask(), size, size);

    expect(light.direction[1]).toBeGreaterThan(0.2);
    expect(Math.abs(light.direction[0])).toBeLessThan(0.2);
  });

  it('grows with the angle rather than jumping', () => {
    const off = (lx: number) => {
      const img = render(size, size, dome(size, r), [lx, 0, Math.sqrt(1 - lx * lx)]);
      const l = estimateLight(luminance(img), mask(), size, size);
      return Math.hypot(l.direction[0], l.direction[1]);
    };

    expect(off(0.2)).toBeLessThan(off(0.5));
    expect(off(0.5)).toBeLessThanOrEqual(off(0.7));
  });

  it('says nothing rather than dividing by zero on an empty mask', () => {
    const n = 32;
    const light = estimateLight(new Uint8Array(n * n), new Uint8Array(n * n), n, n);

    expect(light.confidence).toBe(0);
    expect(light.direction).toEqual([0, 0, 1]);
  });
});

describe('is there a surface here at all', () => {
  const size = 96, r = 34, mm = 0.5;
  const mask = () => maskFromProfile(circleLoop(size, r, mm), [], size, size, mm);

  it('a shaded dome varies inside its outline', () => {
    const img = render(size, size, dome(size, r), [0, 0, 1]);
    expect(shadingStrength(luminance(img), mask())).toBeGreaterThan(0.1);
  });

  it('a flat cut-out does not', () => {
    // The signal that says "do not build a relief": a screenshot, a line drawing or a laser-cut
    // blank is one flat tone inside its outline, and a relief from it is noise given a shape.
    const flat = render(size, size, disc(size, r));
    expect(shadingStrength(luminance(flat), mask())).toBeLessThan(0.02);
  });

  it('says nothing about an empty mask instead of dividing by zero', () => {
    expect(shadingStrength(new Uint8Array(64), new Uint8Array(64))).toBe(0);
  });
});

describe('recovering a dome', () => {
  const size = 96, r = 34, mm = 0.5;

  function recovered() {
    const img = render(size, size, dome(size, r), [0, 0, 1]);
    const mask = maskFromProfile(circleLoop(size, r, mm), [], size, size, mm);
    return { z: heightFromShading(luminance(img), mask, size, size), mask };
  }

  it('comes back domed, not flat', () => {
    // The complaint this answers: a photograph of a curved thing became a flat plate, because
    // everything inside the outline had been thrown away by the threshold.
    const { z } = recovered();
    const centre = z[(size / 2) * size + size / 2]!;

    expect(centre).toBeGreaterThan(0.5);
  });

  it('falls away from the centre towards the rim', () => {
    const { z } = recovered();
    const c = size / 2;
    const along = [0, 6, 12, 18, 24, 30].map((d) => z[c * size + c + d]!);

    for (let i = 1; i < along.length; i++) {
      expect(along[i]!).toBeLessThanOrEqual(along[i - 1]! + 1e-6);
    }
  });

  it('follows the profile of the dome that produced it', () => {
    // Against the closed-form height rather than against a shape someone eyeballed. A
    // reconstruction that merely decreases outwards could be a cone; this has to be the sphere.
    const { z } = recovered();
    const c = size / 2;

    for (const d of [0, 8, 16, 24, 30]) {
      const got = z[c * size + c + d]!;
      const want = domeHeight(size, r, c + d, c);
      expect(Math.abs(got - want)).toBeLessThan(0.16);
    }
  });

  it('is zero on the silhouette, so the surface closes onto its outline', () => {
    // The boundary condition that makes the problem well posed. If it drifts, the relief no
    // longer meets the walls of the solid built from the same outline.
    const { z, mask } = recovered();

    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = y * size + x;
        if (!mask[i]) continue;
        const edge = !mask[i - 1] || !mask[i + 1] || !mask[i - size] || !mask[i + size];
        if (edge) expect(z[i]!).toBe(0);
      }
    }
  });

  it('is roughly symmetric, as the dome that produced it was', () => {
    const { z } = recovered();
    const c = size / 2;

    for (const d of [8, 16, 24]) {
      const left = z[c * size + c - d]!;
      const right = z[c * size + c + d]!;
      const up = z[(c - d) * size + c]!;

      expect(Math.abs(left - right)).toBeLessThan(0.2);
      expect(Math.abs(left - up)).toBeLessThan(0.25);
    }
  });

  it('never goes below the base it stands on', () => {
    const { z } = recovered();
    for (const v of z) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe('telling a shaded solid from a flat cut-out', () => {
  const size = 96, r = 34, mm = 0.5;

  it('gives a dome a relief worth building', () => {
    const img = render(size, size, dome(size, r), [0, 0, 1]);
    const rel = reliefFromImage(img, circleLoop(size, r, mm), [], mm)!;

    expect(rel).not.toBeNull();
    // A hemisphere is half as tall as it is wide, and the ratio is in real proportions rather
    // than normalised ones — which is what makes the relief depth come out in millimetres that
    // mean something.
    expect(rel.reliefRatio).toBeGreaterThan(0.35);
    expect(rel.reliefRatio).toBeLessThan(0.65);
    expect(rel.shading).toBeGreaterThan(0.1);
  });

  it('refuses a picture too small to hold a surface', () => {
    const tiny: RasterImage = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) };
    expect(reliefFromImage(tiny, circleLoop(4, 1, 1), [], 1)).toBeNull();
  });

  it('refuses an outline that covers almost no pixels', () => {
    const img = render(size, size, dome(size, r), [0, 0, 1]);
    expect(reliefFromImage(img, circleLoop(size, 2, mm), [], mm)).toBeNull();
  });
});

describe('sampling the field', () => {
  it('interpolates between pixels rather than stepping', () => {
    // The reason the result is not blocky: the mesh reads the field continuously.
    const f = new Float32Array([0, 1, 0, 1]);
    expect(sampleHeight(f, 2, 2, 0.5, 0)).toBeCloseTo(0.5, 6);
    expect(sampleHeight(f, 2, 2, 0, 0.5)).toBeCloseTo(0, 6);
  });

  it('reads zero outside the field instead of wrapping', () => {
    const f = new Float32Array([1, 1, 1, 1]);
    expect(sampleHeight(f, 2, 2, -1, 0)).toBe(0);
    expect(sampleHeight(f, 2, 2, 0, 5)).toBe(0);
  });
});

describe('knowing when not to try', () => {
  const size = 128, r = 46, mm = 0.5;

  it('reports a side light as oblique, so the caller can decline', () => {
    // Under a strong side light the eikonal reads bright as flat and builds a ridge leaning
    // into the lamp. The method does not handle it; the point is that it says so.
    const img = render(size, size, dome(size, r), [-0.6, 0, 0.8]);
    const traced = traceImage(img, { mmPerPixel: mm });
    if ('error' in traced) throw new Error(traced.error);

    const rel = reliefFromImage(img, traced.profile.outer, traced.profile.holes, mm)!;
    expect(rel.obliquity).toBeGreaterThan(0.35);
  });

  it('reports a frontal light as not oblique', () => {
    const img = render(size, size, dome(size, r), [0, 0, 1]);
    const traced = traceImage(img, { mmPerPixel: mm });
    if ('error' in traced) throw new Error(traced.error);

    const rel = reliefFromImage(img, traced.profile.outer, traced.profile.holes, mm)!;
    expect(rel.obliquity).toBeLessThan(0.2);
  });
});

describe('through the tracer, as the importer will use it', () => {
  it('traces a rendered dome and recovers a relief from the same picture', () => {
    const size = 128, r = 46, mm = 0.5;
    const img = render(size, size, dome(size, r), [0, 0, 1]);

    const traced = traceImage(img, { mmPerPixel: mm });
    expect('error' in traced).toBe(false);
    if ('error' in traced) return;

    const rel = reliefFromImage(img, traced.profile.outer, traced.profile.holes, mm)!;
    expect(rel).not.toBeNull();

    // Domed in the middle, whatever the outline came out as, and the peak is the middle.
    const centre = sampleHeight(rel.height, rel.width, rel.height_, size / 2, size / 2);
    expect(centre).toBeGreaterThan(0.9);
    expect(rel.obliquity).toBeLessThan(0.2);
  });
});

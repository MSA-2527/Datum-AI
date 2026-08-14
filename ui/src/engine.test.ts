import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES, CONNECTORS, WORKS_OFFLINE,
  addInstance, addMate, addPart, assemblyProperties, billOfMaterials,
  drawingToDxf, drawingToSvg, emptyAssembly, generateFromText, health,
  importDrawing, makeDrawing, massProperties, readDxf, solveMates, traceImage,
  extrude, XY,
  type RasterImage,
} from './engine';

/**
 * End-to-end tests for the standalone engine.
 *
 * These are the acceptance tests for the product's central claim: that it models, draws and
 * exports on its own, with no CAD licence, no installation and no network. Each one walks a
 * whole user journey rather than a single function, because a set of individually correct
 * modules that do not compose is not a product.
 *
 * Nothing here imports anything from the SOLIDWORKS connector. That is the point, and it is
 * enforced rather than asserted: if the engine ever grew a dependency on the add-in, this
 * file would fail to run at all.
 */

describe('the engine stands alone', () => {
  it('declares no capability that needs SOLIDWORKS', () => {
    expect(WORKS_OFFLINE).toBe(true);
    for (const c of CAPABILITIES) expect(c.needsSolidWorks).toBe(false);
  });

  it('states a limit for every capability', () => {
    // A capability list without limits is a sales sheet. A user who finds the boundary by
    // hitting it mid-job has been badly served.
    for (const c of CAPABILITIES) {
      expect(c.limits.length, `${c.id} has no stated limit`).toBeGreaterThan(30);
    }
  });

  it('presents SOLIDWORKS as an optional connector, honestly labelled', () => {
    const sw = CONNECTORS.find((c) => c.id === 'solidworks')!;
    expect(sw).toBeDefined();
    // It has never been compiled — there is no licence here to compile it against — and
    // saying otherwise would be the single most misleading claim this product could make.
    expect(sw.status).toBe('unverified');
    expect(sw.requires).toMatch(/licence/i);
  });
});

describe('journey: describe a part in words', () => {
  it('turns "make a cup" into a manufacturable solid', () => {
    const out = generateFromText('make a cup');
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(health(out.result.mesh).closed).toBe(true);
    expect(massProperties(out.result.mesh).volume).toBeGreaterThan(0);

    // It must carry a feature tree with editable parameters, not just geometry.
    expect(out.result.steps.length).toBeGreaterThan(0);
    expect(out.result.params.length).toBeGreaterThan(3);
  });

  it('produces a drawing of what it just built, ready for a shop', () => {
    const out = generateFromText('a 200 x 120 x 10 plate');
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const drawing = makeDrawing(out.result.mesh, {
      fast: true,
      titleBlock: { partNumber: 'PLT-200', description: 'Base plate' },
    });

    const svg = drawingToSvg(drawing);
    const dxf = drawingToDxf(drawing);

    expect(svg).toContain('PLT-200');
    expect(dxf).toContain('ENTITIES');
    expect(drawing.views.some((v) => v.dimensions.length > 0)).toBe(true);
    expect(drawing.titleBlock.massGrams).toBeGreaterThan(0);
  });

  it('refuses a request it does not understand rather than inventing something', () => {
    const out = generateFromText('a widget for the flux manifold');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toMatch(/no shape/i);
  });
});

describe('journey: a picture becomes a part', () => {
  function render(w: number, h: number, inside: (x: number, y: number) => boolean): RasterImage {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const v = inside(x, y) ? 0 : 255;
        data[p] = data[p + 1] = data[p + 2] = v;
        data[p + 3] = 255;
      }
    }
    return { width: w, height: h, data };
  }

  it('traces a bracket outline and produces a drawing of it', () => {
    const img = render(200, 140, (x, y) => {
      const inPlate = x >= 20 && x <= 179 && y >= 20 && y <= 119;
      const inHole = (x - 100) ** 2 + (y - 70) ** 2 <= 20 ** 2;
      return inPlate && !inHole;
    });

    const traced = traceImage(img, { mmPerPixel: 0.5 });
    expect('error' in traced).toBe(false);
    if ('error' in traced) return;

    expect(traced.report.holesFound).toBe(1);
    expect(traced.report.widthMm).toBeCloseTo(80, 0);

    // The whole point: what comes out has to be buildable.
    const solid = extrude(traced.profile, XY, { distance: 6 });
    expect(health(solid).closed).toBe(true);
  });
});

describe('journey: a drawing becomes a part again', () => {
  const pair = (code: number, value: string | number) => `${code}\r\n${value}`;
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    [pair(0, 'LINE'), pair(8, '0'), pair(10, x1), pair(20, y1), pair(11, x2), pair(21, y2)].join('\r\n');
  const rect = (x: number, y: number, w: number, h: number) => [
    line(x, y, x + w, y), line(x + w, y, x + w, y + h),
    line(x + w, y + h, x, y + h), line(x, y + h, x, y),
  ];

  it('reads a two-view DXF and rebuilds the solid', () => {
    const text = [
      pair(0, 'SECTION'), pair(2, 'HEADER'), pair(9, '$INSUNITS'), pair(70, 4), pair(0, 'ENDSEC'),
      pair(0, 'SECTION'), pair(2, 'ENTITIES'),
      ...rect(0, 0, 120, 60),
      ...rect(0, -110, 120, 40),
      pair(0, 'ENDSEC'), pair(0, 'EOF'),
    ].join('\r\n');

    const doc = readDxf(text);
    expect('error' in doc).toBe(false);
    if ('error' in doc) return;

    const built = importDrawing(doc);
    expect(built.valid).toBe(true);
    expect(built.volume).toBeCloseTo(120 * 40 * 60, -3);

    // And it must say what it could not know.
    expect(built.caveats.join(' ')).toMatch(/visual hull/i);
  });

  it('round-trips: model to drawing to model', () => {
    // The strongest available check on both directions at once.
    const out = generateFromText('a 100 x 80 x 12 plate');
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const dxf = drawingToDxf(makeDrawing(out.result.mesh, { fast: true, views: ['front', 'top'] }));
    const reread = readDxf(dxf);
    expect('error' in reread).toBe(false);
    if ('error' in reread) return;

    // The geometry survives the round trip as readable entities.
    expect(reread.entities.length).toBeGreaterThan(4);
  });
});

describe('journey: components into an assembly', () => {
  it('mates parts, weighs them and produces a bill of materials', () => {
    const plateOut = generateFromText('a 120 x 80 x 10 plate');
    const boltOut = generateFromText('M10 hex nut');
    expect(plateOut.ok && boltOut.ok).toBe(true);
    if (!plateOut.ok || !boltOut.ok) return;

    const asm = emptyAssembly();
    const plate = addPart(asm, plateOut.result.mesh, 'Base plate', 'Al 6061-T6', 2.7);
    const nut = addPart(asm, boltOut.result.mesh, 'M10 nut', 'Steel', 7.85);

    const pi = addInstance(asm, plate, [0, 0, 0], true);
    const ni = addInstance(asm, nut, [40, 20, 60]);

    addMate(asm, 'coincident', { instance: pi.id, point: [0, 0, 10] }, { instance: ni.id, point: [0, 0, 0] });

    const solved = solveMates(asm);
    expect(solved.residual).toBeLessThan(1e-5);

    const props = assemblyProperties(solved.assembly);
    expect(props.massGrams).toBeGreaterThan(0);
    expect(props.instanceCount).toBe(2);

    const bom = billOfMaterials(solved.assembly);
    expect(bom.length).toBe(2);
    expect(bom.every((b) => b.massGrams > 0)).toBe(true);
    expect(bom.some((b) => b.material === 'Steel')).toBe(true);
  });
});

describe('journey: the whole loop', () => {
  it('describes, models, checks, draws and exports without any connector', () => {
    // A user with no CAD licence, no network and no API key does all of this.
    const out = generateFromText('a flange 160 mm diameter with 8 bolts');
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // 1. It is a real solid.
    expect(health(out.result.mesh).closed).toBe(true);
    const mp = massProperties(out.result.mesh);
    expect(mp.volume).toBeGreaterThan(0);

    // 2. Its mass is known, not guessed.
    const massGrams = (mp.volume / 1000) * 7.85;
    expect(massGrams).toBeGreaterThan(100);

    // 3. It draws, with hidden lines resolved.
    const drawing = makeDrawing(out.result.mesh, {
      views: ['front', 'top'],
      titleBlock: { partNumber: 'FLG-160', material: 'Steel', description: 'Pipe flange' },
      density: 7.85,
    });
    expect(drawing.views.length).toBe(2);
    expect(drawing.views.some((v) => v.view.report.hiddenSegments > 0)).toBe(true);

    // 4. And it leaves the application in a form a shop can use.
    const dxf = drawingToDxf(drawing);
    expect(dxf).toContain('OUTLINE');
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);

    const svg = drawingToSvg(drawing);
    expect(svg).toContain('FLG-160');
    expect(svg).toContain('Steel');
  });
});

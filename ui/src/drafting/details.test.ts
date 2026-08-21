import { describe, expect, it } from 'vitest';
import { runScript } from '../generate/script';
import { evaluateDocument } from '../model/document';
import { health, triCount, bounds } from '../kernel/topo/mesh';
import { componentMeshes, makeDetailSheets } from './details';
import { drawingToSvg } from './sheet';

/**
 * A drawing per part, not one for the pile.
 *
 * The thing being guarded against is a set of sheets that all show the assembly: plausible,
 * professional-looking, and useless to the machinist who has to make one bracket. So the
 * assertions are about *separation* — each sheet showing its own part at its own size — rather
 * than about the sheets existing.
 */

/** Two boxes and a bar: three components, at known and different sizes. */
const ASSEMBLY = [
  'name Frame',
  'material Aluminium 6061',
  'box Base length=120 width=80 height=10',
  'box Post length=20 width=20 height=60 at.x=40 at.z=35',
  'cylinder Boss diameter=30 height=12 at.x=-40 at.z=11',
].join('\n');

function build(script: string) {
  const result = runScript(script);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return { doc: result.doc, evaluated: evaluateDocument(result.doc) };
}

describe('recovering the parts', () => {
  it('finds every component that contributed material', () => {
    const { doc, evaluated } = build(ASSEMBLY);
    const parts = componentMeshes(doc, evaluated);

    expect(parts.map((p) => p.name)).toEqual(['Base', 'Post', 'Boss']);
  });

  it('gives each one its own geometry, at its own size', () => {
    const { doc, evaluated } = build(ASSEMBLY);
    const parts = componentMeshes(doc, evaluated);

    const size = (name: string) => {
      const b = bounds(parts.find((p) => p.name === name)!.mesh);
      return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
        .map((v) => Math.round(v));
    };

    expect(size('Base')).toEqual([120, 80, 10]);
    expect(size('Post')).toEqual([20, 20, 60]);
    // A cylinder's facets fall a little inside its diameter.
    expect(size('Boss')[2]).toBe(12);
  });

  it('carries the face tags across, so a bore is still a bore on the sheet', () => {
    const { doc, evaluated } = build(ASSEMBLY);
    const boss = componentMeshes(doc, evaluated).find((p) => p.name === 'Boss')!;

    expect([...boss.mesh.tags.values()].some((t) => t.kind === 'cylindrical')).toBe(true);
  });

  it('leaves out a feature that removed material, because a hole is not a part', () => {
    const { doc, evaluated } = build([
      'box Body length=60 width=40 height=20',
      'hole Bolts diameter=8',
    ].join('\n'));

    expect(componentMeshes(doc, evaluated).map((p) => p.name)).toEqual(['Body']);
  });

  it('leaves out a suppressed feature', () => {
    const { doc, evaluated } = build(ASSEMBLY);
    const suppressed = {
      ...doc,
      features: doc.features.map((f) => (f.name === 'Post' ? { ...f, suppressed: true } : f)),
    };

    expect(componentMeshes(suppressed, evaluated).map((p) => p.name))
      .toEqual(['Base', 'Boss']);
  });
});

describe('which part a modifier belongs to', () => {
  /*
   * Written after the post, drilled through the base. By document order the holes belong to the
   * post and cut nothing there, so they vanish from the pack — while every sheet still looks
   * complete, correctly bordered and fully dimensioned. Nothing about the output says the part
   * you make from it will have no bolt holes in it.
   */
  const FRAME = [
    'box Base length=120 width=80 height=10',
    'box Post length=20 width=20 height=60 at.x=40 at.z=35',
    'hole Bolts diameter=8 pattern=grid cols=2 rows=2 spacingX=90 spacingY=50',
  ].join('\n');

  it('puts the holes on the sheet for the part they were drilled into', () => {
    const { doc, evaluated } = build(FRAME);
    const parts = componentMeshes(doc, evaluated);

    const base = parts.find((p) => p.name === 'Base')!;
    const post = parts.find((p) => p.name === 'Post')!;

    const bores = (part: typeof base) =>
      [...part.mesh.tags.values()].filter((t) => t.kind === 'cylindrical').length;

    expect(bores(base), 'the bolt holes are missing from the base').toBeGreaterThan(0);
    expect(bores(post), 'the bolt holes were drilled into the post, which they miss').toBe(0);
  });

  it('puts a hole through two parts on both their sheets', () => {
    // Which is what a shop would expect to receive: both parts get drilled.
    const { doc, evaluated } = build([
      'box Upper length=60 width=60 height=10 at.z=25',
      'box Lower length=60 width=60 height=10 at.z=5',
      'hole Through diameter=8',
    ].join('\n'));

    for (const part of componentMeshes(doc, evaluated)) {
      const bores = [...part.mesh.tags.values()].filter((t) => t.kind === 'cylindrical');
      expect(bores.length, `${part.name} did not get the hole`).toBeGreaterThan(0);
    }
  });
});

describe('the sheet set', () => {
  it('issues the assembly first, then one sheet per part', () => {
    const { doc, evaluated } = build(ASSEMBLY);
    const sheets = makeDetailSheets(doc, evaluated);

    expect(sheets.map((s) => s.name)).toEqual(['Frame', 'Base', 'Post', 'Boss']);
    expect(sheets.map((s) => s.sheet)).toEqual([1, 2, 3, 4]);
  });

  it('numbers them as a set, so a shop knows what is missing', () => {
    const { doc, evaluated } = build(ASSEMBLY);

    for (const sheet of makeDetailSheets(doc, evaluated)) {
      expect(sheet.of).toBe(4);
      expect(sheet.drawing.titleBlock.sheet).toBe(`${sheet.sheet} of 4`);
    }
  });

  it('titles each sheet with its own part', () => {
    const { doc, evaluated } = build(ASSEMBLY);
    const sheets = makeDetailSheets(doc, evaluated);

    expect(sheets[2]!.drawing.titleBlock.description).toBe('Post');
    expect(sheets[2]!.drawing.titleBlock.partNumber).toBe('POST');
  });

  it('dimensions each part rather than leaving the sheet to be marked up by hand', () => {
    const { doc, evaluated } = build(ASSEMBLY);

    for (const sheet of makeDetailSheets(doc, evaluated).slice(1)) {
      const dimensions = sheet.drawing.views.reduce((n, v) => n + v.dimensions.length, 0);
      expect(dimensions, `${sheet.name} came out undimensioned`).toBeGreaterThan(0);
    }
  });

  it('draws different geometry on each sheet, not the assembly four times', () => {
    /*
     * The failure this exists for. A set where every sheet is the assembly looks completely
     * professional — right border, right title block, right numbering — and is worthless. The
     * only way to tell is to compare what is actually drawn.
     */
    const { doc, evaluated } = build(ASSEMBLY);

    // The geometry itself, not a count of it: two different boxes draw the same number of
    // lines, so counting them would pass on a set of four identical sheets.
    const drawn = makeDetailSheets(doc, evaluated).map((s) => s.drawing.views
      .map((v) => v.view.segments
        .map((seg) => seg.a.map((n) => n.toFixed(2)).join(',') + '|' + seg.b.map((n) => n.toFixed(2)).join(','))
        .sort()
        .join(';'))
      .join('#'));

    expect(new Set(drawn).size).toBe(drawn.length);
  });

  it('states each part’s own mass, not the assembly’s', () => {
    const { doc, evaluated } = build(ASSEMBLY);
    const sheets = makeDetailSheets(doc, evaluated);

    const assembly = sheets[0]!.drawing.titleBlock.massGrams ?? 0;
    for (const part of sheets.slice(1)) {
      expect(part.drawing.titleBlock.massGrams ?? 0).toBeLessThan(assembly);
    }
  });

  it('gives a single part a set of one, not an assembly sheet and a copy of it', () => {
    const { doc, evaluated } = build('box Body length=60 width=40 height=20');
    const sheets = makeDetailSheets(doc, evaluated);

    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.of).toBe(1);
  });

  it('produces sheets that render', () => {
    const { doc, evaluated } = build(ASSEMBLY);

    for (const sheet of makeDetailSheets(doc, evaluated)) {
      const svg = drawingToSvg(sheet.drawing);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.length).toBeGreaterThan(500);
    }
  });
});

describe('the parts that come out', () => {
  it('does not corrupt the geometry it slices', () => {
    const { doc, evaluated } = build(ASSEMBLY);

    for (const part of componentMeshes(doc, evaluated)) {
      expect(triCount(part.mesh)).toBeGreaterThan(0);
      /*
       * Closed, because each part is rebuilt rather than cut out of the assembly. Slicing the
       * merged mesh would hand back the base *minus the post standing on it* — an open shell
       * with no volume, no mass and no outline to dimension.
       */
      expect(health(part.mesh).closed, `${part.name} came out open`).toBe(true);
    }
  });
});

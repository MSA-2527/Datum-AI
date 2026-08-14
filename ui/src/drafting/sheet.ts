/**
 * Assembles a finished drawing and exports it.
 *
 * The output has to be something a shop can actually use, which means two formats: SVG for
 * viewing and printing, and DXF because that is what every CAM system, laser cutter and
 * waterjet reads. An in-app preview that cannot leave the app is not a deliverable.
 */

import type { Vec2 } from '../kernel/math/vec';
import { massProperties, bounds as meshBounds, type Mesh } from '../kernel/topo/mesh';
import {
  centreMarks, mergeCollinear, project, type LineStyle, type ProjectedSegment,
  type StandardView,
} from './project';
import {
  autoDimension, chooseScale, defaultTitleBlock, formatFcf, layoutViews, suggestGdt,
  SHEET_MM, type Dimension, type Drawing, type SheetSize, type TitleBlock,
} from './dimension';

export interface DrawingOptions {
  views?: StandardView[];
  sheet?: SheetSize;
  titleBlock?: Partial<TitleBlock>;
  /** Density in g/cm³, for the mass field. Aluminium 6061 by default. */
  density?: number;
  dimension?: boolean;
  gdt?: boolean;
  /** Skip hidden line removal. Much faster; suitable for a live preview. */
  fast?: boolean;
}

/**
 * Produces a complete drawing from a solid.
 *
 * The default view set is front, top, right and isometric — the arrangement that
 * unambiguously defines a prismatic part. Fewer views leaves the reader guessing; more
 * clutters the sheet without adding information.
 */
export function makeDrawing(mesh: Mesh, opts: DrawingOptions = {}): Drawing {
  const views = opts.views ?? ['front', 'top', 'right', 'iso'];
  const sheet = opts.sheet ?? 'A3';

  const projected = views.map((v) => {
    const p = project(mesh, { view: v, visibleOnly: opts.fast });
    // HLR emits one segment per sample run, so a single edge can arrive as a dozen collinear
    // pieces. Merging them is not cosmetic: a DXF with 400 fragments instead of 30 lines
    // makes CAM path planning worse and is unpleasant to edit.
    return { ...p, segments: mergeCollinear(p.segments) };
  });

  const laid = layoutViews(projected, sheet, opts.titleBlock?.projection ?? 'first-angle');

  // Extents of everything, to pick a scale that fits.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { view, offset } of laid) {
    minX = Math.min(minX, view.bounds.min[0] + offset[0]);
    minY = Math.min(minY, view.bounds.min[1] + offset[1]);
    maxX = Math.max(maxX, view.bounds.max[0] + offset[0]);
    maxY = Math.max(maxY, view.bounds.max[1] + offset[1]);
  }
  if (!Number.isFinite(minX)) { minX = minY = 0; maxX = maxY = 1; }

  // Allow room for dimensions and their text outside the geometry.
  const pad = 45;
  const scale = chooseScale([maxX - minX + pad * 2, maxY - minY + pad * 2], sheet);

  const mp = massProperties(mesh);
  const density = opts.density ?? 2.7;
  const massGrams = (Math.abs(mp.volume) / 1000) * density;

  const titleBlock = defaultTitleBlock({ scale: scale.label, massGrams, ...opts.titleBlock });

  const withDims = laid.map(({ view, offset }) => ({
    view,
    offset,
    dimensions: opts.dimension === false || view.view === 'iso'
      ? []
      : autoDimension(view).dimensions,
  }));

  const gdt = opts.gdt === false ? [] : suggestGdt(projected[0]).frames;

  const notes: string[] = [
    `General tolerance ${titleBlock.generalTolerance} unless stated.`,
    'Break sharp edges 0.3 max.',
    `Dimensions in ${titleBlock.units}.`,
  ];
  if (opts.fast) {
    notes.push('PREVIEW — hidden lines not computed. Not for manufacture.');
  }

  return {
    sheet,
    titleBlock,
    scale,
    views: withDims,
    gdt,
    bom: [],
    balloons: [],
    notes,
  };
}

// ── SVG output ───────────────────────────────────────────────────────────────

const STYLE_ATTR: Record<LineStyle, string> = {
  visible: 'stroke="currentColor" stroke-width="0.5" fill="none"',
  hidden: 'stroke="currentColor" stroke-width="0.25" stroke-dasharray="3,1.5" fill="none" opacity="0.75"',
  centre: 'stroke="currentColor" stroke-width="0.25" stroke-dasharray="8,2,1.5,2" fill="none" opacity="0.7"',
  section: 'stroke="currentColor" stroke-width="0.7" stroke-dasharray="12,3,3,3" fill="none"',
  phantom: 'stroke="currentColor" stroke-width="0.25" stroke-dasharray="10,2,2,2" fill="none" opacity="0.5"',
};

export function drawingToSvg(d: Drawing): string {
  const [sw, sh] = SHEET_MM[d.sheet];
  const s = d.scale.scale;

  // Model space to sheet space. Y is negated because SVG counts downward and every drawing
  // standard counts upward; getting this wrong mirrors the part, which is the single most
  // expensive drawing error there is.
  const cx = sw / 2, cy = sh / 2 - 12;
  const X = (x: number) => cx + x * s;
  const Y = (y: number) => cy - y * s;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sw}mm" height="${sh}mm" ` +
    `viewBox="0 0 ${sw} ${sh}" font-family="Helvetica, Arial, sans-serif" color="#111">`,
  );
  parts.push(`<rect x="0" y="0" width="${sw}" height="${sh}" fill="#fff"/>`);
  parts.push(`<rect x="10" y="10" width="${sw - 20}" height="${sh - 20}" fill="none" stroke="#111" stroke-width="0.7"/>`);

  for (const { view, offset, dimensions } of d.views) {
    parts.push(`<g id="view-${view.view}">`);

    const all: ProjectedSegment[] = [...view.segments, ...centreMarks(view.circles)];
    // Hidden lines first so visible lines draw over them where they coincide.
    const ordered = [...all].sort((a, b) => (a.style === 'visible' ? 1 : 0) - (b.style === 'visible' ? 1 : 0));

    for (const seg of ordered) {
      const x1 = X(seg.a[0] + offset[0]), y1 = Y(seg.a[1] + offset[1]);
      const x2 = X(seg.b[0] + offset[0]), y2 = Y(seg.b[1] + offset[1]);
      parts.push(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" ${STYLE_ATTR[seg.style]}/>`);
    }

    for (const c of view.circles) {
      if (!c.faceOn) continue;
      parts.push(
        `<circle cx="${f(X(c.centre[0] + offset[0]))}" cy="${f(Y(c.centre[1] + offset[1]))}" ` +
        `r="${f(c.radius * s)}" ${STYLE_ATTR[c.visible ? 'visible' : 'hidden']}/>`,
      );
    }

    for (const dim of dimensions) parts.push(dimensionSvg(dim, offset, X, Y, s));

    parts.push(`<text x="${f(X(offset[0]))}" y="${f(Y(view.bounds.min[1] + offset[1]) + 26)}" ` +
      `text-anchor="middle" font-size="3.2" opacity="0.75">${view.view.toUpperCase()}</text>`);
    parts.push('</g>');
  }

  for (const g of d.gdt) {
    parts.push(
      `<text x="${f(X(g.at[0]))}" y="${f(Y(g.at[1]))}" font-size="3.4">${escapeXml(formatFcf(g))}</text>`,
    );
  }

  parts.push(titleBlockSvg(d, sw, sh));
  parts.push('</svg>');
  return parts.join('\n');
}

function dimensionSvg(
  dim: Dimension, offset: Vec2, X: (x: number) => number, Y: (y: number) => number, s: number,
): string {
  const ax = X(dim.from[0] + offset[0]), ay = Y(dim.from[1] + offset[1]);
  const bx = X(dim.to[0] + offset[0]), by = Y(dim.to[1] + offset[1]);
  const tx = X(dim.textAt[0] + offset[0]), ty = Y(dim.textAt[1] + offset[1]);

  const line = 'stroke="currentColor" stroke-width="0.25" fill="none"';
  const out: string[] = [`<g class="dim" data-rationale="${escapeXml(dim.rationale)}">`];

  if (dim.kind === 'diameter' || dim.kind === 'radius') {
    out.push(`<line x1="${f(ax)}" y1="${f(ay)}" x2="${f(bx)}" y2="${f(by)}" ${line}/>`);
    out.push(`<line x1="${f(bx)}" y1="${f(by)}" x2="${f(tx)}" y2="${f(ty)}" ${line}/>`);
  } else {
    // Extension lines out to the dimension line, then the dimension line itself with ticks.
    const horizontal = Math.abs(ay - by) < Math.abs(ax - bx);
    const dl = horizontal ? ty : tx;

    if (horizontal) {
      out.push(`<line x1="${f(ax)}" y1="${f(ay)}" x2="${f(ax)}" y2="${f(dl)}" ${line}/>`);
      out.push(`<line x1="${f(bx)}" y1="${f(by)}" x2="${f(bx)}" y2="${f(dl)}" ${line}/>`);
      out.push(`<line x1="${f(ax)}" y1="${f(dl)}" x2="${f(bx)}" y2="${f(dl)}" ${line} marker-start="url(#a)" marker-end="url(#a)"/>`);
    } else {
      out.push(`<line x1="${f(ax)}" y1="${f(ay)}" x2="${f(dl)}" y2="${f(ay)}" ${line}/>`);
      out.push(`<line x1="${f(bx)}" y1="${f(by)}" x2="${f(dl)}" y2="${f(by)}" ${line}/>`);
      out.push(`<line x1="${f(dl)}" y1="${f(ay)}" x2="${f(dl)}" y2="${f(by)}" ${line}/>`);
    }
  }

  const vertical = dim.kind === 'linear' && Math.abs(ax - bx) < Math.abs(ay - by);
  const rotate = vertical ? ` transform="rotate(-90 ${f(tx)} ${f(ty)})"` : '';

  out.push(
    `<text x="${f(tx)}" y="${f(ty - 1)}" text-anchor="middle" font-size="3.4"${rotate}>` +
    `${escapeXml(dim.text)}</text>`,
  );
  out.push('</g>');
  void s;
  return out.join('');
}

function titleBlockSvg(d: Drawing, sw: number, sh: number): string {
  const w = 150, h = 40;
  const x = sw - 10 - w, y = sh - 10 - h;
  const t = d.titleBlock;

  const cell = (cx: number, cy: number, label: string, value: string, size = 3.2) =>
    `<text x="${f(cx)}" y="${f(cy)}" font-size="2.1" opacity="0.65">${escapeXml(label)}</text>` +
    `<text x="${f(cx)}" y="${f(cy + 4.5)}" font-size="${size}">${escapeXml(value)}</text>`;

  const mass = t.massGrams === undefined ? '—' : `${t.massGrams.toFixed(1)} g`;

  return [
    `<g id="title-block">`,
    `<rect x="${f(x)}" y="${f(y)}" width="${w}" height="${h}" fill="none" stroke="#111" stroke-width="0.7"/>`,
    `<line x1="${f(x)}" y1="${f(y + 13)}" x2="${f(x + w)}" y2="${f(y + 13)}" stroke="#111" stroke-width="0.35"/>`,
    `<line x1="${f(x)}" y1="${f(y + 26)}" x2="${f(x + w)}" y2="${f(y + 26)}" stroke="#111" stroke-width="0.35"/>`,
    `<line x1="${f(x + 75)}" y1="${f(y)}" x2="${f(x + 75)}" y2="${f(y + 26)}" stroke="#111" stroke-width="0.35"/>`,
    cell(x + 3, y + 4, 'PART NUMBER', t.partNumber, 4),
    cell(x + 78, y + 4, 'REV', t.revision, 4),
    cell(x + 3, y + 17, 'DESCRIPTION', t.description),
    cell(x + 78, y + 17, 'MATERIAL', t.material),
    cell(x + 3, y + 30, 'SCALE', t.scale),
    cell(x + 33, y + 30, 'MASS', mass),
    cell(x + 63, y + 30, 'UNITS', t.units),
    cell(x + 90, y + 30, 'SHEET', t.sheet),
    cell(x + 118, y + 30, 'DATE', t.date),
    `<text x="${f(x)}" y="${f(y - 3)}" font-size="2.6" opacity="0.75">` +
    `${escapeXml(`${t.projection === 'first-angle' ? 'FIRST' : 'THIRD'} ANGLE PROJECTION · ${t.generalTolerance}`)}</text>`,
    ...d.notes.map((n, i) => `<text x="12" y="${f(sh - 14 - i * 4)}" font-size="2.6" opacity="0.8">${escapeXml(n)}</text>`),
    `</g>`,
  ].join('\n');
}

const f = (x: number): string => String(Number(x.toFixed(3)));

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── DXF output ───────────────────────────────────────────────────────────────

/**
 * Exports the drawing as DXF R12.
 *
 * R12 rather than a newer release deliberately: it is the most widely readable CAD
 * interchange format in existence, and every laser cutter, waterjet and CAM package on a
 * shop floor opens it without complaint. Newer DXF revisions carry more structure that
 * nothing downstream of a drawing actually needs.
 *
 * Layers follow the usual convention so the receiving system can suppress construction
 * geometry and dimension text independently of the part outline.
 */
export function drawingToDxf(d: Drawing): string {
  const out: string[] = [];
  const w = (code: number, value: string | number) => out.push(String(code), String(value));

  const LAYERS: { name: string; colour: number }[] = [
    { name: 'OUTLINE', colour: 7 },
    { name: 'HIDDEN', colour: 8 },
    { name: 'CENTRE', colour: 4 },
    { name: 'DIMENSIONS', colour: 3 },
    { name: 'TEXT', colour: 2 },
    { name: 'BORDER', colour: 7 },
  ];

  w(0, 'SECTION'); w(2, 'TABLES');
  w(0, 'TABLE'); w(2, 'LAYER'); w(70, LAYERS.length);
  for (const l of LAYERS) {
    w(0, 'LAYER'); w(2, l.name); w(70, 0); w(62, l.colour); w(6, 'CONTINUOUS');
  }
  w(0, 'ENDTAB');
  w(0, 'ENDSEC');

  w(0, 'SECTION'); w(2, 'ENTITIES');

  const layerFor = (style: LineStyle): string =>
    style === 'visible' ? 'OUTLINE' : style === 'hidden' ? 'HIDDEN' : 'CENTRE';

  const s = d.scale.scale;

  for (const { view, offset, dimensions } of d.views) {
    for (const seg of [...view.segments, ...centreMarks(view.circles)]) {
      w(0, 'LINE');
      w(8, layerFor(seg.style));
      w(10, num((seg.a[0] + offset[0]) * s)); w(20, num((seg.a[1] + offset[1]) * s)); w(30, 0);
      w(11, num((seg.b[0] + offset[0]) * s)); w(21, num((seg.b[1] + offset[1]) * s)); w(31, 0);
    }

    for (const c of view.circles) {
      if (!c.faceOn) continue;
      w(0, 'CIRCLE');
      w(8, c.visible ? 'OUTLINE' : 'HIDDEN');
      w(10, num((c.centre[0] + offset[0]) * s)); w(20, num((c.centre[1] + offset[1]) * s)); w(30, 0);
      w(40, num(c.radius * s));
    }

    // Dimensions are written as their constituent lines plus text rather than as DXF
    // DIMENSION entities. Associative dimensions require a full block table and a
    // dimension-style table, and receiving systems disagree about how to render them; lines
    // and text are read identically by everything.
    for (const dim of dimensions) {
      w(0, 'TEXT');
      w(8, 'DIMENSIONS');
      w(10, num((dim.textAt[0] + offset[0]) * s)); w(20, num((dim.textAt[1] + offset[1]) * s)); w(30, 0);
      w(40, 3.5);
      w(1, dim.text);
      w(72, 1);
      w(11, num((dim.textAt[0] + offset[0]) * s)); w(21, num((dim.textAt[1] + offset[1]) * s)); w(31, 0);

      w(0, 'LINE');
      w(8, 'DIMENSIONS');
      w(10, num((dim.from[0] + offset[0]) * s)); w(20, num((dim.from[1] + offset[1]) * s)); w(30, 0);
      w(11, num((dim.to[0] + offset[0]) * s)); w(21, num((dim.to[1] + offset[1]) * s)); w(31, 0);
    }
  }

  const [sw, sh] = SHEET_MM[d.sheet];
  const border: [number, number][] = [[10, 10], [sw - 10, 10], [sw - 10, sh - 10], [10, sh - 10]];
  for (let i = 0; i < 4; i++) {
    const a = border[i], b = border[(i + 1) % 4];
    w(0, 'LINE'); w(8, 'BORDER');
    w(10, num(a[0])); w(20, num(a[1])); w(30, 0);
    w(11, num(b[0])); w(21, num(b[1])); w(31, 0);
  }

  const t = d.titleBlock;
  const lines = [
    `${t.partNumber}  REV ${t.revision}`,
    t.description,
    `${t.material} · ${t.finish}`,
    `SCALE ${t.scale} · ${t.units} · ${t.generalTolerance}`,
  ];
  lines.forEach((text, i) => {
    w(0, 'TEXT'); w(8, 'TEXT');
    w(10, num(sw - 155)); w(20, num(20 + (lines.length - i) * 5)); w(30, 0);
    w(40, 3.5);
    w(1, text);
  });

  w(0, 'ENDSEC');
  w(0, 'EOF');

  return out.join('\r\n') + '\r\n';
}

const num = (x: number): string => x.toFixed(4);

// ── convenience ──────────────────────────────────────────────────────────────

/** A one-line summary of a drawing, for the UI. */
export function describeDrawing(d: Drawing): string {
  const dims = d.views.reduce((n, v) => n + v.dimensions.length, 0);
  const hidden = d.views.reduce((n, v) => n + v.view.report.hiddenSegments, 0);
  return (
    `${d.views.length} view${d.views.length === 1 ? '' : 's'} at ${d.scale.label} on ${d.sheet}, ` +
    `${dims} dimension${dims === 1 ? '' : 's'}, ${hidden} hidden-line segment${hidden === 1 ? '' : 's'}.`
  );
}

/** Overall envelope of the solid, which is what the title block's stock size comes from. */
export function stockSize(mesh: Mesh): { x: number; y: number; z: number } {
  const b = meshBounds(mesh);
  return { x: b.max[0] - b.min[0], y: b.max[1] - b.min[1], z: b.max[2] - b.min[2] };
}

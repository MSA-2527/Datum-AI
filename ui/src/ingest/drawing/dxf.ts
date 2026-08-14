/**
 * DXF reader.
 *
 * DXF is the only format every CAD system, laser cutter and CAM package agrees on, so it is
 * how a 2D drawing arrives. The format is a flat stream of (group code, value) pairs, which
 * is easy to read and easy to read *wrongly* — a parser that assumes structure it has not
 * checked will silently mis-associate coordinates and produce geometry that is subtly in the
 * wrong place.
 *
 * So this reads defensively: every entity validates its own required codes, anything
 * unrecognised is counted and reported rather than dropped in silence, and the caller is
 * told what was in the file that could not be used. A drawing that imports "successfully"
 * while having quietly discarded half its geometry is the worst possible outcome.
 *
 * Supported: LINE, CIRCLE, ARC, ELLIPSE, LWPOLYLINE, POLYLINE/VERTEX, SPLINE, POINT, plus
 * layer assignment.
 *
 * Text is not geometry, but it is not noise either. A drawing that shows one view almost
 * always writes the missing dimension down — `THK 6`, `t=3`, `6 MM THICK`, `MATERIAL: 3MM
 * MS`. Discarding it meant throwing away the one thing that made the third dimension
 * knowable, and then guessing at it. TEXT and MTEXT strings are collected as annotations so
 * that guess can be replaced by what the drawing actually says.
 */

import { type Vec2 } from '../../kernel/math/vec';

// ── entities ─────────────────────────────────────────────────────────────────

export type DxfEntity =
  | { type: 'line'; layer: string; a: Vec2; b: Vec2 }
  | { type: 'circle'; layer: string; centre: Vec2; radius: number }
  | { type: 'arc'; layer: string; centre: Vec2; radius: number; startDeg: number; endDeg: number }
  | { type: 'polyline'; layer: string; points: Vec2[]; closed: boolean }
  | { type: 'spline'; layer: string; controlPoints: Vec2[]; degree: number; closed: boolean }
  | { type: 'point'; layer: string; at: Vec2 };

export interface DxfDocument {
  entities: DxfEntity[];
  layers: string[];
  /** Units code from $INSUNITS, when present. */
  units: DxfUnits;
  bounds: { min: Vec2; max: Vec2 };
  report: DxfReport;
  /**
   * Every TEXT and MTEXT string in the file, in document order.
   *
   * Kept out of `entities` deliberately: these must never become geometry. They exist so a
   * reconstruction can read what the drawing says about itself — most importantly the plate
   * thickness, which a single-view drawing states in words rather than showing.
   */
  annotations: string[];
}

export interface DxfReport {
  entitiesRead: number;
  /** Entity types present in the file that this reader does not build geometry from. */
  skipped: { type: string; count: number }[];
  warnings: string[];
}

export type DxfUnits = 'unitless' | 'in' | 'ft' | 'mm' | 'cm' | 'm';

/** $INSUNITS codes, from the DXF specification. */
const UNIT_CODES: Record<number, DxfUnits> = {
  0: 'unitless', 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm',
};

export const UNIT_TO_MM: Record<DxfUnits, number> = {
  unitless: 1, in: 25.4, ft: 304.8, mm: 1, cm: 10, m: 1000,
};

// ── tokeniser ────────────────────────────────────────────────────────────────

interface Pair {
  code: number;
  value: string;
}

/**
 * Splits the stream into (code, value) pairs.
 *
 * DXF is line-oriented, alternating a numeric group code with its value. Both CRLF and LF
 * appear in the wild, and trailing whitespace is common from generators that pad fields, so
 * everything is trimmed rather than assumed clean.
 */
function tokenise(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: Pair[] = [];

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isFinite(code)) continue;
    out.push({ code, value: lines[i + 1].trim() });
  }
  return out;
}

// ── reader ───────────────────────────────────────────────────────────────────

export function readDxf(text: string): DxfDocument | { error: string } {
  if (!text || text.length < 8) return { error: 'The file is empty.' };
  if (!/\bSECTION\b/.test(text)) {
    return {
      error:
        'This does not look like a DXF file — no SECTION marker was found. ' +
        'Binary DXF and DWG are different formats and are not supported; ' +
        're-export as ASCII DXF.',
    };
  }

  const pairs = tokenise(text);
  const entities: DxfEntity[] = [];
  const annotations: string[] = [];
  const layers = new Set<string>();
  const skipped = new Map<string, number>();
  const warnings: string[] = [];
  let units: DxfUnits = 'unitless';

  // Header scan for $INSUNITS.
  for (let i = 0; i + 1 < pairs.length; i++) {
    if (pairs[i].code === 9 && pairs[i].value === '$INSUNITS') {
      const v = Number(pairs[i + 1]?.value);
      if (Number.isFinite(v) && UNIT_CODES[v]) units = UNIT_CODES[v];
      break;
    }
  }

  // Find the ENTITIES section.
  let i = 0;
  while (i < pairs.length) {
    if (pairs[i].code === 0 && pairs[i].value === 'SECTION' &&
        pairs[i + 1]?.code === 2 && pairs[i + 1]?.value === 'ENTITIES') {
      i += 2;
      break;
    }
    i++;
  }

  if (i >= pairs.length) {
    return { error: 'The file has no ENTITIES section, so it contains no drawing geometry.' };
  }

  // Walk entities. Each begins with code 0 and runs until the next code 0.
  while (i < pairs.length) {
    if (pairs[i].code !== 0) { i++; continue; }

    const type = pairs[i].value;
    if (type === 'ENDSEC') break;

    // Collect this entity's pairs.
    const body: Pair[] = [];
    let j = i + 1;
    while (j < pairs.length && pairs[j].code !== 0) { body.push(pairs[j]); j++; }

    // Text is captured before the geometry dispatch, because it is the one kind of
    // "unsupported" entity whose content is worth keeping. Code 1 holds the string; MTEXT
    // splits long runs across code 3 continuations, which have to be joined in order or the
    // callout reads as fragments.
    if (type === 'TEXT' || type === 'MTEXT' || type === 'ATTRIB') {
      const parts = body.filter((p) => p.code === 3).map((p) => p.value);
      const tail = body.find((p) => p.code === 1)?.value;
      if (tail !== undefined) parts.push(tail);
      const joined = cleanMText(parts.join(''));
      if (joined) annotations.push(joined);
    }

    const built = buildEntity(type, body, warnings);
    if (built) {
      for (const e of built) { entities.push(e); layers.add(e.layer); }
    } else if (type !== 'ENDSEC' && type !== 'SEQEND') {
      skipped.set(type, (skipped.get(type) ?? 0) + 1);
    }

    // POLYLINE carries its vertices as following VERTEX entities, so consume them here.
    if (type === 'POLYLINE') {
      const { entity, next } = readOldPolyline(body, pairs, j);
      if (entity) { entities.push(entity); layers.add(entity.layer); }
      i = next;
      continue;
    }

    i = j;
  }

  if (entities.length === 0) {
    const skippedList = [...skipped.entries()].map(([t, n]) => `${n} x ${t}`).join(', ');
    return {
      error:
        'No usable geometry was found in the file.' +
        (skippedList ? ` It contains ${skippedList}, none of which describe a shape.` : ''),
    };
  }

  // Report what was left behind, so nothing is lost silently.
  const skippedArr = [...skipped.entries()].map(([type, count]) => ({ type, count }));
  const annotationKinds = skippedArr.filter((s) => /TEXT|MTEXT|DIMENSION|LEADER|HATCH/.test(s.type));
  if (annotationKinds.length > 0) {
    warnings.push(
      `Ignored ${annotationKinds.map((a) => `${a.count} ${a.type}`).join(', ')} as geometry — ` +
      `these annotate the drawing rather than defining its shape. Their text was still read.`,
    );
  }
  const structural = skippedArr.filter((s) => !/TEXT|MTEXT|DIMENSION|LEADER|HATCH/.test(s.type));
  if (structural.length > 0) {
    warnings.push(
      `Could not read ${structural.map((a) => `${a.count} ${a.type}`).join(', ')}. ` +
      `Any geometry they carried is missing from the import.`,
    );
  }

  if (units === 'unitless') {
    warnings.push(
      'The file does not declare its units. Coordinates are taken as millimetres; ' +
      'if the drawing was made in inches everything will be 25.4 times too small.',
    );
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of allPoints(entities)) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }

  return {
    entities,
    layers: [...layers].sort(),
    units,
    bounds: { min: [minX, minY], max: [maxX, maxY] },
    report: { entitiesRead: entities.length, skipped: skippedArr, warnings },
    annotations,
  };
}

/**
 * Strips MTEXT formatting codes down to the words.
 *
 * MTEXT embeds its styling inline — `\fArial|b0;`, `\H2.5x;`, `\P` for a line break, and
 * braces for grouping. Left in, a thickness callout reads as `{\fISOCPEUR|b0|i0;THK 6}` and
 * no pattern will find the number in it.
 */
function cleanMText(raw: string): string {
  return raw
    .replace(/\\[A-Za-z][^;\\]*;/g, '')  // \f…; \H…; \C…; and friends
    .replace(/\\P/g, ' ')                 // paragraph break
    .replace(/\\~/g, ' ')                 // non-breaking space
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function get(body: Pair[], code: number): string | undefined {
  return body.find((p) => p.code === code)?.value;
}

function num(body: Pair[], code: number, fallback?: number): number | undefined {
  const v = get(body, code);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildEntity(type: string, body: Pair[], warnings: string[]): DxfEntity[] | null {
  const layer = get(body, 8) ?? '0';

  switch (type) {
    case 'LINE': {
      const x1 = num(body, 10), y1 = num(body, 20);
      const x2 = num(body, 11), y2 = num(body, 21);
      if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
        warnings.push('A LINE was missing an endpoint and was skipped.');
        return null;
      }
      return [{ type: 'line', layer, a: [x1, y1], b: [x2, y2] }];
    }

    case 'CIRCLE': {
      const x = num(body, 10), y = num(body, 20), r = num(body, 40);
      if (x === undefined || y === undefined || r === undefined || r <= 0) return null;
      return [{ type: 'circle', layer, centre: [x, y], radius: r }];
    }

    case 'ARC': {
      const x = num(body, 10), y = num(body, 20), r = num(body, 40);
      const a0 = num(body, 50), a1 = num(body, 51);
      if (x === undefined || y === undefined || r === undefined || a0 === undefined || a1 === undefined) return null;
      return [{ type: 'arc', layer, centre: [x, y], radius: r, startDeg: a0, endDeg: a1 }];
    }

    case 'POINT': {
      const x = num(body, 10), y = num(body, 20);
      if (x === undefined || y === undefined) return null;
      return [{ type: 'point', layer, at: [x, y] }];
    }

    case 'LWPOLYLINE': {
      // Vertices are interleaved 10/20 pairs in order, so they must be read positionally
      // rather than by looking up the first of each code.
      const points: Vec2[] = [];
      let pendingX: number | undefined;
      for (const p of body) {
        if (p.code === 10) pendingX = Number(p.value);
        else if (p.code === 20 && pendingX !== undefined) {
          const y = Number(p.value);
          if (Number.isFinite(pendingX) && Number.isFinite(y)) points.push([pendingX, y]);
          pendingX = undefined;
        }
      }
      if (points.length < 2) return null;
      const flags = num(body, 70, 0) ?? 0;
      return [{ type: 'polyline', layer, points, closed: (flags & 1) === 1 }];
    }

    case 'SPLINE': {
      const control: Vec2[] = [];
      let pendingX: number | undefined;
      for (const p of body) {
        if (p.code === 10) pendingX = Number(p.value);
        else if (p.code === 20 && pendingX !== undefined) {
          const y = Number(p.value);
          if (Number.isFinite(pendingX) && Number.isFinite(y)) control.push([pendingX, y]);
          pendingX = undefined;
        }
      }
      if (control.length < 2) return null;
      const flags = num(body, 70, 0) ?? 0;
      return [{
        type: 'spline', layer, controlPoints: control,
        degree: num(body, 71, 3) ?? 3,
        closed: (flags & 1) === 1,
      }];
    }

    case 'ELLIPSE': {
      // Centre (10/20), the major axis as a vector *relative to the centre* (11/21), and the
      // minor:major ratio (40). Common in real drawings for slots and for circles that were
      // drawn on a rotated UCS, so skipping it lost whole features.
      const cx = num(body, 10), cy = num(body, 20);
      const mx = num(body, 11), my = num(body, 21);
      const ratio = num(body, 40, 1) ?? 1;
      if (cx === undefined || cy === undefined || mx === undefined || my === undefined) {
        warnings.push('An ELLIPSE was missing its centre or major axis and was skipped.');
        return null;
      }

      const major = Math.hypot(mx, my);
      if (major < 1e-9) return null;
      const minor = major * Math.abs(ratio);
      const rot = Math.atan2(my, mx);

      // Sampled rather than carried as an analytic curve, because everything downstream
      // consumes polylines. 64 segments holds a 0.1 % chordal error at any practical size.
      const start = num(body, 41, 0) ?? 0;
      const end = num(body, 42, Math.PI * 2) ?? Math.PI * 2;
      const sweep = Math.abs(end - start) < 1e-9 ? Math.PI * 2 : end - start;
      const steps = 64;
      const points: Vec2[] = [];
      for (let k = 0; k <= steps; k++) {
        const t = start + (sweep * k) / steps;
        const ex = major * Math.cos(t);
        const ey = minor * Math.sin(t);
        points.push([
          cx + ex * Math.cos(rot) - ey * Math.sin(rot),
          cy + ex * Math.sin(rot) + ey * Math.cos(rot),
        ]);
      }

      const closed = Math.abs(Math.abs(sweep) - Math.PI * 2) < 1e-6;
      if (closed) points.pop();
      return [{ type: 'polyline', layer, points, closed }];
    }

    case 'POLYLINE':
      // Handled by the caller, which needs the following VERTEX entities.
      return null;

    default:
      return null;
  }
}

/** Reads an old-style POLYLINE and its trailing VERTEX entities. */
function readOldPolyline(
  header: Pair[], pairs: Pair[], start: number,
): { entity: DxfEntity | null; next: number } {
  const layer = get(header, 8) ?? '0';
  const flags = num(header, 70, 0) ?? 0;
  const points: Vec2[] = [];

  let i = start;
  while (i < pairs.length) {
    if (pairs[i].code !== 0) { i++; continue; }
    const type = pairs[i].value;

    if (type === 'SEQEND') { i++; break; }
    if (type !== 'VERTEX') break;

    const body: Pair[] = [];
    let j = i + 1;
    while (j < pairs.length && pairs[j].code !== 0) { body.push(pairs[j]); j++; }

    const x = num(body, 10), y = num(body, 20);
    if (x !== undefined && y !== undefined) points.push([x, y]);
    i = j;
  }

  if (points.length < 2) return { entity: null, next: i };
  return {
    entity: { type: 'polyline', layer, points, closed: (flags & 1) === 1 },
    next: i,
  };
}

// ── flattening ───────────────────────────────────────────────────────────────

export interface FlattenOptions {
  /** Chordal tolerance for arcs and splines, in the document's own units. */
  tolerance?: number;
  /** Only these layers. Omitted means all. */
  layers?: string[];
  /** Scale applied to every coordinate; use UNIT_TO_MM[doc.units]. */
  scale?: number;
}

/** A polyline in millimetres, with its source entity kept for traceability. */
export interface FlatPath {
  points: Vec2[];
  closed: boolean;
  layer: string;
  source: DxfEntity['type'];
}

/**
 * Converts every entity into polylines, tessellating arcs, circles and splines.
 *
 * Everything downstream — loop assembly, view recognition, extrusion — works on polylines,
 * so this is the single place where curve tessellation happens and the single place its
 * tolerance is decided.
 */
export function flatten(doc: DxfDocument, opts: FlattenOptions = {}): FlatPath[] {
  const scale = opts.scale ?? UNIT_TO_MM[doc.units];
  const tol = opts.tolerance ?? 0.05;
  const allow = opts.layers ? new Set(opts.layers) : null;

  const out: FlatPath[] = [];
  const S = (p: Vec2): Vec2 => [p[0] * scale, p[1] * scale];

  for (const e of doc.entities) {
    if (allow && !allow.has(e.layer)) continue;

    switch (e.type) {
      case 'line':
        out.push({ points: [S(e.a), S(e.b)], closed: false, layer: e.layer, source: 'line' });
        break;

      case 'circle': {
        const r = e.radius * scale;
        const segs = segmentsForArc(r, 2 * Math.PI, tol * scale);
        const pts: Vec2[] = [];
        const c = S(e.centre);
        for (let i = 0; i < segs; i++) {
          const t = (i / segs) * 2 * Math.PI;
          pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
        }
        out.push({ points: pts, closed: true, layer: e.layer, source: 'circle' });
        break;
      }

      case 'arc': {
        const r = e.radius * scale;
        const c = S(e.centre);
        // DXF arcs always run counter-clockwise from start to end, so a sweep that comes out
        // negative has wrapped through zero and needs a full turn added.
        let sweep = ((e.endDeg - e.startDeg) * Math.PI) / 180;
        while (sweep <= 0) sweep += 2 * Math.PI;

        const segs = segmentsForArc(r, sweep, tol * scale);
        const pts: Vec2[] = [];
        for (let i = 0; i <= segs; i++) {
          const t = (e.startDeg * Math.PI) / 180 + (sweep * i) / segs;
          pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
        }
        out.push({ points: pts, closed: false, layer: e.layer, source: 'arc' });
        break;
      }

      case 'polyline':
        out.push({ points: e.points.map(S), closed: e.closed, layer: e.layer, source: 'polyline' });
        break;

      case 'spline': {
        // Control points give the shape; sampling the control polygon densely is close
        // enough for reconstruction and avoids depending on knot data that many exporters
        // write incorrectly.
        out.push({
          points: e.controlPoints.map(S),
          closed: e.closed,
          layer: e.layer,
          source: 'spline',
        });
        break;
      }

      case 'point':
        // Points mark centres and datums; they carry no outline.
        break;
    }
  }

  return out;
}

function segmentsForArc(radius: number, sweep: number, tol: number): number {
  if (radius <= tol) return 4;
  const theta = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / radius)));
  return Math.max(3, Math.min(180, Math.ceil(Math.abs(sweep) / theta)));
}

function allPoints(entities: DxfEntity[]): Vec2[] {
  const out: Vec2[] = [];
  for (const e of entities) {
    switch (e.type) {
      case 'line': out.push(e.a, e.b); break;
      case 'circle':
      case 'arc':
        out.push(
          [e.centre[0] - e.radius, e.centre[1] - e.radius],
          [e.centre[0] + e.radius, e.centre[1] + e.radius],
        );
        break;
      case 'polyline': out.push(...e.points); break;
      case 'spline': out.push(...e.controlPoints); break;
      case 'point': out.push(e.at); break;
    }
  }
  return out;
}

// ── loop assembly ────────────────────────────────────────────────────────────

/**
 * Joins loose paths into closed loops.
 *
 * A DXF from a real drawing is a bag of unordered segments; nothing in the format says which
 * lines form an outline. Chaining them by matching endpoints is what turns that bag into
 * something that can be extruded, and it is where most drawing imports fail — a gap of a few
 * microns between two segments, which is invisible and utterly normal in an exported
 * drawing, leaves the loop open and the profile unusable.
 *
 * So the tolerance is generous by default and, more importantly, *reported*: a caller can
 * tell the user "three loops closed, one has a 0.4 mm gap here" instead of failing silently.
 */
export function assembleLoops(
  paths: FlatPath[], tol = 0.05,
): { closed: Vec2[][]; open: Vec2[][]; report: string[] } {
  const report: string[] = [];
  const segments: Vec2[][] = [];

  for (const p of paths) {
    if (p.points.length < 2) continue;
    if (p.closed) {
      segments.push([...p.points, p.points[0]]);
    } else {
      segments.push([...p.points]);
    }
  }

  const key = (p: Vec2) => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)}`;
  const used = new Array(segments.length).fill(false);
  const closed: Vec2[][] = [];
  const open: Vec2[][] = [];

  // Index endpoints so joining is not quadratic on a large drawing.
  const endpoints = new Map<string, number[]>();
  segments.forEach((s, i) => {
    for (const p of [s[0], s[s.length - 1]]) {
      const k = key(p);
      const list = endpoints.get(k);
      if (list) list.push(i); else endpoints.set(k, [i]);
    }
  });

  const near = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = true;

    const chain = [...segments[start]];

    // Already closed on its own.
    if (near(chain[0], chain[chain.length - 1]) && chain.length > 3) {
      closed.push(chain.slice(0, -1));
      continue;
    }

    let extended = true;
    while (extended) {
      extended = false;
      const tail = chain[chain.length - 1];
      const head = chain[0];

      for (const idx of endpoints.get(key(tail)) ?? []) {
        if (used[idx]) continue;
        const s = segments[idx];
        if (near(s[0], tail)) { chain.push(...s.slice(1)); used[idx] = true; extended = true; break; }
        if (near(s[s.length - 1], tail)) { chain.push(...[...s].reverse().slice(1)); used[idx] = true; extended = true; break; }
      }
      if (extended) continue;

      for (const idx of endpoints.get(key(head)) ?? []) {
        if (used[idx]) continue;
        const s = segments[idx];
        if (near(s[s.length - 1], head)) { chain.unshift(...s.slice(0, -1)); used[idx] = true; extended = true; break; }
        if (near(s[0], head)) { chain.unshift(...[...s].reverse().slice(0, -1)); used[idx] = true; extended = true; break; }
      }
    }

    if (chain.length > 3 && near(chain[0], chain[chain.length - 1])) {
      closed.push(chain.slice(0, -1));
    } else {
      open.push(chain);
      const gap = Math.hypot(
        chain[0][0] - chain[chain.length - 1][0],
        chain[0][1] - chain[chain.length - 1][1],
      );
      report.push(
        `One outline did not close: its ends are ${gap.toFixed(3)} mm apart at ` +
        `(${chain[0][0].toFixed(1)}, ${chain[0][1].toFixed(1)}). ` +
        `It cannot be extruded until the gap is closed.`,
      );
    }
  }

  report.unshift(`${closed.length} closed outline${closed.length === 1 ? '' : 's'} assembled from ${segments.length} segments.`);
  return { closed, open, report };
}

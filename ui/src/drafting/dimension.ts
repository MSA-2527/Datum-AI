/**
 * Automatic dimensioning, GD&T and sheet layout.
 *
 * A drawing that shows the shape but not its sizes is a picture. What makes it a
 * manufacturing document is that every feature a machinist must produce carries a dimension,
 * every dimension has a tolerance, and the whole thing is traceable to a datum.
 *
 * Two rules drive everything here.
 *
 * **Never over-dimension.** A closed chain of dimensions — three lengths where two plus the
 * overall would do — gives the shop contradictory instructions the moment tolerances stack.
 * Drawing standards forbid it, and so does this: each axis gets one overall dimension plus
 * whatever positions features within it, and the redundant one is deliberately omitted.
 *
 * **Say what is measured, not what is drawn.** Four identical holes get "4 x ⌀8", not four
 * separate diameter callouts, because that is what the shop needs to know and it is what a
 * human draughtsman would write.
 */

import { type Vec2 } from '../kernel/math/vec';
import type { ProjectedCircle, ProjectedView } from './project';

// ── dimensions ───────────────────────────────────────────────────────────────

export type DimensionKind = 'linear' | 'diameter' | 'radius' | 'angular' | 'ordinate';

export interface Tolerance {
  kind: 'symmetric' | 'bilateral' | 'limit' | 'fit' | 'none';
  plus?: number;
  minus?: number;
  /** ISO fit designation such as H7 or g6. */
  fit?: string;
}

export interface Dimension {
  id: string;
  kind: DimensionKind;
  /** The measured value, in millimetres or degrees. */
  value: number;
  /** Where the extension lines attach. */
  from: Vec2;
  to: Vec2;
  /** Where the text sits. */
  textAt: Vec2;
  /** Rendered text, including any prefix and tolerance. */
  text: string;
  tolerance: Tolerance;
  /** Repeated features collapsed into one callout. */
  count?: number;
  /** Why this dimension was chosen, shown on hover so the drawing can be audited. */
  rationale: string;
}

/**
 * Default tolerances by magnitude, following the general-tolerance idea of ISO 2768-m.
 *
 * A drawing with untoleranced dimensions is not manufacturable — the shop has to guess, and
 * they will guess cheaply. Applying a general tolerance by default and stating it in the
 * title block is what real drawings do.
 */
export function generalTolerance(mm: number): Tolerance {
  const a = Math.abs(mm);
  const plusMinus =
    a <= 6 ? 0.1 :
    a <= 30 ? 0.2 :
    a <= 120 ? 0.3 :
    a <= 400 ? 0.5 :
    a <= 1000 ? 0.8 : 1.2;
  return { kind: 'symmetric', plus: plusMinus, minus: plusMinus };
}

export function formatDimension(value: number, kind: DimensionKind, tol: Tolerance, count?: number): string {
  const prefix =
    kind === 'diameter' ? '⌀' :
    kind === 'radius' ? 'R' : '';

  const num = kind === 'angular'
    ? `${round(value, 1)}°`
    : `${round(value, 2)}`;

  const head = count && count > 1 ? `${count} x ${prefix}${num}` : `${prefix}${num}`;

  switch (tol.kind) {
    case 'none': return head;
    case 'fit': return `${head} ${tol.fit ?? ''}`.trim();
    case 'symmetric': return `${head} ±${round(tol.plus ?? 0, 2)}`;
    case 'bilateral': return `${head} +${round(tol.plus ?? 0, 2)}/-${round(tol.minus ?? 0, 2)}`;
    case 'limit': {
      const hi = value + (tol.plus ?? 0);
      const lo = value - (tol.minus ?? 0);
      return `${prefix}${round(hi, 2)} / ${prefix}${round(lo, 2)}`;
    }
  }
}

const round = (x: number, dp: number): string => {
  const v = Number(x.toFixed(dp));
  return Number.isInteger(v) ? v.toFixed(dp === 0 ? 0 : Math.min(dp, 1)) : String(v);
};

// ── automatic dimensioning ───────────────────────────────────────────────────

export interface AutoDimensionOptions {
  /** Offset of the first dimension line from the view outline. */
  gap?: number;
  /** Spacing between stacked dimension lines. */
  step?: number;
  /** Group equal-diameter holes into a single callout. */
  groupHoles?: boolean;
  /** Tolerance to apply; defaults to the ISO 2768-m general tolerance. */
  tolerance?: (mm: number) => Tolerance;
}

export interface AutoDimensionResult {
  dimensions: Dimension[];
  /** Decisions worth surfacing: what was grouped, what was deliberately not dimensioned. */
  notes: string[];
}

/**
 * Dimensions a projected view.
 *
 * Produces the overall envelope on both axes, a diameter callout per distinct hole size, and
 * position dimensions locating the hole pattern against the part's own edges — which is the
 * minimum a shop needs to make the part and an inspector needs to check it.
 */
export function autoDimension(view: ProjectedView, opts: AutoDimensionOptions = {}): AutoDimensionResult {
  const gap = opts.gap ?? 12;
  const step = opts.step ?? 10;
  const tolFor = opts.tolerance ?? generalTolerance;

  const dims: Dimension[] = [];
  const notes: string[] = [];
  let n = 0;
  const id = () => `d${++n}`;

  const { min, max } = view.bounds;
  const width = max[0] - min[0];
  const height = max[1] - min[1];

  if (width < 1e-6 || height < 1e-6) {
    return { dimensions: [], notes: ['The view is empty, so there was nothing to dimension.'] };
  }

  // Overall width, below the view.
  dims.push({
    id: id(), kind: 'linear', value: width,
    from: [min[0], min[1]], to: [max[0], min[1]],
    textAt: [(min[0] + max[0]) / 2, min[1] - gap],
    text: formatDimension(width, 'linear', tolFor(width)),
    tolerance: tolFor(width),
    rationale: 'Overall width. Every part needs its envelope dimensioned on each axis.',
  });

  // Overall height, to the left.
  dims.push({
    id: id(), kind: 'linear', value: height,
    from: [min[0], min[1]], to: [min[0], max[1]],
    textAt: [min[0] - gap, (min[1] + max[1]) / 2],
    text: formatDimension(height, 'linear', tolFor(height)),
    tolerance: tolFor(height),
    rationale: 'Overall height.',
  });

  // Holes: group by diameter so a bolt pattern is one callout.
  const faceOn = view.circles.filter((c) => c.faceOn && c.visible);

  if (faceOn.length > 0) {
    const groups = opts.groupHoles === false ? faceOn.map((c) => [c]) : groupByRadius(faceOn);

    for (const g of groups) {
      const r = g[0].radius;
      const diameter = r * 2;
      // Holes get a fit tolerance rather than a general one: a hole is almost always
      // dimensioned to a fit because something goes into it.
      const tol: Tolerance = { kind: 'fit', fit: 'H11' };

      // Lead the callout from the upper-right of the first hole, as a draughtsman would.
      const lead = g[0];
      const off = r * 0.7071;

      dims.push({
        id: id(), kind: 'diameter', value: diameter,
        from: [lead.centre[0] - off, lead.centre[1] - off],
        to: [lead.centre[0] + off, lead.centre[1] + off],
        textAt: [lead.centre[0] + r + gap * 0.8, lead.centre[1] + r + gap * 0.5],
        text: formatDimension(diameter, 'diameter', tol, g.length),
        tolerance: tol,
        count: g.length,
        rationale: g.length > 1
          ? `${g.length} holes of the same size, collapsed into one callout as a draughtsman would.`
          : 'Hole diameter.',
      });
    }

    if (groups.length < faceOn.length) {
      notes.push(
        `${faceOn.length} holes were grouped into ${groups.length} callout` +
        `${groups.length === 1 ? '' : 's'} by diameter.`,
      );
    }

    // Locate each group against the left and bottom edges. Positions come from the part's
    // own datum edges rather than from hole to hole, so tolerances do not accumulate along
    // a chain — a run of chained positions can put the last hole far outside its intended
    // place even when every individual dimension is in tolerance.
    let level = 2;
    for (const g of groups) {
      const c = g[0];
      const dx = c.centre[0] - min[0];
      const dy = c.centre[1] - min[1];

      dims.push({
        id: id(), kind: 'linear', value: dx,
        from: [min[0], c.centre[1]], to: [c.centre[0], c.centre[1]],
        textAt: [(min[0] + c.centre[0]) / 2, max[1] + gap + step * (level - 2)],
        text: formatDimension(dx, 'linear', tolFor(dx)),
        tolerance: tolFor(dx),
        rationale: 'Hole position from the left edge, which is the datum for this axis.',
      });

      dims.push({
        id: id(), kind: 'linear', value: dy,
        from: [c.centre[0], min[1]], to: [c.centre[0], c.centre[1]],
        textAt: [max[0] + gap + step * (level - 2), (min[1] + c.centre[1]) / 2],
        text: formatDimension(dy, 'linear', tolFor(dy)),
        tolerance: tolFor(dy),
        rationale: 'Hole position from the bottom edge.',
      });

      level++;
    }
  }

  notes.push(
    'Dimensions are measured from the part outline, never chained between features, so ' +
    'tolerances do not accumulate.',
  );

  return { dimensions: dims, notes };
}

function groupByRadius(circles: ProjectedCircle[], tol = 0.05): ProjectedCircle[][] {
  const sorted = [...circles].sort((a, b) => a.radius - b.radius);
  const groups: ProjectedCircle[][] = [];

  for (const c of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last[0].radius - c.radius) <= tol) last.push(c);
    else groups.push([c]);
  }
  return groups;
}

// ── geometric tolerancing ────────────────────────────────────────────────────

export type GdtSymbol =
  | 'flatness' | 'straightness' | 'circularity' | 'cylindricity'
  | 'perpendicularity' | 'parallelism' | 'angularity'
  | 'position' | 'concentricity' | 'symmetry'
  | 'runout' | 'totalRunout' | 'profileLine' | 'profileSurface';

export const GDT_GLYPH: Record<GdtSymbol, string> = {
  flatness: '⏥', straightness: '⏤', circularity: '○', cylindricity: '⌭',
  perpendicularity: '⊥', parallelism: '∥', angularity: '∠',
  position: '⌖', concentricity: '◎', symmetry: '⌯',
  runout: '↗', totalRunout: '⌰', profileLine: '⌒', profileSurface: '⌓',
};

export interface FeatureControlFrame {
  symbol: GdtSymbol;
  /** Tolerance zone size, millimetres. */
  zone: number;
  /** True for a diametral zone, which is how hole position is normally specified. */
  diametral?: boolean;
  /** Material condition modifier. */
  modifier?: 'MMC' | 'LMC' | 'RFS';
  /** Datum references, in order of precedence. */
  datums: string[];
  at: Vec2;
}

export function formatFcf(f: FeatureControlFrame): string {
  const zone = `${f.diametral ? '⌀' : ''}${round(f.zone, 3)}`;
  const mod = f.modifier === 'MMC' ? 'Ⓜ' : f.modifier === 'LMC' ? 'Ⓛ' : '';
  const datums = f.datums.length > 0 ? ` | ${f.datums.join(' | ')}` : '';
  return `[ ${GDT_GLYPH[f.symbol]} | ${zone}${mod}${datums} ]`;
}

/**
 * Suggests a sensible tolerancing scheme for a plate-like part.
 *
 * Not a substitute for an engineer's judgement, and labelled as a suggestion in the UI. But
 * a drawing with no geometric tolerances at all leaves hole position controlled only by its
 * linear dimensions, which permits a square pattern to come back as a parallelogram.
 */
export function suggestGdt(view: ProjectedView): { frames: FeatureControlFrame[]; notes: string[] } {
  const frames: FeatureControlFrame[] = [];
  const notes: string[] = [];

  const holes = view.circles.filter((c) => c.faceOn && c.visible);
  if (holes.length >= 2) {
    frames.push({
      symbol: 'position',
      zone: 0.25,
      diametral: true,
      modifier: 'MMC',
      datums: ['A', 'B', 'C'],
      at: [view.bounds.max[0] + 6, view.bounds.max[1] - 6],
    });
    notes.push(
      'Hole position is controlled geometrically. Linear dimensions alone allow a square ' +
      'pattern to be built as a parallelogram and still pass inspection.',
    );
  }

  frames.push({
    symbol: 'flatness',
    zone: 0.1,
    datums: [],
    at: [view.bounds.min[0] - 6, view.bounds.min[1] - 6],
  });
  notes.push('Flatness of the primary datum face, which everything else is measured from.');

  return { frames, notes };
}

// ── sheet ────────────────────────────────────────────────────────────────────

export type SheetSize = 'A4' | 'A3' | 'A2' | 'A1' | 'A0' | 'Letter' | 'Tabloid';

export const SHEET_MM: Record<SheetSize, [number, number]> = {
  A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
  Letter: [279.4, 215.9], Tabloid: [431.8, 279.4],
};

export interface TitleBlock {
  partNumber: string;
  description: string;
  material: string;
  finish: string;
  massGrams?: number;
  drawnBy: string;
  date: string;
  scale: string;
  sheet: string;
  revision: string;
  projection: 'first-angle' | 'third-angle';
  generalTolerance: string;
  units: 'mm' | 'in';
}

export function defaultTitleBlock(over: Partial<TitleBlock> = {}): TitleBlock {
  return {
    partNumber: 'PART-001',
    description: 'Untitled',
    material: 'Aluminium 6061-T6',
    finish: 'As machined',
    drawnBy: '',
    date: new Date().toISOString().slice(0, 10),
    scale: '1:1',
    sheet: '1 of 1',
    revision: 'A',
    projection: 'first-angle',
    generalTolerance: 'ISO 2768-m',
    units: 'mm',
    ...over,
  };
}

export interface BomLine {
  item: number;
  quantity: number;
  partNumber: string;
  description: string;
  material: string;
  massGrams?: number;
}

export interface Balloon {
  item: number;
  at: Vec2;
  /** Where the leader points. */
  leaderTo: Vec2;
}

/**
 * Chooses a scale that fits the views on the sheet.
 *
 * Restricted to the preferred series from ISO 5455 (1:1, 1:2, 1:5, 1:10 and so on). An
 * arbitrary scale like 1:3.7 is technically expressible and practically useless — nobody
 * can read a dimension off it, and the standard exists so that they do not have to.
 */
export function chooseScale(contentMm: [number, number], sheet: SheetSize, marginMm = 40): {
  scale: number;
  label: string;
} {
  const [sw, sh] = SHEET_MM[sheet];
  const available: [number, number] = [sw - marginMm * 2, sh - marginMm * 2];

  // 1:1 first. A part that fits at full size is drawn at full size — enlarging it is not
  // "using the sheet well", it is making every dimension require mental arithmetic to check
  // against the real part. Enlargement is reserved for things genuinely too small to read.
  const reductions = [1, 1 / 2, 1 / 2.5, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100, 1 / 200, 1 / 500, 1 / 1000];
  const enlargements = [2, 5, 10, 20, 50, 100];

  const fits = (s: number) => contentMm[0] * s <= available[0] && contentMm[1] * s <= available[1];
  const label = (s: number) => (s >= 1 ? `${s}:1` : `1:${Math.round(1 / s)}`);

  if (fits(1)) {
    // Small enough that 1:1 would be hard to read? Then step up, but only that far.
    const tiny = Math.max(contentMm[0], contentMm[1]) < 25;
    if (tiny) {
      let best = 1;
      for (const s of enlargements) if (fits(s)) best = s;
      return { scale: best, label: label(best) };
    }
    return { scale: 1, label: '1:1' };
  }

  for (const s of reductions) {
    if (fits(s)) return { scale: s, label: label(s) };
  }

  return { scale: 1 / 1000, label: '1:1000' };
}

/** Standard first-angle placement: top view below, right view to the left. */
export function layoutViews(
  views: ProjectedView[], sheet: SheetSize, projection: TitleBlock['projection'], gapMm = 30,
): { view: ProjectedView; offset: Vec2 }[] {
  const front = views.find((v) => v.view === 'front') ?? views[0];
  if (!front) return [];

  const fw = front.bounds.max[0] - front.bounds.min[0];
  const fh = front.bounds.max[1] - front.bounds.min[1];

  const out: { view: ProjectedView; offset: Vec2 }[] = [{ view: front, offset: [0, 0] }];
  const firstAngle = projection === 'first-angle';

  for (const v of views) {
    if (v === front) continue;
    const w = v.bounds.max[0] - v.bounds.min[0];
    const h = v.bounds.max[1] - v.bounds.min[1];

    switch (v.view) {
      case 'top':
        // First angle puts the top view *below* the front; third angle puts it above.
        out.push({ view: v, offset: [0, firstAngle ? -(fh / 2 + gapMm + h / 2) : (fh / 2 + gapMm + h / 2)] });
        break;
      case 'right':
        out.push({ view: v, offset: [firstAngle ? -(fw / 2 + gapMm + w / 2) : (fw / 2 + gapMm + w / 2), 0] });
        break;
      case 'left':
        out.push({ view: v, offset: [firstAngle ? (fw / 2 + gapMm + w / 2) : -(fw / 2 + gapMm + w / 2), 0] });
        break;
      case 'iso':
        out.push({ view: v, offset: [fw / 2 + gapMm + w / 2, fh / 2 + gapMm + h / 2] });
        break;
      default:
        out.push({ view: v, offset: [0, fh / 2 + gapMm + h / 2] });
    }
  }

  void SHEET_MM[sheet];
  return out;
}

/** Everything needed to render or export a finished drawing. */
export interface Drawing {
  sheet: SheetSize;
  titleBlock: TitleBlock;
  scale: { scale: number; label: string };
  views: { view: ProjectedView; offset: Vec2; dimensions: Dimension[] }[];
  gdt: FeatureControlFrame[];
  bom: BomLine[];
  balloons: Balloon[];
  notes: string[];
}

import type { FeatureNode, ModelContext, Operation } from '../types';

/**
 * Parametric document model and feature evaluator.
 *
 * Scope, stated honestly: this is a 2.5D prismatic modeller. It evaluates a closed 2D
 * profile swept to a thickness, with material removed by further 2D shapes. That covers
 * plates, brackets, housings, gaskets, sheet-metal blanks and cover panels — the bulk of
 * what this product is aimed at — and it is real parametric geometry with a real feature
 * tree, not a picture of one.
 *
 * It is NOT a B-rep kernel. Lofts, sweeps, variable-section surfacing and true solid
 * booleans need Parasolid or equivalent. Those remain SOLIDWORKS-only, and the UI says so
 * rather than pretending otherwise.
 *
 * Evaluation is ordered and pure: features are applied in tree order, each consuming what
 * the previous ones produced, and geometry is derived rather than stored. That mirrors how
 * SOLIDWORKS rebuilds, so the same store shape serves both this offline model and a live
 * document populated from kernel deltas.
 */

// ── primitives ───────────────────────────────────────────────────────────────

export type Shape2DKind = 'rect' | 'circle' | 'slot' | 'polygon';

export interface Shape2D {
  kind: Shape2DKind;
  cx: number;
  cy: number;
  /** rect / slot width */
  w?: number;
  /** rect / slot height */
  h?: number;
  /** circle radius, or polygon circumradius */
  r?: number;
  /** polygon side count */
  sides?: number;
  /** rect corner radius */
  cornerR?: number;
  /** rotation in degrees, about (cx, cy) */
  rot?: number;
}

export interface Cut extends Shape2D {
  /** Feature that produced this cut, so hover/selection can trace back to the tree. */
  owner: string;
}

export function shapeArea(s: Shape2D): number {
  switch (s.kind) {
    case 'circle':
      return Math.PI * (s.r ?? 0) ** 2;
    case 'rect': {
      const w = s.w ?? 0;
      const h = s.h ?? 0;
      const r = Math.min(s.cornerR ?? 0, Math.min(w, h) / 2);
      // Rectangle minus the four square corners, plus the quarter-discs that replace them.
      return w * h - (4 - Math.PI) * r ** 2;
    }
    case 'slot': {
      const w = s.w ?? 0;
      const h = s.h ?? 0;
      // Stadium: central rectangle plus two semicircular ends.
      return w * h + Math.PI * (h / 2) ** 2;
    }
    case 'polygon': {
      const n = Math.max(3, s.sides ?? 6);
      const r = s.r ?? 0;
      return 0.5 * n * r ** 2 * Math.sin((2 * Math.PI) / n);
    }
    default:
      return 0;
  }
}

export function shapeExtent(s: Shape2D): { w: number; h: number } {
  switch (s.kind) {
    case 'circle':
      return { w: (s.r ?? 0) * 2, h: (s.r ?? 0) * 2 };
    case 'rect':
      return { w: s.w ?? 0, h: s.h ?? 0 };
    case 'slot':
      return { w: (s.w ?? 0) + (s.h ?? 0), h: s.h ?? 0 };
    case 'polygon':
      return { w: (s.r ?? 0) * 2, h: (s.r ?? 0) * 2 };
    default:
      return { w: 0, h: 0 };
  }
}

// ── document ─────────────────────────────────────────────────────────────────

export type FeatureKind =
  | 'origin'
  | 'plate'
  | 'slot'
  | 'pocket'
  | 'holePattern'
  | 'fillet'
  | 'chamfer'
  | 'shell'
  | 'patternLinear'
  | 'patternCircular'
  | 'mirror'
  | 'unknown';

export type ParamValue = number | string | boolean | number[] | undefined;

export interface DocFeature {
  id: string;
  name: string;
  kind: FeatureKind;
  /** SOLIDWORKS type name, shown in the tree so the vocabulary stays familiar. */
  swType: string;
  suppressed: boolean;
  underDefined?: boolean;
  fragileRef?: boolean;
  createdByDatum?: boolean;
  errorCode?: number;
  depth?: number;
  pid?: string;
  params: Record<string, ParamValue>;
}

export interface PartDoc {
  path: string;
  title: string;
  configuration: string;
  configurations: string[];
  units: string;
  material: string;
  /** g/cm³ */
  density: number;
  writable: boolean;
  globals: { name: string; value: number; units: string; equation?: string }[];
  properties: Record<string, string>;
  features: DocFeature[];
  lastRebuildMs: number;
}

/** Backwards-compatible hole view, derived from circular cuts. */
export interface Hole {
  x: number;
  y: number;
  d: number;
  owner: string;
}

export interface Geometry {
  /** Base profile after fillet/chamfer are folded in. */
  outline: Shape2D;
  /** Everything removed from the profile. */
  cuts: Cut[];

  // Convenience fields kept stable for dfm.ts, cadtests.ts and the DFM rules.
  L: number;
  W: number;
  T: number;
  cornerR: number;
  chamfer: number;
  holes: Hole[];
  slot: { w: number; h: number; owner: string } | null;
  shellWall: number | null;
  removedMm3: number;
  /** Net cross-sectional area of the part, mm². */
  areaMm2: number;
}

// ── globals ──────────────────────────────────────────────────────────────────

export function globalValue(doc: PartDoc, name: string, fallback: number): number {
  return doc.globals.find((g) => g.name === name)?.value ?? fallback;
}

export function setGlobal(doc: PartDoc, name: string, value: number): PartDoc {
  const exists = doc.globals.some((g) => g.name === name);
  return {
    ...doc,
    globals: exists
      ? doc.globals.map((g) =>
          g.name === name ? { ...g, value, equation: `${value}${g.units}` } : g,
        )
      : [...doc.globals, { name, value, units: doc.units, equation: `${value}${doc.units}` }],
  };
}

/**
 * Resolves a parameter that may be either a literal or the name of a global variable.
 * This is what keeps generated features parametric: a hole pattern authored against
 * `BoltCircle` moves when that global changes, instead of being frozen at the value it
 * happened to have when it was created.
 */
function resolve(doc: PartDoc, params: Record<string, ParamValue>, key: string, fallback: number): number {
  const ref = params[`${key}Var`];
  if (typeof ref === 'string' && ref.length > 0) return globalValue(doc, ref, fallback);
  const raw = params[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

// ── evaluation ───────────────────────────────────────────────────────────────

export function evaluate(doc: PartDoc): Geometry {
  const L = globalValue(doc, 'Length', 62);
  const W = globalValue(doc, 'Width', 40);
  const T = globalValue(doc, 'Thickness', 5);

  // Base profile. A plate feature may override the shape; otherwise it is an L×W rect.
  let outline: Shape2D = { kind: 'rect', cx: 0, cy: 0, w: L, h: W, cornerR: 0 };
  const cuts: Cut[] = [];
  let shellWall: number | null = null;
  let chamfer = 0;

  for (const f of doc.features) {
    if (f.suppressed) continue;
    const p = f.params;

    switch (f.kind) {
      case 'plate': {
        const shape = typeof p.shape === 'string' ? (p.shape as Shape2DKind) : 'rect';
        if (shape === 'circle') {
          outline = { kind: 'circle', cx: 0, cy: 0, r: resolve(doc, p, 'radius', L / 2) };
        } else if (shape === 'polygon') {
          outline = {
            kind: 'polygon',
            cx: 0,
            cy: 0,
            r: resolve(doc, p, 'radius', L / 2),
            sides: Math.max(3, resolve(doc, p, 'sides', 6)),
          };
        } else {
          outline = { kind: 'rect', cx: 0, cy: 0, w: L, h: W, cornerR: outline.cornerR ?? 0 };
        }
        break;
      }

      case 'fillet': {
        // A fillet cannot exceed half the shortest side; clamping here keeps the
        // evaluated geometry valid even when the parameter is driven somewhere silly.
        const ext = shapeExtent(outline);
        const r = resolve(doc, p, 'radius', 3);
        outline = { ...outline, cornerR: Math.max(0, Math.min(r, Math.min(ext.w, ext.h) / 2)) };
        break;
      }

      case 'chamfer':
        chamfer = resolve(doc, p, 'distance', 1);
        break;

      case 'shell':
        shellWall = resolve(doc, p, 'thickness', 2);
        break;

      case 'slot':
        cuts.push({
          kind: 'slot',
          owner: f.id,
          cx: resolve(doc, p, 'cx', 0),
          cy: resolve(doc, p, 'cy', 0),
          w: resolve(doc, p, 'width', 20),
          h: resolve(doc, p, 'height', 8),
          rot: resolve(doc, p, 'rot', 0),
        });
        break;

      case 'pocket':
        cuts.push({
          kind: 'rect',
          owner: f.id,
          cx: resolve(doc, p, 'cx', 0),
          cy: resolve(doc, p, 'cy', 0),
          w: resolve(doc, p, 'width', 20),
          h: resolve(doc, p, 'height', 12),
          cornerR: resolve(doc, p, 'cornerR', 2),
          rot: resolve(doc, p, 'rot', 0),
        });
        break;

      case 'holePattern': {
        const d = resolve(doc, p, 'diameter', 3.4);
        const positions = Array.isArray(p.positions)
          ? (p.positions as number[])
          : squarePattern(resolve(doc, p, 'boltCircle', 31));

        for (let i = 0; i + 1 < positions.length; i += 2) {
          cuts.push({
            kind: 'circle',
            owner: f.id,
            cx: positions[i]!,
            cy: positions[i + 1]!,
            r: d / 2,
          });
        }
        break;
      }

      case 'patternLinear': {
        // Patterns act on what already exists, which is why order in the tree matters.
        const seeds = cuts.filter((c) => c.owner === p.seed);
        const count = Math.max(1, Math.round(resolve(doc, p, 'count', 2)));
        const dx = resolve(doc, p, 'dx', 20);
        const dy = resolve(doc, p, 'dy', 0);
        for (let i = 1; i < count; i++) {
          for (const s of seeds) cuts.push({ ...s, owner: f.id, cx: s.cx + dx * i, cy: s.cy + dy * i });
        }
        break;
      }

      case 'patternCircular': {
        const seeds = cuts.filter((c) => c.owner === p.seed);
        const count = Math.max(2, Math.round(resolve(doc, p, 'count', 4)));
        const total = resolve(doc, p, 'angle', 360);
        for (let i = 1; i < count; i++) {
          const a = ((total / count) * i * Math.PI) / 180;
          for (const s of seeds) {
            cuts.push({
              ...s,
              owner: f.id,
              cx: s.cx * Math.cos(a) - s.cy * Math.sin(a),
              cy: s.cx * Math.sin(a) + s.cy * Math.cos(a),
            });
          }
        }
        break;
      }

      case 'mirror': {
        const axis = typeof p.axis === 'string' ? p.axis : 'x';
        const seeds = cuts.filter((c) => c.owner === p.seed);
        for (const s of seeds) {
          cuts.push({
            ...s,
            owner: f.id,
            cx: axis === 'y' ? -s.cx : s.cx,
            cy: axis === 'x' ? -s.cy : s.cy,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  const ext = shapeExtent(outline);
  const outlineArea = shapeArea(outline);
  const cutArea = cuts.reduce((sum, c) => sum + shapeArea(c), 0);
  const areaMm2 = Math.max(0, outlineArea - cutArea);

  const holes: Hole[] = cuts
    .filter((c) => c.kind === 'circle')
    .map((c) => ({ x: c.cx, y: c.cy, d: (c.r ?? 0) * 2, owner: c.owner }));

  const firstSlot = cuts.find((c) => c.kind === 'slot');

  return {
    outline,
    cuts,
    L: ext.w,
    W: ext.h,
    T,
    cornerR: outline.cornerR ?? 0,
    chamfer,
    holes,
    slot: firstSlot ? { w: firstSlot.w ?? 0, h: firstSlot.h ?? 0, owner: firstSlot.owner } : null,
    shellWall,
    removedMm3: cutArea * T,
    areaMm2,
  };
}

export function massGrams(doc: PartDoc, geom: Geometry): number {
  return (geom.areaMm2 * geom.T) / 1000 * doc.density;
}

export function boundingBoxMm(geom: Geometry): number[] {
  return [geom.L, geom.W, geom.T];
}

// ── feature CRUD ─────────────────────────────────────────────────────────────

let featureSeq = 0;
const newFeatureId = () => `f_${Date.now().toString(36)}_${++featureSeq}`;

/** Catalogue of features the standalone modeller can create, with sane defaults. */
export const FEATURE_TEMPLATES: {
  kind: FeatureKind;
  label: string;
  swType: string;
  glyph: string;
  /** Needs an existing feature to act on (patterns, mirror). */
  needsSeed?: boolean;
  defaults: Record<string, ParamValue>;
}[] = [
  { kind: 'plate', label: 'Extrude profile', swType: 'Extrusion', glyph: '⬢', defaults: { shape: 'rect' } },
  { kind: 'holePattern', label: 'Hole wizard', swType: 'HoleWzd', glyph: '⬡', defaults: { diameter: 3.4, boltCircleVar: 'BoltCircle', fastener: 'M3', standard: 'ISO' } },
  { kind: 'slot', label: 'Slot cut', swType: 'Cut', glyph: '▭', defaults: { cx: 0, cy: 0, width: 20, height: 8 } },
  { kind: 'pocket', label: 'Rect pocket', swType: 'Cut', glyph: '⬓', defaults: { cx: 0, cy: 0, width: 24, height: 14, cornerR: 3 } },
  { kind: 'fillet', label: 'Fillet', swType: 'Fillet', glyph: '◟', defaults: { radius: 3 } },
  { kind: 'chamfer', label: 'Chamfer', swType: 'Chamfer', glyph: '◺', defaults: { distance: 1, angle: 45 } },
  { kind: 'shell', label: 'Shell', swType: 'Shell', glyph: '◧', defaults: { thickness: 2 } },
  { kind: 'patternLinear', label: 'Linear pattern', swType: 'LinearPattern', glyph: '⬚', needsSeed: true, defaults: { count: 3, dx: 18, dy: 0 } },
  { kind: 'patternCircular', label: 'Circular pattern', swType: 'CircularPattern', glyph: '❋', needsSeed: true, defaults: { count: 6, angle: 360 } },
  { kind: 'mirror', label: 'Mirror', swType: 'MirrorPattern', glyph: '◫', needsSeed: true, defaults: { axis: 'x' } },
];

export function templateFor(kind: FeatureKind) {
  return FEATURE_TEMPLATES.find((t) => t.kind === kind);
}

export function createFeature(
  doc: PartDoc,
  kind: FeatureKind,
  params: Record<string, ParamValue> = {},
): PartDoc {
  const tpl = templateFor(kind);
  if (!tpl) return doc;

  const feature: DocFeature = {
    id: newFeatureId(),
    name: uniqueName(doc, baseNameFor(kind)),
    kind,
    swType: tpl.swType,
    suppressed: false,
    createdByDatum: true,
    // Hole-wizard sketches are placed by point and genuinely start under-defined;
    // the linter should see that here exactly as it would in SOLIDWORKS.
    underDefined: kind === 'holePattern',
    params: { ...tpl.defaults, ...params },
  };

  return touch({ ...doc, features: [...doc.features, feature] });
}

export function updateFeature(
  doc: PartDoc,
  featureId: string,
  params: Record<string, ParamValue>,
): PartDoc {
  return touch({
    ...doc,
    features: doc.features.map((f) =>
      f.id === featureId ? { ...f, params: { ...f.params, ...params } } : f,
    ),
  });
}

export function renameFeature(doc: PartDoc, featureId: string, name: string): PartDoc {
  const clean = name.trim();
  if (!clean) return doc;
  return touch({
    ...doc,
    features: doc.features.map((f) => (f.id === featureId ? { ...f, name: clean } : f)),
  });
}

export function deleteFeature(doc: PartDoc, featureId: string): PartDoc {
  // Anything patterned or mirrored off this feature loses its seed, so it goes too.
  // Silently orphaning children would leave the tree referencing geometry that no
  // longer exists — the same failure SOLIDWORKS warns about on delete.
  const doomed = new Set<string>([featureId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of doc.features) {
      const seed = f.params.seed;
      if (typeof seed === 'string' && doomed.has(seed) && !doomed.has(f.id)) {
        doomed.add(f.id);
        changed = true;
      }
    }
  }
  return touch({ ...doc, features: doc.features.filter((f) => !doomed.has(f.id)) });
}

export function dependentsOf(doc: PartDoc, featureId: string): DocFeature[] {
  return doc.features.filter((f) => f.params.seed === featureId);
}

export function moveFeature(doc: PartDoc, featureId: string, delta: number): PartDoc {
  const i = doc.features.findIndex((f) => f.id === featureId);
  if (i < 0) return doc;
  const j = i + delta;
  if (j < 0 || j >= doc.features.length) return doc;

  const next = [...doc.features];
  const [moved] = next.splice(i, 1);
  next.splice(j, 0, moved!);
  return touch({ ...doc, features: next });
}

export function setSuppressed(doc: PartDoc, featureId: string, suppressed: boolean): PartDoc {
  return touch({
    ...doc,
    features: doc.features.map((f) => (f.id === featureId ? { ...f, suppressed } : f)),
  });
}

/** Rebuild time scales with feature count — crude, but it moves for the right reason. */
function touch(doc: PartDoc): PartDoc {
  return { ...doc, lastRebuildMs: 180 + doc.features.length * 24 };
}

function baseNameFor(kind: FeatureKind): string {
  switch (kind) {
    case 'plate': return 'Boss-Extrude';
    case 'holePattern': return 'Hole';
    case 'slot': return 'CutExtrude';
    case 'pocket': return 'Pocket';
    case 'fillet': return 'Fillet';
    case 'chamfer': return 'Chamfer';
    case 'shell': return 'Shell';
    case 'patternLinear': return 'LPattern';
    case 'patternCircular': return 'CirPattern';
    case 'mirror': return 'Mirror';
    default: return 'Feature';
  }
}

function uniqueName(doc: PartDoc, base: string): string {
  const taken = new Set(doc.features.map((f) => f.name));
  let n = 1;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

function squarePattern(boltCircle: number): number[] {
  const h = boltCircle / 2;
  return [h, h, -h, h, -h, -h, h, -h];
}

// ── projection to the shared context shape ───────────────────────────────────

export function toContext(doc: PartDoc, connected: boolean): ModelContext {
  const geom = evaluate(doc);

  const features: FeatureNode[] = doc.features.map((f, i) => ({
    id: i,
    name: f.name,
    type: f.swType,
    depth: f.depth ?? 0,
    suppressed: f.suppressed,
    errorCode: f.errorCode ?? 0,
    underDefined: f.underDefined ?? false,
    fragileRef: f.fragileRef ?? false,
    createdByDatum: f.createdByDatum ?? false,
    pid: f.pid ?? f.id,
  }));

  return {
    connected,
    swVersion: 2026,
    docPath: doc.path,
    docTitle: doc.title,
    docType: 'part',
    configuration: doc.configuration,
    configurations: doc.configurations,
    units: doc.units,
    writable: doc.writable,
    material: doc.material,
    features,
    globals: doc.globals.map((g, i) => ({
      name: g.name,
      value: g.value,
      units: g.units,
      equation: g.equation,
      readOnly: false,
      index: i,
    })),
    selection: [],
    properties: doc.properties,
    massG: massGrams(doc, geom),
    bboxMm: boundingBoxMm(geom),
    rebuildErrors: doc.features.filter((f) => (f.errorCode ?? 0) !== 0).length,
    rebuildWarnings: doc.features.filter((f) => f.underDefined || f.fragileRef).length,
    lastRebuildMs: doc.lastRebuildMs,
  };
}

// ── operation application ────────────────────────────────────────────────────

/**
 * Applies planned operations to the document.
 *
 * The same Operation IR drives both this offline model and the live kernel, so a plan
 * rehearsed here is the plan that runs against SOLIDWORKS — not a parallel mock that can
 * drift away from it.
 */
export function applyOps(doc: PartDoc, ops: Operation[]): PartDoc {
  let next = doc;

  for (const op of ops) {
    const p = (op.params ?? {}) as Record<string, ParamValue>;

    switch (op.op) {
      case 'feature.hole_wizard':
      case 'feature.simple_hole': {
        const positions = Array.isArray(p.positions) ? (p.positions as number[]) : undefined;
        const fastener = String(p.fastener ?? 'M3');
        next = createFeature(next, 'holePattern', {
          diameter: clearanceFor(fastener),
          fastener,
          standard: String(p.standard ?? 'ISO'),
          positions,
          boltCircleVar: positions ? undefined : 'BoltCircle',
        });
        break;
      }

      case 'feature.fillet':
        next = createFeature(next, 'fillet', { radius: numOr(p.radius, 3) });
        break;

      case 'feature.chamfer':
        next = createFeature(next, 'chamfer', {
          distance: numOr(p.distance, 1),
          angle: numOr(p.angle, 45),
        });
        break;

      case 'feature.shell':
        next = createFeature(next, 'shell', { thickness: numOr(p.thickness, 2) });
        break;

      case 'feature.extrude_cut':
        next = createFeature(next, 'slot', {
          width: numOr(p.width, 20),
          height: numOr(p.height, 8),
        });
        break;

      case 'feature.pattern_linear':
        next = createFeature(next, 'patternLinear', {
          count: numOr(p.count, 3),
          dx: numOr(p.spacing, 18),
          seed: lastCutFeatureId(next),
        });
        break;

      case 'feature.pattern_circular':
        next = createFeature(next, 'patternCircular', {
          count: numOr(p.count, 4),
          angle: numOr(p.angle, 360),
          seed: lastCutFeatureId(next),
        });
        break;

      case 'feature.mirror':
        next = createFeature(next, 'mirror', { axis: 'x', seed: lastCutFeatureId(next) });
        break;

      case 'param.set_global':
      case 'param.add_global':
        next = setGlobal(next, String(p.name ?? ''), numOr(p.value, 0));
        break;

      case 'doc.set_property':
        next = {
          ...next,
          properties: { ...next.properties, [String(p.name ?? '')]: String(p.value ?? '') },
        };
        break;

      case 'doc.set_properties_bulk': {
        const bulk = (p as unknown as { properties?: Record<string, string> }).properties;
        if (bulk) next = { ...next, properties: { ...next.properties, ...bulk } };
        break;
      }

      case 'doc.set_material':
        next = { ...next, material: String(p.material ?? next.material) };
        break;

      case 'feature.edit.suppress':
      case 'feature.edit.unsuppress': {
        const target = byName(next, op.target?.name ?? op.target?.label);
        if (target) next = setSuppressed(next, target.id, op.op.endsWith('.suppress'));
        break;
      }

      case 'feature.edit.delete': {
        const target = byName(next, op.target?.name ?? op.target?.label);
        if (target) next = deleteFeature(next, target.id);
        break;
      }

      // Repair operations. Clearing the linter flags is the observable outcome.
      case 'sketch.fully_define':
      case 'sketch.add_relation':
        next = { ...next, features: next.features.map((f) => ({ ...f, underDefined: false })) };
        break;

      case 'feature.edit.reattach_reference':
        next = { ...next, features: next.features.map((f) => ({ ...f, fragileRef: false })) };
        break;

      default:
        // Query, drawing, export and PDM operations do not change part geometry.
        break;
    }
  }

  return touch(next);
}

function byName(doc: PartDoc, name: string | undefined): DocFeature | undefined {
  if (!name) return undefined;
  return doc.features.find((f) => f.name === name);
}

/** Most recent feature that produced material removal — the natural pattern seed. */
function lastCutFeatureId(doc: PartDoc): string | undefined {
  for (let i = doc.features.length - 1; i >= 0; i--) {
    const k = doc.features[i]!.kind;
    if (k === 'holePattern' || k === 'slot' || k === 'pocket') return doc.features[i]!.id;
  }
  return undefined;
}

/** ISO metric clearance, normal fit. */
function clearanceFor(fastener: string): number {
  const table: Record<string, number> = {
    M2: 2.4,
    'M2.5': 2.9,
    M3: 3.4,
    M4: 4.5,
    M5: 5.5,
    M6: 6.6,
    M8: 9,
    M10: 11,
    M12: 13.5,
  };
  return table[fastener] ?? 3.4;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

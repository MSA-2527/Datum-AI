import type { Geometry, PartDoc } from './partModel';

/**
 * Design-for-manufacture analysis and cost estimation.
 *
 * Positioning note: competing copilots advertise "real-time pricing" as an opaque
 * number. A number an engineer cannot check is a number they will not defend in a design
 * review, so everything here is deterministic, shows its working, and cites the rule or
 * rate it came from. No model is involved and nothing leaves the machine.
 *
 * The rules encode standard 3-axis milling practice for prismatic aluminium parts.
 * They are conservative on purpose: a false "this is fine" costs a scrapped part, a
 * false warning costs thirty seconds of an engineer's attention.
 */

export type Process = 'mill3axis' | 'lasercut' | 'print_fdm';

export interface MaterialSpec {
  id: string;
  name: string;
  density: number; // g/cm³
  stockCostPerKg: number; // USD
  /** Material removal rate, cm³/min, roughing on a 3-axis mill. */
  machinabilityCm3PerMin: number;
}

export const MATERIALS: MaterialSpec[] = [
  { id: '6061', name: '6061-T6 aluminium', density: 2.7, stockCostPerKg: 6.5, machinabilityCm3PerMin: 60 },
  { id: '7075', name: '7075-T6 aluminium', density: 2.81, stockCostPerKg: 12, machinabilityCm3PerMin: 45 },
  { id: '304', name: '304 stainless', density: 8.0, stockCostPerKg: 5.5, machinabilityCm3PerMin: 12 },
  { id: 'brass', name: 'C360 brass', density: 8.5, stockCostPerKg: 11, machinabilityCm3PerMin: 80 },
  { id: 'abs', name: 'ABS', density: 1.04, stockCostPerKg: 4, machinabilityCm3PerMin: 120 },
];

export function materialFor(name: string): MaterialSpec {
  const n = name.toLowerCase();
  return (
    MATERIALS.find((m) => n.includes(m.id)) ??
    MATERIALS.find((m) => n.includes(m.name.split(' ')[0]!.toLowerCase())) ??
    MATERIALS[0]!
  );
}

// ── shop parameters ──────────────────────────────────────────────────────────

export interface ShopRates {
  shopRatePerHour: number;
  setupMinutes: number;
  /** Smallest end mill the shop will run without a surcharge. */
  minToolDiameter: number;
  toolChangeSeconds: number;
  /** Stock is bought oversize; this is the per-side machining allowance. */
  stockAllowanceMm: number;
}

export const DEFAULT_RATES: ShopRates = {
  shopRatePerHour: 75,
  setupMinutes: 15,
  minToolDiameter: 3,
  toolChangeSeconds: 20,
  stockAllowanceMm: 2,
};

/** Preferred metric drill sizes. Anything else means a custom tool or a reamer pass. */
const STANDARD_DRILLS = [
  1.5, 2, 2.5, 2.9, 3, 3.3, 3.4, 4, 4.2, 4.5, 5, 5.5, 6, 6.6, 6.8, 7, 8, 8.5, 9, 10, 10.5, 11, 12,
  13, 14, 16, 18, 20,
];

// ── findings ─────────────────────────────────────────────────────────────────

export type DfmSeverity = 'blocker' | 'warning' | 'advisory';

export interface DfmFinding {
  id: string;
  severity: DfmSeverity;
  rule: string;
  title: string;
  detail: string;
  /** What to change, phrased as an action rather than a complaint. */
  remedy: string;
  /** Extra cost this finding is responsible for, when it is quantifiable. */
  costImpact?: number;
  /** How many identical occurrences were collapsed into this one. */
  occurrences?: number;
}

export function analyseDfm(
  doc: PartDoc,
  geom: Geometry,
  process: Process = 'mill3axis',
  rates: ShopRates = DEFAULT_RATES,
): DfmFinding[] {
  const out: DfmFinding[] = [];
  const mat = materialFor(doc.material);

  // ── wall thickness ────────────────────────────────────────────────────────
  if (geom.shellWall !== null && geom.shellWall < 0.8) {
    out.push({
      id: 'wall-thin',
      severity: 'blocker',
      rule: 'dfm.mill.min-wall',
      title: `Wall of ${geom.shellWall.toFixed(2)} mm cannot be machined`,
      detail:
        'Walls below roughly 0.8 mm chatter and deflect away from the cutter in aluminium, ' +
        'and will not hold tolerance in steel at all.',
      remedy: 'Increase the shell thickness to at least 1.0 mm, or 1.5 mm for a load-bearing wall.',
    });
  }

  // ── hole rules ────────────────────────────────────────────────────────────
  for (const [i, hole] of geom.holes.entries()) {
    const depth = geom.T;
    const ratio = depth / hole.d;

    if (ratio > 10) {
      out.push({
        id: `hole-deep-${i}`,
        severity: 'blocker',
        rule: 'dfm.drill.depth-ratio',
        title: `⌀${hole.d} mm hole is ${ratio.toFixed(1)}× deep`,
        detail:
          'Beyond about 10× diameter a standard drill wanders and packs with chips. ' +
          'This needs gun-drilling or a peck cycle with a specialist tool.',
        remedy: `Increase the hole to ⌀${(depth / 8).toFixed(1)} mm, or reduce the thickness.`,
        costImpact: 45,
      });
    } else if (ratio > 4) {
      out.push({
        id: `hole-deepish-${i}`,
        severity: 'advisory',
        rule: 'dfm.drill.depth-ratio',
        title: `⌀${hole.d} mm hole is ${ratio.toFixed(1)}× deep`,
        detail: 'Past 4× diameter the shop needs a peck cycle, which roughly doubles the drilling time.',
        remedy: 'Acceptable, but expect a small time premium.',
        costImpact: 4,
      });
    }

    // Edge breakout: a hole too close to the edge blows out the wall.
    const edgeX = geom.L / 2 - Math.abs(hole.x) - hole.d / 2;
    const edgeY = geom.W / 2 - Math.abs(hole.y) - hole.d / 2;
    const edge = Math.min(edgeX, edgeY);
    const minEdge = hole.d * 0.5;

    if (edge < 0) {
      out.push({
        id: `hole-off-${i}`,
        severity: 'blocker',
        rule: 'dfm.hole.off-part',
        title: 'Hole falls outside the part outline',
        detail: `The hole at (${hole.x}, ${hole.y}) breaches the edge by ${Math.abs(edge).toFixed(1)} mm.`,
        remedy: 'Increase Width or Length, or reduce the bolt circle.',
      });
    } else if (edge < minEdge) {
      out.push({
        id: `hole-edge-${i}`,
        severity: 'warning',
        rule: 'dfm.hole.edge-distance',
        title: `Only ${edge.toFixed(1)} mm of material beside a ⌀${hole.d} mm hole`,
        detail:
          `Standard practice keeps at least half a diameter (${minEdge.toFixed(1)} mm) of wall ` +
          'beside a hole. Less than that risks breakout during drilling and tears out under load.',
        remedy: 'Move the hole inboard or add material at the edge.',
      });
    }

    // Non-standard drill sizes mean a custom tool or an extra reaming pass.
    if (!STANDARD_DRILLS.some((d) => Math.abs(d - hole.d) < 0.05)) {
      out.push({
        id: `hole-nonstd-${i}`,
        severity: 'advisory',
        rule: 'dfm.drill.standard-size',
        title: `⌀${hole.d} mm is not a stock drill size`,
        detail: 'The shop will either ream to size or order a custom tool.',
        remedy: `Nearest stock sizes: ⌀${nearestDrill(hole.d).join(' or ⌀')} mm.`,
        costImpact: 18,
      });
    }
  }

  // Duplicate diameters are free; a spread of them is not.
  const distinct = new Set(geom.holes.map((h) => h.d));
  if (distinct.size > 3) {
    out.push({
      id: 'tool-variety',
      severity: 'advisory',
      rule: 'dfm.tooling.variety',
      title: `${distinct.size} different hole diameters`,
      detail: 'Each distinct size is another tool change and another tool to stock.',
      remedy: 'Consolidate onto two or three sizes where the design allows.',
      costImpact: (distinct.size - 3) * 6,
    });
  }

  // ── internal corners ──────────────────────────────────────────────────────
  if (geom.slot) {
    const internalR = geom.slot.h / 2;
    if (internalR < rates.minToolDiameter / 2) {
      out.push({
        id: 'slot-radius',
        severity: 'blocker',
        rule: 'dfm.mill.internal-radius',
        title: `Slot end radius ${internalR.toFixed(1)} mm is below the smallest cutter`,
        detail:
          `A milled internal corner can never be sharper than the tool that cut it. ` +
          `The shop's smallest end mill is ⌀${rates.minToolDiameter} mm, giving a ` +
          `${(rates.minToolDiameter / 2).toFixed(1)} mm minimum radius.`,
        remedy: `Open the slot to at least ${rates.minToolDiameter} mm wide.`,
      });
    }
  }

  // ── proportions ───────────────────────────────────────────────────────────
  const aspect = Math.max(geom.L, geom.W) / geom.T;
  if (aspect > 40) {
    out.push({
      id: 'aspect',
      severity: 'warning',
      rule: 'dfm.part.aspect-ratio',
      title: `Plate is ${aspect.toFixed(0)}× longer than it is thick`,
      detail:
        'Thin plates relieve rolling stress when machined and bow off the fixture. ' +
        'Flatness will drift after the first side is cut.',
      remedy: 'Increase thickness, add a stress-relief step, or accept a flatness callout.',
      costImpact: 25,
    });
  }

  // ── process fit ───────────────────────────────────────────────────────────
  if (process === 'lasercut' && geom.T > 20) {
    out.push({
      id: 'laser-thick',
      severity: 'blocker',
      rule: 'dfm.laser.max-thickness',
      title: `${geom.T} mm exceeds practical laser cutting thickness`,
      detail: 'Above roughly 20 mm in aluminium the kerf tapers badly and edge quality collapses.',
      remedy: 'Switch to waterjet or milling.',
    });
  }

  if (process === 'mill3axis' && mat.machinabilityCm3PerMin < 20 && geom.removedMm3 > 50000) {
    out.push({
      id: 'slow-material',
      severity: 'advisory',
      rule: 'dfm.material.machinability',
      title: `${mat.name} removes slowly`,
      detail:
        `At ${mat.machinabilityCm3PerMin} cm³/min this part spends a long time in the machine. ` +
        'Material choice dominates cost here, not geometry.',
      remedy: 'If the application allows it, aluminium cuts five times faster.',
    });
  }

  // ── metadata that blocks quoting ──────────────────────────────────────────
  for (const key of ['PartNo', 'Revision', 'Description']) {
    if (!doc.properties[key]) {
      out.push({
        id: `prop-${key}`,
        severity: 'warning',
        rule: 'dfm.metadata.required',
        title: `${key} is empty`,
        detail: 'Suppliers reject quote packages missing identity fields, usually after a day of silence.',
        remedy: `Set ${key} before releasing.`,
      });
    }
  }

  return collapse(out).sort((a, b) => rank(a.severity) - rank(b.severity));
}

/**
 * Collapses identical findings.
 *
 * A four-hole pattern that violates edge distance is one design problem, not four. Four
 * identical cards trains the engineer to scroll past the list, which defeats the point
 * of having a linter at all. Cost impact still accumulates across every occurrence.
 */
function collapse(findings: DfmFinding[]): DfmFinding[] {
  const byKey = new Map<string, DfmFinding>();

  for (const f of findings) {
    const key = `${f.rule}|${f.title}`;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { ...f, occurrences: 1 });
      continue;
    }
    seen.occurrences = (seen.occurrences ?? 1) + 1;
    if (f.costImpact) seen.costImpact = (seen.costImpact ?? 0) + f.costImpact;
  }

  return [...byKey.values()];
}

function rank(s: DfmSeverity): number {
  return s === 'blocker' ? 0 : s === 'warning' ? 1 : 2;
}

function nearestDrill(d: number): number[] {
  return [...STANDARD_DRILLS].sort((a, b) => Math.abs(a - d) - Math.abs(b - d)).slice(0, 2).sort((a, b) => a - b);
}

// ── cost ─────────────────────────────────────────────────────────────────────

export interface CostLine {
  label: string;
  detail: string;
  amount: number;
}

export interface CostEstimate {
  lines: CostLine[];
  unitCost: number;
  quantity: number;
  totalCost: number;
  cycleMinutes: number;
  /** Every input, so the number can be argued with rather than believed. */
  basis: string[];
}

export function estimateCost(
  doc: PartDoc,
  geom: Geometry,
  findings: DfmFinding[],
  quantity = 1,
  rates: ShopRates = DEFAULT_RATES,
): CostEstimate {
  const mat = materialFor(doc.material);
  const a = rates.stockAllowanceMm;

  // Stock billet, oversize on every face.
  const stockCm3 = ((geom.L + 2 * a) * (geom.W + 2 * a) * (geom.T + 2 * a)) / 1000;
  const stockKg = (stockCm3 * mat.density) / 1000;
  const materialCost = stockKg * mat.stockCostPerKg;

  // Facing the billet down to size, plus the features cut into it.
  const facingCm3 = (stockCm3 * 1000 - geom.L * geom.W * geom.T) / 1000;
  const featureCm3 = geom.removedMm3 / 1000;
  const roughingMin = (facingCm3 + featureCm3) / mat.machinabilityCm3PerMin;

  // Finishing scales with surface area, not volume.
  const perimeterCm2 = (2 * (geom.L + geom.W) * geom.T) / 100;
  const facesCm2 = (2 * geom.L * geom.W) / 100;
  const finishingMin = (perimeterCm2 + facesCm2) / 90;

  // Drilling: proportional to depth, plus a fixed peck penalty on deep holes.
  const drillMin = geom.holes.reduce((sum, h) => {
    const base = geom.T / 25;
    const peck = geom.T / h.d > 4 ? base : 0;
    return sum + base + peck;
  }, 0);

  const distinctTools = new Set(geom.holes.map((h) => h.d)).size + 2;
  const toolChangeMin = (distinctTools * rates.toolChangeSeconds) / 60;

  const cycleMinutes = roughingMin + finishingMin + drillMin + toolChangeMin;

  // Setup is amortised: it is why one-offs are expensive and hundreds are not.
  const setupPerPart = rates.setupMinutes / Math.max(1, quantity);

  const dfmSurcharge = findings.reduce((s, f) => s + (f.costImpact ?? 0), 0);

  const lines: CostLine[] = [
    {
      label: 'Material',
      detail: `${stockCm3.toFixed(1)} cm³ billet · ${stockKg.toFixed(3)} kg · $${mat.stockCostPerKg}/kg`,
      amount: materialCost,
    },
    {
      label: 'Roughing',
      detail: `${(facingCm3 + featureCm3).toFixed(1)} cm³ at ${mat.machinabilityCm3PerMin} cm³/min`,
      amount: (roughingMin / 60) * rates.shopRatePerHour,
    },
    {
      label: 'Finishing',
      detail: `${(perimeterCm2 + facesCm2).toFixed(0)} cm² surface`,
      amount: (finishingMin / 60) * rates.shopRatePerHour,
    },
    {
      label: 'Drilling',
      detail: `${geom.holes.length} hole${geom.holes.length === 1 ? '' : 's'} · ${geom.T} mm deep`,
      amount: (drillMin / 60) * rates.shopRatePerHour,
    },
    {
      label: 'Tool changes',
      detail: `${distinctTools} tools · ${rates.toolChangeSeconds}s each`,
      amount: (toolChangeMin / 60) * rates.shopRatePerHour,
    },
    {
      label: 'Setup (amortised)',
      detail: `${rates.setupMinutes} min over ${quantity} part${quantity === 1 ? '' : 's'}`,
      amount: (setupPerPart / 60) * rates.shopRatePerHour,
    },
  ];

  if (dfmSurcharge > 0) {
    lines.push({
      label: 'DFM surcharge',
      detail: `${findings.filter((f) => f.costImpact).length} finding(s) with a cost impact`,
      amount: dfmSurcharge,
    });
  }

  const unitCost = lines.reduce((s, l) => s + l.amount, 0);

  return {
    lines,
    unitCost,
    quantity,
    totalCost: unitCost * quantity,
    cycleMinutes,
    basis: [
      `${mat.name} at $${mat.stockCostPerKg}/kg, ${mat.density} g/cm³`,
      `Shop rate $${rates.shopRatePerHour}/hr, setup ${rates.setupMinutes} min`,
      `Removal rate ${mat.machinabilityCm3PerMin} cm³/min, ${rates.stockAllowanceMm} mm stock allowance per side`,
      'Excludes finishing, inspection, freight and margin',
    ],
  };
}

import {
  electricalFor, measurePart, PROCESSES,
  type ElectricalResult, type PartMeasurement, type ProcessSpec, type QualityCheck,
} from './anodizing';
import type { Mesh } from '../kernel/topo/mesh';

/**
 * The bar-and-clip rack: a part goes in, the rack that carries it comes out.
 *
 * ── Where the numbers come from ──
 *
 * Not from a model, and not invented. Every constant below is read off a released drawing in
 * an anodizing shop's own rack library, and each is cited at the point it is used. That
 * library is the design authority; this file is a machine-readable statement of what it does.
 *
 * The architecture it describes is specific and worth stating plainly, because it is not the
 * spine-and-arm rack `anodizing.ts` models. A rack here is **one titanium bar with sheet-metal
 * clips spot-welded across it**:
 *
 *   - **100-0132, "1\" RACK BAR"** — Grade 2 Ti sheet, 309.563 × 25.400 × 1.270 mm, with
 *     9.813" (249.238 mm) of usable span between its end features. Every rack in the library
 *     uses this same bar; it is the fixed frame the design works inside.
 *   - **A clip, or a station of clips** — Grade 4 Ti, 0.025" to 0.040" strip, bent to grip the
 *     part and spot-welded to the bar. Grade 4 for the springs because it work-hardens and
 *     holds contact pressure through a strip cycle; Grade 2 for the bar because it is the
 *     cheaper, more formable sheet and the bar is not sprung.
 *   - **3/16" diameter spot welds, two per clip** (426-0244), or a 0.15" weld (426-0272).
 *
 * ── The design variable ──
 *
 * How many stations fit across the bar. The revision history of 426-0244 is the whole of the
 * design problem in three lines:
 *
 *     A  WAS 10-ACROSS, NOW 8-ACROSS          5 June 2024
 *     AB WAS 8-ACROSS, NOW 6-ACROSS           24 June 2024
 *
 * Nobody reduced the count because the parts stopped fitting. They reduced it because at ten
 * across the bath could not carry fresh electrolyte between the parts and the coating came out
 * patchy — the same diffusion limit `anodizing.ts` sizes its pitch from. So this file does not
 * pack the bar; it spaces it, and then checks that what fits also drains.
 */

// ── the bar, from drawing 100-0132 rev D ────────────────────────────────────

export const RACK_BAR = {
  partNumber: '100-0132',
  description: '1" RACK BAR',
  material: 'Grade 2 Ti sheet',
  lengthMm: 309.563,
  /** Between the end features — the span clips may actually occupy. */
  usableSpanMm: 249.238,
  widthMm: 25.4,
  thicknessMm: 1.27,
  /** Stated on the drawing, so the assembly's area does not have to be estimated. */
  areaMm2: 16_574.29,
  massG: 44.42,
} as const;

/** Spot welds, from 426-0244 and 426-0272. */
export const SPOT_WELD = {
  diameterMm: 4.7625,          // 3/16"
  perClip: 2,
} as const;

/**
 * Clip stock, from 423-0264, 423-0266 and 423-0312.
 *
 * Grade 4 rather than Grade 2 throughout the sprung parts: it work-hardens, so a clip keeps
 * its contact pressure through a strip-and-reuse cycle instead of relaxing after a few runs.
 * A relaxed contact is a burnt contact — the current does not fall, the resistance rises.
 */
export const CLIP_STOCK = {
  material: 'Grade 4 Ti',
  /** The two gauges the library actually uses. */
  thinMm: 0.635,               // 0.025"
  thickMm: 1.016,              // 0.040"
  /** Every fillet and bend radius unless stated otherwise (423-0312). */
  defaultRadiusMm: 2.032,      // R0.080"
} as const;

/**
 * How many stations the library puts on one bar.
 *
 * Four on the candle-lid rack (426-0272), six on the plaque rack (426-0244) after two
 * reductions from ten. Outside this range the design is not one of these racks any more: below
 * four the bar is barely earning its place in the tank, and above ten the shop has already
 * twice concluded the parts do not coat.
 */
export const STATIONS = { min: 2, max: 10 } as const;

/**
 * Clear solution path between parts, as a fraction of the part's *largest* dimension.
 *
 * Not of its thickness, which is what a packing rule would use. The reason is the shape of the
 * problem: spent electrolyte between two parallel parts has to travel out past the edge of the
 * part before fresh solution can take its place, so the path that has to stay open scales with
 * how far there is to travel — the part's face size — and not with how thick the part is. A
 * pair of 100 mm lids 15 mm apart is a worse bath than a pair of 20 mm bosses the same 15 mm
 * apart, and the same fraction applied to the wrong dimension would call them equal.
 *
 * The value is calibrated on the two racks in the library that are documented well enough to
 * calibrate against, and on nothing else:
 *
 *   426-0272   a ~105 mm candle lid, 12 mm deep    →  4 stations   (12 + 0.4×105 = 54.0 mm)
 *   426-0244   a 76 mm plaque, 10 mm deep          →  6 stations   (10 + 0.4×76  = 40.4 mm)
 *
 * Two points fit one constant, which is worth saying plainly: this reproduces the shop's own
 * two answers and is an extrapolation everywhere else. A third documented rack would be worth
 * more to this number than any amount of reasoning about it.
 */
export const CLEARANCE_FRACTION = 0.4;

// ── what comes out ───────────────────────────────────────────────────────────

export interface ClipSpec {
  /** Grip opening, mm — the part dimension the clip closes on. */
  gripMm: number;
  /** Strip width across the part, mm. */
  widthMm: number;
  /** Length of the bent strip from the weld to the tip, mm. */
  reachMm: number;
  thicknessMm: number;
  material: string;
  /** Wetted area of one clip, mm², measured off the strip it is folded from. */
  areaMm2: number;
  massG: number;
  spotWelds: number;
}

export interface BarRackDesign {
  part: PartMeasurement;
  process: ProcessSpec;

  /** Stations across the bar, and what each carries. */
  stations: number;
  partsPerStation: number;
  partsTotal: number;
  /** Centre-to-centre, mm. */
  pitchMm: number;
  /** Clear solution path between parts, mm. */
  clearanceMm: number;

  bar: typeof RACK_BAR;
  clip: ClipSpec;

  electrical: ElectricalResult;
  thicknessUm: number;

  /** The rack's own wetted area, which draws current and coats along with the parts. */
  rackAreaMm2: number;
  /** Fraction of the total current spent coating the rack rather than the work. */
  rackCurrentFraction: number;

  massG: number;
  checks: QualityCheck[];

  /** The rack as a DatumScript, ready to build, edit and draw. */
  script: string;
}

export interface BarRackOptions {
  processId?: string;
  thicknessUm?: number;
  /** Override the station count the rules would choose. */
  stations?: number;
  /** Parts carried at each station. Two is a back-to-back pair on one clip. */
  partsPerStation?: number;
  densityGPerCm3?: number;
}

// ── the design ───────────────────────────────────────────────────────────────

export function designBarRack(mesh: Mesh, options: BarRackOptions = {}): BarRackDesign {
  const part = measurePart(mesh, options.densityGPerCm3 ?? 2.7);
  return designBarRackFor(part, options);
}

export function designBarRackFor(
  part: PartMeasurement, options: BarRackOptions = {},
): BarRackDesign {
  const process = PROCESSES.find((p) => p.id === options.processId) ?? PROCESSES[0]!;
  // The middle of the process's stated range, which is what a shop runs unless told otherwise.
  const thicknessUm = options.thicknessUm
    ?? (process.thicknessUm[0] + process.thicknessUm[1]) / 2;

  /*
   * Which way the part hangs, which decides everything downstream.
   *
   * A part hangs edge-on, like a coin in a slot: its two large dimensions go down into the
   * tank and outward, and only its *smallest* dimension occupies room along the bar. That is
   * why 426-0272 fits four ~105 mm candle lids on 249 mm of span — the lids are 12 mm deep and
   * it is the 12 mm that competes for the bar, not the 105 mm.
   *
   * Getting this wrong is not a small error. Read the second-largest dimension as the one that
   * occupies the span and the same bar takes two lids instead of four, which halves the load,
   * doubles the cost per part, and looks entirely reasonable on the way out.
   */
  const [down, across, through] = part.sizeMm;

  const partsPerStation = clamp(options.partsPerStation ?? 1, 1, 4);
  const needed = through * partsPerStation;
  // The part's own thickness, plus the path solution needs to get past its face.
  const pitchNeeded = Math.max(needed + CLEARANCE_FRACTION * down, MIN_PITCH_MM);

  const fits = Math.floor(RACK_BAR.usableSpanMm / Math.max(pitchNeeded, 1e-6));
  const stations = clamp(options.stations ?? fits, STATIONS.min, STATIONS.max);

  const pitchMm = RACK_BAR.usableSpanMm / Math.max(1, stations);
  const clearanceMm = pitchMm - needed;

  const clip = designClip(through, across, down, part);
  const partsTotal = stations * partsPerStation;

  const electrical = electricalFor(part, process, partsTotal, thicknessUm);

  const rackAreaMm2 = RACK_BAR.areaMm2 + clip.areaMm2 * stations;
  const workAreaMm2 = part.areaMm2 * partsTotal;

  return {
    part,
    process,
    stations,
    partsPerStation,
    partsTotal,
    pitchMm,
    clearanceMm,
    bar: RACK_BAR,
    clip,
    electrical,
    thicknessUm,
    rackAreaMm2,
    rackCurrentFraction: rackAreaMm2 / Math.max(1e-6, rackAreaMm2 + workAreaMm2),
    massG: RACK_BAR.massG + clip.massG * stations,
    checks: check(part, stations, pitchMm, clearanceMm, down, clip, rackAreaMm2, workAreaMm2),
    script: scriptFor(stations, pitchMm, clip),
  };
}

/**
 * The clip, sized to the part it grips.
 *
 * A clip is a folded strip: it reaches out from the bar, closes on the part, and springs back.
 * Three numbers describe it — how far it reaches, how wide the strip is, and how far it opens
 * — and each follows from the part rather than from a catalogue.
 */
function designClip(
  through: number, across: number, down: number, part: PartMeasurement,
): ClipSpec {
  // It grips across the part's smallest dimension, which is the one a spring can close on.
  // Reported as measured, with no floor under it: a part too thin to grip is a fact the caller
  // needs, and a clip silently widened to 1 mm would hide it behind a design that looks fine.
  const gripMm = through;

  // Wide enough to hold without marking: a third of the part's across-bar size, bounded by
  // the bar's own width, because a clip wider than its bar has nowhere to weld.
  const widthMm = clamp(Math.max(across, down) / 3, 6, RACK_BAR.widthMm);

  // Far enough that the part hangs clear of the bar and the weld, and no further: every
  // millimetre of reach is rack area drawing current that coats nothing worth selling.
  const reachMm = clamp(Math.max(gripMm, 1) * 2.5 + 12, 20, 60);

  // Heavier stock for a bigger part, from the two gauges the library uses.
  const thicknessMm = part.massG > 60 ? CLIP_STOCK.thickMm : CLIP_STOCK.thinMm;

  // Both faces of the strip, plus its edges. A folded strip is wetted on every side.
  const developed = reachMm * 2 + gripMm;
  const areaMm2 = 2 * developed * widthMm + 2 * developed * thicknessMm;
  const massG = developed * widthMm * thicknessMm * 4.51e-3;   // Ti, 4.51 g/cm³

  return {
    gripMm,
    widthMm,
    reachMm,
    thicknessMm,
    material: CLIP_STOCK.material,
    areaMm2,
    massG,
    spotWelds: SPOT_WELD.perClip,
  };
}

// ── the checks ───────────────────────────────────────────────────────────────

function check(
  part: PartMeasurement, stations: number, pitchMm: number, clearanceMm: number,
  down: number, clip: ClipSpec, rackAreaMm2: number, workAreaMm2: number,
): QualityCheck[] {
  const out: QualityCheck[] = [];

  out.push({
    id: 'rack.span',
    ok: stations * pitchMm <= RACK_BAR.usableSpanMm + 1e-6,
    title: 'The stations fit the bar',
    detail:
      `${stations} at ${pitchMm.toFixed(1)} mm is ${(stations * pitchMm).toFixed(1)} mm of the ` +
      `${RACK_BAR.usableSpanMm} mm usable span on ${RACK_BAR.partNumber}.`,
    severity: 'blocker',
  });

  out.push({
    id: 'rack.clearance',
    ok: clearanceMm >= CLEARANCE_FRACTION * part.sizeMm[0],
    title: 'Solution can reach between the parts',
    detail:
      `${clearanceMm.toFixed(1)} mm clear between parts, against the ` +
      `${(CLEARANCE_FRACTION * part.sizeMm[0]).toFixed(1)} mm the two racks in the library were ` +
      `built to. The shop twice cut a station count for patchy coating rather than for fit ` +
      `(426-0244 rev A and AB), so this is the number that decides the count.`,
    severity: 'warning',
  });

  out.push({
    id: 'rack.depth',
    ok: down <= 400,
    title: 'The part hangs within a tank depth',
    detail: `${down.toFixed(0)} mm on the long axis. Beyond about 400 mm the load needs a deeper tank than the bar was drawn for.`,
    severity: 'warning',
  });

  out.push({
    id: 'rack.grip',
    ok: clip.gripMm >= 0.8,
    title: 'There is something for a clip to close on',
    detail:
      `The clip closes on ${clip.gripMm.toFixed(2)} mm. Below about 0.8 mm a Grade 4 strip ` +
      `cannot hold contact pressure without marking the part.`,
    severity: 'blocker',
  });

  const fraction = rackAreaMm2 / Math.max(1e-6, rackAreaMm2 + workAreaMm2);
  out.push({
    id: 'rack.parasitic',
    ok: fraction <= 0.4,
    title: 'Most of the current coats work, not rack',
    detail:
      `${(fraction * 100).toFixed(0)}% of the wetted area is rack. Every ampere spent on it is ` +
      `paid for and thrown away at the next strip.`,
    severity: fraction > 0.6 ? 'warning' : 'advisory',
  });

  return out;
}

// ── the rack, as something that builds ───────────────────────────────────────

/**
 * The rack as a DatumScript.
 *
 * A design that cannot be opened, measured and drawn is a report, not a rack. This is the same
 * language the rest of the application builds from, so what comes out of here goes straight
 * into the viewport, the drawing engine and the manufacturability rules with nothing in
 * between.
 *
 * The clip is drawn as a box of the right stock rather than as a `sheet` bend. `sheet` builds
 * a flanged blank from a shape and a thickness and has no length of its own, so a clip drawn
 * with it would not be the clip on the drawing. A block of the right material, in the right
 * place, at the right pitch is honest about standing in for the bend, and it gets the pitch,
 * the count and the interference right — which is what this script is read for.
 *
 * The clips are written out one per line rather than patterned, and that is not verbosity.
 * `patternLinear` repeats the whole body built so far — there is no feature selection in this
 * language, so once the bar exists a pattern repeats the bar with it. The first version of this
 * did exactly that and produced a 496 mm rack from a 310 mm bar: four bars and four clips, a
 * closed solid, every check passed, and nothing that could be welded. Each clip is placed at
 * `first+n*pitch` instead, so the arithmetic stays visible and editing `pitch` still moves
 * every clip. Written without spaces, because a line is split on whitespace and any token
 * without an `=` is a name: `at.x=first + 1*pitch` is three names, not one expression.
 */
function scriptFor(stations: number, pitchMm: number, clip: ClipSpec): string {
  const firstX = -((stations - 1) * pitchMm) / 2;

  /*
   * A clip is a folded strip, and it is drawn folded.
   *
   * It was one upright box per station, which got the pitch and the count right and looked
   * nothing like the thing on the drawing — and a rack drawing whose clips are blank rectangles
   * is a rack nobody can weld from. A 423-0312 comes off the bar, runs out, turns over, and
   * comes back down the other side of the part: the return leg *is* the clip, because it is what
   * grips.
   *
   * Three boxes, not a swept profile, and that is a language limit rather than a preference: a
   * folded section would be an `extrude` of a point list, and a script statement can carry a
   * number or a word but not an array. Three boxes place the same three faces the strip has, at
   * the same thicknesses, with the grip between them — so the geometry is right where it is
   * measured and simplified only where it is bent.
   */
  const t = clip.thicknessMm;
  const grip = Math.max(t, clip.gripMm);
  const jaw = Math.min(clip.reachMm * 0.55, clip.reachMm - t * 2);

  const legZ = round(RACK_BAR.thicknessMm / 2 + clip.reachMm / 2);
  const topZ = round(RACK_BAR.thicknessMm / 2 + clip.reachMm - t / 2);
  const jawZ = round(RACK_BAR.thicknessMm / 2 + clip.reachMm - t - jaw / 2);

  // The back leg sits on the bar's centreline; everything else is measured across from it.
  const spanX = round(grip + t);
  const jawX = round(grip + t);

  const clips = Array.from({ length: stations }, (_, i) => {
    const at = (expr: string) => `at.x=${i === 0 ? expr : `${expr}+${i}*pitch`}`;
    const n = i + 1;

    return [
      `# Station ${n}: back leg welded to the bar, fold over the top, return leg gripping.`,
      `box Clip${n}Leg length=clipThickness width=clipWidth height=clipReach `
      + `${at('first')} at.z=legZ`,
      `box Clip${n}Top length=span width=clipWidth height=clipThickness `
      + `${at(`first+${round(spanX / 2)}`)} at.z=topZ`,
      `box Clip${n}Jaw length=clipThickness width=clipWidth height=jaw `
      + `${at(`first+${jawX}`)} at.z=jawZ`,
    ].join(LINE);
  });

  return [
    'name Rack',
    'material Titanium Grade 2',
    '',
    `param barLength = ${RACK_BAR.lengthMm}`,
    `param barWidth = ${RACK_BAR.widthMm}`,
    `param barThickness = ${RACK_BAR.thicknessMm}`,
    `param stations = ${stations}`,
    `param pitch = ${round(pitchMm)}`,
    `param clipWidth = ${round(clip.widthMm)}`,
    `param clipReach = ${round(clip.reachMm)}`,
    `param clipThickness = ${t}`,
    `param grip = ${round(grip)}`,
    `param jaw = ${round(jaw)}`,
    `param span = ${round(spanX + t)}`,
    `param first = ${round(firstX)}`,
    `param legZ = ${legZ}`,
    `param topZ = ${topZ}`,
    `param jawZ = ${jawZ}`,
    '',
    '# The bar every rack in the library is built on — 100-0132, Grade 2 Ti.',
    'box Bar length=barLength width=barWidth height=barThickness',
    '',
    `# ${stations} stations at ${round(pitchMm)} mm, gripping ${round(grip)} mm.`,
    `# Grade 4 Ti strip, two 3/16" spot welds per clip.`,
    ...clips,
  ].join(LINE);
}

/** A newline, named because these scripts are assembled from arrays of lines. */
const LINE = String.fromCharCode(10);

// ── odds and ends ────────────────────────────────────────────────────────────

/**
 * The least pitch worth welding at, mm.
 *
 * Two 3/16" spot welds and the bend between them need somewhere to sit. Below this the clips
 * are one continuous strip and there is nothing for solution to move through, whatever the
 * diffusion arithmetic says about a very small part.
 */
const MIN_PITCH_MM = 12.7;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round = (v: number) => Number(v.toFixed(3));

/** The design as a sentence, for a reply or a report. */
export function describeBarRack(d: BarRackDesign): string {
  const failed = d.checks.filter((c) => !c.ok);

  return [
    `${d.stations} stations on a ${d.bar.partNumber} bar at ${d.pitchMm.toFixed(1)} mm pitch, ` +
    `carrying ${d.partsTotal} part${d.partsTotal === 1 ? '' : 's'}.`,
    `${d.electrical.currentA.toFixed(1)} A at ${d.process.currentDensityAdm2} A/dm², ` +
    `${d.electrical.minutes.toFixed(0)} min for ${d.thicknessUm} µm.`,
    `Clip: ${d.clip.material}, ${d.clip.thicknessMm} mm strip, ` +
    `${d.clip.widthMm.toFixed(1)} mm wide, gripping ${d.clip.gripMm.toFixed(1)} mm, ` +
    `${d.clip.spotWelds} spot welds.`,
    `${(d.rackCurrentFraction * 100).toFixed(0)}% of the current coats the rack.`,
    failed.length > 0
      ? `${failed.length} check${failed.length === 1 ? '' : 's'} not met: ${failed.map((c) => c.title).join('; ')}.`
      : 'Every check met.',
  ].join(' ');
}

import { bounds, massProperties, surfaceArea, triCount, type Mesh } from '../kernel/topo/mesh';

/**
 * Anodizing: sizing a rack from the part that goes on it.
 *
 * A rack is an electrical component before it is a mechanical one, and that ordering is the
 * whole design. Every dimension of a rack follows from a current, and the current follows
 * from the part's wetted area — so nothing here is chosen. Area is measured off the solid,
 * current falls out of the area and the process, and section, contacts, spacing and cooling
 * all fall out of the current. A rack drawn to look right and sized by eye produces burnt
 * contacts, thin coating at the far end, and a batch nobody can ship.
 *
 * **Every figure states where it comes from.** The constants below are published process
 * practice — MIL-A-8625 for the coating types, Faraday's law for the growth rate, standard
 * busbar practice for the current density in titanium — and each is cited at the point it is
 * used, because a rack is a thing an engineer signs off and an unexplained number is a number
 * they cannot sign.
 *
 * What this does **not** do: it does not model the bath chemistry, the rectifier's ripple, or
 * the thermal transient of a real tank. It computes the steady-state figures a rack is sized
 * from, and says so.
 */

// ── the process ─────────────────────────────────────────────────────────────

export type ProcessType = 'typeII' | 'typeIII' | 'chromic' | 'bright';

export interface ProcessSpec {
  id: ProcessType;
  label: string;
  /** Current density, A/dm². The single figure the whole rack is sized from. */
  currentDensityAdm2: number;
  /** Bath temperature, °C. Hard anodizing runs cold, which is why it needs the chilling. */
  bathC: number;
  /** Typical coating thickness, µm. */
  thicknessUm: [number, number];
  /** Volts at the cell. Sets the rectifier, and with the current sets the heat. */
  volts: number;
  basis: string;
}

/**
 * The four processes that cover almost all aluminium anodizing.
 *
 * Current density is the number to argue with if any of these look wrong for your shop:
 * everything downstream scales linearly with it.
 */
export const PROCESSES: ProcessSpec[] = [
  {
    id: 'typeII',
    label: 'Type II — sulphuric, decorative and protective',
    currentDensityAdm2: 1.5,
    bathC: 20,
    thicknessUm: [5, 25],
    volts: 15,
    basis: 'MIL-A-8625 Type II. 12–18 A/ft² is the usual window; 1.5 A/dm² sits in the middle of it.',
  },
  {
    id: 'typeIII',
    label: 'Type III — hard anodize',
    currentDensityAdm2: 2.5,
    bathC: 0,
    thicknessUm: [25, 75],
    volts: 45,
    basis: 'MIL-A-8625 Type III. Higher density and a chilled bath are what make the coating hard.',
  },
  {
    id: 'chromic',
    label: 'Chromic — thin, for fatigue-critical parts',
    currentDensityAdm2: 0.3,
    bathC: 35,
    thicknessUm: [2, 5],
    volts: 40,
    basis: 'MIL-A-8625 Type I. Thin and least damaging to fatigue life; used on airframe parts.',
  },
  {
    id: 'bright',
    label: 'Bright dip and anodize',
    currentDensityAdm2: 1.2,
    bathC: 21,
    thicknessUm: [5, 12],
    volts: 15,
    basis: 'Decorative work. Lower density protects the polished surface from burning.',
  },
];

export const processById = (id: ProcessType): ProcessSpec =>
  PROCESSES.find((p) => p.id === id) ?? PROCESSES[0]!;

// ── the rack's own material ─────────────────────────────────────────────────

export interface RackMaterial {
  id: string;
  name: string;
  density: number;
  /** Amps per mm² of section that the material will carry continuously in a bath. */
  ampsPerMm2: number;
  /** Runs before the rack must be stripped, from how fast its own oxide builds. */
  runsBeforeStrip: number;
  basis: string;
}

export const RACK_MATERIALS: RackMaterial[] = [
  {
    id: 'ti',
    name: 'Titanium Ti-6Al-4V',
    density: 4.43,
    ampsPerMm2: 1.0,
    runsBeforeStrip: 40,
    basis:
      'Near-universal for anodizing. It survives the sulphuric acid and its own oxide stops it '
      + 'plating up — but that oxide also raises contact resistance, which is what sets the strip '
      + 'interval rather than any mechanical wear.',
  },
  {
    id: 'al',
    name: 'Aluminium 6061-T6',
    density: 2.7,
    ampsPerMm2: 1.6,
    runsBeforeStrip: 1,
    basis:
      'Conducts far better and costs far less, and anodizes along with the work — so it must be '
      + 'stripped every run. Used where racks are effectively consumable.',
  },
  {
    id: 'cu-ti',
    name: 'Copper core, titanium clad',
    density: 8.4,
    ampsPerMm2: 3.5,
    runsBeforeStrip: 40,
    basis:
      'Copper carries the current and titanium takes the acid. Used on high-current work where '
      + 'a solid titanium spine would have to be impractically heavy.',
  },
];

export const rackMaterialById = (id: string): RackMaterial =>
  RACK_MATERIALS.find((m) => m.id === id) ?? RACK_MATERIALS[0]!;

// ── measuring the part ──────────────────────────────────────────────────────

export interface PartMeasurement {
  /** Wetted surface area, dm². The unit the whole industry sizes current in. */
  areaDm2: number;
  areaMm2: number;
  volumeMm3: number;
  massG: number;
  /** Bounding box, mm, largest first. */
  sizeMm: [number, number, number];
}

/**
 * What the rack has to know about the part.
 *
 * Surface area is the figure everything else rests on, and it is measured off the solid
 * rather than estimated from the envelope. The difference is not small: a finned heatsink has
 * several times the area of the box it fits in, draws several times the current, and needs a
 * rack sized for that. Estimating from the envelope is how a rack gets built that burns its
 * contacts on the first run.
 */
export function measurePart(mesh: Mesh, densityGPerCm3 = 2.7): PartMeasurement {
  const areaMm2 = surfaceArea(mesh);
  const volumeMm3 = Math.abs(massProperties(mesh).volume);
  const b = bounds(mesh);
  const size = triCount(mesh) === 0
    ? [0, 0, 0]
    : [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];

  return {
    areaMm2,
    // 1 dm² = 10 000 mm².
    areaDm2: areaMm2 / 10_000,
    volumeMm3,
    massG: (volumeMm3 / 1000) * densityGPerCm3,
    sizeMm: [...size].sort((x, y) => y - x) as [number, number, number],
  };
}

// ── the electrochemistry ────────────────────────────────────────────────────

/**
 * Coating growth, µm per minute, at one A/dm².
 *
 * From Faraday's law with the current efficiency real sulphuric baths achieve. At Type II
 * density this gives roughly 0.4 µm/min, which is the figure every anodizing line quotes as
 * "about 25 microns in an hour" — so the derivation and the shop-floor rule of thumb agree,
 * which is the check worth having on it.
 */
const GROWTH_UM_PER_MIN_PER_ADM2 = 0.28;

/**
 * Fraction of the coating that grows *into* the part rather than outward.
 *
 * Half, near enough, for sulphuric anodizing. It matters because it is the difference between
 * a part that fits after coating and one that does not: a 25 µm coating adds 12.5 µm per
 * surface, so a bore loses 25 µm on diameter.
 */
const PENETRATION = 0.5;

export interface ElectricalResult {
  /** Total current for the load, A. */
  currentA: number;
  /** Current for one part, A. */
  perPartA: number;
  /** Rectifier voltage. */
  volts: number;
  /** Electrical power into the tank, W — which is also the heat that must come back out. */
  powerW: number;
  /** Minutes at this density to reach the requested thickness. */
  minutes: number;
  /** How much a coated surface grows outward, µm — half the coating. */
  growthUm: number;
  /** Diametral loss in a bore, µm. Twice the growth, and the number that scraps parts. */
  boreLossUm: number;
}

export function electricalFor(
  part: PartMeasurement, process: ProcessSpec, partsOnRack: number, thicknessUm: number,
): ElectricalResult {
  const perPartA = part.areaDm2 * process.currentDensityAdm2;
  const currentA = perPartA * partsOnRack;
  const minutes = thicknessUm / (GROWTH_UM_PER_MIN_PER_ADM2 * process.currentDensityAdm2);
  const growthUm = thicknessUm * (1 - PENETRATION);

  return {
    currentA,
    perPartA,
    volts: process.volts,
    powerW: currentA * process.volts,
    minutes,
    growthUm,
    boreLossUm: growthUm * 2,
  };
}

// ── the rack ────────────────────────────────────────────────────────────────

export interface RackSpec {
  /** Parts across one arm, both sides of the spine. */
  partsPerTier: number;
  tiers: number;
  partsTotal: number;

  spineWidthMm: number;
  spineThicknessMm: number;
  spineHeightMm: number;

  armLengthMm: number;
  armWidthMm: number;
  armThicknessMm: number;

  /**
   * Contact positions per part. One.
   *
   * Not a free choice, and worth saying why. The rack geometry carries one sprung tip per
   * part position, and its own electrical model counts a part per tip — so drawing two tips
   * per part makes the rack believe it is carrying twice the load and size itself for a
   * current that does not exist. Where a part genuinely needs more contact than one tip can
   * give, the answer is a larger tip or a forked one, which is what a plating shop does
   * anyway: a second contact is a second witness mark.
   */
  tipsPerPart: 1;
  tipDiaMm: number;
  tipLengthMm: number;
  hookDiaMm: number;

  /** Clear gap between parts, mm. Set by solution flow, not by packing. */
  pitchMm: number;
}

export interface QualityCheck {
  id: string;
  ok: boolean;
  title: string;
  /** What was measured against what, so the check can be argued with. */
  detail: string;
  severity: 'blocker' | 'warning' | 'advisory';
}

export interface RackDesign {
  part: PartMeasurement;
  process: ProcessSpec;
  material: RackMaterial;
  electrical: ElectricalResult;
  rack: RackSpec;
  thicknessUm: number;
  /** Litres per minute of bath movement the load needs to stay in its temperature window. */
  coolingWatts: number;
  coolingLitresPerMin: number;
  /** Runs before the rack must be stripped, and why. */
  rackLifeRuns: number;
  checks: QualityCheck[];
  /** The rack archetype's parameters, ready to build. */
  archetypeParams: Record<string, number>;
}

/**
 * Clear space around a part, as a fraction of its largest dimension.
 *
 * Anodizing is not a line-of-sight process, but it is a *diffusion* one: the electrolyte has
 * to carry heat away from the surface and reaction products out of the pores. Parts packed
 * tighter than this trap warm depleted solution between them and come out patchy on the inner
 * faces, which is the defect that gets blamed on the bath and is actually the rack.
 */
const CLEARANCE = 0.35;

/** Minimum gap regardless of part size, mm. Below this nothing circulates at all. */
const MIN_GAP = 25;

/**
 * Minimum vertical spacing between arms, mm.
 *
 * Larger than the horizontal gap, and for a different reason. Sideways, the constraint is that
 * fresh electrolyte reaches the faces. Vertically it is gas: anodizing evolves oxygen at the
 * work, the bubbles rise, and a part hung too close under another sits in the stream coming
 * off it — which shields the surface and leaves it thin and patchy. Parts also have to drain
 * when the rack lifts.
 *
 * 60 mm is the rack archetype's own figure, taken from it deliberately rather than chosen
 * again here. Sizing to a tighter pitch produced racks that were warned about by the geometry
 * they were built from.
 */
const MIN_TIER_PITCH = 60;

/**
 * Current density the *contact interface* will take, A/mm².
 *
 * Not the same limit as the conductor rating, and stricter than it. A titanium spine carries
 * 1 A/mm² happily because it is one continuous piece of metal; the contact is a titanium tip
 * pressed against aluminium, and it is the aluminium that gives way — it softens under the
 * tip, contact resistance rises, that heats it further, and the part arcs off the rack.
 *
 * Named once because the sizing and the check both need it. An earlier version sized the tip
 * on the conductor rating and then checked it against this one, so every rack it produced
 * failed its own contact check by exactly the ratio between the two numbers.
 */
const CONTACT_A_PER_MM2 = 0.6;

export interface RackOptions {
  process?: ProcessType;
  materialId?: string;
  /** Target coating, µm. Defaults to the middle of the process's range. */
  thicknessUm?: number;
  /** How many parts must go on one rack. */
  partsWanted?: number;
  /** Usable depth of the tank, mm. Caps the spine. */
  tankDepthMm?: number;
}

/**
 * Sizes a rack for a part.
 *
 * The order is the order the physics imposes: measure, choose a load, find the current, size
 * the conductors for that current, then check the result against what a bath can actually
 * deliver. Reversing any two of those gives a rack that looks reasonable and does not work.
 */
export function designRack(
  part: PartMeasurement, options: RackOptions = {},
): RackDesign {
  const process = processById(options.process ?? 'typeII');
  const material = rackMaterialById(options.materialId ?? 'ti');
  const thicknessUm = options.thicknessUm
    ?? (process.thicknessUm[0] + process.thicknessUm[1]) / 2;

  const [long, mid] = part.sizeMm;
  const tankDepth = options.tankDepthMm ?? 1200;

  // ── how many fit ──
  const pitch = Math.max(MIN_GAP, long * CLEARANCE) + mid;
  const wanted = Math.max(1, Math.round(options.partsWanted ?? 20));

  // The spine hangs from the flight bar and must clear the tank floor. 150 mm at the top for
  // the hook and the solution line, 100 mm at the bottom so the lowest tier is not sitting in
  // the sludge that collects there.
  const usableHeight = Math.max(200, tankDepth - 250);
  const tierPitch = Math.max(MIN_TIER_PITCH, long * (1 + CLEARANCE));

  // The hook and the top arm take the first 150 mm, so that height is not available for tiers.
  const maxTiers = Math.max(1, Math.min(30, Math.floor((usableHeight - 150) / tierPitch)));

  // Never more tiers than the load needs. A rack built to its tank's capacity for a load of
  // twenty small parts is thirty tiers of two, which is a taller rack, more titanium, more
  // current in the spine and a longer crane lift — for nothing.
  const tiers = Math.max(1, Math.min(maxTiers, Math.ceil(wanted / 2)));

  const partsPerTier = Math.max(2, Math.ceil(wanted / tiers / 2) * 2);
  const partsTotal = partsPerTier * tiers;

  const electrical = electricalFor(part, process, partsTotal, thicknessUm);

  // ── conductors ──
  // The spine carries everything; each arm carries one tier; each tip carries one part's
  // share. Section follows directly from the material's continuous rating.
  const spineArea = electrical.currentA / material.ampsPerMm2;
  const armArea = (electrical.currentA / tiers) / material.ampsPerMm2;
  // One contact carries the whole of one part's current, and is limited by the aluminium it
  // presses against rather than by the titanium it is made of — so the tighter of the two
  // ratings governs. See `CONTACT_A_PER_MM2`.
  const tipArea = electrical.perPartA / Math.min(material.ampsPerMm2, CONTACT_A_PER_MM2);

  // A flat spine, three times as wide as it is thick: stiff in the hanging direction, and
  // presenting an edge rather than a face to the rising gas.
  const spineThickness = round1(Math.max(4, Math.sqrt(spineArea / 3)));
  const spineWidth = round1(Math.max(12, spineArea / spineThickness));

  const armThickness = round1(Math.max(2, Math.sqrt(armArea / 3)));
  const armWidth = round1(Math.max(8, armArea / armThickness));

  const tipDia = round1(Math.max(2, 2 * Math.sqrt(tipArea / Math.PI)));

  // The hook sits over the flight bar and carries the whole current through a single contact,
  // so it is sized on the same rating with a margin for that being the one joint nobody can
  // inspect mid-run.
  const hookDia = round1(Math.max(8, 2 * Math.sqrt((spineArea * 1.3) / Math.PI)));

  const rack: RackSpec = {
    partsPerTier,
    tiers,
    partsTotal,
    spineWidthMm: spineWidth,
    spineThicknessMm: spineThickness,
    spineHeightMm: round1(Math.min(usableHeight, tiers * tierPitch + 150)),
    armLengthMm: round1((partsPerTier / 2) * pitch),
    armWidthMm: armWidth,
    armThicknessMm: armThickness,
    tipsPerPart: 1,
    tipDiaMm: tipDia,
    tipLengthMm: round1(Math.max(15, mid * 0.4)),
    hookDiaMm: hookDia,
    pitchMm: round1(pitch),
  };

  // ── heat ──
  // Nearly all the electrical power ends as heat in the bath: the reaction itself is
  // exothermic and the film is a resistor. A Type III bath at 0 °C has to remove all of it and
  // then some, which is why hard anodizing lines are built around their chillers.
  const coolingWatts = electrical.powerW * 0.95;
  // Litres per minute to hold a 3 °C rise across the load: Q = m·c·ΔT, water c = 4.18 J/g·K.
  const coolingLitresPerMin = (coolingWatts * 60) / (4.18 * 1000 * 3);

  const design: RackDesign = {
    part,
    process,
    material,
    electrical,
    rack,
    thicknessUm,
    coolingWatts,
    coolingLitresPerMin,
    rackLifeRuns: material.runsBeforeStrip,
    checks: [],
    archetypeParams: {
      spineHeight: rack.spineHeightMm,
      spineWidth: rack.spineWidthMm,
      spineThickness: rack.spineThicknessMm,
      tiers: rack.tiers,
      armLength: rack.armLengthMm,
      armWidth: rack.armWidthMm,
      armThickness: rack.armThicknessMm,
      // Parts per arm, one tip each. The rack archetype counts a part per tip, so this is
      // also what makes its own electrical warnings agree with the sizing above instead of
      // reporting a load twice the real one.
      tipsPerArm: Math.max(1, Math.round(partsPerTier / 2)),
      tipLength: rack.tipLengthMm,
      tipDia: rack.tipDiaMm,
      hookDia: rack.hookDiaMm,
      // The measured figure, so the archetype's own electrical warnings are computed from the
      // same current this sizing used rather than from its 8 A placeholder.
      ampsPerPart: round1(electrical.perPartA),
    },
  };

  design.checks = checkRack(design);
  return design;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

// ── quality control ─────────────────────────────────────────────────────────

/**
 * What has to be true for the rack to produce a good batch.
 *
 * Each check names the measurement and the limit rather than asserting a verdict, because
 * every one of these is a trade someone may legitimately decide to make — a shop running
 * 3 A/dm² on a chilled bath is not wrong, they are running hot on purpose and know it.
 */
export function checkRack(design: RackDesign): QualityCheck[] {
  const out: QualityCheck[] = [];
  const { electrical, rack, process, part, material } = design;

  // Contact area. The single most common rack failure: too little metal touching the part, so
  // the contact runs hot, the aluminium under it melts, and the part arcs off the rack.
  const contactArea = Math.PI * (rack.tipDiaMm / 2) ** 2;
  const contactDensity = electrical.perPartA / Math.max(contactArea, 1e-6);
  out.push({
    id: 'contact-current',
    ok: contactDensity <= CONTACT_A_PER_MM2,
    title: 'Current through the contact',
    detail:
      `${electrical.perPartA.toFixed(1)} A through a ⌀${rack.tipDiaMm} mm contact is `
      + `${contactDensity.toFixed(2)} A/mm². Aluminium softens under the contact above about `
      + `${CONTACT_A_PER_MM2} A/mm² and the part arcs off the rack mid-run; open the tip out `
      + 'or carry fewer parts.',
    severity: 'blocker',
  });

  // Contact marks. Every contact leaves an uncoated witness, and on a cosmetic part that is a
  // reject rather than a blemish.
  out.push({
    id: 'contact-marks',
    ok: true,
    title: 'Witness marks',
    detail:
      `One ⌀${rack.tipDiaMm} mm contact leaves one uncoated mark per part, about `
      + `${(Math.PI * (rack.tipDiaMm / 2) ** 2).toFixed(0)} mm². Put it on a face that is `
      + 'hidden in service or machined afterwards; on a cosmetic face it is a reject.',
    severity: 'advisory',
  });

  // Flow. The reason parts are spaced rather than packed.
  const gap = rack.pitchMm - part.sizeMm[1]!;
  out.push({
    id: 'flow',
    ok: gap >= MIN_GAP,
    title: 'Clearance between parts',
    detail:
      `${gap.toFixed(0)} mm of open space between parts. Below ${MIN_GAP} mm the electrolyte `
      + 'does not turn over between them and the inner faces come out patchy and thin.',
    severity: 'warning',
  });

  // The bath has to be able to deliver it.
  out.push({
    id: 'rectifier',
    ok: electrical.currentA <= 3000,
    title: 'Total current',
    detail:
      `${electrical.currentA.toFixed(0)} A at ${process.volts} V — ${(electrical.powerW / 1000).toFixed(1)} kW. `
      + 'Check this against the rectifier before committing to the load; a rack that exceeds it '
      + 'simply runs at lower density and produces a thinner coating than the traveller says.',
    severity: 'warning',
  });

  // Cooling.
  out.push({
    id: 'cooling',
    ok: design.coolingWatts <= 60_000,
    title: 'Heat into the bath',
    detail:
      `${(design.coolingWatts / 1000).toFixed(1)} kW must be removed to hold ${process.bathC} °C, `
      + `about ${design.coolingLitresPerMin.toFixed(0)} L/min of chilled circulation at a 3 °C rise.`
      + (process.bathC <= 5 ? ' A chilled bath is not optional for this process.' : ''),
    severity: 'warning',
  });

  // Spine section, checked rather than assumed — the sizing above is a calculation and this is
  // the assertion that the calculation was applied.
  const spineDensity = electrical.currentA / (rack.spineWidthMm * rack.spineThicknessMm);
  out.push({
    id: 'spine-section',
    ok: spineDensity <= material.ampsPerMm2 * 1.02,
    title: 'Spine section',
    detail:
      `${rack.spineWidthMm} × ${rack.spineThicknessMm} mm carries ${electrical.currentA.toFixed(0)} A `
      + `at ${spineDensity.toFixed(2)} A/mm². ${material.name} is rated `
      + `${material.ampsPerMm2} A/mm² continuous in a bath.`,
    severity: 'blocker',
  });

  // Dimensional consequence of the coating, which is what a machinist needs to hear.
  out.push({
    id: 'growth',
    ok: true,
    title: 'Size after coating',
    detail:
      `A ${design.thicknessUm.toFixed(0)} µm coating grows ${electrical.growthUm.toFixed(1)} µm `
      + `outward per surface, so an external dimension gains ${(electrical.growthUm * 2).toFixed(1)} µm `
      + `and a bore loses ${electrical.boreLossUm.toFixed(1)} µm on diameter. Mask threads and `
      + 'bearing fits, or machine them after.',
    severity: 'advisory',
  });

  // Rack life.
  out.push({
    id: 'rack-life',
    ok: true,
    title: 'Rack life',
    detail:
      `Strip and re-etch after about ${material.runsBeforeStrip} run`
      + `${material.runsBeforeStrip === 1 ? '' : 's'}. ${material.basis}`,
    severity: 'advisory',
  });

  return out;
}

/** A one-paragraph summary for the transcript. Numbers first, because they are the answer. */
export function describeRack(design: RackDesign): string {
  const { rack, electrical, part, process } = design;
  const blockers = design.checks.filter((c) => !c.ok && c.severity === 'blocker');

  return [
    `${rack.partsTotal} parts (${rack.partsPerTier} across ${rack.tiers} tiers) at `
    + `${part.areaDm2.toFixed(2)} dm² each.`,
    `${electrical.currentA.toFixed(0)} A total at ${process.currentDensityAdm2} A/dm², `
    + `${electrical.minutes.toFixed(0)} min for ${design.thicknessUm.toFixed(0)} µm.`,
    `Spine ${rack.spineWidthMm} × ${rack.spineThicknessMm} mm, arms `
    + `${rack.armWidthMm} × ${rack.armThicknessMm} mm, ⌀${rack.tipDiaMm} mm contacts.`,
    `${(design.coolingWatts / 1000).toFixed(1)} kW of cooling.`,
    blockers.length > 0
      ? `${blockers.length} blocker${blockers.length === 1 ? '' : 's'}: ${blockers.map((b) => b.title).join(', ')}.`
      : 'No blockers.',
  ].join(' ');
}

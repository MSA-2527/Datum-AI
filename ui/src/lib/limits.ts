/**
 * Manufacturing limits, as data.
 *
 * These numbers were already in the product — spread through `dfm.ts` and `dfmPacks.ts` as
 * literals inside the checks that enforce them. That was fine while checking was the only
 * thing done with them. It stops being fine the moment they are also *stated* to a planner,
 * because a limit written down twice is a limit that will eventually disagree with itself,
 * and a prompt promising a 2 mm minimum wall while the linter enforces 0.8 mm is worse than
 * a prompt that says nothing: it teaches the model a rule the product will not back up.
 *
 * So every threshold lives here once. The checkers import the constants; the planner brief
 * is rendered from the same constants. `limits.test.ts` asserts that the two sets of rule ids
 * are identical in both directions, which is what stops a new rule from being enforced and
 * never mentioned, or mentioned and never enforced.
 *
 * **Why state them before generating rather than only checking after.** Verification stays
 * exactly as it was — it is the thing that makes the output trustworthy and nothing here
 * replaces it. But a plan that has to be corrected costs a round trip the user waits for and
 * pays for, and a repair loop is a worse way to learn "walls are at least 1 mm" than being
 * told so first. The rules that survive as *constraints* are the ones a designer could have
 * honoured while drawing; the rest stay purely as findings.
 */

export type ProcessId = 'mill' | 'laser' | 'sheet' | 'additive' | 'moulding';

// ── the numbers ──────────────────────────────────────────────────────────────

/** 3-axis milling of prismatic parts. */
export const MILL = {
  /** Below this a wall chatters and deflects away from the cutter. */
  minWallMm: 0.8,
  /** What to design to, rather than the edge of what is possible. */
  recommendedWallMm: 1.0,
  loadBearingWallMm: 1.5,
  /** Length ÷ thickness beyond which a plate bows off the fixture. */
  maxPlateAspect: 40,
} as const;

/** Drilling, and the tools a shop actually holds. */
export const DRILL = {
  /** Depth ÷ diameter beyond which a standard drill wanders and packs with chips. */
  maxDepthRatio: 10,
  /** Past this a peck cycle is needed, roughly doubling drilling time. */
  peckDepthRatio: 4,
  /** Material beside a hole, as a fraction of its diameter. */
  edgeDistanceRatio: 0.5,
  /** Metric stock drills. A diameter off this list means reaming or a custom tool. */
  standardSizesMm: [
    1.5, 2, 2.5, 2.9, 3, 3.3, 3.4, 4, 4.2, 4.5, 5, 5.5, 6, 6.6, 6.8, 7, 8, 8.5, 9, 10, 10.5,
    11, 12, 13, 14, 16, 18, 20,
  ],
  /** A diameter within this of a stock size counts as that size. */
  sizeToleranceMm: 0.05,
} as const;

export const TOOLING = {
  /** Distinct hole diameters before tool changes start to dominate. */
  maxDistinctHoleSizes: 3,
} as const;

export const LASER = {
  /** Above this the kerf tapers badly and edge quality collapses. */
  maxThicknessMm: 20,
} as const;

export const SHEET = {
  /** Inside bend radius as a fraction of thickness, below which the outer fibre cracks. */
  minBendRadiusRatio: 0.8,
  /** Hole-to-bend clearance is this many thicknesses, plus the bend radius. */
  holeToBendThicknesses: 2.5,
  /** A flange must be this many thicknesses, plus the radius, to be gripped by the brake. */
  minFlangeThicknesses: 4,
  /** A sheet part is cut from one sheet; wall and sheet thickness may differ by no more. */
  thicknessToleranceMm: 0.01,
} as const;

export const ADDITIVE = {
  /** The thinnest printable wall, in nozzle diameters. */
  minWallNozzles: 2,
  /** Below this many nozzle diameters a hole closes in and prints undersize. */
  minHoleNozzles: 4,
  /** Footprint ÷ thickness beyond which a flat print lifts at the corners. */
  maxFlatAspect: 60,
} as const;

export const MOULDING = {
  /** Degrees per side. Less than this and the part drags on the tool during ejection. */
  minDraftDeg: 0.5,
  /** What to design to; a textured face needs it. */
  recommendedDraftDeg: 1,
  /** A section may exceed the nominal wall by this fraction before it sinks. */
  maxWallVariation: 0.25,
  /** Internal radius as a fraction of the wall, below which corners crack in service. */
  minCornerRadiusRatio: 0.25,
  /** What to design a corner to. */
  recommendedCornerRadiusRatio: 0.5,
  /** A rib below this fraction of its wall freezes off before the cavity fills. */
  minRibProportion: 0.6,
} as const;

// ── the limits, in words ─────────────────────────────────────────────────────

export interface Limit {
  /**
   * The rule id the checker reports.
   *
   * The join between a sentence in a prompt and a finding on a card. When the linter says
   * `dfm.hole.edge-distance`, this is the entry that told the planner about it.
   */
  rule: string;
  process: ProcessId;
  severity: 'blocker' | 'warning' | 'advisory';
  /** What must hold, as an instruction, with the number resolved. */
  requirement: string;
  /** Why the physics says so. Stated because a limit an engineer cannot evaluate is one they will override. */
  basis: string;
  /**
   * Whether this belongs in a planner brief.
   *
   * False for findings that are not design constraints — a note about how slowly stainless
   * cuts is real and useful *after* a part exists, and is noise in a list of rules to design
   * against.
   */
  brief: boolean;
}

const list = (values: readonly number[]) => values.join(', ');

export const LIMITS: Limit[] = [
  // ── milling ──
  {
    rule: 'dfm.mill.min-wall',
    process: 'mill',
    severity: 'blocker',
    requirement: `Walls are at least ${MILL.recommendedWallMm} mm, and ${MILL.loadBearingWallMm} mm where they carry load. Below ${MILL.minWallMm} mm is not machinable.`,
    basis: 'Thin walls chatter and deflect away from the cutter in aluminium, and will not hold tolerance in steel at all.',
    brief: true,
  },
  {
    rule: 'dfm.mill.internal-radius',
    process: 'mill',
    severity: 'blocker',
    requirement: 'Internal corners and slot ends carry a radius of at least half the smallest cutter the shop runs.',
    basis: 'A milled internal corner can never be sharper than the tool that cut it.',
    brief: true,
  },
  {
    rule: 'dfm.part.aspect-ratio',
    process: 'mill',
    severity: 'warning',
    requirement: `A plate is no more than ${MILL.maxPlateAspect}× longer than it is thick.`,
    basis: 'Thin plates relieve rolling stress when machined and bow off the fixture; flatness drifts after the first side is cut.',
    brief: true,
  },
  {
    rule: 'dfm.material.machinability',
    process: 'mill',
    severity: 'advisory',
    requirement: 'Prefer aluminium where the application allows it.',
    basis: 'Stainless removes at roughly a fifth the rate; on a part with much material to clear, the choice of material dominates cost rather than the geometry.',
    brief: false,
  },

  // ── drilling ──
  {
    rule: 'dfm.drill.depth-ratio',
    process: 'mill',
    severity: 'blocker',
    requirement: `A hole is no deeper than ${DRILL.maxDepthRatio}× its diameter, and preferably no deeper than ${DRILL.peckDepthRatio}×.`,
    basis: `Beyond ${DRILL.maxDepthRatio}× a standard drill wanders and packs with chips; past ${DRILL.peckDepthRatio}× it needs a peck cycle that roughly doubles drilling time.`,
    brief: true,
  },
  {
    rule: 'dfm.hole.edge-distance',
    process: 'mill',
    severity: 'warning',
    requirement: `At least half a diameter of material (${DRILL.edgeDistanceRatio}× the hole) is left between a hole and the nearest edge.`,
    basis: 'Less than that risks breakout during drilling and tears out under load.',
    brief: true,
  },
  {
    rule: 'dfm.hole.off-part',
    process: 'mill',
    severity: 'blocker',
    requirement: 'Every hole lies wholly inside the outline of the part it goes through.',
    basis: 'A hole that breaches the edge is not a hole; it is a slot the design did not ask for.',
    brief: true,
  },
  {
    rule: 'dfm.drill.standard-size',
    process: 'mill',
    severity: 'advisory',
    requirement: `Hole diameters come from the stock drill list: ${list(DRILL.standardSizesMm)} mm.`,
    basis: 'Anything else means the shop reams to size or orders a custom tool.',
    brief: true,
  },
  {
    rule: 'dfm.tooling.variety',
    process: 'mill',
    severity: 'advisory',
    requirement: `Use no more than ${TOOLING.maxDistinctHoleSizes} distinct hole diameters on one part.`,
    basis: 'Each distinct size is another tool change and another tool to stock. Repeats of one size are free.',
    brief: true,
  },
  {
    rule: 'dfm.metadata.required',
    process: 'mill',
    severity: 'warning',
    requirement: 'Part number, revision and description are set before release.',
    basis: 'Suppliers reject quote packages missing identity fields, usually after a day of silence.',
    brief: false,
  },

  // ── laser ──
  {
    rule: 'dfm.laser.max-thickness',
    process: 'laser',
    severity: 'blocker',
    requirement: `Laser-cut material is no thicker than ${LASER.maxThicknessMm} mm.`,
    basis: 'Above roughly that, in aluminium, the kerf tapers badly and edge quality collapses. Thicker parts go to waterjet or milling.',
    brief: true,
  },

  // ── sheet metal ──
  {
    rule: 'dfm.sheet.uniform-thickness',
    process: 'sheet',
    severity: 'blocker',
    requirement: 'Every wall of a sheet-metal part is the same thickness as the sheet.',
    basis: 'The part is cut from a single sheet; it cannot be thicker anywhere.',
    brief: true,
  },
  {
    rule: 'dfm.sheet.min-bend-radius',
    process: 'sheet',
    severity: 'blocker',
    requirement: `Inside bend radius is at least the material thickness, and never below ${SHEET.minBendRadiusRatio}× it.`,
    basis: 'Bending tighter stretches the outer fibre past its elongation limit: aluminium cracks, steel thins and springs unpredictably.',
    brief: true,
  },
  {
    rule: 'dfm.sheet.hole-to-bend',
    process: 'sheet',
    severity: 'warning',
    requirement: `A hole is kept at least ${SHEET.holeToBendThicknesses}× thickness plus the bend radius away from a bend line.`,
    basis: 'A hole inside the bend zone draws into an oval as the material forms, and will not be round afterwards.',
    brief: true,
  },
  {
    rule: 'dfm.sheet.min-flange',
    process: 'sheet',
    severity: 'warning',
    requirement: `A flange is at least ${SHEET.minFlangeThicknesses}× thickness plus the bend radius.`,
    basis: 'Anything shorter cannot be gripped by the press-brake tooling: it slips during forming and the bend angle drifts.',
    brief: true,
  },

  // ── additive ──
  {
    rule: 'dfm.additive.min-wall',
    process: 'additive',
    severity: 'blocker',
    requirement: `Walls are at least ${ADDITIVE.minWallNozzles} nozzle diameters thick — 0.8 mm on a standard 0.4 mm nozzle.`,
    basis: 'Thinner than two extrusion widths the wall has no interior, and the slicer produces a single unbonded bead that peels apart.',
    brief: true,
  },
  {
    rule: 'dfm.additive.min-hole',
    process: 'additive',
    severity: 'warning',
    requirement: `Printed holes are at least ${ADDITIVE.minHoleNozzles} nozzle diameters across — 1.6 mm on a 0.4 mm nozzle.`,
    basis: 'Below that, bead overlap closes the hole in; expect it 0.2–0.4 mm undersize and needing a drill.',
    brief: true,
  },
  {
    rule: 'dfm.additive.warp-risk',
    process: 'additive',
    severity: 'warning',
    requirement: `A printed part's footprint is no more than ${ADDITIVE.maxFlatAspect}× its thickness.`,
    basis: 'Wide thin prints shrink unevenly as they cool and peel off the bed; the first layer is where it fails.',
    brief: true,
  },
  {
    rule: 'dfm.additive.trapped-cavity',
    process: 'additive',
    severity: 'blocker',
    requirement: 'Any enclosed cavity in a printed part has at least one drain or escape hole.',
    basis: 'A sealed cavity traps uncured resin or support material with no way to remove it, and on SLA builds pressure until a wall blows out.',
    brief: true,
  },

  // ── injection moulding ──
  {
    rule: 'dfm.mould.draft',
    process: 'moulding',
    severity: 'blocker',
    requirement: `Every vertical face carries at least ${MOULDING.recommendedDraftDeg}° of draft per side, and never less than ${MOULDING.minDraftDeg}°.`,
    basis: 'Without draft the part drags against the tool steel on ejection and scores. A textured face needs the full degree.',
    brief: true,
  },
  {
    rule: 'dfm.mould.wall-variation',
    process: 'moulding',
    severity: 'warning',
    requirement: `Wall thickness stays within ±${MOULDING.maxWallVariation * 100}% of the nominal wall throughout.`,
    basis: 'Thick sections solidify last and pull material from the surface as they shrink, leaving a sink mark, and they extend cycle time disproportionately.',
    brief: true,
  },
  {
    rule: 'dfm.mould.corner-radius',
    process: 'moulding',
    severity: 'warning',
    requirement: `Internal corners are radiused to at least ${MOULDING.recommendedCornerRadiusRatio}× the wall, never below ${MOULDING.minCornerRadiusRatio}×.`,
    basis: 'Sharper radii concentrate stress and choke melt flow; parts crack at the corner in service.',
    brief: true,
  },
  {
    rule: 'dfm.mould.rib-proportion',
    process: 'moulding',
    severity: 'warning',
    requirement: `Ribs are 50–${MOULDING.minRibProportion * 100}% of the wall they attach to.`,
    basis: 'Thicker sinks; thinner freezes off before the cavity fills, leaving a short shot.',
    brief: true,
  },
];

// ── rendering the brief ──────────────────────────────────────────────────────

const PROCESS_LABEL: Record<ProcessId, string> = {
  mill: 'Machined (3-axis milling) — assume this unless the request says otherwise',
  laser: 'Laser cut',
  sheet: 'Sheet metal',
  additive: '3D printed',
  moulding: 'Injection moulded',
};

const ORDER: ProcessId[] = ['mill', 'laser', 'sheet', 'additive', 'moulding'];

/**
 * The limits as a block of prompt text.
 *
 * Grouped by process and led by milling, because that is what an unqualified request means
 * and a model reads a prompt in order. The others are included rather than filtered to the
 * one process in play: at the moment a request is read there is no part yet and so no process
 * selected, and "a 3D printed bracket" has to be answerable.
 *
 * Each line carries its reason. A rule given without one is a rule the model will trade away
 * the moment it conflicts with something else in the prompt — and unlike a person, it will
 * not say that it did.
 */
export function constraintBrief(processes: ProcessId[] = ORDER): string {
  const wanted = ORDER.filter((p) => processes.includes(p));
  const sections: string[] = [];

  for (const process of wanted) {
    const rules = LIMITS.filter((l) => l.brief && l.process === process);
    if (rules.length === 0) continue;

    sections.push(
      `${PROCESS_LABEL[process]}:\n` +
      rules.map((l) => `- ${l.requirement} (${l.basis})`).join('\n'),
    );
  }

  if (sections.length === 0) return '';

  return `MANUFACTURING LIMITS — a design that breaches one of these is reported as a defect
after it is built, so honour them while choosing dimensions rather than being corrected
afterwards. Where a request explicitly asks for something outside a limit, follow the
request and say in "notes" which limit it breaches and why.

${sections.join('\n\n')}`;
}

/** Every rule id the brief speaks about, for the parity test against the checkers. */
export function briefedRules(): string[] {
  return LIMITS.filter((l) => l.brief).map((l) => l.rule);
}

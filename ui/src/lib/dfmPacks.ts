import type { DfmFinding } from './dfm';
import type { Geometry, PartDoc } from './partModel';
import { ADDITIVE, MOULDING, SHEET } from './limits';

/**
 * Process-specific manufacturability rule packs.
 *
 * Spec §17 names four process families; CNC lives in dfm.ts, and these are the other
 * three. Each rule states the physics rather than just asserting a limit, because a
 * finding an engineer cannot evaluate is a finding they will disable.
 *
 * The numbers are conservative industry practice, not vendor-specific. Where a limit is
 * genuinely material- or machine-dependent it is expressed as a ratio of the part's own
 * thickness, which travels better than an absolute.
 */

// ── sheet metal ──────────────────────────────────────────────────────────────

export interface SheetMetalParams {
  /** Material thickness, mm. */
  t: number;
  /** Inside bend radius, mm. Defaults to 1× thickness — the common shop default. */
  bendRadius: number;
  /** Number of bends in the part, used for flat-pattern feasibility. */
  bendCount: number;
}

// The `doc` parameter is unused by some packs but kept on every signature so the
// dispatcher can call them uniformly, and so a pack can start reading material or
// property data without a breaking change.
export function analyseSheetMetal(
  _doc: PartDoc,
  geom: Geometry,
  p: SheetMetalParams,
): DfmFinding[] {
  const out: DfmFinding[] = [];
  const { t, bendRadius } = p;

  // Bend radius below material thickness cracks the outer fibre on most alloys.
  if (bendRadius < t * SHEET.minBendRadiusRatio) {
    out.push({
      id: 'sm-bend-radius',
      severity: 'blocker',
      rule: 'dfm.sheet.min-bend-radius',
      title: `Inside bend radius ${bendRadius.toFixed(2)} mm is tighter than the material`,
      detail:
        `Bending below roughly ${SHEET.minBendRadiusRatio}× thickness ` +
        `(${(t * SHEET.minBendRadiusRatio).toFixed(2)} mm here) stretches the ` +
        'outer fibre past its elongation limit. Aluminium cracks; steel thins and springs unpredictably.',
      remedy: `Open the inside radius to at least ${t.toFixed(2)} mm.`,
    });
  }

  // Holes too close to a bend distort into ovals as the material draws in.
  const minHoleToBend = t * SHEET.holeToBendThicknesses + bendRadius;
  for (const hole of geom.holes) {
    const toEdge = Math.min(
      geom.L / 2 - Math.abs(hole.x) - hole.d / 2,
      geom.W / 2 - Math.abs(hole.y) - hole.d / 2,
    );
    if (toEdge < minHoleToBend) {
      out.push({
        id: 'sm-hole-to-bend',
        severity: 'warning',
        rule: 'dfm.sheet.hole-to-bend',
        title: `Hole sits ${toEdge.toFixed(1)} mm from the edge, inside the bend zone`,
        detail:
          `A hole within ${minHoleToBend.toFixed(1)} mm (${SHEET.holeToBendThicknesses}t + radius) of a bend line draws into ` +
          'an oval as the material forms. The feature will not be round after bending.',
        remedy: 'Move the hole inboard, or pierce it after forming.',
        costImpact: 15,
      });
      break; // one finding for the pattern
    }
  }

  // A flange shorter than about 4× thickness cannot be gripped by the press brake.
  const minFlange = t * SHEET.minFlangeThicknesses + bendRadius;
  if (Math.min(geom.L, geom.W) < minFlange * 2) {
    out.push({
      id: 'sm-flange-length',
      severity: 'warning',
      rule: 'dfm.sheet.min-flange',
      title: `Part is too narrow for a ${minFlange.toFixed(1)} mm minimum flange`,
      detail:
        `A flange shorter than roughly ${SHEET.minFlangeThicknesses}t + radius cannot be held by the press-brake tooling; ` +
        'it slips during forming and the bend angle drifts.',
      remedy: 'Increase the part width, or form it as two pieces.',
    });
  }

  // Uniform thickness is a hard constraint: sheet metal is cut from one sheet.
  if (geom.shellWall !== null && Math.abs(geom.shellWall - t) > SHEET.thicknessToleranceMm) {
    out.push({
      id: 'sm-thickness',
      severity: 'blocker',
      rule: 'dfm.sheet.uniform-thickness',
      title: 'Wall thickness differs from the sheet thickness',
      detail:
        `A sheet-metal part is cut from a single ${t.toFixed(2)} mm sheet; it cannot have a ` +
        `${geom.shellWall.toFixed(2)} mm wall anywhere.`,
      remedy: 'Set the shell thickness equal to the sheet, or machine the part instead.',
    });
  }

  return out;
}

// ── additive (FDM / SLA) ─────────────────────────────────────────────────────

export interface AdditiveParams {
  /** Nozzle or laser spot diameter, mm. */
  nozzle: number;
  /** Layer height, mm. */
  layer: number;
  /** Maximum unsupported overhang from vertical, degrees. */
  maxOverhang: number;
}

export function analyseAdditive(_doc: PartDoc, geom: Geometry, p: AdditiveParams): DfmFinding[] {
  const out: DfmFinding[] = [];

  // A wall thinner than two extrusion widths has no interior and delaminates.
  const minWall = p.nozzle * ADDITIVE.minWallNozzles;
  if (geom.shellWall !== null && geom.shellWall < minWall) {
    out.push({
      id: 'am-min-wall',
      severity: 'blocker',
      rule: 'dfm.additive.min-wall',
      title: `Wall of ${geom.shellWall.toFixed(2)} mm is below two extrusion widths`,
      detail:
        `With a ${p.nozzle} mm nozzle the thinnest printable wall is about ${minWall.toFixed(2)} mm. ` +
        `Thinner than ${ADDITIVE.minWallNozzles} extrusion widths the slicer produces a single unbonded bead that peels apart.`,
      remedy: `Increase the wall to at least ${minWall.toFixed(2)} mm.`,
    });
  }

  // Small holes print undersize because of elephant-foot and bead overlap.
  for (const hole of geom.holes) {
    if (hole.d < p.nozzle * ADDITIVE.minHoleNozzles) {
      out.push({
        id: 'am-small-hole',
        severity: 'warning',
        rule: 'dfm.additive.min-hole',
        title: `⌀${hole.d.toFixed(1)} mm hole will print undersize`,
        detail:
          `Below roughly ${ADDITIVE.minHoleNozzles} nozzle diameters, bead overlap closes the hole in. Expect it to ` +
          'come out 0.2–0.4 mm small and need drilling.',
        remedy: `Increase to ⌀${(p.nozzle * ADDITIVE.minHoleNozzles).toFixed(1)} mm, or plan to ream after printing.`,
        costImpact: 6,
      });
      break;
    }
  }

  // A flat plate is fine; a tall thin one warps off the bed.
  const aspect = Math.max(geom.L, geom.W) / Math.max(geom.T, 0.01);
  if (aspect > ADDITIVE.maxFlatAspect) {
    out.push({
      id: 'am-warp',
      severity: 'warning',
      rule: 'dfm.additive.warp-risk',
      title: `Large flat area (${aspect.toFixed(0)}:1) will lift at the corners`,
      detail:
        'Wide thin prints shrink unevenly as they cool and peel off the bed. The first layer ' +
        'is where it fails.',
      remedy: 'Add a brim, print in a heated chamber, or split the part.',
      costImpact: 10,
    });
  }

  // A shelled part with no opening traps support material forever.
  if (geom.shellWall !== null && geom.cuts.length === 0) {
    out.push({
      id: 'am-trapped',
      severity: 'blocker',
      rule: 'dfm.additive.trapped-cavity',
      title: 'Shelled part has no opening',
      detail:
        'A fully enclosed cavity traps uncured resin or support material with no way to remove it. ' +
        'On SLA it will also build pressure and blow out a wall.',
      remedy: 'Add at least one drain or escape hole.',
    });
  }

  return out;
}

// ── injection moulding ───────────────────────────────────────────────────────

export interface MouldingParams {
  /** Nominal wall thickness, mm. */
  nominalWall: number;
  /** Draft angle per side, degrees. */
  draft: number;
}

export function analyseMoulding(_doc: PartDoc, geom: Geometry, p: MouldingParams): DfmFinding[] {
  const out: DfmFinding[] = [];

  // No draft means the part cannot leave the tool without scoring.
  if (p.draft < MOULDING.minDraftDeg) {
    out.push({
      id: 'im-draft',
      severity: 'blocker',
      rule: 'dfm.mould.draft',
      title: `Draft of ${p.draft.toFixed(1)}° is insufficient to eject the part`,
      detail:
        `A moulded face needs at least ${MOULDING.minDraftDeg}° per side — ${MOULDING.recommendedDraftDeg}° for a textured face — or it drags ` +
        'against the tool steel on ejection and scores.',
      remedy: `Add ${MOULDING.recommendedDraftDeg}° draft to all vertical faces.`,
    });
  }

  // Thick sections cool last and sink; the rule of thumb is ±25% of nominal.
  if (geom.T > p.nominalWall * (1 + MOULDING.maxWallVariation)) {
    out.push({
      id: 'im-thick',
      severity: 'warning',
      rule: 'dfm.mould.wall-variation',
      title: `Section of ${geom.T.toFixed(1)} mm exceeds the ${p.nominalWall.toFixed(1)} mm nominal wall`,
      detail:
        'Thick sections are the last to solidify. They pull material from the surface as they ' +
        'shrink, leaving a visible sink mark, and they extend cycle time disproportionately.',
      remedy: 'Core out the thick section, or add ribs instead of solid material.',
      costImpact: 30,
    });
  }

  // Sharp internal corners concentrate stress and resist flow.
  if (geom.cornerR > 0 && geom.cornerR < p.nominalWall * MOULDING.minCornerRadiusRatio) {
    out.push({
      id: 'im-corner',
      severity: 'warning',
      rule: 'dfm.mould.corner-radius',
      title: `Corner radius ${geom.cornerR.toFixed(2)} mm is sharp for a ${p.nominalWall} mm wall`,
      detail:
        'Internal radii below about a quarter of the wall concentrate stress and choke melt flow. ' +
        'Parts crack at the corner in service.',
      remedy: `Increase to at least ${(p.nominalWall * MOULDING.recommendedCornerRadiusRatio).toFixed(2)} mm.`,
    });
  }

  // A slot whose walls are thinner than the nominal wall will not fill.
  if (geom.slot && geom.slot.h < p.nominalWall * MOULDING.minRibProportion) {
    out.push({
      id: 'im-thin-rib',
      severity: 'warning',
      rule: 'dfm.mould.rib-proportion',
      title: `Feature ${geom.slot.h.toFixed(1)} mm wide is below ${MOULDING.minRibProportion * 100}% of the nominal wall`,
      detail:
        'Thin features freeze off before the cavity fills, leaving a short shot. Ribs should be ' +
        '50–60% of the wall they attach to — thicker sinks, thinner will not fill.',
      remedy: `Widen to about ${(p.nominalWall * MOULDING.minRibProportion).toFixed(1)} mm.`,
    });
  }

  return out;
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export type ProcessPack = 'sheet' | 'additive' | 'moulding';

export const PACK_DEFAULTS = {
  sheet: { t: 1.5, bendRadius: 1.5, bendCount: 4 } as SheetMetalParams,
  additive: { nozzle: 0.4, layer: 0.2, maxOverhang: 45 } as AdditiveParams,
  moulding: { nominalWall: 2.5, draft: 1 } as MouldingParams,
};

export function analysePack(
  pack: ProcessPack,
  doc: PartDoc,
  geom: Geometry,
): DfmFinding[] {
  switch (pack) {
    case 'sheet':
      // Sheet thickness is the part thickness; the shop bends what you give them.
      return analyseSheetMetal(doc, geom, {
        ...PACK_DEFAULTS.sheet,
        t: geom.T,
        bendRadius: Math.max(geom.T, PACK_DEFAULTS.sheet.bendRadius),
      });
    case 'additive':
      return analyseAdditive(doc, geom, PACK_DEFAULTS.additive);
    case 'moulding':
      return analyseMoulding(doc, geom, { ...PACK_DEFAULTS.moulding, nominalWall: geom.T });
    default:
      return [];
  }
}

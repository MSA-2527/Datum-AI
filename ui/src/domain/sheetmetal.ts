/**
 * Sheet metal: bends, flanges and the flat pattern they come from.
 *
 * Perhaps a third of all mechanical parts are folded from sheet, and none of them could be
 * modelled here. It is not a variation on solid modelling — it is a different discipline, and
 * the thing that makes it one is the flat pattern. A sheet part exists twice: as the folded
 * shape it becomes, and as the blank a laser cuts. Those two are related by how much the
 * material stretches round each bend, and getting that relation wrong is the commonest and most
 * expensive mistake in the trade — the part comes back the wrong length and the whole batch is
 * scrap.
 *
 * So the bend allowance is the centre of this file rather than an afterthought. Everything else
 * is geometry built on top of it.
 */

/**
 * How far the neutral axis sits through the thickness, as a fraction.
 *
 * The outside of a bend stretches and the inside compresses; somewhere between them is a layer
 * that does neither, and the flat length is measured along it. Where that layer sits depends on
 * the material, the tooling and how tight the bend is — 0.44 is the usual starting figure for
 * mild steel on a sharp punch, and a shop with its own press will have measured its own.
 *
 * Offered as a number rather than hidden, because it is the one figure a fabricator will want to
 * change and the one that decides whether the part comes back right.
 */
export const DEFAULT_K = 0.44;

export interface Bend {
  /** Included angle turned through, degrees. 90 is a right-angle flange. */
  angle: number;
  /** Inside radius of the bend, mm. */
  radius: number;
  /** Distance from the start of the part to this bend, along the flat. */
  at: number;
}

export interface SheetSpec {
  thickness: number;
  kFactor: number;
  bends: Bend[];
  /** Straight lengths between and beyond the bends, mm. */
  flats: number[];
}

/**
 * Bend allowance: the length of material consumed by one bend, measured along the neutral axis.
 *
 * `BA = angle × (radius + K × thickness)`, with the angle in radians. This is the whole of sheet
 * metal in one line — the arc length of the layer that neither stretches nor compresses.
 */
export function bendAllowance(angle: number, radius: number, thickness: number, k: number): number {
  return (Math.abs(angle) * Math.PI / 180) * (radius + k * thickness);
}

/**
 * Bend deduction: how much shorter the blank is than the sum of the outside dimensions.
 *
 * Fabricators work in outside dimensions because that is what a drawing shows and what calipers
 * measure, so the deduction is the number a press operator actually wants. It is the difference
 * between going round the outside of the corner and going round the neutral axis.
 */
export function bendDeduction(angle: number, radius: number, thickness: number, k: number): number {
  const a = Math.abs(angle) * Math.PI / 180;
  const setback = (radius + thickness) * Math.tan(a / 2);
  return 2 * setback - bendAllowance(angle, radius, thickness, k);
}

export interface FlatPattern {
  /** Total developed length of the blank, mm. */
  length: number;
  /** Where each bend line falls on the blank, from one end. */
  bendLines: { at: number; angle: number; radius: number }[];
  /** Sum of the outside dimensions, for comparison. */
  outsideLength: number;
  /** How much shorter the blank is than the outside dimensions. */
  totalDeduction: number;
}

/**
 * The flat blank for a folded part.
 *
 * The sum of the flats plus the allowance for each bend. Bend lines are reported at their
 * position *on the blank*, which is not where they are on the folded part — that difference is
 * exactly what a press operator needs and what nobody can work out by looking at the model.
 */
export function flatPattern(spec: SheetSpec): FlatPattern {
  const { thickness, kFactor, bends, flats } = spec;

  let length = 0;
  const bendLines: { at: number; angle: number; radius: number }[] = [];

  for (let i = 0; i < flats.length; i++) {
    length += Math.max(0, flats[i] ?? 0);

    const bend = bends[i];
    if (!bend) continue;

    // The bend line is placed at the *middle* of the allowance, which is where the tooling
    // centres on the blank.
    const allowance = bendAllowance(bend.angle, bend.radius, thickness, kFactor);
    bendLines.push({ at: length + allowance / 2, angle: bend.angle, radius: bend.radius });
    length += allowance;
  }

  const outsideLength = flats.reduce((s, f) => s + Math.max(0, f), 0)
    + bends.reduce((s, b) => s + 2 * (b.radius + thickness) * Math.tan(Math.abs(b.angle) * Math.PI / 360), 0);

  return {
    length,
    bendLines,
    outsideLength,
    totalDeduction: outsideLength - length,
  };
}

export interface SheetCheck {
  ok: boolean;
  problem: string;
  fix: string;
}

/**
 * What a press brake will and will not do.
 *
 * Every one of these is a part that models perfectly and cannot be made. They are the checks a
 * fabricator would raise on the drawing, moved to where the part is being drawn — which is the
 * only place they are cheap to act on.
 */
export function checkSheet(spec: SheetSpec, material = 'steel'): SheetCheck[] {
  const out: SheetCheck[] = [];
  const t = spec.thickness;

  // Minimum inside radius. Bend tighter than this and the outside fibre cracks; how much
  // tighter depends on the alloy and the grain direction.
  const minRatio = /alumin/i.test(material) ? 1.0 : /stainless/i.test(material) ? 0.8 : 0.5;
  const minRadius = t * minRatio;

  for (const bend of spec.bends) {
    if (bend.radius < minRadius - 1e-9) {
      out.push({
        ok: false,
        problem: `A ${bend.radius} mm inside radius on ${t} mm ${material} is tighter than the `
          + `material will take.`,
        fix: `Use at least ${minRadius.toFixed(1)} mm — ${minRatio}× the thickness for this material.`,
      });
    }
  }

  // Minimum flange. A flange shorter than this cannot be held by the tooling, so the press
  // cannot form it at all.
  const minFlange = t * 4;
  spec.flats.forEach((flat, i) => {
    if (flat > 0 && flat < minFlange) {
      out.push({
        ok: false,
        problem: `Flange ${i + 1} is ${flat} mm, which the tooling cannot grip.`,
        fix: `Make it at least ${minFlange.toFixed(1)} mm — four times the thickness.`,
      });
    }
  });

  if (spec.kFactor <= 0 || spec.kFactor >= 0.5) {
    out.push({
      ok: false,
      problem: `A K factor of ${spec.kFactor} is outside anything physical.`,
      fix: 'The neutral axis lies between the inside face and the middle, so K is between 0 and 0.5.',
    });
  }

  return out;
}

/**
 * A right-angle flange as a set of flats and bends, which is what most sheet parts are.
 *
 * A convenience over building the spec by hand, and the shape people mean when they say
 * "bracket": a base, a bend, and a leg standing off it.
 */
export function angleBracket(
  base: number, leg: number, thickness: number, radius = thickness, k = DEFAULT_K,
): SheetSpec {
  return {
    thickness,
    kFactor: k,
    flats: [base, leg],
    bends: [{ angle: 90, radius, at: base }],
  };
}

/** A U-channel: two bends, three flats. */
export function channel(
  web: number, flange: number, thickness: number, radius = thickness, k = DEFAULT_K,
): SheetSpec {
  return {
    thickness,
    kFactor: k,
    flats: [flange, web, flange],
    bends: [
      { angle: 90, radius, at: flange },
      { angle: 90, radius, at: flange + web },
    ],
  };
}

/** One line per fact, for the panel that shows a flat pattern. */
export function describeFlat(spec: SheetSpec, pattern: FlatPattern): string[] {
  const lines = [
    `Blank ${pattern.length.toFixed(1)} mm long, ${spec.thickness} mm thick.`,
    `${pattern.bendLines.length} bend${pattern.bendLines.length === 1 ? '' : 's'} at `
      + pattern.bendLines.map((b) => `${b.at.toFixed(1)} mm`).join(', ') + '.',
  ];

  if (Math.abs(pattern.totalDeduction) > 0.01) {
    lines.push(
      `${pattern.totalDeduction.toFixed(2)} mm shorter than the outside dimensions add up to — `
      + `that is the bend deduction, at K = ${spec.kFactor}.`,
    );
  }

  return lines;
}

/**
 * What the request actually asked for, and whether the part delivers it.
 *
 * The gap this fills is not subtle. Ask for "a 400 mm long bracket" with no language model
 * configured and the built-in route matched the word "bracket", built the standard one, and
 * handed back something 180 mm long — the number was read, understood, and then thrown away.
 * The only sizing the offline path did was fuzzy: "small" scaled everything by 0.85.
 *
 * So a requirement is treated as a thing in its own right. It is extracted from the request,
 * carried alongside the plan, and *measured against the result*, with each one reported as met
 * or missed. That last step is what makes this reasoning rather than parsing: the answer is
 * checked against the question, and a part that does not meet what was asked for says so
 * instead of looking finished.
 */

import { findMeasures } from '../generate/parse';
import { bounds, type Mesh } from '../kernel/topo/mesh';

export type RequirementKind =
  | 'length' | 'width' | 'height' | 'diameter'
  | 'mass' | 'count' | 'material';

export interface Requirement {
  kind: RequirementKind;
  /** Millimetres for a dimension, grams for a mass, a plain number for a count. */
  value: number;
  /** The words it was read from, so the user can see what was understood. */
  source: string;
  /** Free text for a material, which has no numeric value. */
  text?: string;
}

export interface Check {
  requirement: Requirement;
  met: boolean;
  /** What the part actually came out as, in the requirement's units. */
  actual: number;
  /** How far out, as a proportion. Zero when met exactly. */
  error: number;
  note: string;
}

/** Within this of the asked-for value counts as met. */
const TOLERANCE = 0.02;

const MASS_TO_G: Record<string, number> = {
  g: 1, gram: 1, grams: 1, gramme: 1, grammes: 1,
  kg: 1000, kilo: 1000, kilos: 1000, kilogram: 1000, kilograms: 1000,
  t: 1e6, tonne: 1e6, tonnes: 1e6, ton: 1e6,
  lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592,
  oz: 28.3495, ounce: 28.3495, ounces: 28.3495,
};

/**
 * Words that name a dimension, and how far from the number they may sit.
 *
 * Longest first, so "outside diameter" is not read as "diameter" attached to something else.
 * The window is in characters rather than words because "400mm long" and "400 mm long" and
 * "length of 400 mm" all have to work, and counting words gets a different answer for each.
 */
const DIMENSION_WORDS: { words: string[]; kind: RequirementKind }[] = [
  { words: ['diameter', 'dia', 'across', 'bore'], kind: 'diameter' },
  { words: ['long', 'length'], kind: 'length' },
  { words: ['wide', 'width'], kind: 'width' },
  { words: ['tall', 'high', 'height', 'deep', 'depth', 'thick', 'thickness'], kind: 'height' },
];

/** How close a naming word has to be to the number, in characters. */
const WINDOW = 22;

/**
 * Reads the requirements out of a request.
 *
 * Only what is stated. A request that says nothing about mass produces no mass requirement,
 * and the part is then free on that axis — inventing a default and then checking against it
 * would manufacture failures out of things nobody asked for.
 */
export function readRequirements(text: string): Requirement[] {
  const lower = text.toLowerCase();
  const out: Requirement[] = [];
  const claimed = new Set<number>();

  // Mass first: it shares its numbers with the dimensions, and "2 kg" must not also be read
  // as a length of 2 mm.
  const massAlt = Object.keys(MASS_TO_G).sort((a, b) => b.length - a.length).join('|');
  const massRe = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${massAlt})\\b`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = massRe.exec(lower)) !== null) {
    out.push({
      kind: 'mass',
      value: parseFloat(m[1]!) * (MASS_TO_G[m[2]!.toLowerCase()] ?? 1),
      source: m[0].trim(),
    });
    for (let i = m.index; i < m.index + m[0].length; i++) claimed.add(i);
  }

  /*
   * The material next, and before the dimensions, so its designation is not read as one.
   *
   * "a 400 mm long bracket in 6061" was coming back with a length of 6061 mm: the alloy number
   * is a bare number, "long" sits within the search window before it, and being stated later it
   * won the tie against the 400 that was actually asked for. Claiming the material's characters
   * first takes it out of the running entirely.
   *
   * A capture that is itself a measurement is not a material — "in 25 mm plate" names a
   * thickness, not an alloy — so those are handed back to the dimension pass.
   */
  const material = /\b(?:in|from|made of|out of)\s+([a-z0-9][a-z0-9 -]{2,24}?)\b(?=\s|$|,|\.)/i.exec(text);
  const namesAMeasure = material
    ? /^\d+(?:\.\d+)?\s*(?:mm|cm|m|in|inch|inches|ft|thou)$/i.test(material[1]!.trim())
    : false;

  if (material && !namesAMeasure) {
    out.push({ kind: 'material', value: 0, source: material[0].trim(), text: material[1]!.trim() });
    for (let i = material.index; i < material.index + material[0].length; i++) claimed.add(i);
  }

  for (const measure of findMeasures(text)) {
    if (claimed.has(measure.index)) continue;

    // The naming word may come before the number ("length of 400 mm") or after it
    // ("400 mm long"), so both sides are searched and the nearer one wins.
    const before = lower.slice(Math.max(0, measure.index - WINDOW), measure.index);
    const after = lower.slice(
      measure.index + measure.raw.length,
      measure.index + measure.raw.length + WINDOW,
    );

    let best: { kind: RequirementKind; distance: number } | null = null;

    for (const { words, kind } of DIMENSION_WORDS) {
      for (const word of words) {
        const re = new RegExp(`\\b${word}\\b`);

        const inAfter = after.search(re);
        if (inAfter >= 0 && (!best || inAfter < best.distance)) best = { kind, distance: inAfter };

        const inBefore = before.search(re);
        if (inBefore >= 0) {
          const distance = before.length - inBefore;
          if (!best || distance < best.distance) best = { kind, distance };
        }
      }
    }

    if (best) out.push({ kind: best.kind, value: measure.mm, source: measure.raw });
  }

  const count = /\b(\d+)\s*(?:off|x)\b|\b(\d+)\s+(?:holes|bolts|screws|teeth|slots)\b/i.exec(text);
  if (count) {
    out.push({ kind: 'count', value: parseInt(count[1] ?? count[2] ?? '0', 10), source: count[0].trim() });
  }

  return dedupe(out);
}

/**
 * One requirement per kind.
 *
 * A stated unit beats a bare number, because a bare number is far more often something else
 * that happens to be numeric — an alloy designation, a model number, a quantity. Among two that
 * are equally explicit the later one wins, since restating a dimension is how someone corrects
 * themselves: "200 mm long, no, 300 mm long".
 */
function dedupe(list: Requirement[]): Requirement[] {
  const hasUnit = (r: Requirement) => /[a-z"']/i.test(r.source);
  const byKind = new Map<RequirementKind, Requirement>();

  for (const r of list) {
    const held = byKind.get(r.kind);
    if (held && hasUnit(held) && !hasUnit(r)) continue;
    byKind.set(r.kind, r);
  }

  return [...byKind.values()];
}

/**
 * Measures the built part against each requirement.
 *
 * Dimensions are read off the solid rather than off the parameters that were meant to produce
 * it. That is the whole point: a parameter says what was intended and the mesh says what
 * happened, and the cases worth catching are the ones where they differ.
 *
 * Which measurement each word means is decided in `actualFor` below, and the reasoning for it
 * is there rather than here because it is the part that was got wrong.
 */
export function checkRequirements(
  requirements: Requirement[], mesh: Mesh, massGrams: number, material: string,
): Check[] {
  const box = bounds(mesh);
  const [x, y, z] = [0, 1, 2].map((i) => box.max[i]! - box.min[i]!) as [number, number, number];

  /*
   * Which measurement a word means.
   *
   * By axis, not by sorting the extents largest to smallest. Sorting looks more robust and is
   * wrong about the commonest word of the four: "tall" means the vertical measurement, and on
   * a cup 120 mm tall and 90 mm across the smallest extent is 90. Read that way, a correctly
   * sized cup failed its own requirement and got scaled to 175 mm to fix it.
   *
   * Z is up, which is the convention the whole kernel and every view button already assume, so
   * height is Z. Length and width are the two horizontal ones, larger and smaller — that reads
   * a plate right whichever way round it was drawn, which sorting did get right.
   */
  const actualFor = (kind: RequirementKind): number => {
    switch (kind) {
      case 'height': return z;
      case 'length': return Math.max(x, y);
      case 'width': return Math.min(x, y);
      // A round part's diameter is its span across the axis it was turned about.
      case 'diameter': return Math.max(x, y);
      case 'mass': return massGrams;
      default: return 0;
    }
  };

  return requirements.map((requirement) => {
    if (requirement.kind === 'material') {
      const want = (requirement.text ?? '').toLowerCase();
      const met = material.toLowerCase().includes(want);
      return {
        requirement, met, actual: 0, error: met ? 0 : 1,
        note: met ? `Made in ${material}.` : `Asked for ${requirement.text}, built in ${material}.`,
      };
    }

    if (requirement.kind === 'count') {
      // Counts live in the feature that owns them and cannot be read off a bounding box.
      return { requirement, met: true, actual: requirement.value, error: 0, note: '' };
    }

    const actual = actualFor(requirement.kind);
    const error = requirement.value > 0 ? Math.abs(actual - requirement.value) / requirement.value : 0;
    const met = error <= TOLERANCE;

    const unit = requirement.kind === 'mass' ? 'g' : 'mm';
    return {
      requirement, met, actual, error,
      note: met
        ? `${label(requirement.kind)} ${round(actual)} ${unit}, as asked.`
        : `Asked for ${label(requirement.kind).toLowerCase()} ${round(requirement.value)} ${unit}, ` +
          `built ${round(actual)} ${unit}.`,
    };
  });
}

/**
 * The single factor that would bring the dimensions closest to what was asked.
 *
 * Uniform, not per axis. A recipe's proportions are the part of it that was designed — an
 * airliner stretched only along its length is no longer an airliner — so the scale that best
 * satisfies the stated dimensions while keeping the shape is a least-squares fit in log space,
 * where a factor of two too big and a factor of two too small are the same size of mistake.
 *
 * Returns 1 when nothing dimensional was asked for, which leaves the part exactly as designed.
 */
export function scaleToMeet(checks: Check[]): number {
  const usable = checks.filter(
    (c) => c.actual > 0 && c.requirement.value > 0
      && ['length', 'width', 'height', 'diameter'].includes(c.requirement.kind),
  );
  if (usable.length === 0) return 1;

  let sum = 0;
  for (const c of usable) sum += Math.log(c.requirement.value / c.actual);
  return Math.exp(sum / usable.length);
}

const label = (kind: RequirementKind): string =>
  kind === 'diameter' ? 'Diameter'
    : kind === 'mass' ? 'Mass'
      : kind.charAt(0).toUpperCase() + kind.slice(1);

const round = (v: number): string => (v >= 100 ? v.toFixed(0) : v.toFixed(1));

/** One line per requirement, for the reply. */
export function describeChecks(checks: Check[]): string {
  const notes = checks.map((c) => c.note).filter(Boolean);
  if (notes.length === 0) return '';

  const missed = checks.filter((c) => !c.met);
  if (missed.length === 0) return `Checked against what you asked: ${notes.join(' ')}`;

  return `Checked against what you asked, and ${missed.length} of ` +
    `${checks.length} did not come out right: ${notes.join(' ')}`;
}

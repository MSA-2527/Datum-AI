/**
 * Recovering the third dimension from a one-view drawing.
 *
 * A single orthographic view is, strictly, missing a dimension. But "strictly missing" and
 * "unknowable" are different things, and the previous code treated them as the same: it took
 * a tenth of the smaller plan dimension and said so. That figure is not wrong so much as
 * arbitrary — it has no relationship to the part, and on a 500 mm plate it produced a 50 mm
 * slab nobody would ever cut.
 *
 * Three sources of real information exist, in descending order of authority:
 *
 *  1. **What the drawing says.** Almost every single-view drawing writes the thickness down,
 *     because the drafter knew the view could not carry it. `THK 6`, `t=3`, `6 MM THICK`,
 *     `MATERIAL: 3MM MS`, `PLATE 10`. This is not a guess at all — it is a stated dimension
 *     that was being thrown away with the rest of the text.
 *
 *  2. **What the holes imply.** Clearance holes are drilled for a fastener, fasteners are
 *     chosen for the joint, and the plate has to be thick enough to take the thread. A field
 *     of ⌀5.5 holes is an M5 pattern, and nobody puts M5 through 0.5 mm shim.
 *
 *  3. **What stock exists.** Sheet and plate are not sold as continuous values. Once a
 *     figure is estimated it should be snapped to something a supplier actually stocks,
 *     because the alternative is a model that can never be made from the material it claims.
 *
 * Every path reports which one it used, so the number on screen is never mistaken for a
 * measurement when it was an inference.
 */

/**
 * Reduces MTEXT to its words.
 *
 * MTEXT carries its styling inline: `\fArial|b0;`, `\H2.5x;`, `\P` for a line break. Those
 * codes sit flush against the text, so `NOTES:\PTHK 4` puts a `P` immediately before `THK`
 * and destroys the word boundary every pattern below relies on.
 */
function stripFormatting(raw: string): string {
  return raw
    .replace(/\\[A-Za-z][^;\\]*;/g, ' ')
    .replace(/\\P/g, ' ')
    .replace(/\\~/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Preferred metric flat stock, in millimetres. ISO 4997 / EN 10051 ranges, plus plate. */
const STOCK_MM = [
  0.5, 0.6, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0,
  15.0, 16.0, 20.0, 25.0, 30.0, 40.0, 50.0, 60.0, 80.0, 100.0,
];

/**
 * Metric clearance holes (ISO 273 medium) → the thread they are drilled for.
 *
 * Keyed by the hole, not the thread, because the hole is what the drawing shows.
 */
const CLEARANCE_TO_THREAD: { hole: number; thread: number }[] = [
  { hole: 2.4, thread: 2 }, { hole: 2.9, thread: 2.5 }, { hole: 3.4, thread: 3 },
  { hole: 4.5, thread: 4 }, { hole: 5.5, thread: 5 }, { hole: 6.6, thread: 6 },
  { hole: 9.0, thread: 8 }, { hole: 11.0, thread: 10 }, { hole: 13.5, thread: 12 },
  { hole: 17.5, thread: 16 }, { hole: 22.0, thread: 20 },
];

export type ThicknessSource =
  | 'stated'      // read from the drawing's own text
  | 'fastener'    // inferred from the clearance holes
  | 'proportion'; // last resort, from the plan size

export interface ThicknessEstimate {
  mm: number;
  source: ThicknessSource;
  /** One sentence, for the user, explaining where the number came from. */
  because: string;
  /** True when the figure came from the drawing rather than from a rule. */
  authoritative: boolean;
}

/**
 * Reads a thickness callout out of drawing text.
 *
 * Ordered most-specific first so `THK 6` wins over a bare `6` that happens to sit in the same
 * string. Returns undefined rather than guessing when nothing matches — a wrong "stated"
 * value is far worse than an honest estimate, because it carries authority it has not earned.
 */
export function statedThickness(annotations: string[], toMm = 1): number | undefined {
  // Cleaned here as well as at parse time. The parser strips MTEXT codes on the way in, but
  // this must not depend on that: a caller passing raw strings should still get an answer,
  // and `\PTHK 4` hides the callout behind a paragraph marker that eats the word boundary.
  const texts = annotations.map(stripFormatting);

  const patterns: RegExp[] = [
    // "THK 6", "THK. 6", "THK: 6mm", "THICKNESS 6"
    /\bTHK\.?\s*[:=]?\s*(\d+(?:\.\d+)?)/i,
    /\bTHICK(?:NESS)?\s*[:=]?\s*(\d+(?:\.\d+)?)/i,
    // "6 THK", "6mm THICK", "6 MM THK"
    /(\d+(?:\.\d+)?)\s*(?:MM)?\s*THK\b/i,
    /(\d+(?:\.\d+)?)\s*(?:MM)?\s*THICK\b/i,
    // "t=3", "t 3", "T=3.0"
    /\bT\s*[:=]\s*(\d+(?:\.\d+)?)/i,
    // "PLATE 10", "SHEET 2.5", "MATERIAL: 3MM MS"
    /\b(?:PLATE|SHEET)\s*[:=]?\s*(\d+(?:\.\d+)?)/i,
    /\bMATERIAL\s*[:=]?\s*(\d+(?:\.\d+)?)\s*MM/i,
    // "3MM MS", "6MM SS304" — a bare gauge in front of a material code. No word boundary
    // after the code: grades run straight into digits (SS304, MS1018) and `\b` fails there.
    /\b(\d+(?:\.\d+)?)\s*MM\s+(?:MS|SS|CS|AL|GI)/i,
  ];

  for (const re of patterns) {
    for (const text of texts) {
      const m = re.exec(text);
      if (!m) continue;
      const v = Number(m[1]) * toMm;
      // A stated thickness outside this band is far more likely to be a misparse — a part
      // number, a scale, a quantity — than a real plate.
      if (Number.isFinite(v) && v >= 0.2 && v <= 250) return v;
    }
  }
  return undefined;
}

/**
 * Infers a plate thickness from the clearance holes in it.
 *
 * The rule is the one used at the bench: a bolted joint wants at least the thread's own
 * diameter of engagement, and a plate is normally somewhere between half and one and a half
 * times the bolt size. Taking 0.8 × thread lands mid-range and errs thin, which is the safer
 * direction — too thin is visibly wrong, too thick quietly passes.
 *
 * Only the *smallest* repeated hole is used. A single large bore is a shaft or a cable
 * passage and says nothing about thickness; a repeated small hole is a fixing pattern.
 */
export function fastenerThickness(holeDiametersMm: number[]): { mm: number; thread: number } | undefined {
  if (holeDiametersMm.length === 0) return undefined;

  // Count holes by rounded diameter, so a bolt circle registers as a pattern.
  const counts = new Map<number, number>();
  for (const d of holeDiametersMm) {
    const key = Math.round(d * 10) / 10;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const repeated = [...counts.entries()].filter(([, n]) => n >= 2).map(([d]) => d).sort((a, b) => a - b);
  const candidate = repeated[0];
  if (candidate === undefined) return undefined;

  // Nearest clearance size, but only if it is genuinely close. An arbitrary ⌀7.3 hole is not
  // a fastener hole and should not be forced into being one.
  let best: { hole: number; thread: number } | undefined;
  let bestGap = Infinity;
  for (const c of CLEARANCE_TO_THREAD) {
    const gap = Math.abs(c.hole - candidate);
    if (gap < bestGap) { bestGap = gap; best = c; }
  }
  if (!best || bestGap > 0.6) return undefined;

  return { mm: best.thread * 0.8, thread: best.thread };
}

/** Nearest stocked flat-material thickness. */
export function snapToStock(mm: number): number {
  let best = STOCK_MM[0];
  let bestGap = Infinity;
  for (const s of STOCK_MM) {
    const gap = Math.abs(s - mm);
    if (gap < bestGap) { bestGap = gap; best = s; }
  }
  return best;
}

/**
 * The whole decision, in one place.
 *
 * `planMm` is the smaller of the two plan dimensions — the only thing the old heuristic had.
 */
export function inferThickness(opts: {
  annotations: string[];
  holeDiametersMm: number[];
  planMm: number;
  /** Multiplier from drawing units to millimetres, for a stated value. */
  toMm?: number;
}): ThicknessEstimate {
  const stated = statedThickness(opts.annotations, opts.toMm ?? 1);
  if (stated !== undefined) {
    return {
      mm: stated,
      source: 'stated',
      because: `The drawing states ${stated} mm, so the depth is not a guess.`,
      authoritative: true,
    };
  }

  const fastener = fastenerThickness(opts.holeDiametersMm);
  if (fastener) {
    const snapped = snapToStock(fastener.mm);
    return {
      mm: snapped,
      source: 'fastener',
      because:
        `No thickness is written on the drawing. The repeated holes are M${fastener.thread} ` +
        `clearance, which implies roughly ${fastener.mm.toFixed(1)} mm of plate — taken as ` +
        `${snapped} mm, the nearest stocked size. Set it on the feature if the real plate differs.`,
      authoritative: false,
    };
  }

  const snapped = snapToStock(Math.max(0.5, opts.planMm * 0.1));
  return {
    mm: snapped,
    source: 'proportion',
    because:
      `No thickness is written on the drawing and the holes do not identify a fastener, so ` +
      `${snapped} mm was assumed — the nearest stocked size to a tenth of the smaller plan ` +
      `dimension. This is the one number here that is a guess; set it on the feature.`,
    authoritative: false,
  };
}

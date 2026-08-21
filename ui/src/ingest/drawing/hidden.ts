/**
 * Hidden-detail lines, told apart from the outlines they hide behind.
 *
 * ── Why they have to go ──
 *
 * A draughtsman draws an edge you cannot see as a dashed line. A tracer has no idea it is
 * dashed: it finds each dash as its own little closed contour, and the reconstruction receives a
 * view containing its outline plus forty confetti. Every one of those is material as far as the
 * hull is concerned — so a bore drawn as two hidden lines through a boss becomes two rows of
 * small solid blocks *inside* the part, and a part whose whole point was the bore comes back
 * with the bore filled in and a rash of slivers where it should have been.
 *
 * ── How they are recognised ──
 *
 * Not by being small. A small loop is usually a small hole, and dropping small loops would drop
 * the bolt pattern to save the hidden lines. What identifies a dash is that **it has companions**:
 * dashes come in runs, evenly spaced, along a straight line, all much the same size. One sliver
 * on its own is a slot; five in a row at one pitch is a hidden edge, and nobody draws five
 * identical slots at even spacing along a line and expects them read as solid.
 *
 * That is also why this is safe on a drawing that has none: with nothing in a row, nothing is
 * dropped, and the sheet passes through untouched.
 *
 * ── What it deliberately does not do ──
 *
 * Read line style from the raster. A dashed line in a *vector* file says so in its layer and its
 * linetype, and `dxf.ts` reads that directly — which is better evidence than any of this and is
 * used where it exists. This is for the case where the linetype was thrown away: a scan, a
 * photograph, a screenshot.
 */

import type { Vec2 } from '../../kernel/math/vec';

export interface HiddenDetailResult {
  /** The loops worth reconstructing from. */
  kept: Vec2[][];
  /** The loops taken to be dashes, kept so a caller can say how many and show them. */
  dropped: Vec2[][];
  /** How many runs of dashes were found. */
  runs: number;
}

/** A dash is small: its longest side is under this fraction of the sheet. */
const DASH_MAX = 0.06;

/** And elongated, or at least not obviously a hole. */
const MIN_COMPANIONS = 2;

/**
 * How far off a straight line a companion may sit, as a fraction of the run's own length.
 *
 * Generous, because a scanned drawing is never quite square to the page and a photographed one
 * is never quite flat, so a row of dashes bows slightly. Tight enough that two unrelated small
 * features across a sheet are not read as a run.
 */
const CORRIDOR = 0.08;

/**
 * Separates hidden-detail dashes from real geometry.
 *
 * `extent` is the sheet's larger dimension, in the same units as the loops: the size everything
 * here is judged against, because a dash is small *relative to the drawing* and there is no
 * absolute size that is right for an A4 detail and an A0 general arrangement alike.
 */
export function dropHiddenDetail(loops: Vec2[][], extent: number): HiddenDetailResult {
  if (loops.length < MIN_COMPANIONS + 1 || !(extent > 0)) {
    return { kept: loops, dropped: [], runs: 0 };
  }

  const items = loops.map((loop) => {
    const b = boundsOf(loop);
    return {
      loop,
      centre: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2] as Vec2,
      size: Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]),
    };
  });

  const small = items
    .map((item, i) => ({ ...item, i }))
    .filter((item) => item.size <= extent * DASH_MAX);

  const dropped = new Set<number>();
  let runs = 0;

  for (let a = 0; a < small.length; a++) {
    if (dropped.has(small[a]!.i)) continue;

    for (let b = a + 1; b < small.length; b++) {
      if (dropped.has(small[b]!.i)) continue;

      /*
       * Two dashes propose a line; the rest of the run has to be on it.
       *
       * Taking a pair first and then testing everything else against the line through them is
       * what keeps this from finding runs in noise: a pair is a hypothesis, and it survives only
       * if the drawing actually put more dashes where the hypothesis says they should be.
       */
      const from = small[a]!;
      const to = small[b]!;

      if (!similar(from.size, to.size)) continue;

      const run = [from, to];
      const along = direction(from.centre, to.centre);
      if (!along) continue;

      const span = distance(from.centre, to.centre);

      for (let c = 0; c < small.length; c++) {
        if (c === a || c === b || dropped.has(small[c]!.i)) continue;

        const other = small[c]!;
        if (!similar(other.size, from.size)) continue;
        if (offLine(from.centre, along, other.centre) > Math.max(span, extent * 0.02) * CORRIDOR) {
          continue;
        }
        run.push(other);
      }

      if (run.length >= MIN_COMPANIONS + 1) {
        for (const member of run) dropped.add(member.i);
        runs++;
        break;
      }
    }
  }

  if (dropped.size === 0) return { kept: loops, dropped: [], runs: 0 };

  return {
    kept: loops.filter((_, i) => !dropped.has(i)),
    dropped: loops.filter((_, i) => dropped.has(i)),
    runs,
  };
}

// ── the arithmetic ───────────────────────────────────────────────────────────

/** Two dashes of a run are cut from the same line, so they are near enough the same length. */
function similar(a: number, b: number): boolean {
  const big = Math.max(a, b);
  return big > 0 && Math.abs(a - b) / big < 0.45;
}

function boundsOf(loop: Vec2[]): { min: Vec2; max: Vec2 } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const [x, y] of loop) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

function direction(a: Vec2, b: Vec2): Vec2 | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);

  return len < 1e-9 ? null : [dx / len, dy / len];
}

const distance = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Perpendicular distance from a point to the line through `origin` along `along`. */
function offLine(origin: Vec2, along: Vec2, p: Vec2): number {
  const dx = p[0] - origin[0];
  const dy = p[1] - origin[1];

  return Math.abs(dx * along[1] - dy * along[0]);
}

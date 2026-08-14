/**
 * Reading a finished assembly back and saying what is wrong with it.
 *
 * Generation is one shot: a request goes in, a plan comes out, geometry gets built. Whether
 * that geometry is any *good* is a separate question that nothing was asking. A plan can be
 * schema-valid, build without error, and still put the battery outside the phone.
 *
 * So this is the observe half of a plan–act–observe loop. It reads the built assembly and
 * reports what a person would notice on looking at it: parts floating in space, parts poking
 * out of the envelope the plan itself declared, cuts that remove nothing, components with no
 * volume at all.
 *
 * Every check here is **deterministic and offline**. That is the deliberate part. An agent
 * that asks a language model whether its own work looks right needs a network round trip per
 * iteration, costs money per iteration, and gets a different opinion each time. These are
 * geometric facts: a bounding box either lies inside another or it does not. They run in
 * milliseconds with no provider configured, and they give the *same* answer twice — which is
 * what makes them usable as a repair signal rather than just commentary.
 *
 * What this deliberately does not do is guess at intent. It reports that the camera island
 * protrudes 2 mm beyond the declared envelope; it does not decide whether that is a mistake or
 * a camera bump. Judgement stays with the person, and with the model that can be handed these
 * findings to try again.
 */

import { measureShape, mirrorForInstance, type AssemblyPlan, type ComponentSpec } from '../assembly/plan';

export type Severity = 'error' | 'warning' | 'note';

export interface Critique {
  /** Machine-readable, so a repair prompt can group by kind. */
  kind:
    | 'no-volume'
    | 'outside-envelope'
    | 'floating'
    | 'cut-removes-nothing'
    | 'coincident'
    | 'implausible-scale';
  severity: Severity;
  component: string;
  message: string;
}

/** An axis-aligned box in assembly space. */
interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

// ── where each component sits ────────────────────────────────────────────────

const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * The component's axis-aligned bounding box after placement.
 *
 * Rotation is applied by transforming all eight corners rather than the half-extents, because
 * rotating a box does not give a box: a 45-degree turn makes the enclosing AABB wider by root
 * two, and treating the extents as if they simply swapped axes would under-report the reach of
 * every rotated part — which on a bicycle is both wheels.
 */
function placedBox(c: ComponentSpec): Box | null {
  const { half, centre } = measureShape(c);
  if (half.every((h) => h === 0)) return null;

  const { x, y, z, rx, ry, rz } = c.placement;
  const [cx, sx] = [Math.cos(rad(rx)), Math.sin(rad(rx))];
  const [cy, sy] = [Math.cos(rad(ry)), Math.sin(rad(ry))];
  const [cz, sz] = [Math.cos(rad(rz)), Math.sin(rad(rz))];

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (const ix of [-1, 1]) {
    for (const iy of [-1, 1]) {
      for (const iz of [-1, 1]) {
        // Offset by the shape's own centre before rotating. An archetype that builds upward
        // from its base is not centred on its origin, and treating it as if it were put it
        // half its own height away from where it is.
        let px = centre[0] + ix * half[0];
        let py = centre[1] + iy * half[1];
        let pz = centre[2] + iz * half[2];

        // Z, then Y, then X — the order the document applies them.
        [px, py] = [px * cz - py * sz, px * sz + py * cz];
        [px, pz] = [px * cy + pz * sy, -px * sy + pz * cy];
        [py, pz] = [py * cx - pz * sx, py * sx + pz * cx];

        const world: [number, number, number] = [px + x, py + y, pz + z];
        for (let i = 0; i < 3; i++) {
          if (world[i] < min[i]) min[i] = world[i];
          if (world[i] > max[i]) max[i] = world[i];
        }
      }
    }
  }

  return { min, max };
}

/** True when two boxes share any volume, with a tolerance so touching counts as joined. */
function overlaps(a: Box, b: Box, tol: number): boolean {
  for (let i = 0; i < 3; i++) {
    if (a.min[i] - tol > b.max[i] || b.min[i] - tol > a.max[i]) return false;
  }
  return true;
}

/** The smallest box containing all of them, or nothing when none could be measured. */
function union(parts: (Box | null)[]): Box | null {
  const real = parts.filter((b): b is Box => b !== null);
  if (real.length === 0) return null;

  return {
    min: [0, 1, 2].map((i) => Math.min(...real.map((b) => b.min[i]))) as [number, number, number],
    max: [0, 1, 2].map((i) => Math.max(...real.map((b) => b.max[i]))) as [number, number, number],
  };
}

function span(b: Box): number {
  return Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
}

// ── the checks ───────────────────────────────────────────────────────────────

/**
 * Reads a plan and reports what is wrong with the assembly it describes.
 *
 * Ordered by severity so the caller can show the worst first, and so a repair prompt leads
 * with the thing most worth fixing.
 */
export function critique(plan: AssemblyPlan): Critique[] {
  const found: Critique[] = [];
  const boxes = new Map<string, Box>();

  // Every instance, not just the first.
  //
  // A component with a quantity is placed more than once, and the extra copies are mirrored
  // by the builder rather than stacked. Measuring only the base placement made the inspection
  // disagree with the geometry it was inspecting — it put the phone at 11 mm tall against a
  // built 13.65 mm, because two of the three camera lenses were never looked at. An inspection
  // that measures something other than what was built is worse than none.
  for (const c of plan.components) {
    const merged = union(
      Array.from({ length: Math.max(1, c.quantity) }, (_, i) =>
        placedBox({ ...c, placement: mirrorForInstance(c.placement, i) })),
    );
    if (merged) boxes.set(c.id, merged);
  }

  // Scale-relative tolerance. A 0.1 mm gap is a joint on a phone and a rounding error on a
  // bicycle, so a fixed figure is wrong for one of them.
  const overall = [...boxes.values()].reduce((m, b) => Math.max(m, span(b)), 0);
  const tol = Math.max(1e-6, overall * 0.002);

  for (const c of plan.components) {
    // ── a part with no material ──
    if (measureShape(c).volume < 1e-9) {
      found.push({
        kind: 'no-volume',
        severity: 'error',
        component: c.name,
        message:
          'This component encloses no volume, so it contributes nothing to the assembly. ' +
          'Usually one of its dimensions was left at zero.',
      });
      continue;
    }

    const box = boxes.get(c.id);
    if (!box) continue;

    // ── a single part larger than the whole assembly ──
    //
    // Compared as *sizes*, never as positions. The envelope declares how big the object is,
    // not where its origin sits: a bicycle is dimensioned from the ground and a phone from its
    // centre, and both are correct. Checking a component's coordinates against a centred
    // envelope reported every part of both as escaping it, which is a check measuring its own
    // assumption rather than the design.
    if (plan.envelope) {
      const limits = [plan.envelope.length, plan.envelope.width, plan.envelope.height];
      const names = ['length', 'width', 'height'];

      for (let i = 0; i < 3; i++) {
        const size = box.max[i] - box.min[i];
        if (limits[i] > 0 && size > limits[i] * 1.02 + tol) {
          found.push({
            kind: 'outside-envelope',
            severity: 'error',
            component: c.name,
            message:
              `Measures ${size.toFixed(1)} mm in ${names[i]}, but the whole assembly is ` +
              `declared as ${limits[i]} mm. A part cannot be bigger than the thing it is part of.`,
          });
          break;
        }
      }
    }

    // ── floating free of everything else ──
    const touches = plan.components.some((other) => {
      if (other.id === c.id) return false;
      const b = boxes.get(other.id);
      return b ? overlaps(box, b, tol) : false;
    });

    if (!touches && plan.components.length > 1) {
      found.push({
        kind: 'floating',
        severity: 'error',
        component: c.name,
        message:
          'Touches no other component — it floats in space. A part of an assembly has to ' +
          'sit against, inside, or overlapping something.',
      });
    }

    // ── a cut that removes nothing ──
    //
    // Cuts apply to what precedes them, so a cut overlapping only later components is a
    // no-op. It builds cleanly and silently does nothing, which is the worst kind of wrong.
    if (c.operation === 'cut') {
      const before = plan.components.slice(0, plan.components.indexOf(c));
      const bites = before.some((other) => {
        const b = boxes.get(other.id);
        return b ? overlaps(box, b, -tol) : false;
      });

      if (!bites) {
        found.push({
          kind: 'cut-removes-nothing',
          severity: 'error',
          component: c.name,
          message:
            'This is a cut, but it does not intersect anything listed before it, so it ' +
            'removes no material. A cut only affects components above it in the list.',
        });
      }
    }
  }

  // ── the assembly as a whole against its declared envelope ──
  //
  // This is the check the per-component one cannot be: it is origin-independent, because it
  // compares the overall extent to the declared size and nothing else.
  if (plan.envelope && boxes.size > 0) {
    const all = [...boxes.values()];
    const names = ['length', 'width', 'height'] as const;
    const limits = [plan.envelope.length, plan.envelope.width, plan.envelope.height];

    for (let i = 0; i < 3; i++) {
      const lo = Math.min(...all.map((b) => b.min[i]));
      const hi = Math.max(...all.map((b) => b.max[i]));
      const size = hi - lo;
      if (limits[i] <= 0) continue;

      const off = Math.abs(size - limits[i]) / limits[i];
      if (off > 0.15) {
        found.push({
          kind: 'implausible-scale',
          severity: off > 0.5 ? 'error' : 'warning',
          component: plan.name,
          message:
            `Built ${size.toFixed(0)} mm in ${names[i]}, but the plan declares ` +
            `${limits[i].toFixed(0)} mm — ${(off * 100).toFixed(0)}% out. Either a component ` +
            'is misplaced or the envelope does not describe what was built.',
        });
      }
    }
  }

  // ── two parts occupying the same space with the same shape ──
  for (let i = 0; i < plan.components.length; i++) {
    for (let j = i + 1; j < plan.components.length; j++) {
      const a = plan.components[i], b = plan.components[j];
      if (a.shape !== b.shape) continue;

      const ba = boxes.get(a.id), bb = boxes.get(b.id);
      if (!ba || !bb) continue;

      const same = [0, 1, 2].every(
        (k) => Math.abs(ba.min[k] - bb.min[k]) < tol && Math.abs(ba.max[k] - bb.max[k]) < tol,
      );

      if (same) {
        found.push({
          kind: 'coincident',
          severity: 'warning',
          component: b.name,
          message:
            `Occupies exactly the same space as ${a.name}, with the same shape. ` +
            'If two of these are wanted, set a quantity instead of duplicating the entry.',
        });
      }
    }
  }

  const rank: Record<Severity, number> = { error: 0, warning: 1, note: 2 };
  return found.sort((x, y) => rank[x.severity] - rank[y.severity]);
}

/** A sentence summarising a critique, or an empty string when the assembly reads clean. */
export function summariseCritique(found: Critique[]): string {
  if (found.length === 0) return '';

  const errors = found.filter((f) => f.severity === 'error').length;
  const warnings = found.length - errors;

  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} problem${errors === 1 ? '' : 's'}`);
  if (warnings > 0) parts.push(`${warnings} thing${warnings === 1 ? '' : 's'} to check`);

  return `Inspected the assembly: ${parts.join(' and ')}.`;
}

/**
 * The critique as instructions for a second attempt.
 *
 * Written as corrections to make rather than as complaints, because a model handed a list of
 * grievances tends to apologise and re-emit the same plan. Handed a list of specific edits, it
 * makes them.
 */
export function repairPrompt(plan: AssemblyPlan, found: Critique[]): string {
  const errors = found.filter((f) => f.severity !== 'note');
  if (errors.length === 0) return '';

  return [
    'Your previous plan built, but inspecting the geometry found these problems.',
    'Return a corrected plan in the same JSON format. Change only what is listed; leave',
    'everything else exactly as it was.',
    '',
    ...errors.map((f) => `- ${f.component}: ${f.message}`),
    '',
    'The plan you are correcting:',
    JSON.stringify({ name: plan.name, envelope: plan.envelope, components: plan.components }),
  ].join('\n');
}

/**
 * Rebuilding a DATUM document exactly, where the exact kernel can express it.
 *
 * Not every feature has an exact counterpart yet. A box, a cylinder, a sphere, the three boolean
 * operations and a fillet do; a sweep along a helix, a relief recovered from a photograph and a
 * lofted transition do not, and pretending otherwise would produce a solid that is exact and
 * *not the model on screen*, which is worse than not offering it.
 *
 * So this reports what it can and cannot carry before it builds anything. The user is told which
 * features would be dropped and decides. A conversion that silently omits a third of a part is
 * the kind of thing that gets discovered at the machine.
 */

import { buildExact, type ExactOp, type ExactPrimitive, type ExactResult, type ExactStep } from './exact';
import { parametersOf, type Document, type Feature } from '../../model/document';
import { readNumber } from '../../model/expr';

export interface ExactPlan {
  steps: ExactStep[];
  /** Radius of the single fillet applied at the end, if the document has one. */
  fillet?: number;
  /** Features the exact kernel has no counterpart for, by name. */
  dropped: string[];
}

/** What each DATUM operation means to the exact kernel. */
function opOf(feature: Feature, doc: Document): ExactOp {
  const raw = feature.params.operation;
  const op = typeof raw === 'string' ? raw : 'add';
  void doc;

  return op === 'cut' ? 'cut' : op === 'intersect' ? 'common' : 'fuse';
}

/**
 * Reads a document into a recipe the exact kernel can follow.
 *
 * Expressions are resolved here rather than passed through, because the exact kernel takes
 * numbers and the parametric layer is DATUM's own. A part driven by `Base.length / 2` converts
 * at whatever that currently comes to — which is what "rebuild this exactly" means.
 */
export function planExact(doc: Document): ExactPlan {
  const values = parametersOf(doc);
  const steps: ExactStep[] = [];
  const dropped: string[] = [];
  let fillet: number | undefined;

  const num = (f: Feature, key: string, fallback: number): number =>
    readNumber(f.params[key], values, fallback).value;

  for (const f of doc.features) {
    if (f.suppressed) continue;

    const at = f.placement
      ? [f.placement.x, f.placement.y, f.placement.z] as [number, number, number]
      : undefined;

    let primitive: ExactPrimitive | null = null;

    switch (f.kind) {
      case 'box':
        primitive = {
          kind: 'box',
          size: [num(f, 'length', 60), num(f, 'width', 40), num(f, 'height', 25)],
          at: [(at?.[0] ?? 0) + num(f, 'x', 0), (at?.[1] ?? 0) + num(f, 'y', 0), at?.[2] ?? 0],
        };
        break;

      case 'cylinder':
        primitive = {
          kind: 'cylinder',
          size: [num(f, 'diameter', 40), num(f, 'height', 50), 0],
          at: [(at?.[0] ?? 0) + num(f, 'x', 0), (at?.[1] ?? 0) + num(f, 'y', 0), at?.[2] ?? 0],
        };
        break;

      case 'sphere':
        primitive = {
          kind: 'sphere',
          size: [num(f, 'diameter', 50), 0, 0],
          at: [
            (at?.[0] ?? 0) + num(f, 'x', 0),
            (at?.[1] ?? 0) + num(f, 'y', 0),
            (at?.[2] ?? 0) + num(f, 'z', 0),
          ],
        };
        break;

      case 'fillet':
        // One blend at the end, which is how the exact builder takes it. A document with two
        // fillets of different radii keeps the larger and says the other was dropped, rather
        // than applying one radius everywhere and calling it the model.
        if (fillet === undefined) fillet = num(f, 'radius', 3);
        else {
          fillet = Math.max(fillet, num(f, 'radius', 3));
          dropped.push(f.name);
        }
        continue;

      // A datum builds nothing, so leaving it out changes nothing and is not a loss.
      case 'datum':
        continue;

      default:
        dropped.push(f.name);
        continue;
    }

    steps.push({ primitive, op: steps.length === 0 ? undefined : opOf(f, doc) });
  }

  return { steps, ...(fillet !== undefined ? { fillet } : {}), dropped };
}

export interface ExactConversion extends ExactResult {
  /** Features with no exact counterpart, by name. */
  dropped: string[];
  /** One sentence about what happened, for the user. */
  message: string;
}

/**
 * Rebuilds the document through OpenCascade, and says what it carried.
 *
 * The message is not decoration. Someone converting a part to exact geometry is usually about to
 * send it somewhere it will be machined from, and the one thing they need to know is whether
 * what they are looking at is the whole part.
 */
export async function exactFromDocument(doc: Document): Promise<ExactConversion | null> {
  const plan = planExact(doc);
  if (plan.steps.length === 0) return null;

  const result = await buildExact(plan.steps, { fillet: plan.fillet });

  const carried = `Rebuilt exactly: ${plan.steps.length} solid${plan.steps.length === 1 ? '' : 's'}`
    + `${plan.fillet ? `, blended at ${plan.fillet} mm` : ''}. `
    + `${result.faces} faces, ${result.volume.toFixed(2)} mm³ — exact, not tessellated.`;

  const lost = plan.dropped.length > 0
    ? ` ${plan.dropped.length} feature${plan.dropped.length === 1 ? '' : 's'} could not be `
      + `carried across: ${plan.dropped.join(', ')}.`
    : '';

  return {
    ...result,
    dropped: plan.dropped,
    message: `${carried}${lost}${result.problem ? ` ${result.problem}` : ''}`,
  };
}

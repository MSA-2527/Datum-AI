/**
 * Checking a proposed assembly against the reference corpus.
 *
 * Retrieval improves what a model produces; it does not guarantee it. A plan can still come
 * back with an 18650 cell 70 mm long, or a bracket in "aluminium" at 7.8 g/cm³, and both build
 * into perfectly valid geometry that is quietly wrong. Geometry validity and dimensional
 * correctness are different properties and only one of them is checked by the kernel.
 *
 * So every plan is read back against the same standards that were offered to build it. Two
 * kinds of finding:
 *
 *   - **Corrected.** A density that disagrees with the named material is simply fixed, because
 *     there is exactly one right answer and no design judgement involved. Aluminium is
 *     2.70 g/cm³ or the part is not aluminium.
 *   - **Flagged.** A dimension that disagrees with the standard the component's name invokes
 *     is reported, not changed. An 18650 measuring 70 mm might be a mistake, or it might be a
 *     protected cell with its circuit — the tool does not know, and guessing would be worse
 *     than saying so.
 *
 * The distinction is the point. Silent repair of things that are unambiguous, and plain
 * reporting of things that are not.
 */

import type { AssemblyPlan, ComponentSpec } from '../assembly/plan';
import { densityOf, FACTS, type Fact } from './standards';
import { retrieve } from './retrieve';

export interface Finding {
  component: string;
  /** What the corpus says, in a sentence a reader can act on. */
  message: string;
  /** The entry this came from, so the claim is traceable. */
  source: string;
  severity: 'corrected' | 'check';
}

export interface AuditResult {
  plan: AssemblyPlan;
  findings: Finding[];
}

/** How far a dimension may sit from the published figure before it is worth mentioning. */
const TOLERANCE = 0.06; // 6%, which clears manufacturing variation and catches real errors

/** The component parameters an envelope map can describe. */
const AXES = ['diameter', 'length', 'width', 'height'] as const;

/** The single best reference entry for a component, or nothing when none is clearly about it. */
function entryFor(component: ComponentSpec): Fact | undefined {
  const matches = retrieve(`${component.name} ${component.role}`, 3);
  if (matches.length === 0) return undefined;

  // Require a decisive match. A weak keyword hit ("shaft" retrieving a bearing) is not
  // grounds for telling someone their dimension is wrong.
  const [best, second] = matches;
  if (best.score < 6) return undefined;
  if (second && second.score === best.score) return undefined;

  return best.fact;
}

/**
 * Reads a plan against the corpus, returning a corrected plan and everything worth saying.
 *
 * The plan is copied rather than mutated. A caller that wants the original — to show what
 * changed, or to keep a model's raw output for a bug report — still has it.
 */
export function auditPlan(plan: AssemblyPlan): AuditResult {
  const findings: Finding[] = [];

  const components = plan.components.map((component) => {
    let next = component;

    // ── material density ──
    const known = densityOf(component.material);
    if (known !== undefined && Math.abs(component.density - known) > known * 0.02) {
      findings.push({
        component: component.name,
        message:
          `Density was ${component.density} g/cm³ for ${component.material}; ` +
          `corrected to ${known}. Mass and cost were wrong by ` +
          `${(Math.abs(component.density - known) / known * 100).toFixed(0)}%.`,
        source: 'Published material data',
        severity: 'corrected',
      });
      next = { ...next, density: known };
    }

    // ── dimensions against the standard the name invokes ──
    //
    // Only entries that declare an envelope are compared, and only on the axes they name.
    // Anything else — a mating interface, a mounting pitch, a thread pitch — describes a
    // feature of the part rather than its size, and holding a part's overall dimension
    // against it produces confident nonsense.
    const fact = entryFor(component);

    if (fact?.envelope) {
      for (const axis of AXES) {
        const dimName = fact.envelope[axis];
        if (!dimName) continue;

        const value = component.params[axis];
        const published = fact.dims[dimName];
        if (typeof value !== 'number' || published === undefined || published === 0) continue;

        const off = Math.abs(value - published) / published;
        if (off <= TOLERANCE) continue;

        findings.push({
          component: component.name,
          message:
            `${axis} is ${value} mm; ${fact.subject} is ${published} mm ` +
            `(${(off * 100).toFixed(0)}% out). Left as given — check whether this is ` +
            `a variant or a mistake.`,
          source: fact.source,
          severity: 'check',
        });
      }
    }

    return next;
  });

  return { plan: { ...plan, components }, findings };
}

/**
 * A one-line summary of an audit, or an empty string when there is nothing to say.
 *
 * Kept separate from the audit itself so the caller decides where it goes — the chat stream,
 * a warning badge, or nowhere at all.
 */
export function summariseAudit(findings: Finding[]): string {
  if (findings.length === 0) return '';

  const corrected = findings.filter((f) => f.severity === 'corrected').length;
  const check = findings.length - corrected;

  const parts: string[] = [];
  if (corrected > 0) {
    parts.push(`Corrected ${corrected} value${corrected === 1 ? '' : 's'} against published data`);
  }
  if (check > 0) {
    parts.push(`${check} dimension${check === 1 ? '' : 's'} disagree with the standard and need a look`);
  }

  return `${parts.join('; ')}.`;
}

/** Everything the corpus holds, for a "what does it know" panel. */
export function corpusSummary(): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of FACTS) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

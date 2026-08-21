/**
 * Reasoning about a request in stages, and showing the work.
 *
 * The complaint this answers is that the assistant "just gives something generally found or one
 * from the saved library". That was accurate. With a language model configured there was a
 * chain — study the object, plan it, inspect the plan, send it back for repair — but with the
 * model off, which is how this application runs by default, there was none: a request was
 * matched against recipe names, the matching recipe was built at its designed size, and that
 * was the answer. "A 400 mm long bracket" produced the standard 180 mm bracket. The number was
 * read and discarded.
 *
 * So the stages here run whether or not a model is configured. They are ordinary engineering
 * steps rather than prompts:
 *
 *   1. read what was asked for, as requirements that can be checked;
 *   2. choose an approach, and say why that one;
 *   3. build a first answer;
 *   4. measure it against every requirement;
 *   5. correct what can be corrected, and re-measure;
 *   6. state plainly what was met and what was not.
 *
 * Step 4 is the one that turns the rest into reasoning. Without it the earlier steps are just a
 * pipeline: something comes out, it looks like a part, and nothing ever asks whether it is the
 * part that was requested. A model that cannot check its own answer has not reasoned about
 * anything, however many times it was prompted.
 *
 * Every step is kept, not just the outcome, because a conclusion nobody can inspect is one
 * nobody can correct — and the user who can tell that a 400 mm bracket came out at 180 is the
 * user reading these lines.
 */

import {
  checkRequirements, describeChecks, readRequirements, scaleToMeet,
  type RequirementKind,
  type Check, type Requirement,
} from './requirements';
import { evaluateDocument, type Document } from '../model/document';
import { currentSizeModel } from '../ml/corpus';
import { predictSize } from '../ml/dimensions';

export interface ReasoningStep {
  /** What this step was for, in a few words. */
  name: string;
  /** What it concluded, in a sentence a person can check. */
  finding: string;
  /** True when the step changed the answer rather than only describing it. */
  acted?: boolean;
}

export interface Reasoning {
  steps: ReasoningStep[];
  requirements: Requirement[];
  checks: Check[];
  /** Everything that was asked for came out right. */
  satisfied: boolean;
}

/** How far a scale correction is allowed to go before it is refusing rather than adjusting. */
const MAX_SCALE = 20;
const MIN_SCALE = 1 / 20;

/**
 * Reads the request and says what will be judged.
 *
 * Run before anything is built, so the standard the answer will be held to is fixed in advance.
 * Deciding afterwards what the request "really meant" is how a generator talks itself into
 * accepting whatever it happened to produce.
 */
export function stateRequirements(text: string): { requirements: Requirement[]; step: ReasoningStep } {
  const requirements = readRequirements(text);

  const finding = requirements.length === 0
    ? 'Nothing specific was asked for, so any reasonable size is acceptable.'
    : `Read ${requirements.length} requirement${requirements.length === 1 ? '' : 's'}: ` +
      requirements.map((r) => `${r.kind} from "${r.source}"`).join(', ') + '.';

  return { requirements, step: { name: 'What was asked for', finding } };
}

/**
 * Measures the document against the requirements.
 *
 * The document is evaluated rather than trusted, because the question is what was built and not
 * what was intended.
 */
export function verify(doc: Document, requirements: Requirement[]): { checks: Check[]; step: ReasoningStep } {
  if (requirements.length === 0) {
    return { checks: [], step: { name: 'Check', finding: 'Nothing to check it against.' } };
  }

  const evaluated = evaluateDocument(doc);
  const checks = checkRequirements(requirements, evaluated.mesh, evaluated.massGrams, doc.material);
  const missed = checks.filter((c) => !c.met);

  return {
    checks,
    step: {
      name: 'Check',
      finding: missed.length === 0
        ? 'Everything asked for came out right.'
        : `${missed.length} of ${checks.length} did not: ${missed.map((c) => c.note).join(' ')}`,
    },
  };
}

/**
 * Scales the whole document so its dimensions meet what was asked.
 *
 * Uniform, because the proportions are the part of a recipe that was designed. Applied to the
 * document rather than by rebuilding from a scaled recipe, so it works for anything the earlier
 * stages produced — recipe, catalogue archetype or plan — without each of them needing to know
 * how to resize itself.
 */
export function rescale(doc: Document, factor: number): Document {
  if (!(factor > MIN_SCALE && factor < MAX_SCALE) || Math.abs(factor - 1) < 1e-6) return doc;

  return {
    ...doc,
    features: doc.features.map((f) => {
      const params: Record<string, typeof f.params[string]> = {};

      for (const [key, value] of Object.entries(f.params)) {
        // Only lengths scale. An angle stays an angle, a count stays a count, and a scaled
        // operation name is nonsense — the first draft of this multiplied everything numeric
        // and turned a 4-bolt pattern into a 6.8-bolt one.
        params[key] = typeof value === 'number' && isLength(key) ? value * factor : value;
      }

      const placement = f.placement
        ? {
            ...f.placement,
            x: f.placement.x * factor,
            y: f.placement.y * factor,
            z: f.placement.z * factor,
          }
        : f.placement;

      return { ...f, params, placement };
    }),
    // A scaled part is a different size of part, and its known mass no longer describes it.
    knownMassGrams: undefined,
  };
}

/**
 * Which parameters are lengths.
 *
 * By name, because that is what a parameter has. Listing the exceptions rather than the lengths
 * keeps a new dimension working by default: getting a dimension wrongly left unscaled is
 * visible immediately, and a new angle wrongly scaled is not.
 */
const NOT_LENGTHS = new Set([
  'angle', 'draft', 'twist', 'sides', 'count', 'teeth', 'rows', 'cols', 'turns',
  'subdivisions', 'quantity', 'operation', 'plane', 'shape', 'archetypeId',
  'reliefWidth', 'reliefHeight', 'reliefField', 'pathAngle', 'endScale',
  'minAngle', 'faceMatch', 'convexity', 'faces', 'material', 'colour',
  'tracedWidth', 'holeLengths', 'midplane', 'pattern',
]);

function isLength(key: string): boolean {
  if (NOT_LENGTHS.has(key)) return false;
  // Anything that reads as a count or an angle by name, whatever it is called.
  return !/(count|angle|deg|ratio|number|index)$/i.test(key);
}

/**
 * Corrects the part to meet what was asked, and re-checks.
 *
 * One correction, not a loop. Scaling is exact — the factor that makes a dimension right makes
 * it right the first time — so a second pass would only chase the rounding. Where a requirement
 * cannot be met by scaling at all, such as two dimensions demanding different factors, the
 * result says so rather than iterating towards a compromise nobody asked for.
 */
export function correct(
  doc: Document, requirements: Requirement[], checks: Check[],
): { doc: Document; checks: Check[]; step: ReasoningStep | null } {
  const missed = checks.filter((c) => !c.met);
  if (missed.length === 0) return { doc, checks, step: null };

  const factor = scaleToMeet(checks);
  if (Math.abs(factor - 1) < 0.005) {
    return {
      doc, checks,
      step: {
        name: 'Correct',
        finding: 'Scaling cannot fix this — the dimensions asked for are not in proportion with '
          + 'each other. Left at the designed proportions and reported instead.',
      },
    };
  }

  const scaled = rescale(doc, factor);
  const after = verify(scaled, requirements);

  // Kept only if it is actually better. A correction that satisfies one requirement by breaking
  // two is not a correction, and shipping it because it was newer would make this harmful.
  const betterBefore = checks.filter((c) => c.met).length;
  const betterAfter = after.checks.filter((c) => c.met).length;

  if (betterAfter <= betterBefore) {
    return {
      doc, checks,
      step: {
        name: 'Correct',
        finding: `Scaling by ${factor.toFixed(2)} was tried and did not help, so the part is as `
          + 'first built.',
      },
    };
  }

  return {
    doc: scaled,
    checks: after.checks,
    step: {
      name: 'Correct',
      acted: true,
      finding: `Scaled by ${factor.toFixed(2)} to meet what was asked. `
        + `${betterAfter} of ${after.checks.length} requirements now met, up from ${betterBefore}.`,
    },
  };
}

/**
 * What the library says a part like this usually is.
 *
 * Only offered when the request left the size open — where a dimension was stated, the stated
 * one wins, and quoting the library at someone who has already told you the answer is noise.
 */
export function consultLibrary(text: string, requirements: Requirement[]): ReasoningStep | null {
  const dimensional = requirements.some(
    (r) => r.kind === 'length' || r.kind === 'width' || r.kind === 'height' || r.kind === 'diameter',
  );
  if (dimensional) return null;

  const model = currentSizeModel();
  if (!model) return null;

  const guess = predictSize(model, text);
  return {
    name: 'From your own parts',
    finding:
      `Your ${model.examples} saved parts suggest something around `
      + `${guess.sizeMm.map((v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1))).join(' × ')} mm, `
      + `give or take ${Math.round(guess.typicalError * 100)}%.`,
  };
}

/**
 * The chain for an *edit*: check, but never rescale.
 *
 * An edit already says exactly what to change and to what. Running the correction pass over one
 * is not a safety net, it is a second opinion that overrules the instruction — and it does real
 * damage, because the requirement reader and the edit reader legitimately understand the same
 * words differently. "Make the bracket 5 mm thick" is a thickness parameter to the editor and an
 * overall height to the requirement reader, and both are reasonable readings of the sentence.
 *
 * With the correction pass attached, that disagreement scaled a folded bracket by 5/60 and took
 * it from 11.6 cm³ to 0.05 cm³ while reporting that everything asked for had been met. The edit
 * was right; the correction was answering a different question.
 *
 * So an edit is verified and reported and never resized. Where the check disagrees, it is said
 * plainly and the user decides, which is the only honest thing to do when two readings of one
 * sentence conflict.
 */
export function reasonAboutEdit(
  text: string, doc: Document, what: string,
): { doc: Document; reasoning: Reasoning } {
  const steps: ReasoningStep[] = [];

  const asked = stateRequirements(text);
  steps.push(asked.step);
  steps.push({ name: 'Change', finding: what, acted: true });

  const checked = verify(doc, asked.requirements);
  steps.push(checked.step);

  return {
    doc,
    reasoning: {
      steps,
      requirements: asked.requirements,
      checks: checked.checks,
      satisfied: checked.checks.every((c) => c.met),
    },
  };
}

/**
 * The whole chain, over a document that some earlier route already built.
 *
 * Separated from the routes that build so that every one of them — recipe, catalogue, plan,
 * language model — is held to the same standard afterwards. A check that only runs on one path
 * is a check that the other paths are quietly exempt from.
 */
export function reasonAbout(
  text: string, doc: Document, approach: string,
  options: { built?: RequirementKind[] } = {},
): { doc: Document; reasoning: Reasoning } {
  const steps: ReasoningStep[] = [];

  const asked = stateRequirements(text);
  steps.push(asked.step);

  /*
   * Dimensions the builder read and built to are not re-measured off the bounding box.
   *
   * The box is an approximation of intent — it has no idea which axis a part was turned
   * about — and where the builder understood a dimension exactly, that approximation can only
   * disagree. "A spacer 20 mm od 8 mm id 12 mm long" was built correctly at 3.17 cm³, then
   * checked: "long" was measured as the largest extent, which on a flat washer is its 20 mm
   * diameter, and the correction pass scaled the whole part by 0.6 to make it 12 — leaving a
   * 12 mm washer 7 mm thick and calling the requirement met.
   *
   * A parameter the builder bound is the more precise statement of the two. It is dropped from
   * the checking rather than checked leniently, because a check that cannot fail is noise.
   */
  const checkable = options.built && options.built.length > 0
    ? asked.requirements.filter((r) => !options.built!.includes(r.kind))
    : asked.requirements;

  asked.requirements = checkable;

  const library = consultLibrary(text, asked.requirements);
  if (library) steps.push(library);

  steps.push({ name: 'Approach', finding: approach });

  const first = verify(doc, asked.requirements);
  steps.push(first.step);

  const fixed = correct(doc, asked.requirements, first.checks);
  if (fixed.step) steps.push(fixed.step);

  const satisfied = fixed.checks.every((c) => c.met);
  const summary = describeChecks(fixed.checks);
  if (summary) steps.push({ name: 'Result', finding: summary });

  return {
    doc: fixed.doc,
    reasoning: { steps, requirements: asked.requirements, checks: fixed.checks, satisfied },
  };
}

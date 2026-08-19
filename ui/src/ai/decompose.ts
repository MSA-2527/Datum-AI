/**
 * Turning a request into an assembly plan.
 *
 * Three routes, tried in order, and the order is the point.
 *
 *   1. A **built-in recipe**, when the object is one of the ones already decomposed. Offline,
 *      instant, and the dimensions are real numbers a reviewer can argue with.
 *   2. The **single-shape catalogue**, when the request names one part rather than an
 *      assembly. "A cup" is not an assembly and forcing it through a decomposition would be
 *      absurd.
 *   3. A **language model**, for everything else — and only if one is configured.
 *
 * A model is asked for a plan, never for geometry. It picks from the same closed vocabulary
 * of shapes the rest of the application uses and supplies numbers; it cannot emit a mesh, a
 * script, or an operation the kernel does not implement. That constraint is what makes an
 * untrusted, occasionally-wrong generator safe to build from: the worst it can do is propose
 * a badly proportioned assembly of real, valid parts, which a person can see and correct.
 *
 * It is also what separates this from the text-to-mesh approach. A generated triangle soup
 * cannot be dimensioned, cannot be toleranced and cannot be edited by the engineer who has
 * to sign the drawing. A parts list with dimensions can.
 */

import { complete, extractJson, type CompletionFailure, type ProviderConfig } from './providers';
import { ARCHETYPES, archetypeById } from '../generate/archetypes';
import { generateFromText } from '../generate/parse';
import { matchRecipe, namesSpecificProduct, RECIPES } from '../assembly/recipes';
import {
  buildAssembly, describePlan, shapeVocabulary, validatePlan,
  type AssemblyPlan,
} from '../assembly/plan';
import { addFeature, emptyDocument, type Document, type ParamValue } from '../model/document';
import { constraintBrief } from '../lib/limits';
import { exemplarBlock, exemplarsFor } from '../lib/training';
import { expandQuery, referenceBlock } from '../reference/retrieve';
import { auditPlan, summariseAudit, type Finding } from '../reference/audit';
import { critique, repairPrompt, summariseCritique, type Critique } from './critique';
import { reasonAbout, type Reasoning } from './reason';
import { describeChecks } from './requirements';

export interface DecomposeSuccess {
  ok: true;
  doc: Document;
  plan: AssemblyPlan | null;
  /** How it was decided, so the user knows whether a model was involved. */
  route: 'recipe' | 'catalogue' | 'model';
  message: string;
  /** Repairs the validator made to a model's plan. */
  corrections: string[];
  dropped: { name: string; reason: string }[];
  citations: { title: string; uri: string }[];
  /** What the reference corpus had to say about the result. */
  findings: Finding[];
  /** What inspecting the built geometry found. */
  inspected: Critique[];
  /** True when a first attempt was rejected and the model was asked to correct it. */
  repaired: boolean;
  /**
   * The steps taken to get here, and whether the result meets what was asked.
   *
   * Kept on every route, not only the one that talks to a model. A check that runs on one path
   * is a check the other paths are quietly exempt from — and the path that needed it most was
   * the offline one, which used to match a recipe by name and hand back its designed size
   * whatever dimensions the request had stated.
   */
  reasoning: Reasoning;
  ms: number;
}

export interface DecomposeFailure {
  ok: false;
  message: string;
  suggestions: string[];
  /** Present when a model was tried and failed, so the cause is visible. */
  providerError?: string;
}

export type DecomposeResult = DecomposeSuccess | DecomposeFailure;

// ── the prompt ───────────────────────────────────────────────────────────────

/**
 * Builds the system prompt.
 *
 * The shape vocabulary and every archetype's parameter names and ranges are injected rather
 * than described, so the model is choosing from a list it can see rather than guessing at an
 * API. That single decision removes most of the ways a generated plan can be unbuildable.
 */
export function buildSystemPrompt(reference = '', exemplars = ''): string {
  const shapes = ARCHETYPES.map((a) => {
    const params = a.defaults
      .map((d) => `${d.key}(${d.min}-${d.max}${d.unit === 'count' ? '' : d.unit})`)
      .join(', ');
    return `- ${a.id}: ${a.label}. params: ${params}`;
  }).join('\n');

  // The reference block goes *before* the schema rather than after it. A model reads a prompt
  // in order and the numbers have to be in hand before it starts filling in fields; put them
  // at the end and it has already committed to a set of remembered dimensions by the time it
  // reaches them.
  //
  // The manufacturing limits go at the *end*, for the opposite reason and it is not a
  // contradiction. Reference dimensions decide what the object is — they have to be settled
  // before anything else. The limits decide whether a number that has already been chosen is
  // allowed to stand, which is the last judgement made about each field, so they belong where
  // they are freshest. See `lib/limits.ts` for why they are stated up front at all rather
  // than left to the linter.
  const grounding = reference ? `${reference}\n\n` : '';

  return `You are a mechanical design assistant. You decompose an object into the parts it is
physically made of, and describe each part as a shape this CAD kernel can build.

${grounding}

You reply with JSON only. No prose, no markdown fences.

SHAPES AVAILABLE — you may use no others:
${shapes}
- box: params length, width, height (mm)
- cylinder: params diameter, height (mm)
- sphere: params diameter (mm)

JSON SHAPE:
{
  "name": "string",
  "description": "one sentence",
  "parameters": [
    { "name": "wheelbase", "value": 2335, "units": "mm", "note": "why this figure" },
    { "name": "halfTrack", "value": "track / 2", "units": "mm", "note": "derived" }
  ],
  "envelope": { "length": mm, "width": mm, "height": mm },
  "components": [
    {
      "id": "short-id",
      "name": "Component name",
      "role": "what this part does",
      "shape": "one of the shape ids above",
      "params": { "...": number or "expression" },
      "placement": { "x": mm, "y": mm, "z": mm, "rx": deg, "ry": deg, "rz": deg },
      "placementExpr": { "x": "-wheelbase / 2" },
      "material": "e.g. Aluminium 6061-T6",
      "density": number in g/cm3,
      "quantity": integer,
      "operation": "add" or "cut",
      "note": "why this size"
    }
  ],
  "notes": ["assumptions and what this deliberately leaves out"]
}

PARAMETERS — this is what makes the result a design rather than a picture:
- Pull out the handful of figures the object is actually designed around, and name them.
  A car has a wheelbase, a track and an overall length; an engine has a bore and a stroke; a
  bracket has a plate thickness and a hole pitch. Aim for 3 to 10.
- Then *use* them. A component's params and its placementExpr may be arithmetic over the
  parameter names: "wheelbase / 2", "boreDia * 1.5 + 2", "-track / 2".
- A parameter may be defined in terms of earlier ones: "value": "wheelbase * 0.42".
- Arithmetic only: + - * / % ^, brackets, and min, max, abs, sqrt, round, floor, ceil, sin,
  cos, tan, hypot. Angles in degrees. No other syntax exists — it is not JavaScript.
- Anything genuinely independent stays a plain number. Do not invent a parameter for a figure
  nothing else depends on.
- The test is simple: after changing one parameter, should other parts move or resize? If yes,
  they must be written as expressions over it. A wheel at "-wheelbase / 2" follows the
  wheelbase; a wheel at -1167.5 does not, and that difference is the whole point.

RULES:
- Millimetres and degrees throughout. Never other units.
- Every dimension must be a real, defensible figure for the object at true size. A phone is
  about 163 mm long, not 1.63 or 1630.
- Placement is the centre of the part, in an origin-centred coordinate system.
  X is length, Y is width, Z is height.
- Components must not float in space or overlap implausibly. Position each one where it
  physically sits inside the object.
- "operation" is "add" for a normal part, "cut" for something that removes material such as
  a cavity or a port, and "fuse" only when two parts are genuinely one piece of material.
- ORDER MATTERS. A "cut" removes material from every component listed BEFORE it and none
  listed after. Put a cut immediately after the part it modifies — a chassis cavity goes
  straight after the chassis, not at the end, or it will bore through the internals too.
- Parts placed with "add" are separate bodies that may occupy the same space. A battery
  inside a chassis is normal and correct; do not try to fuse them.
- Decompose to the level a person would recognise: major assemblies and visible parts, not
  individual screws or solder joints. Scale the count to the object:
    * a single turned or milled part (cup, knob, bracket): 1 to 6 components
    * a device or appliance (phone, drill, kettle): 10 to 25
    * a machine or vehicle (car, engine, printer, bicycle): 25 to 60
  A car described with three components is not a car. If the object has wheels, seats, doors,
  glass, lights, a bumper, a bonnet, a roof and pillars, then it has all of those as separate
  components, each sized and placed. Model what is actually there, part by part.
- Prefer many correctly-sized simple parts over few vague ones. Four wheels are four
  components, not one. A windscreen, a rear screen and four side windows are six components.
- Symmetry is not a shortcut: place the left and the right one separately, at mirrored
  coordinates. Use "quantity" only for parts that genuinely repeat on a regular pattern.
- "note" must say where a dimension comes from, so it can be checked.
- "notes" must state what this model is not. Be specific and honest.
- Where a REFERENCE DIMENSIONS entry above covers a part you are placing, its figures are
  authoritative. Use them unchanged and name the standard in that component's "note". If you
  believe a reference figure is wrong for this design, say so in "notes" rather than silently
  using a different number.

${constraintBrief()}${exemplars ? `\n\n${exemplars}` : ''}`;
}

// ── the entry point ──────────────────────────────────────────────────────────

export interface DecomposeOptions {
  config: ProviderConfig;
  /** Force the model even when a recipe or catalogue entry would match. */
  preferModel?: boolean;
  signal?: AbortSignal;
}

export async function decompose(prompt: string, opts: DecomposeOptions): Promise<DecomposeResult> {
  const started = Date.now();
  const text = prompt.trim();

  if (!text) {
    return { ok: false, message: 'Say what to build.', suggestions: starterSuggestions() };
  }

  // 1. A built-in decomposition.
  if (!opts.preferModel) {
    const recipe = matchRecipe(text);

    // A named product goes to the model, which can research its published dimensions. The
    // recipe is a *category* — typical figures for a phone, not measured off any one device —
    // and answering "iPhone 15 Pro Max" with it silently substitutes a different object.
    const specific = recipe !== null && namesSpecificProduct(text, recipe);
    const canResearch = opts.config.id !== 'none';

    if (recipe && !(specific && canResearch)) {
      const plan = recipe.build(scaleFrom(text));
      const validated = validatePlan(plan);
      if (!('error' in validated)) {
        // Recipes are audited too. They are hand-written against real hardware, so this
        // should find nothing — and that is exactly why it runs: a recipe that drifts out of
        // agreement with the standard it was built from is a regression nobody would
        // otherwise notice.
        const audited = auditPlan(validated.plan);
        const summary = summariseAudit(audited.findings);

        // Recipes are inspected too. They are hand-written and should come back clean, which
        // is exactly why it is worth running: the first time this ran over them it found the
        // bicycle's wheels lying flat and the laptop's lid placed beside its base rather than
        // on top of it. Both built into perfectly valid closed solids.
        const inspected = critique(audited.plan);

        // Held to what was asked, and corrected if it can be. Until this existed, "a 400 mm
        // long bracket" matched the word "bracket" and came back at the designed 180 mm.
        const reasoned = reasonAbout(
          text, buildAssembly(audited.plan),
          `Matched the built-in ${recipe.label.toLowerCase()}, which is a designed decomposition ` +
          'rather than a guess.',
        );

        return {
          ok: true,
          doc: reasoned.doc,
          plan: audited.plan,
          route: 'recipe',
          reasoning: reasoned.reasoning,
          message: [
            describePlan(audited.plan),
            // Said plainly rather than left to be discovered. Without a model there is no way
            // to look up a particular device, and quietly handing over the generic one is how
            // someone ends up dimensioning a case against the wrong phone.
            specific
              ? `This is the generic ${recipe.label.toLowerCase()}, not that specific model — ` +
                'turn on a model in AI settings to have its real dimensions researched.'
              : '',
            validated.plan.notes[0] ?? '',
            summary,
            summariseCritique(inspected),
            reasoned.reasoning.checks.length > 0 ? describeChecks(reasoned.reasoning.checks) : '',
          ].filter(Boolean).join(' '),
          corrections: validated.corrections,
          dropped: validated.dropped,
          citations: [],
          findings: audited.findings,
          inspected,
          repaired: false,
          ms: Date.now() - started,
        };
      }
    }

    // 2. A single part from the catalogue.
    const single = generateFromText(text);
    if (single.ok) {
      const archetype = single.archetype;
      const params: Record<string, ParamValue> = { archetypeId: archetype.id };
      for (const spec of archetype.defaults) {
        params[spec.key] = single.parsed.params[spec.key] ?? spec.value;
      }

      // The archetype's own material, so a wooden table is not costed as aluminium.
      const base = emptyDocument(archetype.label);
      const doc = addFeature(
        archetype.material
          ? { ...base, material: archetype.material.name, density: archetype.material.density }
          : base,
        'archetype', params, archetype.label,
      );
      const understood = single.parsed.understood.length > 0
        ? ` Read: ${single.parsed.understood.join(', ')}.`
        : '';

      const reasoned = reasonAbout(
        text, doc,
        `Recognised a ${archetype.label.toLowerCase()} in the built-in catalogue and sized it ` +
        'from the request.',
      );

      return {
        ok: true,
        doc: reasoned.doc,
        plan: null,
        route: 'catalogue',
        reasoning: reasoned.reasoning,
        message: [
          `Built a ${archetype.label.toLowerCase()}.${understood}`,
          single.result.warnings.join(' '),
          describeChecks(reasoned.reasoning.checks),
        ].filter(Boolean).join(' ').trim(),
        corrections: [],
        dropped: [],
        citations: [],
        findings: [],
        inspected: [],
        repaired: false,
        ms: Date.now() - started,
      };
    }
  }

  // 3. A model.
  if (opts.config.id === 'none') {
    return {
      ok: false,
      message:
        `Nothing in the built-in catalogue matches "${text}". ` +
        `Configure a model in AI settings to decompose objects that are not in the list, ` +
        `or try one of the shapes below.`,
      suggestions: starterSuggestions(),
    };
  }

  // Look up what the request implies before asking for anything. A skateboard does not say
  // "bearing" and a 3D printer does not say "NEMA 17", but both have them, and handing the
  // model the real figures is the difference between a plan that is checkable and one that is
  // merely plausible.
  const reference = referenceBlock(expandQuery(text));

  // The examples this organisation has taught, most relevant first. Retrieval rather than a
  // fixed set: showing a model a gearbox while it is being asked for a bracket teaches it to
  // answer with a gearbox, and an irrelevant example is worse than none because the model
  // will try to follow it. See `lib/training.ts`.
  const taught = exemplarsFor(text);
  const exemplars = exemplarBlock(taught.examples);

  // Plan, build, inspect, and — when inspection finds real problems — hand them back and ask
  // for a correction. This is the loop that separates a generator from a designer: the first
  // attempt is a draft, and the second one has been told what was wrong with it.
  //
  // Exactly one retry. The findings a second pass fixes are the blatant ones — a part floating
  // in space, a cut that removes nothing — and past that the returns fall off sharply while
  // the user waits and pays for every round.
  // Think about the object before describing it.
  //
  // A single call that must *simultaneously* recall what a Suzuki Mehran is, decide its
  // subsystems, and emit schema-valid JSON spends most of its attention on the schema. The
  // result is a plan that parses perfectly and describes a box with two cylinders — every
  // field correct, the object unrecognisable. Asking for the engineering first, in prose,
  // costs one extra round trip and changes what the second call is doing: it is no longer
  // recalling and formatting at once, it is transcribing a list it already has.
  //
  // This helps every model and helps the smaller ones most, which is where the problem was.
  const study = await studyObject(opts, reference, text);

  let attempt = await askForPlan(
    opts, reference, exemplars,
    study
      ? `${study}\n\nNow express exactly that as the JSON plan. Every part named above must ` +
        `appear as a component with real dimensions. Do not reduce the part count.`
      : `Decompose this into buildable components: ${text}`,
  );
  if (!attempt.ok) return attempt.failure;

  let repaired = false;
  let inspected = critique(attempt.plan);

  if (inspected.some((c) => c.severity === 'error')) {
    const second = await askForPlan(opts, reference, exemplars, repairPrompt(attempt.plan, inspected));

    // A correction is kept only if it is actually better. A model asked to fix four problems
    // can return something with six, and shipping that because it was newer would make the
    // loop actively harmful.
    if (second.ok) {
      const after = critique(second.plan);
      const errorsBefore = inspected.filter((c) => c.severity === 'error').length;
      const errorsAfter = after.filter((c) => c.severity === 'error').length;

      if (errorsAfter < errorsBefore) {
        attempt = second;
        inspected = after;
        repaired = true;
      }
    }
  }

  const { plan: rawPlan, reply, validated } = attempt;

  const audited = auditPlan(rawPlan);
  const plan: AssemblyPlan = audited.plan;

  const parts: string[] = [describePlan(plan)];
  if (validated.dropped.length > 0) {
    parts.push(
      `${validated.dropped.length} component${validated.dropped.length === 1 ? '' : 's'} were dropped: ` +
      validated.dropped.map((d) => `${d.name} (${d.reason})`).join('; '),
    );
  }
  if (reply.citations.length > 0) {
    parts.push(`Researched from ${reply.citations.length} source${reply.citations.length === 1 ? '' : 's'}.`);
  }

  const summary = summariseAudit(audited.findings);
  if (summary) parts.push(summary);

  if (repaired) {
    parts.push('The first attempt had problems the inspection caught, so it was sent back and corrected.');
  }

  // Named, not merely counted. An example that steered the answer is something the user can
  // go and look at — and delete, if it steered it wrongly.
  if (taught.examples.length > 0) {
    parts.push(
      `Guided by your own ${taught.examples.length === 1 ? 'part' : 'parts'}: ` +
      `${taught.examples.map((e) => `"${e.prompt}"`).join(', ')}.`,
    );
  }

  const inspection = summariseCritique(inspected);
  if (inspection) parts.push(inspection);

  // The same standard as the offline routes. A model that has researched an object still has
  // to produce the size that was asked for, and it is no more exempt from being measured than
  // a recipe is.
  const reasoned = reasonAbout(
    text, buildAssembly(plan),
    `Decomposed by ${reply.model}${repaired ? ', then corrected after inspection' : ''}.`,
  );
  const met = describeChecks(reasoned.reasoning.checks);
  if (met) parts.push(met);

  parts.push(`Built by ${reply.model} in ${(reply.ms / 1000).toFixed(1)} s.`);

  return {
    ok: true,
    doc: reasoned.doc,
    plan,
    route: 'model',
    reasoning: reasoned.reasoning,
    message: parts.join(' '),
    corrections: validated.corrections,
    dropped: validated.dropped,
    citations: reply.citations,
    findings: audited.findings,
    inspected,
    repaired,
    ms: Date.now() - started,
  };
}

/** One round trip: ask for a plan, parse it, validate it. */
type PlanAttempt =
  | {
      ok: true;
      plan: AssemblyPlan;
      reply: { model: string; ms: number; citations: { title: string; uri: string }[] };
      validated: { corrections: string[]; dropped: { name: string; reason: string }[] };
    }
  | { ok: false; failure: DecomposeFailure };

/**
 * The engineering pass: what is this object, actually?
 *
 * Prose, not JSON, and deliberately so — this call is spending its whole budget on recall and
 * structure rather than on schema compliance. Its output is fed to the JSON pass as a list to
 * transcribe.
 *
 * Returns undefined rather than failing the build. A model that cannot produce the study can
 * usually still produce a plan, and losing the request entirely because the *optional* pass
 * failed would be a worse outcome than a plainer model.
 */
async function studyObject(
  opts: DecomposeOptions, reference: string, text: string,
): Promise<string | undefined> {
  const reply = await complete(opts.config, {
    system:
      `You are a mechanical engineer identifying an object so it can be modelled in CAD.\n\n` +
      (reference ? `${reference}\n\n` : '') +
      `Answer in plain prose, briefly, under these headings:\n\n` +
      `IDENTITY — what this object specifically is. If it names a real product, state its ` +
      `actual dimensions, mass and configuration. If you do not know the specific product, ` +
      `say so and describe the class it belongs to instead of inventing figures.\n\n` +
      `OVERALL SIZE — length, width, height in millimetres, and mass.\n\n` +
      `PARTS — a numbered list of the physical parts, each with its approximate size and ` +
      `where it sits. Be exhaustive at the level a person would point at and name. For a car ` +
      `that means body panels, glass, wheels, tyres, lights, bumpers, mirrors, seats, and the ` +
      `major mechanical units — not "body" and "wheels".\n\n` +
      `UNCERTAIN — anything you are guessing at.`,
    user: `Identify and break down: ${text}`,
    maxTokens: 1600,
    signal: opts.signal,
  });

  if (!reply.ok) return undefined;
  const study = reply.text.trim();
  return study.length > 40 ? study : undefined;
}

async function askForPlan(
  opts: DecomposeOptions, reference: string, exemplars: string, user: string,
): Promise<PlanAttempt> {
  const reply = await complete(opts.config, {
    system: buildSystemPrompt(reference, exemplars),
    user,
    // A car or an engine is 25 to 60 components, and each carries a name, a role, six
    // placement numbers and a note. At 4 000 those plans came back truncated — which is one
    // of the ways "make a Suzuki Mehran" ended up as three parts: the model was describing
    // the whole car and the reply was being cut off partway down the list.
    //
    // Higher is safe because a free tier's tokens-per-minute limit is handled rather than
    // avoided: a 413 halves the request and retries, so the ceiling costs nothing when it is
    // not available and buys a complete plan when it is.
    maxTokens: 8000,
    signal: opts.signal,
  });

  if (!reply.ok) {
    const failure = reply as CompletionFailure;
    return {
      ok: false,
      failure: {
        ok: false,
        message: failure.message,
        providerError: failure.detail,
        suggestions: starterSuggestions(),
      },
    };
  }

  const parsed = extractJson<unknown>(reply.text);
  if (!parsed) {
    return {
      ok: false,
      failure: {
        ok: false,
        message:
          'The model replied with something that was not a plan. This usually means the model ' +
          'is too small to follow a JSON schema — try a larger one.',
        providerError: reply.text.slice(0, 400),
        suggestions: starterSuggestions(),
      },
    };
  }

  const validated = validatePlan(parsed);
  if ('error' in validated) {
    return {
      ok: false,
      failure: {
        ok: false,
        message: `The model's plan could not be used: ${validated.error}`,
        providerError: JSON.stringify(parsed).slice(0, 400),
        suggestions: starterSuggestions(),
      },
    };
  }

  return {
    ok: true,
    plan: {
      ...validated.plan,
      source: 'model',
      citations: reply.citations.length > 0 ? reply.citations : undefined,
    },
    reply: { model: reply.model, ms: reply.ms, citations: reply.citations },
    validated,
  };
}

/**
 * Reads a size qualifier out of the request.
 *
 * "A small phone" and "a phone" should not produce identical geometry, and the alternative —
 * ignoring the adjective — is the kind of silent non-response that makes a tool feel deaf.
 */
function scaleFrom(text: string): number {
  const lower = text.toLowerCase();
  if (/\b(tiny|miniature|mini)\b/.test(lower)) return 0.6;
  if (/\b(small|compact)\b/.test(lower)) return 0.85;
  if (/\b(large|big|oversized)\b/.test(lower)) return 1.2;
  if (/\b(huge|giant)\b/.test(lower)) return 1.5;
  return 1;
}

function starterSuggestions(): string[] {
  return [
    ...RECIPES.map((r) => r.label.toLowerCase()),
    ...ARCHETYPES.slice(0, 8).map((a) => a.label.toLowerCase()),
  ];
}

/** What the deterministic core can build, for the catalogue in the UI. */
export function catalogue(): { assemblies: string[]; parts: string[] } {
  return {
    assemblies: RECIPES.map((r) => `${r.label} — ${r.summary}`),
    parts: ARCHETYPES.map((a) => a.label),
  };
}

void archetypeById;
void shapeVocabulary;

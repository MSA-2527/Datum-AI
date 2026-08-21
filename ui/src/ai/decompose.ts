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

import {
  complete, extractJson, providerInfo,
  type CompletionFailure, type ProviderConfig, type RequestImage,
} from './providers';
import { ARCHETYPES, archetypeById } from '../generate/archetypes';
import { findMeasures, generateFromText } from '../generate/parse';
import { applyModifiers, compose, readModifiers } from '../generate/compose';
import { askForScript } from './scriptRoute';
import { reviewBuild } from './review';
import { matchRecipe, namesSpecificProduct, RECIPES } from '../assembly/recipes';
import {
  buildAssembly, describePlan, shapeVocabulary, validatePlan,
  type AssemblyPlan,
} from '../assembly/plan';
import {
  addFeature, emptyDocument, evaluateDocument, type Document, type ParamValue,
} from '../model/document';
import { constraintBrief } from '../lib/limits';
import { exemplarBlock, exemplarsFor } from '../lib/training';
import { expandQuery, referenceBlock } from '../reference/retrieve';
import { auditPlan, summariseAudit, type Finding } from '../reference/audit';
import { critique, repairPrompt, summariseCritique, type Critique } from './critique';
import { reasonAbout, type Reasoning } from './reason';
import { describeInspection, inspectDocument } from './inspect';
import type { RequirementKind } from './requirements';
import { describeChecks } from './requirements';

export interface DecomposeSuccess {
  ok: true;
  doc: Document;
  /**
   * The DatumScript this was built from, when it was built from one.
   *
   * Kept so the part can be shown and edited as a program rather than only as a tree — and so
   * a request that worked can be taught as an example of the language, which is what makes a
   * corpus out of ordinary use.
   */
  script?: string;
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
  /**
   * Pictures of what is wanted, for a model that can see.
   *
   * Threaded through every model call this route makes, not only the first. A picture of a
   * rotary kiln is not a picture of one part, so the study pass says ASSEMBLY and the plan
   * route takes it — and the plan route asking "what are this object's components" while
   * looking at a blank page is the whole failure this exists to prevent. The image goes with
   * the question, wherever the question ends up.
   */
  images?: RequestImage[];
  /**
   * Build the parts that can be built, when some of the object cannot be.
   *
   * Off by default, and the default is right: answering "a turbine volute" with a cylinder is
   * the one failure this application cannot afford, because nothing downstream detects it.
   *
   * But refusing *everything* because one component needs a surface the kernel has not got is a
   * different mistake, and the user meets it as a flat no to a reasonable request. A car body
   * needs class-A surfaces; its chassis, wheels, glass and lamps do not, and someone who imported
   * a picture of a car would rather have those than nothing. So it is offered — never taken
   * silently — and what was left out is named in the result.
   */
  allowPartial?: boolean;
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

    /*
     * When the archetype read none of the sizes it was given.
     *
     * An archetype's parameters are its own, and a request can state a shape it recognises in
     * words it does not: "a spacer 20 mm od 8 mm id 12 mm long" matches the washer, whose
     * vocabulary has no "long", and came back at its default size — 0.11 cm³ against the
     * 3.17 cm³ that was asked for, with three stated dimensions silently discarded.
     *
     * The composer has no such vocabulary problem, because it reads dimensions rather than
     * matching them to a fixed schema. So when the archetype understood *nothing* dimensional
     * from a request that plainly states dimensions, and the composer understood them, the
     * composition is the better answer. The bar is deliberately at zero: an archetype that
     * read even one of its sizes knows something about the request, and a named part beats a
     * pile of primitives whenever it does.
     */
    const composedFirst = single.ok && preferComposition(single, text)
      ? compose(text)
      : { ok: false as const, reason: '' };

    if (composedFirst.ok) {
      return fromComposition(text, composedFirst, started);
    }

    if (single.ok) {
      const archetype = single.archetype;
      const params: Record<string, ParamValue> = { archetypeId: archetype.id };
      for (const spec of archetype.defaults) {
        params[spec.key] = single.parsed.params[spec.key] ?? spec.value;
      }

      // The archetype's own material, so a wooden table is not costed as aluminium.
      const base = emptyDocument(archetype.label);
      const built = addFeature(
        archetype.material
          ? { ...base, material: archetype.material.name, density: archetype.material.density }
          : base,
        'archetype', params, archetype.label,
      );

      /*
       * Everything the archetype did not read.
       *
       * An archetype knows its own shape and nothing else, so a request for one carrying an
       * operation it has no parameter for lost that operation entirely: "a hollow box
       * 80 x 60 x 40 with 3 mm walls" came back solid at exactly 192.00 cm³, and "a 60 x 40 x 10
       * block with an 8 mm hole" came back with no hole. Both reported success, which is the
       * failure mode worth removing — the part measures right for what was built and wrong for
       * what was asked.
       *
       * Only what the archetype did not already cover is added. A plate's own bolt holes stay
       * the plate's business; a shell it has no concept of becomes a real shell feature.
       */
      const extra = readModifiers(text);

      // What the archetype can build, not what the request happened to state. A plate builds
      // bolt holes from its own defaults whether or not the sentence gave a diameter, so a
      // second hole feature on top of them would drill the part twice.
      const owned = new Set(archetype.defaults.map((d) => d.key));
      const wanted = extra.modifiers.filter((m) => !COVERED[m.kind].some((k) => owned.has(k)));

      const doc = wanted.length > 0 ? applyModifiers(built, wanted, acrossOf(single)) : built;

      const readParts = [
        ...single.parsed.understood,
        ...wanted.map((m) => m.describe),
      ];
      const understood = readParts.length > 0 ? ` Read: ${readParts.join(', ')}.` : '';

      const ignored = extra.unhandled.length > 0
        ? ` Not built, because there is no operation for it: ${extra.unhandled.join('; ')}.`
        : '';

      const reasoned = reasonAbout(
        text, doc,
        `Recognised a ${archetype.label.toLowerCase()} in the built-in catalogue and sized it ` +
        'from the request.',
        { built: boundDimensions(single) },
      );

      return {
        ok: true,
        doc: reasoned.doc,
        plan: null,
        route: 'catalogue',
        reasoning: reasoned.reasoning,
        message: [
          `Built a ${archetype.label.toLowerCase()}.${understood}${ignored}`,
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

  /*
   * 2b. Composed from primitives.
   *
   * The catalogue is a finite list of named parts. This is not: it reads a request as a shape
   * and the operations performed on it, which covers the parts a shop actually makes one-off —
   * spacers, bushes, standoffs, mounting blocks, plates with pockets — none of which is worth
   * an archetype and all of which are worth building.
   *
   * After the catalogue, because a named archetype knows more about its own shape than a
   * composition of primitives ever can: a cup gets a handle and a gear gets involute teeth.
   */
  if (!opts.preferModel) {
    const composed = compose(text);
    if (composed.ok) return fromComposition(text, composed, started);
  }

  // 3. A model.
  if (opts.config.id === 'none') {
    // The parser already worked out *why* it could not answer — which noun it does not have,
    // and which shapes are nearest. Quoting "nothing matches your request" over the top of
    // that throws away the only part of the answer a user can act on.
    const attempt = generateFromText(text);
    const why = attempt.ok ? '' : attempt.message;

    return {
      ok: false,
      message: why
        ? `${why} Or configure a model in AI settings, which can decompose objects that are ` +
          `not in the catalogue into parts that are.`
        : `Nothing in the built-in catalogue matches "${text}". ` +
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

  /*
   * 3a. One part, written as a program.
   *
   * The plan route below decomposes a request into components, each of which must name a
   * shape from the catalogue — so its ceiling is the catalogue's. A crankshaft is not in it,
   * and a decomposition of a crankshaft into cylinders is not a crankshaft.
   *
   * A script has no such ceiling. Every statement still names a feature the kernel implements
   * and every argument is still checked against that feature's own schema — a script that
   * could not be built does not parse — but the combinations are unbounded. The model is
   * limited by what the language can say rather than by what somebody thought to add to a
   * list, which is the difference between raising the ceiling and removing it.
   *
   * Routed on the study's own verdict rather than on a keyword rule: nothing about the words
   * says that a gearbox is an assembly and a crankshaft is not, and the pass that has just
   * worked out what the object is knows. When there is no study — the call failed, or none
   * was made — the plan route runs, which is what happened before this existed.
   */
  /*
   * The study's own verdict that nothing here can express the shape.
   *
   * Refusing is the answer, and it is the same answer the offline routes give: naming what is
   * missing is more use than a solid that is the right volume and the wrong object. A part
   * returned as correct when it is not is the one failure mode this application cannot afford,
   * because nothing downstream can detect it — the mass is real, the drawing dimensions it,
   * and the manufacturability rules pass it.
   */
  const unbuildable = study ? readUnbuildable(study) : null;

  /**
   * What the caller chose to go ahead without.
   *
   * Set only when the study said no *and* the caller asked to build anyway. It travels all the
   * way to the message, because a partial build is honest exactly as long as its limits do.
   */
  const omitted = unbuildable && opts.allowPartial ? unbuildable : null;

  if (unbuildable && !opts.allowPartial) {
    return {
      ok: false,
      message:
        `This cannot be built here, and building the nearest thing to it would give you a ` +
        `part you did not ask for. ${unbuildable} ` +
        `The shapes available are: ${BUILDABLE_VOCABULARY}.`,
      suggestions: starterSuggestions(),
    };
  }

  if (study && /\bMAKE\b[^A-Za-z]{0,12}ONE-PART/i.test(study)) {
    const scripted = await askForScript(text, {
      config: opts.config, signal: opts.signal, reference, exemplars, images: opts.images,
      // Look at the finished part before accepting it. `reviewBuild` declines gracefully when
      // the provider has no eyes, so this costs nothing where it cannot be spent.
      look: providerInfo(opts.config.id).supportsImages,
    });

    if (!('assembly' in scripted) && scripted.ok) {
      const reasoned = reasonAbout(text, scripted.doc, scripted.message);

      /*
       * Looked at as geometry, not only as a description.
       *
       * `reasonAbout` checks the result against what was asked — the dimensions the request
       * stated. That leaves everything the request did *not* state: a boss floating clear of the
       * face it belongs on, a component turned 89.4°, a part swallowed inside another. None of
       * those contradict any requirement, and all of them are visible in a second's looking.
       */
      const inspected = inspectDocument(scripted.doc, evaluateDocument(scripted.doc));
      const looked = describeInspection(inspected);

      return {
        ok: true,
        doc: reasoned.doc,
        plan: null,
        route: 'model',
        reasoning: reasoned.reasoning,
        message: [scripted.message, describeChecks(reasoned.reasoning.checks), looked]
          .filter(Boolean).join(' ').trim(),
        corrections: [],
        dropped: [],
        citations: [],
        findings: [],
        inspected: [],
        repaired: scripted.repairs > 0,
        ms: Date.now() - started,
        script: scripted.source,
      };
    }

    // A script the model could not make build is not a reason to give up on the request: the
    // plan route may still answer it, more coarsely, and a coarse answer beats none.
  }

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

  /*
   * Look at the assembly too.
   *
   * The script route already does this. The plan route did not, and it is the one that
   * answered a request for a turbine volute with three cylinders — every check it ran passed,
   * because every check it ran read a description. A part that measures correctly and is not
   * the thing asked for is invisible to a bounding box and obvious in a picture.
   *
   * Reported, not refused. An assembly that a reviewer objects to is still worth handing over
   * with the objection attached: the user can see both, which is more than either alone. The
   * objection also clears `satisfied`, so it surfaces as a warning rather than as success.
   */
  const looked = providerInfo(opts.config.id).supportsImages
    ? await reviewBuild(text, reasoned.doc, { config: opts.config, signal: opts.signal })
    : undefined;

  if (looked?.verdict === 'wrong') {
    parts.push(`Looking at it, this is not right: ${looked.notes.join('; ')}.`);
  }

  /*
   * What was knowingly left out, said in the result and not only at the moment of asking.
   *
   * A partial build is honest exactly as long as its limits travel with it. Said once in a
   * dialog and dropped, this becomes a car with no body panels that the user is told is a car —
   * which is the failure the refusal existed to prevent, arrived at from the other direction.
   */
  if (omitted) {
    parts.push(`Built without the parts this kernel cannot express: ${omitted}`);
  }

  return {
    ok: true,
    doc: reasoned.doc,
    plan,
    route: 'model',
    reasoning: looked?.verdict === 'wrong'
      ? { ...reasoned.reasoning, satisfied: false }
      : reasoned.reasoning,
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

/**
 * The shapes this system can make, in one line, for the study to judge against.
 *
 * Deliberately coarse. The study is deciding whether an object's *form* is expressible, not
 * writing the part, and handing it the full parameter schema would invite it to reason about
 * arguments instead of about shape.
 */
const BUILDABLE_VOCABULARY = [
  'extrusions and revolutions of closed profiles',
  'lofts between two sections',
  'sweeps of a constant section along a path',
  'boxes, cylinders, spheres and cones',
  'boolean add, cut and intersect',
  'holes, pockets, slots, ribs, shells, draft, domes',
  'constant-radius fillets and chamfers',
  'linear, circular and mirrored patterns',
].join('; ');


/**
 * The study's buildability verdict, or null when it did not object.
 *
 * Conservative by construction: only an explicit NO refuses. A study that omitted the heading,
 * hedged, or came back unparseable lets the request through to the routes below, because
 * losing a buildable part to a misread heading is worse than building one that should have
 * been declined — the second is visible and the first is not.
 */
export function readUnbuildable(study: string): string | null {
  const m = /\bBUILDABLE\b[^A-Za-z]{0,12}(YES|NO)\b([^\n]*)/i.exec(study);
  if (!m || m[1]!.toUpperCase() !== 'NO') return null;

  const because = (m[2] ?? '').replace(/^[\s—:,.-]+/, '').trim();
  return because.length > 0 ? because : 'Its shape needs an operation this kernel does not have.';
}

async function studyObject(
  opts: DecomposeOptions, reference: string, text: string,
): Promise<string | undefined> {
  const reply = await complete(opts.config, {
    ...(opts.images ? { images: opts.images } : {}),
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
      `UNCERTAIN — anything you are guessing at.\n\n` +
      // One extra line, no extra round trip. The pass that is already working out what the
      // object *is* is the one best placed to say whether it is one part or several, and
      // asking a separate call to decide would be paying twice to think once.
      `MAKE — exactly one of the words ONE-PART or ASSEMBLY. ONE-PART if this is a single ` +
      `piece of material, however complicated its shape: a crankshaft, a housing, a bracket, ` +
      `an impeller. ASSEMBLY if it is separate pieces made individually and fitted together.` +
      `\n\n` +
      /*
       * Whether the shape can be expressed at all.
       *
       * Measured, not assumed: with a model configured, a request for a hydroformed turbine
       * volute with variable-section runners came back as three cylinders and a closed solid.
       * Offline that request is refused by name; the decomposition route asks a model to break
       * an object into components, and a model asked to decompose complies. The result was a
       * 300 cm³ part that is not a turbine volute, returned as though it were.
       *
       * That is the failure this whole application is built to avoid, so the pass that already
       * knows what the object is has to answer it. The criterion is deliberately about *shape*
       * and not about difficulty: everything below is a real feature the kernel implements, and
       * a form that needs something not on the list cannot be built here however hard anyone
       * tries.
       */
      `BUILDABLE — exactly one of the words YES or NO, then one sentence.\n` +
      `The only shapes this system can make are combinations of these operations:\n` +
      `  ${BUILDABLE_VOCABULARY}\n` +
      `Answer YES if the object's real form is a combination of those — most machined, turned, ` +
      `moulded and fabricated parts are. Answer NO only when the shape is *defined* by ` +
      `something not on that list: a variable-section or freeform surface, an aerofoil, a ` +
      `class-A body panel, a volute or scroll whose cross-section changes along its path, a ` +
      `blended organic form. After NO, name the missing capability in one sentence. Do not ` +
      `answer NO because a part is complicated or has many features; answer NO because the ` +
      `shape cannot be said in those words.`,
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
    // The picture goes with the question. A plan route asked what an object is made of,
    // while looking at nothing, answers about nothing.
    ...(opts.images ? { images: opts.images } : {}),
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

/**
 * Archetype parameters that already express each operation.
 *
 * If the request stated one of these, the archetype has the instruction and adding a feature
 * for it as well would apply it twice — a plate would get its own bolt holes and a second
 * hole on top of them.
 */
const COVERED: Record<string, string[]> = {
  hole: ['holeDia', 'holesPerLeg', 'boltCount', 'boltDia', 'boreDia'],
  fillet: ['filletRadius', 'cornerRadius', 'rimFillet'],
  chamfer: ['chamfer'],
  shell: ['wall', 'wallThickness', 'baseThickness'],
  pocket: [],
  slot: [],
};

/** The archetype's smallest horizontal size, for placing a hole pattern inside it. */
function acrossOf(single: Extract<ReturnType<typeof generateFromText>, { ok: true }>): number {
  const p = single.parsed.params;
  const candidates = ['width', 'length', 'outerDia', 'bodyDia', 'diameter', 'acrossFlats']
    .map((k) => p[k])
    .filter((v): v is number => typeof v === 'number' && v > 0);

  return candidates.length > 0 ? Math.min(...candidates) : 0;
}

/** A composed part, as a decomposition result. Shared by both places composition can win. */
function fromComposition(
  text: string,
  composed: Extract<ReturnType<typeof compose>, { ok: true }>,
  started: number,
): DecomposeSuccess {
  const reasoned = reasonAbout(
    text, composed.doc, `Read the request as ${composed.understood.join(', ')}.`,
  );

  const ignored = composed.unhandled.length > 0
    ? ` Not built, because there is no operation for it: ${composed.unhandled.join('; ')}.`
    : '';

  const count = composed.doc.features.length;

  return {
    ok: true,
    doc: reasoned.doc,
    plan: null,
    route: 'catalogue',
    reasoning: reasoned.reasoning,
    message: [
      `Built it from ${count} feature${count === 1 ? '' : 's'}. ` +
      `Read: ${composed.understood.join(', ')}.${ignored}`,
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

/**
 * Whether a composition beats the archetype the catalogue matched.
 *
 * Two cases, and both are about the archetype knowing less than it appears to.
 *
 * A **primitive** archetype — box, cylinder, sphere — is a bare solid with no design content
 * at all, so there is nothing the composer can lose by replacing it and a good deal to gain:
 * the archetype's parser binds a dimension only to a keyword, so "a 50 mm cylinder 80 mm long"
 * left the diameter on its default, while the composer reads the 50 that sits in front of the
 * noun. Anything with real content in it — a cup's handle, a gear's involute teeth — keeps
 * priority, because a named part beats a pile of primitives every time.
 *
 * The second case is an archetype that read **none** of the sizes it was given, which means
 * the request stated them in words its schema does not have. Then the sizes are the only thing
 * anyone said, and the answer that uses them is the better one.
 */
function preferComposition(
  single: Extract<ReturnType<typeof generateFromText>, { ok: true }>,
  text: string,
): boolean {
  if (single.archetype.category === 'primitive') return true;
  return single.parsed.understood.length === 0 && findMeasures(text).length >= 2;
}

/**
 * Which stated dimensions the archetype actually bound to one of its parameters.
 *
 * Read off `understood`, which the parser writes one entry into per parameter it filled from
 * the request — so this is a record of what was built to on purpose, not a guess about it.
 */
function boundDimensions(
  single: Extract<ReturnType<typeof generateFromText>, { ok: true }>,
): RequirementKind[] {
  const out = new Set<RequirementKind>();

  for (const phrase of single.parsed.understood) {
    const word = phrase.split('=')[0]!.trim().toLowerCase();

    if (/\b(long|length)\b/.test(word)) out.add('length');
    if (/\b(wide|width)\b/.test(word)) out.add('width');
    if (/\b(tall|high|height|thick|thickness|deep|depth)\b/.test(word)) out.add('height');
    if (/\b(od|id|dia|diameter|bore|across)\b/.test(word)) out.add('diameter');
  }

  return [...out];
}

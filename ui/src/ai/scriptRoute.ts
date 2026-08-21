import { complete, type ProviderConfig, type RequestImage } from './providers';
import {
  printScript, runScript, scriptVocabulary, SCRIPT_KINDS, type ScriptError,
} from '../generate/script';
import { evaluateDocument, type Document } from '../model/document';
import { triCount } from '../kernel/topo/mesh';
import { constraintBrief } from '../lib/limits';
import { reviewBuild, type Review } from './review';

/**
 * Asking a model to write a part, rather than to fill in a form.
 *
 * ── What this changes ──
 *
 * The existing model route asks for an `AssemblyPlan`: a decomposition into components, each
 * of which must name a shape from the 27-item catalogue. That constrains the model usefully —
 * it cannot emit a mesh or an operation the kernel does not implement — and it also means the
 * model's ceiling is the catalogue's. A crankshaft is not in the catalogue, so no amount of
 * model capability produces one; the plan route would answer with a decomposition of a
 * crankshaft into cylinders, which is not a crankshaft.
 *
 * Asking for a *script* keeps the constraint and removes the ceiling. Every statement still
 * names a feature the kernel implements and every argument is still checked against that
 * feature's own schema — a script that could not be built does not parse. But the
 * combinations are unbounded, so the model is limited by what the language can say rather than
 * by what somebody thought to add to a list.
 *
 * ── The repair loop is the point ──
 *
 * A first attempt at a program is a draft. Published results on this task put first-attempt
 * validity well below half and a usable result within a handful of rounds; the difference is
 * entirely in whether the errors go back. So they do, by line number, with the line quoted —
 * every error at once, because a model that is handed one error per round converges one line
 * per round.
 *
 * Two repairs, not more. The errors a second and third pass fix are the mechanical ones — a
 * misspelled argument, a parameter that does not resolve — and past that the returns fall off
 * while the user waits and pays for every round.
 */

export interface ScriptAttempt {
  ok: boolean;
  /** The document the script built. Empty when every attempt failed. */
  doc: Document;
  /** The script as the model last wrote it, for showing and for editing. */
  source: string;
  /** How many times it had to be sent back. Zero means it was right first time. */
  repairs: number;
  /** What was still wrong after the last attempt. */
  errors: ScriptError[];
  /** What the part looked like, when a model could be shown it. */
  review?: Review;
  message: string;
}

/** How many times a failing script is handed back with its errors. */
const MAX_REPAIRS = 2;

/**
 * The one word that routes a request away from here.
 *
 * A model that knows what the object is knows whether it is one part or several, and it is
 * better placed to say so than any keyword rule — "gearbox" is an assembly and "crankshaft" is
 * not, and nothing about the words says which.
 */
export const ASSEMBLY_MARKER = 'ASSEMBLY';

export interface ScriptRouteOptions {
  config: ProviderConfig;
  signal?: AbortSignal;
  /** Retrieved standards and worked examples, as the plan route assembles them. */
  reference?: string;
  exemplars?: string;
  /**
   * Show the finished part to the model and let it judge what it wrote.
   *
   * Off by default. It costs a round trip and a handful of images, and it is only worth
   * spending where the request came from a person rather than from a test.
   */
  look?: boolean;
  /**
   * Pictures of what is wanted, for a model that can see.
   *
   * The route by which an image of a real machine becomes a part. Tracing an outline can only
   * recover a flat shape — see `ingest/image/subject.ts` — so anything three-dimensional has to
   * be *read* rather than measured, and reading a picture is what a vision model is for.
   */
  images?: RequestImage[];
}

export async function askForScript(
  request: string, opts: ScriptRouteOptions,
): Promise<ScriptAttempt | { assembly: true }> {
  const system = systemPrompt(opts.reference ?? '', opts.exemplars ?? '');

  const seeing = (opts.images ?? []).length > 0;

  const TAIL = 'Reply with the script and nothing else — no explanation, no code fence.';

  let user = seeing
    ? [
      'Write a DatumScript for what is shown in the image.',
      '',
      request,
      '',
      'Model every distinct component you can see as its own feature, named for what it is.',
      'Where a dimension is not stated, choose one that keeps the proportions of the image',
      'and declare it as a param, so it can be corrected rather than guessed at again.',
      '',
      TAIL,
    ].join('\n')
    : `Write a DatumScript for this part:\n\n${request}\n\n${TAIL}`;

  let source = '';
  let errors: ScriptError[] = [];

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const reply = await complete(opts.config, {
      system, user, maxTokens: 4000, signal: opts.signal,
      /*
       * The image goes with the first attempt only.
       *
       * A repair round is a conversation about a parse error in a script the model has already
       * written; re-sending the picture costs the same tokens as the first look and carries no
       * new information. The model is being asked what line 7 should say, not what the part is.
       */
      ...(attempt === 0 && seeing ? { images: opts.images } : {}),
    });

    if (!reply.ok) {
      return {
        ok: false, doc: evaluateEmpty(), source, repairs: attempt, errors,
        message: reply.message,
      };
    }

    source = stripFences(reply.text);

    // The model's own judgement that this is not a single part.
    if (source.trim().toUpperCase().startsWith(ASSEMBLY_MARKER)) return { assembly: true };

    /*
     * A reply that is not an attempt at a script at all.
     *
     * Repairing costs a round trip each, and it is only worth spending on a script that is
     * nearly right. A model that answers with JSON, or with prose, or with an apology has not
     * written a broken script — it has declined to write one, whatever words it used, and
     * three rounds of "line 1: that is not something this can build" will not change its mind.
     * Handing over immediately costs one call instead of three.
     */
    if (!looksLikeScript(source)) return { assembly: true };

    const result = runScript(source);
    errors = result.errors;

    if (result.ok) {
      // Parsing is not building. A script can be perfectly well-formed and produce nothing —
      // a shell with no body, a cut that removes everything — and reporting that as a success
      // hands back an empty viewport with a cheerful message.
      const evaluated = evaluateDocument(result.doc);
      const built = triCount(evaluated.mesh) > 0;
      const failed = [...evaluated.errors.entries()];

      if (built && failed.length === 0) {
        /*
         * Look at it before accepting it.
         *
         * Everything up to here has judged the part by reading its description. A script that
         * parses, builds and closes can still be recognisably not the thing that was asked
         * for, and no amount of re-reading the program finds that — a boss floating clear of
         * the face it should sit on is obvious in a picture and invisible in the text.
         *
         * A verdict of `wrong` becomes another repair round with the reasons attached, so the
         * model is fixing something it can see rather than something it has been told. Only
         * once: a second opinion on the same part is usually the same opinion, and the user is
         * paying for every round.
         */
        const review = opts.look && attempt < MAX_REPAIRS
          ? await reviewBuild(request, result.doc, { config: opts.config, signal: opts.signal })
          : undefined;

        if (review?.verdict === 'wrong') {
          errors = review.notes.map((note) => ({ line: 0, message: note, source: '' }));
          user = lookedWrongPrompt(printScript(result.doc), review.notes);
          continue;
        }

        return {
          ok: true,
          doc: result.doc,
          source: printScript(result.doc),
          repairs: attempt,
          errors: [],
          ...(review ? { review } : {}),
          message:
            `Wrote and ran a ${result.doc.features.length}-feature script` +
            `${attempt > 0 ? ` (${attempt} repair${attempt === 1 ? '' : 's'})` : ''}` +
            `${review?.verdict === 'matches' ? ', and checked it against the request by eye' : ''}.`,
        };
      }

      // Well-formed but it did not build. Hand back what the evaluator said, which names the
      // feature rather than the line — that is what the model needs to fix it.
      errors = failed.length > 0
        ? failed.map(([id, message]) => ({
            line: lineOfFeature(result.doc, id),
            message,
            source: result.doc.features.find((f) => f.id === id)?.name ?? '',
          }))
        : [{ line: 1, message: 'The script ran but produced no solid at all.', source: '' }];
    }

    if (attempt === MAX_REPAIRS) break;
    user = repairPrompt(source, errors);
  }

  return {
    ok: false,
    doc: evaluateEmpty(),
    source,
    repairs: MAX_REPAIRS,
    errors,
    message:
      `The model could not write a script that builds, after ${MAX_REPAIRS + 1} attempts. ` +
      `Last problems: ${errors.slice(0, 3).map((e) => `line ${e.line}, ${e.message}`).join('; ')}`,
  };
}


/**
 * Whether a reply is an attempt at a script.
 *
 * One line beginning with a statement keyword is enough — the parser judges the rest. The test
 * is deliberately generous: the cost of being wrong here is one wasted repair, and the cost of
 * being too strict is discarding a script over its preamble.
 */
export function looksLikeScript(text: string): boolean {
  /*
   * Lowercased on both sides, because three of the kinds carry a capital in the middle.
   *
   * Testing a lowercased word against the set as written meant `patternLinear` — a keyword the
   * prompt hands the model verbatim — was never recognised as one. A reply whose first
   * statement was a pattern did not look like a script at all, so it was discarded as prose,
   * and the model took the blame for a reply it had written correctly.
   */
  const keywords = new Set<string>(
    [...SCRIPT_KINDS, 'param', 'name', 'material', 'units'].map((k) => k.toLowerCase()),
  );

  return text.split('\n').some((line) => {
    const first = line.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    return keywords.has(first);
  });
}

// ── prompting ────────────────────────────────────────────────────────────────

function systemPrompt(reference: string, exemplars: string): string {
  return [
    'You write DatumScript, a declarative language for parametric solid parts.',
    '',
    'A script is one statement per line. Statements are:',
    '',
    '  param <name> = <number or expression>   a driving dimension',
    '  name <text>                             what the part is called',
    '  material <text>                         what it is made of',
    '  <feature> [Name] key=value key=value    a modelling operation',
    '',
    'Values may be numbers or arithmetic over parameters: length/2, wall*3, bore+2.',
    'Any feature may also take at.x, at.y, at.z, at.rx, at.ry, at.rz to place it.',
    'Millimetres and degrees throughout. Z is up. Comments start with #.',
    '',
    'These are the features and every argument each one takes. Nothing else exists:',
    '',
    scriptVocabulary(),
    '',
    'Rules:',
    '  - Features apply in order to the solid built so far. Build a body before cutting it.',
    '  - Use operation=cut to remove material with a primitive.',
    '  - Fillet and chamfer last: they act on the edges that exist when they run.',
    '  - patternLinear, patternCircular and mirror repeat the WHOLE body built so far, not the',
    '    last feature. To repeat one thing, pattern it before anything else exists, or place',
    '    the copies yourself with at.x=first+1*pitch, at.x=first+2*pitch, and so on.',
    '  - Declare a param for any dimension that appears more than once, or that someone',
    '    would plausibly want to change. That is what makes the part parametric rather than',
    '    a fixed lump.',
    '  - Do not invent features or arguments. A name not in the list above is a parse error.',
    '',
    'If the request describes an assembly of separate parts rather than one part — something',
    `with components that are made individually and fitted together — reply with the single`,
    `word ${ASSEMBLY_MARKER} and nothing else.`,
    '',
    // The same limits the linter enforces, stated once. A part designed against a wall
    // thickness the shop cannot machine is a part that fails inspection after it is built.
    constraintBrief(),
    reference ? `\n${reference}` : '',
    exemplars ? `\n${exemplars}` : '',
  ].join('\n');
}


/**
 * The repair prompt for a part that built correctly and looked wrong.
 *
 * Deliberately different from the parse-error one. Nothing here is a line number, because
 * nothing is a syntax problem: the script is valid and the *part* is not, so what goes back is
 * the whole program and what was seen in it.
 */
function lookedWrongPrompt(source: string, notes: string[]): string {
  return [
    'That script built, but looking at the result it is not right:',
    '',
    ...notes.map((n) => `  - ${n}`),
    '',
    'Here is the script that produced it:',
    '',
    source,
    '',
    'Rewrite it to fix what was seen. Reply with the script and nothing else.',
  ].join('\n');
}

function repairPrompt(source: string, errors: ScriptError[]): string {
  const numbered = source.split('\n')
    .map((line, i) => `${String(i + 1).padStart(3)} | ${line}`)
    .join('\n');

  const listed = errors
    .map((e) => `  line ${e.line}: ${e.message}`)
    .join('\n');

  return [
    'That script did not build. Here it is with line numbers:',
    '',
    numbered,
    '',
    'What went wrong:',
    listed,
    '',
    'Rewrite the whole script with those fixed. Reply with the script and nothing else.',
  ].join('\n');
}

// ── odds and ends ────────────────────────────────────────────────────────────

/**
 * Strips a code fence, which models add whatever the instruction says.
 *
 * Refusing the reply over punctuation would discard an otherwise perfect script, and the
 * content is validated line by line immediately afterwards either way.
 */
export function stripFences(text: string): string {
  const fenced = /```(?:[a-zA-Z]*)?\n([\s\S]*?)```/.exec(text);
  return (fenced ? fenced[1]! : text).trim();
}

function lineOfFeature(doc: Document, id: string): number {
  const at = doc.features.findIndex((f) => f.id === id);
  return at < 0 ? 1 : at + 1;
}

function evaluateEmpty(): Document {
  return runScript('').doc;
}

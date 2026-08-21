/**
 * Changing the part that is open, rather than replacing it.
 *
 * ── The behaviour this exists to end ──
 *
 * Every request that was not one of a handful of recognised phrasings — "rename X", "suppress
 * X", "make X 20 mm thick" — fell through to a fresh build. So "make the shell longer and add a
 * third pier", said to a rotary kiln that took twenty minutes to get right, threw the kiln away
 * and built a new one. Nothing was lost that undo could not recover, and that is not the point:
 * an assistant that answers a correction by starting over is one nobody dares talk to.
 *
 * `edit.ts` handles the phrasings it can parse without a model, and it should keep them —
 * offline, instant, exact. This is the rest: the requests that are plainly edits and plainly
 * beyond a regular expression.
 *
 * ── Why a script round trip ──
 *
 * A document prints as a DatumScript and a DatumScript parses back to a document, exactly.
 * That makes the edit expressible as *text in, text out*: the model is shown the part it is
 * changing, in full, and returns the same program with the requested change made. What comes
 * back is checked by the same parser as any other script, so an edit cannot introduce geometry
 * the kernel could not build any more than a fresh script can.
 *
 * The alternative — asking for a structured patch — sounds safer and is worse. It cannot
 * express "add a third pier between the other two", which needs a new statement placed in
 * context, and it gives the model no view of what it is changing.
 *
 * ── What is guarded ──
 *
 * A model asked to change one line will sometimes rewrite everything, and the result would look
 * like a fresh build wearing an edit's clothes. So the returned script is compared with the one
 * sent: what changed is counted, reported, and — when a request that should have touched a line
 * or two has rewritten the whole part — handed back as a refusal rather than as a result. The
 * user asked for a change, and a replacement is not a large change.
 */

import { complete, type ProviderConfig, type RequestImage } from './providers';
import { printScript, runScript } from '../generate/script';
import { looksLikeScript } from './scriptRoute';
import { evaluateDocument, type Document } from '../model/document';
import { triCount } from '../kernel/topo/mesh';
import { constraintBrief } from '../lib/limits';
import { describeInspection, inspectDocument, type Inspection } from './inspect';

/**
 * The one word that says this is not an edit at all.
 *
 * "A gearbox", said with a bracket on screen, is a new request. The model is better placed to
 * judge that than any keyword rule — and getting it wrong in this direction is cheap, because
 * the request simply goes to the route it would have gone to before.
 */
export const NEW_PART_MARKER = 'NEW';

export interface EditAttempt {
  ok: boolean;
  doc: Document;
  /** The script as it now stands. */
  source: string;
  /** Lines added, removed and changed, for showing what was done. */
  changes: ScriptChange[];
  /**
   * What looking at the result found — parts left floating, angles off square, sizes adrift.
   *
   * An edit is the likeliest place for a component to come loose: a model asked to lengthen a
   * shell changes the shell and leaves the piers where they were, and the part comes back longer
   * and standing on nothing. Every finding here is reported, none blocks the edit.
   */
  inspected: Inspection[];
  /**
   * True when the model could not be reached at all — no key, no network, quota spent.
   *
   * Different in kind from every other failure here, and the caller has to be able to tell.
   * A model that answered and whose answer was rejected has had its say; a model that never
   * answered has not, and the request deserves the route it would have taken had no model been
   * configured. Without this, one dead API key stopped a part being built that the offline
   * catalogue could have made instantly.
   */
  providerFailed?: boolean;
  message: string;
}

export interface ScriptChange {
  kind: 'added' | 'removed' | 'changed';
  /** 1-based line in the new script for added and changed, in the old for removed. */
  line: number;
  text: string;
  /** What the line said before, for a change. */
  was?: string;
}

export interface EditRouteOptions {
  config: ProviderConfig;
  signal?: AbortSignal;
  images?: RequestImage[];
  /**
   * How much of the part a single request is allowed to rewrite, as a fraction of its lines.
   *
   * Not a style preference. Past this it is not an edit any more, and returning it as one hides
   * a replacement inside a message that says "changed 2 things". Generous, because a request
   * can legitimately be sweeping — "make it all steel and twice the size" touches everything —
   * and the check is there to catch a model that ignored the instruction, not to police scope.
   */
  maxRewrite?: number;
}

const DEFAULT_MAX_REWRITE = 0.8;

/**
 * Asks a model to make a change to the part that is open.
 *
 * Returns `{ newPart: true }` when the model judges the request to be about something else
 * entirely, so the caller can send it down the build route instead.
 */
export async function askForEdit(
  request: string, doc: Document, opts: EditRouteOptions,
): Promise<EditAttempt | { newPart: true }> {
  const before = printScript(doc);

  const reply = await complete(opts.config, {
    system: systemPrompt(),
    user: [
      'This is the part that is currently open:',
      '',
      before,
      '',
      'Make this change to it:',
      '',
      request,
      '',
      'Reply with the complete script as it should now read, and nothing else.',
      `If the request is not a change to this part but a request for a different object, reply with the single word ${NEW_PART_MARKER}.`,
    ].join('\n'),
    maxTokens: 4000,
    signal: opts.signal,
    ...(opts.images ? { images: opts.images } : {}),
  });

  if (!reply.ok) {
    return {
      ok: false, doc, source: before, changes: [], inspected: [],
      providerFailed: true, message: reply.message,
    };
  }

  const after = stripFences(reply.text);
  if (after.trim().toUpperCase().startsWith(NEW_PART_MARKER)) return { newPart: true };

  /*
   * A reply that is not an attempt at a script has declined to edit, whatever words it used.
   *
   * Asked to change a bracket into "a 120 × 80 × 8 mm mounting plate", a model quite reasonably
   * answers with a *new part* — as JSON, as prose, as a plan — because that is what the sentence
   * asked for even though it arrived at the edit route. Reading that as a broken edit produced
   * the worst possible response: `"{" is not something this can build`, and the request the
   * offline catalogue would have answered in a hundred milliseconds was thrown away.
   *
   * Handed back as a new part instead, which is the route it should have taken. Same reasoning
   * as the script route uses for the same shape of reply, and cheap to be wrong about: the build
   * route is where the request was going anyway.
   */
  if (!looksLikeScript(after)) return { newPart: true };

  const result = runScript(after);
  if (!result.ok) {
    return {
      ok: false,
      doc,
      source: before,
      changes: [],
      inspected: [],
      message:
        `The change could not be applied: ${result.errors[0]?.message ?? 'the script did not parse.'} `
        + 'The part is unchanged.',
    };
  }

  const evaluated = evaluateDocument(result.doc);
  if (triCount(evaluated.mesh) === 0) {
    // A script that parses and builds nothing is not a change, it is a deletion with extra
    // steps — and returning it would empty the viewport while reporting success.
    return {
      ok: false,
      doc,
      source: before,
      changes: [],
      inspected: [],
      message: 'That change would leave nothing to build, so it was not applied.',
    };
  }

  const inspected = inspectDocument(result.doc, evaluated);
  const changes = diffScripts(before, after);
  const limit = opts.maxRewrite ?? DEFAULT_MAX_REWRITE;
  const lines = Math.max(1, before.split('\n').filter((l) => l.trim().length > 0).length);
  const touched = changes.filter((c) => c.kind !== 'added').length / lines;

  if (touched > limit) {
    return {
      ok: false,
      doc,
      source: before,
      changes,
      inspected: [],
      message:
        `That came back as a rewrite of the whole part rather than a change to it — `
        + `${changes.length} of ${lines} lines. The part is unchanged. `
        + 'Say which feature to change, or start a new part if that is what you meant.',
    };
  }

  const said = describeInspection(inspected);

  return {
    ok: true,
    doc: result.doc,
    source: after,
    changes,
    inspected,
    message: `${describeChanges(changes)}${said ? ` ${said}` : ''}`,
  };
}

// ── what changed ─────────────────────────────────────────────────────────────

/**
 * The difference between two scripts, line by line.
 *
 * A shortest-edit diff would be better for prose and is not better here. A script's lines are
 * features, and a feature keeps its identity by *name*: `box Base length=120 …` edited to
 * `box Base length=150 …` is the same feature with a different size, and reporting it as one
 * line removed and another added would tell the user their base plate was deleted and replaced.
 * So lines are paired by their leading `kind name`, and only what is left over counts as an
 * addition or a removal.
 */
export function diffScripts(before: string, after: string): ScriptChange[] {
  const key = (line: string): string => line.trim().split(/\s+/).slice(0, 2).join(' ');

  const oldLines = before.split('\n').map((l, i) => ({ text: l, line: i + 1 }))
    .filter((l) => l.text.trim().length > 0 && !l.text.trim().startsWith('#'));
  const newLines = after.split('\n').map((l, i) => ({ text: l, line: i + 1 }))
    .filter((l) => l.text.trim().length > 0 && !l.text.trim().startsWith('#'));

  const changes: ScriptChange[] = [];
  const takenOld = new Set<number>();

  for (const now of newLines) {
    const match = oldLines.find((was, i) => !takenOld.has(i) && key(was.text) === key(now.text));

    if (!match) {
      changes.push({ kind: 'added', line: now.line, text: now.text.trim() });
      continue;
    }

    takenOld.add(oldLines.indexOf(match));
    if (match.text.trim() !== now.text.trim()) {
      changes.push({
        kind: 'changed', line: now.line, text: now.text.trim(), was: match.text.trim(),
      });
    }
  }

  oldLines.forEach((was, i) => {
    if (!takenOld.has(i)) changes.push({ kind: 'removed', line: was.line, text: was.text.trim() });
  });

  return changes.sort((a, b) => a.line - b.line);
}

function describeChanges(changes: ScriptChange[]): string {
  if (changes.length === 0) return 'Nothing changed — the part already reads that way.';

  const counted = (kind: ScriptChange['kind'], word: string) => {
    const n = changes.filter((c) => c.kind === kind).length;
    return n === 0 ? null : `${n} ${word}${n === 1 ? '' : 's'}`;
  };

  const parts = [counted('changed', 'change'), counted('added', 'addition'), counted('removed', 'removal')]
    .filter(Boolean);

  const named = changes
    .slice(0, 3)
    .map((c) => c.text.split(/\s+/).slice(0, 2).join(' '))
    .join(', ');

  return `${parts.join(', ')} — ${named}${changes.length > 3 ? ', …' : ''}.`;
}

// ── prompting ────────────────────────────────────────────────────────────────

function systemPrompt(): string {
  return [
    'You edit DatumScript, a declarative language for parametric solid parts.',
    '',
    'You are given a complete script and a change to make to it. You reply with the complete',
    'script as it should read afterwards.',
    '',
    'Rules:',
    '  - Change only what the request asks for. Every other line comes back byte for byte as',
    '    it was, including its name, its arguments and its order in the file.',
    '  - Keep each feature\'s name. A name is how the user refers to it and how the viewport',
    '    highlights it; renaming a feature they did not ask you to rename loses their selection',
    '    and their place in the tree.',
    '  - Prefer changing a param over changing the line that uses it. If a dimension appears as',
    '    a param, edit the param — that is what it is for, and it keeps the part parametric.',
    '  - To add something, add a line. Do not restructure what is already there to accommodate',
    '    it.',
    '  - Reply with the script and nothing else — no explanation, no code fence.',
    '',
    constraintBrief(),
  ].join('\n');
}

/** Strips a code fence, which models add however firmly they are asked not to. */
export function stripFences(text: string): string {
  const fenced = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return (fenced ? fenced[1]! : text).trim();
}

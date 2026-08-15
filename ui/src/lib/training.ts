import { planFromDocument, type AssemblyPlan } from '../assembly/plan';
import type { Document } from '../model/document';
import { textScore, tokenise } from './reuse';

/**
 * Teaching the planner from your own parts.
 *
 * What this is, stated plainly, because the word "training" covers four different things and
 * only one of them is buildable in a browser with no backend.
 *
 * It is **retrieval-augmented few-shot learning**. Your parts are stored as worked examples —
 * a sentence, and the plan that correctly answers it. When a new request arrives, the
 * examples most like it are retrieved and shown to the model as part of the prompt, so it
 * answers in your vocabulary, at your typical dimensions, with your naming and your
 * conventions. The effect on output is immediate and, unlike a fine-tune, it is inspectable:
 * every example used is named in the result, and deleting one changes the next answer.
 *
 * It is **not** gradient fine-tuning. Nothing here adjusts a model's weights — that needs a
 * training run on a provider's infrastructure and, realistically, hundreds of examples before
 * it beats good prompting. `toJsonl` exists for exactly that day: it exports this corpus in
 * the chat format the major providers ingest, so the work of building the corpus is not spent
 * twice. Until then the same corpus is doing useful work through retrieval.
 *
 * It also cannot teach geometry the kernel cannot build. An example is a plan, and a plan is
 * archetypes and primitives placed in space. Showing the model a part it has no vocabulary
 * for would teach it to emit something that fails validation — so `fromDocument` refuses
 * those rather than storing them, and says which feature was the problem.
 */

const SCHEMA = 1;
const KEY = 'datum.training.examples';

export interface Example {
  id: string;
  /** What someone would type to get this part. The half a model has to learn to recognise. */
  prompt: string;
  /** The answer, in exactly the form the planner is asked to emit. */
  plan: AssemblyPlan;
  savedAtUtc: string;
  /**
   * Where it came from, so a corpus can be audited rather than trusted.
   *
   * `library` — taught deliberately from a saved part.
   * `correction` — captured after the user fixed what was generated, which is the most
   *   valuable kind: it encodes a disagreement the product got wrong once.
   * `imported` — brought in from a file.
   */
  origin: 'library' | 'correction' | 'imported';
}

export interface AddResult {
  ok: boolean;
  /** Present on failure, and on success where something about the part could not be kept. */
  problem?: string;
  example?: Example;
}

// ── storage ──────────────────────────────────────────────────────────────────

interface Envelope {
  schema: number;
  examples: Example[];
}

function read(): Example[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const env = JSON.parse(raw) as Envelope;
    if (typeof env?.schema !== 'number' || env.schema > SCHEMA) return [];
    return Array.isArray(env.examples) ? env.examples.filter(isExample) : [];
  } catch {
    return [];
  }
}

function isExample(value: unknown): value is Example {
  const e = value as Example;
  return !!e && typeof e.prompt === 'string' && !!e.plan && Array.isArray(e.plan.components);
}

function write(examples: Example[]): { ok: boolean; problem?: string } {
  try {
    localStorage.setItem(KEY, JSON.stringify({ schema: SCHEMA, examples } satisfies Envelope));
    return { ok: true };
  } catch (e) {
    const quota = e instanceof DOMException
      && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return {
      ok: false,
      problem: quota
        ? 'The training set is full. Export it to a file and delete some examples to make room.'
        : 'This browser would not let DATUM write to local storage, so nothing was saved.',
    };
  }
}

export function listExamples(): Example[] {
  return read().sort((a, b) => b.savedAtUtc.localeCompare(a.savedAtUtc));
}

export function removeExample(id: string): { ok: boolean; problem?: string } {
  return write(read().filter((e) => e.id !== id));
}

export function clearExamples(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* the next write overwrites it anyway */
  }
}

let serial = 0;
const nextId = () => `ex_${Date.now().toString(36)}_${++serial}`;

// ── teaching ─────────────────────────────────────────────────────────────────

/**
 * Turns a part into an example.
 *
 * The prompt is required and is the harder half to get right, so it is asked for rather than
 * generated. A description invented from the part's own name teaches the model to answer the
 * name it was already given, which is the one request it never receives.
 */
export function addFromDocument(
  prompt: string,
  doc: Document,
  origin: Example['origin'] = 'library',
): AddResult {
  const clean = prompt.trim();
  if (clean.length < 3) {
    return { ok: false, problem: 'Write the request this part is the answer to.' };
  }

  const { plan, excluded } = planFromDocument(doc);

  if (plan.components.length === 0) {
    return {
      ok: false,
      problem: excluded.length > 0
        ? `Nothing in this part can be expressed as a plan: ${excluded.map((x) => x.reason).join('; ')}.`
        : 'This part has no features to learn from.',
    };
  }

  // A partial example is refused rather than stored. An example missing the pocket that gives
  // the part its purpose teaches the model to leave the pocket out.
  if (excluded.length > 0) {
    return {
      ok: false,
      problem:
        `${excluded.length} feature${excluded.length === 1 ? '' : 's'} cannot appear in a plan ` +
        `(${excluded.map((x) => `${x.name}: ${x.reason}`).join('; ')}), so this part would ` +
        'teach an incomplete answer. Examples must be complete to be useful.',
    };
  }

  const example: Example = {
    id: nextId(),
    prompt: clean,
    plan,
    savedAtUtc: new Date().toISOString(),
    origin,
  };

  const result = write([...read(), example]);
  return result.ok ? { ok: true, example } : { ok: false, problem: result.problem };
}

// ── retrieval ────────────────────────────────────────────────────────────────

/**
 * How much of the prompt budget worked examples may take.
 *
 * A car plan runs to several thousand characters, and three of them would crowd out the
 * schema, the rules and the reference dimensions — at which point the model has been given
 * examples instead of instructions and follows neither well. Examples earn their place by
 * being *representative*, not by being numerous.
 */
const BUDGET_CHARS = 6000;
const MAX_EXAMPLES = 3;

export interface Selection {
  examples: Example[];
  /** Examples that matched but were too large to include, so the UI can say so. */
  skipped: Example[];
}

/**
 * The examples most like this request, within budget.
 *
 * Ranked by the same text channel the reuse gate uses, so "which saved part answers this"
 * and "which example teaches this" agree about what a request is about. An example that
 * shares no content word with the request is not returned at all: an irrelevant example is
 * worse than none, because the model will try to follow it.
 */
export function exemplarsFor(
  prompt: string,
  corpus: Example[] = listExamples(),
  limit = MAX_EXAMPLES,
): Selection {
  const tokens = tokenise(prompt);
  if (tokens.length === 0) return { examples: [], skipped: [] };

  const ranked = corpus
    .map((e) => ({ e, s: textScore(tokens, tokensFor(e)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.e.savedAtUtc.localeCompare(a.e.savedAtUtc));

  const examples: Example[] = [];
  const skipped: Example[] = [];
  let used = 0;

  for (const { e } of ranked) {
    if (examples.length >= limit) break;
    const size = render(e).length;
    // Skipped rather than truncated. Half a plan is not a smaller example, it is an example
    // of an incomplete answer.
    if (used + size > BUDGET_CHARS) { skipped.push(e); continue; }
    examples.push(e);
    used += size;
  }

  return { examples, skipped };
}

/** Everything an example can be matched on: its prompt, and what its plan is made of. */
function tokensFor(example: Example): string[] {
  const words = [
    example.prompt,
    example.plan.name,
    example.plan.description,
    ...example.plan.components.flatMap((c) => [c.name, c.role, c.shape]),
  ];
  return tokenise(words.join(' '));
}

function render(example: Example): string {
  return `Request: ${example.prompt}\nPlan: ${JSON.stringify(example.plan)}`;
}

/**
 * The examples as a block of prompt text.
 *
 * Placed as *worked answers* rather than as reference material: the model is shown the exact
 * output shape it is being asked for, paired with the request that produced it, which is the
 * form few-shot prompting actually works in.
 */
export function exemplarBlock(examples: Example[]): string {
  if (examples.length === 0) return '';

  return `WORKED EXAMPLES — plans from this organisation's own parts. Match their vocabulary,
their level of detail and their conventions. They are examples of *form*, not a catalogue:
build what has been asked for, not the nearest example.

${examples.map(render).join('\n\n')}`;
}

// ── moving a corpus in and out ───────────────────────────────────────────────

/**
 * The corpus in the chat format every major provider ingests for fine-tuning.
 *
 * One JSON object per line: the system prompt the planner actually runs with, the request,
 * and the plan as the assistant turn. Exported with the *live* system prompt rather than a
 * stored copy, so a fine-tune is always trained against the instructions the product will
 * send it at inference time — a model tuned against a stale prompt is a model tuned to
 * follow rules it will never be given again.
 */
export function toJsonl(examples: Example[], systemPrompt: string): string {
  return examples
    .map((e) => JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: e.prompt },
        { role: 'assistant', content: JSON.stringify(e.plan) },
      ],
    }))
    .join('\n');
}

export interface ImportResult {
  added: number;
  /** Lines that were not usable, with the reason. Never silently skipped. */
  rejected: { line: number; reason: string }[];
  problem?: string;
}

/**
 * Reads a corpus back in.
 *
 * Accepts both the shapes this product emits: a JSON array of examples, and the JSONL chat
 * format from `toJsonl`. The second matters because it is what a corpus looks like after it
 * has been through a provider's tooling, and a round trip that only survives one direction
 * is not a round trip.
 */
export function fromFile(text: string): ImportResult {
  const trimmed = text.trim();
  if (!trimmed) return { added: 0, rejected: [], problem: 'That file is empty.' };

  const incoming: Example[] = [];
  const rejected: ImportResult['rejected'] = [];

  const asArray = trimmed.startsWith('[') ? safeParse<unknown[]>(trimmed) : null;
  if (asArray) {
    asArray.forEach((value, i) => {
      if (isExample(value)) incoming.push({ ...value, id: nextId(), origin: 'imported' });
      else rejected.push({ line: i + 1, reason: 'not an example' });
    });
  } else {
    trimmed.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      const row = safeParse<{ messages?: { role: string; content: string }[] }>(line);
      if (!row) { rejected.push({ line: i + 1, reason: 'not valid JSON' }); return; }

      const user = row.messages?.find((m) => m.role === 'user')?.content;
      const assistant = row.messages?.find((m) => m.role === 'assistant')?.content;
      if (!user || !assistant) {
        rejected.push({ line: i + 1, reason: 'no request and answer pair' });
        return;
      }

      const plan = safeParse<AssemblyPlan>(assistant);
      if (!plan || !Array.isArray(plan.components)) {
        rejected.push({ line: i + 1, reason: 'the answer is not a plan' });
        return;
      }

      incoming.push({
        id: nextId(),
        prompt: user,
        plan,
        savedAtUtc: new Date().toISOString(),
        origin: 'imported',
      });
    });
  }

  if (incoming.length === 0) {
    return { added: 0, rejected, problem: 'Nothing in that file could be read as an example.' };
  }

  const result = write([...read(), ...incoming]);
  return result.ok
    ? { added: incoming.length, rejected }
    : { added: 0, rejected, problem: result.problem };
}

function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

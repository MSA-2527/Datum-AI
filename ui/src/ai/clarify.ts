/**
 * Asking before building.
 *
 * "Create an anodizing rack" is not one object. It is a family of them, and which one you want
 * depends on things the sentence does not say: how deep the tank is, how big the parts are,
 * how many go on at once. Building immediately produces a rack — just not yours. Refusing
 * produces nothing at all, which is what it used to do.
 *
 * So an ambiguous request becomes a short conversation. Two to four questions, each with real
 * options and a default already chosen, so answering is a matter of correcting what is wrong
 * rather than filling in a form.
 *
 * Where a model with search is configured, the questions are informed by what a rack actually
 * looks like in industry and the sources come back with them. Where one is not, the questions
 * come from the archetype's own parameters and their notes — which were written by someone who
 * knew why each one matters, and are therefore better prompts than a model would invent. The
 * offline path is not a degraded version of the online one; it is the same conversation with
 * less research behind it.
 */

import { complete, type ProviderConfig } from './providers';
import { archetypeById, type Archetype, type ParamSpec } from '../generate/archetypes';

export interface Choice {
  label: string;
  /** Parameter values this choice sets. */
  values: Record<string, number>;
  /** Why someone would pick this. */
  note?: string;
}

export interface Question {
  /** Which parameter(s) this settles, for the summary afterwards. */
  key: string;
  question: string;
  choices: Choice[];
  /** Index of the choice used if the question goes unanswered. */
  defaultIndex: number;
}

export interface Clarification {
  archetype: Archetype;
  /** What it understood the request to be, in one line. */
  reading: string;
  questions: Question[];
  /** Where the research came from, when a model looked it up. */
  citations: { title: string; uri: string }[];
  /** Present when research was attempted and could not be done. */
  researchNote?: string;
}

// ── which parameters are worth asking about ──────────────────────────────────

/**
 * The parameters that change what the part *is*, rather than trimming it.
 *
 * Asking about every parameter would be a settings dialogue, not a conversation. These are
 * chosen by a simple rule that turns out to work well: a parameter is worth asking about when
 * its author wrote a note explaining it. A note means the value carries a decision; a bare
 * number is a dimension you can drag afterwards.
 */
function worthAsking(archetype: Archetype): ParamSpec[] {
  const noted = archetype.defaults.filter((d) => d.note);
  if (noted.length >= 2) return noted.slice(0, 4);

  // Nothing annotated: fall back to the widest-ranging parameters, which are the ones where
  // the default is least likely to be what someone wants.
  return [...archetype.defaults]
    .sort((a, b) => (b.max - b.min) / (b.value || 1) - (a.max - a.min) / (a.value || 1))
    .slice(0, 3);
}

/** Three options spanning a parameter's useful range, with the default in the middle. */
function choicesFor(spec: ParamSpec): Choice[] {
  const unit = spec.unit === 'count' ? '' : ` ${spec.unit}`;
  const low = Math.max(spec.min, spec.value / 2);
  const high = Math.min(spec.max, spec.value * 2);

  const round = (v: number) => (spec.unit === 'count' ? Math.max(1, Math.round(v)) : Number(v.toFixed(1)));

  const seen = new Set<number>();
  return [low, spec.value, high]
    .map(round)
    .filter((v) => (seen.has(v) ? false : (seen.add(v), true)))
    .map((v) => ({
      label: `${v}${unit}`,
      values: { [spec.key]: v },
    }));
}

/** The offline conversation: the archetype's own parameters, in its author's words. */
export function questionsFrom(archetype: Archetype): Question[] {
  return worthAsking(archetype).map((spec) => {
    const choices = choicesFor(spec);
    const defaultIndex = Math.max(0, choices.findIndex((c) => c.values[spec.key] === spec.value));

    return {
      key: spec.key,
      question: spec.note ? `${spec.label}? ${spec.note}` : `${spec.label}?`,
      choices,
      defaultIndex,
    };
  });
}

// ── the research step ────────────────────────────────────────────────────────

const RESEARCH_SYSTEM = `You are helping an engineer specify a part before it is modelled.

You will be given the kind of part and the parameters the CAD kernel can vary. Research how
this part is actually built and used, then return the two to four questions whose answers most
change the design. Use the real vocabulary of the trade.

Reply with JSON only:
{
  "reading": "one sentence saying what you understand is being asked for",
  "questions": [
    {
      "key": "one of the parameter keys given to you",
      "question": "the question, phrased so an engineer would recognise it",
      "choices": [
        { "label": "what to show, including units", "values": { "paramKey": number }, "note": "when this is the right pick" }
      ],
      "defaultIndex": 0
    }
  ]
}

RULES:
- Every "key" and every key inside "values" must be one of the parameter keys given. No others.
- Two to four questions. Three choices each is usually right.
- Values must be inside the stated range for that parameter.
- Choices must be genuinely different designs, not three numbers close together.
- "defaultIndex" is the one most people want.`;

/**
 * Asks a model to research the part and propose the questions.
 *
 * Returns null rather than throwing when there is no model, no search, or the reply cannot be
 * used — the caller then falls back to the offline questions, which are always available.
 */
async function researchQuestions(
  archetype: Archetype, request: string, config: ProviderConfig, signal?: AbortSignal,
): Promise<{ reading: string; questions: Question[]; citations: { title: string; uri: string }[] } | null> {
  if (config.id === 'none') return null;

  const vocabulary = archetype.defaults
    .map((d) => `${d.key}: ${d.label}, ${d.min}–${d.max} ${d.unit}, default ${d.value}${d.note ? ` — ${d.note}` : ''}`)
    .join('\n');

  const reply = await complete(config, {
    system: RESEARCH_SYSTEM,
    user: `Part: ${archetype.label}\nThe request was: "${request}"\n\nParameters:\n${vocabulary}`,
    maxTokens: 2000,
    signal,
  });

  if (!reply.ok) return null;

  const parsed = extract(reply.text);
  if (!parsed) return null;

  const valid = new Set(archetype.defaults.map((d) => d.key));
  const ranges = new Map(archetype.defaults.map((d) => [d.key, d] as const));

  const questions: Question[] = [];

  for (const raw of parsed.questions ?? []) {
    if (!valid.has(raw.key)) continue;

    // Every proposed value is clamped to the parameter's declared range before it is offered.
    // A choice a user picks and the kernel then silently alters is worse than no choice.
    const choices: Choice[] = [];
    for (const c of raw.choices ?? []) {
      const values: Record<string, number> = {};
      for (const [k, v] of Object.entries(c.values ?? {})) {
        const spec = ranges.get(k);
        if (!spec || typeof v !== 'number' || !Number.isFinite(v)) continue;
        values[k] = Math.min(spec.max, Math.max(spec.min, v));
      }
      if (Object.keys(values).length > 0 && typeof c.label === 'string') {
        choices.push({ label: c.label, values, note: typeof c.note === 'string' ? c.note : undefined });
      }
    }

    if (choices.length >= 2) {
      questions.push({
        key: raw.key,
        question: String(raw.question ?? ranges.get(raw.key)?.label ?? raw.key),
        choices,
        defaultIndex: Math.min(Math.max(0, Math.round(raw.defaultIndex ?? 0)), choices.length - 1),
      });
    }
  }

  if (questions.length === 0) return null;

  return {
    reading: typeof parsed.reading === 'string' ? parsed.reading : `A ${archetype.label.toLowerCase()}.`,
    questions: questions.slice(0, 4),
    citations: reply.citations,
  };
}

interface RawReply {
  reading?: unknown;
  questions?: {
    key: string;
    question?: unknown;
    defaultIndex?: number;
    choices?: { label?: unknown; values?: Record<string, unknown>; note?: unknown }[];
  }[];
}

/** Pulls JSON out of a reply that may be wrapped in prose or a code fence. */
function extract(text: string): RawReply | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    return JSON.parse(body.slice(start, end + 1)) as RawReply;
  } catch {
    return null;
  }
}

// ── the entry point ──────────────────────────────────────────────────────────

export interface ClarifyOptions {
  config: ProviderConfig;
  /** Skip the research round trip even when a model is configured. */
  offlineOnly?: boolean;
  signal?: AbortSignal;
}

/**
 * Prepares the questions to ask before building `shape`.
 *
 * Research is attempted first and falls back silently, so a missing key, a rate limit or a
 * flat network never costs the user the conversation — it only costs the citations.
 */
export async function clarify(
  shape: string, request: string, opts: ClarifyOptions,
): Promise<Clarification | null> {
  const archetype = archetypeById(shape);
  if (!archetype) return null;

  const offline: Clarification = {
    archetype,
    reading: `A ${archetype.label.toLowerCase()}, from the built-in catalogue.`,
    questions: questionsFrom(archetype),
    citations: [],
  };

  if (opts.offlineOnly || opts.config.id === 'none') return offline;

  try {
    const researched = await researchQuestions(archetype, request, opts.config, opts.signal);
    if (!researched) {
      return { ...offline, researchNote: 'The model could not be reached, so these are the built-in questions.' };
    }
    return { archetype, ...researched };
  } catch {
    return { ...offline, researchNote: 'Research failed, so these are the built-in questions.' };
  }
}

/** Folds the chosen answers into a parameter set, defaults filling anything unanswered. */
export function applyAnswers(
  clarification: Clarification, answers: Record<string, number>,
): Record<string, number> {
  const params: Record<string, number> = {};
  for (const spec of clarification.archetype.defaults) params[spec.key] = spec.value;

  for (const question of clarification.questions) {
    const index = answers[question.key] ?? question.defaultIndex;
    const choice = question.choices[index] ?? question.choices[question.defaultIndex];
    if (choice) Object.assign(params, choice.values);
  }

  return params;
}

/** A sentence saying what was settled, for the transcript. */
export function describeAnswers(
  clarification: Clarification, answers: Record<string, number>,
): string {
  const picked = clarification.questions.map((q) => {
    const choice = q.choices[answers[q.key] ?? q.defaultIndex];
    return choice ? `${q.key} ${choice.label}` : null;
  }).filter(Boolean);

  return picked.length > 0 ? `Built with ${picked.join(', ')}.` : '';
}

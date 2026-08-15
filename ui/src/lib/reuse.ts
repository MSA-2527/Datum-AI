import { archetypeById } from '../generate/archetypes';
import { parseRequest } from '../generate/parse';
import { matchRecipe } from '../assembly/recipes';
import type { Document } from '../model/document';
import type { LibraryEntry } from './library';

/**
 * "Have we already made this?" — asked *before* anything is generated.
 *
 * The cheapest part to make is the one that already exists. Engineers remodel parts their
 * own company owns because finding one has always been harder than drawing one, and every
 * duplicate is a second thing to revise, quote, stock and get wrong. So the question has to
 * be asked at the only moment it can still save the work: before the request reaches the
 * generator.
 *
 * That timing is what makes this a different problem from ordinary part search, and it is
 * worth being explicit about why. Searching a library compares one *part* with another and
 * can use geometry — sizes, hole patterns, how much material survives. Here there is no
 * part yet. There is a sentence. So the evidence available is:
 *
 *   - **words** — what the request calls the thing, against what the saved parts are called;
 *   - **structure** — the archetype or recipe the request routes to, against the archetypes
 *     the saved parts were actually built from;
 *   - **dimensions** — the numbers the request states, against the numbers the saved part
 *     was built with.
 *
 * The third is used as a veto rather than a score, and that asymmetry is the whole design.
 * Words and structure can only ever suggest; a stated dimension that the saved part does not
 * meet is proof that it is a different part. Someone asking for a 300 mm plate is not helped
 * by being shown the 200 mm one, however similar its name.
 *
 * **Strictness is the feature.** A false positive here interrupts someone who was right to
 * be modelling, and two of those teach them to dismiss the card without reading it — at
 * which point the true positive, the one that saves a week, is dismissed too. Missing a
 * match costs a duplicate part. Inventing one costs the mechanism. The thresholds below are
 * set accordingly, and the tests pin them.
 */

// ── text ─────────────────────────────────────────────────────────────────────

/**
 * Words carrying no information about *which* part is wanted.
 *
 * Includes the imperative verbs the composer invites ("Describe a part…" produces "make me
 * a…" constantly) and the unit words, which are handled by the dimension channel and would
 * otherwise let "8 mm" agree with every metric part in the library.
 */
const NOISE = new Set([
  'a', 'an', 'the', 'of', 'for', 'with', 'and', 'to', 'in', 'on', 'at', 'by', 'from',
  'make', 'makes', 'making', 'create', 'creates', 'creating', 'build', 'builds', 'building',
  'model', 'models', 'modelling', 'modeling', 'design', 'designs', 'draw', 'give', 'get',
  'me', 'my', 'our', 'us', 'it', 'this', 'that', 'some', 'please', 'new',
  'mm', 'millimetre', 'millimetres', 'millimeter', 'millimeters', 'cm', 'centimetre',
  'centimetres', 'm', 'metre', 'metres', 'meter', 'meters', 'in', 'inch', 'inches',
  'thick', 'thickness', 'long', 'wide', 'tall', 'deep', 'diameter', 'dia',
]);

/**
 * Folds a word to a comparison key.
 *
 * Plurals only, and only the regular ones. A real stemmer would fold "bearing" to "bear"
 * and "housing" to "hous", which is how a bearing starts matching a bear — the vocabulary
 * here is mechanical nouns, where over-stemming produces exactly the false positives this
 * module exists to avoid.
 */
function fold(word: string): string {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('hes'))) {
    return word.slice(0, -2);
  }
  if (word.length > 2 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Content words, folded and de-duplicated. Numbers are dropped: they are dimensions. */
export function tokenise(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9.\-\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const out: string[] = [];
  for (const w of words) {
    if (/^[\d.\-/]+$/.test(w)) continue;         // a pure number is a dimension, not a name
    const clean = w.replace(/^[-.]+|[-.]+$/g, '');
    if (clean.length < 2 || NOISE.has(clean)) continue;
    const key = fold(clean);
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Everything a saved part can be called, as folded tokens.
 *
 * The archetype's own aliases are included, which is what lets "a mug" find the part saved
 * as "Cup". Without them the index only matches people who happen to reuse their own
 * vocabulary, and the person most likely to remodel a part is the one who did not.
 */
export function tokensFor(doc: Document): string[] {
  const parts: string[] = [doc.name, doc.material];

  for (const f of doc.features) {
    parts.push(f.name);
    if (f.role) parts.push(f.role);

    const id = f.params.archetypeId;
    if (typeof id === 'string') {
      const archetype = archetypeById(id);
      if (archetype) parts.push(archetype.label, ...archetype.aliases);
    }
  }

  for (const g of doc.globals) parts.push(g.name);

  return tokenise(parts.join(' '));
}

/**
 * How much of the request the saved part's vocabulary accounts for, 0 to 1.
 *
 * Measured over the *request's* tokens rather than symmetrically, because a saved assembly
 * legitimately carries a hundred words the request does not; penalising it for being
 * described in detail would rank rich entries below sparse ones.
 */
export function textScore(requestTokens: string[], entryTokens: string[]): number {
  if (requestTokens.length === 0) return 0;
  const have = new Set(entryTokens);
  const hits = requestTokens.filter((t) => have.has(t)).length;
  return hits / requestTokens.length;
}

// ── structure ────────────────────────────────────────────────────────────────

/** The archetype ids a saved document was actually built from. */
export function archetypesIn(doc: Document): string[] {
  const out: string[] = [];
  for (const f of doc.features) {
    const id = f.params.archetypeId;
    if (typeof id === 'string' && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * What the request routes to, before anything is built.
 *
 * `null` where the request is not recognised by either deterministic route — which is not a
 * failure, it is the model's territory. It does mean this channel has nothing to say, and
 * `structureScore` treats that as neutral rather than as disagreement.
 */
export interface RequestShape {
  archetypeId: string | null;
  recipeLabel: string | null;
  /** Dimensions the request stated explicitly, in millimetres or degrees. */
  stated: Record<string, number>;
}

export function readRequest(prompt: string): RequestShape {
  const parsed = parseRequest(prompt);
  const recipe = matchRecipe(prompt);

  return {
    archetypeId: parsed.archetype?.id ?? null,
    recipeLabel: recipe?.label ?? null,
    stated: parsed.archetype ? { ...parsed.params } : {},
  };
}

/**
 * 1 agrees, 0 disagrees, 0.5 when the channel has nothing to say.
 *
 * The two ways of having nothing to say are worth separating, because conflating them broke
 * the case this feature exists for.
 *
 * The request may route nowhere — a description only a model could answer. Then there is no
 * structure to compare against and the channel abstains.
 *
 * Or the *saved part* may have no archetypes: an imported drawing, a traced photograph, a
 * hand-built tree. This was scored as disagreement, which is wrong and was quietly severe. A
 * company that imports nine hundred of its own drawings has a library where nothing carries an
 * archetype, so every request that parsed to one — which is most of them — scored those parts
 * at zero and regenerated a part that was already on file. The gate was doing nothing for
 * precisely the library it was built to search.
 *
 * Absence of evidence is not evidence of absence. A part that *has* archetypes and does not
 * include this one genuinely disagrees, and still scores zero.
 */
export function structureScore(shape: RequestShape, doc: Document): number {
  if (!shape.archetypeId && !shape.recipeLabel) return 0.5;

  if (shape.archetypeId && archetypesIn(doc).includes(shape.archetypeId)) return 1;

  if (shape.recipeLabel && doc.name.trim().toLowerCase() === shape.recipeLabel.trim().toLowerCase()) {
    return 1;
  }

  // Nothing to compare: the part was not built from the catalogue at all.
  if (archetypesIn(doc).length === 0) return 0.5;

  return 0;
}

// ── dimensions: the veto ─────────────────────────────────────────────────────

export interface Conflict {
  key: string;
  label: string;
  /** What the request asked for. */
  wanted: number;
  /** What the saved part is. */
  saved: number;
  unit: string;
}

/**
 * A dimension with its unit, spaced the way a drawing would write it.
 *
 * Here rather than at each call site because a conflict is described in two places — the
 * transcript line and the card — and the first version of each wrote "200mm".
 */
export function dimension(value: number, unit: string): string {
  return unit ? `${value} ${unit}` : `${value}`;
}

/**
 * Two percent.
 *
 * Wide enough to absorb a request phrased in inches against a part modelled in millimetres,
 * and narrow enough that no standard size sits inside it — the tightest neighbouring pair in
 * ordinary use is M10 against M11 at 10%, and preferred-number plate thicknesses are further
 * apart than that. A tolerance that admitted a neighbouring standard size would hand someone
 * the wrong bolt.
 */
const DIMENSION_TOLERANCE = 0.02;

/**
 * Dimensions the request states that the saved part does not meet.
 *
 * Only the parameters the request named are compared. A request that says nothing about
 * thickness is not asserting the default — it is leaving the decision open, and treating
 * silence as a requirement would reject every reusable part for not being explicitly asked
 * for.
 */
export function conflictsWith(shape: RequestShape, doc: Document): Conflict[] {
  const keys = Object.keys(shape.stated);
  if (keys.length === 0 || !shape.archetypeId) return [];

  const archetype = archetypeById(shape.archetypeId);
  if (!archetype) return [];

  const feature = doc.features.find((f) => f.params.archetypeId === shape.archetypeId);
  if (!feature) return [];

  const out: Conflict[] = [];
  for (const key of keys) {
    const spec = archetype.defaults.find((d) => d.key === key);
    if (!spec) continue;

    const wanted = shape.stated[key]!;
    const stored = feature.params[key];
    const saved = typeof stored === 'number' ? stored : spec.value;

    const scale = Math.max(Math.abs(wanted), Math.abs(saved));
    if (scale < 1e-9) continue;                                 // both zero — no disagreement
    if (Math.abs(wanted - saved) / scale <= DIMENSION_TOLERANCE) continue;

    out.push({ key, label: spec.label, wanted, saved, unit: spec.unit === 'count' ? '' : spec.unit });
  }

  return out;
}

// ── triage ───────────────────────────────────────────────────────────────────

export interface ReuseMatch {
  entry: LibraryEntry;
  /** Fused confidence, 0 to 1. */
  score: number;
  textScore: number;
  structureScore: number;
  /** Why this was offered, in plain words. */
  reason: string;
}

/**
 * Weights and the acceptance bar.
 *
 * Words carry slightly more than structure because structure is coarse: a library of twenty
 * plates all answer "plate" identically, and only the name distinguishes them. The bar is
 * then set so that agreement on one channel alone is never enough —
 *
 *   perfect words, wrong archetype    0.55  →  rejected, and it should be: a part named
 *                                              "bracket" built as a cup is not this bracket
 *   perfect words, nothing to compare 0.78  →  offered, with the name as the only evidence
 *   perfect words, right archetype    1.00  →  offered
 *   half the words, right archetype   0.73  →  rejected, one word short of the bar
 *
 * — so a match always rests on at least the name plus something, and the numbers are pinned
 * in the tests rather than left as tunable constants nobody dares change.
 */
const TEXT_WEIGHT = 0.55;
const STRUCTURE_WEIGHT = 0.45;
const ACCEPT = 0.75;

export interface TriageResult {
  /** The part to offer instead of generating, or null to go ahead and generate. */
  match: ReuseMatch | null;
  /**
   * Parts that matched on name and structure but contradict a stated dimension.
   *
   * Kept rather than discarded because it is the honest thing to say when someone asks for a
   * 300 mm plate and the library holds the 200 mm one: this is not it, and here is what you
   * do have.
   */
  nearMisses: { entry: LibraryEntry; conflicts: Conflict[] }[];
}

export function triage(index: LibraryEntry[], prompt: string): TriageResult {
  const shape = readRequest(prompt);
  const requestTokens = tokenise(prompt);
  const nearMisses: TriageResult['nearMisses'] = [];

  if (requestTokens.length === 0) return { match: null, nearMisses };

  const scored: ReuseMatch[] = [];

  for (const entry of index) {
    const text = textScore(requestTokens, tokensFor(entry.doc));
    const structure = structureScore(shape, entry.doc);
    const score = text * TEXT_WEIGHT + structure * STRUCTURE_WEIGHT;
    if (score < ACCEPT) continue;

    // The veto runs last, on candidates that would otherwise have been offered, so a
    // near miss is a part that really was about to be handed over.
    const conflicts = conflictsWith(shape, entry.doc);
    if (conflicts.length > 0) {
      nearMisses.push({ entry, conflicts });
      continue;
    }

    scored.push({
      entry,
      score,
      textScore: text,
      structureScore: structure,
      reason: describe(entry, text, structure),
    });
  }

  scored.sort((a, b) =>
    b.score - a.score || b.entry.savedAtUtc.localeCompare(a.entry.savedAtUtc));

  return { match: scored[0] ?? null, nearMisses };
}

function describe(entry: LibraryEntry, text: number, structure: number): string {
  const parts: string[] = [];

  if (text >= 0.999) parts.push('the name matches');
  else parts.push('the name mostly matches');

  if (structure === 1) parts.push('built from the same archetype');

  const [x, y, z] = entry.snapshot.sizeMm;
  if (x > 0 || y > 0 || z > 0) {
    parts.push(`${x.toFixed(0)} × ${y.toFixed(0)} × ${z.toFixed(0)} mm`);
  }
  if (entry.snapshot.massG > 0) parts.push(`${formatMass(entry.snapshot.massG)}`);

  return parts.join(' · ');
}

function formatMass(g: number): string {
  if (g >= 1e6) return `${(g / 1e6).toFixed(2)} t`;
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg`;
  return `${g.toFixed(g < 10 ? 1 : 0)} g`;
}

/**
 * Free-text filter for the library list.
 *
 * Ranked by the same text channel as triage, so the part the gate would have offered is the
 * part the list shows first. An empty query keeps the library's own order — most recently
 * saved first — rather than imposing an arbitrary one.
 */
export function filterLibrary(index: LibraryEntry[], query: string): LibraryEntry[] {
  const tokens = tokenise(query);
  if (tokens.length === 0) return index;

  return index
    .map((entry) => ({ entry, s: textScore(tokens, tokensFor(entry.doc)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.entry.savedAtUtc.localeCompare(a.entry.savedAtUtc))
    .map((x) => x.entry);
}

/**
 * Natural language to archetype and parameters.
 *
 * This is deliberately a deterministic parser rather than a model call. Three reasons.
 *
 * It has to work offline and instantly — the free tier's whole promise is that the
 * deterministic core needs no planner at all, and "make a cup" is exactly the request a
 * user tries first. It has to be *predictable*: the same phrasing must produce the same
 * part every time, because an engineer who cannot reproduce a result cannot rely on it. And
 * it has to be honest about what it did not understand, which a model that always returns
 * something plausible cannot be.
 *
 * When a language model is available it does not replace this; it maps unusual phrasing
 * onto the same archetype and parameter vocabulary, so there is still exactly one code path
 * that builds geometry.
 */

import { ARCHETYPES, type Archetype, type ParamSpec } from './archetypes';

export interface ParseResult {
  archetype: Archetype;
  /** Parameters recognised in the text, already in millimetres or degrees. */
  params: Record<string, number>;
  /** How confident the archetype match is, 0 to 1. */
  confidence: number;
  /** Phrases that were understood, for showing the user what was read. */
  understood: string[];
  /** Phrases that were not, so the user can see what was ignored rather than guessing. */
  ignored: string[];
}

export interface ParseFailure {
  archetype: null;
  /** Archetypes that partly matched, best first. */
  suggestions: { id: string; label: string; score: number }[];
  message: string;
}

// ── units ────────────────────────────────────────────────────────────────────

const UNIT_TO_MM: Record<string, number> = {
  mm: 1, millimetre: 1, millimeter: 1, millimetres: 1, millimeters: 1,
  cm: 10, centimetre: 10, centimeter: 10, centimetres: 10, centimeters: 10,
  m: 1000, metre: 1000, meter: 1000, metres: 1000, meters: 1000,
  in: 25.4, inch: 25.4, inches: 25.4, '"': 25.4,
  ft: 304.8, foot: 304.8, feet: 304.8, "'": 304.8,
  thou: 0.0254, mil: 0.0254,
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, sixteen: 16, twenty: 20,
  twentyfour: 24, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100,
};

/**
 * A measurement with its unit resolved to millimetres.
 *
 * Imperial fractions are handled because they are how imperial parts are actually
 * specified — "1/4 inch plate", not "6.35 mm plate" — and silently mis-reading 1/4 as 1
 * would produce a part four times too thick.
 */
export interface Measure {
  mm: number;
  raw: string;
  index: number;
}

export function findMeasures(text: string): Measure[] {
  const out: Measure[] = [];
  const unitAlt = Object.keys(UNIT_TO_MM)
    .filter((u) => /^[a-z]+$/.test(u))
    .sort((a, b) => b.length - a.length)
    .join('|');

  // Fractions first: "1/4 in", "3 1/2 inch".
  const frac = new RegExp(`(\\d+\\s+)?(\\d+)\\s*/\\s*(\\d+)\\s*(${unitAlt}|"|')`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = frac.exec(text)) !== null) {
    const whole = m[1] ? parseFloat(m[1]) : 0;
    const value = whole + parseInt(m[2], 10) / parseInt(m[3], 10);
    out.push({ mm: value * (UNIT_TO_MM[m[4].toLowerCase()] ?? 1), raw: m[0], index: m.index });
  }

  // Plain decimals with an optional unit. No unit means millimetres, which is the CAD
  // default and is stated in the UI so it is never a silent assumption.
  const plain = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${unitAlt}|"|')?`, 'gi');
  while ((m = plain.exec(text)) !== null) {
    if (out.some((o) => m!.index >= o.index && m!.index < o.index + o.raw.length)) continue;

    /*
     * A number welded to a letter is part of a designation, not a measurement.
     *
     * "Two M8 feet holes" gave a ⌀2438.4 mm hole in an 80 mm block: the 8 of M8 was read as a
     * free number, the word after it was "feet", and eight feet is 2438.4 mm. The block did
     * not close, which is the only reason anyone noticed. M8, M10, R5, A36 — the digits belong
     * to the token, and a designation is handled by `applyFastenerDesignation`, not here.
     */
    const before = m.index > 0 ? text[m.index - 1]! : ' ';
    if (/[A-Za-z]/.test(before)) continue;

    const unit = m[2]?.toLowerCase();

    /*
     * "Feet" is a unit only where a unit can stand.
     *
     * It is also the commonest word in mechanical English for the parts a thing stands on, and
     * the two readings differ by a factor of three hundred. A unit is followed by nothing, by
     * punctuation, or by a word about size; a plural noun is followed by whatever it belongs to.
     */
    if (unit && FOOT_WORDS.has(unit)) {
      const after = text.slice(m.index + m[0].length).trimStart();
      if (after.length > 0 && !/^[,.;:)]|^(?:long|wide|tall|high|deep|across|of|by|and|or)\b/i.test(after)) {
        continue;
      }
    }

    out.push({ mm: parseFloat(m[1]) * (unit ? UNIT_TO_MM[unit] ?? 1 : 1), raw: m[0].trim(), index: m.index });
  }

  return out.sort((a, b) => a.index - b.index);
}

/** The words for a foot, which is also a part a machine stands on. */
const FOOT_WORDS = new Set(['ft', 'foot', 'feet']);

// ── parameter keywords ───────────────────────────────────────────────────────

/**
 * Words that identify a parameter, longest phrase first so "outer diameter" wins over
 * "diameter".
 */
const KEYWORDS: { words: string[]; keys: string[] }[] = [
  { words: ['outer diameter', 'outside diameter', 'od'], keys: ['outerDia', 'bodyDia', 'diameter'] },
  { words: ['inner diameter', 'inside diameter', 'id', 'bore diameter', 'bore'], keys: ['boreDia', 'neckDia'] },
  { words: ['bolt circle', 'pitch circle', 'pcd'], keys: ['boltCircle'] },
  // Before the generic diameter entry, so "9 mm holes" sizes the holes rather than the body.
  // Without it a plate asked for 13 mm holes was built with its default 9 mm ones and said
  // nothing — the number is plausible, which is what makes it worth catching.
  { words: ['hole diameter', 'hole size', 'hole'], keys: ['holeDia', 'holeDiameter'] },
  { words: ['wall thickness', 'wall'], keys: ['wall'] },
  { words: ['base thickness', 'floor thickness', 'base'], keys: ['baseThickness'] },
  { words: ['face width'], keys: ['faceWidth'] },
  { words: ['corner radius', 'corner'], keys: ['cornerRadius'] },
  { words: ['fillet radius', 'fillet', 'round'], keys: ['filletRadius', 'rimFillet'] },
  { words: ['chamfer'], keys: ['chamfer'] },
  { words: ['thickness', 'thick'], keys: ['thickness', 'wall'] },
  { words: ['diameter', 'dia', 'across'], keys: ['diameter', 'outerDia', 'bodyDia', 'acrossFlats'] },
  { words: ['radius'], keys: ['radius'] },
  { words: ['height', 'tall', 'high'], keys: ['height', 'length'] },
  // `thickness` last: it is only reached by an archetype that has neither a length nor a
  // height, which is exactly the flat, turned kind — a washer, a shim, a spacer — where "12 mm
  // long" means its thickness and was previously read as nothing at all.
  { words: ['length', 'long'], keys: ['length', 'height', 'thickness'] },
  { words: ['width', 'wide'], keys: ['width'] },
  { words: ['depth', 'deep'], keys: ['depth', 'grooveDepth', 'keywayDepth'] },
  { words: ['teeth', 'tooth'], keys: ['teeth'] },
  { words: ['module'], keys: ['module'] },
  { words: ['pressure angle'], keys: ['pressureAngle'] },
  { words: ['taper', 'draft'], keys: ['taper', 'draft'] },
  { words: ['bend radius'], keys: ['bendRadius'] },
  { words: ['reach'], keys: ['handleReach'] },
  { words: ['capacity', 'volume', 'holds'], keys: ['__capacity'] },
];

/** Words meaning "no handle", "no holes" and so on. */
const NEGATIONS = ['no ', 'without ', 'remove ', "don't ", 'do not ', 'none'];

/** Where an alias appears as a whole word, or −1. */
function aliasIndex(lower: string, alias: string): number {
  for (const form of [` ${alias} `, ` ${alias}s `, ` ${alias},`, ` ${alias}.`]) {
    const at = lower.indexOf(form);
    if (at >= 0) return at + 1;
  }
  return -1;
}

/**
 * True when the word at `at` is being excluded rather than requested.
 *
 * Only the text immediately before it is considered — far enough back to catch "with no" and
 * "without a", short enough that a negation about something else earlier in the sentence does
 * not suppress an unrelated noun.
 */
function negatedAt(lower: string, at: number): boolean {
  const before = lower.slice(Math.max(0, at - 16), at);
  return NEGATIONS.some((n) => before.includes(n));
}

/** Words that introduce a part of the thing, rather than the thing. */
const ATTACHMENTS = [' with ', ' and ', ' plus ', ' having ', ' including '];

/**
 * Words that end the *head* of a request and begin a qualifier.
 *
 * "A crankshaft for a 4 cylinder engine" asks for a crankshaft. Everything after "for" says
 * what the crankshaft is for, and the nouns in it are not the thing being requested — but a
 * parser that scores every word in the sentence equally will happily pick "cylinder" out of
 * the qualifier and build one, because "cylinder" is a longer alias than "engine". The user
 * gets a plain cylinder and a message saying "Built a cylinder", which is the worst possible
 * outcome: confidently wrong, and indistinguishable at a glance from having worked.
 */
const HEAD_BOUNDARIES = [
  ' with ', ' without ', ' for ', ' and ', ' plus ', ' having ', ' including ',
  ' that ', ' which ', ' to fit ', ' to suit ', ' from ', ' using ', ' made ',
  ' on ', ' in ', ' at ', ' per ', ' so ', ' but ',
];

/**
 * Nouns that stand in for the real subject: "a model of a car" is a request for a car.
 * Their presence as a head noun means the head is really whatever follows "of".
 */
const TRANSPARENT_HEADS = new Set([
  'model', 'part', 'design', 'drawing', 'cad', 'shape', 'object', 'component',
  'thing', 'version', 'copy', 'render', 'sketch', 'file', 'solid', 'body',
]);

/**
 * Trailing words that qualify a head noun rather than being one: units, bare numbers,
 * designations and the dimension adjectives that follow a size.
 *
 * "Make a cup 90 mm tall" still has "cup" as its head; the three words after it are the size.
 */
const TRAILING_QUALIFIERS = new Set([
  ...Object.keys(UNIT_TO_MM),
  // Every word that names a *parameter* names a dimension of the head noun, never the head
  // noun itself. Taking them from the same table the sizer uses means the two cannot drift.
  ...KEYWORDS.flatMap((k) => k.words).flatMap((w) => w.split(' ')),
  'tall', 'high', 'long', 'wide', 'deep', 'thick', 'across', 'square', 'round',
  'x', '×', 'by', 'degree', 'degrees', 'deg', 'off', 'free', 'overall', 'each',
  'arm', 'spine', 'tier', 'tiers', 'pitch', 'stroke', 'lift', 'wire', 'size',
  // Politeness and filler, which trail a request often enough to matter.
  'please', 'thanks', 'thank', 'you', 'now', 'ok', 'okay', 'asap',
  // Product variant words. "iPhone 15 Pro Max" is a request for an iPhone; "Pro" and "Max"
  // grade it, and none of them is the name of a mechanical part.
  'pro', 'max', 'plus', 'mini', 'air', 'ultra', 'lite', 'se', 'xl', 'gen',
]);

/** True for a token that carries no noun meaning: a number, a size code, punctuation. */
function isQualifierToken(token: string): boolean {
  if (token.length === 0) return true;
  if (TRAILING_QUALIFIERS.has(token)) return true;
  // 6205, m10, 1/4, 08b, htd5m — a designation or a measurement, never the head noun.
  return /^[\d./]+$/.test(token) || /^[a-z]{0,3}\d/.test(token);
}

/**
 * The words the request is actually about, in order.
 *
 * Everything after a qualifier boundary is cut away first: "a crankshaft for a 4 cylinder
 * engine" reduces to "crankshaft", because the cylinder and the engine are what the
 * crankshaft is *for*, not what was asked for. Articles and the imperative go too, so
 * "please make me a cup" reduces to "cup".
 */
export function headTokens(text: string): string[] {
  let phrase = ` ${text.toLowerCase().trim()} `;

  const cut = phrase.search(/[,;.:(]/);
  if (cut > 0) phrase = `${phrase.slice(0, cut)} `;
  for (const b of HEAD_BOUNDARIES) {
    const at = phrase.indexOf(b);
    if (at > 0) phrase = `${phrase.slice(0, at)} `;
  }

  for (let pass = 0; pass < 2; pass++) {
    const words = phrase
      .replace(/^\s*(please\s+)?(make|model|build|create|design|draw|generate|give|show|produce|need|want|get)\s+(me\s+)?/, ' ')
      .replace(/\s(a|an|the|some|my|this|that|of|new)\s/g, ' ')
      .replace(/\s(a|an|the|some|my|this|that|of|new)\s/g, ' ')
      .split(/[^a-z0-9\/.×"'-]+/)
      .filter((w) => w.length > 0);

    // "A model of a car" — the last word stands in for the real subject, so re-read from
    // after "of" and take the noun that follows.
    const last = words[words.length - 1] ?? '';
    if (pass === 0 && TRANSPARENT_HEADS.has(last.replace(/[^a-z-]/g, ''))) {
      const of = phrase.indexOf(' of ');
      if (of >= 0) { phrase = ` ${phrase.slice(of + 4)} `; continue; }
    }
    return words;
  }
  return [];
}

/**
 * The single noun a request is about, or '' when there is no identifiable one.
 *
 * English compound nouns are head-final — a "socket head cap screw" is a screw, a "ball
 * bearing" is a bearing — so the head is the last real word. `isKnown` lets the caller stop
 * the walk early on a word it recognises, which is what keeps a designation like "HTD 5M"
 * from being mistaken for the head of "timing belt pulley 20 teeth HTD 5M".
 */
export function headNoun(text: string, isKnown: (word: string) => boolean = () => false): string {
  const words = headTokens(text);
  let afterDesignation = false;

  for (let i = words.length - 1; i >= 0; i--) {
    const raw = words[i]!;
    const word = raw.replace(/[^a-z-]/g, '');

    if (word.length > 0 && isKnown(word)) return word;

    if (isQualifierToken(raw)) {
      // Only a token mixing letters and digits puts the walk into designation territory —
      // "5M", "M10", "08B". A plain measurement does not, so "cup" is still the head of
      // "a cup 90 mm tall".
      if (/[a-z]/.test(raw) && /\d/.test(raw)) afterDesignation = true;
      continue;
    }

    // A short alphabetic run *inside* a designation is part of it, not the head noun: the
    // "HTD" of "HTD 5M", the "ISO" of "ISO 4762". Standing alone it is a noun like any
    // other — "rib", "nut", "car" — and the walk stops there, which is the whole point: an
    // unrecognised head noun becomes a refusal rather than a silently different part.
    if (word.length <= 3 && afterDesignation) continue;

    return word;
  }
  return '';
}

/**
 * True when `alias` is a name for the thing `head` names.
 *
 * Head-final again: the multi-word alias "hex nut" names a nut, so it satisfies the head
 * "nut". Plurals are matched because a request is as often plural as not.
 */
function aliasNames(alias: string, head: string): boolean {
  const last = alias.trim().split(/\s+/).pop() ?? '';
  return last === head
    || `${last}s` === head
    || last === `${head}s`
    || (head.length > 4 && (last === head.replace(/s$/, '') || last.replace(/s$/, '') === head));
}


/** True when the word at `at` is introduced as an attachment to something already named. */
function attachedAt(lower: string, at: number): boolean {
  const before = lower.slice(Math.max(0, at - 16), at);
  return ATTACHMENTS.some((w) => before.includes(w));
}

// ── the parser ───────────────────────────────────────────────────────────────

export function parseRequest(text: string): ParseResult | ParseFailure {
  const lower = ` ${text.toLowerCase().replace(/[,;]/g, ' ')} `;

  // Score every archetype by how specifically its aliases appear.
  const scored = ARCHETYPES.map((a) => {
    let score = 0;
    for (const alias of a.aliases) {
      const at = aliasIndex(lower, alias);
      if (at < 0) continue;
      // A word the request is *excluding* is not what it is asking for. "A cup with no
      // handle" names a cup; scoring on alias length alone made it a handle, because
      // "handle" is the longer word. The negation list already existed for parameters —
      // this is the same signal applied one level up, to which shape was meant.
      if (negatedAt(lower, at)) continue;

      // Longer aliases are more specific: "coffee cup" beats "cup". But a noun introduced by
      // "with" is a *feature of* the thing being asked for rather than the thing itself —
      // "a mug with a handle" is a mug — so it is heavily discounted. It still scores above
      // zero, because "a handle" on its own has to keep working.
      const weight = attachedAt(lower, at) ? Math.max(1, alias.length - 10) : alias.length;
      score = Math.max(score, weight);
    }
    return { a, score };
  }).filter((s) => s.score > 0).sort((x, y) => y.score - x.score);

  if (scored.length === 0) {
    return {
      archetype: null,
      suggestions: ARCHETYPES.slice(0, 6).map((a) => ({ id: a.id, label: a.label, score: 0 })),
      message:
        `No shape in the catalogue matches "${text.trim()}". ` +
        `Try naming one directly — for example "make a cup", "M10 hex nut", or ` +
        `"200 x 120 x 8 plate with 9 mm holes".`,
    };
  }

  /*
   * The head-noun gate.
   *
   * Scoring alone will match any alias anywhere in the sentence, which is right for
   * "200 x 120 x 8 plate with 9 mm holes" and catastrophic for "a crankshaft for a 4
   * cylinder engine" — the latter scores `cylinder` out of a subordinate clause and builds
   * a plain cylinder, announced as a success. A CAD tool that answers the wrong question
   * confidently is worse than one that answers nothing: the user has no signal that the
   * geometry on screen is not the part they asked for.
   *
   * So the winner must be a name for the thing the request is actually about. When the head
   * noun is identifiable and no archetype names it, the request is refused and the head noun
   * is quoted back, which is the one piece of information that tells the user why.
   */
  const names = (word: string) =>
    ARCHETYPES.some((a) => a.aliases.some((alias) => aliasNames(alias, word)));
  const head = headNoun(text, names);

  if (head.length > 2) {
    const named = scored.filter((s) => s.a.aliases.some((alias) => aliasNames(alias, head)));

    if (named.length === 0) {
      return {
        archetype: null,
        suggestions: scored.slice(0, 6).map((s) => ({ id: s.a.id, label: s.a.label, score: s.score })),
        message:
          `There is no "${head}" in the catalogue, and building the nearest thing to it ` +
          `would give you a part you did not ask for. ` +
          (scored.length > 0
            ? `The closest shapes it does have are ${scored.slice(0, 3).map((s) => s.a.label).join(', ')}. `
            : '') +
          `Name one of those directly, or model the ${head} from features — sketch, extrude, ` +
          `revolve, sweep and loft are all on the toolbar.`,
      };
    }

    // Re-rank so the archetype that names the head wins, whatever else the sentence mentions.
    scored.length = 0;
    scored.push(...named);
  }

  const archetype = scored[0].a;
  const measures = findMeasures(lower);
  const params: Record<string, number> = {};
  const understood: string[] = [];
  const ignored: string[] = [];

  const validKeys = new Set(archetype.defaults.map((d) => d.key));
  const claimed = new Set<number>();

  // Each archetype's own parameter labels, before the shared synonym table.
  //
  // The synonym table only knows the words common across mechanical parts — diameter, wall,
  // thickness, tall. That covers a cup and says nothing about a plating rack, whose useful
  // parameters are "spine height", "arm length" and "tiers": the parser understood not one
  // phrasing of them, so every rack request had to be adjusted by hand afterwards.
  //
  // The labels are already written, already in the trade's own words, and already attached to
  // the right key. Matching them first gives every archetype natural-language sizing without
  // anyone maintaining a synonym list per part.
  for (const spec of archetype.defaults) {
    if (params[spec.key] !== undefined) continue;

    const label = spec.label.toLowerCase();
    const at = lower.indexOf(` ${label}`);
    if (at < 0) continue;

    const near = nearestMeasure(measures, at, label.length, claimed);
    if (!near) continue;

    params[spec.key] = convertForParam(archetype, spec.key, near.mm);
    claimed.add(near.index);
    understood.push(`${label} = ${spec.unit === 'count' ? String(Math.round(near.mm)) : formatMm(near.mm)}`);
  }

  // Keyword-anchored measurements: "wall 3 mm", "3 mm wall", "diameter of 80".
  for (const entry of KEYWORDS) {
    const key = entry.keys.find((k) => validKeys.has(k));
    if (!key || params[key] !== undefined) continue;

    for (const word of entry.words) {
      const at = lower.indexOf(` ${word}`);
      if (at < 0) continue;

      const near = nearestMeasure(measures, at, word.length, claimed);
      if (!near) continue;

      params[key] = convertForParam(archetype, key, near.mm);
      claimed.add(near.index);
      understood.push(`${word} = ${formatMm(near.mm)}`);
      break;
    }
  }

  // Dimension triples: "200 x 120 x 8".
  const triple = lower.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:[x×]\s*(\d+(?:\.\d+)?))?/);
  if (triple) {
    const order = dimensionOrder(archetype);
    const values = [triple[1], triple[2], triple[3]].filter(Boolean).map(Number);
    values.forEach((v, i) => {
      const key = order[i];
      if (key && params[key] === undefined && validKeys.has(key)) {
        params[key] = v;
        understood.push(`${key} = ${formatMm(v)}`);
      }
    });
    for (const m of measures) if (triple.index !== undefined && m.index >= triple.index && m.index < triple.index + triple[0].length) claimed.add(m.index);
  }

  // Counts: "8 bolts", "24 teeth", "4 holes".
  applyCount(lower, /(\d+)\s*(?:off\s*)?(?:bolt|screw|fastener)/, 'boltCount', archetype, params, understood, validKeys);
  applyCount(lower, /(\d+)\s*(?:tooth|teeth)/, 'teeth', archetype, params, understood, validKeys);
  applyCount(lower, /(\d+)\s*hole/, 'holesPerLeg', archetype, params, understood, validKeys);

  // Word-form numbers: "eight bolts".
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (!lower.includes(` ${word} `)) continue;
    if (lower.includes(`${word} bolt`) && validKeys.has('boltCount') && params.boltCount === undefined) {
      params.boltCount = value;
      understood.push(`bolt count = ${value}`);
    }
    if (lower.includes(`${word} teeth`) && validKeys.has('teeth') && params.teeth === undefined) {
      params.teeth = value;
      understood.push(`teeth = ${value}`);
    }
  }

  // Negations: "no handle", "without holes".
  if (validKeys.has('handle') && NEGATIONS.some((n) => lower.includes(`${n}handle`))) {
    params.handle = 0;
    understood.push('no handle');
  }
  if (validKeys.has('holesPerLeg') && NEGATIONS.some((n) => lower.includes(`${n}hole`))) {
    params.holesPerLeg = 0;
    understood.push('no holes');
  }
  if (validKeys.has('holeDia') && NEGATIONS.some((n) => lower.includes(`${n}hole`))) {
    params.holeDia = 0;
  }

  // Capacity, for vessels: size the body to hold the requested volume.
  const capacity = lower.match(/(\d+(?:\.\d+)?)\s*(ml|millilitre|milliliter|l|litre|liter|cl)\b/);
  if (capacity && (validKeys.has('outerDia') || validKeys.has('bodyDia'))) {
    const unit = capacity[2];
    const ml = parseFloat(capacity[1]) * (unit.startsWith('l') ? 1000 : unit === 'cl' ? 10 : 1);
    applyCapacity(archetype, params, ml, understood);
  }

  // A single bare number with no keyword is genuinely ambiguous, so say so rather than
  // guessing which dimension the user meant.
  const unclaimed = measures.filter((m) => !claimed.has(m.index) && !/^\d+$/.test(m.raw.trim()) === false);
  for (const m of unclaimed) {
    if (Object.keys(params).length > 0) ignored.push(m.raw);
  }

  return {
    archetype,
    params,
    confidence: Math.min(1, 0.5 + scored[0].score / 24 + Object.keys(params).length * 0.05),
    understood,
    ignored,
  };
}

function nearestMeasure(
  measures: Measure[], at: number, wordLen: number, claimed: Set<number>,
): Measure | null {
  let best: Measure | null = null;
  let bestDist = Infinity;

  for (const m of measures) {
    if (claimed.has(m.index)) continue;
    // Distance from the keyword to the number, measuring from whichever side it sits on.
    const dist = m.index > at ? m.index - (at + wordLen) : at - (m.index + m.raw.length);
    // Beyond about 12 characters the association is guesswork, and a wrong association is
    // worse than none: it silently produces a part with the wrong dimension.
    if (dist < 0 || dist > 12 || dist >= bestDist) continue;
    bestDist = dist;
    best = m;
  }
  return best;
}

/** Angles are given in degrees, not millimetres, so the unit conversion must not apply. */
function convertForParam(a: Archetype, key: string, mm: number): number {
  const spec = a.defaults.find((d) => d.key === key);
  return spec?.unit === 'deg' || spec?.unit === 'count' ? mm : mm;
}

/** Which parameters a bare "A x B x C" maps to, per archetype. */
function dimensionOrder(a: Archetype): string[] {
  switch (a.id) {
    case 'plate': return ['length', 'width', 'thickness'];
    case 'box': return ['length', 'width', 'height'];
    case 'bracket': return ['legA', 'legB', 'thickness'];
    case 'enclosure': return ['length', 'width', 'height'];
    case 'cup': return ['outerDia', 'height', 'wall'];
    default: {
      const keys = a.defaults.map((d) => d.key);
      return keys.slice(0, 3);
    }
  }
}

function applyCount(
  text: string, re: RegExp, key: string, a: Archetype,
  params: Record<string, number>, understood: string[], valid: Set<string>,
): void {
  if (!valid.has(key) || params[key] !== undefined) return;
  const m = text.match(re);
  if (!m) return;
  params[key] = parseInt(m[1], 10);
  understood.push(`${key} = ${m[1]}`);
  void a;
}

/**
 * Sizes a vessel to a requested capacity.
 *
 * Height is held at a natural proportion and the diameter solved for, because a 500 ml cup
 * that is 300 mm tall and 46 mm across is technically correct and obviously not what was
 * asked for.
 */
function applyCapacity(a: Archetype, params: Record<string, number>, ml: number, understood: string[]): void {
  const mm3 = ml * 1000;

  if (a.id === 'cup') {
    // Aspect ratio of roughly 1.15 height to diameter matches typical drinkware.
    const d = Math.cbrt((4 * mm3) / (Math.PI * 1.15));
    params.outerDia = params.outerDia ?? Math.round(d + 8);   // add the wall
    params.height = params.height ?? Math.round(d * 1.15 + 12);
    understood.push(`sized for ${ml} ml`);
    return;
  }

  if (a.id === 'bottle') {
    const d = Math.cbrt((4 * mm3) / (Math.PI * 2.6));
    params.bodyDia = params.bodyDia ?? Math.round(d + 4);
    params.height = params.height ?? Math.round(d * 2.6 + 60);
    understood.push(`sized for ${ml} ml`);
  }
}

const formatMm = (mm: number): string =>
  mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Number(mm.toFixed(3))} mm`;

// ── thread designations ──────────────────────────────────────────────────────

/**
 * ISO metric thread designations, because "M10 nut" is how fasteners are actually
 * specified and expanding it by hand every time would be absurd.
 *
 * Values are the standard across-flats and nominal thicknesses from ISO 4032/4035.
 */
const METRIC_FASTENERS: Record<string, { acrossFlats: number; thickness: number; bore: number; washerOd: number }> = {
  m3: { acrossFlats: 5.5, thickness: 2.4, bore: 3, washerOd: 7 },
  m4: { acrossFlats: 7, thickness: 3.2, bore: 4, washerOd: 9 },
  m5: { acrossFlats: 8, thickness: 4.7, bore: 5, washerOd: 10 },
  m6: { acrossFlats: 10, thickness: 5.2, bore: 6, washerOd: 12 },
  m8: { acrossFlats: 13, thickness: 6.8, bore: 8, washerOd: 16 },
  m10: { acrossFlats: 17, thickness: 8.4, bore: 10, washerOd: 20 },
  m12: { acrossFlats: 19, thickness: 10.8, bore: 12, washerOd: 24 },
  m16: { acrossFlats: 24, thickness: 14.8, bore: 16, washerOd: 30 },
  m20: { acrossFlats: 30, thickness: 18, bore: 20, washerOd: 37 },
  m24: { acrossFlats: 36, thickness: 21.5, bore: 24, washerOd: 44 },
};

/** Applies an "M10"-style designation, if one is present. Returns true when it matched. */
export function applyFastenerDesignation(
  text: string, archetypeId: string, params: Record<string, number>,
): boolean {
  const m = text.toLowerCase().match(/\bm(\d+(?:\.\d+)?)\b/);
  if (!m) return false;

  const spec = METRIC_FASTENERS[`m${m[1]}`];
  if (!spec) return false;

  if (archetypeId === 'nut') {
    params.acrossFlats ??= spec.acrossFlats;
    params.thickness ??= spec.thickness;
    params.boreDia ??= spec.bore;
    return true;
  }
  if (archetypeId === 'washer') {
    params.boreDia ??= spec.bore + 0.5;
    params.outerDia ??= spec.washerOd;
    return true;
  }
  // For anything else, an M-number most likely describes its holes.
  if (params.holeDia === undefined) params.holeDia = spec.bore + 0.5;
  if (params.boltDia === undefined) params.boltDia = spec.bore + 0.5;
  return true;
}

/** Full pipeline: text in, built solid out. */
export function generateFromText(text: string) {
  const parsed = parseRequest(text);
  if (parsed.archetype === null) return { ok: false as const, ...parsed };

  applyFastenerDesignation(text, parsed.archetype.id, parsed.params);
  const result = parsed.archetype.build(parsed.params);

  return {
    ok: true as const,
    archetype: parsed.archetype,
    parsed,
    result,
  };
}

export function describeParams(specs: ParamSpec[], values: Record<string, number>): string[] {
  return specs.map((s) => {
    const v = values[s.key] ?? s.value;
    const unit = s.unit === 'count' ? '' : ` ${s.unit}`;
    const explicit = values[s.key] !== undefined ? '' : ' (default)';
    return `${s.label}: ${v}${unit}${explicit}`;
  });
}

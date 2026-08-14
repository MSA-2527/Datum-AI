/**
 * Finding the reference entries relevant to a request.
 *
 * The whole corpus is far too long to put in a prompt, and putting it there would be the wrong
 * move anyway: a model handed four hundred dimensions attends to none of them. What works is a
 * short, targeted list — the dozen entries that actually bear on what is being built.
 *
 * Matching is keyword overlap with a length bias, not embeddings. That is a deliberate choice
 * rather than a shortcut. This vocabulary is closed and technical: "M6", "608", "18650",
 * "NEMA 17" are exact tokens with exact meanings, and a nearest-neighbour search in an
 * embedding space is *worse* at them than string matching, because it happily returns 6205
 * when you asked for 6204. It also needs no model, no index and no network, which keeps the
 * offline path genuinely offline.
 */

import { FACTS, type Fact } from './standards';

export interface Match {
  fact: Fact;
  score: number;
}

/**
 * Scores one entry against a lower-cased query.
 *
 * A longer keyword matching is worth more than a short one, because "ball bearing" appearing
 * in the request says far more than "shaft" does. Designations are checked on a word boundary
 * so "608" does not match inside "1608" or a stray dimension.
 */
function score(fact: Fact, query: string): number {
  let total = 0;

  for (const keyword of fact.keywords) {
    if (!query.includes(keyword)) continue;

    // A purely numeric or alphanumeric designation must stand as its own word. Without this,
    // asking for a 40 mm fan retrieves every entry whose keyword contains "40".
    if (DESIGNATION.test(keyword)) {
      if (!standsAlone(keyword, query)) continue;
      total += keyword.length * 3; // an exact designation is the strongest possible signal
      continue;
    }

    total += keyword.length;
  }

  // The subject line itself, for requests that name the thing outright.
  if (query.includes(fact.subject.toLowerCase())) total += fact.subject.length * 2;

  return total;
}

/**
 * The entries most relevant to a request, best first.
 *
 * `limit` is small on purpose. Twelve entries is roughly what a model will actually read and
 * use; fifty is a wall of numbers it skims.
 */
export function retrieve(query: string, limit = 12): Match[] {
  const lower = ` ${query.toLowerCase()} `;
  const asked = designationsIn(lower);

  const scored = FACTS
    .map((fact) => ({ fact, score: score(fact, lower) }))
    .filter((m) => m.score > 0 && !wrongSize(m.fact, asked))
    .sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id));

  return diversify(scored, limit);
}

/** A part designation — `m6`, `608`, `18650`, `cr2032` — as opposed to a descriptive word. */
const DESIGNATION = /^[a-z]?[\d.]+$/;

/**
 * True when `token` appears in `query` as its own word.
 *
 * The surrounding character class excludes digits and dots as well as letters, which is what
 * stops "608" matching inside "1608" and "M3" matching inside "M30". Both are entirely
 * different parts, and a plain substring test conflates them silently.
 */
function standsAlone(token: string, query: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9.])${escaped}([^a-z0-9.]|$)`).test(query);
}

/**
 * The designations a query names, grouped by the category they belong to.
 *
 * Grouping is the whole point. "An M6 bolt and a bearing" names a *fastener* size and no
 * bearing size, so it should narrow the fasteners to M6 and leave the bearings wide open. A
 * single flat set cannot express that: it suppressed every bearing in the corpus for failing
 * to be called M6.
 */
function designationsIn(query: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();

  for (const fact of FACTS) {
    for (const keyword of fact.keywords) {
      if (!DESIGNATION.test(keyword) || !standsAlone(keyword, query)) continue;
      const set = found.get(fact.category);
      if (set) set.add(keyword);
      else found.set(fact.category, new Set([keyword]));
    }
  }

  return found;
}

/**
 * True when this entry is a *different size of the same kind of thing* than was asked for.
 *
 * Generic keywords are what make retrieval useful — "cap screw" should find cap screws — but
 * they are also what makes it useless once a size is named. Asking for an M3 screw matched all
 * thirteen ISO 4762 entries on the words "cap screw", filling the entire result budget with
 * twelve wrong sizes and pushing out the motor and the circuit board the request also needed.
 *
 * The filter is confined to the category the named size belongs to. Naming M6 narrows the
 * fasteners and says nothing about bearings; entries carrying no size at all are never
 * touched, because "aluminium" is not a wrong answer to "M3 screw in aluminium".
 */
function wrongSize(fact: Fact, asked: Map<string, Set<string>>): boolean {
  const inCategory = asked.get(fact.category);
  if (!inCategory) return false;

  const own = fact.keywords.filter((k) => DESIGNATION.test(k));
  if (own.length === 0) return false;

  return !own.some((k) => inCategory.has(k));
}

/**
 * Spreads the result across categories.
 *
 * Relevance ordering alone is not enough even after size filtering, because a request that
 * names several fastener terms still ranks a dozen fasteners above the one battery it also
 * needs. A model reading twelve screw entries and no cell has been given a worse prompt than
 * one reading four of each.
 *
 * Best-first within each category, round-robin across them, so the strongest entry from every
 * relevant category is in before the second entry from any of them.
 */
function diversify(scored: Match[], limit: number): Match[] {
  const byCategory = new Map<string, Match[]>();
  for (const m of scored) {
    const bucket = byCategory.get(m.fact.category);
    if (bucket) bucket.push(m);
    else byCategory.set(m.fact.category, [m]);
  }

  // Categories in order of their best entry, so the most relevant kind of thing leads.
  const buckets = [...byCategory.values()].sort((a, b) => b[0].score - a[0].score);

  const out: Match[] = [];
  for (let round = 0; out.length < limit; round++) {
    let placed = false;
    for (const bucket of buckets) {
      if (round >= bucket.length) continue;
      out.push(bucket[round]);
      placed = true;
      if (out.length >= limit) break;
    }
    if (!placed) break;
  }

  return out;
}

/** Formats one entry as a single compact line. */
export function renderFact(fact: Fact): string {
  const dims = Object.entries(fact.dims)
    .map(([k, v]) => `${k}=${Number(v.toFixed(4))}`)
    .join(', ');
  return `- ${fact.subject}: ${dims} [${fact.source}]`;
}

/**
 * The retrieved entries as a prompt block, or an empty string when nothing matched.
 *
 * Returning empty rather than a "no results" note matters: an empty string drops the whole
 * section from the prompt, whereas telling a model that a lookup found nothing invites it to
 * comment on the lookup instead of doing the job.
 */
export function referenceBlock(query: string, limit = 12): string {
  const matches = retrieve(query, limit);
  if (matches.length === 0) return '';

  return [
    'REFERENCE DIMENSIONS — these are published standards, not suggestions.',
    'Where a component below appears in your plan, use these figures exactly and cite the',
    'standard in its "note". Do not round them and do not substitute your own recollection.',
    '',
    ...matches.map((m) => renderFact(m.fact)),
  ].join('\n');
}

/**
 * Expands a request into the terms worth looking up.
 *
 * A request rarely names the parts it implies. "A skateboard" does not say "bearing", but a
 * skateboard has eight of them and they are 608s. These associations are the difference
 * between retrieval that fires on a component list and retrieval that fires on the request
 * itself, which is the only chance it gets before the plan exists.
 */
const IMPLIES: [pattern: RegExp, terms: string[]][] = [
  [/\bskateboard|longboard|scooter\b/, ['608 bearing', 'M8 bolt', 'nut']],
  [/\b3d printer|prusa|ender\b/, ['NEMA 17', '608 bearing', 'M3 socket head cap screw', 'pcb']],
  [/\bcnc|router|mill\b/, ['NEMA 23', 'bearing', 'M8 bolt', 'aluminium']],
  [/\bphone|smartphone|handset\b/, ['pcb', 'usb-c', 'lithium battery', 'glass', 'credit card']],
  [/\blaptop|notebook\b/, ['pcb', 'usb-c', 'usb-a', '18650', 'hdmi', 'aluminium']],
  [/\bdesktop|pc case|computer\b/, ['120mm fan', 'pcb', 'usb-a', 'rack']],
  [/\bdrone|quadcopter\b/, ['lithium battery', 'pcb', 'M3 screw', 'carbon']],
  [/\btorch|flashlight\b/, ['AA cell', '18650', 'aluminium']],
  [/\bremote|controller\b/, ['AAA cell', 'pcb', 'abs']],
  [/\bwatch|wearable\b/, ['CR2032', 'pcb', 'stainless']],
  [/\bmotor|actuator\b/, ['NEMA 17', 'bearing', 'copper', 'steel']],
  [/\bgearbox|reducer\b/, ['bearing', 'steel', 'M6 bolt']],
  [/\bbicycle|bike\b/, ['bearing', 'aluminium', 'M5 bolt']],
  [/\bserver|rack\b/, ['rack', '80mm fan', 'pcb']],
  [/\benclosure|housing|case\b/, ['abs', 'M3 screw', 'pcb']],
  [/\bbracket|mount\b/, ['M6 bolt', 'aluminium', 'steel', 'tolerance']],
];

/**
 * Builds the retrieval query for a request.
 *
 * The request itself plus the terms it implies plus, when a plan already exists, every
 * component name in it — so the audit path looks up what was actually proposed rather than
 * what was asked for.
 */
export function expandQuery(request: string, componentNames: string[] = []): string {
  const lower = request.toLowerCase();
  const extra: string[] = [];

  for (const [pattern, terms] of IMPLIES) {
    if (pattern.test(lower)) extra.push(...terms);
  }

  return [request, ...componentNames, ...extra].join(' ');
}

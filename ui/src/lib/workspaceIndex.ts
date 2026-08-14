import { evaluate, massGrams, type PartDoc } from './partModel';
import { listSaved, open as openSaved } from './persistence';

/**
 * Local workspace index.
 *
 * Answers the question that actually saves money: "have we already made this?" Engineers
 * remodel parts the company already owns because finding one is harder than drawing one,
 * so retrieval has to beat modelling on effort or nobody uses it.
 *
 * Two channels, because neither works alone:
 *   - **text** over titles, part numbers, materials and properties;
 *   - **geometry** over a cheap deterministic fingerprint — envelope ratios, hole count,
 *     hole sizes, area fill. No embeddings, no GPU, no network.
 *
 * Results are fused with reciprocal rank fusion, which is robust when the two channels
 * disagree about ordering and needs no score calibration between them.
 */

export interface IndexEntry {
  name: string;
  title: string;
  savedAtUtc: string;
  material: string;
  properties: Record<string, string>;
  /** Geometry fingerprint. */
  fingerprint: Fingerprint;
  /** Flattened text, lower-cased, for substring and token matching. */
  haystack: string;
}

export interface Fingerprint {
  L: number;
  W: number;
  T: number;
  massG: number;
  holeCount: number;
  /** Distinct hole diameters, ascending. */
  holeSizes: number[];
  cutCount: number;
  cornerR: number;
  /** Net area ÷ envelope area — how much material survives. */
  fill: number;
}

export function fingerprintOf(doc: PartDoc): Fingerprint {
  const g = evaluate(doc);
  const envelope = Math.max(1e-6, g.L * g.W);

  return {
    L: g.L,
    W: g.W,
    T: g.T,
    massG: massGrams(doc, g),
    holeCount: g.holes.length,
    holeSizes: [...new Set(g.holes.map((h) => Math.round(h.d * 10) / 10))].sort((a, b) => a - b),
    cutCount: g.cuts.length,
    cornerR: g.cornerR,
    fill: g.areaMm2 / envelope,
  };
}

function haystackOf(doc: PartDoc, name: string): string {
  return [
    name,
    doc.title,
    doc.material,
    ...Object.entries(doc.properties).flatMap(([k, v]) => [k, v]),
    ...doc.features.map((f) => `${f.name} ${f.swType}`),
  ]
    .join(' ')
    .toLowerCase();
}

/** Builds the index from everything in the local library. */
export function buildIndex(): IndexEntry[] {
  const out: IndexEntry[] = [];

  for (const saved of listSaved()) {
    const res = openSaved(saved.name);
    if (!res.doc) continue; // schema mismatch or corrupt entry — skip, do not guess

    out.push({
      name: saved.name,
      title: res.doc.title,
      savedAtUtc: saved.savedAtUtc,
      material: res.doc.material,
      properties: res.doc.properties,
      fingerprint: fingerprintOf(res.doc),
      haystack: haystackOf(res.doc, saved.name),
    });
  }

  return out;
}

// ── scoring ──────────────────────────────────────────────────────────────────

export function textScore(entry: IndexEntry, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  let hits = 0;
  for (const t of tokens) if (entry.haystack.includes(t)) hits += 1;

  // Whole-phrase matches beat scattered token hits.
  const phrase = entry.haystack.includes(q) ? 0.5 : 0;
  return hits / tokens.length + phrase;
}

/**
 * Geometric similarity in [0, 1].
 *
 * Compares shape rather than absolute size first: two brackets that differ only in scale
 * are far more interchangeable than two of identical mass with different hole patterns.
 */
export function geometryScore(a: Fingerprint, b: Fingerprint): number {
  const ratio = (x: number, y: number) => {
    const hi = Math.max(Math.abs(x), Math.abs(y));
    if (hi < 1e-9) return 1; // both effectively zero — identical, not divergent
    return 1 - Math.abs(x - y) / hi;
  };

  // Aspect ratio, normalised so orientation does not matter.
  const aspect = (f: Fingerprint) => (f.W < 1e-9 ? 0 : Math.max(f.L, f.W) / Math.max(1e-9, Math.min(f.L, f.W)));

  const holeSizeMatch =
    a.holeSizes.length === 0 && b.holeSizes.length === 0
      ? 1
      : a.holeSizes.filter((d) => b.holeSizes.some((e) => Math.abs(d - e) < 0.3)).length /
        Math.max(1, Math.max(a.holeSizes.length, b.holeSizes.length));

  const terms: [number, number][] = [
    [ratio(aspect(a), aspect(b)), 0.25],
    [ratio(a.fill, b.fill), 0.2],
    [ratio(a.holeCount, b.holeCount), 0.2],
    [holeSizeMatch, 0.2],
    [ratio(a.T, b.T), 0.15],
  ];

  return terms.reduce((sum, [score, weight]) => sum + score * weight, 0);
}

export interface SearchHit {
  entry: IndexEntry;
  score: number;
  textScore: number;
  geometryScore: number;
  /** Why this matched, in plain words. */
  reason: string;
}

export interface SearchOptions {
  /** Text query. Optional when searching purely by geometry. */
  query?: string;
  /** Compare against this document's shape. */
  like?: PartDoc;
  limit?: number;
  /** Exclude the document being searched from its own results. */
  excludeName?: string;
}

/**
 * Reciprocal rank fusion over the two channels.
 *
 * RRF is used rather than a weighted sum because the two scores are not on comparable
 * scales, and calibrating them would need tuning data this product does not have yet.
 * Rank position is scale-free.
 */
export function search(index: IndexEntry[], options: SearchOptions): SearchHit[] {
  const { query = '', like, limit = 10, excludeName } = options;
  const pool = index.filter((e) => e.name !== excludeName);
  if (pool.length === 0) return [];

  const K = 60; // standard RRF damping

  const byText = [...pool]
    .map((e) => ({ e, s: textScore(e, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const likeFp = like ? fingerprintOf(like) : null;
  const byGeom = likeFp
    ? [...pool].map((e) => ({ e, s: geometryScore(likeFp, e.fingerprint) })).sort((a, b) => b.s - a.s)
    : [];

  const fused = new Map<string, SearchHit>();

  const fuse = (list: { e: IndexEntry; s: number }[], kind: 'text' | 'geom') => {
    list.forEach((item, rank) => {
      const existing = fused.get(item.e.name) ?? {
        entry: item.e,
        score: 0,
        textScore: 0,
        geometryScore: 0,
        reason: '',
      };
      existing.score += 1 / (K + rank + 1);
      if (kind === 'text') existing.textScore = item.s;
      else existing.geometryScore = item.s;
      fused.set(item.e.name, existing);
    });
  };

  fuse(byText, 'text');
  fuse(byGeom, 'geom');

  return [...fused.values()]
    .map((hit) => ({ ...hit, reason: describe(hit) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function describe(hit: SearchHit): string {
  const parts: string[] = [];
  if (hit.textScore >= 1) parts.push('name and properties match');
  else if (hit.textScore > 0) parts.push('partial text match');

  if (hit.geometryScore > 0.85) parts.push('near-identical geometry');
  else if (hit.geometryScore > 0.65) parts.push('similar proportions');

  const f = hit.entry.fingerprint;
  parts.push(
    `${f.L.toFixed(0)}×${f.W.toFixed(0)}×${f.T.toFixed(0)} mm, ${f.holeCount} hole${f.holeCount === 1 ? '' : 's'}`,
  );

  return parts.join(' · ');
}

/**
 * Proactive interception before modelling begins.
 *
 * Surfacing a match after someone has drawn the part is worthless; the value is entirely
 * in interrupting first. Deliberately strict — a false positive here trains people to
 * ignore the panel.
 */
export function findDuplicates(index: IndexEntry[], doc: PartDoc, threshold = 0.9): SearchHit[] {
  return search(index, { like: doc, limit: 5, excludeName: doc.title })
    .filter((h) => h.geometryScore >= threshold);
}

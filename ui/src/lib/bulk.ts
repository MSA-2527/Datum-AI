import { readStep } from '../ingest/step/read';
import { featureFromFit, fitArchetype } from '../ingest/fit/archetype';
import { addFeature, emptyDocument, type ParamValue } from '../model/document';
import { addFromDocument } from './training';

/**
 * Teaching a whole library at once.
 *
 * The single-part path — open a file, press Recognise, write the request, press Teach — is
 * the right shape for one part and the wrong shape for nine hundred. A library only becomes
 * training material if it can be taught in one pass, and the material for that pass already
 * exists: the export macro writes a `manifest.csv` beside the geometry, carrying the part
 * number, the revision and the **description** for every file.
 *
 * That description is the half a mesh cannot supply. An example is a request paired with the
 * part that answers it, the request cannot be recovered from geometry by any method, and
 * whatever your parts are described as in CAD is the closest thing to it you already have.
 * So this reads the two together: geometry from the STEP file, request from the manifest row
 * that names it.
 *
 * **Every file gets an outcome, and the outcomes are the point.** Most of a real library will
 * not be teachable — the fitter recovers six shapes and refuses everything else — and a run
 * that reports "taught 40" without saying what happened to the other 860 tells you nothing
 * about your library. The per-file reasons are what say whether the next work is more fitter
 * proposers, or better descriptions, or a different export setting.
 */

export type Outcome =
  | 'taught'
  /** Read as a solid, but no catalogue shape fits it closely enough to teach from. */
  | 'not recognised'
  /** Read, recognised, but the manifest gave no description to pair it with. */
  | 'no description'
  /** The file could not be read as a solid at all. */
  | 'unreadable'
  /** Read, but with faces missing or open — not sound enough to learn from. */
  | 'incomplete';

export interface FileResult {
  file: string;
  outcome: Outcome;
  /** What was taught, or why it was not. */
  detail: string;
  /** The archetype recovered, when one was. */
  archetypeId?: string;
}

export interface BulkResult {
  results: FileResult[];
  taught: number;
  /** Counts by outcome, most common first — the shape of the library in one line. */
  summary: { outcome: Outcome; count: number }[];
}

export interface ManifestRow {
  /** Base name of the exported file, without directories or extension. */
  key: string;
  description: string;
  partNumber: string;
  material: string;
}

// ── the manifest ────────────────────────────────────────────────────────────

/**
 * RFC 4180 CSV, which is what the export macro writes.
 *
 * Written out rather than split on commas because descriptions contain commas far more often
 * than anyone expects, and an unquoted one silently shifts every later column — so the part
 * number ends up in the material field and nothing announces it.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; continue; }
        quoted = false;
        continue;
      }
      field += c;
      continue;
    }

    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }

  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim().length > 0));
}

/** Strips directories and the extension, which is the only thing the two sides share. */
export function baseName(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.[^.]+$/, '').trim().toLowerCase();
}

/**
 * The manifest indexed by the file each row describes.
 *
 * Keyed on the *export* path where there is one, and on the source path otherwise, because a
 * row describes one part under two names and either may be the file that arrives.
 */
export function readManifest(text: string): Map<string, ManifestRow> {
  const rows = parseCsv(text);
  if (rows.length < 2) return new Map();

  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const at = (name: string) => header.indexOf(name);

  const sourceAt = at('source');
  const exportAt = at('export');
  const descriptionAt = at('description');
  const partAt = at('partnumber');
  const materialAt = at('material');

  if (descriptionAt < 0) return new Map();

  const out = new Map<string, ManifestRow>();

  for (const row of rows.slice(1)) {
    const description = (row[descriptionAt] ?? '').trim();
    const entry: ManifestRow = {
      key: '',
      description,
      partNumber: partAt >= 0 ? (row[partAt] ?? '').trim() : '',
      material: materialAt >= 0 ? (row[materialAt] ?? '').trim() : '',
    };

    for (const index of [exportAt, sourceAt]) {
      const path = index >= 0 ? (row[index] ?? '').trim() : '';
      if (!path) continue;
      const key = baseName(path);
      if (key) out.set(key, { ...entry, key });
    }
  }

  return out;
}

// ── the run ─────────────────────────────────────────────────────────────────

export interface BulkInput {
  /** File name as supplied, used to find its manifest row and to report against. */
  name: string;
  /** The STEP file's text. */
  text: string;
}

export interface BulkOptions {
  /** `manifest.csv`, if it came with the files. */
  manifest?: Map<string, ManifestRow>;
  /**
   * Teach a part whose solid did not close.
   *
   * Off by default. An example built from an incomplete solid teaches dimensions that were
   * measured from geometry with faces missing, and it does so without any sign that it did.
   */
  allowIncomplete?: boolean;
}

export function teachFiles(files: BulkInput[], options: BulkOptions = {}): BulkResult {
  const results: FileResult[] = [];

  for (const file of files) {
    results.push(teachOne(file, options));
  }

  const counts = new Map<Outcome, number>();
  for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);

  return {
    results,
    taught: counts.get('taught') ?? 0,
    summary: [...counts.entries()]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count),
  };
}

function teachOne(file: BulkInput, options: BulkOptions): FileResult {
  const read = readStep(file.text);
  if ('error' in read) {
    return { file: file.name, outcome: 'unreadable', detail: read.error };
  }

  if (!read.closed && !options.allowIncomplete) {
    return {
      file: file.name,
      outcome: 'incomplete',
      detail: read.notes[0] ?? 'The solid did not close, so its dimensions cannot be trusted.',
    };
  }

  const { best, reason } = fitArchetype(read.mesh);
  if (!best) {
    return {
      file: file.name,
      outcome: 'not recognised',
      detail: reason ?? 'No catalogue shape fits this closely enough to learn from.',
    };
  }

  const row = options.manifest?.get(baseName(file.name));
  const prompt = (row?.description ?? '').trim();

  if (prompt.length < 3) {
    return {
      file: file.name,
      outcome: 'no description',
      archetypeId: best.archetypeId,
      detail:
        `Recognised as a ${best.archetypeId}, but the manifest gives no description to pair `
        + 'it with. An example needs the request as well as the part.',
    };
  }

  const feature = featureFromFit(best);
  const base = row?.material
    ? { ...emptyDocument(read.name), material: row.material }
    : emptyDocument(read.name);

  const doc = addFeature(
    base, feature.kind,
    feature.params as Record<string, ParamValue>,
    feature.name,
  );

  const added = addFromDocument(prompt, doc, 'imported');
  if (!added.ok) {
    return {
      file: file.name,
      outcome: 'not recognised',
      archetypeId: best.archetypeId,
      detail: added.problem ?? 'The example could not be stored.',
    };
  }

  return {
    file: file.name,
    outcome: 'taught',
    archetypeId: best.archetypeId,
    detail: `"${prompt}" → ${best.archetypeId} (${best.detail})`,
  };
}

/** The run in one paragraph, outcomes first because they are the answer. */
export function describeBulk(result: BulkResult): string {
  if (result.results.length === 0) return 'No files were given.';

  const parts = result.summary.map((s) => `${s.count} ${s.outcome}`).join(', ');
  return `${result.results.length} files: ${parts}.`;
}

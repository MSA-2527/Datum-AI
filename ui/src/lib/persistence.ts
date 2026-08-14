import type { PartDoc } from './partModel';

/**
 * Local document persistence.
 *
 * A design tool that loses your work on refresh is not a design tool. The standalone
 * modeller keeps the document in localStorage, versioned, so a reload, a crash or a
 * WebView2 restart inside SOLIDWORKS all recover to the last good state.
 *
 * The schema version is checked on read. A document written by a newer build is left
 * alone rather than coerced — silently reinterpreting someone's geometry against a
 * changed schema is how you corrupt a part and blame the user.
 */

const SCHEMA = 2;
const AUTOSAVE_KEY = 'datum.doc.autosave';
const LIBRARY_KEY = 'datum.doc.library';

interface Envelope {
  schema: number;
  savedAtUtc: string;
  doc: PartDoc;
}

export interface LibraryEntry {
  name: string;
  savedAtUtc: string;
  features: number;
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Storage can throw: private browsing, quota, or a locked profile. Never fatal. */
function safeWrite(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// ── autosave ─────────────────────────────────────────────────────────────────

export function autosave(doc: PartDoc): boolean {
  const env: Envelope = { schema: SCHEMA, savedAtUtc: new Date().toISOString(), doc };
  return safeWrite(AUTOSAVE_KEY, JSON.stringify(env));
}

export interface RestoreResult {
  doc: PartDoc | null;
  /** Set when something was found but could not be used, so the UI can say why. */
  problem?: string;
  savedAtUtc?: string;
}

export function restoreAutosave(): RestoreResult {
  const env = safeParse<Envelope>(localStorage.getItem(AUTOSAVE_KEY));
  if (!env) return { doc: null };

  if (typeof env.schema !== 'number' || !env.doc || !Array.isArray(env.doc.features)) {
    return { doc: null, problem: 'The saved document is malformed and was ignored.' };
  }

  if (env.schema > SCHEMA) {
    return {
      doc: null,
      problem: `That document was saved by a newer version of DATUM (schema ${env.schema}). It was left untouched rather than opened against an older schema.`,
    };
  }

  return { doc: migrate(env.doc, env.schema), savedAtUtc: env.savedAtUtc };
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    /* nothing to do — the next autosave overwrites it anyway */
  }
}

/**
 * Forward-migrates older documents. Schema 1 predates the generalised profile, where
 * the outline was implied rather than carried by a feature.
 */
function migrate(doc: PartDoc, from: number): PartDoc {
  let out = doc;

  if (from < 2) {
    const hasProfile = out.features.some((f) => f.kind === 'plate');
    if (!hasProfile) {
      out = {
        ...out,
        features: [
          {
            id: 'f_migrated_profile',
            name: 'Boss-Extrude1',
            kind: 'plate',
            swType: 'Extrusion',
            suppressed: false,
            params: { shape: 'rect' },
          },
          ...out.features,
        ],
      };
    }
  }

  return out;
}

// ── named library ────────────────────────────────────────────────────────────

type Library = Record<string, Envelope>;

function readLibrary(): Library {
  return safeParse<Library>(localStorage.getItem(LIBRARY_KEY)) ?? {};
}

export function saveAs(name: string, doc: PartDoc): boolean {
  const clean = name.trim();
  if (!clean) return false;
  const lib = readLibrary();
  lib[clean] = { schema: SCHEMA, savedAtUtc: new Date().toISOString(), doc };
  return safeWrite(LIBRARY_KEY, JSON.stringify(lib));
}

export function listSaved(): LibraryEntry[] {
  const lib = readLibrary();
  return Object.entries(lib)
    .map(([name, env]) => ({
      name,
      savedAtUtc: env.savedAtUtc,
      features: env.doc?.features?.length ?? 0,
    }))
    .sort((a, b) => b.savedAtUtc.localeCompare(a.savedAtUtc));
}

export function open(name: string): RestoreResult {
  const env = readLibrary()[name];
  if (!env) return { doc: null, problem: `No saved document named "${name}".` };
  if (env.schema > SCHEMA) {
    return { doc: null, problem: `"${name}" was saved by a newer version of DATUM.` };
  }
  return { doc: migrate(env.doc, env.schema), savedAtUtc: env.savedAtUtc };
}

export function remove(name: string): void {
  const lib = readLibrary();
  delete lib[name];
  safeWrite(LIBRARY_KEY, JSON.stringify(lib));
}

/** Round-trips a document to a file, so work can leave the browser profile. */
export function toFile(doc: PartDoc): string {
  return JSON.stringify({ schema: SCHEMA, savedAtUtc: new Date().toISOString(), doc }, null, 2);
}

export function fromFile(json: string): RestoreResult {
  const env = safeParse<Envelope>(json);
  if (!env?.doc) return { doc: null, problem: 'That file is not a DATUM document.' };
  if (env.schema > SCHEMA) return { doc: null, problem: 'That file was written by a newer version.' };
  return { doc: migrate(env.doc, env.schema), savedAtUtc: env.savedAtUtc };
}

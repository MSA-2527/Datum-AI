import {
  deserialise, serialise, type Document, type EvaluatedDocument,
} from '../model/document';
import { bounds, triCount } from '../kernel/topo/mesh';

/**
 * The named part library.
 *
 * The modeller could already write a document to a file and read one back, which is enough
 * to not lose work and not enough to ever *find* anything. Reuse needs a set the application
 * can enumerate — you cannot be told "you already have this" about a file sitting in a
 * downloads folder — so this is that set.
 *
 * Deliberately separate from `persistence.ts`, which stores the legacy 2.5D `PartDoc` of the
 * Studio surface. The two document models are not interchangeable and merging their storage
 * would mean one schema version governing two unrelated shapes; the next migration would
 * then have to be correct for both at once.
 *
 * **What is stored beside the document, and why.** Every entry carries a `GeometrySnapshot`
 * measured at save time. Geometry here is derived — the feature tree is the document and the
 * mesh is a rebuild of it — so in principle the library could recompute size and mass on
 * demand. In practice a rebuild runs in a worker and takes tens of milliseconds per part, and
 * an index over fifty parts would then cost seconds and could not be built synchronously at
 * all. Saving is the one moment the geometry is already known, so it is the moment to
 * measure. The snapshot is *facts about what was saved*, nothing interpreted; anything
 * derived from it for matching lives in `reuse.ts`.
 */

const SCHEMA = 1;
const KEY = 'datum.model.library';

/** Measured facts about a document's geometry, captured when it was saved. */
export interface GeometrySnapshot {
  /** Bounding box, millimetres, in document axis order (X, Y, Z). */
  sizeMm: [number, number, number];
  volumeMm3: number;
  massG: number;
  triangles: number;
  /** False for a solid with open edges — its volume and mass cannot be trusted. */
  closed: boolean;
}

export interface LibraryEntry {
  name: string;
  savedAtUtc: string;
  doc: Document;
  snapshot: GeometrySnapshot;
}

/** What went wrong, in words a user can act on. Absent on success. */
export interface LibraryResult {
  ok: boolean;
  problem?: string;
}

interface Envelope {
  schema: number;
  savedAtUtc: string;
  snapshot: GeometrySnapshot;
  /**
   * The document in its serialised form, as an object rather than a string.
   *
   * Written through `serialise` and read through `deserialise` so the on-disk shape has
   * exactly one definition — including the rule that an imported mesh is dropped rather than
   * stored, which is easy to forget and expensive to get wrong.
   */
  doc: unknown;
}

type Store = Record<string, Envelope>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A corrupt library is not a reason to break the application. It reads as empty, and
    // the next save rewrites it.
    return {};
  }
}

function writeStore(store: Store): LibraryResult {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
    return { ok: true };
  } catch (e) {
    // Quota is the interesting case and it is worth naming: the user can act on "the
    // library is full" and cannot act on "save failed".
    const quota = e instanceof DOMException
      && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return {
      ok: false,
      problem: quota
        ? 'The part library is full. Delete a saved part to make room, or export it as a file first.'
        : 'This browser would not let DATUM write to local storage, so nothing was saved.',
    };
  }
}

/**
 * Measures a rebuilt document.
 *
 * An empty document is a legitimate thing to save — a parameter sheet with no geometry yet —
 * so it produces a zero snapshot rather than being refused. `bounds` on an empty mesh
 * returns an inverted box, which would otherwise read as an infinite part.
 */
export function snapshotOf(evaluated: EvaluatedDocument): GeometrySnapshot {
  if (triCount(evaluated.mesh) === 0) {
    return { sizeMm: [0, 0, 0], volumeMm3: 0, massG: 0, triangles: 0, closed: true };
  }

  const b = bounds(evaluated.mesh);
  return {
    sizeMm: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]],
    volumeMm3: evaluated.volume,
    massG: evaluated.massGrams,
    triangles: triCount(evaluated.mesh),
    closed: evaluated.health.closed,
  };
}

// ── reading ──────────────────────────────────────────────────────────────────

function entryFrom(name: string, env: Envelope): LibraryEntry | null {
  if (typeof env?.schema !== 'number' || env.schema > SCHEMA) return null;
  const doc = deserialise(JSON.stringify(env.doc));
  if (!doc) return null;
  if (!env.snapshot || !Array.isArray(env.snapshot.sizeMm)) return null;

  return { name, savedAtUtc: env.savedAtUtc, doc, snapshot: env.snapshot };
}

/**
 * Everything readable in the library, most recently saved first.
 *
 * Unreadable entries are skipped rather than reported. A single part written by a newer
 * build must not stop the other forty from being listed, and the place that tells a user why
 * a specific part will not open is `openFromLibrary`, which is asked about one part.
 */
export function listLibrary(): LibraryEntry[] {
  return Object.entries(readStore())
    .map(([name, env]) => entryFrom(name, env))
    .filter((e): e is LibraryEntry => e !== null)
    .sort((a, b) => b.savedAtUtc.localeCompare(a.savedAtUtc));
}

export function openFromLibrary(name: string): { doc: Document | null; problem?: string } {
  const env = readStore()[name];
  if (!env) return { doc: null, problem: `No saved part named "${name}".` };

  if (typeof env.schema === 'number' && env.schema > SCHEMA) {
    return {
      doc: null,
      problem:
        `"${name}" was saved by a newer version of DATUM (schema ${env.schema}). It was left ` +
        'untouched rather than opened against an older schema.',
    };
  }

  const entry = entryFrom(name, env);
  return entry
    ? { doc: entry.doc }
    : { doc: null, problem: `"${name}" is stored in a form this build cannot read.` };
}

// ── writing ──────────────────────────────────────────────────────────────────

/**
 * Saves under a name, replacing any part already using it.
 *
 * Overwriting is the caller's decision to confirm, not this module's to prevent — `hasName`
 * exists so the UI can ask first.
 */
export function saveToLibrary(
  name: string,
  doc: Document,
  snapshot: GeometrySnapshot,
): LibraryResult {
  const clean = name.trim();
  if (!clean) return { ok: false, problem: 'A saved part needs a name.' };

  const store = readStore();
  store[clean] = {
    schema: SCHEMA,
    savedAtUtc: new Date().toISOString(),
    snapshot,
    doc: JSON.parse(serialise({ ...doc, name: clean })) as unknown,
  };

  return writeStore(store);
}

export function hasName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(readStore(), name.trim());
}

export function removeFromLibrary(name: string): LibraryResult {
  const store = readStore();
  if (!(name in store)) return { ok: true };
  delete store[name];
  return writeStore(store);
}

/** Empties the library. Used by tests and by nothing in the product. */
export function clearLibrary(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do — the next write overwrites it anyway */
  }
}

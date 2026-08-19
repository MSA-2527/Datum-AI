import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLibrary, hasName, listLibrary, openFromLibrary, removeFromLibrary, saveToLibrary,
  snapshotOf,
} from './library';
import {
  addFeature, defaultParams, emptyDocument, evaluateDocument, type Document,
} from '../model/document';

/**
 * Part library tests.
 *
 * The library is the set the reuse gate searches, so two properties matter beyond ordinary
 * round-tripping. A saved part must come back as an editable feature tree rather than as
 * whatever the mesh happened to be — a reopened part you cannot edit has not been reused,
 * it has been copied. And a part this build cannot read must never take the rest of the
 * library down with it, because a library that fails to list is a library nobody trusts.
 */

function plate(name = 'Plate'): Document {
  return addFeature(emptyDocument(name), 'box', defaultParams('box'), 'Body');
}

const KEY = 'datum.model.library';

beforeEach(() => {
  clearLibrary();
});

describe('saving and reading back', () => {
  it('round-trips a document as a feature tree', () => {
    const doc = plate('Bracket');
    expect(saveToLibrary('Bracket', doc, snapshotOf(evaluateDocument(doc))).ok).toBe(true);

    const { doc: read } = openFromLibrary('Bracket');
    expect(read).not.toBeNull();
    expect(read!.features).toHaveLength(1);
    expect(read!.features[0]!.kind).toBe('box');
    expect(read!.features[0]!.params.length).toBe(60);
  });

  it('mints a fresh document id on open, so opening is arriving at a part', () => {
    const doc = plate();
    saveToLibrary('Plate', doc, snapshotOf(evaluateDocument(doc)));

    const { doc: read } = openFromLibrary('Plate');
    expect(read!.id).not.toBe(doc.id);
  });

  it('takes the name it was saved under', () => {
    const doc = plate('Untitled');
    saveToLibrary('Mounting plate', doc, snapshotOf(evaluateDocument(doc)));
    expect(openFromLibrary('Mounting plate').doc!.name).toBe('Mounting plate');
  });

  it('keeps an assembly\'s known mass rather than re-weighing it at one density', () => {
    // The failure this pins: `deserialise` used to drop `knownMassGrams`, so a reopened
    // phone was weighed as if it were solid aluminium.
    const doc: Document = { ...plate('Phone'), knownMassGrams: 187 };
    saveToLibrary('Phone', doc, snapshotOf(evaluateDocument(doc)));
    expect(openFromLibrary('Phone').doc!.knownMassGrams).toBe(187);
  });

  it('refuses an empty name rather than saving under one', () => {
    const doc = plate();
    expect(saveToLibrary('   ', doc, snapshotOf(evaluateDocument(doc))).ok).toBe(false);
    expect(listLibrary()).toHaveLength(0);
  });

  it('trims the name, so "Plate " and "Plate" are one part', () => {
    const doc = plate();
    saveToLibrary('Plate ', doc, snapshotOf(evaluateDocument(doc)));
    saveToLibrary(' Plate', doc, snapshotOf(evaluateDocument(doc)));
    expect(listLibrary()).toHaveLength(1);
    expect(hasName('Plate')).toBe(true);
  });
});

describe('the snapshot', () => {
  it('measures the evaluated solid', () => {
    const doc = plate();
    const snap = snapshotOf(evaluateDocument(doc));

    // The default box is 60 × 40 × 25.
    expect(snap.sizeMm[0]).toBeCloseTo(60, 3);
    expect(snap.sizeMm[1]).toBeCloseTo(40, 3);
    expect(snap.sizeMm[2]).toBeCloseTo(25, 3);
    // Exactly the prism. The default box no longer carries an edge break: it turned six
    // pickable faces into thirty-four and left Fillet and Chamfer nothing long enough to
    // work on. Rounding is a feature you add now, so an unmodified box measures what it says.
    expect(snap.volumeMm3).toBeCloseTo(60 * 40 * 25, 6);
    expect(snap.massG).toBeGreaterThan(0);
    expect(snap.closed).toBe(true);
  });

  it('reports zero for a document with no geometry, not an infinite box', () => {
    const snap = snapshotOf(evaluateDocument(emptyDocument()));
    expect(snap.sizeMm).toEqual([0, 0, 0]);
    expect(snap.triangles).toBe(0);
    expect(Number.isFinite(snap.volumeMm3)).toBe(true);
  });
});

describe('listing', () => {
  it('orders most recently saved first', () => {
    const doc = plate();
    const snap = snapshotOf(evaluateDocument(doc));

    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    saveToLibrary('Older', doc, snap);
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    saveToLibrary('Newer', doc, snap);
    vi.useRealTimers();

    expect(listLibrary().map((e) => e.name)).toEqual(['Newer', 'Older']);
  });

  it('skips an entry written by a newer build without hiding the others', () => {
    const doc = plate();
    saveToLibrary('Readable', doc, snapshotOf(evaluateDocument(doc)));

    const store = JSON.parse(localStorage.getItem(KEY)!) as Record<string, unknown>;
    store['FromTheFuture'] = { schema: 99, savedAtUtc: new Date().toISOString(), snapshot: {}, doc: {} };
    localStorage.setItem(KEY, JSON.stringify(store));

    expect(listLibrary().map((e) => e.name)).toEqual(['Readable']);
  });

  it('reads as empty when storage holds something that is not a library', () => {
    localStorage.setItem(KEY, 'not json at all');
    expect(listLibrary()).toEqual([]);
  });
});

describe('opening what cannot be opened', () => {
  it('names the part that does not exist', () => {
    expect(openFromLibrary('Nothing').problem).toContain('Nothing');
  });

  it('says a newer schema was left untouched rather than coercing it', () => {
    localStorage.setItem(KEY, JSON.stringify({
      Future: { schema: 99, savedAtUtc: new Date().toISOString(), snapshot: {}, doc: {} },
    }));

    const { doc, problem } = openFromLibrary('Future');
    expect(doc).toBeNull();
    expect(problem).toMatch(/newer version/i);
  });
});

describe('deleting', () => {
  it('removes the part and leaves the rest', () => {
    const doc = plate();
    const snap = snapshotOf(evaluateDocument(doc));
    saveToLibrary('A', doc, snap);
    saveToLibrary('B', doc, snap);

    expect(removeFromLibrary('A').ok).toBe(true);
    expect(listLibrary().map((e) => e.name)).toEqual(['B']);
  });

  it('deleting something absent is not an error', () => {
    expect(removeFromLibrary('Never existed').ok).toBe(true);
  });
});

describe('when storage refuses', () => {
  it('reports a full library in words the user can act on', () => {
    const quota = new DOMException('exceeded', 'QuotaExceededError');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw quota; });

    const doc = plate();
    const result = saveToLibrary('Plate', doc, snapshotOf(evaluateDocument(doc)));

    spy.mockRestore();
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/full/i);
  });
});

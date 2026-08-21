import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildIndex,
  fingerprintOf,
  findDuplicates,
  geometryScore,
  search,
  textScore,
  type IndexEntry,
} from './workspaceIndex';
import { saveToLibrary, type GeometrySnapshot } from './library';
import {
  addFeature, emptyDocument, evaluateDocument, type Document,
} from '../model/document';
import { bounds, triCount } from '../kernel/topo/mesh';

/**
 * Workspace index tests.
 *
 * The index only earns its place if it finds the part someone was about to redraw. The
 * assertions that matter are that a genuine near-duplicate ranks first, and that an unrelated
 * part does NOT — a false positive trains people to ignore the panel, which is worse than
 * having no index.
 *
 * Everything here is built from real documents evaluated by the kernel, because the
 * fingerprint is measured off saved geometry rather than declared: a test that hand-wrote the
 * numbers would pass whatever the measurement did.
 */

/** A plate, optionally with a bolt circle of holes. */
function plate(
  name: string,
  { L = 100, W = 60, T = 8, holes = 0, holeDia = 5, boltCircle = 40 } = {},
): Document {
  let doc = addFeature(emptyDocument(name), 'box', { length: L, width: W, height: T }, 'Body');
  if (holes > 0) {
    doc = addFeature(doc, 'hole', {
      diameter: holeDia, holeType: 'through', pattern: 'boltCircle',
      count: holes, boltCircle, cx: 0, cy: 0,
    }, 'Bolt holes');
  }
  return doc;
}

/** The snapshot the library would have recorded when this document was saved. */
function snapshotOf(doc: Document): GeometrySnapshot {
  const ev = evaluateDocument(doc);
  const box = bounds(ev.mesh);
  return {
    sizeMm: [
      box.max[0]! - box.min[0]!,
      box.max[1]! - box.min[1]!,
      box.max[2]! - box.min[2]!,
    ],
    volumeMm3: ev.volume,
    massG: ev.massGrams,
    triangles: triCount(ev.mesh),
    closed: ev.health.closed,
  };
}

const print = (doc: Document) => fingerprintOf(doc, snapshotOf(doc));

function entry(name: string, doc: Document, description = name): IndexEntry {
  return {
    name,
    title: doc.name,
    savedAtUtc: new Date().toISOString(),
    material: doc.material,
    properties: { Description: description, Material: doc.material },
    fingerprint: print(doc),
    haystack: [name, doc.name, doc.material, description].join(' ').toLowerCase(),
  };
}

describe('fingerprint', () => {
  it('captures envelope, holes and fill', () => {
    const f = print(plate('a', { holes: 4 }));

    expect(f.L).toBeCloseTo(100, 3);
    expect(f.W).toBeCloseTo(60, 3);
    expect(f.T).toBeCloseTo(8, 3);
    expect(f.holeCount).toBe(4);
    expect(f.holeSizes).toEqual([5]);
    expect(f.fill).toBeGreaterThan(0.9);   // four small holes barely dent a 100 × 60 plate
    expect(f.fill).toBeLessThanOrEqual(1);
  });

  it('collapses duplicate hole diameters', () => {
    let doc = plate('a', { holes: 4, holeDia: 5, boltCircle: 40 });
    doc = addFeature(doc, 'hole', {
      diameter: 5, holeType: 'through', pattern: 'boltCircle',
      count: 4, boltCircle: 70, cx: 0, cy: 0,
    }, 'More holes');

    const f = print(doc);
    expect(f.holeSizes).toEqual([5]);
    expect(f.holeCount).toBe(8);
  });

  it('weighs the part at the mass that was saved, not volume times a density', () => {
    // An assembly has several densities, so the snapshot's mass is the only trustworthy one.
    const doc = plate('a');
    const snap = { ...snapshotOf(doc), massG: 1234 };
    expect(fingerprintOf(doc, snap).massG).toBe(1234);
  });
});

describe('text scoring', () => {
  const e = entry('motor-bracket', plate('motor-bracket'), 'Motor mounting bracket');

  it('scores a full phrase above scattered tokens', () => {
    expect(textScore(e, 'motor mounting bracket')).toBeGreaterThan(textScore(e, 'motor plate'));
  });

  it('matches on the description', () => {
    expect(textScore(e, 'bracket')).toBeGreaterThan(0);
  });

  it('returns zero for an empty query', () => {
    expect(textScore(e, '   ')).toBe(0);
  });
});

describe('geometry scoring', () => {
  it('scores an identical part at 1', () => {
    const f = print(plate('a', { holes: 4 }));
    expect(geometryScore(f, f)).toBeCloseTo(1, 6);
  });

  it('rates a scaled version of the same shape highly', () => {
    // Same 5:3 aspect, same hole count and size — interchangeable design, different size.
    const base = print(plate('a', { holes: 4, boltCircle: 40 }));
    const bigger = print(plate('b', { L: 150, W: 90, holes: 4, boltCircle: 60 }));

    expect(geometryScore(base, bigger)).toBeGreaterThan(0.75);
  });

  it('rates a genuinely different part low', () => {
    const flat = print(plate('a', { holes: 4 }));
    const bar = print(plate('b', { L: 400, W: 20, T: 40 }));

    expect(geometryScore(flat, bar)).toBeLessThan(0.6);
  });

  it('is symmetric', () => {
    const a = print(plate('a', { holes: 4 }));
    const b = print(plate('b', { L: 130 }));
    expect(geometryScore(a, b)).toBeCloseTo(geometryScore(b, a), 6);
  });
});

describe('search', () => {
  const index: IndexEntry[] = [
    entry('motor-bracket', plate('motor-bracket', { holes: 4, boltCircle: 40 }), 'Motor mounting bracket'),
    entry('cover-plate', plate('cover-plate', { holes: 4, boltCircle: 40 }), 'Blank cover plate'),
    entry('long-rail', plate('long-rail', { L: 600, W: 25 }), 'Extruded rail'),
  ];

  it('finds by text', () => {
    const hits = search(index, { query: 'motor mounting' });
    expect(hits[0]!.entry.name).toBe('motor-bracket');
  });

  it('finds by geometry with no query at all', () => {
    const hits = search(index, { like: print(plate('new', { holes: 4, boltCircle: 40 })) });

    // The rail is a completely different shape and must not lead.
    expect(hits[0]!.entry.name).not.toBe('long-rail');
    expect(hits[0]!.geometryScore).toBeGreaterThan(0.8);
  });

  it('excludes the document being searched from its own results', () => {
    const hits = search(index, { query: 'plate', excludeName: 'cover-plate' });
    expect(hits.every((h) => h.entry.name !== 'cover-plate')).toBe(true);
  });

  it('respects the limit', () => {
    expect(search(index, { query: 'plate bracket rail', limit: 2 })).toHaveLength(2);
  });

  it('returns an empty list rather than throwing on an empty index', () => {
    expect(search([], { query: 'anything' })).toEqual([]);
  });

  it('explains why each result matched', () => {
    const hits = search(index, { query: 'motor' });
    expect(hits[0]!.reason).toBeTruthy();
    expect(hits[0]!.reason).toMatch(/mm/);   // always states the envelope
  });
});

describe('duplicate interception', () => {
  it('flags a near-identical part before it gets redrawn', () => {
    const index = [entry('motor-bracket', plate('motor-bracket', { holes: 4, boltCircle: 40 }))];

    // Same design, being drawn again from scratch.
    const redraw = print(plate('untitled', { holes: 4, boltCircle: 40 }));

    const dupes = findDuplicates(index, redraw, 'untitled');
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.entry.name).toBe('motor-bracket');
  });

  it('stays quiet for an unrelated part', () => {
    const index = [entry('motor-bracket', plate('motor-bracket', { holes: 4 }))];
    const shaft = print(plate('shaft', { L: 500, W: 20, T: 20 }));

    // A false positive here trains people to ignore the panel entirely.
    expect(findDuplicates(index, shaft, 'shaft')).toHaveLength(0);
  });
});

describe('index construction', () => {
  beforeEach(() => localStorage.clear());

  /*
   * The regression this closes: the index read `persistence`, the store the 2.5D UI wrote
   * into, which nothing writes to any more. So it reported an empty index however many parts
   * the user had saved, and the duplicate interception above could never fire in the product.
   */
  it('builds from the part library — the one the Library dialogue writes to', () => {
    const a = plate('bracket-a', { holes: 4 });
    const b = plate('bracket-b');
    saveToLibrary('bracket-a', a, snapshotOf(a));
    saveToLibrary('bracket-b', b, snapshotOf(b));

    const index = buildIndex();

    expect(index).toHaveLength(2);
    expect(index.map((e) => e.name).sort()).toEqual(['bracket-a', 'bracket-b']);
    expect(index.find((e) => e.name === 'bracket-a')!.fingerprint.holeCount).toBe(4);
    expect(index.find((e) => e.name === 'bracket-b')!.fingerprint.holeCount).toBe(0);
  });

  it('is empty when nothing has been saved, rather than inventing entries', () => {
    expect(buildIndex()).toEqual([]);
  });
});

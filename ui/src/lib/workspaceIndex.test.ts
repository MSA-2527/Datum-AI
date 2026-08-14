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
import { createFeature, setGlobal, type PartDoc } from './partModel';
import { saveAs } from './persistence';

/**
 * Workspace index tests.
 *
 * The index only earns its place if it finds the part someone was about to redraw. The
 * assertions that matter are that a genuine near-duplicate ranks first, and that an
 * unrelated part does NOT — a false positive trains people to ignore the panel, which is
 * worse than having no index.
 */

function part(name: string, overrides: Partial<PartDoc> = {}): PartDoc {
  return {
    path: `C:\\t\\${name}.SLDPRT`,
    title: `${name}.SLDPRT`,
    configuration: 'Default',
    configurations: ['Default'],
    units: 'mm',
    material: '6061-T6',
    density: 2.7,
    writable: true,
    lastRebuildMs: 100,
    globals: [
      { name: 'Length', value: 100, units: 'mm' },
      { name: 'Width', value: 60, units: 'mm' },
      { name: 'Thickness', value: 8, units: 'mm' },
      { name: 'BoltCircle', value: 40, units: 'mm' },
    ],
    properties: { PartNo: 'P-1', Description: 'plate' },
    features: [],
    ...overrides,
  };
}

function entry(name: string, doc: PartDoc): IndexEntry {
  return {
    name,
    title: doc.title,
    savedAtUtc: new Date().toISOString(),
    material: doc.material,
    properties: doc.properties,
    fingerprint: fingerprintOf(doc),
    haystack: [name, doc.title, doc.material, ...Object.values(doc.properties)].join(' ').toLowerCase(),
  };
}

describe('fingerprint', () => {
  it('captures envelope, holes and fill', () => {
    const d = createFeature(part('a'), 'holePattern', { diameter: 5, boltCircleVar: 'BoltCircle' });
    const f = fingerprintOf(d);

    expect(f.L).toBe(100);
    expect(f.W).toBe(60);
    expect(f.holeCount).toBe(4);
    expect(f.holeSizes).toEqual([5]);
    expect(f.fill).toBeGreaterThan(0.9); // four small holes barely dent a 100×60 plate
    expect(f.fill).toBeLessThanOrEqual(1);
  });

  it('collapses duplicate hole diameters', () => {
    let d = createFeature(part('a'), 'holePattern', { diameter: 5, boltCircle: 40 });
    d = createFeature(d, 'holePattern', { diameter: 5, boltCircle: 70 });
    expect(fingerprintOf(d).holeSizes).toEqual([5]);
  });
});

describe('text scoring', () => {
  const e = entry('motor-bracket', part('motor-bracket', {
    properties: { PartNo: 'BRK-0142', Description: 'Motor mounting bracket' },
  }));

  it('scores a full phrase above scattered tokens', () => {
    expect(textScore(e, 'motor mounting bracket')).toBeGreaterThan(textScore(e, 'motor plate'));
  });

  it('matches on part number', () => {
    expect(textScore(e, 'BRK-0142')).toBeGreaterThan(0);
  });

  it('returns zero for an empty query', () => {
    expect(textScore(e, '   ')).toBe(0);
  });
});

describe('geometry scoring', () => {
  it('scores an identical part at 1', () => {
    const f = fingerprintOf(createFeature(part('a'), 'holePattern', { diameter: 5 }));
    expect(geometryScore(f, f)).toBeCloseTo(1, 6);
  });

  it('rates a scaled version of the same shape highly', () => {
    const base = createFeature(part('a'), 'holePattern', { diameter: 5, boltCircle: 40 });
    let bigger = createFeature(part('b'), 'holePattern', { diameter: 5, boltCircle: 60 });
    bigger = setGlobal(bigger, 'Length', 150);
    bigger = setGlobal(bigger, 'Width', 90);

    // Same 5:3 aspect, same hole count and size — interchangeable design, different size.
    expect(geometryScore(fingerprintOf(base), fingerprintOf(bigger))).toBeGreaterThan(0.75);
  });

  it('rates a genuinely different part low', () => {
    const plate = createFeature(part('a'), 'holePattern', { diameter: 5, boltCircle: 40 });

    let bar = part('b');
    bar = setGlobal(bar, 'Length', 400);
    bar = setGlobal(bar, 'Width', 20);
    bar = setGlobal(bar, 'Thickness', 40);

    expect(geometryScore(fingerprintOf(plate), fingerprintOf(bar))).toBeLessThan(0.6);
  });

  it('is symmetric', () => {
    const a = fingerprintOf(createFeature(part('a'), 'holePattern', { diameter: 5 }));
    const b = fingerprintOf(setGlobal(part('b'), 'Length', 130));
    expect(geometryScore(a, b)).toBeCloseTo(geometryScore(b, a), 6);
  });
});

describe('search', () => {
  const index: IndexEntry[] = [
    entry('motor-bracket', createFeature(part('motor-bracket', {
      properties: { PartNo: 'BRK-0142', Description: 'Motor mounting bracket' },
    }), 'holePattern', { diameter: 5, boltCircle: 40 })),

    entry('cover-plate', createFeature(part('cover-plate', {
      properties: { PartNo: 'PLT-0088', Description: 'Blank cover plate' },
    }), 'holePattern', { diameter: 5, boltCircle: 40 })),

    entry('long-rail', setGlobal(setGlobal(part('long-rail', {
      properties: { PartNo: 'RL-0001', Description: 'Extruded rail' },
    }), 'Length', 600), 'Width', 25)),
  ];

  it('finds by text', () => {
    const hits = search(index, { query: 'motor mounting' });
    expect(hits[0]!.entry.name).toBe('motor-bracket');
  });

  it('finds by geometry with no query at all', () => {
    const like = createFeature(part('new'), 'holePattern', { diameter: 5, boltCircle: 40 });
    const hits = search(index, { like });

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
    expect(hits[0]!.reason).toMatch(/mm/); // always states the envelope
  });
});

describe('duplicate interception', () => {
  it('flags a near-identical part before it gets redrawn', () => {
    const existing = createFeature(part('motor-bracket'), 'holePattern', { diameter: 5, boltCircle: 40 });
    const index = [entry('motor-bracket', existing)];

    // Same design, being drawn again from scratch.
    const redraw = createFeature(part('untitled'), 'holePattern', { diameter: 5, boltCircle: 40 });

    const dupes = findDuplicates(index, redraw);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]!.entry.name).toBe('motor-bracket');
  });

  it('stays quiet for an unrelated part', () => {
    const index = [entry('motor-bracket', createFeature(part('motor-bracket'), 'holePattern', { diameter: 5 }))];

    let different = part('shaft');
    different = setGlobal(different, 'Length', 500);
    different = setGlobal(different, 'Width', 20);
    different = setGlobal(different, 'Thickness', 20);

    // A false positive here trains people to ignore the panel entirely.
    expect(findDuplicates(index, different)).toHaveLength(0);
  });
});

describe('index construction', () => {
  beforeEach(() => localStorage.clear());

  it('builds from the saved library', () => {
    saveAs('bracket-a', createFeature(part('bracket-a'), 'holePattern', { diameter: 5 }));
    saveAs('bracket-b', part('bracket-b'));

    const index = buildIndex();
    expect(index).toHaveLength(2);
    expect(index.map((e) => e.name).sort()).toEqual(['bracket-a', 'bracket-b']);
    expect(index.find((e) => e.name === 'bracket-a')!.fingerprint.holeCount).toBe(4);
  });

  it('returns an empty index when nothing is saved', () => {
    expect(buildIndex()).toEqual([]);
  });
});

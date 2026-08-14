import { describe, expect, it } from 'vitest';
import { FACTS, densityOf, sources, type Fact } from './standards';
import { expandQuery, referenceBlock, renderFact, retrieve } from './retrieve';
import { auditPlan, corpusSummary, summariseAudit } from './audit';
import { IDENTITY_PLACEMENT, type AssemblyPlan, type ComponentSpec } from '../assembly/plan';
import { RECIPES } from '../assembly/recipes';

/**
 * The reference corpus, its retrieval, and the audit that reads a plan back against it.
 *
 * These tests are unusual in that a fair number of them assert *specific published numbers*.
 * That is deliberate. The value of this corpus is entirely in whether the figures are right —
 * a retrieval system that returns the wrong dimension confidently is worse than none, because
 * it launders a guess into something that looks sourced. So the numbers a reader is most
 * likely to check by hand are checked here.
 */

describe('the corpus holds well-formed entries', () => {
  it('gives every entry an id, a subject and a source', () => {
    for (const f of FACTS) {
      expect(f.id, f.subject).toBeTruthy();
      expect(f.subject, f.id).toBeTruthy();
      expect(f.source, f.id).toBeTruthy();
      expect(f.keywords.length, f.id).toBeGreaterThan(0);
      expect(Object.keys(f.dims).length, f.id).toBeGreaterThan(0);
    }
  });

  it('has no duplicate ids', () => {
    const ids = FACTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('holds only finite, positive dimensions', () => {
    for (const f of FACTS) {
      for (const [key, value] of Object.entries(f.dims)) {
        expect(Number.isFinite(value), `${f.id}.${key}`).toBe(true);
        expect(value, `${f.id}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps keywords lower case, so matching is not case-dependent', () => {
    for (const f of FACTS) {
      for (const k of f.keywords) expect(k, `${f.id}: ${k}`).toBe(k.toLowerCase());
    }
  });

  it('names real standards', () => {
    const all = sources().join(' ');
    expect(all).toMatch(/ISO 4762/);
    expect(all).toMatch(/ISO 15/);
    expect(all).toMatch(/IEC 60086/);
  });
});

/** Pulls one entry out by id, failing loudly rather than returning undefined. */
function fact(id: string): Fact {
  const f = FACTS.find((x) => x.id === id);
  if (!f) throw new Error(`no such fact: ${id}`);
  return f;
}

describe('the published figures are the published figures', () => {
  it('M6 socket head cap screw, ISO 4762', () => {
    const f = fact('shcs-m6');
    expect(f.dims.headDiameter).toBe(10);
    expect(f.dims.headHeight).toBe(6);   // head height equals nominal diameter for this family
    expect(f.dims.hexSocket).toBe(5);
  });

  it('M6 clearance and tapping holes', () => {
    const f = fact('thread-m6');
    expect(f.dims.pitch).toBe(1.0);
    expect(f.dims.clearanceHole).toBe(6.6);  // larger than the screw
    expect(f.dims.tappingDrill).toBe(5.0);   // smaller than the screw
    expect(f.dims.clearanceHole).toBeGreaterThan(f.dims.nominalDiameter);
    expect(f.dims.tappingDrill).toBeLessThan(f.dims.nominalDiameter);
  });

  it('every thread has a clearance hole above and a tapping drill below nominal', () => {
    // The single most common dimensioning error in a generated part is a hole the screw
    // cannot pass through, so it is worth asserting across the whole table rather than once.
    for (const f of FACTS.filter((x) => x.id.startsWith('thread-'))) {
      expect(f.dims.clearanceHole, f.id).toBeGreaterThan(f.dims.nominalDiameter);
      expect(f.dims.tappingDrill, f.id).toBeLessThan(f.dims.nominalDiameter);
      // A tapping drill is nominal minus the pitch, near enough, for a 100% thread.
      expect(f.dims.tappingDrill, f.id)
        .toBeCloseTo(f.dims.nominalDiameter - f.dims.pitch, 0);
    }
  });

  it('608 bearing, ISO 15', () => {
    const f = fact('bearing-608');
    expect([f.dims.bore, f.dims.outsideDiameter, f.dims.width]).toEqual([8, 22, 7]);
  });

  it('6203 bearing, ISO 15', () => {
    const f = fact('bearing-6203');
    expect([f.dims.bore, f.dims.outsideDiameter, f.dims.width]).toEqual([17, 40, 12]);
  });

  it('every bearing has a bore smaller than its outside diameter', () => {
    for (const f of FACTS.filter((x) => x.category === 'bearing')) {
      expect(f.dims.bore, f.id).toBeLessThan(f.dims.outsideDiameter);
    }
  });

  it('AA cell, IEC 60086 R6', () => {
    const f = fact('cell-aa');
    expect(f.dims.diameter).toBe(14.5);
    expect(f.dims.height).toBe(50.5);
  });

  it('CR2032, whose name encodes its size', () => {
    const f = fact('cell-cr2032');
    expect(f.dims.diameter).toBe(20.0);
    expect(f.dims.height).toBe(3.2);
  });

  it('18650, likewise', () => {
    const f = fact('cell-18650');
    expect(f.dims.diameter).toBeCloseTo(18.4, 1);
    expect(f.dims.height).toBe(65.0);
  });

  it('a credit card, ISO/IEC 7810 ID-1', () => {
    const f = fact('card-id1');
    expect(f.dims.length).toBe(85.60);
    expect(f.dims.width).toBe(53.98);
  });

  it('A4, ISO 216 — and its aspect ratio is root two', () => {
    const f = fact('paper-a4');
    expect([f.dims.length, f.dims.width]).toEqual([297, 210]);
    expect(f.dims.length / f.dims.width).toBeCloseTo(Math.SQRT2, 2);
  });

  it('a 19-inch rack unit is 1.75 inches', () => {
    const f = fact('rack-19');
    expect(f.dims.unitHeight).toBeCloseTo(1.75 * 25.4, 2);
    expect(f.dims.panelWidth).toBeCloseTo(19 * 25.4, 1);
  });

  it('NEMA 17 is 42.3 mm, not the 43.2 mm its name suggests', () => {
    // The NEMA number is the frame size in tenths of an inch *nominally*. The actual
    // standard frame is 42.3 mm, and a mount cut at 1.7 × 25.4 = 43.18 is nearly a
    // millimetre oversize. This is exactly the kind of figure a model recalls by doing the
    // arithmetic instead of reading the standard.
    const f = fact('nema17');
    expect(f.dims.frame).toBe(42.3);
    expect(f.dims.mountingPitch).toBe(31.0);
    expect(f.dims.shaftDiameter).toBe(5);
  });

  it('a hex nut is wider across corners than across flats', () => {
    const f = fact('hexnut-m6');
    expect(f.dims.acrossFlats).toBe(10);
    expect(f.dims.acrossCorners).toBeGreaterThan(f.dims.acrossFlats);
    expect(f.dims.acrossCorners).toBeCloseTo(10 / Math.cos(Math.PI / 6), 1);
  });
});

describe('material densities', () => {
  it('knows aluminium from steel, which is a threefold error in mass', () => {
    expect(densityOf('Aluminium 6061-T6')).toBeCloseTo(2.70, 2);
    expect(densityOf('Steel 1018')).toBeCloseTo(7.87, 2);
  });

  it('prefers the most specific match', () => {
    // "stainless steel 316" contains "steel"; the longer keyword has to win or every
    // stainless part is costed as mild steel.
    expect(densityOf('Stainless steel 316')).toBeCloseTo(8.00, 2);
    expect(densityOf('316 stainless')).toBeCloseTo(8.00, 2);
  });

  it('is case-insensitive', () => {
    expect(densityOf('ALUMINIUM')).toBeCloseTo(2.70, 2);
    expect(densityOf('titanium')).toBeCloseTo(4.43, 2);
  });

  it('returns nothing for a material it does not hold, rather than a guess', () => {
    expect(densityOf('unobtainium')).toBeUndefined();
    expect(densityOf('')).toBeUndefined();
  });

  it('refuses to resolve a composite, leaving the given figure alone', () => {
    // A motor rotor described as "laminated steel and copper" has a density that is neither
    // steel's nor copper's. Picking the longest keyword gives copper and overwrites a
    // considered stack average with a wrong number — an audit actively making the model
    // worse, which is the one thing it must never do.
    expect(densityOf('Laminated steel and copper')).toBeUndefined();
    expect(densityOf('Glass fibre / epoxy')).toBeUndefined();
    expect(densityOf('ABS with steel insert')).toBeUndefined();
  });

  it('still resolves a single material whose name contains several words', () => {
    // The mirror of the case above: these are one material each, and must not be mistaken
    // for mixtures just because more than one entry matches on a shared word.
    expect(densityOf('Aluminium 6061-T6')).toBeCloseTo(2.70, 2);
    expect(densityOf('Stainless steel 316')).toBeCloseTo(8.00, 2);
  });
});

describe('every built-in recipe agrees with the corpus', () => {
  // The recipes are hand-written from real hardware and the corpus is published data, so
  // these two should never disagree. When they do, one of them has drifted — and this is the
  // only place that would notice.
  it.each(RECIPES.map((r) => r.id))('%s', (id) => {
    const recipe = RECIPES.find((r) => r.id === id)!;
    const { findings } = auditPlan(recipe.build(1));
    expect(findings.map((f) => `${f.component}: ${f.message}`)).toEqual([]);
  });
});

describe('retrieval', () => {
  it('finds the bearing when a designation is named', () => {
    const top = retrieve('I need a 608 bearing for this wheel')[0];
    expect(top.fact.id).toBe('bearing-608');
  });

  it('does not match a designation inside a longer number', () => {
    // "1608" is a different part. Substring matching would return the 608 entry and be
    // confidently wrong, which is worse than returning nothing.
    const ids = retrieve('part number 1608 housing').map((m) => m.fact.id);
    expect(ids).not.toContain('bearing-608');
  });

  it('finds the right thread size, not a neighbouring one', () => {
    const ids = retrieve('fix it with an M4 screw').map((m) => m.fact.id);
    expect(ids).toContain('shcs-m4');
    expect(ids).not.toContain('shcs-m40');
  });

  it('distinguishes M3 from M30-style tokens sharing a prefix', () => {
    const ids = retrieve('M3 cap screw').map((m) => m.fact.id);
    expect(ids).toContain('shcs-m3');
    expect(ids.filter((id) => id === 'shcs-m2.5')).toHaveLength(0);
  });

  it('returns nothing for a request with no engineering content', () => {
    expect(retrieve('hello there')).toHaveLength(0);
  });

  it('honours the limit', () => {
    expect(retrieve('screw bolt nut bearing battery material', 5).length).toBeLessThanOrEqual(5);
  });

  it('leads with the strongest match', () => {
    const matches = retrieve('an 18650 lithium cell');
    expect(matches[0].fact.id).toBe('cell-18650');
    expect(matches[0].score).toBeGreaterThanOrEqual(
      Math.max(...matches.map((m) => m.score)),
    );
  });

  it('orders within a category by score, even though categories interleave', () => {
    // Results round-robin across categories so one flood of fasteners cannot crowd out the
    // battery a request also needs. That means the *list* is not monotonically descending —
    // but each category's own entries still are, which is the property worth holding.
    const matches = retrieve('screw bolt nut bearing battery aluminium', 30);
    const byCategory = new Map<string, number[]>();
    for (const m of matches) {
      const scores = byCategory.get(m.fact.category) ?? [];
      scores.push(m.score);
      byCategory.set(m.fact.category, scores);
    }

    for (const [category, scores] of byCategory) {
      const sorted = [...scores].sort((a, b) => b - a);
      expect(scores, category).toEqual(sorted);
    }
  });

  it('gives every relevant category a place before doubling up on any one', () => {
    const matches = retrieve('a bearing, an M6 bolt and an 18650 cell', 6);
    const categories = new Set(matches.map((m) => m.fact.category));
    expect(categories.size).toBeGreaterThanOrEqual(3);
  });
});

describe('expanding a request into what it implies', () => {
  it('knows a skateboard has 608 bearings without being told', () => {
    const expanded = expandQuery('build me a skateboard');
    expect(expanded).toMatch(/608/);
    const ids = retrieve(expanded).map((m) => m.fact.id);
    expect(ids).toContain('bearing-608');
  });

  it('knows a 3D printer has NEMA 17 motors', () => {
    const ids = retrieve(expandQuery('design a 3d printer')).map((m) => m.fact.id);
    expect(ids).toContain('nema17');
  });

  it('knows a phone has a USB-C port and a circuit board', () => {
    const ids = retrieve(expandQuery('make a phone')).map((m) => m.fact.id);
    expect(ids).toContain('usb-c');
    expect(ids).toContain('pcb-thickness');
  });

  it('folds in component names when a plan already exists', () => {
    const ids = retrieve(expandQuery('a gadget', ['CR2032 coin cell'])).map((m) => m.fact.id);
    expect(ids).toContain('cell-cr2032');
  });
});

describe('the prompt block', () => {
  it('renders a fact as one readable line carrying its source', () => {
    const line = renderFact(fact('bearing-608'));
    expect(line).toContain('608 deep groove ball bearing');
    expect(line).toContain('bore=8');
    expect(line).toContain('ISO 15');
  });

  it('is empty when nothing matched, so the section drops out of the prompt', () => {
    expect(referenceBlock('hello there')).toBe('');
  });

  it('tells the model the figures are authoritative', () => {
    const block = referenceBlock('an M6 bolt');
    expect(block).toMatch(/published standards/i);
    expect(block).toContain('M6');
  });
});

// ── audit ────────────────────────────────────────────────────────────────────

function component(over: Partial<ComponentSpec>): ComponentSpec {
  return {
    id: 'c1', name: 'Part', role: 'a part', shape: 'box',
    params: {}, placement: IDENTITY_PLACEMENT,
    material: 'Aluminium 6061-T6', density: 2.7, quantity: 1,
    ...over,
  };
}

function plan(components: ComponentSpec[]): AssemblyPlan {
  return {
    name: 'Test', description: 'test',
    envelope: { length: 100, width: 100, height: 100 },
    components, notes: [], source: 'model',
  };
}

describe('auditing a plan against the corpus', () => {
  it('corrects a density that disagrees with its named material', () => {
    const { plan: out, findings } = auditPlan(plan([
      component({ name: 'Bracket', material: 'Aluminium 6061-T6', density: 7.85 }),
    ]));

    expect(out.components[0].density).toBeCloseTo(2.70, 2);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('corrected');
    expect(findings[0].message).toMatch(/191%|190%/);
  });

  it('leaves a correct density alone and says nothing', () => {
    const { findings } = auditPlan(plan([
      component({ material: 'Aluminium 6061-T6', density: 2.7 }),
    ]));
    expect(findings).toHaveLength(0);
  });

  it('says nothing about a material it does not hold', () => {
    // Silence is right here. Flagging every unfamiliar material would train the reader to
    // ignore the findings, which costs more than the missed check.
    const { findings } = auditPlan(plan([
      component({ material: 'Inconel 718', density: 8.19 }),
    ]));
    expect(findings).toHaveLength(0);
  });

  it('flags a dimension that disagrees with the standard the name invokes', () => {
    const { findings } = auditPlan(plan([
      component({
        name: '18650 lithium cell', role: 'power', shape: 'cylinder',
        params: { diameter: 18.4, height: 45 },  // a real 18650 is 65 mm
        material: 'ABS', density: 1.05,
      }),
    ]));

    const dim = findings.find((f) => f.severity === 'check');
    expect(dim).toBeDefined();
    expect(dim!.message).toMatch(/65/);
    expect(dim!.source).toMatch(/IEC/);
  });

  it('does not change a flagged dimension, because it might be a variant', () => {
    const wrong = plan([
      component({
        name: '18650 lithium cell', role: 'power', shape: 'cylinder',
        params: { diameter: 18.4, height: 45 },
        material: 'ABS', density: 1.05,
      }),
    ]);
    const { plan: out } = auditPlan(wrong);
    expect(out.components[0].params.height).toBe(45);
  });

  it('accepts a dimension within manufacturing tolerance', () => {
    const { findings } = auditPlan(plan([
      component({
        name: 'AA cell', role: 'power', shape: 'cylinder',
        params: { diameter: 14.5, height: 50.5 },
        material: 'Steel 1018', density: 7.87,
      }),
    ]));
    expect(findings.filter((f) => f.severity === 'check')).toHaveLength(0);
  });

  it('does not compare a part envelope against a mating interface', () => {
    // A phone's USB-C port is the receptacle body, roughly 9 x 3.2 x 3.2 mm. The corpus
    // records the *plug*, 8.34 x 2.56. Comparing them flagged three errors on a recipe whose
    // numbers were right, which is how an audit teaches people to ignore it.
    const { findings } = auditPlan(plan([
      component({
        name: 'USB-C port', role: 'charging and data', shape: 'box',
        params: { length: 9, width: 3.2, height: 3.2 },
        material: 'Stainless steel 304', density: 8.0,
      }),
    ]));
    expect(findings).toEqual([]);
  });

  it('compares a bearing on its outside diameter, not its bore', () => {
    const { findings } = auditPlan(plan([
      component({
        name: '608 bearing', role: 'wheel bearing', shape: 'cylinder',
        params: { diameter: 22, height: 7 },   // the OD and width, which is how it is modelled
        material: 'Stainless steel 304', density: 8.0,
      }),
    ]));
    expect(findings).toEqual([]);
  });

  it('does not flag on a weak keyword match', () => {
    // "Shaft" retrieves bearings, but a shaft is not a bearing and its diameter has nothing
    // to prove against one.
    const { findings } = auditPlan(plan([
      component({
        name: 'Output shaft', role: 'transmits torque', shape: 'cylinder',
        params: { diameter: 12, height: 200 },
        material: 'Steel 1018', density: 7.87,
      }),
    ]));
    expect(findings.filter((f) => f.severity === 'check')).toHaveLength(0);
  });

  it('leaves the original plan untouched', () => {
    const original = plan([component({ material: 'Aluminium 6061-T6', density: 7.85 })]);
    auditPlan(original);
    expect(original.components[0].density).toBe(7.85);
  });

  it('summarises nothing as nothing', () => {
    expect(summariseAudit([])).toBe('');
  });

  it('summarises corrections and checks separately', () => {
    const { findings } = auditPlan(plan([
      component({ name: 'Bracket', material: 'Aluminium 6061-T6', density: 7.85 }),
      component({
        id: 'c2', name: 'AA cell', role: 'power', shape: 'cylinder',
        params: { diameter: 14.5, height: 30 },
        material: 'Steel 1018', density: 7.87,
      }),
    ]));

    const text = summariseAudit(findings);
    expect(text).toMatch(/Corrected 1 value/);
    expect(text).toMatch(/1 dimension/);
  });
});

describe('the corpus summary', () => {
  it('counts every category and totals to the whole corpus', () => {
    const summary = corpusSummary();
    expect(summary.length).toBeGreaterThan(4);
    expect(summary.reduce((s, c) => s + c.count, 0)).toBe(FACTS.length);
  });
});

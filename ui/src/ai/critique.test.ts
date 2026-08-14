import { describe, expect, it } from 'vitest';
import { critique, repairPrompt, summariseCritique } from './critique';
import { IDENTITY_PLACEMENT, type AssemblyPlan, type ComponentSpec } from '../assembly/plan';
import { RECIPES } from '../assembly/recipes';

/**
 * Inspecting a finished assembly.
 *
 * The value of these checks is measured in what they caught the first time they ran over the
 * hand-written recipes — geometry that had been building cleanly for the whole life of the
 * project:
 *
 *   - The bicycle's wheels were lying flat. The archetype builds a wheel with its axle already
 *     along Y, and the recipe rotated it 90 degrees anyway.
 *   - The laptop's lid was placed beside its base rather than on top, making a closed laptop
 *     346 mm deep.
 *   - Four recipes declared envelopes smaller than the thing they built.
 *
 * Every one of those produced a closed, manifold, valid solid. Validity and correctness are
 * different properties and only one of them was being checked.
 */

function component(over: Partial<ComponentSpec> = {}): ComponentSpec {
  return {
    id: 'c1', name: 'Part', role: 'a part', shape: 'box',
    params: { length: 10, width: 10, height: 10 },
    placement: IDENTITY_PLACEMENT,
    material: 'Aluminium 6061-T6', density: 2.7, quantity: 1,
    ...over,
  };
}

function plan(components: ComponentSpec[], envelope?: AssemblyPlan['envelope']): AssemblyPlan {
  return {
    name: 'Test', description: 'test',
    envelope, components, notes: [], source: 'model',
  };
}

const kinds = (p: AssemblyPlan) => critique(p).map((c) => c.kind);

describe('parts that contribute nothing', () => {
  it('flags a component with a zero dimension', () => {
    expect(kinds(plan([
      component({ params: { length: 10, width: 0, height: 10 } }),
      component({ id: 'c2', name: 'Other' }),
    ]))).toContain('no-volume');
  });

  it('says nothing about a normal part', () => {
    expect(kinds(plan([
      component(),
      component({ id: 'c2', name: 'Other' }),
    ]))).not.toContain('no-volume');
  });
});

describe('parts floating in space', () => {
  it('flags a component touching nothing', () => {
    expect(kinds(plan([
      component({ name: 'Body' }),
      component({ id: 'c2', name: 'Stray', placement: { ...IDENTITY_PLACEMENT, x: 500 } }),
    ]))).toContain('floating');
  });

  it('accepts a component that overlaps another', () => {
    expect(kinds(plan([
      component({ name: 'Body' }),
      component({ id: 'c2', name: 'Inside', params: { length: 4, width: 4, height: 4 } }),
    ]))).not.toContain('floating');
  });

  it('accepts a component that merely touches another', () => {
    // Parts that abut are joined, not floating. Requiring genuine overlap would flag every
    // correctly-stacked assembly in existence.
    expect(kinds(plan([
      component({ name: 'Lower' }),
      component({ id: 'c2', name: 'Upper', placement: { ...IDENTITY_PLACEMENT, z: 10 } }),
    ]))).not.toContain('floating');
  });

  it('never flags a single-component plan as floating', () => {
    expect(kinds(plan([component()]))).not.toContain('floating');
  });
});

describe('cuts that remove nothing', () => {
  it('flags a cut that intersects nothing before it', () => {
    expect(kinds(plan([
      component({ name: 'Body' }),
      component({
        id: 'c2', name: 'Pocket', operation: 'cut',
        params: { length: 4, width: 4, height: 4 },
        placement: { ...IDENTITY_PLACEMENT, x: 40 },
      }),
      component({ id: 'c3', name: 'Neighbour', placement: { ...IDENTITY_PLACEMENT, x: 40 } }),
    ]))).toContain('cut-removes-nothing');
  });

  it('accepts a cut inside the part it precedes nothing of', () => {
    expect(kinds(plan([
      component({ name: 'Body', params: { length: 40, width: 40, height: 40 } }),
      component({
        id: 'c2', name: 'Pocket', operation: 'cut',
        params: { length: 10, width: 10, height: 10 },
      }),
    ]))).not.toContain('cut-removes-nothing');
  });

  it('flags a cut listed before the thing it was meant to cut', () => {
    // Order is the whole semantics of a cut, and getting it backwards is silent: the geometry
    // builds, and the pocket simply is not there.
    expect(kinds(plan([
      component({
        id: 'c1', name: 'Pocket', operation: 'cut',
        params: { length: 10, width: 10, height: 10 },
      }),
      component({ id: 'c2', name: 'Body', params: { length: 40, width: 40, height: 40 } }),
    ]))).toContain('cut-removes-nothing');
  });
});

describe('size against the declared envelope', () => {
  it('flags a part larger than the whole assembly', () => {
    expect(kinds(plan(
      [component({ params: { length: 400, width: 10, height: 10 } })],
      { length: 100, width: 100, height: 100 },
    ))).toContain('outside-envelope');
  });

  it('flags an assembly that does not measure what it claims', () => {
    expect(kinds(plan(
      [
        component({ name: 'A', params: { length: 10, width: 10, height: 10 } }),
        component({ id: 'c2', name: 'B', placement: { ...IDENTITY_PLACEMENT, x: 10 } }),
      ],
      { length: 500, width: 10, height: 10 },
    ))).toContain('implausible-scale');
  });

  it('does not care where the origin sits', () => {
    // A bicycle is dimensioned from the ground and a phone from its centre. Both are correct,
    // and a check that compares coordinates against a centred envelope calls both wrong —
    // which is what the first version of this did, reporting every part of both recipes.
    const centred = plan(
      [component({ params: { length: 100, width: 100, height: 100 } })],
      { length: 100, width: 100, height: 100 },
    );
    const grounded = plan(
      [component({
        params: { length: 100, width: 100, height: 100 },
        placement: { ...IDENTITY_PLACEMENT, z: 50 },
      })],
      { length: 100, width: 100, height: 100 },
    );

    expect(kinds(centred)).toEqual(kinds(grounded));
    expect(kinds(centred)).not.toContain('outside-envelope');
  });

  it('says nothing when there is no envelope to check against', () => {
    expect(kinds(plan([component()]))).not.toContain('implausible-scale');
  });
});

describe('rotation', () => {
  it('measures a rotated part along the axes it actually occupies', () => {
    // A wheel built with its axle along Y and then rotated 90 degrees about X ends up lying
    // flat. Treating rotation as a swap of extents would miss it; transforming the corners
    // does not. This is the check that caught both of the bicycle's wheels.
    const upright = plan([component({
      name: 'Wheel', params: { length: 700, width: 25, height: 700 },
    })], { length: 700, width: 25, height: 700 });

    const tipped = plan([component({
      name: 'Wheel', params: { length: 700, width: 25, height: 700 },
      placement: { ...IDENTITY_PLACEMENT, rx: 90 },
    })], { length: 700, width: 25, height: 700 });

    expect(kinds(upright)).not.toContain('outside-envelope');
    expect(kinds(tipped)).toContain('outside-envelope');
  });
});

describe('duplicates', () => {
  it('flags two identical parts in the same place', () => {
    expect(kinds(plan([
      component({ id: 'c1', name: 'A' }),
      component({ id: 'c2', name: 'B' }),
    ]))).toContain('coincident');
  });
});

describe('reporting', () => {
  it('is silent about a clean assembly', () => {
    expect(summariseCritique([])).toBe('');
    expect(repairPrompt(plan([component()]), [])).toBe('');
  });

  it('separates problems from things to check', () => {
    const found = critique(plan([
      component({ name: 'Body' }),
      component({ id: 'c2', name: 'Stray', placement: { ...IDENTITY_PLACEMENT, x: 500 } }),
    ]));
    expect(summariseCritique(found)).toMatch(/problem/);
  });

  it('puts errors before warnings, so the worst thing is read first', () => {
    const found = critique(plan([
      component({ id: 'c1', name: 'A' }),
      component({ id: 'c2', name: 'B' }),
      component({ id: 'c3', name: 'Stray', placement: { ...IDENTITY_PLACEMENT, x: 500 } }),
    ]));
    const severities = found.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort());
  });

  it('writes a repair prompt as edits to make, carrying the plan to correct', () => {
    const p = plan([
      component({ name: 'Body' }),
      component({ id: 'c2', name: 'Stray', placement: { ...IDENTITY_PLACEMENT, x: 500 } }),
    ]);
    const prompt = repairPrompt(p, critique(p));

    expect(prompt).toMatch(/Stray/);
    expect(prompt).toMatch(/corrected plan/i);
    expect(prompt).toContain('"components"');
  });
});

describe('the built-in recipes survive inspection', () => {
  it.each(RECIPES.map((r) => r.id))('%s has no misplaced or oversized parts', (id) => {
    const recipe = RECIPES.find((r) => r.id === id)!;
    const found = critique(recipe.build(1));

    // The bicycle has no stem, seatpost, hub or chain, so its bars and saddle genuinely do
    // float. That is a stated limitation in the recipe's own notes rather than a defect, and
    // the honest thing is to allow it here rather than silence the check that reports it.
    const unexpected = found.filter((f) => !(id === 'bicycle' && f.kind === 'floating'));
    expect(unexpected.map((f) => `${f.kind}: ${f.component} — ${f.message}`)).toEqual([]);
  });
});

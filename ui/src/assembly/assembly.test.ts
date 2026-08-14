import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  billOfMaterials, buildAssembly, describePlan, isArchetype, isPrimitive,
  shapeVocabulary, validatePlan,
} from './plan';
import { RECIPES, matchRecipe, namesSpecificProduct, phoneRecipe, recipeById } from './recipes';
import { evaluateDocument } from '../model/document';
import { bounds, health, triCount } from '../kernel/topo/mesh';
import { buildSystemPrompt } from '../ai/decompose';
import { defaultConfig, extractJson, providerInfo, PROVIDERS } from '../ai/providers';

/**
 * Assembly decomposition tests.
 *
 * Two distinct risks are covered here.
 *
 * That the built-in recipes produce *real* geometry — a phone whose components fit inside a
 * phone-sized envelope, with the parts a phone actually has. A decomposition that lists
 * plausible names and produces nothing buildable is worse than no decomposition.
 *
 * And that a plan arriving from a language model is treated as untrusted input. It will
 * occasionally name a shape that does not exist, give a negative thickness, or place a
 * component a kilometre away, and none of that may reach the kernel or silently become a
 * wrong part.
 */

describe('the shape vocabulary', () => {
  it('covers every archetype plus the primitives', () => {
    const vocab = shapeVocabulary();
    expect(vocab).toContain('cup');
    expect(vocab).toContain('gear');
    expect(vocab).toContain('box');
    expect(vocab).toContain('cylinder');
  });

  it('classifies shapes correctly', () => {
    expect(isArchetype('cup')).toBe(true);
    expect(isPrimitive('cup')).toBe(false);

    // box, cylinder and sphere exist as both a primitive and a catalogue archetype. Both
    // predicates are true for them, and `buildAssembly` prefers the primitive — the same
    // shape by a shorter path, with no parameter clamping in between.
    expect(isPrimitive('box')).toBe(true);
    expect(isArchetype('box')).toBe(true);

    expect(isArchetype('teleporter')).toBe(false);
    expect(isPrimitive('teleporter')).toBe(false);
  });
});

describe('recipes', () => {
  for (const recipe of RECIPES) {
    it(`${recipe.id} produces a buildable assembly`, () => {
      const plan = recipe.build();
      const validated = validatePlan(plan);

      expect('error' in validated).toBe(false);
      if ('error' in validated) return;

      // Nothing may be dropped: these are hand-written and must use only real shapes.
      expect(validated.dropped).toEqual([]);
      expect(validated.plan.components.length).toBeGreaterThan(3);

      const doc = buildAssembly(validated.plan);
      const ev = evaluateDocument(doc);

      expect(triCount(ev.mesh)).toBeGreaterThan(0);
      // Every feature must contribute geometry or say why it did not.
      for (const f of doc.features) {
        if (ev.errors.has(f.id)) {
          expect(ev.errors.get(f.id)!.length).toBeGreaterThan(5);
        }
      }
    }, 120_000);

    it(`${recipe.id} names a material and a role for every component`, () => {
      // A bill of materials without materials is a parts list, and a component without a
      // role cannot be reviewed by anyone who did not write it.
      for (const c of recipe.build().components) {
        expect(c.material.length).toBeGreaterThan(0);
        expect(c.role.length).toBeGreaterThan(0);
      }
    });

    it(`${recipe.id} states what it is not`, () => {
      // Every one of these is a package study, not a manufacturable design. Saying so is
      // the difference between a useful model and a misleading one.
      expect(recipe.build().notes.length).toBeGreaterThan(0);
    });
  }
});

describe('the phone', () => {
  it('has the components a phone actually has', () => {
    const names = phoneRecipe().components.map((c) => c.name.toLowerCase()).join(' ');

    for (const expected of ['frame', 'display', 'battery', 'mainboard', 'camera', 'cover', 'button']) {
      expect(names, `missing ${expected}`).toContain(expected);
    }
  });

  it('is phone-sized', () => {
    const plan = phoneRecipe();
    expect(plan.envelope!.length).toBeGreaterThan(140);
    expect(plan.envelope!.length).toBeLessThan(180);

    // Height is quoted over the camera island, not the body, because that is what the model
    // actually measures and what matters for a case or a pocket. The body alone is 8.3 mm;
    // a real flagship stands about 4 mm proud at the camera.
    expect(plan.envelope!.height).toBeGreaterThan(9);
    expect(plan.envelope!.height).toBeLessThan(13);
  });

  it('keeps every component inside the envelope', () => {
    // A battery placed outside the chassis is the classic failure of a generated
    // decomposition: the parts list reads correctly and the model is nonsense.
    const plan = phoneRecipe();
    const { length, width } = plan.envelope!;

    for (const c of plan.components) {
      expect(Math.abs(c.placement.x), `${c.name} is outside on X`).toBeLessThan(length);
      expect(Math.abs(c.placement.y), `${c.name} is outside on Y`).toBeLessThan(width);
    }
  });

  it('builds into a solid whose envelope matches the specification', () => {
    const plan = phoneRecipe();
    const doc = buildAssembly(plan);
    const ev = evaluateDocument(doc);

    expect(triCount(ev.mesh)).toBeGreaterThan(0);

    const b = bounds(ev.mesh);
    // Camera island and buttons stand proud, so allow for them rather than demanding an
    // exact match to the bare chassis.
    expect(b.max[0] - b.min[0]).toBeGreaterThan(plan.envelope!.length * 0.9);
    expect(b.max[0] - b.min[0]).toBeLessThan(plan.envelope!.length * 1.15);
  }, 120_000);

  it('scales as a whole when asked for a small one', () => {
    const normal = phoneRecipe(1);
    const small = phoneRecipe(0.6);

    expect(small.envelope!.length).toBeCloseTo(normal.envelope!.length * 0.6, 3);
    // The battery must shrink with it, not stay full size inside a smaller phone.
    const bigCell = normal.components.find((c) => c.name === 'Battery')!;
    const smallCell = small.components.find((c) => c.name === 'Battery')!;
    expect(Number(smallCell.params.length)).toBeLessThan(Number(bigCell.params.length));
  });

  it('produces a bill of materials', () => {
    const bom = billOfMaterials(phoneRecipe());
    expect(bom.length).toBeGreaterThan(8);
    expect(bom[0].item).toBe(1);
    expect(bom.every((l) => l.quantity >= 1)).toBe(true);
  });
});

describe('matching a request to a recipe', () => {
  it('recognises the obvious words', () => {
    expect(matchRecipe('make a phone')?.id).toBe('phone');
    expect(matchRecipe('design a smartphone')?.id).toBe('phone');
    expect(matchRecipe('I need a gearbox')?.id).toBe('gearbox');
    expect(matchRecipe('a bicycle please')?.id).toBe('bicycle');
    expect(matchRecipe('electric motor')?.id).toBe('motor');
  });

  it('does not match unrelated text', () => {
    expect(matchRecipe('a cup of tea')).toBeNull();
    expect(matchRecipe('quantum flux capacitor')).toBeNull();
  });

  it('is not fooled by a word inside another word', () => {
    // "microphone" contains "phone" but is not one.
    expect(matchRecipe('a microphone stand')).toBeNull();
  });
});

describe('telling a category from a named product', () => {
  // A recipe describes the *kind* of thing, built from figures typical of it rather than
  // measured off any one device. That is right for "a phone" and wrong for "iPhone 15 Pro
  // Max", which has published dimensions somebody can check. Answering the second with the
  // first silently substitutes a different object — the more embarrassing of the two failures.
  it.each([
    ['iphone 15 pro max', true],
    ['iPhone 15 Pro Max', true],
    ['macbook pro 16', true],
    ['a phone', false],
    ['create an iphone', false],
    ['a smartphone', false],
    ['a small phone', false],
  ])('%s', (prompt, expected) => {
    const recipe = matchRecipe(prompt);
    expect(recipe, `${prompt} matched no recipe`).not.toBeNull();
    expect(namesSpecificProduct(prompt, recipe!)).toBe(expected);
  });

  it('does not mistake a dimension for a model number', () => {
    // "a phone 160 mm long" is a dimensioned category, not a product name. Numbers carrying
    // a unit are stripped before the check.
    expect(namesSpecificProduct('a phone 160 mm long', matchRecipe('a phone')!)).toBe(false);
    expect(namesSpecificProduct('a 26 inch bicycle', matchRecipe('a bicycle')!)).toBe(false);
  });
});

describe('validating an untrusted plan', () => {
  const base = {
    name: 'Test',
    description: '',
    components: [
      {
        id: 'a', name: 'Body', role: 'shell', shape: 'box',
        params: { length: 100, width: 50, height: 20 },
        placement: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
        material: 'Aluminium', density: 2.7, quantity: 1,
      },
    ],
    notes: [],
  };

  it('accepts a well-formed plan', () => {
    const r = validatePlan(base);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.plan.components.length).toBe(1);
    expect(r.dropped).toEqual([]);
  });

  it('rejects a plan that is not an object', () => {
    expect('error' in validatePlan('nope')).toBe(true);
    expect('error' in validatePlan(null)).toBe(true);
  });

  it('rejects a plan with no components', () => {
    expect('error' in validatePlan({ ...base, components: [] })).toBe(true);
  });

  it('drops a component naming a shape the kernel cannot build, and says which', () => {
    // The single most likely thing a model gets wrong.
    const r = validatePlan({
      ...base,
      components: [...base.components, { ...base.components[0], id: 'b', name: 'Warp core', shape: 'warpcore' }],
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;

    expect(r.plan.components.length).toBe(1);
    expect(r.dropped.length).toBe(1);
    expect(r.dropped[0].name).toBe('Warp core');
    expect(r.dropped[0].reason).toMatch(/warpcore/);
  });

  it('clamps an out-of-range archetype parameter and reports it', () => {
    // A quietly corrected dimension is worse than a rejected one.
    const r = validatePlan({
      ...base,
      components: [{
        ...base.components[0], shape: 'cup',
        params: { outerDia: 5000, wall: -3 },
      }],
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;

    expect(r.corrections.length).toBeGreaterThan(0);
    expect(r.corrections.join(' ')).toMatch(/outside/);

    const cup = r.plan.components[0];
    expect(cup.params.outerDia).toBeLessThanOrEqual(200);
    expect(cup.params.wall).toBeGreaterThan(0);
  });

  it('fills in missing archetype parameters with their defaults', () => {
    const r = validatePlan({ ...base, components: [{ ...base.components[0], shape: 'cup', params: {} }] });
    if ('error' in r) return;
    // A cup with no parameters must still be a cup, not an empty one.
    expect(r.plan.components[0].params.outerDia).toBeGreaterThan(0);
    expect(r.plan.components[0].params.height).toBeGreaterThan(0);
  });

  it('pulls back an implausible position rather than losing the part off screen', () => {
    const r = validatePlan({
      ...base,
      components: [{ ...base.components[0], placement: { x: 5e7, y: 0, z: 0, rx: 0, ry: 0, rz: 0 } }],
    });
    if ('error' in r) return;
    expect(Math.abs(r.plan.components[0].placement.x)).toBeLessThan(5e7);
    expect(r.corrections.join(' ')).toMatch(/implausible/);
  });

  it('measures implausibility against the plan own size, not a fixed distance', () => {
    // The limit was a flat ten metres, which was fine until an airliner arrived: its radome
    // sits 18.8 m down a 37.6 m fuselage, and the validator moved it to 10 m and reported
    // that it had fixed something. Correcting a correct part is worse than not checking.
    const big = {
      ...base,
      envelope: { length: 37_570, width: 35_800, height: 11_760 },
      components: [{ ...base.components[0], placement: { x: 18_785, y: 0, z: 0, rx: 0, ry: 0, rz: 0 } }],
    };

    const r = validatePlan(big);
    if ('error' in r) return;
    expect(r.plan.components[0].placement.x).toBe(18_785);
    expect(r.corrections.join(' ')).not.toMatch(/implausible/);
  });

  it('still catches a part flung far outside a small assembly', () => {
    const small = {
      ...base,
      envelope: { length: 163, width: 78, height: 10 },
      components: [{ ...base.components[0], placement: { x: 50_000, y: 0, z: 0, rx: 0, ry: 0, rz: 0 } }],
    };

    const r = validatePlan(small);
    if ('error' in r) return;
    expect(Math.abs(r.plan.components[0].placement.x)).toBeLessThanOrEqual(1000);
    expect(r.corrections.join(' ')).toMatch(/implausible/);
  });

  it('normalises rotations and rejects non-numbers', () => {
    const r = validatePlan({
      ...base,
      components: [{ ...base.components[0], placement: { x: 0, y: 0, z: 0, rx: 450, ry: NaN, rz: -90 } }],
    });
    if ('error' in r) return;
    const p = r.plan.components[0].placement;
    expect(p.rx).toBeCloseTo(90, 6);
    expect(p.ry).toBe(0);
    expect(p.rz).toBeCloseTo(270, 6);
  });

  it('bounds the quantity so a plan cannot ask for ten thousand instances', () => {
    const r = validatePlan({ ...base, components: [{ ...base.components[0], quantity: 99999 }] });
    if ('error' in r) return;
    expect(r.plan.components[0].quantity).toBeLessThanOrEqual(64);
  });

  it('fails when every component is unbuildable', () => {
    const r = validatePlan({ ...base, components: [{ ...base.components[0], shape: 'nonsense' }] });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/none of the/i);
  });
});

describe('building an assembly', () => {
  it('makes one feature per component instance', () => {
    const plan = validatePlan({
      name: 'Pair', description: '', notes: [],
      components: [{
        id: 'a', name: 'Bracket', role: 'mount', shape: 'box',
        params: { length: 40, width: 20, height: 10 },
        placement: { x: 0, y: 30, z: 0, rx: 0, ry: 0, rz: 0 },
        material: 'Steel', density: 7.85, quantity: 2,
      }],
    });
    if ('error' in plan) return;

    const doc = buildAssembly(plan.plan);
    expect(doc.features.length).toBe(2);
    expect(doc.features[0].name).toBe('Bracket 1');
    // A quantity of two is a symmetric pair; stacking both at the same place would hide one.
    expect(doc.features[1].placement!.y).toBeCloseTo(-30, 6);
  });

  it('applies cutting components after everything they cut', () => {
    // A port listed before the chassis must still cut through it.
    const plan = validatePlan({
      name: 'Cut', description: '', notes: [],
      components: [
        {
          id: 'cut', name: 'Port', role: 'opening', shape: 'box',
          params: { length: 10, width: 40, height: 10 },
          placement: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
          material: '—', density: 1, quantity: 1, operation: 'cut',
        },
        {
          id: 'body', name: 'Body', role: 'shell', shape: 'box',
          params: { length: 60, width: 30, height: 20 },
          placement: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
          material: 'Aluminium', density: 2.7, quantity: 1,
        },
      ],
    });
    if ('error' in plan) return;

    const doc = buildAssembly(plan.plan);
    expect(doc.features[0].name).toBe('Body');
    expect(doc.features[1].name).toBe('Port');

    const ev = evaluateDocument(doc);
    expect(health(ev.mesh).closed).toBe(true);
    // The cut must actually remove material.
    expect(ev.volume).toBeLessThan(60 * 30 * 20);
  }, 60_000);

  it('carries the role through to the tree', () => {
    const plan = validatePlan({
      name: 'X', description: '', notes: [],
      components: [{
        id: 'a', name: 'Shaft', role: 'transmits torque', shape: 'cylinder',
        params: { diameter: 20, height: 100 },
        placement: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
        material: 'Steel', density: 7.85, quantity: 1,
      }],
    });
    if ('error' in plan) return;
    expect(buildAssembly(plan.plan).features[0].role).toBe('transmits torque');
  });

  it('places a component where the plan says', () => {
    const plan = validatePlan({
      name: 'Offset', description: '', notes: [],
      components: [{
        id: 'a', name: 'Block', role: 'test', shape: 'box',
        params: { length: 10, width: 10, height: 10 },
        placement: { x: 200, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
        material: 'Steel', density: 7.85, quantity: 1,
      }],
    });
    if ('error' in plan) return;

    const ev = evaluateDocument(buildAssembly(plan.plan));
    const b = bounds(ev.mesh);
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(200, 1);
  }, 60_000);

  it('summarises itself', () => {
    expect(describePlan(phoneRecipe())).toMatch(/parts across/);
  });
});

describe('provider configuration', () => {
  it('defaults to no model at all', () => {
    // The deterministic path is the product, not a fallback.
    expect(defaultConfig().id).toBe('none');
    expect(defaultConfig().allowWebSearch).toBe(false);
  });

  it('describes every provider it offers', () => {
    for (const p of PROVIDERS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.note.length).toBeGreaterThan(20);
      if (p.needsKey) expect(p.keyUrl).toBeTruthy();
    }
  });

  it('falls back to the offline provider for an unknown id', () => {
    expect(providerInfo('made-up' as never).id).toBe('none');
  });

  it('only claims web search where the provider actually has it', () => {
    // Gemini has server-side grounding; a browser cannot fetch arbitrary sites itself.
    expect(providerInfo('gemini').supportsWebSearch).toBe(true);
    expect(providerInfo('ollama').supportsWebSearch).toBe(false);
    expect(providerInfo('groq').supportsWebSearch).toBe(false);
  });

  it('offers Groq, with somewhere to get a key', () => {
    const groq = providerInfo('groq');
    expect(groq.id).toBe('groq');
    expect(groq.needsKey).toBe(true);
    expect(groq.keyUrl).toMatch(/console\.groq\.com/);
    expect(groq.suggestedModels.length).toBeGreaterThan(0);
  });

  it('lets the page reach every hosted provider it offers', () => {
    // A provider in the list that connect-src forbids is worse than one that is absent: it
    // fails at the moment someone has already found a key and pasted it in. This is the check
    // that would have caught Gemini being unreachable for the whole life of the project.
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const policy = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/)?.[1] ?? '';
    const connect = policy.match(/connect-src([^;]*)/)?.[1] ?? '';

    const origins: Partial<Record<string, string>> = {
      gemini: 'https://generativelanguage.googleapis.com',
      anthropic: 'https://api.anthropic.com',
      openai: 'https://api.openai.com',
      groq: 'https://api.groq.com',
    };

    for (const p of PROVIDERS) {
      const origin = origins[p.id];
      if (!origin) continue;   // 'none' needs nothing; Ollama is loopback, allowed separately
      expect(connect, `${p.label} is offered but connect-src forbids ${origin}`).toContain(origin);
    }
  });
});

describe('reading a model reply', () => {
  it('parses plain JSON', () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON inside a fenced block', () => {
    // Models emit fences constantly, even when told not to.
    expect(extractJson<{ a: number }>('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('recovers JSON surrounded by prose', () => {
    expect(extractJson<{ a: number }>('Sure! {"a":3} Hope that helps.')).toEqual({ a: 3 });
  });

  it('returns null rather than throwing on nonsense', () => {
    expect(extractJson('not json at all')).toBeNull();
  });
});

describe('the system prompt', () => {
  it('lists every shape a plan may use, with its parameter ranges', () => {
    const prompt = buildSystemPrompt();

    // The model must choose from a visible list rather than guess at an API. This is what
    // removes most of the ways a generated plan can be unbuildable.
    for (const shape of ['cup', 'gear', 'flange', 'box', 'cylinder']) {
      expect(prompt).toContain(shape);
    }
    expect(prompt).toMatch(/outerDia\(\d/);
  });

  it('states the units, because getting them wrong is the expensive failure', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/millimetre/i);
    expect(prompt).toMatch(/163 mm/);
  });

  it('asks for the honest limitations', () => {
    expect(buildSystemPrompt()).toMatch(/what this model is not/i);
  });
});

describe('recipe registry', () => {
  it('finds recipes by id', () => {
    expect(recipeById('phone')?.label).toBe('Phone');
    expect(recipeById('nope')).toBeUndefined();
  });

  it('gives every recipe a summary a user can read', () => {
    for (const r of RECIPES) {
      expect(r.summary.length).toBeGreaterThan(20);
      expect(r.aliases.length).toBeGreaterThan(1);
    }
  });
});

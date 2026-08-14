import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { useModel } from './modelStore';
import { emptyDocument, evaluateDocument } from './model/document';
import { triCount } from './kernel/topo/mesh';
import { generateFromText } from './generate/parse';
import { archetypeById } from './generate/archetypes';
import { health } from './kernel/topo/mesh';
import type { RasterImage } from './ingest/image/trace';

/**
 * The paths a person actually walks through the application.
 *
 * Everything else in the suite tests a layer. This tests the product: type a request, get a
 * solid; import a picture, get a solid; export it; save it; open it again. These are the
 * things that must not be broken when the application is put in front of someone, and they
 * are exactly the things unit tests of individual modules will not catch — every layer can
 * pass while the wiring between two of them is wrong.
 */

function reset() {
  useModel.setState({
    doc: emptyDocument(),
    evaluated: evaluateDocument(emptyDocument()),
    selectedFaces: [],
    selectedFeatureId: null,
    editingFeatureId: null,
    undoStack: [],
    redoStack: [],
    notice: null,
    plan: null,
  });
}

/** Runs a request through the offline path and returns what the user would see. */
async function build(prompt: string) {
  const result = await useModel.getState().build(prompt);
  const evaluated = useModel.getState().evaluated;
  return { result, evaluated };
}

describe('typing a request and getting a solid', () => {
  beforeEach(reset);

  it.each([
    ['a phone', 10],
    ['a gearbox', 6],
    ['make a cup', 1],
    ['M10 hex nut', 1],
    ['a bracket', 1],
  ])('%s builds a closed solid', async (prompt, minFeatures) => {
    const { result, evaluated } = await build(prompt);

    expect(result.ok, result.message).toBe(true);
    expect(triCount(evaluated.mesh)).toBeGreaterThan(0);
    expect(evaluated.health.closed, `${prompt} came out open`).toBe(true);
    expect(evaluated.health.manifold, `${prompt} came out non-manifold`).toBe(true);
    expect(useModel.getState().doc.features.length).toBeGreaterThanOrEqual(minFeatures);
  });

  it('reads a size out of the sentence rather than ignoring it', async () => {
    reset();
    await build('make a cup 120 mm tall');
    const tall = useModel.getState().evaluated;

    reset();
    await build('make a cup 60 mm tall');
    const short = useModel.getState().evaluated;

    expect(tall.volume).toBeGreaterThan(short.volume);
  });

  it('reports a real mass, not a volume weighed at one density', async () => {
    const { evaluated } = await build('a phone');
    // A flagship phone is 200–250 g. Weighing the whole 104 cm³ at its stainless SIM tray's
    // density gave 831 g, which is the failure this number exists to catch.
    expect(evaluated.massGrams).toBeGreaterThan(150);
    expect(evaluated.massGrams).toBeLessThan(400);
  });

  it('says so rather than throwing when it cannot build something', async () => {
    const { result } = await build('a quantum flux capacitor');
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(20);
  });
});

describe('getting the work out', () => {
  beforeEach(reset);

  it('exports an STL a slicer would accept', async () => {
    await build('make a cup');
    const out = useModel.getState().exportStl();

    expect(out).not.toBeNull();
    expect(out!.name).toMatch(/\.stl$/i);
    expect(out!.text).toMatch(/^solid/);
    expect(out!.text).toMatch(/endsolid/);
    expect(out!.text.match(/facet normal/g)!.length).toBeGreaterThan(100);
  });

  it('exports a drawing as SVG', async () => {
    await build('a bracket');
    const out = useModel.getState().exportDrawing('svg');

    expect(out).not.toBeNull();
    expect(out!.name).toMatch(/\.svg$/i);
    expect(out!.text).toMatch(/<svg/);
    expect(out!.text).toMatch(/<\/svg>/);
  });

  it('exports a drawing as DXF that names the sections a reader expects', async () => {
    await build('a bracket');
    const out = useModel.getState().exportDrawing('dxf');

    expect(out).not.toBeNull();
    expect(out!.text).toMatch(/ENTITIES/);
    expect(out!.text).toMatch(/EOF/);
  });

  it('refuses to export an empty document rather than writing a blank file', () => {
    expect(useModel.getState().exportStl()).toBeNull();
    expect(useModel.getState().exportDrawing('svg')).toBeNull();
  });
});

describe('saving and reopening', () => {
  beforeEach(reset);

  it('round-trips a model through JSON with its geometry intact', async () => {
    await build('a gearbox');
    const before = useModel.getState().evaluated;
    const saved = useModel.getState().save();

    reset();
    expect(triCount(useModel.getState().evaluated.mesh)).toBe(0);

    expect(useModel.getState().load(saved)).toBe(true);
    const after = useModel.getState().evaluated;

    expect(after.volume).toBeCloseTo(before.volume, 3);
    expect(triCount(after.mesh)).toBe(triCount(before.mesh));
  });

  it('saves the feature tree, so the reopened model is still editable', async () => {
    await build('a phone');
    const saved = JSON.parse(useModel.getState().save());

    expect(Array.isArray(saved.features)).toBe(true);
    expect(saved.features.length).toBeGreaterThan(10);
    // Every feature keeps its parameters. A saved mesh would reopen as an uneditable lump.
    expect(saved.features.every((f: { params: unknown }) => f.params)).toBe(true);
  });

  it('rejects a file that is not a document, rather than crashing', () => {
    expect(useModel.getState().load('{"nonsense":true}')).toBe(false);
    expect(useModel.getState().load('not json at all')).toBe(false);
  });
});

describe('importing a picture', () => {
  beforeEach(reset);

  /** A black rounded blob on white, which is what a silhouette photo reduces to. */
  function blob(w = 120, h = 90): RasterImage {
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inside = (x - w / 2) ** 2 / (w * 0.3) ** 2 + (y - h / 2) ** 2 / (h * 0.3) ** 2 < 1;
        const i = (y * w + x) * 4;
        if (inside) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; }
      }
    }
    return { width: w, height: h, data };
  }

  it('traces an outline and extrudes it into a closed solid', () => {
    const r = useModel.getState().importImage(blob(), 0.5, 6);

    expect(r.ok, r.message).toBe(true);
    const evaluated = useModel.getState().evaluated;
    expect(triCount(evaluated.mesh)).toBeGreaterThan(0);
    expect(evaluated.health.closed).toBe(true);
  });

  it('produces a feature whose thickness can then be edited', () => {
    useModel.getState().importImage(blob(), 0.5, 6);
    const feature = useModel.getState().doc.features[0];
    expect(feature).toBeDefined();

    // The traced outline is stored as an extrude, so its thickness is the extrude distance.
    // That is the point of tracing to a *feature* rather than to a mesh: the depth stays a
    // number you can change afterwards.
    expect(feature.kind).toBe('extrude');

    const before = useModel.getState().evaluated.volume;
    useModel.getState().setParams(feature.id, { distance: 12 });
    expect(useModel.getState().evaluated.volume).toBeGreaterThan(before * 1.5);
  });

  it('carries holes through, so a washer is not traced as a disc', () => {
    // The tracer always found the holes; the extrusion threw them away, so every part
    // imported from a picture came out solid. A traced flange with a bolt circle is a very
    // different object from a disc.
    const w = 140, h = 140;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d2 = (x - w / 2) ** 2 + (y - h / 2) ** 2;
        const i = (y * w + x) * 4;
        if (d2 < 50 ** 2 && d2 > 20 ** 2) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; }
      }
    }

    const r = useModel.getState().importImage({ width: w, height: h, data }, 0.5, 6);
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/1 hole/);

    const evaluated = useModel.getState().evaluated;
    expect(evaluated.health.closed).toBe(true);

    // A 25 mm-radius disc 6 mm thick is 11 781 mm³; with a 10 mm-radius bore it is 9 896.
    // Anything near the former means the hole was dropped again.
    expect(evaluated.volume).toBeGreaterThan(9000);
    expect(evaluated.volume).toBeLessThan(10600);
  });

  it('says so when an image has nothing traceable in it', () => {
    const blank: RasterImage = {
      width: 40, height: 40, data: new Uint8ClampedArray(40 * 40 * 4).fill(255),
    };
    const r = useModel.getState().importImage(blank, 0.5, 6);
    expect(r.ok).toBe(false);
    expect(r.message.length).toBeGreaterThan(10);
  });
});

describe('the page allows the providers it ships with', () => {
  // For a long time it did not. connect-src listed only loopback — a leftover from when this
  // ran inside a CAD process — so every hosted provider failed with "Failed to fetch", and
  // the error text blamed the provider's CORS policy. Nothing reached Google at all.
  //
  // Read from index.html rather than from the DOM so this holds for the built bundle too.
  // Resolved from the working directory rather than import.meta.url: under jsdom the module
  // URL is not a file: URL, and readFileSync rejects it.
  //
  // Read out of the content attribute specifically. Searching the whole file for
  // "connect-src" found the phrase in the comment above the tag instead, which is a fine
  // reminder that a test can pass or fail on the prose next to the thing it is checking.
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
  const policy = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/)?.[1] ?? '';
  const csp = policy.match(/connect-src([^;]*)/)?.[1] ?? '';

  it.each([
    ['Gemini', 'https://generativelanguage.googleapis.com'],
    ['Anthropic', 'https://api.anthropic.com'],
    ['OpenAI', 'https://api.openai.com'],
  ])('%s is reachable', (_name, origin) => {
    expect(csp).toContain(origin);
  });

  it('allows Ollama by name as well as by address', () => {
    // Ollama's default host is localhost, and only 127.0.0.1 was listed — so the one provider
    // that needs no key and no network was blocked too.
    expect(csp).toMatch(/http:\/\/localhost:\*/);
    expect(csp).toMatch(/http:\/\/127\.0\.0\.1:\*/);
  });

  it('lets the boolean engine instantiate', () => {
    // Manifold is WebAssembly bound through Emscripten's Embind, which builds its invoker
    // functions with `new Function`. Without this the module downloads, fails to instantiate,
    // and every boolean silently falls back to the old BSP — the application still works and
    // every part comes out five times heavier, which is the worst kind of broken.
    const script = html.match(/script-src([^;]*)/)?.[1] ?? '';
    expect(script).toMatch(/unsafe-eval/);
  });

  it('does not simply open connect-src to everything', () => {
    // The point of the policy is that a script running here cannot post the API keys in local
    // storage to somewhere they do not belong. A wildcard would give that up entirely.
    expect(csp).not.toMatch(/connect-src[^;]*\shttps:(\s|$)/);
    expect(csp).not.toContain('*;');
  });
});

describe('parts weigh what they should', () => {
  beforeEach(reset);

  // Mass is the first number an engineer checks and the one that gives a fake model away.
  // Every single part used to be weighed as aluminium because that is the document default,
  // which made a solid oak dining table come out at 84 kg. Each archetype now declares what
  // it is actually made of.
  it.each([
    ['a coffee table', 'Oak', 15_000, 40_000],
    ['a storage bin', 'Polypropylene', 150, 600],
    ['a wall hook', 'Steel', 30, 250],
    ['a cup', 'Stoneware', 120, 500],
    ['a control knob', 'ABS', 10, 80],
    ['M10 hex nut', 'Steel', 5, 25],
  ])('%s is %s and weighs a sane amount', async (prompt, material, lo, hi) => {
    await build(prompt);
    const state = useModel.getState();

    expect(state.doc.material).toMatch(new RegExp(material, 'i'));
    expect(state.evaluated.massGrams).toBeGreaterThan(lo);
    expect(state.evaluated.massGrams).toBeLessThan(hi);
  });
});

describe('asking before building', () => {
  beforeEach(reset);

  it('asks rather than guessing when a request names a family of parts', async () => {
    // This used to produce nothing at all: no rack in the catalogue, so it refused. Refusing
    // and guessing are both wrong answers to "create an anodizing rack" — which rack depends
    // on the tank, the parts and the batch, and none of that is in the sentence.
    const r = await useModel.getState().build('create an anodizing rack');

    expect(r.ok).toBe(true);
    const pending = useModel.getState().pending;
    expect(pending).not.toBeNull();
    expect(pending!.clarification.questions.length).toBeGreaterThanOrEqual(2);
    expect(pending!.clarification.questions.length).toBeLessThanOrEqual(4);

    // Nothing is built until it is answered.
    expect(triCount(useModel.getState().evaluated.mesh)).toBe(0);
  });

  it('asks about the things that carry a decision, in the words of whoever knew why', async () => {
    await useModel.getState().build('an anodizing rack');
    const questions = useModel.getState().pending!.clarification.questions;

    // The spine's section is what decides the current the rack can carry, so it has to be
    // one of the questions.
    const spine = questions.find((q) => q.key === 'spineWidth');
    expect(spine, questions.map((q) => q.key).join(', ')).toBeDefined();
    expect(spine!.question).toMatch(/A per mm|current/i);
    expect(spine!.choices.length).toBeGreaterThanOrEqual(2);
  });

  it('every offered choice is inside the range the kernel will accept', async () => {
    await useModel.getState().build('an anodizing rack');
    const { clarification } = useModel.getState().pending!;
    const ranges = new Map(clarification.archetype.defaults.map((d) => [d.key, d]));

    for (const q of clarification.questions) {
      for (const choice of q.choices) {
        for (const [key, value] of Object.entries(choice.values)) {
          const spec = ranges.get(key);
          expect(spec, `${key} is not a parameter`).toBeDefined();
          expect(value).toBeGreaterThanOrEqual(spec!.min);
          expect(value).toBeLessThanOrEqual(spec!.max);
        }
      }
    }
  });

  it('builds from the answers, and defaults fill whatever went unanswered', async () => {
    await useModel.getState().build('an anodizing rack');
    const { clarification } = useModel.getState().pending!;

    // Answer one question with its last choice; leave the rest alone.
    const first = clarification.questions[0];
    useModel.getState().answer(first.key, first.choices.length - 1);

    const built = await useModel.getState().buildAnswered();
    expect(built.ok, built.message).toBe(true);

    const evaluated = useModel.getState().evaluated;
    expect(triCount(evaluated.mesh)).toBeGreaterThan(0);
    expect(evaluated.health.closed).toBe(true);
    expect(useModel.getState().pending).toBeNull();

    // The answer reached the geometry, not just the transcript.
    const chosen = first.choices[first.choices.length - 1].values[first.key];
    const feature = useModel.getState().doc.features[0];
    expect(feature.params[first.key]).toBe(chosen);
  });

  it('carries the archetype material through, so a rack is titanium', async () => {
    await useModel.getState().build('an anodizing rack');
    await useModel.getState().buildAnswered();
    expect(useModel.getState().doc.material).toMatch(/titanium/i);
  });

  it('lets the questions be abandoned without building', async () => {
    await useModel.getState().build('an anodizing rack');
    useModel.getState().cancelPending();

    expect(useModel.getState().pending).toBeNull();
    expect(triCount(useModel.getState().evaluated.mesh)).toBe(0);
  });

  it.each(['a phone', 'make a cup', 'M10 hex nut', 'a bracket', 'a gearbox'])(
    'builds %s straight away rather than interrogating',
    async (prompt) => {
      // Only made-to-fit parts ask. A cup is a cup; an assembly has thirteen components and
      // the parameter panel is the right place to adjust it. An early version asked about
      // everything and broke a dozen tests by building nothing without a dialogue first.
      const r = await useModel.getState().build(prompt);

      expect(useModel.getState().pending).toBeNull();
      expect(r.ok, r.message).toBe(true);
      expect(triCount(useModel.getState().evaluated.mesh)).toBeGreaterThan(0);
    },
  );

  it('does not ask when the request already gave the dimensions', async () => {
    const r = await useModel.getState().build('a rack with spine height 1200 and 8 tiers');

    expect(useModel.getState().pending).toBeNull();
    expect(r.ok, r.message).toBe(true);
    expect(triCount(useModel.getState().evaluated.mesh)).toBeGreaterThan(0);
  });
});

describe('every part understands its own parameter names', () => {
  // The synonym table only knew words common across mechanical parts — diameter, wall, tall.
  // A plating rack's useful parameters are "spine height", "arm length" and "tiers", and not
  // one phrasing of them was understood, so every rack had to be corrected by hand after it
  // was built. Matching the archetype's own labels gives all 26 of them natural-language
  // sizing without a synonym list per part.
  it.each([
    ['a rack with spine height 1200', 'rack', 'spineHeight', 1200],
    ['a rack with 8 tiers', 'rack', 'tiers', 8],
    ['a rack arm length 400', 'rack', 'armLength', 400],
    ['a gear with 40 teeth', 'gear', 'teeth', 40],
  ])('%s sets %s.%s', (prompt, shape, key, value) => {
    const out = generateFromText(prompt);
    expect(out.ok, `"${prompt}" matched nothing`).toBe(true);
    if (!out.ok) return;

    expect(out.archetype.id).toBe(shape);
    expect(out.parsed.params[key]).toBe(value);
  });

  it('still honours the shared synonyms it always knew', () => {
    const out = generateFromText('make a cup 90 mm tall');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.parsed.understood.join(' ')).toMatch(/90/);
  });
});

describe('a plating rack is an electrical part before it is a mechanical one', () => {
  const rack = (over: Record<string, number> = {}) => {
    const a = archetypeById('rack')!;
    const p: Record<string, number> = {};
    for (const d of a.defaults) p[d.key] = d.value;
    return a.build({ ...p, ...over });
  };

  it('builds a closed solid at its defaults', () => {
    const r = rack();
    expect(health(r.mesh).closed).toBe(true);
    expect(health(r.mesh).manifold).toBe(true);
  });

  it('is sized so the default rack is not already overloaded', () => {
    // A default that fails its own check teaches people to ignore the warnings.
    const complaints = rack().warnings.filter((w) => /widen it|run hot|burn/.test(w));
    expect(complaints).toEqual([]);
  });

  it('says when the spine cannot carry the current the parts will draw', () => {
    // Current is the thing that decides a rack. Forty parts at 8 A each is 320 A, and
    // titanium carries about 1 A/mm² — a 10 mm spine is a quarter of what that needs.
    const r = rack({ spineWidth: 10, spineThickness: 3 });
    expect(r.warnings.join(' ')).toMatch(/spine is 30 mm².*320 A/s);
    expect(r.warnings.join(' ')).toMatch(/widen it/);
  });

  it('says when a contact tip is too thin to carry its part', () => {
    const r = rack({ tipDia: 1 });
    expect(r.warnings.join(' ')).toMatch(/contact tip/i);
    expect(r.warnings.join(' ')).toMatch(/burn/i);
  });

  it('says when the tiers are packed too close to drain', () => {
    const r = rack({ tiers: 20, spineHeight: 600 });
    expect(r.warnings.join(' ')).toMatch(/drain|bubbles/);
  });

  it('scales the part count with tiers and tips, and reports it', () => {
    expect(rack({ tiers: 3, tipsPerArm: 2 }).warnings.join(' ')).toMatch(/12 parts on 3 tiers/);
  });

  it('is titanium, because a steel rack would plate up every run', () => {
    expect(archetypeById('rack')!.material?.name).toMatch(/titanium/i);
  });
});

describe('choosing the right shape from a sentence', () => {
  // Adding shapes to the catalogue makes routing harder, not easier: every new alias is a
  // new way for an unrelated request to be captured. Adding "handle" sent "a cup with no
  // handle" to the handle, because "handle" is the longer word. These hold the two rules
  // that fix it — a negated noun is not what was asked for, and a noun after "with" is a
  // feature of the thing rather than the thing.
  it.each([
    ['make a cup with no handle', 'cup'],
    ['a mug with a handle', 'cup'],
    ['a handle', 'handle'],
    ['a door handle', 'handle'],
    ['a table without legs', 'table'],
    ['a box with no lid', 'box'],
    ['a desk lamp', 'lamp'],
    ['a coffee table', 'table'],
    ['a bracket with a hook', 'bracket'],
    ['a storage bin', 'tray'],
    ['a picture frame', 'frame'],
    ['a control knob', 'knob'],
    ['a funnel', 'funnel'],
    ['a wall hook', 'hook'],
  ])('%s builds a %s', (prompt, expected) => {
    const out = generateFromText(prompt);
    expect(out.ok, `"${prompt}" matched nothing`).toBe(true);
    if (!out.ok) return;
    expect(out.archetype.id).toBe(expected);
  });
});

describe('editing after the fact', () => {
  beforeEach(reset);

  it('rebuilds when a parameter changes, and undo puts it back', async () => {
    await build('make a cup');
    const doc = useModel.getState().doc;
    const feature = doc.features[0];
    const before = useModel.getState().evaluated.volume;

    useModel.getState().setParams(feature.id, { height: 140 });
    const after = useModel.getState().evaluated.volume;
    expect(after).not.toBeCloseTo(before, 3);

    useModel.getState().undo();
    expect(useModel.getState().evaluated.volume).toBeCloseTo(before, 3);
  });

  it('suppressing a feature removes its contribution and restores it', async () => {
    await build('a gearbox');
    const features = useModel.getState().doc.features;
    const last = features[features.length - 1];
    const before = useModel.getState().evaluated.volume;

    useModel.getState().toggleSuppressed(last.id);
    expect(useModel.getState().evaluated.volume).toBeLessThan(before);

    useModel.getState().toggleSuppressed(last.id);
    expect(useModel.getState().evaluated.volume).toBeCloseTo(before, 3);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSystemPrompt, decompose, readUnbuildable } from './decompose';
import { type ProviderConfig } from './providers';
import { constraintBrief } from '../lib/limits';
import { addFromDocument, clearExamples } from '../lib/training';
import { addFeature, emptyDocument } from '../model/document';

/**
 * Model-routed decomposition.
 *
 * The failure this guards against is not a crash — it is a plan that parses perfectly and
 * describes the wrong object. "Make a Suzuki Mehran" came back as two cylinders and a box:
 * valid JSON, valid geometry, unrecognisable as a car. Three things caused it, and all three
 * are asserted here, because none of them announce themselves at runtime.
 */

const config: ProviderConfig = {
  id: 'groq',
  model: 'openai/gpt-oss-120b',
  apiKey: 'test-key',
  allowWebSearch: false,
};

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

/** A plan with enough real parts to survive validation. */
const CAR_PLAN = JSON.stringify({
  name: 'Suzuki Mehran',
  description: 'A small three-box hatchback.',
  envelope: { length: 3300, width: 1405, height: 1410 },
  components: [
    { id: 'body', name: 'Body shell', role: 'structure', shape: 'box',
      params: { length: 3300, width: 1405, height: 900 },
      placement: { x: 0, y: 0, z: 300, rx: 0, ry: 0, rz: 0 },
      material: 'Steel', density: 7.85, quantity: 1, operation: 'add', note: 'Published length.' },
    { id: 'wheel-fl', name: 'Front left wheel', role: 'running gear', shape: 'cylinder',
      params: { diameter: 530, height: 145 },
      placement: { x: 1100, y: -630, z: -265, rx: 0, ry: 90, rz: 0 },
      material: 'Rubber', density: 1.1, quantity: 1, operation: 'add', note: '145/70 R12.' },
  ],
  notes: ['Massing model.'],
});

afterEach(() => vi.unstubAllGlobals());

describe('the prompt asks for the object that was requested', () => {
  const prompt = buildSystemPrompt();

  it('scales the component count to the object, rather than capping it low', () => {
    // "Aim for 5 to 20 components" was the instruction, and a car obeyed it by being wrong.
    // A budget that suits a kettle cannot also suit a vehicle.
    expect(prompt).toMatch(/25 to 60/);
    expect(prompt).not.toMatch(/Aim for 5 to 20 components/);
  });

  it('names the failure mode explicitly', () => {
    // Models follow concrete prohibitions far better than abstract quality bars.
    expect(prompt).toMatch(/three components is not a car/i);
  });

  it('refuses to let symmetry collapse the part count', () => {
    // "Four wheels" as one component is how a car becomes a box with two cylinders.
    expect(prompt).toMatch(/Four wheels are four/i);
  });

  it('states the manufacturing limits rather than leaving them to the linter', () => {
    // Everything here was previously enforced only after the part existed, which meant the
    // planner learned each rule by being corrected — a round trip the user waits for.
    expect(prompt).toContain('MANUFACTURING LIMITS');
    expect(prompt).toContain(constraintBrief());
  });

  it('puts the limits after the reference dimensions, not before them', () => {
    // Reference figures decide what the object *is* and must be in hand first; the limits
    // decide whether a chosen number may stand, which is the last judgement made.
    const withReference = buildSystemPrompt('REFERENCE DIMENSIONS\n- a bearing is 22 mm');
    expect(withReference.indexOf('REFERENCE DIMENSIONS'))
      .toBeLessThan(withReference.indexOf('MANUFACTURING LIMITS'));
  });

  it('tells the model to build what was asked and flag the breach, not to override silently', () => {
    expect(prompt).toMatch(/follow the\s+request and say in "notes"/);
  });
});

describe('learning from the organisation\'s own parts', () => {
  beforeEach(() => clearExamples());
  afterEach(() => clearExamples());

  it('puts a relevant taught example in front of the planner', async () => {
    const doc = addFeature(emptyDocument('Motor bracket'), 'box',
      { length: 120, width: 60, height: 8 }, 'Base plate');
    expect(addFromDocument('a mounting bracket for a motor', doc).ok).toBe(true);

    const systems: string[] = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
      systems.push(body.messages.find((m) => m.role === 'system')?.content ?? '');
      return ++n === 1 ? reply('IDENTITY — a bracket. PARTS — 1. Plate') : reply(CAR_PLAN);
    }));

    const result = await decompose('a mounting bracket', { config, preferModel: true });

    expect(result.ok).toBe(true);
    // The plan call — not the study call — is the one that has to see the worked answers.
    expect(systems[1]).toContain('WORKED EXAMPLES');
    expect(systems[1]).toContain('a mounting bracket for a motor');

    // And the user is told which of their parts steered it, so a bad example can be found.
    expect(result.ok && result.message).toContain('Guided by your own part');
  });

  it('says nothing about examples when none is relevant to the request', async () => {
    const doc = addFeature(emptyDocument('Cover'), 'box', { length: 40 }, 'Panel');
    addFromDocument('a cover panel', doc);

    const systems: string[] = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
      systems.push(body.messages.find((m) => m.role === 'system')?.content ?? '');
      return ++n === 1 ? reply('IDENTITY — a gearbox. PARTS — 1. Case') : reply(CAR_PLAN);
    }));

    // An irrelevant example is worse than none: the model would try to follow it.
    await decompose('a gearbox', { config, preferModel: true });
    expect(systems[1]).not.toContain('WORKED EXAMPLES');
  });
});

describe('reasoning before formatting', () => {
  it('studies the object first, then asks for JSON carrying that study', async () => {
    const calls: { system: string; user: string; maxTokens: number }[] = [];

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        messages: { role: string; content: string }[]; max_tokens: number;
      };
      calls.push({
        system: body.messages.find((m) => m.role === 'system')?.content ?? '',
        user: body.messages.find((m) => m.role === 'user')?.content ?? '',
        maxTokens: body.max_tokens,
      });

      // The study, then the plan, then the look at what was built.
      return calls.length === 1
        ? reply('IDENTITY — a Suzuki Mehran is a 3300 mm hatchback.\n' +
                'PARTS — 1. Body shell 2. Four wheels 3. Windscreen 4. Bumpers')
        : reply(CAR_PLAN);
    }));

    const result = await decompose('make a suzuki mehran', { config, preferModel: true });

    expect(result.ok).toBe(true);
    // The study, the plan, and the look at what was built.
    expect(calls).toHaveLength(3);

    // The first call asks what the thing is — in prose, with no schema to satisfy.
    expect(calls[0].system).toMatch(/mechanical engineer identifying an object/i);
    expect(calls[0].system).toMatch(/IDENTITY/);
    expect(calls[0].system).not.toMatch(/JSON SHAPE/);

    // The second call is handed that answer and told to transcribe it, not to re-derive it.
    expect(calls[1].user).toContain('Suzuki Mehran is a 3300 mm hatchback');
    expect(calls[1].user).toMatch(/Do not reduce the part count/i);
    expect(calls[1].system).toMatch(/JSON SHAPE/);
  });

  it('asks for enough tokens to express a whole vehicle', async () => {
    const budgets: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { max_tokens: number };
      budgets.push(body.max_tokens);
      return budgets.length === 1 ? reply('IDENTITY — a car. PARTS — 1. Body 2. Wheels') : reply(CAR_PLAN);
    }));

    await decompose('make a car', { config, preferModel: true });

    // 4 000 truncated a 40-part plan partway down the list, and a truncated plan is a small
    // plan — which is indistinguishable from the model having decided on few parts.
    expect(budgets[1]).toBeGreaterThanOrEqual(8000);
  });

  it('still produces a plan when the study call fails', async () => {
    // The study is an improvement, not a dependency. Losing the whole request because the
    // optional pass failed would trade a plainer answer for no answer.
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      return n === 1
        ? new Response('{"error":{"message":"rate limited"}}', { status: 429 })
        : reply(CAR_PLAN);
    }));

    const result = await decompose('make a car', { config, preferModel: true });

    expect(result.ok).toBe(true);
    // The failed study, the plan, and the look at what it built.
    expect(n).toBe(3);
  });
});

describe('one part, written as a program', () => {
  /*
   * The route that removes the catalogue's ceiling. A crankshaft has no archetype and never
   * will; a decomposition of one into cylinders is not a crankshaft. The script route answers
   * it with a feature tree instead, and is reached on the study's own verdict rather than on
   * a keyword rule — nothing about the words says a gearbox is an assembly and a crankshaft
   * is not.
   */
  const SCRIPT = [
    'param L = 300',
    'param D = 40',
    'cylinder Journal diameter=D height=L',
    'hole Oilway diameter=6 holeType=through pattern=single x=0 y=0',
  ].join('\n');

  it('is used when the study says the object is one piece', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        messages: { role: string; content: string | { type: string; text?: string }[] }[];
      };
      const content = body.messages.find((m) => m.role === 'user')?.content ?? '';
      // A review carries images beside its text, so the content is an array rather than a
      // string. Flattened to the words, which is what these assertions are about.
      calls.push(typeof content === 'string'
        ? content
        : content.filter((c) => c.type === 'text').map((c) => c.text).join(''));

      return calls.length === 1
        ? reply('IDENTITY — a crankshaft for a small four-cylinder engine, about 300 mm long.'
                + '\nMAKE — ONE-PART')
        : reply(SCRIPT);
    }));

    const result = await decompose('a crankshaft', { config, preferModel: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.route).toBe('model');
    expect(result.script).toContain('cylinder');
    expect(result.doc.features.map((f) => f.kind)).toEqual(['cylinder', 'hole']);

    // Three calls: the study, the script, and the look at what it built. No plan call at all.
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain('DatumScript');
    expect(calls[2]).toContain('Here is what was built');
  });

  it('shows the finished part to the model before accepting it', async () => {
    /*
     * Everything else judges the part by reading its description. A script that parses,
     * builds and closes can still be recognisably not the thing that was asked for, and the
     * only check that catches that is looking.
     */
    const images: number[] = [];
    let n = 0;

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        messages: { role: string; content: unknown }[];
      };
      const user = body.messages.find((m) => m.role === 'user');
      images.push(Array.isArray(user?.content)
        ? (user.content as { type: string }[]).filter((c) => c.type === 'image_url').length
        : 0);

      n += 1;
      if (n === 1) {
        return reply('IDENTITY — a spacer turned from bar, about 40 mm long.'
          + '\nMAKE — ONE-PART');
      }
      if (n === 2) return reply(SCRIPT);
      return reply('{"verdict":"matches","notes":[]}');
    }));

    const result = await decompose('a spacer', { config, preferModel: true });

    expect(result.ok).toBe(true);
    // The study and the script carry no images; the review carries one per view.
    expect(images[0]).toBe(0);
    expect(images[1]).toBe(0);
    expect(images[2]).toBe(4);
  });

  it('is skipped when the study says the object is an assembly', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
      calls.push(body.messages.find((m) => m.role === 'user')?.content ?? '');
      return calls.length === 1
        ? reply('IDENTITY — a car.\nPARTS — 1. Body 2. Wheels\nMAKE — ASSEMBLY')
        : reply(CAR_PLAN);
    }));

    const result = await decompose('make a car', { config, preferModel: true });

    expect(result.ok).toBe(true);
    // The study, the plan and the look at it — with nothing spent on a script that was never
    // going to be one.
    expect(calls).toHaveLength(3);
  });

  it('falls back to the plan when the script never builds', async () => {
    // A script the model cannot make build is not a reason to lose the request.
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
      calls.push(body.messages.find((m) => m.role === 'user')?.content ?? '');

      if (calls.length === 1) return reply('IDENTITY — an L-shaped mounting bracket in 6 mm steel, 80 mm on a side.'
        + '\nMAKE — ONE-PART');
      // Looks like a script — so the repair loop genuinely runs — and never parses.
      if (calls.length <= 4) return reply('box Body nonsense=1');
      return reply(CAR_PLAN);
    }));

    const result = await decompose('a bracket', { config, preferModel: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).not.toBeNull();
  });
});

describe('refusing what nothing here can express', () => {
  /*
   * The measured regression this closes. Offline, a request naming a shape the catalogue does
   * not have is refused by name. With a model configured it was not: the plan route asks a
   * model to decompose an object into components, a model asked to decompose complies, and
   * "a hydroformed titanium turbine volute with variable-section runners" came back as three
   * cylinders and a closed 300 cm³ solid.
   *
   * That failure is invisible to everything downstream — the mass is real, the drawing
   * dimensions it, the manufacturability rules pass it — which is exactly why the refusal has
   * to happen before any of them.
   */
  it('declines when the study says the shape needs something the kernel lacks', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
      calls.push(body.messages.find((m) => m.role === 'user')?.content ?? '');

      return reply(
        'IDENTITY — a turbine volute, a scroll casing whose cross-section changes along its path.'
        + '\nMAKE — ONE-PART'
        + '\nBUILDABLE — NO. Its form is a variable-section scroll, which needs a sweep whose '
        + 'profile changes along the path.',
      );
    }));

    const result = await decompose(
      'a hydroformed titanium turbine volute with variable-section runners',
      { config, preferModel: true },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // Named, so the refusal is something a person can act on.
    expect(result.message).toContain('variable-section');
    expect(result.message).toContain('lofts between two sections');

    // And it cost one call: nothing was spent trying to build it.
    expect(calls).toHaveLength(1);
  });

  it('builds when the study says the shape is expressible', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return reply(
          'IDENTITY — a mounting bracket in 6 mm steel, 80 mm on a side.'
          + '\nMAKE — ONE-PART'
          + '\nBUILDABLE — YES. A plate with holes and a bend.',
        );
      }
      if (n === 2) return reply('box Body length=80 width=80 height=6');
      return reply('{"verdict":"matches","notes":[]}');
    }));

    const result = await decompose('a bracket', { config, preferModel: true });
    expect(result.ok).toBe(true);
  });

  it('lets a request through when the study did not answer the question', async () => {
    /*
     * Conservative by construction. Losing a buildable part to a missing heading is worse than
     * building one that should have been declined: the second is visible and the first is not.
     */
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return reply('IDENTITY — a bracket in 6 mm steel, about 80 mm on a side.\nMAKE — ONE-PART');
      }
      if (n === 2) return reply('box Body length=80 width=80 height=6');
      return reply('{"verdict":"matches","notes":[]}');
    }));

    const result = await decompose('a bracket', { config, preferModel: true });
    expect(result.ok).toBe(true);
  });

  it('reads only an explicit NO as an objection', () => {
    expect(readUnbuildable('BUILDABLE — YES. A plate with holes.')).toBeNull();
    expect(readUnbuildable('IDENTITY — a thing.')).toBeNull();
    expect(readUnbuildable('BUILDABLE - NO. It needs an aerofoil.')).toContain('aerofoil');
    // A bare NO still refuses, with something to say.
    expect(readUnbuildable('BUILDABLE: NO')).toBeTruthy();
  });
});

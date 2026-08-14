import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSystemPrompt, decompose } from './decompose';
import { type ProviderConfig } from './providers';

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

      // First call is the study, second is the plan.
      return calls.length === 1
        ? reply('IDENTITY — a Suzuki Mehran is a 3300 mm hatchback.\n' +
                'PARTS — 1. Body shell 2. Four wheels 3. Windscreen 4. Bumpers')
        : reply(CAR_PLAN);
    }));

    const result = await decompose('make a suzuki mehran', { config, preferModel: true });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);

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
    expect(n).toBe(2);
  });
});

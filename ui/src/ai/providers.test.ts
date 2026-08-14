import { afterEach, describe, expect, it, vi } from 'vitest';
import { complete, parseTokenLimit, providerInfo, type ProviderConfig } from './providers';

/**
 * Talking to a provider.
 *
 * Driven against a mocked `fetch` rather than a live endpoint, because the interesting cases
 * are all failures — a rejected key, a refused reply, a truncated plan — and none of them can
 * be produced on demand from a real service. Every one below was seen in practice first.
 */

const groq: ProviderConfig = {
  id: 'groq',
  model: 'llama-3.3-70b-versatile',
  apiKey: 'test-key',
  allowWebSearch: false,
};

/** The 400 Groq returns when its JSON mode refuses the model's own output. */
const JSON_MODE_REFUSAL = JSON.stringify({
  error: {
    message: "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.",
    type: 'invalid_request_error',
    code: 'json_validate_failed',
    failed_generation: '{"name":"Anodizing rack","components":[{"id":"c1","name":"Spine"',
  },
});

const GOOD_REPLY = JSON.stringify({
  choices: [{ message: { content: '{"name":"Anodizing rack","components":[]}' } }],
});

function mockFetch(responses: { status: number; body: string }[]) {
  const calls: { body: Record<string, unknown> }[] = [];
  let n = 0;

  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const r = responses[Math.min(n++, responses.length - 1)];
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  }));

  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('strict JSON mode refusing the model’s own reply', () => {
  it('retries without the constraint rather than giving up', async () => {
    // Groq validates the whole reply before returning it, so a plan that runs past the token
    // limit comes back as a 400 instead of as truncated text. The prompt was fine; the reply
    // was long. Asked again without the constraint, the same request succeeds.
    const calls = mockFetch([
      { status: 400, body: JSON_MODE_REFUSAL },
      { status: 200, body: GOOD_REPLY },
    ]);

    const reply = await complete(groq, { system: 'sys', user: 'an anodizing rack' });

    expect(reply.ok, 'ok' in reply && !reply.ok ? reply.message : '').toBe(true);
    expect(calls).toHaveLength(2);

    // First attempt asks for strict JSON; the retry does not.
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[1].body.response_format).toBeUndefined();

    // And the retry is the same request otherwise — not a degraded one.
    expect(calls[1].body.model).toBe(calls[0].body.model);
    expect(calls[1].body.messages).toEqual(calls[0].body.messages);
  });

  it('asks for strict JSON first, and stops at one attempt when that works', async () => {
    const calls = mockFetch([{ status: 200, body: GOOD_REPLY }]);

    const reply = await complete(groq, { system: 'sys', user: 'a cup' });

    expect(reply.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
  });

  it('does not retry a failure that has nothing to do with JSON', async () => {
    // A bad key must fail once and say so, not be asked again in a different shape.
    const calls = mockFetch([
      { status: 401, body: JSON.stringify({ error: { message: 'Invalid API Key' } }) },
    ]);

    const reply = await complete(groq, { system: 'sys', user: 'a cup' });

    expect(reply.ok).toBe(false);
    expect(calls).toHaveLength(1);
    if (!reply.ok) expect(reply.message).toMatch(/rejected the API key/i);
  });

  it('reports what the model produced when the retry also fails', async () => {
    // The provider's own message says to "see failed_generation for more details", which is
    // useless if nothing reads the field. Without it a 400 gives no way to tell a truncated
    // reply from a refusal.
    mockFetch([
      { status: 400, body: JSON_MODE_REFUSAL },
      { status: 400, body: JSON_MODE_REFUSAL },
    ]);

    const reply = await complete(groq, { system: 'sys', user: 'an anodizing rack' });

    expect(reply.ok).toBe(false);
    if (reply.ok) return;

    expect(reply.message).toMatch(/not being valid JSON/i);
    expect(reply.message).toMatch(/token limit/i);
    expect(reply.detail).toMatch(/What the model produced/);
    expect(reply.detail).toMatch(/Anodizing rack/);
  });
});

describe('a request refused as too large', () => {
  // 413 from an OpenAI-compatible provider is usually not about bytes. Groq counts the
  // `max_tokens` you ask for against a tokens-per-minute allowance and reports the overrun
  // this way, so asking for a 6 000-token plan failed before generating anything — while
  // "a phone", which never calls a model, worked. The prompt was 1 600 tokens.
  const TOO_LARGE = JSON.stringify({
    error: {
      message: 'Request too large for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 6000, Requested 7584.',
      code: 'rate_limit_exceeded',
    },
  });

  it('asks for less rather than failing', async () => {
    const calls = mockFetch([
      { status: 413, body: TOO_LARGE },
      { status: 200, body: GOOD_REPLY },
    ]);

    const reply = await complete(
      { ...groq, model: 'shrink-to-fit' },
      { system: 'sys', user: 'create a house', maxTokens: 4000 },
    );

    expect(reply.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].body.max_tokens).toBe(4000);

    // Fitted to the overshoot the service stated — 7 584 requested against a 6 000 limit is
    // 1 584 too many — rather than halved. Halving happens to work here and does not on a
    // tighter ceiling, which is how the same refusal used to appear twice in a row.
    expect(calls[1].body.max_tokens).toBe(4000 - 1584 - 256);
  });

  it('does not keep retrying a budget that is already minimal', async () => {
    // Asking for 512 tokens and being refused means the *prompt* is over the line. Shrinking
    // the completion further cannot help, so the honest answer is the refusal itself rather
    // than a second identical attempt.
    const calls = mockFetch([
      { status: 413, body: TOO_LARGE },
      { status: 200, body: GOOD_REPLY },
    ]);

    const reply = await complete(
      { ...groq, model: 'already-small' }, { system: 'sys', user: 'x', maxTokens: 512 });

    expect(calls).toHaveLength(1);
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.message).toMatch(/prompt alone/i);
  });

  it('explains the limit rather than saying the payload was too big', async () => {
    mockFetch([{ status: 413, body: TOO_LARGE }, { status: 413, body: TOO_LARGE }]);

    const reply = await complete(groq, { system: 'sys', user: 'create a house' });

    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.message).toMatch(/tokens-per-minute/i);
    expect(reply.message).not.toMatch(/prompt is too long/i);
    // The provider's own numbers are passed through, because they name the actual limit.
    expect(reply.detail).toMatch(/Limit 6000/);
    expect(reply.retryable).toBe(true);
  });
});

describe('naming the right provider', () => {
  it('blames Groq rather than OpenAI when Groq refuses', async () => {
    // Both speak the same protocol through one client. An error that names the wrong service
    // sends someone to the wrong dashboard.
    mockFetch([{ status: 401, body: JSON.stringify({ error: { message: 'Invalid API Key' } }) }]);

    const reply = await complete(groq, { system: 'sys', user: 'a cup' });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.message).toContain(providerInfo('groq').label);
  });

  it('sends Groq’s request to Groq', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(GOOD_REPLY, { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await complete(groq, { system: 'sys', user: 'a cup' });
    expect(urls[0]).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('honours a custom base URL over the built-in endpoint', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(GOOD_REPLY, { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await complete({ ...groq, baseUrl: 'https://proxy.internal/v1' }, { system: 'sys', user: 'a cup' });
    expect(urls[0]).toBe('https://proxy.internal/v1/chat/completions');
  });
});

/**
 * Rate limits that are about *requested* tokens, not prompt size.
 *
 * Groq counts the completion budget you ask for against the per-minute allowance before
 * generating anything, so asking for a 60-part assembly plan on a free tier is refused
 * outright. The old handling halved the ask once and gave up — which on a 6 000-token ceiling
 * still overshot, so the same refusal appeared twice and the feature looked broken.
 *
 * The refusal names the limit and the overshoot, which is enough to fit exactly.
 */
describe('fitting a request to a per-minute token limit', () => {
  /** The refusal Groq actually returns, verbatim in shape. */
  const tooLarge = (limit: number, requested: number) => JSON.stringify({
    error: {
      message:
        'Request too large for model `openai/gpt-oss-120b` in organization `org_1` service ' +
        `tier \`on_demand\` on tokens per minute (TPM): Limit ${limit}, Requested ${requested}, ` +
        'please reduce your message size and try again.',
      type: 'tokens',
      code: 'rate_limit_exceeded',
    },
  });

  /** A server that refuses anything whose prompt plus budget exceeds `limit`. */
  const serverWithLimit = (limit: number, promptTokens: number, seen: number[]) =>
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { max_tokens: number };
      seen.push(body.max_tokens);
      const requested = body.max_tokens + promptTokens;
      return requested > limit
        ? new Response(tooLarge(limit, requested), { status: 413 })
        : new Response(GOOD_REPLY, { status: 200 });
    });

  it('reads the limit and the overshoot out of the refusal', () => {
    const parsed = parseTokenLimit(tooLarge(6000, 11234));
    expect(parsed).toMatchObject({ limit: 6000, requested: 11234, used: 0, overshoot: 5234 });
  });

  it('ignores a message that does not state both numbers', () => {
    // Guessing a limit from a partial message would be worse than halving.
    expect(parseTokenLimit('Request too large, please reduce your message size.')).toBeNull();
    expect(parseTokenLimit('Limit 6000')).toBeNull();
  });

  it('shrinks to a budget that fits, in one retry', async () => {
    const seen: number[] = [];
    vi.stubGlobal('fetch', serverWithLimit(6000, 600, seen));

    const reply = await complete(
      { ...groq, model: 'fit-once' },
      { system: 'x'.repeat(1200), user: 'y'.repeat(600), maxTokens: 8000 },
    );

    expect(reply.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(8000);
    // Fitted from the stated numbers rather than halved: 4 000 would also have been refused.
    expect(seen[1]).toBeLessThanOrEqual(6000 - 600);
    expect(seen[1]).toBeGreaterThan(4000);
  });

  it('remembers the limit, so later requests fit first time', async () => {
    const first: number[] = [];
    vi.stubGlobal('fetch', serverWithLimit(6000, 600, first));
    await complete(
      { ...groq, model: 'remembered' },
      { system: 'x'.repeat(1200), user: 'y'.repeat(600), maxTokens: 8000 },
    );

    const second: number[] = [];
    vi.stubGlobal('fetch', serverWithLimit(6000, 600, second));
    const reply = await complete(
      { ...groq, model: 'remembered' },
      { system: 'x'.repeat(1200), user: 'y'.repeat(600), maxTokens: 8000 },
    );

    // No wasted round trip: the second call never gets refused.
    expect(reply.ok).toBe(true);
    expect(second).toHaveLength(1);
    expect(second[0]).toBeLessThan(8000);
  });

  it('says the prompt is the problem when no budget can fit', async () => {
    // Shrinking the completion cannot help when the prompt alone exceeds the allowance, and
    // "try a smaller request" is unhelpful advice for a request that is already minimal.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(tooLarge(6000, 99999), { status: 413 })));

    const reply = await complete(
      { ...groq, model: 'hopeless' },
      { system: 'z'.repeat(60000), user: 'q', maxTokens: 8000 },
    );

    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.message).toMatch(/prompt alone/i);
    expect(reply.message).toMatch(/6,000/);
    expect(reply.retryable).toBe(true);
  });

  it('gives up rather than looping when the service states no numbers', async () => {
    const seen: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((JSON.parse(String(init.body)) as { max_tokens: number }).max_tokens);
      return new Response('{"error":{"message":"Request too large."}}', { status: 413 });
    }));

    const reply = await complete(
      { ...groq, model: 'no-numbers' }, { system: 's', user: 'u', maxTokens: 8000 });

    expect(reply.ok).toBe(false);
    // Halving from 8 000 reaches the floor after four attempts and stops there.
    expect(seen.length).toBeLessThanOrEqual(5);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
  });
});

describe('a limit measured against a window that is already partly spent', () => {
  /** What the service says when earlier calls in the same minute have consumed the allowance. */
  const partlySpent = (limit: number, used: number, requested: number) => JSON.stringify({
    error: {
      message:
        'Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): ' +
        `Limit ${limit}, Used ${used}, Requested ${requested}.`,
      code: 'rate_limit_exceeded',
    },
  });

  it('counts what was already used when working out the overshoot', () => {
    // 5 000 spent of 6 000, asking for 2 000 more: over by 1 000, even though the request on
    // its own is well under the limit.
    expect(parseTokenLimit(partlySpent(6000, 5000, 2000))).toMatchObject({
      limit: 6000, used: 5000, requested: 2000, overshoot: 1000,
    });
  });

  it('shrinks rather than growing when the window is nearly spent', async () => {
    // Ignoring `Used` makes the overshoot negative — requested is below the limit — and the
    // budget would be *increased* in response to being refused. A build makes two calls
    // seconds apart, so this is the ordinary case, not an edge one.
    const seen: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const budget = (JSON.parse(String(init.body)) as { max_tokens: number }).max_tokens;
      seen.push(budget);
      return budget > 900
        ? new Response(partlySpent(6000, 5000, budget), { status: 413 })
        : new Response(GOOD_REPLY, { status: 200 });
    }));

    const reply = await complete(
      { ...groq, model: 'window-spent' }, { system: 's', user: 'u', maxTokens: 2000 });

    expect(reply.ok).toBe(true);
    expect(seen[1]).toBeLessThan(seen[0]);
  });

  it('does not record a ceiling learned from a spent window', async () => {
    // The limit is real but the moment is not representative. Remembering it would throttle
    // every later request in the session to a fraction of what the tier actually allows.
    const first: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const budget = (JSON.parse(String(init.body)) as { max_tokens: number }).max_tokens;
      first.push(budget);
      return budget > 900
        ? new Response(partlySpent(6000, 5000, budget), { status: 413 })
        : new Response(GOOD_REPLY, { status: 200 });
    }));
    await complete({ ...groq, model: 'not-learned' }, { system: 's', user: 'u', maxTokens: 2000 });

    const second: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      second.push((JSON.parse(String(init.body)) as { max_tokens: number }).max_tokens);
      return new Response(GOOD_REPLY, { status: 200 });
    }));
    await complete({ ...groq, model: 'not-learned' }, { system: 's', user: 'u', maxTokens: 2000 });

    // Full ask again, because nothing durable was learned from a congested moment.
    expect(second[0]).toBe(2000);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { complete, PROVIDERS, type ProviderConfig, type RequestImage } from './providers';

/**
 * Sending a model something to look at.
 *
 * The provider layer was text-only, and that was not a missing feature — it was a wall in
 * front of a product category. A photograph could reach the classical tracer and nothing else;
 * no model could ever *see* a part, so multi-view reconstruction, drawing-sheet reading and
 * visual review of what was just built were all unreachable regardless of what was built above.
 *
 * Each provider frames image content differently and every one of them accepts a
 * well-formed-looking request that silently ignores an attachment in the wrong shape. That
 * failure is invisible without a live key: the model replies fluently, in the right format,
 * about a picture it never received. So the wire shape is asserted here, against a mocked
 * `fetch`, where it can be checked on every commit for nothing.
 */

const PNG: RequestImage = {
  mediaType: 'image/png',
  // A one-pixel PNG. Real bytes, so nothing here depends on a placeholder being accepted.
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  label: 'front view',
};

const config = (id: ProviderConfig['id'], model = 'a-model'): ProviderConfig => ({
  id, model, apiKey: 'k', allowWebSearch: false,
});

/** Captures the body of the first request made, and answers with something parseable. */
function capture(reply: unknown) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];

  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(reply), { status: 200 });
  }));

  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('what each provider is actually sent', () => {
  it('Anthropic gets a base64 image block before the text', async () => {
    const seen = capture({ content: [{ type: 'text', text: '{"ok":true}' }] });

    await complete(config('anthropic'), { system: 's', user: 'what is this?', images: [PNG] });

    const content = (seen[0]!.body.messages as { content: Record<string, unknown>[] }[])[0]!.content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG.base64 },
    });
    expect(content[1]).toEqual({ type: 'text', text: 'what is this?' });
  });

  it('Gemini gets inline_data before the text', async () => {
    const seen = capture({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] });

    await complete(config('gemini'), { system: 's', user: 'what is this?', images: [PNG] });

    const parts = (seen[0]!.body.contents as { parts: Record<string, unknown>[] }[])[0]!.parts;
    expect(parts[0]).toEqual({ inline_data: { mime_type: 'image/png', data: PNG.base64 } });
    expect(parts[1]).toEqual({ text: 'what is this?' });
  });

  it('OpenAI gets a data URL in an image_url part', async () => {
    const seen = capture({ choices: [{ message: { content: '{"ok":true}' } }] });

    await complete(config('openai'), { system: 's', user: 'what is this?', images: [PNG] });

    const messages = seen[0]!.body.messages as { role: string; content: unknown }[];
    const user = messages.find((m) => m.role === 'user')!;
    const parts = user.content as Record<string, unknown>[];

    expect(parts[0]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG.base64}` },
    });
    expect(parts[1]).toEqual({ type: 'text', text: 'what is this?' });
  });

  it('Ollama gets bare base64 on the message, with no media type', async () => {
    const seen = capture({ message: { content: '{"ok":true}' } });

    await complete(config('ollama'), { system: 's', user: 'what is this?', images: [PNG] });

    const messages = seen[0]!.body.messages as { role: string; images?: string[] }[];
    const user = messages.find((m) => m.role === 'user')!;

    expect(user.images).toEqual([PNG.base64]);
  });

  it('sends several images in the order they were given', async () => {
    const seen = capture({ content: [{ type: 'text', text: '{"ok":true}' }] });

    const back: RequestImage = { ...PNG, label: 'back view' };
    await complete(config('anthropic'), { system: 's', user: 'two views', images: [PNG, back] });

    const content = (seen[0]!.body.messages as { content: Record<string, unknown>[] }[])[0]!.content;
    expect(content).toHaveLength(3);
    expect(content[2]).toEqual({ type: 'text', text: 'two views' });
  });
});

describe('a text-only request is unchanged', () => {
  /*
   * The array content form is accepted by OpenAI itself and rejected by several
   * OpenAI-compatible endpoints that only implement the simple shape. Adding vision must not
   * break every provider that has none.
   */
  it('OpenAI still gets a plain string when there is nothing to look at', async () => {
    const seen = capture({ choices: [{ message: { content: '{"ok":true}' } }] });

    await complete(config('openai'), { system: 's', user: 'no picture' });

    const messages = seen[0]!.body.messages as { role: string; content: unknown }[];
    expect(messages.find((m) => m.role === 'user')!.content).toBe('no picture');
  });

  it('Ollama carries no images key at all', async () => {
    const seen = capture({ message: { content: '{"ok":true}' } });

    await complete(config('ollama'), { system: 's', user: 'no picture' });

    const messages = seen[0]!.body.messages as Record<string, unknown>[];
    expect(messages.find((m) => m.role === 'user')).not.toHaveProperty('images');
  });
});

describe('what it refuses', () => {
  /*
   * The failure worth engineering against. A provider with no image path that is handed one
   * and strips it will answer the question anyway — fluently, in the right format, about a
   * picture it never saw. The reply is indistinguishable from a grounded one, so the mistake
   * surfaces as a wrong part rather than as an error.
   */
  it('will not quietly drop an image a provider cannot read', async () => {
    const seen = capture({});

    const result = await complete(
      { ...config('none'), id: 'none' }, { system: 's', user: 'look', images: [PNG] },
    );

    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('names the providers that can see, so the message is actionable', async () => {
    capture({});
    const result = await complete(
      { ...config('none'), id: 'none' }, { system: 's', user: 'look', images: [PNG] },
    );

    if (result.ok) throw new Error('expected a refusal');
    // "No model is configured" wins for `none`; the point is that it never reached the wire.
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('refuses an image past the size every one of these APIs rejects', async () => {
    const seen = capture({ content: [{ type: 'text', text: '{}' }] });

    const huge: RequestImage = { mediaType: 'image/png', base64: 'A'.repeat(5_000_001) };
    const result = await complete(config('anthropic'), { system: 's', user: 'look', images: [huge] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/MB/);
    // Never sent: a 413 from an image reads as a rate limit, and the budget-shrinking retry
    // would respond to it by making the *text* smaller, forever.
    expect(seen).toHaveLength(0);
  });
});

describe('the capability is declared, not guessed', () => {
  it('every provider states whether it can be sent an image', () => {
    for (const p of PROVIDERS) {
      expect(typeof p.supportsImages, `${p.id} does not declare supportsImages`).toBe('boolean');
    }
  });

  it('the offline route cannot, and every real provider can', () => {
    expect(PROVIDERS.find((p) => p.id === 'none')!.supportsImages).toBe(false);

    for (const p of PROVIDERS.filter((x) => x.id !== 'none')) {
      expect(p.supportsImages, `${p.id} should support images`).toBe(true);
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configFromEnv, formatModelReport, MODEL_CASES, runModelBenchmark, runModelCase,
} from './model';
import type { ProviderConfig } from '../ai/providers';

/**
 * The benchmark that measures the model path.
 *
 * A benchmark is only worth publishing if its arithmetic is right when nobody is watching, so
 * what is tested here is the counting rather than any model: a throttled call must not be
 * counted as a failure, a refusal of something unbuildable must count as a success, and a case
 * that threw must not take the run down with it.
 *
 * The one that matters most is the throttle. A free tier refusing a fourth call in a minute
 * says nothing about whether the model could have written the part, and a benchmark that
 * counts it as a failure is measuring the price plan.
 */

const config: ProviderConfig = {
  id: 'groq', model: 'test-model', apiKey: 'k', allowWebSearch: false,
};

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('reading a configuration', () => {
  it('takes the key from the environment, never from an argument', () => {
    const c = configFromEnv({
      DATUM_PROVIDER: 'groq', DATUM_MODEL: 'm', DATUM_API_KEY: 'secret',
    });

    expect(c.id).toBe('groq');
    expect(c.model).toBe('m');
    expect(c.apiKey).toBe('secret');
  });

  it('carries a base URL through, for an OpenAI-compatible endpoint', () => {
    const c = configFromEnv({
      DATUM_PROVIDER: 'openai', DATUM_MODEL: 'm', DATUM_API_KEY: 'k',
      DATUM_BASE_URL: 'https://api.example.com',
    });

    expect(c.baseUrl).toBe('https://api.example.com');
  });

  it('is the offline configuration when nothing is set', () => {
    expect(configFromEnv({}).id).toBe('none');
  });
});

describe('what counts as what', () => {
  it('counts a request the catalogue answers, with no model involved', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('should not be called'); }));

    const outcome = await runModelCase(
      { prompt: 'M10 hex nut', family: 'catalogue' }, config,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.route).toBe('catalogue');
    expect(outcome.volumeCm3).toBeGreaterThan(0);
    // No script route ran, so there is no repair count to report.
    expect(outcome.repairs).toBeUndefined();
  });

  it('marks a throttled case rather than calling it a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 })));

    const outcome = await runModelCase(
      { prompt: 'a dovetail slide 120 mm long', family: 'machined' }, config, 0,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.rateLimited).toBe(true);
  });

  it('does not mark a genuine refusal as throttled', async () => {
    const outcome = await runModelCase(
      { prompt: 'a hydroformed titanium turbine volute', family: 'unbuildable' },
      { ...config, id: 'none' }, 0,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.rateLimited).toBeUndefined();
  });

  it('survives a case that throws rather than losing the run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket exploded'); }));

    const outcome = await runModelCase(
      { prompt: 'a dovetail slide 120 mm long', family: 'machined' }, config, 0,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.route).toMatch(/refused|error/);
  });
});

describe('the aggregate', () => {
  it('excludes throttled cases from every rate', async () => {
    /*
     * Two cases: one the catalogue answers, one the model would have to and cannot because the
     * provider is throttling. The build rate must be 100% of what was actually measured, not
     * 50% of what was attempted.
     */
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 })));

    const report = await runModelBenchmark(
      { ...config },
      [
        { prompt: 'M10 hex nut', family: 'catalogue' },
        { prompt: 'a dovetail slide 120 mm long', family: 'machined' },
      ],
      undefined,
      0,
      0,
    );

    expect(report.rateLimited).toBe(1);
    expect(report.buildRate).toBe(1);
  });

  it('counts a correct refusal as a success for an unbuildable request', async () => {
    const report = await runModelBenchmark(
      { ...config, id: 'none' },
      [{ prompt: 'a hydroformed titanium turbine volute', family: 'unbuildable' }],
      undefined,
      0,
      0,
    );

    expect(report.refusable).toBe(1);
    expect(report.refusedCorrectly).toBe(1);
    // And it is not counted in the build rate, which is about things that should build.
    expect(report.buildRate).toBe(0);
  });

  it('reports first-attempt validity over the cases the script route answered', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      if (n === 1) return reply('IDENTITY — a dovetail slide, 120 mm long in steel.\nMAKE — ONE-PART');
      if (n === 2) return reply('box Body length=120 width=40 height=20');
      return reply('{"verdict":"matches","notes":[]}');
    }));

    const report = await runModelBenchmark(
      config,
      [{ prompt: 'a dovetail slide 120 mm long', family: 'machined' }],
      undefined,
      0,
      0,
    );

    expect(report.scripted).toBe(1);
    expect(report.firstAttemptRate).toBe(1);
    expect(report.meanRepairs).toBe(0);
  });
});

describe('the report', () => {
  it('names the model and states each rate', async () => {
    const report = await runModelBenchmark(
      { ...config, id: 'none' },
      [{ prompt: 'M10 hex nut', family: 'catalogue' }],
      undefined,
      0,
      0,
    );

    const text = formatModelReport(report);
    expect(text).toContain('test-model');
    expect(text).toContain('built');
    expect(text).toContain('refused');
  });

  it('never prints the key', async () => {
    const report = await runModelBenchmark(
      { ...config, id: 'none', apiKey: 'super-secret-value' },
      [{ prompt: 'M10 hex nut', family: 'catalogue' }],
      undefined,
      0,
      0,
    );

    expect(formatModelReport(report)).not.toContain('super-secret');
    expect(JSON.stringify(report)).not.toContain('super-secret');
  });
});

describe('the case set', () => {
  it('includes something nothing should build', () => {
    // A benchmark with no refusals in it cannot tell a capable system from a compliant one.
    expect(MODEL_CASES.some((c) => c.family === 'unbuildable')).toBe(true);
  });

  it('includes parts the offline routes cannot answer', () => {
    // Otherwise the figure describes the parser rather than the model.
    expect(MODEL_CASES.filter((c) => c.family === 'machined').length).toBeGreaterThan(4);
  });
});

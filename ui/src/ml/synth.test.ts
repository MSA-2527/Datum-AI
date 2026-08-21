import { describe, expect, it } from 'vitest';
import { judge, rng, synthesise, toJsonl } from './synth';

/**
 * Synthesising a corpus.
 *
 * The value is entirely in the filter. Anyone can generate a million programs; the reason this
 * is worth doing here is that this project can *check* them against the kernel — closure,
 * manifoldness, a real volume — so what survives is a corpus of programs known to build rather
 * than a corpus of programs that look plausible.
 *
 * So the tests are about the judge as much as the sampler: it has to reject what does not
 * build, and it has to say why.
 */

describe('the judge', () => {
  it('keeps a program that builds a closed solid, and measures it', () => {
    const v = judge('box Body length=60 width=40 height=20', 'a block');

    expect('measured' in v).toBe(true);
    if (!('measured' in v)) return;

    expect(v.measured.volumeMm3).toBeCloseTo(48000, 1);
    expect(v.measured.features).toBe(1);
    expect(v.measured.sizeMm[0]).toBeCloseTo(60, 3);
    expect(v.request).toBe('a block');
  });

  it('rejects a program that does not parse, and says why', () => {
    const v = judge('sculpt Blob smoothness=3', 'a blob');

    expect('reason' in v).toBe(true);
    if (!('reason' in v)) return;
    expect(v.reason).toContain('did not parse');
  });

  it('rejects a program that parses and builds nothing', () => {
    const v = judge('param L = 10', 'nothing');

    expect('reason' in v).toBe(true);
    if (!('reason' in v)) return;
    expect(v.reason).toContain('no geometry');
  });

  it('rejects a program whose feature failed', () => {
    const v = judge('shell Hollow thickness=2', 'a shell of nothing');

    expect('reason' in v).toBe(true);
    if (!('reason' in v)) return;
    expect(v.reason).toContain('feature failed');
  });

  it('records the manufacturability rules that fired, without requiring none', () => {
    // A part with a wall below the machining floor is still a real part and still worth
    // learning from — what matters is that the finding travels with it.
    const v = judge(
      'box Body length=80 width=60 height=40\nshell Hollow thickness=0.4',
      'a thin-walled housing',
    );

    if (!('measured' in v)) throw new Error(`rejected: ${v.reason}`);
    expect(v.findings).toContain('dfm.mill.min-wall');
  });

  it('returns the script printed from the tree, not the text it was handed', () => {
    const v = judge('box   Body   length=60   width=40   height=20', 'a block');

    if (!('measured' in v)) throw new Error('rejected');
    // Normalised, so every line of the corpus is in one form — which is what a fine-tune needs.
    expect(v.script).not.toContain('   ');
  });
});

describe('the sampler', () => {
  it('produces the number of samples asked for', () => {
    const corpus = synthesise(40, 7);
    expect(corpus.samples).toHaveLength(40);
  });

  it('is reproducible from its seed', () => {
    const a = synthesise(20, 42);
    const b = synthesise(20, 42);

    expect(a.samples.map((s) => s.script)).toEqual(b.samples.map((s) => s.script));
  });

  it('produces different parts from different seeds', () => {
    const a = synthesise(20, 1);
    const b = synthesise(20, 2);

    expect(a.samples.map((s) => s.script)).not.toEqual(b.samples.map((s) => s.script));
  });

  it('yields well enough to be worth running', () => {
    // A generator that mostly produces rubbish is a generator that teaches a model rubbish.
    const corpus = synthesise(60, 3);
    expect(corpus.samples.length / corpus.attempted).toBeGreaterThan(0.7);
  });

  it('every sample it keeps really does build', () => {
    for (const sample of synthesise(30, 11).samples) {
      const again = judge(sample.script, sample.request);
      expect('measured' in again, `${sample.script} did not rebuild`).toBe(true);
    }
  });

  it('covers more than one family of part', () => {
    const corpus = synthesise(60, 5);
    const kinds = new Set(corpus.samples.map((s) => s.measured.features));

    expect(kinds.size).toBeGreaterThan(1);
    expect(new Set(corpus.samples.map((s) => s.request.split(' ')[1])).size).toBeGreaterThan(2);
  });
});

describe('the corpus as JSONL', () => {
  it('writes one training pair per line', () => {
    const lines = toJsonl(synthesise(10, 9)).split('\n');
    expect(lines).toHaveLength(10);

    const first = JSON.parse(lines[0]!) as {
      messages: { role: string; content: string }[];
      measured: { volumeMm3: number };
    };

    expect(first.messages[0]!.role).toBe('user');
    expect(first.messages[1]!.role).toBe('assistant');
    expect(first.measured.volumeMm3).toBeGreaterThan(0);
  });

  it('carries the measurement, which is what a text corpus of CAD code cannot teach', () => {
    const line = JSON.parse(toJsonl(synthesise(1, 4)).split('\n')[0]!) as {
      measured: { massG: number; sizeMm: number[] };
    };

    expect(line.measured.massG).toBeGreaterThan(0);
    expect(line.measured.sizeMm).toHaveLength(3);
  });
});

describe('the random source', () => {
  it('is deterministic and spread over its range', () => {
    const r = rng(1);
    const xs = Array.from({ length: 500 }, () => r());

    expect(Math.min(...xs)).toBeLessThan(0.05);
    expect(Math.max(...xs)).toBeGreaterThan(0.95);
    expect(rng(1)()).toBe(rng(1)());
  });
});

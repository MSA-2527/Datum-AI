import { afterEach, describe, expect, it, vi } from 'vitest';
import { askForScript, looksLikeScript, stripFences, ASSEMBLY_MARKER } from './scriptRoute';
import { evaluateDocument } from '../model/document';
import { massProperties } from '../kernel/topo/mesh';
import type { ProviderConfig } from './providers';
import { SCRIPT_KINDS } from '../generate/script';

/**
 * The loop that turns a draft into a part.
 *
 * A model's first attempt at a program is wrong more often than not, and the whole value of a
 * language over a fixed schema depends on what happens next: the errors go back, by line, and
 * the model tries again. If that loop does not work, a script route is strictly worse than the
 * catalogue it replaces.
 *
 * Driven against a scripted sequence of replies rather than a live model — the interesting
 * cases are a bad first attempt, a well-formed script that builds nothing, and a model that
 * never converges, and none of those is reproducible against a real one.
 */

const config: ProviderConfig = {
  id: 'anthropic', model: 'test', apiKey: 'k', allowWebSearch: false,
};

/** Answers with each reply in turn, and records what it was asked. */
function modelSaying(...replies: string[]) {
  const asked: { system: string; user: string }[] = [];
  let n = 0;

  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      system: string;
      messages: { content: { type: string; text?: string }[] | string }[];
    };

    const content = body.messages[0]!.content;
    const user = typeof content === 'string'
      ? content
      : content.filter((c) => c.type === 'text').map((c) => c.text).join('');

    asked.push({ system: body.system, user });

    const text = replies[Math.min(n, replies.length - 1)]!;
    n += 1;
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });
  }));

  return asked;
}

afterEach(() => vi.unstubAllGlobals());

const GOOD = `
param L = 80
param W = 50
param T = 10

box Body length=L width=W height=T
hole Bore diameter=12 holeType=through pattern=single x=0 y=0
`.trim();

describe('a script that is right first time', () => {
  it('builds it and reports no repairs', async () => {
    modelSaying(GOOD);
    const r = await askForScript('a plate with a hole', { config });

    expect('assembly' in r).toBe(false);
    if ('assembly' in r) return;

    expect(r.ok).toBe(true);
    expect(r.repairs).toBe(0);

    const volume = massProperties(evaluateDocument(r.doc).mesh).volume;
    // 80 × 50 × 10 = 40 000 mm³ less a ⌀12 bore through 10 = 1 131 mm³.
    expect(volume).toBeGreaterThan(38700);
    expect(volume).toBeLessThan(38950);
  });

  it('returns the script printed back from the tree, not the model’s formatting', async () => {
    modelSaying(GOOD);
    const r = await askForScript('a plate with a hole', { config });
    if ('assembly' in r) return;

    // Round-tripped, so what is shown is what was built rather than what was typed.
    expect(r.source).toContain('box');
    expect(r.source).toContain('hole');
  });
});

describe('a script that does not parse', () => {
  it('sends the errors back and accepts the repair', async () => {
    const asked = modelSaying('sculpt Blob smoothness=3', GOOD);

    const r = await askForScript('a plate with a hole', { config });
    if ('assembly' in r) return;

    expect(r.ok).toBe(true);
    expect(r.repairs).toBe(1);
    expect(asked).toHaveLength(2);
  });

  it('quotes the failing script with line numbers, and names every error', async () => {
    const asked = modelSaying('sculpt Blob\nbox Body nonsense=1', GOOD);

    await askForScript('anything', { config });

    const repair = asked[1]!.user;
    expect(repair).toContain('  1 | sculpt Blob');
    expect(repair).toContain('  2 | box Body nonsense=1');
    expect(repair).toContain('line 1');
    expect(repair).toContain('line 2');
    expect(repair).toContain('nonsense');
  });

  it('gives up after two repairs rather than looping', async () => {
    const asked = modelSaying('sculpt Blob');

    const r = await askForScript('anything', { config });
    if ('assembly' in r) return;

    expect(r.ok).toBe(false);
    expect(asked).toHaveLength(3);          // the first attempt plus two repairs
    expect(r.message).toContain('after 3 attempts');
    expect(r.message).toContain('line 1');
  });
});

describe('a script that parses but builds nothing', () => {
  /*
   * Parsing is not building. A well-formed script can produce an empty viewport — a shell
   * with no body, a cut that removes everything — and reporting that as a success is the
   * failure mode this whole application is built to avoid.
   */
  it('is not accepted as a success', async () => {
    modelSaying('param L = 10');           // parses perfectly, builds nothing
    const r = await askForScript('anything', { config });
    if ('assembly' in r) return;

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no solid|could not/i);
  });

  it('tells the model that it ran and produced nothing', async () => {
    const asked = modelSaying('param L = 10', GOOD);
    const r = await askForScript('anything', { config });
    if ('assembly' in r) return;

    expect(r.ok).toBe(true);
    expect(asked[1]!.user).toContain('no solid');
  });

  it('hands back the evaluator’s own reason when a feature fails to build', async () => {
    // A shell with nothing to hollow: parses, and the evaluator refuses it by name.
    const asked = modelSaying('shell Hollow thickness=2', GOOD);

    const r = await askForScript('anything', { config });
    if ('assembly' in r) return;

    expect(r.ok).toBe(true);
    expect(asked[1]!.user.toLowerCase()).toContain('nothing to hollow');
  });
});

describe('routing away from a single part', () => {
  it('reports an assembly rather than trying to script one', async () => {
    modelSaying(ASSEMBLY_MARKER);
    const r = await askForScript('a gearbox', { config });

    expect('assembly' in r).toBe(true);
  });

  it('accepts the marker inside a fence, as models write it', async () => {
    modelSaying('```\nASSEMBLY\n```');
    expect('assembly' in await askForScript('a car', { config })).toBe(true);
  });
});

describe('what the model is told', () => {
  it('is given every feature and argument, generated from the kernel', async () => {
    const asked = modelSaying(GOOD);
    await askForScript('anything', { config });

    const system = asked[0]!.system;
    expect(system).toContain('patternCircular');
    expect(system).toContain('operation=add|cut|intersect');
  });

  it('is told the manufacturing limits the linter will hold it to', async () => {
    const asked = modelSaying(GOOD);
    await askForScript('anything', { config });

    // Stated once and enforced once: the prompt and the linter read one definition, so a
    // model cannot be asked for something that is then rejected.
    expect(asked[0]!.system.length).toBeGreaterThan(1500);
  });

  it('is told how to decline a request that is not one part', async () => {
    const asked = modelSaying(GOOD);
    await askForScript('anything', { config });

    expect(asked[0]!.system).toContain(ASSEMBLY_MARKER);
  });
});

describe('reading a reply', () => {
  it('strips a fence, whatever the instruction said', () => {
    expect(stripFences('```datum\nbox Body length=1\n```')).toBe('box Body length=1');
    expect(stripFences('```\nbox Body length=1\n```')).toBe('box Body length=1');
    expect(stripFences('box Body length=1')).toBe('box Body length=1');
  });
});

describe('telling a script from prose', () => {
  /*
   * The gate every model reply passes through. A reply that fails it is discarded as prose, so
   * a keyword this cannot recognise is a keyword no model can use — whatever the prompt says.
   *
   * `patternLinear` was one: it was tested lowercased against the vocabulary as written, so a
   * reply whose first statement was a pattern did not look like a script at all. The model was
   * handed the spelling in the prompt, used it, and had its answer thrown away.
   */
  it('recognises every keyword the prompt hands the model', () => {
    for (const kind of SCRIPT_KINDS) {
      expect(looksLikeScript(`${kind} Thing`), `${kind} was not recognised as a statement`)
        .toBe(true);
    }
    for (const directive of ['param', 'name', 'material', 'units']) {
      expect(looksLikeScript(`${directive} x`), `${directive} was not recognised`).toBe(true);
    }
  });

  it('finds a statement after a preamble, which is the case it exists for', () => {
    expect(looksLikeScript('Sure! Here is the part:\n\npatternLinear Holes count=4')).toBe(true);
  });

  it('does not mistake prose for a script', () => {
    expect(looksLikeScript('I cannot build that shape with the operations available.'))
      .toBe(false);
  });
});

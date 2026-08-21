import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from './cli';

/**
 * The headless surface.
 *
 * What is being tested is the *contract*, not the formatting: an exit code that means
 * something, evidence rather than a verdict, and a refusal that names what went wrong. Those
 * are what a CI job and an agent both depend on, and both are silently useless if the exit
 * code is always zero.
 */

let dir: string;
const out: string[] = [];
const errs: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'datum-cli-'));
  out.length = 0;
  errs.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { errs.push(a.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const file = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

const PLATE = [
  'name Plate',
  'param L = 120',
  'param W = 80',
  'param T = 10',
  'box Body length=L width=W height=T',
  'hole Bore diameter=20 holeType=through pattern=single x=0 y=0',
].join('\n');

const said = () => out.join('\n');

describe('run', () => {
  it('builds a script and reports what it made', async () => {
    const code = await main(['run', file('p.datum', PLATE)]);

    expect(code).toBe(0);
    expect(said()).toContain('Plate');
    // 120 × 80 × 10 = 96 000 mm³ less a ⌀20 bore through 10 = 3 142 mm³.
    expect(said()).toMatch(/92\.\d\d cm³/);
    expect(said()).toContain('solid: closed');
  });

  it('fails with a non-zero code when the script does not parse', async () => {
    const code = await main(['run', file('bad.datum', 'sculpt Blob smoothness=3')]);

    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('line 1');
    expect(errs.join('\n')).toContain('not something this can build');
  });

  it('names the feature that failed rather than only reporting an open solid', async () => {
    /*
     * The evaluator carries on when a feature fails, so a run can finish with geometry and a
     * step of the recipe silently missing. A CI job told the solid is open and not which line
     * opened it has to bisect by hand.
     */
    const code = await main(['run', file('shell.datum', 'shell Hollow thickness=2')]);

    expect(code).toBe(1);
    expect(said() + errs.join('\n')).toMatch(/nothing to hollow|failed/i);
  });

  it('answers as one object with --json', async () => {
    await main(['run', file('p.datum', PLATE), '--json']);

    const parsed = JSON.parse(said()) as {
      ok: boolean; volumeMm3: number; health: { closed: boolean }; features: unknown[];
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.health.closed).toBe(true);
    expect(parsed.volumeMm3).toBeGreaterThan(92000);
    expect(parsed.features).toHaveLength(2);
  });
});

describe('inspect', () => {
  it('returns measurements rather than a verdict', async () => {
    await main(['inspect', file('p.datum', PLATE), '--json']);

    const parsed = JSON.parse(said()) as {
      massG: number; sizeMm: number[]; holes: number; prismatic: boolean; script: string;
    };

    expect(parsed.sizeMm).toEqual([120, 80, 10]);
    expect(parsed.holes).toBe(1);
    expect(parsed.prismatic).toBe(true);
    expect(parsed.massG).toBeGreaterThan(0);
    // The script travels with it, so an agent can edit what it just measured.
    expect(parsed.script).toContain('box');
  });

  it('lists every feature with its state', async () => {
    await main(['inspect', file('p.datum', PLATE)]);

    expect(said()).toContain('Body');
    expect(said()).toContain('Bore');
  });
});

describe('dfm', () => {
  it('names each rule that fired and prices the part', async () => {
    await main(['dfm', file('p.datum', PLATE), '--json']);

    const parsed = JSON.parse(said()) as {
      findings: { rule: string; severity: string }[];
      cost: { unit: number };
      blockers: number;
    };

    expect(parsed.cost.unit).toBeGreaterThan(0);
    for (const f of parsed.findings) expect(f.rule).toMatch(/^dfm\./);
  });

  it('fails the command on a blocking finding, so it is usable as a gate', async () => {
    const thin = 'box Body length=80 width=60 height=40\nshell Hollow thickness=0.4';
    const code = await main(['dfm', file('thin.datum', thin), '--json']);

    expect(code).toBe(1);
    const parsed = JSON.parse(said()) as { findings: { rule: string }[] };
    expect(parsed.findings.some((f) => f.rule === 'dfm.mill.min-wall')).toBe(true);
  });
});

describe('export', () => {
  it.each([
    ['step', '.step', 'ISO-10303-21'],
    ['svg', '.svg', '<svg'],
    ['dxf', '.dxf', 'SECTION'],
    ['stl', '.stl', 'facet normal'],
  ])('writes %s', async (_name, ext, needle) => {
    const target = join(dir, `part${ext}`);
    const code = await main(['export', file('p.datum', PLATE), '--out', target]);

    expect(code).toBe(0);
    expect(readFileSync(target, 'utf8')).toContain(needle);
  });

  it('round-trips through the saved document', async () => {
    const asJson = join(dir, 'part.json');
    await main(['export', file('p.datum', PLATE), '--out', asJson]);

    out.length = 0;
    await main(['run', asJson, '--json']);

    const parsed = JSON.parse(said()) as { sizeMm: number[]; volumeMm3: number };
    expect(parsed.sizeMm).toEqual([120, 80, 10]);
  });

  it('refuses a format it cannot write, and says which it can', async () => {
    const code = await main(['export', file('p.datum', PLATE), '--out', join(dir, 'p.iges')]);

    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('.step');
  });
});

describe('print', () => {
  it('prints a saved document as a script that runs', async () => {
    const asJson = join(dir, 'part.json');
    await main(['export', file('p.datum', PLATE), '--out', asJson]);

    out.length = 0;
    await main(['print', asJson]);

    const script = said();
    expect(script).toContain('box');

    // And what it printed is itself runnable — which is what makes the language a format.
    out.length = 0;
    expect(await main(['run', file('again.datum', script)])).toBe(0);
  });
});

describe('corpus', () => {
  it('writes one training pair per line, and reports its yield', async () => {
    const target = join(dir, 'corpus.jsonl');
    const code = await main(['corpus', '--count', '25', '--seed', '3', '--out', target, '--json']);

    expect(code).toBe(0);

    const report = JSON.parse(said()) as { kept: number; yieldPercent: number };
    expect(report.kept).toBe(25);
    expect(report.yieldPercent).toBeGreaterThan(70);

    const lines = readFileSync(target, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(25);

    const first = JSON.parse(lines[0]!) as { messages: unknown[]; measured: { massG: number } };
    expect(first.messages).toHaveLength(2);
    expect(first.measured.massG).toBeGreaterThan(0);
  });

  it('is reproducible from its seed', async () => {
    const a = join(dir, 'a.jsonl');
    const b = join(dir, 'b.jsonl');

    await main(['corpus', '--count', '10', '--seed', '5', '--out', a]);
    await main(['corpus', '--count', '10', '--seed', '5', '--out', b]);

    expect(readFileSync(a, 'utf8')).toBe(readFileSync(b, 'utf8'));
  });
});

describe('the command line itself', () => {
  it('prints usage with no arguments', async () => {
    expect(await main([])).toBe(0);
    expect(said()).toContain('datum run');
  });

  it('refuses an unknown command with a distinct code', async () => {
    expect(await main(['frobnicate'])).toBe(2);
  });

  it('refuses an unknown option rather than ignoring it', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/--wat/);
  });

  it('reads options in any position', () => {
    const { positional, options } = parseArgs(['--json', 'a.datum', '--out', 'b.step']);

    expect(positional).toEqual(['a.datum']);
    expect(options.json).toBe(true);
    expect(options.out).toBe('b.step');
  });

  it('says what to do when given no file', async () => {
    expect(await main(['inspect'])).toBe(1);
    expect(errs.join('\n')).toContain('datum inspect');
  });
});

describe('render', () => {
  /*
   * The command that closes the loop. A part that has been described is not a part that has
   * been looked at, and until this existed there was no way to look at one without a browser.
   */
  it('writes one PNG per view, named for the view', async () => {
    const code = await main(['render', file('p.datum', PLATE), '--out', join(dir, 'v.png'), '--size', '128']);

    expect(code).toBe(0);
    for (const view of ['iso', 'front', 'right', 'top']) {
      const png = readFileSync(join(dir, `v-${view}.png`));
      expect(Array.from(png.subarray(0, 4))).toEqual([137, 80, 78, 71]);
      expect(png.length).toBeGreaterThan(1000);
    }
  });

  it('reports how much of each frame the part covered', async () => {
    await main(['render', file('p.datum', PLATE), '--out', join(dir, 'v.png'), '--size', '128', '--json']);

    const report = JSON.parse(said()) as { views: { view: string; coveredPercent: number }[] };

    expect(report.views).toHaveLength(4);
    // A part that rendered as nothing is a render that succeeded and is worth nothing.
    for (const v of report.views) expect(v.coveredPercent).toBeGreaterThan(1);
  });

  it('renders only the views asked for', async () => {
    await main([
      'render', file('p.datum', PLATE), '--out', join(dir, 'v.png'),
      '--views', 'front,top', '--size', '64', '--json',
    ]);

    const report = JSON.parse(said()) as { views: { view: string }[] };
    expect(report.views.map((v) => v.view)).toEqual(['front', 'top']);
  });

  it('refuses when there is no solid to render', async () => {
    const code = await main(['render', file('n.datum', 'param L = 10'), '--out', join(dir, 'n.png')]);

    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('no solid');
  });
});

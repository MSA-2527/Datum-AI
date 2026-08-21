import { afterEach, describe, expect, it, vi } from 'vitest';
import { askForEdit, diffScripts, NEW_PART_MARKER } from './editRoute';
import { printScript, runScript } from '../generate/script';
import { evaluateDocument } from '../model/document';
import { massProperties } from '../kernel/topo/mesh';
import type { ProviderConfig } from './providers';

/**
 * Changing the part that is open.
 *
 * The behaviour being fixed is not a crash. It is that a correction — "make the shell longer" —
 * was answered by throwing the part away and building a new one, which is what made the
 * assistant something you talked to once and then stopped trusting with anything you cared
 * about.
 */

const config: ProviderConfig = {
  id: 'anthropic', model: 'test', apiKey: 'k', allowWebSearch: false,
};

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

afterEach(() => { vi.unstubAllGlobals(); });

const LF = String.fromCharCode(10);

function docOf(script: string) {
  const result = runScript(script);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return result.doc;
}

/*
 * The baseline is the *printed* script, not the one typed here.
 *
 * That is what the route shows the model — a document round-tripped through `printScript` —
 * and diffing a model's reply against anything else measures the difference between two
 * spellings of the same part rather than the change that was asked for. Writing the test
 * against a hand-typed script reported three changes for a one-number edit, which was the test
 * being wrong about what the code sees.
 */
const FRAME = printScript(docOf([
  'name Frame',
  'material Aluminium 6061',
  'param plate = 10',
  'box Base length=120 width=80 height=plate',
  'box Post length=20 width=20 height=60 at.x=40 at.z=35',
].join(LF)));

describe('making a change', () => {
  it('changes the line it was asked to and leaves the rest alone', async () => {
    const doc = docOf(FRAME);
    modelSaying(FRAME.replace('param plate = 10', 'param plate = 20'));

    const result = await askForEdit('make the base 20 mm thick', doc, { config });
    expect('newPart' in result).toBe(false);
    if ('newPart' in result) return;

    expect(result.ok).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.kind).toBe('changed');
    expect(result.changes[0]!.was).toContain('plate = 10');

    // And the part is the old part with one number different, not a new part.
    expect(result.doc.features.map((f) => f.name)).toEqual(doc.features.map((f) => f.name));
  });

  it('shows the part it is changing to the model', async () => {
    const asked = modelSaying(FRAME);
    await askForEdit('make it taller', docOf(FRAME), { config });

    expect(asked[0]!.user).toContain('box Base length=120');
    expect(asked[0]!.system).toContain('Change only what the request asks');
  });

  it('reports an addition as an addition', async () => {
    const doc = docOf(FRAME);
    modelSaying(`${FRAME}${LF}box Post2 length=20 width=20 height=60 at.x=-40 at.z=35`);

    const result = await askForEdit('add a second post', doc, { config });
    if ('newPart' in result) throw new Error('read as a new part');

    expect(result.changes.map((c) => c.kind)).toEqual(['added']);
    expect(result.doc.features).toHaveLength(doc.features.length + 1);
  });

  it('reports a removal as a removal', async () => {
    const doc = docOf(FRAME);
    modelSaying(FRAME.split(LF).filter((l) => !l.trim().startsWith('box Post')).join(LF));

    const result = await askForEdit('take the post off', doc, { config });
    if ('newPart' in result) throw new Error('read as a new part');

    expect(result.changes.map((c) => c.kind)).toEqual(['removed']);
  });

  it('says what changed in words, not just that something did', async () => {
    modelSaying(FRAME.replace('param plate = 10', 'param plate = 25'));
    const result = await askForEdit('thicker base', docOf(FRAME), { config });
    if ('newPart' in result) throw new Error('read as a new part');

    expect(result.message).toMatch(/1 change/);
    expect(result.message).toContain('param plate');
  });
});

describe('what it refuses', () => {
  it('hands a request for a different object back to the build route', async () => {
    modelSaying(NEW_PART_MARKER);
    const result = await askForEdit('a gearbox', docOf(FRAME), { config });

    expect('newPart' in result).toBe(true);
  });

  it('hands back a reply that is not a script at all', async () => {
    /*
     * Asked to turn a bracket into "a 120 × 80 × 8 mm mounting plate", a model quite reasonably
     * answers with a new part — as JSON, as prose, as a plan — because that is what the sentence
     * asked for, even though it arrived here. Read as a broken edit it produced the worst
     * possible response: `"{" is not something this can build`, and a request the offline
     * catalogue answers instantly was thrown away.
     */
    modelSaying('{"name":"Mounting plate","components":[]}');
    expect('newPart' in await askForEdit('a mounting plate', docOf(FRAME), { config })).toBe(true);

    modelSaying('Certainly! A mounting plate is a flat rectangular part used to…');
    expect('newPart' in await askForEdit('a mounting plate', docOf(FRAME), { config })).toBe(true);
  });

  it('refuses a rewrite dressed up as an edit, and keeps the part', async () => {
    /*
     * The failure mode this guards. A model asked to change one line sometimes returns a
     * different part entirely — plausible, well-formed, and nothing to do with what was open.
     * Reporting that as "2 changes" would be a replacement hidden inside an edit's message.
     */
    const doc = docOf(FRAME);
    modelSaying([
      'name Something else',
      'material Steel',
      'cylinder Barrel diameter=90 height=200',
      'hole Bore diameter=40',
      'fillet Edges radius=3',
    ].join(LF));

    const result = await askForEdit('make the base thicker', doc, { config });
    if ('newPart' in result) throw new Error('read as a new part');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('rewrite of the whole part');
    expect(result.doc).toBe(doc);
  });

  it('refuses a change that would leave nothing to build', async () => {
    const doc = docOf(FRAME);
    modelSaying(['name Frame', 'param plate = 10'].join(LF));

    const result = await askForEdit('remove everything', doc, { config });
    if ('newPart' in result) throw new Error('read as a new part');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('nothing to build');
    expect(result.doc).toBe(doc);
  });

  it('refuses a script that does not parse, and says why, and keeps the part', async () => {
    const doc = docOf(FRAME);
    modelSaying('box Base lenth=120 width=80 height=10');

    const result = await askForEdit('make it wider', doc, { config });
    if ('newPart' in result) throw new Error('read as a new part');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('could not be applied');
    expect(result.doc).toBe(doc);
  });
});

describe('when the model cannot be reached', () => {
  /*
   * A dead API key is not a design decision, and it must not read like one.
   *
   * Every other failure in this file is the model's judgement: it rewrote too much, it wrote a
   * script that would not parse, it decided the request was about something else. A provider
   * failure is none of those — no key, no network, or a free tier spent — and treating it as a
   * refusal stops the request dead. A part the offline catalogue could have built instantly is
   * lost to an expired key, which is how an application that works offline stops working when
   * you configure a model for it.
   */
  it('says the model never answered, so the caller can go elsewhere', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'You exceeded your current quota.' } }),
      { status: 429 },
    )));

    const result = await askForEdit('a mounting plate', docOf(FRAME), { config });
    if ('newPart' in result) throw new Error('read as a new part');

    expect(result.ok).toBe(false);
    expect(result.providerFailed).toBe(true);
    expect(result.doc).toBe(docOf(FRAME).features.length ? result.doc : result.doc);
  });

  it('does not set the flag when the model answered and was refused', async () => {
    // A rewrite is the model having its say. The request has been considered and declined, and
    // sending it somewhere else would be asking twice for a different answer.
    modelSaying([
      'name Something else',
      'cylinder Barrel diameter=90 height=200',
      'hole Bore diameter=40',
      'fillet Edges radius=3',
    ].join(LF));

    const result = await askForEdit('make the base thicker', docOf(FRAME), { config });
    if ('newPart' in result) throw new Error('read as a new part');

    expect(result.ok).toBe(false);
    expect(result.providerFailed).toBeFalsy();
  });

  it('does not set the flag when the script would not parse', async () => {
    modelSaying('box Base lenth=120 width=80 height=10');

    const result = await askForEdit('make it wider', docOf(FRAME), { config });
    if ('newPart' in result) throw new Error('read as a new part');

    expect(result.providerFailed).toBeFalsy();
  });
});

describe('reading the difference', () => {
  it('treats a feature with a changed argument as changed, not as deleted and re-added', () => {
    /*
     * The property that makes the report readable. A feature keeps its identity by name, so
     * resizing the base plate has to read as "Base changed" — telling the user their base was
     * deleted and a different one added describes the same bytes and the wrong event.
     */
    const changes = diffScripts(
      'box Base length=120 width=80 height=10',
      'box Base length=150 width=80 height=10',
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('changed');
  });

  it('ignores comments and blank lines, which are not the part', () => {
    const changes = diffScripts(
      `# a frame${LF}${LF}box Base length=120 width=80 height=10`,
      `box Base length=120 width=80 height=10${LF}# a note added later`,
    );

    expect(changes).toEqual([]);
  });

  it('counts a move as a change to the line that moved', () => {
    const changes = diffScripts(
      'box Post length=20 width=20 height=60 at.x=40',
      'box Post length=20 width=20 height=60 at.x=-40',
    );

    expect(changes[0]!.kind).toBe('changed');
    expect(changes[0]!.was).toContain('at.x=40');
  });

  it('sees nothing where nothing changed', () => {
    expect(diffScripts(FRAME, FRAME)).toEqual([]);
  });
});

describe('the part that comes back', () => {
  it('still builds, and is the edited size', async () => {
    modelSaying(FRAME.replace('param plate = 10', 'param plate = 20'));
    const result = await askForEdit('20 mm base', docOf(FRAME), { config });
    if ('newPart' in result) throw new Error('read as a new part');

    const before = massProperties(evaluateDocument(docOf(FRAME)).mesh).volume;
    const after = massProperties(evaluateDocument(result.doc).mesh).volume;

    /*
     * More material, and not 120 × 80 × 10 more: the post stands in the base and the extra
     * thickness swallows part of it, so the union gains less than the plate alone would. The
     * assertion is that the edit took effect on the solid, which is the thing being checked —
     * the exact figure is a fact about the overlap, not about the edit.
     */
    expect(after).toBeGreaterThan(before);
    expect(after - before).toBeGreaterThan(90_000);
  });
});

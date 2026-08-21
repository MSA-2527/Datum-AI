import { afterEach, describe, expect, it, vi } from 'vitest';
import { readVerdict, reviewBuild, viewsAsImages } from './review';
import { askForScript } from './scriptRoute';
import { runScript } from '../generate/script';
import { evaluateDocument } from '../model/document';
import type { ProviderConfig } from './providers';

/**
 * Showing a model what it built.
 *
 * The failures this catches are the ones that survive every other check: a script that parses,
 * builds, closes and measures correctly can still be recognisably not the thing that was asked
 * for. So the tests are about the loop rather than about taste — a `wrong` verdict must become
 * another repair round carrying what was seen, and an unreadable reply must not be able to
 * condemn a good part or pass a bad one.
 */

const config: ProviderConfig = {
  id: 'anthropic', model: 'test', apiKey: 'k', allowWebSearch: false,
};

const PLATE = 'box Body length=120 width=80 height=10';
const docOf = (script: string) => runScript(script).doc;

/** Answers with each reply in turn, and records what it was sent. */
function modelSaying(...replies: string[]) {
  const asked: { user: string; images: number }[] = [];
  let n = 0;

  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      messages: { content: { type: string; text?: string }[] | string }[];
    };

    const content = body.messages[0]!.content;
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;

    asked.push({
      user: parts.filter((p) => p.type === 'text').map((p) => p.text).join(''),
      images: parts.filter((p) => p.type === 'image').length,
    });

    const text = replies[Math.min(n, replies.length - 1)]!;
    n += 1;
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });
  }));

  return asked;
}

afterEach(() => vi.unstubAllGlobals());

describe('what the model is shown', () => {
  it('is four orthographic views, as images', async () => {
    const asked = modelSaying('{"verdict":"matches","notes":[]}');

    const review = await reviewBuild('a plate', docOf(PLATE), { config });

    expect(review.verdict).toBe('matches');
    expect(asked[0]!.images).toBe(4);
    expect(asked[0]!.user).toContain('iso, front, right, top');
  });

  it('is told what was asked for, so it can compare rather than describe', async () => {
    const asked = modelSaying('{"verdict":"matches","notes":[]}');
    await reviewBuild('a 120 x 80 x 10 mounting plate', docOf(PLATE), { config });

    expect(asked[0]!.user).toContain('a 120 x 80 x 10 mounting plate');
  });

  it('renders real images, not placeholders', () => {
    const evaluated = evaluateDocument(docOf(PLATE));
    const images = viewsAsImages(evaluated.mesh, ['iso', 'front'], 128);

    expect(images).toHaveLength(2);
    for (const img of images) {
      expect(img.mediaType).toBe('image/png');
      // A PNG signature, base64-encoded, always starts this way.
      expect(img.base64.startsWith('iVBORw0KGgo')).toBe(true);
      expect(img.base64.length).toBeGreaterThan(1000);
    }
    expect(images[0]!.label).toBe('iso view');
  });
});

describe('what it will not do', () => {
  it('declines rather than guessing when the provider has no eyes', async () => {
    const asked = modelSaying('{"verdict":"wrong","notes":["it is upside down"]}');

    const review = await reviewBuild('a plate', docOf(PLATE), {
      config: { ...config, id: 'none' },
    });

    expect(review.verdict).toBe('unsure');
    expect(review.problem).toContain('cannot be sent images');
    expect(asked).toHaveLength(0);
  });

  it('declines when there is no solid to look at', async () => {
    const asked = modelSaying('{"verdict":"matches","notes":[]}');
    const review = await reviewBuild('nothing', docOf('param L = 10'), { config });

    expect(review.verdict).toBe('unsure');
    expect(review.problem).toContain('no solid');
    expect(asked).toHaveLength(0);
  });

  it('declines when the provider could not be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"error":{"message":"rate limited"}}', { status: 429 })));

    const review = await reviewBuild('a plate', docOf(PLATE), { config });
    expect(review.verdict).toBe('unsure');
    expect(review.problem).toBeTruthy();
  });
});

describe('reading a verdict', () => {
  it('takes a clean reply', () => {
    expect(readVerdict('{"verdict":"matches","notes":[]}')).toEqual({ verdict: 'matches', notes: [] });
  });

  it('takes one inside a fence, or with prose around it', () => {
    expect(readVerdict('```json\n{"verdict":"wrong","notes":["no holes"]}\n```').verdict).toBe('wrong');
    expect(readVerdict('Looking at it: {"verdict":"wrong","notes":["no holes"]} — hope that helps')
      .verdict).toBe('wrong');
  });

  it('treats anything unreadable as no opinion', () => {
    /*
     * Load-bearing. A review that cannot be parsed must not condemn a part that is fine, and
     * must not pass one that is not.
     */
    for (const reply of ['', 'I think it looks fine', '{"verdict":', 'null', '{"verdict":"maybe"}']) {
      expect(readVerdict(reply).verdict, reply).toBe('unsure');
    }
  });

  it('treats "wrong" with nothing to point at as no opinion', () => {
    // Acting on it would send a part back for repair with no instruction.
    expect(readVerdict('{"verdict":"wrong","notes":[]}').verdict).toBe('unsure');
  });

  it('keeps only notes that say something', () => {
    const { notes } = readVerdict('{"verdict":"wrong","notes":["the bore is off centre","","  "]}');
    expect(notes).toEqual(['the bore is off centre']);
  });
});

describe('the loop it closes', () => {
  it('sends a part back for repair when it looked wrong, carrying what was seen', async () => {
    const asked = modelSaying(
      PLATE,                                                        // first script
      '{"verdict":"wrong","notes":["the plate has no holes at all"]}',  // the review
      `${PLATE}\nhole Bore diameter=20 holeType=through pattern=single x=0 y=0`,
      '{"verdict":"matches","notes":[]}',
    );

    const result = await askForScript('a plate with a bore', { config, look: true });

    expect('assembly' in result).toBe(false);
    if ('assembly' in result) return;

    expect(result.ok).toBe(true);
    expect(result.repairs).toBe(1);
    expect(result.source).toContain('hole');

    // The third call is the repair, and it quotes what was seen rather than a line number.
    expect(asked[2]!.user).toContain('no holes at all');
    expect(asked[2]!.user).toContain('built, but looking at the result');
  });

  it('accepts a part the model looked at and approved', async () => {
    modelSaying(PLATE, '{"verdict":"matches","notes":[]}');

    const result = await askForScript('a plate', { config, look: true });
    if ('assembly' in result) return;

    expect(result.ok).toBe(true);
    expect(result.repairs).toBe(0);
    expect(result.review?.verdict).toBe('matches');
    expect(result.message).toContain('by eye');
  });

  it('accepts a part when the review could not be had', async () => {
    // An unreadable review is not a reason to lose a part that built.
    modelSaying(PLATE, 'I am not sure what I am looking at');

    const result = await askForScript('a plate', { config, look: true });
    if ('assembly' in result) return;

    expect(result.ok).toBe(true);
    expect(result.review?.verdict).toBe('unsure');
  });

  it('does not look at all unless it was asked to', async () => {
    const asked = modelSaying(PLATE);

    const result = await askForScript('a plate', { config });
    if ('assembly' in result) return;

    expect(result.ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(result.review).toBeUndefined();
  });
});

import { complete, providerInfo, type ProviderConfig, type RequestImage } from './providers';
import { encodeImage } from './images';
import { renderViews, REVIEW_VIEWS, type ViewName } from '../render/raster';
import { encodePng } from '../render/png';
import { evaluateDocument, type Document } from '../model/document';
import { triCount } from '../kernel/topo/mesh';

/**
 * Looking at what was built.
 *
 * ── Why this is the loop that matters ──
 *
 * Everything else in the model path judges a part by reading its description. The requirement
 * checker measures a bounding box; the critique inspects a plan; the script route reports what
 * parsed. None of them can see, and the failures that survive all three are exactly the ones a
 * glance would catch: a boss floating half a millimetre off the face it was meant to sit on, a
 * pocket cut through the wrong side, four bolt holes on a circle so large they break the edge,
 * a part that is recognisably not the thing that was asked for.
 *
 * A model that has been handed the part it just wrote is doing something categorically
 * different from one re-reading its own program. It has the same relationship to its output
 * that an engineer has to a screen.
 *
 * ── Why the verdict is structured, and conservative ──
 *
 * The reply is a decision plus reasons, not prose, because the caller has to act on it: a
 * verdict of `wrong` becomes another repair round with the reasons attached. And an unreadable
 * reply is treated as **no opinion** rather than as approval or rejection — a review that
 * cannot be parsed must not be able to condemn a part that is fine, and must not be able to
 * pass one that is not.
 */

export type Verdict = 'matches' | 'wrong' | 'unsure';

export interface Review {
  verdict: Verdict;
  /** What is wrong, or what was checked. One line each, for handing back to a repair round. */
  notes: string[];
  /** The views that were looked at. */
  views: ViewName[];
  /** Absent when the provider could not be reached, or has no eyes. */
  problem?: string;
}

export interface ReviewOptions {
  config: ProviderConfig;
  signal?: AbortSignal;
  views?: ViewName[];
  /** Pixels per side. Smaller is cheaper and, past a point, no less legible. */
  size?: number;
}

/**
 * Renders a document and asks a model whether it is the part that was requested.
 *
 * Returns `unsure` rather than failing for every reason that is not the model's judgement —
 * no provider, no eyes, nothing built, an unparseable reply. A review is an improvement on the
 * answer, never a gate on producing one, and losing a good part because an optional pass could
 * not run would be a worse outcome than not looking.
 */
export async function reviewBuild(
  request: string, doc: Document, opts: ReviewOptions,
): Promise<Review> {
  const views = opts.views ?? REVIEW_VIEWS;

  const info = providerInfo(opts.config.id);
  if (!info.supportsImages) {
    return {
      verdict: 'unsure', notes: [], views,
      problem: `${info.label} cannot be sent images, so the part was not looked at.`,
    };
  }

  const evaluated = evaluateDocument(doc);
  if (triCount(evaluated.mesh) === 0) {
    return { verdict: 'unsure', notes: [], views, problem: 'There was no solid to look at.' };
  }

  const images = viewsAsImages(evaluated.mesh, views, opts.size ?? 512);

  const reply = await complete(opts.config, {
    system: SYSTEM,
    user:
      `The request was:\n\n${request}\n\n` +
      `Here is what was built, in ${views.length} views: ${views.join(', ')}. ` +
      `Every view is orthographic and to the same scale.\n\n` +
      `Reply with JSON only: {"verdict":"matches"|"wrong","notes":["…"]}. ` +
      `Use "wrong" only for something you can see — a feature in the wrong place, a missing ` +
      `feature, proportions that do not match the request. Do not judge surface finish, ` +
      `colour or render quality.`,
    images,
    maxTokens: 800,
    signal: opts.signal,
  });

  if (!reply.ok) return { verdict: 'unsure', notes: [], views, problem: reply.message };

  return { ...readVerdict(reply.text), views };
}

/** Each view as a PNG, ready to send. */
export function viewsAsImages(
  mesh: Parameters<typeof renderViews>[0], views: ViewName[], size: number,
): RequestImage[] {
  return renderViews(mesh, views, { width: size, height: size }).map(({ name, render }) =>
    encodeImage(encodePng(render.rgba, render.width, render.height), 'image/png', `${name} view`));
}

const SYSTEM = [
  'You are a mechanical engineer checking a CAD model against the request it was built from.',
  '',
  'You are shown orthographic views of one part. Judge only what is visible:',
  '',
  '  - is it recognisably the thing that was asked for?',
  '  - are the features that were asked for present, and in the right places?',
  '  - are the proportions right relative to each other?',
  '  - is anything obviously wrong — a feature floating clear of the body, a cut on the',
  '    wrong face, holes breaking through an edge?',
  '',
  'Do not comment on colour, lighting, shading or render quality: none of them is part of the',
  'model. Do not guess at dimensions from the image; the views carry no scale.',
  '',
  'Say "wrong" only for something you can point at. A part you cannot fault is "matches",',
  'even if you would have designed it differently.',
].join('\n');

/**
 * Reads the verdict out of a reply.
 *
 * Anything unreadable is `unsure`. Guessing at an intent that was not expressed would either
 * condemn a part that is fine or pass one that is not, and both are worse than declining to
 * have an opinion.
 */
export function readVerdict(text: string): { verdict: Verdict; notes: string[] } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();

  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return { verdict: 'unsure', notes: [] };

  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as {
      verdict?: unknown; notes?: unknown;
    };

    const verdict: Verdict =
      parsed.verdict === 'matches' ? 'matches'
        : parsed.verdict === 'wrong' ? 'wrong'
          : 'unsure';

    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
      : [];

    // A verdict of "wrong" with nothing to point at is not actionable, and acting on it would
    // send a part back for repair with no instruction. Treated as no opinion.
    if (verdict === 'wrong' && notes.length === 0) return { verdict: 'unsure', notes: [] };

    return { verdict, notes };
  } catch {
    return { verdict: 'unsure', notes: [] };
  }
}

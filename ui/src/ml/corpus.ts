/**
 * The training corpus, gathered from what the user has actually done.
 *
 * Two sources, and no third. Parts they saved to the library, which carry a measured bounding
 * box; and parts they taught, which carry the words they would use to ask for one. Nothing
 * from the built-in catalogue goes in — the whole value of the model is that it knows *their*
 * conventions, and seeding it with the shipped recipes would teach it the textbook dimensions
 * it exists to replace.
 *
 * The model is rebuilt from the corpus rather than stored. It trains in a few milliseconds on
 * a library this size, and a stored model is a thing that can be stale, can disagree with the
 * library it claims to describe, and needs a migration the first time its shape changes.
 */

import { listLibrary } from '../lib/library';
import { listExamples } from '../lib/training';
import { trainSizeModel, type SizeModel, type SizedPart } from './dimensions';

/** The envelope a plan declares, when it declares one. */
function envelopeOf(plan: { envelope?: unknown }): [number, number, number] | null {
  const e = plan.envelope as { length?: number; width?: number; height?: number } | undefined;
  if (!e) return null;

  const size: [number, number, number] = [e.length ?? 0, e.width ?? 0, e.height ?? 0];
  return size.every((v) => Number.isFinite(v) && v > 0) ? size : null;
}

/**
 * Everything there is to learn from, deduplicated by description.
 *
 * A part that was saved and then taught appears in both lists, and counting it twice would
 * let whichever parts happen to have been through both routes pull twice as hard — a fact
 * about how they were entered rather than about the parts.
 */
export function gatherCorpus(): SizedPart[] {
  const byText = new Map<string, SizedPart>();

  for (const entry of listLibrary()) {
    // The name is what someone would type to ask for it again, which is the half the model
    // has to learn to read. The document's own name is the same string by the time it is
    // saved — saving renames the document to match.
    const size = entry.snapshot.sizeMm;
    if (!entry.snapshot.closed) continue;   // an open solid's measurements are not trustworthy
    byText.set(entry.name.toLowerCase(), { text: entry.name, sizeMm: size });
  }

  for (const example of listExamples()) {
    const size = envelopeOf(example.plan);
    if (!size) continue;
    byText.set(example.prompt.toLowerCase(), { text: example.prompt, sizeMm: size });
  }

  return [...byText.values()];
}

/** Trains on the current corpus. Null when there is not enough to learn anything from. */
export function currentSizeModel(): SizeModel | null {
  return trainSizeModel(gatherCorpus());
}

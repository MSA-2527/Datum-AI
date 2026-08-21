/**
 * Editing the model that is already open.
 *
 * Every request started a new document. "Make the wall 2 mm thicker", "add a boss on top",
 * "move the holes to a 60 mm circle", "the bracket is too heavy" — none of them worked, because
 * the only thing the assistant could do was build something from scratch. That is not how anyone
 * uses CAD: the first version is a draft and everything after it is a change.
 *
 * The gap was never model capability. It was that the assistant had one verb. This gives it the
 * others — change a dimension, add a feature, remove one, suppress one, rename — expressed
 * against the document that is open, with the same requirement checking that a fresh build gets.
 *
 * Deliberately not a free-form patch. Each edit is one of a small set of operations against a
 * named target, so an edit that cannot be understood is refused with the reason rather than
 * applied approximately. A modeller that sometimes does something *near* what you asked is worse
 * than one that says it did not follow you.
 */

import {
  addFeature, defaultParams, deleteFeature, paramFields, renameFeature, setSuppressed,
  updateFeature, type Document, type FeatureKind, type ParamValue,
} from '../model/document';
import { readRequirements } from './requirements';
import { findMeasures } from '../generate/parse';

export type EditKind = 'set' | 'add' | 'remove' | 'suppress' | 'unsuppress' | 'rename';

export interface Edit {
  kind: EditKind;
  /** Feature the edit acts on, by name. Absent for `add`. */
  target?: string;
  /** Parameter to change, for `set`. */
  parameter?: string;
  value?: ParamValue;
  /** Feature kind, for `add`. */
  feature?: FeatureKind;
  /** New name, for `rename`. */
  name?: string;
}

export interface EditResult {
  ok: boolean;
  doc: Document;
  message: string;
}

/** Feature names, lowercased, for matching what someone typed against what exists. */
function index(doc: Document): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of doc.features) out.set(f.name.toLowerCase(), f.id);
  return out;
}

/**
 * Finds the feature a phrase refers to.
 *
 * Exact name first, then a unique partial match. A partial that matches two features is refused
 * rather than resolved to the first: "the plate" on a document with `Base plate` and `Top plate`
 * is genuinely ambiguous, and picking one silently edits the wrong part of someone's model.
 */
export function resolveTarget(doc: Document, phrase: string): { id?: string; problem?: string } {
  const want = phrase.trim().toLowerCase();
  if (!want) return { problem: 'No feature was named.' };

  const names = index(doc);
  const exact = names.get(want);
  if (exact) return { id: exact };

  const partial = [...names.entries()].filter(([name]) => name.includes(want) || want.includes(name));
  if (partial.length === 1) return { id: partial[0]![1] };

  if (partial.length > 1) {
    return {
      problem: `"${phrase}" could be ${partial.map(([n]) => `"${n}"`).join(' or ')}. `
        + 'Name one of them.',
    };
  }

  const available = doc.features.map((f) => f.name).join(', ');
  return { problem: `There is no feature called "${phrase}". This model has: ${available}.` };
}

/** Applies one edit, or explains why it cannot. */
export function applyEdit(doc: Document, edit: Edit): EditResult {
  if (edit.kind === 'add') {
    if (!edit.feature) return { ok: false, doc, message: 'No feature kind was given to add.' };

    const next = addFeature(doc, edit.feature, {
      ...defaultParams(edit.feature),
      ...(edit.parameter && edit.value !== undefined ? { [edit.parameter]: edit.value } : {}),
    });
    const added = next.features[next.features.length - 1]!;
    return { ok: true, doc: next, message: `Added ${added.name}.` };
  }

  const found = resolveTarget(doc, edit.target ?? '');
  if (!found.id) return { ok: false, doc, message: found.problem ?? 'That feature was not found.' };

  const feature = doc.features.find((f) => f.id === found.id)!;

  switch (edit.kind) {
    case 'set': {
      if (!edit.parameter) {
        return { ok: false, doc, message: `No parameter was named on ${feature.name}.` };
      }

      // Checked against what the feature actually has, so a misread parameter is refused rather
      // than written as a key nothing reads — which would look like success and change nothing.
      const known = paramFields(feature.kind, feature.params, doc).map((f) => f.key);
      if (!known.includes(edit.parameter)) {
        return {
          ok: false, doc,
          message: `${feature.name} has no "${edit.parameter}". It has: ${known.join(', ')}.`,
        };
      }

      return {
        ok: true,
        doc: updateFeature(doc, feature.id, { [edit.parameter]: edit.value as ParamValue }),
        message: `${feature.name}: ${edit.parameter} is now ${String(edit.value)}.`,
      };
    }

    case 'remove':
      return { ok: true, doc: deleteFeature(doc, feature.id), message: `Deleted ${feature.name}.` };

    case 'suppress':
      return {
        ok: true, doc: setSuppressed(doc, feature.id, true),
        message: `${feature.name} is switched off. It is still in the tree.`,
      };

    case 'unsuppress':
      return {
        ok: true, doc: setSuppressed(doc, feature.id, false),
        message: `${feature.name} is switched back on.`,
      };

    case 'rename': {
      if (!edit.name?.trim()) return { ok: false, doc, message: 'No new name was given.' };
      return {
        ok: true,
        doc: renameFeature(doc, feature.id, edit.name.trim()),
        message: `${feature.name} is now called ${edit.name.trim()}.`,
      };
    }

    default:
      return { ok: false, doc, message: 'That is not an edit this understands.' };
  }
}

// ── reading an edit out of a sentence ────────────────────────────────────────

const REMOVE = /\b(?:delete|remove|get rid of|drop)\b/i;
const SUPPRESS = /\b(?:suppress|turn off|switch off|disable|hide)\b/i;
const UNSUPPRESS = /\b(?:unsuppress|turn on|switch on|enable|show)\b/i;
const RENAME = /\b(?:rename|call it)\b/i;
const ADD = /\b(?:add|put|give it|drill|create)\b/i;

/** Words that name a feature kind, longest first so "linear pattern" beats "pattern". */
const KINDS: { words: string[]; kind: FeatureKind }[] = [
  { words: ['linear pattern'], kind: 'patternLinear' },
  { words: ['circular pattern'], kind: 'patternCircular' },
  { words: ['datum plane', 'datum'], kind: 'datum' },
  { words: ['counterbore', 'countersink', 'hole'], kind: 'hole' },
  { words: ['fillet', 'round'], kind: 'fillet' },
  { words: ['chamfer'], kind: 'chamfer' },
  { words: ['shell', 'hollow'], kind: 'shell' },
  { words: ['pocket'], kind: 'pocket' },
  { words: ['slot'], kind: 'slot' },
  { words: ['rib'], kind: 'rib' },
  { words: ['draft'], kind: 'draft' },
  { words: ['dome'], kind: 'dome' },
  { words: ['split'], kind: 'split' },
  { words: ['wrap', 'knurl'], kind: 'wrap' },
  { words: ['mirror'], kind: 'mirror' },
  { words: ['box', 'block'], kind: 'box' },
  { words: ['cylinder'], kind: 'cylinder' },
  { words: ['sphere'], kind: 'sphere' },
];

/**
 * Which parameter a phrase is about, as the words that name it and the keys it could be.
 *
 * One word means different keys on different features. "Thick" is `height` on a box, `thickness`
 * on a shell and `distance` on an extrude — the same physical idea reached by three names,
 * because each feature names the dimension after what it does with it. So a word maps to a
 * *list* of candidates, and the one that survives is the one the target feature actually has.
 *
 * The first draft mapped each word to a single key, and "make the base plate 20 mm thick" was
 * refused because a box has no parameter called thickness. It was right to refuse rather than
 * write a key nothing reads; it was wrong about there being nothing to write.
 *
 * Longest phrase first, so "corner radius" is not read as "radius".
 */
const PARAMETERS: { words: string[]; keys: string[] }[] = [
  { words: ['corner radius'], keys: ['cornerRadius'] },
  { words: ['wall thickness', 'thickness', 'thick', 'wall'], keys: ['thickness', 'height', 'distance', 'width'] },
  { words: ['diameter', 'dia', 'bore'], keys: ['diameter', 'baseDiameter', 'topDiameter'] },
  { words: ['radius'], keys: ['radius', 'pathRadius'] },
  { words: ['length', 'long'], keys: ['length', 'distance', 'baseLength'] },
  { words: ['width', 'wide'], keys: ['width', 'baseWidth'] },
  { words: ['height', 'tall'], keys: ['height', 'distance'] },
  { words: ['deep', 'depth'], keys: ['depth', 'height', 'counterDepth'] },
  { words: ['distance'], keys: ['distance'] },
  { words: ['angle'], keys: ['angle', 'draft'] },
  { words: ['count', 'how many'], keys: ['count'] },
];

/** The parameter a word means on a particular feature, or nothing if it has none of them. */
function keyOn(doc: Document, featureName: string, keys: string[]): string | null {
  const feature = doc.features.find((f) => f.name === featureName);
  if (!feature) return null;

  const has = new Set(paramFields(feature.kind, feature.params, doc).map((f) => f.key));
  return keys.find((k) => has.has(k)) ?? null;
}

/**
 * Reads an edit out of a sentence, against the document it is about.
 *
 * The document matters: "make the plate 8 mm thick" is only an edit if there is a plate, and
 * knowing the feature names is what separates a change from a fresh request. Returns null when
 * the sentence is not an edit at all, which is how the assistant decides whether to change what
 * is open or build something new.
 */
export function readEdit(text: string, doc: Document): Edit | null {
  if (doc.features.length === 0) return null;

  const lower = text.toLowerCase();

  /*
   * Which feature the sentence is about.
   *
   * Matched with the trailing number stripped, because features are auto-named `Fillet1`,
   * `Box2`, `Sheet metal1` — and nobody types the number. "Turn off the fillet" failed outright
   * until this did, and fell through to building a new document, which is the worst possible
   * answer to a request to switch something off.
   *
   * The longest matching name wins, so `Base plate` beats `Base` on a document that has both.
   */
  const named = doc.features
    .map((f) => ({ f, key: f.name.toLowerCase().replace(/\s*\d+$/, '') }))
    .filter(({ f, key }) => key.length > 0 && (lower.includes(key) || lower.includes(f.name.toLowerCase())))
    .sort((a, b) => b.key.length - a.key.length)[0]?.f;

  const kindWord = KINDS.find((k) => k.words.some((w) => lower.includes(w)));
  const paramWord = PARAMETERS.find((p) => p.words.some((w) => new RegExp(`\\b${w}\\b`).test(lower)));
  const measure = findMeasures(text)[0];

  if (RENAME.test(lower) && named) {
    const to = /(?:rename[^"']*|call it)\s+["']?([^"']+?)["']?\s*$/i.exec(text);
    return to ? { kind: 'rename', target: named.name, name: to[1]!.trim() } : null;
  }

  if (UNSUPPRESS.test(lower) && named) return { kind: 'unsuppress', target: named.name };
  if (SUPPRESS.test(lower) && named) return { kind: 'suppress', target: named.name };
  if (REMOVE.test(lower) && named) return { kind: 'remove', target: named.name };

  // A dimension with a target and a parameter is a change to that dimension. Checked before
  // `add`, because "give it a 40 mm bore" on a feature that already has one is an edit.
  if (named && paramWord && measure) {
    const key = keyOn(doc, named.name, paramWord.keys);
    if (key) {
      return {
        kind: 'set', target: named.name, parameter: key,
        value: Math.round(measure.mm * 1000) / 1000,
      };
    }
  }

  if (ADD.test(lower) && kindWord) {
    const requirement = readRequirements(text)[0];
    return {
      kind: 'add',
      feature: kindWord.kind,
      ...(paramWord && measure
        ? { parameter: paramWord.keys[0]!, value: Math.round(measure.mm * 1000) / 1000 }
        : {}),
      ...(requirement ? {} : {}),
    };
  }

  // A dimension and a parameter but no named feature: the only unambiguous reading is that it
  // is about the one feature that has that parameter. More than one and it is not an edit —
  // guessing which would edit the wrong part of someone's model.
  if (paramWord && measure) {
    const candidates = doc.features
      .map((f) => ({ f, key: keyOn(doc, f.name, paramWord.keys) }))
      .filter((x): x is { f: typeof doc.features[number]; key: string } => x.key !== null);

    if (candidates.length === 1) {
      return {
        kind: 'set', target: candidates[0]!.f.name, parameter: candidates[0]!.key,
        value: Math.round(measure.mm * 1000) / 1000,
      };
    }
  }

  return null;
}

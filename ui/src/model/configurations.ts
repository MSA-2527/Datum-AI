/**
 * Configurations: one document, several sizes of the part it describes.
 *
 * A family of parts is one design. A bracket in three lengths, a valve body in four port sizes,
 * a housing with and without its mounting lugs — modelling each as its own document means every
 * later correction has to be made three or four times, and one of them will be missed.
 *
 * A configuration is a named set of parameter values, plus which features are suppressed.
 * Nothing else: no separate geometry, no copy of the tree. Switching one applies the values and
 * rebuilds, so every configuration is always the current design rather than a snapshot of it
 * taken whenever someone last remembered to update it.
 *
 * That restriction is the whole point. Anything a configuration could carry beyond parameters
 * and suppression would be a way for two configurations to become different *designs*, which is
 * the problem this exists to prevent.
 */

import { type Document } from './document';

export interface Configuration {
  name: string;
  /** Parameter name to value. Only the ones this configuration changes. */
  values: Record<string, number | string>;
  /** Features switched off in this configuration, by id. */
  suppressed: string[];
  note?: string;
}

/** Everything a document needs to remember about its configurations. */
export interface ConfigurationSet {
  active: string;
  list: Configuration[];
}

export const DEFAULT_NAME = 'Default';

export function configurationsOf(doc: Document): ConfigurationSet {
  const raw = (doc as { configurations?: unknown }).configurations;
  if (!raw || typeof raw !== 'object') return { active: DEFAULT_NAME, list: [] };

  const set = raw as Partial<ConfigurationSet>;
  return {
    active: typeof set.active === 'string' ? set.active : DEFAULT_NAME,
    list: Array.isArray(set.list) ? set.list : [],
  };
}

/**
 * Captures the document's current state as a configuration.
 *
 * Every global parameter, not only the ones that differ from some baseline. A configuration
 * that stored differences would depend on what it was different *from*, and editing the
 * baseline would silently change every configuration built on it.
 */
export function captureConfiguration(doc: Document, name: string, note?: string): Configuration {
  const values: Record<string, number | string> = {};
  for (const g of doc.globals ?? []) values[g.name] = g.value;

  return {
    name,
    values,
    suppressed: doc.features.filter((f) => f.suppressed).map((f) => f.id),
    ...(note ? { note } : {}),
  };
}

/**
 * Applies a configuration to a document.
 *
 * Parameters the configuration does not name are left alone rather than cleared — a parameter
 * added after a configuration was captured should not vanish when that configuration is
 * selected, which would be a design silently losing a dimension.
 *
 * Suppression is applied in full, because it *is* a complete statement: a feature not in the
 * list is on.
 */
export function applyConfiguration(doc: Document, config: Configuration): Document {
  const suppressed = new Set(config.suppressed);

  return {
    ...doc,
    globals: (doc.globals ?? []).map((g) =>
      Object.prototype.hasOwnProperty.call(config.values, g.name)
        ? { ...g, value: config.values[g.name]! }
        : g),
    features: doc.features.map((f) => ({ ...f, suppressed: suppressed.has(f.id) })),
    configurations: { ...configurationsOf(doc), active: config.name },
  } as Document;
}

/** Adds or replaces a configuration by name, keeping the order stable. */
export function saveConfiguration(doc: Document, config: Configuration): Document {
  const set = configurationsOf(doc);
  const at = set.list.findIndex((c) => c.name === config.name);

  const list = at >= 0
    ? set.list.map((c, i) => (i === at ? config : c))
    : [...set.list, config];

  return { ...doc, configurations: { active: config.name, list } } as Document;
}

export function removeConfiguration(doc: Document, name: string): Document {
  const set = configurationsOf(doc);
  const list = set.list.filter((c) => c.name !== name);

  return {
    ...doc,
    configurations: {
      active: set.active === name ? (list[0]?.name ?? DEFAULT_NAME) : set.active,
      list,
    },
  } as Document;
}

/**
 * What differs between configurations, for a table showing them side by side.
 *
 * Only the parameters that actually vary. A design table listing forty parameters of which
 * three differ is one someone has to read forty rows of to find the three.
 */
export function comparison(doc: Document): {
  parameters: string[];
  rows: { name: string; values: (number | string | undefined)[] }[];
} {
  const set = configurationsOf(doc);
  if (set.list.length === 0) return { parameters: [], rows: [] };

  const names = new Set<string>();
  for (const c of set.list) for (const key of Object.keys(c.values)) names.add(key);

  const varying = [...names].filter((key) => {
    const seen = new Set(set.list.map((c) => String(c.values[key] ?? '')));
    return seen.size > 1;
  }).sort();

  return {
    parameters: varying,
    rows: set.list.map((c) => ({
      name: c.name,
      values: varying.map((key) => c.values[key]),
    })),
  };
}

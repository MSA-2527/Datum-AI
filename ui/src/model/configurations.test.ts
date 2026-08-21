import { describe, expect, it } from 'vitest';
import {
  applyConfiguration, captureConfiguration, comparison, configurationsOf,
  removeConfiguration, saveConfiguration,
} from './configurations';
import {
  addFeature, defaultParams, deserialise, emptyDocument, evaluateDocument, serialise,
  type Document,
} from './document';
import { bounds } from '../kernel/topo/mesh';

/**
 * Configurations.
 *
 * A family of parts is one design. Modelling three sizes as three documents means every later
 * correction has to be made three times, and one of them will be missed.
 *
 * The restriction that makes this work is that a configuration carries parameter values and
 * suppression and nothing else. Anything more would be a way for two configurations to become
 * different *designs*, which is the problem it exists to prevent — so several tests here are
 * about what it does not do.
 */

function family(): Document {
  let doc = emptyDocument('Bracket');
  doc = {
    ...doc,
    globals: [
      { name: 'length', value: 100, units: 'mm' },
      { name: 'thickness', value: 6, units: 'mm' },
    ],
  };
  doc = addFeature(doc, 'box', {
    ...defaultParams('box'), length: 'length', width: 40, height: 'thickness',
  }, 'Plate');
  return doc;
}

const size = (doc: Document) => {
  const bb = bounds(evaluateDocument(doc).mesh);
  return [bb.max[0]! - bb.min[0]!, bb.max[2]! - bb.min[2]!];
};

describe('capturing and applying', () => {
  it('takes the current parameter values', () => {
    const c = captureConfiguration(family(), 'Short');
    expect(c.values).toEqual({ length: 100, thickness: 6 });
  });

  it('captures every parameter, not only the ones that differ from something', () => {
    // A configuration storing differences would depend on what it was different *from*, and
    // editing that baseline would silently change every configuration built on it.
    const c = captureConfiguration(family(), 'Short');
    expect(Object.keys(c.values).sort()).toEqual(['length', 'thickness']);
  });

  it('rebuilds the part at the configuration it is given', () => {
    let doc = family();
    doc = saveConfiguration(doc, captureConfiguration(doc, 'Short'));
    doc = saveConfiguration(doc, {
      name: 'Long', values: { length: 250, thickness: 10 }, suppressed: [],
    });

    expect(size(applyConfiguration(doc, configurationsOf(doc).list[0]!))).toEqual([100, 6]);
    expect(size(applyConfiguration(doc, configurationsOf(doc).list[1]!))).toEqual([250, 10]);
  });

  it('leaves alone a parameter the configuration does not name', () => {
    // A parameter added after a configuration was captured must not vanish when that
    // configuration is selected — that is a design quietly losing a dimension.
    let doc = family();
    doc = { ...doc, globals: [...doc.globals, { name: 'holeDia', value: 8, units: 'mm' }] };

    const applied = applyConfiguration(doc, {
      name: 'Long', values: { length: 250 }, suppressed: [],
    });

    expect(applied.globals.find((g) => g.name === 'holeDia')!.value).toBe(8);
    expect(applied.globals.find((g) => g.name === 'length')!.value).toBe(250);
  });
});

describe('suppression', () => {
  function withLug(): Document {
    let doc = family();
    doc = addFeature(doc, 'cylinder', { ...defaultParams('cylinder'), diameter: 20 }, 'Lug');
    return doc;
  }

  it('switches a feature off in one configuration and on in another', () => {
    const doc = withLug();
    const lug = doc.features[1]!;

    const without = applyConfiguration(doc, { name: 'Plain', values: {}, suppressed: [lug.id] });
    const with_ = applyConfiguration(doc, { name: 'Lugged', values: {}, suppressed: [] });

    expect(evaluateDocument(without).volume).toBeLessThan(evaluateDocument(with_).volume);
  });

  it('is a complete statement, so a feature not listed comes back on', () => {
    let doc = withLug();
    doc = { ...doc, features: doc.features.map((f) => ({ ...f, suppressed: true })) };

    const applied = applyConfiguration(doc, { name: 'All on', values: {}, suppressed: [] });
    expect(applied.features.every((f) => !f.suppressed)).toBe(true);
  });
});

describe('managing the set', () => {
  it('replaces one of the same name rather than adding a duplicate', () => {
    let doc = family();
    doc = saveConfiguration(doc, { name: 'Short', values: { length: 80 }, suppressed: [] });
    doc = saveConfiguration(doc, { name: 'Short', values: { length: 90 }, suppressed: [] });

    const set = configurationsOf(doc);
    expect(set.list).toHaveLength(1);
    expect(set.list[0]!.values.length).toBe(90);
  });

  it('keeps the order when replacing, so the list does not reshuffle as it is edited', () => {
    let doc = family();
    doc = saveConfiguration(doc, { name: 'A', values: {}, suppressed: [] });
    doc = saveConfiguration(doc, { name: 'B', values: {}, suppressed: [] });
    doc = saveConfiguration(doc, { name: 'A', values: { length: 5 }, suppressed: [] });

    expect(configurationsOf(doc).list.map((c) => c.name)).toEqual(['A', 'B']);
  });

  it('moves the active one along when the active is deleted', () => {
    let doc = family();
    doc = saveConfiguration(doc, { name: 'A', values: {}, suppressed: [] });
    doc = saveConfiguration(doc, { name: 'B', values: {}, suppressed: [] });
    doc = removeConfiguration(doc, 'B');

    expect(configurationsOf(doc).active).toBe('A');
  });

  it('survives a save and reopen', () => {
    let doc = family();
    doc = saveConfiguration(doc, { name: 'Long', values: { length: 250 }, suppressed: [] });

    const again = deserialise(serialise(doc))!;
    expect(configurationsOf(again).list[0]!.values.length).toBe(250);
  });
});

describe('the comparison table', () => {
  it('lists only the parameters that actually vary', () => {
    // Forty parameters of which three differ is a table someone has to read forty rows of to
    // find the three.
    let doc = family();
    doc = saveConfiguration(doc, { name: 'S', values: { length: 80, thickness: 6 }, suppressed: [] });
    doc = saveConfiguration(doc, { name: 'M', values: { length: 120, thickness: 6 }, suppressed: [] });
    doc = saveConfiguration(doc, { name: 'L', values: { length: 200, thickness: 6 }, suppressed: [] });

    const table = comparison(doc);
    expect(table.parameters).toEqual(['length']);
    expect(table.rows.map((r) => r.values[0])).toEqual([80, 120, 200]);
  });

  it('says nothing when there are no configurations', () => {
    expect(comparison(family())).toEqual({ parameters: [], rows: [] });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autosave, clearAutosave, listSaved, restoreAutosave } from './persistence';

/**
 * Saving and restoring, when the browser will not co-operate.
 *
 * The happy path is exercised by everything that uses it. What is checked here is the
 * unhappy one, which is the only one that can lose a user's work: storage denied, storage
 * full, storage holding something this version cannot read.
 */

describe('when the browser refuses storage', () => {
  /*
   * A third-party iframe, a locked profile, private browsing on some hosts: `localStorage`
   * exists as a property and throws `SecurityError` on the first touch. Writing was guarded and
   * reading was not — and this module is what the SOLIDWORKS task pane restores through, which
   * is an iframe. The one place the denial is likely is the place this runs.
   */
  const denied = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };

  let original: Storage;

  beforeEach(() => {
    original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: denied, setItem: denied, removeItem: denied, key: denied, length: 0 },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
  });

  it('reports nothing to restore rather than throwing', () => {
    expect(() => restoreAutosave()).not.toThrow();
    expect(restoreAutosave().doc).toBeNull();
  });

  it('reports a failed save rather than throwing', () => {
    expect(autosave({ features: [] } as never)).toBe(false);
  });

  it('lists an empty library rather than throwing', () => {
    expect(() => listSaved()).not.toThrow();
    expect(listSaved()).toEqual([]);
  });

  it('clears without complaint', () => {
    expect(() => clearAutosave()).not.toThrow();
  });
});

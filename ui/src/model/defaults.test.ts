import { describe, expect, it } from 'vitest';
import { SCRIPT_KINDS, runScript } from '../generate/script';
import { defaultParams, evaluateDocument } from './document';
import { health, massProperties, triCount } from '../kernel/topo/mesh';

/**
 * Every feature, built from nothing but its own defaults.
 *
 * The cheapest possible test and one of the most valuable, because a feature's defaults are
 * what the toolbar button produces: click Revolve and this is the part you get, before you have
 * touched a single parameter. A default that does not build is the first thing a new user
 * meets.
 *
 * It exists because the defaults were in two places and disagreed. A feature added from the
 * toolbar carried `defaultParams`; the same feature written in a script carried only what was
 * written, and every unwritten field fell through to a second set of literals inside the
 * evaluator. `revolve Body` therefore built a 60 mm section centred on the axis — a section
 * crossing its own axis of revolution, which cancels itself out — and produced a closed,
 * manifold, 696-triangle solid of **exactly zero volume**. Closed and manifold is what every
 * check in this codebase asks about a mesh, so every one of them passed it.
 */

/** Modifiers need something to modify; the rest make their own material. */
const MAKES_ITS_OWN = new Set([
  'box', 'cylinder', 'sphere', 'sketch', 'extrude', 'revolve', 'loft', 'sweep',
]);

/** A sketch with no sketch in it is empty by definition, and says so rather than guessing. */
const NEEDS_INPUT = new Set(['sketch']);

describe('what a toolbar button builds', () => {
  for (const kind of SCRIPT_KINDS) {
    if (kind === 'archetype' || NEEDS_INPUT.has(kind)) continue;

    it(`${kind} builds a solid with volume from its defaults`, () => {
      const base = MAKES_ITS_OWN.has(kind) ? '' : 'box Base length=60 width=40 height=20\n';
      const result = runScript(`${base}${kind} Thing`);

      expect(result.errors.map((e) => e.message)).toEqual([]);

      const evaluated = evaluateDocument(result.doc);
      expect([...evaluated.errors.values()], `${kind} failed to evaluate`).toEqual([]);

      expect(triCount(evaluated.mesh), `${kind} built nothing`).toBeGreaterThan(0);
      expect(health(evaluated.mesh).closed, `${kind} left the solid open`).toBe(true);

      // The assertion that caught the revolve: closed and manifold says the mesh is sound,
      // not that it encloses anything. A shape can be both and still be no solid at all.
      expect(massProperties(evaluated.mesh).volume, `${kind} encloses no volume`)
        .toBeGreaterThan(1);
    });
  }

  it('gives a script the same defaults as the toolbar', () => {
    /*
     * The invariant behind all of the above. Anything that adds a feature has to start from one
     * table, or the language and the interface describe different applications.
     */
    for (const kind of SCRIPT_KINDS) {
      if (kind === 'archetype') continue;

      const base = MAKES_ITS_OWN.has(kind) ? '' : 'box Base length=60 width=40 height=20\n';
      const script = runScript(`${base}${kind} Thing`);
      const written = script.doc.features.at(-1)!;

      for (const [key, value] of Object.entries(defaultParams(kind))) {
        expect(written.params[key], `${kind}.${key} differs from the toolbar's default`)
          .toEqual(value);
      }
    }
  });
});

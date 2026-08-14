import { describe, expect, it } from 'vitest';
import { evaluateExpr, readNumber, resolveParameters } from './expr';
import {
  addFeature, emptyDocument, evaluateDocument, parameterErrors, parametersOf, resolvedPlacement,
} from './document';
import { bounds } from '../kernel/topo/mesh';

/**
 * Expressions over named parameters.
 *
 * The point of all this is one behaviour: change a driving dimension and everything written in
 * terms of it follows. Without that, a generated model is a result — re-prompting replaces it
 * rather than editing it. The last block here is the one that actually proves it.
 */

const V = { wheelbase: 2335, track: 1400, bore: 86 };

describe('evaluating an expression', () => {
  it('does the arithmetic a dimension needs', () => {
    expect(evaluateExpr('wheelbase / 2', V).value).toBe(1167.5);
    expect(evaluateExpr('bore * 1.5 + 3', V).value).toBe(132);
    expect(evaluateExpr('-track / 2', V).value).toBe(-700);
    expect(evaluateExpr('(bore + 4) * 2', V).value).toBe(180);
    expect(evaluateExpr('1.5e3 + 1', V).value).toBe(1501);
  });

  it('raises to a power right-associatively, as every engineering tool does', () => {
    expect(evaluateExpr('2^3^2', V).value).toBe(512);
  });

  it('offers the functions a drawing needs, in degrees', () => {
    expect(evaluateExpr('sin(30) * 100', V).value).toBeCloseTo(50, 9);
    expect(evaluateExpr('round(bore * 0.8)', V).value).toBe(69);
    expect(evaluateExpr('max(bore, 100)', V).value).toBe(100);
    expect(evaluateExpr('hypot(3, 4)', V).value).toBe(5);
  });

  it('reports what is wrong in words a user can act on', () => {
    expect(evaluateExpr('nope + 1', V).error).toMatch(/no parameter called nope/);
    expect(evaluateExpr('2 +', V).error).toMatch(/ends too early/);
    expect(evaluateExpr('(1 + 2', V).error).toMatch(/never closed/);
    expect(evaluateExpr('wheelbase / 0', V).error).toMatch(/divides by zero/);
    expect(evaluateExpr('1 & 2', V).error).toMatch(/is not something an expression can contain/);
  });

  it('reaches nothing on the prototype chain', () => {
    // These names come from a language model over the network. A bare `name in values` reports
    // `constructor` and `toString` as parameters and hands back a *function* where a number
    // belongs; a bare `FUNCTIONS[name]` makes them callable. Both go through `Object.hasOwn`.
    for (const attack of ['constructor', '__proto__', 'valueOf', 'toString', 'hasOwnProperty']) {
      expect(evaluateExpr(attack, V).error).toMatch(/no parameter called/);
      expect(evaluateExpr(`${attack}(1)`, V).error).toMatch(/no function called/);
    }
  });

  it('has no way to reach JavaScript at all', () => {
    // Parsed by hand rather than by `Function` or `eval`, which is the only reason the above
    // is a closed question rather than an ongoing one.
    for (const attack of [
      'globalThis', 'window.alert(1)', 'fetch("/x")', '(()=>1)()', 'a?.b', '1;2', 'this',
    ]) {
      expect(evaluateExpr(attack, V).error).toBeTruthy();
    }
  });
});

describe('resolving a parameter table', () => {
  it('lets parameters be written in terms of each other, in any order', () => {
    // A plan comes from a language model and will not arrive in dependency order.
    const { values, errors } = resolveParameters([
      { name: 'cornerX', value: 'halfTrack + inset', units: 'mm' },
      { name: 'halfTrack', value: 'track / 2', units: 'mm' },
      { name: 'track', value: 1400, units: 'mm' },
      { name: 'inset', value: 25, units: 'mm' },
    ]);

    expect(errors.size).toBe(0);
    expect(values).toEqual({ track: 1400, inset: 25, halfTrack: 700, cornerX: 725 });
  });

  it('names a circular definition as circular', () => {
    // `a = b + 1` with `b = a + 1` is circular and neither expression names itself. Reporting
    // "there is no parameter called b" is true in a narrow sense and useless for fixing it.
    const { values, errors } = resolveParameters([
      { name: 'a', value: 'b + 1', units: 'mm' },
      { name: 'b', value: 'a + 1', units: 'mm' },
      { name: 'selfish', value: 'selfish * 2', units: 'mm' },
      { name: 'fine', value: 5, units: 'mm' },
    ]);

    expect(values).toEqual({ fine: 5 });
    expect(errors.get('a')).toMatch(/defined in terms of itself/);
    expect(errors.get('b')).toMatch(/defined in terms of itself/);
    expect(errors.get('selfish')).toMatch(/defined in terms of itself/);
  });

  it('distinguishes a missing reference from a circular one', () => {
    const { errors } = resolveParameters([{ name: 'x', value: 'notThere + 1', units: 'mm' }]);
    expect(errors.get('x')).toMatch(/no parameter called notThere/);
  });
});

describe('reading a value that may be either', () => {
  it('takes a literal, an expression, or falls back', () => {
    expect(readNumber(42, V, 0).value).toBe(42);
    expect(readNumber('bore / 2', V, 0).value).toBe(43);
    expect(readNumber(undefined, V, 9).value).toBe(9);
    expect(readNumber('', V, 9).value).toBe(9);
  });

  it('falls back and explains, rather than producing a silent zero', () => {
    const r = readNumber('junk!', V, 7);
    expect(r.value).toBe(7);
    expect(r.error).toBeTruthy();
  });
});

describe('parameters drive the model', () => {
  /** A plate sized by a parameter, with a boss placed at half its length. */
  function driven(plateLength: number | string = 200) {
    let doc = emptyDocument('Driven');
    doc = {
      ...doc,
      globals: [
        { name: 'plateLength', value: plateLength, units: 'mm' },
        { name: 'plateWidth', value: 'plateLength * 0.6', units: 'mm' },
      ],
    };
    doc = addFeature(doc, 'box',
      { length: 'plateLength', width: 'plateWidth', height: 10, operation: 'place' }, 'Plate');
    doc = addFeature(doc, 'cylinder', { diameter: 20, height: 30, operation: 'place' }, 'Boss');
    return {
      ...doc,
      features: doc.features.map((f, i) =>
        i === 1 ? { ...f, placementExpr: { x: 'plateLength / 2 - 20' } } : f),
    };
  }

  const size = (doc: ReturnType<typeof driven>) => {
    const b = bounds(evaluateDocument(doc).mesh);
    return [0, 1, 2].map((i) => Number((b.max[i] - b.min[i]).toFixed(3)));
  };

  it('sizes a feature from a parameter', () => {
    expect(size(driven(200))).toEqual([200, 120, 30]);
  });

  it('moves everything derived from a parameter when it changes', () => {
    // The whole point. One edit, and the plate resizes, the derived width follows it, and the
    // boss moves — none of which is true when a generator emits literal coordinates.
    const before = driven(200);
    const after = { ...before, globals: before.globals.map((g) =>
      g.name === 'plateLength' ? { ...g, value: 300 } : g) };

    expect(size(before)).toEqual([200, 120, 30]);
    expect(size(after)).toEqual([300, 180, 30]);

    expect(resolvedPlacement(before.features[1], before)!.x).toBe(80);
    expect(resolvedPlacement(after.features[1], after)!.x).toBe(130);
  });

  it('keeps the model standing when a parameter breaks', () => {
    // A broken expression must show up as a diagnostic, not as geometry collapsing to the
    // origin. Falling back to the stored number leaves something on screen to fix.
    const broken = driven('nope * 2');

    expect(parameterErrors(broken).get('plateLength')).toMatch(/no parameter called nope/);
    expect(evaluateDocument(broken).mesh.indices.length).toBeGreaterThan(0);
  });

  it('resolves the same values whichever way it is asked', () => {
    const doc = driven(250);
    expect(parametersOf(doc)).toEqual({ plateLength: 250, plateWidth: 150 });
  });
});

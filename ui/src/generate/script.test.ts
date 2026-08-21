import { describe, expect, it } from 'vitest';
import { printScript, runScript, scriptVocabulary, SCRIPT_KINDS } from './script';
import { evaluateDocument } from '../model/document';
import { health, massProperties } from '../kernel/topo/mesh';

/**
 * DatumScript.
 *
 * Two properties have to hold, and they pull against each other.
 *
 * It must be **more expressive than the catalogue** — that is the entire reason for it — which
 * means asserting that combinations no archetype anticipates come out right, against closed
 * forms computed by hand.
 *
 * And it must be **no less safe**. The guarantee that makes this application different is that
 * a model cannot emit geometry the kernel would not have built; a language is only worth
 * having if it keeps that. So the refusals are tested as hard as the successes: an unknown
 * feature, an argument no feature has, a choice outside its own list, a parameter that does
 * not resolve. Each must fail at parse time, by name, with a line number.
 */

const built = (source: string) => {
  const r = runScript(source);
  if (!r.ok) throw new Error(`script failed:\n${r.errors.map((e) => `${e.line}: ${e.message}`).join('\n')}`);
  const ev = evaluateDocument(r.doc);
  return { ...r, ev, volume: massProperties(ev.mesh).volume };
};

describe('what a script builds', () => {
  it('builds a solid from one statement', () => {
    const b = built('box Body length=60 width=40 height=20');

    expect(b.volume).toBeCloseTo(60 * 40 * 20, 3);
    expect(health(b.ev.mesh).closed).toBe(true);
  });

  it('sizes features from shared parameters', () => {
    const b = built(`
      param L = 100
      param W = 60
      param T = 10

      box Body length=L width=W height=T
    `);

    expect(b.volume).toBeCloseTo(100 * 60 * 10, 3);
  });

  it('evaluates arithmetic over parameters', () => {
    const b = built(`
      param L = 100
      box Body length=L width=L/2 height=L*0.1
    `);

    expect(b.volume).toBeCloseTo(100 * 50 * 10, 3);
  });

  it('resolves a parameter declared after the one that uses it', () => {
    // A program written by a model does not arrive in dependency order.
    const b = built(`
      param W = L / 2
      param L = 80
      box Body length=L width=W height=10
    `);

    expect(b.volume).toBeCloseTo(80 * 40 * 10, 3);
  });

  it('composes features the catalogue has no archetype for', () => {
    // A plate, bored, pocketed and blended — no archetype is this, and it needs none.
    const b = built(`
      param L = 120
      param W = 80
      param T = 12

      box    Body   length=L width=W height=T
      hole   Bore   diameter=20 holeType=through pattern=single x=0 y=0
      pocket Relief length=40 width=30 depth=4 x=0 y=0 cornerRadius=0
      chamfer Break distance=2
    `);

    expect(b.doc.features.map((f) => f.kind)).toEqual(['box', 'hole', 'pocket', 'chamfer']);
    expect(health(b.ev.mesh).closed).toBe(true);

    // 115 200 mm³ less a ⌀20 bore through 12 (3 770) less a 40 × 30 × 4 pocket (4 800),
    // less whatever the chamfer takes off the edges.
    expect(b.volume).toBeLessThan(115200 - 8000);
    expect(b.volume).toBeGreaterThan(115200 - 12000);
  });

  it('places a feature where it was told to', () => {
    const b = built(`
      box  Base   length=100 width=100 height=10
      cylinder Boss diameter=20 height=20 at.z=15
    `);

    const boss = b.doc.features.find((f) => f.name === 'Boss')!;
    expect(boss.placement?.z).toBe(15);
    expect(b.volume).toBeGreaterThan(100 * 100 * 10);
  });

  it('takes a choice by its own word, not a number', () => {
    const b = built(`
      box Body length=60 width=60 height=20
      cylinder Cut diameter=20 height=40 operation=cut
    `);

    expect(b.volume).toBeLessThan(60 * 60 * 20);
  });

  it('carries a name and a material onto the document', () => {
    const r = runScript(`
      name Bearing block
      material Stainless 304
      box Body length=40 width=40 height=40
    `);

    expect(r.ok).toBe(true);
    expect(r.doc.name).toBe('Bearing block');
    expect(r.doc.material).toBe('Stainless 304');
  });

  it('ignores comments and blank lines', () => {
    const b = built(`
      # a plate

      box Body length=50 width=50 height=5   # sized for stock
    `);

    expect(b.volume).toBeCloseTo(50 * 50 * 5, 3);
  });
});

describe('what a script cannot do', () => {
  /*
   * The safety property. Every one of these must fail before anything is built — a script is
   * only worth having if it cannot express something the kernel would not have built.
   */
  it('refuses a feature the kernel does not implement', () => {
    const r = runScript('sculpt Blob smoothness=3');

    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain('not something this can build');
    expect(r.errors[0]!.line).toBe(1);
  });

  it('refuses an argument the feature does not have', () => {
    const r = runScript('box Body length=10 width=10 height=10 flangeStyle=2');

    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain('flangeStyle');
    expect(r.errors[0]!.message).toContain('It takes:');
  });

  it('refuses a choice outside its own list', () => {
    const r = runScript(`
      box Body length=10 width=10 height=10
      cylinder Cut diameter=5 height=20 operation=dissolve
    `);

    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain('dissolve');
    expect(r.errors[0]!.message).toContain('add, cut, intersect');
  });

  it('refuses an expression naming a parameter that does not exist', () => {
    const r = runScript('box Body length=widthOfNothing width=10 height=10');

    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('widthOfNothing'))).toBe(true);
  });

  it('reports a circular parameter by name rather than leaving a silent zero', () => {
    const r = runScript(`
      param a = b + 1
      param b = a + 1
      box Body length=a width=10 height=10
    `);

    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /could not be worked out|a|b/.test(e.message))).toBe(true);
  });

  it('refuses a parameter declared twice', () => {
    const r = runScript(`
      param L = 10
      param L = 20
      box Body length=L width=10 height=10
    `);

    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('declared twice'))).toBe(true);
  });

  it('reports every error, not just the first', () => {
    // A model repairing its own program needs all of them, or it converges one line per round.
    const r = runScript(`
      sculpt Blob
      box Body nonsense=1
      cylinder Cut operation=vanish
    `);

    expect(r.errors.length).toBeGreaterThanOrEqual(3);
    expect(new Set(r.errors.map((e) => e.line)).size).toBeGreaterThanOrEqual(3);
  });

  it('names the line, and quotes it, so an error can be shown in place', () => {
    const r = runScript(`box Body length=10 width=10 height=10\nsculpt Blob`);

    expect(r.errors[0]!.line).toBe(2);
    expect(r.errors[0]!.source).toBe('sculpt Blob');
  });

  it('catches an argument whose spaces broke it into words', () => {
    const r = runScript('box Body radius = 3');

    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain('"="');
  });
});

describe('the round trip', () => {
  /*
   * A script is a *format*, not only an input: a part built by clicking must read back as a
   * program, and a program must edit with the sliders. Neither form is the primary one.
   */
  it('prints a document and reads it back to the same solid', () => {
    const first = built(`
      param L = 90
      box    Body   length=L width=60 height=12
      hole   Bore   diameter=16 holeType=through pattern=single x=0 y=0
      fillet Edges  radius=3
    `);

    const printed = printScript(first.doc);
    const again = built(printed);

    expect(again.volume).toBeCloseTo(first.volume, 6);
    expect(again.doc.features.map((f) => f.kind)).toEqual(first.doc.features.map((f) => f.kind));
  });

  it('prints something that parses without error', () => {
    const first = built('box Body length=40 width=40 height=40');
    const printed = printScript(first.doc);

    expect(runScript(printed).errors).toEqual([]);
  });

  it('keeps the name and material through a round trip', () => {
    const r = runScript('name Spacer\nmaterial Brass\nbox Body length=20 width=20 height=5');
    const again = runScript(printScript(r.doc));

    expect(again.doc.name).toBe('Spacer');
    expect(again.doc.material).toBe('Brass');
  });
});

describe('the vocabulary a model is given', () => {
  it('describes every feature the language accepts, and only those', () => {
    const text = scriptVocabulary();

    for (const kind of SCRIPT_KINDS) {
      expect(text, `${kind} is missing from the vocabulary`).toContain(kind);
    }
  });

  it('states a choice field by its allowed words', () => {
    expect(scriptVocabulary()).toMatch(/operation=add\|cut\|intersect/);
  });

  it('is generated from the kernel schema, so it cannot describe a feature that is gone', () => {
    // Every line's keyword must be a kind the parser accepts. If the two ever disagree, a
    // model is being told about something that will be refused.
    for (const line of scriptVocabulary().split('\n')) {
      const keyword = line.split(' ')[0]!;
      expect(SCRIPT_KINDS).toContain(keyword);
    }
  });
});

describe('the catalogue, as a statement', () => {
  /*
   * Without this the language would be an input rather than a format: a document built from
   * the catalogue — which is most of them — could not be printed as a script at all, and the
   * script view would show a part it could not rebuild.
   */
  it('builds a catalogue shape in one line', () => {
    const b = built('archetype Cup archetypeId=cup');

    expect(b.volume).toBeGreaterThan(0);
    expect(health(b.ev.mesh).closed).toBe(true);
  });

  it('takes that shape’s own parameters', () => {
    const tall = built('archetype Cup archetypeId=cup height=120');
    const short = built('archetype Cup archetypeId=cup height=60');

    expect(tall.volume).toBeGreaterThan(short.volume);
  });

  it('refuses a shape the catalogue does not have', () => {
    const r = runScript('archetype Thing archetypeId=crankshaft');

    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain('crankshaft');
  });

  it('refuses a parameter that shape does not have', () => {
    const r = runScript('archetype Cup archetypeId=cup numberOfWheels=4');

    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain('numberOfWheels');
  });

  it('round-trips a catalogue part, which is what makes the view honest', () => {
    const first = built('archetype Plate archetypeId=plate length=150 width=90 thickness=10');
    const again = built(printScript(first.doc));

    expect(again.volume).toBeCloseTo(first.volume, 6);
  });

  it('composes catalogue shapes with kernel features', () => {
    // The point of having both: an archetype knows what a flange is, and the language adds
    // what no archetype anticipated.
    const b = built(`
      archetype Body archetypeId=flange
      hole Tap diameter=8 holeType=through pattern=single x=0 y=0
      chamfer Break distance=1
    `);

    expect(b.doc.features.map((f) => f.kind)).toEqual(['archetype', 'hole', 'chamfer']);
    expect(health(b.ev.mesh).closed).toBe(true);
  });
});

describe('the spelling of a keyword', () => {
  /*
   * Every kind in the vocabulary has to be usable by the exact name the vocabulary gives it.
   * Three of them carry a capital in the middle, and for a while those three were unreachable:
   * the keyword was lowercased before it was looked up, so `patternLinear` — copied verbatim
   * out of the error message listing what this can build — was answered with "not something
   * this can build", followed by a list containing it. A model handed that vocabulary could
   * never use a pattern at all.
   */
  it('accepts every kind it says it accepts', () => {
    for (const kind of SCRIPT_KINDS) {
      const errors = runScript(`${kind} Thing`).errors;
      expect(
        errors.map((e) => e.message).filter((m) => m.includes('is not something this can build')),
        `${kind} is listed in the vocabulary but rejected as unknown`,
      ).toEqual([]);
    }
  });

  it('does not care about case, because case is not information here', () => {
    const a = runScript('BOX Base length=20 width=10 height=5');
    const b = runScript('box Base length=20 width=10 height=5');

    expect(a.errors).toEqual([]);
    expect(a.doc.features.map((f) => f.kind)).toEqual(b.doc.features.map((f) => f.kind));
  });

  it('does not care about the case of an argument name either', () => {
    /*
     * Case was information in one half of a statement and not the other: the kind was matched
     * without it and the argument names with it, so `PatternLinear` was accepted while
     * `flangea` was refused. Several field names carry a capital in the middle, and each one
     * was a place to lose a script to a shift key.
     */
    const a = runScript('box Base Length=20 WIDTH=10 height=5');
    const b = runScript('box Base length=20 width=10 height=5');

    expect(a.errors).toEqual([]);
    expect(a.doc.features[0]?.params).toEqual(b.doc.features[0]?.params);
  });

  it('does not care about the case of a placement key', () => {
    const moved = runScript('box Base length=20 width=10 height=5 AT.X=7');

    expect(moved.errors).toEqual([]);
    expect(moved.doc.features[0]?.placement?.x).toBe(7);
  });

  it('names the argument the way the author wrote it when refusing one', () => {
    // Echoing the canonical spelling of a name that was not found is impossible, and echoing
    // a lowercased version of what they typed makes them hunt for a line they cannot see.
    const wrong = runScript('box Base Lenth=20');

    expect(wrong.errors[0]?.message).toContain('"Lenth"');
  });

  it('still refuses a word that is not a kind', () => {
    expect(runScript('sprocket Thing').errors[0]?.message).toContain('not something this can build');
  });
});

describe('a parameter that still drives the part after a round trip', () => {
  /*
   * `height=plate` was evaluated at parse time and the answer stored, so the document held
   * `height=10` and the parameter it came from was declared and dead. Printing gave back a
   * script whose params drove nothing; changing `plate` moved no geometry. A parametric part
   * that stops being parametric the moment it is saved is not a parametric part.
   */
  const SOURCE = [
    'param plate = 10',
    'box Base length=120 width=80 height=plate',
  ].join('\n');

  it('prints the expression back, not the number it worked out to', () => {
    const printed = printScript(runScript(SOURCE).doc);

    expect(printed).toContain('param plate = 10');
    expect(printed).toContain('height=plate');
  });

  it('still builds to the right size', () => {
    const built = evaluateDocument(runScript(SOURCE).doc);
    expect(massProperties(built.mesh).volume).toBeCloseTo(120 * 80 * 10, 6);
  });

  it('changes the part when the parameter changes', () => {
    const doubled = runScript(SOURCE.replace('param plate = 10', 'param plate = 20'));
    const built = evaluateDocument(doubled.doc);

    expect(massProperties(built.mesh).volume).toBeCloseTo(120 * 80 * 20, 6);
  });

  it('survives being printed and read again', () => {
    // The property that matters for saving and for editing: print, parse, print gives the same
    // script, and the parameter is still connected at the end of it.
    const once = printScript(runScript(SOURCE).doc);
    const twice = printScript(runScript(once).doc);

    expect(twice).toBe(once);
    expect(twice).toContain('height=plate');
  });

  it('keeps arithmetic over parameters, not only bare names', () => {
    const printed = printScript(runScript([
      'param wall = 4',
      'box Body length=60 width=40 height=wall*3',
    ].join('\n')).doc);

    expect(printed).toContain('height=wall*3');
  });

  it('leaves a plain number a plain number', () => {
    const printed = printScript(runScript('box Body length=60 width=40 height=12').doc);
    expect(printed).toContain('height=12');
  });
});

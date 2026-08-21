import { describe, expect, it } from 'vitest';
import { describeInspection, inspectDocument, offRightAngle } from './inspect';
import { runScript } from '../generate/script';
import { evaluateDocument } from '../model/document';

/**
 * Looking at what was built before handing it over.
 *
 * Each case is a document whose defect is put there deliberately, so a finding that does not
 * appear is a miss and a finding that appears on the sound case is a false alarm. Both matter:
 * an inspection that cries wolf gets switched off, and one that stays quiet is decoration.
 */

const LF = String.fromCharCode(10);

function build(lines: string[]) {
  const result = runScript(lines.join(LF));
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return { doc: result.doc, evaluated: evaluateDocument(result.doc) };
}

describe('a part that is put together properly', () => {
  it('has nothing to report', () => {
    const { doc, evaluated } = build([
      'box Base length=120 width=80 height=10',
      'box Post length=20 width=20 height=60 at.x=40 at.z=35',
    ]);

    expect(inspectDocument(doc, evaluated)).toEqual([]);
  });

  it('has nothing to report about a single part either', () => {
    const { doc, evaluated } = build(['box Body length=60 width=40 height=20']);
    expect(inspectDocument(doc, evaluated)).toEqual([]);
  });

  it('counts touching as joined, not as a near miss', () => {
    // The post sits exactly on the base: they share a plane and no volume.
    const { doc, evaluated } = build([
      'box Base length=120 width=80 height=10 at.z=5',
      'box Post length=20 width=20 height=60 at.z=40',
    ]);

    expect(inspectDocument(doc, evaluated).filter((f) => f.kind === 'floating')).toEqual([]);
  });
});

describe('a component in the wrong place', () => {
  it('finds a part floating clear of everything else', () => {
    /*
     * The commonest way a generated assembly is wrong, and the one that is invisible in the text:
     * every dimension right, every material right, and the boss hanging in space above the face
     * it was meant to sit on.
     */
    const { doc, evaluated } = build([
      'box Base length=120 width=80 height=10',
      'box Boss length=20 width=20 height=20 at.z=90',
    ]);

    const floating = inspectDocument(doc, evaluated).filter((f) => f.kind === 'floating');

    expect(floating).toHaveLength(1);
    expect(floating[0]!.feature).toBe('Boss');
    expect(floating[0]!.detail).toMatch(/\d+\.\d mm away/);
  });

  it('measures the gap rather than only naming it', () => {
    const { doc, evaluated } = build([
      'box Base length=100 width=100 height=10',
      'box Boss length=10 width=10 height=10 at.z=55',
    ]);

    // Base spans z −5…5, boss 50…60: a 45 mm gap.
    const floating = inspectDocument(doc, evaluated).find((f) => f.kind === 'floating')!;
    expect(floating.detail).toContain('45.0 mm away');
  });

  it('finds a part swallowed inside another', () => {
    const { doc, evaluated } = build([
      'box Case length=120 width=120 height=120',
      'box Core length=20 width=20 height=20',
    ]);

    const swallowed = inspectDocument(doc, evaluated).filter((f) => f.kind === 'swallowed');

    expect(swallowed).toHaveLength(1);
    expect(swallowed[0]!.feature).toBe('Core');
    // Advisory, because a core inside a casting is a real thing somebody meant.
    expect(swallowed[0]!.severity).toBe('advisory');
  });

  it('scales its tolerance to the part, not to a fixed millimetre', () => {
    // The same proportions at two sizes have to give the same verdict; a fixed tolerance would
    // call one of them joined and the other floating.
    const small = build([
      'box Base length=12 width=8 height=1',
      'box Post length=2 width=2 height=6 at.x=4 at.z=3.5',
    ]);
    const large = build([
      'box Base length=1200 width=800 height=100',
      'box Post length=200 width=200 height=600 at.x=400 at.z=350',
    ]);

    expect(inspectDocument(small.doc, small.evaluated)).toEqual([]);
    expect(inspectDocument(large.doc, large.evaluated)).toEqual([]);
  });
});

describe('a component turned to an angle nobody chose', () => {
  it('finds a near-square rotation', () => {
    const { doc, evaluated } = build([
      'box Base length=120 width=80 height=10',
      'box Post length=20 width=20 height=60 at.z=35 at.rz=89.4',
    ]);

    const askew = inspectDocument(doc, evaluated).filter((f) => f.kind === 'askew');

    expect(askew).toHaveLength(1);
    expect(askew[0]!.detail).toContain('89.40°');
    expect(askew[0]!.detail).toContain('0.60° off square');
  });

  it('says nothing about a square one', () => {
    const { doc, evaluated } = build([
      'box Base length=120 width=80 height=10',
      'box Post length=20 width=20 height=60 at.z=35 at.rz=90',
    ]);

    expect(inspectDocument(doc, evaluated).filter((f) => f.kind === 'askew')).toEqual([]);
  });

  it('says nothing about a frankly oblique one, which is a decision', () => {
    const { doc, evaluated } = build([
      'box Base length=120 width=80 height=10',
      'box Rib length=20 width=20 height=60 at.z=35 at.rz=30',
    ]);

    expect(inspectDocument(doc, evaluated).filter((f) => f.kind === 'askew')).toEqual([]);
  });

  it('reads the angle the same however many turns it has been round', () => {
    expect(offRightAngle(89.4)).toBeCloseTo(0.6, 9);
    expect(offRightAngle(449.4)).toBeCloseTo(0.6, 9);
    expect(offRightAngle(-0.6)).toBeCloseTo(0.6, 9);
    expect(offRightAngle(90)).toBeNull();
    expect(offRightAngle(0)).toBeNull();
    expect(offRightAngle(45)).toBeNull();
  });
});

describe('the size against what was asked for', () => {
  it('reports a part built to the wrong size', () => {
    const { doc, evaluated } = build(['box Body length=180 width=40 height=20']);

    const found = inspectDocument(doc, evaluated, { wanted: { length: 120 } });

    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe('oversize');
    expect(found[0]!.detail).toContain('Asked for 120 mm long; built 180.0 mm');
    expect(found[0]!.detail).toContain('50% over');
  });

  it('reports one built short', () => {
    const { doc, evaluated } = build(['box Body length=60 width=40 height=20']);
    const found = inspectDocument(doc, evaluated, { wanted: { length: 120 } });

    expect(found[0]!.kind).toBe('undersize');
  });

  it('lets a small difference pass, because a fillet changes an envelope', () => {
    const { doc, evaluated } = build(['box Body length=122 width=40 height=20']);
    expect(inspectDocument(doc, evaluated, { wanted: { length: 120 } })).toEqual([]);
  });

  it('checks only the dimensions that were actually asked for', () => {
    /*
     * Checking against a size nobody stated invents a requirement and then reports the part for
     * failing it — which is how a checker teaches people to ignore it.
     */
    const { doc, evaluated } = build(['box Body length=120 width=999 height=999']);
    expect(inspectDocument(doc, evaluated, { wanted: { length: 120 } })).toEqual([]);
  });
});

describe('what it says', () => {
  it('leads with the findings that matter, not with a count', () => {
    const { doc, evaluated } = build([
      'box Base length=120 width=80 height=10',
      'box Boss length=20 width=20 height=20 at.z=90 at.rz=89.4',
    ]);

    const said = describeInspection(inspectDocument(doc, evaluated));

    expect(said).toContain('Boss touches nothing else');
    expect(said).toMatch(/^\d+ things? to check/);
  });

  it('says nothing at all when there is nothing to say', () => {
    expect(describeInspection([])).toBe('');
  });
});

describe('what it will not do', () => {
  it('never refuses — it reports, and the part is handed over', () => {
    /*
     * An exploded view has every component floating, and a part that is wrong in a way the user
     * intended is common. A checker that blocks those is one people switch off, and then it
     * catches nothing at all.
     */
    const { doc, evaluated } = build([
      'box A length=20 width=20 height=20',
      'box B length=20 width=20 height=20 at.x=200',
      'box C length=20 width=20 height=20 at.x=400',
    ]);

    const found = inspectDocument(doc, evaluated);

    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.severity !== 'blocker')).toBe(true);
  });

  it('has nothing to say about an empty document', () => {
    const { doc, evaluated } = build(['param unused = 1']);
    expect(inspectDocument(doc, evaluated)).toEqual([]);
  });
});

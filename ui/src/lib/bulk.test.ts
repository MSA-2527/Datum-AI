import { beforeEach, describe, expect, it } from 'vitest';
import {
  baseName, describeBulk, parseCsv, readManifest, teachFiles, type BulkInput,
} from './bulk';
import { clearExamples, listExamples } from './training';
import { meshToStep } from '../export/step';
import { box, cylinder } from '../kernel/ops/build';
import { archetypeById } from '../generate/archetypes';

/**
 * Teaching a library in one pass.
 *
 * The assertion that matters most is not "it taught some files" — it is that **every file
 * gets an outcome, and the outcome is true**. A run over nine hundred parts will teach a
 * minority of them, and a report that says "taught 40" without accounting for the other 860
 * tells you nothing about whether the next work is more fitter proposers, better descriptions
 * or a different export setting.
 *
 * So each way a file can fail is tested separately and by name.
 */

const stepFor = (mesh: Parameters<typeof meshToStep>[0], name: string) =>
  ({ name, text: meshToStep(mesh, { name }).text }) satisfies BulkInput;

const manifest = (rows: string) =>
  readManifest(`source,export,kind,partNumber,revision,description,material,massGrams,status\n${rows}`);

beforeEach(() => clearExamples());

describe('reading the manifest', () => {
  it('keeps a comma inside a quoted description', () => {
    // Descriptions contain commas far more often than anyone expects, and an unquoted one
    // shifts every later column without announcing it.
    const rows = parseCsv('a,b,c\n"one, two",three,four\n');
    expect(rows[1]).toEqual(['one, two', 'three', 'four']);
  });

  it('reads a doubled quote as one literal quote', () => {
    expect(parseCsv('x\n"Bill""s bracket"\n')[1]).toEqual(['Bill"s bracket']);
  });

  it('ignores blank lines rather than producing empty rows', () => {
    expect(parseCsv('a,b\n\n1,2\n\n')).toHaveLength(2);
  });

  it('finds a row by the exported file name', () => {
    const m = manifest('"C:\\\\lib\\\\Plate.SLDPRT","C:\\\\out\\\\Plate.step","part","P-1","B","a 200 mm mounting plate","6061","511","ok"');

    expect(m.get('plate')?.description).toBe('a 200 mm mounting plate');
    expect(m.get('plate')?.partNumber).toBe('P-1');
    expect(m.get('plate')?.material).toBe('6061');
  });

  it('finds the same row by its source name, since either may be the file that arrives', () => {
    const m = manifest('"C:\\\\lib\\\\Bracket.SLDPRT","C:\\\\out\\\\Renamed.step","part","P-2","A","a bracket","6061","90","ok"');
    expect(m.get('bracket')?.description).toBe('a bracket');
    expect(m.get('renamed')?.description).toBe('a bracket');
  });

  it('is empty when the file has no description column to pair parts with', () => {
    expect(readManifest('source,export,material\na,b,c\n').size).toBe(0);
  });

  it('strips directories and extension, which is all the two sides share', () => {
    expect(baseName('C:\\\\Engineering\\\\Parts\\\\Cover Plate.SLDPRT')).toBe('cover plate');
    expect(baseName('cover plate.step')).toBe('cover plate');
  });
});

describe('teaching a folder', () => {
  it('teaches a part the manifest describes and the fitter recognises', () => {
    const files = [stepFor(box(200, 120, 8, [0, 0, 0], 'Plate'), 'Plate')];
    const m = manifest('"x","C:\\\\out\\\\Plate.step","part","P-1","A","a 200 mm mounting plate","6061","511","ok"');

    const result = teachFiles(files, { manifest: m });

    expect(result.taught).toBe(1);
    expect(result.results[0]!.outcome).toBe('taught');
    expect(result.results[0]!.archetypeId).toBe('box');
    expect(listExamples()[0]!.prompt).toBe('a 200 mm mounting plate');
  });

  it('stores the plan, so the example is in the form the planner emits', () => {
    const files = [stepFor(cylinder(15, 90, [0, 0, 0], [0, 0, 1], 'Bar'), 'Bar')];
    const m = manifest('"x","Bar.step","part","P-2","A","a 30 mm turned bar","1018","500","ok"');

    teachFiles(files, { manifest: m });

    const example = listExamples()[0]!;
    expect(example.plan.components[0]!.shape).toBe('cylinder');
    expect(example.plan.components[0]!.params.diameter).toBeCloseTo(30, 0);
    expect(example.origin).toBe('imported');
  });

  it('takes the material from the manifest, so the mass is the part\'s own', () => {
    const files = [stepFor(box(50, 50, 10), 'Block')];
    const m = manifest('"x","Block.step","part","P-3","A","a spacer block","304 stainless","1000","ok"');

    teachFiles(files, { manifest: m });
    expect(listExamples()[0]!.plan.components[0]!.material).toBe('304 stainless');
  });
});

describe('what it says about the files it could not teach', () => {
  it('names a part the fitter does not recognise, and why', () => {
    // A gear is a real part and not one of the six shapes the fitter recovers. Teaching it as
    // the nearest thing would produce an example answering "gear" with "disc".
    const files = [stepFor(archetypeById('gear')!.build({}).mesh, 'Gear')];
    const m = manifest('"x","Gear.step","part","P-4","A","a 40 tooth spur gear","1018","900","ok"');

    const result = teachFiles(files, { manifest: m });

    expect(result.taught).toBe(0);
    expect(result.results[0]!.outcome).toBe('not recognised');
    expect(result.results[0]!.detail).toMatch(/agreement|not close/);
    expect(listExamples()).toHaveLength(0);
  });

  it('says when a recognised part had no description to pair with', () => {
    // The commonest real failure, and the one the user can act on: populate the property in
    // CAD and export again.
    const result = teachFiles([stepFor(box(60, 40, 10), 'Block')], { manifest: new Map() });

    expect(result.results[0]!.outcome).toBe('no description');
    expect(result.results[0]!.archetypeId).toBe('box');
    expect(result.results[0]!.detail).toMatch(/no description/i);
  });

  it('refuses a solid that did not close rather than measuring it anyway', () => {
    // A shaft comes back cracked at its chamfers. Its dimensions were taken from geometry with
    // faces missing, and an example built from that teaches those dimensions silently.
    const files = [stepFor(archetypeById('shaft')!.build({}).mesh, 'Shaft')];
    const m = manifest('"x","Shaft.step","part","P-5","A","a 25 mm stepped shaft","1018","600","ok"');

    const result = teachFiles(files, { manifest: m });

    expect(result.results[0]!.outcome).toBe('incomplete');
    expect(listExamples()).toHaveLength(0);
  });

  it('teaches an incomplete solid only when told to', () => {
    const files = [stepFor(archetypeById('shaft')!.build({}).mesh, 'Shaft')];
    const m = manifest('"x","Shaft.step","part","P-5","A","a 25 mm stepped shaft","1018","600","ok"');

    const result = teachFiles(files, { manifest: m, allowIncomplete: true });
    expect(result.results[0]!.outcome).not.toBe('incomplete');
  });

  it('names a file that is not a STEP file at all', () => {
    const result = teachFiles([{ name: 'notes.txt', text: 'hello' }]);

    expect(result.results[0]!.outcome).toBe('unreadable');
    expect(result.results[0]!.detail).toMatch(/ISO-10303-21/);
  });
});

describe('the run as a whole', () => {
  it('accounts for every file, not just the ones it taught', () => {
    const files = [
      stepFor(box(200, 120, 8), 'Plate'),
      stepFor(box(60, 40, 10), 'Undescribed'),
      { name: 'junk.step', text: 'not a step file' },
    ];
    const m = manifest('"x","Plate.step","part","P-1","A","a mounting plate","6061","511","ok"');

    const result = teachFiles(files, { manifest: m });

    expect(result.results).toHaveLength(3);
    expect(result.summary.reduce((n, s) => n + s.count, 0)).toBe(3);
    expect(new Set(result.results.map((r) => r.outcome)))
      .toEqual(new Set(['taught', 'no description', 'unreadable']));
  });

  it('summarises the shape of the library in one line', () => {
    const files = [stepFor(box(200, 120, 8), 'Plate'), { name: 'junk.step', text: 'nope' }];
    const text = describeBulk(teachFiles(files));

    expect(text).toMatch(/2 files/);
    expect(text).toMatch(/unreadable/);
  });

  it('says so plainly when given nothing', () => {
    expect(describeBulk(teachFiles([]))).toMatch(/No files/);
  });
});

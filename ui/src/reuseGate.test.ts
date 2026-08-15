import { beforeEach, describe, expect, it } from 'vitest';
import { useModel } from './modelStore';
import { emptyDocument, evaluateDocument } from './model/document';
import { clearLibrary, listLibrary } from './lib/library';
import { clearExamples } from './lib/training';
import { meshToStep } from './export/step';
import { box } from './kernel/ops/build';
import { archetypeById } from './generate/archetypes';

/**
 * The reuse gate, end to end through the store.
 *
 * `lib/reuse.ts` decides whether a saved part answers a request; this is about what the
 * application then does with that answer. Three things have to hold, and each of them was a
 * way an earlier draft went wrong:
 *
 *   - a match must stop the build *before* geometry exists, because an interruption after
 *     the work is done has no value;
 *   - the decision must stay with the user, so both routes out of the offer are tested;
 *   - "build anyway" must not be re-intercepted by the same match, which would trap someone
 *     in a loop they cannot leave.
 */

function reset() {
  clearLibrary();
  clearExamples();
  const doc = emptyDocument();
  useModel.setState({
    doc,
    evaluated: evaluateDocument(doc),
    selectedFeatureId: null,
    editingFeatureId: null,
    undoStack: [],
    redoStack: [],
    notice: null,
    plan: null,
    pending: null,
    reuse: null,
  });
}

/** Builds a part and saves it, which is how anything enters the library. */
async function saveAPlate(name = 'Plate') {
  await useModel.getState().build('a plate', { skipReuse: true });
  const saved = useModel.getState().saveToLibrary(name);
  expect(saved.ok).toBe(true);
}

describe('before anything is generated', () => {
  beforeEach(reset);

  it('an empty library never interrupts', async () => {
    const r = await useModel.getState().build('a plate');
    expect(r.ok).toBe(true);
    expect(useModel.getState().reuse).toBeNull();
    expect(useModel.getState().doc.features.length).toBeGreaterThan(0);
  });

  it('offers the saved part and builds nothing', async () => {
    await saveAPlate('Mounting plate');

    // A different document is open, so a build would visibly replace it.
    useModel.getState().clear();
    const before = useModel.getState().doc;

    const r = await useModel.getState().build('a plate');

    expect(r.message).toContain('Mounting plate');
    expect(useModel.getState().reuse?.match.entry.name).toBe('Mounting plate');
    expect(useModel.getState().doc).toBe(before);           // nothing was built
    expect(useModel.getState().building).toBe(false);       // and nothing is still running
  });

  it('does not interrupt a request the saved part does not answer', async () => {
    await saveAPlate();
    const r = await useModel.getState().build('a cup');

    expect(useModel.getState().reuse).toBeNull();
    expect(r.ok).toBe(true);
    expect(useModel.getState().doc.name.toLowerCase()).toContain('cup');
  });

  it('mentions a same-kind part of a different size while building the new one', async () => {
    await saveAPlate('Small plate');                        // the default plate is 200 mm long
    const r = await useModel.getState().build('a 600 mm long plate');

    expect(useModel.getState().reuse).toBeNull();           // it did build
    expect(r.message).toContain('Small plate');
    expect(r.message).toContain('length 200 mm rather than 600 mm');
  });
});

describe('the decision stays with the user', () => {
  beforeEach(reset);

  it('opening the offered part loads its feature tree', async () => {
    await saveAPlate('Mounting plate');
    useModel.getState().clear();
    await useModel.getState().build('a plate');

    const r = useModel.getState().acceptReuse();

    expect(r.ok).toBe(true);
    expect(useModel.getState().doc.name).toBe('Mounting plate');
    expect(useModel.getState().doc.features.length).toBeGreaterThan(0);
    expect(useModel.getState().reuse).toBeNull();
  });

  it('opening clears the undo history rather than making a part an edit of another', async () => {
    await saveAPlate('Mounting plate');
    await useModel.getState().build('a plate');
    useModel.getState().acceptReuse();

    expect(useModel.getState().undoStack).toHaveLength(0);
  });

  it('building anyway generates, and is not intercepted a second time', async () => {
    await saveAPlate('Mounting plate');
    useModel.getState().clear();
    await useModel.getState().build('a plate');

    const r = await useModel.getState().buildAnyway();

    expect(r.ok).toBe(true);
    expect(useModel.getState().reuse).toBeNull();
    expect(useModel.getState().doc.features.length).toBeGreaterThan(0);
    expect(useModel.getState().doc.name).not.toBe('Mounting plate');
  });

  it('accepting or building anyway with nothing offered is refused, not crashed', async () => {
    expect(useModel.getState().acceptReuse().ok).toBe(false);
    expect((await useModel.getState().buildAnyway()).ok).toBe(false);
  });
});

describe('teaching, from the store', () => {
  beforeEach(reset);

  it('teaches the open part and counts the corpus in the confirmation', async () => {
    await useModel.getState().build('a plate', { skipReuse: true });
    const r = useModel.getState().teach('a 200 mm mounting plate');

    expect(r.ok).toBe(true);
    expect(r.message).toContain('1 component.');            // not "1 components"
    expect(r.message).toContain('1 example now steers');    // not "1 example now steer"
    expect(useModel.getState().examples()).toHaveLength(1);
  });

  it('offers the request that produced the part, so it need not be retyped', async () => {
    await useModel.getState().build('a plate', { skipReuse: true });
    expect(useModel.getState().lastRequest).toBe('a plate');
  });

  it('refuses to teach without a request and says why', () => {
    const r = useModel.getState().teach('  ');
    expect(r.ok).toBe(false);
    expect(useModel.getState().notice?.tone).toBe('warn');
  });

  it('forgets an example again', async () => {
    await useModel.getState().build('a plate', { skipReuse: true });
    useModel.getState().teach('a mounting plate');

    const id = useModel.getState().examples()[0]!.id;
    expect(useModel.getState().forget(id).ok).toBe(true);
    expect(useModel.getState().examples()).toHaveLength(0);
  });
});

describe('teaching a folder, from the store', () => {
  beforeEach(reset);

  it('says nothing was taught rather than claiming a number', () => {
    // A plate with four fixing holes is the commonest part in any library, and the fitter has
    // no proposal for one — the genus gate correctly refuses to call it a solid block. So a
    // real run over a real folder teaches nothing here, and the message has to say so.
    const { text } = meshToStep(archetypeById('plate')!.build({}).mesh, { name: 'Plate' });
    const manifest = [
      'source,export,kind,partNumber,revision,description,material,massGrams,status',
      '"a","Plate.step","part","P-1","A","a 200 mm mounting plate","6061","511","ok"',
    ].join('\n');

    const r = useModel.getState().teachFolder([{ name: 'Plate.step', text }], manifest);

    expect(r.result.results[0]!.outcome).toBe('not recognised');
    expect(r.result.results[0]!.detail).toMatch(/through-holes|agreement/);
    expect(r.message).toContain('Nothing was taught');
  });

  it('teaches a plain block and counts it in the singular', () => {
    const { text } = meshToStep(box(60, 40, 25, [0, 0, 0], 'Block'), { name: 'Block' });
    const manifest = [
      'source,export,kind,partNumber,revision,description,material,massGrams,status',
      '"a","Block.step","part","P-2","A","a spacer block","6061","1","ok"',
    ].join('\n');

    const r = useModel.getState().teachFolder([{ name: 'Block.step', text }], manifest);

    expect(r.ok).toBe(true);
    expect(r.message).toContain('1 example now steers');   // not "1 examples now steer"
    expect(useModel.getState().examples()).toHaveLength(1);
  });
});

describe('the library, from the store', () => {
  beforeEach(reset);

  it('saving renames the open document to match, so the tree and the library agree', async () => {
    await useModel.getState().build('a plate', { skipReuse: true });
    useModel.getState().saveToLibrary('Baseplate rev B');

    expect(useModel.getState().doc.name).toBe('Baseplate rev B');
    expect(listLibrary().map((e) => e.name)).toEqual(['Baseplate rev B']);
  });

  it('refuses to save under a blank name and says so', () => {
    const r = useModel.getState().saveToLibrary('   ');
    expect(r.ok).toBe(false);
    expect(useModel.getState().notice?.tone).toBe('warn');
    expect(listLibrary()).toHaveLength(0);
  });

  it('opening a part that is not there reports it rather than blanking the model', () => {
    const before = useModel.getState().doc;
    const r = useModel.getState().openFromLibrary('Never saved');

    expect(r.ok).toBe(false);
    expect(useModel.getState().doc).toBe(before);
    expect(useModel.getState().notice?.tone).toBe('error');
  });

  it('deleting a part removes it from the set the gate searches', async () => {
    await saveAPlate('Mounting plate');
    useModel.getState().removeFromLibrary('Mounting plate');
    useModel.getState().clear();

    await useModel.getState().build('a plate');
    expect(useModel.getState().reuse).toBeNull();
  });

  it('an assembly opened from the library does not carry the previous part\'s plan', async () => {
    await saveAPlate('Mounting plate');
    useModel.setState({ plan: { name: 'Stale', components: [] } as never });

    useModel.getState().openFromLibrary('Mounting plate');
    expect(useModel.getState().plan).toBeNull();
  });
});

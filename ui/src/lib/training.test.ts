import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addFromDocument, clearExamples, exemplarBlock, exemplarsFor, fromFile, listExamples,
  removeExample, toJsonl, type Example,
} from './training';
import { planFromDocument } from '../assembly/plan';
import { addFeature, emptyDocument, type Document } from '../model/document';

/**
 * Training-set tests.
 *
 * The corpus is the one thing here a user builds by hand and cannot easily rebuild, so the
 * properties worth asserting are about *not losing or corrupting it*: a part must round-trip
 * into the exact form the planner emits, an example that would teach an incomplete answer
 * must be refused rather than stored, and an import must say what it could not read instead
 * of quietly dropping it.
 *
 * The retrieval tests matter for a different reason. An irrelevant example is worse than no
 * example — the model will try to follow it — so "returns nothing" is as much a required
 * behaviour as "returns the right one".
 */

function bracket(name = 'Bracket'): Document {
  const base = addFeature(emptyDocument(name), 'box',
    { length: 120, width: 60, height: 8, operation: 'add' }, 'Base plate');
  return addFeature(base, 'cylinder',
    { diameter: 9, height: 20, operation: 'cut' }, 'Fixing hole');
}

beforeEach(() => {
  clearExamples();
});

describe('a document read back as the plan that made it', () => {
  it('turns each feature into a component the planner could have emitted', () => {
    const { plan, excluded } = planFromDocument(bracket());

    expect(excluded).toEqual([]);
    expect(plan.components).toHaveLength(2);
    expect(plan.components[0]!.shape).toBe('box');
    expect(plan.components[0]!.params.length).toBe(120);
    expect(plan.components[1]!.operation).toBe('cut');
  });

  it('keeps the archetype id as the shape, not as a parameter', () => {
    const doc = addFeature(emptyDocument('Plate'), 'archetype',
      { archetypeId: 'plate', length: 200, width: 120 }, 'Plate');
    const { plan } = planFromDocument(doc);

    expect(plan.components[0]!.shape).toBe('plate');
    expect(plan.components[0]!.params.archetypeId).toBeUndefined();
    expect(plan.components[0]!.params.operation).toBeUndefined();
  });

  it('carries the driving dimensions across, because that is what makes it a design', () => {
    const doc: Document = {
      ...bracket(),
      globals: [{ name: 'holePitch', value: 96, units: 'mm' }],
    };
    const { plan } = planFromDocument(doc);

    expect(plan.parameters?.map((p) => p.name)).toContain('holePitch');
  });

  it('reports what a plan cannot express rather than dropping it', () => {
    const doc = addFeature(bracket(), 'fillet', { radius: 2 }, 'Edge break');
    const { plan, excluded } = planFromDocument(doc);

    expect(plan.components).toHaveLength(2);
    expect(excluded).toHaveLength(1);
    expect(excluded[0]!.name).toBe('Edge break');
    expect(excluded[0]!.reason).toContain('fillet');
  });
});

describe('teaching', () => {
  it('stores the request and the plan together', () => {
    const r = addFromDocument('a 120 mm bracket with one fixing hole', bracket());

    expect(r.ok).toBe(true);
    expect(listExamples()).toHaveLength(1);
    expect(listExamples()[0]!.prompt).toBe('a 120 mm bracket with one fixing hole');
    expect(listExamples()[0]!.plan.components).toHaveLength(2);
  });

  it('refuses a part with no request, because the part is only half an example', () => {
    expect(addFromDocument('  ', bracket()).ok).toBe(false);
    expect(listExamples()).toHaveLength(0);
  });

  it('refuses a part that would teach an incomplete answer', () => {
    // A fillet cannot appear in a plan. Storing the part without it teaches the model to
    // leave the fillet out, which is a lesson that is actively wrong.
    const doc = addFeature(bracket(), 'fillet', { radius: 2 }, 'Edge break');
    const r = addFromDocument('a filleted bracket', doc);

    expect(r.ok).toBe(false);
    expect(r.problem).toContain('Edge break');
    expect(listExamples()).toHaveLength(0);
  });

  it('refuses an empty document rather than storing an empty answer', () => {
    expect(addFromDocument('nothing at all', emptyDocument()).ok).toBe(false);
  });

  it('forgets one example without disturbing the others', () => {
    addFromDocument('a bracket', bracket());
    addFromDocument('a plate', bracket('Plate'));

    const first = listExamples().find((e) => e.prompt === 'a bracket')!;
    removeExample(first.id);

    expect(listExamples().map((e) => e.prompt)).toEqual(['a plate']);
  });

  it('reports a full store in words the user can act on', () => {
    const quota = new DOMException('exceeded', 'QuotaExceededError');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw quota; });

    const r = addFromDocument('a bracket', bracket());

    spy.mockRestore();
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/full/i);
  });
});

describe('choosing which examples to show', () => {
  beforeEach(() => {
    addFromDocument('a mounting bracket for a motor', bracket('Motor bracket'));
    addFromDocument('a cover plate', bracket('Cover plate'));
  });

  it('returns the example closest to the request', () => {
    const { examples } = exemplarsFor('a mounting bracket');
    expect(examples[0]!.prompt).toBe('a mounting bracket for a motor');
  });

  it('returns nothing when no example is relevant', () => {
    // An irrelevant example is worse than none: the model will try to follow it.
    expect(exemplarsFor('a gearbox').examples).toHaveLength(0);
  });

  it('returns nothing for a request with no content words', () => {
    expect(exemplarsFor('make me one please').examples).toHaveLength(0);
  });

  it('honours the limit it is given', () => {
    expect(exemplarsFor('a bracket plate', listExamples(), 1).examples).toHaveLength(1);
  });

  it('skips an example too large for the prompt budget rather than truncating it', () => {
    // Half a plan is not a smaller example; it is an example of an incomplete answer.
    const huge: Example = {
      id: 'huge',
      prompt: 'a bracket',
      savedAtUtc: new Date().toISOString(),
      origin: 'imported',
      plan: {
        name: 'Huge', description: 'x'.repeat(9000), components: [], notes: [], source: 'model',
      },
    };

    const { examples, skipped } = exemplarsFor('a bracket', [huge]);
    expect(examples).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });
});

describe('the block that reaches the model', () => {
  it('pairs each request with the plan that answers it', () => {
    addFromDocument('a mounting bracket', bracket());
    const block = exemplarBlock(listExamples());

    expect(block).toContain('WORKED EXAMPLES');
    expect(block).toContain('Request: a mounting bracket');
    expect(block).toContain('"shape":"box"');
  });

  it('says they are examples of form, not a catalogue to pick from', () => {
    addFromDocument('a mounting bracket', bracket());
    expect(exemplarBlock(listExamples())).toMatch(/not a catalogue/i);
  });

  it('is empty rather than a bare heading when nothing has been taught', () => {
    expect(exemplarBlock([])).toBe('');
  });
});

describe('moving a corpus in and out', () => {
  it('round-trips through the chat format providers ingest', () => {
    addFromDocument('a mounting bracket', bracket());
    const jsonl = toJsonl(listExamples(), 'SYSTEM');

    clearExamples();
    const result = fromFile(jsonl);

    expect(result.added).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(listExamples()[0]!.prompt).toBe('a mounting bracket');
    expect(listExamples()[0]!.plan.components).toHaveLength(2);
    expect(listExamples()[0]!.origin).toBe('imported');
  });

  it('writes one self-contained record per line', () => {
    addFromDocument('a bracket', bracket());
    addFromDocument('a plate', bracket('Plate'));

    const lines = toJsonl(listExamples(), 'SYSTEM').split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const row = JSON.parse(line) as { messages: { role: string }[] };
      expect(row.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    }
  });

  it('names the lines it could not read instead of dropping them', () => {
    addFromDocument('a bracket', bracket());
    const good = toJsonl(listExamples(), 'SYSTEM');
    clearExamples();

    const result = fromFile(`${good}\nnot json\n{"messages":[{"role":"user","content":"x"}]}`);

    expect(result.added).toBe(1);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]!.reason).toContain('JSON');
    expect(result.rejected[1]!.reason).toContain('request and answer');
  });

  it('refuses a file that holds nothing usable', () => {
    expect(fromFile('nothing here at all').problem).toBeTruthy();
    expect(fromFile('   ').problem).toContain('empty');
  });

  it('reads back a plain array of examples too', () => {
    addFromDocument('a bracket', bracket());
    const exported = JSON.stringify(listExamples());
    clearExamples();

    expect(fromFile(exported).added).toBe(1);
  });
});

describe('a corrupt store', () => {
  it('reads as empty rather than breaking the application', () => {
    localStorage.setItem('datum.training.examples', 'not json');
    expect(listExamples()).toEqual([]);
  });

  it('ignores a corpus written by a newer build', () => {
    localStorage.setItem('datum.training.examples', JSON.stringify({ schema: 99, examples: [] }));
    expect(listExamples()).toEqual([]);
  });
});

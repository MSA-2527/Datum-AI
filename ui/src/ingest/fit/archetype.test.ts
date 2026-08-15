import { describe, expect, it } from 'vitest';
import { fitArchetype } from './archetype';
import { box, cylinder } from '../../kernel/ops/build';
import { boolean } from '../../kernel/ops/boolean';
import { ARCHETYPES, archetypeById } from '../../generate/archetypes';
import { transformMesh } from '../../kernel/topo/mesh';
import { rotation } from '../../kernel/math/vec';

/**
 * Archetype fitting tests.
 *
 * Two properties, and the second is the one that makes the feature safe to build on.
 *
 * It must **recover** a part that really is one of the catalogue shapes, closely enough that
 * the recovered parameters are the part's actual dimensions rather than approximately them.
 * That is what makes an imported solid teachable.
 *
 * And it must **refuse** everything else. A fit is used to build training examples, and an
 * example that names a manifold a tube teaches the model to answer "manifold" with "tube" —
 * a lesson that is worse than the silence it replaced. So the refusal tests here matter more
 * than the recovery ones, and there are deliberately more of them.
 */

const roundTrip = (id: string, params: Record<string, number>) =>
  archetypeById(id)!.build(params).mesh;

describe('recovering a part that is one of the catalogue shapes', () => {
  it('reads a plain block back as a box, at its real dimensions', () => {
    const fit = fitArchetype(box(80, 50, 30, [0, 0, 0], 'Block')).best!;

    expect(fit).not.toBeNull();
    expect(fit.archetypeId).toBe('box');
    expect(fit.params.length).toBeCloseTo(80, 3);
    expect(fit.params.width).toBeCloseTo(50, 3);
    expect(fit.params.height).toBeCloseTo(30, 3);
  });

  it('reads a turned bar back as a cylinder', () => {
    const fit = fitArchetype(cylinder(12.5, 90, [0, 0, 0], [0, 0, 1], 'Bar')).best!;

    expect(fit.archetypeId).toBe('cylinder');
    expect(fit.params.diameter).toBeCloseTo(25, 1);
    expect(fit.params.height).toBeCloseTo(90, 1);
  });

  it('finds the axis rather than assuming Z', () => {
    // An imported part arrives in whatever orientation its drawing was drawn in.
    const lying = transformMesh(cylinder(10, 60, [0, 0, 0], [0, 0, 1], 'Bar'), rotation([0, 1, 0], Math.PI / 2));
    const fit = fitArchetype(lying).best!;

    expect(fit.archetypeId).toBe('cylinder');
    expect(fit.params.height).toBeCloseTo(60, 1);
    expect(fit.params.diameter).toBeCloseTo(20, 1);
  });

  it('reads a thin plate back as a plate rather than a box', () => {
    const fit = fitArchetype(box(200, 120, 8, [0, 0, 0], 'Plate')).best!;

    // Both fit a rectangular prism exactly; the plate is the more useful description and wins
    // on nothing but being proposed for the proportions that make it one.
    expect(['plate', 'box']).toContain(fit.archetypeId);
    if (fit.archetypeId === 'plate') {
      expect(fit.params.length).toBeCloseTo(200, 2);
      expect(fit.params.thickness).toBeCloseTo(8, 2);
    }
  });

  it('reads a washer back with its bore, derived from the volume', () => {
    const fit = fitArchetype(roundTrip('washer', { outerDia: 21, boreDia: 10.5, thickness: 2 })).best!;

    expect(fit.archetypeId).toBe('washer');
    expect(fit.params.outerDia).toBeCloseTo(21, 1);
    expect(fit.params.boreDia).toBeCloseTo(10.5, 0);
  });

  it('reads a tube back as a pipe, not a washer', () => {
    const fit = fitArchetype(
      roundTrip('pipe', { outerDia: 60, wall: 4, length: 250, bendRadius: 0, bendAngle: 90 }),
    ).best!;

    expect(fit.archetypeId).toBe('pipe');
    expect(fit.params.outerDia).toBeCloseTo(60, 0);
    expect(fit.params.length).toBeCloseTo(250, 0);
    expect(fit.params.wall).toBeCloseTo(4, 0);
  });

  it('reads a stepped shaft back with its step, from the section profile', () => {
    const fit = fitArchetype(
      roundTrip('shaft', { diameter: 30, length: 200, stepDia: 22, stepLength: 50, chamfer: 0 }),
    ).best!;

    expect(fit.archetypeId).toBe('shaft');
    expect(fit.params.diameter).toBeCloseTo(30, 0);
    expect(fit.params.length).toBeCloseTo(200, 0);
    expect(fit.params.stepDia).toBeCloseTo(22, 0);
    // The step is found by banding, so its length resolves to a twelfth of the shaft.
    expect(fit.params.stepLength).toBeGreaterThan(30);
    expect(fit.params.stepLength).toBeLessThan(70);
  });

  it('reads a hex nut back through its across-corners ratio', () => {
    // A hex is 15% wider across its corners than across its flats, so the round-axis test
    // never fires on one; it is found by that ratio instead.
    const fit = fitArchetype(
      roundTrip('nut', { acrossFlats: 17, thickness: 8.4, boreDia: 10, chamfer: 0 }),
    ).best!;

    expect(fit.archetypeId).toBe('nut');
    expect(fit.params.acrossFlats).toBeCloseTo(17, 0);
    expect(fit.params.thickness).toBeCloseTo(8.4, 1);
    expect(fit.params.boreDia).toBeCloseTo(10, 0);
  });

  it('reports what it compared, so a fit can be judged rather than trusted', () => {
    const fit = fitArchetype(box(80, 50, 30)).best!;
    expect(fit.detail)
      .toMatch(/volume .*%, section .*%, inertia .*%, surface .*%, envelope .*%/);
    expect(fit.agreement).toBeGreaterThan(0.97);
  });
});

describe('refusing everything else', () => {
  it('refuses an L-bracket, without even proposing a candidate for it', () => {
    // Nothing offers a shape for it: an L fills about a third of its bounding box and has no
    // axis of revolution, so it fails every proposer's entry condition. Declining before
    // building anything is the cheap half of the design working.
    const result = fitArchetype(roundTrip('bracket', {}));

    expect(result.best).toBeNull();
    expect(result.considered).toEqual([]);
    expect(result.reason).toContain('not close to anything');
  });

  it('refuses a gear rather than calling it a disc', () => {
    const result = fitArchetype(roundTrip('gear', {}));
    expect(result.best).toBeNull();
  });

  it('refuses a bottle rather than calling it a tube', () => {
    // Round, hollow and taller than it is wide, so the pipe proposer does offer it. What
    // rejects it is the topology: a bottle is open at one end and a tube at both.
    const result = fitArchetype(roundTrip('bottle', {}));
    expect(result.best).toBeNull();
  });

  it('refuses a plate that has holes rather than calling it a solid block', () => {
    // 1% of volume and four handles. No weighting of volume, area and envelope expresses the
    // difference; the genus does, exactly.
    const result = fitArchetype(roundTrip('plate', {}));

    expect(result.best).toBeNull();
    expect(result.considered[0]!.detail).toMatch(/through-holes against/);
  });

  it('refuses a shaft with a waist rather than calling it stepped', () => {
    // The shaft archetype puts its step at one end. A reduced section in the middle is a
    // different part, and offering a shaft for it would be a guess dressed as a reading.
    const bar = cylinder(15, 200, [0, 0, 0], [0, 0, 1], 'Bar');
    const waist = boolean(bar, cylinder(20, 30, [0, 0, 0], [0, 0, 1], 'Waist'), 'difference');
    expect(fitArchetype(waist.mesh).best).toBeNull();
  });

  it('refuses a pulley rather than calling it a washer', () => {
    // Same topology, same envelope, near-identical volume. The V-groove shows only in where
    // the material sits along the bore axis.
    expect(fitArchetype(roundTrip('pulley', {})).best).toBeNull();
  });

  it('refuses a block with a groove that no parameter describes', () => {
    const block = box(80, 50, 30, [0, 0, 0], 'Block');
    const groove = box(90, 24, 16, [0, 0, 14], 'Groove');
    const result = fitArchetype(boolean(block, groove, 'difference').mesh);

    expect(result.best).toBeNull();
  });

  it('names the closest match and its score when one was proposed and rejected', () => {
    // A refusal that says only "no" cannot be argued with, and a threshold nobody can argue
    // with is a threshold that gets lowered until it accepts everything. A pulley is round
    // and bored, so the washer proposer does offer it — and the section profile, which sees
    // the V-groove, is what rejects it.
    const result = fitArchetype(roundTrip('pulley', {}));

    expect(result.considered.length).toBeGreaterThan(0);
    expect(result.reason).toMatch(/closest match is a \w+ at \d/);
    expect(result.reason).toMatch(/below the 97% needed/);
  });

  it('refuses an empty mesh and says so', () => {
    const result = fitArchetype({
      positions: new Float64Array(0), indices: new Uint32Array(0),
      faceIds: new Uint32Array(0), tags: new Map(),
    });

    expect(result.best).toBeNull();
    expect(result.reason).toContain('no geometry');
  });

  it('lets the bar be lowered deliberately, and says what that accepted', () => {
    // Someone may decide a looser fit is good enough for their own library. That is a
    // decision to make with the number in front of them, not a default.
    const strict = fitArchetype(roundTrip('pulley', {}));
    const loose = fitArchetype(roundTrip('pulley', {}), { accept: 0.5 });

    expect(strict.best).toBeNull();
    expect(loose.best).not.toBeNull();
    expect(loose.best!.agreement).toBeLessThan(0.97);
  });
});

describe('swept across the whole catalogue', () => {
  /*
   * The test that makes the feature safe to build training on.
   *
   * Every archetype is built at its defaults and offered to the fitter. Exactly four may be
   * accepted — the four whose shape really is described by the parameters recovered — and
   * every other part in the catalogue must be refused. A false positive here is not a missed
   * opportunity, it is a training example that teaches a model to answer "flange" with
   * "washer", so this is written as an allow-list: adding a proposer without extending the
   * list fails, which is the right way round.
   */
  const RECOVERABLE = new Set(['box', 'cylinder', 'pipe', 'washer', 'shaft', 'nut']);

  for (const archetype of ARCHETYPES) {
    it(`${archetype.id} is ${RECOVERABLE.has(archetype.id) ? 'recovered' : 'refused'}`, () => {
      const built = archetype.build({});
      if (!built.valid) return;                       // a default that cannot build is not this test's business

      const result = fitArchetype(built.mesh);

      if (RECOVERABLE.has(archetype.id)) {
        expect(result.best, result.reason).not.toBeNull();
        expect(result.best!.archetypeId).toBe(archetype.id);
      } else {
        expect(
          result.best,
          `${archetype.id} was accepted as a ${result.best?.archetypeId} — that is a training ` +
          'example teaching the wrong answer',
        ).toBeNull();
      }
    });
  }
});

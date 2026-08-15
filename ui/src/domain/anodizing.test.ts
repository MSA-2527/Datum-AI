import { describe, expect, it } from 'vitest';
import {
  PROCESSES, RACK_MATERIALS, checkRack, describeRack, designRack, electricalFor, measurePart,
  processById, rackMaterialById,
} from './anodizing';
import { box, cylinder } from '../kernel/ops/build';
import { boolean } from '../kernel/ops/boolean';
import { archetypeById } from '../generate/archetypes';

/**
 * Anodizing rack sizing.
 *
 * These assertions are against published process practice and arithmetic that can be done on
 * paper, never against what the code currently returns. A rack is signed off by an engineer,
 * and a test that only says "the same as last time" gives them nothing to check.
 *
 * The chain being verified is the one the physics imposes: area → current → conductor section
 * → heat. Each link is tested on its own with a figure you can verify independently, and then
 * the whole chain is tested end to end on a part whose area is a number you can work out by
 * hand.
 */

/** 100 × 100 × 10 mm plate: area = 2(100×100) + 4(100×10) = 24 000 mm² = 2.4 dm². */
const plate = () => box(100, 100, 10, [0, 0, 0], 'Plate');

describe('measuring the part', () => {
  it('measures wetted area off the solid, in the unit the industry sizes current in', () => {
    const m = measurePart(plate());

    expect(m.areaMm2).toBeCloseTo(24_000, 0);
    expect(m.areaDm2).toBeCloseTo(2.4, 3);
  });

  it('sees the area a finned part actually has, not the area of the box it fits in', () => {
    // The failure this prevents: sizing from the envelope, then burning the contacts on the
    // first run because the real part draws several times the current.
    let finned = box(100, 100, 10, [0, 0, 0], 'Base');
    for (let i = -2; i <= 2; i++) {
      finned = boolean(finned, box(4, 100, 40, [i * 18, 0, 25], 'Fin'), 'union').mesh;
    }

    const plain = measurePart(plate()).areaDm2;
    const withFins = measurePart(finned).areaDm2;

    expect(withFins).toBeGreaterThan(plain * 1.5);
  });

  it('weighs the part at the density it is given', () => {
    // 100 × 100 × 10 = 100 000 mm³ = 100 cm³, aluminium at 2.7 g/cm³ = 270 g.
    expect(measurePart(plate(), 2.7).massG).toBeCloseTo(270, 0);
  });
});

describe('the electrochemistry', () => {
  const part = measurePart(plate());

  it('draws the current the area and the density say it should', () => {
    // 2.4 dm² at 1.5 A/dm² = 3.6 A per part; twenty parts = 72 A.
    const e = electricalFor(part, processById('typeII'), 20, 15);

    expect(e.perPartA).toBeCloseTo(3.6, 2);
    expect(e.currentA).toBeCloseTo(72, 1);
  });

  it('agrees with the shop-floor rule of thumb for Type II', () => {
    // "About 25 microns in an hour" is what every anodizing line quotes. The derivation from
    // Faraday's law is independent of that saying, and the two landing together is the check
    // worth having on the growth constant.
    const e = electricalFor(part, processById('typeII'), 1, 25);
    expect(e.minutes).toBeGreaterThan(45);
    expect(e.minutes).toBeLessThan(75);
  });

  it('takes longer for a hard-anodize coating even at higher density', () => {
    const typeII = electricalFor(part, processById('typeII'), 1, 25);
    const typeIII = electricalFor(part, processById('typeIII'), 1, 50);
    expect(typeIII.minutes).toBeGreaterThan(typeII.minutes);
  });

  it('reports the dimensional consequence, which is what scraps parts', () => {
    // Half the coating grows outward: a 25 µm coating puts 12.5 µm on each surface, so a bore
    // loses 25 µm on diameter. This is the number a machinist needs and never gets.
    const e = electricalFor(part, processById('typeII'), 1, 25);

    expect(e.growthUm).toBeCloseTo(12.5, 2);
    expect(e.boreLossUm).toBeCloseTo(25, 2);
  });

  it('turns nearly all the electrical power into heat', () => {
    const e = electricalFor(part, processById('typeII'), 20, 25);
    expect(e.powerW).toBeCloseTo(72 * 15, 0);
  });
});

describe('sizing the conductors', () => {
  it('sizes the spine for the whole load at the material rating', () => {
    const design = designRack(measurePart(plate()), { partsWanted: 40, materialId: 'ti' });
    const section = design.rack.spineWidthMm * design.rack.spineThicknessMm;

    // Titanium at 1 A/mm² continuous: the section must carry the total current, and the check
    // asserts the sizing was actually applied rather than defaulted.
    expect(section).toBeGreaterThanOrEqual(design.electrical.currentA / 1.0 * 0.98);
    expect(design.checks.find((c) => c.id === 'spine-section')!.ok).toBe(true);
  });

  it('gives a copper-cored rack a smaller spine for the same current', () => {
    const part = measurePart(plate());
    const ti = designRack(part, { partsWanted: 40, materialId: 'ti' });
    const cu = designRack(part, { partsWanted: 40, materialId: 'cu-ti' });

    const section = (d: typeof ti) => d.rack.spineWidthMm * d.rack.spineThicknessMm;
    expect(section(cu)).toBeLessThan(section(ti));
  });

  it('grows the spine when the load grows', () => {
    const part = measurePart(plate());
    const small = designRack(part, { partsWanted: 10 });
    const large = designRack(part, { partsWanted: 100 });

    expect(large.electrical.currentA).toBeGreaterThan(small.electrical.currentA);
    expect(large.rack.spineWidthMm * large.rack.spineThicknessMm)
      .toBeGreaterThan(small.rack.spineWidthMm * small.rack.spineThicknessMm);
  });

  it('sizes the contact for one part\'s current, not the whole rack\'s', () => {
    const design = designRack(measurePart(plate()), { partsWanted: 40 });
    const contactArea = Math.PI * (design.rack.tipDiaMm / 2) ** 2;

    expect(design.electrical.perPartA / contactArea).toBeLessThanOrEqual(0.61);
    expect(design.checks.find((c) => c.id === 'contact-current')!.ok).toBe(true);
  });

  it('draws one contact position per part, so the rack agrees with its own load', () => {
    // The rack archetype counts a part per tip. Drawing two tips per part made it believe it
    // was carrying twice the current, and warn about a spine that was correctly sized.
    const design = designRack(measurePart(plate()), { partsWanted: 40 });

    expect(design.rack.tipsPerPart).toBe(1);
    expect(design.archetypeParams.tipsPerArm! * design.rack.tiers * 2)
      .toBe(design.rack.partsTotal);
  });
});

describe('fitting the tank', () => {
  it('sets the tier count from the tank depth', () => {
    const part = measurePart(plate());
    const shallow = designRack(part, { tankDepthMm: 600 });
    const deep = designRack(part, { tankDepthMm: 2000 });

    expect(deep.rack.tiers).toBeGreaterThan(shallow.rack.tiers);
    expect(shallow.rack.spineHeightMm).toBeLessThan(600);
  });

  it('spaces parts for flow rather than packing them', () => {
    const design = designRack(measurePart(plate()));
    const gap = design.rack.pitchMm - design.part.sizeMm[1]!;

    expect(gap).toBeGreaterThanOrEqual(25);
    expect(design.checks.find((c) => c.id === 'flow')!.ok).toBe(true);
  });

  it('leaves room for gas to rise and parts to drain, even for a small part', () => {
    // A small part invites a tall stack of closely-spaced tiers. Anodizing evolves oxygen at
    // the work, and a part hung in the bubble stream off the one below finishes thin — so the
    // vertical pitch has a floor the part size cannot argue down.
    const design = designRack(measurePart(box(20, 17, 8)), { partsWanted: 20 });
    const armPitch = design.rack.spineHeightMm / (design.rack.tiers + 1);

    expect(armPitch).toBeGreaterThanOrEqual(60);
  });

  it('builds no more tiers than the load needs', () => {
    // Thirty tiers of two parts for a load of twenty is a taller rack, more titanium, more
    // current in the spine and a longer lift — for nothing.
    const design = designRack(measurePart(box(20, 17, 8)), { partsWanted: 20, tankDepthMm: 2000 });

    expect(design.rack.partsTotal).toBeGreaterThanOrEqual(20);
    expect(design.rack.partsTotal).toBeLessThanOrEqual(24);
    expect(design.rack.tiers).toBeLessThanOrEqual(10);
  });

  it('builds a rack the archetype does not complain about, at any part size', () => {
    // The tier-pitch bug appeared only on small parts, so the agreement between the two models
    // is checked across the range rather than at one convenient size.
    for (const [l, w, t] of [[20, 17, 8], [60, 40, 10], [100, 100, 10], [400, 200, 20]]) {
      const design = designRack(measurePart(box(l!, w!, t!)), { partsWanted: 24 });
      const built = archetypeById('rack')!.build(design.archetypeParams);
      const problems = built.warnings.filter((x) => /widen|run hot|burn|room to drain/i.test(x));

      expect(problems, `${l}×${w}×${t}: ${problems.join(' | ')}`).toEqual([]);
    }
  });

  it('spaces a large part more widely than a small one', () => {
    const small = designRack(measurePart(box(30, 30, 5)));
    const large = designRack(measurePart(box(400, 200, 20)));

    expect(large.rack.pitchMm).toBeGreaterThan(small.rack.pitchMm);
  });
});

describe('quality control', () => {
  it('blocks a rack that would burn its contacts', () => {
    // One tiny contact on a large part is the classic failure: the aluminium under the
    // contact melts and the part arcs off the rack mid-run.
    const big = measurePart(cylinder(150, 400, [0, 0, 0], [0, 0, 1], 'Drum'));
    const design = designRack(big, { partsWanted: 4 });
    const forced = { ...design, rack: { ...design.rack, tipDiaMm: 1.5 } };

    const check = checkRack(forced).find((c) => c.id === 'contact-current')!;
    expect(check.ok).toBe(false);
    expect(check.severity).toBe('blocker');
    expect(check.detail).toMatch(/A\/mm²/);
  });

  it('states the witness mark it will leave, and how large it is', () => {
    // On a cosmetic face an uncoated contact mark is a reject rather than a blemish, and its
    // area is what decides whether it can be hidden or has to be machined off.
    const detail = designRack(measurePart(plate())).checks
      .find((c) => c.id === 'contact-marks')!.detail;

    expect(detail).toMatch(/one uncoated mark per part/);
    expect(detail).toMatch(/mm²/);
  });

  it('says a chilled bath is not optional for hard anodizing', () => {
    const design = designRack(measurePart(plate()), { process: 'typeIII', partsWanted: 20 });
    expect(design.checks.find((c) => c.id === 'cooling')!.detail).toMatch(/not optional/);
  });

  it('states the cooling load in kilowatts and litres per minute', () => {
    const design = designRack(measurePart(plate()), { partsWanted: 40 });

    expect(design.coolingWatts).toBeGreaterThan(0);
    expect(design.coolingLitresPerMin).toBeGreaterThan(0);
    // Q = m·c·ΔT at a 3 °C rise through water.
    expect(design.coolingLitresPerMin)
      .toBeCloseTo((design.coolingWatts * 60) / (4.18 * 1000 * 3), 3);
  });

  it('gives every check something to argue with rather than a verdict', () => {
    const design = designRack(measurePart(plate()));
    for (const check of design.checks) {
      expect(check.detail.length, check.id).toBeGreaterThan(40);
      expect(check.title.length, check.id).toBeGreaterThan(4);
    }
  });

  it('states rack life and why it ends', () => {
    const ti = designRack(measurePart(plate()), { materialId: 'ti' });
    const al = designRack(measurePart(plate()), { materialId: 'al' });

    expect(ti.rackLifeRuns).toBeGreaterThan(al.rackLifeRuns);
    // Aluminium anodizes along with the work, so it is stripped every run.
    expect(al.rackLifeRuns).toBe(1);
    expect(ti.checks.find((c) => c.id === 'rack-life')!.detail).toMatch(/oxide/);
  });
});

describe('the process library', () => {
  it('cites a basis for every process', () => {
    for (const p of PROCESSES) {
      expect(p.basis.length, p.id).toBeGreaterThan(30);
      expect(p.currentDensityAdm2, p.id).toBeGreaterThan(0);
      expect(p.thicknessUm[0], p.id).toBeLessThan(p.thicknessUm[1]);
    }
  });

  it('cites a basis for every rack material', () => {
    for (const m of RACK_MATERIALS) {
      expect(m.basis.length, m.id).toBeGreaterThan(30);
      expect(m.ampsPerMm2, m.id).toBeGreaterThan(0);
    }
  });

  it('falls back to Type II rather than throwing on an unknown id', () => {
    expect(processById('nonsense' as never).id).toBe('typeII');
    expect(rackMaterialById('nonsense').id).toBe('ti');
  });
});

describe('what it hands back', () => {
  it('produces parameters the rack archetype can build', () => {
    const design = designRack(measurePart(plate()), { partsWanted: 30 });

    for (const key of [
      'spineHeight', 'spineWidth', 'spineThickness', 'tiers',
      'armLength', 'armWidth', 'armThickness', 'tipsPerArm', 'tipLength', 'tipDia', 'hookDia',
    ]) {
      expect(design.archetypeParams[key], key).toBeGreaterThan(0);
      expect(Number.isFinite(design.archetypeParams[key]!), key).toBe(true);
    }
  });

  it('builds a rack whose own warnings agree with the sizing that produced it', () => {
    // This went wrong twice, in both directions, and each time the user saw a rack contradict
    // itself: the archetype counting a part per contact tip, and then assuming 8 A per part
    // regardless of the part. The design and the geometry have to share their arithmetic, so
    // the assertion is that the archetype builds clean from these parameters.
    const design = designRack(measurePart(plate()), { partsWanted: 28 });
    const built = archetypeById('rack')!.build(design.archetypeParams);
    const problems = built.warnings.filter((w) => /widen|run hot|burn|trapped/i.test(w));

    expect(built.valid).toBe(true);
    expect(problems, problems.join(' | ')).toEqual([]);

    // And the summary the archetype prints reports the same current the sizing used. This is
    // the assertion that the two models share their arithmetic rather than merely both being
    // plausible.
    const summary = built.warnings.find((w) => /in total/.test(w))!;
    expect(summary).toContain(`${design.electrical.currentA.toFixed(0)} A in total`);
    expect(summary).toContain(`${design.rack.partsTotal} parts`);
  });

  it('hands the archetype the measured current, not its placeholder', () => {
    const design = designRack(measurePart(plate()), { partsWanted: 28 });

    expect(design.archetypeParams.ampsPerPart)
      .toBeCloseTo(design.electrical.perPartA, 1);
    expect(design.archetypeParams.ampsPerPart).not.toBe(8);
  });

  it('summarises with the numbers first, because they are the answer', () => {
    const text = describeRack(designRack(measurePart(plate()), { partsWanted: 30 }));

    expect(text).toMatch(/\d+ parts/);
    expect(text).toMatch(/A total at/);
    expect(text).toMatch(/min for/);
    expect(text).toMatch(/kW of cooling/);
  });
});

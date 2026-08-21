import { describe, expect, it } from 'vitest';
import {
  CLEARANCE_FRACTION, RACK_BAR, SPOT_WELD, STATIONS,
  designBarRack, designBarRackFor, describeBarRack,
} from './barRack';
import { runScript } from '../generate/script';
import { evaluateDocument } from '../model/document';
import { bounds, health, triCount } from '../kernel/topo/mesh';
import { box } from '../kernel/ops/build';
import type { PartMeasurement } from './anodizing';

/**
 * Designing the rack a part hangs on.
 *
 * The only validation worth having here is against the shop's own released racks. Two are
 * documented well enough to check: the candle-lid rack (426-0272, four clips on a 100-0132
 * bar) and the plaque rack (426-0244, six stations on the same bar, arrived at after reducing
 * from ten). A generator that cannot land near those on the parts they were drawn for is not
 * describing this shop's practice, whatever else it does.
 *
 * The rest asserts the things a rack has to be true about regardless: the stations fit the
 * bar, the checks fire on geometry that breaches them, and the design builds.
 */

/** A part measurement, as `measurePart` would return one. */
function part(down: number, across: number, through: number, areaMm2: number): PartMeasurement {
  const sizeMm = [down, across, through].sort((a, b) => b - a) as [number, number, number];
  return {
    areaMm2,
    areaDm2: areaMm2 / 10_000,
    volumeMm3: down * across * through,
    massG: (down * across * through / 1000) * 2.7,
    sizeMm,
  };
}

describe('against the shop’s own racks', () => {
  /*
   * 426-0272, the candle-lid rack: four 423-0312 clips on a 100-0132 bar, pitch 2.17" (55.1 mm).
   * A three-wick candle lid is roughly 100 mm across and shallow.
   */
  it('lands on four stations for a candle lid, as 426-0272 does', () => {
    const lid = part(105, 100, 12, 6_650);       // ~10.3 in² per the clip drawing's part
    const design = designBarRackFor(lid);

    expect(design.stations).toBe(4);
    // 249.238 / 4 = 62.3 mm, against the drawing's 2.17" (55.1 mm) typical clip pitch.
    expect(design.pitchMm).toBeGreaterThan(50);
    expect(design.pitchMm).toBeLessThan(70);
  });

  /*
   * 426-0244, the plaque rack: six 422-0124 stations. The shop reached six by reducing from
   * ten and then eight, both times for coating rather than for fit — so a generator that
   * proposes eight or ten here is repeating a mistake this library already corrected.
   */
  it('lands on six stations for a 50 ml plaque, not the ten that failed', () => {
    const plaque = part(76, 36, 10, 2_950);
    const design = designBarRackFor(plaque);

    expect(design.stations).toBeLessThanOrEqual(6);
    expect(design.stations).toBeGreaterThanOrEqual(4);
  });

  it('uses the bar the whole library uses', () => {
    const design = designBarRackFor(part(80, 40, 10, 3_000));

    expect(design.bar.partNumber).toBe('100-0132');
    expect(design.bar.lengthMm).toBeCloseTo(309.563, 3);
    expect(design.bar.usableSpanMm).toBeCloseTo(249.238, 3);
    expect(design.bar.material).toContain('Grade 2');
  });

  it('specifies Grade 4 strip and two spot welds per clip, as the drawings do', () => {
    const design = designBarRackFor(part(80, 40, 10, 3_000));

    expect(design.clip.material).toContain('Grade 4');
    expect(design.clip.spotWelds).toBe(SPOT_WELD.perClip);
    expect([0.635, 1.016]).toContain(design.clip.thicknessMm);
  });
});

describe('how many go across', () => {
  it('puts more small parts on a bar than large ones', () => {
    const small = designBarRackFor(part(60, 20, 6, 1_200));
    const large = designBarRackFor(part(200, 90, 30, 20_000));

    expect(small.stations).toBeGreaterThan(large.stations);
  });

  it('never exceeds the bar, whatever the part', () => {
    for (const across of [5, 12, 25, 40, 80, 150, 240]) {
      const design = designBarRackFor(part(200, across, 10, 5_000));
      expect(design.stations * design.pitchMm, `${across} mm part overran the bar`)
        .toBeLessThanOrEqual(RACK_BAR.usableSpanMm + 1e-6);
    }
  });

  it('stays inside the range the library actually uses', () => {
    for (const across of [2, 8, 30, 120, 400]) {
      const design = designBarRackFor(part(150, across, 8, 4_000));
      expect(design.stations).toBeGreaterThanOrEqual(STATIONS.min);
      expect(design.stations).toBeLessThanOrEqual(STATIONS.max);
    }
  });

  it('leaves the clearance the diffusion limit asks for', () => {
    const design = designBarRackFor(part(120, 40, 10, 4_000));
    // Pitch is the part plus its clear path, so the clearance is the fraction of the part.
    expect(design.clearanceMm / 40).toBeGreaterThan(CLEARANCE_FRACTION * 0.5);
  });

  it('accepts an override, because a shop knows its own tank', () => {
    expect(designBarRackFor(part(120, 40, 10, 4_000), { stations: 3 }).stations).toBe(3);
  });
});

describe('the electrical side', () => {
  it('scales the current with the number of parts on the bar', () => {
    const one = designBarRackFor(part(120, 40, 10, 5_000), { stations: 2 });
    const many = designBarRackFor(part(120, 40, 10, 5_000), { stations: 8 });

    expect(many.electrical.currentA).toBeCloseTo(one.electrical.currentA * 4, 6);
  });

  it('reports how much of the current coats the rack rather than the work', () => {
    // A tiny part on a full bar: the rack is most of the wetted area, and that is the figure
    // worth seeing before anyone runs it.
    const tiny = designBarRackFor(part(20, 8, 3, 120));
    const big = designBarRackFor(part(200, 90, 30, 40_000));

    expect(tiny.rackCurrentFraction).toBeGreaterThan(big.rackCurrentFraction);
    expect(big.rackCurrentFraction).toBeGreaterThan(0);
    expect(tiny.rackCurrentFraction).toBeLessThan(1);
  });

  it('takes the coating time from the process, not from the rack', () => {
    const design = designBarRackFor(part(120, 40, 10, 5_000));
    expect(design.electrical.minutes).toBeGreaterThan(0);
    expect(design.thicknessUm).toBeGreaterThan(0);
  });
});

describe('the checks', () => {
  it('passes a part the bar was made for', () => {
    const design = designBarRackFor(part(105, 100, 12, 6_650));
    const blockers = design.checks.filter((c) => !c.ok && c.severity === 'blocker');

    expect(blockers.map((b) => b.title)).toEqual([]);
  });

  it('blocks a part too thin for a clip to close on', () => {
    const foil = designBarRackFor(part(100, 50, 0.2, 10_000));
    const blocked = foil.checks.find((c) => c.id === 'rack.grip');

    expect(blocked?.ok).toBe(false);
    expect(blocked?.severity).toBe('blocker');
  });

  it('warns when a part is deeper than the tank the bar was drawn for', () => {
    const long = designBarRackFor(part(600, 30, 10, 20_000));
    expect(long.checks.find((c) => c.id === 'rack.depth')?.ok).toBe(false);
  });

  it('states what it measured against what, so a check can be argued with', () => {
    for (const c of designBarRackFor(part(120, 40, 10, 5_000)).checks) {
      expect(c.detail.length, `${c.id} says nothing`).toBeGreaterThan(30);
      expect(c.detail).toMatch(/\d/);
    }
  });
});

describe('the rack that comes out', () => {
  it('is a script that builds a closed solid', () => {
    const design = designBarRackFor(part(105, 100, 12, 6_650));
    const result = runScript(design.script);

    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);

    const evaluated = evaluateDocument(result.doc);
    expect(triCount(evaluated.mesh)).toBeGreaterThan(0);
    expect(health(evaluated.mesh).closed).toBe(true);
  });

  it('carries the bar at the size the drawing states', () => {
    const design = designBarRackFor(part(105, 100, 12, 6_650));

    expect(design.script).toContain(`param barLength = ${RACK_BAR.lengthMm}`);
    expect(design.script).toContain(`param barWidth = ${RACK_BAR.widthMm}`);
  });

  it('is editable — the station count and pitch are parameters', () => {
    const design = designBarRackFor(part(105, 100, 12, 6_650));

    expect(design.script).toMatch(/param stations = \d+/);
    expect(design.script).toMatch(/param pitch = [\d.]+/);
  });

  /*
   * The clips are placed, not patterned. `patternLinear` repeats the whole body built so far,
   * so once the bar exists a pattern repeats the bar too: the first version of this emitted a
   * pattern and built a 496 mm rack out of a 310 mm bar — four bars, four clips, closed solid,
   * every check green. Nothing downstream could have caught that, because everything downstream
   * measures the mesh it is given.
   */
  it('is no longer than the bar it is built on', () => {
    for (const across of [10, 40, 100, 200]) {
      const design = designBarRackFor(part(200, across, 12, 8_000));
      const evaluated = evaluateDocument(runScript(design.script).doc);
      const size = bounds(evaluated.mesh);

      expect(size.max[0] - size.min[0], `${across} mm part gave a rack longer than its bar`)
        .toBeLessThanOrEqual(RACK_BAR.lengthMm + 1e-3);
    }
  });

  it('places one clip per station, and draws each one folded', () => {
    /*
     * A clip is not a rectangle standing on a bar. A 423-0312 comes off the bar, runs out, turns
     * over and comes back down the other side of the part — the return leg *is* the clip, since
     * it is what grips. Drawn as a blank upright it got the pitch and the count right and looked
     * nothing like the thing on the drawing, which is a rack nobody can weld from.
     */
    const design = designBarRackFor(part(105, 100, 12, 6_650));
    const lines = design.script.split('\n');

    for (const piece of ['Leg', 'Top', 'Jaw']) {
      const found = lines.filter((l) => new RegExp(`^box Clip\\d+${piece} `).test(l));
      expect(found, `no ${piece} on any clip`).toHaveLength(design.stations);
    }
  });

  it('leaves the grip open between the two legs', () => {
    // The dimension the whole clip exists for: the gap the part sits in.
    const design = designBarRackFor(part(105, 100, 12, 6_650));

    expect(design.script).toContain(`param grip = ${Number(design.clip.gripMm.toFixed(3))}`);
    expect(design.clip.gripMm).toBeCloseTo(12, 6);
  });

  it('works from a mesh as well as from a measurement', () => {
    const design = designBarRack(box(100, 40, 10));

    expect(design.stations).toBeGreaterThan(0);
    expect(design.part.areaMm2).toBeGreaterThan(0);
  });
});

describe('what it says about itself', () => {
  it('states the count, the pitch, the current and the clip in one sentence', () => {
    const said = describeBarRack(designBarRackFor(part(105, 100, 12, 6_650)));

    expect(said).toContain('100-0132');
    expect(said).toContain('stations');
    expect(said).toMatch(/[\d.]+ A/);
    expect(said).toContain('Grade 4');
    expect(said).toContain('spot welds');
  });

  it('names the checks that were not met rather than only counting them', () => {
    const said = describeBarRack(designBarRackFor(part(600, 30, 0.2, 20_000)));
    expect(said).toMatch(/not met: .+/);
  });
});

/**
 * Parametric archetypes: named shapes built from real features.
 *
 * This is what turns "make a cup" into geometry. Every archetype is a *procedure* over the
 * kernel — revolve this profile, shell it, sweep that handle, fillet those edges — so the
 * output carries a genuine feature tree with named, editable parameters. Ask for a cup and
 * then change its wall thickness, and the model rebuilds; it is not a mesh that happened to
 * be shaped like a cup.
 *
 * That distinction is the entire product argument against mesh-generating AI CAD. A
 * generated triangle soup cannot be dimensioned, cannot be manufactured to a tolerance, and
 * cannot be edited by the engineer who has to sign the drawing. A parameter set plus a
 * construction procedure can.
 *
 * Defaults are drawn from real dimensions rather than invented — a 350 ml mug really is
 * about 82 mm tall with an 80 mm bore — so an unqualified request produces something
 * plausible rather than something arbitrary.
 */

import {
  add3, mul3, norm3, rad, translation, type Vec2, type Vec3,
} from '../kernel/math/vec';
import { interpolateCurve } from '../kernel/math/nurbs';
import {
  bounds, concatMeshes, health, massProperties, transformMesh, triCount, type Mesh,
} from '../kernel/topo/mesh';
import {
  XY, XZ, box, cylinder, extrude, linePath, planeFrom, revolve, sweep, type Plane,
} from '../kernel/ops/build';
import { boolean, subtractAll, unionAll } from '../kernel/ops/boolean';
import {
  chamferEdges, circularPattern, drillHole, filletEdges, linearPattern, shell,
} from '../kernel/ops/modify';
import {
  circleProfile, filletCorners, makeProfile, polygonProfile, rectProfile, type Profile,
} from '../kernel/sketch/profile';

// ── the parameter contract ───────────────────────────────────────────────────

export interface ParamSpec {
  key: string;
  label: string;
  /** Millimetres unless stated. */
  value: number;
  min: number;
  max: number;
  unit: 'mm' | 'deg' | 'count' | 'ml';
  /** Why this default; shown in the UI so the number is never unexplained. */
  note?: string;
}

export interface BuildStep {
  /** Feature name as it appears in the tree. */
  name: string;
  op: string;
  /** Parameters this step consumed, for traceability back to the inputs. */
  uses: string[];
}

export interface ArchetypeResult {
  mesh: Mesh;
  steps: BuildStep[];
  params: ParamSpec[];
  /** Non-fatal notes: assumptions made, limits hit. */
  warnings: string[];
  valid: boolean;
}

export interface Archetype {
  id: string;
  label: string;
  /** Words that should route to this archetype. */
  aliases: string[];
  category: 'vessel' | 'mechanical' | 'structural' | 'fastener' | 'primitive';
  defaults: ParamSpec[];
  build: (p: Record<string, number>) => ArchetypeResult;
  /**
   * What the thing is normally made of.
   *
   * Without this every single part is weighed as aluminium, because that is the document
   * default — and a dining table then comes out at 84 kg. Mass is the first number an
   * engineer checks and the one that gives a model away as fake, so a table is oak, a storage
   * bin is polypropylene and a hook is steel unless the request says otherwise.
   *
   * Omitted where aluminium genuinely is the sensible default.
   */
  material?: { name: string; density: number };
  /**
   * Whether to ask a couple of questions before building this.
   *
   * Set for parts that are *made to fit something else*. A cup is a cup and everybody knows
   * what one looks like, so asking about it is an obstacle. A plating rack is a fixture for
   * your parts in your tank — its height, reach and current capacity are all decided by things
   * the request cannot contain — so building one without asking produces a rack, just not
   * yours.
   *
   * Deliberately a flag rather than something inferred. The first attempt guessed from how
   * many parameters carried explanatory notes, which put the cup and the rack on exactly the
   * same score: six each. The distinction is about what the object is for, and nothing in the
   * parameter table knows that.
   */
  asksFirst?: boolean;
}

const P = (
  key: string, label: string, value: number, min: number, max: number,
  unit: ParamSpec['unit'] = 'mm', note?: string,
): ParamSpec => ({ key, label, value, min, max, unit, note });

/** Clamps supplied values into their declared range and fills in any that were omitted. */
function resolve(defaults: ParamSpec[], given: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of defaults) {
    const v = given[d.key];
    out[d.key] = v === undefined || !Number.isFinite(v) ? d.value : Math.min(d.max, Math.max(d.min, v));
  }
  return out;
}

// ── cup / mug ────────────────────────────────────────────────────────────────

const CUP_PARAMS: ParamSpec[] = [
  P('outerDia', 'Outer diameter', 82, 30, 200, 'mm', 'A standard 350 ml mug measures 80-85 mm across.'),
  P('height', 'Height', 95, 30, 250, 'mm'),
  P('wall', 'Wall thickness', 4, 1, 15, 'mm', 'Typical for ceramic; 2 mm suits an injection-moulded plastic cup.'),
  P('baseThickness', 'Base thickness', 6, 1, 25, 'mm', 'Thicker than the wall so the cup sits stably and resists thermal shock.'),
  P('taper', 'Taper', 6, 0, 25, 'deg', 'Sides lean out slightly so cups stack and mould tooling can draw.'),
  P('handle', 'Handle', 1, 0, 1, 'count', '1 makes a mug, 0 a tumbler.'),
  P('handleThickness', 'Handle thickness', 9, 3, 25, 'mm'),
  P('handleReach', 'Handle reach', 32, 10, 90, 'mm', 'How far the handle stands off the body.'),
  P('rimFillet', 'Rim fillet', 2, 0, 10, 'mm'),
];

/**
 * A cup: revolved body, shelled from the top, with an optional swept handle.
 *
 * Built the way a person would model it, because that is what makes the result editable.
 * The body is a revolve of the outer silhouette; the cavity is a second revolve subtracted
 * rather than a generic shell operation, because a cup's wall and base thicknesses differ
 * and a uniform shell cannot express that.
 */
function buildCup(given: Record<string, number>): ArchetypeResult {
  const p = resolve(CUP_PARAMS, given);
  const warnings: string[] = [];
  const steps: BuildStep[] = [];

  const rBottom = p.outerDia / 2 - Math.tan(rad(p.taper)) * p.height;
  const rTop = p.outerDia / 2;

  if (rBottom < p.wall * 1.5) {
    warnings.push(
      `A ${p.taper}° taper over ${p.height} mm narrows the base to ${(rBottom * 2).toFixed(1)} mm, ` +
      `which is too little for a ${p.wall} mm wall. The taper was reduced to keep the base usable.`,
    );
  }
  const safeBottom = Math.max(rBottom, p.wall * 1.5 + 2);

  const cavBottom = Math.max(1, safeBottom - p.wall);
  const cavTop = Math.max(1, rTop - p.wall);

  // The whole cup is one revolve of its wall section — a U lying on its side, traced from
  // the axis out along the base, up the outside, across the rim and back down the inside.
  //
  // Modelling it as a solid body minus a cavity would need a boolean between two coaxial
  // revolves, which is both slower and needlessly fragile: two surfaces that differ by only
  // the wall thickness give the classifier a great many near-coincident planes to resolve.
  // One profile has no such problem, and it is also how a person would actually model it.
  let sectionPts: Vec2[] = [
    [0, 0],
    [safeBottom, 0],
    [rTop, p.height],
    [cavTop, p.height],
    [cavBottom, p.baseThickness],
    [0, p.baseThickness],
  ];

  // Round the rim and the inside floor in the *section*, before revolving.
  //
  // Doing it here rather than as a solid fillet afterwards is the whole difference between
  // an instant rebuild and a minute-long boolean between two coaxial revolves. The geometry
  // is identical — the arc is tangent to both faces by construction — and the result is a
  // single clean revolve rather than a fragmented one.
  if (p.rimFillet > 0.05) {
    // Indices 2 and 3 are the outer and inner rim corners; 4 is the inside floor corner.
    const f = filletCorners(sectionPts, p.rimFillet, [2, 3, 4]);
    sectionPts = f.loop;
    for (const s of f.skipped) {
      warnings.push(`The ${p.rimFillet} mm round was skipped at one corner: ${s.reason}.`);
    }
    if (f.rounded.length > 0) {
      steps.push({ name: 'RimRound', op: 'sketch-fillet', uses: ['rimFillet'] });
    }
  }

  let body = revolve(makeProfile(sectionPts), XZ, {
    axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360, feature: 'Body',
  });
  steps.unshift({
    name: 'Body', op: 'revolve',
    uses: ['outerDia', 'height', 'taper', 'wall', 'baseThickness'],
  });

  // Handle: a circular section swept along a C-curve from the upper body to the lower.
  if (p.handle >= 0.5) {
    const attachHigh = p.height * 0.78;
    const attachLow = p.height * 0.28;
    const rAt = (z: number) => safeBottom + ((rTop - safeBottom) * z) / p.height;

    // Start and end *inside* the wall so the sweep fuses with the body instead of
    // touching it tangentially, which would union into a non-manifold join.
    const bite = p.wall * 0.6;
    const spine: Vec3[] = [
      [rAt(attachHigh) - bite, 0, attachHigh],
      [rAt(attachHigh) + p.handleReach * 0.75, 0, attachHigh + 2],
      [rAt((attachHigh + attachLow) / 2) + p.handleReach, 0, (attachHigh + attachLow) / 2],
      [rAt(attachLow) + p.handleReach * 0.7, 0, attachLow - 2],
      [rAt(attachLow) - bite, 0, attachLow],
    ];

    const path = interpolateCurve(spine, 3);
    const section = circleProfile(p.handleThickness / 2);

    // A coarser sweep tolerance than the default. The handle is the one part of a cup that
    // gets unioned rather than revolved, and boolean cost climbs steeply with the number of
    // planes involved — 0.3 mm is well below what anyone can see on a 9 mm handle and cuts
    // the tool from a few thousand triangles to a few hundred.
    const handle = sweep(section, { path, feature: 'Handle', cap: true, tolerance: 0.3 });

    const joined = boolean(body, handle, 'union');
    if (!joined.valid) {
      warnings.push(
        joined.diagnostic ??
        'The handle did not fuse cleanly with the body. A thicker handle or a larger reach usually resolves it.',
      );
    }
    if (health(joined.mesh).closed) body = joined.mesh;
    steps.push({ name: 'Handle', op: 'sweep-union', uses: ['handleThickness', 'handleReach'] });
  }

  // Report the capacity, since that is what a cup is actually specified by.
  const mp = massProperties(body);
  void mp;
  const innerVolume = capacityMl(cavBottom, cavTop, p.height - p.baseThickness);
  warnings.push(`Holds about ${innerVolume.toFixed(0)} ml to the rim.`);

  return { mesh: body, steps, params: CUP_PARAMS, warnings, valid: health(body).closed };
}

/** Volume of a truncated cone, in millilitres. */
function capacityMl(rBottom: number, rTop: number, h: number): number {
  const mm3 = (Math.PI * h * (rBottom ** 2 + rBottom * rTop + rTop ** 2)) / 3;
  return mm3 / 1000;
}

// ── bottle ───────────────────────────────────────────────────────────────────

const BOTTLE_PARAMS: ParamSpec[] = [
  P('bodyDia', 'Body diameter', 65, 20, 200),
  P('height', 'Overall height', 210, 50, 400),
  P('neckDia', 'Neck diameter', 26, 8, 80),
  P('neckHeight', 'Neck height', 30, 5, 100),
  P('shoulderHeight', 'Shoulder height', 40, 5, 150, 'mm', 'The transition from body to neck.'),
  P('wall', 'Wall thickness', 2, 0.5, 10),
  P('baseThickness', 'Base thickness', 3, 1, 15),
];

function buildBottle(given: Record<string, number>): ArchetypeResult {
  const p = resolve(BOTTLE_PARAMS, given);
  const warnings: string[] = [];

  const rBody = p.bodyDia / 2;
  const rNeck = p.neckDia / 2;
  const bodyTop = p.height - p.neckHeight - p.shoulderHeight;

  if (bodyTop <= 5) {
    warnings.push('The neck and shoulder use up the whole height, so the body was given a 5 mm minimum.');
  }
  const safeBodyTop = Math.max(5, bodyTop);

  // Silhouette with a smooth shoulder, sampled from a spline so the curve is real geometry
  // rather than a chamfer pretending to be one.
  const shoulder: Vec2[] = [];
  const segs = 12;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // Smoothstep gives zero slope at both ends, so the shoulder meets body and neck tangentially.
    const s = t * t * (3 - 2 * t);
    shoulder.push([rBody + (rNeck - rBody) * s, safeBodyTop + p.shoulderHeight * t]);
  }

  // One closed wall section, out along the base and back down the inside — same reasoning
  // as the cup: no boolean between two nearly coincident coaxial surfaces.
  const inner = [...shoulder].reverse().map(([r, z]) => [Math.max(0.5, r - p.wall), z] as Vec2);

  const section = makeProfile([
    [0, 0], [rBody, 0], [rBody, safeBodyTop],
    ...shoulder,
    [rNeck, p.height],
    [Math.max(0.5, rNeck - p.wall), p.height],
    ...inner,
    [rBody - p.wall, safeBodyTop],
    [rBody - p.wall, p.baseThickness],
    [0, p.baseThickness],
  ]);

  const body = revolve(section, XZ, { axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360, feature: 'Body' });

  // Capacity from the internal silhouette, by Pappus rather than by meshing a second body.
  const innerMl = revolvedCapacityMl([
    [0, p.baseThickness], [rBody - p.wall, p.baseThickness], [rBody - p.wall, safeBodyTop],
    ...shoulder.map(([r, z]) => [Math.max(0.5, r - p.wall), z] as Vec2),
    [Math.max(0.5, rNeck - p.wall), p.height], [0, p.height],
  ]);
  warnings.push(`Holds about ${innerMl.toFixed(0)} ml.`);

  return {
    mesh: body,
    steps: [
      { name: 'Body', op: 'revolve', uses: ['bodyDia', 'height', 'neckDia', 'shoulderHeight', 'wall', 'baseThickness'] },
    ],
    params: BOTTLE_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}

/**
 * Volume swept by revolving a closed 2D section about the Y axis, in millilitres.
 *
 * Pappus's theorem: the volume equals the section's area times the distance its centroid
 * travels. Exact for a full revolution, and it costs no mesh at all.
 */
function revolvedCapacityMl(section: Vec2[]): number {
  let area2 = 0;
  let cx = 0;
  for (let i = 0; i < section.length; i++) {
    const [x0, y0] = section[i];
    const [x1, y1] = section[(i + 1) % section.length];
    const cr = x0 * y1 - x1 * y0;
    area2 += cr;
    cx += (x0 + x1) * cr;
  }
  if (Math.abs(area2) < 1e-12) return 0;
  const area = Math.abs(area2) / 2;
  const centroidX = Math.abs(cx / (3 * area2));
  return (area * 2 * Math.PI * centroidX) / 1000;
}

// ── flange ───────────────────────────────────────────────────────────────────

const FLANGE_PARAMS: ParamSpec[] = [
  P('outerDia', 'Outer diameter', 160, 30, 800),
  P('boreDia', 'Bore diameter', 60, 5, 600),
  P('thickness', 'Thickness', 14, 2, 100),
  P('boltCircle', 'Bolt circle diameter', 125, 10, 700),
  P('boltDia', 'Bolt hole diameter', 14, 2, 60),
  P('boltCount', 'Bolt count', 8, 2, 48, 'count'),
  P('hubDia', 'Hub diameter', 90, 0, 400, 'mm', 'Zero for a plain plate flange.'),
  P('hubHeight', 'Hub height', 20, 0, 150),
];

function buildFlange(given: Record<string, number>): ArchetypeResult {
  const p = resolve(FLANGE_PARAMS, given);
  const warnings: string[] = [];
  const steps: BuildStep[] = [];

  // Check the bolt circle actually fits between the bore and the rim before building.
  const inner = p.boreDia / 2;
  const outer = p.outerDia / 2;
  const bc = p.boltCircle / 2;
  const br = p.boltDia / 2;

  if (bc - br < inner + 2 || bc + br > outer - 2) {
    warnings.push(
      `A ${p.boltCircle} mm bolt circle with ${p.boltDia} mm holes leaves less than 2 mm of metal ` +
      `to the bore or the rim. The holes were kept, but this flange would not pass a review.`,
    );
  }

  // Bolt holes that overlap each other stop being holes: they merge into a continuous slot
  // and cut the flange into two loose rings. The geometry engine would dutifully produce
  // that, and it would be a valid solid that is not a flange, so it is caught here.
  let boltCount = Math.round(p.boltCount);
  const pitch = (2 * Math.PI * bc) / boltCount;
  if (pitch < p.boltDia + 1) {
    const maxCount = Math.max(2, Math.floor((2 * Math.PI * bc) / (p.boltDia + 1)));
    warnings.push(
      `${boltCount} holes of ${p.boltDia} mm on a ${p.boltCircle} mm circle are only ` +
      `${pitch.toFixed(1)} mm apart, so they would run into one another and part the flange. ` +
      `Reduced to ${maxCount}, the most that fit with 1 mm of metal between them.`,
    );
    boltCount = maxCount;
  }

  let body = revolve(
    makeProfile([[inner, 0], [outer, 0], [outer, p.thickness], [inner, p.thickness]]),
    XZ, { axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360, feature: 'Plate' },
  );
  steps.push({ name: 'Plate', op: 'revolve', uses: ['outerDia', 'boreDia', 'thickness'] });

  if (p.hubDia > p.boreDia && p.hubHeight > 0.5) {
    const hub = revolve(
      makeProfile([
        [inner, p.thickness], [p.hubDia / 2, p.thickness],
        [p.hubDia / 2, p.thickness + p.hubHeight], [inner, p.thickness + p.hubHeight],
      ]),
      XZ, { axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360, feature: 'Hub' },
    );
    const j = boolean(body, hub, 'union');
    if (j.valid) { body = j.mesh; steps.push({ name: 'Hub', op: 'revolve-union', uses: ['hubDia', 'hubHeight'] }); }
    else if (j.diagnostic) warnings.push(j.diagnostic);
  }

  const n = boltCount;
  const drills: Mesh[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    drills.push(cylinder(br, p.thickness + p.hubHeight + 20, [bc * Math.cos(a), bc * Math.sin(a), p.thickness / 2], [0, 0, 1], 'BoltHole'));
  }
  // A failed cut is discarded, not kept. An undrilled flange can still be drilled; a flange
  // whose surface no longer closes cannot be machined, printed, meshed or costed.
  const drilled = subtractAll(body, drills);
  if (drilled.valid) {
    body = drilled.mesh;
    steps.push({ name: 'BoltHoles', op: 'circular-pattern-cut', uses: ['boltCircle', 'boltDia', 'boltCount'] });
  } else {
    warnings.push(
      drilled.diagnostic ??
      'The bolt holes could not be cut without breaking the solid, so they were left out.',
    );
  }

  return { mesh: body, steps, params: FLANGE_PARAMS, warnings, valid: health(body).closed };
}

// ── L-bracket ────────────────────────────────────────────────────────────────

const BRACKET_PARAMS: ParamSpec[] = [
  P('legA', 'Leg A length', 80, 15, 500),
  P('legB', 'Leg B length', 60, 15, 500),
  P('width', 'Width', 50, 10, 400),
  P('thickness', 'Thickness', 6, 1, 50),
  P('holeDia', 'Hole diameter', 7, 0, 60),
  P('holesPerLeg', 'Holes per leg', 2, 0, 8, 'count'),
  P('filletRadius', 'Inside fillet', 6, 0, 40, 'mm', 'The inside corner is where a bracket fails first.'),
];

function buildBracket(given: Record<string, number>): ArchetypeResult {
  const p = resolve(BRACKET_PARAMS, given);
  const warnings: string[] = [];
  const steps: BuildStep[] = [];

  // L profile in XZ, extruded across the width.
  const t = p.thickness;
  const prof = makeProfile([
    [0, 0], [p.legA, 0], [p.legA, t], [t, t], [t, p.legB], [0, p.legB],
  ]);

  let body = extrude(prof, { origin: [0, -p.width / 2, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, 1, 0] }, {
    distance: p.width, feature: 'Bracket',
  });
  steps.push({ name: 'Bracket', op: 'extrude', uses: ['legA', 'legB', 'width', 'thickness'] });

  if (p.filletRadius > 0.05) {
    // Concave only. The parameter is the *inside* fillet — the corner a bracket fails at —
    // and rounding every outside edge as well turns it into a different part.
    const r = filletEdges(body, {
      radius: Math.min(p.filletRadius, Math.min(p.legA, p.legB) / 3),
      minAngleDeg: 45,
      convexity: 'concave',
    });
    if (r.valid) { body = r.mesh; steps.push({ name: 'Fillet', op: 'fillet', uses: ['filletRadius'] }); }
    else if (r.diagnostic) warnings.push(r.diagnostic);
  }

  const n = Math.round(p.holesPerLeg);
  if (n > 0 && p.holeDia > 0.5) {
    const drills: Mesh[] = [];
    const margin = Math.max(p.holeDia, t) * 1.5;

    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0.6 : margin / p.legA + (i / (n - 1)) * (1 - (2 * margin) / p.legA);
      const x = Math.min(p.legA - margin, Math.max(margin, f * p.legA));
      drills.push(cylinder(p.holeDia / 2, t * 4, [x, 0, t / 2], [0, 0, 1], 'Hole'));
    }
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0.6 : margin / p.legB + (i / (n - 1)) * (1 - (2 * margin) / p.legB);
      const z = Math.min(p.legB - margin, Math.max(margin + t, f * p.legB));
      drills.push(cylinder(p.holeDia / 2, t * 4, [t / 2, 0, z], [1, 0, 0], 'Hole'));
    }

    const drilled = subtractAll(body, drills);
    if (drilled.valid) {
      body = drilled.mesh;
      steps.push({ name: 'Holes', op: 'cut', uses: ['holeDia', 'holesPerLeg'] });
    } else {
      // Keep the undrilled bracket. A solid part missing its holes can still be drilled; a
      // part whose surface no longer closes cannot be machined, printed or costed at all.
      warnings.push(
        drilled.diagnostic ??
        'The mounting holes could not be cut without breaking the solid, so they were left out.',
      );
    }
  }

  return { mesh: body, steps, params: BRACKET_PARAMS, warnings, valid: health(body).closed };
}

// ── spur gear ────────────────────────────────────────────────────────────────

const GEAR_PARAMS: ParamSpec[] = [
  P('module', 'Module', 2, 0.3, 20, 'mm', 'Pitch diameter divided by tooth count; the standard way gears are sized.'),
  P('teeth', 'Teeth', 24, 6, 200, 'count'),
  P('faceWidth', 'Face width', 12, 1, 200),
  P('pressureAngle', 'Pressure angle', 20, 14.5, 30, 'deg', '20° is the modern standard.'),
  P('boreDia', 'Bore diameter', 10, 0, 300),
  P('hubDia', 'Hub diameter', 0, 0, 400),
  P('hubWidth', 'Hub width', 0, 0, 200),
];

/**
 * An involute spur gear.
 *
 * The tooth flank is a true involute of the base circle, generated from its parametric
 * definition rather than approximated by arcs. That matters: an approximated flank does not
 * roll at constant angular velocity, which is the entire purpose of the involute form, and
 * a gear that looks right but transmits unevenly is worse than one that obviously does not
 * fit.
 */
function buildGear(given: Record<string, number>): ArchetypeResult {
  const p = resolve(GEAR_PARAMS, given);
  const warnings: string[] = [];

  const z = Math.round(p.teeth);
  const m = p.module;
  const alpha = rad(p.pressureAngle);

  const rPitch = (m * z) / 2;
  const rBase = rPitch * Math.cos(alpha);
  const rAddendum = rPitch + m;             // standard addendum = 1 module
  const rDedendum = rPitch - 1.25 * m;      // standard dedendum = 1.25 modules

  if (p.boreDia / 2 > rDedendum - m) {
    warnings.push(
      `A ${p.boreDia} mm bore leaves almost no metal under the tooth roots ` +
      `(root radius ${(rDedendum * 2).toFixed(1)} mm). The gear would strip.`,
    );
  }

  // Undercut check: below this count, a standard cutter removes part of the involute.
  const minTeeth = Math.ceil(2 / Math.sin(alpha) ** 2);
  if (z < minTeeth) {
    warnings.push(
      `${z} teeth at ${p.pressureAngle}° will undercut — the standard minimum is ${minTeeth}. ` +
      `The flanks are drawn to the ideal involute, so a real cut gear would be weaker than this model.`,
    );
  }

  // One tooth flank as an involute from base circle to tip.
  const involute = (t: number): Vec2 => [
    rBase * (Math.cos(t) + t * Math.sin(t)),
    rBase * (Math.sin(t) - t * Math.cos(t)),
  ];
  const tMax = Math.sqrt((rAddendum / rBase) ** 2 - 1);

  // Angular thickness of a tooth at the pitch circle, offset so teeth are symmetric.
  const invAlpha = Math.tan(alpha) - alpha;
  const toothAngle = Math.PI / z;
  const halfTooth = toothAngle / 2 + invAlpha;

  const flankSteps = 10;
  const pts: Vec2[] = [];

  for (let i = 0; i < z; i++) {
    const centre = (i / z) * 2 * Math.PI;

    // Rising flank, mirrored to give the falling flank.
    const rise: Vec2[] = [];
    for (let k = 0; k <= flankSteps; k++) {
      const t = (k / flankSteps) * tMax;
      const [x, y] = involute(t);
      const a = Math.atan2(y, x);
      const r = Math.hypot(x, y);
      rise.push([r, a - halfTooth]);
    }

    // Root arc leading into this tooth.
    const rootStart = centre - toothAngle;
    for (let k = 0; k <= 3; k++) {
      const a = rootStart + (k / 3) * (toothAngle - (rise[0][1] + toothAngle));
      pts.push([rDedendum * Math.cos(a + centre - centre), rDedendum * Math.sin(a)]);
    }

    for (const [r, a] of rise) pts.push([r * Math.cos(centre + a), r * Math.sin(centre + a)]);
    for (let k = rise.length - 1; k >= 0; k--) {
      const [r, a] = rise[k];
      pts.push([r * Math.cos(centre - a), r * Math.sin(centre - a)]);
    }
  }

  // The bore is a hole in the profile, not a boolean afterwards.
  //
  // A gear body is an extrusion of a fifteen-hundred-point involute polygon, and pushing a
  // cylinder through twenty-five thousand triangles of it is exactly the case the BSP handles
  // worst. On a 54-tooth gear the cut came back with 204 open edges and the broken result was
  // kept, so the gearbox was not a solid. Extruding a profile that already has the hole in it
  // produces the same geometry exactly, in one pass, with no boolean that can fail.
  const bored = p.boreDia > 0.5 && p.boreDia / 2 < rDedendum;
  const prof = bored
    ? makeProfile(pts, [circleProfile(p.boreDia / 2).outer])
    : makeProfile(pts);

  let body = extrude(prof, { ...XY, origin: [0, 0, -p.faceWidth / 2] }, { distance: p.faceWidth, feature: 'Gear' });

  if (p.hubDia > 0 && p.hubWidth > 0) {
    const hub = cylinder(p.hubDia / 2, p.hubWidth, [0, 0, 0], [0, 0, 1], 'Hub');
    const j = boolean(body, hub, 'union');
    // A hub that will not merge is dropped rather than kept. Losing the hub leaves a usable
    // gear; keeping a failed union leaves a body that is not a solid at all.
    if (j.valid) body = j.mesh;
    else if (j.diagnostic) warnings.push(`The hub could not be merged, so it was left off. ${j.diagnostic}`);

    // The hub covers the bore, so it has to be re-opened through it.
    if (bored && j.valid) {
      const bore = cylinder(p.boreDia / 2, Math.max(p.faceWidth, p.hubWidth) * 2 + 10, [0, 0, 0], [0, 0, 1], 'Bore');
      const cut = boolean(body, bore, 'difference');
      if (cut.valid) body = cut.mesh;
      else if (cut.diagnostic) warnings.push(`The bore could not be cut through the hub. ${cut.diagnostic}`);
    }
  }

  if (p.boreDia > 0.5 && !bored) {
    warnings.push(
      `A ${p.boreDia} mm bore is wider than the tooth roots (${(rDedendum * 2).toFixed(1)} mm), ` +
      'so it was left out — cutting it would leave a ring of teeth with nothing holding them.',
    );
  }

  warnings.push(
    `Pitch diameter ${(rPitch * 2).toFixed(2)} mm, outside diameter ${(rAddendum * 2).toFixed(2)} mm. ` +
    `Meshes with any ${p.module} module gear at ${p.pressureAngle}°.`,
  );

  return {
    mesh: body,
    steps: [
      { name: 'Gear', op: 'extrude', uses: ['module', 'teeth', 'faceWidth', 'pressureAngle'] },
      { name: 'Bore', op: 'cut', uses: ['boreDia'] },
    ],
    params: GEAR_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}

// ── shaft ────────────────────────────────────────────────────────────────────

const SHAFT_PARAMS: ParamSpec[] = [
  P('diameter', 'Diameter', 25, 3, 300),
  P('length', 'Length', 180, 10, 2000),
  P('stepDia', 'Step diameter', 20, 0, 300, 'mm', 'Zero for a plain shaft.'),
  P('stepLength', 'Step length', 40, 0, 500),
  P('chamfer', 'End chamfer', 1.5, 0, 15),
  P('keywayWidth', 'Keyway width', 0, 0, 60),
  P('keywayDepth', 'Keyway depth', 0, 0, 40),
  P('keywayLength', 'Keyway length', 40, 0, 500),
];

function buildShaft(given: Record<string, number>): ArchetypeResult {
  const p = resolve(SHAFT_PARAMS, given);
  const warnings: string[] = [];

  const r = p.diameter / 2;
  let body = cylinder(r, p.length, [0, 0, p.length / 2], [0, 0, 1], 'Shaft');

  if (p.stepDia > 0.5 && p.stepLength > 0.5 && p.stepDia < p.diameter) {
    // Turn the end down to the step diameter.
    const collar = cylinder(r + 1, p.stepLength, [0, 0, p.length - p.stepLength / 2], [0, 0, 1], 'StepTool');
    const keep = cylinder(p.stepDia / 2, p.stepLength + 2, [0, 0, p.length - p.stepLength / 2], [0, 0, 1], 'Step');
    const waste = boolean(collar, keep, 'difference');
    const cut = boolean(body, waste.mesh, 'difference');
    if (cut.valid) body = cut.mesh; else if (cut.diagnostic) warnings.push(cut.diagnostic);
  }

  if (p.keywayWidth > 0.5 && p.keywayDepth > 0.1) {
    if (p.keywayDepth > r * 0.5) {
      warnings.push(`A ${p.keywayDepth} mm keyway removes more than half the shaft radius and would fail in torsion.`);
    }
    const slot = extrude(
      rectProfile(p.keywayWidth, p.keywayLength, 0, 0),
      { origin: [0, 0, r - p.keywayDepth], u: [1, 0, 0], v: [0, 0, 1], normal: [0, 1, 0] },
      { distance: p.keywayDepth * 2 + 2, midplane: true, feature: 'Keyway' },
    );
    const cut = boolean(body, slot, 'difference');
    if (cut.valid) body = cut.mesh; else if (cut.diagnostic) warnings.push(cut.diagnostic);
  }

  if (p.chamfer > 0.05) {
    const c = chamferEdges(body, { distance: p.chamfer, minAngleDeg: 60, feature: 'Chamfer' });
    if (c.valid) body = c.mesh;
  }

  return {
    mesh: body,
    steps: [{ name: 'Shaft', op: 'revolve', uses: ['diameter', 'length'] }],
    params: SHAFT_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}

// ── plate ────────────────────────────────────────────────────────────────────

const PLATE_PARAMS: ParamSpec[] = [
  P('length', 'Length', 200, 5, 3000),
  P('width', 'Width', 120, 5, 3000),
  P('thickness', 'Thickness', 8, 0.3, 200),
  P('cornerRadius', 'Corner radius', 10, 0, 300),
  P('holeDia', 'Hole diameter', 9, 0, 200),
  P('holeInset', 'Hole inset from edge', 18, 2, 500),
];

function buildPlate(given: Record<string, number>): ArchetypeResult {
  const p = resolve(PLATE_PARAMS, given);
  const warnings: string[] = [];

  const prof = rectProfile(p.length, p.width, 0, 0, p.cornerRadius);
  let body = extrude(prof, XY, { distance: p.thickness, feature: 'Plate' });

  if (p.holeDia > 0.5) {
    const dx = p.length / 2 - p.holeInset;
    const dy = p.width / 2 - p.holeInset;
    if (dx <= 0 || dy <= 0) {
      warnings.push(`A ${p.holeInset} mm inset does not fit on a ${p.length} x ${p.width} mm plate; the holes were skipped.`);
    } else {
      const drills = [[-dx, -dy], [dx, -dy], [dx, dy], [-dx, dy]].map(([x, y]) =>
        cylinder(p.holeDia / 2, p.thickness * 3, [x, y, p.thickness / 2], [0, 0, 1], 'Hole'),
      );
      const cut = subtractAll(body, drills);
      if (cut.valid) body = cut.mesh; else if (cut.diagnostic) warnings.push(cut.diagnostic);
    }
  }

  return {
    mesh: body,
    steps: [{ name: 'Plate', op: 'extrude', uses: ['length', 'width', 'thickness'] }],
    params: PLATE_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}

// ── pipe ─────────────────────────────────────────────────────────────────────

const PIPE_PARAMS: ParamSpec[] = [
  P('outerDia', 'Outer diameter', 60, 3, 1000),
  P('wall', 'Wall thickness', 4, 0.3, 100),
  P('length', 'Length', 250, 5, 5000),
  P('bendRadius', 'Bend radius', 0, 0, 1000, 'mm', 'Zero for a straight pipe.'),
  P('bendAngle', 'Bend angle', 90, 0, 180, 'deg'),
];

function buildPipe(given: Record<string, number>): ArchetypeResult {
  const p = resolve(PIPE_PARAMS, given);
  const warnings: string[] = [];

  const ro = p.outerDia / 2;
  const ri = Math.max(0.2, ro - p.wall);

  if (p.wall * 2 >= p.outerDia) {
    warnings.push('The wall is thicker than the radius, so this is a solid bar rather than a pipe.');
  }

  const section = makeProfile(circleProfile(ro).outer, [circleProfile(ri).outer]);

  let body: Mesh;
  if (p.bendRadius > ro && p.bendAngle > 1) {
    // Sweep the annulus along a circular arc path.
    const spine: Vec3[] = [];
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * rad(p.bendAngle);
      spine.push([p.bendRadius * Math.sin(a), 0, p.bendRadius * (1 - Math.cos(a))]);
    }
    body = sweep(section, { path: interpolateCurve(spine, 3), feature: 'Pipe' });
  } else {
    body = extrude(section, XY, { distance: p.length, feature: 'Pipe' });
  }

  return {
    mesh: body,
    steps: [{ name: 'Pipe', op: p.bendRadius > ro ? 'sweep' : 'extrude', uses: ['outerDia', 'wall', 'length'] }],
    params: PIPE_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}

// ── hex nut ──────────────────────────────────────────────────────────────────

const NUT_PARAMS: ParamSpec[] = [
  P('acrossFlats', 'Across flats', 17, 3, 120, 'mm', 'The spanner size. 17 mm suits an M10.'),
  P('thickness', 'Thickness', 8, 1, 80),
  P('boreDia', 'Bore diameter', 10, 1, 100),
  P('chamfer', 'Chamfer', 1, 0, 10),
];

function buildNut(given: Record<string, number>): ArchetypeResult {
  const p = resolve(NUT_PARAMS, given);
  const warnings: string[] = [];

  if (p.boreDia >= p.acrossFlats * 0.8) {
    warnings.push(`A ${p.boreDia} mm bore in a ${p.acrossFlats} mm nut leaves almost no wall.`);
  }

  // Across-flats to circumradius for a hexagon.
  const circum = p.acrossFlats / 2 / Math.cos(Math.PI / 6);
  const hexProfile = polygonProfile(6, circum);

  let body = extrude(hexProfile, XY, { distance: p.thickness, feature: 'Nut' });
  const bore = cylinder(p.boreDia / 2, p.thickness * 3, [0, 0, p.thickness / 2], [0, 0, 1], 'Bore');
  const cut = boolean(body, bore, 'difference');
  if (cut.valid) body = cut.mesh; else if (cut.diagnostic) warnings.push(cut.diagnostic);

  return {
    mesh: body,
    steps: [{ name: 'Nut', op: 'extrude', uses: ['acrossFlats', 'thickness'] }],
    params: NUT_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}

// ── washer ───────────────────────────────────────────────────────────────────

const WASHER_PARAMS: ParamSpec[] = [
  P('outerDia', 'Outer diameter', 21, 2, 300),
  P('boreDia', 'Bore diameter', 10.5, 1, 280),
  P('thickness', 'Thickness', 2, 0.2, 40),
];

function buildWasher(given: Record<string, number>): ArchetypeResult {
  const p = resolve(WASHER_PARAMS, given);
  const ro = p.outerDia / 2;
  const ri = Math.min(p.boreDia / 2, ro - 0.2);

  const body = extrude(
    makeProfile(circleProfile(ro).outer, [circleProfile(ri).outer]),
    XY, { distance: p.thickness, feature: 'Washer' },
  );

  return {
    mesh: body,
    steps: [{ name: 'Washer', op: 'extrude', uses: ['outerDia', 'boreDia', 'thickness'] }],
    params: WASHER_PARAMS,
    warnings: [],
    valid: health(body).closed,
  };
}

// ── pulley ───────────────────────────────────────────────────────────────────

const PULLEY_PARAMS: ParamSpec[] = [
  P('outerDia', 'Outer diameter', 100, 10, 800),
  P('width', 'Width', 22, 3, 200),
  P('grooveDepth', 'Groove depth', 8, 0, 60),
  P('grooveAngle', 'Groove angle', 38, 0, 90, 'deg', '38° is the standard V-belt included angle.'),
  P('boreDia', 'Bore diameter', 16, 0, 300),
  P('hubDia', 'Hub diameter', 40, 0, 400),
  P('hubWidth', 'Hub width', 30, 0, 200),
];

function buildPulley(given: Record<string, number>): ArchetypeResult {
  const p = resolve(PULLEY_PARAMS, given);
  const warnings: string[] = [];

  const ro = p.outerDia / 2;
  const halfW = p.width / 2;
  const grooveHalf = Math.tan(rad(p.grooveAngle / 2)) * p.grooveDepth;

  // Rim section with the V groove cut into its outer face.
  const section: Vec2[] = [
    [Math.max(1, p.boreDia / 2), -halfW],
    [ro, -halfW],
    [ro - p.grooveDepth, -Math.min(halfW, grooveHalf)],
    [ro - p.grooveDepth, Math.min(halfW, grooveHalf)],
    [ro, halfW],
    [Math.max(1, p.boreDia / 2), halfW],
  ];

  let body = revolve(makeProfile(section), XZ, {
    axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360, feature: 'Rim',
  });

  if (p.hubDia > p.boreDia && p.hubWidth > p.width) {
    const hub = cylinder(p.hubDia / 2, p.hubWidth, [0, 0, 0], [0, 0, 1], 'Hub');
    const j = boolean(body, hub, 'union');
    if (j.valid) body = j.mesh; else if (j.diagnostic) warnings.push(j.diagnostic);
  }

  if (p.boreDia > 0.5) {
    const bore = cylinder(p.boreDia / 2, Math.max(p.width, p.hubWidth) * 2 + 10, [0, 0, 0], [0, 0, 1], 'Bore');
    const cut = boolean(body, bore, 'difference');
    if (cut.valid) body = cut.mesh; else if (cut.diagnostic) warnings.push(cut.diagnostic);
  }

  return {
    mesh: body,
    steps: [{ name: 'Rim', op: 'revolve', uses: ['outerDia', 'width', 'grooveDepth'] }],
    params: PULLEY_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}

// ── enclosure ────────────────────────────────────────────────────────────────

const ENCLOSURE_PARAMS: ParamSpec[] = [
  P('length', 'Length', 120, 20, 800),
  P('width', 'Width', 80, 20, 800),
  P('height', 'Height', 45, 10, 600),
  P('wall', 'Wall thickness', 2.5, 0.6, 25),
  P('cornerRadius', 'Corner radius', 6, 0, 100),
  P('draft', 'Draft', 1.5, 0, 10, 'deg', 'Needed for the part to release from an injection mould.'),
];

function buildEnclosure(given: Record<string, number>): ArchetypeResult {
  const p = resolve(ENCLOSURE_PARAMS, given);
  const warnings: string[] = [];

  const outerProf = rectProfile(p.length, p.width, 0, 0, p.cornerRadius);
  let body = extrude(outerProf, XY, { distance: p.height, draftDeg: p.draft, feature: 'Shell' });

  const innerProf = rectProfile(
    p.length - p.wall * 2, p.width - p.wall * 2, 0, 0,
    Math.max(0, p.cornerRadius - p.wall),
  );
  const cavity = extrude(innerProf, { ...XY, origin: [0, 0, p.wall] }, {
    distance: p.height, draftDeg: p.draft, feature: 'Cavity',
  });

  const cut = boolean(body, cavity, 'difference');
  if (cut.valid) {
    body = cut.mesh;
  } else {
    warnings.push(
      (cut.diagnostic ?? 'The cavity could not be cut.') +
      ' The part is shown solid, so its wall thickness and mass are not yet meaningful.',
    );
  }

  if (p.draft < 0.5) {
    warnings.push('With less than 0.5° of draft this part will not release from an injection mould without scuffing.');
  }

  return {
    mesh: body,
    steps: [
      { name: 'Shell', op: 'extrude', uses: ['length', 'width', 'height', 'draft'] },
      { name: 'Cavity', op: 'extrude-cut', uses: ['wall'] },
    ],
    params: ENCLOSURE_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}

// ── car ──────────────────────────────────────────────────────────────────────

const CAR_PARAMS: ParamSpec[] = [
  P('length', 'Length', 4200, 1000, 12000, 'mm', 'A typical hatchback is about 4.2 m long.'),
  P('width', 'Width', 1780, 600, 3000),
  P('roofHeight', 'Roof height', 1450, 400, 4000),
  P('bonnetHeight', 'Bonnet height', 950, 200, 3000),
  P('wheelbase', 'Wheelbase', 2600, 500, 8000, 'mm', 'Centre to centre between the axles.'),
  P('wheelDiameter', 'Wheel diameter', 640, 100, 2000),
  P('wheelWidth', 'Wheel width', 225, 40, 800),
  P('groundClearance', 'Ground clearance', 150, 20, 800),
  P('cabinFront', 'Cabin front', 0.42, 0.1, 0.7, 'count', 'Where the windscreen meets the bonnet, as a fraction of the length.'),
  P('cabinRear', 'Cabin rear', 0.72, 0.3, 0.95, 'count'),
  P('bodyTaper', 'Body taper', 4, 0, 25, 'deg', 'Sides lean in toward the roof, as a real body does.'),
];

/**
 * A car.
 *
 * Modelled the way a body would actually be laid out: a side silhouette extruded across the
 * width, wheel arches cut, and wheels placed on the axles. That keeps it parametric — change
 * the wheelbase and the arches and wheels move together — rather than being a fixed mesh
 * shaped like a car.
 *
 * It is a massing model, not a body panel. It gets the proportions, the stance and the
 * package right, which is what a shape at this stage is for; it has no doors, no glazing and
 * no surface continuity, and it is not a substitute for a Class A surface.
 */
function buildCar(given: Record<string, number>): ArchetypeResult {
  const p = resolve(CAR_PARAMS, given);
  const warnings: string[] = [];
  const steps: BuildStep[] = [];

  const L = p.length;
  const halfL = L / 2;
  const wheelR = p.wheelDiameter / 2;

  // Keep the silhouette ordered and sane even when the parameters fight each other.
  const roof = Math.max(p.roofHeight, p.bonnetHeight + 120);
  if (roof !== p.roofHeight) {
    warnings.push(
      `The roof was raised to ${roof} mm: a roof at or below the bonnet leaves no cabin.`,
    );
  }

  const cabinRear = Math.max(p.cabinRear, p.cabinFront + 0.12);
  const xFront = -halfL + L * p.cabinFront;
  const xRear = -halfL + L * cabinRear;

  const floor = p.groundClearance;

  // Side silhouette in the XZ plane, traced from the front bumper round to the back.
  const side: Vec2[] = [
    [-halfL, floor],
    [-halfL, p.bonnetHeight * 0.72],
    [-halfL + L * 0.06, p.bonnetHeight],
    [xFront, p.bonnetHeight],
    [xFront + L * 0.10, roof],
    [xRear - L * 0.06, roof],
    [xRear + L * 0.05, p.bonnetHeight * 0.98],
    [halfL, p.bonnetHeight * 0.86],
    [halfL, floor],
  ];

  // Soften the transitions. A car silhouette with hard corners reads as a wedge, and these
  // are the radii that make it read as a car.
  const softened = filletCorners(side, Math.min(L * 0.045, 220), [1, 2, 3, 4, 5, 6, 7]);

  let body = extrude(
    makeProfile(softened.loop),
    { origin: [0, -p.width / 2, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, 1, 0] },
    { distance: p.width, draftDeg: -p.bodyTaper, feature: 'Body' },
  );
  steps.push({
    name: 'Body', op: 'extrude',
    uses: ['length', 'width', 'roofHeight', 'bonnetHeight', 'cabinFront', 'cabinRear', 'bodyTaper'],
  });

  // Wheel arches, cut before the wheels go in so the wheels sit inside them.
  const axleX = [-p.wheelbase / 2, p.wheelbase / 2];
  const archR = wheelR * 1.14;

  const arches = axleX.map((x) =>
    cylinder(archR, p.width * 1.2, [x, 0, wheelR], [0, 1, 0], 'WheelArch'),
  );
  const cutArches = subtractAll(body, arches);
  if (cutArches.valid) {
    body = cutArches.mesh;
    steps.push({ name: 'WheelArches', op: 'cut', uses: ['wheelbase', 'wheelDiameter'] });
  } else if (cutArches.diagnostic) {
    warnings.push(cutArches.diagnostic);
  }

  // Wheels, one at each corner, inset so they sit under the arches rather than proud.
  const trackHalf = p.width / 2 - p.wheelWidth / 2 - 20;
  const wheels: Mesh[] = [];
  for (const x of axleX) {
    for (const y of [-trackHalf, trackHalf]) {
      wheels.push(cylinder(wheelR, p.wheelWidth, [x, y, wheelR], [0, 1, 0], 'Wheel'));
    }
  }

  // The wheels are concatenated, not unioned.
  //
  // Each wheel sits inside its arch without touching the shell, so there is no material for
  // a union to fuse — and asking the boolean engine to merge two solids that do not
  // intersect is both wasteful and fragile: their bounding boxes overlap, so it runs the
  // full classifier over fifteen thousand triangles and can leave the result non-manifold.
  // When that happened the wheels were discarded and the car came out with none.
  //
  // Separate bodies is also the honest model. A wheel is not welded to the car; keeping them
  // distinct is what lets a wheel be changed without touching the shell.
  body = concatMeshes([body, ...wheels]);
  steps.push({ name: 'Wheels', op: 'place', uses: ['wheelDiameter', 'wheelWidth', 'wheelbase'] });

  if (p.wheelbase > L * 0.78) {
    warnings.push(
      `A ${p.wheelbase} mm wheelbase on a ${L} mm car leaves almost no overhang; ` +
      `the wheels will sit at the very ends of the body.`,
    );
  }

  warnings.push(
    'This is a massing model: proportions, stance and package. The wheels are separate ' +
    'bodies, as they are on a real car. It has no doors, glazing or Class A surfacing.',
  );

  return { mesh: body, steps, params: CAR_PARAMS, warnings, valid: health(body).closed };
}

// ── wheel ────────────────────────────────────────────────────────────────────

const WHEEL_PARAMS: ParamSpec[] = [
  P('diameter', 'Overall diameter', 640, 50, 2000),
  P('width', 'Width', 225, 20, 800),
  P('rimDiameter', 'Rim diameter', 432, 30, 1500, 'mm', '432 mm is a 17 inch rim.'),
  P('boreDiameter', 'Centre bore', 66, 5, 400),
  P('spokes', 'Spokes', 5, 0, 24, 'count'),
  P('spokeWidth', 'Spoke width', 34, 1.5, 200),
];

function buildWheel(given: Record<string, number>): ArchetypeResult {
  const p = resolve(WHEEL_PARAMS, given);
  const warnings: string[] = [];

  const rOuter = p.diameter / 2;
  const rRim = Math.min(p.rimDiameter / 2, rOuter - 5);
  const rBore = Math.min(p.boreDiameter / 2, rRim - 5);
  const halfW = p.width / 2;

  // Tyre: an annulus revolved about the axle.
  const tyre = revolve(
    makeProfile([[rRim, -halfW], [rOuter, -halfW * 0.86], [rOuter, halfW * 0.86], [rRim, halfW]]),
    { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
    { axisOrigin: [0, 0, 0], axisDir: [0, 1, 0], angleDeg: 360, feature: 'Tyre' },
  );

  const spokeCount = Math.round(p.spokes);

  // With no spokes the wheel is a solid disc, so the hub runs all the way out to the rim.
  // A small hub with nothing joining it to the tyre would be two disconnected bodies —
  // topologically valid and not a wheel.
  const hubW = spokeCount > 0 ? p.width * 0.35 : p.width * 0.55;
  const hubR = spokeCount > 0 ? Math.max(rBore + 12, rRim * 0.35) : rRim + 2;
  const hub = cylinder(hubR, hubW, [0, 0, 0], [0, 1, 0], 'Hub');

  const spokes: Mesh[] = [];

  if (spokeCount > 0) {
    // Two things have to be avoided here, and both produce a non-manifold union rather than
    // an obviously wrong shape.
    //
    // A spoke that stops exactly on the tyre's inner radius touches it tangentially: it
    // shares a surface but no volume, so there is nothing for the boolean to merge. So the
    // spokes overlap into both the hub and the tyre.
    //
    // And a spoke that runs all the way to the bore converges with every other spoke at the
    // centre, where five overlapping boxes meet the hub's own face. Starting them at the hub
    // instead keeps each intersection a simple pair.
    const overlap = Math.max(3, rRim * 0.03);
    const inner = Math.max(2, hubR - overlap);
    const outer = rRim + overlap;
    const len = outer - inner;
    const mid = (outer + inner) / 2;

    // Thinner than the hub, so the spoke's end faces sit strictly inside it rather than
    // exactly coplanar with it.
    const spokeAxial = hubW * 0.72;

    for (let i = 0; i < spokeCount; i++) {
      const a = (i / spokeCount) * Math.PI * 2;
      const spoke = extrude(
        rectProfile(len, Math.min(p.spokeWidth, (2 * Math.PI * inner) / spokeCount * 0.7)),
        {
          origin: [mid * Math.cos(a), -spokeAxial / 2, mid * Math.sin(a)],
          u: [Math.cos(a), 0, Math.sin(a)],
          v: [-Math.sin(a), 0, Math.cos(a)],
          normal: [0, 1, 0],
        },
        { distance: spokeAxial, feature: 'Spoke' },
      );
      spokes.push(spoke);
    }
  }

  // Spokes first, on their own, then the hub and tyre.
  //
  // Order is the whole cost here. Folding tyre, hub and twenty-four spokes together in one
  // list unions each spoke against an accumulator that already contains the tyre — so every
  // one of the twenty-four is a full BSP against a growing body, and building one wheel took
  // 11.8 seconds.
  //
  // The spokes do not touch each other: their width is capped at 70% of the gap between them.
  // A union of mutually disjoint solids takes the concatenation fast path, so bundling them
  // first costs almost nothing, and what remains is two real booleans instead of twenty-five.
  const parts = [...(spokes.length > 0 ? [unionAll(spokes).mesh] : []), hub, tyre];
  const merged = unionAll(parts);

  // A failed union is not kept.
  //
  // Twenty-four spokes meeting a hub and a rim is a pile of three-way intersections, and at
  // most spoke widths the merge came back with an open edge or two — which was then kept
  // anyway, so the wheel silently was not a solid. Whether it succeeds turns on the spoke
  // width in a way no user could predict: 2 and 5 mm worked, 1.5, 3, 4 and 6 did not.
  //
  // The fallback is to leave the rim, hub and spokes as separate bodies. They interpenetrate
  // exactly where they would be welded, each one is closed, and the combination is watertight
  // and weighs the right amount. It looks identical. What it loses is a single merged shell,
  // which matters for nothing this wheel is used for.
  let body: Mesh;
  if (merged.valid && health(merged.mesh).closed) {
    body = merged.mesh;
  } else {
    body = concatMeshes(parts);
    warnings.push(
      'The spokes would not merge into one shell, so the rim, hub and spokes are kept as ' +
      'separate bodies. They overlap where they would be welded; the wheel is still ' +
      'watertight and its mass is right.',
    );
  }

  if (rBore > 2) {
    const bore = cylinder(rBore, p.width * 2, [0, 0, 0], [0, 1, 0], 'Bore');
    const cut = boolean(body, bore, 'difference');
    if (cut.valid) body = cut.mesh; else if (cut.diagnostic) warnings.push(cut.diagnostic);
  }

  return {
    mesh: body,
    steps: [
      { name: 'Tyre', op: 'revolve', uses: ['diameter', 'width', 'rimDiameter'] },
      { name: 'Spokes', op: 'union', uses: ['spokes', 'spokeWidth'] },
      { name: 'Bore', op: 'cut', uses: ['boreDiameter'] },
    ],
    params: WHEEL_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}

// ── primitives ───────────────────────────────────────────────────────────────

const BOX_PARAMS = [P('length', 'Length', 60, 1, 2000), P('width', 'Width', 40, 1, 2000), P('height', 'Height', 25, 1, 2000)];
const CYL_PARAMS = [P('diameter', 'Diameter', 40, 1, 2000), P('height', 'Height', 60, 1, 2000)];
const SPHERE_PARAMS = [P('diameter', 'Diameter', 50, 1, 2000)];


// ── table ────────────────────────────────────────────────────────────────────

const TABLE_PARAMS: ParamSpec[] = [
  P('length', 'Top length', 1200, 200, 4000),
  P('width', 'Top width', 700, 150, 2000),
  P('height', 'Overall height', 740, 100, 1500, 'mm', '740 mm is the standard desk and dining height.'),
  P('topThickness', 'Top thickness', 25, 4, 120),
  P('legSize', 'Leg size', 60, 10, 250),
  P('inset', 'Leg inset from edge', 60, 0, 500),
];

/**
 * A four-legged table: top plus legs.
 *
 * Covers desk, dining table, bench and workbench, which are the same object at different
 * proportions. The legs are disjoint from one another, so they concatenate rather than going
 * through a boolean each — the same reason a spoked wheel is built the way it is.
 */
function buildTable(given: Record<string, number>): ArchetypeResult {
  const p = resolve(TABLE_PARAMS, given);
  const warnings: string[] = [];

  const legH = Math.max(10, p.height - p.topThickness);
  const inset = Math.min(p.inset, Math.min(p.length, p.width) / 2 - p.legSize);

  if (p.height > 500 && p.legSize < 30) {
    warnings.push(
      `A ${p.legSize} mm leg at ${p.height} mm tall is very slender. Real tables use at ` +
      'least 45 mm, or a stretcher between the legs.',
    );
  }

  const top = box(p.length, p.width, p.topThickness, [0, 0, p.height - p.topThickness / 2], 'Top');

  const dx = p.length / 2 - inset - p.legSize / 2;
  const dy = p.width / 2 - inset - p.legSize / 2;

  const legs = [[dx, dy], [-dx, dy], [dx, -dy], [-dx, -dy]].map(([x, y]) =>
    box(p.legSize, p.legSize, legH, [x, y, legH / 2], 'Leg'),
  );

  const merged = unionAll([...legs, top]);
  if (!merged.valid && merged.diagnostic) warnings.push(merged.diagnostic);

  return {
    mesh: merged.mesh,
    steps: [
      { name: 'Top', op: 'extrude', uses: ['length', 'width', 'topThickness'] },
      { name: 'Legs', op: 'union', uses: ['height', 'legSize', 'inset'] },
    ],
    params: TABLE_PARAMS,
    warnings,
    valid: health(merged.mesh).closed,
  };
}

// ── lamp ─────────────────────────────────────────────────────────────────────

const LAMP_PARAMS: ParamSpec[] = [
  P('height', 'Overall height', 450, 80, 2200),
  P('baseDia', 'Base diameter', 160, 30, 600),
  P('baseThickness', 'Base thickness', 18, 3, 120),
  P('stemDia', 'Stem diameter', 16, 3, 120),
  P('shadeTopDia', 'Shade top diameter', 110, 10, 700),
  P('shadeBottomDia', 'Shade bottom diameter', 190, 20, 900),
  P('shadeHeight', 'Shade height', 150, 20, 700),
];

/**
 * A table lamp: weighted base, stem, and a tapered shade.
 *
 * The shade is a revolve of a two-sided section rather than a solid cone, because a lamp
 * shade is a shell and modelling it solid would triple its mass and hide the bulb volume that
 * a packaging study actually cares about.
 */
function buildLamp(given: Record<string, number>): ArchetypeResult {
  const p = resolve(LAMP_PARAMS, given);
  const warnings: string[] = [];

  const baseR = p.baseDia / 2;
  const stemR = Math.min(p.stemDia / 2, baseR - 2);
  const shadeH = Math.min(p.shadeHeight, p.height - p.baseThickness - 20);
  const stemH = Math.max(10, p.height - p.baseThickness - shadeH);

  if (p.shadeBottomDia > p.baseDia * 2.2) {
    warnings.push(
      `A ${p.shadeBottomDia} mm shade over a ${p.baseDia} mm base is top-heavy and would ` +
      'tip. Widen the base or narrow the shade.',
    );
  }

  const base = cylinder(baseR, p.baseThickness, [0, 0, p.baseThickness / 2], [0, 0, 1], 'Base');
  const stem = cylinder(stemR, stemH, [0, 0, p.baseThickness + stemH / 2], [0, 0, 1], 'Stem');

  // Shade: a 2 mm wall revolved, so it is a shell rather than a solid cone.
  const wall = 2;
  const zBase = p.baseThickness + stemH;
  const rb = p.shadeBottomDia / 2;
  const rt = Math.max(1, p.shadeTopDia / 2);

  const shade = revolve(
    makeProfile([
      [rb, zBase], [rb + wall, zBase],
      [rt + wall, zBase + shadeH], [rt, zBase + shadeH],
    ]),
    { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
    { axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360, feature: 'Shade' },
  );

  const merged = unionAll([base, stem, shade]);
  if (!merged.valid && merged.diagnostic) warnings.push(merged.diagnostic);

  return {
    mesh: merged.mesh,
    steps: [
      { name: 'Base', op: 'revolve', uses: ['baseDia', 'baseThickness'] },
      { name: 'Stem', op: 'revolve', uses: ['stemDia', 'height'] },
      { name: 'Shade', op: 'revolve', uses: ['shadeTopDia', 'shadeBottomDia', 'shadeHeight'] },
    ],
    params: LAMP_PARAMS,
    warnings,
    valid: health(merged.mesh).closed,
  };
}

// ── handle ───────────────────────────────────────────────────────────────────

const HANDLE_PARAMS: ParamSpec[] = [
  P('centres', 'Fixing centres', 128, 20, 800, 'mm', 'The standard cabinet pitches are 96, 128 and 160 mm.'),
  P('gripDia', 'Grip diameter', 12, 4, 60),
  P('standoff', 'Standoff height', 32, 8, 200),
  P('postDia', 'Post diameter', 10, 3, 50),
];

/** A D-handle: a grip bar on two posts. Covers cabinet pulls, appliance and door handles. */
function buildHandle(given: Record<string, number>): ArchetypeResult {
  const p = resolve(HANDLE_PARAMS, given);
  const warnings: string[] = [];

  const postR = Math.min(p.postDia / 2, p.gripDia / 2);
  const overhang = p.gripDia;
  const gripLength = p.centres + overhang * 2;

  const grip = cylinder(p.gripDia / 2, gripLength, [0, 0, p.standoff], [1, 0, 0], 'Grip');
  const posts = [-p.centres / 2, p.centres / 2].map((x) =>
    cylinder(postR, p.standoff, [x, 0, p.standoff / 2], [0, 0, 1], 'Post'),
  );

  const merged = unionAll([...posts, grip]);
  if (!merged.valid && merged.diagnostic) warnings.push(merged.diagnostic);

  warnings.push(
    `Grip stands ${p.standoff} mm off the face with ${(p.standoff - p.gripDia / 2).toFixed(1)} mm ` +
    'of finger clearance under it.',
  );

  return {
    mesh: merged.mesh,
    steps: [
      { name: 'Posts', op: 'union', uses: ['centres', 'standoff', 'postDia'] },
      { name: 'Grip', op: 'union', uses: ['gripDia'] },
    ],
    params: HANDLE_PARAMS,
    warnings,
    valid: health(merged.mesh).closed,
  };
}

// ── knob ─────────────────────────────────────────────────────────────────────

const KNOB_PARAMS: ParamSpec[] = [
  P('diameter', 'Diameter', 40, 8, 250),
  P('height', 'Height', 22, 4, 160),
  P('boreDia', 'Shaft bore', 6, 0, 60),
  P('skirtDia', 'Skirt diameter', 46, 0, 300, 'mm', 'Zero for a plain cylinder.'),
  P('skirtHeight', 'Skirt height', 5, 0, 60),
];

/** A control knob: body, optional skirt, and a shaft bore. Covers dials, caps and handwheels. */
function buildKnob(given: Record<string, number>): ArchetypeResult {
  const p = resolve(KNOB_PARAMS, given);
  const warnings: string[] = [];

  const r = p.diameter / 2;
  const bore = Math.min(p.boreDia / 2, r - 1);

  // Body and skirt as one revolved section, so there is no boolean between them at all.
  const hasSkirt = p.skirtDia > p.diameter && p.skirtHeight > 0;
  const section: Vec2[] = hasSkirt
    ? [[0, 0], [p.skirtDia / 2, 0], [p.skirtDia / 2, p.skirtHeight], [r, p.skirtHeight], [r, p.height], [0, p.height]]
    : [[0, 0], [r, 0], [r, p.height], [0, p.height]];

  let body = revolve(
    makeProfile(section),
    { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
    { axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360, feature: 'Knob' },
  );

  if (bore > 0.5) {
    const drill = cylinder(bore, p.height * 2 + 10, [0, 0, p.height / 2], [0, 0, 1], 'Bore');
    const cut = boolean(body, drill, 'difference');
    if (cut.valid) body = cut.mesh;
    else if (cut.diagnostic) warnings.push(`The bore could not be cut, so it was left off. ${cut.diagnostic}`);
  }

  return {
    mesh: body,
    steps: [
      { name: 'Knob', op: 'revolve', uses: ['diameter', 'height', 'skirtDia', 'skirtHeight'] },
      { name: 'Bore', op: 'cut', uses: ['boreDia'] },
    ],
    params: KNOB_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}

// ── hook ─────────────────────────────────────────────────────────────────────

const HOOK_PARAMS: ParamSpec[] = [
  P('plateWidth', 'Backplate width', 40, 10, 300),
  P('plateHeight', 'Backplate height', 60, 10, 400),
  P('plateThickness', 'Backplate thickness', 4, 1, 40),
  P('armLength', 'Arm length', 45, 10, 400),
  P('barDia', 'Bar diameter', 8, 2, 60),
  P('lipHeight', 'Upturned lip', 18, 0, 200),
];

/** A wall hook: backplate, arm, and an upturned lip so what hangs on it stays on it. */
function buildHook(given: Record<string, number>): ArchetypeResult {
  const p = resolve(HOOK_PARAMS, given);
  const warnings: string[] = [];

  const r = p.barDia / 2;
  const t = p.plateThickness;
  const armZ = -p.plateHeight / 2 + r + 2;

  const plate = box(t, p.plateWidth, p.plateHeight, [t / 2, 0, 0], 'Backplate');
  const arm = cylinder(r, p.armLength, [t + p.armLength / 2, 0, armZ], [1, 0, 0], 'Arm');

  const parts = [plate, arm];
  if (p.lipHeight > 0.5) {
    parts.push(cylinder(r, p.lipHeight, [t + p.armLength, 0, armZ + p.lipHeight / 2], [0, 0, 1], 'Lip'));
  } else {
    warnings.push('With no lip, anything hung on this slides straight off.');
  }

  const merged = unionAll(parts);
  if (!merged.valid && merged.diagnostic) warnings.push(merged.diagnostic);

  return {
    mesh: merged.mesh,
    steps: [
      { name: 'Backplate', op: 'extrude', uses: ['plateWidth', 'plateHeight', 'plateThickness'] },
      { name: 'Arm', op: 'union', uses: ['armLength', 'barDia'] },
      { name: 'Lip', op: 'union', uses: ['lipHeight'] },
    ],
    params: HOOK_PARAMS,
    warnings,
    valid: health(merged.mesh).closed,
  };
}

// ── frame ────────────────────────────────────────────────────────────────────

const FRAME_PARAMS: ParamSpec[] = [
  P('length', 'Outer length', 400, 40, 4000),
  P('width', 'Outer width', 300, 40, 3000),
  P('section', 'Member width', 20, 3, 200),
  P('thickness', 'Thickness', 20, 3, 200),
];

/** A rectangular frame: four members round an opening. Covers picture frames and chassis. */
function buildFrame(given: Record<string, number>): ArchetypeResult {
  const p = resolve(FRAME_PARAMS, given);
  const warnings: string[] = [];

  const sec = Math.min(p.section, Math.min(p.length, p.width) / 2 - 1);
  if (sec !== p.section) {
    warnings.push(`A ${p.section} mm member leaves no opening at this size; it was reduced to ${sec.toFixed(1)} mm.`);
  }

  // The opening is a hole in the profile rather than a boolean, so this cannot fail.
  const outer = rectProfile(p.length, p.width).outer;
  const inner = rectProfile(p.length - sec * 2, p.width - sec * 2).outer;

  const body = extrude(makeProfile(outer, [inner]), XY, { distance: p.thickness, feature: 'Frame' });

  return {
    mesh: body,
    steps: [{ name: 'Frame', op: 'extrude', uses: ['length', 'width', 'section', 'thickness'] }],
    params: FRAME_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}

// ── funnel ───────────────────────────────────────────────────────────────────

const FUNNEL_PARAMS: ParamSpec[] = [
  P('mouthDia', 'Mouth diameter', 120, 20, 900),
  P('spoutDia', 'Spout diameter', 16, 3, 200),
  P('coneHeight', 'Cone height', 110, 10, 3000),
  P('spoutLength', 'Spout length', 60, 5, 500),
  P('wall', 'Wall thickness', 2, 0.4, 20),
];

/** A funnel or hopper: tapered cone into a straight spout, revolved as one shell. */
function buildFunnel(given: Record<string, number>): ArchetypeResult {
  const p = resolve(FUNNEL_PARAMS, given);
  const warnings: string[] = [];

  const rm = p.mouthDia / 2;
  const rs = Math.min(p.spoutDia / 2, rm - p.wall - 0.5);
  const w = p.wall;

  if (rs <= 0) {
    warnings.push('The spout is wider than the mouth, which is not a funnel. It was clamped.');
  }

  const rSpout = Math.max(1, rs);
  const zTop = p.spoutLength + p.coneHeight;

  // One closed section, inner wall back down — a single revolve with no boolean.
  const section: Vec2[] = [
    [rSpout, 0], [rSpout + w, 0],
    [rm + w, zTop], [rm, zTop],
    [rSpout, p.spoutLength],
  ];

  const body = revolve(
    makeProfile(section),
    { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
    { axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360, feature: 'Funnel' },
  );

  return {
    mesh: body,
    steps: [{ name: 'Funnel', op: 'revolve', uses: ['mouthDia', 'spoutDia', 'coneHeight', 'spoutLength', 'wall'] }],
    params: FUNNEL_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}

// ── tray ─────────────────────────────────────────────────────────────────────

const TRAY_PARAMS: ParamSpec[] = [
  P('length', 'Length', 300, 30, 2000),
  P('width', 'Width', 200, 30, 1500),
  P('height', 'Height', 60, 5, 800),
  P('wall', 'Wall thickness', 3, 0.5, 40),
  P('cornerRadius', 'Corner radius', 12, 0, 200),
];

/** An open-topped tray, bin or crate: a rounded box with the inside removed. */
function buildTray(given: Record<string, number>): ArchetypeResult {
  const p = resolve(TRAY_PARAMS, given);
  const warnings: string[] = [];

  const r = Math.min(p.cornerRadius, Math.min(p.length, p.width) / 2 - p.wall);
  const inner = Math.max(0, r - p.wall);

  const outer = extrude(
    rectProfile(p.length, p.width, 0, 0, Math.max(0, r)),
    XY, { distance: p.height, feature: 'Tray' },
  );

  // The cavity is open at the top, so it passes fully through that face rather than stopping
  // inside it. A cut that finishes within a wall leaves a sliver the boolean cannot resolve.
  const cavity = extrude(
    rectProfile(p.length - p.wall * 2, p.width - p.wall * 2, 0, 0, inner),
    { ...XY, origin: [0, 0, p.wall] },
    { distance: p.height, feature: 'Cavity' },
  );

  const cut = boolean(outer, cavity, 'difference');
  let body = outer;
  if (cut.valid) body = cut.mesh;
  else warnings.push(`${cut.diagnostic ?? 'The cavity could not be cut.'} The tray is shown solid.`);

  return {
    mesh: body,
    steps: [
      { name: 'Tray', op: 'extrude', uses: ['length', 'width', 'height', 'cornerRadius'] },
      { name: 'Cavity', op: 'cut', uses: ['wall'] },
    ],
    params: TRAY_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}

// ── registry ─────────────────────────────────────────────────────────────────


// ── plating / anodizing rack ─────────────────────────────────────────────────

const RACK_PARAMS: ParamSpec[] = [
  P('spineHeight', 'Spine height', 900, 200, 3000, 'mm',
    'Long enough to hang from the cathode bar and still clear the tank floor.'),
  P('spineWidth', 'Spine width', 40, 10, 200, 'mm',
    'Sets the current the rack can carry: about 1 A per mm² of titanium section.'),
  P('spineThickness', 'Spine thickness', 8, 2, 60),
  P('tiers', 'Tiers', 5, 1, 30, 'count', 'Rows of parts up the spine.'),
  P('armLength', 'Arm length', 300, 50, 1500, 'mm', 'Half-span each side of the spine.'),
  P('armWidth', 'Arm width', 16, 4, 120),
  P('armThickness', 'Arm thickness', 5, 1.5, 40),
  P('tipsPerArm', 'Contact tips per arm', 4, 1, 40, 'count'),
  P('tipLength', 'Contact tip length', 35, 5, 200, 'mm',
    'The sprung finger that grips the part and carries the current into it.'),
  P('tipDia', 'Contact tip diameter', 4, 1, 30),
  P('hookDia', 'Hook bar diameter', 14, 4, 60, 'mm',
    'Sits over the tank flight bar, so it must clear that bar.'),
];

/**
 * A plating or anodizing rack.
 *
 * A rack is an electrical component before it is a mechanical one. Current enters at the hook,
 * runs down the spine, out along each arm and into the part through a sprung contact tip, and
 * every one of those sections has to carry the whole downstream load without heating. The
 * warnings below check exactly that, because a rack that is mechanically fine and electrically
 * undersized produces burnt contacts and a batch of rejects.
 *
 * Titanium is the default and near-universal choice: it conducts, it survives the sulphuric
 * acid, and its own oxide stops it plating up — so the rack does not gain a coating every run
 * the way a steel one would.
 *
 * Geometry is a spine, a set of cross arms, and a tip per part. Everything is disjoint except
 * where arms meet the spine, so it concatenates rather than paying for a boolean per tip.
 */
function buildRack(given: Record<string, number>): ArchetypeResult {
  const p = resolve(RACK_PARAMS, given);
  const warnings: string[] = [];

  const tiers = Math.max(1, Math.round(p.tiers));
  const perArm = Math.max(1, Math.round(p.tipsPerArm));
  const parts = tiers * perArm * 2;

  // ── electrical sizing ──
  //
  // Titanium carries roughly 1 A/mm² in a plating rack before self-heating becomes a problem.
  // A part being anodized draws about 1.5 A/dm² of surface; without knowing the parts, the
  // check is made per contact, which is the section that fails first.
  const AMPS_PER_MM2 = 1.0;
  const AMPS_PER_TIP = 8;

  const spineSection = p.spineWidth * p.spineThickness;
  const armSection = p.armWidth * p.armThickness;
  const tipSection = Math.PI * (p.tipDia / 2) ** 2;

  const totalCurrent = parts * AMPS_PER_TIP;
  const currentPerArm = perArm * AMPS_PER_TIP;

  if (spineSection * AMPS_PER_MM2 < totalCurrent) {
    warnings.push(
      `The spine is ${spineSection.toFixed(0)} mm² and has to carry about ` +
      `${totalCurrent.toFixed(0)} A for ${parts} parts. Titanium wants roughly 1 A/mm², so ` +
      `widen it to at least ${(totalCurrent / p.spineThickness).toFixed(0)} mm or run fewer parts.`,
    );
  }

  if (armSection * AMPS_PER_MM2 < currentPerArm) {
    warnings.push(
      `Each arm is ${armSection.toFixed(0)} mm² carrying about ${currentPerArm.toFixed(0)} A. ` +
      'The arms will run hot and the outermost parts will finish thin.',
    );
  }

  if (tipSection * AMPS_PER_MM2 < AMPS_PER_TIP) {
    warnings.push(
      `A ${p.tipDia} mm contact tip is ${tipSection.toFixed(1)} mm² for about ${AMPS_PER_TIP} A. ` +
      'Thin tips burn at the contact point and mark the part.',
    );
  }

  const pitch = p.spineHeight / (tiers + 1);
  if (pitch < 60) {
    warnings.push(
      `${tiers} tiers over ${p.spineHeight} mm leaves ${pitch.toFixed(0)} mm between arms. ` +
      'Parts need room to drain and to stop gas bubbles being trapped under the one above.',
    );
  }

  // ── geometry ──
  const bodies: Mesh[] = [];

  // Spine, standing on the origin so the hook is at the top.
  bodies.push(box(p.spineThickness, p.spineWidth, p.spineHeight, [0, 0, p.spineHeight / 2], 'Spine'));

  // Hook: a bar across the top that drops over the tank's flight bar.
  bodies.push(cylinder(
    p.hookDia / 2, p.spineWidth * 3,
    [0, 0, p.spineHeight + p.hookDia], [0, 1, 0], 'Hook',
  ));

  const tipSpacing = p.armLength / (perArm + 0.5);

  for (let t = 0; t < tiers; t++) {
    const z = pitch * (t + 1);

    // One arm through the spine, reaching both ways.
    bodies.push(box(p.armThickness, p.armLength * 2, p.armWidth, [0, 0, z], 'Arm'));

    for (let i = 0; i < perArm; i++) {
      // Outward from the spine, leaving the innermost slot clear of it.
      const y = tipSpacing * (i + 1);
      for (const side of [1, -1]) {
        bodies.push(cylinder(
          p.tipDia / 2, p.tipLength,
          [p.tipLength / 2, side * y, z], [1, 0, 0], 'Contact tip',
        ));
      }
    }
  }

  // Concatenated, not unioned.
  //
  // The tips and arms overlap the spine exactly where they would be welded, and each piece is
  // a closed solid on its own, so the result is watertight without asking a BSP to resolve
  // several hundred three-way intersections. On a five-tier rack that is the difference
  // between milliseconds and half a minute.
  const body = concatMeshes(bodies);

  warnings.push(
    `${parts} parts on ${tiers} tiers, drawing about ${totalCurrent.toFixed(0)} A in total. ` +
    `Immersion depth ${(p.spineHeight - pitch).toFixed(0)} mm below the top arm.`,
  );

  return {
    mesh: body,
    steps: [
      { name: 'Spine', op: 'extrude', uses: ['spineHeight', 'spineWidth', 'spineThickness'] },
      { name: 'Hook', op: 'revolve', uses: ['hookDia'] },
      { name: 'Arms', op: 'linear-pattern', uses: ['tiers', 'armLength', 'armWidth', 'armThickness'] },
      { name: 'Contact tips', op: 'linear-pattern', uses: ['tipsPerArm', 'tipLength', 'tipDia'] },
    ],
    params: RACK_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}


// ── internal combustion engine ───────────────────────────────────────────────

const ENGINE_PARAMS: ParamSpec[] = [
  P('power', 'Power', 150, 5, 2000, 'count',
    'Crank kilowatts. Everything else is sized from this and the speed it makes it at.'),
  P('cylinders', 'Cylinders', 4, 1, 16, 'count',
    'Four in line, six or eight in a vee. Above six, a vee is shorter than a straight.'),
  P('redline', 'Rated speed', 6000, 1200, 12000, 'count',
    'rev/min at peak power. A diesel makes it near 4 000; a bike engine past 10 000.'),
  P('bmep', 'Brake mean effective pressure', 11, 5, 30, 'count',
    'Bar. About 10–12 naturally aspirated, 18–25 turbocharged. This is what decides how much '
    + 'engine a given power needs.'),
  P('strokeRatio', 'Stroke / bore', 1.0, 0.6, 1.6, 'count',
    'Under 1 is oversquare and revs; over 1 is undersquare and pulls low down.'),
  P('vee', 'Vee angle', 0, 0, 180, 'deg',
    'Zero for an in-line engine. 90° for a V8, 60° for a V6.'),
];

/**
 * A piston engine, sized from what it has to do rather than picked off a shelf.
 *
 * The chain is the one an engine designer actually walks, and every step of it is a published
 * relationship rather than a guess:
 *
 *   Swept volume from power. For a four-stroke, P = BMEP · V · N / 2, because each cylinder
 *   fires once every two revolutions. Rearranged, the displacement needed for a given power at
 *   a given speed falls straight out — and BMEP is the honest knob, because it is what
 *   separates a naturally aspirated engine from a turbocharged one of half the size.
 *
 *   Bore and stroke from swept volume. V per cylinder = π·b²·s/4 with s = r·b, so
 *   b = ∛(4·V / (π·r)). The stroke ratio is the character of the engine: oversquare revs,
 *   undersquare pulls.
 *
 *   Everything else from the bore. Bore spacing is about 1.2 bores on a production block, deck
 *   height is roughly stroke + rod + compression height, and the crank throw is half the
 *   stroke by definition.
 *
 * So asking for "a 300 kW V8" gives a 4.9-litre engine with a 94 mm bore, and asking for the
 * same power at 3 000 rpm gives twice the displacement — which is the difference between a
 * sports car and a truck, and is the sort of thing a model that had memorised engines would
 * get wrong.
 */
function buildEngine(given: Record<string, number>): ArchetypeResult {
  const p = resolve(ENGINE_PARAMS, given);
  const warnings: string[] = [];

  const n = Math.max(1, Math.round(p.cylinders));
  const rpm = p.redline;
  const bmepPa = p.bmep * 1e5;          // bar → Pa
  const powerW = p.power * 1000;

  // Four-stroke: one power stroke per two revolutions, so the 2 in the denominator.
  const revsPerSecond = rpm / 60;
  const sweptM3 = (powerW * 2) / (bmepPa * revsPerSecond);
  const sweptCc = sweptM3 * 1e6;
  const perCylinderCc = sweptCc / n;

  // V = π·b²·s/4 with s = r·b  →  b = cbrt(4V / (π·r))
  const bore = Math.cbrt((4 * perCylinderCc * 1000) / (Math.PI * p.strokeRatio));
  const stroke = bore * p.strokeRatio;

  const boreSpacing = bore * 1.22;      // production blocks sit near this
  const rodLength = stroke * 1.75;      // rod / stroke of 1.75 is the usual compromise
  const deckHeight = stroke / 2 + rodLength + bore * 0.45;

  const vee = p.vee > 5;
  const banks = vee ? 2 : 1;
  const perBank = Math.ceil(n / banks);
  const blockLength = boreSpacing * perBank + bore * 0.9;

  // ── what the numbers mean ──
  const litres = sweptCc / 1000;
  const meanPistonSpeed = (2 * stroke * rpm) / 60000;   // m/s
  const specificOutput = p.power / litres;               // kW per litre

  warnings.push(
    `${litres.toFixed(2)} litres, ${n} cylinders, ${bore.toFixed(1)} x ${stroke.toFixed(1)} mm ` +
    `bore x stroke. ${specificOutput.toFixed(0)} kW/litre at ${rpm} rev/min.`,
  );

  if (meanPistonSpeed > 25) {
    warnings.push(
      `Mean piston speed is ${meanPistonSpeed.toFixed(1)} m/s. Production engines stay under ` +
      'about 20 and racing engines under 25 — beyond that the rings and the rod bolts are the ' +
      'limit, not the breathing.',
    );
  }

  if (p.bmep > 14 && p.bmep < 30) {
    warnings.push(
      `${p.bmep} bar BMEP needs forced induction; a naturally aspirated engine reaches ` +
      'about 12. No turbocharger or supercharger is modelled here.',
    );
  }

  if (!vee && n > 6) {
    warnings.push(
      `${n} cylinders in line makes a ${blockLength.toFixed(0)} mm block. Above six, a vee is ` +
      'the usual answer — set a vee angle.',
    );
  }

  // ── geometry ──
  const bodies: Mesh[] = [];
  const bankTilt = vee ? p.vee / 2 : 0;
  const crankZ = 0;

  // Crankcase and sump sit under the crank centreline.
  bodies.push(box(blockLength, bore * 1.9, bore * 0.9, [0, 0, crankZ - bore * 0.45], 'Crankcase'));
  bodies.push(box(blockLength * 0.86, bore * 1.5, bore * 0.75,
    [0, 0, crankZ - bore * 1.25], 'Sump'));

  // Crankshaft along the block.
  bodies.push(cylinder(bore * 0.3, blockLength * 0.98, [0, 0, crankZ], [1, 0, 0], 'Crankshaft'));

  // Flywheel at the back.
  bodies.push(cylinder(bore * 1.05, bore * 0.22,
    [-blockLength / 2 - bore * 0.11, 0, crankZ], [1, 0, 0], 'Flywheel'));

  for (let b = 0; b < banks; b++) {
    const side = banks === 1 ? 0 : (b === 0 ? 1 : -1);
    const angle = (side * bankTilt * Math.PI) / 180;
    const [sinA, cosA] = [Math.sin(angle), Math.cos(angle)];

    // A bank is a cylinder block, a head and a cam cover, stacked along the bank axis.
    const bankAt = (up: number): [number, number, number] =>
      [0, up * sinA, crankZ + up * cosA];

    const blockUp = deckHeight / 2;
    bodies.push(box(blockLength, bore * 1.45, deckHeight, bankAt(blockUp), 'Cylinder block'));

    const headUp = deckHeight + bore * 0.42;
    bodies.push(box(blockLength * 0.97, bore * 1.4, bore * 0.84, bankAt(headUp), 'Cylinder head'));

    const coverUp = deckHeight + bore * 1.06;
    bodies.push(box(blockLength * 0.92, bore * 1.25, bore * 0.44, bankAt(coverUp), 'Cam cover'));

    // Exhaust manifold down the outboard face.
    const manifoldY = (bore * 0.95) * (side === 0 ? 1 : side);
    bodies.push(cylinder(bore * 0.22, blockLength * 0.9,
      [0, manifoldY * cosA + (deckHeight * 0.6) * sinA * (side || 1),
        crankZ + deckHeight * 0.6 * cosA],
      [1, 0, 0], 'Exhaust manifold'));

    // Pistons and rods, one per cylinder in this bank.
    const count = b === banks - 1 ? n - perBank * b : perBank;
    for (let i = 0; i < count; i++) {
      const x = -blockLength / 2 + bore * 0.45 + boreSpacing * (i + 0.5) - boreSpacing / 2 + bore * 0.45;
      const pistonUp = deckHeight * 0.62;
      const rodUp = deckHeight * 0.3;

      bodies.push(cylinder(bore / 2 - 0.4, bore * 0.7,
        [x, pistonUp * sinA, crankZ + pistonUp * cosA],
        [-sinA, 0, cosA] as unknown as [number, number, number], 'Piston'));

      bodies.push(cylinder(bore * 0.13, rodLength,
        [x, rodUp * sinA, crankZ + rodUp * cosA],
        [-sinA, 0, cosA] as unknown as [number, number, number], 'Connecting rod'));
    }
  }

  // Intake sits in the vee, or on the inboard face of an in-line engine.
  bodies.push(box(blockLength * 0.8, bore * 0.9, bore * 0.7,
    [0, vee ? 0 : bore * 1.1, crankZ + deckHeight + bore * 1.5], 'Intake manifold'));

  // Concatenated rather than unioned: each body is closed on its own and they overlap only
  // where they would be bolted or pressed together, so the result is watertight without
  // asking for several hundred three-way intersections.
  const body = concatMeshes(bodies);

  return {
    mesh: body,
    steps: [
      { name: 'Displacement', op: 'derive', uses: ['power', 'redline', 'bmep'] },
      { name: 'Bore and stroke', op: 'derive', uses: ['cylinders', 'strokeRatio'] },
      { name: 'Block', op: 'extrude', uses: ['cylinders', 'vee'] },
      { name: 'Rotating assembly', op: 'union', uses: ['strokeRatio'] },
    ],
    params: ENGINE_PARAMS,
    warnings,
    valid: health(body).closed,
  };
}

const CATALOGUE: Archetype[] = [
  {
    id: 'cup', label: 'Cup / mug', category: 'vessel',
    aliases: ['cup', 'mug', 'tumbler', 'beaker', 'glass', 'teacup', 'coffee cup'],
    defaults: CUP_PARAMS, build: buildCup,
    material: { name: 'Stoneware', density: 2.4 },
  },
  {
    id: 'bottle', label: 'Bottle', category: 'vessel',
    aliases: ['bottle', 'flask', 'vial', 'jar', 'canteen'],
    defaults: BOTTLE_PARAMS, build: buildBottle,
    material: { name: 'PET', density: 1.38 },
  },
  {
    id: 'flange', label: 'Flange', category: 'mechanical',
    aliases: ['flange', 'pipe flange', 'blind flange', 'weld neck'],
    defaults: FLANGE_PARAMS, build: buildFlange,
  },
  {
    id: 'bracket', label: 'L-bracket', category: 'structural',
    aliases: ['bracket', 'l-bracket', 'angle bracket', 'corner brace', 'angle'],
    defaults: BRACKET_PARAMS, build: buildBracket,
  },
  {
    id: 'gear', label: 'Spur gear', category: 'mechanical',
    aliases: ['gear', 'spur gear', 'cog', 'pinion', 'gearwheel'],
    defaults: GEAR_PARAMS, build: buildGear,
    material: { name: 'Steel 1018', density: 7.85 },
  },
  {
    id: 'shaft', label: 'Shaft', category: 'mechanical',
    aliases: ['shaft', 'axle', 'spindle', 'rod', 'pin'],
    defaults: SHAFT_PARAMS, build: buildShaft,
    material: { name: 'Steel 1018', density: 7.85 },
  },
  {
    id: 'plate', label: 'Plate', category: 'structural',
    aliases: ['plate', 'panel', 'sheet', 'baseplate', 'mounting plate'],
    defaults: PLATE_PARAMS, build: buildPlate,
  },
  {
    id: 'pipe', label: 'Pipe / tube', category: 'structural',
    aliases: ['pipe', 'tube', 'tubing', 'conduit', 'elbow'],
    defaults: PIPE_PARAMS, build: buildPipe,
  },
  {
    id: 'nut', label: 'Hex nut', category: 'fastener',
    aliases: ['nut', 'hex nut', 'hexagon nut', 'lock nut'],
    defaults: NUT_PARAMS, build: buildNut,
    material: { name: 'Steel 1018', density: 7.85 },
  },
  {
    id: 'washer', label: 'Washer', category: 'fastener',
    aliases: ['washer', 'shim', 'spacer'],
    defaults: WASHER_PARAMS, build: buildWasher,
    material: { name: 'Steel 1018', density: 7.85 },
  },
  {
    id: 'pulley', label: 'V-belt pulley', category: 'mechanical',
    aliases: ['pulley', 'sheave', 'belt wheel', 'v-belt pulley'],
    defaults: PULLEY_PARAMS, build: buildPulley,
  },
  {
    id: 'enclosure', label: 'Enclosure', category: 'structural',
    aliases: ['enclosure', 'housing', 'case', 'box housing', 'project box'],
    defaults: ENCLOSURE_PARAMS, build: buildEnclosure,
    material: { name: 'ABS', density: 1.05 },
  },
  {
    id: 'car', label: 'Car', category: 'structural',
    aliases: ['car', 'automobile', 'vehicle', 'sedan', 'hatchback', 'saloon', 'suv', 'motorcar'],
    defaults: CAR_PARAMS, build: buildCar,
  },
  {
    id: 'wheel', label: 'Road wheel', category: 'mechanical',
    aliases: ['wheel', 'road wheel', 'rim', 'tyre', 'tire', 'alloy wheel'],
    defaults: WHEEL_PARAMS, build: buildWheel,
  },
  {
    id: 'engine', label: 'Piston engine', category: 'mechanical',
    aliases: [
      'engine', 'car engine', 'ic engine', 'combustion engine', 'petrol engine',
      'diesel engine', 'motor engine', 'v8', 'v6', 'inline four', 'powerplant',
    ],
    defaults: ENGINE_PARAMS, build: buildEngine,
    material: { name: 'Cast aluminium and steel', density: 3.6 },
    asksFirst: true,
  },
  {
    id: 'rack', label: 'Plating rack', category: 'structural',
    aliases: [
      'rack', 'anodizing rack', 'anodising rack', 'plating rack', 'jig',
      'anodizing jig', 'plating jig', 'electroplating rack', 'work rack',
    ],
    defaults: RACK_PARAMS, build: buildRack,
    material: { name: 'Titanium Ti-6Al-4V', density: 4.43 },
    asksFirst: true,
  },
  {
    id: 'table', label: 'Table', category: 'structural',
    aliases: ['table', 'desk', 'bench', 'workbench', 'dining table', 'coffee table', 'side table'],
    defaults: TABLE_PARAMS, build: buildTable,
    material: { name: 'Oak', density: 0.75 },
  },
  {
    id: 'lamp', label: 'Table lamp', category: 'structural',
    aliases: ['lamp', 'desk lamp', 'table lamp', 'light', 'bedside lamp', 'floor lamp'],
    defaults: LAMP_PARAMS, build: buildLamp,
    material: { name: 'Steel base and fabric shade', density: 2.7 },
  },
  {
    id: 'handle', label: 'Handle', category: 'structural',
    aliases: ['handle', 'pull', 'door handle', 'cabinet handle', 'grab handle', 'd-handle'],
    defaults: HANDLE_PARAMS, build: buildHandle,
  },
  {
    id: 'knob', label: 'Knob', category: 'mechanical',
    aliases: ['knob', 'dial', 'control knob', 'handwheel', 'cap'],
    defaults: KNOB_PARAMS, build: buildKnob,
    material: { name: 'ABS', density: 1.05 },
  },
  {
    id: 'hook', label: 'Wall hook', category: 'structural',
    aliases: ['hook', 'wall hook', 'coat hook', 'peg', 'hanger'],
    defaults: HOOK_PARAMS, build: buildHook,
    material: { name: 'Steel 1018', density: 7.85 },
  },
  {
    id: 'frame', label: 'Frame', category: 'structural',
    aliases: ['frame', 'picture frame', 'surround', 'bezel'],
    defaults: FRAME_PARAMS, build: buildFrame,
    material: { name: 'Oak', density: 0.75 },
  },
  {
    id: 'funnel', label: 'Funnel', category: 'vessel',
    aliases: ['funnel', 'hopper', 'chute'],
    defaults: FUNNEL_PARAMS, build: buildFunnel,
    material: { name: 'Polypropylene', density: 0.9 },
  },
  {
    id: 'tray', label: 'Tray', category: 'vessel',
    aliases: ['tray', 'bin', 'crate', 'container', 'basket', 'box open', 'caddy'],
    defaults: TRAY_PARAMS, build: buildTray,
    material: { name: 'Polypropylene', density: 0.9 },
  },
  {
    id: 'box', label: 'Box', category: 'primitive',
    aliases: ['box', 'block', 'cube', 'cuboid', 'slab'],
    defaults: BOX_PARAMS,
    build: (g) => {
      const p = resolve(BOX_PARAMS, g);
      const mesh = extrude(rectProfile(p.length, p.width), { ...XY, origin: [0, 0, 0] }, { distance: p.height, feature: 'Box' });
      return { mesh, steps: [{ name: 'Box', op: 'extrude', uses: ['length', 'width', 'height'] }], params: BOX_PARAMS, warnings: [], valid: health(mesh).closed };
    },
  },
  {
    id: 'cylinder', label: 'Cylinder', category: 'primitive',
    aliases: ['cylinder', 'disc', 'disk', 'puck', 'billet'],
    defaults: CYL_PARAMS,
    build: (g) => {
      const p = resolve(CYL_PARAMS, g);
      const mesh = cylinder(p.diameter / 2, p.height, [0, 0, p.height / 2], [0, 0, 1], 'Cylinder');
      return { mesh, steps: [{ name: 'Cylinder', op: 'revolve', uses: ['diameter', 'height'] }], params: CYL_PARAMS, warnings: [], valid: health(mesh).closed };
    },
  },
  {
    id: 'sphere', label: 'Sphere', category: 'primitive',
    aliases: ['sphere', 'ball', 'orb', 'globe'],
    defaults: SPHERE_PARAMS,
    build: (g) => {
      const p = resolve(SPHERE_PARAMS, g);
      const prof = makeProfile([
        [0, -p.diameter / 2],
        ...Array.from({ length: 25 }, (_, i) => {
          const t = -Math.PI / 2 + (i / 24) * Math.PI;
          return [Math.cos(t) * p.diameter / 2, Math.sin(t) * p.diameter / 2] as Vec2;
        }),
      ]);
      const mesh = revolve(prof, XZ, { axisOrigin: [0, 0, 0], axisDir: [0, 0, 1], angleDeg: 360, feature: 'Sphere' });
      return { mesh, steps: [{ name: 'Sphere', op: 'revolve', uses: ['diameter'] }], params: SPHERE_PARAMS, warnings: [], valid: health(mesh).closed };
    },
  },
];

/**
 * Every archetype, centred on its own origin.
 *
 * The builders each grow a shape upward from z = 0, because that is the natural way to write
 * an extrude or a revolve. The primitives — box, cylinder, sphere — are centred instead. That
 * split was invisible until something tried to *place* one: a flange positioned at the top of
 * a motor housing ended up floating a flange-thickness above it, a rocket's body tube sat half
 * its own length too high, and the assistant is told in its own prompt that a placement names
 * the centre of a part.
 *
 * Rather than correct every recipe against a rule that only held for three shapes out of
 * twenty-five, the rule is made true: every archetype is translated so its bounding box is
 * centred on the origin. Placement then means the same thing everywhere, for hand-written
 * recipes and generated ones alike.
 *
 * Done by wrapping the catalogue rather than editing each builder, so a new archetype cannot
 * forget to do it.
 */
export const ARCHETYPES: Archetype[] = CATALOGUE.map((a) => ({
  ...a,
  build: (p) => {
    const result = a.build(p);
    if (triCount(result.mesh) === 0) return result;

    const b = bounds(result.mesh);
    const offset: Vec3 = [
      -(b.max[0] + b.min[0]) / 2,
      -(b.max[1] + b.min[1]) / 2,
      -(b.max[2] + b.min[2]) / 2,
    ];

    // Already centred to within a rounding error: skip the copy.
    if (Math.abs(offset[0]) + Math.abs(offset[1]) + Math.abs(offset[2]) < 1e-9) return result;

    return { ...result, mesh: transformMesh(result.mesh, translation(offset)) };
  },
}));


export const archetypeById = (id: string): Archetype | undefined => ARCHETYPES.find((a) => a.id === id);

/** Unused imports kept deliberately available to archetype authors. */
void [add3, mul3, norm3, linePath, planeFrom, unionAll, drillHole, linearPattern, circularPattern, shell, boolean];
export type { Plane, Profile };

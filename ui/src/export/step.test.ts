import { beforeAll, describe, expect, it } from 'vitest';
import { meshToStep } from './step';
import { meshToBrep } from './brep';
import { box, cone, cylinder, sphere, torus } from '../kernel/ops/build';
import { boolean } from '../kernel/ops/boolean';
import {
  emptyMesh, massProperties, transformMesh, triCount, type Mesh,
} from '../kernel/topo/mesh';
import { translation } from '../kernel/math/vec';
import { initManifold } from '../kernel/ops/manifold';
import { archetypeById } from '../generate/archetypes';

/**
 * STEP export.
 *
 * The temptation with an exporter is to test that it produces a file. That proves nothing — a
 * `.step` file with one `ADVANCED_FACE` per triangle also "works", imports without error, and
 * is useless: no face to select, no edge to dimension, no diameter to measure.
 *
 * So these check what the file is actually *made of*. A box is six faces. A hole is one
 * cylindrical surface with a real radius, not forty-five flat strips. And the solid the file
 * describes is verified by reading it back and integrating its faces — including the curved
 * ones — rather than by trusting the writer.
 */

beforeAll(async () => { await initManifold(); });

type P3 = [number, number, number];

const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: P3, b: P3): P3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Signed angle difference folded into (-pi, pi]. */
function wrap(d: number): number {
  const x = d % (2 * Math.PI);
  return x > Math.PI ? x - 2 * Math.PI : x <= -Math.PI ? x + 2 * Math.PI : x;
}

/**
 * Reads a STEP file produced here and computes the volume of the solid it describes.
 *
 * Deliberately independent of the writer's data structures: it starts from the text, so a
 * writer emitting a self-consistent but wrong file is still caught. The volume comes from the
 * divergence theorem, V = ⅓∮(r·n)dA, evaluated in closed form for each surface type.
 *
 * The arc handling is the part that matters. A planar face bounded by arcs is *not* the
 * polygon through its corners — a bore's cap has three corner points and is a circle. Each arc
 * contributes a circular segment, signed by its sweep, so a face bounded by three 120° arcs
 * integrates to exactly πR².
 */
function volumeFromStepText(text: string): number {
  const num3 = (s: string): P3 => {
    const [x, y, z] = s.split(',').map(Number);
    return [x, y, z];
  };

  const points = new Map<number, P3>();
  for (const m of text.matchAll(/#(\d+)=CARTESIAN_POINT\('',\(([^)]*)\)\)/g))
    points.set(Number(m[1]), num3(m[2]));

  const dirs = new Map<number, P3>();
  for (const m of text.matchAll(/#(\d+)=DIRECTION\('',\(([^)]*)\)\)/g))
    dirs.set(Number(m[1]), num3(m[2]));

  const vertexPoint = new Map<number, number>();
  for (const m of text.matchAll(/#(\d+)=VERTEX_POINT\('',#(\d+)\)/g))
    vertexPoint.set(Number(m[1]), Number(m[2]));

  const a2p = new Map<number, { origin: number; axis: number; ref: number }>();
  for (const m of text.matchAll(/#(\d+)=AXIS2_PLACEMENT_3D\('',#(\d+),#(\d+),#(\d+)\)/g))
    a2p.set(Number(m[1]), { origin: Number(m[2]), axis: Number(m[3]), ref: Number(m[4]) });

  const circles = new Map<number, { placement: number; radius: number }>();
  for (const m of text.matchAll(/#(\d+)=CIRCLE\('',#(\d+),([-\d.E+]+)\)/g))
    circles.set(Number(m[1]), { placement: Number(m[2]), radius: Number(m[3]) });

  const edgeCurve = new Map<number, { a: number; b: number; circle?: number }>();
  for (const m of text.matchAll(/#(\d+)=EDGE_CURVE\('',#(\d+),#(\d+),#(\d+),\.T\.\)/g)) {
    const geom = Number(m[4]);
    edgeCurve.set(Number(m[1]), {
      a: Number(m[2]), b: Number(m[3]), circle: circles.has(geom) ? geom : undefined,
    });
  }

  const oriented = new Map<number, { edge: number; fwd: boolean }>();
  for (const m of text.matchAll(/#(\d+)=ORIENTED_EDGE\('',\*,\*,#(\d+),\.([TF])\.\)/g))
    oriented.set(Number(m[1]), { edge: Number(m[2]), fwd: m[3] === 'T' });

  const edgeLoop = new Map<number, number[]>();
  for (const m of text.matchAll(/#(\d+)=EDGE_LOOP\('',\(([^)]*)\)\)/g))
    edgeLoop.set(Number(m[1]), m[2].split(',').map((s) => Number(s.trim().slice(1))));

  const bound = new Map<number, number>();
  for (const m of text.matchAll(/#(\d+)=FACE_(?:OUTER_)?BOUND\('',#(\d+),\.T\.\)/g))
    bound.set(Number(m[1]), Number(m[2]));

  const planes = new Map<number, number>();
  for (const m of text.matchAll(/#(\d+)=PLANE\('',#(\d+)\)/g))
    planes.set(Number(m[1]), Number(m[2]));

  const cylinders = new Map<number, { placement: number; radius: number }>();
  for (const m of text.matchAll(/#(\d+)=CYLINDRICAL_SURFACE\('',#(\d+),([-\d.E+]+)\)/g))
    cylinders.set(Number(m[1]), { placement: Number(m[2]), radius: Number(m[3]) });

  /** The ordered vertex ring of a loop, following each oriented edge's direction. */
  const ringOf = (loopId: number) =>
    edgeLoop.get(loopId)!.map((oId) => {
      const o = oriented.get(oId)!;
      const e = edgeCurve.get(o.edge)!;
      return { point: points.get(vertexPoint.get(o.fwd ? e.a : e.b)!)!, edge: e };
    });

  let volume = 0;

  for (const m of text.matchAll(/#(\d+)=ADVANCED_FACE\('',\(([^)]*)\),#(\d+),\.([TF])\.\)/g)) {
    const boundIds = m[2].split(',').map((s) => Number(s.trim().slice(1)));
    const surfaceId = Number(m[3]);
    const sameSense = m[4] === 'T';

    if (planes.has(surfaceId)) {
      const pl = a2p.get(planes.get(surfaceId)!)!;
      const n = dirs.get(pl.axis)!;
      const p0 = points.get(pl.origin)!;

      let area = 0;
      for (const boundId of boundIds) {
        const ring = ringOf(bound.get(boundId)!);

        // Polygon through the corners.
        let s: P3 = [0, 0, 0];
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i].point, q = ring[(i + 1) % ring.length].point;
          const c = cross(p, q);
          s = [s[0] + c[0], s[1] + c[1], s[2] + c[2]];
        }
        area += dot(s, n) / 2;

        // Plus a circular segment for every arc, signed by the way it is traversed.
        for (let i = 0; i < ring.length; i++) {
          const { edge } = ring[i];
          if (edge.circle === undefined) continue;

          const circle = circles.get(edge.circle)!;
          const cp = a2p.get(circle.placement)!;
          const centre = points.get(cp.origin)!;
          const u = dirs.get(cp.ref)!;
          const axis = dirs.get(cp.axis)!;
          const w = cross(axis, u);

          const from = ring[i].point;
          const to = ring[(i + 1) % ring.length].point;
          const ang = (p: P3) => Math.atan2(dot(sub(p, centre), w), dot(sub(p, centre), u));

          let sweep = wrap(ang(to) - ang(from));
          if (dot(axis, n) < 0) sweep = -sweep;

          area += (circle.radius ** 2 / 2) * (sweep - Math.sin(sweep));
        }
      }

      volume += dot(p0, n) * area / 3;
      continue;
    }

    if (cylinders.has(surfaceId)) {
      const cyl = cylinders.get(surfaceId)!;
      const cp = a2p.get(cyl.placement)!;
      const centre = points.get(cp.origin)!;
      const axis = dirs.get(cp.axis)!;
      const u = dirs.get(cp.ref)!;
      const w = cross(axis, u);
      const R = cyl.radius;

      // The patch's extent, read off the corners of its boundary.
      const ring = ringOf(bound.get(boundIds[0])!);
      const angles = ring.map((r) =>
        Math.atan2(dot(sub(r.point, centre), w), dot(sub(r.point, centre), u)));
      const heights = ring.map((r) => dot(sub(r.point, centre), axis));

      const zLo = Math.min(...heights), zHi = Math.max(...heights);
      let aLo = angles[0];
      for (const a of angles) if (wrap(a - aLo) < 0) aLo = a;
      let sweep = 0;
      for (const a of angles) sweep = Math.max(sweep, wrap(a - aLo));

      // ∮(r·n)dA over a cylindrical patch, with n the outward radial normal.
      const integral = R * (zHi - zLo) * (
        dot(centre, u) * (Math.sin(aLo + sweep) - Math.sin(aLo)) -
        dot(centre, w) * (Math.cos(aLo + sweep) - Math.cos(aLo)) +
        R * sweep
      );

      volume += (sameSense ? 1 : -1) * integral / 3;
    }
  }

  return Math.abs(volume);
}

const plateWithHole = (): Mesh =>
  boolean(box(100, 60, 20), cylinder(10, 60), 'difference').mesh;

describe('putting the triangles back together', () => {
  it('turns a box into six faces, not twelve', () => {
    const b = meshToBrep(box(100, 60, 20));

    expect(b.faces).toHaveLength(6);
    expect(b.vertices).toHaveLength(8);
    expect(b.edges).toHaveLength(12);
  });

  it('produces a topologically valid solid', () => {
    // Euler's formula. V − E + F = 2 for any solid of genus zero, and it fails loudly if the
    // merging dropped an edge or invented one.
    for (const mesh of [box(100, 60, 20), cylinder(20, 40), plateWithHole()]) {
      const b = meshToBrep(mesh);
      expect(b.vertices.length - b.edges.length + b.faces.length).toBe(2);
      expect(b.report.unclosedRegions).toBe(0);
      expect(b.report.nonConformalEdges).toBe(0);
    }
  });

  it('repairs T-junctions rather than exporting a shell that will not knit', () => {
    // A step — a narrow block on a wide one — puts the upper block's corner partway along the
    // lower block's top edge. That vertex belongs to one face and not the other, so the two
    // disagree about their shared boundary and the edge is used once instead of twice.
    const stepped = boolean(
      box(100, 60, 20),
      transformMesh(box(50, 60, 20), translation([25, 0, 20])),
      'union',
    ).mesh;

    const b = meshToBrep(stepped);

    expect(b.report.nonConformalEdges).toBe(0);
    expect(b.report.unclosedRegions).toBe(0);
  });

  it('does not fuse parallel faces that never touch', () => {
    const b = meshToBrep(box(100, 60, 20));
    const up = b.faces.filter((f) => f.surface.kind === 'plane' && f.surface.normal[2] > 0.99);
    const down = b.faces.filter((f) => f.surface.kind === 'plane' && f.surface.normal[2] < -0.99);

    expect(up).toHaveLength(1);
    expect(down).toHaveLength(1);
  });
});

describe('recognising cylinders', () => {
  it('recovers a shaft as cylindrical surfaces at its true radius', () => {
    const b = meshToBrep(cylinder(20, 40));
    const cyl = b.faces.filter((f) => f.surface.kind === 'cylinder');

    // Three faces make one revolution — see ARCS_PER_REVOLUTION for why not one or two.
    expect(cyl).toHaveLength(3);
    expect(b.faces).toHaveLength(5);            // three cylindrical, two caps

    for (const f of cyl) {
      if (f.surface.kind !== 'cylinder') throw new Error('unreachable');
      // Exact, not close. The vertices lie on the true cylinder, so the fit must return the
      // radius the modeller asked for — fitting facet centres instead reads the polygon's
      // apothem and every shaft comes out undersize.
      expect(f.surface.radius).toBeCloseTo(20, 9);
      expect(Math.abs(f.surface.axis[2])).toBeCloseTo(1, 9);
      expect(f.surface.outward).toBe(true);
    }
  });

  it('recovers a bore, and knows the material is on the outside', () => {
    const b = meshToBrep(plateWithHole());
    const cyl = b.faces.filter((f) => f.surface.kind === 'cylinder');

    expect(cyl).toHaveLength(3);
    for (const f of cyl) {
      if (f.surface.kind !== 'cylinder') throw new Error('unreachable');

      // Exact, not close — and it was not always. Fitting this bore rediscovered its radius
      // from the boolean's own intersection points and landed on 10.000000006, because those
      // points carry a few parts per billion of noise. The kernel now *declares* the surface
      // when it builds the cylinder and Manifold carries that tag through the cut, so the
      // radius that comes out is the radius that went in.
      expect(f.surface.radius).toBe(10);

      // The difference between a hole and a peg. Get it wrong and the solid inverts.
      expect(f.surface.outward).toBe(false);
    }
  });

  it('collapses the facets it replaces', () => {
    // The whole point: a bore that was forty-odd flat strips becomes three faces, and the
    // vertices that existed only to tessellate it are gone.
    const faceted = meshToBrep(plateWithHole(), { recogniseCylinders: false });
    const fitted = meshToBrep(plateWithHole());

    expect(fitted.faces.length).toBeLessThan(faceted.faces.length / 3);
    expect(fitted.vertices.length).toBeLessThan(faceted.vertices.length / 3);
    expect(fitted.report.cylindersFound).toBe(1);
  });

  it('leaves a box alone', () => {
    const b = meshToBrep(box(100, 60, 20));

    expect(b.report.cylindersFound).toBe(0);
    expect(b.faces.every((f) => f.surface.kind === 'plane')).toBe(true);
  });

  it('refuses a sphere', () => {
    // A sphere's normals point in every direction, so the "axis" is whichever way rounding
    // happened to fall. Accepting one would replace it with a cylinder of arbitrary
    // orientation — geometry nobody asked to change.
    const b = meshToBrep(sphere(25));

    expect(b.report.cylindersFound).toBe(0);
  });

  it('keeps the solid valid after replacing facets with surfaces', () => {
    for (const mesh of [cylinder(20, 40), plateWithHole()]) {
      const b = meshToBrep(mesh);
      expect(b.report.nonConformalEdges).toBe(0);
      expect(b.vertices.length - b.edges.length + b.faces.length).toBe(2);
    }
  });
});

describe('the file describes the right solid', () => {
  it('round-trips a planar solid exactly', () => {
    for (const make of [() => box(100, 60, 20), () => sphere(25)]) {
      const mesh = make();
      const { text } = meshToStep(mesh, { name: 'Part' });
      expect(volumeFromStepText(text)).toBeCloseTo(Math.abs(massProperties(mesh).volume), 6);
    }
  });

  it('round-trips a shaft at its analytic volume', () => {
    const { text } = meshToStep(cylinder(20, 40), { name: 'Shaft' });
    expect(volumeFromStepText(text)).toBeCloseTo(Math.PI * 400 * 40, 6);
  });

  it('is *more* accurate than the mesh once cylinders are recovered', () => {
    // The headline result. A tessellated bore removes too little material, because a polygon
    // inscribed in a circle is smaller than the circle. Exporting the analytic cylinder does
    // not approximate the mesh — it recovers the shape the mesh was approximating, so the
    // exported solid is closer to the truth than the model it came from.
    const mesh = plateWithHole();
    const exact = 100 * 60 * 20 - Math.PI * 10 * 10 * 20;

    const meshError = Math.abs(Math.abs(massProperties(mesh).volume) - exact) / exact;
    const stepError = Math.abs(volumeFromStepText(meshToStep(mesh, {}).text) - exact) / exact;

    expect(meshError).toBeGreaterThan(1e-4);
    expect(stepError).toBeLessThan(1e-9);
  });
});


describe('recognising cones', () => {
  it('recovers a frustum with its true half-angle and radii', () => {
    // r30 to r10 over 40 mm of height is a 26.565° taper — atan(20/40), exactly.
    const b = meshToBrep(cone(30, 10, 40));
    const cones = b.faces.filter((f) => f.surface.kind === 'cone');

    expect(cones).toHaveLength(3);
    expect(b.faces).toHaveLength(5);            // three conical, two flat ends

    for (const f of cones) {
      if (f.surface.kind !== 'cone') throw new Error('unreachable');
      // Exact, because the half-angle is refitted to the vertices rather than left as the
      // value the facet normals implied. Normals are chords' normals and are biased by the
      // tessellation; the vertices lie on the surface itself.
      expect(f.surface.halfAngle).toBeCloseTo(Math.atan(20 / 40), 9);
      expect(Math.abs(f.surface.axis[2])).toBeCloseTo(1, 9);
    }
  });

  it('recovers a tapered hole and knows the material is outside it', () => {
    const b = meshToBrep(boolean(box(60, 60, 20), cone(20, 5, 30), 'difference').mesh);
    const cones = b.faces.filter((f) => f.surface.kind === 'cone');

    expect(cones).toHaveLength(3);
    for (const f of cones) {
      if (f.surface.kind !== 'cone') throw new Error('unreachable');
      expect(f.surface.outward).toBe(false);
    }
  });

  it('recovers a boss whose two rims carry different vertex counts', () => {
    // One rim is the cone's own mesh; the other is cut by the boolean against the face it
    // stands on. Requiring the two to match — which a primitive cylinder always does — threw
    // away a correctly fitted cone for a difference that carries no meaning.
    const b = meshToBrep(boolean(box(60, 60, 10), cone(20, 8, 16, [0, 0, 10]), 'union').mesh);

    expect(b.report.conesFound).toBe(1);
    const f = b.faces.find((x) => x.surface.kind === 'cone')!;
    if (f.surface.kind !== 'cone') throw new Error('unreachable');

    // Exact. This is the case fitting could never get right: a boolean trims the cone where
    // it meets the box, and those cut points land on the triangles' *edges* — chords of the
    // cone, lying fractionally inside it. Every rim vertex on that seam is a hair
    // under-radius, which tilted the fitted taper by about a thousandth of a degree. A
    // declared surface has no such problem, because nothing is being rediscovered.
    expect(f.surface.halfAngle).toBeCloseTo(Math.atan(12 / 16), 12);
  });

  it('does not mistake a cylinder for a cone, or the reverse', () => {
    const cyl = meshToBrep(cylinder(20, 40));
    expect(cyl.report.cylindersFound).toBe(1);
    expect(cyl.report.conesFound).toBe(0);

    const frustum = meshToBrep(cone(30, 10, 40));
    expect(frustum.report.conesFound).toBe(1);
    expect(frustum.report.cylindersFound).toBe(0);
  });

  it('refuses a sphere and a torus', () => {
    // Both are smooth and neither is a surface of revolution this pass can represent. A
    // shallow patch of either is "nearly" conical, and accepting one would move geometry.
    expect(meshToBrep(sphere(25)).report.conesFound).toBe(0);
    expect(meshToBrep(torus(40, 12)).report.conesFound).toBe(0);
  });
});

describe('recognition never costs validity', () => {
  const shapes: [string, () => Mesh][] = [
    ['a shaft', () => cylinder(20, 40)],
    ['a frustum', () => cone(30, 10, 40)],
    ['a drilled plate', plateWithHole],
    ['a tapered hole', () => boolean(box(60, 60, 20), cone(20, 5, 30), 'difference').mesh],
    ['a conical boss', () => boolean(box(60, 60, 10), cone(20, 8, 16, [0, 0, 10]), 'union').mesh],
    ['a countersunk hole', () =>
      boolean(
        boolean(box(60, 60, 20), cylinder(5, 40), 'difference').mesh,
        cone(12, 5, 14, [0, 0, 3]), 'difference').mesh],
    ['a plate with four holes', () =>
      [1, 2, 3, 4].reduce(
        (m, i) => boolean(m, cylinder(4, 40, [i % 2 ? 20 : -20, i > 2 ? 15 : -15, 0]), 'difference').mesh,
        box(100, 60, 20))],
  ];

  for (const [label, make] of shapes) {
    it(`leaves ${label} conformal`, () => {
      // The guarantee that matters more than any face count: every edge walked by exactly two
      // faces. When recognising a surface would break that — as it does on the countersink,
      // where the bore and the cone disagree about the boundary between them — the whole pass
      // is discarded and the mesh is re-read as planes. A verbose solid that knits beats an
      // elegant one that arrives as loose surfaces.
      expect(meshToBrep(make()).report.nonConformalEdges).toBe(0);
    });
  }

  it('drops only the surface it cannot represent, and keeps the rest', () => {
    // A countersink's cone runs into the top face at the same radius as the bore, so its upper
    // rim is not a loop any single face owns. That cone cannot be expressed without the two
    // sides disagreeing about the boundary, so it is dropped — while the bore below it, whose
    // rims are ordinary, is still recovered. Losing one surface is the right price; losing the
    // whole solid's validity is not.
    const countersunk = boolean(
      boolean(box(60, 60, 20), cylinder(5, 40), 'difference').mesh,
      cone(12, 5, 14, [0, 0, 3]), 'difference').mesh;

    const b = meshToBrep(countersunk);

    expect(b.report.nonConformalEdges).toBe(0);
    expect(b.report.cylindersFound).toBe(1);
    expect(b.report.conesFound).toBe(0);
  });

  it('keeps both surfaces when two curved faces share a rim', () => {
    // A funnel's cone runs straight into its spout, so the rim between them belongs to no
    // planar face at all. Each surface cutting that rim into its own three arcs would describe
    // one circle two different ways; the second to arrive reuses the first's arcs instead.
    const a = archetypeById('funnel');
    if (!a) return;

    const params: Record<string, number> = {};
    for (const d of a.defaults) params[d.key] = d.value;
    const b = meshToBrep(a.build(params).mesh);

    expect(b.report.nonConformalEdges).toBe(0);
    expect(b.report.cylindersFound).toBeGreaterThan(0);
    expect(b.report.conesFound).toBeGreaterThan(0);
    expect(b.faces.length).toBeLessThan(30);
  });
});

describe('the file is well formed', () => {
  const make = () => meshToStep(plateWithHole(), {
    name: 'Plate', now: new Date('2026-08-13T00:00:00Z'),
  });

  it('references no entity it does not define', () => {
    const { text, report } = make();
    const defined = new Set<number>();
    for (const m of text.matchAll(/^#(\d+)=/gm)) defined.add(Number(m[1]));

    const dangling: number[] = [];
    for (const m of text.matchAll(/#(\d+)/g)) {
      if (!defined.has(Number(m[1]))) dangling.push(Number(m[1]));
    }

    expect(dangling).toEqual([]);
    expect(defined.size).toBe(report.entities);
  });

  it('shares every edge between exactly two faces', () => {
    // What makes a closed shell a solid: one ORIENTED_EDGE per face per edge, two faces per
    // edge. A writer giving each face its own copy lands on 1.00, and the importer refuses to
    // knit the result.
    const { text } = make();
    const curves = [...text.matchAll(/=EDGE_CURVE/g)].length;
    const oriented = [...text.matchAll(/=ORIENTED_EDGE/g)].length;

    expect(curves).toBeGreaterThan(0);
    expect(oriented).toBe(curves * 2);
  });

  it('writes the bore as a cylindrical surface with circular edges', () => {
    const { text } = make();

    expect(text).toContain('CYLINDRICAL_SURFACE');
    expect([...text.matchAll(/=CIRCLE\(/g)].length).toBeGreaterThan(0);

    // A bore's face normal opposes the surface's own outward normal.
    expect(text).toMatch(/ADVANCED_FACE\('',\([^)]*\),#\d+,\.F\.\)/);
  });

  it('writes every real with a decimal point', () => {
    const { text } = make();
    const offenders = [...text.matchAll(/(?:CARTESIAN_POINT|DIRECTION)\('',\(([^)]*)\)\)/g)]
      .flatMap((m) => m[1].split(','))
      .map((s) => s.trim())
      .filter((s) => !s.includes('.') && !s.includes('E'));

    expect(offenders).toEqual([]);
  });

  it('carries the header a CAD package reads', () => {
    const { text } = make();
    expect(text.startsWith('ISO-10303-21;\n')).toBe(true);
    expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
    expect(text).toContain("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'));");
    expect(text).toContain('SI_UNIT(.MILLI.,.METRE.)');
    expect(text).toContain('SHAPE_DEFINITION_REPRESENTATION');
    expect(text).toContain("MANIFOLD_SOLID_BREP('Plate'");
  });

  it('escapes a name that would otherwise break the syntax', () => {
    const odd = meshToStep(box(10, 10, 10), { name: "Bob's part" });
    expect(odd.text).toContain("MANIFOLD_SOLID_BREP('Bob''s part'");
  });
});

describe('nothing to export', () => {
  it('returns an empty shell rather than throwing', () => {
    const { text, report } = meshToStep(emptyMesh(), { name: 'Nothing' });

    expect(report.facesOut).toBe(0);
    expect(triCount(emptyMesh())).toBe(0);
    expect(text).toContain('ISO-10303-21;');
  });
});

describe('cones reach the file', () => {
  it('writes a CONICAL_SURFACE with its radius and half-angle', () => {
    const { text, report } = meshToStep(cone(30, 10, 40), { name: 'Frustum' });

    expect(report.conesFound).toBe(1);
    expect([...text.matchAll(/=CONICAL_SURFACE/g)]).toHaveLength(3);

    // STEP states a cone as a radius at a place on the axis plus the half-angle in radians.
    const written = /=CONICAL_SURFACE\('',#\d+,([-\d.E+]+),([-\d.E+]+)\)/.exec(text);
    expect(written).not.toBeNull();
    expect(Number(written![2])).toBeCloseTo(Math.atan(20 / 40), 6);

    // And the topology still holds: every edge shared by exactly two faces.
    const curves = [...text.matchAll(/=EDGE_CURVE/g)].length;
    expect([...text.matchAll(/=ORIENTED_EDGE/g)]).toHaveLength(curves * 2);
  });
});

/**
 * Surfaces declared at construction, not rediscovered at export.
 *
 * The kernel tags every face a primitive builds with the surface it came from, and Manifold
 * carries those tags through booleans untouched. Using them beats fitting on both counts that
 * matter: the answer is exact rather than noisy, and it survives trimming severe enough that
 * there is nothing left to fit.
 */
describe('carrying analytic surfaces through the kernel', () => {
  it('tags a primitive with the surface it was built from', () => {
    const kinds = (m: Mesh) => [...new Set([...m.tags.values()].map((t) => t.kind))].sort();

    expect(kinds(box(100, 60, 20))).toEqual(['planar']);
    expect(kinds(cylinder(20, 40))).toEqual(['cylindrical', 'planar']);
    expect(kinds(cone(30, 10, 40))).toEqual(['conical', 'planar']);
    // A sphere used to arrive as twenty-four cone bands, and a torus as thirty-four: the
    // revolve inferred a surface per profile segment, which is right for straight segments
    // and wrong for a curved profile. The primitive declares what it is instead.
    expect(kinds(sphere(25))).toEqual(['planar', 'spherical']);
    expect(kinds(torus(40, 12))).toEqual(['toroidal']);
  });

  it('records a cone by half-angle rather than a mean radius', () => {
    // The old inference stored `radius: 20` for a 30-to-10 frustum — a figure the surface
    // never takes anywhere along its length, and from which no cone can be reconstructed.
    const tags = [...cone(30, 10, 40).tags.values()].filter((t) => t.kind === 'conical');

    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) {
      expect(t.radius).toBe(30);                       // at the bottom rim, a real place
      expect(t.halfAngle).toBeCloseTo(Math.atan(20 / 40), 12);
    }
  });

  it('keeps the tag through a boolean', () => {
    // This is what makes declaring worth anything. A bore drilled through a plate still knows
    // it is a 10 mm cylinder, and a sphere cut into a block still knows its radius.
    const drilled = boolean(box(100, 60, 20), cylinder(10, 60), 'difference').mesh;
    const bore = [...drilled.tags.values()].find((t) => t.kind === 'cylindrical');
    expect(bore?.radius).toBe(10);

    const dimpled = boolean(box(60, 60, 60), sphere(25), 'difference').mesh;
    const dimple = [...dimpled.tags.values()].find((t) => t.kind === 'spherical');
    expect(dimple?.radius).toBe(25);
  });

  it('recovers an exact radius where fitting recovered a noisy one', () => {
    const b = meshToBrep(boolean(box(100, 60, 20), cylinder(10, 60), 'difference').mesh);
    const bore = b.faces.find((f) => f.surface.kind === 'cylinder')!;
    if (bore.surface.kind !== 'cylinder') throw new Error('unreachable');

    // Exactly 10, not 10.000000006. The difference is the boolean's own intersection points,
    // which is noise a fit has no way to see past.
    expect(bore.surface.radius).toBe(10);
  });

  it('still fits when nothing was declared', () => {
    // A mesh that arrived from somewhere else — a trace, an import, a repaired body — carries
    // no tags at all. Fitting has to stay, and stay correct.
    const shaft = cylinder(20, 40);
    const untagged: Mesh = { ...shaft, tags: new Map() };

    const b = meshToBrep(untagged);
    expect(b.report.cylindersFound).toBe(1);
    const f = b.faces.find((x) => x.surface.kind === 'cylinder')!;
    if (f.surface.kind !== 'cylinder') throw new Error('unreachable');
    expect(f.surface.radius).toBeCloseTo(20, 9);
  });

  it('refuses a tag the geometry does not actually match', () => {
    // Trust, but verify. A tag that survived an operation it should not have would otherwise
    // move geometry to a surface it is not on. The vertices are checked against the declared
    // surface before it is accepted.
    const shaft = cylinder(20, 40);
    const lying: Mesh = {
      ...shaft,
      tags: new Map([...shaft.tags].map(([id, t]) =>
        [id, t.kind === 'cylindrical' ? { ...t, radius: 60 } : t])),
    };

    const b = meshToBrep(lying);
    const f = b.faces.find((x) => x.surface.kind === 'cylinder');
    // Either it fell back to fitting and got 20, or it rejected the surface entirely. What it
    // must never do is report a 60 mm shaft.
    if (f && f.surface.kind === 'cylinder') expect(f.surface.radius).toBeCloseTo(20, 6);
  });
});

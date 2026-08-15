/**
 * STEP AP214 export.
 *
 * This is the format every CAD, CAM and inspection package agrees on, and until now it was
 * the thing standing between DATUM producing shapes and DATUM producing *parts*. STL carries
 * triangles and nothing else: no faces to select, no edges to dimension, no way back to an
 * editable solid. A shop cannot quote milling from one. Everything the app made stopped being
 * useful the moment it left the app.
 *
 * What is written here is a real boundary representation — `MANIFOLD_SOLID_BREP` over a
 * `CLOSED_SHELL` of `ADVANCED_FACE`s, with adjacent faces sharing `EDGE_CURVE` identity.
 * That sharing is the part that is easy to skip and impossible to fake: a shell whose faces
 * each carry their own copy of the edge between them is a pile of surfaces, and the importer
 * says so ("unable to knit"). The topology comes from `meshToBrep`, which puts the triangles
 * back together into faces first; see that file for why.
 *
 * Cylinders are recovered rather than faceted. A bore arrives as one `CYLINDRICAL_SURFACE`
 * with a real radius and circular edges, so the receiving package can measure its diameter,
 * counterbore it, and recognise it as a drilling operation — and the exported solid is
 * *closer to the truth than the mesh it came from*, because the analytic surface is the
 * surface the facets were sampling rather than an approximation of them.
 *
 * Honest limit, stated in the file's own header rather than buried here: only planes and
 * cylinders are recognised. Spheres, cones, tori and fillet blends still export as planar
 * facets — geometrically the same solid to within the tessellation, and correct to measure,
 * but not selectable as the single curved face they ought to be.
 */

import { cross3, dot3, len3, mul3, norm3, sub3, type Vec3 } from '../kernel/math/vec';
import { triCount, type Mesh } from '../kernel/topo/mesh';
import { meshToBrep, type Brep, type BrepOptions } from './brep';

export interface StepOptions extends BrepOptions {
  /** Part name, as it will appear in the receiving package's tree. */
  name?: string;
  /** Free-text description for the header. */
  description?: string;
  author?: string;
  organisation?: string;
  /** Overrides the timestamp, for reproducible output in tests. */
  now?: Date;
}

export interface StepResult {
  text: string;
  report: Brep['report'] & { entities: number };
}

/**
 * A STEP real.
 *
 * The format demands a decimal point on every real — `0` is an integer and a parser is
 * entitled to reject it where a real was expected, which is the kind of defect that shows up
 * as one package importing the file and another refusing it. Exponent form is normalised to
 * the `1.E-06` spelling the standard uses.
 */
function real(x: number): string {
  if (!Number.isFinite(x)) return '0.';

  // Collapse the negative zero that falls out of normal arithmetic, so the same face does not
  // export differently depending on which way a subtraction went.
  if (x === 0) return '0.';

  const s = Math.abs(x) < 1e-4 || Math.abs(x) >= 1e7
    ? x.toExponential(9).replace(/e([+-])(\d+)/, (_, sign: string, digits: string) =>
        `E${sign === '-' ? '-' : ''}${Number(digits)}`)
    : Number(x.toPrecision(12)).toString();

  return s.includes('.') || s.includes('E') ? (s.includes('.') ? s : s.replace('E', '.E')) : `${s}.`;
}

/** Escapes a string for a STEP literal. */
function str(s: string): string {
  return `'${s.replace(/'/g, "''").replace(/\\/g, '\\\\')}'`;
}

/** ISO 8601 without milliseconds, which is what STEP files carry. */
function stamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, '');
}

/**
 * A reference direction perpendicular to the axis.
 *
 * `AXIS2_PLACEMENT_3D` requires one, and it must genuinely be perpendicular — a near-parallel
 * pair leaves the placement degenerate and the face lands rotated or rejected. Crossing
 * against whichever world axis the normal is least aligned with keeps the two well separated
 * whatever direction the face happens to point.
 */
function refDirection(axis: Vec3): Vec3 {
  const ax = Math.abs(axis[0]), ay = Math.abs(axis[1]), az = Math.abs(axis[2]);
  const pick: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const r = cross3(axis, pick);
  const l = len3(r);
  // Cannot happen given the choice above, but a zero-length reference would produce a file
  // that imports as garbage rather than failing loudly, so it is worth the guard.
  return l > 1e-12 ? [r[0] / l, r[1] / l, r[2] / l] : [1, 0, 0];
}

export function meshToStep(mesh: Mesh, opts: StepOptions = {}): StepResult {
  const name = opts.name?.trim() || 'Part';
  const brep = meshToBrep(mesh, opts);

  const lines: string[] = [];
  let next = 1;
  const emit = (body: string): number => {
    const id = next++;
    lines.push(`#${id}=${body};`);
    return id;
  };

  // ── product structure ──
  const appContext = emit(`APPLICATION_CONTEXT(${str('automotive design')})`);
  emit(`APPLICATION_PROTOCOL_DEFINITION(${str('international standard')},${str('automotive_design')},2000,#${appContext})`);
  const productContext = emit(`PRODUCT_CONTEXT('',#${appContext},${str('mechanical')})`);
  const product = emit(`PRODUCT(${str(name)},${str(name)},'',(#${productContext}))`);
  const formation = emit(`PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${product},.NOT_KNOWN.)`);
  const defContext = emit(`PRODUCT_DEFINITION_CONTEXT(${str('part definition')},#${appContext},${str('design')})`);
  const definition = emit(`PRODUCT_DEFINITION(${str('design')},'',#${formation},#${defContext})`);
  const defShape = emit(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`);

  // ── units and accuracy ──
  //
  // The uncertainty is not decoration: it is what the importer uses to decide whether two
  // faces meet. Set it too tight and a legitimately welded shell is reported as having gaps.
  // It is tied to the weld tolerance actually used, so the file describes how it was built.
  const lengthUnit = emit('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const angleUnit = emit('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const solidUnit = emit('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < mesh.positions.length; i++) {
    if (mesh.positions[i] < lo) lo = mesh.positions[i];
    if (mesh.positions[i] > hi) hi = mesh.positions[i];
  }
  const scale = Number.isFinite(hi - lo) ? Math.max(1, hi - lo) : 1;
  const uncertainty = opts.weldTol ?? scale * 1e-7;

  const accuracy = emit(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(${real(uncertainty)}),#${lengthUnit},` +
    `${str('distance_accuracy_value')},${str('confusion accuracy')})`);
  const geomContext = emit(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)` +
    `GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${accuracy}))` +
    `GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnit},#${angleUnit},#${solidUnit}))` +
    `REPRESENTATION_CONTEXT('',''))`);

  // ── geometry ──
  const worldOrigin = emit(`CARTESIAN_POINT('',(0.,0.,0.))`);
  const zDir = emit(`DIRECTION('',(0.,0.,1.))`);
  const xDir = emit(`DIRECTION('',(1.,0.,0.))`);
  const placement = emit(`AXIS2_PLACEMENT_3D('',#${worldOrigin},#${zDir},#${xDir})`);

  // Points and vertices are written once and referenced everywhere, which is both smaller and
  // the thing that makes the topology genuinely shared rather than merely coincident.
  const pointId = brep.vertices.map((v) =>
    emit(`CARTESIAN_POINT('',(${real(v[0])},${real(v[1])},${real(v[2])}))`));
  const vertexId = brep.vertices.map((_, i) => emit(`VERTEX_POINT('',#${pointId[i]})`));

  const point = (p: Vec3) =>
    emit(`CARTESIAN_POINT('',(${real(p[0])},${real(p[1])},${real(p[2])}))`);
  const direction = (d: Vec3) =>
    emit(`DIRECTION('',(${real(d[0])},${real(d[1])},${real(d[2])}))`);

  /** An AXIS2_PLACEMENT_3D at `origin`, with `axis` as its Z and `ref` as its X. */
  const placementAt = (origin: Vec3, axis: Vec3, ref: Vec3) =>
    emit(`AXIS2_PLACEMENT_3D('',#${point(origin)},#${direction(axis)},#${direction(ref)})`);

  // One EDGE_CURVE per undirected edge, shared by both faces that meet along it.
  const edgeId = brep.edges.map((e) => {
    const a = brep.vertices[e.a];
    const b = brep.vertices[e.b];

    let geometry: number;
    if (e.curve.kind === 'circle') {
      // The reference direction points at the edge's start vertex, so the circle's parameter
      // is zero there and increases anticlockwise about the axis. A reader trims between the
      // two vertices along that parametrisation.
      //
      // Which means the axis has to be chosen, not copied. Anticlockwise from `a` to `b`
      // about the recovered axis is sometimes the major arc — and then the file says "go the
      // long way", the receiving package believes it, and the face comes back inside out or
      // with no area at all. Every arc this exporter writes is a third of a circle or less,
      // because circles are split before they are written, so flipping the axis whenever the
      // sweep exceeds half a turn always names the arc that was meant. Found by importing our
      // own output: the end caps of a cylinder came back with no area.
      const c = e.curve;
      const ref = norm3(sub3(a, c.centre));
      const toB = norm3(sub3(b, c.centre));
      const sweep = Math.atan2(dot3(cross3(ref, toB), c.axis), dot3(ref, toB));
      const axis = sweep < 0 ? mul3(c.axis, -1) : c.axis;

      geometry = emit(`CIRCLE('',#${placementAt(c.centre, axis, ref)},${real(c.radius)})`);
    } else {
      const d = norm3(sub3(b, a));
      const vec = emit(`VECTOR('',#${direction(d)},${real(len3(sub3(b, a)))})`);
      geometry = emit(`LINE('',#${pointId[e.a]},#${vec})`);
    }

    return emit(`EDGE_CURVE('',#${vertexId[e.a]},#${vertexId[e.b]},#${geometry},.T.)`);
  });

  const faceIds: number[] = [];
  for (const face of brep.faces) {
    const s = face.surface;

    // The surface, and whether the face agrees with its natural normal.
    //
    // A plane is written with its normal as the placement axis, so the face always agrees.
    // A cylinder's natural normal points radially outward from the axis, which is right for a
    // shaft and backwards for a bore — so a bore is the same surface with same_sense false,
    // not a different surface. Getting this wrong inverts the solid.
    let surfaceId: number;
    let sameSense: boolean;

    if (s.kind === 'plane') {
      surfaceId = emit(`PLANE('',#${placementAt(s.origin, s.normal, refDirection(s.normal))})`);
      sameSense = true;
    } else if (s.kind === 'cylinder') {
      surfaceId = emit(
        `CYLINDRICAL_SURFACE('',#${placementAt(s.origin, s.axis, refDirection(s.axis))},` +
        `${real(s.radius)})`);
      sameSense = s.outward;
    } else {
      // A cone is stated as a radius at a place on the axis plus a half-angle, with the radius
      // growing along the placement's +Z. The axis already points that way, so the reference
      // rim's own radius can be used as it stands.
      surfaceId = emit(
        `CONICAL_SURFACE('',#${placementAt(s.origin, s.axis, refDirection(s.axis))},` +
        `${real(s.radius)},${real(s.halfAngle)})`);
      sameSense = s.outward;
    }

    const boundOf = (loop: { edges: number[] }, outer: boolean): number => {
      const oriented = loop.edges.map((signed) => {
        const id = edgeId[Math.abs(signed) - 1];
        // The sign records whether this loop traverses the shared edge forwards or
        // backwards. Both faces reference the same EDGE_CURVE; only the flag differs.
        return emit(`ORIENTED_EDGE('',*,*,#${id},${signed > 0 ? '.T.' : '.F.'})`);
      });
      const edgeLoop = emit(`EDGE_LOOP('',(${oriented.map((o) => `#${o}`).join(',')}))`);
      return emit(`${outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${edgeLoop},.T.)`);
    };

    const bounds = [boundOf(face.outer, true), ...face.inner.map((l) => boundOf(l, false))];
    faceIds.push(emit(
      `ADVANCED_FACE('',(${bounds.map((b) => `#${b}`).join(',')}),#${surfaceId},` +
      `${sameSense ? '.T.' : '.F.'})`));
  }

  const shell = emit(`CLOSED_SHELL('',(${faceIds.map((f) => `#${f}`).join(',')}))`);
  const solid = emit(`MANIFOLD_SOLID_BREP(${str(name)},#${shell})`);
  const shapeRep = emit(
    `ADVANCED_BREP_SHAPE_REPRESENTATION(${str(name)},(#${placement},#${solid}),#${geomContext})`);
  emit(`SHAPE_DEFINITION_REPRESENTATION(#${defShape},#${shapeRep})`);

  const when = stamp(opts.now ?? new Date());
  const note =
    opts.description?.trim() ||
    `B-rep recovered from a tessellated solid: ${brep.report.facesOut} faces from ` +
    `${brep.report.trianglesIn} triangles, ${brep.report.cylindersFound} cylindrical. ` +
    `Other curved surfaces remain faceted.`;

  const header = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION((${str(note)}),'2;1');`,
    `FILE_NAME(${str(`${name}.step`)},${str(when)},(${str(opts.author?.trim() || 'DATUM')}),` +
      `(${str(opts.organisation?.trim() || '')}),${str('DATUM STEP writer')},` +
      `${str('DATUM')},'');`,
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'));`,
    'ENDSEC;',
    'DATA;',
  ];

  const text = [...header, ...lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');

  return {
    text,
    report: { ...brep.report, entities: next - 1 },
  };
}

/** True when there is geometry worth writing. */
export function canExportStep(mesh: Mesh): boolean {
  return triCount(mesh) > 0;
}

/** Kept next to the writer so the two cannot drift apart. */
export function stepFileName(partName: string): string {
  const base = partName.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ') || 'Part';
  return `${base}.step`;
}

/** Re-exported so callers can reason about the topology without importing two modules. */
export { meshToBrep };

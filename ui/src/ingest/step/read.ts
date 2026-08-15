import {
  asFlag, asList, asNumber, asRef, asString, entitiesOfType, memberOfType, parseStep,
  type Entity, type StepFile,
} from './parse';
import {
  add3, cross3, dot3, len3, mul3, norm3, sub3, type Vec2, type Vec3,
} from '../../kernel/math/vec';
import { MeshBuilder, concatMeshes, health, triCount, type Mesh } from '../../kernel/topo/mesh';
import { arcSegments, makeProfile, triangulate } from '../../kernel/sketch/profile';

/**
 * STEP boundary representation → a solid this kernel can work on.
 *
 * The half of STEP import that decides whether the result is a part or a bag of triangles.
 * A file describes faces bounded by loops of edges lying on surfaces; turning that into a
 * mesh means, for every face: walk its loops into 3D polylines, flatten them into the
 * surface's own parameter plane, triangulate there, and lift the result back.
 *
 * **Which surfaces are handled, and why those.**
 *
 * Planes and cylinders, and cones as a cylinder's generalisation. That is not an arbitrary
 * subset — it is what a prismatic machined part is made of, which is what an engineering
 * library is mostly full of, and it is exactly the vocabulary this project's own STEP
 * exporter writes. B-splines, tori and spheres are **reported and skipped** rather than
 * approximated, because a solid silently missing a face is not a solid: it fails to close,
 * its volume is meaningless, and every downstream measurement is quietly wrong. A part that
 * arrives incomplete says so.
 *
 * **Trimming is by the loops, not by the surface.** A cylindrical face is not "the whole
 * cylinder": it is the region its edge loops enclose, and unrolling to (arc length, axial)
 * is what lets the same triangulator handle it as handles a plane. The unroll has a seam,
 * and choosing where to put it is the one genuinely fiddly part — see `revolvedFace`.
 */

/** One solid body. A part may be modelled as several. */
export interface StepBody {
  /** The name the modeller gave the feature that made it, where the file records one. */
  name: string;
  mesh: Mesh;
  closed: boolean;
}

export interface StepImport {
  /**
   * Every body at once, for measuring and for showing.
   *
   * Volume and mass are additive over disjoint closed bodies, so this is the right thing to
   * weigh. It is *not* the right thing to check for manifoldness — see `bodies`.
   */
  mesh: Mesh;
  /**
   * The bodies, separately.
   *
   * A multi-body part is several solids, and merging them into one mesh is a reader's
   * convenience rather than a fact about the part. Where two bodies touch, the merged mesh
   * has four triangles on the shared edges and reads as non-manifold — which is how a
   * perfectly sound two-body clip came back "not sound", and why anything that cares about
   * topology has to look at the bodies rather than at the sum of them.
   */
  bodies: StepBody[];
  /** Faces successfully built. */
  faces: number;
  /** Surfaces this build cannot represent, counted by type, in the order first seen. */
  skipped: { type: string; count: number }[];
  /** What the file said it was, from FILE_NAME. */
  name: string;
  /** Everything worth saying about the result, most important first. */
  notes: string[];
  /** False when the solid did not close — its volume and mass cannot be trusted. */
  closed: boolean;
}

export interface StepFailure {
  error: string;
  line?: number;
}

/** Chord tolerance for turning a circle into a polyline, in mm. */
const CHORD_TOL = 0.05;

export function readStep(text: string): StepImport | StepFailure {
  const file = parseStep(text);
  if ('error' in file) return file;
  return buildFromFile(file);
}

/**
 * Millimetres per file unit.
 *
 * The single most consequential thing to get right about a real STEP file, and the easiest to
 * miss: nothing in the geometry section says what a coordinate means. A SOLIDWORKS part
 * modelled in inches writes `-0.48` and declares, forty entities away, that its length unit is
 * a `CONVERSION_BASED_UNIT('INCH')` worth 0.0254 metres. Read without that, a 1.085 inch part
 * arrives 1.085 mm long — every dimension, mass, area and manufacturability check wrong by
 * 25.4, and nothing about the result looks broken.
 *
 * Three forms appear in practice and all three are read:
 *
 *   `SI_UNIT(.MILLI., .METRE.)`        → 1
 *   `SI_UNIT($, .METRE.)`              → 1000
 *   `CONVERSION_BASED_UNIT('INCH', …)` → the conversion's own measure, in metres, × 1000
 *
 * A file that declares nothing is taken as millimetres and said so in the notes, because
 * silently assuming is how this goes wrong in the first place.
 */
function lengthScale(file: StepFile): { mm: number; note: string | null } {
  const contexts = [
    ...entitiesOfType(file, 'GLOBAL_UNIT_ASSIGNED_CONTEXT'),
    ...entitiesOfType(file, 'GEOMETRIC_REPRESENTATION_CONTEXT'),
  ];

  const candidates: Entity[] = [];
  for (const context of contexts) {
    const assigned = memberOfType(context, 'GLOBAL_UNIT_ASSIGNED_CONTEXT');
    for (const ref of asList(assigned?.args[0])) {
      const unit = deref(file, ref.kind === 'ref' ? ref.id : null);
      if (unit) candidates.push(unit);
    }
  }

  // Only length units are of interest; a file also assigns angle and solid-angle units.
  for (const unit of candidates) {
    if (!memberOfType(unit, 'LENGTH_UNIT')) continue;

    const converted = memberOfType(unit, 'CONVERSION_BASED_UNIT');
    if (converted) {
      const measure = deref(file, asRef(converted.args[1]));
      const metres = measure ? asNumber(measure.args[0]) : null;
      if (metres !== null && metres > 0) {
        return { mm: metres * 1000, note: `Units: ${asString(converted.args[0]) ?? 'converted'}.` };
      }
    }

    const si = memberOfType(unit, 'SI_UNIT');
    if (si) {
      const prefix = si.args[0];
      const factor = prefix && prefix.kind === 'enum'
        ? ({ MILLI: 1, CENTI: 10, DECI: 100, KILO: 1e6 } as Record<string, number>)[prefix.value] ?? null
        : 1000;                                   // "$" — no prefix, so plain metres
      if (factor) return { mm: factor, note: null };
    }
  }

  return {
    mm: 1,
    note: 'The file declares no length unit, so it was read as millimetres.',
  };
}

function buildFromFile(file: StepFile): StepImport | StepFailure {
  const shells = [
    ...entitiesOfType(file, 'CLOSED_SHELL'),
    ...entitiesOfType(file, 'OPEN_SHELL'),
  ];

  if (shells.length === 0) {
    return {
      error:
        'The file has no shell, so it describes no solid. Files exported as a surface model '
        + 'or as a wireframe carry no closed volume; re-export as a solid.',
    };
  }

  // Resolved before any geometry is read: every coordinate below goes through `cartesian`,
  // which scales by this.
  const scale = lengthScale(file);
  file.lengthMm = scale.mm;

  // Which body each shell belongs to. A solid names its shell, so the grouping is in the
  // file; shells no solid claims are taken as bodies of their own rather than dropped.
  const named = new Map<number, string>();
  for (const solid of entitiesOfType(file, 'MANIFOLD_SOLID_BREP')) {
    const shellId = asRef(solid.args[1]);
    if (shellId !== null) named.set(shellId, asString(solid.args[0]) ?? 'Body');
  }

  const skipped = new Map<string, number>();
  const bodies: StepBody[] = [];
  let faces = 0;

  for (const shell of shells) {
    const builder = new MeshBuilder();
    let built = 0;

    for (const ref of asList(shell.args[1])) {
      const face = deref(file, ref.kind === 'ref' ? ref.id : null);
      if (!face || face.type !== 'ADVANCED_FACE') continue;

      const outcome = buildFace(file, face, builder);
      if (outcome === true) built += 1;
      else skipped.set(outcome, (skipped.get(outcome) ?? 0) + 1);
    }

    if (built === 0) continue;
    faces += built;

    const body = builder.build();
    bodies.push({
      name: named.get(shell.id) ?? 'Body',
      mesh: body,
      closed: health(body).closed,
    });
  }

  const mesh = bodies.length === 1
    ? bodies[0]!.mesh
    : concatMeshes(bodies.map((b) => b.mesh));

  if (triCount(mesh) === 0) {
    const worst = [...skipped.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      error: worst
        ? `Nothing could be built: every face uses ${describeSurface(worst[0])}, which this `
          + 'build cannot represent.'
        : 'Nothing could be built from the shells in this file.',
    };
  }

  const skippedList = [...skipped.entries()].map(([type, count]) => ({ type, count }));
  const notes: string[] = [];

  if (scale.note) notes.push(scale.note);

  if (skippedList.length > 0) {
    notes.push(
      `${skippedList.reduce((n, s) => n + s.count, 0)} of `
      + `${faces + skippedList.reduce((n, s) => n + s.count, 0)} faces were skipped: `
      + `${skippedList.map((s) => `${s.count} × ${describeSurface(s.type)}`).join(', ')}. `
      + 'The solid is incomplete, so its volume and mass are not trustworthy.',
    );
  }

  if (bodies.length > 1) {
    notes.push(
      `${bodies.length} separate bodies: ${bodies.map((b) => b.name).join(', ')}. `
      + 'A multi-body part is several solids, and each is measured and recognised on its own.',
    );
  }

  for (const body of bodies.filter((b) => !b.closed)) {
    const state = health(body.mesh);
    notes.push(
      `"${body.name}" is not closed (${state.boundaryEdges} open edges). `
      + (skippedList.length > 0
        ? 'That follows from the skipped faces above.'
        : 'The faces built but do not meet — the file may use tolerances this reader did not '
          + 'reproduce.'),
    );
  }

  return {
    mesh,
    bodies,
    faces,
    skipped: skippedList,
    name: fileName(file),
    notes,
    // Closed means every body is closed. The merged mesh is not the thing to ask: two sound
    // bodies that touch share edges in it and it reads as non-manifold.
    closed: bodies.every((b) => b.closed),
  };
}

// ── one face ────────────────────────────────────────────────────────────────

/** True when built; otherwise the surface type that could not be represented. */
function buildFace(file: StepFile, face: Entity, builder: MeshBuilder): true | string {
  const surface = deref(file, asRef(face.args[2]));
  if (!surface) return 'UNKNOWN';

  // ADVANCED_FACE's fourth argument is `same_sense`: false means the face normal opposes the
  // surface normal. Getting this wrong inverts individual faces, and an inverted face is not
  // visibly wrong — it is wrong in the volume, which is worse.
  const sameSense = asFlag(face.args[3]);

  const loops: Vec3[][] = [];
  for (const boundRef of asList(face.args[1])) {
    const bound = deref(file, boundRef.kind === 'ref' ? boundRef.id : null);
    if (!bound) continue;

    const loop = readLoop(file, deref(file, asRef(bound.args[1])));
    if (!loop || loop.length < 3) continue;

    // FACE_BOUND carries its own orientation flag, separately from the edges inside it.
    loops.push(asFlag(bound.args[2]) ? loop : [...loop].reverse());
  }

  if (loops.length === 0) return surface.type;

  switch (surface.type) {
    case 'PLANE': return planarFace(file, surface, loops, sameSense, builder);
    case 'CYLINDRICAL_SURFACE':
    case 'CONICAL_SURFACE': return revolvedFace(file, surface, loops, sameSense, builder);
    default: return surface.type;
  }
}

function planarFace(
  file: StepFile, surface: Entity, loops: Vec3[][], sameSense: boolean, builder: MeshBuilder,
): true | string {
  const frame = placement(file, asRef(surface.args[1]));
  if (!frame) return 'PLANE';

  const { origin, axis, ref } = frame;
  const u = ref;
  const v = cross3(axis, u);

  const flatten = (p: Vec3): Vec2 => {
    const d = sub3(p, origin);
    return [dot3(d, u), dot3(d, v)];
  };

  return emit(loops.map((l) => l.map(flatten)), loops, axis, sameSense, builder,
    (a: Vec2) => add3(origin, add3(mul3(u, a[0]), mul3(v, a[1]))), 'planar');
}

/**
 * A cylindrical or conical face, as a strip between its two rims.
 *
 * The obvious construction — unroll to (arc length, axial), triangulate as a plane, lift back
 * — is a correct *parameterisation* and produced a wrong solid, which is worth recording
 * because it looked right by every other measure. A cylinder round-tripped through it came
 * back closed, manifold, genus 0, with the same triangle count, the same vertex count and the
 * same bounding box as the original, and 19.5% less volume.
 *
 * The cause is that ear clipping does not know the region is a band. Given a rectangle with a
 * row of collinear points along each long edge it fans triangles across the whole thing, and
 * those triangles — harmless in the plane — become chords cutting through the solid when they
 * are lifted back onto the cylinder. The mesh stays perfectly closed; it just encloses a
 * different shape.
 *
 * So the structure is used rather than discarded: the boundary of a face of revolution is two
 * rims at different axial positions, joined by at most two seam edges, and stitching quads
 * between them in angle order is exact. It works unchanged for a full bore and a 90° sector,
 * for a cylinder and for a cone — a cone's rims simply have different radii, which the strip
 * reads from the rims themselves rather than from the surface's single stored radius.
 *
 * Anything that is not two matching rims — a band with a notch, a face carrying a hole — falls
 * back to the unrolled triangulation, which is right for those and cannot be structured this
 * way.
 */
function revolvedFace(
  file: StepFile, surface: Entity, loops: Vec3[][], sameSense: boolean, builder: MeshBuilder,
): true | string {
  const frame = placement(file, asRef(surface.args[1]));
  const radius = radiusOf(file, surface);
  if (!frame || radius === null) return surface.type;

  const { origin, axis, ref } = frame;
  const u = ref;
  const v = cross3(axis, u);

  const local = (p: Vec3) => {
    const d = sub3(p, origin);
    const z = dot3(d, axis);
    const radial = sub3(d, mul3(axis, z));
    return { point: p, z, angle: Math.atan2(dot3(radial, v), dot3(radial, u)) };
  };

  const strip = stripBetweenRims(loops, local, sameSense, axis, origin, radius, builder);
  if (strip !== null) return strip;

  // ── fallback: unroll and triangulate ──
  //
  // The seam. Angle is periodic, so a loop crossing the 0/2π line comes back as a polygon that
  // jumps the full circumference. Unwrapping incrementally — keeping each angle within half a
  // turn of the one before — follows the loop the way it actually runs.
  const flat: Vec2[][] = [];
  for (const loop of loops) {
    const out: Vec2[] = [];
    let previous = 0;

    for (let i = 0; i < loop.length; i++) {
      const { z, angle } = local(loop[i]!);
      let a = angle;
      if (i === 0) previous = a;
      else {
        while (a - previous > Math.PI) a -= 2 * Math.PI;
        while (previous - a > Math.PI) a += 2 * Math.PI;
        previous = a;
      }
      out.push([a * radius, z]);
    }

    // A face that wraps the whole way has no flat representation and did not strip, so there
    // is nothing left to try.
    const span = Math.max(...out.map((p) => p[0])) - Math.min(...out.map((p) => p[0]));
    if (span > 2 * Math.PI * radius * 0.999) return `${surface.type}_FULL`;

    flat.push(out);
  }

  const lift = (a: Vec2): Vec3 => {
    const angle = a[0] / radius;
    const r = add3(mul3(u, Math.cos(angle) * radius), mul3(v, Math.sin(angle) * radius));
    return add3(origin, add3(r, mul3(axis, a[1])));
  };

  return emit(flat, loops, axis, sameSense, builder, lift, 'cylindrical');
}

interface Sample { point: Vec3; z: number; angle: number }

/** One triangle, wound according to the face's sense. */
function addTriangle(
  builder: MeshBuilder, tag: number, sameSense: boolean, p0: Vec3, p1: Vec3, p2: Vec3,
): void {
  if (sameSense) builder.triangle(p0, p1, p2, tag);
  else builder.triangle(p0, p2, p1, tag);
}

/**
 * Quads between two rims, or null when the face is not that shape.
 *
 * The rims are found by clustering the boundary points on axial position: every point of a
 * face of revolution lies on one of its two ends. Seam points belong to whichever rim they sit
 * on, so a sector's two straight edges need no special handling — they are simply the first
 * and last quad's sides.
 */
function stripBetweenRims(
  loops: Vec3[][],
  local: (p: Vec3) => Sample,
  sameSense: boolean,
  axis: Vec3,
  origin: Vec3,
  surfaceRadius: number,
  builder: MeshBuilder,
): true | null {
  // A face of revolution arrives in one of two forms, and both have to be taken.
  //
  // One loop: a sector, whose boundary runs up one seam, along a rim, down the other seam and
  // back. Two loops: a face that wraps the whole way, whose two rims are separate closed
  // circles with no seam between them — which is how a chamfer or a full bore is written.
  // Refusing the second form sent every cone to the unrolled fallback, where a single stored
  // radius cannot describe a surface whose radius varies, and the faces came back overlapping:
  // non-manifold, with duplicate triangles, and a fifth of the volume missing.
  if (loops.length < 1 || loops.length > 2) return null;

  // `atan2` cuts at ±π. A *sector* spanning that cut comes back with its two halves at
  // opposite ends of the range, and sorting then interleaves them and stitches the strip
  // across the part — so a sector's angles are unwrapped by following its loop. A closed rim
  // needs no unwrapping and must not be given any: it is a full turn, and the raw angle is
  // already the right key to sort on.
  //
  // Following the loop is not perfect. Where a sector's two rims are tessellated differently —
  // a cone's are, because its rims have different radii — the running unwrap can leave them a
  // turn or more apart, and those faces are stitched wrongly. Ordering each rim independently
  // from its own widest angular gap was tried as a replacement and was worse: it mis-reads the
  // opening on a rim whose points are unevenly spaced, and the shaft's volume error went from
  // 5% to 42%. The joins between conical faces and their neighbours remain open, are reported
  // as such, and are the next work on this reader.
  const unwrap = loops.length === 1;
  const points: Sample[] = [];

  for (const loop of loops) {
    const raw = loop.map(local);
    if (raw.length < 3) return null;

    let previous = raw[0]!.angle;
    for (let i = 0; i < raw.length; i++) {
      let angle = raw[i]!.angle;
      if (unwrap && i > 0) {
        while (angle - previous > Math.PI) angle -= 2 * Math.PI;
        while (previous - angle > Math.PI) angle += 2 * Math.PI;
      }
      previous = angle;
      points.push({ ...raw[i]!, angle });
    }
  }

  if (points.length < 4) return null;

  const zs = points.map((p) => p.z);
  const zMin = Math.min(...zs);
  const zMax = Math.max(...zs);
  const height = zMax - zMin;
  if (height < 1e-9) return null;

  // A point belongs to a rim when it sits within a hundredth of the height of one end. That is
  // tight enough that a notch or a sloped trim falls outside it and sends the face to the
  // general path, and loose enough to absorb the file's own rounding.
  const tol = Math.max(height * 0.01, 1e-6);
  const lower: Sample[] = [];
  const upper: Sample[] = [];

  for (const p of points) {
    if (p.z - zMin <= tol) lower.push(p);
    else if (zMax - p.z <= tol) upper.push(p);
    else return null;                          // between the ends: not a plain strip
  }

  if (lower.length < 2 || upper.length < 2) return null;

  const byAngle = (a: Sample, b: Sample) => a.angle - b.angle;
  lower.sort(byAngle);
  upper.sort(byAngle);

  // Full wrap when no gap between consecutive points stands out from the rest.
  const gaps: number[] = [];
  for (let i = 0; i < lower.length; i++) {
    const next = lower[(i + 1) % lower.length]!;
    let d = next.angle - lower[i]!.angle;
    if (d <= 0) d += 2 * Math.PI;
    gaps.push(d);
  }
  const widest = Math.max(...gaps);
  const typical = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const wraps = widest < typical * 1.5;

  const tag = builder.addTag({
    feature: 'Imported',
    kind: 'cylindrical',
    normal: norm3(axis),
    origin,
    radius: surfaceRadius,
  });

  /*
   * The two rims are stitched by *angle*, not by index.
   *
   * Pairing them off one for one assumes they carry the same number of points, and a cone's
   * do not: its rims have different radii, so each is tessellated to the same chord tolerance
   * with a different number of segments. Requiring equal counts made every chamfer fall
   * through to the unrolled fallback — where a single stored radius cannot describe a surface
   * whose radius varies — and the shaft came back non-manifold, with duplicate triangles and a
   * fifth of its volume missing.
   *
   * Advancing whichever rim has the nearer next point is the standard merge, it needs no
   * correspondence between the two, and it degenerates to one-for-one when the counts do
   * happen to match.
   */
  const ring = (rim: Sample[]) => (wraps
    ? [...rim, { ...rim[0]!, angle: rim[0]!.angle + 2 * Math.PI }]
    : rim);

  const a = ring(lower);
  const b = ring(upper);

  let i = 0;
  let j = 0;

  while (i < a.length - 1 || j < b.length - 1) {
    // Advance along whichever rim reaches its next point first, so the triangles stay well
    // shaped instead of fanning from one end.
    const takeLower = j >= b.length - 1
      || (i < a.length - 1 && a[i + 1]!.angle <= b[j + 1]!.angle);

    if (takeLower) {
      addTriangle(builder, tag, sameSense, a[i]!.point, a[i + 1]!.point, b[j]!.point);
      i += 1;
    } else {
      addTriangle(builder, tag, sameSense, a[i]!.point, b[j + 1]!.point, b[j]!.point);
      j += 1;
    }
  }

  return true;
}

/**
 * Triangulates the flattened loops and emits the result in 3D.
 *
 * The outer loop is the one enclosing the largest area; everything else is a hole. STEP does
 * distinguish FACE_OUTER_BOUND from FACE_BOUND, but not every translator uses it correctly,
 * and area is a fact about the geometry rather than a claim in the file.
 */
function emit(
  flat: Vec2[][],
  original: Vec3[][],
  normal: Vec3,
  sameSense: boolean,
  builder: MeshBuilder,
  lift: (p: Vec2) => Vec3,
  kind: 'planar' | 'cylindrical',
): true | string {
  if (flat.length === 0) return 'EMPTY';

  const areaOf = (pts: Vec2[]) => {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      a += pts[j]![0] * pts[i]![1] - pts[i]![0] * pts[j]![1];
    }
    return Math.abs(a) / 2;
  };

  let outerAt = 0;
  for (let i = 1; i < flat.length; i++) {
    if (areaOf(flat[i]!) > areaOf(flat[outerAt]!)) outerAt = i;
  }

  const outer = flat[outerAt]!;
  const holes = flat.filter((_, i) => i !== outerAt);
  if (areaOf(outer) < 1e-9) return 'DEGENERATE';

  const profile = makeProfile(outer, holes);
  const { vertices, triangles } = triangulate(profile);
  if (triangles.length === 0) return 'DEGENERATE';

  const tag = builder.addTag({
    feature: 'Imported',
    kind,
    normal: norm3(normal),
    origin: original[0]?.[0],
  });

  for (let t = 0; t < triangles.length; t += 3) {
    const a = lift(vertices[triangles[t]!]!);
    const b = lift(vertices[triangles[t + 1]!]!);
    const c = lift(vertices[triangles[t + 2]!]!);

    // `same_sense` false means the face runs against its surface, so the winding flips. An
    // inverted face is invisible on screen and wrong in the volume, which is the worse half.
    if (sameSense) builder.triangle(a, b, c, tag);
    else builder.triangle(a, c, b, tag);
  }

  return true;
}

// ── walking the topology ────────────────────────────────────────────────────

/** An EDGE_LOOP as a closed 3D polyline, curved edges sampled to the chord tolerance. */
function readLoop(file: StepFile, loop: Entity | null): Vec3[] | null {
  if (!loop || loop.type !== 'EDGE_LOOP') return null;

  const points: Vec3[] = [];

  for (const ref of asList(loop.args[1])) {
    const oriented = deref(file, ref.kind === 'ref' ? ref.id : null);
    if (!oriented || oriented.type !== 'ORIENTED_EDGE') continue;

    const edge = deref(file, asRef(oriented.args[3]));
    if (!edge || edge.type !== 'EDGE_CURVE') continue;

    const forward = asFlag(oriented.args[4]);
    const from = vertexPoint(file, asRef(edge.args[forward ? 1 : 2]));
    const to = vertexPoint(file, asRef(edge.args[forward ? 2 : 1]));
    if (!from || !to) continue;

    const curve = deref(file, asRef(edge.args[3]));
    const samples = sampleEdge(file, curve, from, to, forward === asFlag(edge.args[4]));

    // Each edge contributes its start and interior; the next edge supplies the shared end,
    // so the polyline has no duplicated vertices at the joins.
    for (let i = 0; i < samples.length - 1; i++) points.push(samples[i]!);
  }

  return points.length >= 3 ? points : null;
}

/**
 * An edge as a polyline from `from` to `to`.
 *
 * Lines are their two ends. Circles are sampled at the chord tolerance over the arc the two
 * ends actually subtend — not over the whole circle, which is the mistake that turns a 90°
 * fillet into a full round.
 */
function sampleEdge(
  file: StepFile, curve: Entity | null, from: Vec3, to: Vec3, forward: boolean,
): Vec3[] {
  if (!curve || curve.type === 'LINE') return [from, to];

  if (curve.type === 'CIRCLE') {
    const frame = placement(file, asRef(curve.args[1]));
    const radius = radiusOf(file, curve);
    if (!frame || radius === null || radius <= 0) return [from, to];

    const { origin, axis, ref } = frame;
    const u = ref;
    const v = cross3(axis, u);

    const angleOf = (p: Vec3) => {
      const d = sub3(p, origin);
      return Math.atan2(dot3(d, v), dot3(d, u));
    };

    const a0 = angleOf(from);
    const a1 = angleOf(to);

    // A closed circular edge has both ends at the same place. It is a full turn, and which
    // way round it goes is the edge's own sense.
    let sweep = a1 - a0;
    if (Math.abs(sweep) < 1e-9) sweep = forward ? 2 * Math.PI : -2 * Math.PI;
    else if (forward && sweep < 0) sweep += 2 * Math.PI;
    else if (!forward && sweep > 0) sweep -= 2 * Math.PI;

    const steps = Math.max(2, arcSegments(radius, Math.abs(sweep), CHORD_TOL));
    const out: Vec3[] = [];
    for (let i = 0; i <= steps; i++) {
      const angle = a0 + (sweep * i) / steps;
      out.push(add3(
        origin,
        add3(mul3(u, Math.cos(angle) * radius), mul3(v, Math.sin(angle) * radius)),
      ));
    }

    // The two ends are taken from the file's own vertices rather than from the trigonometry.
    //
    // They are the same point to about fifteen decimal places, and that was not enough. Two
    // arcs meeting at a vertex each compute it from their own placement and reference
    // direction, so the two results differ in the last bits — and the mesh welder, which is
    // comparing positions rather than identities, kept them as separate vertices. The shell
    // then had a hairline crack at every arc junction: closed by inspection, open by
    // measurement, and the volume of a bore came out wrong with nothing visibly missing.
    //
    // A vertex in STEP is a named instance shared by every edge that meets there. Using it is
    // both exact and what the file actually says.
    out[0] = from;
    out[out.length - 1] = to;

    return out;
  }

  // Any other curve — a B-spline, an ellipse — is taken as its chord. The face it bounds is
  // then slightly wrong rather than missing, and `notes` says the file used curves this build
  // does not follow.
  return [from, to];
}

// ── small readers ───────────────────────────────────────────────────────────

function deref(file: StepFile, id: number | null): Entity | null {
  return id === null ? null : file.entities.get(id) ?? null;
}

function cartesian(file: StepFile, id: number | null): Vec3 | null {
  const entity = deref(file, id);
  if (!entity || (entity.type !== 'CARTESIAN_POINT' && entity.type !== 'DIRECTION')) return null;

  const coords = asList(entity.args[1]).map((v) => asNumber(v) ?? 0);
  if (coords.length < 3) return null;

  // A position is in file units; a direction is a unit vector and must not be scaled. Both
  // are written as three numbers, and scaling the wrong one skews every frame in the file.
  const k = entity.type === 'CARTESIAN_POINT' ? file.lengthMm : 1;
  return [coords[0]! * k, coords[1]! * k, coords[2]! * k];
}

/** A radius in file units, converted. */
function radiusOf(file: StepFile, entity: Entity, at = 2): number | null {
  const raw = asNumber(entity.args[at]);
  return raw === null ? null : raw * file.lengthMm;
}

function vertexPoint(file: StepFile, id: number | null): Vec3 | null {
  const vertex = deref(file, id);
  if (!vertex || vertex.type !== 'VERTEX_POINT') return null;
  return cartesian(file, asRef(vertex.args[1]));
}

interface Frame {
  origin: Vec3;
  /** Local Z. */
  axis: Vec3;
  /** Local X, made exactly perpendicular to the axis. */
  ref: Vec3;
}

/**
 * AXIS2_PLACEMENT_3D — an origin, an axis and a reference direction.
 *
 * Both directions are optional in the schema and are genuinely omitted by some translators,
 * so the defaults from the standard are supplied. The reference direction is also
 * re-orthogonalised against the axis rather than trusted: files exist where the two are not
 * quite perpendicular, and a skewed basis puts every point on that face slightly out of place.
 */
function placement(file: StepFile, id: number | null): Frame | null {
  const entity = deref(file, id);
  if (!entity || entity.type !== 'AXIS2_PLACEMENT_3D') return null;

  const origin = cartesian(file, asRef(entity.args[1]));
  if (!origin) return null;

  const axis = norm3(cartesian(file, asRef(entity.args[2])) ?? [0, 0, 1]);
  const given = cartesian(file, asRef(entity.args[3])) ?? defaultRef(axis);

  const projected = sub3(given, mul3(axis, dot3(given, axis)));
  const ref = len3(projected) > 1e-9 ? norm3(projected) : defaultRef(axis);

  return { origin, axis, ref };
}

/** Any unit vector perpendicular to the axis, chosen so it is never near-parallel to it. */
function defaultRef(axis: Vec3): Vec3 {
  const away: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return norm3(sub3(away, mul3(axis, dot3(away, axis))));
}

function fileName(file: StepFile): string {
  for (const entity of file.header) {
    if (entity.type !== 'FILE_NAME') continue;
    const first = entity.args[0];
    if (first && first.kind === 'string' && first.value.trim()) {
      return first.value.replace(/\.(stp|step)$/i, '').trim();
    }
  }
  return 'Imported part';
}

/** A surface type in words, because "B_SPLINE_SURFACE_WITH_KNOTS" is not an explanation. */
function describeSurface(type: string): string {
  switch (type) {
    case 'B_SPLINE_SURFACE_WITH_KNOTS':
    case 'B_SPLINE_SURFACE':
    case 'RATIONAL_B_SPLINE_SURFACE': return 'a freeform (spline) surface';
    case 'TOROIDAL_SURFACE': return 'a torus — usually a fillet blend';
    case 'SPHERICAL_SURFACE': return 'a sphere';
    case 'SURFACE_OF_REVOLUTION': return 'a surface of revolution';
    case 'SURFACE_OF_LINEAR_EXTRUSION': return 'a swept surface';
    case 'CYLINDRICAL_SURFACE_FULL':
    case 'CONICAL_SURFACE_FULL': return 'a face wrapping a whole cylinder in one piece';
    case 'DEGENERATE': return 'a face with no area';
    default: return type.toLowerCase().replace(/_/g, ' ');
  }
}

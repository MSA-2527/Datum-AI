/**
 * The document: an ordered feature tree evaluated by the kernel.
 *
 * This replaces the 2.5D `partModel` that the UI was built against. That model could only
 * represent a profile swept to a thickness, which is why the viewport was a flat plan view
 * and why nothing the kernel could do was reachable from the interface.
 *
 * The shape of the model is the same as any parametric CAD system's, and for the same
 * reason: **features are stored, geometry is derived**. Nothing here caches a mesh as the
 * source of truth. Editing a parameter and re-evaluating is the only way geometry changes,
 * which is what makes the tree editable at all — and it means the document that gets saved
 * is a few hundred bytes of intent rather than megabytes of triangles.
 *
 * Face ownership falls out of evaluation rather than being tracked separately. Every kernel
 * operation tags the faces it creates with the name it was given, so passing the feature's
 * id as that name means the finished mesh already knows which feature produced each face.
 * That is what lets the tree highlight geometry and the viewport select a feature.
 */

import {
  add3, matMul, mul3, norm3, rad, reflection, rotation, translation,
  type Mat4, type Vec2, type Vec3,
} from '../kernel/math/vec';
import {
  bounds, concatMeshes, deserialiseMesh, getTriangle, health, massProperties, serialiseMesh,
  transformMesh, triCount,
  type Mesh, type MeshHealth,
} from '../kernel/topo/mesh';
import {
  circleProfile, makeProfile, polygonProfile, rectProfile, slotProfile, type Profile,
} from '../kernel/sketch/profile';
import {
  XY, XZ, YZ, box, cone, cylinder, extrude, loft, planeFrom, profileCrossesAxis, revolve, sphere,
  sweep, type Plane,
} from '../kernel/ops/build';
import { interpolateCurve, lineToNurbs, type NurbsCurve } from '../kernel/math/nurbs';
import { boolean, subtractAll } from '../kernel/ops/boolean';
import { displaceFaces, facesFacing, subdivide } from '../kernel/ops/subdivide';
import { sketchFromJson, solveForProfile } from '../kernel/sketch/document';
import {
  chamferEdges, circularPattern, filletEdges, linearPattern, mirrorBody, sharpEdges, shell,
} from '../kernel/ops/modify';
import { archetypeById } from '../generate/archetypes';
import { type MateKind } from '../kernel/assembly/assembly';
import { evaluateExpr, readNumber, resolveParameters } from './expr';

// ── features ─────────────────────────────────────────────────────────────────

export type FeatureKind =
  | 'archetype'
  | 'box' | 'cylinder' | 'sphere'
  | 'sketch'
  | 'extrude' | 'revolve' | 'loft' | 'sweep'
  | 'rib' | 'draft' | 'dome' | 'split' | 'datum' | 'wrap' | 'sheet'
  | 'hole' | 'pocket' | 'slot'
  | 'fillet' | 'chamfer' | 'shell'
  | 'patternLinear' | 'patternCircular' | 'mirror'
  | 'imported';

export type ParamValue = number | string | boolean | number[];

/**
 * A mate, as the document stores it.
 *
 * Keyed by **feature id**, not by instance id, and that distinction is load-bearing. The
 * assembly is derived from the tree on demand, so its instance ids are minted fresh every
 * time it is built — a mate holding one refers to an instance that no longer exists the
 * moment anything is edited. The first version did exactly that and silently solved nothing:
 * the mate was ignored, the solver reported six untouched degrees of freedom, and no part
 * moved. A feature id is the document's own identity and outlives every rebuild.
 */
export interface DocumentMate {
  id: string;
  kind: MateKind;
  a: { feature: string; point?: Vec3; direction?: Vec3 };
  b: { feature: string; point?: Vec3; direction?: Vec3 };
  /** Distance in mm, or angle in degrees. */
  value?: number;
  suppressed?: boolean;
}


export interface Placement {
  /** Translation, millimetres. */
  x: number; y: number; z: number;
  /** Rotation about each axis, degrees, applied Z then Y then X. */
  rx: number; ry: number; rz: number;
  /**
   * Reflect the body in the plane through its own origin normal to this axis, before the
   * rotation and translation.
   *
   * A mirror is not a rotation, and treating it as one is a mistake that only stays hidden
   * while every part is symmetric. An assembly places its second instance of a paired
   * component by negating its position — which is right for a box and wrong for anything with
   * a handedness. A lofted wing grows outboard from its root, so the mirrored copy grew back
   * through the fuselage and the aircraft had two left wings on the same side.
   */
  mirror?: 'x' | 'y' | 'z';
}

export const IDENTITY_PLACEMENT: Placement = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };

export interface Feature {
  id: string;
  name: string;
  kind: FeatureKind;
  params: Record<string, ParamValue>;
  suppressed: boolean;
  /**
   * Where this feature's geometry sits.
   *
   * Held separately from the shape's own parameters because position and size are edited for
   * different reasons: a component is moved to fit an assembly, and resized to meet a
   * requirement. Mixing them means every archetype has to grow x/y/z parameters it does not
   * otherwise need.
   */
  placement?: Placement;
  /**
   * Expressions that drive placement components.
   *
   * Kept beside `placement` rather than replacing its numbers, so everything that reads a
   * position — the viewport, drag handling, mates, the assembly bridge — keeps seeing plain
   * millimetres. `placement` is the *resolved* value; this is where it came from.
   *
   * A driven axis is what makes a generated assembly a design. The rear axle at
   * `-wheelbase / 2` follows when the wheelbase changes; the same axle at `-1167.5` does not.
   */
  placementExpr?: Partial<Record<'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz', string>>;
  /** What this component is for, in an assembly. Shown in the tree. */
  role?: string;
  /** Populated by evaluation; never stored. */
  error?: string;
  warning?: string;
}

export interface Document {
  /**
   * Identifies this document as a distinct part, not a distinct revision of one.
   *
   * Editing a feature keeps the id; opening, importing or clearing mints a new one. The
   * viewport uses it to decide whether to re-frame the camera.
   */
  id: string;
  name: string;
  units: 'mm' | 'in';
  material: string;
  /** g/cm³. */
  density: number;
  /**
   * Mass in grams, when it is known more precisely than volume × density.
   *
   * A single-material part has one density and the product is exact. An assembly does not:
   * a phone is aluminium, glass, a battery and a board, and no single figure describes it.
   * Weighing the merged solid at any one component's density is simply wrong — at the
   * heaviest it made a 250 g phone weigh 831 g.
   *
   * When a document is built from a plan, every component's own volume and own density are
   * summed into this. It takes precedence because it is the better measurement, not because
   * it is an override.
   */
  knownMassGrams?: number;
  /**
   * Release metadata: part number, revision, vendor, finish.
   *
   * Not geometry, and deliberately free-form. It exists because the manufacturability rules
   * already check for it - a quote package without a part number is rejected by suppliers,
   * and `dfm.metadata.required` says so - but there was nowhere on the document to put it, so
   * the finding could be read and never acted on. It also fills the drawing's title block.
   */
  properties?: Record<string, string>;
  features: Feature[];
  /**
   * The design's driving dimensions.
   *
   * A parameter may be a literal or an expression over the others, and any feature parameter
   * or placement may be an expression over these. That is what makes a generated model a
   * *design* rather than a result: `wheelbase = 2335` stated once, and every part that depends
   * on it moving when it changes.
   */
  globals: { name: string; value: number | string; units: string; note?: string }[];
  /**
   * Named sets of parameter values, for a family of parts in one document.
   *
   * Optional so that every document written before configurations existed still reads. See
   * `model/configurations.ts` for why a configuration carries parameters and suppression and
   * deliberately nothing else.
   */
  configurations?: { active: string; list: unknown[] };
  /**
   * Relationships between components, which drive their placements.
   *
   * Optional because most documents are a single part and have none, and because every
   * document written before mates existed has none either.
   */
  mates?: DocumentMate[];
}

let documentSerial = 0;

/**
 * A fresh document, with an identity.
 *
 * The id exists so the viewport can tell "the user changed a dimension" from "this is a
 * different part now". Re-fitting the camera on every edit would fight the user's own
 * navigation; never re-fitting meant that importing a drawing while a model was already open
 * left the new part outside the view — built correctly, in the tree, weighed on the status
 * line, and invisible. That reads as "the import did nothing".
 */
export function emptyDocument(name = 'Part1'): Document {
  return {
    id: `d${++documentSerial}`,
    name,
    units: 'mm',
    material: 'Aluminium 6061-T6',
    density: 2.7,
    features: [],
    globals: [],
  };
}

let uid = 0;
export const newFeatureId = (): string => `f${++uid}`;

// ── evaluation ───────────────────────────────────────────────────────────────

export interface EvaluatedDocument {
  mesh: Mesh;
  /** Face tag id → feature id, for selection and highlighting. */
  faceOwner: Map<number, string>;
  /** Feature id → the inclusive face-tag range it owns, for the shader's cheap range test. */
  featureFaceRange: Map<string, [number, number]>;
  /** Per-feature diagnostics, keyed by feature id. */
  errors: Map<string, string>;
  warnings: Map<string, string>;
  health: MeshHealth;
  volume: number;
  massGrams: number;
  centroid: Vec3;
  /** Line list for the edge pass: six floats per edge. */
  edges: Float32Array;
  rebuildMs: number;
}

/**
 * Evaluates the whole tree in order.
 *
 * A feature that fails does not abort the rebuild. It records its error and the tree carries
 * on with the geometry it had, which is what every parametric system does and what users
 * expect — one bad fillet should not make the rest of the part disappear.
 */
export function evaluateDocument(doc: Document): EvaluatedDocument {
  const started = Date.now();

  let mesh: Mesh = {
    positions: new Float64Array(0),
    indices: new Uint32Array(0),
    faceIds: new Uint32Array(0),
    tags: new Map(),
  };

  const errors = new Map<string, string>();
  const warnings = new Map<string, string>();

  for (const feature of doc.features) {
    if (feature.suppressed) continue;

    try {
      const result = applyFeature(mesh, feature, doc);
      if (result.error) errors.set(feature.id, result.error);
      if (result.warning) warnings.set(feature.id, result.warning);
      if (result.mesh) mesh = result.mesh;
    } catch (e) {
      // A kernel operation throwing is a defect, not a user error, but the document has to
      // stay usable so the user can undo whatever caused it.
      errors.set(feature.id, e instanceof Error ? e.message : 'The feature could not be built.');
    }
  }

  const faceOwner = new Map<number, string>();
  const featureFaceRange = new Map<string, [number, number]>();

  for (const [tagId, tag] of mesh.tags) {
    faceOwner.set(tagId, tag.feature);
    const range = featureFaceRange.get(tag.feature);
    if (range) {
      range[0] = Math.min(range[0], tagId);
      range[1] = Math.max(range[1], tagId);
    } else {
      featureFaceRange.set(tag.feature, [tagId, tagId]);
    }
  }

  const mp = triCount(mesh) > 0
    ? massProperties(mesh)
    : { volume: 0, area: 0, centroid: [0, 0, 0] as Vec3, inertia: [0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number], principal: [0, 0, 0] as Vec3, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as [Vec3, Vec3, Vec3] };

  return {
    mesh,
    faceOwner,
    featureFaceRange,
    errors,
    warnings,
    health: health(mesh),
    volume: Math.abs(mp.volume),
    massGrams: doc.knownMassGrams ?? (Math.abs(mp.volume) / 1000) * doc.density,
    centroid: mp.centroid,
    edges: extractEdges(mesh),
    rebuildMs: Date.now() - started,
  };
}

interface FeatureResult {
  mesh?: Mesh;
  error?: string;
  warning?: string;
}

/** Resolves a parameter, following a global reference when the value is a name. */
/**
 * Reads a numeric parameter, which may be a literal, a parameter name, or an expression.
 *
 * This used to accept only a bare parameter name. Accepting an expression is the whole point:
 * a bare name can say "this is the wheelbase" but only an expression can say "this is half of
 * it", and half of it is what a placement actually needs.
 */
export function num(doc: Document, params: Record<string, ParamValue>, key: string, fallback: number): number {
  return readNumber(params[key], parametersOf(doc), fallback).value;
}

/**
 * The document's resolved parameter values, memoised per document object.
 *
 * Resolution walks the whole table and is called once per parameter read — several hundred
 * times in a sixty-part rebuild. The cache is keyed on the document *identity*, so any edit
 * produces a new object and a fresh resolve; nothing can go stale.
 */
const parameterCache = new WeakMap<Document, Record<string, number>>();

export function parametersOf(doc: Document): Record<string, number> {
  const hit = parameterCache.get(doc);
  if (hit) return hit;

  const { values } = resolveParameters(doc.globals ?? []);
  withFeatureDimensions(doc, values);
  parameterCache.set(doc, values);
  return values;
}

/**
 * The name a feature's dimensions are referred to by.
 *
 * Feature names are written for people — "Mid-frame", "Camera lens 1" — and an expression
 * language cannot take a space or a hyphen without them meaning subtraction. So the reference
 * name is the feature name with anything else turned into an underscore. It is derived rather
 * than stored so that renaming a feature renames what its dimensions are called, which is what
 * anyone would expect; the cost is that an expression naming the old one stops resolving, and
 * that is reported by name rather than silently read as zero.
 */
export function referenceName(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!cleaned) return '';
  // An identifier cannot start with a digit, and "3rd bracket" is a name someone will use.
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Every feature dimension, added to the value scope as `Feature.parameter`.
 *
 * This is what makes the document one parametric model rather than a set of features that
 * happen to sit in the same file. Without it a wall thickness that has to be twice the plate
 * thickness can only be typed twice and kept in step by hand, which is exactly the thing a
 * parametric modeller exists to stop.
 *
 * Resolved in tree order, and a feature may only refer to features *before* it. That is the
 * same rule the tree already obeys — a feature is built onto what precedes it — and it makes
 * a circular reference impossible to write rather than something to detect and report. It also
 * means the answer never depends on the order the scope happened to be built in.
 *
 * Written into the caller's map rather than returned, because the parameter table it extends
 * is the same scope: a feature's dimension may be an expression over a global, and a later
 * feature's may be an expression over that.
 */
function withFeatureDimensions(doc: Document, values: Record<string, number>): void {
  const used = new Set(Object.keys(values));

  for (const f of doc.features) {
    let name = referenceName(f.name);
    if (!name) continue;

    // Two features may legitimately share a name. The first one keeps it: silently
    // redirecting an expression to a different feature would be worse than not resolving.
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
    }
    used.add(name);

    for (const [key, raw] of Object.entries(f.params)) {
      if (typeof raw === 'number') {
        if (Number.isFinite(raw)) values[`${name}.${key}`] = raw;
        continue;
      }
      if (typeof raw !== 'string' || !raw.trim()) continue;

      // A sketch travels as JSON and a plane travels as "XZ"; neither is an expression, and
      // handing a kilobyte of JSON to the tokeniser on every rebuild to be told so is work
      // done for nothing. Anything with a brace or a quote in it is not arithmetic.
      if (raw.length > 120 || /["'{}[\]:]/.test(raw)) continue;

      const r = evaluateExpr(raw, values);
      if (!r.error) values[`${name}.${key}`] = r.value;
    }
  }
}

/** Parameters that could not be worked out, and why. */
export function parameterErrors(doc: Document): Map<string, string> {
  return resolveParameters(doc.globals ?? []).errors;
}

/**
 * What an expression *on a particular feature* may name.
 *
 * Narrower than the whole scope, because a feature may only refer to features before it. The
 * editor offers this rather than everything, so the list a user is shown is the list that
 * actually resolves — offering a name that will not work is worse than offering none.
 *
 * Built by asking the same function about a document truncated at this feature, so the rule
 * cannot drift away from the one the evaluator applies.
 */
export function referenceScopeAt(
  doc: Document, featureId: string,
): { name: string; value: number; from: string }[] {
  const at = doc.features.findIndex((f) => f.id === featureId);
  const before = at < 0 ? doc.features : doc.features.slice(0, at);
  return referenceScope({ ...doc, features: before });
}

/**
 * Everything an expression in this document may name, with what it currently comes to.
 *
 * Offered to the editor so the names are discoverable. A reference language nobody can see the
 * vocabulary of is one people will not use.
 */
export function referenceScope(doc: Document): { name: string; value: number; from: string }[] {
  const globals = new Set((doc.globals ?? []).map((g) => g.name));
  return Object.entries(parametersOf(doc))
    .map(([name, value]) => ({
      name, value,
      from: globals.has(name) ? 'parameter' : 'feature',
    }))
    .sort((a, b) => (a.from === b.from ? a.name.localeCompare(b.name) : a.from < b.from ? 1 : -1));
}

const str = (params: Record<string, ParamValue>, key: string, fallback: string): string =>
  typeof params[key] === 'string' ? (params[key] as string) : fallback;

/**
 * Breaks the edges of a primitive.
 *
 * Nothing manufactured has a knife edge. A machined part gets its corners broken by the tool
 * radius whether anyone asks or not, a casting is drafted and radiused because it has to come
 * out of the mould, and a sheet part carries the bend radius of the press. A model made of
 * mathematically sharp prisms does not look like a simplified real part — it looks like a
 * drawing of blocks, and that is most of the difference between a massing study and something
 * that reads as a made object.
 *
 * Applied by construction here, on the primitive alone before it is placed or combined, so
 * the blend is on the part rather than on whatever it later happens to touch. A radius the
 * solid cannot take is dropped rather than raised as an error: an edge break is a finish, and
 * losing the finish is not a reason to refuse to build the part.
 */
function broken(solid: Mesh, radius: number, feature: string): Mesh {
  if (!(radius > 1e-6)) return solid;

  const bb = bounds(solid);
  const smallest = Math.min(
    bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2],
  );
  // A blend wider than a third of the thinnest section stops being an edge break and starts
  // being the shape of the part, which is a decision for whoever drew it, not for a default.
  if (radius >= smallest / 3) return solid;

  const rounded = filletEdges(solid, { radius, feature });
  return rounded.valid && triCount(rounded.mesh) > 0 ? rounded.mesh : solid;
}

/**
 * A relief carried in a feature's parameters, if it has one.
 *
 * The field travels as a flat array of numbers because that is what a parameter is allowed to
 * be — see the note on hole loops in `profileFrom`. Keeping documents to plain JSON with no
 * nested structures is what makes them serialise, validate and diff without special cases, and
 * one index calculation here is a cheaper price than a second shape everywhere else.
 */
function reliefFor(p: Record<string, ParamValue>, doc: Document): {
  field: number[]; width: number; height: number; mmPerPixel: number; depth: number;
} | null {
  const field = p.reliefField;
  if (!Array.isArray(field) || field.length < 4) return null;

  const width = Math.round(num(doc, p, 'reliefWidth', 0));
  const height = Math.round(num(doc, p, 'reliefHeight', 0));
  const mmPerPixel = num(doc, p, 'reliefScale', 0);
  const depth = num(doc, p, 'reliefDepth', 0);

  if (width < 2 || height < 2 || field.length < width * height) return null;
  if (!(mmPerPixel > 0) || !(Math.abs(depth) > 1e-9)) return null;

  return { field: field as number[], width, height, mmPerPixel, depth };
}

/**
 * Pushes the top face of an extrusion out by a height field.
 *
 * The face is refined first, because displacing a flat cap made of two triangles moves three
 * corners and produces a wedge. Four levels takes the two triangles of a rectangular cap to
 * five hundred, which is enough to carry the shape without making the tree sluggish.
 */
function applyRelief(
  solid: Mesh, relief: { field: number[]; width: number; height: number; mmPerPixel: number; depth: number },
  feature: string,
): Mesh {
  void feature;

  // Four levels. Five is visibly no better on the surface itself and costs four times the
  // triangles — a dome came out at 127 000 and took 600 ms to rebuild, against 32 000 and
  // 140 ms. What five improved was the *edge overlay*, which draws the fan of long thin
  // triangles an ear-clipped cap is made of; that is a display artefact and not a reason to
  // make every parameter edit four times slower.
  const fine = subdivide(solid, 4);
  const top = facesFacing(fine, [0, 0, 1], 10);
  if (top.size === 0) return solid;

  const { field, width, height, mmPerPixel, depth } = relief;

  return displaceFaces(fine, top, [0, 0, 1], (point) => {
    // Model millimetres back to the pixel grid the field was measured on.
    const x = point[0] / mmPerPixel;
    const y = point[1] / mmPerPixel;
    if (!(x >= 0 && y >= 0 && x <= width - 1 && y <= height - 1)) return 0;

    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;

    const a = field[y0 * width + x0]! * (1 - fx) + field[y0 * width + x1]! * fx;
    const b = field[y1 * width + x0]! * (1 - fx) + field[y1 * width + x1]! * fx;
    return (a * (1 - fy) + b * fy) * depth;
  });
}

/**
 * The plane a profile feature is built on.
 *
 * Named planes — Top, Front, Right — are what you start from, but nothing real is modelled
 * only from those: a boss goes on the face of the part it sits on, and a pocket is cut into
 * the face you can see. So a feature may instead carry `planeOrigin` and `planeNormal`,
 * written by picking a face in the viewport, and then it is built on that face.
 *
 * The named plane stays the fallback rather than being replaced, so an older document, or one
 * where the face it referred to no longer exists, still builds somewhere sensible instead of
 * refusing.
 */
/**
 * The plane a named datum feature defines.
 *
 * Derived from the datum's parameters every time rather than stored on it, because a stored
 * plane is a second copy of the answer that goes stale the moment the offset is edited.
 */
export function datumPlane(f: Feature, doc: Document): Plane {
  const num_ = (key: string, fallback: number) => num(doc, f.params, key, fallback);

  const base = planeOf(str(f.params, 'basePlane', 'XY'));
  const offset = num_('offset', 0);

  const origin: Vec3 = [
    base.origin[0] + base.normal[0] * offset,
    base.origin[1] + base.normal[1] * offset,
    base.origin[2] + base.normal[2] * offset,
  ];

  const tiltX = rad(num_('tiltX', 0));
  const tiltY = rad(num_('tiltY', 0));

  // Tilted about the plane's own in-plane axes, so "tilt about X" means the same thing on a
  // datum parallel to Front as it does on one parallel to Top.
  const turn = matMul(rotation(base.u, tiltX), rotation(base.v, tiltY));
  const normal = norm3(xformDirection(turn, base.normal));

  return planeFrom(origin, normal, xformDirection(turn, base.u));
}

/** Rotates a direction by a matrix, ignoring its translation. */
function xformDirection(m: Mat4, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
  ];
}

/** Every datum in the document, in tree order, for the plane picker. */
export function datumsIn(doc: Document): Feature[] {
  return doc.features.filter((f) => f.kind === 'datum' && !f.suppressed);
}

function planeFor(p: Record<string, ParamValue>, fallback: string, doc?: Document): Plane {
  // A datum named by a feature that comes later, or one that has been deleted, falls back to
  // the named plane rather than refusing — an older document still builds somewhere sensible
  // instead of going blank.
  const named = str(p, 'plane', fallback);
  if (named === 'datum' && doc) {
    const want = str(p, 'datumRef', '');
    const datums = datumsIn(doc);

    // Naming none means the first one, not none at all. Choosing "a datum plane" and then
    // falling back to Top because the second control had not been touched yet is a feature
    // that silently does nothing — the user has said where they want it and been ignored.
    const datum = want
      ? datums.find((d) => referenceName(d.name) === want || d.name === want)
      : datums[0];

    if (datum) return datumPlane(datum, doc);
  }

  const origin = p.planeOrigin;
  const normal = p.planeNormal;

  if (Array.isArray(origin) && origin.length === 3 && Array.isArray(normal) && normal.length === 3) {
    const n: Vec3 = [Number(normal[0]), Number(normal[1]), Number(normal[2])];
    if (n.every(Number.isFinite) && Math.hypot(n[0], n[1], n[2]) > 1e-9) {
      return planeFrom(
        [Number(origin[0]), Number(origin[1]), Number(origin[2])],
        n,
      );
    }
  }

  return planeOf(str(p, 'plane', fallback));
}

/**
 * The drill a thread is cut into, for the common coarse metric sizes.
 *
 * Nominal minus the pitch, which is the rule every shop uses and which the table below simply
 * tabulates for the sizes people ask for by name. Anything not listed falls back to the rule
 * itself rather than to the nominal size, because a hole drilled at the thread diameter cannot
 * be tapped at all and is a more expensive mistake than one drilled a few tenths off.
 */
function tappingDrill(nominal: number): number {
  const COARSE_PITCH: Record<number, number> = {
    2: 0.4, 2.5: 0.45, 3: 0.5, 4: 0.7, 5: 0.8, 6: 1, 8: 1.25, 10: 1.5,
    12: 1.75, 14: 2, 16: 2, 20: 2.5, 24: 3,
  };

  const pitch = COARSE_PITCH[nominal] ?? nominal * 0.16;
  return Math.max(0.5, nominal - pitch);
}

/** How much of a flange a bend consumes, measured to the outside of the corner. */
function setbackOf(angle: number, radius: number, thickness: number): number {
  return (radius + thickness) * Math.tan(Math.abs(rad(angle)) / 2);
}

/**
 * A closed outline around a centreline, at a constant half-width.
 *
 * Up one side and back the other, which is what a constant-thickness section is. The normals are
 * taken from the segment on each side of a vertex and averaged, so the thickness holds through a
 * corner instead of pinching on the inside of it.
 */
function ribbon(path: Vec2[], half: number): Vec2[] {
  if (path.length < 2) return [];

  const normals: Vec2[] = path.map((_, i) => {
    const before = path[Math.max(0, i - 1)]!;
    const after = path[Math.min(path.length - 1, i + 1)]!;

    const dx = after[0] - before[0];
    const dy = after[1] - before[1];
    const len = Math.hypot(dx, dy) || 1;
    return [-dy / len, dx / len];
  });

  const left: Vec2[] = path.map((pt, i) => [
    pt[0] + normals[i]![0] * half, pt[1] + normals[i]![1] * half,
  ]);
  const right: Vec2[] = path.map((pt, i) => [
    pt[0] - normals[i]![0] * half, pt[1] - normals[i]![1] * half,
  ]);

  return [...left, ...right.reverse()];
}

function planeOf(name: string): Plane {
  switch (name) {
    case 'XZ': case 'front': return XZ;
    case 'YZ': case 'right': return YZ;
    default: return XY;
  }
}

/**
 * Builds one feature onto the mesh so far.
 *
 * Exported because an assembly needs each component as its *own* body, built from an empty
 * mesh rather than onto the accumulated one. Evaluating the tree in sequence is what produces
 * the single merged solid the viewport shows, and that solid has no seam where one component
 * ends and the next begins.
 */
export function applyFeature(current: Mesh, f: Feature, doc: Document): FeatureResult {
  const p = f.params;
  const n = (key: string, fallback: number) => num(doc, p, key, fallback);

  switch (f.kind) {
    case 'archetype': {
      const archetype = archetypeById(str(p, 'archetypeId', ''));
      if (!archetype) return { error: `Unknown shape "${str(p, 'archetypeId', '')}".` };

      const values: Record<string, number> = {};
      for (const spec of archetype.defaults) values[spec.key] = n(spec.key, spec.value);

      const built = archetype.build(values);
      // Re-tag every face with this feature's id so selection maps back to the tree.
      const tagged = retag(built.mesh, f.id);

      // Archetypes obey add/cut/intersect exactly like primitives do. They did not, and the
      // consequence was silent and severe: a component marked as a cut — a port, a cavity, a
      // clearance — was unioned instead, so it *added* material where it should have removed
      // it. A phone's speaker ports became six solid pins through the chassis.
      const combined = combine(current, place(tagged, f, doc), str(p, 'operation', 'add'));

      return {
        mesh: combined.mesh,
        warning: built.warnings.length > 0 ? built.warnings.join(' ') : undefined,
        error: combined.error ?? (built.valid ? undefined : 'The shape did not close.'),
      };
    }

    // Primitives are centred on their own origin, so a feature's placement means the centre
    // of the part.
    //
    // These used to sit *on* the Z=0 plane — the centre defaulted to half the height — which
    // reads nicely for a single part dropped on a build plate and is wrong for everything
    // else. A placement then moved the base rather than the centre, so every component in
    // every assembly was displaced upward by half its own height. The phone's cover glass
    // ended up buried inside the mid-frame instead of lying on its face, and the assistant is
    // told in its own prompt that placement is the centre, so every generated plan inherited
    // the same offset.
    case 'box': {
      const solid = box(n('length', 60), n('width', 40), n('height', 25),
        [n('x', 0), n('y', 0), n('z', 0)], f.id);
      return combine(current, place(broken(solid, n('round', 0), f.id), f, doc),
        str(p, 'operation', 'add'));
    }

    case 'cylinder': {
      const solid = cylinder(n('diameter', 40) / 2, n('height', 50),
        [n('x', 0), n('y', 0), n('z', 0)], [0, 0, 1], f.id);
      return combine(current, place(broken(solid, n('round', 0), f.id), f, doc),
        str(p, 'operation', 'add'));
    }

    case 'sphere': {
      const solid = sphere(n('diameter', 50) / 2, [n('x', 0), n('y', 0), n('z', 0)], f.id);
      return combine(current, place(solid, f, doc), str(p, 'operation', 'add'));
    }

    // A sketch is the only feature here whose shape is *derived* rather than typed.
    //
    // Its dimensions are constraints, and the solver decides where the geometry actually goes.
    // That is what makes it parametric in the sense the rest of CAD means: change the 100 mm
    // and every relation depending on it moves too, instead of one number changing in
    // isolation.
    case 'sketch': {
      const solved = solveForProfile(sketchFromJson(str(p, 'sketch', '')));
      if (!solved.profile) return { error: solved.reason ?? 'The sketch has no closed outline.' };

      if (solved.result.status === 'conflict') {
        return { error: `${solved.summary} Remove one of them and the sketch will solve.` };
      }

      const solid = extrude(solved.profile, planeFor(p, 'XY', doc), {
        distance: n('distance', 20),
        midplane: p.midplane === true,
        draftDeg: n('draft', 0),
        feature: f.id,
      });

      /*
       * Under-constrained is deliberately *not* reported here.
       *
       * It is worth knowing — a dimension that does not hold is a surprise later — and the
       * sketch editor says it, in its own status line, with the tone it deserves. Raising it
       * as a feature warning as well put it in the application's main notice, where it
       * replaced the result: draw a rectangle, get a solid, and read "Under-constrained: 8
       * degrees of freedom left" as the outcome. Every sketch is under-constrained the moment
       * it is drawn, so that fired every time and taught people that drawing does not work.
       */
      return combine(current, place(solid, f, doc), str(p, 'operation', 'add'));
    }

    case 'extrude': {
      const profile = profileFrom(p, doc);
      if (!profile) return { error: 'This feature has no profile to extrude.' };

      const solid = extrude(profile, planeFor(p, 'XY', doc), {
        distance: n('distance', 20),
        midplane: p.midplane === true,
        draftDeg: n('draft', 0),
        feature: f.id,
      });

      // A relief recovered from a photograph rides on the extrusion rather than replacing it:
      // the outline still comes from the traced silhouette, and the shading only says how far
      // the top face stands proud of it. Kept as parameters so the depth stays a number the
      // user can change — a reconstruction you cannot argue with is not a model.
      const relief = reliefFor(p, doc);
      const shaped = relief ? applyRelief(solid, relief, f.id) : solid;

      return combine(current, place(shaped, f, doc), str(p, 'operation', 'add'));
    }

    case 'revolve': {
      const profile = profileFrom(p, doc);
      if (!profile) return { error: 'This feature has no profile to revolve.' };

      const plane = planeOf(str(p, 'plane', 'XZ'));
      const axisOrigin: Vec3 = [0, 0, 0];
      const axisDir: Vec3 = [0, 0, 1];

      /*
       * A section that straddles the axis cannot be revolved, and has to be told so.
       *
       * The material on the far side sweeps through the same space as the material on the near
       * side, wound the other way, and the two cancel. What comes out is closed, manifold, and
       * has zero volume — a shape the viewport draws happily, the mass properties weigh at
       * nothing, and no downstream check objects to, because every one of them asks whether the
       * mesh is sound rather than whether it is a solid.
       */
      if (profileCrossesAxis(profile, plane, axisOrigin, axisDir)) {
        return {
          error:
            'The section crosses the axis, so revolving it would cancel itself out. '
            + 'Move it clear of the axis with "Offset from axis", or make it narrower.',
        };
      }

      const solid = revolve(profile, plane, {
        axisOrigin,
        axisDir,
        angleDeg: n('angle', 360),
        feature: f.id,
      });
      return combine(current, place(solid, f, doc), str(p, 'operation', 'add'));
    }

    /*
     * Loft: a solid through two sections on parallel planes.
     *
     * The operation every real CAD package has and this one did not expose, though the kernel
     * has done it correctly all along. It is what a round-to-square duct transition, a tapered
     * boss, a blended nacelle and an aerofoil section all are, and without it those parts can
     * only be approximated by a stack of prisms.
     *
     * Two sections rather than an arbitrary stack, because two is what covers the great
     * majority of real transitions and because a stack needs an editor of its own. Each
     * section is a full profile in its own right — shape, size and offset — so the sides can
     * lean as well as taper.
     */
    case 'loft': {
      const bottom = profileFrom(section(p, 'base'), doc);
      const top = profileFrom(section(p, 'top'), doc);
      if (!bottom || !top) return { error: 'A loft needs a section at each end.' };

      const height = n('height', 40);
      if (!(Math.abs(height) > 1e-6)) {
        return { error: 'A loft with no height between its sections has no volume.' };
      }

      const plane = planeOf(str(p, 'plane', 'XY'));
      const solid = loft({
        sections: [
          { profile: bottom, plane },
          { profile: top, plane: { ...plane, origin: add3(plane.origin, mul3(plane.normal, height)) } },
        ],
        subdivisions: Math.max(1, Math.round(n('subdivisions', 8))),
        feature: f.id,
      });
      return combine(current, place(solid, f, doc), str(p, 'operation', 'add'));
    }

    /*
     * Sweep: a profile driven along a path.
     *
     * Also already in the kernel, on rotation-minimising frames, and also unreachable. The
     * helix path is the reason this matters most: a spring, a worm, a screw thread and an
     * auger are all one profile on a helix, and none of them can be built from prisms and
     * revolves at all.
     */
    case 'sweep': {
      const profile = profileFrom(p, doc);
      if (!profile) return { error: 'This feature has no profile to sweep.' };

      const path = sweepPath(p, doc);
      if (!path) return { error: 'This sweep has no path to follow.' };

      const solid = sweep(profile, {
        path,
        twistDeg: n('twist', 0),
        endScale: n('endScale', 1),
        feature: f.id,
      });
      return combine(current, place(solid, f, doc), str(p, 'operation', 'add'));
    }

    /*
     * Holes, in the forms a drawing actually calls for.
     *
     * A plain through hole is the minority of holes on a real part. A cap screw needs a
     * counterbore so its head sits below the surface, a flat head needs a countersink at the
     * angle of the head, a screw into a blind boss needs a hole that stops, and a tapped hole
     * is drilled at the tapping size and not at the thread size. Modelling all of them as one
     * cylinder of the nominal diameter is wrong in a way that only shows up at assembly.
     *
     * Everything is cut from the top face downwards, because that is where a drill enters and
     * where every depth on a drawing is measured from.
     */
    case 'hole': {
      if (triCount(current) === 0) return { error: 'There is nothing to drill into yet.' };

      const bb = bounds(current);
      const top = bb.max[2];
      const span = bb.max[2] - bb.min[2];
      const kind = str(p, 'holeType', 'through');

      // A tapped hole is drilled at the tapping size, not at the thread size: an M6 tapped
      // hole is a 5 mm drill. Cutting it at 6 mm leaves no material for the thread to be cut
      // into, and the part looks right until someone tries to tap it.
      const nominal = n('diameter', 8);
      const r = (kind === 'tapped' ? tappingDrill(nominal) : nominal) / 2;

      // Overshoot past the surface so the cut resolves cleanly instead of leaving a film of
      // coincident faces where the tool ends exactly on the face it is cutting through.
      const OVER = 1;

      const positions = holePositions(p, doc);
      const tools: Mesh[] = [];

      for (const [x, y] of positions) {
        if (kind === 'blind' || kind === 'tapped') {
          const depth = Math.min(span, Math.max(0.1, n('depth', span / 2)));
          tools.push(cylinder(r, depth + OVER, [x, y, top + OVER / 2 - depth / 2], [0, 0, 1], f.id));
        } else {
          tools.push(cylinder(r, span * 3 + 20, [x, y, (bb.min[2] + bb.max[2]) / 2], [0, 0, 1], f.id));
        }

        if (kind === 'counterbore') {
          const cr = Math.max(r + 0.1, n('counterDiameter', nominal * 1.7) / 2);
          const cd = Math.max(0.1, n('counterDepth', nominal * 0.6));
          tools.push(cylinder(cr, cd + OVER, [x, y, top + OVER / 2 - cd / 2], [0, 0, 1], f.id));
        }

        if (kind === 'countersink') {
          const cr = Math.max(r + 0.1, n('counterDiameter', nominal * 2) / 2);
          // The depth follows from the head angle and the diameters — it is not a free number,
          // and offering it as one lets someone draw a countersink no drill could produce.
          const half = rad(Math.min(179, Math.max(1, n('counterAngle', 90))) / 2);
          const sink = (cr - r) / Math.tan(half);
          const lip = OVER * Math.tan(half);

          tools.push(cone(
            r, cr + lip, sink + OVER,
            [x, y, top + OVER / 2 - sink / 2], f.id,
          ));
        }
      }

      const cut = subtractAll(current, tools);
      return { mesh: cut.mesh, error: cut.valid ? undefined : cut.diagnostic };
    }

    /*
     * A rib: a thin wall standing on the part to stiffen it.
     *
     * The commonest feature on any moulded or cast component and one of the cheapest ways to
     * add stiffness — a wall of a given depth is far stiffer than the same material spread as
     * extra thickness. Built as a thin box standing on the top face and fused, which is what a
     * rib is; the alternative of asking the user to draw one as a sketch and extrude it is the
     * same geometry through four more steps.
     *
     * Drafted as it goes, because a rib with parallel sides cannot leave a mould, and the whole
     * reason a part has ribs rather than thick walls is usually that it is moulded.
     */
    case 'rib': {
      if (triCount(current) === 0) return { error: 'A rib needs something to stand on.' };

      const bb = bounds(current);
      const thickness = Math.max(0.2, n('thickness', 4));
      const height = Math.max(0.2, n('height', 20));
      const length = Math.max(0.2, n('length', (bb.max[0] - bb.min[0]) * 0.8));
      const draft = n('draft', 1);

      // Standing on the top face and reaching down into the part, so the fusion has real
      // overlap to work with rather than meeting it exactly at a plane.
      const base = bb.max[2] - Math.min(height / 2, 2);

      const profile = rectProfile(length, thickness, n('x', 0), n('y', 0), 0);
      const wall = extrude(profile, { ...XY, origin: [0, 0, base] }, {
        distance: height,
        draftDeg: -Math.abs(draft),
        feature: f.id,
      });

      return combine(current, place(wall, f, doc), 'add');
    }

    /*
     * Draft: taper the walls so the part can leave its mould.
     *
     * Every moulded and cast part has it, and its absence is the single most common reason a
     * design has to go back before tooling. Applied as an intersection with a tapered envelope
     * of the part's own footprint, which tapers the vertical walls and leaves the top and
     * bottom faces where they are.
     *
     * A positive angle narrows towards the top, which is the direction a part is drawn from a
     * cavity. Negative narrows downwards, for the other half of the tool.
     */
    case 'draft': {
      if (triCount(current) === 0) return { error: 'There is nothing to draft yet.' };

      const angle = n('angle', 2);
      if (Math.abs(angle) < 0.01) return { mesh: current };

      const bb = bounds(current);
      const span = bb.max[2] - bb.min[2];
      if (!(span > 1e-6)) return { error: 'The part has no height to taper along.' };

      /*
       * The envelope is lofted between two explicit rectangles rather than extruded with a
       * draft angle, so both ends are exactly the size intended.
       *
       * The first attempt extruded a footprint one and a half times the part's own and let the
       * draft narrow it. Over a 30 mm block a 3° taper pulls in 1.6 mm a side, against an
       * envelope 25 mm clear of the part on every side — so the intersection never touched the
       * walls and draft silently did nothing at all.
       */
      const cx = (bb.max[0] + bb.min[0]) / 2;
      const cy = (bb.max[1] + bb.min[1]) / 2;

      // Just clear of the part at the wide end, so the intersection there does not have to
      // resolve two coincident walls.
      const CLEAR = 0.25;
      const wide = span * Math.tan(rad(Math.abs(angle)));

      const bottomW = (bb.max[0] - bb.min[0]) + CLEAR * 2;
      const bottomD = (bb.max[1] - bb.min[1]) + CLEAR * 2;
      const narrow = Math.max(0.5, Math.min(bottomW, bottomD) - wide * 2);

      // A positive angle narrows towards the top, which is the direction a part is drawn from
      // a cavity. Negative narrows downwards, for the other half of the tool.
      const topW = angle > 0 ? bottomW - wide * 2 : bottomW;
      const topD = angle > 0 ? bottomD - wide * 2 : bottomD;
      const baseW = angle > 0 ? bottomW : bottomW - wide * 2;
      const baseD = angle > 0 ? bottomD : bottomD - wide * 2;

      if (Math.min(topW, topD, baseW, baseD, narrow) <= 0.5) {
        return {
          error: `A ${Math.abs(angle)}° taper over ${span.toFixed(1)} mm would close the part ` +
            'off entirely. Use a smaller angle.',
        };
      }

      const envelope = loft({
        sections: [
          { profile: rectProfile(baseW, baseD, cx, cy, 0), plane: { ...XY, origin: [0, 0, bb.min[2] - 0.5] } },
          { profile: rectProfile(topW, topD, cx, cy, 0), plane: { ...XY, origin: [0, 0, bb.max[2] + 0.5] } },
        ],
        subdivisions: 1,
        feature: f.id,
      });

      const kept = boolean(current, envelope, 'intersection');
      return { mesh: kept.mesh, error: kept.valid ? undefined : kept.diagnostic };
    }

    /*
     * Dome: bulge a flat face into a curved one.
     *
     * The face is refined and pushed out along its own normal by an elliptical profile — full
     * height at the centre, zero at the edge. Zero at the edge is the part that matters: those
     * boundary vertices are shared with the walls, so leaving them where they are keeps the
     * solid closed without any stitching.
     *
     * Elliptical over the face's own extent rather than spherical, so a dome on a long
     * rectangular face follows the rectangle instead of bulging a circle in the middle of it.
     */
    case 'dome': {
      if (triCount(current) === 0) return { error: 'There is nothing to dome yet.' };

      const height = n('height', 10);
      if (Math.abs(height) < 1e-6) return { mesh: current };

      const up = str(p, 'face', 'top') !== 'bottom';
      const direction: Vec3 = up ? [0, 0, 1] : [0, 0, -1];

      /*
       * How much to refine, bounded by what the solid already costs.
       *
       * Subdivision splits *every* triangle — it has to, or the mesh develops T-junctions and
       * stops being closed. So the price is set by the whole part, not by the face being
       * domed, and asking for a fixed four levels regardless took a tessellated sphere from
       * 3 800 triangles to 242 000 to raise a bump worth a third of a percent of its volume.
       *
       * The budget is a ceiling on the finished mesh rather than a fixed number of levels: a
       * box has twelve triangles and can afford to be refined a great deal, and something
       * already dense cannot afford much at all. Where the budget allows nothing, the existing
       * vertices are displaced as they are — coarse, but a valid solid, and honest about it.
       */
      const BUDGET = 60_000;
      const affordable = Math.floor(Math.log(BUDGET / Math.max(1, triCount(current))) / Math.log(4));
      const asked = Math.round(n('smoothness', 4));
      const levels = Math.max(0, Math.min(5, asked, affordable));

      const fine = levels > 0 ? subdivide(current, levels) : current;
      const faces = facesFacing(fine, direction, 10);
      if (faces.size === 0) {
        return {
          error: `No flat face points ${up ? 'up' : 'down'}, so there is nothing to dome. `
            + 'A dome needs somewhere flat to grow out of.',
        };
      }

      // The extent of the faces being domed, so the profile spans exactly them.
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let t = 0; t < triCount(fine); t++) {
        if (!faces.has(fine.faceIds[t]!)) continue;
        for (const v of getTriangle(fine, t)) {
          minX = Math.min(minX, v[0]); maxX = Math.max(maxX, v[0]);
          minY = Math.min(minY, v[1]); maxY = Math.max(maxY, v[1]);
        }
      }

      const halfX = Math.max(1e-6, (maxX - minX) / 2);
      const halfY = Math.max(1e-6, (maxY - minY) / 2);
      const cx = (maxX + minX) / 2;
      const cy = (maxY + minY) / 2;

      const domed = displaceFaces(fine, faces, direction, (point) => {
        const u = (point[0] - cx) / halfX;
        const v = (point[1] - cy) / halfY;
        const r2 = u * u + v * v;
        return r2 >= 1 ? 0 : Math.abs(height) * Math.sqrt(1 - r2);
      });

      return { mesh: domed };
    }

    /*
     * Split: cut the solid into two bodies with a plane.
     *
     * Both halves are kept rather than one being thrown away, because that is what the
     * operation is for — a moulded housing separated into its two shells, a casting parted at
     * its parting line. They come back as distinct bodies, so each gets its own colour and its
     * own line in the bill of materials.
     */
    case 'split': {
      if (triCount(current) === 0) return { error: 'There is nothing to split yet.' };

      const bb = bounds(current);
      const axis = str(p, 'plane', 'YZ');
      const index = axis === 'XY' ? 2 : axis === 'XZ' ? 1 : 0;

      const lo = bb.min[index]!;
      const hi = bb.max[index]!;
      const at = lo + (hi - lo) * Math.min(0.99, Math.max(0.01, n('at', 0.5)));

      // A cutter big enough to cover the part in the two directions it does not divide.
      const pad = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], hi - lo) + 20;
      const size: Vec3 = [pad, pad, pad];
      const centre: Vec3 = [
        (bb.max[0] + bb.min[0]) / 2, (bb.max[1] + bb.min[1]) / 2, (bb.max[2] + bb.min[2]) / 2,
      ];

      size[index] = (at - lo) + 10;
      centre[index] = at - size[index] / 2;

      const cutter = box(size[0], size[1], size[2], centre, f.id);

      const keep = str(p, 'keep', 'both');
      const near = boolean(current, cutter, 'intersection');
      const far = boolean(current, cutter, 'difference');

      if (!near.valid || !far.valid) {
        return { mesh: current, error: near.diagnostic ?? far.diagnostic };
      }

      if (keep === 'first') return { mesh: near.mesh };
      if (keep === 'second') return { mesh: far.mesh };
      return { mesh: concatMeshes([near.mesh, far.mesh]) };
    }

    /*
     * Datum: a reference plane, and nothing else.
     *
     * It builds no geometry. It exists so a sketch or an extrude can be placed somewhere other
     * than Top, Front or Right. Sketching on a model face already covers the common case; this
     * covers the one it cannot, which is a plane offset from or tilted relative to anything
     * that exists yet.
     */
    case 'datum':
      return { mesh: current };

    /*
     * Wrap: a band of features rolled around the part, embossed or engraved.
     *
     * What people reach for wrap to do on a round part is knurling, a gripping pattern, a
     * retaining groove, or a ring of slots or flats — all of them the same shape repeated
     * around an axis at a constant radius. That is what this builds.
     *
     * It is not the general operation. Wrapping arbitrary *text* onto a cone, or a sketch onto
     * a doubly-curved surface, needs a surface parameterisation this kernel does not carry, and
     * the honest thing is to build the case that covers most of the use rather than to
     * approximate the rest badly. The limitation is in the manual.
     *
     * Each tooth is placed by rotating one cutter about Z, so the pattern is exactly regular
     * and the count is exactly what was asked for.
     */
    case 'wrap': {
      if (triCount(current) === 0) return { error: 'There is nothing to wrap around yet.' };

      const bb = bounds(current);
      const count = Math.max(1, Math.min(240, Math.round(n('count', 24))));
      const depth = Math.max(0.05, n('depth', 1.5));
      const height = Math.max(0.1, n('height', (bb.max[2] - bb.min[2]) * 0.6));
      const teethWidth = Math.max(0.05, n('width', 2));
      const z = n('z', (bb.max[2] + bb.min[2]) / 2);

      // The radius the band sits at: taken from the part unless it was given, so the common
      // case needs no measuring.
      const measured = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]) / 2;
      const radius = n('radius', measured);
      if (!(radius > 0)) return { error: 'The wrap radius has to be greater than zero.' };

      const engrave = str(p, 'operation', 'cut') !== 'add';

      // One tooth, standing at the radius on the +X side, then turned into place.
      const tools: Mesh[] = [];
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;

        // Straddling the surface, so an engraved tooth bites in and an embossed one lands on
        // it rather than floating a hair away.
        const centre: Vec3 = [radius, 0, z];
        const tooth = box(depth * 2, teethWidth, height, centre, f.id);
        tools.push(transformMesh(tooth, rotation([0, 0, 1], angle)));
      }

      if (engrave) {
        const cut = subtractAll(current, tools);
        return { mesh: cut.mesh, error: cut.valid ? undefined : cut.diagnostic };
      }

      let out = current;
      for (const tool of tools) {
        const fused = boolean(out, tool, 'union');
        if (!fused.valid) return { mesh: out, error: fused.diagnostic };
        out = fused.mesh;
      }
      return { mesh: out };
    }

    /*
     * A folded sheet part: flats joined by bends.
     *
     * Built as a chain in the XZ plane and extruded across, which is what a folded part is —
     * a profile of constant thickness swept along the width of the sheet. Each bend is a run of
     * short segments round the inside radius, so the corner is a real radius rather than a
     * knife edge, because a press brake cannot produce one and a model that shows one lies about
     * what will arrive.
     *
     * The flat pattern lives in `domain/sheetmetal.ts` and is the half that decides whether the
     * part comes back the right length. This is the half you can look at.
     */
    case 'sheet': {
      const thickness = Math.max(0.1, n('thickness', 2));
      const width = Math.max(1, n('width', 60));
      const radius = Math.max(0.01, n('radius', thickness));

      const shape = str(p, 'shape', 'angle');
      const a = Math.max(0.1, n('flangeA', 60));
      const b = Math.max(0.1, n('flangeB', 40));
      const c = Math.max(0.1, n('flangeC', 40));
      const angle = n('angle', 90);

      // The chain of flats and the turns between them, as a sequence of directions.
      const legs = shape === 'channel' ? [b, a, c] : shape === 'z' ? [b, a, c] : [a, b];
      const turns = shape === 'channel' ? [angle, angle]
        : shape === 'z' ? [angle, -angle]
          : [angle];

      // Walk the centreline of the sheet, turning at each bend, and record the path.
      const path: Vec2[] = [];
      let x = 0, y = 0, heading = 0;

      const step = (distance: number) => {
        x += Math.cos(heading) * distance;
        y += Math.sin(heading) * distance;
        path.push([x, y]);
      };

      path.push([0, 0]);
      for (let i = 0; i < legs.length; i++) {
        // The straight part is shorter than the flange by the setback the bend takes up.
        const before = i > 0 ? setbackOf(turns[i - 1] ?? 0, radius, thickness) : 0;
        const after = i < turns.length ? setbackOf(turns[i] ?? 0, radius, thickness) : 0;
        step(Math.max(0.05, (legs[i] ?? 0) - before - after));

        const turn = turns[i];
        if (turn === undefined) continue;

        // The bend itself, as an arc of the centreline.
        const sweep = rad(turn);
        const centreRadius = radius + thickness / 2;
        const SEGMENTS = 8;
        for (let k = 1; k <= SEGMENTS; k++) {
          const part = sweep / SEGMENTS;
          heading += part;
          x += Math.cos(heading) * centreRadius * Math.abs(part);
          y += Math.sin(heading) * centreRadius * Math.abs(part);
          path.push([x, y]);
        }
      }

      if (path.length < 2) return { error: 'That sheet part has no length to fold.' };

      // Offset the centreline both ways by half the thickness to get the closed section.
      const outline = ribbon(path, thickness / 2);
      if (outline.length < 3) return { error: 'The folds overlap — use a smaller flange or radius.' };

      const points: number[] = [];
      for (const [px_, py_] of outline) points.push(px_, py_);

      const solid = extrude(
        makeProfile(outline),
        { ...XZ, origin: [0, width / 2, 0] },
        { distance: width, feature: f.id },
      );
      void points;

      return combine(current, place(solid, f, doc), str(p, 'operation', 'add'));
    }

    case 'pocket': {
      if (triCount(current) === 0) return { error: 'There is nothing to pocket yet.' };
      const bb = bounds(current);
      const depth = n('depth', 5);

      const tool = extrude(
        rectProfile(n('length', 30), n('width', 20), n('x', 0), n('y', 0), n('cornerRadius', 0)),
        { ...XY, origin: [0, 0, bb.max[2] - depth] },
        { distance: depth + 1, feature: f.id },
      );
      const cut = boolean(current, tool, 'difference');
      return { mesh: cut.mesh, error: cut.valid ? undefined : cut.diagnostic };
    }

    case 'slot': {
      if (triCount(current) === 0) return { error: 'There is nothing to cut a slot into yet.' };
      const bb = bounds(current);

      const tool = extrude(
        slotProfile(n('length', 30), n('width', 8), n('x', 0), n('y', 0), rad(n('angle', 0))),
        { ...XY, origin: [0, 0, bb.min[2] - 1] },
        { distance: bb.max[2] - bb.min[2] + 2, feature: f.id },
      );
      const cut = boolean(current, tool, 'difference');
      return { mesh: cut.mesh, error: cut.valid ? undefined : cut.diagnostic };
    }

    case 'fillet': {
      if (triCount(current) === 0) return { error: 'There is nothing to round yet.' };
      const r = filletEdges(current, {
        radius: n('radius', 3),
        minAngleDeg: n('minAngle', 30),
        faces: faceList(p),
        faceMatch: str(p, 'faceMatch', 'bounding') === 'between' ? 'between' : 'bounding',
        convexity: convexity(p),
        feature: f.id,
      });
      return { mesh: r.mesh, warning: r.diagnostic };
    }

    case 'chamfer': {
      if (triCount(current) === 0) return { error: 'There is nothing to chamfer yet.' };
      // Chamfer takes no convexity: it only ever applies to convex edges, because cutting a
      // concave one would add material rather than remove it.
      const r = chamferEdges(current, {
        distance: n('distance', 2),
        minAngleDeg: n('minAngle', 30),
        faces: faceList(p),
        faceMatch: str(p, 'faceMatch', 'bounding') === 'between' ? 'between' : 'bounding',
        feature: f.id,
      });
      return { mesh: r.mesh, warning: r.diagnostic };
    }

    case 'shell': {
      if (triCount(current) === 0) return { error: 'There is nothing to hollow yet.' };
      const r = shell(current, { thickness: n('thickness', 2), feature: f.id });
      return { mesh: r.mesh, error: r.valid ? undefined : r.diagnostic };
    }

    case 'patternLinear': {
      if (triCount(current) === 0) return { error: 'There is nothing to pattern yet.' };
      const r = linearPattern(current, {
        direction: [n('dx', 1), n('dy', 0), n('dz', 0)],
        spacing: n('spacing', 30),
        count: Math.round(n('count', 3)),
        feature: f.id,
      });
      return { mesh: r.mesh, warning: r.diagnostic };
    }

    case 'patternCircular': {
      if (triCount(current) === 0) return { error: 'There is nothing to pattern yet.' };
      const r = circularPattern(current, {
        axisOrigin: [n('cx', 0), n('cy', 0), 0],
        axisDir: [0, 0, 1],
        count: Math.round(n('count', 6)),
        angleDeg: n('angle', 360),
        feature: f.id,
      });
      return { mesh: r.mesh, warning: r.diagnostic };
    }

    case 'mirror': {
      if (triCount(current) === 0) return { error: 'There is nothing to mirror yet.' };
      const plane = str(p, 'plane', 'YZ');
      const normal: Vec3 = plane === 'XZ' ? [0, 1, 0] : plane === 'XY' ? [0, 0, 1] : [1, 0, 0];
      const r = mirrorBody(current, [0, 0, 0], normal, true);
      return { mesh: r.mesh, warning: r.diagnostic };
    }

    case 'imported': {
      const raw = p.__mesh as unknown;
      if (!raw || typeof raw !== 'object') return { error: 'The imported geometry is missing.' };
      const imported = retag(raw as Mesh, f.id);
      return combine(current, place(imported, f, doc), str(p, 'operation', 'add'));
    }
  }
}

/**
 * Moves a feature's own geometry into place.
 *
 * Applied to the solid the feature built, *before* it is merged into the running model.
 *
 * The obvious alternative — merge first, then transform whatever was added — is what this
 * replaced, and it was wrong in a way that took a while to see. Identifying "what was added"
 * meant slicing the result by triangle range, and those slices share one positions array, so
 * transforming the newest slice also moved every vertex placed before it. Each component
 * landed at its own offset plus the sum of all previous offsets, and a 163 mm phone came out
 * 715 mm long.
 */
function place(solid: Mesh, feature: Feature, doc?: Document): Mesh {
  const p = doc ? resolvedPlacement(feature, doc) : feature.placement;
  if (!p || isIdentity(p)) return solid;
  return transformMesh(solid, placementMatrix(p));
}

/**
 * A feature's placement with its driven axes worked out.
 *
 * An expression that cannot be resolved leaves that axis at its stored number rather than
 * dropping the part to the origin. A broken parameter should show up as a diagnostic, not as
 * geometry silently collapsing into a heap at the middle of the model.
 */
export function resolvedPlacement(feature: Feature, doc: Document): Placement | undefined {
  const base = feature.placement;
  const driven = feature.placementExpr;
  if (!driven) return base;

  const values = parametersOf(doc);
  const out: Placement = { ...(base ?? IDENTITY_PLACEMENT) };

  for (const axis of ['x', 'y', 'z', 'rx', 'ry', 'rz'] as const) {
    const src = driven[axis];
    if (!src) continue;
    const r = readNumber(src, values, out[axis]);
    if (!r.error) out[axis] = r.value;
  }

  return out;
}

/** Which placement axes are driven by an expression that does not resolve. */
export function placementProblems(feature: Feature, doc: Document): string[] {
  const driven = feature.placementExpr;
  if (!driven) return [];

  const values = parametersOf(doc);
  const out: string[] = [];
  for (const axis of ['x', 'y', 'z', 'rx', 'ry', 'rz'] as const) {
    const src = driven[axis];
    if (!src) continue;
    const r = readNumber(src, values, 0);
    if (r.error) out.push(`${axis}: ${r.error}`);
  }
  return out;
}

// A mirror is never identity, however zero the rest of the placement is.
const isIdentity = (p: Placement) =>
  !p.mirror && p.x === 0 && p.y === 0 && p.z === 0 && p.rx === 0 && p.ry === 0 && p.rz === 0;

/** The transform a placement applies: rotate about Z, then Y, then X, then translate. */
export function placementMatrix(p: Placement): Mat4 {
  const rotate = matMul(
    rotation([0, 0, 1], rad(p.rz)),
    matMul(rotation([0, 1, 0], rad(p.ry)), rotation([1, 0, 0], rad(p.rx))),
  );

  // Innermost, so the body is reflected in its own frame and then oriented and moved. Applied
  // after the rotation it would reflect the placed body about a world plane instead, which
  // moves the part as well as flipping it.
  const oriented = p.mirror
    ? matMul(rotate, reflection([0, 0, 0], MIRROR_NORMAL[p.mirror]))
    : rotate;

  return matMul(translation([p.x, p.y, p.z]), oriented);
}

const MIRROR_NORMAL: Record<'x' | 'y' | 'z', Vec3> = {
  x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1],
};

/**
 * Takes a mesh from world coordinates back into a feature's own.
 *
 * The inverse is built from negated angles in reverse order rather than by inverting the
 * matrix numerically: a placement is a rigid motion, so its inverse is exact in closed form,
 * and a numerically inverted matrix would accumulate error every time a body is taken out and
 * put back — which happens once per cut.
 */
export function unplaceMesh(solid: Mesh, feature: Feature, doc: Document): Mesh {
  const p = resolvedPlacement(feature, doc);
  if (!p || isIdentity(p)) return solid;

  const unrotate = matMul(
    matMul(rotation([1, 0, 0], rad(-p.rx)), rotation([0, 1, 0], rad(-p.ry))),
    rotation([0, 0, 1], rad(-p.rz)),
  );

  // A reflection is its own inverse, so undoing it is the same matrix — but it has to come
  // last here, mirroring the fact that it came first going the other way.
  const unoriented = p.mirror
    ? matMul(reflection([0, 0, 0], MIRROR_NORMAL[p.mirror]), unrotate)
    : unrotate;

  return transformMesh(solid, matMul(unoriented, translation([-p.x, -p.y, -p.z])));
}

/** Applies a feature's placement to a mesh, resolving any driven axes. */
export function placeMesh(solid: Mesh, feature: Feature, doc: Document): Mesh {
  return place(solid, feature, doc);
}

/**
 * The faces a fillet or chamfer is scoped to.
 *
 * Empty means the whole body, which is the right default for a first attempt on a simple
 * part and the wrong one on anything complex — rounding every edge of a thirty-feature
 * assembly is slow and almost never what was wanted. Clicking a face in the viewport fills
 * this in.
 */
export function faceList(params: Record<string, ParamValue>): number[] | undefined {
  const raw = params.faces;
  if (!Array.isArray(raw)) return undefined;

  // Face tags are non-negative integers. A list can arrive from a saved file or from a
  // language model, so anything else is filtered rather than trusted — a fractional id
  // matches no face and would quietly reduce the scope instead of failing.
  const ids = raw.filter(
    (v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0,
  );
  return ids.length > 0 ? ids : undefined;
}

/**
 * Which edges a fillet applies to: outside, inside, or both.
 *
 * Worth exposing rather than always doing both, because the two are different design intents.
 * A bracket's inside fillet carries load and its size is a strength decision; rounding the
 * outside edges is cosmetic and handling. Applying one when the other was asked for produces
 * a part that looks right and is not.
 */
function convexity(params: Record<string, ParamValue>): 'convex' | 'concave' | undefined {
  const raw = params.convexity;
  return raw === 'convex' || raw === 'concave' ? raw : undefined;
}

function combine(current: Mesh, solid: Mesh, operation: string): FeatureResult {
  if (triCount(current) === 0) return { mesh: solid };

  // "place" adds the body without fusing it.
  //
  // This is what an assembly component wants, and it is not an optimisation. A phone's
  // battery is not welded to its chassis and a wheel is not welded to a car; they are
  // separate bodies that occupy the same space. Unioning them is wrong on three counts: it
  // makes one part where there were several, it destroys the per-component mass breakdown,
  // and it asks the boolean engine to resolve dozens of deep overlaps it has no reason to
  // touch — which on a thirteen-component phone fragmented the mesh until a 1.2 mm speaker
  // port exhausted the interpreter's stack.
  if (operation === 'place') return { mesh: concatMeshes([current, solid]) };

  const op = operation === 'cut' ? 'difference' : operation === 'intersect' ? 'intersection' : 'union';
  const r = boolean(current, solid, op);
  return { mesh: r.mesh, error: r.valid ? undefined : r.diagnostic };
}

/** Rewrites every face tag's owning feature, so archetype and imported geometry joins the tree. */
function retag(mesh: Mesh, featureId: string): Mesh {
  const tags = new Map(mesh.tags);
  for (const [id, tag] of tags) tags.set(id, { ...tag, feature: featureId });
  return { ...mesh, tags };
}

/** Reads a flat `[x0, y0, x1, y1, ...]` run as points. */
function pairs(flat: number[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

/**
 * One end of a loft, read out of the feature's own parameters.
 *
 * `baseShape`/`baseDiameter`/… are rewritten to `shape`/`diameter`/… so both ends go through
 * exactly the same profile builder as every other feature. Two parallel profile readers that
 * drift apart is how a circle ends up meaning one thing at the bottom of a loft and another
 * at the top.
 */
function section(p: Record<string, ParamValue>, prefix: string): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [key, value] of Object.entries(p)) {
    if (!key.startsWith(prefix) || key.length === prefix.length) continue;
    out[key[prefix.length]!.toLowerCase() + key.slice(prefix.length + 1)] = value;
  }
  return out;
}

/**
 * The curve a sweep follows.
 *
 * A helix is interpolated rather than expressed exactly, because a helix is not a rational
 * curve and no NURBS of any degree is one. Sampling it densely and interpolating is the
 * standard construction; the error is bounded by the sample spacing, which is why the number
 * of samples is tied to the number of turns rather than fixed.
 */
function sweepPath(p: Record<string, ParamValue>, doc: Document): NurbsCurve | null {
  const n = (key: string, fallback: number) => num(doc, p, key, fallback);
  const kind = str(p, 'path', 'line');

  if (kind === 'helix') {
    const radius = n('pathRadius', 30);
    const turns = n('turns', 4);
    const pitch = n('pitch', 12);
    if (!(radius > 0) || !(Math.abs(turns) > 1e-6)) return null;

    const perTurn = 48;
    const count = Math.max(8, Math.min(4000, Math.round(Math.abs(turns) * perTurn)));
    const pts: Vec3[] = [];
    for (let i = 0; i <= count; i++) {
      const t = (i / count) * turns * 2 * Math.PI;
      pts.push([radius * Math.cos(t), radius * Math.sin(t), (t / (2 * Math.PI)) * pitch]);
    }
    return interpolateCurve(pts, 3);
  }

  if (kind === 'arc') {
    const radius = n('pathRadius', 60);
    const sweepDeg = n('pathAngle', 90);
    if (!(radius > 0) || !(Math.abs(sweepDeg) > 1e-6)) return null;

    // Interpolated, not `arcToNurbs`, so the path starts at the origin pointing along +Z —
    // the same place and direction a straight path starts. A sweep whose path jumps somewhere
    // else the moment you change its shape is not an editable feature.
    const count = Math.max(8, Math.round(Math.abs(sweepDeg) / 3));
    const pts: Vec3[] = [];
    for (let i = 0; i <= count; i++) {
      const a = rad((sweepDeg * i) / count);
      pts.push([radius * (1 - Math.cos(a)), 0, radius * Math.sin(a)]);
    }
    return interpolateCurve(pts, 3);
  }

  const distance = n('distance', 80);
  if (!(Math.abs(distance) > 1e-6)) return null;
  return lineToNurbs([0, 0, 0], [0, 0, distance]);
}

function profileFrom(p: Record<string, ParamValue>, doc: Document): Profile | null {
  const shape = str(p, 'shape', 'rect');
  const n = (key: string, fallback: number) => num(doc, p, key, fallback);

  switch (shape) {
    case 'circle': return circleProfile(n('diameter', 40) / 2, n('x', 0), n('y', 0));
    case 'polygon': return polygonProfile(Math.round(n('sides', 6)), n('diameter', 40) / 2, n('x', 0), n('y', 0));
    case 'slot': return slotProfile(n('length', 40), n('width', 12), n('x', 0), n('y', 0), rad(n('angle', 0)));
    case 'points': {
      const pts = p.points;
      if (!Array.isArray(pts) || pts.length < 6) return null;

      const loop = pairs(pts);

      // Holes travel as one flat run of coordinates plus a list of how many points each
      // loop has.
      //
      // A parameter is a number, a string, a boolean or a flat array of numbers, and that
      // constraint is what keeps documents plain JSON that serialises, validates and edits
      // without special cases. Nesting arrays to carry hole loops would have leaked through
      // all three. Flattening them costs one index walk here and nothing anywhere else.
      const holeRuns = p.holePoints;
      const holeSizes = p.holeLengths;

      const holes: Vec2[][] = [];
      if (Array.isArray(holeRuns) && Array.isArray(holeSizes)) {
        let at = 0;
        for (const count of holeSizes) {
          const take = Math.max(0, Math.round(count)) * 2;
          if (at + take > holeRuns.length) break;
          const hole = pairs(holeRuns.slice(at, at + take));
          if (hole.length >= 3) holes.push(hole);
          at += take;
        }
      }

      // A traced profile has to stay rescalable. A picture carries no scale, so the trace
      // assumes one and says so — and until this existed the advice was impossible to act on:
      // the editor showed Length and Width, both of which a point list ignores, so the only
      // thing a picture could ever produce was a part 100 mm across.
      //
      // `tracedWidth` is the width the points were built at. Scaling to `width` is done about
      // the profile's own centre so correcting the scale does not also walk the part off the
      // origin.
      const natural = n('tracedWidth', 0);
      const wanted = n('width', 0);
      if (natural > 0 && wanted > 0 && Math.abs(wanted - natural) > 1e-9) {
        const k = wanted / natural;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const [x, y] of loop) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const scale = (ring: Vec2[]): Vec2[] =>
          ring.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k] as Vec2);

        return makeProfile(scale(loop), holes.map(scale));
      }

      return makeProfile(loop, holes);
    }
    default:
      return rectProfile(n('length', 60), n('width', 40), n('x', 0), n('y', 0), n('cornerRadius', 0));
  }
}

export function holePositions(p: Record<string, ParamValue>, doc: Document): Vec2[] {
  const n = (key: string, fallback: number) => num(doc, p, key, fallback);
  const pattern = str(p, 'pattern', 'single');

  if (pattern === 'boltCircle') {
    const count = Math.max(1, Math.round(n('count', 6)));
    const r = n('boltCircle', 100) / 2;
    return Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2;
      return [n('cx', 0) + r * Math.cos(a), n('cy', 0) + r * Math.sin(a)] as Vec2;
    });
  }

  if (pattern === 'grid') {
    const cols = Math.max(1, Math.round(n('cols', 2)));
    const rows = Math.max(1, Math.round(n('rows', 2)));
    const sx = n('spacingX', 40), sy = n('spacingY', 40);
    const out: Vec2[] = [];
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        out.push([n('cx', 0) + (i - (cols - 1) / 2) * sx, n('cy', 0) + (j - (rows - 1) / 2) * sy]);
      }
    }
    return out;
  }

  return [[n('x', 0), n('y', 0)]];
}

// ── edges for display ────────────────────────────────────────────────────────

/**
 * Sharp edges as a flat line list.
 *
 * A shaded solid with no edges reads as a blob — the eye needs the outline to resolve the
 * form, which is why every CAD viewport draws them. The crease angle is deliberately higher
 * than the kernel's default: at 20 degrees a tessellated cylinder shows every one of its
 * facet seams and looks like a barrel made of staves.
 */
export function extractEdges(mesh: Mesh, creaseDeg = 25): Float32Array {
  if (triCount(mesh) === 0) return new Float32Array(0);

  const edges = sharpEdges(mesh, creaseDeg);
  const out = new Float32Array(edges.length * 6);

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    out[i * 6] = e.a[0]; out[i * 6 + 1] = e.a[1]; out[i * 6 + 2] = e.a[2];
    out[i * 6 + 3] = e.b[0]; out[i * 6 + 4] = e.b[1]; out[i * 6 + 5] = e.b[2];
  }
  return out;
}

// ── tree editing ─────────────────────────────────────────────────────────────

export function addFeature(
  doc: Document, kind: FeatureKind, params: Record<string, ParamValue> = {},
  name?: string,
  extra?: { placement?: Placement; role?: string; placementExpr?: Feature['placementExpr'] },
): Document {
  const feature: Feature = {
    id: newFeatureId(),
    name: name ?? defaultName(kind, doc),
    kind,
    params,
    suppressed: false,
    ...extra,
  };
  return { ...doc, features: [...doc.features, feature] };
}

export function setPlacement(doc: Document, id: string, placement: Partial<Placement>): Document {
  return {
    ...doc,
    features: doc.features.map((f) =>
      f.id === id
        ? { ...f, placement: { ...IDENTITY_PLACEMENT, ...f.placement, ...placement } }
        : f,
    ),
  };
}

export function updateFeature(doc: Document, id: string, params: Record<string, ParamValue>): Document {
  return {
    ...doc,
    features: doc.features.map((f) => (f.id === id ? { ...f, params: { ...f.params, ...params } } : f)),
  };
}

/**
 * Moves or turns a feature, leaving its shape alone.
 *
 * Placement is kept apart from the shape's own parameters on purpose — a part is moved to fit
 * an assembly and resized to meet a requirement, and they are different decisions — so it
 * needs its own way in. Without one there was no way to move anything at all: the tree could
 * resize a part and the viewport could only move the camera.
 */
export function placeFeature(doc: Document, id: string, delta: Partial<Placement>): Document {
  return {
    ...doc,
    features: doc.features.map((f) => (f.id === id
      ? { ...f, placement: { ...IDENTITY_PLACEMENT, ...f.placement, ...delta } }
      : f)),
  };
}

export function renameFeature(doc: Document, id: string, name: string): Document {
  return { ...doc, features: doc.features.map((f) => (f.id === id ? { ...f, name } : f)) };
}

export function deleteFeature(doc: Document, id: string): Document {
  return { ...doc, features: doc.features.filter((f) => f.id !== id) };
}

export function setSuppressed(doc: Document, id: string, suppressed: boolean): Document {
  return { ...doc, features: doc.features.map((f) => (f.id === id ? { ...f, suppressed } : f)) };
}

/**
 * Moves a feature in the tree.
 *
 * Order is the whole meaning of a feature tree — a fillet before the hole it should round
 * does nothing — so reordering is a real edit that triggers a full rebuild, not a cosmetic
 * list operation.
 */
export function moveFeature(doc: Document, id: string, delta: number): Document {
  const index = doc.features.findIndex((f) => f.id === id);
  if (index < 0) return doc;

  const target = Math.max(0, Math.min(doc.features.length - 1, index + delta));
  if (target === index) return doc;

  const features = [...doc.features];
  const [moved] = features.splice(index, 1);
  features.splice(target, 0, moved);
  return { ...doc, features };
}

const KIND_LABEL: Record<FeatureKind, string> = {
  archetype: 'Shape',
  box: 'Box', cylinder: 'Cylinder', sphere: 'Sphere',
  sketch: 'Sketch',
  extrude: 'Extrude', revolve: 'Revolve', loft: 'Loft', sweep: 'Sweep',
  rib: 'Rib', draft: 'Draft', dome: 'Dome', split: 'Split', datum: 'Datum',
  wrap: 'Wrap', sheet: 'Sheet metal',
  hole: 'Hole', pocket: 'Pocket', slot: 'Slot',
  fillet: 'Fillet', chamfer: 'Chamfer', shell: 'Shell',
  patternLinear: 'LinearPattern', patternCircular: 'CircularPattern', mirror: 'Mirror',
  imported: 'Imported',
};

function defaultName(kind: FeatureKind, doc: Document): string {
  const base = KIND_LABEL[kind];
  const used = doc.features.filter((f) => f.kind === kind).length;
  return `${base}${used + 1}`;
}

export const featureLabel = (kind: FeatureKind): string => KIND_LABEL[kind];

// ── parameter descriptions ───────────────────────────────────────────────────

export interface ParamField {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  kind: 'number' | 'choice';
  choices?: { value: string; label: string }[];
}

/**
 * The editable parameters for a feature kind.
 *
 * Drives the editor UI. Ranges are real limits rather than decoration: a negative wall
 * thickness or a 400-instance pattern will produce something the kernel refuses to build,
 * and it is better to stop it at the slider than to explain the failure afterwards.
 */
export function paramFields(
  kind: FeatureKind, params?: Record<string, ParamValue>, doc?: Document,
): ParamField[] {
  const N = (key: string, label: string, min: number, max: number, step = 0.5, unit = 'mm'): ParamField =>
    ({ key, label, unit, min, max, step, kind: 'number' });

  const OPERATION: ParamField = {
    key: 'operation', label: 'Operation', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
    choices: [
      { value: 'add', label: 'Add material' },
      { value: 'cut', label: 'Remove material' },
      { value: 'intersect', label: 'Keep the overlap' },
    ],
  };

  // The three standard planes, plus whatever datums the document actually has. Offered rather
  // than typed, because a reference nobody can see the vocabulary of is one nobody uses.
  const datums = doc ? datumsIn(doc) : [];
  const PLANE: ParamField = {
    key: 'plane', label: 'Plane', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
    choices: [
      { value: 'XY', label: 'Top (XY)' },
      { value: 'XZ', label: 'Front (XZ)' },
      { value: 'YZ', label: 'Right (YZ)' },
      ...(datums.length > 0 ? [{ value: 'datum', label: 'A datum plane' }] : []),
    ],
  };

  const DATUM_REF: ParamField[] = datums.length > 0 && params && str(params, 'plane', '') === 'datum'
    ? [{
        key: 'datumRef', label: 'Which datum', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
        choices: datums.map((d) => ({ value: referenceName(d.name), label: d.name })),
      }]
    : [];

  switch (kind) {
    case 'box':
      return [N('length', 'Length', 1, 2000), N('width', 'Width', 1, 2000), N('height', 'Height', 1, 2000),
        N('x', 'Centre X', -1000, 1000), N('y', 'Centre Y', -1000, 1000),
        N('round', 'Edge break', 0, 200, 0.25), OPERATION];
    case 'cylinder':
      return [N('diameter', 'Diameter', 1, 2000), N('height', 'Height', 1, 2000),
        N('x', 'Centre X', -1000, 1000), N('y', 'Centre Y', -1000, 1000),
        N('round', 'Edge break', 0, 200, 0.25), OPERATION];
    case 'sphere':
      return [N('diameter', 'Diameter', 1, 2000), N('x', 'Centre X', -1000, 1000),
        N('y', 'Centre Y', -1000, 1000), N('z', 'Centre Z', -1000, 1000), OPERATION];
    case 'sketch':
      // No Length or Width: a sketch's size comes from its constraints, and offering a box to
      // type into beside them would be two competing ways to say the same thing.
      return [PLANE, ...DATUM_REF, N('distance', 'Thickness', 0.1, 2000),
        N('draft', 'Draft', -20, 20, 0.5, 'deg'), OPERATION];

    case 'extrude':
      // A traced or imported outline is a point list, so Length, Width and Corner radius have
      // nothing to act on — showing them offered edits that silently did nothing. What such a
      // profile does need is an overall width, because the picture it came from had no scale.
      if (params && str(params, 'shape', 'rect') === 'points') {
        return [N('width', 'Overall width', 1, 5000, 0.5), N('distance', 'Thickness', 0.1, 2000),
          N('draft', 'Draft', -20, 20, 0.5, 'deg'), OPERATION];
      }
      return [PLANE, ...DATUM_REF, N('length', 'Length', 1, 2000), N('width', 'Width', 1, 2000),
        N('cornerRadius', 'Corner radius', 0, 200), N('distance', 'Distance', 0.1, 2000),
        N('draft', 'Draft', -20, 20, 0.5, 'deg'), OPERATION];
    case 'revolve':
      return [PLANE, N('length', 'Section length', 1, 500), N('width', 'Section width', 1, 500),
        N('x', 'Offset from axis', 0, 1000), N('angle', 'Angle', 1, 360, 1, 'deg'), OPERATION];
    case 'loft': {
      // Each end shows only the dimensions its own shape uses. A circle has no width, and
      // offering one is an edit that silently does nothing — the same defect the traced
      // extrude had.
      const ends = (prefix: string, label: string): ParamField[] => {
        const shape = params ? str(params, `${prefix}Shape`, 'rect') : 'rect';
        const choice: ParamField = {
          key: `${prefix}Shape`, label: `${label} shape`, unit: '', min: 0, max: 0, step: 0,
          kind: 'choice',
          choices: [
            { value: 'rect', label: 'Rectangle' },
            { value: 'circle', label: 'Circle' },
            { value: 'polygon', label: 'Polygon' },
          ],
        };
        const size = shape === 'circle'
          ? [N(`${prefix}Diameter`, `${label} diameter`, 0.5, 2000)]
          : shape === 'polygon'
            ? [N(`${prefix}Diameter`, `${label} across corners`, 0.5, 2000),
               N(`${prefix}Sides`, `${label} sides`, 3, 24, 1, '')]
            : [N(`${prefix}Length`, `${label} length`, 0.5, 2000),
               N(`${prefix}Width`, `${label} width`, 0.5, 2000)];

        return [choice, ...size,
          N(`${prefix}X`, `${label} offset X`, -1000, 1000),
          N(`${prefix}Y`, `${label} offset Y`, -1000, 1000)];
      };

      return [PLANE, N('height', 'Height', 0.1, 2000),
        ...ends('base', 'Bottom'), ...ends('top', 'Top'),
        N('subdivisions', 'Smoothness', 1, 64, 1, ''), OPERATION];
    }

    case 'sweep': {
      const path = params ? str(params, 'path', 'line') : 'line';
      const PATH: ParamField = {
        key: 'path', label: 'Path', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
        choices: [
          { value: 'line', label: 'Straight' },
          { value: 'arc', label: 'Arc' },
          { value: 'helix', label: 'Helix' },
        ],
      };
      const SHAPE: ParamField = {
        key: 'shape', label: 'Section', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
        choices: [
          { value: 'circle', label: 'Circle' },
          { value: 'rect', label: 'Rectangle' },
          { value: 'polygon', label: 'Polygon' },
        ],
      };
      const shape = params ? str(params, 'shape', 'circle') : 'circle';
      const size = shape === 'rect'
        ? [N('length', 'Section length', 0.2, 1000), N('width', 'Section width', 0.2, 1000)]
        : shape === 'polygon'
          ? [N('diameter', 'Across corners', 0.2, 1000), N('sides', 'Sides', 3, 24, 1, '')]
          : [N('diameter', 'Section diameter', 0.2, 1000)];

      const along = path === 'helix'
        ? [N('pathRadius', 'Coil radius', 0.5, 2000), N('turns', 'Turns', 0.25, 200, 0.25, ''),
           N('pitch', 'Pitch', 0.2, 500)]
        : path === 'arc'
          ? [N('pathRadius', 'Bend radius', 0.5, 5000), N('pathAngle', 'Bend angle', 1, 350, 1, 'deg')]
          : [N('distance', 'Length', 0.5, 5000)];

      return [SHAPE, ...size, PATH, ...along,
        N('twist', 'Twist', -1080, 1080, 5, 'deg'),
        N('endScale', 'End scale', 0.05, 20, 0.05, ''), OPERATION];
    }

    case 'sheet': {
      const shape = params ? str(params, 'shape', 'angle') : 'angle';
      return [
        { key: 'shape', label: 'Shape', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
          choices: [
            { value: 'angle', label: 'Angle — one bend' },
            { value: 'channel', label: 'Channel — two bends, same way' },
            { value: 'z', label: 'Z — two bends, opposite ways' },
          ] },
        N('thickness', 'Material thickness', 0.1, 30),
        N('width', 'Width across the sheet', 1, 3000),
        N('radius', 'Inside bend radius', 0.05, 100),
        N('angle', 'Bend angle', 1, 170, 1, 'deg'),
        N('flangeA', shape === 'angle' ? 'First flange' : 'Web', 1, 3000),
        N('flangeB', shape === 'angle' ? 'Second flange' : 'First flange', 1, 3000),
        ...(shape === 'angle' ? [] : [N('flangeC', 'Second flange', 1, 3000)]),
        OPERATION,
      ];
    }
    case 'wrap':
      return [
        N('count', 'How many', 1, 240, 1, ''),
        N('width', 'Feature width', 0.05, 200),
        N('depth', 'Depth', 0.05, 200),
        N('height', 'Band height', 0.1, 2000),
        N('z', 'Band centre Z', -2000, 2000),
        N('radius', 'Radius', 0.1, 2000),
        { key: 'operation', label: 'Cut or raise', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
          choices: [
            { value: 'cut', label: 'Engrave into the surface' },
            { value: 'add', label: 'Emboss onto the surface' },
          ] },
      ];
    case 'dome':
      return [
        { key: 'face', label: 'Face', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
          choices: [{ value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' }] },
        N('height', 'Height', 0.1, 1000),
        N('smoothness', 'Smoothness', 1, 5, 1, ''),
      ];
    case 'split':
      return [
        { key: 'plane', label: 'Cut along', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
          choices: [
            { value: 'YZ', label: 'X (left / right)' },
            { value: 'XZ', label: 'Y (front / back)' },
            { value: 'XY', label: 'Z (top / bottom)' },
          ] },
        N('at', 'Position', 0.01, 0.99, 0.01, ''),
        { key: 'keep', label: 'Keep', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
          choices: [
            { value: 'both', label: 'Both halves' },
            { value: 'first', label: 'The near half only' },
            { value: 'second', label: 'The far half only' },
          ] },
      ];
    case 'datum':
      return [
        { key: 'basePlane', label: 'Parallel to', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
          choices: [
            { value: 'XY', label: 'Top (XY)' },
            { value: 'XZ', label: 'Front (XZ)' },
            { value: 'YZ', label: 'Right (YZ)' },
          ] },
        N('offset', 'Offset', -2000, 2000),
        N('tiltX', 'Tilt about X', -89, 89, 1, 'deg'),
        N('tiltY', 'Tilt about Y', -89, 89, 1, 'deg'),
      ];
    case 'rib':
      return [N('length', 'Length', 1, 2000), N('thickness', 'Thickness', 0.2, 200),
        N('height', 'Height', 0.5, 1000), N('x', 'Centre X', -1000, 1000),
        N('y', 'Centre Y', -1000, 1000), N('draft', 'Draft', 0, 15, 0.5, 'deg')];
    case 'draft':
      return [N('angle', 'Angle', -20, 20, 0.5, 'deg')];
    case 'hole': {
      const holeType = params ? str(params, 'holeType', 'through') : 'through';
      const TYPE: ParamField = {
        key: 'holeType', label: 'Type', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
        choices: [
          { value: 'through', label: 'Through' },
          { value: 'blind', label: 'Blind' },
          { value: 'counterbore', label: 'Counterbore' },
          { value: 'countersink', label: 'Countersink' },
          { value: 'tapped', label: 'Tapped' },
        ],
      };

      // Only the dimensions this kind of hole uses. A countersink has no depth of its own —
      // it follows from the head angle and the two diameters — and offering one would let
      // someone draw a countersink no drill could cut.
      const forType =
        holeType === 'counterbore'
          ? [N('counterDiameter', 'Counterbore diameter', 1, 300),
             N('counterDepth', 'Counterbore depth', 0.1, 200)]
          : holeType === 'countersink'
            ? [N('counterDiameter', 'Countersink diameter', 1, 300),
               N('counterAngle', 'Head angle', 60, 130, 1, 'deg')]
            : holeType === 'blind' || holeType === 'tapped'
              ? [N('depth', 'Depth', 0.5, 500)]
              : [];

      return [
        TYPE,
        N('diameter', holeType === 'tapped' ? 'Thread size' : 'Diameter', 0.5, 300),
        ...forType,
        { key: 'pattern', label: 'Pattern', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
          choices: [{ value: 'single', label: 'Single' }, { value: 'boltCircle', label: 'Bolt circle' }, { value: 'grid', label: 'Grid' }] },
        N('x', 'X', -1000, 1000), N('y', 'Y', -1000, 1000),
        N('boltCircle', 'Bolt circle diameter', 1, 2000), N('count', 'Count', 1, 48, 1, ''),
        N('cols', 'Columns', 1, 20, 1, ''), N('rows', 'Rows', 1, 20, 1, ''),
        N('spacingX', 'Spacing X', 1, 500), N('spacingY', 'Spacing Y', 1, 500),
        // Where the pattern is centred. `holePositions` has always read these; nothing
        // declared them, so a bolt circle could only ever sit on the origin — not because
        // anyone decided that, but because the field to move it was missing from the schema
        // the editor and the script parser both read. A parameter the evaluator honours and
        // no schema names is a parameter that cannot be set.
        N('cx', 'Pattern centre X', -1000, 1000), N('cy', 'Pattern centre Y', -1000, 1000)];
    }
    case 'pocket':
      return [N('length', 'Length', 1, 1000), N('width', 'Width', 1, 1000), N('depth', 'Depth', 0.1, 500),
        N('cornerRadius', 'Corner radius', 0, 200), N('x', 'Centre X', -1000, 1000), N('y', 'Centre Y', -1000, 1000)];
    case 'slot':
      return [N('length', 'Length', 1, 1000), N('width', 'Width', 0.5, 500),
        N('x', 'Centre X', -1000, 1000), N('y', 'Centre Y', -1000, 1000), N('angle', 'Angle', 0, 180, 1, 'deg')];
    case 'fillet':
      return [
        N('radius', 'Radius', 0.1, 200, 0.1),
        N('minAngle', 'Minimum edge angle', 5, 90, 1, 'deg'),
        { key: 'convexity', label: 'Which edges', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
          choices: [
            { value: 'all', label: 'Outside and inside' },
            { value: 'convex', label: 'Outside only' },
            { value: 'concave', label: 'Inside corners only' },
          ] },
        { key: 'faceMatch', label: 'Selected faces mean', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
          choices: [
            { value: 'bounding', label: 'Round every edge of them' },
            { value: 'between', label: 'Round only the seam between them' },
          ] },
      ];
    case 'chamfer':
      return [
        N('distance', 'Distance', 0.1, 200, 0.1),
        N('minAngle', 'Minimum edge angle', 5, 90, 1, 'deg'),
        { key: 'faceMatch', label: 'Selected faces mean', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
          choices: [
            { value: 'bounding', label: 'Chamfer every edge of them' },
            { value: 'between', label: 'Chamfer only the seam between them' },
          ] },
      ];
    case 'shell':
      return [N('thickness', 'Wall thickness', 0.2, 100, 0.1)];
    case 'patternLinear':
      return [N('count', 'Count', 2, 50, 1, ''), N('spacing', 'Spacing', 0.5, 1000),
        N('dx', 'Direction X', -1, 1, 0.1, ''), N('dy', 'Direction Y', -1, 1, 0.1, ''), N('dz', 'Direction Z', -1, 1, 0.1, '')];
    case 'patternCircular':
      return [N('count', 'Count', 2, 60, 1, ''), N('angle', 'Total angle', 1, 360, 1, 'deg'),
        N('cx', 'Axis X', -1000, 1000), N('cy', 'Axis Y', -1000, 1000)];
    case 'mirror':
      return [{ key: 'plane', label: 'Mirror plane', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
        choices: [{ value: 'YZ', label: 'Right (YZ)' }, { value: 'XZ', label: 'Front (XZ)' }, { value: 'XY', label: 'Top (XY)' }] }];
    default:
      return [];
  }
}

/** Sensible starting parameters, so a newly added feature is immediately visible. */
export function defaultParams(kind: FeatureKind): Record<string, ParamValue> {
  switch (kind) {
    // A 1 mm break by default, because that is what a part comes off a machine with. It is
    // small enough not to change any dimension anyone typed and large enough to catch a
    // highlight, which is what makes a solid read as a made object rather than a diagram.
    /*
     * Edge break off by default.
     *
     * It was on, at 1 mm, so that a massing model would not read as a stack of blocks. The
     * cost was not worth it and was not visible from here: breaking the edges of a box turns
     * six flat faces into thirty-four — six faces, twelve edge blends and eight corner patches
     * — and every one of them is separately pickable, so choosing a face to work on became a
     * hunt. Worse, it left no edge longer than the break itself, and Fillet and Chamfer both
     * refuse a radius wider than half the edge it runs along. The two most basic modelling
     * operations after extrude were dead on the commonest solid in the application, and said
     * so with a message about a 1.57 mm edge nobody had drawn.
     *
     * A box is a box. Rounding is a feature you add, deliberately, and now one that works.
     * The parameter stays, for a part that wants a finish rather than further modelling.
     */
    case 'box': return { length: 60, width: 40, height: 25, x: 0, y: 0, round: 0, operation: 'add' };
    case 'cylinder': return { diameter: 40, height: 50, x: 0, y: 0, round: 0, operation: 'add' };
    case 'sphere': return { diameter: 50, x: 0, y: 0, z: 0, operation: 'add' };
    case 'sketch': return { plane: 'XY', sketch: '', distance: 20, draft: 0, operation: 'add' };
    case 'extrude': return { plane: 'XY', shape: 'rect', length: 60, width: 40, cornerRadius: 0, distance: 20, draft: 0, operation: 'add' };
    case 'revolve': return { plane: 'XZ', shape: 'rect', length: 20, width: 40, x: 30, angle: 360, operation: 'add' };
    // A 60 mm square up to a 40 mm circle: a round-to-square transition, which is the shape
    // that makes it obvious at a glance what a loft is for.
    case 'loft': return {
      plane: 'XY', height: 60, subdivisions: 8, operation: 'add',
      baseShape: 'rect', baseLength: 60, baseWidth: 60, baseX: 0, baseY: 0,
      topShape: 'circle', topDiameter: 40, topX: 0, topY: 0,
    };
    // A helical spring: 6 mm wire, 30 mm coil radius, four turns. Chosen over a straight
    // sweep as the default because a straight sweep of a circle is a cylinder, and a default
    // that looks like something you could already build teaches nothing.
    case 'sweep': return {
      shape: 'circle', diameter: 6, path: 'helix',
      pathRadius: 30, turns: 4, pitch: 12, distance: 80, pathAngle: 90,
      twist: 0, endScale: 1, operation: 'add',
    };
    case 'sheet': return {
      shape: 'angle', thickness: 2, width: 60, radius: 2, angle: 90,
      flangeA: 60, flangeB: 40, flangeC: 40, operation: 'add',
    };
    case 'dome': return { height: 10, face: 'top', smoothness: 4 };
    case 'wrap': return { count: 24, depth: 1.5, width: 2, height: 20, z: 0, operation: 'cut' };
    case 'split': return { plane: 'YZ', at: 0.5, keep: 'both' };
    case 'datum': return { basePlane: 'XY', offset: 20, tiltX: 0, tiltY: 0 };
    case 'rib': return { thickness: 4, height: 20, length: 60, x: 0, y: 0, draft: 1 };
    case 'draft': return { angle: 2 };
    case 'hole': return { holeType: 'through', pattern: 'single', diameter: 8, x: 0, y: 0, boltCircle: 80, count: 6, cols: 2, rows: 2, spacingX: 40, spacingY: 40, cx: 0, cy: 0 };
    case 'pocket': return { length: 30, width: 20, depth: 5, cornerRadius: 2, x: 0, y: 0 };
    case 'slot': return { length: 30, width: 8, x: 0, y: 0, angle: 0 };
    case 'fillet': return { radius: 3, minAngle: 30, faceMatch: 'bounding', convexity: 'all', faces: [] };
    case 'chamfer': return { distance: 2, minAngle: 30, faceMatch: 'bounding', faces: [] };
    case 'shell': return { thickness: 2 };
    case 'patternLinear': return { count: 3, spacing: 30, dx: 1, dy: 0, dz: 0 };
    case 'patternCircular': return { count: 6, angle: 360, cx: 0, cy: 0 };
    case 'mirror': return { plane: 'YZ' };
    default: return {};
  }
}

// ── serialisation ────────────────────────────────────────────────────────────

/**
 * Serialises the document.
 *
 * Imported meshes are dropped rather than embedded. A traced image or a rebuilt DXF can be
 * megabytes of triangles, and a save format that grows without bound is one users learn to
 * avoid. The feature stays in the tree with a note so nothing disappears silently.
 */
/**
 * The document as text.
 *
 * Schema 3 writes imported geometry out instead of discarding it. Schema 2 replaced an
 * imported feature's mesh with `__dropped: true`, on the reasoning that geometry is derived
 * and the tree is the document — which is right for every feature that has a tree to rebuild
 * from, and exactly wrong for the one kind that does not. A traced photograph or a
 * reconstructed drawing has no recipe behind it, so dropping the mesh did not defer the work,
 * it lost the part: saving and reopening produced "the imported geometry is missing" and an
 * empty viewport.
 *
 * That made the whole import path unusable for its actual purpose. Bringing a library of
 * drawings in is worth nothing if none of them can be saved afterwards.
 */
export function serialise(doc: Document): string {
  return JSON.stringify({
    schema: 3,
    ...doc,
    features: doc.features.map((f) => {
      if (f.kind !== 'imported') return f;
      const mesh = f.params.__mesh as unknown;
      return {
        ...f,
        params: {
          ...f.params,
          __mesh: mesh && typeof mesh === 'object'
            ? serialiseMesh(mesh as Mesh)
            : undefined,
        },
      };
    }),
  });
}

export function deserialise(text: string): Document | null {
  try {
    const raw = JSON.parse(text) as Document & { schema?: number };
    if (!Array.isArray(raw.features)) return null;
    return {
      // Always a fresh id, never the saved one. Opening a file is arriving at a different
      // part as far as the viewport is concerned, even if you saved it a moment ago — and
      // documents written before ids existed have none to restore.
      id: `d${++documentSerial}`,
      name: raw.name ?? 'Part1',
      units: raw.units ?? 'mm',
      material: raw.material ?? 'Aluminium 6061-T6',
      density: raw.density ?? 2.7,
      // Carried through rather than recomputed. An assembly's mass is summed from components
      // weighed at their own densities; dropping it on read meant a reopened phone was
      // re-weighed as if it were solid aluminium, which is the one number that gives a model
      // away as fake.
      ...(typeof raw.knownMassGrams === 'number' ? { knownMassGrams: raw.knownMassGrams } : {}),
      globals: raw.globals ?? [],
      ...(raw.properties ? { properties: raw.properties } : {}),
      ...(raw.configurations ? { configurations: raw.configurations } : {}),
      features: raw.features.map((f): Feature => {
        const feature: Feature = { ...f, suppressed: f.suppressed ?? false };
        if (feature.kind !== 'imported') return feature;

        // Rebuilt into typed arrays. A schema-2 document has nothing to rebuild from — the
        // mesh was discarded on save — so it keeps its `__dropped` marker and the evaluator
        // reports the geometry as missing, which is the truth about that file.
        const mesh = deserialiseMesh(feature.params.__mesh);
        const params: Record<string, ParamValue> = { ...feature.params };
        if (mesh) params.__mesh = mesh as unknown as ParamValue;
        else { delete params.__mesh; params.__dropped = true; }

        return { ...feature, params };
      }),
      mates: Array.isArray(raw.mates) ? raw.mates : [],
    };
  } catch {
    return null;
  }
}

/** Bounding box of the evaluated solid, for the camera's fit. */
export function documentBounds(ev: EvaluatedDocument) {
  return bounds(ev.mesh);
}

void add3; void mul3; void norm3; void getTriangle; void planeFrom;

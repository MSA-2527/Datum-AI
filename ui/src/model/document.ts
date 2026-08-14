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
  add3, matMul, mul3, norm3, rad, rotation, translation,
  type Mat4, type Vec2, type Vec3,
} from '../kernel/math/vec';
import {
  bounds, concatMeshes, getTriangle, health, massProperties, transformMesh, triCount,
  type Mesh, type MeshHealth,
} from '../kernel/topo/mesh';
import {
  circleProfile, makeProfile, polygonProfile, rectProfile, slotProfile, type Profile,
} from '../kernel/sketch/profile';
import {
  XY, XZ, YZ, box, cylinder, extrude, planeFrom, revolve, sphere, type Plane,
} from '../kernel/ops/build';
import { boolean, subtractAll } from '../kernel/ops/boolean';
import { sketchFromJson, solveForProfile } from '../kernel/sketch/document';
import {
  chamferEdges, circularPattern, filletEdges, linearPattern, mirrorBody, sharpEdges, shell,
} from '../kernel/ops/modify';
import { archetypeById } from '../generate/archetypes';
import { type MateKind } from '../kernel/assembly/assembly';
import { readNumber, resolveParameters } from './expr';

// ── features ─────────────────────────────────────────────────────────────────

export type FeatureKind =
  | 'archetype'
  | 'box' | 'cylinder' | 'sphere'
  | 'sketch'
  | 'extrude' | 'revolve'
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
function num(doc: Document, params: Record<string, ParamValue>, key: string, fallback: number): number {
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
  parameterCache.set(doc, values);
  return values;
}

/** Parameters that could not be worked out, and why. */
export function parameterErrors(doc: Document): Map<string, string> {
  return resolveParameters(doc.globals ?? []).errors;
}

const str = (params: Record<string, ParamValue>, key: string, fallback: string): string =>
  typeof params[key] === 'string' ? (params[key] as string) : fallback;

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
      return combine(current, place(solid, f, doc), str(p, 'operation', 'add'));
    }

    case 'cylinder': {
      const solid = cylinder(n('diameter', 40) / 2, n('height', 50),
        [n('x', 0), n('y', 0), n('z', 0)], [0, 0, 1], f.id);
      return combine(current, place(solid, f, doc), str(p, 'operation', 'add'));
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

      const solid = extrude(solved.profile, planeOf(str(p, 'plane', 'XY')), {
        distance: n('distance', 20),
        midplane: p.midplane === true,
        draftDeg: n('draft', 0),
        feature: f.id,
      });

      const combined = combine(current, place(solid, f, doc), str(p, 'operation', 'add'));
      // Under-constrained is not an error — most sketches are, most of the time — but it is
      // worth saying, because a dimension that does not hold is a surprise later.
      return solved.result.degreesOfFreedom > 0
        ? { ...combined, warning: solved.summary }
        : combined;
    }

    case 'extrude': {
      const profile = profileFrom(p, doc);
      if (!profile) return { error: 'This feature has no profile to extrude.' };

      const solid = extrude(profile, planeOf(str(p, 'plane', 'XY')), {
        distance: n('distance', 20),
        midplane: p.midplane === true,
        draftDeg: n('draft', 0),
        feature: f.id,
      });
      return combine(current, place(solid, f, doc), str(p, 'operation', 'add'));
    }

    case 'revolve': {
      const profile = profileFrom(p, doc);
      if (!profile) return { error: 'This feature has no profile to revolve.' };

      const solid = revolve(profile, planeOf(str(p, 'plane', 'XZ')), {
        axisOrigin: [0, 0, 0],
        axisDir: [0, 0, 1],
        angleDeg: n('angle', 360),
        feature: f.id,
      });
      return combine(current, place(solid, f, doc), str(p, 'operation', 'add'));
    }

    case 'hole': {
      if (triCount(current) === 0) return { error: 'There is nothing to drill into yet.' };

      const bb = bounds(current);
      const depth = (bb.max[2] - bb.min[2]) * 3 + 20;
      const r = n('diameter', 8) / 2;

      const positions = holePositions(p, doc);
      const drills = positions.map(([x, y]) =>
        cylinder(r, depth, [x, y, (bb.min[2] + bb.max[2]) / 2], [0, 0, 1], f.id),
      );

      const cut = subtractAll(current, drills);
      return { mesh: cut.mesh, error: cut.valid ? undefined : cut.diagnostic };
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

const isIdentity = (p: Placement) =>
  p.x === 0 && p.y === 0 && p.z === 0 && p.rx === 0 && p.ry === 0 && p.rz === 0;

/** The transform a placement applies: rotate about Z, then Y, then X, then translate. */
export function placementMatrix(p: Placement): Mat4 {
  return matMul(
    translation([p.x, p.y, p.z]),
    matMul(
      rotation([0, 0, 1], rad(p.rz)),
      matMul(rotation([0, 1, 0], rad(p.ry)), rotation([1, 0, 0], rad(p.rx))),
    ),
  );
}

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

  const inverse = matMul(
    matMul(
      matMul(rotation([1, 0, 0], rad(-p.rx)), rotation([0, 1, 0], rad(-p.ry))),
      rotation([0, 0, 1], rad(-p.rz)),
    ),
    translation([-p.x, -p.y, -p.z]),
  );
  return transformMesh(solid, inverse);
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

function holePositions(p: Record<string, ParamValue>, doc: Document): Vec2[] {
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
  extrude: 'Extrude', revolve: 'Revolve',
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
export function paramFields(kind: FeatureKind, params?: Record<string, ParamValue>): ParamField[] {
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

  const PLANE: ParamField = {
    key: 'plane', label: 'Plane', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
    choices: [
      { value: 'XY', label: 'Top (XY)' },
      { value: 'XZ', label: 'Front (XZ)' },
      { value: 'YZ', label: 'Right (YZ)' },
    ],
  };

  switch (kind) {
    case 'box':
      return [N('length', 'Length', 1, 2000), N('width', 'Width', 1, 2000), N('height', 'Height', 1, 2000),
        N('x', 'Centre X', -1000, 1000), N('y', 'Centre Y', -1000, 1000), OPERATION];
    case 'cylinder':
      return [N('diameter', 'Diameter', 1, 2000), N('height', 'Height', 1, 2000),
        N('x', 'Centre X', -1000, 1000), N('y', 'Centre Y', -1000, 1000), OPERATION];
    case 'sphere':
      return [N('diameter', 'Diameter', 1, 2000), N('x', 'Centre X', -1000, 1000),
        N('y', 'Centre Y', -1000, 1000), N('z', 'Centre Z', -1000, 1000), OPERATION];
    case 'sketch':
      // No Length or Width: a sketch's size comes from its constraints, and offering a box to
      // type into beside them would be two competing ways to say the same thing.
      return [PLANE, N('distance', 'Thickness', 0.1, 2000),
        N('draft', 'Draft', -20, 20, 0.5, 'deg'), OPERATION];

    case 'extrude':
      // A traced or imported outline is a point list, so Length, Width and Corner radius have
      // nothing to act on — showing them offered edits that silently did nothing. What such a
      // profile does need is an overall width, because the picture it came from had no scale.
      if (params && str(params, 'shape', 'rect') === 'points') {
        return [N('width', 'Overall width', 1, 5000, 0.5), N('distance', 'Thickness', 0.1, 2000),
          N('draft', 'Draft', -20, 20, 0.5, 'deg'), OPERATION];
      }
      return [PLANE, N('length', 'Length', 1, 2000), N('width', 'Width', 1, 2000),
        N('cornerRadius', 'Corner radius', 0, 200), N('distance', 'Distance', 0.1, 2000),
        N('draft', 'Draft', -20, 20, 0.5, 'deg'), OPERATION];
    case 'revolve':
      return [PLANE, N('length', 'Section length', 1, 500), N('width', 'Section width', 1, 500),
        N('x', 'Offset from axis', 0, 1000), N('angle', 'Angle', 1, 360, 1, 'deg'), OPERATION];
    case 'hole':
      return [
        { key: 'pattern', label: 'Pattern', unit: '', min: 0, max: 0, step: 0, kind: 'choice',
          choices: [{ value: 'single', label: 'Single' }, { value: 'boltCircle', label: 'Bolt circle' }, { value: 'grid', label: 'Grid' }] },
        N('diameter', 'Diameter', 0.5, 300), N('x', 'X', -1000, 1000), N('y', 'Y', -1000, 1000),
        N('boltCircle', 'Bolt circle diameter', 1, 2000), N('count', 'Count', 1, 48, 1, ''),
        N('cols', 'Columns', 1, 20, 1, ''), N('rows', 'Rows', 1, 20, 1, ''),
        N('spacingX', 'Spacing X', 1, 500), N('spacingY', 'Spacing Y', 1, 500)];
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
    case 'box': return { length: 60, width: 40, height: 25, x: 0, y: 0, operation: 'add' };
    case 'cylinder': return { diameter: 40, height: 50, x: 0, y: 0, operation: 'add' };
    case 'sphere': return { diameter: 50, x: 0, y: 0, z: 0, operation: 'add' };
    case 'sketch': return { plane: 'XY', sketch: '', distance: 20, draft: 0, operation: 'add' };
    case 'extrude': return { plane: 'XY', shape: 'rect', length: 60, width: 40, cornerRadius: 0, distance: 20, draft: 0, operation: 'add' };
    case 'revolve': return { plane: 'XZ', shape: 'rect', length: 20, width: 40, x: 30, angle: 360, operation: 'add' };
    case 'hole': return { pattern: 'single', diameter: 8, x: 0, y: 0, boltCircle: 80, count: 6, cols: 2, rows: 2, spacingX: 40, spacingY: 40 };
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
export function serialise(doc: Document): string {
  return JSON.stringify({
    schema: 2,
    ...doc,
    features: doc.features.map((f) =>
      f.kind === 'imported'
        ? { ...f, params: { ...f.params, __mesh: undefined, __dropped: true } }
        : f,
    ),
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
      globals: raw.globals ?? [],
      features: raw.features.map((f) => ({ ...f, suppressed: f.suppressed ?? false })),
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

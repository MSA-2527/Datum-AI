/**
 * The feature tree as an assembly.
 *
 * The kernel has carried mates, a mate solver and interference detection for a long time, and
 * like the sketch solver before it, nothing has ever called them. The reason is a mismatch in
 * shape: the document is an ordered feature tree that evaluates to *one merged mesh*, while
 * the assembly module works on instances that each have their own transform.
 *
 * This file is the bridge, and it is deliberately one-directional in the way that matters.
 * The tree stays the document — that rule is what makes everything else in the modeller work
 * — and the assembly is derived from it on demand. Mates do not replace placements; they
 * *drive* them. Solving writes solved positions back into the features' own placements, so the
 * result is still an ordinary tree that saves, reloads and rebuilds like any other.
 *
 * That is the difference between "this bolt sits at x=42" and "this bolt is concentric with
 * that hole". The first is a coordinate somebody typed and nothing maintains. The second
 * survives the plate moving.
 */

import { type Vec3 } from '../kernel/math/vec';
import { triCount, type Mesh } from '../kernel/topo/mesh';
import {
  addInstance, addPart, emptyAssembly, findInterference, solveMates,
  type Assembly, type Interference, type Mate, type MateSolveResult,
} from '../kernel/assembly/assembly';
import {
  applyFeature, placeMesh, resolvedPlacement, unplaceMesh,
  type Document, type DocumentMate, type Feature,
} from './document';
import { boolean } from '../kernel/ops/boolean';

/**
 * Feature kinds that can contribute a body.
 *
 * Features that modify what came before — a fillet, a shell, a pattern — are not components
 * and must not become instances: moving a fillet independently of the thing it rounds is
 * meaningless.
 */
const BODY_KINDS = new Set([
  'archetype', 'box', 'cylinder', 'sphere', 'sketch', 'extrude', 'revolve', 'imported',
]);

/** Kinds that only ever remove material, whatever their `operation` says. */
const TOOL_KINDS = new Set(['hole', 'pocket', 'slot']);

function operationOf(f: Feature): string {
  const op = f.params.operation;
  return typeof op === 'string' ? op : 'add';
}

/**
 * True when this feature adds a body of its own.
 *
 * `place` counts as much as `add`, and is in fact the stronger signal. It is the operation a
 * generated assembly uses for every component — it concatenates a separate body rather than
 * unioning into the one before it, which is precisely what "this is its own part" means.
 * Accepting only `add` found nothing in a phone, a gearbox or a bicycle: sixteen features,
 * zero instances, and an interference check that had nothing to check.
 */
export function isComponent(f: Feature): boolean {
  if (!BODY_KINDS.has(f.kind) || f.suppressed) return false;
  const op = operationOf(f);
  return op === 'add' || op === 'place';
}

/** True when this feature removes material from the bodies before it. */
function isTool(f: Feature): boolean {
  if (f.suppressed) return false;
  if (TOOL_KINDS.has(f.kind)) return true;
  return BODY_KINDS.has(f.kind) && operationOf(f) === 'cut';
}

export interface DocumentAssembly {
  assembly: Assembly;
  /** Instance id → the feature it came from, so results can be written back. */
  featureOf: Map<string, string>;
  /** Feature id → instance id. */
  instanceOf: Map<string, string>;
}

const EMPTY: Mesh = {
  positions: new Float64Array(0),
  indices: new Uint32Array(0),
  faceIds: new Uint32Array(0),
  tags: new Map(),
};

/** Builds one feature's own body, at the origin, with nothing before it. */
function bodyOf(feature: Feature, doc: Document): Mesh | null {
  try {
    const result = applyFeature(EMPTY, { ...feature, placement: undefined }, doc);
    return result.error || !result.mesh || triCount(result.mesh) === 0 ? null : result.mesh;
  } catch {
    return null;
  }
}

/**
 * Builds an assembly from the tree's component features.
 *
 * The subtlety that makes this correct is *cuts*. A tree reads "Case, Case cavity, Output
 * gear": the cavity is not a component, it is a tool that hollows the case. Building each
 * feature independently and calling them all components made a gearbox report fourteen
 * clashes — a case overlapping its own cavity by 100 %, and a gear overlapping the solid block
 * the case would have been if it had never been hollowed out. Every one of those was an
 * artefact of ignoring the cut.
 *
 * So this walks the tree in order, the way evaluation does: a body-adding feature starts a new
 * component, and a cutting feature is removed from every component that exists at that point,
 * which is exactly the semantics the merged solid already has.
 *
 * The first component is fixed. Every mate solve needs something to be still — otherwise the
 * whole assembly drifts as a rigid body and the solver reports degrees of freedom no mate can
 * ever remove.
 */
export function documentToAssembly(doc: Document): DocumentAssembly {
  const assembly = emptyAssembly();
  const featureOf = new Map<string, string>();
  const instanceOf = new Map<string, string>();

  const bodies: { feature: Feature; mesh: Mesh }[] = [];

  for (const feature of doc.features) {
    if (isComponent(feature)) {
      const mesh = bodyOf(feature, doc);
      if (mesh) bodies.push({ feature, mesh });
      continue;
    }

    if (!isTool(feature)) continue;

    // A tool is positioned in world space, so each body has to be taken there, cut, and
    // brought back to its own coordinates.
    const tool = bodyOf(feature, doc);
    if (!tool) continue;
    const worldTool = placeMesh(tool, feature, doc);

    for (const body of bodies) {
      const worldBody = placeMesh(body.mesh, body.feature, doc);
      try {
        const cut = boolean(worldBody, worldTool, 'difference');
        if (triCount(cut.mesh) > 0) body.mesh = unplaceMesh(cut.mesh, body.feature, doc);
      } catch {
        // A boolean that fails leaves the body as it was, which is the conservative answer.
      }
    }
  }

  let first = true;
  for (const { feature, mesh } of bodies) {
    if (triCount(mesh) === 0) continue;

    const part = addPart(assembly, mesh, feature.name, doc.material, doc.density);
    // The *resolved* placement: a driven axis is a real position, not a stale stored number.
    const at = resolvedPlacement(feature, doc);
    const inst = addInstance(
      assembly, part,
      at ? [at.x, at.y, at.z] : [0, 0, 0],
      first,
      feature.name,
    );

    featureOf.set(inst.id, feature.id);
    instanceOf.set(feature.id, inst.id);
    first = false;
  }

  return { assembly, featureOf, instanceOf };
}

let mateSerial = 0;
export const newMateId = (): string => `m${++mateSerial}`;

export interface MateSolve {
  result: MateSolveResult;
  /** Feature id → the position the solve put it at. */
  positions: Map<string, Vec3>;
  /** Mates that referred to a feature no longer in the tree. */
  orphaned: DocumentMate[];
  /** One line for the user. */
  summary: string;
}

/**
 * Solves the document's mates and reports where each component ended up.
 *
 * Returns positions rather than writing them, so a caller can show the outcome before
 * committing it — and so a conflicting solve never silently rearranges someone's model.
 */
export function solveDocumentMates(doc: Document, mates: DocumentMate[]): MateSolve {
  const { assembly, featureOf, instanceOf } = documentToAssembly(doc);

  const orphaned: DocumentMate[] = [];
  const live: Mate[] = [];

  for (const m of mates) {
    if (m.suppressed) continue;

    const ia = instanceOf.get(m.a.feature);
    const ib = instanceOf.get(m.b.feature);
    // A mate onto a deleted or unbuildable component is reported rather than dropped, so the
    // user finds out why their assembly stopped holding together.
    if (!ia || !ib) { orphaned.push(m); continue; }

    live.push({
      id: m.id,
      kind: m.kind,
      a: { instance: ia, point: m.a.point, direction: m.a.direction },
      b: { instance: ib, point: m.b.point, direction: m.b.direction },
      value: m.value,
    });
  }

  assembly.mates = live;
  const result = solveMates(assembly);

  const positions = new Map<string, Vec3>();
  for (const inst of result.assembly.instances) {
    const fid = featureOf.get(inst.id);
    if (fid) positions.set(fid, inst.position);
  }

  const dof = result.degreesOfFreedom;
  const base =
    result.status === 'conflict'
      ? 'Mates conflict — they cannot all hold at once.'
      : result.status === 'diverged'
        ? 'The mates did not settle. Remove the last one added.'
        : result.status === 'over'
          ? 'Fully mated, with redundant mates.'
          : dof === 0
            ? 'Fully mated.'
            : `${dof} degree${dof === 1 ? '' : 's'} of freedom left.`;

  const summary = orphaned.length > 0
    ? `${base} ${orphaned.length} mate${orphaned.length === 1 ? '' : 's'} refer to a ` +
      `component that is no longer in the tree.`
    : base;

  return { result, positions, orphaned, summary };
}

export interface ClashReport {
  clashes: Interference[];
  /** Instance id → the readable component name. */
  nameOf: Map<string, string>;
  summary: string;
}

/**
 * Finds components sharing space.
 *
 * This is the check that matters most for what this app actually produces. A generated plan
 * places thirty parts by absolute coordinate, and the failure mode is not a part in the wrong
 * place by a metre — that is obvious — but a battery a few millimetres inside a chassis wall,
 * which looks right and cannot be built.
 *
 * A small overlap is reported separately because it is an interference *fit*, which is how
 * dowels and bearings are retained. Flagging both the same way trains people to ignore both.
 */
export function findDocumentClashes(doc: Document): ClashReport {
  const { assembly } = documentToAssembly(doc);
  const clashes = findInterference(assembly);

  const nameOf = new Map<string, string>();
  for (const i of assembly.instances) nameOf.set(i.id, i.name);

  const real = clashes.filter((c) => !c.likelyPressFit);
  const fits = clashes.length - real.length;

  const summary = real.length === 0
    ? fits > 0
      ? `No clashes. ${fits} light overlap${fits === 1 ? '' : 's'}, consistent with press fits.`
      : 'No components share space.'
    : `${real.length} clash${real.length === 1 ? '' : 'es'}: components overlapping by more ` +
      `than a press fit would.`;

  return { clashes, nameOf, summary };
}

export type { Interference, Mate, MateSolveResult };

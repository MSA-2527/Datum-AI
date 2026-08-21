import {
  holePositions, num, parametersOf,
  type Document, type EvaluatedDocument, type Feature, type FeatureKind as DocKind,
} from '../model/document';
import { bounds, pointInside, triCount, type Mesh } from '../kernel/topo/mesh';
import type { Cut, DocFeature, FeatureKind, Geometry, Hole, PartDoc, Shape2D } from './partModel';

/**
 * The feature tree, projected into the 2.5D view the analysis code was written against.
 *
 * ── Why this exists ──
 *
 * Two modelling stacks grew up in this codebase. `model/document` is the feature tree the
 * kernel evaluates and the viewport draws — the source of truth. `lib/partModel` is an older
 * 2.5D model (a closed profile swept to a thickness, with 2D shapes cut out of it) that the
 * SOLIDWORKS-facing UI was written against, and everything analytical still speaks it: the
 * manufacturability rules, the four process rule packs, the cost model and the CAD test suite.
 *
 * They were never connected. So the Studio's manufacturability tab analysed a *sample
 * bracket* — invented at boot, never edited — whatever part was on screen. Every finding,
 * every cost line and every rule citation described a part the user had never asked for,
 * presented beside the one they had.
 *
 * Rewriting the rules onto the feature tree is the eventual answer. This is the step that
 * makes them true in the meantime: `partModel` stops being a second document and becomes a
 * *derived measurement* of the real one. Nothing edits it, nothing saves it, and it is
 * recomputed from the solid on every rebuild.
 *
 * ── What is measured, and what is approximated ──
 *
 * The envelope and the volume are measured off the evaluated mesh, so they are as exact as
 * the solid is. Holes, wall thickness, corner radii and chamfers are read from the feature
 * tree, which is exact by construction — a hole feature *is* its diameter.
 *
 * The base outline is the honest approximation: a rectangle at the envelope, because a 2.5D
 * profile cannot describe a revolved or lofted body. `prismatic` says whether that is a fair
 * description of this part, so a caller can decline to draw a conclusion from it rather than
 * being handed a confident one about a shape that is not there.
 */
export interface ProjectedPart {
  doc: PartDoc;
  geometry: Geometry;
  /**
   * True when the solid is a constant cross-section swept along Z, so the 2.5D rules describe
   * the part rather than its bounding box. See `isPrismatic` for how it is decided.
   */
  prismatic: boolean;
}

/**
 * Whether the solid really is a constant cross-section swept along Z.
 *
 * Asked of the geometry rather than the feature list, because the feature list cannot answer
 * it: an `archetype` feature is a plate or a cup depending on which archetype, and an
 * `imported` solid could be anything. The faces can answer it exactly and cheaply, because
 * every kernel operation tags the surface it creates.
 *
 * A prism has two kinds of face and no others: end caps whose normal is along Z, and sides
 * that run parallel to Z — planar walls, or the cylindrical faces a vertical hole or a
 * vertical-edge fillet produces. A sphere, a cone, a torus, a freeform patch or a tilted plane
 * means the section changes with height, and a rule about the outline stops describing it.
 *
 * This classifies an L-bracket as prismatic, which a volume-versus-envelope test does not: an
 * L fills barely half its box, the same fraction as the revolved cup it has to be told apart
 * from.
 */
function isPrismatic(mesh: Mesh): boolean {
  if (triCount(mesh) === 0 || mesh.tags.size === 0) return false;

  for (const tag of mesh.tags.values()) {
    const axis = tag.normal;
    if (!axis) return false;

    const alongZ = Math.abs(axis[2]!);

    if (tag.kind === 'planar') {
      // A cap (normal along Z) or a wall (normal across it). Anything between is a taper.
      if (alongZ > 0.999 || alongZ < 0.001) continue;
      return false;
    }

    // A vertical hole, boss or corner blend keeps the section constant. A horizontal one
    // does not.
    if (tag.kind === 'cylindrical' && alongZ > 0.999) continue;

    return false;
  }

  return true;
}

/**
 * Holes recovered from the solid.
 *
 * The feature tree is the better source when it has them — a hole feature *is* its diameter,
 * with no fitting involved — but most parts here do not carry one. An archetype builds its
 * holes inside a single feature, an imported STEP arrives as one solid, and a traced photo
 * has no tree at all; in every one of those cases the tree reports no holes and the drilling
 * line of the cost model read zero on a part full of them.
 *
 * The faces know. Every cylindrical face is tagged with its axis, its origin and its radius,
 * so a hole is a Z-parallel cylinder with no material on its axis — which is exactly what
 * separates it from a boss, whose axis runs through solid.
 */
function holesFromMesh(mesh: Mesh): Hole[] {
  if (triCount(mesh) === 0) return [];

  const out: Hole[] = [];
  const seen = new Set<string>();

  for (const tag of mesh.tags.values()) {
    if (tag.kind !== 'cylindrical' || tag.radius === undefined || !tag.origin || !tag.normal) continue;
    if (Math.abs(tag.normal[2]!) < 0.999) continue;

    const [cx, cy] = [tag.origin[0]!, tag.origin[1]!];

    // A cylinder's tag is one face; a counterbored hole contributes two at the same centre.
    // The larger is the counterbore, and the drill is what the shop plans around, so the
    // smallest radius at a given centre wins.
    const key = `${cx.toFixed(3)},${cy.toFixed(3)}`;
    if (seen.has(key)) continue;

    if (pointInside(mesh, [cx, cy, tag.origin[2]!])) continue;   // a boss, not a hole

    seen.add(key);
    out.push({ x: cx, y: cy, d: tag.radius * 2, owner: tag.feature });
  }

  return out;
}

/** Document feature kinds that have a 2.5D counterpart, and what it is called there. */
const KIND_MAP: Partial<Record<DocKind, FeatureKind>> = {
  box: 'plate',
  extrude: 'plate',
  sketch: 'plate',
  archetype: 'plate',
  imported: 'unknown',
  hole: 'holePattern',
  pocket: 'pocket',
  slot: 'slot',
  fillet: 'fillet',
  chamfer: 'chamfer',
  shell: 'shell',
  patternLinear: 'patternLinear',
  patternCircular: 'patternCircular',
  mirror: 'mirror',
};

export function projectPart(doc: Document, evaluated: EvaluatedDocument): ProjectedPart {
  const mesh = evaluated.mesh;
  const empty = triCount(mesh) === 0;

  const box = bounds(mesh);
  const [x, y, z] = empty
    ? [0, 0, 0]
    : ([0, 1, 2].map((i) => box.max[i]! - box.min[i]!) as [number, number, number]);

  // Length and width are the horizontal extents, thickness the vertical one — the same
  // convention the kernel, the view buttons and the requirement checker already use.
  const L = Math.max(x, y);
  const W = Math.min(x, y);
  const T = z;

  const volume = evaluated.volume;
  const envelope = L * W * T;

  // The equivalent constant cross-section: the area a prism of this height would need to hold
  // the volume that is actually there. On a genuinely prismatic part it is the profile area
  // exactly; on a turned part it is the area that costs the same to cut, which is what the
  // cost model wants from it.
  const areaMm2 = T > 0 ? volume / T : 0;

  const live = doc.features.filter((f) => !f.suppressed);

  const fromTree: Hole[] = [];
  for (const f of live) {
    if (f.kind !== 'hole') continue;
    const d = num(doc, f.params, 'diameter', 8);
    for (const [hx, hy] of holePositions(f.params, doc)) {
      fromTree.push({ x: hx, y: hy, d, owner: f.id });
    }
  }

  const holes = fromTree.length > 0 ? fromTree : holesFromMesh(mesh);

  const shell = live.find((f) => f.kind === 'shell');
  const fillet = live.find((f) => f.kind === 'fillet');
  const chamferFeature = live.find((f) => f.kind === 'chamfer');
  const slotFeature = live.find((f) => f.kind === 'slot');

  const cornerR = fillet ? num(doc, fillet.params, 'radius', 0) : 0;
  const chamfer = chamferFeature ? num(doc, chamferFeature.params, 'distance', 0) : 0;

  const outline: Shape2D = { kind: 'rect', cx: 0, cy: 0, w: L, h: W, cornerR };

  const cuts: Cut[] = holes.map((h) => ({
    kind: 'circle', cx: h.x, cy: h.y, r: h.d / 2, owner: h.owner,
  }));

  const geometry: Geometry = {
    outline,
    cuts,
    L, W, T,
    cornerR,
    chamfer,
    holes,
    slot: slotFeature
      ? {
          w: num(doc, slotFeature.params, 'length', 20),
          h: num(doc, slotFeature.params, 'width', 8),
          owner: slotFeature.id,
        }
      : null,
    shellWall: shell ? num(doc, shell.params, 'thickness', 0) : null,
    removedMm3: Math.max(0, envelope - volume),
    areaMm2,
  };

  return {
    doc: toPartDoc(doc, evaluated, L, W, T),
    geometry,
    prismatic: isPrismatic(mesh),
  };
}

/**
 * The document header the rules read: material, density and the driving dimensions.
 *
 * `globals` carries Length, Width and Thickness because the rule packs and the recipe engine
 * look them up by name. They are the measured envelope, not a stored parameter — the point of
 * this projection is that nothing here is a second place a dimension can be edited.
 */
function toPartDoc(
  doc: Document, evaluated: EvaluatedDocument, L: number, W: number, T: number,
): PartDoc {
  const named = parametersOf(doc);

  return {
    path: `${doc.name}.datum`,
    title: doc.name,
    configuration: 'Default',
    configurations: ['Default'],
    units: doc.units,
    material: doc.material,
    density: doc.density,
    writable: true,
    lastRebuildMs: evaluated.rebuildMs,
    globals: [
      { name: 'Length', value: L, units: doc.units },
      { name: 'Width', value: W, units: doc.units },
      { name: 'Thickness', value: T, units: doc.units },
      // The design's own driving dimensions, so a rule that cites one names it as the user does.
      ...Object.entries(named)
        .filter(([name]) => !['Length', 'Width', 'Thickness'].includes(name))
        .map(([name, value]) => ({ name, value, units: doc.units })),
    ],
    // The document's own release metadata first, so a part number the user set is the one
    // the rules check and the one the title block prints.
    properties: {
      Description: doc.name,
      Material: doc.material,
      ...(doc.properties ?? {}),
    },
    features: doc.features.map(toDocFeature),
  };
}

function toDocFeature(f: Feature): DocFeature {
  return {
    id: f.id,
    name: f.name,
    kind: KIND_MAP[f.kind] ?? 'unknown',
    swType: f.kind,
    suppressed: f.suppressed,
    createdByDatum: true,
    params: f.params,
  };
}

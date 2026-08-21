/**
 * Detail sheets: one dimensioned drawing per part, not one for the pile.
 *
 * An assembly drawing shows how the parts go together and dimensions almost nothing, because
 * the dimensions that matter belong to the parts. A shop cannot make anything from an assembly
 * view: the machinist making the bracket needs the bracket's own overall sizes, its hole
 * positions and its thicknesses, on a sheet with the bracket alone on it. That is what a detail
 * sheet is, and a CAD system that cannot produce one has not finished the job it started when
 * it drew the assembly.
 *
 * ── How a part is recovered from an assembly ──
 *
 * By rebuilding it on its own: a document containing that component's feature and the modifiers
 * that follow it, evaluated by the same evaluator. Not by cutting the assembly's mesh apart.
 *
 * Slicing looks cheaper and is wrong in a way that matters. Where two components meet, the
 * union trims both, so the triangles belonging to the base of a bracket are the base *minus the
 * post standing on it* — an open shell with a hole where the joint was. It has no volume, no
 * mass, and no closed outline to dimension. What a machinist needs is the part as it was made,
 * before it met anything.
 *
 * A modifier is attributed to the component it actually changes, by trying it.
 *
 * Order alone is not enough, and the failure is quiet: a bolt pattern drilled through the base
 * of a frame, written after the post that stands on it, belongs to the post by order and cuts
 * nothing there — so the holes disappear from the pack entirely, and every sheet still looks
 * complete. Applying the modifier to each component and keeping it where the volume changes
 * costs a rebuild per pair and answers the question with the geometry rather than the typing
 * order. A hole through two plates changes both, and belongs on both sheets, which is also
 * what a shop would expect to receive.
 */

import { massProperties, triCount, type Mesh } from '../kernel/topo/mesh';
import {
  evaluateDocument,
  type Document, type EvaluatedDocument, type Feature, type FeatureKind,
} from '../model/document';
import { makeDrawing, type DrawingOptions } from './sheet';
import type { Drawing } from './dimension';

export interface DetailPart {
  featureId: string;
  /** What the sheet is titled. */
  name: string;
  mesh: Mesh;
  /** Triangles that came from this feature. */
  triangles: number;
}

/**
 * The parts an assembly is made of, each as its own mesh.
 *
 * Features that removed material rather than adding it own no triangles of their own in the
 * final solid — a hole is an absence — so they never appear here. Nothing has to be told which
 * features are components: the ones that contributed surface are the ones that did.
 */
export function componentMeshes(doc: Document, _evaluated?: EvaluatedDocument): DetailPart[] {
  const groups = componentGroups(doc);
  const parts: DetailPart[] = [];

  for (const group of groups) {
    const own: Document = { ...doc, features: group.features };
    const built = evaluateDocument(own);
    if (triCount(built.mesh) === 0) continue;

    parts.push({
      featureId: group.lead.id,
      name: group.lead.name,
      mesh: built.mesh,
      triangles: triCount(built.mesh),
    });
  }

  return parts;
}

/**
 * Kinds that make a body of their own, as against kinds that change the body already there.
 *
 * The distinction is the whole of what "a part" means in a flat feature tree: a box is a thing,
 * a fillet is something done to a thing.
 */
const MAKES_A_BODY = new Set<FeatureKind>([
  'archetype', 'box', 'cylinder', 'sphere', 'sketch', 'extrude', 'revolve', 'loft', 'sweep',
  'sheet', 'rib', 'dome',
]);

interface ComponentGroup {
  lead: Feature;
  /** The component's own feature, plus every modifier applied before the next component. */
  features: Feature[];
}

function componentGroups(doc: Document): ComponentGroup[] {
  const groups: ComponentGroup[] = [];
  const modifiers: Feature[] = [];

  for (const feature of doc.features) {
    if (feature.suppressed) continue;

    // A body added with `operation=cut` is removing material, whatever kind it is: a cylinder
    // used to bore a hole is a hole, and it is not a part anybody makes.
    const cutting = feature.params.operation === 'cut'
      || feature.params.operation === 'intersect';

    if (MAKES_A_BODY.has(feature.kind) && !cutting) {
      groups.push({ lead: feature, features: [feature] });
    } else if (groups.length > 0) {
      // A modifier before any body has nothing to modify and nothing to belong to.
      modifiers.push(feature);
    }
  }

  /*
   * Which component each modifier belongs to, measured rather than assumed.
   *
   * Every modifier is offered to every component, and kept where it changes the solid. Modifiers
   * are applied in document order within a group so a chamfer that depends on a hole still finds
   * it.
   */
  for (const modifier of modifiers) {
    for (const group of groups) {
      const before = evaluateDocument({ ...doc, features: group.features });
      const after = evaluateDocument({ ...doc, features: [...group.features, modifier] });

      const changed = Math.abs(
        massProperties(after.mesh).volume - massProperties(before.mesh).volume,
      ) > 1e-6 || triCount(after.mesh) !== triCount(before.mesh);

      if (changed) group.features.push(modifier);
    }
  }

  return groups;
}

export interface DetailSheet {
  /** Empty for the assembly sheet, set for a part. */
  featureId?: string;
  name: string;
  drawing: Drawing;
  /** 1 for the assembly, then one per part, as a drawing set is numbered. */
  sheet: number;
  of: number;
}

/**
 * A full set: the assembly, then a dimensioned sheet for every part in it.
 *
 * Numbered as a set — "2 of 7" — because that is how a drawing pack is issued and how a shop
 * knows whether it has all of it. A single-part document produces a set of one rather than an
 * assembly sheet and a duplicate of it; drawing the same thing twice under two titles is worse
 * than useless, because someone will eventually make two of them.
 */
export function makeDetailSheets(
  doc: Document, evaluated: EvaluatedDocument, opts: DrawingOptions = {},
): DetailSheet[] {
  const parts = componentMeshes(doc, evaluated);

  const title = (name: string, sheet: number, of: number) => ({
    ...opts,
    titleBlock: {
      ...opts.titleBlock,
      description: name,
      partNumber: opts.titleBlock?.partNumber ?? name.toUpperCase().replace(/[^A-Z0-9]+/g, '-'),
      material: opts.titleBlock?.material ?? doc.material,
      sheet: `${sheet} of ${of}`,
    },
  });

  // One part is not an assembly, whatever the tree says.
  if (parts.length <= 1) {
    return [{
      name: doc.name,
      drawing: makeDrawing(evaluated.mesh, title(doc.name, 1, 1)),
      sheet: 1,
      of: 1,
    }];
  }

  const of = parts.length + 1;
  const sheets: DetailSheet[] = [{
    name: doc.name,
    drawing: makeDrawing(evaluated.mesh, title(doc.name, 1, of)),
    sheet: 1,
    of,
  }];

  parts.forEach((part, i) => {
    sheets.push({
      featureId: part.featureId,
      name: part.name,
      drawing: makeDrawing(part.mesh, title(part.name, i + 2, of)),
      sheet: i + 2,
      of,
    });
  });

  return sheets;
}

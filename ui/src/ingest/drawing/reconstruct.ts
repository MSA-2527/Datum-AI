/**
 * Multi-view reconstruction: an orthographic drawing back into a 3D solid.
 *
 * A drawing with front, top and side views defines a solid completely, and recovering it is
 * a classic problem in solid modelling. The rigorous method (Wesley & Markowsky, 1981)
 * builds every candidate vertex from triples of view points, then every candidate edge, face
 * and finally solid, discarding whatever is not consistent with all three views. It is
 * complete but combinatorially expensive and produces multiple valid answers for ambiguous
 * input.
 *
 * The method used here is the practical one: **intersection of extruded prisms**. Each view's
 * outline is extruded infinitely along its own viewing axis, and the solid is the
 * intersection of those prisms. That is exactly the visual hull, and for the prismatic and
 * turned parts that make up the overwhelming majority of engineering drawings it *is* the
 * part.
 *
 * The limitation is real and is reported rather than hidden: the visual hull cannot see a
 * cavity that is fully enclosed, and it fills any concavity not visible in silhouette from
 * one of the given directions. A part with an internal void reconstructs as solid, and the
 * result says so. Adding a section view resolves it, which is exactly why draughtsmen draw
 * section views.
 */

import { type Vec2, type Vec3 } from '../../kernel/math/vec';
import { makeProfile, profileArea, signedArea2, type Profile } from '../../kernel/sketch/profile';
import { XY, XZ, YZ, extrude, type Plane } from '../../kernel/ops/build';
import { boolean } from '../../kernel/ops/boolean';
import { bounds, health, massProperties, type Mesh } from '../../kernel/topo/mesh';
import { assembleLoops, flatten, UNIT_TO_MM, type DxfDocument, type FlatPath } from './dxf';
import { inferThickness } from './thickness';

// ── view recognition ─────────────────────────────────────────────────────────

export type ViewRole = 'front' | 'top' | 'right' | 'unknown';

export interface RecognisedView {
  role: ViewRole;
  /** Loops in this view's own local coordinates, origin at the view's lower-left. */
  loops: Vec2[][];
  /** Where the view sat on the sheet. */
  origin: Vec2;
  size: Vec2;
  confidence: number;
  reason: string;
}

/**
 * Clusters loose geometry into separate views by spatial gaps.
 *
 * Views on a sheet are separated by whitespace, so a single-linkage clustering on bounding
 * boxes recovers them. The gap threshold is derived from the drawing's own size rather than
 * fixed, because a gap that separates views on an A4 sheet is smaller than a feature on an
 * A0 one.
 */
export function clusterViews(loops: Vec2[][], gapFactor = 0.06): Vec2[][][] {
  if (loops.length === 0) return [];

  const boxes = loops.map(loopBounds);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.min[0]); maxX = Math.max(maxX, b.max[0]);
    minY = Math.min(minY, b.min[1]); maxY = Math.max(maxY, b.max[1]);
  }
  const span = Math.max(maxX - minX, maxY - minY);
  const gap = span * gapFactor;

  // Union-find over loops whose boxes are within `gap` of each other.
  const parent = loops.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => { parent[find(a)] = find(b); };

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxesNear(boxes[i], boxes[j], gap)) join(i, j);
    }
  }

  const groups = new Map<number, Vec2[][]>();
  loops.forEach((loop, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(loop); else groups.set(root, [loop]);
  });

  return [...groups.values()];
}

function loopBounds(loop: Vec2[]): { min: Vec2; max: Vec2 } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of loop) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

function boxesNear(a: { min: Vec2; max: Vec2 }, b: { min: Vec2; max: Vec2 }, gap: number): boolean {
  return (
    a.min[0] - gap <= b.max[0] && a.max[0] + gap >= b.min[0] &&
    a.min[1] - gap <= b.max[1] && a.max[1] + gap >= b.min[1]
  );
}

/**
 * Assigns roles to clustered views by their alignment.
 *
 * In both first- and third-angle projection the top view shares the front view's width and
 * sits directly above or below it, and the side view shares its height and sits beside it.
 * Those alignments are the whole convention, and they are what makes a drawing readable
 * without labels — so they are what identifies the views here.
 */
export function assignRoles(clusters: Vec2[][][]): RecognisedView[] {
  const infos = clusters.map((loops) => {
    const all = loops.flat();
    const b = loopBounds(all);
    return {
      loops,
      origin: b.min,
      size: [b.max[0] - b.min[0], b.max[1] - b.min[1]] as Vec2,
      centre: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2] as Vec2,
      area: (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]),
    };
  });

  if (infos.length === 0) return [];

  // The front view is conventionally the most informative, which in practice means the one
  // with the most geometry.
  const frontIdx = infos.reduce(
    (best, info, i) => (info.loops.flat().length > infos[best].loops.flat().length ? i : best),
    0,
  );
  const front = infos[frontIdx];

  const out: RecognisedView[] = [];
  const tol = Math.max(front.size[0], front.size[1]) * 0.08;

  infos.forEach((info, i) => {
    if (i === frontIdx) {
      out.push({
        role: 'front', loops: info.loops, origin: info.origin, size: info.size,
        confidence: 0.9,
        reason: 'Taken as the front view: it carries the most geometry, which is the convention.',
      });
      return;
    }

    // Roles come from *alignment*, not from matching sizes.
    //
    // Requiring the top view to be exactly as wide as the front view works only for a plain
    // block. Give the part a step, a boss or a flange and the two views legitimately differ
    // in extent while remaining perfectly aligned — which is the actual convention, and the
    // reason a reader can identify the views without labels. Judging by size instead sends
    // every stepped part down the single-view path and silently invents a thickness.
    const dx = info.centre[0] - front.centre[0];
    const dy = info.centre[1] - front.centre[1];

    const overlapX = Math.min(info.origin[0] + info.size[0], front.origin[0] + front.size[0]) -
                     Math.max(info.origin[0], front.origin[0]);
    const overlapY = Math.min(info.origin[1] + info.size[1], front.origin[1] + front.size[1]) -
                     Math.max(info.origin[1], front.origin[1]);

    // "Substantially overlapping" means most of the smaller view's extent lines up.
    const sharesX = overlapX > Math.min(info.size[0], front.size[0]) * 0.6;
    const sharesY = overlapY > Math.min(info.size[1], front.size[1]) * 0.6;

    if (Math.abs(dy) > Math.abs(dx) && sharesX) {
      const above = dy > 0;
      out.push({
        role: 'top', loops: info.loops, origin: info.origin, size: info.size,
        confidence: 0.85,
        reason:
          `Identified as the ${above ? 'top' : 'bottom'} view: it sits directly ` +
          `${above ? 'above' : 'below'} the front view and shares ` +
          `${overlapX.toFixed(1)} mm of its width, which is how the projection convention ` +
          `lines views up.`,
      });
      return;
    }

    if (Math.abs(dx) > Math.abs(dy) && sharesY) {
      out.push({
        role: 'right', loops: info.loops, origin: info.origin, size: info.size,
        confidence: 0.85,
        reason:
          `Identified as the side view: it sits beside the front view and shares ` +
          `${overlapY.toFixed(1)} mm of its height.`,
      });
      return;
    }
    void tol;

    out.push({
      role: 'unknown', loops: info.loops, origin: info.origin, size: info.size,
      confidence: 0.2,
      reason:
        'This group is neither aligned with nor the same size as the front view, so its ' +
        'role could not be determined. It may be a detail, a title block, or a second part.',
    });
  });

  return out;
}

// ── profiles ─────────────────────────────────────────────────────────────────

/**
 * Turns a view's loops into a profile, nesting holes inside their enclosing outline.
 *
 * Loop nesting is determined by containment and area, not by winding: DXF exporters are
 * wildly inconsistent about winding direction, and trusting it produces parts with their
 * holes filled and their outsides hollow.
 */
export function loopsToProfile(loops: Vec2[][], origin: Vec2 = [0, 0]): Profile | null {
  if (loops.length === 0) return null;

  const shifted = loops.map((l) => l.map(([x, y]) => [x - origin[0], y - origin[1]] as Vec2));
  const areas = shifted.map((l) => Math.abs(signedArea2(l)) / 2);

  const outerIdx = areas.reduce((best, a, i) => (a > areas[best] ? i : best), 0);
  const outer = shifted[outerIdx];

  const holes: Vec2[][] = [];
  for (let i = 0; i < shifted.length; i++) {
    if (i === outerIdx) continue;
    if (areas[i] < 1e-9) continue;
    if (pointInLoop(outer, centroidOf(shifted[i]))) holes.push(shifted[i]);
  }

  return makeProfile(outer, holes);
}

function centroidOf(loop: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of loop) { x += p[0]; y += p[1]; }
  return [x / loop.length, y / loop.length];
}

function pointInLoop(loop: Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    if (loop[i][1] > p[1] !== loop[j][1] > p[1]) {
      const x = loop[i][0] + ((p[1] - loop[i][1]) / (loop[j][1] - loop[i][1])) * (loop[j][0] - loop[i][0]);
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}

// ── reconstruction ───────────────────────────────────────────────────────────

export interface ReconstructionResult {
  mesh: Mesh;
  views: RecognisedView[];
  /** Volume of the reconstructed body, mm³. */
  volume: number;
  valid: boolean;
  /** What was assumed, what could not be recovered. Never omitted. */
  caveats: string[];
  notes: string[];
}

export interface ReconstructOptions {
  /** Thickness used when only one view is available. Overrides every inference. */
  singleViewThickness?: number;
  tolerance?: number;
  /**
   * Text found in the drawing.
   *
   * A one-view drawing normally writes its thickness down rather than showing it, so these
   * strings are often the difference between reading a dimension and inventing one.
   */
  annotations?: string[];
  /** Drawing units to millimetres, applied to a thickness read out of the text. */
  toMm?: number;
}

/**
 * Diameters of the closed inner loops in a view, in drawing units.
 *
 * Used to recognise a fastener pattern. Only near-circular loops count: a rectangular cutout
 * has a bounding box too, and treating its width as a "hole diameter" would invent an M-size
 * that was never there. The roundness test is the ratio of the loop's two bounding extents
 * together with the area it actually encloses against the circle those extents imply.
 */
function holeDiameters(v: RecognisedView): number[] {
  const out: number[] = [];

  // Loop 0 is the outer boundary; the rest are holes.
  for (let i = 1; i < v.loops.length; i++) {
    const loop = v.loops[i];
    if (loop.length < 6) continue;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of loop) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const w = maxX - minX, h = maxY - minY;
    if (w <= 0 || h <= 0) continue;
    if (Math.abs(w - h) / Math.max(w, h) > 0.15) continue; // not round

    let area2 = 0;
    for (let k = 0; k < loop.length; k++) {
      const [x1, y1] = loop[k];
      const [x2, y2] = loop[(k + 1) % loop.length];
      area2 += x1 * y2 - x2 * y1;
    }
    const area = Math.abs(area2) / 2;
    const d = (w + h) / 2;
    const circle = Math.PI * (d / 2) ** 2;
    if (circle <= 0 || Math.abs(area - circle) / circle > 0.2) continue;

    out.push(d);
  }

  return out;
}

/**
 * Reconstructs a solid from recognised views by intersecting extruded prisms.
 */
export function reconstruct(views: RecognisedView[], opts: ReconstructOptions = {}): ReconstructionResult {
  const caveats: string[] = [];
  const notes: string[] = [];

  const usable = views.filter((v) => v.role !== 'unknown');
  if (usable.length === 0) {
    return {
      mesh: emptyMesh(), views, volume: 0, valid: false,
      caveats: ['No view could be identified, so nothing could be reconstructed.'],
      notes: [],
    };
  }

  // A single view gives only a flat plate: there is no second opinion about depth.
  if (usable.length === 1) {
    const v = usable[0];
    const profile = loopsToProfile(v.loops, v.origin);
    if (!profile) {
      return { mesh: emptyMesh(), views, volume: 0, valid: false, caveats: ['The view had no closed outline.'], notes: [] };
    }

    // The depth is not shown, but it is usually still knowable — see `inferThickness`. An
    // explicit option always wins; otherwise read the drawing's own text, then the fastener
    // pattern, and only then fall back to a proportion of the plan.
    const estimate = inferThickness({
      annotations: opts.annotations ?? [],
      holeDiametersMm: holeDiameters(v),
      planMm: Math.min(v.size[0], v.size[1]),
      toMm: opts.toMm,
    });
    const thickness = opts.singleViewThickness ?? estimate.mm;

    const mesh = extrude(profile, planeFor(v.role), { distance: thickness, feature: 'FromDrawing' });

    if (opts.singleViewThickness !== undefined) {
      caveats.push(`Only one view was found; the depth was set to ${thickness.toFixed(1)} mm as given.`);
    } else {
      caveats.push(
        `Only one view was found, so the depth is not drawn. ${estimate.because}` +
        (estimate.authoritative ? '' : ' Add a second view to measure it instead.'),
      );
    }

    return {
      mesh, views, volume: Math.abs(massProperties(mesh).volume),
      valid: health(mesh).closed, caveats, notes,
    };
  }

  // Two or three views: intersect their prisms.
  //
  // Views must be aligned by the axis they *share*, not each shifted to its own bounding
  // box. A drawing's whole convention is that a feature 30 mm from the left in the front
  // view is 30 mm from the left in the top view; normalising each view independently
  // discards that, and it only looks correct while both views happen to have the same
  // extent. Give a part a step — so the top view is narrower than the front — and
  // independently normalised views place the step in two different places, and the
  // intersection silently removes real material.
  const front = usable.find((v) => v.role === 'front');
  const top = usable.find((v) => v.role === 'top');
  const right = usable.find((v) => v.role === 'right');

  const originFor = (v: RecognisedView): Vec2 => {
    switch (v.role) {
      case 'front':
        return v.origin;
      case 'top':
        // Shares X with the front view; its own vertical axis is the part's depth.
        return [front ? front.origin[0] : v.origin[0], v.origin[1]];
      case 'right':
        // Shares Z (the page's vertical) with the front view.
        return [v.origin[0], front ? front.origin[1] : v.origin[1]];
      default:
        return v.origin;
    }
  };
  void top; void right;

  const prisms: { mesh: Mesh; role: ViewRole }[] = [];

  for (const v of usable) {
    const profile = loopsToProfile(v.loops, originFor(v));
    if (!profile || profileArea(profile) < 1e-9) {
      caveats.push(`The ${v.role} view had no closed outline and was ignored.`);
      continue;
    }

    // Extrude well past the part in both directions so the prism is effectively infinite.
    const reach = Math.max(...usable.map((u) => Math.max(u.size[0], u.size[1]))) * 3;
    const plane = planeFor(v.role);

    prisms.push({
      mesh: extrude(profile, plane, {
        distance: reach, midplane: true, feature: `From${v.role}`,
      }),
      role: v.role,
    });
  }

  if (prisms.length === 0) {
    return { mesh: emptyMesh(), views, volume: 0, valid: false, caveats: [...caveats, 'No view produced a usable outline.'], notes: [] };
  }

  let result = prisms[0].mesh;
  for (let i = 1; i < prisms.length; i++) {
    const r = boolean(result, prisms[i].mesh, 'intersection');
    if (!r.valid && r.diagnostic) caveats.push(r.diagnostic);
    result = r.mesh;
  }

  notes.push(
    `Reconstructed by intersecting the ${prisms.map((p) => p.role).join(', ')} view` +
    `${prisms.length === 1 ? '' : 's'}.`,
  );

  caveats.push(
    'This is the visual hull of the given views. It cannot recover a fully enclosed cavity, ' +
    'and any concavity not visible in silhouette from one of these directions is filled in. ' +
    'A section view would resolve both.',
  );

  const vol = Math.abs(massProperties(result).volume);
  if (vol < 1e-6) {
    caveats.push(
      'The views do not overlap in space, so their intersection is empty. ' +
      'This usually means the views were placed by a convention the importer did not expect.',
    );
  }

  return {
    mesh: result, views, volume: vol,
    valid: health(result).closed && vol > 1e-6,
    caveats, notes,
  };
}

/**
 * The sketch plane a view's outline lives in.
 *
 * The front view's page axes are world X and Z; the top view's are X and Y; the side view's
 * are Y and Z. Getting any of these wrong produces a part that is correct in size and wrong
 * in orientation, which then fails to intersect with the others and yields nothing.
 */
function planeFor(role: ViewRole): Plane {
  switch (role) {
    case 'front': return XZ;
    case 'top': return XY;
    case 'right': return YZ;
    default: return XY;
  }
}

function emptyMesh(): Mesh {
  return { positions: new Float64Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0), tags: new Map() };
}

// ── whole pipeline ───────────────────────────────────────────────────────────

export interface ImportResult extends ReconstructionResult {
  paths: FlatPath[];
  layers: string[];
  openOutlines: number;
  report: string[];
}

/**
 * The whole path from a DXF file to a solid.
 */
export function importDrawing(doc: DxfDocument, opts: ReconstructOptions = {}): ImportResult {
  const tol = opts.tolerance ?? 0.05;
  const paths = flatten(doc, { tolerance: tol });
  const assembled = assembleLoops(paths, Math.max(tol, 0.05));

  const clusters = clusterViews(assembled.closed);
  const views = assignRoles(clusters);

  // The drawing's own text and unit scale travel with it, so a one-view import can read the
  // thickness the drafter wrote down instead of guessing at it. Explicit options still win.
  const built = reconstruct(views, {
    annotations: doc.annotations,
    toMm: UNIT_TO_MM[doc.units],
    ...opts,
  });

  const report = [
    ...doc.report.warnings,
    ...assembled.report,
    ...views.map((v) => `${v.role.toUpperCase()}: ${v.reason}`),
    ...built.notes,
  ];

  return {
    ...built,
    paths,
    layers: doc.layers,
    openOutlines: assembled.open.length,
    report,
  };
}

/**
 * Splits a reconstructed body into separate parts where it is not connected.
 *
 * A drawing sheet often carries several parts. Treating them as one body would give a single
 * component with a nonsense mass, so disconnected regions are separated into an assembly of
 * their own right.
 */
export function splitBodies(mesh: Mesh): Mesh[] {
  const n = mesh.indices.length / 3;
  if (n === 0) return [];

  // Union-find over triangles sharing a vertex.
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const join = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const byVertex = new Map<number, number>();
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k];
      const seen = byVertex.get(v);
      if (seen === undefined) byVertex.set(v, t);
      else join(t, seen);
    }
  }

  const groups = new Map<number, number[]>();
  for (let t = 0; t < n; t++) {
    const r = find(t);
    const list = groups.get(r);
    if (list) list.push(t); else groups.set(r, [t]);
  }

  if (groups.size <= 1) return [mesh];

  const out: Mesh[] = [];
  for (const tris of groups.values()) {
    const indices = new Uint32Array(tris.length * 3);
    const faceIds = new Uint32Array(tris.length);
    tris.forEach((t, i) => {
      indices[i * 3] = mesh.indices[t * 3];
      indices[i * 3 + 1] = mesh.indices[t * 3 + 1];
      indices[i * 3 + 2] = mesh.indices[t * 3 + 2];
      faceIds[i] = mesh.faceIds[t];
    });
    out.push({ positions: mesh.positions, indices, faceIds, tags: mesh.tags });
  }

  // Largest first, which is almost always the main part.
  return out.sort((a, b) => volumeOf(b) - volumeOf(a));
}

const volumeOf = (m: Mesh): number => Math.abs(massProperties(m).volume);

/** Overall size of a reconstructed body, for reporting back to the user. */
export function describeReconstruction(r: ReconstructionResult): string {
  if (!r.valid) return 'Reconstruction did not produce a valid solid.';
  const b = bounds(r.mesh);
  const size: Vec3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  return (
    `${size[0].toFixed(1)} x ${size[1].toFixed(1)} x ${size[2].toFixed(1)} mm, ` +
    `${(r.volume / 1000).toFixed(1)} cm³, from ${r.views.filter((v) => v.role !== 'unknown').length} views.`
  );
}

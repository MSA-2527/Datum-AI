/**
 * Measuring what is selected.
 *
 * The tool a person reaches for more often than any other in a CAD package, and the one that
 * decides whether a model can be trusted: a part you cannot interrogate is a picture. Pick a
 * face and it tells you its area and where it sits; pick two and it tells you the distance
 * between them, or the angle if they are not parallel, or the centre distance if they are
 * round.
 *
 * Everything is read from the triangles through the face graph rather than from the feature
 * that made them. A dimension that only reports what was typed cannot catch the case worth
 * catching — geometry that did not come out the way the parameters said.
 */

import { buildFaceGraph, type FaceInfo } from '../kernel/topo/facegraph';
import { type Mesh } from '../kernel/topo/mesh';
import { type Vec3 } from '../kernel/math/vec';

export interface Measurement {
  /** One line per fact, in the order a person would read them. */
  lines: { label: string; value: string }[];
  /** What is being measured, for the panel heading. */
  subject: string;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** Millimetres, to a hundredth — finer than any of this geometry is meaningful to. */
const mm = (v: number) => `${v.toFixed(2)} mm`;
const deg = (v: number) => `${v.toFixed(2)}°`;

/** Square millimetres below a square centimetre, cm² above, because 4 512 mm² reads as noise. */
function area(v: number): string {
  return v >= 100 ? `${(v / 100).toFixed(2)} cm²` : `${v.toFixed(1)} mm²`;
}

const point = (p: Vec3) => `${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)}`;

/** The angle between two directions, folded to 0–90: a face has no front or back here. */
function betweenDeg(a: Vec3, b: Vec3): number {
  const c = Math.min(1, Math.max(-1, Math.abs(dot(a, b))));
  return (Math.acos(c) * 180) / Math.PI;
}

function describeOne(f: FaceInfo): Measurement {
  const lines: { label: string; value: string }[] = [];

  if (f.tag.kind === 'cylindrical' || f.tag.kind === 'conical') {
    if (f.radius !== undefined) lines.push({ label: 'Diameter', value: mm(f.radius * 2) });
    if (f.extent) lines.push({ label: 'Length', value: mm(f.extent[1] - f.extent[0]) });
    lines.push({ label: 'Axis', value: point(f.axis) });
  } else if (f.tag.kind === 'spherical' && f.radius !== undefined) {
    lines.push({ label: 'Diameter', value: mm(f.radius * 2) });
  } else {
    lines.push({ label: 'Normal', value: point(f.axis) });
  }

  lines.push({ label: 'Area', value: area(f.area) });
  lines.push({ label: 'Centre', value: point(f.centroid) });

  // The role is what the face graph decided it is *for* — a bore rather than "a cylinder",
  // a seat rather than "a big flat one". It is the part of this a drawing would carry.
  lines.push({ label: 'Kind', value: `${f.role} (${f.tag.kind})` });

  return { subject: `Face ${f.id}`, lines };
}

function describeTwo(a: FaceInfo, b: FaceInfo): Measurement {
  const lines: { label: string; value: string }[] = [];
  const angle = betweenDeg(a.axis, b.axis);
  const parallel = angle < 0.5;

  const bothFlat = a.tag.kind === 'planar' && b.tag.kind === 'planar';
  const bothRound = (a.radius !== undefined) && (b.radius !== undefined);

  if (bothFlat && parallel) {
    // Along the shared normal, not centre to centre: two faces of a plate are 10 mm apart
    // however far their centroids are offset sideways, and the offset is not the thickness.
    lines.push({ label: 'Distance', value: mm(Math.abs(dot(sub(b.centroid, a.centroid), a.axis))) });
    lines.push({ label: 'Offset', value: mm(len(sub(b.centroid, a.centroid))) });
  } else if (bothFlat) {
    lines.push({ label: 'Angle', value: deg(angle) });
    lines.push({ label: 'Centres', value: mm(len(sub(b.centroid, a.centroid))) });
  } else if (bothRound && a.origin && b.origin && parallel) {
    // Centre distance across the axes, which is what a bolt spacing or a gear centre is —
    // measured perpendicular to the shared axis so the axial offset does not inflate it.
    const between = sub(b.origin, a.origin);
    const along = dot(between, a.axis);
    const across: Vec3 = [
      between[0] - a.axis[0] * along,
      between[1] - a.axis[1] * along,
      between[2] - a.axis[2] * along,
    ];
    lines.push({ label: 'Centre distance', value: mm(len(across)) });
    if (a.radius !== undefined && b.radius !== undefined) {
      lines.push({ label: 'Diameters', value: `${mm(a.radius * 2)} and ${mm(b.radius * 2)}` });
    }
  } else {
    lines.push({ label: 'Centres', value: mm(len(sub(b.centroid, a.centroid))) });
    lines.push({ label: 'Angle', value: deg(angle) });
  }

  lines.push({ label: 'Total area', value: area(a.area + b.area) });
  return { subject: `Faces ${a.id} and ${b.id}`, lines };
}

/**
 * Measures the selected faces.
 *
 * Returns nothing when nothing is selected, rather than a panel of dashes: an empty readout
 * that is always on screen teaches people to stop looking at it.
 */
export function measureFaces(mesh: Mesh, selected: number[]): Measurement | null {
  if (selected.length === 0) return null;

  const graph = buildFaceGraph(mesh);
  const faces = selected
    .map((id) => graph.faces.get(id))
    .filter((f): f is FaceInfo => f !== undefined);

  if (faces.length === 0) return null;
  if (faces.length === 1) return describeOne(faces[0]!);
  if (faces.length === 2) return describeTwo(faces[0]!, faces[1]!);

  const total = faces.reduce((s, f) => s + f.area, 0);
  return {
    subject: `${faces.length} faces`,
    lines: [
      { label: 'Total area', value: area(total) },
      { label: 'Largest', value: area(Math.max(...faces.map((f) => f.area))) },
      { label: 'Smallest', value: area(Math.min(...faces.map((f) => f.area))) },
    ],
  };
}

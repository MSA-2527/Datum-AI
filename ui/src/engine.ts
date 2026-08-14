/**
 * The engine: one entry point for everything the application can model.
 *
 * ── Why this file exists ──
 *
 * This product began as a SOLIDWORKS add-in, and its geometry lived in SOLIDWORKS. That
 * arrangement makes the CAD seat a hard dependency: no licence, no product, and every
 * capability has to be expressed as something the host's API happens to support.
 *
 * The relationship is now inverted. The geometry engine underneath this file is complete and
 * self-contained — exact predicates, NURBS, a boolean kernel, a constraint solver, an
 * assembly mate solver, and drawing generation — so the application models on its own. It
 * needs no licence, no installation and no network. SOLIDWORKS becomes one of several
 * *connectors*: valuable when present, because a team standardised on it wants its native
 * files, and entirely absent from the critical path when it is not.
 *
 * Everything in here runs locally and synchronously. There is no server, no API key and no
 * telemetry in any of it.
 */

// ── geometry ─────────────────────────────────────────────────────────────────

export type { Vec2, Vec3, Mat4, Quat, Box3 } from './kernel/math/vec';
export {
  add3, sub3, mul3, dot3, cross3, len3, norm3, dist3, deg, rad,
  rotation, rotationAbout, translation, reflection, matMul, matInvert, xformPoint,
  boxCentre, boxSize, boxDiagonal, boxUnion, boxContains, boxOverlaps,
} from './kernel/math/vec';

export { orient2d, orient3d, coplanar, polygonArea2d } from './kernel/math/predicates';

export {
  mat, matFrom, luDecompose, luSolve, qrDecompose, qrSolve, svd, rank,
  conditionNumber, nullSpace, pseudoInverseSolve, invert as invertMatrix,
  determinant, quadraticRoots, cubicRoots, type Matrix,
} from './kernel/math/linalg';

export {
  arcToNurbs, circleToNurbs, lineToNurbs, interpolateCurve, approximateCurve,
  curvePoint, curveTangent, curveCurvature, curveLength, tessellateCurve,
  closestPointOnCurve, surfacePoint, surfaceNormal, polylineToNurbs,
  type NurbsCurve, type NurbsSurface,
} from './kernel/math/nurbs';

// ── solids ───────────────────────────────────────────────────────────────────

export {
  MeshBuilder, emptyMesh, triCount, vertCount, getVertex, getTriangle,
  bounds, surfaceArea, massProperties, health, signedVolume, orientOutward,
  transformMesh, flipMesh, concatMeshes, compact, repairTJunctions,
  vertexNormals, shadingMesh, trianglesByFace, raycast, pointInside,
  type Mesh, type FaceTag, type MassProperties, type MeshHealth,
} from './kernel/topo/mesh';

export {
  makeProfile, profileArea, profileCentroid, profileBounds, pointInProfile,
  triangulate, rectProfile, circleProfile, slotProfile, polygonProfile,
  offsetProfile, offsetPolygon, minimumFeatureSize, filletCorners, filletProfile,
  arcSegments, inscribedDeficit, CHORD_TOL, DEFAULT_CHORD_TOL,
  type Profile, type TessellationQuality, type CornerFilletResult,
} from './kernel/sketch/profile';

export {
  XY, XZ, YZ, planeFrom, extrude, revolve, sweep, loft, linePath,
  box, cylinder, sphere, cone, torus, extrudedVolume, revolvedVolume,
  type Plane, type ExtrudeOptions, type RevolveOptions, type SweepOptions, type LoftOptions,
} from './kernel/ops/build';

export {
  boolean, union, subtract, intersect, unionAll, subtractAll, clipByPlane,
  type BooleanOp, type BooleanResult,
} from './kernel/ops/boolean';

export {
  shell, filletEdges, chamferEdges, drillHole, linearPattern, circularPattern,
  mirrorBody, sharpEdges, edgeChains, edgesBetweenFaces, circularChain,
  minimumWallThickness,
  type ShellOptions, type FilletOptions, type ChamferOptions, type HoleOptions,
  type SolidEdge, type HoleKind,
} from './kernel/ops/modify';

// ── sketching ────────────────────────────────────────────────────────────────

export {
  emptySketch, addPoint, addLine, addCircle, constrain, solve as solveSketch,
  coordsOf, radiusOf, toPolyline,
  type Sketch, type SketchEntity, type Constraint, type ConstraintKind,
  type SolveResult as SketchSolveResult, type SolveStatus as SketchStatus,
} from './kernel/sketch/solver';

// ── assemblies ───────────────────────────────────────────────────────────────

export {
  emptyAssembly, addPart, addInstance, addMate, solveMates, findInterference,
  assemblyProperties, billOfMaterials, flattenAssembly, placedMesh, instanceTransform,
  type Assembly, type Part, type PartInstance, type Mate, type MateKind,
  type MateSolveResult, type Interference, type AssemblyProperties,
} from './kernel/assembly/assembly';

// ── generation ───────────────────────────────────────────────────────────────

export {
  ARCHETYPES, archetypeById,
  type Archetype, type ArchetypeResult, type ParamSpec, type BuildStep,
} from './generate/archetypes';

export {
  parseRequest, generateFromText, describeParams, applyFastenerDesignation,
  type ParseResult, type ParseFailure,
} from './generate/parse';

// ── import ───────────────────────────────────────────────────────────────────

export {
  traceImage, otsuThreshold, fitCircle, fitSegments, simplifyLoop, detectSymmetry,
  scaleFromKnownWidth, describeTrace,
  type RasterImage, type TraceOptions, type TracedShape, type TraceReport,
  type FittedSegment, type BuildSuggestion,
} from './ingest/image/trace';

export {
  readDxf, flatten as flattenDxf, assembleLoops, UNIT_TO_MM,
  type DxfDocument, type DxfEntity, type DxfUnits, type FlatPath,
} from './ingest/drawing/dxf';

export {
  importDrawing, reconstruct, clusterViews, assignRoles, loopsToProfile,
  splitBodies, describeReconstruction,
  type ImportResult, type ReconstructionResult, type RecognisedView, type ViewRole,
} from './ingest/drawing/reconstruct';

// ── drawings ─────────────────────────────────────────────────────────────────

export {
  project, viewDirection, hatchRegion, centreMarks, mergeCollinear,
  type ProjectedView, type ProjectedSegment, type ProjectedCircle,
  type StandardView, type LineStyle,
} from './drafting/project';

export {
  autoDimension, generalTolerance, formatDimension, formatFcf, suggestGdt,
  chooseScale, defaultTitleBlock, layoutViews, SHEET_MM, GDT_GLYPH,
  type Dimension, type Tolerance, type Drawing, type TitleBlock, type SheetSize,
  type FeatureControlFrame, type GdtSymbol, type BomLine,
} from './drafting/dimension';

export {
  makeDrawing, drawingToSvg, drawingToDxf, describeDrawing, stockSize,
  type DrawingOptions,
} from './drafting/sheet';

// ── capability description ───────────────────────────────────────────────────

import { ARCHETYPES } from './generate/archetypes';

export interface EngineCapability {
  id: string;
  title: string;
  /** What a user can actually do, in their words. */
  summary: string;
  /** Honest statement of what it will not do. Never omitted. */
  limits: string;
  needsSolidWorks: false;
}

/**
 * What the engine can do, and where each capability stops.
 *
 * Written for display in the product. Every entry states a limit, because a capability list
 * without them is a sales sheet, and a user who discovers the boundary by hitting it in the
 * middle of a job has been badly served.
 */
export const CAPABILITIES: EngineCapability[] = [
  {
    id: 'model',
    title: 'Model parts',
    summary:
      'Extrude, revolve, sweep and loft profiles into solids; cut, join and intersect them; ' +
      'shell, fillet, chamfer, draft, pattern and mirror. Exact mass, centre of mass and ' +
      'inertia at every step.',
    limits:
      'Solids are tessellated rather than analytic. Dimensions are exact, but the volume of ' +
      'a curved body runs low by a known amount — about 0.4% at the default quality, and ' +
      'under 0.03% at the finest. Rebuild at a finer quality when a mass will be quoted.',
    needsSolidWorks: false,
  },
  {
    id: 'sketch',
    title: 'Constrain sketches',
    summary:
      'Sixteen constraint types solved together — coincident, distance, angle, tangent, ' +
      'symmetric and the rest. The solver reports whether a sketch is under-defined, fully ' +
      'defined, over-defined or contradictory, and names the constraints at fault.',
    limits:
      'Two dimensions only. Sketches live on a plane; 3D curve constraints are not supported.',
    needsSolidWorks: false,
  },
  {
    id: 'generate',
    title: 'Build from a description',
    summary:
      `Type "make a cup" or "M10 hex nut" or "200 x 120 x 8 plate with 9 mm holes" and get a ` +
      `real feature tree with named, editable parameters. ${ARCHETYPES.length} shapes, ` +
      `covering vessels, fasteners, transmission and structural parts.`,
    limits:
      'The catalogue is finite. A request that matches nothing is refused with suggestions ' +
      'rather than answered with something approximate.',
    needsSolidWorks: false,
  },
  {
    id: 'image',
    title: 'Trace a picture into a part',
    summary:
      'A photo, scan or screenshot becomes a closed profile: the outline is traced, holes ' +
      'are found, and straight lines and arcs are recognised so the result carries real ' +
      'radii rather than thousands of pixel steps. Symmetric silhouettes are offered as ' +
      'revolves.',
    limits:
      'A scale must be given — an image records no size. Only the silhouette is recovered, ' +
      'so nothing behind the outline is known.',
    needsSolidWorks: false,
  },
  {
    id: 'drawingIn',
    title: 'Rebuild a part from its drawing',
    summary:
      'Read a DXF, recognise which cluster of geometry is which view by how the views line ' +
      'up, and intersect their extruded outlines to recover the solid.',
    limits:
      'This is the visual hull of the given views. A fully enclosed cavity cannot be seen ' +
      'from outside and will come back solid; a section view resolves it. Anything the ' +
      'reader could not parse is listed rather than dropped.',
    needsSolidWorks: false,
  },
  {
    id: 'drawingOut',
    title: 'Produce a manufacturing drawing',
    summary:
      'Standard views with true hidden-line removal, automatic dimensions with ISO 2768-m ' +
      'tolerances, hole callouts grouped as "4 x ⌀8", geometric tolerances, a title block ' +
      'with computed mass, and export to SVG and DXF.',
    limits:
      'Dimensioning covers the envelope and hole pattern. A drawing for a regulated part ' +
      'still needs an engineer to add the dimensions that carry the design intent.',
    needsSolidWorks: false,
  },
  {
    id: 'assembly',
    title: 'Assemble components',
    summary:
      'Place instances, mate them with coincident, concentric, distance, angle, parallel ' +
      'and lock, and let the solver position them. Interference detection tells a press fit ' +
      'from a collision. Mass, centre of mass and a rolled-up bill of materials.',
    limits:
      'Mates are solved statically. There is no motion study, and no contact simulation.',
    needsSolidWorks: false,
  },
  {
    id: 'manufacturing',
    title: 'Check manufacturability and cost',
    summary:
      'Rules for CNC machining, sheet metal, additive and injection moulding, each finding ' +
      'citing the rule it came from, plus an itemised cost model whose every input is shown.',
    limits:
      'Cost is an estimate from published rates, not a quotation. Treat it as a way to ' +
      'compare two designs, not as a price.',
    needsSolidWorks: false,
  },
];

/**
 * Optional connectors.
 *
 * These add value when present and are never on the critical path. The application models,
 * draws, checks and exports without any of them.
 */
export interface Connector {
  id: string;
  title: string;
  what: string;
  requires: string;
  status: 'available' | 'requires-setup' | 'unverified';
}

export const CONNECTORS: Connector[] = [
  {
    id: 'solidworks',
    title: 'SOLIDWORKS',
    what:
      'Push a model into a live SOLIDWORKS session as native features, and read an open ' +
      'document back. Useful when a team standardises on SOLIDWORKS files.',
    requires: 'A SOLIDWORKS licence (2022–2026) and the DATUM add-in registered.',
    // Honest: the add-in has never been compiled, because that needs the interop assemblies
    // that ship with a licensed installation.
    status: 'unverified',
  },
  {
    id: 'localModel',
    title: 'Local language model',
    what:
      'Interprets phrasing the built-in parser does not recognise, mapping it onto the same ' +
      'archetypes and parameters. Runs entirely on your machine.',
    requires: 'A llama.cpp or Ollama endpoint.',
    status: 'requires-setup',
  },
  {
    id: 'frontierModel',
    title: 'Frontier model',
    what: 'The same role as the local model, with better handling of unusual requests.',
    requires: 'Your own API key. No markup is added and no data is retained.',
    status: 'requires-setup',
  },
];

/** True when every headline capability works without any connector. Asserted by the tests. */
export const WORKS_OFFLINE = CAPABILITIES.every((c) => c.needsSolidWorks === false);

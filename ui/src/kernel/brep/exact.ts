/**
 * Exact solid modelling, through OpenCascade.
 *
 * The difference from `kernel/ops` is not accuracy in the loose sense — it is what a solid *is*.
 * Here a cylinder is a cylindrical surface with an axis and a radius, and the curve where it
 * meets a plane is a circle. In the mesh kernel a cylinder is twenty-four flat strips and that
 * curve is twenty-four short lines. Everything else follows from that:
 *
 *   - a fillet is a real rolling-ball blend, constructed rather than approximated by cutting;
 *   - a volume is the volume, not the volume of a prism inscribed in the shape;
 *   - exported STEP carries the surfaces themselves, which is what a CAM package wants;
 *   - three faces meeting at a corner blend correctly, which the swept-tool approach cannot do.
 *
 * The shapes never leave this module as OCCT handles. Everything returns a plain DATUM `Mesh` or
 * a number, so nothing downstream has to know the exact kernel exists, and nothing holds a
 * pointer into a WebAssembly heap that will be freed underneath it.
 */

import { exactKernel, type OpenCascade } from './load';
import { type Mesh } from '../topo/mesh';
import { type Vec3 } from '../math/vec';

/** An OCCT shape, opaque outside this module. */
type Shape = { readonly __shape: unique symbol };

/**
 * The bindings used here, named and typed at the point of use.
 *
 * The package ships no declarations, so this is the contract this module is asserting. Writing it
 * out is what makes a wrong call a compile error in this file rather than a runtime failure deep
 * inside the WebAssembly heap.
 */
interface Bindings {
  BRepPrimAPI_MakeBox_1: new (dx: number, dy: number, dz: number) => { Shape(): Shape };
  BRepPrimAPI_MakeCylinder_1: new (r: number, h: number) => { Shape(): Shape };
  BRepPrimAPI_MakeSphere_1: new (r: number) => { Shape(): Shape };

  // The two-shape overloads are the `_3` ones in this build — `_1` and `_2` take a pave filler,
  // not shapes. Probed rather than assumed: the numbering follows the C++ declaration order,
  // which is not the order anyone would guess from the documentation.
  BRepAlgoAPI_Fuse_3: new (a: Shape, b: Shape) => { Shape(): Shape };
  BRepAlgoAPI_Cut_3: new (a: Shape, b: Shape) => { Shape(): Shape };
  BRepAlgoAPI_Common_3: new (a: Shape, b: Shape) => { Shape(): Shape };

  BRepFilletAPI_MakeFillet: new (s: Shape, t: unknown) => {
    Add_2(radius: number, edge: unknown): void;
    // No arguments in this build. Passing a progress range — which later OCCT wants — made
    // `Build` fail without raising, so `IsDone` came back false and every blend was reported
    // as impossible.
    Build(): void;
    IsDone(): boolean;
    Shape(): Shape;
  };
  ChFi3d_FilletShape: { ChFi3d_Rational: unknown };

  BRepBuilderAPI_Transform_2: new (s: Shape, t: unknown, copy: boolean) => { Shape(): Shape };
  gp_Trsf_1: new () => { SetTranslation_1(v: unknown): void };
  gp_Vec_4: new (x: number, y: number, z: number) => unknown;

  TopExp_Explorer_2: new (s: Shape, kind: unknown, avoid: unknown) => {
    More(): boolean; Next(): void; Current(): unknown;
  };
  TopAbs_ShapeEnum: { TopAbs_EDGE: unknown; TopAbs_FACE: unknown; TopAbs_SHAPE: unknown };

  BRepMesh_IncrementalMesh_2: new (
    s: Shape, linear: number, relative: boolean, angular: number, parallel: boolean,
  ) => unknown;

  GProp_GProps_1: new () => { Mass(): number };
  BRepGProp: {
    VolumeProperties_1(s: Shape, p: unknown, onlyClosed: boolean, skip: boolean, useTri: boolean): void;
    SurfaceProperties_1(s: Shape, p: unknown, skip: boolean, useTri: boolean): void;
  };

  // Two arguments in this build. Later OCCT adds a mesh-purpose enum; asking for it here got a
  // read of undefined deep inside the WebAssembly heap rather than a useful error, which is the
  // reason the bindings are written out at all.
  BRep_Tool: { Triangulation(face: unknown, loc: unknown): unknown };
  // `TopExp_Explorer.Current()` hands back a generic `TopoDS_Shape`, and the fillet builder
  // wants a `TopoDS_Edge`. Without the cast the binding layer refuses the upcast with an error
  // from inside its own pointer machinery rather than anything a caller could act on.
  TopoDS: { Face_1(s: unknown): unknown; Edge_1(s: unknown): unknown };
  TopLoc_Location_1: new () => unknown;
}

const api = (oc: OpenCascade) => oc as unknown as Bindings;

// ── building ─────────────────────────────────────────────────────────────────

export interface ExactPrimitive {
  kind: 'box' | 'cylinder' | 'sphere';
  /** Box: length, width, height. Cylinder: diameter, height. Sphere: diameter. */
  size: [number, number, number];
  /** Centre of the primitive, in world coordinates. */
  at?: Vec3;
}

/**
 * Builds one primitive, centred where it was asked for.
 *
 * OCCT's primitives grow from a corner or an axis origin, and DATUM's are centred. Translating
 * here rather than at every call site is what keeps the two conventions from being mixed up in
 * the arithmetic of whatever is using them.
 */
function primitive(oc: OpenCascade, spec: ExactPrimitive): Shape {
  const b = api(oc);
  const [a1, a2, a3] = spec.size;
  const at = spec.at ?? [0, 0, 0];

  let shape: Shape;
  let offset: Vec3;

  switch (spec.kind) {
    case 'box':
      shape = new b.BRepPrimAPI_MakeBox_1(a1, a2, a3).Shape();
      offset = [at[0] - a1 / 2, at[1] - a2 / 2, at[2] - a3 / 2];
      break;
    case 'cylinder':
      shape = new b.BRepPrimAPI_MakeCylinder_1(a1 / 2, a2).Shape();
      offset = [at[0], at[1], at[2] - a2 / 2];
      break;
    default:
      shape = new b.BRepPrimAPI_MakeSphere_1(a1 / 2).Shape();
      offset = at;
      break;
  }

  if (offset[0] === 0 && offset[1] === 0 && offset[2] === 0) return shape;

  const trsf = new b.gp_Trsf_1();
  trsf.SetTranslation_1(new b.gp_Vec_4(offset[0], offset[1], offset[2]));
  return new b.BRepBuilderAPI_Transform_2(shape, trsf, true).Shape();
}

export type ExactOp = 'fuse' | 'cut' | 'common';

function combine(oc: OpenCascade, a: Shape, bShape: Shape, op: ExactOp): Shape {
  const b = api(oc);

  const Ctor = op === 'cut' ? b.BRepAlgoAPI_Cut_3
    : op === 'common' ? b.BRepAlgoAPI_Common_3
      : b.BRepAlgoAPI_Fuse_3;

  return new Ctor(a, bShape).Shape();
}

/**
 * Rounds every edge of a shape, as a true blend.
 *
 * This is the operation the mesh kernel cannot do properly. There, a fillet is a swept tool cut
 * from the solid, and where three filleted edges meet at a corner the three tools do not agree
 * about what the corner should be — so it comes out as slivers, or the operation gives up. Here
 * the blend surfaces are constructed and the corner patch between them is solved for.
 *
 * Returns null rather than throwing when the blend cannot be built. A radius larger than the
 * geometry can carry is a legitimate thing to ask for and find out about, not an exception.
 */
function filletAll(oc: OpenCascade, shape: Shape, radius: number): Shape | null {
  const b = api(oc);
  if (!(radius > 0)) return shape;

  const maker = new b.BRepFilletAPI_MakeFillet(shape, b.ChFi3d_FilletShape.ChFi3d_Rational);

  const explorer = new b.TopExp_Explorer_2(
    shape, b.TopAbs_ShapeEnum.TopAbs_EDGE, b.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );

  /*
   * Each edge once, not once per face it borders.
   *
   * `TopExp_Explorer` walks the topology, so an edge shared by two faces is visited twice — a
   * box reports twenty-four rather than twelve. Feeding a blend builder the same edge twice is
   * asking it to round the same corner to two different surfaces.
   */
  const seen = new Set<string>();
  let edges = 0;

  while (explorer.More()) {
    const edge = b.TopoDS.Edge_1(explorer.Current());
    const key = String((edge as { HashCode?: (n: number) => number }).HashCode?.(1e9) ?? edges);

    if (!seen.has(key)) {
      seen.add(key);
      maker.Add_2(radius, edge);
      edges++;
    }
    explorer.Next();
  }
  if (edges === 0) return shape;

  try {
    maker.Build();
    return maker.IsDone() ? maker.Shape() : null;
  } catch {
    return null;
  }
}

// ── reading results back ─────────────────────────────────────────────────────

/** Exact volume, in cubic millimetres. Not the volume of a prism inscribed in the shape. */
function volumeOf(oc: OpenCascade, shape: Shape): number {
  const b = api(oc);
  const props = new b.GProp_GProps_1();
  b.BRepGProp.VolumeProperties_1(shape, props, true, false, false);
  return Math.abs(props.Mass());
}

/** Exact surface area, in square millimetres. */
function areaOf(oc: OpenCascade, shape: Shape): number {
  const b = api(oc);
  const props = new b.GProp_GProps_1();
  b.BRepGProp.SurfaceProperties_1(shape, props, false, false);
  return Math.abs(props.Mass());
}

/**
 * Tessellates an exact shape into a mesh the viewport can draw.
 *
 * The display is still triangles — every display is — but they come from the true surface at a
 * stated chordal tolerance rather than being the definition of the shape. So a cylinder is
 * round to a hundredth of a millimetre because that is what was asked for, and can be re-drawn
 * finer without the model changing.
 */
function tessellate(oc: OpenCascade, shape: Shape, tolerance: number): Mesh {
  const b = api(oc);
  new b.BRepMesh_IncrementalMesh_2(shape, tolerance, false, 0.35, false);

  const positions: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];

  const explorer = new b.TopExp_Explorer_2(
    shape, b.TopAbs_ShapeEnum.TopAbs_FACE, b.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );

  let faceId = 0;

  while (explorer.More()) {
    const face = b.TopoDS.Face_1(explorer.Current());
    const location = new b.TopLoc_Location_1();
    const tri = b.BRep_Tool.Triangulation(face, location) as {
      IsNull?(): boolean;
      get(): {
        NbNodes(): number;
        NbTriangles(): number;
        Node(i: number): { X(): number; Y(): number; Z(): number };
        Triangle(i: number): { Value(i: number): number };
      };
    } | null;

    if (tri && !(tri.IsNull?.() ?? false)) {
      const t = tri.get();
      const base = positions.length / 3;

      for (let i = 1; i <= t.NbNodes(); i++) {
        const p = t.Node(i);
        positions.push(p.X(), p.Y(), p.Z());
      }

      for (let i = 1; i <= t.NbTriangles(); i++) {
        const face3 = t.Triangle(i);
        indices.push(
          base + face3.Value(1) - 1,
          base + face3.Value(2) - 1,
          base + face3.Value(3) - 1,
        );
        faceIds.push(faceId);
      }
    }

    faceId++;
    explorer.Next();
  }

  return {
    positions: Float64Array.from(positions),
    indices: Uint32Array.from(indices),
    faceIds: Uint32Array.from(faceIds),
    tags: new Map(),
  };
}

// ── the public surface ───────────────────────────────────────────────────────

export interface ExactStep {
  primitive: ExactPrimitive;
  /** How to combine it with what has been built so far. The first step is ignored. */
  op?: ExactOp;
}

export interface ExactResult {
  mesh: Mesh;
  /** Exact, from the surfaces themselves. */
  volume: number;
  area: number;
  /** Faces in the boundary representation — six for a box, three for a cylinder. */
  faces: number;
  /** Set when a requested blend could not be built. */
  problem?: string;
}

/**
 * Builds a solid exactly, and hands back a mesh and the true measurements.
 *
 * Deliberately a single call that takes the whole recipe rather than a set of functions that
 * pass shapes about. OCCT shapes are handles into a WebAssembly heap; letting them escape into
 * application code is how a modeller acquires a class of bug where a shape is used after the
 * kernel has moved on, and those are miserable to find.
 */
export async function buildExact(
  steps: ExactStep[], options: { fillet?: number; tolerance?: number } = {},
): Promise<ExactResult> {
  const oc = await exactKernel();
  const tolerance = options.tolerance ?? 0.01;

  if (steps.length === 0) {
    return {
      mesh: { positions: new Float64Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0), tags: new Map() },
      volume: 0, area: 0, faces: 0,
    };
  }

  let shape = primitive(oc, steps[0]!.primitive);
  for (let i = 1; i < steps.length; i++) {
    shape = combine(oc, shape, primitive(oc, steps[i]!.primitive), steps[i]!.op ?? 'fuse');
  }

  let problem: string | undefined;

  if (options.fillet && options.fillet > 0) {
    const rounded = filletAll(oc, shape, options.fillet);
    if (rounded) shape = rounded;
    else {
      problem = `A ${options.fillet} mm blend could not be built on this shape. `
        + 'The radius is probably larger than a face it has to run across.';
    }
  }

  let faces = 0;
  const b = api(oc);
  const counter = new b.TopExp_Explorer_2(
    shape, b.TopAbs_ShapeEnum.TopAbs_FACE, b.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  while (counter.More()) { faces++; counter.Next(); }

  return {
    mesh: tessellate(oc, shape, tolerance),
    volume: volumeOf(oc, shape),
    area: areaOf(oc, shape),
    faces,
    ...(problem ? { problem } : {}),
  };
}

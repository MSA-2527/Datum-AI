import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  closestNamedView, defaultCamera, fit, mmPerPixel, namedView, orbit, pan, pickRay,
  projectionMatrix, viewMatrix, zoomAt, type CameraState, type NamedView,
} from '../viewport/camera';
import { SolidRenderer, webglAvailable, type DisplayMode } from '../viewport/renderer';
import {
  gridFor, projectPoint, scaleBarFor, triadFor, viewCubeFaces, viewCubeHit,
} from '../viewport/overlay';
import { measureBetween, snap, type SnapPoint } from '../viewport/measure';
import {
  dragAboutAxis, dragAlongAxis, gizmoHandles, gizmoOrigin, grabHandle, type GizmoHandle,
} from '../viewport/gizmo';
import { bounds, getTriangle, triCount, type Mesh } from '../kernel/topo/mesh';
import { matMul, xformPoint, type Mat4, type Vec3 } from '../kernel/math/vec';

/**
 * The 3D viewport.
 *
 * Replaces the flat SVG plan view, which could only ever show a profile and a thickness and
 * was the single biggest reason the application did not feel like CAD.
 *
 * The interaction model is the one every mechanical CAD package uses, because a designer
 * arrives already knowing it and anything else costs them time for no benefit: left-drag
 * orbits, middle-drag or shift-drag pans, the wheel zooms toward the cursor, and a double
 * click frames the part.
 */

export interface Viewport3DProps {
  mesh: Mesh;
  edges: Float32Array;
  /**
   * Identifies the part being shown. When it changes, the camera re-frames.
   *
   * Not derived from the mesh: a mesh changes on every parameter edit, and re-framing then
   * would yank the view out from under the user mid-adjustment. The document id changes only
   * when this becomes a different part.
   */
  fitKey?: string;
  /** Face tag → owning feature id. Drives selection, so it must carry ids, not names. */
  faceOwner: Map<number, string>;
  /** Face tag → a human-readable label, shown on hover. Ids are useless to a reader. */
  faceLabel?: Map<number, string>;
  /**
   * A colour per face id, three floats each.
   *
   * Separate from the mesh because it changes for different reasons: recolouring a component
   * or changing its material does not move a vertex, and re-uploading the geometry to do it
   * would be a rebuild the user did not ask for.
   */
  faceColours?: Float32Array | null;
  /** Feature id → inclusive face-tag range, so a whole feature highlights at once. */
  featureFaceRange: Map<string, [number, number]>;
  selectedFeatureId: string | null;
  onSelectFeature: (id: string | null) => void;
  /**
   * Faces the user has picked, to scope an operation to them.
   *
   * Held by the store rather than here, because the feature editor needs to read the same
   * set — a selection the panel cannot see is a selection you cannot act on.
   */
  pickedFaces?: number[];
  /** Called on click with the face under the pointer; `additive` is shift-click. */
  onPickFace?: (faceId: number, additive: boolean) => void;
  /**
   * Called when a face has been dragged along its own normal, with the distance in millimetres.
   *
   * Positive is outwards. Reported once on release rather than continuously: each one becomes a
   * feature and a rebuild, and committing on every pointer move would put a hundred of them in
   * the tree for one drag.
   */
  onPushPull?: (faceId: number, distance: number) => void;
  /** Outward normal of each face, so a drag can be resolved along it. */
  faceNormals?: Map<number, [number, number, number]>;
  /**
   * What the right-click menu offers.
   *
   * Supplied rather than built here, because the useful actions are the ones that know about
   * the document — round these faces, sketch on this one, delete the feature that made it —
   * and a viewport that knew about those would not be a viewport any more.
   */
  menuActions?: (face: number) => { label: string; run: () => void; disabled?: boolean }[];
  /**
   * Moves the selected part by a world-space delta, in millimetres.
   *
   * Given as a delta rather than a position because the viewport does not know where the part
   * currently is — the document does. Dragging accumulates deltas; the panel sets absolutes.
   */
  onMovePart?: (dx: number, dy: number, dz: number) => void;
  /**
   * Turn the selected part about a model axis, in degrees.
   *
   * Separate from moving because a placement stores the two separately, and because a gesture
   * that could do either depending on how it started is a gesture nobody trusts.
   */
  onRotatePart?: (drx: number, dry: number, drz: number) => void;
  /**
   * True while an open feature is collecting faces.
   *
   * Clicks then pick faces and leave the editor alone. Otherwise scoping a fillet would be
   * impossible: the first click lands on a face belonging to the extrude, which switches the
   * panel to the extrude and closes the fillet you were scoping. Every CAD package captures
   * graphics-area clicks the same way while a selection-taking dialog is open; the tree is
   * still there for changing which feature that is.
   */
  faceScopeMode?: boolean;
  /** Shown in the corner: mass, rebuild time and so on. */
  status?: { label: string; value: string }[];
  /**
   * True while geometry is being recomputed in the background.
   *
   * The previous mesh stays on screen throughout, so without an indicator a slow rebuild is
   * indistinguishable from nothing having happened.
   */
  rebuilding?: boolean;
  dark?: boolean;
}

const EMPTY_FACES: number[] = [];

/**
 * The camera's right and up vectors in world space.
 *
 * Derived from the orbit angles rather than read back out of the view matrix, because the
 * matrix is rebuilt every frame and this is wanted mid-drag between frames.
 */
function screenAxes(c: CameraState): [[number, number, number], [number, number, number]] {
  const { azimuth, elevation } = c;

  // Right is horizontal in world terms — it never tilts, however far the camera is pitched,
  // which is what makes a horizontal drag feel horizontal.
  const right: [number, number, number] = [-Math.sin(azimuth), Math.cos(azimuth), 0];

  // Up is the remaining axis of the view plane: the world Z axis tipped back by the elevation.
  const up: [number, number, number] = [
    -Math.cos(azimuth) * Math.sin(elevation),
    -Math.sin(azimuth) * Math.sin(elevation),
    Math.cos(elevation),
  ];

  return [right, up];
}

/**
 * How many millimetres the viewport shows vertically.
 *
 * The projection is orthographic, so this is a property of the camera alone and not of the
 * distance to the part — which is what makes a drag track the pointer exactly rather than
 * approximately.
 */
function viewHeightMm(c: CameraState): number {
  return c.fovMm;
}

const DISPLAY_MODES: { mode: DisplayMode; label: string; title: string }[] = [
  { mode: 'shaded', label: 'SHD', title: 'Shaded (W cycles)' },
  { mode: 'shadedEdges', label: 'S+E', title: 'Shaded with edges (W cycles)' },
  { mode: 'hiddenLine', label: 'HLR', title: 'Hidden line — the drawing, live (W cycles)' },
  { mode: 'wireframe', label: 'WIR', title: 'Wireframe, including edges behind (W cycles)' },
];

const VIEW_BUTTONS: { view: NamedView; label: string; title: string }[] = [
  { view: 'iso', label: 'ISO', title: 'Isometric' },
  { view: 'front', label: 'FR', title: 'Front' },
  { view: 'top', label: 'TP', title: 'Top' },
  { view: 'right', label: 'RT', title: 'Right' },
];


/**
 * Which faces a screen rectangle covers.
 *
 * A triangle counts when its centroid projects inside the band, and a face counts when any of
 * its triangles do. Centroids rather than exact triangle-rectangle overlap because a face is
 * either obviously in the sweep or obviously not, and the exact test costs far more than the
 * disagreement at the boundary is worth.
 *
 * Nothing here is depth-tested, so a sweep takes the faces on the far side of the part as
 * well. That is what a crossing selection does in every package that has one, and it is what
 * makes it useful for picking all six faces of a boss in one gesture.
 */
export function facesInBand(
  mesh: Mesh, view: Mat4, projection: Mat4,
  rect: { x0: number; y0: number; x1: number; y1: number },
  width: number, height: number,
): number[] {
  const left = Math.min(rect.x0, rect.x1);
  const right = Math.max(rect.x0, rect.x1);
  const top = Math.min(rect.y0, rect.y1);
  const bottom = Math.max(rect.y0, rect.y1);

  const clip = matMul(projection, view);
  const found = new Set<number>();
  const tris = triCount(mesh);

  for (let t = 0; t < tris; t++) {
    const face = mesh.faceIds[t];
    if (face === undefined || found.has(face)) continue;

    const [a, b, c] = getTriangle(mesh, t);
    const centre: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const p = xformPoint(clip, centre);

    // Normalised device coordinates to pixels. Y flips: clip space counts up, the screen
    // counts down.
    const sx = ((p[0] + 1) / 2) * width;
    const sy = ((1 - p[1]) / 2) * height;

    if (sx >= left && sx <= right && sy >= top && sy <= bottom) found.add(face);
  }

  return [...found];
}

export function Viewport3D(props: Viewport3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<SolidRenderer | null>(null);

  const [camera, setCamera] = useState<CameraState>(defaultCamera);
  const [size, setSize] = useState<[number, number]>([800, 600]);
  const [hoverFace, setHoverFace] = useState(-1);
  const [showEdges, setShowEdges] = useState(true);

  /**
   * How the solid is drawn, and whether the furniture is shown.
   *
   * `showEdges` stays as the thing the E key toggles, because that is the switch people reach
   * for constantly; the mode below is the fuller choice, and the two are reconciled when the
   * render options are assembled. Wireframe and hidden-line ignore the edge toggle, since
   * edges are all either of them draws.
   */
  const [displayMode, setDisplayMode] = useState<DisplayMode>('shadedEdges');
  const [showGrid, setShowGrid] = useState(true);

  /**
   * The measuring tape.
   *
   * A mode rather than a modifier, because measuring is something you do for a while: you take
   * one dimension, then another, then a third off the same part, and a modifier key held
   * through all that is a worse tool than a button pressed once. Two points make a
   * measurement, and a third starts a new one — so the common case, walking around a part
   * taking dimensions, is one click each after the first.
   */
  const [measuring, setMeasuring] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<SnapPoint[]>([]);

  /**
   * The move-and-turn gizmo on the selected part.
   *
   * On by default, and only ever visible when something is selected — which is the whole of its
   * discoverability problem solved: a user who selects a part sees the handles appear on it and
   * does not have to know a mode exists.
   */
  const [showGizmo, setShowGizmo] = useState(true);

  /**
   * The section plane: which axis it cuts along, and how far through the part.
   *
   * Kept as a fraction rather than a coordinate so the slider means the same thing on a 6 mm
   * washer and on a 37 m airliner — dragging to the middle shows you the middle of whatever is
   * on screen.
   */
  const [section, setSection] = useState<{ axis: 0 | 1 | 2; at: number } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Kept in a ref as well as state: the pointer handlers need the current camera without
  // being torn down and rebuilt on every frame of a drag.
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const dragRef = useRef<
    {
      mode: 'orbit' | 'pan' | 'move' | 'band' | 'push' | 'gizmo';
      x: number; y: number; x0: number; y0: number;
      /** The face being pushed, and how far it has travelled so far. */
      face?: number; distance?: number;
      /** The handle being dragged, when the gizmo has the pointer. */
      handle?: GizmoHandle;
    } | null
  >(null);

  /** How far the face under the pointer has been dragged, while a push is in progress. */
  const [pushing, setPushing] = useState<{ face: number; distance: number } | null>(null);

  /** The rubber band, in client pixels, while one is being dragged. */
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  /** Where the context menu is, in client pixels, and what it was opened on. */
  const [menu, setMenu] = useState<{ x: number; y: number; face: number } | null>(null);
  const [hasFitted, setHasFitted] = useState(false);
  const fittedKeyRef = useRef<string | undefined>(undefined);

  const aspect = size[0] / Math.max(1, size[1]);

  // ── set-up ──

  useEffect(() => {
    if (!canvasRef.current) return;
    if (!webglAvailable()) {
      setFailure(
        'This browser cannot use WebGL 2, so the 3D view is unavailable. ' +
        'Everything else — modelling, drawings and export — still works.',
      );
      return;
    }

    try {
      rendererRef.current = new SolidRenderer(canvasRef.current);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'The 3D view could not start.');
      return;
    }

    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Size from the element, not the window: the viewport is a flex child and its size changes
  // when a panel opens, which no window event reports.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);

      // A zero measurement means the element is not laid out yet, or its panel is hidden.
      // Accepting it would collapse the canvas to one pixel and, worse, make the aspect
      // ratio 1 — so the camera framing computed while hidden is wrong when it reappears.
      // Keeping the previous size is correct in both cases.
      if (w < 2 || h < 2) return;
      setSize([w, h]);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── geometry upload ──

  useEffect(() => {
    const r = rendererRef.current;
    if (!r || triCount(props.mesh) === 0) return;

    r.setMesh(props.mesh);
    r.setEdges(props.edges);
  }, [props.mesh, props.edges]);

  // Colour separately from geometry: a recolour is not a rebuild. The draw below lists
  // `props.faceColours` among its dependencies, so this upload is followed by a redraw.
  useEffect(() => {
    rendererRef.current?.setFaceColours(props.faceColours ?? null);
  }, [props.faceColours]);

  // Frame the part when something first appears, and again whenever this becomes a different
  // part — an import, an opened file, a new build.
  //
  // Re-fitting on every mesh change would fight the user's own navigation: nudge a dimension
  // and the camera would jump. But only fitting on empty→non-empty was worse. Importing a
  // drawing while a model was already open never passed through empty, so the camera stayed
  // framed on the *old* part and the newly imported one sat outside the view — correctly
  // built, listed in the tree, weighed on the status line, and completely invisible. Every
  // report of "the import does nothing" was this.
  const fitKey = props.fitKey;
  useEffect(() => {
    if (triCount(props.mesh) === 0) { setHasFitted(false); return; }
    if (hasFitted && fitKey === fittedKeyRef.current) return;

    setCamera((c) => fit(c, bounds(props.mesh), aspect));
    setHasFitted(true);
    fittedKeyRef.current = fitKey;
  }, [props.mesh, aspect, hasFitted, fitKey]);

  // ── drawing ──

  // The fraction resolved against the part's own bounding box, recomputed when either changes.
  const sectionPlane = useMemo(() => {
    if (!section || triCount(props.mesh) === 0) return null;

    const bb = bounds(props.mesh);
    const lo = bb.min[section.axis]!;
    const hi = bb.max[section.axis]!;

    const normal: [number, number, number] = [0, 0, 0];
    normal[section.axis] = 1;

    return { normal, offset: lo + (hi - lo) * section.at };
  }, [section, props.mesh]);

  /*
   * The ground grid, rebuilt whenever the camera moves.
   *
   * Flattened here rather than in the renderer because this is where the camera lives, and
   * because `gridFor` is pure and tested: everything that decides what the grid *is* stays
   * testable, and the renderer only draws the lines it is handed.
   */
  const grid = useMemo(() => {
    if (!showGrid) return null;
    const g = gridFor(camera, size[1]);

    const flatten = (lines: [Vec3, Vec3][]): Float32Array => {
      const out = new Float32Array(lines.length * 6);
      lines.forEach(([a, b], i) => out.set([...a, ...b], i * 6));
      return out;
    };

    return { spec: g, minor: flatten(g.minor), major: flatten(g.major), axes: flatten(g.axes) };
  }, [camera, size, showGrid]);

  const measurement = useMemo(
    () => (measurePoints.length === 2
      ? measureBetween(measurePoints[0]!, measurePoints[1]!)
      : null),
    [measurePoints],
  );

  /** The measurement's ends and midpoint, as fractions of the viewport, for the overlay. */
  const measureOnScreen = useMemo(() => {
    const at = (p: Vec3) => projectPoint(camera, p, aspect);
    const ends = measurePoints.map((m) => at(m.point));
    return {
      ends,
      label: measurement ? at(measurement.midpoint) : null,
    };
  }, [measurePoints, measurement, camera, aspect]);

  /**
   * Where the gizmo sits: the centre of the selected feature's own geometry.
   *
   * Its own, not the part's. A gizmo parked at the whole model's centre while dragging one
   * component of an assembly is a control that visibly does not belong to what it moves, and
   * with several components stacked it is ambiguous which one is about to move.
   */
  const selectedRange = useMemo((): [number, number] => {
    if (!props.selectedFeatureId) return [-1, -1];
    return props.featureFaceRange.get(props.selectedFeatureId) ?? [-1, -1];
  }, [props.selectedFeatureId, props.featureFaceRange]);

  const gizmoAt = useMemo((): Vec3 | null => {
    const [lo, hi] = selectedRange;
    if (lo < 0 || !props.onMovePart) return null;

    let min: Vec3 = [Infinity, Infinity, Infinity];
    let max: Vec3 = [-Infinity, -Infinity, -Infinity];
    let found = false;

    for (let t = 0; t < triCount(props.mesh); t++) {
      const face = props.mesh.faceIds[t]!;
      if (face < lo || face > hi) continue;

      for (const v of getTriangle(props.mesh, t)) {
        for (let i = 0; i < 3; i++) {
          if (v[i]! < min[i]!) min[i] = v[i]!;
          if (v[i]! > max[i]!) max[i] = v[i]!;
        }
      }
      found = true;
    }

    return found ? gizmoOrigin(min, max) : null;
  }, [selectedRange, props.mesh, props.onMovePart]);

  const handles = useMemo(
    () => (showGizmo && gizmoAt && !measuring ? gizmoHandles(camera, gizmoAt, aspect) : []),
    [showGizmo, gizmoAt, measuring, camera, aspect],
  );

  const scaleBar = useMemo(() => scaleBarFor(camera, size[1]), [camera, size]);
  const triad = useMemo(() => triadFor(camera), [camera]);
  const cubeFaces = useMemo(() => viewCubeFaces(camera), [camera]);

  const view = useMemo(() => viewMatrix(camera), [camera]);
  const projection = useMemo(() => projectionMatrix(camera, aspect), [camera, aspect]);


  useEffect(() => {
    const r = rendererRef.current;
    const canvas = canvasRef.current;
    if (!r || !canvas) return;

    canvas.width = size[0];
    canvas.height = size[1];

    r.render(size[0], size[1], {
      view,
      projection,
      pickedFaces: props.pickedFaces ?? EMPTY_FACES,
      hoverFace,
      selectedFeatureRange: selectedRange,
      showEdges,
      // Shaded with the edge toggle off is plain shaded; the toggle cannot turn edges off in
      // the two modes that are nothing but edges.
      displayMode: displayMode === 'shadedEdges' && !showEdges ? 'shaded' : displayMode,
      grid,
      dark: props.dark !== false,
      section: sectionPlane,
    });
  }, [view, projection, size, props.pickedFaces, hoverFace, selectedRange, showEdges, displayMode, grid, props.dark, props.mesh, props.faceColours, sectionPlane]);

  // ── interaction ──

  const pickAt = useCallback((clientX: number, clientY: number): number => {
    const r = rendererRef.current;
    const canvas = canvasRef.current;
    if (!r || !canvas) return -1;

    const rect = canvas.getBoundingClientRect();
    const dpr = size[0] / Math.max(1, rect.width);
    const x = Math.round((clientX - rect.left) * dpr);
    const y = Math.round((clientY - rect.top) * dpr);
    if (x < 0 || y < 0 || x >= size[0] || y >= size[1]) return -1;

    return r.pick(x, y, size[0], size[1], viewMatrix(cameraRef.current), projectionMatrix(cameraRef.current, aspect));
  }, [size, aspect]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    /*
     * Capture the pointer, and do not let failing to capture it cost the click.
     *
     * `setPointerCapture` throws `NotFoundError` when the pointer id is no longer active — a
     * race that happens for real when a pointer is released between the event being queued and
     * the handler running, and every time under a synthetic event. Uncaught, the throw takes
     * the rest of this handler with it: the click does nothing at all, silently, and the
     * viewport looks dead rather than broken. Capture is an optimisation for dragging outside
     * the canvas; the click is the thing that matters.
     */
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // Nothing to do: the drag simply ends if the pointer leaves the canvas.
    }

    // Middle button or shift pans, matching the convention in every CAD package. The right
    // button moves the selected part — the camera has two ways to be driven already, and the
    // model had none.
    setMenu(null);

    // Ctrl-drag sweeps a rubber band over faces. Ctrl rather than a bare drag because a bare
    // drag has to stay orbit — a viewport where dragging sometimes turns the model and
    // sometimes selects is one you cannot use without looking at the modifier key first.
    /*
     * Grabbing a face that is already selected pushes or pulls it; anything else orbits.
     *
     * Click once to select, then drag — which is the gesture people arrive with, and it does
     * not cost the plain drag its meaning. Requiring the face to be selected first is what
     * keeps orbit predictable: a drag that started anywhere else on the model still turns it.
     */
    /*
     * Measuring takes the click before anything else can.
     *
     * A ray through the pointer, snapped to the nearest thing worth measuring to. The snap
     * tolerance is ten pixels converted to millimetres at the current zoom, so it grabs the
     * same distance on screen whether the part is a watch pinion or a chassis rail.
     */
    if (measuring && e.button === 0) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const c = cameraRef.current;
        const { origin, direction } = pickRay(
          c, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height, aspect,
        );
        const hit = snap(props.mesh, origin, direction, mmPerPixel(c, rect.height) * 10);

        // A click on empty space clears rather than measuring to nothing.
        if (!hit) setMeasurePoints([]);
        else setMeasurePoints((pts) => (pts.length >= 2 ? [hit] : [...pts, hit]));
      }
      e.preventDefault();
      return;
    }

    /*
     * A gizmo handle takes the drag ahead of the camera.
     *
     * Before the pick, because the handles are drawn over the part and a drag that started on
     * an arrow has to move the part rather than orbit the view — even where the arrow happens
     * to lie over the model it belongs to, which is most of the time.
     */
    if (handles.length > 0 && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const rect = canvasRef.current?.getBoundingClientRect();
      const grabbed = rect
        ? grabHandle(
            handles,
            (e.clientX - rect.left) / rect.width,
            (e.clientY - rect.top) / rect.height,
            aspect,
          )
        : null;

      if (grabbed) {
        dragRef.current = {
          mode: 'gizmo', handle: grabbed,
          x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY,
        };
        return;
      }
    }

    const under = e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey
      ? pickAt(e.clientX, e.clientY)
      : -1;
    const grabbing = under >= 0 && (props.pickedFaces ?? []).includes(under) && !!props.onPushPull;

    const mode = e.ctrlKey || e.metaKey ? 'band'
      : grabbing ? 'push'
      : e.button === 2 && props.selectedFeatureId && props.onMovePart ? 'move'
      : e.button === 1 || e.shiftKey ? 'pan'
      : 'orbit';

    dragRef.current = {
      mode, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY,
      ...(mode === 'push' ? { face: under, distance: 0 } : {}),
    };
    if (mode === 'push') setPushing({ face: under, distance: 0 });
    if (mode === 'band') setBand({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
  }, [props.selectedFeatureId, props.onMovePart, props.onPushPull, props.pickedFaces, pickAt,
      measuring, props.mesh, aspect, handles]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;

    if (!drag) {
      const face = pickAt(e.clientX, e.clientY);
      setHoverFace(face);
      return;
    }

    if (drag.mode === 'band') {
      setBand({ x0: drag.x0, y0: drag.y0, x1: e.clientX, y1: e.clientY });
      return;
    }

    if (drag.mode === 'push') {
      const rect = canvasRef.current?.getBoundingClientRect();
      const normal = props.faceNormals?.get(drag.face ?? -1);
      if (!rect || !normal) return;

      /*
       * The pointer's travel, projected onto the face normal as it appears on screen.
       *
       * Projected rather than taken as raw vertical motion, so dragging *along* the face slides
       * nothing and dragging *away* from it moves the full amount — which is what makes the
       * gesture feel like pushing the face rather than like moving a slider that happens to be
       * attached to it.
       */
      const c = cameraRef.current;
      const [right, up] = screenAxes(c);
      const screenX = normal[0] * right[0] + normal[1] * right[1] + normal[2] * right[2];
      const screenY = normal[0] * up[0] + normal[1] * up[1] + normal[2] * up[2];

      const length = Math.hypot(screenX, screenY);
      if (length < 1e-6) return;   // the face is edge-on: there is no direction to drag along

      // Pixels to millimetres through the view height, so the face keeps pace with the
      // pointer at any zoom.
      const perPixel = viewHeightMm(c) / Math.max(1, rect.height);
      const dx = e.clientX - drag.x0;
      const dy = -(e.clientY - drag.y0);

      const distance = ((dx * screenX + dy * screenY) / length) * perPixel;

      drag.distance = distance;
      setPushing({ face: drag.face!, distance });
      return;
    }

    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;

    /*
     * Where the pointer was, kept before the anchor is advanced.
     *
     * A rotation is measured as the angle swept *between two positions*, not from a delta, so
     * it needs the previous point rather than the distance travelled. Reading `drag.x` after
     * the anchor had already been moved to the current position meant the two points were the
     * same one: every frame swept exactly zero degrees, the gizmo grabbed, dragged, released
     * and turned the part by nothing at all, with no error anywhere to show for it.
     */
    const wasAt = { x: drag.x, y: drag.y };

    drag.x = e.clientX;
    drag.y = e.clientY;

    const rect = canvasRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 1, h = rect?.height ?? 1;

    if (drag.mode === 'gizmo' && drag.handle) {
      const c = cameraRef.current;
      const { axis, mode } = drag.handle;

      if (mode === 'move') {
        // Along one axis only. `dragAlongAxis` returns zero for an axis too edge-on to mean
        // anything, so a handle that cannot be dragged simply does not move the part.
        const mm = dragAlongAxis(c, axis, dx, dy, h);
        props.onMovePart?.(
          axis === 'x' ? mm : 0,
          axis === 'y' ? mm : 0,
          axis === 'z' ? mm : 0,
        );
      } else if (gizmoAt && rect) {
        const point = (cx: number, cy: number) => ({
          x: (cx - rect.left) / rect.width,
          y: (cy - rect.top) / rect.height,
        });
        const deg = dragAboutAxis(
          c, axis, gizmoAt, aspect, point(wasAt.x, wasAt.y), point(e.clientX, e.clientY),
        );
        props.onRotatePart?.(
          axis === 'x' ? deg : 0,
          axis === 'y' ? deg : 0,
          axis === 'z' ? deg : 0,
        );
      }
      return;
    }

    if (drag.mode === 'move') {
      // Dragged in the plane facing the viewer, which is the only motion a single pointer can
      // specify unambiguously. The camera's right and up vectors give that plane, so the part
      // follows the cursor whichever way the model has been turned — dragging right moves it
      // right on screen, not along some fixed world axis the user cannot see.
      const c = cameraRef.current;
      const [right, up] = screenAxes(c);

      // Pixels to millimetres through the orthographic height, so a part keeps pace with the
      // pointer at any zoom.
      const perPixel = viewHeightMm(c) / Math.max(1, h);
      const sx = dx * perPixel;
      const sy = -dy * perPixel;

      props.onMovePart?.(
        right[0] * sx + up[0] * sy,
        right[1] * sx + up[1] * sy,
        right[2] * sx + up[2] * sy,
      );
      return;
    }

    setCamera((c) => drag.mode === 'orbit'
      ? orbit(c, -dx * 0.0075, dy * 0.0075)
      : pan(c, dx / w, dy / h, aspect));
  }, [aspect, pickAt, props]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;

    if (drag?.mode === 'push') {
      setPushing(null);
      const distance = drag.distance ?? 0;
      if (Math.abs(distance) > 0.05) props.onPushPull?.(drag.face!, distance);
      return;
    }

    if (drag?.mode === 'band') {
      setBand(null);
      const rect = canvasRef.current?.getBoundingClientRect();
      const moved = Math.abs(e.clientX - drag.x0) > 3 || Math.abs(e.clientY - drag.y0) > 3;

      if (rect && moved) {
        // The band is in client pixels and the projection works in canvas pixels, so both
        // ends are converted through the same rect rather than through the device ratio,
        // which is not the same number when the canvas is scaled by CSS.
        const toCanvas = (cx: number, cy: number) => [
          ((cx - rect.left) / rect.width) * size[0],
          ((cy - rect.top) / rect.height) * size[1],
        ] as const;
        const [ax, ay] = toCanvas(drag.x0, drag.y0);
        const [bx, by] = toCanvas(e.clientX, e.clientY);

        const swept = facesInBand(
          props.mesh,
          viewMatrix(cameraRef.current),
          projectionMatrix(cameraRef.current, aspect),
          { x0: ax, y0: ay, x1: bx, y1: by },
          size[0], size[1],
        );

        // Cleared first unless extending, so a fresh sweep replaces the previous one rather
        // than adding to it — which is what every package does and what makes a mis-sweep
        // recoverable by sweeping again.
        if (!e.shiftKey) props.onPickFace?.(-1, false);
        for (const face of swept) props.onPickFace?.(face, true);
      }
      return;
    }

    // A right click that did not drag opens the menu rather than doing nothing. Right-drag
    // still moves the selected part; the two do not collide because one moved and one did not.
    if (drag && e.button === 2
      && Math.abs(e.clientX - drag.x0) < 3 && Math.abs(e.clientY - drag.y0) < 3) {
      const face = pickAt(e.clientX, e.clientY);
      setMenu({ x: e.clientX, y: e.clientY, face });
      if (face >= 0) props.onSelectFeature(props.faceOwner.get(face) ?? null);
      return;
    }

    // A click that did not move is a selection, not the end of an orbit. A move drag is never
    // a selection, however short — releasing after nudging a part must not reselect whatever
    // happens to be under the cursor.
    if (drag && drag.mode !== 'move'
      && Math.abs(e.clientX - drag.x) < 3 && Math.abs(e.clientY - drag.y) < 3) {
      const face = pickAt(e.clientX, e.clientY);

      // Shift extends the face selection without disturbing which feature is open in the
      // editor — otherwise picking a second face for a fillet would switch the panel away
      // from the fillet you are trying to scope.
      // Shift always extends the pick rather than changing the selected feature.
      const picking = props.faceScopeMode || e.shiftKey;

      // While a feature is collecting faces every click accumulates, and clicking a face
      // already in the set removes it. Requiring shift there would mean the plain click —
      // the one people actually make — silently discards the four faces already picked.
      if (face >= 0) props.onPickFace?.(face, picking);
      else if (!e.shiftKey) props.onPickFace?.(-1, false);

      if (!picking) {
        props.onSelectFeature(face >= 0 ? props.faceOwner.get(face) ?? null : null);
      }
    }
  }, [pickAt, props]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const cx = (e.clientX - rect.left) / rect.width;
    const cy = (e.clientY - rect.top) / rect.height;
    // Exponential in the wheel delta so a trackpad's small increments and a mouse's large
    // notches both feel proportional.
    const factor = Math.exp(e.deltaY * 0.0015);
    setCamera((c) => zoomAt(c, factor, cx, cy, aspect));
  }, [aspect]);

  const doFit = useCallback(() => {
    if (triCount(props.mesh) === 0) return;
    setCamera((c) => fit(c, bounds(props.mesh), aspect));
  }, [props.mesh, aspect]);

  // Keyboard: the shortcuts a CAD user already has in their fingers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const views: Record<string, NamedView> = {
        '1': 'front', '2': 'back', '3': 'left', '4': 'right', '5': 'top', '6': 'bottom', '7': 'iso',
      };
      if (views[e.key]) {
        setCamera((c) => namedView(c, views[e.key]));
        e.preventDefault();
        return;
      }
      if (e.key === 'f' || e.key === 'F') { doFit(); e.preventDefault(); }
      if (e.key === 's' || e.key === 'S') {
        setSection((v) => (v ? null : { axis: 0, at: 0.5 }));
        e.preventDefault();
      }
      if (e.key === 'e' || e.key === 'E') { setShowEdges((v) => !v); e.preventDefault(); }
      if (e.key === 'g' || e.key === 'G') { setShowGrid((v) => !v); e.preventDefault(); }
      if (e.key === 't' || e.key === 'T') { setShowGizmo((v) => !v); e.preventDefault(); }
      if (e.key === 'm' || e.key === 'M') {
        setMeasuring((v) => !v);
        setMeasurePoints([]);
        e.preventDefault();
      }
      if (e.key === 'Escape' && measuring) {
        setMeasuring(false);
        setMeasurePoints([]);
        e.preventDefault();
      }
      if (e.key === 'p' || e.key === 'P') {
        setCamera((c) => ({ ...c, orthographic: !c.orthographic }));
        e.preventDefault();
      }
      if (e.key === 'w' || e.key === 'W') {
        // Round the display modes, which is how every package with more than two does it.
        setDisplayMode((m) => {
          const order = DISPLAY_MODES.map((d) => d.mode);
          return order[(order.indexOf(m) + 1) % order.length]!;
        });
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doFit, measuring]);

  const active = closestNamedView(camera);
  const empty = triCount(props.mesh) === 0;

  if (failure) {
    return (
      <div className="vp3d-fallback" ref={wrapRef}>
        <strong>3D view unavailable</strong>
        <p>{failure}</p>
      </div>
    );
  }

  return (
    <div className="vp3d" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="vp3d-canvas"
        style={{ cursor: dragRef.current ? 'grabbing' : hoverFace >= 0 ? 'pointer' : 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverFace(-1)}
        onWheel={onWheel}
        onDoubleClick={doFit}
        onContextMenu={(e) => e.preventDefault()}
      />

      {props.rebuilding && (
        <div className="vp3d-rebuilding" role="status">
          <span className="vp3d-spinner" aria-hidden="true" />
          Rebuilding
        </div>
      )}

      {empty && !props.rebuilding && (
        <div className="vp3d-empty">
          <strong>Nothing modelled yet</strong>
          <span>Describe a part in the chat, or add a feature from the toolbar.</span>
        </div>
      )}

      <div className="vp3d-views" role="group" aria-label="Standard views">
        {VIEW_BUTTONS.map((b) => (
          <button
            key={b.view}
            title={`${b.title} view`}
            aria-pressed={active === b.view}
            onClick={() => setCamera((c) => namedView(c, b.view))}
          >
            {b.label}
          </button>
        ))}
        <button title="Fit to window (F)" onClick={doFit}>FIT</button>
        <button
          title="Show edges (E)"
          aria-pressed={showEdges}
          onClick={() => setShowEdges((v) => !v)}
        >
          EDG
        </button>
        <button
          title="Section view — cut the part open to see inside it (S)"
          aria-pressed={section !== null}
          onClick={() => setSection((v) => (v ? null : { axis: 0, at: 0.5 }))}
        >
          SEC
        </button>
        <button
          title="Move and turn handles on the selected part (T)"
          aria-pressed={showGizmo}
          onClick={() => setShowGizmo((v) => !v)}
        >
          MOV
        </button>
        <button
          title="Measure — click two points; corners, edges and bore centres snap (M)"
          aria-pressed={measuring}
          onClick={() => { setMeasuring((v) => !v); setMeasurePoints([]); }}
        >
          MEA
        </button>
        <button
          title="Ground grid (G)"
          aria-pressed={showGrid}
          onClick={() => setShowGrid((v) => !v)}
        >
          GRD
        </button>
        <button
          title={camera.orthographic
            ? 'Orthographic — equal features measure equally wherever they are (P)'
            : 'Perspective — nearer is bigger, which is for looking rather than measuring (P)'}
          aria-pressed={!camera.orthographic}
          onClick={() => setCamera((c) => ({ ...c, orthographic: !c.orthographic }))}
        >
          {camera.orthographic ? 'ORT' : 'PSP'}
        </button>
      </div>

      <div className="vp3d-modes" role="group" aria-label="Display mode">
        {DISPLAY_MODES.map((m) => (
          <button
            key={m.mode}
            title={m.title}
            aria-pressed={displayMode === m.mode}
            onClick={() => setDisplayMode(m.mode)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/*
        * The view cube.
        *
        * Drawn as SVG over the canvas rather than as geometry inside it, because it is not part
        * of the scene: it must never be picked, sectioned, fitted to, or lit, and keeping it out
        * of the WebGL context is the simplest way to guarantee all four. The faces come back
        * sorted back to front, so drawing them in order gives a solid cube.
        */}
      <svg
        className="vp3d-cube"
        viewBox="0 0 100 100"
        role="group"
        aria-label="View cube"
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const hit = viewCubeHit(camera,
            (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
          if (hit) setCamera((c) => namedView(c, hit));
        }}
      >
        {cubeFaces.map((f) => (
          <polygon
            key={f.view}
            className={`vp3d-cube-face${f.facing > 1e-3 ? ' is-front' : ''}`}
            points={f.corners.map((c) => `${c[0] * 100},${c[1] * 100}`).join(' ')}
            style={{ opacity: f.facing > 1e-3 ? 0.35 + f.facing * 0.5 : 0.12 }}
          />
        ))}
        {cubeFaces.filter((f) => f.facing > 0.35).map((f) => (
          <text
            key={`t-${f.view}`}
            className="vp3d-cube-label"
            x={f.centre[0] * 100}
            y={f.centre[1] * 100}
          >
            {f.label}
          </text>
        ))}
      </svg>

      {/*
        * The origin triad, which is the answer to "which way is up in this view".
        *
        * An axis pointing away from the viewer is drawn faint. Without that cue a top view and
        * a bottom view are the same picture, and a part can be modelled upside down.
        */}
      <svg className="vp3d-triad" viewBox="-50 -50 100 100" aria-hidden="true">
        {triad.map((a) => (
          <g key={a.axis} style={{ opacity: a.towards < -0.2 ? 0.3 : 1 }}>
            <line
              className={`vp3d-axis vp3d-axis-${a.axis.toLowerCase()}`}
              x1={0} y1={0} x2={a.screen[0] * 34} y2={a.screen[1] * 34}
            />
            <text
              className="vp3d-axis-label"
              x={a.screen[0] * 44} y={a.screen[1] * 44}
            >
              {a.axis}
            </text>
          </g>
        ))}
      </svg>

      {/*
        * The move-and-turn gizmo.
        *
        * SVG over the canvas, like the view cube and for the same reason: it is a control, not
        * geometry, and it must never be picked, sectioned, lit or fitted to. Handles that are
        * no use from this angle are drawn faded rather than hidden — a gizmo whose arrows come
        * and go as you orbit reads as broken, and the faded arrow tells you what to do about
        * it, which is turn the model.
        */}
      {handles.length > 0 && (
        <svg className="vp3d-gizmo" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
          {handles.filter((h) => h.mode === 'move').map((h) => (
            <g key={`m-${h.axis}`} className={`vp3d-giz vp3d-giz-${h.axis}`} opacity={h.usable ? 1 : 0.25}>
              <line x1={h.from.x * 1000} y1={h.from.y * 1000} x2={h.at.x * 1000} y2={h.at.y * 1000} />
              <circle cx={h.at.x * 1000} cy={h.at.y * 1000} r={9} />
            </g>
          ))}
          {handles.filter((h) => h.mode === 'turn').map((h) => (
            <g key={`t-${h.axis}`} className={`vp3d-giz vp3d-giz-${h.axis}`} opacity={h.usable ? 0.9 : 0.2}>
              <circle
                className="vp3d-giz-turn"
                cx={h.at.x * 1000} cy={h.at.y * 1000} r={7}
              />
            </g>
          ))}
        </svg>
      )}

      {/*
        * The measurement, drawn over the canvas.
        *
        * In SVG rather than as geometry, for the same reason as the view cube: it is an
        * annotation, not part of the model, and it must never be picked, sectioned or fitted
        * to. Ends are marked and the span between them is drawn dashed, which is how a
        * dimension reads on a drawing.
        */}
      {measurePoints.length > 0 && (
        <svg className="vp3d-measure" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
          {measureOnScreen.ends.length === 2
            && measureOnScreen.ends[0] && measureOnScreen.ends[1] && (
            <line
              className="vp3d-measure-line"
              x1={measureOnScreen.ends[0].x * 1000} y1={measureOnScreen.ends[0].y * 1000}
              x2={measureOnScreen.ends[1].x * 1000} y2={measureOnScreen.ends[1].y * 1000}
            />
          )}
          {measureOnScreen.ends.map((p, i) => p && (
            <circle
              key={i}
              className="vp3d-measure-end"
              cx={p.x * 1000} cy={p.y * 1000} r={5}
            />
          ))}
        </svg>
      )}

      {measuring && (
        <div className="vp3d-measure-readout" role="status">
          {measurement ? (
            <>
              <strong>{measurement.distanceMm.toFixed(3)} mm</strong>
              <span>
                ΔX {measurement.deltaMm[0].toFixed(2)} · ΔY {measurement.deltaMm[1].toFixed(2)}
                {' '}· ΔZ {measurement.deltaMm[2].toFixed(2)}
              </span>
              <span className="vp3d-measure-what">{measurement.description}</span>
            </>
          ) : (
            <span>
              {measurePoints.length === 0
                ? 'Click a point on the part.'
                : `From a ${measurePoints[0]!.kind === 'centre' ? 'bore axis' : measurePoints[0]!.kind}. Click the second point.`}
            </span>
          )}
        </div>
      )}

      {scaleBar && (
        <div className="vp3d-scale" aria-label={`Scale: ${scaleBar.label}`}>
          <span className="vp3d-scale-bar" style={{ width: `${scaleBar.widthPx}px` }} />
          <span className="vp3d-scale-label">{scaleBar.label}</span>
        </div>
      )}

      {section && (
        <div className="vp3d-section" role="group" aria-label="Section plane">
          {(['X', 'Y', 'Z'] as const).map((axis, i) => (
            <button
              key={axis}
              title={`Cut along ${axis}`}
              aria-pressed={section.axis === i}
              onClick={() => setSection({ axis: i as 0 | 1 | 2, at: section.at })}
            >
              {axis}
            </button>
          ))}
          <input
            type="range"
            min={0}
            max={1}
            step={0.005}
            value={section.at}
            aria-label="How far through the part to cut"
            onChange={(e) => setSection({ axis: section.axis, at: Number(e.target.value) })}
          />
        </div>
      )}

      {props.status && props.status.length > 0 && (
        <div className="vp3d-status">
          {props.status.map((s) => (
            <span key={s.label}>
              <em>{s.label}</em>
              {s.value}
            </span>
          ))}
        </div>
      )}

      {hoverFace >= 0 && (props.faceLabel?.get(hoverFace) ?? props.faceOwner.get(hoverFace)) && (
        <div className="vp3d-hover">
          {props.faceLabel?.get(hoverFace) ?? props.faceOwner.get(hoverFace)}
        </div>
      )}

      {pushing && (
        <div className="vp3d-push" role="status">
          {pushing.distance >= 0 ? 'Pull' : 'Push'} {Math.abs(pushing.distance).toFixed(1)} mm
        </div>
      )}

      {band && (() => {
        const rect = wrapRef.current?.getBoundingClientRect();
        if (!rect) return null;
        return (
          <div
            className="vp3d-band"
            style={{
              left: Math.min(band.x0, band.x1) - rect.left,
              top: Math.min(band.y0, band.y1) - rect.top,
              width: Math.abs(band.x1 - band.x0),
              height: Math.abs(band.y1 - band.y0),
            }}
          />
        );
      })()}

      {menu && (() => {
        const rect = wrapRef.current?.getBoundingClientRect();
        const actions = props.menuActions?.(menu.face) ?? [];
        if (!rect || actions.length === 0) return null;
        return (
          <div
            className="vp3d-menu"
            style={{ left: menu.x - rect.left, top: menu.y - rect.top }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                disabled={a.disabled}
                onClick={() => { a.run(); setMenu(null); }}
              >
                {a.label}
              </button>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

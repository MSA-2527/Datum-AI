import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  closestNamedView, defaultCamera, fit, namedView, orbit, pan, projectionMatrix,
  viewMatrix, zoomAt, type CameraState, type NamedView,
} from '../viewport/camera';
import { SolidRenderer, webglAvailable } from '../viewport/renderer';
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
      mode: 'orbit' | 'pan' | 'move' | 'band' | 'push';
      x: number; y: number; x0: number; y0: number;
      /** The face being pushed, and how far it has travelled so far. */
      face?: number; distance?: number;
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

  const view = useMemo(() => viewMatrix(camera), [camera]);
  const projection = useMemo(() => projectionMatrix(camera, aspect), [camera, aspect]);

  const selectedRange = useMemo((): [number, number] => {
    if (!props.selectedFeatureId) return [-1, -1];
    return props.featureFaceRange.get(props.selectedFeatureId) ?? [-1, -1];
  }, [props.selectedFeatureId, props.featureFaceRange]);

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
      dark: props.dark !== false,
      section: sectionPlane,
    });
  }, [view, projection, size, props.pickedFaces, hoverFace, selectedRange, showEdges, props.dark, props.mesh, props.faceColours, sectionPlane]);

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
    (e.target as Element).setPointerCapture?.(e.pointerId);

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
  }, [props.selectedFeatureId, props.onMovePart, props.onPushPull, props.pickedFaces, pickAt]);

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
    drag.x = e.clientX;
    drag.y = e.clientY;

    const rect = canvasRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 1, h = rect?.height ?? 1;

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
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doFit]);

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
      </div>

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

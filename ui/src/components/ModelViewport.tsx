import { useCallback, useMemo } from 'react';
import { useModel } from '../modelStore';
import { appearanceFor, fallbackColour, parseHex } from '../lib/appearance';
import { measureFaces } from '../lib/measure';
import { buildFaceGraph } from '../kernel/topo/facegraph';
import { SketchEditor } from './SketchEditor';
import { Viewport3D } from './Viewport3D';
import { triCount } from '../kernel/topo/mesh';
import type { Document } from '../model/document';

/**
 * The 3D view, wired to the document.
 *
 * Pulled out of the modeller so Studio can show the same thing. Studio had its own viewport —
 * a flat SVG plan view over a separate 2.5D document model that predates the kernel — which is
 * why it looked two-dimensional and why typing into it appeared to do nothing: it was a
 * parallel pipeline reading a different document.
 *
 * One component rather than two call sites with the same props, because the props are where
 * the two surfaces would drift apart. Face picking, part dragging and the status line are all
 * wired here once.
 */

/** Face tag → the name of the feature that made it, for the hover label. */
export function featureNames(faceOwner: Map<number, string>, doc: Document): Map<number, string> {
  const byId = new Map(doc.features.map((f) => [f.id, f.name] as const));
  const out = new Map<number, string>();
  for (const [face, owner] of faceOwner) out.set(face, byId.get(owner) ?? owner);
  return out;
}

/**
 * Which body each feature belongs to.
 *
 * Colour belongs to a body, not to a feature. A box with a fillet and four holes is one part
 * and has one colour; colouring each feature separately would paint the fillet a different
 * shade from the face it blends, which is not information, it is noise. A feature placed
 * rather than combined (`operation: 'place'`) is a separate body — that is how a multi-body
 * import and an assembly both arrive.
 */
export function bodyIndex(doc: Document): Map<string, number> {
  const out = new Map<string, number>();
  let body = 0;
  for (const f of doc.features) {
    if (f.params.operation === 'place' && out.size > 0) body += 1;
    out.set(f.id, body);
  }
  return out;
}

/**
 * A colour for every face, from the body that made it.
 *
 * Material first, because that is the colour that carries information — a brass bush looks
 * like brass, and a part that looks wrong is wrong. Where the bodies of one document share a
 * material, or have none worth naming, their position in the tree distinguishes them instead,
 * so an assembly is readable rather than one grey mass.
 *
 * An explicit `colour` on a feature wins over both: two steel brackets sometimes need telling
 * apart, and no material distinction exists to do it.
 */
export function faceColours(
  faceOwner: Map<number, string>, doc: Document,
): Float32Array | null {
  if (faceOwner.size === 0) return null;

  const bodies = bodyIndex(doc);
  const byId = new Map(doc.features.map((f) => [f.id, f] as const));

  // Body-level material and override: taken from whichever feature in the body names one, so
  // it can be set on the placed root or on any feature that builds it.
  const material = new Map<number, string>();
  const override = new Map<number, [number, number, number]>();
  for (const f of doc.features) {
    const b = bodies.get(f.id) ?? 0;
    const m = f.params.material;
    if (typeof m === 'string' && m.trim() && !material.has(b)) material.set(b, m);
    const c = f.params.colour;
    if (typeof c === 'string' && !override.has(b)) {
      const rgb = parseHex(c);
      if (rgb) override.set(b, rgb);
    }
  }

  const named = new Set([...material.values()].map((m) => appearanceFor(m).label));
  const bodyCount = new Set(bodies.values()).size;

  let highest = 0;
  for (const face of faceOwner.keys()) if (face > highest) highest = face;
  // Pre-filled with the document's own colour rather than left at zero: face ids are not
  // guaranteed to start at zero or run without gaps, and an unwritten entry is black — which
  // reads as a deliberate choice rather than as a missing one.
  const out = new Float32Array((highest + 1) * 3);
  const ground = appearanceFor(doc.material).rgb;
  for (let i = 0; i <= highest; i++) {
    out[i * 3] = ground[0];
    out[i * 3 + 1] = ground[1];
    out[i * 3 + 2] = ground[2];
  }

  for (const [face, owner] of faceOwner) {
    const b = bodies.get(owner) ?? 0;
    const look = appearanceFor(material.get(b) ?? (byId.has(owner) ? doc.material : ''));

    // One body: its material is the whole story. Several: only use material where it actually
    // tells them apart, or they all come out the same shade and nothing is gained.
    const useMaterial = bodyCount === 1 || (named.size > 1 && look.label !== 'Unspecified');
    const rgb = override.get(b) ?? (useMaterial ? look.rgb : fallbackColour(b));

    out[face * 3] = rgb[0];
    out[face * 3 + 1] = rgb[1];
    out[face * 3 + 2] = rgb[2];
  }

  return out;
}

export function ModelViewport() {
  const doc = useModel((s) => s.doc);
  const evaluated = useModel((s) => s.evaluated);
  const selectedFeatureId = useModel((s) => s.selectedFeatureId);
  const select = useModel((s) => s.select);
  const selectedFaces = useModel((s) => s.selectedFaces);
  const toggleFace = useModel((s) => s.toggleFace);
  const nudge = useModel((s) => s.nudge);
  const rebuilding = useModel((s) => s.building);
  const addScoped = useModel((s) => s.addScoped);
  const sketchOnFace = useModel((s) => s.sketchOnFace);
  const drillOnFace = useModel((s) => s.drillOnFace);
  const ribOnFace = useModel((s) => s.ribOnFace);
  const remove = useModel((s) => s.remove);
  const pushPull = useModel((s) => s.pushPull);
  const addFeature = useModel((s) => s.addFeature);
  const edit = useModel((s) => s.edit);
  const setParams = useModel((s) => s.setParams);
  const editing = useModel((s) => s.doc.features.find((f) => f.id === s.editingFeatureId));

  const faceScopeMode = useModel((s) => {
    const f = s.doc.features.find((x) => x.id === s.editingFeatureId);
    return f?.kind === 'fillet' || f?.kind === 'chamfer';
  });

  // Memoised because the effect that uploads it compares by identity: a fresh array on every
  // React render would re-upload a texture that had not changed.
  const colours = useMemo(
    () => faceColours(evaluated.faceOwner, doc),
    [evaluated.faceOwner, doc],
  );

  // Outward normals, so the viewport can resolve a drag along the face being pushed. Built
  // here because the face graph is the document's business, not the viewport's.
  const faceNormals = useMemo(() => {
    const out = new Map<number, [number, number, number]>();
    if (triCount(evaluated.mesh) === 0) return out;

    for (const face of buildFaceGraph(evaluated.mesh).faces.values()) {
      out.set(face.id, [face.axis[0], face.axis[1], face.axis[2]]);
    }
    return out;
  }, [evaluated.mesh]);

  const hasModel = triCount(evaluated.mesh) > 0;

  // What a face is, measured from the triangles. Recomputed only when the selection or the
  // geometry changes, because building the face graph is not free.
  const measurement = useMemo(
    () => (hasModel ? measureFaces(evaluated.mesh, selectedFaces) : null),
    [evaluated.mesh, selectedFaces, hasModel],
  );

  /*
   * The right-click menu.
   *
   * Built here rather than in the viewport because every action worth offering knows about
   * the document. What it offers depends on what is under the pointer and what is already
   * picked: rounding needs faces selected, sketching needs one flat face, and deleting needs
   * a feature that made the face you clicked.
   */
  const menuActions = useCallback((face: number) => {
    const owner = face >= 0 ? evaluated.faceOwner.get(face) : undefined;
    const feature = owner ? doc.features.find((f) => f.id === owner) : undefined;
    const picked = selectedFaces.length;
    const scoped = picked > 0 ? selectedFaces : face >= 0 ? [face] : [];
    const hasModel = triCount(evaluated.mesh) > 0;

    /*
     * Everything a face can be the subject of.
     *
     * Six of twenty-four features used to be reachable here, which meant the viewport was for
     * looking and the toolbar was for working. A menu that offers what you can do to *the thing
     * you just clicked* is the difference between the two.
     *
     * Grouped the way the operations divide: what to do with the faces you picked, what to
     * build on the face under the pointer, what to do to the whole part, and what to do to the
     * feature that made this face.
     */
    return [
      {
        label: picked > 1 ? `Round these ${picked} faces` : 'Round this face',
        disabled: scoped.length === 0,
        run: () => addScoped('fillet', scoped),
      },
      {
        label: picked > 1 ? `Chamfer these ${picked} faces` : 'Chamfer this face',
        disabled: scoped.length === 0,
        run: () => addScoped('chamfer', scoped),
      },
      {
        label: picked > 1 ? `Drill ${picked} holes here` : 'Drill a hole here',
        disabled: face < 0,
        run: () => drillOnFace(face),
      },
      {
        label: 'Sketch on this face',
        disabled: face < 0,
        run: () => sketchOnFace(face, 'sketch'),
      },
      {
        label: 'Extrude from this face',
        disabled: face < 0,
        run: () => sketchOnFace(face, 'extrude'),
      },
      {
        label: 'Rib on this face',
        disabled: face < 0,
        run: () => ribOnFace(face),
      },
      {
        label: 'Pocket into this face',
        disabled: face < 0,
        run: () => addFeature('pocket'),
      },
      {
        label: 'Slot into this face',
        disabled: face < 0,
        run: () => addFeature('slot'),
      },
      {
        label: 'Dome this face',
        disabled: face < 0,
        run: () => addFeature('dome'),
      },

      // Whole-part operations. They do not need a face, only something to act on.
      { label: 'Shell the part', disabled: !hasModel, run: () => addFeature('shell') },
      { label: 'Draft the walls', disabled: !hasModel, run: () => addFeature('draft') },
      { label: 'Split into two bodies', disabled: !hasModel, run: () => addFeature('split') },
      { label: 'Wrap a pattern around it', disabled: !hasModel, run: () => addFeature('wrap') },
      { label: 'Mirror the part', disabled: !hasModel, run: () => addFeature('mirror') },
      { label: 'Repeat in a line', disabled: !hasModel, run: () => addFeature('patternLinear') },
      { label: 'Repeat around a circle', disabled: !hasModel, run: () => addFeature('patternCircular') },
      { label: 'Add a datum plane', run: () => addFeature('datum') },

      {
        label: feature ? `Edit ${feature.name}` : 'Edit feature',
        disabled: !feature,
        run: () => { if (feature) edit(feature.id); },
      },
      {
        label: feature ? `Delete ${feature.name}` : 'Delete feature',
        disabled: !feature,
        run: () => { if (feature) remove(feature.id); },
      },
      {
        label: 'Clear selection',
        disabled: picked === 0,
        run: () => toggleFace(-1, false),
      },
    ];
  }, [doc, evaluated.faceOwner, evaluated.mesh, selectedFaces, addScoped, sketchOnFace,
      drillOnFace, ribOnFace, addFeature, edit, remove, toggleFace]);

  /*
   * The status line shows the measurement while faces are picked, and the part's own figures
   * otherwise.
   *
   * Replacing rather than appending, because the two are answers to different questions and
   * both on screen at once is a row of eleven numbers nobody reads. What you picked a face to
   * find out is the more urgent of the two for as long as the face is picked.
   */
  /*
   * The exact figures replace the tessellated ones once the part has been rebuilt exactly.
   *
   * Marked as exact rather than quietly swapped, because the whole reason to have asked is that
   * the two differ — a 10 mm hole reads 9.94 in one and 10.00 in the other, and which you are
   * looking at decides whether the number can carry a tolerance.
   */
  const exact = useModel((s) => s.exact);

  const status = measurement
    ? [
        { label: measurement.subject, value: '' },
        ...measurement.lines.map((l) => ({ label: l.label.toLowerCase(), value: l.value })),
      ]
    : exact
      ? [
          { label: 'exact vol', value: formatVolume(exact.volume) },
          { label: 'area', value: `${(exact.area / 100).toFixed(2)} cm²` },
          { label: 'faces', value: String(exact.faces) },
          { label: 'tri', value: triCount(exact.mesh).toLocaleString() },
          { label: 'kernel', value: 'exact' },
        ]
      : [
          { label: 'mass', value: hasModel ? formatMass(evaluated.massGrams) : '—' },
          { label: 'vol', value: hasModel ? formatVolume(evaluated.volume) : '—' },
          { label: 'tri', value: triCount(evaluated.mesh).toLocaleString() },
          { label: 'build', value: `${evaluated.rebuildMs} ms` },
          { label: 'solid', value: hasModel ? (evaluated.health.closed ? 'closed' : 'OPEN') : '—' },
        ];

  /*
   * The sketch is drawn over the viewport, not beside it.
   *
   * It was only ever in the feature panel: click Sketch and the tools appeared in a column on
   * the far side of the window from the part they belong to. That is where the editor was
   * easiest to mount and it is not where anyone looks for it — you sketch *on the model*, and
   * a user who selects the sketch tool and finds nothing in the viewport concludes, reasonably,
   * that sketching does not work.
   *
   * The same component, unchanged, docked over the 3D view. The part stays visible behind it,
   * which is the other half of why it belongs here: a sketch is nearly always drawn in relation
   * to geometry that already exists.
   */
  const view = (
    <Viewport3D
      mesh={exact ? exact.mesh : evaluated.mesh}
      edges={evaluated.edges}
      fitKey={doc.id}
      faceOwner={evaluated.faceOwner}
      faceLabel={featureNames(evaluated.faceOwner, doc)}
      faceColours={colours}
      featureFaceRange={evaluated.featureFaceRange}
      selectedFeatureId={selectedFeatureId}
      onSelectFeature={select}
      pickedFaces={selectedFaces}
      onPickFace={toggleFace}
      onPushPull={(face, distance) => pushPull(face, distance)}
      faceNormals={faceNormals}
      menuActions={menuActions}
      onMovePart={(dx, dy, dz) => {
        // Added by the store against the live document, not read-and-set from this render's
        // copy of it: a drag emits pointer events faster than React re-renders, and every
        // frame in one batch would otherwise start from the same stale placement.
        if (selectedFeatureId) nudge(selectedFeatureId, { x: dx, y: dy, z: dz });
      }}
      onRotatePart={(drx, dry, drz) => {
        if (selectedFeatureId) nudge(selectedFeatureId, { rx: drx, ry: dry, rz: drz });
      }}
      faceScopeMode={faceScopeMode}
      status={status}
      rebuilding={rebuilding}
    />
  );

  if (editing?.kind === 'sketch') {
    return (
      <div className="mv-sketching">
        {view}

        <div className="mv-sketch-pane">
          <div className="mv-sketch-head">
            <strong>{editing.name}</strong>
            <span>Draw a closed outline. Click a line or a circle to dimension it.</span>
            <button type="button" onClick={() => edit(null)} title="Close the sketch (Esc)">
              Done
            </button>
          </div>

          <SketchEditor
            value={typeof editing.params.sketch === 'string' ? editing.params.sketch : ''}
            onChange={(json) => setParams(editing.id, { sketch: json })}
          />
        </div>
      </div>
    );
  }

  return view;
}

function formatMass(g: number): string {
  if (g >= 1e6) return `${(g / 1e6).toFixed(2)} t`;
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg`;
  return `${g.toFixed(1)} g`;
}

function formatVolume(mm3: number): string {
  if (mm3 >= 1e9) return `${(mm3 / 1e9).toFixed(3)} m³`;
  return `${(mm3 / 1000).toFixed(2)} cm³`;
}

import { useModel } from '../modelStore';
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

export function ModelViewport() {
  const doc = useModel((s) => s.doc);
  const evaluated = useModel((s) => s.evaluated);
  const selectedFeatureId = useModel((s) => s.selectedFeatureId);
  const select = useModel((s) => s.select);
  const selectedFaces = useModel((s) => s.selectedFaces);
  const toggleFace = useModel((s) => s.toggleFace);
  const place = useModel((s) => s.place);
  const rebuilding = useModel((s) => s.building);

  const faceScopeMode = useModel((s) => {
    const f = s.doc.features.find((x) => x.id === s.editingFeatureId);
    return f?.kind === 'fillet' || f?.kind === 'chamfer';
  });

  const hasModel = triCount(evaluated.mesh) > 0;

  const status = [
    { label: 'mass', value: hasModel ? formatMass(evaluated.massGrams) : '—' },
    { label: 'vol', value: hasModel ? formatVolume(evaluated.volume) : '—' },
    { label: 'tri', value: triCount(evaluated.mesh).toLocaleString() },
    { label: 'build', value: `${evaluated.rebuildMs} ms` },
    { label: 'solid', value: hasModel ? (evaluated.health.closed ? 'closed' : 'OPEN') : '—' },
  ];

  return (
    <Viewport3D
      mesh={evaluated.mesh}
      edges={evaluated.edges}
      fitKey={doc.id}
      faceOwner={evaluated.faceOwner}
      faceLabel={featureNames(evaluated.faceOwner, doc)}
      featureFaceRange={evaluated.featureFaceRange}
      selectedFeatureId={selectedFeatureId}
      onSelectFeature={select}
      pickedFaces={selectedFaces}
      onPickFace={toggleFace}
      onMovePart={(dx, dy, dz) => {
        // Resolved against the document rather than accumulated in the viewport, so a drag and
        // a typed coordinate are the same edit and cannot drift apart.
        const f = doc.features.find((x) => x.id === selectedFeatureId);
        if (!f) return;
        const at = f.placement ?? { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
        place(f.id, { x: at.x + dx, y: at.y + dy, z: at.z + dz });
      }}
      faceScopeMode={faceScopeMode}
      status={status}
      rebuilding={rebuilding}
    />
  );
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

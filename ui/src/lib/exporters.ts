import { shapeExtent, type Geometry, type PartDoc, type Shape2D } from './partModel';

/**
 * Export from the evaluated profile.
 *
 * DXF and SVG are exact: the model is a 2D profile swept to a thickness, so a 2D export
 * is a lossless representation of the geometry, not an approximation. DXF is the format
 * that actually matters for a plate — it is what laser, waterjet and routing shops quote
 * from.
 *
 * STEP and STL are deliberately absent. Both describe solids, and producing them honestly
 * needs a B-rep kernel and a mesher respectively. Emitting a plausible-looking file that
 * a shop cannot machine from would be worse than not offering it, so the UI says what is
 * missing and why instead.
 */

// ── polyline flattening ──────────────────────────────────────────────────────

export type Poly = { x: number; y: number }[];

const ARC_SEGMENTS = 48;

/** Converts a shape to a closed polyline in model space (mm, Y up). */
export function flatten(shape: Shape2D): Poly {
  const rot = ((shape.rot ?? 0) * Math.PI) / 180;
  const spin = (p: { x: number; y: number }): { x: number; y: number } => {
    if (!rot) return p;
    const dx = p.x - shape.cx;
    const dy = p.y - shape.cy;
    return {
      x: shape.cx + dx * Math.cos(rot) - dy * Math.sin(rot),
      y: shape.cy + dx * Math.sin(rot) + dy * Math.cos(rot),
    };
  };

  switch (shape.kind) {
    case 'circle': {
      const r = shape.r ?? 0;
      const out: Poly = [];
      for (let i = 0; i < ARC_SEGMENTS; i++) {
        const a = (i / ARC_SEGMENTS) * Math.PI * 2;
        out.push({ x: shape.cx + r * Math.cos(a), y: shape.cy + r * Math.sin(a) });
      }
      return out;
    }

    case 'polygon': {
      const n = Math.max(3, shape.sides ?? 6);
      const r = shape.r ?? 0;
      const out: Poly = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        out.push(spin({ x: shape.cx + r * Math.cos(a), y: shape.cy + r * Math.sin(a) }));
      }
      return out;
    }

    case 'rect': {
      const w = shape.w ?? 0;
      const h = shape.h ?? 0;
      const r = Math.min(shape.cornerR ?? 0, Math.min(w, h) / 2);
      const x0 = shape.cx - w / 2;
      const y0 = shape.cy - h / 2;
      const x1 = shape.cx + w / 2;
      const y1 = shape.cy + h / 2;

      if (r <= 1e-6) {
        return [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ].map(spin);
      }

      // Rounded rectangle: four straight runs joined by quarter arcs, walked
      // counter-clockwise so the outer boundary keeps a consistent winding.
      const out: Poly = [];
      const q = Math.max(2, Math.round(ARC_SEGMENTS / 4));
      const corners: [number, number, number][] = [
        [x1 - r, y0 + r, -Math.PI / 2],
        [x1 - r, y1 - r, 0],
        [x0 + r, y1 - r, Math.PI / 2],
        [x0 + r, y0 + r, Math.PI],
      ];
      for (const [cxr, cyr, start] of corners) {
        for (let i = 0; i <= q; i++) {
          const a = start + (i / q) * (Math.PI / 2);
          out.push(spin({ x: cxr + r * Math.cos(a), y: cyr + r * Math.sin(a) }));
        }
      }
      return out;
    }

    case 'slot': {
      // Stadium: two semicircles of radius h/2, centres w apart.
      const w = shape.w ?? 0;
      const h = shape.h ?? 0;
      const r = h / 2;
      const out: Poly = [];
      const q = Math.max(4, ARC_SEGMENTS / 2);

      for (let i = 0; i <= q; i++) {
        const a = -Math.PI / 2 + (i / q) * Math.PI;
        out.push(spin({ x: shape.cx + w / 2 + r * Math.cos(a), y: shape.cy + r * Math.sin(a) }));
      }
      for (let i = 0; i <= q; i++) {
        const a = Math.PI / 2 + (i / q) * Math.PI;
        out.push(spin({ x: shape.cx - w / 2 + r * Math.cos(a), y: shape.cy + r * Math.sin(a) }));
      }
      return out;
    }

    default:
      return [];
  }
}

// ── DXF ──────────────────────────────────────────────────────────────────────

/**
 * Minimal but valid AutoCAD R12 DXF. R12 is chosen deliberately: it is the most widely
 * accepted dialect in job shops and CAM packages, and it needs no handles, classes or
 * object tables — which keeps this writer small enough to audit.
 *
 * Circles are emitted as true CIRCLE entities rather than polylines so the shop sees a
 * drillable hole with an exact diameter.
 */
export function toDxf(geom: Geometry): string {
  const L: string[] = [];
  const pair = (code: number, value: string | number) => {
    L.push(String(code));
    L.push(String(value));
  };

  pair(0, 'SECTION');
  pair(2, 'ENTITIES');

  const polyline = (poly: Poly, layer: string) => {
    if (poly.length < 2) return;
    pair(0, 'POLYLINE');
    pair(8, layer);
    pair(66, 1);
    pair(70, 1); // closed
    for (const p of poly) {
      pair(0, 'VERTEX');
      pair(8, layer);
      pair(10, round(p.x));
      pair(20, round(p.y));
      pair(30, 0);
    }
    pair(0, 'SEQEND');
    pair(8, layer);
  };

  // Outer profile on its own layer so the shop can separate cut order.
  if (geom.outline.kind === 'circle') {
    pair(0, 'CIRCLE');
    pair(8, 'PROFILE');
    pair(10, round(geom.outline.cx));
    pair(20, round(geom.outline.cy));
    pair(30, 0);
    pair(40, round(geom.outline.r ?? 0));
  } else {
    polyline(flatten(geom.outline), 'PROFILE');
  }

  for (const c of geom.cuts) {
    if (c.kind === 'circle') {
      pair(0, 'CIRCLE');
      pair(8, 'HOLES');
      pair(10, round(c.cx));
      pair(20, round(c.cy));
      pair(30, 0);
      pair(40, round(c.r ?? 0));
    } else {
      polyline(flatten(c), 'CUTOUTS');
    }
  }

  pair(0, 'ENDSEC');
  pair(0, 'EOF');
  return L.join('\r\n') + '\r\n';
}

// ── SVG ──────────────────────────────────────────────────────────────────────

/**
 * SVG with the cuts as a single path using the even-odd fill rule, so holes read as
 * holes in any viewer rather than as filled discs stacked on the profile.
 */
export function toSvg(geom: Geometry): string {
  const ext = shapeExtent(geom.outline);
  const pad = 5;
  const w = ext.w + pad * 2;
  const h = ext.h + pad * 2;

  // SVG's Y axis grows downward; the model's grows up.
  const path = (poly: Poly) =>
    poly.length === 0
      ? ''
      : `M ${poly
          .map((p) => `${round(p.x + w / 2)} ${round(h / 2 - p.y)}`)
          .join(' L ')} Z`;

  const parts = [path(flatten(geom.outline)), ...geom.cuts.map((c) => path(flatten(c)))];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${round(w)}mm" height="${round(h)}mm" viewBox="0 0 ${round(w)} ${round(h)}">
  <path d="${parts.join(' ')}" fill="#8899aa" fill-rule="evenodd" stroke="#111" stroke-width="0.25"/>
</svg>
`;
}

// ── manifest ─────────────────────────────────────────────────────────────────

/** Human-readable summary of what was exported, for the release package. */
export function toManifest(doc: PartDoc, geom: Geometry, massG: number): string {
  const ext = shapeExtent(geom.outline);
  const lines = [
    `Part        ${doc.title}`,
    `Material    ${doc.material}`,
    `Envelope    ${ext.w.toFixed(2)} x ${ext.h.toFixed(2)} x ${geom.T.toFixed(2)} mm`,
    `Mass        ${massG.toFixed(2)} g`,
    `Area        ${geom.areaMm2.toFixed(1)} mm^2`,
    `Cuts        ${geom.cuts.length}`,
    `Holes       ${geom.holes.length}`,
    '',
    'Properties',
    ...Object.entries(doc.properties).map(([k, v]) => `  ${k.padEnd(14)}${v}`),
    '',
    'Feature tree',
    ...doc.features.map(
      (f, i) => `  ${String(i + 1).padStart(2)}. ${f.name.padEnd(22)}${f.swType}${f.suppressed ? '  [suppressed]' : ''}`,
    ),
  ];
  return lines.join('\r\n') + '\r\n';
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── browser download ─────────────────────────────────────────────────────────

export function download(filename: string, contents: string, mime: string): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can cancel the download in
  // some browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

import { useMemo } from 'react';
import { useStore } from '../store';
import { evaluate, massGrams, shapeExtent, type Shape2D } from '../lib/partModel';

/**
 * Plan-view of the active document.
 *
 * Everything is derived from the evaluated feature tree — the outline comes from the
 * profile feature, the corner radius from a fillet, every hole and pocket from a cut.
 * Nothing is hardcoded, so adding, editing, reordering, suppressing, undoing or redoing
 * a feature all move the geometry here.
 *
 * Clicking a cut selects the feature that produced it and opens it in the editor, which
 * is the same select-then-edit loop SOLIDWORKS uses.
 *
 * When a live seat is attached this pane is replaced by a throttled JPEG stream of the
 * real graphics area. This vector view is the standalone modeller, and the badge says
 * which one you are looking at rather than leaving it ambiguous.
 */
export function Viewport({ compact = false }: { compact?: boolean }) {
  const doc = useStore((s) => s.doc);
  const hotPids = useStore((s) => s.hotPids);
  const connected = useStore((s) => s.connected);
  const editingId = useStore((s) => s.editingFeatureId);
  const setEditingFeature = useStore((s) => s.setEditingFeature);

  const geom = useMemo(() => (doc ? evaluate(doc) : null), [doc]);

  if (!doc || !geom) {
    return (
      <div className="vp-empty">
        <span className="eyebrow">Viewport</span>
        <p>No document open.</p>
      </div>
    );
  }

  const VB_W = 460;
  const VB_H = 320;
  const margin = compact ? 46 : 74;
  const ext = shapeExtent(geom.outline);
  const scale = Math.min((VB_W - margin * 2) / Math.max(ext.w, 1), (VB_H - margin * 2) / Math.max(ext.h, 1));

  const cx = VB_W / 2;
  const cy = VB_H / 2 - (compact ? 0 : 6);

  const outlineHot = hotPids.some((p) => p.startsWith('edge'));
  const mass = massGrams(doc, geom);

  // Model-space (mm, Y up) → screen. Y flips because SVG grows downward.
  const sx = (x: number) => cx + x * scale;
  const sy = (y: number) => cy - y * scale;

  return (
    <div className="vp">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="vp-svg"
        role="img"
        aria-label={`Plan view, ${ext.w.toFixed(1)} by ${ext.h.toFixed(1)} by ${geom.T} millimetres`}
      >
        <defs>
          <pattern id="vpgrid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" stroke="var(--hairline)" strokeWidth="1" />
          </pattern>
          <marker id="vparrow" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6 z" fill="var(--tx2)" />
          </marker>
          <marker id="vparrowStart" markerWidth="9" markerHeight="9" refX="1" refY="3" orient="auto">
            <path d="M8,0 L0,3 L8,6 z" fill="var(--tx2)" />
          </marker>
        </defs>

        <rect width={VB_W} height={VB_H} fill="url(#vpgrid)" />

        {/* centre lines — drafting convention, long-dash-dot */}
        <line x1={sx(-ext.w / 2) - 26} y1={cy} x2={sx(ext.w / 2) + 26} y2={cy}
              stroke="var(--tx2)" strokeWidth="0.8" strokeDasharray="14 4 3 4" opacity="0.55" />
        <line x1={cx} y1={sy(ext.h / 2) - 26} x2={cx} y2={sy(-ext.h / 2) + 26}
              stroke="var(--tx2)" strokeWidth="0.8" strokeDasharray="14 4 3 4" opacity="0.55" />

        {/* outer profile */}
        <ShapePath
          shape={geom.outline}
          sx={sx}
          sy={sy}
          scale={scale}
          fill="color-mix(in srgb, var(--ai) 10%, transparent)"
          stroke={outlineHot ? 'var(--viz)' : 'var(--tx0)'}
          strokeWidth={outlineHot ? 3 : 1.6}
        />

        {/* shell wall, as an inner offset */}
        {geom.shellWall !== null && geom.outline.kind === 'rect' && (
          <ShapePath
            shape={{
              ...geom.outline,
              w: Math.max(0, (geom.outline.w ?? 0) - geom.shellWall * 2),
              h: Math.max(0, (geom.outline.h ?? 0) - geom.shellWall * 2),
              cornerR: Math.max(0, (geom.outline.cornerR ?? 0) - geom.shellWall),
            }}
            sx={sx}
            sy={sy}
            scale={scale}
            fill="none"
            stroke="var(--tx1)"
            strokeWidth={1}
            dash="4 3"
          />
        )}

        {/* cuts — clickable, each traceable to the feature that made it */}
        {geom.cuts.map((c, i) => {
          const selected = c.owner === editingId;
          return (
            <g
              key={i}
              className="vp-cut"
              onClick={() => setEditingFeature(c.owner)}
              style={{ cursor: 'pointer' }}
            >
              <ShapePath
                shape={c}
                sx={sx}
                sy={sy}
                scale={scale}
                fill="var(--ground)"
                stroke={selected ? 'var(--viz)' : 'var(--tx0)'}
                strokeWidth={selected ? 2.6 : 1.2}
              />
              {c.kind === 'circle' && <CentreMark x={sx(c.cx)} y={sy(c.cy)} r={(c.r ?? 0) * scale} />}
            </g>
          );
        })}

        {!compact && (
          <>
            <HDim from={sx(-ext.w / 2)} to={sx(ext.w / 2)} y={sy(-ext.h / 2) + 40}
                  extendFrom={sy(-ext.h / 2)} label={ext.w.toFixed(1)} />
            <VDim from={sy(ext.h / 2)} to={sy(-ext.h / 2)} x={sx(-ext.w / 2) - 40}
                  extendFrom={sx(-ext.w / 2)} label={ext.h.toFixed(1)} />
            {geom.cornerR > 0 && (
              <text x={sx(ext.w / 2) + 8} y={sy(ext.h / 2) - 6} className="vp-note">
                R{geom.cornerR.toFixed(1)}
              </text>
            )}
            {geom.holes.length > 0 && (
              <text x={cx + 8} y={sy(ext.h / 2) - 6} className="vp-note">
                {geom.holes.length}× ⌀{geom.holes[0]!.d.toFixed(1)}
              </text>
            )}
          </>
        )}
      </svg>

      <div className="vp-tag">
        <span className="eyebrow">
          {connected ? 'SOLIDWORKS · live' : 'Standalone modeller'}
        </span>
      </div>

      <div className="vp-read">
        <span>L <b>{ext.w.toFixed(1)}</b></span>
        <span>W <b>{ext.h.toFixed(1)}</b></span>
        <span>T <b>{geom.T.toFixed(1)}</b></span>
        <span>mass <b>{mass.toFixed(1)}</b> g</span>
        <span>{geom.cuts.length} cut{geom.cuts.length === 1 ? '' : 's'}</span>
        <span>{doc.material}</span>
      </div>
    </div>
  );
}

/* ── shape rendering ──────────────────────────────────────────────────────── */

function ShapePath({
  shape,
  sx,
  sy,
  scale,
  fill,
  stroke,
  strokeWidth,
  dash,
}: {
  shape: Shape2D;
  sx: (x: number) => number;
  sy: (y: number) => number;
  scale: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  dash?: string;
}) {
  const common = { fill, stroke, strokeWidth, strokeDasharray: dash };
  const rot = shape.rot ?? 0;
  const transform = rot ? `rotate(${-rot} ${sx(shape.cx)} ${sy(shape.cy)})` : undefined;

  switch (shape.kind) {
    case 'circle':
      return <circle cx={sx(shape.cx)} cy={sy(shape.cy)} r={(shape.r ?? 0) * scale} {...common} />;

    case 'rect': {
      const w = (shape.w ?? 0) * scale;
      const h = (shape.h ?? 0) * scale;
      return (
        <rect
          x={sx(shape.cx) - w / 2}
          y={sy(shape.cy) - h / 2}
          width={w}
          height={h}
          rx={(shape.cornerR ?? 0) * scale}
          transform={transform}
          {...common}
        />
      );
    }

    case 'slot': {
      // A slot is a stadium: the rounded ends have radius h/2, so the drawn rectangle
      // must be widened by h to place the arc centres w apart.
      const w = (shape.w ?? 0) * scale;
      const h = (shape.h ?? 0) * scale;
      return (
        <rect
          x={sx(shape.cx) - (w + h) / 2}
          y={sy(shape.cy) - h / 2}
          width={w + h}
          height={h}
          rx={h / 2}
          transform={transform}
          {...common}
        />
      );
    }

    case 'polygon': {
      const n = Math.max(3, shape.sides ?? 6);
      const r = (shape.r ?? 0) * scale;
      const pts: string[] = [];
      for (let i = 0; i < n; i++) {
        // Start at the top so an even-sided polygon sits flat, as a drafter expects.
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        pts.push(`${sx(shape.cx) + r * Math.cos(a)},${sy(shape.cy) + r * Math.sin(a)}`);
      }
      return <polygon points={pts.join(' ')} transform={transform} {...common} />;
    }

    default:
      return null;
  }
}

function CentreMark({ x, y, r }: { x: number; y: number; r: number }) {
  const m = Math.max(r + 4, 7);
  return (
    <>
      <line x1={x - m} y1={y} x2={x + m} y2={y} stroke="var(--tx2)" strokeWidth="0.8" />
      <line x1={x} y1={y - m} x2={x} y2={y + m} stroke="var(--tx2)" strokeWidth="0.8" />
    </>
  );
}

/* ── dimensions ───────────────────────────────────────────────────────────── */

function HDim({ from, to, y, extendFrom, label }: {
  from: number; to: number; y: number; extendFrom: number; label: string;
}) {
  const mid = (from + to) / 2;
  return (
    <>
      <line x1={from} y1={extendFrom + 6} x2={from} y2={y + 8} stroke="var(--tx2)" strokeWidth="0.7" />
      <line x1={to} y1={extendFrom + 6} x2={to} y2={y + 8} stroke="var(--tx2)" strokeWidth="0.7" />
      <line x1={from} y1={y} x2={to} y2={y} stroke="var(--tx2)" strokeWidth="0.9"
            markerStart="url(#vparrowStart)" markerEnd="url(#vparrow)" />
      <rect x={mid - 24} y={y - 9} width="48" height="17" fill="var(--ground)" />
      <text x={mid} y={y + 4} textAnchor="middle" className="vp-dim">{label}</text>
    </>
  );
}

function VDim({ from, to, x, extendFrom, label }: {
  from: number; to: number; x: number; extendFrom: number; label: string;
}) {
  const mid = (from + to) / 2;
  return (
    <>
      <line x1={extendFrom - 6} y1={from} x2={x - 8} y2={from} stroke="var(--tx2)" strokeWidth="0.7" />
      <line x1={extendFrom - 6} y1={to} x2={x - 8} y2={to} stroke="var(--tx2)" strokeWidth="0.7" />
      <line x1={x} y1={from} x2={x} y2={to} stroke="var(--tx2)" strokeWidth="0.9"
            markerStart="url(#vparrowStart)" markerEnd="url(#vparrow)" />
      <rect x={x - 18} y={mid - 9} width="36" height="17" fill="var(--ground)" />
      <text x={x} y={mid + 4} textAnchor="middle" className="vp-dim">{label}</text>
    </>
  );
}

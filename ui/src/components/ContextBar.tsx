import { useStore } from '../store';

/**
 * The app's proof that it is actually connected and watching.
 *
 * Critical rule from the UX spec: this must never present stale data as current. When
 * the delta stream stalls, the whole bar desaturates and says so, because showing
 * nothing is better than showing a lie about someone's model.
 */
export function ContextBar() {
  const ctx = useStore((s) => s.context);
  const connected = useStore((s) => s.connected);
  const stale = useStore((s) => s.stale);
  const demo = useStore((s) => s.demo);
  const setTab = useStore((s) => s.setTab);

  if (!ctx?.docPath) {
    return (
      <div className="ctx" data-stale={stale}>
        <div className="ctx-line">
          <span className="doc" style={{ color: 'var(--tx1)', fontWeight: 400 }}>
            No document open
          </span>
        </div>
        <div className="pills">
          <span className={connected ? 'pill ok' : 'pill'}>
            {connected ? '✓ SOLIDWORKS connected' : '○ waiting for SOLIDWORKS'}
          </span>
        </div>
      </div>
    );
  }

  const warnings = ctx.features.filter((f) => f.underDefined || f.fragileRef).length;
  const locked = ctx.pdm?.inVault && !ctx.pdm.checkedOut;

  return (
    <div className="ctx" data-stale={stale}>
      <div className="ctx-line">
        <span className="doc" title={ctx.docPath}>
          {ctx.docTitle}
        </span>
        <span className="sep">·</span>
        <span className="cfg">{ctx.configuration}</span>
        <span className="sep">·</span>
        <span className="cfg">{ctx.units}</span>
      </div>

      <div className="pills">
        {demo ? (
          <span className="pill warn">sample data</span>
        ) : stale ? (
          <span className="pill warn">reconnecting…</span>
        ) : null}

        {ctx.pdm?.inVault ? (
          locked ? (
            <span className="pill dang">
              🔒 locked{ctx.pdm.checkedOutBy ? ` by ${ctx.pdm.checkedOutBy}` : ''}
            </span>
          ) : (
            <span className="pill ok">✓ checked out</span>
          )
        ) : !ctx.writable ? (
          <span className="pill dang">read-only</span>
        ) : null}

        <span className="pill">⟳ {(ctx.lastRebuildMs / 1000).toFixed(1)} s</span>

        {ctx.rebuildErrors > 0 && <span className="pill dang">✕ {ctx.rebuildErrors}</span>}

        {warnings > 0 && (
          <button className="pill warn" onClick={() => setTab('health')}>
            ⚠ {warnings}
          </button>
        )}

        <span className="pill">{ctx.massG.toFixed(1)} g</span>
      </div>
    </div>
  );
}

import { useStore } from '../store';
import { useModel } from '../modelStore';
import { triCount } from '../engine';

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

  /*
   * Standalone.
   *
   * With no connector there is no SOLIDWORKS document to be the context of, and the bar used
   * to fill the gap with a fabricated one — a file path, a configuration and a mass belonging
   * to no part on screen, sitting directly above the real part's mass in the status strip and
   * disagreeing with it. "sample data" labelled the lie without stopping it being one.
   *
   * There *is* a document open in standalone: the DATUM part. So the bar reports that.
   */
  if (demo) return <StandaloneContext />;

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


/** The bar as it reads with no connector: the open DATUM part, measured off its own solid. */
function StandaloneContext() {
  const doc = useModel((s) => s.doc);
  const evaluated = useModel((s) => s.evaluated);
  const building = useModel((s) => s.building);

  const modelled = triCount(evaluated.mesh) > 0;
  /*
   * The mass the evaluator already computed, not volume times one density.
   *
   * A single-material part has one density and the product is exact. An assembly does not: a
   * gearbox is a steel case, two steel gears and bronze bushes, and weighing the merged solid
   * at any one of those densities is simply wrong. Doing it here put 5773 g in the context bar
   * beside the 3.09 kg the viewport reported for the same gearbox - two figures for one part,
   * on the same screen. `massGrams` sums each component's own volume at its own density, which
   * is why the document carries it.
   */
  const mass = evaluated.massGrams;

  return (
    <div className="ctx">
      <div className="ctx-line">
        <span className="doc" title="Modelled in DATUM — no CAD licence involved">
          {modelled ? doc.name : 'No part yet'}
        </span>
        <span className="sep">·</span>
        <span className="cfg">{doc.material}</span>
        <span className="sep">·</span>
        <span className="cfg">mm</span>
      </div>

      <div className="pills">
        <span className="pill ok">standalone</span>
        {building && <span className="pill">rebuilding…</span>}
        {modelled && (
          <span className="pill">
            {doc.features.length} feature{doc.features.length === 1 ? '' : 's'}
          </span>
        )}
        {modelled && <span className="pill">{mass.toFixed(1)} g</span>}
      </div>
    </div>
  );
}

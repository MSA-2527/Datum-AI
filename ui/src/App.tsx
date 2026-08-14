import { useEffect, useState } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { Panel } from './components/Panel';
import { ModelStudio } from './components/ModelStudio';
import { Studio } from './components/Studio';
import { SurfaceNav, useSurface } from './components/SurfaceNav';
import { useStore } from './store';

export function App() {
  // The standalone modeller is the default because it is the product: no licence, no add-in,
  // no connection. Studio and the CAD panel used to be reachable only by typing a query
  // string, which meant nobody found them; they now have a tab each.
  const surface = useSurface();
  const boot = useStore((s) => s.boot);
  const [ready, setReady] = useState(false);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    void boot().finally(() => setReady(true));
  }, [boot]);

  // Below 320 px the panel cannot render usefully, so it says so rather than
  // degrading into something broken.
  //
  // Observed on the element rather than the window: the task pane is resized by
  // SOLIDWORKS docking the host window, and in an embedded WebView2 the window
  // `resize` event is not reliably delivered. A ResizeObserver on the root element
  // sees every layout change regardless of how it was caused.
  useEffect(() => {
    const el = document.documentElement;
    const check = (width: number) => {
      // Width 0 means the host has not laid us out yet (hidden pane, first paint).
      // That is not "too narrow" — treat it as unknown and keep rendering.
      if (width > 0) setNarrow(width < 320);
    };

    check(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) check(box.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (narrow && surface === 'panel') {
    return <div className="panel-narrow-hint">Widen this pane to use DATUM.</div>;
  }

  // The standalone modeller needs nothing to boot, so it renders immediately. Only the
  // SOLIDWORKS-attached surfaces wait on the connection handshake.
  if (!ready && surface !== 'model') {
    return (
      <div className="panel-narrow-hint">
        <span className="eyebrow">Looking for SOLIDWORKS…</span>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <SurfaceNav current={surface} />
      <div className="app-surface">
        {surface === 'studio' ? <Studio /> : surface === 'panel' ? <Panel /> : <ModelStudio />}
      </div>
      <CommandPalette />
    </div>
  );
}

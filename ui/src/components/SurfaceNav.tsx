import { useEffect, useState } from 'react';

/**
 * The switch between the application's top-level surfaces.
 *
 * All three have existed for a long time and only one of them was reachable: the other two
 * needed a query string typed by hand, which meant that in practice nobody saw them. A
 * feature nobody can navigate to is not a feature.
 *
 * The URL stays the source of truth rather than component state, so a surface can still be
 * linked to, bookmarked, and reloaded into. Switching pushes a history entry, which makes the
 * browser's back button do the obvious thing.
 */

export type Surface = 'model' | 'studio' | 'panel';

interface SurfaceInfo {
  id: Surface;
  label: string;
  hint: string;
}

const SURFACES: SurfaceInfo[] = [
  {
    id: 'model',
    label: 'Modeller',
    hint: 'Describe a part, build it, edit it, export it. Needs nothing installed.',
  },
  {
    id: 'studio',
    label: 'Studio',
    hint: 'Manufacturability, drawings, batch runs, reuse index, history and diagnostics.',
  },
  {
    id: 'panel',
    label: 'CAD panel',
    hint: 'The task pane that runs inside SOLIDWORKS. Needs the add-in and a seat.',
  },
];

/** Reads the surface out of the URL, accepting the older `legacy` spelling. */
export function readSurface(): Surface {
  const q = new URLSearchParams(location.search).get('surface');
  if (q === 'panel') return 'panel';
  if (q === 'studio' || q === 'legacy') return 'studio';
  return 'model';
}

/**
 * Keeps a component in step with the URL.
 *
 * `popstate` is what makes the back button work; without it, going back changes the address
 * and leaves the page showing the surface you were already on.
 */
export function useSurface(): Surface {
  const [surface, setSurface] = useState<Surface>(readSurface);

  useEffect(() => {
    const sync = () => setSurface(readSurface());
    window.addEventListener('popstate', sync);
    window.addEventListener('datum:surface', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('datum:surface', sync);
    };
  }, []);

  return surface;
}

export function goToSurface(next: Surface): void {
  const url = new URL(location.href);
  if (next === 'model') url.searchParams.delete('surface');
  else url.searchParams.set('surface', next);

  history.pushState({ surface: next }, '', url);
  // pushState does not fire popstate, so the listeners need telling directly.
  window.dispatchEvent(new Event('datum:surface'));
}

export function SurfaceNav({ current }: { current: Surface }) {
  return (
    <nav className="surface-nav" aria-label="Workspace">
      <span className="surface-brand">DATUM</span>

      <div className="surface-tabs" role="tablist">
        {SURFACES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={s.id === current}
            className={s.id === current ? 'is-current' : undefined}
            title={s.hint}
            onClick={() => goToSurface(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <span className="surface-hint">{SURFACES.find((s) => s.id === current)?.hint}</span>
    </nav>
  );
}

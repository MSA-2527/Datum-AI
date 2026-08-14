/**
 * Product identity, in one place.
 *
 * The build spec requires that the product name and branding be changeable through
 * configuration rather than a find-and-replace across the source. Everything the user
 * can read the name in — window title, panel header, undo-record labels, feature tags,
 * log paths — resolves through here.
 *
 * Resolution order, most specific first:
 *   1. window.FORGE_BRAND        injected by the host (task pane or desktop shell)
 *   2. VITE_BRAND_* build vars   set per white-label build
 *   3. the defaults below
 *
 * Note the undo label and feature tag are branded too: they are written into the
 * customer's SOLIDWORKS document and show up in their undo stack and custom properties,
 * so a rebrand has to reach them or the old name leaks into real engineering files.
 */

export interface Brand {
  /** Short product name. Appears in the panel header and window title. */
  name: string;
  /** Full name for first-run, about, and installers. */
  fullName: string;
  /** One-line positioning statement. */
  tagline: string;
  /** Prefix for SOLIDWORKS undo records: "<prefix>: Add mounting holes". */
  undoPrefix: string;
  /** Custom property written onto features this product creates. */
  featureTag: string;
  /** Folder under %LOCALAPPDATA% for logs, snapshots and the local database. */
  dataFolder: string;
  /** Virtual host the task pane serves the bundle from. */
  virtualHost: string;
  /** Documentation root, shown in error states that offer help. */
  docsUrl: string;
}

const DEFAULTS: Brand = {
  name: 'DATUM',
  fullName: 'DATUM for SOLIDWORKS',
  tagline: 'Intent in, native parametric operations out',
  undoPrefix: 'DATUM',
  featureTag: 'DatumOp',
  dataFolder: 'DATUM',
  virtualHost: 'datum.local',
  docsUrl: 'https://datum.local/docs',
};

declare global {
  interface Window {
    FORGE_BRAND?: Partial<Brand>;
  }
}

function fromEnv(): Partial<Brand> {
  const env = import.meta.env as Record<string, string | undefined>;
  const pick: Partial<Brand> = {};
  if (env.VITE_BRAND_NAME) pick.name = env.VITE_BRAND_NAME;
  if (env.VITE_BRAND_FULL_NAME) pick.fullName = env.VITE_BRAND_FULL_NAME;
  if (env.VITE_BRAND_TAGLINE) pick.tagline = env.VITE_BRAND_TAGLINE;
  if (env.VITE_BRAND_UNDO_PREFIX) pick.undoPrefix = env.VITE_BRAND_UNDO_PREFIX;
  if (env.VITE_BRAND_FEATURE_TAG) pick.featureTag = env.VITE_BRAND_FEATURE_TAG;
  if (env.VITE_BRAND_DATA_FOLDER) pick.dataFolder = env.VITE_BRAND_DATA_FOLDER;
  if (env.VITE_BRAND_VIRTUAL_HOST) pick.virtualHost = env.VITE_BRAND_VIRTUAL_HOST;
  if (env.VITE_BRAND_DOCS_URL) pick.docsUrl = env.VITE_BRAND_DOCS_URL;
  return pick;
}

export const brand: Brand = {
  ...DEFAULTS,
  ...fromEnv(),
  ...(typeof window !== 'undefined' ? (window.FORGE_BRAND ?? {}) : {}),
};

/** Applies the resolved brand to anything outside React's control. */
export function applyBrand(): void {
  if (typeof document !== 'undefined') document.title = brand.name;
}

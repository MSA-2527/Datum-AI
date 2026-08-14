import { brand } from '../brand';
import { evaluate, massGrams, type PartDoc } from './partModel';
import { listSaved } from './persistence';
import { loadRecipes } from './recipes';
import type { ModelContext, Provider } from '../types';

/**
 * Diagnostics and support bundle (spec §20).
 *
 * When something goes wrong on a customer's workstation, the fastest route to a fix is a
 * file they can send. The obstacle is that everything useful for debugging is also
 * commercially sensitive: document paths carry project and client names, feature names
 * carry design intent, and properties carry part numbers.
 *
 * So redaction is the default, not an option. The bundle keeps shapes, counts, versions
 * and timings — which is what actually diagnoses a fault — and drops the identifiers.
 * A support bundle nobody dares send is worth nothing.
 */

export interface DiagnosticsInput {
  context: ModelContext | null;
  doc: PartDoc | null;
  providers: Provider[];
  providerId: string;
  connected: boolean;
  demo: boolean;
  undoDepth: number;
  redoDepth: number;
  streamLength: number;
}

export interface DiagnosticSection {
  title: string;
  rows: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }[];
}

export function collect(input: DiagnosticsInput): DiagnosticSection[] {
  const { context, doc, providers, providerId, connected, demo } = input;
  const geom = doc ? evaluate(doc) : null;

  const active = providers.find((p) => p.id === providerId);

  return [
    {
      title: 'Versions',
      rows: [
        { label: 'Product', value: `${brand.fullName}` },
        { label: 'UI bundle', value: import.meta.env.MODE },
        { label: 'Operation IR', value: '1.4' },
        { label: 'SOLIDWORKS', value: context?.swVersion ? String(context.swVersion) : 'not connected' },
      ],
    },
    {
      title: 'Connection',
      rows: [
        {
          label: 'Kernel',
          value: connected ? 'connected' : demo ? 'standalone (no seat)' : 'disconnected',
          tone: connected ? 'ok' : demo ? 'warn' : 'bad',
        },
        { label: 'Surface', value: new URLSearchParams(location.search).get('surface') ?? 'panel' },
        { label: 'Document', value: context?.docTitle ? 'open' : 'none' },
        { label: 'Writable', value: context?.writable ? 'yes' : 'no', tone: context?.writable ? 'ok' : 'warn' },
      ],
    },
    {
      title: 'Planner',
      rows: [
        { label: 'Active', value: active ? `${active.kind} · ${active.model}` : 'none configured',
          tone: active ? 'ok' : 'warn' },
        { label: 'Registered', value: String(providers.length) },
        { label: 'Available', value: String(providers.filter((p) => p.available).length) },
      ],
    },
    {
      title: 'Document',
      rows: [
        { label: 'Features', value: String(context?.features.length ?? 0) },
        { label: 'Rebuild errors', value: String(context?.rebuildErrors ?? 0),
          tone: (context?.rebuildErrors ?? 0) === 0 ? 'ok' : 'bad' },
        { label: 'Warnings', value: String(context?.rebuildWarnings ?? 0),
          tone: (context?.rebuildWarnings ?? 0) === 0 ? 'ok' : 'warn' },
        { label: 'Rebuild time', value: `${((context?.lastRebuildMs ?? 0) / 1000).toFixed(2)} s` },
        { label: 'Cuts evaluated', value: String(geom?.cuts.length ?? 0) },
        { label: 'Mass', value: doc && geom ? `${massGrams(doc, geom).toFixed(1)} g` : '—' },
      ],
    },
    {
      title: 'Session',
      rows: [
        { label: 'Undo depth', value: String(input.undoDepth) },
        { label: 'Redo depth', value: String(input.redoDepth) },
        { label: 'Transcript items', value: String(input.streamLength) },
        { label: 'Saved documents', value: String(listSaved().length) },
        { label: 'User recipes', value: String(loadRecipes().length) },
      ],
    },
    {
      title: 'Environment',
      rows: [
        { label: 'Viewport', value: `${window.innerWidth} × ${window.innerHeight}` },
        { label: 'Device pixel ratio', value: String(window.devicePixelRatio) },
        { label: 'Colour scheme', value: media('(prefers-color-scheme: dark)') ? 'dark' : 'light' },
        { label: 'Reduced motion', value: media('(prefers-reduced-motion: reduce)') ? 'yes' : 'no' },
        { label: 'Storage', value: storageHealth() },
      ],
    },
  ];
}

/**
 * Media query with a fallback.
 *
 * Diagnostics is the screen someone opens when everything else is broken, so it must not
 * be the thing that throws. `matchMedia` is absent in some embedded hosts and older
 * WebView builds, and a missing preference is not worth losing the whole report over.
 */
function media(query: string): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

function storageHealth(): string {
  try {
    const probe = '__datum_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);

    let bytes = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) bytes += key.length + (localStorage.getItem(key)?.length ?? 0);
    }
    return `writable · ${(bytes / 1024).toFixed(1)} KB used`;
  } catch {
    // Private browsing, a full quota, or a locked profile. Autosave is silently
    // failing in this state, which is exactly what a support bundle needs to reveal.
    return 'UNAVAILABLE — autosave is not working';
  }
}

// ── redaction ────────────────────────────────────────────────────────────────

/**
 * Strips anything that identifies a customer's work.
 *
 * Paths carry project and client names. Feature names carry design intent. Properties
 * carry part numbers. What a fault actually needs is shape and count, so that is what
 * survives.
 */
export function redactPath(path: string | undefined): string {
  if (!path) return '';
  const ext = path.match(/\.[^.\\/]+$/)?.[0] ?? '';
  const depth = path.split(/[\\/]/).filter(Boolean).length;
  return `<redacted:${depth} segments>${ext}`;
}

export interface BundleOptions {
  /** Off by default. Turning it on is a deliberate act, and the bundle says so. */
  includeIdentifiers?: boolean;
}

export function buildSupportBundle(
  input: DiagnosticsInput,
  errors: string[] = [],
  options: BundleOptions = {},
): string {
  const redact = !options.includeIdentifiers;
  const sections = collect(input);
  const { context, doc } = input;
  const geom = doc ? evaluate(doc) : null;

  const lines: string[] = [
    `${brand.fullName} — support bundle`,
    `Generated ${new Date().toISOString()}`,
    redact
      ? 'REDACTED: paths, feature names and property values removed.'
      : 'UNREDACTED: this bundle contains document paths, feature names and property values.',
    '',
  ];

  for (const section of sections) {
    lines.push(`## ${section.title}`);
    for (const row of section.rows) lines.push(`  ${row.label.padEnd(20)}${row.value}`);
    lines.push('');
  }

  lines.push('## Document');
  lines.push(`  path                ${redact ? redactPath(context?.docPath) : (context?.docPath ?? '')}`);
  lines.push(`  material            ${doc?.material ?? ''}`);
  if (geom) {
    lines.push(`  envelope            ${geom.L.toFixed(1)} x ${geom.W.toFixed(1)} x ${geom.T.toFixed(1)} mm`);
    lines.push(`  holes               ${geom.holes.length}`);
    lines.push(`  corner radius       ${geom.cornerR.toFixed(2)} mm`);
  }
  lines.push('');

  lines.push('## Feature tree');
  for (const [i, f] of (context?.features ?? []).entries()) {
    // The TYPE is what diagnoses a fault; the NAME is what leaks the design.
    const label = redact ? `feature_${i + 1}` : f.name;
    const flags = [
      f.suppressed ? 'suppressed' : null,
      f.underDefined ? 'under-defined' : null,
      f.fragileRef ? 'fragile-ref' : null,
      f.errorCode !== 0 ? `error:${f.errorCode}` : null,
    ].filter(Boolean);
    lines.push(`  ${String(i + 1).padStart(3)}. ${label.padEnd(24)}${f.type}${flags.length ? '  [' + flags.join(', ') + ']' : ''}`);
  }
  lines.push('');

  lines.push('## Global variables');
  for (const g of context?.globals ?? []) {
    // Values are geometry, not identity, and a units bug is invisible without them.
    lines.push(`  ${g.name.padEnd(20)}${g.value} ${g.units}`);
  }
  lines.push('');

  lines.push('## Custom properties');
  for (const [k, v] of Object.entries(context?.properties ?? {})) {
    lines.push(`  ${k.padEnd(20)}${redact ? '<redacted>' : v}`);
  }
  lines.push('');

  lines.push('## Recent errors');
  if (errors.length === 0) lines.push('  none recorded');
  else for (const e of errors.slice(-20)) lines.push(`  ${e}`);
  lines.push('');

  lines.push('## Notes');
  lines.push('  Generated locally. Nothing was transmitted; send this file yourself.');

  return lines.join('\r\n') + '\r\n';
}

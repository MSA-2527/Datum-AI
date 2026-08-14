import { beforeEach, describe, expect, it } from 'vitest';
import { buildSupportBundle, collect, redactPath, type DiagnosticsInput } from './diagnostics';
import { createFeature, toContext, type PartDoc } from './partModel';

/**
 * Diagnostics tests.
 *
 * The bundle exists to be sent to a stranger for debugging, so the assertions that matter
 * are the ones proving sensitive material does NOT survive redaction. A bundle a customer
 * is afraid to send is worth nothing, and one that leaks a client's project name is worse
 * than nothing.
 */

function doc(): PartDoc {
  return {
    path: 'D:\\Projects\\AcmeCorp\\Confidential\\bracket.SLDPRT',
    title: 'bracket.SLDPRT',
    configuration: 'Default',
    configurations: ['Default'],
    units: 'mm',
    material: '6061-T6',
    density: 2.7,
    writable: true,
    lastRebuildMs: 412,
    globals: [
      { name: 'Length', value: 100, units: 'mm' },
      { name: 'Width', value: 60, units: 'mm' },
      { name: 'Thickness', value: 8, units: 'mm' },
      { name: 'BoltCircle', value: 40, units: 'mm' },
    ],
    properties: { PartNo: 'ACME-SECRET-9910', Description: 'Classified actuator mount' },
    features: [],
  };
}

function input(d: PartDoc): DiagnosticsInput {
  return {
    doc: d,
    context: toContext(d, false),
    providers: [
      { id: 'local', model: 'qwen2.5-coder-14b', kind: 'Local', available: true, maxReliableOps: 8 },
    ],
    providerId: 'local',
    connected: false,
    demo: true,
    undoDepth: 3,
    redoDepth: 1,
    streamLength: 7,
  };
}

describe('collect', () => {
  beforeEach(() => localStorage.clear());

  it('returns every section', () => {
    const titles = collect(input(doc())).map((s) => s.title);
    expect(titles).toEqual(
      expect.arrayContaining(['Versions', 'Connection', 'Planner', 'Document', 'Session', 'Environment']),
    );
  });

  it('flags rebuild errors as bad and a clean model as ok', () => {
    let d = doc();
    d = { ...d, features: [{ id: 'f1', name: 'Boss', kind: 'plate', swType: 'Extrusion', suppressed: false, errorCode: 5, params: {} }] };

    const section = collect(input(d)).find((s) => s.title === 'Document')!;
    const errors = section.rows.find((r) => r.label === 'Rebuild errors')!;

    expect(errors.value).toBe('1');
    expect(errors.tone).toBe('bad');
  });

  it('reports the disconnected state honestly', () => {
    const section = collect(input(doc())).find((s) => s.title === 'Connection')!;
    const kernel = section.rows.find((r) => r.label === 'Kernel')!;

    // Standalone must not be dressed up as connected.
    expect(kernel.value).toContain('standalone');
    expect(kernel.tone).toBe('warn');
  });

  it('detects a working storage layer', () => {
    const section = collect(input(doc())).find((s) => s.title === 'Environment')!;
    expect(section.rows.find((r) => r.label === 'Storage')!.value).toContain('writable');
  });
});

describe('redactPath', () => {
  it('keeps the extension and depth but drops every name', () => {
    const out = redactPath('D:\\Projects\\AcmeCorp\\Confidential\\bracket.SLDPRT');

    // D:, Projects, AcmeCorp, Confidential, bracket.SLDPRT
    expect(out).toContain('.SLDPRT');
    expect(out).toContain('5 segments');
    expect(out).not.toContain('AcmeCorp');
    expect(out).not.toContain('bracket');
  });

  it('handles an empty path', () => {
    expect(redactPath(undefined)).toBe('');
  });
});

describe('support bundle', () => {
  beforeEach(() => localStorage.clear());

  it('redacts by default', () => {
    let d = doc();
    d = createFeature(d, 'holePattern', { diameter: 5 });

    const bundle = buildSupportBundle(input(d));

    // None of this may leave the customer's machine without a deliberate opt-in.
    expect(bundle).not.toContain('AcmeCorp');
    expect(bundle).not.toContain('Confidential');
    expect(bundle).not.toContain('ACME-SECRET-9910');
    expect(bundle).not.toContain('Classified actuator mount');
    expect(bundle).toContain('REDACTED');
  });

  it('keeps what actually diagnoses a fault', () => {
    let d = doc();
    d = createFeature(d, 'holePattern', { diameter: 5, boltCircleVar: 'BoltCircle' });
    d = createFeature(d, 'fillet', { radius: 4 });

    const bundle = buildSupportBundle(input(d));

    // Shape, counts and types survive; identity does not.
    expect(bundle).toContain('HoleWzd');
    expect(bundle).toContain('Fillet');
    expect(bundle).toContain('holes               4');
    expect(bundle).toContain('.SLDPRT');
    expect(bundle).toContain('6061-T6');
  });

  it('keeps global VALUES because a units bug is invisible without them', () => {
    const bundle = buildSupportBundle(input(doc()));
    expect(bundle).toContain('Length');
    expect(bundle).toContain('100');
  });

  it('replaces feature names with positional labels', () => {
    let d = doc();
    d = createFeature(d, 'fillet', { radius: 3 });
    d = { ...d, features: d.features.map((f) => ({ ...f, name: 'SecretProjectFillet' })) };

    const bundle = buildSupportBundle(input(d));

    expect(bundle).not.toContain('SecretProjectFillet');
    expect(bundle).toContain('feature_1');
  });

  it('includes identifiers only when explicitly asked, and says so', () => {
    const bundle = buildSupportBundle(input(doc()), [], { includeIdentifiers: true });

    expect(bundle).toContain('UNREDACTED');
    expect(bundle).toContain('AcmeCorp');
    expect(bundle).toContain('ACME-SECRET-9910');
  });

  it('carries recent errors', () => {
    const bundle = buildSupportBundle(input(doc()), ['COM error 0x80004005 in feature.fillet']);
    expect(bundle).toContain('0x80004005');
  });

  it('states that nothing was transmitted', () => {
    // The user has to know they are in control of sending it.
    expect(buildSupportBundle(input(doc()))).toContain('Nothing was transmitted');
  });

  it('survives a null document without throwing', () => {
    const empty: DiagnosticsInput = {
      doc: null, context: null, providers: [], providerId: '',
      connected: false, demo: false, undoDepth: 0, redoDepth: 0, streamLength: 0,
    };

    // Diagnostics are most needed when things are broken, so they must work with nothing
    // loaded — that is precisely the state a user reports a fault from.
    const bundle = buildSupportBundle(empty);
    expect(bundle).toContain('support bundle');
    expect(bundle).toContain('none recorded');
  });
});

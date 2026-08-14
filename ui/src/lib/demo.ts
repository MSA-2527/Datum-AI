import type { Plan, Provider, VerifyReport } from '../types';
import type { PartDoc } from './partModel';

/**
 * Offline document and sample plans.
 *
 * Used when no SOLIDWORKS seat is attached, so the whole application is operable and
 * demonstrable without one. Every surface still reports itself as offline — nothing
 * here is ever presented as live model state.
 */

export const demoProviders: Provider[] = [
  { id: 'local', model: 'qwen2.5-coder-14b-instruct', kind: 'Local', available: true, maxReliableOps: 8 },
  { id: 'byo-anthropic', model: 'claude-sonnet-5', kind: 'ByoKey', available: true, maxReliableOps: 200 },
  { id: 'pro', model: 'claude-opus-5', kind: 'Managed', available: true, maxReliableOps: 200 },
];

export function newDemoDoc(): PartDoc {
  return {
    path: 'D:\\Projects\\ACME\\bracket_v3.SLDPRT',
    title: 'bracket_v3.SLDPRT',
    configuration: 'Default',
    configurations: ['Default', 'Machined', 'Cast'],
    units: 'mm',
    material: '6061-T6 (SS)',
    density: 2.7,
    writable: true,
    lastRebuildMs: 412,
    globals: [
      { name: 'Length', value: 62, units: 'mm', equation: '62mm' },
      { name: 'Width', value: 40, units: 'mm', equation: '40mm' },
      { name: 'Thickness', value: 5, units: 'mm', equation: '5mm' },
      { name: 'BoltCircle', value: 31, units: 'mm', equation: '31mm' },
    ],
    properties: { PartNo: 'BRK-0142', Revision: 'B', Description: 'Motor mounting bracket' },
    features: [
      { id: 'f0', name: 'Annotations', kind: 'origin', swType: 'Annotations', suppressed: false, params: {} },
      { id: 'f1', name: 'Material <6061-T6>', kind: 'origin', swType: 'MaterialFolder', suppressed: false, params: {} },
      { id: 'f2', name: 'Front Plane', kind: 'origin', swType: 'RefPlane', suppressed: false, params: {} },
      { id: 'f3', name: 'Top Plane', kind: 'origin', swType: 'RefPlane', suppressed: false, params: {} },
      { id: 'f4', name: 'Right Plane', kind: 'origin', swType: 'RefPlane', suppressed: false, params: {} },
      {
        id: 'f5',
        name: 'Boss-Extrude1',
        kind: 'plate',
        swType: 'Extrusion',
        suppressed: false,
        pid: 'face-boss1',
        params: {},
      },
      {
        id: 'f6',
        name: 'Sketch1',
        kind: 'unknown',
        swType: 'ProfileFeature',
        suppressed: false,
        depth: 1,
        underDefined: true,
        params: {},
      },
      {
        id: 'f7',
        name: 'CutExtrude1',
        kind: 'slot',
        swType: 'Cut',
        suppressed: false,
        fragileRef: true,
        params: { width: 20, height: 8 },
      },
    ],
  };
}

/**
 * Sample plans keyed off the prompt. Deliberately three different shapes — a geometry
 * plan, a pure-metadata plan and a repair plan — so the demo exercises the deterministic
 * path and the linter path, not just the headline one.
 */
export function demoPlanFor(prompt: string): Plan {
  const p = prompt.toLowerCase();

  if (p.includes('propert') || p.includes('metadata') || p.includes('naming')) {
    return basePlan(prompt, {
      intent: 'Fills the empty custom properties from the ACME naming rules.',
      assumptions: [
        'Description taken from the part family in the folder name',
        'Revision left at B — DATUM never bumps a revision without being asked',
      ],
      ops: [
        {
          id: 'op1',
          op: 'doc.set_properties_bulk',
          target: { kind: 'Document', label: 'bracket_v3.SLDPRT' },
          params: {
            properties: {
              Material: '6061-T6',
              Finish: 'Anodised clear',
              Vendor: 'ACME Machining',
            },
          },
          resolved: { count: 1, pids: [], labels: ['document'], ok: true },
          estimatedMs: 150,
        },
      ],
      verify: [{ check: 'rebuild_errors', expect: 0 }],
    });
  }

  if (p.includes('fix') || p.includes('warning') || p.includes('health') || p.includes('repair')) {
    return basePlan(prompt, {
      intent: 'Repairs the two model-health warnings without changing geometry.',
      assumptions: [
        'Sketch1 is symmetric about the origin — inferred from its existing dimensions',
        'CutExtrude1 re-attaches to the Front Plane, the datum its face derives from',
      ],
      ops: [
        {
          id: 'op1',
          op: 'sketch.fully_define',
          target: { kind: 'Name', name: 'Sketch1', label: 'Sketch1' },
          params: {},
          resolved: { count: 1, pids: ['sketch1'], labels: ['Sketch1'], ok: true },
          estimatedMs: 250,
        },
        {
          id: 'op2',
          op: 'feature.edit.reattach_reference',
          dependsOn: ['op1'],
          target: { kind: 'Name', name: 'CutExtrude1', label: 'CutExtrude1' },
          params: { to: 'Front Plane' },
          resolved: { count: 1, pids: ['cut1'], labels: ['CutExtrude1'], ok: true },
          estimatedMs: 350,
        },
      ],
      verify: [
        { check: 'rebuild_errors', expect: 0 },
        { check: 'mass_delta_pct', max: 0.1 },
      ],
    });
  }

  return basePlan(prompt, {
    intent: 'Adds a NEMA 17 mounting pattern and R3 corner fillets to the selected face.',
    assumptions: [
      'M3 clearance holes, normal fit — NEMA 17 uses a 31 mm square bolt circle',
      'Hole positions driven by the BoltCircle global, so the pattern stays parametric',
      'R3 chosen to match the existing radius on Boss-Extrude1',
    ],
    ops: [
      {
        id: 'op1',
        op: 'feature.hole_wizard',
        target: { kind: 'Pid', pid: 'face-boss1', label: 'Face<1> of Boss-Extrude1' },
        params: {
          standard: 'ISO',
          fastener: 'M3',
          fit: 'normal',
          endCondition: 'through_all',
          units: 'mm',
        },
        resolved: { count: 1, pids: ['face-boss1'], labels: ['Face<1>'], ok: true },
        estimatedMs: 900,
      },
      {
        id: 'op2',
        op: 'feature.fillet',
        dependsOn: ['op1'],
        target: { kind: 'Query', query: 'edges(vertical, convex)', label: 'vertical convex edges' },
        params: { radius: 3, propagate: true, units: 'mm' },
        resolved: {
          count: 4,
          pids: ['edge0', 'edge1', 'edge2', 'edge3'],
          labels: [],
          ok: true,
        },
        estimatedMs: 400,
      },
    ],
    verify: [
      { check: 'rebuild_errors', expect: 0 },
      { check: 'mass_delta_pct', max: 15 },
    ],
  });
}

function basePlan(prompt: string, parts: Pick<Plan, 'intent' | 'assumptions' | 'ops' | 'verify'>): Plan {
  return {
    planId: 'pln_' + Math.random().toString(36).slice(2, 12),
    irVersion: '1.4',
    target: { docPath: 'D:\\Projects\\ACME\\bracket_v3.SLDPRT', configuration: 'Default' },
    undo: { groupName: 'DATUM: ' + prompt.slice(0, 48), snapshot: true },
    provenance: {
      providerId: 'local',
      modelId: 'qwen2.5-coder-14b-instruct',
      promptTokens: 2140,
      completionTokens: 386,
    },
    ...parts,
  };
}

export function buildReport(
  massBefore: number,
  massAfter: number,
  errorsBefore: number,
  errorsAfter: number,
  lintBefore: number,
  lintAfter: number,
  elapsedMs: number,
  maxDeltaPct: number,
): VerifyReport {
  const deltaPct =
    Math.abs(massBefore) < 1e-9 ? 0 : Math.abs((massAfter - massBefore) / massBefore) * 100;
  const massOk = deltaPct <= maxDeltaPct;
  const errorsOk = errorsAfter <= errorsBefore;

  return {
    passed: massOk && errorsOk,
    rolledBack: false,
    errorsBefore,
    errorsAfter,
    massBeforeG: massBefore,
    massAfterG: massAfter,
    interferences: 0,
    lintBefore,
    lintAfter,
    checks: [
      { check: 'rebuild_errors', ok: errorsOk, detail: `${errorsBefore} → ${errorsAfter}` },
      {
        check: 'mass_delta_pct',
        ok: massOk,
        detail: `${deltaPct.toFixed(1)}% (limit ${maxDeltaPct.toFixed(1)}%)`,
      },
    ],
    elapsedMs,
  };
}

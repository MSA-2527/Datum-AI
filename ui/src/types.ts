// Mirrors DATUM.Contracts. Kept hand-written rather than generated so the UI can
// tolerate an older kernel without a build step in between.

export type PlanMode = 'Ask' | 'Build' | 'Edit' | 'Batch';

export type TargetKind = 'Pid' | 'Selection' | 'Query' | 'Name' | 'Document';

export interface OpTarget {
  kind: TargetKind;
  pid?: string;
  pids?: string[];
  query?: string;
  name?: string;
  label?: string;
}

export interface ResolvedTarget {
  count: number;
  pids: string[];
  labels: string[];
  ok: boolean;
  problem?: string;
}

export interface Operation {
  id: string;
  op: string;
  dependsOn?: string[];
  target?: OpTarget;
  params?: Record<string, unknown>;
  resolved?: ResolvedTarget;
  estimatedMs?: number;
  note?: string;
}

export interface VerifyCheckSpec {
  check: string;
  expect?: unknown;
  max?: number;
  min?: number;
}

export interface Plan {
  planId: string;
  irVersion: string;
  target: { docPath: string; configuration?: string };
  intent: string;
  assumptions: string[];
  ops: Operation[];
  verify: VerifyCheckSpec[];
  undo: { groupName: string; snapshot: boolean };
  provenance?: {
    providerId: string;
    modelId: string;
    promptTokens: number;
    completionTokens: number;
  };
}

export interface VerifyResult {
  check: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyReport {
  passed: boolean;
  rolledBack: boolean;
  errorsBefore: number;
  errorsAfter: number;
  massBeforeG: number;
  massAfterG: number;
  interferences: number;
  lintBefore: number;
  lintAfter: number;
  checks: VerifyResult[];
  elapsedMs: number;
  snapshotId?: string;
}

export interface FeatureNode {
  id: number;
  name: string;
  type: string;
  depth: number;
  suppressed: boolean;
  errorCode: number;
  underDefined: boolean;
  fragileRef: boolean;
  createdByDatum: boolean;
  pid?: string;
}

export interface GlobalVar {
  name: string;
  value: number;
  units: string;
  equation?: string;
  readOnly: boolean;
  index: number;
}

export interface SelectionItem {
  type: string;
  label: string;
  pid?: string;
}

export interface PdmState {
  inVault: boolean;
  checkedOut: boolean;
  checkedOutBy?: string;
  version: number;
  state?: string;
}

export interface ModelContext {
  connected: boolean;
  swVersion: number;
  docPath?: string;
  docTitle?: string;
  docType?: string;
  configuration?: string;
  configurations: string[];
  units: string;
  writable: boolean;
  material?: string;
  features: FeatureNode[];
  globals: GlobalVar[];
  selection: SelectionItem[];
  properties: Record<string, string>;
  massG: number;
  bboxMm?: number[];
  rebuildErrors: number;
  rebuildWarnings: number;
  lastRebuildMs: number;
  pdm?: PdmState;
}

export interface Provider {
  id: string;
  model: string;
  kind: 'Local' | 'ByoKey' | 'Managed';
  available: boolean;
  maxReliableOps: number;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  opId: string;
  message: string;
}

export interface CapabilityMiss {
  error: string;
  exceededCapability: boolean;
  partialOps: number;
  totalOps: number;
  alternatives: { id: string; modelId: string; kind: string }[];
}

/** Delta kinds — must stay in step with Datum.Contracts.DeltaKind. */
export const DeltaKind = {
  ActiveDocChanged: 1,
  DocOpened: 2,
  DocClosed: 3,
  FeatureAdded: 4,
  FeatureDeleted: 5,
  FeatureRenamed: 6,
  FeatureSuppression: 7,
  RebuildDone: 8,
  RebuildFailed: 9,
  SelectionChanged: 10,
  DimensionChanged: 11,
  GlobalVarChanged: 12,
  ConfigChanged: 13,
  MassProperties: 14,
  LintFindings: 15,
  PdmState: 16,
  SaveDone: 17,
  ComponentState: 18,
  ViewChanged: 19,
  ErrorCount: 20,
} as const;

export interface WireDelta {
  k: number;
  doc: number;
  t: number;
  a: number;
  b: number;
  s?: string;
  ts: number;
}

export interface OpProgress {
  planId: string;
  opId: string;
  index: number;
  total: number;
  status: 'running' | 'done' | 'failed';
  elapsedMs: number;
}

// ── conversation stream ──────────────────────────────────────────────────────

export type StreamItem =
  | { kind: 'user'; id: string; text: string; refs: string[] }
  | { kind: 'plan'; id: string; plan: Plan; issues: ValidationIssue[]; state: PlanState }
  | { kind: 'result'; id: string; planId: string; report: VerifyReport }
  | { kind: 'capability'; id: string; miss: CapabilityMiss }
  | { kind: 'notice'; id: string; tone: 'info' | 'warn' | 'error'; title?: string; text: string };

export type PlanState = 'streaming' | 'resolving' | 'ready' | 'running' | 'failed';

export type Tab = 'chat' | 'tree' | 'params' | 'health';

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Datum.Contracts
{
    /// <summary>Command envelope sent Orchestrator -&gt; Kernel over the named pipe.</summary>
    public sealed class KernelCommand
    {
        [JsonPropertyName("id")] public string Id { get; set; } = Plan.NewId("cmd");
        [JsonPropertyName("verb")] public string Verb { get; set; } = "";
        [JsonPropertyName("body")] public JsonElement Body { get; set; }

        // Verbs. Kept as constants rather than an enum so a newer orchestrator talking to
        // an older kernel gets a clean "unknown verb" result instead of a deserialization crash.
        public const string GetContext = "context.get";
        public const string ResolvePlan = "plan.resolve";   // read-only: resolve PIDs + preconditions
        public const string DryRunPlan = "plan.dryrun";    // execute against a scratch copy
        public const string ApplyPlan = "plan.apply";     // the only mutating verb
        public const string CancelPlan = "plan.cancel";
        public const string Query = "query.run";
        public const string Highlight = "ui.highlight";     // preview: select entities in the viewport
        public const string ClearHighlight = "ui.clearHighlight";
        public const string SetParam = "param.set";       // fast path for slider drags
        public const string Rebuild = "doc.rebuild";
        public const string Snapshot = "doc.snapshot";
        public const string RestoreSnapshot = "doc.restoreSnapshot";
        public const string Undo = "doc.undo";
        public const string Lint = "lint.run";
        public const string Capabilities = "caps.get";
    }

    /// <summary>Result envelope sent Kernel -&gt; Orchestrator.</summary>
    public sealed class KernelResult
    {
        [JsonPropertyName("id")] public string Id { get; set; } = "";
        [JsonPropertyName("ok")] public bool Ok { get; set; }
        [JsonPropertyName("body")] public JsonElement Body { get; set; }
        [JsonPropertyName("error")] public KernelError? Error { get; set; }
        [JsonPropertyName("elapsedMs")] public long ElapsedMs { get; set; }

        public static KernelResult Fail(string id, string code, string message, string? detail = null) =>
            new KernelResult
            {
                Id = id,
                Ok = false,
                Error = new KernelError { Code = code, Message = message, Detail = detail }
            };
    }

    public sealed class KernelError
    {
        [JsonPropertyName("code")] public string Code { get; set; } = "";
        [JsonPropertyName("message")] public string Message { get; set; } = "";
        [JsonPropertyName("detail")] public string? Detail { get; set; }
        /// <summary>Op id that failed, when the error occurred inside a plan.</summary>
        [JsonPropertyName("opId")] public string? OpId { get; set; }
        /// <summary>True when the document was restored to its pre-plan state.</summary>
        [JsonPropertyName("rolledBack")] public bool RolledBack { get; set; }

        public const string NoDocument = "no_document";
        public const string NotWritable = "not_writable";
        public const string VaultLocked = "vault_locked";
        public const string PidUnresolved = "pid_unresolved";
        public const string PreconditionFailed = "precondition_failed";
        public const string UnknownOp = "unknown_op";
        public const string OpNotSupported = "op_not_supported";
        public const string ModeViolation = "mode_violation";
        public const string ComFailure = "com_failure";
        public const string VerifyFailed = "verify_failed";
        public const string Cancelled = "cancelled";
        public const string Busy = "busy";
    }

    /// <summary>Everything the planner needs about the live session (pipeline step 1).</summary>
    public sealed class ModelContext
    {
        [JsonPropertyName("connected")] public bool Connected { get; set; }
        [JsonPropertyName("swVersion")] public int SwVersion { get; set; }
        [JsonPropertyName("docPath")] public string? DocPath { get; set; }
        [JsonPropertyName("docTitle")] public string? DocTitle { get; set; }
        [JsonPropertyName("docType")] public string? DocType { get; set; }   // part | assembly | drawing
        [JsonPropertyName("configuration")] public string? Configuration { get; set; }
        [JsonPropertyName("configurations")] public List<string> Configurations { get; set; } = new List<string>();
        [JsonPropertyName("units")] public string Units { get; set; } = "mm";
        [JsonPropertyName("writable")] public bool Writable { get; set; }
        [JsonPropertyName("material")] public string? Material { get; set; }

        [JsonPropertyName("features")] public List<FeatureNode> Features { get; set; } = new List<FeatureNode>();
        [JsonPropertyName("globals")] public List<GlobalVar> Globals { get; set; } = new List<GlobalVar>();
        [JsonPropertyName("selection")] public List<SelectionItem> Selection { get; set; } = new List<SelectionItem>();
        [JsonPropertyName("properties")] public Dictionary<string, string> Properties { get; set; } = new Dictionary<string, string>();

        [JsonPropertyName("massG")] public double MassG { get; set; }
        [JsonPropertyName("bboxMm")] public double[]? BBoxMm { get; set; }
        [JsonPropertyName("rebuildErrors")] public int RebuildErrors { get; set; }
        [JsonPropertyName("rebuildWarnings")] public int RebuildWarnings { get; set; }
        [JsonPropertyName("lastRebuildMs")] public double LastRebuildMs { get; set; }

        [JsonPropertyName("pdm")] public PdmState? Pdm { get; set; }
    }

    public sealed class FeatureNode
    {
        [JsonPropertyName("id")] public int Id { get; set; }
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("type")] public string Type { get; set; } = "";
        [JsonPropertyName("depth")] public int Depth { get; set; }
        [JsonPropertyName("suppressed")] public bool Suppressed { get; set; }
        [JsonPropertyName("errorCode")] public int ErrorCode { get; set; }
        /// <summary>Set when a sketch is not fully defined — drives the linter badge.</summary>
        [JsonPropertyName("underDefined")] public bool UnderDefined { get; set; }
        /// <summary>Set when the feature is built on a model face rather than a datum.</summary>
        [JsonPropertyName("fragileRef")] public bool FragileRef { get; set; }
        [JsonPropertyName("createdByDatum")] public bool CreatedByDatum { get; set; }
        [JsonPropertyName("pid")] public string? Pid { get; set; }
    }

    public sealed class GlobalVar
    {
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("value")] public double Value { get; set; }
        [JsonPropertyName("units")] public string Units { get; set; } = "mm";
        [JsonPropertyName("equation")] public string? Equation { get; set; }
        [JsonPropertyName("readOnly")] public bool ReadOnly { get; set; }
        [JsonPropertyName("index")] public int Index { get; set; }
    }

    public sealed class SelectionItem
    {
        [JsonPropertyName("type")] public string Type { get; set; } = "";   // Face | Edge | Vertex | Feature | Component
        [JsonPropertyName("label")] public string Label { get; set; } = "";
        [JsonPropertyName("pid")] public string? Pid { get; set; }
    }

    public sealed class PdmState
    {
        [JsonPropertyName("inVault")] public bool InVault { get; set; }
        [JsonPropertyName("checkedOut")] public bool CheckedOut { get; set; }
        [JsonPropertyName("checkedOutBy")] public string? CheckedOutBy { get; set; }
        [JsonPropertyName("version")] public int Version { get; set; }
        [JsonPropertyName("state")] public string? State { get; set; }
    }

    /// <summary>Per-op progress, pushed during apply so the UI can fill the op-row bars.</summary>
    public sealed class OpProgress
    {
        [JsonPropertyName("planId")] public string PlanId { get; set; } = "";
        [JsonPropertyName("opId")] public string OpId { get; set; } = "";
        [JsonPropertyName("index")] public int Index { get; set; }
        [JsonPropertyName("total")] public int Total { get; set; }
        [JsonPropertyName("status")] public string Status { get; set; } = "";   // running | done | failed
        [JsonPropertyName("elapsedMs")] public long ElapsedMs { get; set; }
    }

    /// <summary>Post-apply evidence. This is what turns "the AI did something" into a measurable claim.</summary>
    public sealed class VerifyReport
    {
        [JsonPropertyName("passed")] public bool Passed { get; set; }
        [JsonPropertyName("rolledBack")] public bool RolledBack { get; set; }
        [JsonPropertyName("errorsBefore")] public int ErrorsBefore { get; set; }
        [JsonPropertyName("errorsAfter")] public int ErrorsAfter { get; set; }
        [JsonPropertyName("massBeforeG")] public double MassBeforeG { get; set; }
        [JsonPropertyName("massAfterG")] public double MassAfterG { get; set; }
        [JsonPropertyName("interferences")] public int Interferences { get; set; }
        [JsonPropertyName("lintBefore")] public int LintBefore { get; set; }
        [JsonPropertyName("lintAfter")] public int LintAfter { get; set; }
        [JsonPropertyName("checks")] public List<VerifyResult> Checks { get; set; } = new List<VerifyResult>();
        [JsonPropertyName("elapsedMs")] public long ElapsedMs { get; set; }
        [JsonPropertyName("snapshotId")] public string? SnapshotId { get; set; }

        public double MassDeltaPct =>
            Math.Abs(MassBeforeG) < 1e-9 ? 0 : (MassAfterG - MassBeforeG) / MassBeforeG * 100.0;
    }

    public sealed class VerifyResult
    {
        [JsonPropertyName("check")] public string Check { get; set; } = "";
        [JsonPropertyName("ok")] public bool Ok { get; set; }
        [JsonPropertyName("detail")] public string? Detail { get; set; }
    }

    /// <summary>Capability probe result — drives graceful degradation across SW 2022..2026.</summary>
    public sealed class Capabilities
    {
        [JsonPropertyName("swVersion")] public int SwVersion { get; set; }
        [JsonPropertyName("swBuild")] public string? SwBuild { get; set; }
        [JsonPropertyName("hasPdm")] public bool HasPdm { get; set; }
        [JsonPropertyName("supportedOps")] public List<string> SupportedOps { get; set; } = new List<string>();
        [JsonPropertyName("unsupportedOps")] public List<string> UnsupportedOps { get; set; } = new List<string>();
    }
}

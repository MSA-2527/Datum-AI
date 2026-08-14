using System;
using System.Collections.Generic;
using System.Linq;
using Datum.Contracts;

namespace Datum.Orchestrator.Planning;

public sealed record ValidationIssue(string Severity, string OpId, string Message);

public sealed record ValidationResult(bool Ok, IReadOnlyList<ValidationIssue> Issues)
{
    public bool HasErrors => Issues.Any(i => i.Severity == "error");
    public static ValidationResult Pass() => new(true, Array.Empty<ValidationIssue>());
}

/// <summary>
/// Pipeline step 3. Runs entirely in the orchestrator and makes no SOLIDWORKS calls —
/// a plan that fails here never reaches the CAD process at all.
///
/// This is the layer that enforces the invariants the model is not trusted to respect:
/// vocabulary membership, mode gating, acyclic dependencies, unit sanity, and policy.
/// </summary>
public sealed class PlanValidator
{
    private readonly Policy _policy;

    public PlanValidator(Policy policy) { _policy = policy; }

    public ValidationResult Validate(Plan plan, PlanMode mode, ModelContext context)
    {
        var issues = new List<ValidationIssue>();

        void Err(string opId, string msg) => issues.Add(new ValidationIssue("error", opId, msg));
        void Warn(string opId, string msg) => issues.Add(new ValidationIssue("warning", opId, msg));

        if (plan.IrVersion != Plan.CurrentIrVersion)
            Warn("", $"Plan targets IR {plan.IrVersion}; this build speaks {Plan.CurrentIrVersion}.");

        if (plan.Ops.Count == 0)
            Err("", "The plan contains no operations.");

        if (plan.Ops.Count > _policy.MaxOpsPerPlan)
            Err("", $"The plan has {plan.Ops.Count} operations; the limit is {_policy.MaxOpsPerPlan}.");

        // Dependency graph must be acyclic and fully resolvable.
        try { _ = plan.TopologicalOrder(); }
        catch (IrException ex) { Err("", ex.Message); }

        var seenIds = new HashSet<string>(StringComparer.Ordinal);

        foreach (var op in plan.Ops)
        {
            if (string.IsNullOrWhiteSpace(op.Id)) { Err("", "An operation has no id."); continue; }
            if (!seenIds.Add(op.Id)) Err(op.Id, "Duplicate operation id.");

            if (!OpCatalog.TryGet(op.Op, out var spec))
            {
                Err(op.Id, $"'{op.Op}' is not in the operation vocabulary.");
                continue;
            }

            if (!OpCatalog.AllowedInMode(op.Op, mode))
                Err(op.Id, $"'{op.Op}' is not permitted in {mode} mode.");

            if (context.SwVersion > 0 && !OpCatalog.SupportedBy(op.Op, context.SwVersion))
                Err(op.Id, $"'{op.Op}' requires SOLIDWORKS {spec.MinSwVersion} or newer (this seat is {context.SwVersion}).");

            // Script operations are the escape hatch, and carry the most friction by design.
            if (OpCatalog.IsScript(op.Op) && !_policy.AllowScriptOps)
                Err(op.Id, "Generated macros are disabled by policy on this machine.");

            if (OpCatalog.IsDestructive(op.Op) && !_policy.AllowDestructiveOps)
                Err(op.Id, $"'{op.Op}' removes data and destructive operations are disabled by policy.");

            // A mutating plan against a read-only document can never succeed; catching it
            // here means the user sees a clear reason instead of a COM failure later.
            if (!context.Writable && !OpCatalog.IsReadOnly(op.Op))
                Err(op.Id, "The document is read-only. Check it out of the vault before editing.");

            if (context.Pdm is { InVault: true, CheckedOut: false } && !OpCatalog.IsReadOnly(op.Op))
                Err(op.Id, context.Pdm.CheckedOutBy is { } who && who.Length > 0
                    ? $"The file is checked out by {who}."
                    : "The file is in a vault but not checked out to you.");

            ValidateTarget(op, issues);
            ValidateUnits(op, issues);
        }

        if (plan.Ops.Any(o => OpCatalog.IsDestructive(o.Op)) && !plan.Undo.Snapshot)
            Warn("", "This plan is destructive but does not request a snapshot; one will be taken anyway.");

        return new ValidationResult(!issues.Any(i => i.Severity == "error"), issues);
    }

    private static void ValidateTarget(Operation op, List<ValidationIssue> issues)
    {
        var t = op.Target;
        if (t == null) return;

        switch (t.Kind)
        {
            case TargetKind.Pid:
                if (string.IsNullOrEmpty(t.Pid) && (t.Pids == null || t.Pids.Count == 0))
                    issues.Add(new ValidationIssue("error", op.Id, "PID target carries no reference."));
                break;

            case TargetKind.Query:
                if (string.IsNullOrWhiteSpace(t.Query))
                    issues.Add(new ValidationIssue("error", op.Id, "Query target has no query."));
                break;

            case TargetKind.Name:
                // Not an error, but the linter flags name targets as fragile and the user
                // should see why in the plan card.
                issues.Add(new ValidationIssue("warning", op.Id,
                    $"Targets '{t.Name}' by name. Names break on rename; PIDs do not."));
                break;
        }
    }

    /// <summary>
    /// Unit sanity. A plan asking for a 5000 mm fillet on a 60 mm part is a units bug,
    /// and catching it before execution is far cheaper than a failed rebuild.
    /// </summary>
    private static void ValidateUnits(Operation op, List<ValidationIssue> issues)
    {
        if (op.Params.ValueKind != System.Text.Json.JsonValueKind.Object) return;

        foreach (var key in new[] { "radius", "distance", "thickness", "depth", "spacing", "diameter" })
        {
            if (!op.Params.TryGetProperty(key, out var v)) continue;
            if (v.ValueKind != System.Text.Json.JsonValueKind.Number) continue;

            double mm = v.GetDouble();
            if (mm <= 0)
                issues.Add(new ValidationIssue("error", op.Id, $"'{key}' must be positive (got {mm})."));
            else if (mm > 10000)
                issues.Add(new ValidationIssue("warning", op.Id,
                    $"'{key}' is {mm} mm — check the units, that is over 10 metres."));
        }
    }
}

/// <summary>
/// Machine policy. Admin-set values are locked and cannot be overridden by the user,
/// which is what makes the enterprise story credible.
/// </summary>
public sealed class Policy
{
    public int MaxOpsPerPlan { get; init; } = 500;
    public bool AllowScriptOps { get; init; } = false;
    public bool AllowDestructiveOps { get; init; } = true;
    public bool AllowCloudProviders { get; init; } = true;
    public int FreeTierBatchCap { get; init; } = 25;
    public bool RequirePreviewAlways { get; init; } = false;
}

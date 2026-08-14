using System.Text.Json;
using Datum.Orchestrator.Planning;

namespace Datum.Tests;

/// <summary>
/// Pipeline step 3. Everything asserted here is a reason a plan never reaches
/// SLDWORKS.exe at all — the cheapest possible place to stop a bad plan, and the only
/// place that works when SOLIDWORKS is not even running.
/// </summary>
public sealed class PlanValidatorTests
{
    private static ModelContext Context(
        bool writable = true, int swVersion = 2026, PdmState? pdm = null) => new()
    {
        Connected = true,
        SwVersion = swVersion,
        DocPath = @"C:\parts\bracket.sldprt",
        DocType = "part",
        Writable = writable,
        Pdm = pdm
    };

    private static Plan PlanOf(params Operation[] ops)
    {
        var p = new Plan { Intent = "test" };
        p.Ops.AddRange(ops);
        return p;
    }

    private static Operation Op(string id, string op, object? @params = null, OpTarget? target = null) => new()
    {
        Id = id,
        Op = op,
        Target = target,
        Params = JsonSerializer.SerializeToElement(@params ?? new { })
    };

    private static PlanValidator Validator(Policy? policy = null) => new(policy ?? new Policy());

    private static IEnumerable<string> Errors(ValidationResult r) =>
        r.Issues.Where(i => i.Severity == "error").Select(i => i.Message);

    // ── the happy path ───────────────────────────────────────────────────────────

    [Fact]
    public void AWellFormedEditPlanPasses()
    {
        var plan = PlanOf(Op("a", "param.set_global", new { name = "Length", value = 62.0 }));

        var result = Validator().Validate(plan, PlanMode.Edit, Context());

        Assert.True(result.Ok, string.Join("; ", Errors(result)));
        Assert.False(result.HasErrors);
    }

    // ── vocabulary and mode ──────────────────────────────────────────────────────

    [Fact]
    public void AnOperationOutsideTheVocabularyIsRejected()
    {
        var plan = PlanOf(Op("a", "feature.improvise"));

        var result = Validator().Validate(plan, PlanMode.Build, Context());

        Assert.False(result.Ok);
        Assert.Contains(Errors(result), m => m.Contains("vocabulary", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void AskModeRejectsAnythingThatCouldMutateTheModel()
    {
        var plan = PlanOf(
            Op("read", "query.mass_properties"),
            Op("write", "param.set_global", new { name = "Length", value = 1.0 }));

        var result = Validator().Validate(plan, PlanMode.Ask, Context());

        Assert.False(result.Ok);
        Assert.Contains(Errors(result), m => m.Contains("not permitted in Ask mode"));
    }

    [Fact]
    public void AskModeAcceptsAPurelyInterrogativePlan()
    {
        var plan = PlanOf(Op("a", "query.mass_properties"), Op("b", "query.list_features"));

        Assert.True(Validator().Validate(plan, PlanMode.Ask, Context()).Ok);
    }

    [Fact]
    public void AnOperationNewerThanTheSeatIsRejectedWithTheVersionInTheMessage()
    {
        var plan = PlanOf(Op("a", "config.family_table_update"));

        var result = Validator().Validate(plan, PlanMode.Edit, Context(swVersion: 2024));

        Assert.False(result.Ok);
        Assert.Contains(Errors(result), m => m.Contains("2026") && m.Contains("2024"));
    }

    [Fact]
    public void AnUnknownSeatVersionDoesNotBlockThePlan()
    {
        // SwVersion 0 means "we could not read it". Guessing would fail plans on a
        // perfectly capable seat.
        var plan = PlanOf(Op("a", "config.family_table_update"));

        Assert.True(Validator().Validate(plan, PlanMode.Edit, Context(swVersion: 0)).Ok);
    }

    // ── structure ────────────────────────────────────────────────────────────────

    [Fact]
    public void AnEmptyPlanIsAnError()
    {
        var result = Validator().Validate(PlanOf(), PlanMode.Edit, Context());

        Assert.False(result.Ok);
        Assert.Contains(Errors(result), m => m.Contains("no operations"));
    }

    [Fact]
    public void ACyclicPlanIsRejectedBeforeItReachesTheKernel()
    {
        var a = Op("a", "sketch.create");
        var b = Op("b", "feature.extrude");
        a.DependsOn = new List<string> { "b" };
        b.DependsOn = new List<string> { "a" };

        var result = Validator().Validate(PlanOf(a, b), PlanMode.Build, Context());

        Assert.False(result.Ok);
        Assert.Contains(Errors(result), m => m.Contains("Cyclic", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void DuplicateOperationIdsAreRejected()
    {
        var result = Validator().Validate(
            PlanOf(Op("a", "sketch.create"), Op("a", "sketch.circle")), PlanMode.Build, Context());

        Assert.False(result.Ok);
        Assert.Contains(Errors(result), m => m.Contains("Duplicate", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void APlanLongerThanPolicyAllowsIsRejected()
    {
        var ops = Enumerable.Range(0, 12).Select(i => Op($"op{i}", "sketch.line")).ToArray();

        var result = Validator(new Policy { MaxOpsPerPlan = 10 }).Validate(PlanOf(ops), PlanMode.Build, Context());

        Assert.False(result.Ok);
        Assert.Contains(Errors(result), m => m.Contains("12") && m.Contains("10"));
    }

    [Fact]
    public void APlanFromAFutureIrVersionWarnsButStillRuns()
    {
        var plan = PlanOf(Op("a", "param.set_global", new { name = "L", value = 1.0 }));
        plan.IrVersion = "99.0";

        var result = Validator().Validate(plan, PlanMode.Edit, Context());

        Assert.True(result.Ok);
        Assert.Contains(result.Issues, i => i.Severity == "warning" && i.Message.Contains("99.0"));
    }

    // ── targets ──────────────────────────────────────────────────────────────────

    [Fact]
    public void APidTargetCarryingNoReferenceIsRejected()
    {
        var plan = PlanOf(Op("a", "feature.fillet", new { radius = 3.0 },
            new OpTarget { Kind = TargetKind.Pid }));

        var result = Validator().Validate(plan, PlanMode.Edit, Context());

        Assert.False(result.Ok);
        Assert.Contains(Errors(result), m => m.Contains("no reference"));
    }

    [Fact]
    public void AnEmptyQueryTargetIsRejected()
    {
        var plan = PlanOf(Op("a", "feature.fillet", new { radius = 3.0 },
            new OpTarget { Kind = TargetKind.Query, Query = "   " }));

        Assert.False(Validator().Validate(plan, PlanMode.Edit, Context()).Ok);
    }

    [Fact]
    public void TargetingByNameIsAllowedButFlaggedFragile()
    {
        var plan = PlanOf(Op("a", "feature.edit.suppress", null,
            new OpTarget { Kind = TargetKind.Name, Name = "Fillet1" }));

        var result = Validator().Validate(plan, PlanMode.Edit, Context());

        Assert.True(result.Ok);
        Assert.Contains(result.Issues, i => i.Severity == "warning" && i.Message.Contains("Fillet1"));
    }

    // ── units ────────────────────────────────────────────────────────────────────

    [Theory]
    [InlineData(0.0)]
    [InlineData(-3.0)]
    public void ANonPositiveLengthIsRejected(double radius)
    {
        var plan = PlanOf(Op("a", "feature.fillet", new { radius }));

        var result = Validator().Validate(plan, PlanMode.Edit, Context());

        Assert.False(result.Ok);
        Assert.Contains(Errors(result), m => m.Contains("must be positive"));
    }

    [Fact]
    public void AMetreScaleLengthWarnsAboutUnitsWithoutBlockingTheUser()
    {
        // Someone genuinely modelling a 15 m weldment should not be stopped; someone who
        // meant 15 mm should be told.
        var plan = PlanOf(Op("a", "feature.extrude", new { distance = 15000.0 }));

        var result = Validator().Validate(plan, PlanMode.Build, Context());

        Assert.True(result.Ok);
        Assert.Contains(result.Issues, i => i.Severity == "warning" && i.Message.Contains("metres"));
    }

    [Fact]
    public void NonNumericAndAbsentDimensionsAreLeftAlone()
    {
        var plan = PlanOf(
            Op("a", "feature.fillet", new { radius = "3mm" }),
            Op("b", "doc.rebuild"));

        Assert.True(Validator().Validate(plan, PlanMode.Edit, Context()).Ok);
    }

    // ── document and vault state ─────────────────────────────────────────────────

    [Fact]
    public void AReadOnlyDocumentBlocksMutationButNotInterrogation()
    {
        var mutating = PlanOf(Op("a", "param.set_global", new { name = "L", value = 1.0 }));
        var reading = PlanOf(Op("a", "query.mass_properties"));

        Assert.False(Validator().Validate(mutating, PlanMode.Edit, Context(writable: false)).Ok);
        Assert.True(Validator().Validate(reading, PlanMode.Ask, Context(writable: false)).Ok);
    }

    [Fact]
    public void AVaultedFileCheckedOutBySomeoneElseNamesThem()
    {
        var pdm = new PdmState { InVault = true, CheckedOut = false, CheckedOutBy = "j.okafor" };
        var plan = PlanOf(Op("a", "param.set_global", new { name = "L", value = 1.0 }));

        var result = Validator().Validate(plan, PlanMode.Edit, Context(pdm: pdm));

        Assert.False(result.Ok);
        Assert.Contains(Errors(result), m => m.Contains("j.okafor"));
    }

    [Fact]
    public void AVaultedFileCheckedOutToMeIsFine()
    {
        var pdm = new PdmState { InVault = true, CheckedOut = true };
        var plan = PlanOf(Op("a", "param.set_global", new { name = "L", value = 1.0 }));

        Assert.True(Validator().Validate(plan, PlanMode.Edit, Context(pdm: pdm)).Ok);
    }

    // ── policy ───────────────────────────────────────────────────────────────────

    [Fact]
    public void GeneratedMacrosAreOffByDefaultAndSayWhy()
    {
        var plan = PlanOf(Op("a", "script.macro", new { code = "Sub main()" }));

        var result = Validator().Validate(plan, PlanMode.Build, Context());

        Assert.False(result.Ok);
        Assert.Contains(Errors(result), m => m.Contains("policy"));
    }

    [Fact]
    public void DestructiveOperationsCanBeDisabledByPolicy()
    {
        var plan = PlanOf(Op("a", "feature.edit.delete", null,
            new OpTarget { Kind = TargetKind.Pid, Pid = "AAAA" }));

        var locked = new Policy { AllowDestructiveOps = false };

        Assert.False(Validator(locked).Validate(plan, PlanMode.Edit, Context()).Ok);
        Assert.True(Validator().Validate(plan, PlanMode.Edit, Context()).Ok);
    }

    [Fact]
    public void ADestructivePlanWithoutASnapshotWarnsThatOneIsTakenAnyway()
    {
        var plan = PlanOf(Op("a", "feature.edit.delete", null,
            new OpTarget { Kind = TargetKind.Pid, Pid = "AAAA" }));
        plan.Undo.Snapshot = false;

        var result = Validator().Validate(plan, PlanMode.Edit, Context());

        Assert.True(result.Ok);
        Assert.Contains(result.Issues, i => i.Severity == "warning" && i.Message.Contains("snapshot"));
    }

    [Fact]
    public void PolicyDefaultsMatchTheShippedFreeTier()
    {
        var p = new Policy();

        Assert.Equal(500, p.MaxOpsPerPlan);
        Assert.False(p.AllowScriptOps);
        Assert.True(p.AllowDestructiveOps);
        Assert.Equal(25, p.FreeTierBatchCap);
    }
}

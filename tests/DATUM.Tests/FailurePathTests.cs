using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Datum.Orchestrator.Planning;
using Datum.Orchestrator.Storage;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;

namespace Datum.Tests;

/// <summary>
/// Failure-path tests (spec §19.5).
///
/// Happy-path tests prove the product works. These prove it fails *safely*, which is the
/// harder and more important property: a CAD automation tool is judged on what it does on
/// its worst day, not its best. Every case here asks the same question — when this goes
/// wrong, does the customer's model survive and does the user find out?
/// </summary>
public sealed class ValidationFailureTests
{
    private static ModelContext Context(bool writable = true, PdmState? pdm = null) => new()
    {
        Connected = true,
        SwVersion = 2026,
        DocPath = @"C:\parts\bracket.SLDPRT",
        Writable = writable,
        Pdm = pdm,
    };

    private static Plan PlanWith(params Operation[] ops)
    {
        var p = new Plan { Intent = "test" };
        p.Ops.AddRange(ops);
        return p;
    }

    private static Operation Op(string name, string id = "op1") => new() { Id = id, Op = name };

    [Fact]
    public void ReadOnlyDocumentBlocksEveryMutatingOperation()
    {
        var v = new PlanValidator(new Policy());
        var result = v.Validate(PlanWith(Op("feature.fillet")), PlanMode.Edit, Context(writable: false));

        // Catching this before dispatch means the user sees "check it out" rather than a
        // COM failure surfacing minutes later from inside the kernel.
        Assert.False(result.Ok);
        Assert.Contains(result.Issues, i => i.Message.Contains("read-only", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ReadOnlyDocumentStillAllowsQueries()
    {
        var v = new PlanValidator(new Policy());
        var result = v.Validate(PlanWith(Op("query.mass_properties")), PlanMode.Ask, Context(writable: false));

        // Read-only must not mean useless. Asking questions about a locked file is fine.
        Assert.True(result.Ok);
    }

    [Fact]
    public void FileCheckedOutBySomeoneElseIsRefusedByName()
    {
        var pdm = new PdmState { InVault = true, CheckedOut = false, CheckedOutBy = "j.diaz" };
        var v = new PlanValidator(new Policy());
        var result = v.Validate(PlanWith(Op("feature.fillet")), PlanMode.Edit, Context(pdm: pdm));

        Assert.False(result.Ok);
        // Naming the holder is the difference between an actionable message and a dead end.
        Assert.Contains(result.Issues, i => i.Message.Contains("j.diaz", StringComparison.Ordinal));
    }

    [Fact]
    public void AskModeCannotMutate()
    {
        var v = new PlanValidator(new Policy());
        var result = v.Validate(PlanWith(Op("feature.edit.delete")), PlanMode.Ask, Context());

        // Mode is a safety control, not a UI hint.
        Assert.False(result.Ok);
    }

    [Fact]
    public void UnknownOperationIsRejected()
    {
        var v = new PlanValidator(new Policy());
        var result = v.Validate(PlanWith(Op("feature.teleport")), PlanMode.Build, Context());

        // A model that invents an operation must be stopped at the vocabulary boundary.
        Assert.False(result.Ok);
        Assert.Contains(result.Issues, i => i.Message.Contains("vocabulary", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void CyclicDependenciesAreCaughtBeforeExecution()
    {
        var plan = PlanWith(
            new Operation { Id = "a", Op = "feature.fillet", DependsOn = new() { "b" } },
            new Operation { Id = "b", Op = "feature.chamfer", DependsOn = new() { "a" } });

        var result = new PlanValidator(new Policy()).Validate(plan, PlanMode.Build, Context());
        Assert.False(result.Ok);
    }

    [Fact]
    public void DuplicateOperationIdsAreRejected()
    {
        var result = new PlanValidator(new Policy())
            .Validate(PlanWith(Op("feature.fillet", "op1"), Op("feature.chamfer", "op1")),
                      PlanMode.Build, Context());

        // Duplicate ids would make progress reporting and rollback ambiguous.
        Assert.False(result.Ok);
    }

    [Fact]
    public void ScriptOperationsAreBlockedByDefaultPolicy()
    {
        var result = new PlanValidator(new Policy())
            .Validate(PlanWith(Op("script.macro")), PlanMode.Build, Context());

        // The escape hatch is off unless a policy explicitly enables it.
        Assert.False(result.Ok);
    }

    [Fact]
    public void ImplausibleUnitsAreFlagged()
    {
        var op = new Operation
        {
            Id = "op1",
            Op = "feature.fillet",
            Params = JsonSerializer.SerializeToElement(new { radius = 50_000.0 }),
        };

        var result = new PlanValidator(new Policy()).Validate(PlanWith(op), PlanMode.Build, Context());

        // A 50-metre fillet is a units bug. Catching it here is far cheaper than a failed
        // rebuild, and it is the single most common class of generated-plan error.
        Assert.Contains(result.Issues, i => i.Message.Contains("units", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void NegativeDimensionsAreRejected()
    {
        var op = new Operation
        {
            Id = "op1",
            Op = "feature.fillet",
            Params = JsonSerializer.SerializeToElement(new { radius = -3.0 }),
        };

        var result = new PlanValidator(new Policy()).Validate(PlanWith(op), PlanMode.Build, Context());
        Assert.False(result.Ok);
    }

    [Fact]
    public void OversizedPlansAreRefused()
    {
        var plan = new Plan { Intent = "runaway" };
        for (int i = 0; i < 600; i++) plan.Ops.Add(Op("feature.fillet", $"op{i}"));

        var result = new PlanValidator(new Policy { MaxOpsPerPlan = 500 })
            .Validate(plan, PlanMode.Build, Context());

        Assert.False(result.Ok);
    }

    [Fact]
    public void OperationsNewerThanTheSeatAreRefused()
    {
        var ctx = Context();
        ctx.SwVersion = 2022;

        // family_table_update needs SOLIDWORKS 2026. Dispatching it to a 2022 seat would
        // be a COM exception with no useful message.
        var result = new PlanValidator(new Policy())
            .Validate(PlanWith(Op("config.family_table_update")), PlanMode.Build, ctx);

        Assert.False(result.Ok);
    }
}

/// <summary>
/// Recovery-path failures: what happens when the safety net itself is under stress.
/// </summary>
public sealed class RecoveryFailureTests : IDisposable
{
    private readonly string _root;
    private readonly string _dbPath;
    private readonly string _blobs;

    public RecoveryFailureTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "datum-fail", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
        _dbPath = Path.Combine(_root, "t.db");
        _blobs = Path.Combine(_root, "blobs");
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_root, recursive: true); } catch { }
    }

    private async Task<CheckpointService> ServiceAsync()
    {
        await new Store(NullLogger<Store>.Instance, _dbPath).InitialiseAsync();
        return new CheckpointService(_blobs, async () =>
        {
            var db = new SqliteConnection($"Data Source={_dbPath}");
            await db.OpenAsync();
            return db;
        }, NullLogger.Instance);
    }

    [Fact]
    public async Task RestoringAnUnknownCheckpointFailsRatherThanThrowing()
    {
        var svc = await ServiceAsync();
        // The UI calls this from a button. An exception here would surface as a crash
        // rather than "that checkpoint is gone".
        Assert.False(await svc.RestoreAsync("does-not-exist"));
    }

    [Fact]
    public async Task CheckpointOfALockedFileStillSucceeds()
    {
        var svc = await ServiceAsync();
        string doc = Path.Combine(_root, "open.SLDPRT");
        await File.WriteAllTextAsync(doc, "CONTENT");

        // SOLIDWORKS holds its documents open. Reading with FileShare.ReadWrite is what
        // makes checkpointing a live document possible at all.
        await using var holder = new FileStream(doc, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);

        var cp = await svc.CaptureAsync(doc, null);
        Assert.NotNull(cp);
    }

    [Fact]
    public async Task ListingCheckpointsForAnUnknownDocumentReturnsEmpty()
    {
        var svc = await ServiceAsync();
        Assert.Empty(await svc.ListAsync(@"C:\never\seen.SLDPRT"));
    }

    [Fact]
    public async Task PruneOnAnEmptyStoreIsHarmless()
    {
        var svc = await ServiceAsync();
        Assert.Equal(0, await svc.PruneAsync());
    }
}

/// <summary>
/// Provider-path failures. The planner is the least reliable component in the system by
/// construction, so its failure modes must be ordinary rather than exceptional.
/// </summary>
public sealed class ProviderFailureTests
{
    private static PlanRequest Request(string prompt = "fillet") =>
        new(prompt, PlanMode.Edit, new ModelContext { DocPath = @"C:\p.SLDPRT" }, Array.Empty<string>());

    [Fact]
    public async Task MalformedProviderOutputIsReportedNotThrown()
    {
        var provider = new MockPlanProvider
        {
            ForcedOutcome = new PlanOutcome(null, false, "The planner returned an unparseable plan."),
        };

        var outcome = await provider.PlanAsync(Request(), CancellationToken.None);

        Assert.False(outcome.Ok);
        Assert.Null(outcome.Plan);
    }

    [Fact]
    public async Task CapabilityOverrunIsSurfacedWithThePartialResult()
    {
        var partial = new Plan { Intent = "too big" };
        partial.Ops.Add(new Operation { Id = "op1", Op = "feature.fillet" });

        var provider = new MockPlanProvider
        {
            ForcedOutcome = new PlanOutcome(partial, false, "Beyond the local model.",
                ExceededCapability: true, PartialOps: 6, TotalOps: 14),
        };

        var outcome = await provider.PlanAsync(Request(), CancellationToken.None);

        // Attempted-and-honest beats blocked-and-silent: the user is told what it managed
        // and offered the partial result, rather than just being refused.
        Assert.True(outcome.ExceededCapability);
        Assert.Equal(6, outcome.PartialOps);
        Assert.NotNull(outcome.Plan);
    }

    [Fact]
    public async Task UnavailableProviderDoesNotStallTheRouter()
    {
        var router = new ProviderRouter(NullLogger<ProviderRouter>.Instance);
        router.Register(new MockPlanProvider { IsAvailable = false });

        var outcome = await router.PlanAsync(Request(), CancellationToken.None);

        Assert.False(outcome.Ok);
        Assert.NotNull(outcome.Error);
    }

    [Fact]
    public async Task AzureProviderReportsMissingConfigurationInsteadOfCallingOut()
    {
        var provider = new AzureOpenAiProvider(
            endpoint: "", deployment: "gpt-4o", apiKey: null,
            http: new System.Net.Http.HttpClient(), log: NullLogger.Instance);

        Assert.False(provider.IsAvailable);

        var outcome = await provider.PlanAsync(Request(), CancellationToken.None);
        Assert.False(outcome.Ok);
        Assert.Contains("not configured", outcome.Error!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task CancellationPropagates()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        // Esc must actually stop work, not just hide the spinner.
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => new MockPlanProvider().PlanAsync(Request(), cts.Token));
    }
}

/// <summary>
/// Transport failures. The kernel lives in another process that can vanish at any moment.
/// </summary>
public sealed class TransportFailureTests
{
    [Fact]
    public async Task CallingADisconnectedKernelReturnsAnErrorRatherThanHanging()
    {
        var hub = new Datum.Orchestrator.Transport.SessionHub(
            NullLogger<Datum.Orchestrator.Transport.SessionHub>.Instance);

        var gateway = new Datum.Orchestrator.Transport.KernelGateway(
            hub,
            Microsoft.Extensions.Logging.Abstractions.NullLoggerFactory.Instance,
            NullLogger<Datum.Orchestrator.Transport.KernelGateway>.Instance);

        // No Start(), so nothing is tracked — the same state as SOLIDWORKS not running.
        var result = await gateway.CallAsync(new KernelCommand { Verb = KernelCommand.GetContext });

        Assert.False(result.Ok);
        Assert.Equal("disconnected", result.Error!.Code);

        // The message must point at what still works offline rather than dead-ending.
        Assert.Contains("Skills", result.Error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void MalformedFrameHeaderIsRejected()
    {
        // A corrupt length prefix must not be trusted into a multi-gigabyte allocation.
        var header = new byte[FrameCodec.HeaderSize];
        BitConverter.GetBytes(uint.MaxValue).CopyTo(header, 0);

        Assert.False(FrameCodec.TryReadHeader(header, out _, out _));
    }

    [Fact]
    public void TruncatedFrameHeaderIsRejected()
    {
        Assert.False(FrameCodec.TryReadHeader(new byte[2], out _, out _));
    }

    [Fact]
    public void OverLongDeltaTextIsTruncatedNotOverflowed()
    {
        // A pathological feature name must not overrun the encoder's scratch buffer.
        var delta = new StateDelta
        {
            Kind = DeltaKind.FeatureAdded,
            DocId = 1,
            Text = new string('x', 5000),
        };

        var buffer = new byte[DeltaCodec.MaxBatchSize(1)];
        int written = DeltaCodec.Write(buffer, new[] { delta });

        Assert.True(written > 0);
        var decoded = DeltaCodec.Read(new ReadOnlySpan<byte>(buffer, 0, written));
        Assert.Single(decoded);
        Assert.True(decoded[0].Text!.Length <= DeltaCodec.MaxTextBytes);
    }
}

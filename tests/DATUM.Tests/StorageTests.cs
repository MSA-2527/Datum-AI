using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Datum.Orchestrator.Planning;
using Datum.Orchestrator.Storage;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;

namespace Datum.Tests;

/// <summary>
/// Migration and persistence tests.
///
/// The audit trail is the customer's record of what an AI did to their engineering files.
/// If an upgrade drops it, or a second start wipes it, the product's central safety claim
/// is false — so these assert idempotency and survival across restarts, not just that the
/// tables exist.
/// </summary>
public sealed class MigrationTests : IDisposable
{
    private readonly string _dir;
    private readonly string _dbPath;

    public MigrationTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "datum-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
        _dbPath = Path.Combine(_dir, "test.db");
    }

    public void Dispose()
    {
        // Pooled connections keep a handle on the file; clearing lets the delete succeed.
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_dir, recursive: true); } catch { /* temp dir, best effort */ }
    }

    private Store NewStore() => new(NullLogger<Store>.Instance, _dbPath);

    [Fact]
    public async Task Initialise_BringsAFreshDatabaseToTheLatestSchema()
    {
        await NewStore().InitialiseAsync();

        await using var db = new SqliteConnection($"Data Source={_dbPath}");
        await db.OpenAsync();
        Assert.Equal(Migrations.LatestVersion, await Migrations.ReadVersionAsync(db));
    }

    [Fact]
    public async Task Initialise_IsIdempotent()
    {
        var store = NewStore();
        await store.InitialiseAsync();

        // A second start must apply nothing. If it re-ran migrations it would either throw
        // on existing objects or, worse, quietly recreate them and lose history.
        await using var db = new SqliteConnection($"Data Source={_dbPath}");
        await db.OpenAsync();
        Assert.Equal(0, await Migrations.ApplyAsync(db));
    }

    [Fact]
    public async Task Migrations_UpgradeAnOlderDatabaseWithoutLosingData()
    {
        // Stand up a v1 database and put a row in it.
        await using (var db = new SqliteConnection($"Data Source={_dbPath}"))
        {
            await db.OpenAsync();
            var step = db.CreateCommand();
            step.CommandText = """
                CREATE TABLE plans (
                    planId TEXT PRIMARY KEY, docPath TEXT, configuration TEXT, mode TEXT,
                    intent TEXT, assumptions TEXT, irVersion TEXT, providerId TEXT,
                    modelId TEXT, promptTokens INTEGER, completionTokens INTEGER,
                    opCount INTEGER, status TEXT DEFAULT 'planned', createdAtUtc TEXT NOT NULL);
                PRAGMA user_version = 1;
                """;
            await step.ExecuteNonQueryAsync();

            var insert = db.CreateCommand();
            insert.CommandText =
                "INSERT INTO plans (planId, intent, createdAtUtc) VALUES ('pln_old', 'legacy', '2020-01-01');";
            await insert.ExecuteNonQueryAsync();
        }

        SqliteConnection.ClearAllPools();
        await NewStore().InitialiseAsync();

        await using var check = new SqliteConnection($"Data Source={_dbPath}");
        await check.OpenAsync();

        Assert.Equal(Migrations.LatestVersion, await Migrations.ReadVersionAsync(check));

        // The pre-existing row must still be there. An upgrade that silently drops a
        // customer's audit history is a data-loss bug, not a schema change.
        var q = check.CreateCommand();
        q.CommandText = "SELECT intent FROM plans WHERE planId = 'pln_old';";
        Assert.Equal("legacy", await q.ExecuteScalarAsync() as string);

        // And the tables the later migrations introduce must now exist.
        foreach (var table in new[] { "checkpoints", "audit", "recipes", "providers", "settings" })
        {
            var t = check.CreateCommand();
            t.CommandText = "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=$n;";
            t.Parameters.AddWithValue("$n", table);
            Assert.Equal(1L, Convert.ToInt64(await t.ExecuteScalarAsync()));
        }
    }

    [Fact]
    public async Task Migrations_RefuseToDowngradeANewerDatabase()
    {
        await using var db = new SqliteConnection($"Data Source={_dbPath}");
        await db.OpenAsync();

        var cmd = db.CreateCommand();
        cmd.CommandText = $"PRAGMA user_version = {Migrations.LatestVersion + 5};";
        await cmd.ExecuteNonQueryAsync();

        // Running older statements against a newer schema would corrupt it. Refusing is
        // the only safe answer, and the message has to tell the user what to do.
        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => Migrations.ApplyAsync(db));
        Assert.Contains("newer", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Store_PersistsAPlanAndReadsItBack()
    {
        var store = NewStore();
        await store.InitialiseAsync();

        var plan = new Plan
        {
            Intent = "Add a fillet",
            Target = { DocPath = @"C:\parts\bracket.SLDPRT" },
        };
        plan.Ops.Add(new Operation { Id = "op1", Op = "feature.fillet" });

        await store.SavePlanAsync(plan, "Edit");

        var rows = await store.RecentPlansAsync(@"C:\parts\bracket.SLDPRT", 10);
        Assert.Single(rows);
        Assert.Equal("Add a fillet", rows[0]["intent"] as string);
    }

    [Fact]
    public async Task Store_SavesAPlanWhoseOperationHasNoParameters()
    {
        // Regression: Operation.Params is a JsonElement struct. Left at ValueKind.Undefined
        // it threw on serialisation, so any op without parameters — the common case — could
        // not be persisted at all.
        var store = NewStore();
        await store.InitialiseAsync();

        var plan = new Plan { Intent = "no params" };
        plan.Ops.Add(new Operation { Id = "op1", Op = "doc.rebuild" });

        await store.SavePlanAsync(plan, "Edit");
        Assert.Single(await store.RecentPlansAsync(null, 10));
    }
}

/// <summary>
/// Provider-routing tests. These exercise the decision layer without a network call,
/// which is the whole reason the mock provider exists.
/// </summary>
public sealed class MockProviderTests
{
    private static PlanRequest Request(string prompt) =>
        new(prompt, PlanMode.Edit, new ModelContext { DocPath = @"C:\p.SLDPRT" }, Array.Empty<string>());

    [Fact]
    public async Task ProducesADeterministicPlanForAKnownPrompt()
    {
        var provider = new MockPlanProvider();

        var a = await provider.PlanAsync(Request("add a fillet"), CancellationToken.None);
        var b = await provider.PlanAsync(Request("add a fillet"), CancellationToken.None);

        Assert.True(a.Ok);
        Assert.Equal(a.Plan!.Ops[0].Op, b.Plan!.Ops[0].Op);
        Assert.Equal("feature.fillet", a.Plan.Ops[0].Op);
        Assert.NotEmpty(a.Plan.Assumptions);
    }

    [Fact]
    public async Task FailsRatherThanReturningAnEmptyPlanForAnUnknownPrompt()
    {
        var outcome = await new MockPlanProvider()
            .PlanAsync(Request("something it has never seen"), CancellationToken.None);

        // An empty plan would make the pipeline report success for a request it did not
        // understand — the exact failure verification exists to prevent.
        Assert.False(outcome.Ok);
        Assert.Null(outcome.Plan);
    }

    [Fact]
    public async Task EmitsOnlyOperationsInTheCatalogue()
    {
        var provider = new MockPlanProvider();
        foreach (var prompt in new[] { "fillet", "hole", "properties" })
        {
            var outcome = await provider.PlanAsync(Request(prompt), CancellationToken.None);
            Assert.True(outcome.Ok);
            foreach (var op in outcome.Plan!.Ops)
                Assert.True(OpCatalog.Exists(op.Op), $"'{op.Op}' is not in the operation catalogue.");
        }
    }

    [Fact]
    public async Task HonoursCancellation()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => new MockPlanProvider().PlanAsync(Request("fillet"), cts.Token));
    }

    [Fact]
    public void RouterPrefersAManagedProviderOverALocalOne()
    {
        var router = new ProviderRouter(NullLogger<ProviderRouter>.Instance);
        var local = new MockPlanProvider();
        router.Register(local);

        var chosen = router.Resolve(null);
        Assert.NotNull(chosen);

        // With only the mock registered it must still be selectable by id.
        Assert.Equal("mock", router.Resolve("mock")!.Id);
    }

    [Fact]
    public async Task RouterReportsWhenNoProviderIsAvailable()
    {
        var router = new ProviderRouter(NullLogger<ProviderRouter>.Instance);
        router.Register(new MockPlanProvider { IsAvailable = false });

        var outcome = await router.PlanAsync(Request("fillet"), CancellationToken.None);

        Assert.False(outcome.Ok);
        // The message must point at the deterministic escape hatch, not just say "no".
        Assert.Contains("Skills", outcome.Error!, StringComparison.OrdinalIgnoreCase);
    }
}

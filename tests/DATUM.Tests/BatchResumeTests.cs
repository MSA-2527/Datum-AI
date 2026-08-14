using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Datum.Orchestrator.Storage;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;

namespace Datum.Tests;

/// <summary>
/// Batch resume tests.
///
/// A release run over a few thousand files is the longest-lived operation in the product
/// and therefore the most likely to be interrupted. The properties that matter: resuming
/// does not redo completed work, and an item interrupted mid-flight is retried rather than
/// silently skipped. Doing a file twice is recoverable; losing one is not.
/// </summary>
public sealed class BatchResumeTests : IDisposable
{
    private readonly string _root;
    private readonly string _dbPath;

    public BatchResumeTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "datum-batch", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
        _dbPath = Path.Combine(_root, "t.db");
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_root, recursive: true); } catch { }
    }

    private async Task<BatchStore> StoreAsync()
    {
        await new Store(NullLogger<Store>.Instance, _dbPath).InitialiseAsync();
        return new BatchStore(async () =>
        {
            var db = new SqliteConnection($"Data Source={_dbPath}");
            await db.OpenAsync();
            return db;
        }, NullLogger.Instance);
    }

    private static string[] Targets(int n) =>
        Enumerable.Range(1, n).Select(i => $@"C:\parts\file{i:D3}.SLDPRT").ToArray();

    [Fact]
    public async Task CreatesOneItemPerTarget()
    {
        var store = await StoreAsync();
        string id = await store.CreateAsync("release", "release-package", Targets(5), dryRun: false);

        var items = await store.ItemsAsync(id);
        Assert.Equal(5, items.Count);
        Assert.All(items, i => Assert.Equal(BatchStore.ItemStatus.Queued, i.Status));
    }

    [Fact]
    public async Task ResumeSkipsCompletedWork()
    {
        var store = await StoreAsync();
        string id = await store.CreateAsync("release", null, Targets(10), dryRun: false);

        // Simulate 6 finished, then a crash.
        for (int i = 0; i < 6; i++)
            await store.MarkAsync(id, i, BatchStore.ItemStatus.Done, elapsedMs: 100);

        var pending = await store.PendingAsync(id);

        // Must resume at 7, not start over. Re-exporting the first six would rewrite
        // artefacts someone may already have collected.
        Assert.Equal(4, pending.Count);
        Assert.Equal(6, pending[0].Ordinal);
        Assert.Equal(@"C:\parts\file007.SLDPRT", pending[0].DocPath);
    }

    [Fact]
    public async Task AnItemInterruptedMidFlightIsRetriedNotSkipped()
    {
        var store = await StoreAsync();
        string id = await store.CreateAsync("release", null, Targets(3), dryRun: false);

        await store.MarkAsync(id, 0, BatchStore.ItemStatus.Done);
        await store.MarkAsync(id, 1, BatchStore.ItemStatus.Running); // crashed here

        var pending = await store.PendingAsync(id);

        // Its outcome is unknown, so it must come back. Treating 'running' as complete
        // would silently drop a file from a release package.
        Assert.Equal(2, pending.Count);
        Assert.Contains(pending, p => p.Ordinal == 1);
    }

    [Fact]
    public async Task PendingIsOrderedSoResumeIsDeterministic()
    {
        var store = await StoreAsync();
        string id = await store.CreateAsync("release", null, Targets(6), dryRun: false);

        await store.MarkAsync(id, 3, BatchStore.ItemStatus.Done);
        await store.MarkAsync(id, 0, BatchStore.ItemStatus.Done);

        var pending = await store.PendingAsync(id);
        Assert.Equal(new[] { 1, 2, 4, 5 }, pending.Select(p => p.Ordinal).ToArray());
    }

    [Fact]
    public async Task FailedItemsLandInTheDeadLetterListWithTheirError()
    {
        var store = await StoreAsync();
        string id = await store.CreateAsync("release", null, Targets(4), dryRun: false);

        await store.MarkAsync(id, 0, BatchStore.ItemStatus.Done);
        await store.MarkAsync(id, 1, BatchStore.ItemStatus.Failed,
            error: "Read-only — not checked out of the vault");

        var dead = await store.DeadLetterAsync(id);

        // A failed file must never vanish. The reason has to survive too, or the user
        // cannot tell a locked file from a broken model.
        Assert.Single(dead);
        Assert.Contains("checked out", dead[0].Error!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task RequeueRetriesOnlyTheFailures()
    {
        var store = await StoreAsync();
        string id = await store.CreateAsync("release", null, Targets(5), dryRun: false);

        for (int i = 0; i < 4; i++) await store.MarkAsync(id, i, BatchStore.ItemStatus.Done);
        await store.MarkAsync(id, 4, BatchStore.ItemStatus.Failed, error: "locked");

        await store.RequeueFailedAsync(id);
        var pending = await store.PendingAsync(id);

        Assert.Single(pending);
        Assert.Equal(4, pending[0].Ordinal);
    }

    [Fact]
    public async Task InterruptedBatchesAreOfferedForResumeWithAccurateCounts()
    {
        var store = await StoreAsync();
        string id = await store.CreateAsync("nightly release", "release-package", Targets(8), dryRun: false);

        for (int i = 0; i < 5; i++) await store.MarkAsync(id, i, BatchStore.ItemStatus.Done);
        await store.MarkAsync(id, 5, BatchStore.ItemStatus.Failed, error: "boom");

        var interrupted = await store.InterruptedAsync();

        Assert.Single(interrupted);
        Assert.Equal("nightly release", interrupted[0].Name);
        Assert.Equal(8, interrupted[0].Total);
        Assert.Equal(5, interrupted[0].Done);
        Assert.Equal(1, interrupted[0].Failed);
    }

    [Fact]
    public async Task AFinishedBatchIsNotOfferedForResume()
    {
        var store = await StoreAsync();
        string id = await store.CreateAsync("done", null, Targets(2), dryRun: false);

        await store.MarkAsync(id, 0, BatchStore.ItemStatus.Done);
        await store.MarkAsync(id, 1, BatchStore.ItemStatus.Done);
        await store.FinishAsync(id, BatchStore.BatchStatus.Completed);

        Assert.Empty(await store.InterruptedAsync());
    }

    [Fact]
    public async Task AttemptsAreCountedSoARunawayRetryIsVisible()
    {
        var store = await StoreAsync();
        string id = await store.CreateAsync("r", null, Targets(1), dryRun: false);

        await store.MarkAsync(id, 0, BatchStore.ItemStatus.Running);
        await store.MarkAsync(id, 0, BatchStore.ItemStatus.Failed, error: "x");
        await store.MarkAsync(id, 0, BatchStore.ItemStatus.Running);

        var items = await store.ItemsAsync(id);
        Assert.Equal(2, items[0].Attempts);
    }

    [Fact]
    public async Task DryRunIsRecordedSoAResumeCannotSilentlyCommit()
    {
        var store = await StoreAsync();
        string id = await store.CreateAsync("preview", null, Targets(3), dryRun: true);

        var interrupted = await store.InterruptedAsync();

        // Resuming a dry run as a real run would write files the user explicitly asked
        // not to write.
        Assert.True(interrupted.Single(b => b.BatchId == id).DryRun);
    }
}

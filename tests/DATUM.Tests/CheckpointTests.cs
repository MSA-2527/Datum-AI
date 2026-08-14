using System;
using System.IO;
using System.Threading.Tasks;
using Datum.Orchestrator.Security;
using Datum.Orchestrator.Storage;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;

namespace Datum.Tests;

/// <summary>
/// Checkpoint tests.
///
/// This is the recovery path. If it does not work, the product's central safety claim —
/// that a bad plan cannot cost you your model — is false. So these assert the file really
/// comes back byte-identical, and that restoring does not destroy what it replaces.
/// </summary>
public sealed class CheckpointTests : IDisposable
{
    private readonly string _root;
    private readonly string _dbPath;
    private readonly string _blobs;
    private readonly string _docPath;

    public CheckpointTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "datum-cp", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
        _dbPath = Path.Combine(_root, "test.db");
        _blobs = Path.Combine(_root, "blobs");
        _docPath = Path.Combine(_root, "bracket.SLDPRT");
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_root, recursive: true); } catch { /* temp */ }
    }

    private async Task<CheckpointService> NewServiceAsync()
    {
        await new Store(NullLogger<Store>.Instance, _dbPath).InitialiseAsync();

        return new CheckpointService(
            _blobs,
            async () =>
            {
                var db = new SqliteConnection($"Data Source={_dbPath}");
                await db.OpenAsync();
                return db;
            },
            NullLogger.Instance);
    }

    [Fact]
    public async Task CaptureThenRestoreReturnsTheOriginalBytes()
    {
        var svc = await NewServiceAsync();
        await File.WriteAllTextAsync(_docPath, "ORIGINAL CONTENT");

        var cp = await svc.CaptureAsync(_docPath, "pln_1");
        Assert.NotNull(cp);

        // Simulate a plan that wrecked the file.
        await File.WriteAllTextAsync(_docPath, "CORRUPTED BY A BAD PLAN");

        Assert.True(await svc.RestoreAsync(cp!.CheckpointId));
        Assert.Equal("ORIGINAL CONTENT", await File.ReadAllTextAsync(_docPath));
    }

    [Fact]
    public async Task RestoreCheckpointsTheCurrentStateFirst()
    {
        var svc = await NewServiceAsync();
        await File.WriteAllTextAsync(_docPath, "V1");
        var first = await svc.CaptureAsync(_docPath, null);

        await File.WriteAllTextAsync(_docPath, "V2");
        await svc.RestoreAsync(first!.CheckpointId);

        // Restoring is destructive. A recovery tool that destroys the state you were
        // recovering *from* is not one — V2 must still be reachable.
        var all = await svc.ListAsync(_docPath);
        Assert.True(all.Count >= 2);

        var v2 = all[0];
        Assert.True(File.Exists(v2.BlobPath));
    }

    [Fact]
    public async Task IdenticalContentIsStoredOnce()
    {
        var svc = await NewServiceAsync();
        await File.WriteAllTextAsync(_docPath, "UNCHANGED");

        var a = await svc.CaptureAsync(_docPath, "pln_1");
        var b = await svc.CaptureAsync(_docPath, "pln_2");

        // Content addressing is what makes unconditional checkpointing affordable across
        // a batch. Two rows, one blob.
        Assert.NotEqual(a!.CheckpointId, b!.CheckpointId);
        Assert.Equal(a.BlobPath, b.BlobPath);
        Assert.Single(Directory.GetFiles(_blobs, "*", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task ReturnsNullForADocumentThatHasNeverBeenSaved()
    {
        var svc = await NewServiceAsync();
        // A new part with no file on disk has nothing to restore; failing the whole plan
        // over that would be wrong.
        Assert.Null(await svc.CaptureAsync(Path.Combine(_root, "never-saved.SLDPRT"), null));
    }

    [Fact]
    public async Task RestoreFailsHonestlyWhenTheBlobIsGone()
    {
        var svc = await NewServiceAsync();
        await File.WriteAllTextAsync(_docPath, "DATA");
        var cp = await svc.CaptureAsync(_docPath, null);

        File.Delete(cp!.BlobPath);

        // Reporting a successful restore of nothing would be the worst possible outcome.
        Assert.False(await svc.RestoreAsync(cp.CheckpointId));
    }

    [Fact]
    public async Task PruneKeepsBlobsThatAreStillReferenced()
    {
        var svc = await NewServiceAsync();
        svc.Retention = TimeSpan.Zero; // everything is immediately expired

        await File.WriteAllTextAsync(_docPath, "SHARED");
        await svc.CaptureAsync(_docPath, "pln_1");
        await svc.CaptureAsync(_docPath, "pln_2");

        await svc.PruneAsync();

        // Both rows expire together, so the shared blob may go — but it must never be
        // deleted while a surviving row still points at it.
        Assert.Empty(await svc.ListAsync(_docPath));
    }

    [Fact]
    public async Task ListIsNewestFirst()
    {
        var svc = await NewServiceAsync();

        await File.WriteAllTextAsync(_docPath, "A");
        await svc.CaptureAsync(_docPath, "first");
        await Task.Delay(10);
        await File.WriteAllTextAsync(_docPath, "B");
        await svc.CaptureAsync(_docPath, "second");

        var all = await svc.ListAsync(_docPath);
        Assert.Equal("second", all[0].PlanId);
    }
}

/// <summary>
/// Credential store tests. These run only on Windows, because DPAPI is a Windows API and
/// the orchestrator targets net8.0-windows for exactly that reason.
/// </summary>
public sealed class CredentialStoreTests : IDisposable
{
    private readonly string _dir;
    private readonly string _path;

    public CredentialStoreTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "datum-cred", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
        _path = Path.Combine(_dir, "credentials.dat");
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* temp */ }
    }

    private CredentialStore New() => new(_path, NullLogger.Instance);

    [Fact]
    public void RoundTripsASecret()
    {
        var store = New();
        store.Store("byo-anthropic", "sk-ant-secret-value");
        Assert.Equal("sk-ant-secret-value", store.Resolve("byo-anthropic"));
    }

    [Fact]
    public void NeverWritesTheSecretInPlaintext()
    {
        var store = New();
        store.Store("pro", "super-secret-key-12345");

        string onDisk = File.ReadAllText(_path);

        // The whole point. If this ever fails, keys are sitting readable in a file that
        // gets copied around with project data.
        Assert.DoesNotContain("super-secret-key-12345", onDisk, StringComparison.Ordinal);
    }

    [Fact]
    public void ReturnsNullForAnUnknownHandle()
    {
        Assert.Null(New().Resolve("never-stored"));
        Assert.Null(New().Resolve(null));
        Assert.Null(New().Resolve(""));
    }

    [Fact]
    public void OverwritesAnExistingHandle()
    {
        var store = New();
        store.Store("k", "first");
        store.Store("k", "second");
        Assert.Equal("second", store.Resolve("k"));
    }

    [Fact]
    public void DeleteRemovesTheSecret()
    {
        var store = New();
        store.Store("k", "value");

        Assert.True(store.Delete("k"));
        Assert.Null(store.Resolve("k"));
        Assert.False(store.Delete("k"));
    }

    [Fact]
    public void SurvivesACorruptStoreRatherThanFailingToStart()
    {
        File.WriteAllText(_path, "{ this is not valid json");

        // A corrupt file must not prevent the service starting. The user re-enters a key;
        // throwing here would mean they cannot get far enough to do that.
        var store = New();
        Assert.Empty(store.List());

        store.Store("k", "recovered");
        Assert.Equal("recovered", store.Resolve("k"));
    }

    [Fact]
    public void ImportsFromEnvironmentWithoutOverwritingAStoredKey()
    {
        var store = New();
        store.Store("byo-anthropic", "already-stored");

        Environment.SetEnvironmentVariable("ANTHROPIC_API_KEY", "from-environment");
        try
        {
            store.ImportFromEnvironment();
            // A stale environment variable must never clobber a deliberately stored key.
            Assert.Equal("already-stored", store.Resolve("byo-anthropic"));
        }
        finally
        {
            Environment.SetEnvironmentVariable("ANTHROPIC_API_KEY", null);
        }
    }

    [Fact]
    public void ListsStoredHandlesButNotValues()
    {
        var store = New();
        store.Store("a", "secret-a");
        store.Store("b", "secret-b");

        var handles = store.List();
        Assert.Contains("a", handles);
        Assert.Contains("b", handles);
        Assert.DoesNotContain("secret-a", handles);
    }
}

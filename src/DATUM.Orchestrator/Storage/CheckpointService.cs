using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace Datum.Orchestrator.Storage;

/// <summary>
/// Pre-apply file checkpoints.
///
/// Undo is not a recovery mechanism. It depends on SOLIDWORKS still running, on the undo
/// stack being intact, and on <c>FinishRecordingUndoObject</c> having actually grouped the
/// work — none of which survive a crash mid-plan. A copy of the file taken before anything
/// mutates does.
///
/// Storage is content-addressed: identical bytes are stored once, so checkpointing the
/// same unchanged assembly across twenty batch items costs one copy rather than twenty.
/// That is what makes it affordable to checkpoint unconditionally instead of asking the
/// user to opt in — and a safety net people have to remember to enable is not a safety net.
/// </summary>
public sealed class CheckpointService
{
    private readonly string _blobRoot;
    private readonly Func<Task<SqliteConnection>> _openDb;
    private readonly ILogger _log;

    /// <summary>Checkpoints older than this are pruned. Configurable per deployment.</summary>
    public TimeSpan Retention { get; set; } = TimeSpan.FromDays(30);

    public CheckpointService(string blobRoot, Func<Task<SqliteConnection>> openDb, ILogger log)
    {
        _blobRoot = blobRoot;
        _openDb = openDb;
        _log = log;
        Directory.CreateDirectory(_blobRoot);
    }

    public sealed record Checkpoint(
        string CheckpointId,
        string DocPath,
        string? PlanId,
        string BlobPath,
        string Sha256,
        long SizeBytes,
        DateTime CreatedAtUtc);

    /// <summary>
    /// Snapshots a document before a plan is applied.
    ///
    /// Returns null when the file does not exist — a never-saved document has nothing to
    /// restore, and failing the whole plan for that would be wrong.
    /// </summary>
    public async Task<Checkpoint?> CaptureAsync(
        string docPath,
        string? planId,
        CancellationToken ct = default)
    {
        if (!File.Exists(docPath))
        {
            _log.LogDebug("No checkpoint for {Path}: file does not exist yet.", docPath);
            return null;
        }

        string hash = await ComputeSha256Async(docPath, ct);

        // Fan the blobs out by hash prefix. A flat directory with tens of thousands of
        // entries degrades badly on NTFS.
        string dir = Path.Combine(_blobRoot, hash[..2]);
        Directory.CreateDirectory(dir);
        string blobPath = Path.Combine(dir, hash + Path.GetExtension(docPath));

        var info = new FileInfo(docPath);

        if (!File.Exists(blobPath))
        {
            File.Copy(docPath, blobPath, overwrite: false);
        }
        else
        {
            // Same content already stored. This is the common case in a batch.
            _log.LogDebug("Checkpoint deduplicated for {Path} ({Hash}).", docPath, hash[..8]);
        }

        var checkpoint = new Checkpoint(
            Guid.NewGuid().ToString("N"),
            docPath,
            planId,
            blobPath,
            hash,
            info.Length,
            DateTime.UtcNow);

        await RecordAsync(checkpoint);
        _log.LogInformation("Checkpoint {Id} captured for {Path}.", checkpoint.CheckpointId[..8], docPath);
        return checkpoint;
    }

    /// <summary>
    /// Restores a checkpoint over the live file.
    ///
    /// The current file is itself checkpointed first. Restoring is destructive, and a
    /// recovery tool that destroys the state you were trying to recover from is not one.
    /// </summary>
    public async Task<bool> RestoreAsync(string checkpointId, CancellationToken ct = default)
    {
        var cp = await GetAsync(checkpointId);
        if (cp is null)
        {
            _log.LogWarning("Checkpoint {Id} not found.", checkpointId);
            return false;
        }

        if (!File.Exists(cp.BlobPath))
        {
            // The database row outlived its blob — pruned, or the folder was cleaned.
            // Say so plainly rather than reporting a successful restore of nothing.
            _log.LogError("Checkpoint {Id} references a missing blob at {Path}.", checkpointId, cp.BlobPath);
            return false;
        }

        if (File.Exists(cp.DocPath))
            await CaptureAsync(cp.DocPath, planId: null, ct);

        string? dir = Path.GetDirectoryName(cp.DocPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        File.Copy(cp.BlobPath, cp.DocPath, overwrite: true);

        // Verify rather than assume. A truncated copy would otherwise be reported as a
        // successful recovery.
        string after = await ComputeSha256Async(cp.DocPath, ct);
        if (!string.Equals(after, cp.Sha256, StringComparison.OrdinalIgnoreCase))
        {
            _log.LogError("Restore of {Id} produced a different hash; the file may be locked.", checkpointId);
            return false;
        }

        _log.LogInformation("Restored {Path} from checkpoint {Id}.", cp.DocPath, checkpointId[..8]);
        return true;
    }

    public async Task<IReadOnlyList<Checkpoint>> ListAsync(string? docPath, int limit = 50)
    {
        await using var db = await _openDb();
        var cmd = db.CreateCommand();
        cmd.CommandText = docPath is { Length: > 0 }
            ? "SELECT * FROM checkpoints WHERE docPath = $doc ORDER BY createdAtUtc DESC LIMIT $n;"
            : "SELECT * FROM checkpoints ORDER BY createdAtUtc DESC LIMIT $n;";
        if (docPath is { Length: > 0 }) cmd.Parameters.AddWithValue("$doc", docPath);
        cmd.Parameters.AddWithValue("$n", limit);

        var list = new List<Checkpoint>();
        await using var rd = await cmd.ExecuteReaderAsync();
        while (await rd.ReadAsync()) list.Add(Read(rd));
        return list;
    }

    public async Task<Checkpoint?> GetAsync(string checkpointId)
    {
        await using var db = await _openDb();
        var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT * FROM checkpoints WHERE checkpointId = $id;";
        cmd.Parameters.AddWithValue("$id", checkpointId);

        await using var rd = await cmd.ExecuteReaderAsync();
        return await rd.ReadAsync() ? Read(rd) : null;
    }

    /// <summary>
    /// Removes expired rows, and deletes a blob only once nothing references it.
    /// Returns the number of blobs actually deleted.
    /// </summary>
    public async Task<int> PruneAsync()
    {
        await using var db = await _openDb();
        string cutoff = DateTime.UtcNow.Subtract(Retention).ToString("O");

        var expired = db.CreateCommand();
        expired.CommandText = "SELECT DISTINCT blobPath FROM checkpoints WHERE createdAtUtc < $cut;";
        expired.Parameters.AddWithValue("$cut", cutoff);

        var candidates = new List<string>();
        await using (var rd = await expired.ExecuteReaderAsync())
            while (await rd.ReadAsync()) candidates.Add(rd.GetString(0));

        var del = db.CreateCommand();
        del.CommandText = "DELETE FROM checkpoints WHERE createdAtUtc < $cut;";
        del.Parameters.AddWithValue("$cut", cutoff);
        await del.ExecuteNonQueryAsync();

        int removed = 0;
        foreach (var blob in candidates)
        {
            // Content addressing means several checkpoints can share a blob. Deleting one
            // that a surviving row still points at would silently break that restore.
            var still = db.CreateCommand();
            still.CommandText = "SELECT count(*) FROM checkpoints WHERE blobPath = $b;";
            still.Parameters.AddWithValue("$b", blob);
            if (Convert.ToInt64(await still.ExecuteScalarAsync()) > 0) continue;

            try
            {
                if (File.Exists(blob)) { File.Delete(blob); removed++; }
            }
            catch (IOException ex)
            {
                _log.LogWarning(ex, "Could not delete checkpoint blob {Path}.", blob);
            }
        }

        if (removed > 0) _log.LogInformation("Pruned {N} checkpoint blob(s).", removed);
        return removed;
    }

    // ── internals ────────────────────────────────────────────────────────────

    private async Task RecordAsync(Checkpoint cp)
    {
        await using var db = await _openDb();
        var cmd = db.CreateCommand();
        cmd.CommandText = """
            INSERT INTO checkpoints (checkpointId, docPath, planId, blobPath, sha256, sizeBytes, createdAtUtc)
            VALUES ($id, $doc, $plan, $blob, $sha, $size, $t);
            """;
        cmd.Parameters.AddWithValue("$id", cp.CheckpointId);
        cmd.Parameters.AddWithValue("$doc", cp.DocPath);
        cmd.Parameters.AddWithValue("$plan", (object?)cp.PlanId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$blob", cp.BlobPath);
        cmd.Parameters.AddWithValue("$sha", cp.Sha256);
        cmd.Parameters.AddWithValue("$size", cp.SizeBytes);
        cmd.Parameters.AddWithValue("$t", cp.CreatedAtUtc.ToString("O"));
        await cmd.ExecuteNonQueryAsync();
    }

    private static Checkpoint Read(SqliteDataReader rd) => new(
        rd.GetString(rd.GetOrdinal("checkpointId")),
        rd.GetString(rd.GetOrdinal("docPath")),
        rd.IsDBNull(rd.GetOrdinal("planId")) ? null : rd.GetString(rd.GetOrdinal("planId")),
        rd.GetString(rd.GetOrdinal("blobPath")),
        rd.GetString(rd.GetOrdinal("sha256")),
        rd.GetInt64(rd.GetOrdinal("sizeBytes")),
        DateTime.Parse(rd.GetString(rd.GetOrdinal("createdAtUtc")), null,
            System.Globalization.DateTimeStyles.RoundtripKind));

    private static async Task<string> ComputeSha256Async(string path, CancellationToken ct)
    {
        // Streamed, so a 400 MB assembly does not land in memory.
        await using var stream = new FileStream(
            path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 64 * 1024, useAsync: true);
        using var sha = SHA256.Create();
        byte[] hash = await sha.ComputeHashAsync(stream, ct);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}

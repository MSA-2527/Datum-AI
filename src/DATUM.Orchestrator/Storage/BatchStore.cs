using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace Datum.Orchestrator.Storage;

/// <summary>
/// Resumable batch state.
///
/// Batch runs are the longest-lived operation in the product — a release package over a
/// few thousand files can take hours — which makes them the most likely thing to be
/// interrupted by a SOLIDWORKS crash, a reboot, or someone closing the lid.
///
/// State is recorded per item, not per batch. Resuming a 1000-file run that died at 900
/// must continue at 901: re-processing the first 900 is not merely slow, it rewrites
/// artefacts a colleague may already have collected and re-checks-out files that were
/// deliberately released.
///
/// Items are marked complete only after their work is done, so an item interrupted
/// mid-flight comes back as `running` and is retried rather than skipped. Losing a file
/// silently is far worse than doing one twice.
/// </summary>
public sealed class BatchStore
{
    private readonly Func<Task<SqliteConnection>> _open;
    private readonly ILogger _log;

    public BatchStore(Func<Task<SqliteConnection>> open, ILogger log)
    {
        _open = open;
        _log = log;
    }

    public enum ItemStatus { Queued, Running, Done, Failed, Skipped }
    public enum BatchStatus { Running, Completed, Failed, Cancelled }

    public sealed record BatchItem(int Ordinal, string DocPath, ItemStatus Status, int Attempts, string? Error, long ElapsedMs);

    public sealed record BatchSummary(
        string BatchId,
        string Name,
        string? RecipeId,
        BatchStatus Status,
        int Total,
        int Done,
        int Failed,
        bool DryRun,
        DateTime CreatedAtUtc);

    public async Task<string> CreateAsync(string name, string? recipeId, IReadOnlyList<string> targets, bool dryRun)
    {
        string batchId = Guid.NewGuid().ToString("N");

        await using var db = await _open();
        await using var tx = (SqliteTransaction)await db.BeginTransactionAsync();

        var head = db.CreateCommand();
        head.Transaction = tx;
        head.CommandText = """
            INSERT INTO batches (batchId, name, recipeId, status, total, dryRun, createdAtUtc)
            VALUES ($id, $name, $recipe, 'running', $total, $dry, $t);
            """;
        head.Parameters.AddWithValue("$id", batchId);
        head.Parameters.AddWithValue("$name", name);
        head.Parameters.AddWithValue("$recipe", (object?)recipeId ?? DBNull.Value);
        head.Parameters.AddWithValue("$total", targets.Count);
        head.Parameters.AddWithValue("$dry", dryRun ? 1 : 0);
        head.Parameters.AddWithValue("$t", DateTime.UtcNow.ToString("O"));
        await head.ExecuteNonQueryAsync();

        for (int i = 0; i < targets.Count; i++)
        {
            var item = db.CreateCommand();
            item.Transaction = tx;
            item.CommandText = """
                INSERT INTO batch_items (batchId, ordinal, docPath, status, updatedAtUtc)
                VALUES ($b, $i, $p, 'queued', $t);
                """;
            item.Parameters.AddWithValue("$b", batchId);
            item.Parameters.AddWithValue("$i", i);
            item.Parameters.AddWithValue("$p", targets[i]);
            item.Parameters.AddWithValue("$t", DateTime.UtcNow.ToString("O"));
            await item.ExecuteNonQueryAsync();
        }

        await tx.CommitAsync();
        _log.LogInformation("Batch {Id} created with {N} target(s).", batchId[..8], targets.Count);
        return batchId;
    }

    public async Task MarkAsync(string batchId, int ordinal, ItemStatus status,
                                string? planId = null, string? error = null, long elapsedMs = 0)
    {
        await using var db = await _open();
        var cmd = db.CreateCommand();
        cmd.CommandText = """
            UPDATE batch_items
               SET status = $s,
                   planId = COALESCE($plan, planId),
                   errorText = $err,
                   elapsedMs = $ms,
                   attempts = attempts + CASE WHEN $s = 'running' THEN 1 ELSE 0 END,
                   updatedAtUtc = $t
             WHERE batchId = $b AND ordinal = $i;
            """;
        cmd.Parameters.AddWithValue("$s", status.ToString().ToLowerInvariant());
        cmd.Parameters.AddWithValue("$plan", (object?)planId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$err", (object?)error ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$ms", elapsedMs);
        cmd.Parameters.AddWithValue("$t", DateTime.UtcNow.ToString("O"));
        cmd.Parameters.AddWithValue("$b", batchId);
        cmd.Parameters.AddWithValue("$i", ordinal);
        await cmd.ExecuteNonQueryAsync();
    }

    /// <summary>
    /// Work still outstanding, in order.
    ///
    /// Includes items left `running` by an interrupted process. Those were in flight when
    /// the crash happened and their outcome is unknown, so they are retried — a file
    /// processed twice is recoverable, a file silently skipped is not.
    /// </summary>
    public async Task<IReadOnlyList<BatchItem>> PendingAsync(string batchId)
    {
        await using var db = await _open();
        var cmd = db.CreateCommand();
        cmd.CommandText = """
            SELECT ordinal, docPath, status, attempts, errorText, COALESCE(elapsedMs, 0)
              FROM batch_items
             WHERE batchId = $b AND status IN ('queued', 'running')
             ORDER BY ordinal;
            """;
        cmd.Parameters.AddWithValue("$b", batchId);
        return await ReadItemsAsync(cmd);
    }

    public async Task<IReadOnlyList<BatchItem>> ItemsAsync(string batchId)
    {
        await using var db = await _open();
        var cmd = db.CreateCommand();
        cmd.CommandText = """
            SELECT ordinal, docPath, status, attempts, errorText, COALESCE(elapsedMs, 0)
              FROM batch_items WHERE batchId = $b ORDER BY ordinal;
            """;
        cmd.Parameters.AddWithValue("$b", batchId);
        return await ReadItemsAsync(cmd);
    }

    /// <summary>Failed items only — the dead-letter list, for one-click retry.</summary>
    public async Task<IReadOnlyList<BatchItem>> DeadLetterAsync(string batchId)
    {
        await using var db = await _open();
        var cmd = db.CreateCommand();
        cmd.CommandText = """
            SELECT ordinal, docPath, status, attempts, errorText, COALESCE(elapsedMs, 0)
              FROM batch_items WHERE batchId = $b AND status = 'failed' ORDER BY ordinal;
            """;
        cmd.Parameters.AddWithValue("$b", batchId);
        return await ReadItemsAsync(cmd);
    }

    /// <summary>Requeues failed items so a retry does not re-run the successes.</summary>
    public async Task<int> RequeueFailedAsync(string batchId)
    {
        await using var db = await _open();
        var cmd = db.CreateCommand();
        cmd.CommandText = """
            UPDATE batch_items SET status = 'queued', errorText = NULL, updatedAtUtc = $t
             WHERE batchId = $b AND status = 'failed';
            UPDATE batches SET status = 'running', finishedAtUtc = NULL WHERE batchId = $b;
            """;
        cmd.Parameters.AddWithValue("$t", DateTime.UtcNow.ToString("O"));
        cmd.Parameters.AddWithValue("$b", batchId);
        return await cmd.ExecuteNonQueryAsync();
    }

    public async Task FinishAsync(string batchId, BatchStatus status)
    {
        await using var db = await _open();
        var cmd = db.CreateCommand();
        cmd.CommandText = "UPDATE batches SET status = $s, finishedAtUtc = $t WHERE batchId = $b;";
        cmd.Parameters.AddWithValue("$s", status.ToString().ToLowerInvariant());
        cmd.Parameters.AddWithValue("$t", DateTime.UtcNow.ToString("O"));
        cmd.Parameters.AddWithValue("$b", batchId);
        await cmd.ExecuteNonQueryAsync();
    }

    /// <summary>
    /// Batches left running by a previous process — offered for resume on startup.
    /// </summary>
    public async Task<IReadOnlyList<BatchSummary>> InterruptedAsync()
    {
        await using var db = await _open();
        var cmd = db.CreateCommand();
        cmd.CommandText = """
            SELECT b.batchId, b.name, b.recipeId, b.status, b.total, b.dryRun, b.createdAtUtc,
                   SUM(CASE WHEN i.status = 'done'   THEN 1 ELSE 0 END) AS doneCount,
                   SUM(CASE WHEN i.status = 'failed' THEN 1 ELSE 0 END) AS failedCount
              FROM batches b
              JOIN batch_items i ON i.batchId = b.batchId
             WHERE b.status = 'running'
             GROUP BY b.batchId
             ORDER BY b.createdAtUtc DESC;
            """;

        var list = new List<BatchSummary>();
        await using var rd = await cmd.ExecuteReaderAsync();
        while (await rd.ReadAsync())
        {
            list.Add(new BatchSummary(
                rd.GetString(0),
                rd.GetString(1),
                rd.IsDBNull(2) ? null : rd.GetString(2),
                Enum.Parse<BatchStatus>(rd.GetString(3), ignoreCase: true),
                rd.GetInt32(4),
                rd.GetInt32(7),
                rd.GetInt32(8),
                rd.GetInt32(5) == 1,
                DateTime.Parse(rd.GetString(6), null, System.Globalization.DateTimeStyles.RoundtripKind)));
        }
        return list;
    }

    private static async Task<IReadOnlyList<BatchItem>> ReadItemsAsync(SqliteCommand cmd)
    {
        var list = new List<BatchItem>();
        await using var rd = await cmd.ExecuteReaderAsync();
        while (await rd.ReadAsync())
        {
            list.Add(new BatchItem(
                rd.GetInt32(0),
                rd.GetString(1),
                Enum.Parse<ItemStatus>(rd.GetString(2), ignoreCase: true),
                rd.GetInt32(3),
                rd.IsDBNull(4) ? null : rd.GetString(4),
                rd.GetInt64(5)));
        }
        return list;
    }
}

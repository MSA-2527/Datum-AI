using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace Datum.Orchestrator.Storage;

/// <summary>
/// Versioned schema migrations.
///
/// The audit trail is the customer's own record of what an AI did to their engineering
/// files, so it has to survive upgrades. `CREATE TABLE IF NOT EXISTS` alone does not do
/// that: it silently skips an existing table whose columns have since changed, and the
/// first query against the new column then fails at runtime on a customer's machine.
///
/// Migrations run inside a transaction and are tracked with SQLite's own `user_version`
/// pragma — no bookkeeping table of our own to get out of step with reality.
///
/// Rules for adding one:
///   - append only, never edit a shipped migration;
///   - additive where possible (SQLite cannot drop a column before 3.35);
///   - a migration that cannot be made safe should fail loudly rather than guess.
/// </summary>
public static class Migrations
{
    /// <summary>Each entry is one version step, applied in order.</summary>
    private static readonly IReadOnlyList<string> Steps = new[]
    {
        // v1 — initial schema.
        """
        CREATE TABLE IF NOT EXISTS plans (
            planId        TEXT PRIMARY KEY,
            docPath       TEXT,
            configuration TEXT,
            mode          TEXT,
            intent        TEXT,
            assumptions   TEXT,
            irVersion     TEXT,
            providerId    TEXT,
            modelId       TEXT,
            promptTokens  INTEGER,
            completionTokens INTEGER,
            opCount       INTEGER,
            status        TEXT DEFAULT 'planned',
            createdAtUtc  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ops (
            opId     TEXT,
            planId   TEXT NOT NULL REFERENCES plans(planId) ON DELETE CASCADE,
            ordinal  INTEGER,
            opName   TEXT,
            targetJson TEXT,
            paramsJson TEXT,
            resolvedCount INTEGER,
            PRIMARY KEY (planId, opId)
        );

        CREATE TABLE IF NOT EXISTS verify (
            planId        TEXT PRIMARY KEY REFERENCES plans(planId) ON DELETE CASCADE,
            passed        INTEGER,
            rolledBack    INTEGER,
            errorsBefore  INTEGER,
            errorsAfter   INTEGER,
            massBeforeG   REAL,
            massAfterG    REAL,
            interferences INTEGER,
            elapsedMs     INTEGER,
            checksJson    TEXT,
            appliedAtUtc  TEXT
        );

        CREATE TABLE IF NOT EXISTS skills (
            skillId      TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            version      TEXT NOT NULL,
            description  TEXT,
            inputsJson   TEXT,
            opsJson      TEXT,
            testsJson    TEXT,
            runCount     INTEGER DEFAULT 0,
            lastStatus   TEXT,
            updatedAtUtc TEXT
        );

        CREATE INDEX IF NOT EXISTS ix_plans_doc  ON plans(docPath, createdAtUtc DESC);
        CREATE INDEX IF NOT EXISTS ix_plans_time ON plans(createdAtUtc DESC);
        """,

        // v2 — checkpoints and an append-only audit log.
        //
        // Undo is not a recovery mechanism: it depends on SOLIDWORKS still running and
        // the undo stack being intact. A content-addressed file snapshot taken before a
        // plan is applied survives both a crash and a failed rollback.
        """
        CREATE TABLE IF NOT EXISTS checkpoints (
            checkpointId TEXT PRIMARY KEY,
            docPath      TEXT NOT NULL,
            planId       TEXT,
            blobPath     TEXT NOT NULL,
            sha256       TEXT NOT NULL,
            sizeBytes    INTEGER NOT NULL,
            createdAtUtc TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit (
            eventId      INTEGER PRIMARY KEY AUTOINCREMENT,
            kind         TEXT NOT NULL,
            docPath      TEXT,
            planId       TEXT,
            detailJson   TEXT,
            createdAtUtc TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS ix_checkpoints_doc ON checkpoints(docPath, createdAtUtc DESC);
        CREATE INDEX IF NOT EXISTS ix_audit_time      ON audit(createdAtUtc DESC);
        """,

        // v3 — recipes, and provider config without plaintext secrets.
        //
        // keyRef is a handle into Windows Credential Manager. An API key must never be
        // written here: this file is the customer's, is trivially readable, and gets
        // copied around with their project data.
        """
        CREATE TABLE IF NOT EXISTS recipes (
            recipeId     TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            version      TEXT NOT NULL DEFAULT '1.0.0',
            description  TEXT,
            stepsJson    TEXT NOT NULL,
            inputsJson   TEXT,
            failurePolicy TEXT NOT NULL DEFAULT 'stop',
            runCount     INTEGER DEFAULT 0,
            lastStatus   TEXT,
            updatedAtUtc TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS providers (
            providerId TEXT PRIMARY KEY,
            kind       TEXT NOT NULL,
            endpoint   TEXT,
            modelId    TEXT,
            keyRef     TEXT,
            enabled    INTEGER NOT NULL DEFAULT 1,
            isDefault  INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS settings (
            key          TEXT PRIMARY KEY,
            value        TEXT,
            scope        TEXT NOT NULL DEFAULT 'user',
            lockedByAdmin INTEGER NOT NULL DEFAULT 0
        );
        """,

        // v4 — resumable batches.
        //
        // Per-item state, not per-batch: a crash 900 files into a 1000-file release run
        // must resume at 901, not start over. Re-exporting 900 files is not merely slow,
        // it rewrites artefacts a colleague may already have collected.
        """
        CREATE TABLE IF NOT EXISTS batches (
            batchId       TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            recipeId      TEXT,
            targetQuery   TEXT,
            status        TEXT NOT NULL DEFAULT 'running',
            total         INTEGER NOT NULL DEFAULT 0,
            dryRun        INTEGER NOT NULL DEFAULT 0,
            createdAtUtc  TEXT NOT NULL,
            finishedAtUtc TEXT
        );

        CREATE TABLE IF NOT EXISTS batch_items (
            batchId   TEXT NOT NULL REFERENCES batches(batchId) ON DELETE CASCADE,
            ordinal   INTEGER NOT NULL,
            docPath   TEXT NOT NULL,
            status    TEXT NOT NULL DEFAULT 'queued',
            planId    TEXT,
            attempts  INTEGER NOT NULL DEFAULT 0,
            errorText TEXT,
            elapsedMs INTEGER,
            updatedAtUtc TEXT,
            PRIMARY KEY (batchId, ordinal)
        );

        CREATE INDEX IF NOT EXISTS ix_batch_items_status ON batch_items(batchId, status);
        CREATE INDEX IF NOT EXISTS ix_batches_status     ON batches(status, createdAtUtc DESC);
        """,
    };

    public static int LatestVersion => Steps.Count;

    public static async Task<int> ReadVersionAsync(SqliteConnection db)
    {
        var cmd = db.CreateCommand();
        cmd.CommandText = "PRAGMA user_version;";
        object? raw = await cmd.ExecuteScalarAsync();
        return raw is null ? 0 : Convert.ToInt32(raw);
    }

    /// <summary>
    /// Brings the database up to <see cref="LatestVersion"/>. Returns how many steps ran.
    /// Safe to call on every start: an up-to-date database does no work.
    /// </summary>
    public static async Task<int> ApplyAsync(SqliteConnection db, ILogger? log = null)
    {
        int current = await ReadVersionAsync(db);

        if (current > LatestVersion)
        {
            // A newer build has already migrated this file. Continuing would run older
            // statements against a newer schema, so refuse rather than corrupt it.
            throw new InvalidOperationException(
                $"This database was written by a newer version of DATUM (schema v{current}); " +
                $"this build only understands v{LatestVersion}. Your history has not been touched. " +
                "Upgrade DATUM, or point this build at a different data directory.");
        }

        int applied = 0;
        for (int v = current; v < LatestVersion; v++)
        {
            await using var tx = (SqliteTransaction)await db.BeginTransactionAsync();
            try
            {
                var cmd = db.CreateCommand();
                cmd.Transaction = tx;
                cmd.CommandText = Steps[v];
                await cmd.ExecuteNonQueryAsync();

                // PRAGMA does not accept a parameter, and v+1 is an int we produced —
                // there is no injection surface here.
                var bump = db.CreateCommand();
                bump.Transaction = tx;
                bump.CommandText = $"PRAGMA user_version = {v + 1};";
                await bump.ExecuteNonQueryAsync();

                await tx.CommitAsync();
                applied++;
                log?.LogInformation("Applied schema migration {From} → {To}.", v, v + 1);
            }
            catch (Exception ex)
            {
                await tx.RollbackAsync();
                log?.LogError(ex, "Migration {From} → {To} failed; database left at {From}.", v, v + 1, v);
                throw;
            }
        }

        return applied;
    }
}

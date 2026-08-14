using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Datum.Contracts;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace Datum.Orchestrator.Storage;

/// <summary>
/// Local SQLite store: plans, operations, verification reports, snapshots, skills.
///
/// Everything lives on the workstation. There is no cloud dependency for history,
/// which is what makes the free tier genuinely offline and the audit trail genuinely
/// the customer's own. API keys never come near this file â€” they live in Windows
/// Credential Manager and are referenced by handle.
/// </summary>
public sealed class Store
{
    private readonly string _connectionString;
    private readonly ILogger<Store> _log;

    public Store(ILogger<Store> log)
        : this(log, DefaultDatabasePath())
    {
    }

    /// <summary>
    /// Explicit-path constructor. Tests use it to run against a temp file or an in-memory
    /// database instead of the developer's real history.
    /// </summary>
    public Store(ILogger<Store> log, string databasePath)
    {
        _log = log;
        string? dir = Path.GetDirectoryName(databasePath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = databasePath,
            Cache = SqliteCacheMode.Shared
        }.ToString();
    }

    private static string DefaultDatabasePath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "DATUM",
        "datum.db");

    public async Task InitialiseAsync()
    {
        await using var db = await OpenAsync();

        // WAL so a long batch write never blocks the UI reading history.
        await Exec(db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");

        // Schema comes from the migration runner, not inline DDL. CREATE TABLE IF NOT
        // EXISTS silently skips a table whose columns have since changed, so an upgraded
        // build would fail at query time on a customer's machine instead of at startup.
        int applied = await Migrations.ApplyAsync(db, _log);

        _log.LogInformation(
            "Store ready at schema v{Version} ({Applied} migration(s) applied).",
            Migrations.LatestVersion, applied);
    }

    public async Task SavePlanAsync(Plan plan, string mode)
    {
        await using var db = await OpenAsync();
        await using var tx = (SqliteTransaction)await db.BeginTransactionAsync();

        var cmd = db.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            INSERT INTO plans (planId, docPath, configuration, mode, intent, assumptions,
                               irVersion, providerId, modelId, promptTokens, completionTokens,
                               opCount, createdAtUtc)
            VALUES ($id, $doc, $cfg, $mode, $intent, $assume, $ir, $prov, $model, $pt, $ctk, $n, $t)
            ON CONFLICT(planId) DO UPDATE SET intent = $intent, opCount = $n;
            """;
        cmd.Parameters.AddWithValue("$id", plan.PlanId);
        cmd.Parameters.AddWithValue("$doc", plan.Target.DocPath ?? "");
        cmd.Parameters.AddWithValue("$cfg", (object?)plan.Target.Configuration ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$mode", mode);
        cmd.Parameters.AddWithValue("$intent", plan.Intent);
        cmd.Parameters.AddWithValue("$assume", IrJson.Serialize(plan.Assumptions));
        cmd.Parameters.AddWithValue("$ir", plan.IrVersion);
        cmd.Parameters.AddWithValue("$prov", (object?)plan.Provenance?.ProviderId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$model", (object?)plan.Provenance?.ModelId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$pt", plan.Provenance?.PromptTokens ?? 0);
        cmd.Parameters.AddWithValue("$ctk", plan.Provenance?.CompletionTokens ?? 0);
        cmd.Parameters.AddWithValue("$n", plan.Ops.Count);
        cmd.Parameters.AddWithValue("$t", DateTime.UtcNow.ToString("O"));
        await cmd.ExecuteNonQueryAsync();

        for (int i = 0; i < plan.Ops.Count; i++)
        {
            var op = plan.Ops[i];
            var oc = db.CreateCommand();
            oc.Transaction = tx;
            oc.CommandText = """
                INSERT OR REPLACE INTO ops (opId, planId, ordinal, opName, targetJson, paramsJson, resolvedCount)
                VALUES ($op, $plan, $i, $name, $target, $params, $rc);
                """;
            oc.Parameters.AddWithValue("$op", op.Id);
            oc.Parameters.AddWithValue("$plan", plan.PlanId);
            oc.Parameters.AddWithValue("$i", i);
            oc.Parameters.AddWithValue("$name", op.Op);
            // Both arms must be typed `object` â€” a bare conditional between DBNull and
            // string has no common type and will not compile.
            oc.Parameters.AddWithValue("$target",
                op.Target == null ? (object)DBNull.Value : IrJson.Serialize(op.Target));
            oc.Parameters.AddWithValue("$params", op.Params.ToString() ?? "{}");
            oc.Parameters.AddWithValue("$rc", op.Resolved?.Count ?? 0);
            await oc.ExecuteNonQueryAsync();
        }

        await tx.CommitAsync();
    }

    public async Task SaveVerifyAsync(string planId, VerifyReport r)
    {
        await using var db = await OpenAsync();
        var cmd = db.CreateCommand();
        cmd.CommandText = """
            INSERT OR REPLACE INTO verify
                (planId, passed, rolledBack, errorsBefore, errorsAfter,
                 massBeforeG, massAfterG, interferences, elapsedMs, checksJson, appliedAtUtc)
            VALUES ($id, $p, $rb, $eb, $ea, $mb, $ma, $itf, $ms, $checks, $t);

            UPDATE plans SET status = $status WHERE planId = $id;
            """;
        cmd.Parameters.AddWithValue("$id", planId);
        cmd.Parameters.AddWithValue("$p", r.Passed ? 1 : 0);
        cmd.Parameters.AddWithValue("$rb", r.RolledBack ? 1 : 0);
        cmd.Parameters.AddWithValue("$eb", r.ErrorsBefore);
        cmd.Parameters.AddWithValue("$ea", r.ErrorsAfter);
        cmd.Parameters.AddWithValue("$mb", r.MassBeforeG);
        cmd.Parameters.AddWithValue("$ma", r.MassAfterG);
        cmd.Parameters.AddWithValue("$itf", r.Interferences);
        cmd.Parameters.AddWithValue("$ms", r.ElapsedMs);
        cmd.Parameters.AddWithValue("$checks", IrJson.Serialize(r.Checks));
        cmd.Parameters.AddWithValue("$t", DateTime.UtcNow.ToString("O"));
        cmd.Parameters.AddWithValue("$status", r.RolledBack ? "rolled_back" : r.Passed ? "applied" : "failed");
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<List<Dictionary<string, object?>>> RecentPlansAsync(string? docPath, int limit)
    {
        await using var db = await OpenAsync();
        var cmd = db.CreateCommand();
        cmd.CommandText = docPath is { Length: > 0 }
            ? """
              SELECT p.*, v.passed, v.massBeforeG, v.massAfterG, v.errorsAfter, v.elapsedMs
              FROM plans p LEFT JOIN verify v ON v.planId = p.planId
              WHERE p.docPath = $doc ORDER BY p.createdAtUtc DESC LIMIT $n;
              """
            : """
              SELECT p.*, v.passed, v.massBeforeG, v.massAfterG, v.errorsAfter, v.elapsedMs
              FROM plans p LEFT JOIN verify v ON v.planId = p.planId
              ORDER BY p.createdAtUtc DESC LIMIT $n;
              """;
        if (docPath is { Length: > 0 }) cmd.Parameters.AddWithValue("$doc", docPath);
        cmd.Parameters.AddWithValue("$n", limit);

        var rows = new List<Dictionary<string, object?>>();
        await using var rd = await cmd.ExecuteReaderAsync();
        while (await rd.ReadAsync())
        {
            var row = new Dictionary<string, object?>(rd.FieldCount);
            for (int i = 0; i < rd.FieldCount; i++)
                row[rd.GetName(i)] = rd.IsDBNull(i) ? null : rd.GetValue(i);
            rows.Add(row);
        }
        return rows;
    }

    private Task<SqliteConnection> OpenAsync() => OpenConnectionAsync();

    /// <summary>
    /// Opens a connection to the same database. Exposed so services that own their own
    /// tables — the checkpoint service, for one — share this store's file and migrations
    /// rather than standing up a second database that could drift out of step with it.
    /// The caller owns the connection and must dispose it.
    /// </summary>
    public async Task<SqliteConnection> OpenConnectionAsync()
    {
        var db = new SqliteConnection(_connectionString);
        await db.OpenAsync();
        return db;
    }

    private static async Task Exec(SqliteConnection db, string sql)
    {
        var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        await cmd.ExecuteNonQueryAsync();
    }
}

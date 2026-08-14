using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Datum.Contracts;
using Datum.Orchestrator.Planning;
using Datum.Orchestrator.Security;
using Datum.Orchestrator.Storage;
using Datum.Orchestrator.Transport;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

// ─────────────────────────────────────────────────────────────────────────────
//  DATUM Orchestrator
//
//  Loopback-only. Listens on 127.0.0.1 with a random high port and a per-session
//  bearer token; nothing is reachable from the network. Survives a SOLIDWORKS crash,
//  which is why history and queued batches are not lost when the CAD app goes down.
// ─────────────────────────────────────────────────────────────────────────────

var builder = WebApplication.CreateSlimBuilder(args);

int port = FindFreePort();
string token = Guid.NewGuid().ToString("N");

builder.WebHost.ConfigureKestrel(k =>
{
    k.Listen(IPAddress.Loopback, port);
    k.AddServerHeader = false;
    k.Limits.MaxRequestBodySize = 64 * 1024 * 1024;   // image and PDF attachments
});

builder.Logging.SetMinimumLevel(LogLevel.Information);

// Minimal APIs do NOT use IrJson.Options — they use their own. Without this, `PlanMode`
// arrives from the UI as the string "Edit" and fails to bind to the enum, so every
// /api/apply and /api/plan call 400s. Keep these in step with IrJson.Create().
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    o.SerializerOptions.PropertyNameCaseInsensitive = true;
    o.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
    o.SerializerOptions.NumberHandling = JsonNumberHandling.AllowReadingFromString;
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

builder.Services.AddSingleton<SessionHub>();
builder.Services.AddSingleton<Store>();
builder.Services.AddSingleton(new Policy());
builder.Services.AddSingleton<PlanValidator>();
builder.Services.AddSingleton<ProviderRouter>();
builder.Services.AddSingleton<KernelGateway>();
builder.Services.AddHttpClient();

// Recovery and secrets. Both are constructed here rather than lazily so a broken data
// directory surfaces at startup instead of at the moment a user needs to restore.
builder.Services.AddSingleton(sp => new CheckpointService(
    Path.Combine(DataDirectory(), "checkpoints"),
    sp.GetRequiredService<Store>().OpenConnectionAsync,
    sp.GetRequiredService<ILogger<CheckpointService>>()));

builder.Services.AddSingleton(sp => new CredentialStore(
    CredentialStore.DefaultPath(),
    sp.GetRequiredService<ILogger<CredentialStore>>()));

var app = builder.Build();

var log = app.Services.GetRequiredService<ILogger<Program>>();
var hub = app.Services.GetRequiredService<SessionHub>();
var store = app.Services.GetRequiredService<Store>();
var router = app.Services.GetRequiredService<ProviderRouter>();
var validator = app.Services.GetRequiredService<PlanValidator>();
var gateway = app.Services.GetRequiredService<KernelGateway>();
var checkpoints = app.Services.GetRequiredService<CheckpointService>();
var credentials = app.Services.GetRequiredService<CredentialStore>();

await store.InitialiseAsync();
await ConfigureProvidersAsync(app, router, credentials, log);
gateway.Start();

WriteHandshakeFile(port, token);
log.LogInformation("DATUM orchestrator listening on http://127.0.0.1:{Port}", port);

app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });

// Every route except the handshake requires the session token.
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path.StartsWithSegments("/health")) { await next(); return; }

    string? provided = ctx.Request.Headers.Authorization.ToString().Replace("Bearer ", "")
                       is { Length: > 0 } h ? h : ctx.Request.Query["token"].ToString();

    if (provided != token)
    {
        ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return;
    }
    await next();
});

// ── routes ───────────────────────────────────────────────────────────────────

app.MapGet("/health", () => Results.Json(new { ok = true, port }));

app.MapGet("/ws", async (HttpContext ctx, string? surface) =>
{
    if (!ctx.WebSockets.IsWebSocketRequest)
    {
        ctx.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }
    using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
    await hub.HandleAsync(socket, surface ?? "panel", ctx.RequestAborted);
});

app.MapGet("/api/context", async () =>
{
    var res = await gateway.CallAsync(new KernelCommand { Verb = KernelCommand.GetContext });
    return res.Ok ? Results.Json(res.Body) : Results.Json(res, statusCode: 503);
});

app.MapGet("/api/providers", () => Results.Json(router.Providers.Select(p => new
{
    id = p.Id,
    model = p.ModelId,
    kind = p.Kind.ToString(),
    available = p.IsAvailable,
    maxReliableOps = p.MaxReliableOps
})));

// Plan → validate → resolve. Mutates nothing; a rejected plan costs the user nothing.
app.MapPost("/api/plan", async (PlanApiRequest req, CancellationToken ct) =>
{
    var ctxRes = await gateway.CallAsync(new KernelCommand { Verb = KernelCommand.GetContext });
    if (!ctxRes.Ok)
        return Results.Json(new { ok = false, error = "SOLIDWORKS is not connected." }, statusCode: 503);

    var context = ctxRes.Body.Deserialize<ModelContext>(IrJson.Options) ?? new ModelContext();
    var mode = Enum.TryParse<PlanMode>(req.Mode, true, out var m) ? m : PlanMode.Edit;

    var outcome = await router.PlanAsync(
        new PlanRequest(req.Prompt, mode, context, req.Attachments ?? Array.Empty<string>(), req.ProviderId), ct);

    if (!outcome.Ok || outcome.Plan == null)
        return Results.Json(new
        {
            ok = false,
            error = outcome.Error,
            exceededCapability = outcome.ExceededCapability,
            partialOps = outcome.PartialOps,
            totalOps = outcome.TotalOps,
            alternatives = router.Providers
                .Where(p => p.IsAvailable && p.Kind != ProviderKind.Local)
                .Select(p => new { p.Id, p.ModelId, kind = p.Kind.ToString() })
        });

    var plan = outcome.Plan;
    plan.Target.DocPath = context.DocPath ?? "";
    plan.Target.Configuration = context.Configuration;
    if (string.IsNullOrWhiteSpace(plan.Undo.GroupName))
        plan.Undo.GroupName = "DATUM: " + plan.Intent;

    var validation = validator.Validate(plan, mode, context);
    if (!validation.Ok)
        return Results.Json(new { ok = false, error = "Plan validation failed.", issues = validation.Issues });

    // Read-only resolve inside SOLIDWORKS: this is what fills in the affected counts
    // the preview shows before the user commits to anything.
    var resolve = await gateway.CallAsync(new KernelCommand
    {
        Verb = KernelCommand.ResolvePlan,
        Body = JsonSerializer.SerializeToElement(new { plan, mode }, IrJson.Options)
    });

    if (!resolve.Ok)
        return Results.Json(new { ok = false, error = resolve.Error?.Message, detail = resolve.Error });

    var resolved = resolve.Body.GetProperty("plan").Deserialize<Plan>(IrJson.Options) ?? plan;
    await store.SavePlanAsync(resolved, mode.ToString());

    return Results.Json(new { ok = true, plan = resolved, issues = validation.Issues });
});

// The only mutating route. Everything upstream of it is read-only by construction.
/// The only mutating route, and the only place a checkpoint is taken.
app.MapPost("/api/apply", async (ApplyApiRequest req) =>
{
    // Snapshot BEFORE anything touches the document. Undo depends on SOLIDWORKS still
    // running and its stack being intact; neither survives a crash mid-plan. This does.
    //
    // Content addressing makes it cheap enough to do unconditionally, which matters —
    // a safety net the user has to remember to switch on is not a safety net.
    CheckpointService.Checkpoint? checkpoint = null;
    string docPath = req.Plan.Target.DocPath ?? "";

    if (!string.IsNullOrEmpty(docPath))
    {
        try
        {
            checkpoint = await checkpoints.CaptureAsync(docPath, req.Plan.PlanId);
        }
        catch (Exception ex)
        {
            // A failed checkpoint must block the apply. Proceeding would mutate a
            // customer's model with no recovery path, which is the one thing this
            // pipeline exists to prevent.
            log.LogError(ex, "Checkpoint failed for {Path}; refusing to apply.", docPath);
            return Results.Json(new
            {
                ok = false,
                error = new
                {
                    code = "checkpoint_failed",
                    message = "Could not create a recovery checkpoint, so the plan was not applied. " +
                              "Check disk space and that the file is not locked.",
                },
            }, statusCode: 507);
        }
    }

    var res = await gateway.CallAsync(new KernelCommand
    {
        Verb = KernelCommand.ApplyPlan,
        Body = JsonSerializer.SerializeToElement(new { plan = req.Plan, mode = req.Mode }, IrJson.Options)
    });

    if (res.Ok)
    {
        var report = res.Body.Deserialize<VerifyReport>(IrJson.Options);
        if (report != null)
        {
            report.SnapshotId = checkpoint?.CheckpointId;
            await store.SaveVerifyAsync(req.Plan.PlanId, report);
        }
        await hub.BroadcastAsync("plan.applied",
            new { planId = req.Plan.PlanId, report, checkpointId = checkpoint?.CheckpointId });
        return Results.Json(new { ok = true, report, checkpointId = checkpoint?.CheckpointId });
    }

    await hub.BroadcastAsync("plan.failed",
        new { planId = req.Plan.PlanId, error = res.Error, checkpointId = checkpoint?.CheckpointId });

    // Surface the checkpoint on failure too. The kernel rolls back via the undo scope,
    // but if that itself failed this is the user's remaining route back.
    return Results.Json(new { ok = false, error = res.Error, checkpointId = checkpoint?.CheckpointId });
});

app.MapGet("/api/checkpoints", async (string? docPath) =>
    Results.Json(await checkpoints.ListAsync(docPath)));

app.MapPost("/api/checkpoints/{id}/restore", async (string id) =>
{
    bool ok = await checkpoints.RestoreAsync(id);
    if (ok) await hub.BroadcastAsync("checkpoint.restored", new { checkpointId = id });

    return ok
        ? Results.Json(new { ok = true })
        : Results.Json(new
        {
            ok = false,
            error = "Checkpoint could not be restored. The stored copy may have been pruned, " +
                    "or the file is locked by SOLIDWORKS — close the document and retry.",
        }, statusCode: 409);
});

app.MapPost("/api/param", async (SetParamRequest req) =>
{
    // Fast path for slider drags: no planner, no validation round trip, no tokens.
    var res = await gateway.CallAsync(new KernelCommand
    {
        Verb = KernelCommand.SetParam,
        Body = JsonSerializer.SerializeToElement(req, IrJson.Options)
    });
    return res.Ok ? Results.Json(res.Body) : Results.Json(res, statusCode: 400);
});

app.MapPost("/api/highlight", async (HighlightRequest req) =>
{
    var res = await gateway.CallAsync(new KernelCommand
    {
        Verb = req.Pids.Length == 0 ? KernelCommand.ClearHighlight : KernelCommand.Highlight,
        Body = JsonSerializer.SerializeToElement(new { pids = req.Pids }, IrJson.Options)
    });
    return Results.Json(new { ok = res.Ok });
});

app.MapPost("/api/undo", async () =>
{
    var res = await gateway.CallAsync(new KernelCommand { Verb = KernelCommand.Undo });
    return Results.Json(new { ok = res.Ok });
});

app.MapPost("/api/cancel", async () =>
{
    var res = await gateway.CallAsync(new KernelCommand { Verb = KernelCommand.CancelPlan });
    return Results.Json(new { ok = res.Ok });
});

// `limit` is nullable so that omitting it is a default rather than a 400 from the
// parameter binder.
app.MapGet("/api/history", async (string? docPath, int? limit) =>
    Results.Json(await store.RecentPlansAsync(docPath, Math.Clamp(limit ?? 50, 1, 500))));

// Serve the built UI so the Studio shell and any browser can load the same bundle.
string uiDir = Path.Combine(AppContext.BaseDirectory, "ui");
if (Directory.Exists(uiDir))
{
    app.UseDefaultFiles(new DefaultFilesOptions
    {
        FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(uiDir)
    });
    app.UseStaticFiles(new StaticFileOptions
    {
        FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(uiDir)
    });
}

await app.RunAsync();

// ─────────────────────────────────────────────────────────────────────────────

/// <summary>Per-user data root. Everything DATUM writes lives under here.</summary>
static string DataDirectory() => Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DATUM");

static int FindFreePort()
{
    var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
    l.Start();
    int p = ((IPEndPoint)l.LocalEndpoint).Port;
    l.Stop();
    return p;
}

/// <summary>
/// The kernel and the Studio shell discover the orchestrator through this file rather
/// than a fixed port, so several SOLIDWORKS seats can run side by side. It is written
/// to the user's own LocalAppData, which is already ACL'd to them.
/// </summary>
static void WriteHandshakeFile(int port, string token)
{
    string dir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DATUM");
    Directory.CreateDirectory(dir);
    File.WriteAllText(Path.Combine(dir, "session.json"),
        JsonSerializer.Serialize(new { port, token, pid = Environment.ProcessId }));
}

static async Task ConfigureProvidersAsync(
    WebApplication app,
    ProviderRouter router,
    CredentialStore credentials,
    ILogger log)
{
    var factory = app.Services.GetRequiredService<IHttpClientFactory>();
    var http = factory.CreateClient();
    http.Timeout = TimeSpan.FromMinutes(4);

    // One-time migration: keys previously configured as environment variables are
    // encrypted on first run. Environment variables leak into child processes and crash
    // dumps, so they stop being a secret's resting place.
    credentials.ImportFromEnvironment();

    // Local first: the default on a fresh install and the only provider that works
    // offline, so it is always registered even when the endpoint is down.
    var local = new LocalPlanProvider(
        Environment.GetEnvironmentVariable("DATUM_LOCAL_ENDPOINT") ?? "http://127.0.0.1:8080",
        Environment.GetEnvironmentVariable("DATUM_LOCAL_MODEL") ?? "qwen2.5-coder-14b-instruct-q4_k_m",
        http, log);
    await local.ProbeAsync(CancellationToken.None);
    router.Register(local);

    // BYO key: the user pays the model vendor directly and DATUM takes no cut.
    string? byoKey = credentials.Resolve("byo-anthropic");
    if (!string.IsNullOrEmpty(byoKey))
        router.Register(new AnthropicPlanProvider(
            "byo-anthropic", "claude-sonnet-5", ProviderKind.ByoKey, byoKey, http, log));

    // Managed Pro.
    string? proKey = credentials.Resolve("pro");
    if (!string.IsNullOrEmpty(proKey))
        router.Register(new AnthropicPlanProvider(
            "pro", "claude-opus-5", ProviderKind.Managed, proKey, http, log));

    // Azure: for customers whose policy forbids a public endpoint but permits a model
    // deployed inside their own tenancy.
    string? azureKey = credentials.Resolve("azure");
    string? azureEndpoint = Environment.GetEnvironmentVariable("AZURE_OPENAI_ENDPOINT");
    if (!string.IsNullOrEmpty(azureKey) && !string.IsNullOrEmpty(azureEndpoint))
        router.Register(new AzureOpenAiProvider(
            azureEndpoint,
            Environment.GetEnvironmentVariable("AZURE_OPENAI_DEPLOYMENT") ?? "gpt-4o",
            azureKey, http, log));
}

// ── request DTOs ─────────────────────────────────────────────────────────────

public sealed record PlanApiRequest(string Prompt, string Mode, string[]? Attachments, string? ProviderId);
public sealed record ApplyApiRequest(Plan Plan, PlanMode Mode);
public sealed record SetParamRequest(string Name, double Value, string Units, bool DeferRebuild);
public sealed record HighlightRequest(string[] Pids);

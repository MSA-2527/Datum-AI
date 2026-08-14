using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Datum.Contracts;
using Microsoft.Extensions.Logging;

namespace Datum.Orchestrator.Planning;

public enum ProviderKind { Local, ByoKey, Managed }

public sealed record PlanRequest(
    string Prompt,
    PlanMode Mode,
    ModelContext Context,
    IReadOnlyList<string> AttachmentPaths,
    string? PreferredProviderId = null);

public sealed record PlanOutcome(
    Plan? Plan,
    bool Ok,
    string? Error = null,
    bool ExceededCapability = false,
    int PartialOps = 0,
    int TotalOps = 0);

public interface IPlanProvider
{
    string Id { get; }
    string ModelId { get; }
    ProviderKind Kind { get; }
    bool IsAvailable { get; }
    /// <summary>Rough ceiling on plan complexity this provider handles reliably.</summary>
    int MaxReliableOps { get; }
    Task<PlanOutcome> PlanAsync(PlanRequest request, CancellationToken ct);
}

/// <summary>
/// Chooses a provider per request and degrades honestly.
///
/// The tiering rule from the spec: the deterministic core is free and needs no model at
/// all; the planner is the only pluggable piece. When a request exceeds local capability
/// the router does NOT silently fail or silently upsell — it reports what the local model
/// managed and offers the alternatives, including running the partial plan.
/// </summary>
public sealed class ProviderRouter
{
    private readonly List<IPlanProvider> _providers = new();
    private readonly ILogger<ProviderRouter> _log;

    public ProviderRouter(ILogger<ProviderRouter> log) { _log = log; }

    public void Register(IPlanProvider p)
    {
        _providers.Add(p);
        _log.LogInformation("Provider registered: {Id} ({Kind}, {Model})", p.Id, p.Kind, p.ModelId);
    }

    public IReadOnlyList<IPlanProvider> Providers => _providers;

    public IPlanProvider? Resolve(string? preferredId)
    {
        if (!string.IsNullOrEmpty(preferredId))
        {
            var exact = _providers.FirstOrDefault(p => p.Id == preferredId && p.IsAvailable);
            if (exact != null) return exact;
        }

        // Managed first when present, then BYO key, then local. Local is always the
        // fallback because it works offline and costs nothing.
        return _providers.Where(p => p.IsAvailable)
                         .OrderBy(p => p.Kind switch
                         {
                             ProviderKind.Managed => 0,
                             ProviderKind.ByoKey => 1,
                             _ => 2
                         })
                         .FirstOrDefault();
    }

    public async Task<PlanOutcome> PlanAsync(PlanRequest req, CancellationToken ct)
    {
        var provider = Resolve(req.PreferredProviderId);
        if (provider == null)
            return new PlanOutcome(null, false,
                "No planner is configured. Add an API key, download a local model, " +
                "or use Skills and the Parameter Inspector, which need no model at all.");

        var outcome = await provider.PlanAsync(req, ct);

        if (!outcome.Ok && outcome.ExceededCapability && provider.Kind == ProviderKind.Local)
        {
            var better = _providers.FirstOrDefault(p => p.IsAvailable && p.Kind != ProviderKind.Local);
            if (better != null)
                _log.LogInformation("Local planner declined; {Better} is available for escalation.", better.Id);
        }

        return outcome;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Managed / BYO-key provider (Anthropic Messages API with tool use)
// ─────────────────────────────────────────────────────────────────────────────

public sealed class AnthropicPlanProvider : IPlanProvider
{
    private readonly HttpClient _http;
    private readonly ILogger _log;
    private readonly string? _apiKey;

    public string Id { get; }
    public string ModelId { get; }
    public ProviderKind Kind { get; }
    public bool IsAvailable => !string.IsNullOrEmpty(_apiKey);
    public int MaxReliableOps => 200;

    public AnthropicPlanProvider(string id, string modelId, ProviderKind kind,
                                 string? apiKey, HttpClient http, ILogger log)
    {
        Id = id; ModelId = modelId; Kind = kind;
        _apiKey = apiKey; _http = http; _log = log;
    }

    public async Task<PlanOutcome> PlanAsync(PlanRequest req, CancellationToken ct)
    {
        try
        {
            var body = new
            {
                model = ModelId,
                max_tokens = 8192,
                system = PlannerPrompt.Build(req.Mode),
                tools = new object[] { PlannerPrompt.EmitPlanTool() },
                tool_choice = new { type = "tool", name = "emit_plan" },
                messages = new object[]
                {
                    new
                    {
                        role = "user",
                        content = PlannerPrompt.BuildUserMessage(req)
                    }
                }
            };

            using var msg = new HttpRequestMessage(HttpMethod.Post, "https://api.anthropic.com/v1/messages");
            msg.Headers.Add("x-api-key", _apiKey);
            msg.Headers.Add("anthropic-version", "2023-06-01");
            msg.Content = JsonContent.Create(body);

            using var res = await _http.SendAsync(msg, ct);
            string json = await res.Content.ReadAsStringAsync(ct);

            if (!res.IsSuccessStatusCode)
                return new PlanOutcome(null, false, $"Planner request failed ({(int)res.StatusCode}): {Truncate(json, 400)}");

            using var doc = JsonDocument.Parse(json);
            var content = doc.RootElement.GetProperty("content");

            foreach (var block in content.EnumerateArray())
            {
                if (block.GetProperty("type").GetString() != "tool_use") continue;

                var input = block.GetProperty("input");
                var plan = input.Deserialize<Plan>(IrJson.Options);
                if (plan == null) continue;

                plan.Provenance = new Provenance
                {
                    ProviderId = Id,
                    ModelId = ModelId,
                    PromptTokens = doc.RootElement.GetProperty("usage").GetProperty("input_tokens").GetInt32(),
                    CompletionTokens = doc.RootElement.GetProperty("usage").GetProperty("output_tokens").GetInt32()
                };
                return new PlanOutcome(plan, true, TotalOps: plan.Ops.Count);
            }

            return new PlanOutcome(null, false, "The planner returned no plan.");
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            _log.LogError(ex, "Anthropic planner failed.");
            return new PlanOutcome(null, false, ex.Message);
        }
    }

    private static string Truncate(string s, int n) => s.Length <= n ? s : s[..n] + "…";
}

// ─────────────────────────────────────────────────────────────────────────────
//  Local provider (llama.cpp server, grammar-constrained)
// ─────────────────────────────────────────────────────────────────────────────

/// <summary>
/// Talks to a local llama.cpp / Ollama-compatible endpoint with GBNF grammar
/// constraints generated from the operation vocabulary.
///
/// The grammar is the whole reason a 7–14B model is viable here: it physically cannot
/// emit a malformed operation or a name outside the catalogue, so the failure mode
/// becomes "the plan is wrong" (which preview catches) rather than "the plan is garbage".
/// </summary>
public sealed class LocalPlanProvider : IPlanProvider
{
    private readonly HttpClient _http;
    private readonly ILogger _log;
    private readonly string _endpoint;

    public string Id => "local";
    public string ModelId { get; }
    public ProviderKind Kind => ProviderKind.Local;
    public bool IsAvailable { get; private set; }
    public int MaxReliableOps => 8;

    public LocalPlanProvider(string endpoint, string modelId, HttpClient http, ILogger log)
    {
        _endpoint = endpoint.TrimEnd('/');
        ModelId = modelId;
        _http = http;
        _log = log;
    }

    public async Task ProbeAsync(CancellationToken ct)
    {
        try
        {
            using var res = await _http.GetAsync(_endpoint + "/health", ct);
            IsAvailable = res.IsSuccessStatusCode;
        }
        catch { IsAvailable = false; }

        _log.LogInformation("Local planner at {Endpoint}: {State}",
            _endpoint, IsAvailable ? "available" : "unavailable");
    }

    public async Task<PlanOutcome> PlanAsync(PlanRequest req, CancellationToken ct)
    {
        // Honest capability gate. Assembly-scale and long dependent chains are beyond a
        // small local model; saying so up front beats burning 40 seconds to produce a
        // plan that fails at preview.
        if (req.Mode == PlanMode.Build && LooksLikeAssemblyWork(req.Prompt))
            return new PlanOutcome(null, false,
                "Assembly generation and mating strategy need a frontier model.",
                ExceededCapability: true);

        try
        {
            var body = new
            {
                model = ModelId,
                prompt = PlannerPrompt.Build(req.Mode) + "\n\n" +
                         PlannerPrompt.BuildUserMessage(req) + "\n\nJSON plan:\n",
                grammar = GbnfGrammar.ForOperationIr(),
                temperature = 0.2,
                n_predict = 2048,
                stream = false
            };

            using var res = await _http.PostAsJsonAsync(_endpoint + "/completion", body, ct);
            if (!res.IsSuccessStatusCode)
                return new PlanOutcome(null, false, $"Local planner returned {(int)res.StatusCode}.");

            string raw = await res.Content.ReadAsStringAsync(ct);
            using var doc = JsonDocument.Parse(raw);
            string content = doc.RootElement.TryGetProperty("content", out var c)
                ? c.GetString() ?? "" : raw;

            var plan = IrJson.Deserialize<Plan>(content);
            if (plan == null)
                return new PlanOutcome(null, false, "The local model produced an unparseable plan.");

            plan.Provenance = new Provenance { ProviderId = Id, ModelId = ModelId };

            if (plan.Ops.Count > MaxReliableOps)
                return new PlanOutcome(plan, false,
                    $"This plan needs {plan.Ops.Count} operations; the local model is reliable to about {MaxReliableOps}.",
                    ExceededCapability: true, PartialOps: MaxReliableOps, TotalOps: plan.Ops.Count);

            return new PlanOutcome(plan, true, TotalOps: plan.Ops.Count);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            _log.LogError(ex, "Local planner failed.");
            return new PlanOutcome(null, false, ex.Message);
        }
    }

    private static bool LooksLikeAssemblyWork(string prompt)
    {
        string p = prompt.ToLowerInvariant();
        return p.Contains("assembly") || p.Contains("mate ") || p.Contains("enclosure") ||
               p.Contains("mechanism") || p.Contains("linkage");
    }
}

using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Datum.Contracts;
using Microsoft.Extensions.Logging;

namespace Datum.Orchestrator.Planning;

/// <summary>
/// Azure OpenAI planner.
///
/// Present because enterprise CAD customers are frequently the ones who cannot send
/// geometry to a public API endpoint, but can use a model deployed inside their own Azure
/// tenancy. Without it, the honest answer for those users is "local model only", which
/// gives up a lot of planning quality for a policy reason rather than a technical one.
///
/// Structured output is enforced with a JSON-schema response format rather than trusting
/// prose parsing, so the same closed operation vocabulary applies here as everywhere else.
/// </summary>
public sealed class AzureOpenAiProvider : IPlanProvider
{
    private readonly HttpClient _http;
    private readonly ILogger _log;
    private readonly string? _apiKey;
    private readonly string _endpoint;
    private readonly string _deployment;
    private readonly string _apiVersion;

    public string Id => "azure";
    public string ModelId => _deployment;
    public ProviderKind Kind => ProviderKind.Managed;
    public bool IsAvailable => !string.IsNullOrEmpty(_apiKey) && !string.IsNullOrEmpty(_endpoint);
    public int MaxReliableOps => 200;

    public AzureOpenAiProvider(
        string endpoint,
        string deployment,
        string? apiKey,
        HttpClient http,
        ILogger log,
        string apiVersion = "2024-10-21")
    {
        _endpoint = endpoint.TrimEnd('/');
        _deployment = deployment;
        _apiKey = apiKey;
        _http = http;
        _log = log;
        _apiVersion = apiVersion;
    }

    public async Task<PlanOutcome> PlanAsync(PlanRequest request, CancellationToken ct)
    {
        if (!IsAvailable)
            return new PlanOutcome(null, false, "Azure OpenAI is not configured (endpoint or key missing).");

        try
        {
            var body = new
            {
                messages = new object[]
                {
                    new { role = "system", content = PlannerPrompt.Build(request.Mode) },
                    new { role = "user", content = PlannerPrompt.BuildUserMessage(request) },
                },
                // Enforced structured output. Prose parsing would reintroduce exactly the
                // failure mode the typed IR exists to eliminate.
                response_format = new
                {
                    type = "json_schema",
                    json_schema = new
                    {
                        name = "operation_plan",
                        strict = false,
                        schema = PlanJsonSchema(),
                    },
                },
                temperature = 0.2,
                max_tokens = 8192,
            };

            string url = $"{_endpoint}/openai/deployments/{_deployment}/chat/completions?api-version={_apiVersion}";

            using var msg = new HttpRequestMessage(HttpMethod.Post, url);
            msg.Headers.Add("api-key", _apiKey);
            msg.Content = JsonContent.Create(body);

            using var res = await _http.SendAsync(msg, ct);
            string raw = await res.Content.ReadAsStringAsync(ct);

            if (!res.IsSuccessStatusCode)
                return new PlanOutcome(null, false,
                    $"Azure OpenAI returned {(int)res.StatusCode}: {Truncate(raw, 300)}");

            using var doc = JsonDocument.Parse(raw);
            string? content = doc.RootElement
                .GetProperty("choices")[0]
                .GetProperty("message")
                .GetProperty("content")
                .GetString();

            if (string.IsNullOrWhiteSpace(content))
                return new PlanOutcome(null, false, "Azure OpenAI returned an empty response.");

            var plan = IrJson.Deserialize<Plan>(content!);
            if (plan is null)
                return new PlanOutcome(null, false, "Azure OpenAI returned an unparseable plan.");

            plan.Provenance = new Provenance
            {
                ProviderId = Id,
                ModelId = _deployment,
                PromptTokens = ReadUsage(doc, "prompt_tokens"),
                CompletionTokens = ReadUsage(doc, "completion_tokens"),
            };

            return new PlanOutcome(plan, true, TotalOps: plan.Ops.Count);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            _log.LogError(ex, "Azure OpenAI planner failed.");
            return new PlanOutcome(null, false, ex.Message);
        }
    }

    private static int ReadUsage(JsonDocument doc, string field) =>
        doc.RootElement.TryGetProperty("usage", out var usage) && usage.TryGetProperty(field, out var v)
            ? v.GetInt32()
            : 0;

    /// <summary>
    /// Plan schema for structured output. The operation enum is generated from the
    /// catalogue, so the model physically cannot name an operation the executor does not
    /// implement.
    /// </summary>
    private static object PlanJsonSchema() => new
    {
        type = "object",
        required = new[] { "intent", "ops" },
        properties = new Dictionary<string, object>
        {
            ["intent"] = new { type = "string" },
            ["assumptions"] = new { type = "array", items = new { type = "string" } },
            ["ops"] = new
            {
                type = "array",
                items = new
                {
                    type = "object",
                    required = new[] { "id", "op" },
                    properties = new Dictionary<string, object>
                    {
                        ["id"] = new { type = "string" },
                        ["op"] = new { type = "string", @enum = System.Linq.Enumerable.ToArray(OpCatalog.AllNames) },
                        ["dependsOn"] = new { type = "array", items = new { type = "string" } },
                        ["target"] = new { type = "object" },
                        ["params"] = new { type = "object" },
                    },
                },
            },
        },
    };

    private static string Truncate(string s, int n) => s.Length <= n ? s : s[..n] + "…";
}

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Datum.Contracts;

namespace Datum.Orchestrator.Planning;

/// <summary>
/// Deterministic planner for tests and offline development.
///
/// Everything downstream of the planner — validation, resolution, execution, verification,
/// rollback — is the part that decides whether a plan may touch a customer's model. That
/// machinery should be testable without a network call, an API key, or the non-determinism
/// of a language model, so this provider produces a fixed plan for a fixed prompt.
///
/// It is registered only when explicitly asked for. A mock silently serving real users
/// would be far worse than no provider at all, so it never appears in the default routing
/// order and reports its kind honestly.
/// </summary>
public sealed class MockPlanProvider : IPlanProvider
{
    private readonly Dictionary<string, Func<PlanRequest, Plan>> _canned;

    public string Id => "mock";
    public string ModelId => "mock-deterministic";
    public ProviderKind Kind => ProviderKind.Local;
    public bool IsAvailable { get; set; } = true;
    public int MaxReliableOps => 64;

    /// <summary>Forced outcome for failure-path tests. Null means plan normally.</summary>
    public PlanOutcome? ForcedOutcome { get; set; }

    /// <summary>Number of times PlanAsync has been called, for asserting routing.</summary>
    public int CallCount { get; private set; }

    public MockPlanProvider()
    {
        _canned = new Dictionary<string, Func<PlanRequest, Plan>>(StringComparer.OrdinalIgnoreCase)
        {
            ["fillet"] = r => Build(r, "Adds a 3 mm fillet to the outer edges.",
                new[] { "R3 chosen to match the existing corner radius" },
                Op("op1", "feature.fillet", new { radius = 3.0, propagate = true, units = "mm" })),

            ["hole"] = r => Build(r, "Adds an M3 clearance hole pattern.",
                new[] { "M3 clearance, normal fit", "Positions driven by the BoltCircle global" },
                Op("op1", "feature.hole_wizard",
                    new { standard = "ISO", fastener = "M3", fit = "normal", units = "mm" })),

            ["properties"] = r => Build(r, "Fills the empty custom properties.",
                Array.Empty<string>(),
                Op("op1", "doc.set_property", new { name = "Material", value = "6061-T6" })),
        };
    }

    public Task<PlanOutcome> PlanAsync(PlanRequest request, CancellationToken ct)
    {
        CallCount++;
        ct.ThrowIfCancellationRequested();

        if (ForcedOutcome is { } forced) return Task.FromResult(forced);

        foreach (var (keyword, factory) in _canned)
        {
            if (request.Prompt.Contains(keyword, StringComparison.OrdinalIgnoreCase))
            {
                var plan = factory(request);
                return Task.FromResult(new PlanOutcome(plan, true, TotalOps: plan.Ops.Count));
            }
        }

        // An unrecognised prompt is a planning failure, not an empty plan. Returning a
        // zero-op plan would make the pipeline report success for a request it did not
        // understand, which is the exact failure mode the verification layer exists to stop.
        return Task.FromResult(new PlanOutcome(
            null, false, $"The mock planner has no canned response for \"{request.Prompt}\"."));
    }

    private static Plan Build(PlanRequest r, string intent, IReadOnlyList<string> assumptions, params Operation[] ops)
    {
        var plan = new Plan
        {
            Intent = intent,
            Target = { DocPath = r.Context.DocPath ?? "", Configuration = r.Context.Configuration },
            Undo = { GroupName = "DATUM: " + intent },
            Provenance = new Provenance { ProviderId = "mock", ModelId = "mock-deterministic" },
        };
        plan.Assumptions.AddRange(assumptions);
        plan.Ops.AddRange(ops);
        plan.Verify.Add(new VerifyCheck { Check = "rebuild_errors", Expect = JsonSerializer.SerializeToElement(0) });
        return plan;
    }

    private static Operation Op(string id, string name, object parameters) => new()
    {
        Id = id,
        Op = name,
        Params = JsonSerializer.SerializeToElement(parameters, IrJson.Options),
    };
}

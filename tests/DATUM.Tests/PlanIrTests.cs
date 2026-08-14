using System.Text.Json;

namespace Datum.Tests;

/// <summary>
/// The Operation IR is the contract the whole safety model rests on. If a plan can
/// carry a dependency cycle, a dangling reference or a duplicate id past this layer,
/// the executor will discover it halfway through mutating a customer's model — which
/// is precisely the failure mode the architecture exists to prevent.
/// </summary>
public sealed class PlanIrTests
{
    private static Operation Op(string id, string op, params string[] dependsOn) => new()
    {
        Id = id,
        Op = op,
        DependsOn = dependsOn.Length == 0 ? null : new List<string>(dependsOn)
    };

    [Fact]
    public void TopologicalOrder_PutsDependenciesFirst()
    {
        var plan = new Plan
        {
            Ops =
            {
                Op("c", "feature.fillet", "b"),
                Op("a", "sketch.create"),
                Op("b", "feature.extrude", "a")
            }
        };

        var order = plan.TopologicalOrder().Select(o => o.Id).ToList();

        Assert.Equal(new[] { "a", "b", "c" }, order);
    }

    [Fact]
    public void TopologicalOrder_IsStableForIndependentOps()
    {
        // Independent operations must keep the planner's authored order. A planner that
        // emits "cut, then deburr" means it, even with no explicit dependency edge.
        var plan = new Plan
        {
            Ops = { Op("one", "sketch.line"), Op("two", "sketch.line"), Op("three", "sketch.line") }
        };

        Assert.Equal(new[] { "one", "two", "three" }, plan.TopologicalOrder().Select(o => o.Id));
    }

    [Fact]
    public void TopologicalOrder_RejectsCycles()
    {
        var plan = new Plan { Ops = { Op("a", "sketch.create", "b"), Op("b", "feature.extrude", "a") } };

        var ex = Assert.Throws<IrException>(() => plan.TopologicalOrder());
        Assert.Contains("Cyclic", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TopologicalOrder_RejectsSelfDependency()
    {
        var plan = new Plan { Ops = { Op("a", "sketch.create", "a") } };

        Assert.Throws<IrException>(() => plan.TopologicalOrder());
    }

    [Fact]
    public void TopologicalOrder_RejectsDanglingDependency()
    {
        var plan = new Plan { Ops = { Op("a", "feature.fillet", "ghost") } };

        var ex = Assert.Throws<IrException>(() => plan.TopologicalOrder());
        Assert.Contains("ghost", ex.Message);
    }

    [Fact]
    public void TopologicalOrder_RejectsDuplicateIds()
    {
        var plan = new Plan { Ops = { Op("a", "sketch.create"), Op("a", "feature.extrude") } };

        var ex = Assert.Throws<IrException>(() => plan.TopologicalOrder());
        Assert.Contains("Duplicate", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TopologicalOrder_HandlesDiamondDependenciesWithoutDuplicating()
    {
        var plan = new Plan
        {
            Ops =
            {
                Op("root", "sketch.create"),
                Op("left", "feature.extrude", "root"),
                Op("right", "feature.fillet", "root"),
                Op("join", "feature.combine", "left", "right")
            }
        };

        var order = plan.TopologicalOrder().Select(o => o.Id).ToList();

        Assert.Equal(4, order.Count);
        Assert.Equal(4, order.Distinct().Count());
        Assert.True(order.IndexOf("root") < order.IndexOf("left"));
        Assert.True(order.IndexOf("root") < order.IndexOf("right"));
        Assert.Equal("join", order[^1]);
    }

    [Fact]
    public void RequiresSnapshot_IsTrueOnlyForDestructiveVocabulary()
    {
        var benign = new Plan { Ops = { Op("a", "param.set_global"), Op("b", "feature.fillet") } };
        var destructive = new Plan { Ops = { Op("a", "param.set_global"), Op("b", "feature.edit.delete") } };

        Assert.False(benign.RequiresSnapshot());
        Assert.True(destructive.RequiresSnapshot());
    }

    [Fact]
    public void Plan_RoundTripsThroughJsonWithParamsIntact()
    {
        var plan = new Plan
        {
            Intent = "Add M3 clearance holes",
            Assumptions = { "ISO normal fit", "holes on the BoltCircle global" },
            Ops =
            {
                new Operation
                {
                    Id = "op1",
                    Op = "feature.hole_wizard",
                    Target = new OpTarget { Kind = TargetKind.Query, Query = "faces(planar, normal:+Z)" },
                    Params = JsonSerializer.SerializeToElement(new { fastener = "M3", diameter = 3.4 })
                }
            },
            Verify = { new VerifyCheck { Check = "mass_delta_pct", Max = 5 } }
        };

        var round = IrJson.Deserialize<Plan>(IrJson.Serialize(plan));

        Assert.NotNull(round);
        Assert.Equal(Plan.CurrentIrVersion, round!.IrVersion);
        Assert.Equal(plan.PlanId, round.PlanId);
        Assert.Equal("Add M3 clearance holes", round.Intent);
        Assert.Equal(2, round.Assumptions.Count);
        Assert.Equal(TargetKind.Query, round.Ops[0].Target!.Kind);
        Assert.Equal("faces(planar, normal:+Z)", round.Ops[0].Target!.Query);
        Assert.Equal(3.4, round.Ops[0].Params.GetProperty("diameter").GetDouble(), 6);
        Assert.Equal(5, round.Verify[0].Max);
    }

    [Fact]
    public void TargetKind_SerialisesAsAName_NotAnOrdinal()
    {
        // The planner's tool schema and the GBNF grammar both emit "Pid"/"Query" as
        // strings. If this ever became an integer, every model-authored plan would
        // silently deserialise as TargetKind.Pid.
        var json = IrJson.Serialize(new OpTarget { Kind = TargetKind.Selection, Selection = "*" });

        Assert.Contains("\"Selection\"", json);
        Assert.DoesNotContain("\"kind\":1", json);
    }

    [Fact]
    public void UnknownMembersAreToleratedSoANewerPlannerCannotBrickAnOlderKernel()
    {
        const string json = """
            { "planId":"pln_x", "intent":"hi", "ops":[], "somethingFromTheFuture": { "a": 1 } }
            """;

        var plan = IrJson.Deserialize<Plan>(json);

        Assert.NotNull(plan);
        Assert.Equal("pln_x", plan!.PlanId);
    }

    [Fact]
    public void NewPlanDefaultsToASnapshottedUndoGroup()
    {
        var plan = new Plan();

        Assert.True(plan.Undo.Snapshot);
        Assert.False(string.IsNullOrWhiteSpace(plan.Undo.GroupName));
        Assert.StartsWith("pln_", plan.PlanId);
    }
}

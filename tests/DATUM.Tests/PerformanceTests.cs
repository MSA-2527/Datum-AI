using System;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Datum.Tests;

/// <summary>
/// Performance regression tests for the hot paths.
///
/// These are not benchmarks — they are guard rails. The budgets are deliberately loose
/// (roughly 10× the measured cost) so they do not flake on a busy CI agent, while still
/// catching the kind of change that turns an O(1) write into an allocation or a copy.
///
/// The paths covered all sit between a SOLIDWORKS notification and the UI. If any of them
/// regresses badly the symptom is not a slow panel, it is a CAD application that stutters
/// — and the fastest way to get an add-in uninstalled is to make SOLIDWORKS feel slow.
/// </summary>
public sealed class WireProtocolPerformanceTests
{
    [Fact]
    public void DeltaEncodingStaysUnderBudgetForALargeBatch()
    {
        const int count = 512;
        var deltas = Enumerable.Range(0, count)
            .Select(i => new StateDelta
            {
                Kind = DeltaKind.FeatureAdded,
                DocId = 1,
                TargetId = i,
                NumA = i * 1.5,
                TimestampTicks = DateTime.UtcNow.Ticks,
                Text = $"Boss-Extrude{i}",
            })
            .ToArray();

        var buffer = new byte[DeltaCodec.MaxBatchSize(count)];

        // Warm up so JIT cost is not attributed to the measurement.
        for (int i = 0; i < 10; i++) DeltaCodec.Write(buffer, deltas);

        var sw = Stopwatch.StartNew();
        const int iterations = 200;
        for (int i = 0; i < iterations; i++) DeltaCodec.Write(buffer, deltas);
        sw.Stop();

        double perBatchUs = sw.Elapsed.TotalMilliseconds * 1000 / iterations;

        // A 512-delta batch is what a pattern rebuild produces. At 30 Hz the pump has
        // 33 ms per window; spending more than a fraction of a millisecond encoding
        // would mean the coalescing window is doing more work than the CAD event itself.
        Assert.True(perBatchUs < 2000,
            $"Encoding 512 deltas took {perBatchUs:F0} µs per batch; budget is 2000 µs.");
    }

    [Fact]
    public void DeltaRoundTripPreservesEveryFieldExactly()
    {
        var original = new StateDelta
        {
            Kind = DeltaKind.MassProperties,
            DocId = 42,
            TargetId = -7,
            NumA = 179.456,
            NumB = -0.00042,
            TimestampTicks = 638_000_000_000_000_000L,
            Text = "Boss-Extrude1",
        };

        var buffer = new byte[DeltaCodec.MaxBatchSize(1)];
        int written = DeltaCodec.Write(buffer, new[] { original });
        var decoded = DeltaCodec.Read(new ReadOnlySpan<byte>(buffer, 0, written));

        // Doubles must survive bit-exact: mass and bounding-box values ride this path and
        // a lossy round trip would show up as a verification failure with no cause.
        Assert.Single(decoded);
        Assert.Equal(original.Kind, decoded[0].Kind);
        Assert.Equal(original.DocId, decoded[0].DocId);
        Assert.Equal(original.TargetId, decoded[0].TargetId);
        Assert.Equal(original.NumA, decoded[0].NumA);
        Assert.Equal(original.NumB, decoded[0].NumB);
        Assert.Equal(original.TimestampTicks, decoded[0].TimestampTicks);
        Assert.Equal(original.Text, decoded[0].Text);
    }

    [Fact]
    public void EncodedSizeStaysProportionalToContent()
    {
        var small = new StateDelta { Kind = DeltaKind.RebuildDone, DocId = 1 };
        var large = new StateDelta { Kind = DeltaKind.FeatureAdded, DocId = 1, Text = new string('x', 200) };

        var buffer = new byte[DeltaCodec.MaxBatchSize(1)];

        int smallBytes = DeltaCodec.Write(buffer, new[] { small });
        int largeBytes = DeltaCodec.Write(buffer, new[] { large });

        // The fixed header is what makes the format cheap; if a change made every delta
        // pay for the largest possible payload this would catch it.
        Assert.True(smallBytes <= DeltaCodec.FixedSize + 2);
        Assert.True(largeBytes > smallBytes);
        Assert.True(largeBytes <= DeltaCodec.MaxDeltaSize + 2);
    }

    [Fact]
    public void UnicodeTextIsNeverSplitMidCharacter()
    {
        // Truncating an over-long label must respect UTF-8 boundaries, or the decoder
        // produces a replacement character in a feature name the user then cannot find.
        var delta = new StateDelta
        {
            Kind = DeltaKind.FeatureRenamed,
            DocId = 1,
            Text = string.Concat(Enumerable.Repeat("é", 400)), // 2 bytes each
        };

        var buffer = new byte[DeltaCodec.MaxBatchSize(1)];
        int written = DeltaCodec.Write(buffer, new[] { delta });
        var decoded = DeltaCodec.Read(new ReadOnlySpan<byte>(buffer, 0, written));

        Assert.DoesNotContain('\uFFFD', decoded[0].Text!);
    }
}

public sealed class CatalogPerformanceTests
{
    [Fact]
    public void CatalogueLookupIsConstantTime()
    {
        // The validator hits this once per operation per plan; a linear scan over ~200
        // entries would turn a 500-op plan into 100 000 string comparisons.
        var names = OpCatalog.AllNames.ToArray();

        for (int i = 0; i < 1000; i++) OpCatalog.Exists(names[i % names.Length]);

        var sw = Stopwatch.StartNew();
        const int iterations = 100_000;
        for (int i = 0; i < iterations; i++) OpCatalog.Exists(names[i % names.Length]);
        sw.Stop();

        double perLookupNs = sw.Elapsed.TotalMilliseconds * 1_000_000 / iterations;
        Assert.True(perLookupNs < 1000, $"Catalogue lookup took {perLookupNs:F0} ns; budget is 1000 ns.");
    }

    [Fact]
    public void GrammarGenerationIsCachedNotRebuiltPerCall()
    {
        // The GBNF grammar is derived from the whole catalogue. Rebuilding it on every
        // local-model request would add measurable latency to every prompt.
        string first = Datum.Orchestrator.Planning.GbnfGrammar.ForOperationIr();

        var sw = Stopwatch.StartNew();
        for (int i = 0; i < 1000; i++) Datum.Orchestrator.Planning.GbnfGrammar.ForOperationIr();
        sw.Stop();

        Assert.NotEmpty(first);
        Assert.True(sw.ElapsedMilliseconds < 100,
            $"1000 grammar fetches took {sw.ElapsedMilliseconds} ms; it should be cached.");
    }

    [Fact]
    public void TopologicalSortHandlesALargePlanQuickly()
    {
        var plan = new Plan { Intent = "large" };
        for (int i = 0; i < 500; i++)
        {
            var op = new Operation { Id = $"op{i}", Op = "feature.fillet" };
            if (i > 0) op.DependsOn = new() { $"op{i - 1}" };
            plan.Ops.Add(op);
        }

        var sw = Stopwatch.StartNew();
        var ordered = plan.TopologicalOrder();
        sw.Stop();

        Assert.Equal(500, ordered.Count);
        // A deep chain is the worst case for the visitor; it must not be quadratic.
        Assert.True(sw.ElapsedMilliseconds < 200,
            $"Sorting a 500-op chain took {sw.ElapsedMilliseconds} ms; budget is 200 ms.");
    }

    [Fact]
    public void DeepDependencyChainDoesNotOverflowTheStack()
    {
        // The sort is recursive. A pathological plan must fail as a validation error, not
        // as a StackOverflowException — which cannot be caught and would take the
        // orchestrator down.
        var plan = new Plan { Intent = "deep" };
        for (int i = 0; i < 5000; i++)
        {
            var op = new Operation { Id = $"op{i}", Op = "feature.fillet" };
            if (i > 0) op.DependsOn = new() { $"op{i - 1}" };
            plan.Ops.Add(op);
        }

        // Either it sorts, or it throws IrException. Both are acceptable; a crash is not.
        var ex = Record.Exception(() => plan.TopologicalOrder());
        Assert.True(ex is null or IrException, $"Unexpected {ex?.GetType().Name}.");
    }
}

public sealed class ValidatorPerformanceTests
{
    [Fact]
    public void ValidatingAFullPlanStaysWellInsideTheInteractionBudget()
    {
        var plan = new Plan { Intent = "big" };
        for (int i = 0; i < 300; i++)
            plan.Ops.Add(new Operation { Id = $"op{i}", Op = "feature.fillet" });

        var ctx = new ModelContext { Writable = true, SwVersion = 2026, DocPath = @"C:\p.SLDPRT" };
        var validator = new Datum.Orchestrator.Planning.PlanValidator(new Datum.Orchestrator.Planning.Policy());

        validator.Validate(plan, PlanMode.Build, ctx); // warm up

        var sw = Stopwatch.StartNew();
        for (int i = 0; i < 20; i++) validator.Validate(plan, PlanMode.Build, ctx);
        sw.Stop();

        double perValidationMs = sw.Elapsed.TotalMilliseconds / 20;

        // Validation sits between the model returning a plan and the preview rendering.
        // Anything approaching a second here would be felt as the product hanging.
        Assert.True(perValidationMs < 100,
            $"Validating 300 ops took {perValidationMs:F1} ms; budget is 100 ms.");
    }
}

public sealed class ConcurrencyTests
{
    [Fact]
    public async Task ConcurrentCatalogueReadsAreSafe()
    {
        // The catalogue is a static dictionary read from the pipe thread, the pump thread
        // and every request. It is only safe because it is never mutated after build —
        // this asserts that stays true.
        var names = OpCatalog.AllNames.ToArray();
        int errors = 0;

        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            try
            {
                for (int i = 0; i < 10_000; i++)
                {
                    OpCatalog.Exists(names[i % names.Length]);
                    OpCatalog.TraitsOf(names[i % names.Length]);
                }
            }
            catch
            {
                Interlocked.Increment(ref errors);
            }
        })));

        Assert.Equal(0, errors);
    }

    [Fact]
    public async Task ConcurrentDeltaEncodingDoesNotCorruptAcrossThreads()
    {
        // The encoder uses a [ThreadStatic] scratch buffer. If that ever became shared,
        // two pump threads would interleave and produce garbled feature names.
        int mismatches = 0;

        await Task.WhenAll(Enumerable.Range(0, 8).Select(t => Task.Run(() =>
        {
            var buffer = new byte[DeltaCodec.MaxBatchSize(1)];
            string label = $"Thread{t}-Feature";

            for (int i = 0; i < 2000; i++)
            {
                var delta = new StateDelta { Kind = DeltaKind.FeatureAdded, DocId = t, Text = label };
                int written = DeltaCodec.Write(buffer, new[] { delta });
                var decoded = DeltaCodec.Read(new ReadOnlySpan<byte>(buffer, 0, written));

                if (decoded[0].Text != label) Interlocked.Increment(ref mismatches);
            }
        })));

        Assert.Equal(0, mismatches);
    }
}

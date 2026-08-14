using System;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace Datum.Tests;

/// <summary>
/// Cross-engine drift guard.
///
/// The kernel and the standalone TypeScript modeller consume the same Operation IR but
/// have entirely separate executors — one drives real SOLIDWORKS B-rep, the other
/// evaluates 2.5D geometry in the browser. Nothing structural stops them diverging, and
/// divergence surfaces as an offline rehearsal that does not match what SOLIDWORKS
/// actually produces. That is worse than having no rehearsal, because it is trusted.
///
/// The fixture is the contract. Its TypeScript counterpart lives in
/// ui/src/lib/drift.test.ts and asserts the same file from the other side, so adding an
/// operation to one engine without the other fails a build rather than a customer's part.
/// </summary>
public sealed class DriftGuardTests
{
    private sealed record Fixture(
        string IrVersion,
        string[] HandledByStandaloneModeller,
        string[] KernelOnly);

    private static Fixture Load()
    {
        // Walk up from the test binary to the repository root. Copying the fixture into
        // the output directory would let the two copies drift, which is the exact failure
        // this test exists to prevent.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "tests", "fixtures", "op-vocabulary.json")))
            dir = dir.Parent;

        Assert.NotNull(dir);
        string path = Path.Combine(dir!.FullName, "tests", "fixtures", "op-vocabulary.json");

        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var root = doc.RootElement;

        return new Fixture(
            root.GetProperty("irVersion").GetString()!,
            root.GetProperty("handledByStandaloneModeller").EnumerateArray().Select(e => e.GetString()!).ToArray(),
            root.GetProperty("kernelOnly").EnumerateArray().Select(e => e.GetString()!).ToArray());
    }

    [Fact]
    public void FixtureTargetsTheCurrentIrVersion()
    {
        // A fixture pinned to an older IR would keep passing while the vocabulary moved
        // underneath it, which would quietly disable the whole guard.
        Assert.Equal(Plan.CurrentIrVersion, Load().IrVersion);
    }

    [Fact]
    public void EveryOperationTheModellerHandlesExistsInTheCatalogue()
    {
        var fixture = Load();
        var unknown = fixture.HandledByStandaloneModeller
            .Where(op => !OpCatalog.Exists(op))
            .ToArray();

        Assert.True(
            unknown.Length == 0,
            "The standalone modeller handles operations the kernel does not define: " +
            string.Join(", ", unknown) +
            ". Either add them to OpCatalog or stop handling them in ui/src/lib/partModel.ts.");
    }

    [Fact]
    public void EveryKernelOnlyOperationAlsoExistsInTheCatalogue()
    {
        var fixture = Load();
        var unknown = fixture.KernelOnly.Where(op => !OpCatalog.Exists(op)).ToArray();

        Assert.True(
            unknown.Length == 0,
            "The fixture names kernel-only operations that no longer exist: " + string.Join(", ", unknown));
    }

    [Fact]
    public void TheTwoListsDoNotOverlap()
    {
        var fixture = Load();
        var both = fixture.HandledByStandaloneModeller.Intersect(fixture.KernelOnly).ToArray();

        // An operation cannot be both "handled offline" and "needs a real kernel". If it
        // appears in both the fixture is lying about one of them.
        Assert.True(both.Length == 0, "Operations listed as both offline and kernel-only: " + string.Join(", ", both));
    }

    [Fact]
    public void ModellerOperationsAreAllMutating()
    {
        var fixture = Load();

        // Query operations read state and have no geometric effect, so the offline
        // modeller has nothing to reproduce. Listing one would mean the fixture is
        // tracking something that cannot drift.
        var readOnly = fixture.HandledByStandaloneModeller
            .Where(OpCatalog.IsReadOnly)
            .ToArray();

        Assert.True(readOnly.Length == 0,
            "Read-only operations should not be listed as modeller-handled: " + string.Join(", ", readOnly));
    }
}

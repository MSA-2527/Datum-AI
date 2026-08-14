namespace Datum.Tests;

/// <summary>
/// The catalogue is a closed vocabulary and a safety control at the same time. Ask mode
/// is only "provably incapable of mutation" if the trait table actually says so, so these
/// tests assert the invariants the executor and the planner both rely on.
/// </summary>
public sealed class OpCatalogTests
{
    [Fact]
    public void VocabularyIsNonEmptyAndUniformlyDotted()
    {
        Assert.True(OpCatalog.Count > 150, $"catalogue shrank to {OpCatalog.Count} operations");

        foreach (var name in OpCatalog.AllNames)
        {
            Assert.True(name.Contains('.'), $"'{name}' is not namespaced");
            Assert.Equal(name.Trim(), name);
            Assert.Equal(name.ToLowerInvariant(), name);
            Assert.False(name.Contains(' '), $"'{name}' contains whitespace");
        }
    }

    [Fact]
    public void EveryNamespaceIsRepresented()
    {
        var namespaces = OpCatalog.AllNames
            .Select(n => n.Split('.')[0])
            .Distinct()
            .ToHashSet(StringComparer.Ordinal);

        foreach (var expected in new[]
                 {
                     "sketch", "feature", "sheetmetal", "weldment", "surface",
                     "param", "config", "asm", "doc", "drw", "pdm", "query", "meta", "script"
                 })
        {
            Assert.Contains(expected, namespaces);
        }
    }

    [Fact]
    public void UnknownOperationsAreRejectedRatherThanDefaulted()
    {
        Assert.False(OpCatalog.Exists("feature.summon_geometry"));
        Assert.False(OpCatalog.TryGet("feature.summon_geometry", out _));
        Assert.Equal(OpTraits.None, OpCatalog.TraitsOf("feature.summon_geometry"));

        // Critically: an unknown name is not allowed in ANY mode, including Build.
        foreach (PlanMode mode in Enum.GetValues<PlanMode>())
            Assert.False(OpCatalog.AllowedInMode("feature.summon_geometry", mode));
    }

    [Fact]
    public void AskModeAdmitsOnlyReadOnlyOperations()
    {
        foreach (var name in OpCatalog.AllNames)
        {
            bool allowed = OpCatalog.AllowedInMode(name, PlanMode.Ask);
            Assert.Equal(OpCatalog.IsReadOnly(name), allowed);
        }
    }

    [Fact]
    public void EveryQueryOperationIsReadOnlyAndEveryReadOnlyOperationIsHarmless()
    {
        foreach (var name in OpCatalog.AllNames.Where(n => n.StartsWith("query.", StringComparison.Ordinal)))
            Assert.True(OpCatalog.IsReadOnly(name), $"{name} is a query but not marked ReadOnly");

        foreach (var name in OpCatalog.AllNames.Where(OpCatalog.IsReadOnly))
        {
            Assert.False(OpCatalog.IsDestructive(name), $"{name} is both ReadOnly and Destructive");
            Assert.False(OpCatalog.IsScript(name), $"{name} is both ReadOnly and Script");
            Assert.Equal(OpTraits.None, OpCatalog.TraitsOf(name) & OpTraits.TopologyChange);
        }
    }

    [Fact]
    public void DeletionsAndOverwritesAreMarkedDestructive()
    {
        foreach (var name in new[]
                 {
                     "feature.edit.delete", "config.delete", "doc.delete_property",
                     "doc.save_as", "asm.delete_component", "asm.replace_component",
                     "param.delete_equation", "pdm.check_in", "pdm.change_state", "script.macro"
                 })
        {
            Assert.True(OpCatalog.IsDestructive(name), $"{name} should be Destructive");
        }
    }

    [Fact]
    public void GeneratedMacrosAreTheOnlyScriptOperation()
    {
        var scripts = OpCatalog.AllNames.Where(OpCatalog.IsScript).ToList();

        Assert.Equal(new[] { "script.macro" }, scripts);
    }

    [Fact]
    public void EditModeRefusesToCreateWholeNewDocuments()
    {
        Assert.False(OpCatalog.AllowedInMode("doc.new_from_template", PlanMode.Edit));
        Assert.True(OpCatalog.AllowedInMode("doc.new_from_template", PlanMode.Build));
        Assert.True(OpCatalog.AllowedInMode("feature.edit.set_params", PlanMode.Edit));
    }

    [Fact]
    public void VersionGatingIsInclusiveOfTheMinimumSeat()
    {
        Assert.True(OpCatalog.TryGet("config.family_table_update", out var newer));
        Assert.Equal(2026, newer.MinSwVersion);

        Assert.False(OpCatalog.SupportedBy("config.family_table_update", 2025));
        Assert.True(OpCatalog.SupportedBy("config.family_table_update", 2026));
        Assert.True(OpCatalog.SupportedBy("config.family_table_update", 2027));

        Assert.True(OpCatalog.SupportedBy("feature.fillet", 2022));
        Assert.False(OpCatalog.SupportedBy("feature.fillet", 2021));
    }

    [Fact]
    public void CostHintsArePositiveSoProgressEstimationNeverDividesByZero()
    {
        foreach (var name in OpCatalog.AllNames)
            Assert.True(OpCatalog.EstimateMs(name) > 0, $"{name} has a non-positive cost hint");

        Assert.Equal(120, OpCatalog.EstimateMs("not.a.real.op"));
    }

    [Fact]
    public void TopologyChangingOperationsDeclareThatTheyAffectDrawings()
    {
        // A drawing referencing this part goes stale whenever B-Rep topology moves.
        // Anything that changes topology but claims not to affect drawings would let the
        // Drawing Autopilot skip a required update.
        var offenders = OpCatalog.AllNames
            .Where(n => (OpCatalog.TraitsOf(n) & OpTraits.TopologyChange) != 0)
            .Where(n => (OpCatalog.TraitsOf(n) & OpTraits.AffectsDrawings) == 0)
            .ToList();

        // The known, deliberate exceptions: these move the rollback bar or the active
        // configuration without altering the geometry a drawing view resolves against.
        var expected = new[]
        {
            "feature.edit.rollback_to", "config.activate", "config.set_dimension",
            "config.set_suppression", "asm.mate", "asm.mate_by_reference",
            "asm.flexible_subassembly", "param.add_equation", "param.edit_equation",
            "param.delete_equation", "param.import_equations", "param.goal_seek",
            "script.macro"
        };

        Assert.Empty(offenders.Except(expected, StringComparer.Ordinal));
    }
}

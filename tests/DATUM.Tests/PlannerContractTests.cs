using System.Text.Json;
using Datum.Orchestrator.Planning;

namespace Datum.Tests;

/// <summary>
/// The grammar and the tool schema are both generated from the operation catalogue, and
/// that generation is the entire reason a 7–14B local model is credible here: the model
/// physically cannot emit a name the executor does not implement. If these ever drift,
/// the free tier silently degrades from "constrained" to "hopeful".
/// </summary>
public sealed class PlannerContractTests
{
    private static readonly string Grammar = GbnfGrammar.ForOperationIr();

    /// <summary>Line-ending agnostic: raw string literals carry whatever the source file has.</summary>
    private static string[] GrammarLines() =>
        Grammar.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');

    private static string RuleBody(string name) =>
        GrammarLines()
            .First(l => l.TrimStart().StartsWith(name + " ", StringComparison.Ordinal)
                        || l.TrimStart().StartsWith(name + "::=", StringComparison.Ordinal))
            .Split("::=", 2, StringSplitOptions.None)[1];

    [Fact]
    public void GrammarEnumeratesEveryCataloguedOperationAndNothingElse()
    {
        foreach (var name in OpCatalog.AllNames)
            Assert.True(Grammar.Contains($"\"\\\"{name}\\\"\"", StringComparison.Ordinal),
                $"'{name}' is in the catalogue but missing from the GBNF grammar");

        int alternatives = RuleBody("opname").Split('|').Length;

        Assert.Equal(OpCatalog.Count, alternatives);
    }

    [Fact]
    public void GrammarDeclaresEveryRuleItReferences()
    {
        var declared = GrammarLines()
            .Where(l => l.Contains("::=", StringComparison.Ordinal))
            .Select(l => l.Split("::=", 2, StringSplitOptions.None)[0].Trim())
            .Where(l => l.Length > 0 && !l.StartsWith('"') && !l.Contains(' '))
            .ToHashSet(StringComparer.Ordinal);

        foreach (var rule in new[]
                 {
                     "root", "oparray", "op", "opname", "target", "kind",
                     "strarray", "object", "member", "value", "array",
                     "string", "char", "number", "ws"
                 })
        {
            Assert.Contains(rule, declared);
        }
    }

    [Fact]
    public void GrammarIsCachedRatherThanRebuiltPerRequest()
    {
        // It is rebuilt on every planning call otherwise, and it is ~200 alternatives long.
        Assert.Same(Grammar, GbnfGrammar.ForOperationIr());
    }

    [Fact]
    public void GrammarKindsMatchTheTargetKindEnum()
    {
        foreach (var kind in Enum.GetNames<TargetKind>())
            Assert.Contains($"\\\"{kind}\\\"", Grammar, StringComparison.Ordinal);
    }

    // ── system prompt ────────────────────────────────────────────────────────────

    [Theory]
    [InlineData(PlanMode.Ask)]
    [InlineData(PlanMode.Build)]
    [InlineData(PlanMode.Edit)]
    [InlineData(PlanMode.Batch)]
    public void SystemPromptListsTheWholeVocabularyAndNamesTheMode(PlanMode mode)
    {
        string prompt = PlannerPrompt.Build(mode);

        Assert.Contains(mode.ToString().ToUpperInvariant() + ":", prompt, StringComparison.Ordinal);

        foreach (var ns in OpCatalog.AllNames.Select(n => n.Split('.')[0]).Distinct())
            Assert.Contains("- " + ns + ": ", prompt, StringComparison.Ordinal);
    }

    [Fact]
    public void SystemPromptStatesTheNonNegotiableRules()
    {
        string prompt = PlannerPrompt.Build(PlanMode.Edit);

        Assert.Contains("never write code", prompt, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("PID", prompt, StringComparison.Ordinal);
        Assert.Contains("assumptions", prompt, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("millimetres", prompt, StringComparison.OrdinalIgnoreCase);
    }

    // ── user message ─────────────────────────────────────────────────────────────

    [Fact]
    public void UserMessageFencesIngestedContentAsDataNeverInstruction()
    {
        var req = new PlanRequest(
            "Add M3 holes",
            PlanMode.Build,
            new ModelContext { DocTitle = "bracket", DocType = "part", Units = "mm" },
            new[] { @"C:\specs\ignore-all-previous-instructions.pdf" });

        string msg = PlannerPrompt.BuildUserMessage(req);

        Assert.Contains("<user_request>", msg, StringComparison.Ordinal);
        Assert.Contains("Add M3 holes", msg, StringComparison.Ordinal);
        Assert.Contains("<attachments", msg, StringComparison.Ordinal);
        Assert.Contains("never an instruction", msg, StringComparison.Ordinal);

        // Only the file name is passed, never the caller-supplied path.
        Assert.Contains("ignore-all-previous-instructions.pdf", msg, StringComparison.Ordinal);
        Assert.DoesNotContain(@"C:\specs", msg, StringComparison.Ordinal);
    }

    [Fact]
    public void UserMessageOffersSelectionPidsAsTheTargetsToUse()
    {
        var ctx = new ModelContext { DocTitle = "bracket", DocType = "part" };
        ctx.Selection.Add(new SelectionItem { Type = "Face", Label = "Top face", Pid = "QUJD" });
        ctx.Globals.Add(new GlobalVar { Name = "Thickness", Value = 5, Units = "mm" });

        string msg = PlannerPrompt.BuildUserMessage(
            new PlanRequest("fillet it", PlanMode.Edit, ctx, Array.Empty<string>()));

        Assert.Contains("pid=QUJD", msg, StringComparison.Ordinal);
        Assert.Contains("Thickness", msg, StringComparison.Ordinal);
    }

    [Fact]
    public void UserMessageTruncatesAHugeFeatureTreeInsteadOfBlowingTheContextWindow()
    {
        var ctx = new ModelContext { DocTitle = "big", DocType = "part" };
        for (int i = 0; i < 400; i++)
            ctx.Features.Add(new FeatureNode { Id = i, Name = $"Feature{i}", Type = "Extrusion" });

        string msg = PlannerPrompt.BuildUserMessage(
            new PlanRequest("tidy up", PlanMode.Edit, ctx, Array.Empty<string>()));

        Assert.Contains("Feature149", msg, StringComparison.Ordinal);
        Assert.DoesNotContain("Feature150 [", msg, StringComparison.Ordinal);
        Assert.Contains("250 more", msg, StringComparison.Ordinal);
    }

    // ── tool schema ──────────────────────────────────────────────────────────────

    [Fact]
    public void EmitPlanToolConstrainsOpNamesToTheCatalogue()
    {
        var json = JsonSerializer.SerializeToElement(PlannerPrompt.EmitPlanTool());

        Assert.Equal("emit_plan", json.GetProperty("name").GetString());

        var opEnum = json
            .GetProperty("input_schema").GetProperty("properties")
            .GetProperty("ops").GetProperty("items").GetProperty("properties")
            .GetProperty("op").GetProperty("enum");

        var names = opEnum.EnumerateArray().Select(e => e.GetString()!).ToHashSet(StringComparer.Ordinal);

        Assert.Equal(OpCatalog.Count, names.Count);
        Assert.True(names.SetEquals(OpCatalog.AllNames));
    }

    [Fact]
    public void EmitPlanToolRequiresAnIntentAndOperations()
    {
        var json = JsonSerializer.SerializeToElement(PlannerPrompt.EmitPlanTool());

        var required = json.GetProperty("input_schema").GetProperty("required")
            .EnumerateArray().Select(e => e.GetString()).ToList();

        Assert.Contains("intent", required);
        Assert.Contains("ops", required);
    }

    // ── provider routing ─────────────────────────────────────────────────────────

    [Fact]
    public void PlanOutcomeDefaultsToNotOkSoAFailureCannotBeMistakenForSuccess()
    {
        var outcome = new PlanOutcome(null, false, "no planner configured");

        Assert.False(outcome.Ok);
        Assert.Null(outcome.Plan);
        Assert.False(outcome.ExceededCapability);
        Assert.Equal(0, outcome.TotalOps);
    }
}

using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Datum.Contracts
{
    /// <summary>
    /// The Operation IR. A <see cref="Plan"/> is the ONLY thing a planner may emit —
    /// never code, never raw SOLIDWORKS API calls. The kernel is the sole component
    /// that knows how to turn an <see cref="Operation"/> into COM calls.
    ///
    /// Consequences (see docs/02-architecture.md §2):
    ///   - the model cannot invent an API call, so it cannot corrupt a model
    ///     in a way the executor did not anticipate;
    ///   - plans are diffable, replayable, serialisable and hand-editable;
    ///   - the deterministic free path (skills, recipes, batch) emits the same IR,
    ///     so there is exactly one executor and one safety model.
    /// </summary>
    public sealed class Plan
    {
        /// <summary>Current IR version. Bump on any breaking vocabulary change.</summary>
        public const string CurrentIrVersion = "1.4";

        [JsonPropertyName("planId")] public string PlanId { get; set; } = NewId("pln");
        [JsonPropertyName("irVersion")] public string IrVersion { get; set; } = CurrentIrVersion;
        [JsonPropertyName("target")] public PlanTarget Target { get; set; } = new PlanTarget();

        /// <summary>One-sentence restatement of intent, shown at the top of the plan card.</summary>
        [JsonPropertyName("intent")] public string Intent { get; set; } = "";

        /// <summary>
        /// Every inference the planner made that was not stated by the user.
        /// Rendered as a first-class amber block in the UI — an AI that states its
        /// assumptions is auditable; one that hides them is not.
        /// </summary>
        [JsonPropertyName("assumptions")] public List<string> Assumptions { get; set; } = new List<string>();

        [JsonPropertyName("ops")] public List<Operation> Ops { get; set; } = new List<Operation>();

        /// <summary>Post-apply assertions. A failure triggers auto-rollback.</summary>
        [JsonPropertyName("verify")] public List<VerifyCheck> Verify { get; set; } = new List<VerifyCheck>();

        [JsonPropertyName("undo")] public UndoSpec Undo { get; set; } = new UndoSpec();

        /// <summary>Provenance, so a plan can be replayed byte-identically.</summary>
        [JsonPropertyName("provenance")] public Provenance? Provenance { get; set; }

        internal static string NewId(string prefix) =>
            prefix + "_" + Guid.NewGuid().ToString("N").Substring(0, 20);

        /// <summary>
        /// Topological order of <see cref="Ops"/> honouring <see cref="Operation.DependsOn"/>.
        /// Throws if the dependency graph contains a cycle or a dangling reference —
        /// validated before any COM call is made.
        /// </summary>
        public IReadOnlyList<Operation> TopologicalOrder()
        {
            var byId = new Dictionary<string, Operation>(Ops.Count, StringComparer.Ordinal);
            foreach (var op in Ops)
            {
                if (byId.ContainsKey(op.Id))
                    throw new IrException($"Duplicate operation id '{op.Id}'.");
                byId[op.Id] = op;
            }

            var state = new Dictionary<string, int>(Ops.Count, StringComparer.Ordinal); // 0 unseen, 1 visiting, 2 done
            var ordered = new List<Operation>(Ops.Count);

            void Visit(Operation op, string path)
            {
                state.TryGetValue(op.Id, out int s);
                if (s == 2) return;
                if (s == 1) throw new IrException($"Cyclic dependency: {path} -> {op.Id}");

                state[op.Id] = 1;
                if (op.DependsOn != null)
                {
                    foreach (var depId in op.DependsOn)
                    {
                        if (!byId.TryGetValue(depId, out var dep))
                            throw new IrException($"Operation '{op.Id}' depends on unknown op '{depId}'.");
                        Visit(dep, path + " -> " + op.Id);
                    }
                }
                state[op.Id] = 2;
                ordered.Add(op);
            }

            foreach (var op in Ops) Visit(op, op.Id);
            return ordered;
        }

        /// <summary>True if any operation is irreversible by undo alone (snapshot required).</summary>
        public bool RequiresSnapshot()
        {
            foreach (var op in Ops)
                if (OpCatalog.IsDestructive(op.Op)) return true;
            return false;
        }
    }

    public sealed class PlanTarget
    {
        [JsonPropertyName("docPath")] public string DocPath { get; set; } = "";
        [JsonPropertyName("configuration")] public string? Configuration { get; set; }
        /// <summary>Stable document identity, survives rename. Read from the SOLIDWORKS doc UUID.</summary>
        [JsonPropertyName("docUuid")] public string? DocUuid { get; set; }
    }

    public sealed class Operation
    {
        [JsonPropertyName("id")] public string Id { get; set; } = "";

        /// <summary>Dotted op name from the closed vocabulary. See <see cref="OpCatalog"/>.</summary>
        [JsonPropertyName("op")] public string Op { get; set; } = "";

        [JsonPropertyName("dependsOn")] public List<string>? DependsOn { get; set; }

        [JsonPropertyName("target")] public OpTarget? Target { get; set; }

        private JsonElement _params = JsonEmpty.Object;

        /// <summary>
        /// Free-form per-op parameters. Deliberately a JsonElement rather than a typed
        /// union: the executor's handler for each op name owns its own schema, which
        /// keeps the vocabulary extensible without touching this type.
        ///
        /// Normalised to an empty object when unset. JsonElement is a struct, so an
        /// operation built without parameters would otherwise carry ValueKind.Undefined,
        /// and System.Text.Json throws when asked to serialise that. An op with no
        /// params is the common case, so leaving it undefined made whole plans
        /// unserialisable — they could be neither persisted nor sent to the kernel.
        /// </summary>
        [JsonPropertyName("params")]
        public JsonElement Params
        {
            get => _params;
            set => _params = value.ValueKind == JsonValueKind.Undefined ? JsonEmpty.Object : value;
        }

        [JsonPropertyName("preconditions")] public List<Precondition>? Preconditions { get; set; }

        /// <summary>Populated by the kernel during the read-only resolve pass.</summary>
        [JsonPropertyName("resolved")] public ResolvedTarget? Resolved { get; set; }

        [JsonPropertyName("estimatedMs")] public int EstimatedMs { get; set; }

        [JsonPropertyName("note")] public string? Note { get; set; }
    }

    public enum TargetKind
    {
        /// <summary>Persistent Reference ID. Always preferred — survives rebuild, session and version.</summary>
        Pid = 0,
        /// <summary>What the user had highlighted. Resolved to PIDs at plan time.</summary>
        Selection = 1,
        /// <summary>Declarative geometric query, e.g. edges(vertical, convex). Resolved set shown before apply.</summary>
        Query = 2,
        /// <summary>Feature/entity name. Discouraged and flagged fragile by the linter.</summary>
        Name = 3,
        /// <summary>The document itself.</summary>
        Document = 4
    }

    public sealed class OpTarget
    {
        [JsonPropertyName("kind")]
        [JsonConverter(typeof(JsonStringEnumConverter))]
        public TargetKind Kind { get; set; } = TargetKind.Pid;

        /// <summary>Base64 of the raw PID byte[] returned by GetPersistReference3.</summary>
        [JsonPropertyName("pid")] public string? Pid { get; set; }

        /// <summary>Multiple PIDs when the op acts on a set.</summary>
        [JsonPropertyName("pids")] public List<string>? Pids { get; set; }

        [JsonPropertyName("query")] public string? Query { get; set; }
        [JsonPropertyName("name")] public string? Name { get; set; }

        /// <summary>Selection index range, e.g. "0..2" or "*".</summary>
        [JsonPropertyName("selection")] public string? Selection { get; set; }

        /// <summary>Human label for the UI. Never used for resolution.</summary>
        [JsonPropertyName("label")] public string? Label { get; set; }
    }

    /// <summary>Result of the kernel's read-only resolve pass (pipeline step 4).</summary>
    public sealed class ResolvedTarget
    {
        [JsonPropertyName("count")] public int Count { get; set; }
        [JsonPropertyName("pids")] public List<string> Pids { get; set; } = new List<string>();
        [JsonPropertyName("labels")] public List<string> Labels { get; set; } = new List<string>();
        [JsonPropertyName("ok")] public bool Ok { get; set; }
        [JsonPropertyName("problem")] public string? Problem { get; set; }
    }

    public sealed class Precondition
    {
        [JsonPropertyName("check")] public string Check { get; set; } = "";
        [JsonPropertyName("ref")] public string? Ref { get; set; }

        /// <summary>Nullable: absence is meaningful, and an undefined JsonElement cannot be serialised.</summary>
        [JsonPropertyName("value")] public JsonElement? Value { get; set; }
    }

    public sealed class VerifyCheck
    {
        [JsonPropertyName("check")] public string Check { get; set; } = "";

        /// <summary>
        /// Nullable for the same reason as <see cref="Precondition.Value"/>: most checks
        /// (mass_delta_pct, no_interference) carry no expected value, and a default
        /// JsonElement is Undefined, which throws on serialisation.
        /// </summary>
        [JsonPropertyName("expect")] public JsonElement? Expect { get; set; }
        [JsonPropertyName("max")] public double? Max { get; set; }
        [JsonPropertyName("min")] public double? Min { get; set; }
    }

    public sealed class UndoSpec
    {
        /// <summary>
        /// Name of the single SOLIDWORKS undo record wrapping the whole plan.
        /// However many hundreds of API calls a plan makes, it collapses to one Ctrl+Z.
        /// </summary>
        [JsonPropertyName("groupName")] public string GroupName { get; set; } = "DATUM operation";
        [JsonPropertyName("snapshot")] public bool Snapshot { get; set; } = true;
    }

    public sealed class Provenance
    {
        [JsonPropertyName("providerId")] public string ProviderId { get; set; } = "";
        [JsonPropertyName("modelId")] public string ModelId { get; set; } = "";
        [JsonPropertyName("seed")] public long? Seed { get; set; }
        [JsonPropertyName("contextDigestSha256")] public string? ContextDigest { get; set; }
        [JsonPropertyName("promptTokens")] public int PromptTokens { get; set; }
        [JsonPropertyName("completionTokens")] public int CompletionTokens { get; set; }
        [JsonPropertyName("createdAtUtc")] public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
    }

    public sealed class IrException : Exception
    {
        public IrException(string message) : base(message) { }
    }

    /// <summary>
    /// A shared, detached empty JSON object. Cloned off its document so nothing has to
    /// keep a JsonDocument alive, and allocated once because every parameterless
    /// operation reuses it.
    /// </summary>
    internal static class JsonEmpty
    {
        internal static readonly JsonElement Object = ParseDetached("{}");

        private static JsonElement ParseDetached(string json)
        {
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.Clone();
        }
    }

    /// <summary>Shared serializer options. Camel-case in, camel-case out, tolerant of unknown members.</summary>
    public static class IrJson
    {
        public static readonly JsonSerializerOptions Options = Create();

        private static JsonSerializerOptions Create()
        {
            var o = new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                PropertyNameCaseInsensitive = true,
                DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
                ReadCommentHandling = JsonCommentHandling.Skip,
                AllowTrailingCommas = true,
                NumberHandling = JsonNumberHandling.AllowReadingFromString,
                WriteIndented = false
            };
            o.Converters.Add(new JsonStringEnumConverter());
            return o;
        }

        public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);
        public static T? Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, Options);
    }
}

using System;
using System.Collections.Generic;
using Datum.Contracts;
using Datum.Kernel.Execution;

namespace Datum.Kernel.Handlers
{
    /// <summary>
    /// Plan-level control operations. meta.assert exists so a planner can encode a
    /// safety condition inline — "stop if the mass moved more than 20%" — rather than
    /// relying on the caller to check afterwards.
    /// </summary>
    internal static class MetaHandlers
    {
        public static void Register(Dictionary<string, OpHandler> h)
        {
            h["meta.assert"] = Assert;
            h["meta.note"] = Note;
            h["meta.ask_user"] = AskUser;
        }

        private static void Assert(OpContext c)
        {
            string condition = c.GetString("condition", "") ?? "";
            string message = c.GetString("message", "Assertion failed.") ?? "Assertion failed.";

            bool ok;
            switch (condition)
            {
                case "rebuild_errors_zero":
                    ok = OpExecutor.CountRebuildErrors(c.Doc) == 0;
                    break;

                case "mass_between":
                {
                    double g = OpExecutor.SafeMassGrams(c.Doc);
                    ok = g >= c.GetDouble("min", double.MinValue) &&
                         g <= c.GetDouble("max", double.MaxValue);
                    c.Output["massG"] = g;
                    break;
                }

                case "has_configuration":
                {
                    var names = c.Doc.GetConfigurationNames() as string[] ?? new string[0];
                    string want = c.GetString("name", "") ?? "";
                    ok = false;
                    foreach (var n in names)
                        if (string.Equals(n, want, StringComparison.OrdinalIgnoreCase)) { ok = true; break; }
                    break;
                }

                default:
                    // An unknown assertion must not silently pass — that would let a
                    // newer planner believe a safety check ran when it did not.
                    throw new OpException(KernelError.PreconditionFailed,
                        $"This kernel does not know how to evaluate the assertion '{condition}'.");
            }

            if (!ok) throw new OpException(KernelError.PreconditionFailed, message);
            c.Output["asserted"] = condition;
        }

        private static void Note(OpContext c)
        {
            // Recorded in the op log for the design-rationale export (problem B6).
            c.Output["note"] = c.GetString("text", "") ?? "";
        }

        private static void AskUser(OpContext c)
        {
            // The planner explicitly wants a decision mid-plan. Executing this always
            // halts: the orchestrator surfaces the question and re-plans from the answer.
            throw new OpException(KernelError.PreconditionFailed,
                c.GetString("question", "The plan needs a decision before it can continue.")!);
        }
    }
}

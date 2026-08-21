using System;
using System.Collections.Generic;
using System.Globalization;
using Datum.Contracts;
using Datum.Connector.SolidWorks.Execution;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Datum.Connector.SolidWorks.Handlers
{
    /// <summary>
    /// Parameter and equation operations.
    ///
    /// This is the highest-frequency, zero-AI, always-free path in the product — the
    /// Parameter Inspector's sliders compile straight to param.set_global. It is also
    /// the *correct* target for most edits: changing a global variable preserves design
    /// intent, whereas re-creating geometry destroys it.
    /// </summary>
    internal static class ParamHandlers
    {
        public static void Register(Dictionary<string, OpHandler> h)
        {
            h["param.set_global"] = SetGlobal;
            h["param.add_global"] = AddGlobal;
            h["param.set_dimension"] = SetDimension;
            h["param.add_equation"] = AddEquation;
            h["param.edit_equation"] = EditEquation;
            h["param.delete_equation"] = DeleteEquation;
            h["param.goal_seek"] = GoalSeek;
        }

        // ── globals ─────────────────────────────────────────────────────────────────

        private static void SetGlobal(OpContext c)
        {
            string name = c.RequireString("name");
            double value = c.GetDouble("value");
            string units = c.GetString("units", "mm") ?? "mm";

            var mgr = c.Doc.GetEquationMgr();
            if (mgr == null) throw new OpException(KernelError.ComFailure, "No equation manager on this document.");

            int index = FindGlobalIndex(mgr, name);
            if (index < 0)
                throw new OpException(KernelError.PreconditionFailed,
                    $"No global variable named '{name}'. Use param.add_global to create it first.");

            // Global variables are stored as a full equation string: "name" = value.
            // Writing the value alone silently no-ops, which is a classic macro bug.
            string expr = $"\"{name}\" = {Fmt(value)}{UnitSuffix(units)}";
            int rc = mgr.set_Equation(index, expr);
            if (rc != 0)
                throw new OpException(KernelError.ComFailure,
                    $"SOLIDWORKS rejected the equation '{expr}' (code {rc}).");

            // Deferred: inside a FastScope the plan rebuilds once at the end. Outside
            // one (the slider fast-path) the caller rebuilds on drag release.
            if (c.Fast == null && c.GetBool("rebuild", true))
                c.Doc.EditRebuild3();

            c.Output["name"] = name;
            c.Output["value"] = value;
        }

        private static void AddGlobal(OpContext c)
        {
            string name = c.RequireString("name");
            double value = c.GetDouble("value");
            string units = c.GetString("units", "mm") ?? "mm";

            var mgr = c.Doc.GetEquationMgr();
            if (FindGlobalIndex(mgr, name) >= 0)
            {
                // Idempotent: re-running a plan must not fail or duplicate.
                SetGlobal(c);
                return;
            }

            string expr = $"\"{name}\" = {Fmt(value)}{UnitSuffix(units)}";
            int idx = mgr.Add3(-1, expr, true, (int)swInConfigurationOpts_e.swAllConfiguration, null);
            if (idx < 0)
                throw new OpException(KernelError.ComFailure, $"Could not add global variable '{name}'.");

            c.Output["name"] = name;
            c.Output["index"] = idx;
        }

        // ── dimensions ──────────────────────────────────────────────────────────────

        private static void SetDimension(OpContext c)
        {
            // Fully-qualified name, e.g. "D1@Sketch1".
            string name = c.RequireString("name");
            double valueMetres = c.GetLengthMetres("value");

            var dim = c.Doc.Parameter(name) as IDimension;
            if (dim == null)
                throw new OpException(KernelError.PreconditionFailed,
                    $"No dimension named '{name}'. Fully-qualified names look like 'D1@Sketch1'.");

            // SetSystemValue3 rather than IParameter.SystemValue: it takes an explicit
            // configuration option, so a plan cannot accidentally edit every
            // configuration when the user meant only the active one.
            string scope = c.GetString("configurations", "this") ?? "this";
            var opt = scope == "all"
                ? swSetValueInConfiguration_e.swSetValue_InAllConfigurations
                : swSetValueInConfiguration_e.swSetValue_InThisConfiguration;

            int rc = dim.SetSystemValue3(valueMetres, (int)opt, null);
            if (rc != (int)swSetValueReturnStatus_e.swSetValue_Successful)
                throw new OpException(KernelError.ComFailure,
                    $"SOLIDWORKS rejected the value for '{name}' (status {rc}). " +
                    "The dimension may be driven by an equation or a design table.");

            if (c.Fast == null && c.GetBool("rebuild", true))
                c.Doc.EditRebuild3();

            c.Output["name"] = name;
            c.Output["valueMm"] = OpContext.FromMetres(valueMetres, "mm");
        }

        // ── equations ───────────────────────────────────────────────────────────────

        private static void AddEquation(OpContext c)
        {
            string expr = c.RequireString("equation");
            var mgr = c.Doc.GetEquationMgr();

            int idx = mgr.Add3(-1, expr, true, (int)swInConfigurationOpts_e.swAllConfiguration, null);
            if (idx < 0)
                throw new OpException(KernelError.ComFailure, $"SOLIDWORKS rejected the equation '{expr}'.");

            // A circular reference is accepted by Add3 but poisons every later rebuild,
            // so it is caught here while the plan can still be rolled back cleanly.
            if (mgr.Status != (int)swEquationStatus_e.swEquationStatus_Ok)
            {
                mgr.Delete(idx);
                throw new OpException(KernelError.PreconditionFailed,
                    $"The equation '{expr}' is invalid (status {mgr.Status}); it was not kept.");
            }

            c.Output["index"] = idx;
        }

        private static void EditEquation(OpContext c)
        {
            int index = c.GetInt("index", -1);
            string expr = c.RequireString("equation");
            var mgr = c.Doc.GetEquationMgr();

            if (index < 0) index = FindGlobalIndex(mgr, c.GetString("name") ?? "");
            if (index < 0 || index >= mgr.GetCount())
                throw new OpException(KernelError.PreconditionFailed, "Equation index out of range.");

            string previous = mgr.get_Equation(index);
            if (mgr.set_Equation(index, expr) != 0)
                throw new OpException(KernelError.ComFailure, $"SOLIDWORKS rejected '{expr}'.");

            if (mgr.Status != (int)swEquationStatus_e.swEquationStatus_Ok)
            {
                mgr.set_Equation(index, previous);   // restore rather than leave it broken
                throw new OpException(KernelError.PreconditionFailed,
                    $"'{expr}' is invalid; the previous equation was restored.");
            }
        }

        private static void DeleteEquation(OpContext c)
        {
            int index = c.GetInt("index", -1);
            var mgr = c.Doc.GetEquationMgr();
            if (index < 0) index = FindGlobalIndex(mgr, c.GetString("name") ?? "");
            if (index < 0 || index >= mgr.GetCount())
                throw new OpException(KernelError.PreconditionFailed, "Equation index out of range.");
            mgr.Delete(index);
        }

        // ── goal seek ───────────────────────────────────────────────────────────────

        /// <summary>
        /// Bounded bisection over one global variable against a measured target
        /// (mass today; extensible to volume or CoG).
        ///
        /// Deterministic and free — no model involved. Pro adds AI variable selection
        /// and multi-objective handling, but the search itself stays here so it remains
        /// reproducible and auditable.
        /// </summary>
        private static void GoalSeek(OpContext c)
        {
            string variable = c.RequireString("variable");
            string metric = c.GetString("metric", "mass") ?? "mass";
            double target = c.GetDouble("target");
            double lo = c.GetDouble("min", 1);
            double hi = c.GetDouble("max", 1000);
            double tolPct = c.GetDouble("tolerancePct", 0.5);
            int maxIter = Math.Min(c.GetInt("maxIterations", 24), 60);
            string units = c.GetString("units", "mm") ?? "mm";

            var mgr = c.Doc.GetEquationMgr();
            int idx = FindGlobalIndex(mgr, variable);
            if (idx < 0)
                throw new OpException(KernelError.PreconditionFailed, $"No global variable '{variable}'.");

            double Measure(double x)
            {
                mgr.set_Equation(idx, $"\"{variable}\" = {Fmt(x)}{UnitSuffix(units)}");
                c.Doc.EditRebuild3();
                return metric == "volume"
                    ? VolumeCm3(c.Doc)
                    : OpExecutor.SafeMassGrams(c.Doc);
            }

            double fLo = Measure(lo), fHi = Measure(hi);
            if ((fLo - target) * (fHi - target) > 0)
                throw new OpException(KernelError.PreconditionFailed,
                    $"Target {metric} {target:F2} is not bracketed by {variable} ∈ [{lo}, {hi}] " +
                    $"(range {Math.Min(fLo, fHi):F2}..{Math.Max(fLo, fHi):F2}). Widen the bounds.");

            double mid = lo, fMid = fLo;
            int i = 0;
            for (; i < maxIter; i++)
            {
                c.Cancel.ThrowIfCancelled();
                mid = 0.5 * (lo + hi);
                fMid = Measure(mid);

                double errPct = Math.Abs(target) < 1e-9 ? Math.Abs(fMid) : Math.Abs((fMid - target) / target) * 100.0;
                if (errPct <= tolPct) break;

                if ((fLo - target) * (fMid - target) <= 0) { hi = mid; fHi = fMid; }
                else { lo = mid; fLo = fMid; }
            }

            c.Output["variable"] = variable;
            c.Output["value"] = mid;
            c.Output["achieved"] = fMid;
            c.Output["target"] = target;
            c.Output["iterations"] = i + 1;
        }

        private static double VolumeCm3(IModelDoc2 doc)
        {
            try
            {
                var mp = doc.Extension.CreateMassProperty();
                return mp == null ? 0 : mp.Volume * 1e6;
            }
            catch { return 0; }
        }

        // ── helpers ─────────────────────────────────────────────────────────────────

        internal static int FindGlobalIndex(IEquationMgr mgr, string name)
        {
            if (mgr == null || string.IsNullOrEmpty(name)) return -1;
            int count = mgr.GetCount();
            for (int i = 0; i < count; i++)
            {
                string eq = mgr.get_Equation(i);
                if (string.IsNullOrEmpty(eq)) continue;

                // Global variables are written as: "name" = expression
                int q1 = eq.IndexOf('"');
                if (q1 < 0) continue;
                int q2 = eq.IndexOf('"', q1 + 1);
                if (q2 < 0) continue;

                if (string.Equals(eq.Substring(q1 + 1, q2 - q1 - 1), name, StringComparison.OrdinalIgnoreCase))
                    return i;
            }
            return -1;
        }

        private static string Fmt(double v) => v.ToString("0.############", CultureInfo.InvariantCulture);

        private static string UnitSuffix(string units)
        {
            switch (units.ToLowerInvariant())
            {
                case "mm": return "mm";
                case "cm": return "cm";
                case "m": return "m";
                case "in": case "inch": return "in";
                case "ft": return "ft";
                default: return "mm";
            }
        }
    }
}

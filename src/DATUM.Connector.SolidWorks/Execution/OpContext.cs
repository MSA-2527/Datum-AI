using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using Datum.Contracts;
using SolidWorks.Interop.sldworks;

namespace Datum.Connector.SolidWorks.Execution
{
    /// <summary>
    /// Everything an operation handler is allowed to touch. Handlers receive this and
    /// nothing else, which keeps the blast radius of a bad handler small and makes the
    /// whole executor testable against a mock.
    /// </summary>
    internal sealed class OpContext
    {
        public SldWorks Sw = null!;
        public IModelDoc2 Doc = null!;
        public PidResolver Pids = null!;
        public Operation Op = null!;
        public FastScope? Fast;
        public CancellationFlag Cancel = null!;

        /// <summary>Entities resolved during the read-only pass. Never re-resolve inside a handler.</summary>
        public List<object> Targets = new List<object>();

        /// <summary>Free-form results surfaced back to the UI (query ops, measured values...).</summary>
        public Dictionary<string, object?> Output = new Dictionary<string, object?>();

        // ── typed parameter access ───────────────────────────────────────────────────
        // SOLIDWORKS works in metres internally while every engineer thinks in mm, so
        // length accessors convert explicitly rather than leaving unit handling to
        // whoever wrote the handler. This has historically been a rich source of bugs.

        public bool TryGetProp(string name, out JsonElement value)
        {
            value = default;
            if (Op.Params.ValueKind != JsonValueKind.Object) return false;
            return Op.Params.TryGetProperty(name, out value);
        }

        public double GetDouble(string name, double fallback = 0)
        {
            if (!TryGetProp(name, out var v)) return fallback;
            switch (v.ValueKind)
            {
                case JsonValueKind.Number: return v.GetDouble();
                case JsonValueKind.String:
                    return double.TryParse(v.GetString(), NumberStyles.Any,
                                           CultureInfo.InvariantCulture, out double d) ? d : fallback;
                default: return fallback;
            }
        }

        /// <summary>Reads a length in the plan's units (default mm) and returns metres.</summary>
        public double GetLengthMetres(string name, double fallbackMm = 0)
        {
            double raw = GetDouble(name, fallbackMm);
            string units = GetString("units", "mm") ?? "mm";
            return ToMetres(raw, units);
        }

        public static double ToMetres(double value, string units)
        {
            switch (units.ToLowerInvariant())
            {
                case "m": return value;
                case "cm": return value * 0.01;
                case "mm": return value * 0.001;
                case "in": case "inch": return value * 0.0254;
                case "ft": return value * 0.3048;
                default: return value * 0.001;   // mm is the safe default for MCAD
            }
        }

        public static double FromMetres(double metres, string units)
        {
            switch (units.ToLowerInvariant())
            {
                case "m": return metres;
                case "cm": return metres * 100.0;
                case "mm": return metres * 1000.0;
                case "in": case "inch": return metres / 0.0254;
                case "ft": return metres / 0.3048;
                default: return metres * 1000.0;
            }
        }

        public int GetInt(string name, int fallback = 0)
        {
            if (!TryGetProp(name, out var v)) return fallback;
            if (v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out int i)) return i;
            if (v.ValueKind == JsonValueKind.String &&
                int.TryParse(v.GetString(), out int j)) return j;
            return fallback;
        }

        public bool GetBool(string name, bool fallback = false)
        {
            if (!TryGetProp(name, out var v)) return fallback;
            if (v.ValueKind == JsonValueKind.True) return true;
            if (v.ValueKind == JsonValueKind.False) return false;
            return fallback;
        }

        public string? GetString(string name, string? fallback = null)
        {
            if (!TryGetProp(name, out var v)) return fallback;
            return v.ValueKind == JsonValueKind.String ? v.GetString() : fallback;
        }

        public double[]? GetDoubleArray(string name)
        {
            if (!TryGetProp(name, out var v) || v.ValueKind != JsonValueKind.Array) return null;
            var list = new List<double>(v.GetArrayLength());
            foreach (var e in v.EnumerateArray())
                if (e.ValueKind == JsonValueKind.Number) list.Add(e.GetDouble());
            return list.ToArray();
        }

        /// <summary>Required-parameter accessor. Throws OpException so the executor reports which op and which field.</summary>
        public string RequireString(string name)
        {
            var s = GetString(name);
            if (string.IsNullOrEmpty(s))
                throw new OpException(KernelError.PreconditionFailed,
                    $"Operation '{Op.Op}' requires parameter '{name}'.");
            return s!;
        }

        public void RequireTargets(int min = 1)
        {
            if (Targets.Count < min)
                throw new OpException(KernelError.PidUnresolved,
                    $"Operation '{Op.Op}' needs at least {min} resolved target(s) but has {Targets.Count}.");
        }
    }

    /// <summary>Cooperative cancellation. Checked between operations, never mid-COM-call.</summary>
    internal sealed class CancellationFlag
    {
        private volatile bool _cancelled;
        public bool IsCancelled => _cancelled;
        public void Cancel() => _cancelled = true;
        public void Reset() => _cancelled = false;
        public void ThrowIfCancelled()
        {
            if (_cancelled) throw new OpException(KernelError.Cancelled, "Cancelled by the user.");
        }
    }

    /// <summary>Handler-level failure carrying a machine-readable code for the UI.</summary>
    internal sealed class OpException : Exception
    {
        public string Code { get; }
        public OpException(string code, string message) : base(message) { Code = code; }
        public OpException(string code, string message, Exception inner) : base(message, inner) { Code = code; }
    }
}

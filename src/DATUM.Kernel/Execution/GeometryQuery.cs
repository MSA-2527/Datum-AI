using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

namespace Datum.Kernel.Execution
{
    /// <summary>
    /// Declarative geometric queries, e.g.
    ///     faces(planar, normal:+Z)
    ///     edges(vertical, convex, length:&gt;20)
    ///     edges(of:Boss-Extrude1, circular)
    ///
    /// Set-based intent ("all vertical edges") cannot be expressed as a PID list at plan
    /// time, so the planner emits a query and the kernel evaluates it. Crucially the
    /// RESOLVED SET is shown in the preview before anything is applied — the user sees
    /// "12 edges" and can hover to highlight them, so a wrong query is caught by a human
    /// rather than discovered after the fact.
    /// </summary>
    internal static class GeometryQuery
    {
        private static readonly Regex Shape =
            new Regex(@"^\s*(?<kind>faces|edges|vertices|features|bodies)\s*\((?<args>.*)\)\s*$",
                      RegexOptions.IgnoreCase | RegexOptions.Compiled);

        private const double Tol = 1e-6;

        public static List<object>? Evaluate(IModelDoc2 doc, string query, out string? error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(query)) { error = "empty query"; return null; }

            var m = Shape.Match(query);
            if (!m.Success)
            {
                error = $"Unrecognised query syntax: '{query}'. Expected e.g. edges(vertical, convex).";
                return null;
            }

            string kind = m.Groups["kind"].Value.ToLowerInvariant();
            var args = ParseArgs(m.Groups["args"].Value);

            try
            {
                switch (kind)
                {
                    case "faces": return QueryFaces(doc, args, out error);
                    case "edges": return QueryEdges(doc, args, out error);
                    case "features": return QueryFeatures(doc, args, out error);
                    case "bodies": return QueryBodies(doc, args, out error);
                    default:
                        error = $"Query kind '{kind}' is not supported yet.";
                        return null;
                }
            }
            catch (Exception ex)
            {
                error = "query evaluation failed: " + ex.Message;
                return null;
            }
        }

        // ── argument parsing ────────────────────────────────────────────────────────

        private sealed class Args
        {
            public readonly HashSet<string> Flags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            public readonly Dictionary<string, string> Kv =
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            public bool Has(string f) => Flags.Contains(f);
            public string? Get(string k) => Kv.TryGetValue(k, out var v) ? v : null;

            /// <summary>Parses comparison values like "&gt;20", "&lt;=5", "12".</summary>
            public bool Compare(string key, double actual)
            {
                var raw = Get(key);
                if (raw == null) return true;
                raw = raw.Trim();

                string op = "=";
                if (raw.StartsWith(">=") || raw.StartsWith("<=")) { op = raw.Substring(0, 2); raw = raw.Substring(2); }
                else if (raw.StartsWith(">") || raw.StartsWith("<")) { op = raw.Substring(0, 1); raw = raw.Substring(1); }

                if (!double.TryParse(raw.Trim(), NumberStyles.Any, CultureInfo.InvariantCulture, out double v))
                    return true;

                switch (op)
                {
                    case ">": return actual > v;
                    case "<": return actual < v;
                    case ">=": return actual >= v - Tol;
                    case "<=": return actual <= v + Tol;
                    default: return Math.Abs(actual - v) < 1e-3;
                }
            }
        }

        private static Args ParseArgs(string raw)
        {
            var a = new Args();
            foreach (var part in raw.Split(','))
            {
                var p = part.Trim();
                if (p.Length == 0) continue;
                int c = p.IndexOf(':');
                if (c > 0) a.Kv[p.Substring(0, c).Trim()] = p.Substring(c + 1).Trim();
                else a.Flags.Add(p);
            }
            return a;
        }

        // ── traversal ───────────────────────────────────────────────────────────────

        private static List<IBody2> BodiesOf(IModelDoc2 doc)
        {
            var list = new List<IBody2>();
            if ((swDocumentTypes_e)doc.GetType() != swDocumentTypes_e.swDocPART) return list;

            var part = (PartDoc)doc;
            var bodies = part.GetBodies2((int)swBodyType_e.swSolidBody, false) as object[];
            if (bodies == null) return list;
            foreach (var b in bodies)
                if (b is IBody2 body) list.Add(body);
            return list;
        }

        private static List<object> QueryFaces(IModelDoc2 doc, Args a, out string? error)
        {
            error = null;
            var result = new List<object>();
            string? ofFeature = a.Get("of");

            foreach (var body in BodiesOf(doc))
            {
                var faces = body.GetFaces() as object[];
                if (faces == null) continue;

                foreach (var fo in faces)
                {
                    if (!(fo is IFace2 face)) continue;
                    var surf = face.IGetSurface();

                    if (a.Has("planar") && !surf.IsPlane()) continue;
                    if (a.Has("cylindrical") && !surf.IsCylinder()) continue;
                    if (a.Has("conical") && !surf.IsCone()) continue;
                    if (a.Has("spherical") && !surf.IsSphere()) continue;

                    double areaMm2 = face.GetArea() * 1e6;
                    if (!a.Compare("area", areaMm2)) continue;

                    var normal = a.Get("normal");
                    if (normal != null && !NormalMatches(face, normal)) continue;

                    if (ofFeature != null && !BelongsToFeature(face, ofFeature)) continue;

                    result.Add(face);
                }
            }
            return result;
        }

        private static List<object> QueryEdges(IModelDoc2 doc, Args a, out string? error)
        {
            error = null;
            var result = new List<object>();
            var seen = new HashSet<int>();
            string? ofFeature = a.Get("of");

            foreach (var body in BodiesOf(doc))
            {
                var edges = body.GetEdges() as object[];
                if (edges == null) continue;

                foreach (var eo in edges)
                {
                    if (!(eo is IEdge edge)) continue;

                    // GetEdges can return the same edge twice via adjacent faces.
                    int hash = edge.GetHashCode();
                    if (!seen.Add(hash)) continue;

                    var curve = edge.IGetCurve();

                    if (a.Has("linear") && !curve.IsLine()) continue;
                    if (a.Has("circular") && !curve.IsCircle()) continue;

                    double lenMm = EdgeLengthMm(edge);
                    if (!a.Compare("length", lenMm)) continue;

                    if (a.Has("vertical") && !IsVertical(edge)) continue;
                    if (a.Has("horizontal") && IsVertical(edge)) continue;

                    if (a.Has("convex") || a.Has("concave"))
                    {
                        bool? convex = IsConvex(edge);
                        if (convex == null) continue;
                        if (a.Has("convex") && convex != true) continue;
                        if (a.Has("concave") && convex != false) continue;
                    }

                    if (ofFeature != null && !BelongsToFeature(edge, ofFeature)) continue;

                    result.Add(edge);
                }
            }
            return result;
        }

        private static List<object> QueryFeatures(IModelDoc2 doc, Args a, out string? error)
        {
            error = null;
            var result = new List<object>();
            string? type = a.Get("type");
            string? nameLike = a.Get("name");

            var feat = doc.FirstFeature() as IFeature;
            while (feat != null)
            {
                bool ok = true;
                if (type != null && !string.Equals(feat.GetTypeName2(), type, StringComparison.OrdinalIgnoreCase))
                    ok = false;
                if (nameLike != null && feat.Name.IndexOf(nameLike, StringComparison.OrdinalIgnoreCase) < 0)
                    ok = false;
                if (a.Has("suppressed") && !feat.IsSuppressed()) ok = false;
                if (a.Has("errored") && feat.GetErrorCode2(out _) == (int)swFeatureError_e.swFeatureErrorNone)
                    ok = false;

                if (ok) result.Add(feat);
                feat = feat.GetNextFeature() as IFeature;
            }
            return result;
        }

        private static List<object> QueryBodies(IModelDoc2 doc, Args a, out string? error)
        {
            error = null;
            var result = new List<object>();
            foreach (var b in BodiesOf(doc)) result.Add(b);
            return result;
        }

        // ── predicates ──────────────────────────────────────────────────────────────

        private static double EdgeLengthMm(IEdge edge)
        {
            try
            {
                var cp = edge.IGetCurveParams3(out _);
                return Math.Abs(cp.UMaxValue - cp.UMinValue) * 1000.0;
            }
            catch { return 0; }
        }

        /// <summary>An edge is "vertical" when its direction is parallel to model +Z.</summary>
        private static bool IsVertical(IEdge edge)
        {
            try
            {
                var curve = edge.IGetCurve();
                if (!curve.IsLine()) return false;
                var lp = curve.LineParams as double[];
                if (lp == null || lp.Length < 6) return false;
                double dx = lp[3], dy = lp[4], dz = lp[5];
                double len = Math.Sqrt(dx * dx + dy * dy + dz * dz);
                if (len < Tol) return false;
                return Math.Abs(Math.Abs(dz / len) - 1.0) < 1e-3;
            }
            catch { return false; }
        }

        /// <summary>Null when convexity cannot be determined (e.g. a non-manifold edge).</summary>
        private static bool? IsConvex(IEdge edge)
        {
            try
            {
                var faces = edge.GetTwoAdjacentFaces2() as object[];
                if (faces == null || faces.Length < 2) return null;

                var f1 = faces[0] as IFace2;
                var f2 = faces[1] as IFace2;
                if (f1 == null || f2 == null) return null;

                var mid = edge.IGetCurve().Evaluate2(
                    (edge.IGetCurveParams3(out _).UMinValue + edge.IGetCurveParams3(out _).UMaxValue) / 2, 0) as double[];
                if (mid == null || mid.Length < 3) return null;

                var n1 = f1.GetClosestPointOn(mid[0], mid[1], mid[2]) as double[];
                var n2 = f2.GetClosestPointOn(mid[0], mid[1], mid[2]) as double[];
                if (n1 == null || n2 == null) return null;

                // Compare face normals at the shared point: diverging normals => convex.
                var nv1 = f1.Normal as double[];
                var nv2 = f2.Normal as double[];
                if (nv1 == null || nv2 == null) return null;

                double dot = nv1[0] * nv2[0] + nv1[1] * nv2[1] + nv1[2] * nv2[2];
                return dot < 1.0 - Tol;
            }
            catch { return null; }
        }

        private static bool NormalMatches(IFace2 face, string spec)
        {
            var n = face.Normal as double[];
            if (n == null || n.Length < 3) return false;

            double sign = spec.StartsWith("-") ? -1 : 1;
            char axis = char.ToUpperInvariant(spec[spec.Length - 1]);

            double c = axis == 'X' ? n[0] : axis == 'Y' ? n[1] : n[2];
            return Math.Abs(c - sign) < 1e-3;
        }

        private static bool BelongsToFeature(object entity, string featureName)
        {
            try
            {
                var ent = entity as IEntity;
                var feat = ent?.GetComponent() as IFeature;
                if (feat != null)
                    return feat.Name.Equals(featureName, StringComparison.OrdinalIgnoreCase);

                // Faces expose their originating feature directly.
                if (entity is IFace2 face && face.IGetFeature() is IFeature ff)
                    return ff.Name.Equals(featureName, StringComparison.OrdinalIgnoreCase);
            }
            catch { /* fall through */ }
            return true;   // unknown provenance: do not exclude
        }
    }
}

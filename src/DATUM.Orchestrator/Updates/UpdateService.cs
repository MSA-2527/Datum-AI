using System;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Datum.Orchestrator.Updates;

/// <summary>
/// Update channel.
///
/// This ships to engineering workstations that run licensed CAD software, so the update
/// path has to be conservative in ways a consumer app's does not:
///
///   - **Never auto-install.** An update that restarts the orchestrator mid-batch would
///     abandon a release run. Downloads are staged; the user chooses when to apply.
///   - **Verify before staging.** A hash mismatch means the payload is corrupt or
///     substituted; either way it must never reach disk as a runnable installer.
///   - **Channels are explicit.** A site that pins to `stable` must not silently receive
///     a beta because someone changed a default.
///
/// The manifest is fetched over HTTPS; the hash is what actually establishes trust, since
/// TLS only proves who served the file, not that it is the file we expected.
/// </summary>
public sealed class UpdateService
{
    private readonly HttpClient _http;
    private readonly ILogger _log;
    private readonly string _stagingDir;

    public UpdateService(HttpClient http, ILogger log, string stagingDir)
    {
        _http = http;
        _log = log;
        _stagingDir = stagingDir;
    }

    public enum Channel { Stable, Beta }

    public sealed record Release
    {
        [JsonPropertyName("version")] public string Version { get; init; } = "";
        [JsonPropertyName("channel")] public string Channel { get; init; } = "stable";
        [JsonPropertyName("url")] public string Url { get; init; } = "";
        [JsonPropertyName("sha256")] public string Sha256 { get; init; } = "";
        [JsonPropertyName("sizeBytes")] public long SizeBytes { get; init; }
        [JsonPropertyName("notes")] public string? Notes { get; init; }
        [JsonPropertyName("minimumVersion")] public string? MinimumVersion { get; init; }
    }

    public sealed record Manifest
    {
        [JsonPropertyName("releases")] public Release[] Releases { get; init; } = Array.Empty<Release>();
    }

    public enum CheckState { UpToDate, UpdateAvailable, Unreachable, Malformed }

    public sealed record CheckResult(CheckState State, Release? Release, string Message);

    /// <summary>
    /// Looks for a newer release on the given channel.
    ///
    /// An unreachable manifest is reported, never thrown: a site with no outbound internet
    /// is a supported configuration, and update checking must not be a startup failure.
    /// </summary>
    public async Task<CheckResult> CheckAsync(
        string manifestUrl,
        Version current,
        Channel channel = Channel.Stable,
        CancellationToken ct = default)
    {
        Manifest? manifest;
        try
        {
            string json = await _http.GetStringAsync(manifestUrl, ct);
            manifest = JsonSerializer.Deserialize<Manifest>(json);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            _log.LogInformation("Update check skipped: {Reason}", ex.Message);
            return new CheckResult(CheckState.Unreachable, null,
                "Could not reach the update server. DATUM works normally offline.");
        }

        if (manifest?.Releases is null || manifest.Releases.Length == 0)
            return new CheckResult(CheckState.Malformed, null, "The update manifest is empty or malformed.");

        Release? best = null;
        Version? bestVersion = null;

        foreach (var release in manifest.Releases)
        {
            if (!string.Equals(release.Channel, channel.ToString(), StringComparison.OrdinalIgnoreCase))
                continue;

            // A malformed version in one entry must not discard the whole manifest.
            if (!Version.TryParse(release.Version, out var v)) continue;
            if (v <= current) continue;

            // A release can declare a floor: upgrading across a breaking schema change
            // may require passing through an intermediate build first.
            if (!string.IsNullOrEmpty(release.MinimumVersion)
                && Version.TryParse(release.MinimumVersion, out var min)
                && current < min)
            {
                continue;
            }

            if (bestVersion is null || v > bestVersion) { best = release; bestVersion = v; }
        }

        if (best is null)
            return new CheckResult(CheckState.UpToDate, null, $"DATUM {current} is up to date.");

        return new CheckResult(CheckState.UpdateAvailable, best,
            $"DATUM {best.Version} is available.");
    }

    public sealed record StageResult(bool Ok, string? Path, string Message);

    /// <summary>
    /// Downloads a release and verifies it before it lands anywhere runnable.
    ///
    /// The download goes to a `.partial` file and is only renamed once the hash matches.
    /// An interrupted download therefore cannot be mistaken for a complete installer, and
    /// a substituted payload never gets a `.msi` extension at all.
    /// </summary>
    public async Task<StageResult> StageAsync(Release release, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(release.Url) || string.IsNullOrWhiteSpace(release.Sha256))
            return new StageResult(false, null, "The release entry is missing a URL or hash.");

        Directory.CreateDirectory(_stagingDir);

        string finalPath = Path.Combine(_stagingDir, $"DATUM-{release.Version}.msi");
        string partPath = finalPath + ".partial";

        try
        {
            await using (var src = await _http.GetStreamAsync(release.Url, ct))
            await using (var dst = new FileStream(partPath, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                await src.CopyToAsync(dst, ct);
            }

            string actual = await Sha256Async(partPath, ct);
            if (!string.Equals(actual, release.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                // Corrupt or substituted. Delete it — leaving a bad installer on disk is
                // how someone ends up running it anyway.
                File.Delete(partPath);
                _log.LogError("Update {Version} failed hash verification.", release.Version);
                return new StageResult(false, null,
                    "The downloaded update did not match its published checksum and was discarded.");
            }

            File.Move(partPath, finalPath, overwrite: true);
            _log.LogInformation("Update {Version} staged at {Path}.", release.Version, finalPath);

            return new StageResult(true, finalPath,
                $"DATUM {release.Version} is ready to install. It will not be applied until you choose to.");
        }
        catch (OperationCanceledException)
        {
            TryDelete(partPath);
            throw;
        }
        catch (Exception ex)
        {
            TryDelete(partPath);
            _log.LogWarning(ex, "Update download failed.");
            return new StageResult(false, null, $"The update could not be downloaded: {ex.Message}");
        }
    }

    /// <summary>Staged updates that were downloaded but never applied.</summary>
    public string[] StagedUpdates() =>
        Directory.Exists(_stagingDir) ? Directory.GetFiles(_stagingDir, "DATUM-*.msi") : Array.Empty<string>();

    /// <summary>Clears staged payloads — used after a successful install, and by support.</summary>
    public int ClearStaged()
    {
        int n = 0;
        foreach (var f in StagedUpdates())
        {
            if (TryDelete(f)) n++;
        }
        return n;
    }

    private static bool TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) { File.Delete(path); return true; }
        }
        catch { /* a locked staged file is not worth failing over */ }
        return false;
    }

    internal static async Task<string> Sha256Async(string path, CancellationToken ct)
    {
        await using var stream = new FileStream(
            path, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, useAsync: true);
        using var sha = SHA256.Create();
        return Convert.ToHexString(await sha.ComputeHashAsync(stream, ct)).ToLowerInvariant();
    }
}

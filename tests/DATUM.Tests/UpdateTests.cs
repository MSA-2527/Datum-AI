using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Datum.Orchestrator.Updates;
using Microsoft.Extensions.Logging.Abstractions;

namespace Datum.Tests;

/// <summary>
/// Update-channel tests.
///
/// An updater is a privileged thing: it downloads code and puts it somewhere the user
/// will run it. The properties worth asserting are the refusals — a corrupt payload must
/// be discarded, a pinned channel must not drift, and an unreachable server must not
/// break startup for a site with no outbound internet.
/// </summary>
public sealed class UpdateServiceTests : IDisposable
{
    private readonly string _staging;

    public UpdateServiceTests()
    {
        _staging = Path.Combine(Path.GetTempPath(), "datum-updates", Guid.NewGuid().ToString("N"));
    }

    public void Dispose()
    {
        try { Directory.Delete(_staging, recursive: true); } catch { }
    }

    /// <summary>Serves canned responses so tests never touch the network.</summary>
    private sealed class StubHandler : HttpMessageHandler
    {
        public string? Json;
        public byte[]? Payload;
        public bool ThrowOnSend;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (ThrowOnSend) throw new HttpRequestException("no route to host");

            HttpContent content = Payload is not null && request.RequestUri!.AbsolutePath.EndsWith(".msi")
                ? new ByteArrayContent(Payload)
                : new StringContent(Json ?? "{}", Encoding.UTF8, "application/json");

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
        }
    }

    private UpdateService Service(StubHandler handler) =>
        new(new HttpClient(handler), NullLogger.Instance, _staging);

    private static string Manifest(params string[] entries) =>
        "{\"releases\":[" + string.Join(",", entries) + "]}";

    private static string Entry(string version, string channel = "stable",
                                string sha = "abc", string? minimum = null) =>
        $$"""
        {"version":"{{version}}","channel":"{{channel}}","url":"https://x/DATUM-{{version}}.msi",
         "sha256":"{{sha}}","sizeBytes":1024{{(minimum is null ? "" : $",\"minimumVersion\":\"{minimum}\"")}}}
        """;

    [Fact]
    public async Task ReportsUpToDateWhenNothingIsNewer()
    {
        var svc = Service(new StubHandler { Json = Manifest(Entry("0.9.0")) });
        var result = await svc.CheckAsync("https://x/manifest.json", new Version(1, 0, 0));

        Assert.Equal(UpdateService.CheckState.UpToDate, result.State);
        Assert.Null(result.Release);
    }

    [Fact]
    public async Task FindsTheNewestReleaseOnTheChannel()
    {
        var svc = Service(new StubHandler
        {
            Json = Manifest(Entry("1.1.0"), Entry("1.3.0"), Entry("1.2.0")),
        });

        var result = await svc.CheckAsync("https://x/manifest.json", new Version(1, 0, 0));

        Assert.Equal(UpdateService.CheckState.UpdateAvailable, result.State);
        Assert.Equal("1.3.0", result.Release!.Version);
    }

    [Fact]
    public async Task NeverOffersABetaToAStableChannel()
    {
        var svc = Service(new StubHandler
        {
            Json = Manifest(Entry("2.0.0", channel: "beta"), Entry("1.1.0", channel: "stable")),
        });

        var result = await svc.CheckAsync("https://x/manifest.json", new Version(1, 0, 0));

        // A site pinned to stable must not silently receive a beta because it sorts higher.
        Assert.Equal("1.1.0", result.Release!.Version);
    }

    [Fact]
    public async Task HonoursAMinimumVersionFloor()
    {
        // 3.0.0 requires passing through 2.0.0 first — typically a breaking schema change.
        var svc = Service(new StubHandler { Json = Manifest(Entry("3.0.0", minimum: "2.0.0")) });

        var result = await svc.CheckAsync("https://x/manifest.json", new Version(1, 0, 0));
        Assert.Equal(UpdateService.CheckState.UpToDate, result.State);

        var fromTwo = await svc.CheckAsync("https://x/manifest.json", new Version(2, 0, 0));
        Assert.Equal(UpdateService.CheckState.UpdateAvailable, fromTwo.State);
    }

    [Fact]
    public async Task AnUnreachableServerIsReportedNotThrown()
    {
        var svc = Service(new StubHandler { ThrowOnSend = true });
        var result = await svc.CheckAsync("https://x/manifest.json", new Version(1, 0, 0));

        // An air-gapped site is a supported configuration, not a startup failure.
        Assert.Equal(UpdateService.CheckState.Unreachable, result.State);
        Assert.Contains("offline", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task AMalformedManifestIsRejected()
    {
        var svc = Service(new StubHandler { Json = "{\"releases\":[]}" });
        var result = await svc.CheckAsync("https://x/manifest.json", new Version(1, 0, 0));
        Assert.Equal(UpdateService.CheckState.Malformed, result.State);
    }

    [Fact]
    public async Task AnUnparseableVersionDoesNotDiscardTheWholeManifest()
    {
        var svc = Service(new StubHandler
        {
            Json = Manifest(Entry("not-a-version"), Entry("1.5.0")),
        });

        var result = await svc.CheckAsync("https://x/manifest.json", new Version(1, 0, 0));
        Assert.Equal("1.5.0", result.Release!.Version);
    }

    [Fact]
    public async Task StagesAPayloadThatMatchesItsHash()
    {
        byte[] payload = Encoding.UTF8.GetBytes("pretend this is an MSI");
        string sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(payload)).ToLowerInvariant();

        var svc = Service(new StubHandler { Payload = payload });
        var release = new UpdateService.Release
        {
            Version = "1.2.0",
            Url = "https://x/DATUM-1.2.0.msi",
            Sha256 = sha,
        };

        var result = await svc.StageAsync(release);

        Assert.True(result.Ok);
        Assert.True(File.Exists(result.Path));
        // Staged, not installed. Applying an update mid-batch would abandon a release run.
        Assert.Contains("will not be applied", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task DiscardsAPayloadWhoseHashDoesNotMatch()
    {
        var svc = Service(new StubHandler { Payload = Encoding.UTF8.GetBytes("substituted content") });
        var release = new UpdateService.Release
        {
            Version = "1.2.0",
            Url = "https://x/DATUM-1.2.0.msi",
            Sha256 = new string('0', 64),
        };

        var result = await svc.StageAsync(release);

        Assert.False(result.Ok);
        Assert.Null(result.Path);

        // Nothing runnable may survive. Leaving a bad installer on disk is how someone
        // ends up executing it anyway.
        Assert.Empty(svc.StagedUpdates());
        Assert.False(Directory.Exists(_staging) && Directory.GetFiles(_staging, "*.partial").Length > 0);
    }

    [Fact]
    public async Task RejectsAReleaseMissingItsHash()
    {
        var svc = Service(new StubHandler { Payload = new byte[] { 1, 2, 3 } });
        var result = await svc.StageAsync(new UpdateService.Release
        {
            Version = "1.2.0",
            Url = "https://x/DATUM-1.2.0.msi",
            Sha256 = "",
        });

        // Without a hash there is nothing to verify against, so the download is refused
        // rather than trusted on TLS alone.
        Assert.False(result.Ok);
    }

    [Fact]
    public async Task ClearStagedRemovesDownloadedPayloads()
    {
        byte[] payload = Encoding.UTF8.GetBytes("msi");
        string sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(payload)).ToLowerInvariant();

        var svc = Service(new StubHandler { Payload = payload });
        await svc.StageAsync(new UpdateService.Release
        {
            Version = "1.2.0", Url = "https://x/DATUM-1.2.0.msi", Sha256 = sha,
        });

        Assert.Single(svc.StagedUpdates());
        Assert.Equal(1, svc.ClearStaged());
        Assert.Empty(svc.StagedUpdates());
    }
}

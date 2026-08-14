using System;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Datum.Studio;

/// <summary>
/// Finds the running orchestrator.
///
/// The port is chosen at random on each start so several SOLIDWORKS seats can run side by
/// side, which means the shell cannot assume a fixed address. The orchestrator writes its
/// port and session token to a handshake file under the user's own LocalAppData; this
/// reads it and verifies the service is genuinely alive before handing the address to the
/// WebView.
/// </summary>
public sealed class SessionDiscovery
{
    public sealed record Session(int Port, string Token, int Pid)
    {
        public string BaseUrl => $"http://127.0.0.1:{Port}";
        public string StudioUrl => $"{BaseUrl}/index.html?surface=studio&token={Token}";
    }

    public enum State
    {
        Searching,
        Connected,
        /// <summary>Handshake file absent — the orchestrator has never run, or is stopped.</summary>
        NotRunning,
        /// <summary>Handshake file present but the service does not answer — stale file.</summary>
        Stale,
    }

    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(3) };

    public static string HandshakePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "DATUM",
        "session.json");

    public sealed record Result(State State, Session? Session, string Message);

    public async Task<Result> DiscoverAsync(CancellationToken ct = default)
    {
        if (!File.Exists(HandshakePath))
        {
            return new Result(State.NotRunning, null,
                "DATUM.Orchestrator is not running. Start it, then reconnect.");
        }

        Session? session;
        try
        {
            // Share the read: the orchestrator may be rewriting this file as we look.
            await using var stream = new FileStream(
                HandshakePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            session = await JsonSerializer.DeserializeAsync<Session>(stream, cancellationToken: ct);
        }
        catch (Exception ex)
        {
            return new Result(State.Stale, null, $"The handshake file is unreadable: {ex.Message}");
        }

        if (session is null || session.Port <= 0 || string.IsNullOrEmpty(session.Token))
            return new Result(State.Stale, null, "The handshake file is incomplete.");

        // A file on disk proves nothing — the service may have been killed without
        // cleaning up. Probe before telling the user we are connected.
        try
        {
            using var res = await _http.GetAsync($"{session.BaseUrl}/health", ct);
            if (!res.IsSuccessStatusCode)
                return new Result(State.Stale, session, $"The orchestrator answered {(int)res.StatusCode}.");
        }
        catch (Exception)
        {
            return new Result(State.Stale, session,
                $"Nothing is listening on port {session.Port}. The orchestrator may have stopped without cleaning up.");
        }

        return new Result(State.Connected, session, $"Connected on port {session.Port}.");
    }
}

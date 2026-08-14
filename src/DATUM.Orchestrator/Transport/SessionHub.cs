using System;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Datum.Contracts;
using Microsoft.Extensions.Logging;

namespace Datum.Orchestrator.Transport;

/// <summary>
/// WebSocket fan-out to every connected UI surface — the task pane, the Studio window,
/// and any additional panel the user has open. All of them share one state stream, so
/// they can never disagree about what the model looks like.
/// </summary>
public sealed class SessionHub
{
    private readonly ConcurrentDictionary<string, Client> _clients = new();
    private readonly ILogger<SessionHub> _log;

    public SessionHub(ILogger<SessionHub> log) { _log = log; }

    private sealed class Client
    {
        public required WebSocket Socket;
        public required string Surface;              // "panel" | "studio"
        public readonly SemaphoreSlim SendLock = new(1, 1);
    }

    public int ClientCount => _clients.Count;

    public async Task HandleAsync(WebSocket socket, string surface, CancellationToken ct)
    {
        string id = Guid.NewGuid().ToString("N");
        _clients[id] = new Client { Socket = socket, Surface = surface };
        _log.LogInformation("UI connected ({Surface}); {N} client(s).", surface, _clients.Count);

        var buffer = new byte[16 * 1024];
        try
        {
            while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                var res = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                if (res.MessageType == WebSocketMessageType.Close) break;
                // Inbound traffic is heartbeat only; commands go over HTTP where they
                // get proper status codes and can be retried idempotently.
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException ex) { _log.LogDebug("UI socket closed: {Msg}", ex.Message); }
        finally
        {
            _clients.TryRemove(id, out _);
            _log.LogInformation("UI disconnected; {N} client(s) remain.", _clients.Count);
        }
    }

    public Task BroadcastAsync(string type, object? payload) =>
        SendRawAsync(JsonSerializer.Serialize(new { type, payload }, IrJson.Options));

    /// <summary>
    /// Deltas are re-encoded as compact JSON for the browser. The binary form exists for
    /// the pipe hop, where volume is highest; by the time a batch reaches here it has
    /// already been coalesced down to what the UI actually needs to render.
    /// </summary>
    public Task BroadcastDeltasAsync(StateDelta[] deltas)
    {
        if (deltas.Length == 0) return Task.CompletedTask;

        var items = new object[deltas.Length];
        for (int i = 0; i < deltas.Length; i++)
        {
            ref var d = ref deltas[i];
            items[i] = new
            {
                k = (int)d.Kind,
                doc = d.DocId,
                t = d.TargetId,
                a = d.NumA,
                b = d.NumB,
                s = d.Text,
                ts = d.TimestampTicks
            };
        }

        return SendRawAsync(JsonSerializer.Serialize(new { type = "deltas", payload = items }, IrJson.Options));
    }

    private async Task SendRawAsync(string json)
    {
        if (_clients.IsEmpty) return;
        var bytes = Encoding.UTF8.GetBytes(json);

        foreach (var (id, client) in _clients)
        {
            if (client.Socket.State != WebSocketState.Open)
            {
                _clients.TryRemove(id, out _);
                continue;
            }

            // Per-client lock: concurrent SendAsync on one WebSocket is undefined
            // behaviour and corrupts the frame stream.
            await client.SendLock.WaitAsync();
            try
            {
                await client.Socket.SendAsync(
                    new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch (Exception ex)
            {
                _log.LogDebug("Dropping UI client {Id}: {Msg}", id, ex.Message);
                _clients.TryRemove(id, out _);
            }
            finally { client.SendLock.Release(); }
        }
    }
}

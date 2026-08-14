using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Datum.Contracts;
using Microsoft.Extensions.Logging;

namespace Datum.Orchestrator.Transport;

/// <summary>
/// Named-pipe server, one instance per connected SOLIDWORKS process.
///
/// The pipe ACL is restricted to the interactive user's own SID: on a shared
/// workstation no other account can reach into the CAD session, and nothing is
/// listening on a network-visible socket.
/// </summary>
public sealed class PipeServer : IAsyncDisposable
{
    private readonly ILogger<PipeServer> _log;
    private readonly SessionHub _hub;
    private readonly int _swPid;
    private readonly string _pipeName;

    private readonly ConcurrentDictionary<string, TaskCompletionSource<KernelResult>> _pending = new();

    /// <summary>
    /// Serialises writes. A pipe carries length-prefixed frames, so two concurrent
    /// WriteAsync calls interleave their bytes and permanently desynchronise the kernel's
    /// reader — and concurrent calls are the normal case here, because the panel fires
    /// highlight and context requests while a plan is applying.
    /// </summary>
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    private NamedPipeServerStream? _pipe;
    private CancellationTokenSource? _cts;
    private Task? _loop;

    public bool IsConnected { get; private set; }
    public event Action<StateDelta[]>? DeltasReceived;
    public event Action<OpProgress>? ProgressReceived;

    public PipeServer(int swPid, SessionHub hub, ILogger<PipeServer> log)
    {
        _swPid = swPid;
        _hub = hub;
        _log = log;
        _pipeName = "datum.kernel." + swPid;
    }

    public void Start()
    {
        _cts = new CancellationTokenSource();
        _loop = Task.Run(() => AcceptLoop(_cts.Token));
    }

    private async Task AcceptLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                _pipe = CreatePipe();
                _log.LogInformation("Waiting for kernel on \\\\.\\pipe\\{Pipe}", _pipeName);

                await _pipe.WaitForConnectionAsync(ct);
                IsConnected = true;
                await _hub.BroadcastAsync("kernel.connected", new { pid = _swPid });
                _log.LogInformation("Kernel connected (SOLIDWORKS pid {Pid}).", _swPid);

                await ReadLoop(ct);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Pipe accept loop error; retrying.");
                // Never let the backoff itself throw out of the loop on shutdown — the
                // finally block below still has to fail every pending call.
                try { await Task.Delay(1000, ct); }
                catch (OperationCanceledException) { /* shutting down */ }
            }
            finally
            {
                IsConnected = false;
                await _hub.BroadcastAsync("kernel.disconnected", new { pid = _swPid });
                FailAllPending("The SOLIDWORKS connection dropped.");
                try { _pipe?.Dispose(); } catch { }
                _pipe = null;
            }
        }
    }

    private NamedPipeServerStream CreatePipe()
    {
        var security = new PipeSecurity();
        var user = WindowsIdentity.GetCurrent().User!;
        security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.FullControl, AccessControlType.Allow));

        return NamedPipeServerStreamAcl.Create(
            _pipeName, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous,
            inBufferSize: 1 << 16, outBufferSize: 1 << 16, pipeSecurity: security);
    }

    private async Task ReadLoop(CancellationToken ct)
    {
        var header = new byte[FrameCodec.HeaderSize];

        while (_pipe is { IsConnected: true } && !ct.IsCancellationRequested)
        {
            if (!await ReadExactAsync(header, FrameCodec.HeaderSize, ct)) break;
            if (!FrameCodec.TryReadHeader(header, out var type, out int len))
            {
                _log.LogWarning("Malformed frame header; dropping connection.");
                break;
            }

            byte[] payload = len > 0 ? new byte[len] : Array.Empty<byte>();
            if (len > 0 && !await ReadExactAsync(payload, len, ct)) break;

            try { await Dispatch(type, payload); }
            catch (Exception ex) { _log.LogError(ex, "Frame dispatch failed ({Type}).", type); }
        }
    }

    private async Task Dispatch(FrameType type, byte[] payload)
    {
        switch (type)
        {
            case FrameType.DeltaBatch:
            {
                var deltas = DeltaCodec.Read(payload);
                DeltasReceived?.Invoke(deltas);
                // Straight through to every connected UI surface. This is the path that
                // makes the panel feel live rather than request/response.
                await _hub.BroadcastDeltasAsync(deltas);
                break;
            }

            case FrameType.CommandResult:
            {
                var result = IrJson.Deserialize<KernelResult>(Encoding.UTF8.GetString(payload));
                if (result != null && _pending.TryRemove(result.Id, out var tcs))
                    tcs.TrySetResult(result);
                break;
            }

            case FrameType.Progress:
            {
                var p = IrJson.Deserialize<OpProgress>(Encoding.UTF8.GetString(payload));
                if (p != null)
                {
                    ProgressReceived?.Invoke(p);
                    await _hub.BroadcastAsync("plan.progress", p);
                }
                break;
            }

            case FrameType.UiRequest:
            {
                // A gesture made in SOLIDWORKS itself — a ribbon button, or right-click
                // "Ask DATUM" on a face. Straight through to every open panel.
                var req = IrJson.Deserialize<UiRequest>(Encoding.UTF8.GetString(payload));
                if (req != null && req.Verb.Length > 0)
                {
                    // An absent payload deserialises to an Undefined JsonElement, which
                    // throws if handed to the serializer. Send null instead.
                    object? body = req.Payload.ValueKind == JsonValueKind.Undefined
                        ? null
                        : req.Payload;
                    await _hub.BroadcastAsync("ui." + req.Verb, body);
                }
                break;
            }

            case FrameType.Hello:
                _log.LogInformation("Kernel hello: {Json}", Encoding.UTF8.GetString(payload));
                break;

            case FrameType.Log:
                _log.LogDebug("Kernel: {Line}", Encoding.UTF8.GetString(payload));
                break;
        }
    }

    /// <summary>
    /// Send a command and await its result. Every call is bounded by a timeout: a hung
    /// kernel must surface as a clear error in the UI, never as a spinner that never ends.
    /// </summary>
    public async Task<KernelResult> CallAsync(KernelCommand cmd, TimeSpan? timeout = null)
    {
        if (_pipe is not { IsConnected: true })
            return KernelResult.Fail(cmd.Id, "disconnected", "SOLIDWORKS is not connected.");

        var tcs = new TaskCompletionSource<KernelResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[cmd.Id] = tcs;

        try
        {
            byte[] body = JsonSerializer.SerializeToUtf8Bytes(cmd, IrJson.Options);
            byte[] frame = new byte[FrameCodec.HeaderSize + body.Length];
            FrameCodec.WriteHeader(frame, FrameType.Command, body.Length);
            Buffer.BlockCopy(body, 0, frame, FrameCodec.HeaderSize, body.Length);

            await _writeLock.WaitAsync();
            try
            {
                await _pipe.WriteAsync(frame);
                await _pipe.FlushAsync();
            }
            finally { _writeLock.Release(); }

            var window = timeout ?? DefaultTimeoutFor(cmd.Verb);

            // WaitAsync owns the timer and tears it down as soon as the result lands.
            // A hand-rolled Task.WhenAny(…, Task.Delay(10 min)) would leave a timer
            // rooted for the full budget on every fast apply.
            try
            {
                return await tcs.Task.WaitAsync(window);
            }
            catch (TimeoutException)
            {
                _pending.TryRemove(cmd.Id, out _);
                return KernelResult.Fail(cmd.Id, "timeout",
                    $"SOLIDWORKS did not respond to '{cmd.Verb}' within {window.TotalSeconds:F0}s.");
            }
        }
        catch (Exception ex)
        {
            _pending.TryRemove(cmd.Id, out _);
            return KernelResult.Fail(cmd.Id, "transport", ex.Message);
        }
    }

    /// <summary>
    /// Verb-specific budgets. A slider drag that takes two seconds is broken; a plan
    /// apply on a 2000-feature assembly legitimately takes minutes.
    /// </summary>
    private static TimeSpan DefaultTimeoutFor(string verb) => verb switch
    {
        KernelCommand.SetParam => TimeSpan.FromSeconds(5),
        KernelCommand.Highlight or KernelCommand.ClearHighlight => TimeSpan.FromSeconds(5),
        KernelCommand.GetContext or KernelCommand.Capabilities => TimeSpan.FromSeconds(20),
        KernelCommand.ResolvePlan => TimeSpan.FromSeconds(60),
        KernelCommand.ApplyPlan or KernelCommand.DryRunPlan => TimeSpan.FromMinutes(10),
        _ => TimeSpan.FromSeconds(30)
    };

    private async Task<bool> ReadExactAsync(byte[] buffer, int count, CancellationToken ct)
    {
        int read = 0;
        while (read < count)
        {
            int n;
            try { n = await _pipe!.ReadAsync(buffer.AsMemory(read, count - read), ct); }
            catch (IOException) { return false; }
            catch (ObjectDisposedException) { return false; }
            if (n <= 0) return false;
            read += n;
        }
        return true;
    }

    private void FailAllPending(string reason)
    {
        foreach (var key in _pending.Keys)
            if (_pending.TryRemove(key, out var tcs))
                tcs.TrySetResult(KernelResult.Fail(key, "disconnected", reason));
    }

    public async ValueTask DisposeAsync()
    {
        _cts?.Cancel();
        if (_loop != null) { try { await _loop; } catch { } }
        try { _pipe?.Dispose(); } catch { }
        _cts?.Dispose();
        _writeLock.Dispose();
    }
}

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Datum.Contracts;
using Microsoft.Extensions.Logging;

namespace Datum.Orchestrator.Transport;

/// <summary>
/// Owns one <see cref="PipeServer"/> per running SOLIDWORKS process and routes commands
/// to the right one.
///
/// Multi-seat is a real scenario: designers routinely run two SOLIDWORKS instances, and
/// Pro's batch worker pool deliberately spawns more. Binding to a single global pipe
/// would make those collide silently.
/// </summary>
public sealed class KernelGateway : IAsyncDisposable
{
    private readonly ConcurrentDictionary<int, PipeServer> _servers = new();
    private readonly SessionHub _hub;
    private readonly ILoggerFactory _loggerFactory;
    private readonly ILogger<KernelGateway> _log;
    private Timer? _scanTimer;

    /// <summary>The seat the UI is currently attached to.</summary>
    public int ActivePid { get; private set; }

    public KernelGateway(SessionHub hub, ILoggerFactory loggerFactory, ILogger<KernelGateway> log)
    {
        _hub = hub; _loggerFactory = loggerFactory; _log = log;
    }

    public void Start()
    {
        Scan(null);
        // SOLIDWORKS may start after us, or restart; rescanning keeps the connection
        // automatic so the user never has to think about ordering.
        _scanTimer = new Timer(Scan, null, 5000, 5000);
    }

    private void Scan(object? _)
    {
        try
        {
            // GetProcessesByName hands back live Process objects holding OS handles.
            // This runs every five seconds for the life of the orchestrator, so the ids
            // are copied out and the handles released immediately.
            var found = Process.GetProcessesByName("SLDWORKS");
            var live = new HashSet<int>(found.Length);
            foreach (var p in found)
            {
                live.Add(p.Id);
                p.Dispose();
            }

            foreach (int pid in live)
            {
                if (_servers.ContainsKey(pid)) continue;

                var server = new PipeServer(pid, _hub, _loggerFactory.CreateLogger<PipeServer>());
                if (_servers.TryAdd(pid, server))
                {
                    server.Start();
                    if (ActivePid == 0) ActivePid = pid;
                    _log.LogInformation("Tracking SOLIDWORKS pid {Pid}.", pid);
                }
            }

            foreach (var pid in _servers.Keys.Where(k => !live.Contains(k)).ToList())
            {
                if (_servers.TryRemove(pid, out var dead))
                {
                    _ = dead.DisposeAsync();
                    _log.LogInformation("SOLIDWORKS pid {Pid} exited.", pid);
                    if (ActivePid == pid) ActivePid = _servers.Keys.FirstOrDefault();
                }
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Process scan failed.");
        }
    }

    public bool IsConnected =>
        ActivePid != 0 && _servers.TryGetValue(ActivePid, out var s) && s.IsConnected;

    public Task<KernelResult> CallAsync(KernelCommand cmd, int? pid = null, TimeSpan? timeout = null)
    {
        int target = pid ?? ActivePid;
        if (target == 0 || !_servers.TryGetValue(target, out var server))
            return Task.FromResult(KernelResult.Fail(cmd.Id, "disconnected",
                "SOLIDWORKS is not running. Start it, or keep working — Skills, history " +
                "and batch queues are all available offline."));

        return server.CallAsync(cmd, timeout);
    }

    public void SetActive(int pid)
    {
        if (_servers.ContainsKey(pid)) ActivePid = pid;
    }

    public async ValueTask DisposeAsync()
    {
        _scanTimer?.Dispose();
        foreach (var s in _servers.Values) await s.DisposeAsync();
        _servers.Clear();
    }
}

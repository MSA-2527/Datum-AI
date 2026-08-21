using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using Datum.Contracts;

namespace Datum.Connector.SolidWorks.Transport
{
    /// <summary>
    /// Duplex named-pipe client: kernel ⇄ orchestrator.
    ///
    /// Named pipes rather than TCP because the ACL can be restricted to the interactive
    /// user's SID, so no other account on the machine can reach the CAD process even on
    /// a shared workstation. The pipe name includes the SOLIDWORKS PID so multiple
    /// concurrent seats never collide.
    ///
    /// All I/O happens on dedicated threads; the STA thread only ever enqueues.
    /// Reconnection is automatic and silent — SOLIDWORKS must keep working perfectly
    /// well when the orchestrator is restarting.
    /// </summary>
    internal sealed class PipeClient : IDisposable
    {
        private readonly string _pipeName;
        private readonly BlockingCollection<ArraySegment<byte>> _outbox =
            new BlockingCollection<ArraySegment<byte>>(new ConcurrentQueue<ArraySegment<byte>>(), 4096);

        private NamedPipeClientStream? _pipe;
        private Thread? _rx;
        private Thread? _tx;
        private volatile bool _running = true;
        private volatile bool _connected;

        public event Action<KernelCommand>? CommandReceived;
        public event Action<bool>? ConnectionChanged;

        public bool IsConnected => _connected;

        public PipeClient(int solidWorksPid)
        {
            _pipeName = "datum.kernel." + solidWorksPid;
        }

        public void Start()
        {
            _rx = new Thread(ReceiveLoop) { IsBackground = true, Name = "DATUM.Pipe.Rx" };
            _tx = new Thread(SendLoop) { IsBackground = true, Name = "DATUM.Pipe.Tx" };
            _rx.Start();
            _tx.Start();
        }

        /// <summary>
        /// Non-blocking. Drops the frame if the outbox is saturated rather than blocking
        /// the delta pump — losing a redundant state update is far better than stalling.
        /// </summary>
        public void Send(ArraySegment<byte> frame)
        {
            if (!_connected) return;

            // The delta pump reuses its buffer, so the frame must be copied before it
            // crosses a thread boundary.
            var copy = new byte[frame.Count];
            Buffer.BlockCopy(frame.Array!, frame.Offset, copy, 0, frame.Count);

            if (!_outbox.TryAdd(new ArraySegment<byte>(copy)))
                KernelLog.Warn("Pipe outbox saturated; dropped a frame.");
        }

        public void SendJson(FrameType type, object payload)
        {
            string json = IrJson.Serialize(payload);
            byte[] body = Encoding.UTF8.GetBytes(json);
            byte[] frame = new byte[FrameCodec.HeaderSize + body.Length];
            FrameCodec.WriteHeader(frame, type, body.Length);
            Buffer.BlockCopy(body, 0, frame, FrameCodec.HeaderSize, body.Length);

            if (!_outbox.TryAdd(new ArraySegment<byte>(frame)))
                KernelLog.Warn("Pipe outbox saturated; dropped a JSON frame.");
        }

        // ── receive ─────────────────────────────────────────────────────────────────

        private void ReceiveLoop()
        {
            var header = new byte[FrameCodec.HeaderSize];

            while (_running)
            {
                try
                {
                    if (_pipe == null || !_pipe.IsConnected)
                    {
                        Connect();
                        if (!_connected) { Thread.Sleep(1000); continue; }
                    }

                    if (!ReadExact(header, FrameCodec.HeaderSize)) { Drop(); continue; }
                    if (!FrameCodec.TryReadHeader(header, out var type, out int len)) { Drop(); continue; }

                    byte[] payload = len > 0 ? new byte[len] : Array.Empty<byte>();
                    if (len > 0 && !ReadExact(payload, len)) { Drop(); continue; }

                    Dispatch(type, payload);
                }
                catch (IOException) { Drop(); }
                catch (ObjectDisposedException) { Drop(); }
                catch (Exception ex)
                {
                    KernelLog.Error("Pipe receive loop error", ex);
                    Drop();
                    Thread.Sleep(500);
                }
            }
        }

        private void Dispatch(FrameType type, byte[] payload)
        {
            switch (type)
            {
                case FrameType.Command:
                {
                    string json = Encoding.UTF8.GetString(payload);
                    var cmd = IrJson.Deserialize<KernelCommand>(json);
                    if (cmd != null) CommandReceived?.Invoke(cmd);
                    break;
                }
                case FrameType.Heartbeat:
                    break;   // liveness only
                case FrameType.Bye:
                    KernelLog.Info("Orchestrator said goodbye.");
                    Drop();
                    break;
                default:
                    KernelLog.Verbose("Ignoring inbound frame type " + type);
                    break;
            }
        }

        private bool ReadExact(byte[] buffer, int count)
        {
            int read = 0;
            while (read < count)
            {
                int n = _pipe!.Read(buffer, read, count - read);
                if (n <= 0) return false;
                read += n;
            }
            return true;
        }

        // ── send ────────────────────────────────────────────────────────────────────

        private void SendLoop()
        {
            while (_running)
            {
                try
                {
                    if (!_outbox.TryTake(out var frame, 250)) continue;
                    if (_pipe == null || !_pipe.IsConnected) continue;

                    _pipe.Write(frame.Array!, frame.Offset, frame.Count);
                    _pipe.Flush();
                }
                catch (IOException) { Drop(); }
                catch (ObjectDisposedException) { Drop(); }
                catch (Exception ex)
                {
                    KernelLog.Error("Pipe send loop error", ex);
                    Drop();
                }
            }
        }

        // ── connection ──────────────────────────────────────────────────────────────

        private void Connect()
        {
            try
            {
                _pipe?.Dispose();
                _pipe = new NamedPipeClientStream(".", _pipeName,
                    PipeDirection.InOut, PipeOptions.Asynchronous);

                _pipe.Connect(2000);
                _pipe.ReadMode = PipeTransmissionMode.Byte;

                _connected = true;
                ConnectionChanged?.Invoke(true);
                KernelLog.Info($"Connected to orchestrator on \\\\.\\pipe\\{_pipeName}.");

                SendJson(FrameType.Hello, new
                {
                    kernelVersion = typeof(PipeClient).Assembly.GetName().Version?.ToString(),
                    irVersion = Plan.CurrentIrVersion,
                    pid = System.Diagnostics.Process.GetCurrentProcess().Id
                });
            }
            catch (TimeoutException)
            {
                // Expected while the orchestrator is not yet running. Not an error.
                _connected = false;
            }
            catch (Exception ex)
            {
                _connected = false;
                KernelLog.Verbose("Pipe connect failed: " + ex.Message);
            }
        }

        private void Drop()
        {
            if (_connected)
            {
                _connected = false;
                ConnectionChanged?.Invoke(false);
                KernelLog.Info("Orchestrator connection dropped; will retry.");
            }
            try { _pipe?.Dispose(); } catch { }
            _pipe = null;
        }

        public void Dispose()
        {
            _running = false;
            try { _outbox.CompleteAdding(); } catch { }
            try { _pipe?.Dispose(); } catch { }
            try { _rx?.Join(500); } catch { }
            try { _tx?.Join(500); } catch { }
            _outbox.Dispose();
        }
    }
}

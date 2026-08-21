using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using Datum.Contracts;

namespace Datum.Connector.SolidWorks.Realtime
{
    /// <summary>
    /// Drains the <see cref="DeltaRing"/> on a background thread, coalesces redundant
    /// state updates inside a fixed window, and hands packed binary batches to the
    /// transport.
    ///
    /// Coalescing is not an optimisation, it is a correctness requirement for the UI:
    /// AddItemNotify can fire hundreds of times during a single pattern rebuild, and
    /// forwarding all of them would cause a render storm in the panel. State-like
    /// deltas (mass, rebuild status, selection) collapse to their newest value;
    /// event-like deltas (feature added / deleted / renamed) are never dropped because
    /// each one carries information the previous does not.
    /// </summary>
    internal sealed class DeltaPump : IDisposable
    {
        private const int WindowMs = 33;            // ~30 Hz
        private const int DrainBatch = 1024;
        private const int MaxBatchOut = 512;

        private readonly DeltaRing _ring;
        private readonly Action<ArraySegment<byte>> _send;
        private readonly Thread _thread;
        private readonly ManualResetEventSlim _wake = new ManualResetEventSlim(false);
        private volatile bool _running = true;

        // Reused for the lifetime of the process — the pump must not generate garbage
        // proportional to CAD activity.
        private readonly StateDelta[] _scratch = new StateDelta[DrainBatch];
        private readonly List<StateDelta> _out = new List<StateDelta>(MaxBatchOut);
        private readonly Dictionary<long, int> _coalesceIndex = new Dictionary<long, int>(256);
        private byte[] _wire = new byte[DeltaCodec.MaxBatchSize(MaxBatchOut) + FrameCodec.HeaderSize];

        public long BatchesSent;
        public long DeltasSent;
        public long DeltasCoalesced;

        public DeltaPump(DeltaRing ring, Action<ArraySegment<byte>> send)
        {
            _ring = ring ?? throw new ArgumentNullException(nameof(ring));
            _send = send ?? throw new ArgumentNullException(nameof(send));
            _thread = new Thread(Loop)
            {
                IsBackground = true,
                Name = "DATUM.DeltaPump",
                // Slightly above normal so a busy rebuild does not starve the UI feed,
                // but never above the CAD thread.
                Priority = ThreadPriority.AboveNormal
            };
        }

        public void Start() => _thread.Start();

        /// <summary>Nudge the pump when a latency-sensitive delta lands (e.g. selection change).</summary>
        public void Poke() => _wake.Set();

        private void Loop()
        {
            var sw = Stopwatch.StartNew();
            long nextDue = 0;

            while (_running)
            {
                long now = sw.ElapsedMilliseconds;
                if (now < nextDue)
                {
                    _wake.Wait((int)Math.Max(1, nextDue - now));
                    _wake.Reset();
                    continue;
                }
                nextDue = now + WindowMs;

                try
                {
                    PumpOnce();
                }
                catch (Exception ex)
                {
                    // The pump must never take the CAD process down with it.
                    KernelLog.Warn("DeltaPump iteration failed: " + ex.Message);
                    Thread.Sleep(50);
                }
            }
        }

        private void PumpOnce()
        {
            int n = _ring.Drain(_scratch);
            if (n == 0) return;

            _out.Clear();
            _coalesceIndex.Clear();

            for (int i = 0; i < n; i++)
            {
                ref StateDelta d = ref _scratch[i];

                if (d.IsCoalescable)
                {
                    long key = d.CoalesceKey;
                    if (_coalesceIndex.TryGetValue(key, out int at))
                    {
                        // Newer value supersedes the one already queued. Order is preserved
                        // because we overwrite in place rather than appending.
                        _out[at] = d;
                        DeltasCoalesced++;
                        continue;
                    }
                    _coalesceIndex[key] = _out.Count;
                }

                _out.Add(d);

                if (_out.Count >= MaxBatchOut)
                {
                    Flush();
                    _coalesceIndex.Clear();
                }
            }

            Flush();
        }

        private void Flush()
        {
            if (_out.Count == 0) return;

            int need = DeltaCodec.MaxBatchSize(_out.Count) + FrameCodec.HeaderSize;
            if (_wire.Length < need) _wire = new byte[need];

            // CopyTo avoids the List<T> enumerator allocation on the hot path.
            var arr = _scratchOut ??= new StateDelta[MaxBatchOut];
            if (arr.Length < _out.Count) arr = _scratchOut = new StateDelta[_out.Count];
            _out.CopyTo(arr, 0);

            int written = DeltaCodec.Write(
                new Span<byte>(_wire, FrameCodec.HeaderSize, _wire.Length - FrameCodec.HeaderSize),
                new ReadOnlySpan<StateDelta>(arr, 0, _out.Count));

            FrameCodec.WriteHeader(new Span<byte>(_wire, 0, FrameCodec.HeaderSize),
                                   FrameType.DeltaBatch, written);

            _send(new ArraySegment<byte>(_wire, 0, FrameCodec.HeaderSize + written));

            BatchesSent++;
            DeltasSent += _out.Count;
            _out.Clear();
        }

        private StateDelta[]? _scratchOut;

        public void Dispose()
        {
            _running = false;
            _wake.Set();
            try { _thread.Join(500); } catch { /* shutting down */ }
            _wake.Dispose();
        }
    }
}

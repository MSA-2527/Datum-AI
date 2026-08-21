using System;
using System.Runtime.CompilerServices;
using System.Threading;
using Datum.Contracts;

namespace Datum.Connector.SolidWorks.Realtime
{
    /// <summary>
    /// Single-producer / single-consumer lock-free ring buffer for state deltas.
    ///
    /// Why this exists: SOLIDWORKS notifications fire on the STA thread and must return
    /// in well under a millisecond. A slow handler freezes the CAD UI, which is the
    /// fastest possible way to get uninstalled. So handlers do exactly one thing —
    /// stamp a pre-allocated slot here — and a separate pump thread does all the
    /// serialisation and I/O.
    ///
    /// Producer: the SOLIDWORKS STA thread (only ever one).
    /// Consumer: the DeltaPump thread (only ever one).
    ///
    /// Capacity is a power of two so the index wrap is a mask rather than a modulo.
    /// On overflow the OLDEST entry is dropped, not the newest: during a storm the
    /// recent state is what the UI needs, and losing the tail of a stale burst is
    /// strictly better than blocking the CAD thread or unbounded memory growth.
    /// </summary>
    internal sealed class DeltaRing
    {
        private readonly StateDelta[] _slots;
        private readonly int _mask;

        // Padded to separate cache lines: head is written only by the producer,
        // tail only by the consumer. Sharing a line would cause false sharing on
        // every single notification.
        private PaddedLong _head;   // next write index
        private PaddedLong _tail;   // next read index
        private long _dropped;

        public DeltaRing(int capacity = 8192)
        {
            if (capacity < 2 || (capacity & (capacity - 1)) != 0)
                throw new ArgumentException("capacity must be a power of two >= 2", nameof(capacity));
            _slots = new StateDelta[capacity];
            _mask = capacity - 1;
        }

        public int Capacity => _slots.Length;
        public long Dropped => Interlocked.Read(ref _dropped);

        public int Count
        {
            get
            {
                long h = Volatile.Read(ref _head.Value);
                long t = Volatile.Read(ref _tail.Value);
                long n = h - t;
                return n < 0 ? 0 : (n > _slots.Length ? _slots.Length : (int)n);
            }
        }

        /// <summary>
        /// Producer side. Called from the SOLIDWORKS STA thread.
        /// Allocation-free and wait-free: a struct copy plus one volatile write.
        /// </summary>
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public void Write(DeltaKind kind, int docId, int targetId,
                          double numA = 0, double numB = 0, string? text = null)
        {
            long head = _head.Value;               // producer-exclusive, no interlock needed
            long tail = Volatile.Read(ref _tail.Value);

            if (head - tail >= _slots.Length)
            {
                // Full. Advance the consumer's tail past the oldest entry. The consumer
                // tolerates this: it re-reads tail each iteration and never assumes
                // monotonic ownership of a specific slot.
                Volatile.Write(ref _tail.Value, tail + 1);
                Interlocked.Increment(ref _dropped);
            }

            int i = (int)(head & _mask);
            ref StateDelta s = ref _slots[i];
            s.Kind = kind;
            s.DocId = docId;
            s.TargetId = targetId;
            s.NumA = numA;
            s.NumB = numB;
            s.Text = text;
            s.TimestampTicks = DateTime.UtcNow.Ticks;

            // Publish: everything above must be visible before the index moves.
            Volatile.Write(ref _head.Value, head + 1);
        }

        /// <summary>
        /// Consumer side. Drains up to <paramref name="dst"/>.Length entries.
        /// Returns the number written.
        /// </summary>
        public int Drain(Span<StateDelta> dst)
        {
            long tail = _tail.Value;                // consumer-exclusive
            long head = Volatile.Read(ref _head.Value);

            long available = head - tail;
            if (available <= 0) return 0;

            // If the producer lapped us, skip forward to the oldest still-valid entry.
            if (available > _slots.Length)
            {
                tail = head - _slots.Length;
                available = _slots.Length;
            }

            int n = (int)Math.Min(available, dst.Length);
            for (int k = 0; k < n; k++)
                dst[k] = _slots[(int)((tail + k) & _mask)];

            Volatile.Write(ref _tail.Value, tail + n);
            return n;
        }

        /// <summary>64-byte padded long, to keep head and tail off the same cache line.</summary>
        private struct PaddedLong
        {
#pragma warning disable CS0169, IDE0051 // padding fields are intentionally unused
            private long _p0, _p1, _p2, _p3;
            public long Value;
            private long _p4, _p5, _p6, _p7;
#pragma warning restore CS0169, IDE0051
        }
    }
}

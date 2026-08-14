using System;
using System.Buffers.Binary;
using System.Text;

namespace Datum.Contracts
{
    /// <summary>
    /// Kernel &lt;-&gt; Orchestrator framing.
    ///
    /// Design note: state deltas are small, fixed-shape and very high frequency
    /// (AddItemNotify alone can fire hundreds of times during a pattern rebuild),
    /// so they use a hand-rolled packed binary encoding with zero allocation on the
    /// write path. Commands and results are low frequency and structurally complex,
    /// so they stay JSON where readability and evolvability matter more than bytes.
    /// </summary>
    public enum FrameType : byte
    {
        Hello = 0x01,
        Heartbeat = 0x02,
        Bye = 0x03,
        DeltaBatch = 0x10,   // packed binary
        Command = 0x20,   // UTF-8 JSON
        CommandResult = 0x21,   // UTF-8 JSON
        Progress = 0x22,   // packed binary
        /// <summary>
        /// Kernel -&gt; Orchestrator -&gt; UI. A gesture made in the SOLIDWORKS UI itself
        /// (ribbon button, right-click "Ask DATUM") asking the panel to do something.
        /// Relayed over the same WebSocket the panel already listens on, so there stays
        /// exactly one path into the UI's state store.
        /// </summary>
        UiRequest = 0x23,   // UTF-8 JSON
        Log = 0x30    // UTF-8 text
    }

    /// <summary>Payload of <see cref="FrameType.UiRequest"/>.</summary>
    public sealed class UiRequest
    {
        [System.Text.Json.Serialization.JsonPropertyName("verb")]
        public string Verb { get; set; } = "";

        [System.Text.Json.Serialization.JsonPropertyName("payload")]
        public System.Text.Json.JsonElement Payload { get; set; }

        public const string TogglePanel = "panel.toggle";
        public const string FocusComposer = "composer.focus";
        public const string RunLint = "lint.run";
    }

    public enum DeltaKind : byte
    {
        None = 0,
        ActiveDocChanged = 1,
        DocOpened = 2,
        DocClosed = 3,
        FeatureAdded = 4,
        FeatureDeleted = 5,
        FeatureRenamed = 6,
        FeatureSuppression = 7,
        RebuildDone = 8,
        RebuildFailed = 9,
        SelectionChanged = 10,
        DimensionChanged = 11,
        GlobalVarChanged = 12,
        ConfigChanged = 13,
        MassProperties = 14,
        LintFindings = 15,
        PdmState = 16,
        SaveDone = 17,
        ComponentState = 18,
        ViewChanged = 19,
        ErrorCount = 20
    }

    /// <summary>
    /// One state change. Deliberately a struct with a fixed header plus an optional
    /// short UTF-8 payload so the STA event handler can stamp it into a pre-allocated
    /// ring slot without allocating.
    /// </summary>
    public struct StateDelta
    {
        public DeltaKind Kind;
        public int DocId;
        public int TargetId;
        public double NumA;
        public double NumB;
        /// <summary>Optional short text (feature name, config name...). Max 255 UTF-8 bytes.</summary>
        public string? Text;
        public long TimestampTicks;

        /// <summary>
        /// Coalescing key. The pump merges deltas sharing a key inside its 33 ms window
        /// and keeps only the newest — this is what stops a pattern rebuild from
        /// flooding the UI with hundreds of redundant messages.
        /// </summary>
        public long CoalesceKey => ((long)Kind << 56) ^ ((long)DocId << 32) ^ (uint)TargetId;

        /// <summary>Kinds where only the latest value matters, so older ones may be dropped.</summary>
        public bool IsCoalescable
        {
            get
            {
                switch (Kind)
                {
                    case DeltaKind.RebuildDone:
                    case DeltaKind.SelectionChanged:
                    case DeltaKind.MassProperties:
                    case DeltaKind.DimensionChanged:
                    case DeltaKind.GlobalVarChanged:
                    case DeltaKind.ViewChanged:
                    case DeltaKind.ErrorCount:
                    case DeltaKind.PdmState:
                        return true;
                    default:
                        return false; // adds/deletes/renames are events, not states — never drop
                }
            }
        }
    }

    /// <summary>
    /// Length-prefixed frame codec. Layout:
    ///   [u32 payloadLength LE][u8 frameType][payload...]
    /// </summary>
    public static class FrameCodec
    {
        public const int HeaderSize = 5;
        /// <summary>Guards against a corrupt length prefix allocating gigabytes.</summary>
        public const int MaxPayload = 32 * 1024 * 1024;

        public static void WriteHeader(Span<byte> dst, FrameType type, int payloadLength)
        {
            if (dst.Length < HeaderSize) throw new ArgumentException("header buffer too small", nameof(dst));
            BinaryPrimitives.WriteUInt32LittleEndian(dst, (uint)payloadLength);
            dst[4] = (byte)type;
        }

        public static bool TryReadHeader(ReadOnlySpan<byte> src, out FrameType type, out int payloadLength)
        {
            type = default; payloadLength = 0;
            if (src.Length < HeaderSize) return false;
            uint len = BinaryPrimitives.ReadUInt32LittleEndian(src);
            if (len > MaxPayload) return false;
            payloadLength = (int)len;
            type = (FrameType)src[4];
            return true;
        }
    }

    /// <summary>
    /// Packed binary encoder for delta batches. Writes into a caller-supplied span so
    /// the pump can reuse one pooled buffer for the lifetime of the process.
    ///
    /// Per-delta layout:
    ///   [u8 kind][i32 docId][i32 targetId][f64 numA][f64 numB][i64 ticks][u8 textLen][text...]
    /// </summary>
    public static class DeltaCodec
    {
        public const int FixedSize = 1 + 4 + 4 + 8 + 8 + 8 + 1; // 34 bytes
        public const int MaxTextBytes = 255;
        public const int MaxDeltaSize = FixedSize + MaxTextBytes;

        /// <summary>Upper bound for a batch of <paramref name="count"/> deltas.</summary>
        public static int MaxBatchSize(int count) => 2 + count * MaxDeltaSize;

        public static int Write(Span<byte> dst, ReadOnlySpan<StateDelta> deltas)
        {
            if (deltas.Length > ushort.MaxValue) throw new ArgumentException("batch too large", nameof(deltas));

            // The pump writes into one pooled buffer sized from MaxBatchSize and reuses it
            // forever. Checking up front turns a silent buffer overrun — which would
            // corrupt the frame stream and desynchronise the reader — into a loud failure.
            if (dst.Length < MaxBatchSize(deltas.Length))
                throw new ArgumentException(
                    "destination is smaller than DeltaCodec.MaxBatchSize(count)", nameof(dst));

            int o = 0;
            BinaryPrimitives.WriteUInt16LittleEndian(dst.Slice(o), (ushort)deltas.Length); o += 2;

            for (int i = 0; i < deltas.Length; i++)
            {
                ref readonly StateDelta d = ref deltas[i];
                dst[o++] = (byte)d.Kind;
                BinaryPrimitives.WriteInt32LittleEndian(dst.Slice(o), d.DocId); o += 4;
                BinaryPrimitives.WriteInt32LittleEndian(dst.Slice(o), d.TargetId); o += 4;
                BinaryPrimitives.WriteInt64LittleEndian(dst.Slice(o), BitConverter.DoubleToInt64Bits(d.NumA)); o += 8;
                BinaryPrimitives.WriteInt64LittleEndian(dst.Slice(o), BitConverter.DoubleToInt64Bits(d.NumB)); o += 8;
                BinaryPrimitives.WriteInt64LittleEndian(dst.Slice(o), d.TimestampTicks); o += 8;

                if (!string.IsNullOrEmpty(d.Text))
                {
                    byte[] tmp = Temp;
                    // Clamp the char count first: UTF-8 emits at most 4 bytes per char, so
                    // this bounds the encode without ever overflowing the scratch buffer,
                    // however long the incoming label is.
                    int chars = Math.Min(d.Text!.Length, tmp.Length / 4);
                    int textLen = Encoding.UTF8.GetBytes(d.Text!, 0, chars, tmp, 0);
                    if (textLen > MaxTextBytes) textLen = TrimToCharBoundary(tmp, MaxTextBytes);
                    dst[o++] = (byte)textLen;
                    new ReadOnlySpan<byte>(tmp, 0, textLen).CopyTo(dst.Slice(o));
                    o += textLen;
                }
                else
                {
                    dst[o++] = 0;
                }
            }
            return o;
        }

        public static StateDelta[] Read(ReadOnlySpan<byte> src)
        {
            int o = 0;
            ushort count = BinaryPrimitives.ReadUInt16LittleEndian(src.Slice(o)); o += 2;
            var result = new StateDelta[count];

            for (int i = 0; i < count; i++)
            {
                var d = new StateDelta();
                d.Kind = (DeltaKind)src[o++];
                d.DocId = BinaryPrimitives.ReadInt32LittleEndian(src.Slice(o)); o += 4;
                d.TargetId = BinaryPrimitives.ReadInt32LittleEndian(src.Slice(o)); o += 4;
                d.NumA = BitConverter.Int64BitsToDouble(BinaryPrimitives.ReadInt64LittleEndian(src.Slice(o))); o += 8;
                d.NumB = BitConverter.Int64BitsToDouble(BinaryPrimitives.ReadInt64LittleEndian(src.Slice(o))); o += 8;
                d.TimestampTicks = BinaryPrimitives.ReadInt64LittleEndian(src.Slice(o)); o += 8;
                int textLen = src[o++];
                if (textLen > 0)
                {
                    d.Text = Encoding.UTF8.GetString(src.Slice(o, textLen).ToArray());
                    o += textLen;
                }
                result[i] = d;
            }
            return result;
        }

        /// <summary>Never split a UTF-8 sequence when truncating an over-long label.</summary>
        private static int TrimToCharBoundary(byte[] buf, int max)
        {
            int i = max;
            while (i > 0 && (buf[i] & 0xC0) == 0x80) i--;
            return i;
        }

        [ThreadStatic] private static byte[]? _temp;
        private static byte[] Temp => _temp ??= new byte[1024];
    }
}

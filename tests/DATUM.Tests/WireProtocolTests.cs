using System.Text;

namespace Datum.Tests;

/// <summary>
/// The kernel↔orchestrator framing. These are the bytes that cross a process boundary
/// hundreds of times a second during a pattern rebuild; a decoding bug here shows up as
/// a panel that quietly stops matching the model, which is worse than a crash.
/// </summary>
public sealed class WireProtocolTests
{
    // ── framing ──────────────────────────────────────────────────────────────────

    [Theory]
    [InlineData(FrameType.Hello, 0)]
    [InlineData(FrameType.Command, 1)]
    [InlineData(FrameType.DeltaBatch, 65535)]
    [InlineData(FrameType.CommandResult, FrameCodec.MaxPayload)]
    public void FrameHeader_RoundTrips(FrameType type, int length)
    {
        var buf = new byte[FrameCodec.HeaderSize];

        FrameCodec.WriteHeader(buf, type, length);
        bool ok = FrameCodec.TryReadHeader(buf, out var readType, out int readLength);

        Assert.True(ok);
        Assert.Equal(type, readType);
        Assert.Equal(length, readLength);
    }

    [Fact]
    public void FrameHeader_IsLittleEndianAndFiveBytes()
    {
        var buf = new byte[FrameCodec.HeaderSize];
        FrameCodec.WriteHeader(buf, FrameType.Progress, 0x01020304);

        Assert.Equal(5, FrameCodec.HeaderSize);
        Assert.Equal(new byte[] { 0x04, 0x03, 0x02, 0x01, (byte)FrameType.Progress }, buf);
    }

    [Fact]
    public void FrameHeader_RejectsAnAbsurdLengthRatherThanAllocatingIt()
    {
        // A corrupt or hostile length prefix must not turn into a gigabyte allocation
        // inside SLDWORKS.exe.
        var buf = new byte[FrameCodec.HeaderSize];
        FrameCodec.WriteHeader(buf, FrameType.DeltaBatch, FrameCodec.MaxPayload);
        buf[3] = 0xFF;

        Assert.False(FrameCodec.TryReadHeader(buf, out _, out _));
    }

    [Fact]
    public void FrameHeader_RejectsATruncatedBuffer()
    {
        Assert.False(FrameCodec.TryReadHeader(new byte[FrameCodec.HeaderSize - 1], out _, out _));
        Assert.Throws<ArgumentException>(() =>
            FrameCodec.WriteHeader(new byte[FrameCodec.HeaderSize - 1], FrameType.Log, 0));
    }

    // ── delta batches ────────────────────────────────────────────────────────────

    [Fact]
    public void DeltaBatch_RoundTripsEveryField()
    {
        var source = new[]
        {
            new StateDelta
            {
                Kind = DeltaKind.FeatureAdded, DocId = 7, TargetId = 42,
                NumA = 1234.5678, NumB = -0.5, Text = "Boss-Extrude1", TimestampTicks = 638_000_000_000_000_000
            },
            new StateDelta { Kind = DeltaKind.RebuildDone, DocId = 7, TargetId = 0 },
            new StateDelta { Kind = DeltaKind.MassProperties, DocId = 7, NumA = 88.25, Text = null }
        };

        var buf = new byte[DeltaCodec.MaxBatchSize(source.Length)];
        int written = DeltaCodec.Write(buf, source);
        var round = DeltaCodec.Read(new ReadOnlySpan<byte>(buf, 0, written));

        Assert.Equal(source.Length, round.Length);
        for (int i = 0; i < source.Length; i++)
        {
            Assert.Equal(source[i].Kind, round[i].Kind);
            Assert.Equal(source[i].DocId, round[i].DocId);
            Assert.Equal(source[i].TargetId, round[i].TargetId);
            Assert.Equal(source[i].NumA, round[i].NumA);
            Assert.Equal(source[i].NumB, round[i].NumB);
            Assert.Equal(source[i].TimestampTicks, round[i].TimestampTicks);
            Assert.Equal(string.IsNullOrEmpty(source[i].Text) ? null : source[i].Text, round[i].Text);
        }
    }

    [Fact]
    public void DeltaBatch_HandlesAnEmptyBatch()
    {
        var buf = new byte[DeltaCodec.MaxBatchSize(0)];
        int written = DeltaCodec.Write(buf, Array.Empty<StateDelta>());

        Assert.Equal(2, written);
        Assert.Empty(DeltaCodec.Read(new ReadOnlySpan<byte>(buf, 0, written)));
    }

    [Fact]
    public void DeltaBatch_PreservesNonAsciiFeatureNames()
    {
        // Feature names are whatever the customer typed. German, Japanese and emoji all
        // occur in real trees.
        var source = new[]
        {
            new StateDelta { Kind = DeltaKind.FeatureRenamed, Text = "Aufsatz-Linear-Austrag1" },
            new StateDelta { Kind = DeltaKind.FeatureRenamed, Text = "押し出しボス1" }
        };

        var buf = new byte[DeltaCodec.MaxBatchSize(source.Length)];
        int written = DeltaCodec.Write(buf, source);
        var round = DeltaCodec.Read(new ReadOnlySpan<byte>(buf, 0, written));

        Assert.Equal("Aufsatz-Linear-Austrag1", round[0].Text);
        Assert.Equal("押し出しボス1", round[1].Text);
    }

    [Fact]
    public void DeltaBatch_TruncatesAnOverLongLabelWithoutSplittingAUtf8Sequence()
    {
        // 300 three-byte characters: far past the 255-byte field, and every boundary
        // lands mid-sequence unless the codec trims properly.
        var source = new[]
        {
            new StateDelta { Kind = DeltaKind.FeatureAdded, Text = new string('あ', 300) }
        };

        var buf = new byte[DeltaCodec.MaxBatchSize(source.Length)];
        int written = DeltaCodec.Write(buf, source);
        var round = DeltaCodec.Read(new ReadOnlySpan<byte>(buf, 0, written));

        Assert.NotNull(round[0].Text);
        Assert.DoesNotContain("�", round[0].Text!);     // no replacement characters
        Assert.All(round[0].Text!, ch => Assert.Equal('あ', ch));
        Assert.True(Encoding.UTF8.GetByteCount(round[0].Text!) <= DeltaCodec.MaxTextBytes);
    }

    [Fact]
    public void DeltaBatch_FitsInsideTheAdvertisedUpperBound()
    {
        // The pump sizes one pooled buffer from MaxBatchSize and reuses it forever.
        // If Write could ever exceed that bound it would corrupt the frame stream.
        var source = new StateDelta[64];
        for (int i = 0; i < source.Length; i++)
            source[i] = new StateDelta { Kind = DeltaKind.FeatureAdded, DocId = i, Text = new string('x', 400) };

        int bound = DeltaCodec.MaxBatchSize(source.Length);
        var buf = new byte[bound];

        int written = DeltaCodec.Write(buf, source);

        Assert.InRange(written, 1, bound);
    }

    // ── coalescing ───────────────────────────────────────────────────────────────

    [Theory]
    [InlineData(DeltaKind.RebuildDone, true)]
    [InlineData(DeltaKind.SelectionChanged, true)]
    [InlineData(DeltaKind.MassProperties, true)]
    [InlineData(DeltaKind.ErrorCount, true)]
    [InlineData(DeltaKind.FeatureAdded, false)]
    [InlineData(DeltaKind.FeatureDeleted, false)]
    [InlineData(DeltaKind.FeatureRenamed, false)]
    [InlineData(DeltaKind.DocOpened, false)]
    public void OnlyStateLikeDeltasMayBeCoalesced(DeltaKind kind, bool coalescable)
    {
        // Dropping an "added" or "deleted" loses information the next delta does not
        // carry; dropping a stale mass reading loses nothing.
        Assert.Equal(coalescable, new StateDelta { Kind = kind }.IsCoalescable);
    }

    [Fact]
    public void CoalesceKey_SeparatesKindDocumentAndTarget()
    {
        var a = new StateDelta { Kind = DeltaKind.MassProperties, DocId = 1, TargetId = 0 };
        var b = new StateDelta { Kind = DeltaKind.MassProperties, DocId = 2, TargetId = 0 };
        var c = new StateDelta { Kind = DeltaKind.ErrorCount, DocId = 1, TargetId = 0 };
        var d = new StateDelta { Kind = DeltaKind.MassProperties, DocId = 1, TargetId = 9 };
        var same = new StateDelta { Kind = DeltaKind.MassProperties, DocId = 1, TargetId = 0, NumA = 99 };

        Assert.Equal(a.CoalesceKey, same.CoalesceKey);
        Assert.NotEqual(a.CoalesceKey, b.CoalesceKey);
        Assert.NotEqual(a.CoalesceKey, c.CoalesceKey);
        Assert.NotEqual(a.CoalesceKey, d.CoalesceKey);
    }

    // ── command envelopes ────────────────────────────────────────────────────────

    [Fact]
    public void KernelResultFail_CarriesAMachineReadableCode()
    {
        var r = KernelResult.Fail("cmd_1", KernelError.PidUnresolved, "gone", "detail");

        Assert.False(r.Ok);
        Assert.Equal("cmd_1", r.Id);
        Assert.Equal(KernelError.PidUnresolved, r.Error!.Code);
        Assert.Equal("detail", r.Error.Detail);
    }

    [Fact]
    public void CommandEnvelope_RoundTripsThroughJson()
    {
        var cmd = new KernelCommand
        {
            Verb = KernelCommand.ApplyPlan,
            Body = System.Text.Json.JsonSerializer.SerializeToElement(new { mode = "Edit" })
        };

        var round = IrJson.Deserialize<KernelCommand>(IrJson.Serialize(cmd));

        Assert.NotNull(round);
        Assert.Equal(cmd.Id, round!.Id);
        Assert.Equal(KernelCommand.ApplyPlan, round.Verb);
        Assert.Equal("Edit", round.Body.GetProperty("mode").GetString());
    }

    [Fact]
    public void MassDeltaPct_IsZeroRatherThanInfiniteForAMasslessDocument()
    {
        // Drawings report zero mass. A naive division here would put "∞%" on the
        // verify card of every drawing plan.
        var drawing = new VerifyReport { MassBeforeG = 0, MassAfterG = 0 };
        var part = new VerifyReport { MassBeforeG = 100, MassAfterG = 90 };

        Assert.Equal(0d, drawing.MassDeltaPct);
        Assert.Equal(-10d, part.MassDeltaPct, 6);
    }
}

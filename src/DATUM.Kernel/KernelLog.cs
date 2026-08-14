using System;
using System.IO;
using System.Text;
using System.Threading;

namespace Datum.Kernel
{
    /// <summary>
    /// Minimal, allocation-cheap, crash-safe logger.
    ///
    /// Deliberately not a logging framework: this assembly is loaded into SLDWORKS.exe
    /// alongside every other add-in the customer has installed, and dragging in a
    /// logging stack is a good way to lose an assembly-binding fight in someone else's
    /// process. Writes are buffered and flushed by a background timer so the STA thread
    /// never blocks on disk.
    /// </summary>
    internal static class KernelLog
    {
        private static readonly object Gate = new object();
        private static readonly StringBuilder Buffer = new StringBuilder(8 * 1024);
        private static readonly string LogPath;
        private static Timer? _flushTimer;
        private static long _dropped;

        public static bool VerboseEnabled;

        static KernelLog()
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DATUM", "logs");
            try { Directory.CreateDirectory(dir); } catch { /* logging must never throw */ }
            LogPath = Path.Combine(dir, $"kernel-{DateTime.Now:yyyyMMdd}.log");
            _flushTimer = new Timer(_ => Flush(), null, 2000, 2000);
        }

        public static void Verbose(string msg) { if (VerboseEnabled) Write("VRB", msg); }
        public static void Info(string msg) => Write("INF", msg);
        public static void Warn(string msg) => Write("WRN", msg);
        public static void Error(string msg) => Write("ERR", msg);

        public static void Error(string msg, Exception ex) =>
            Write("ERR", msg + " :: " + ex.GetType().Name + ": " + ex.Message +
                         (ex.StackTrace != null ? "\n" + ex.StackTrace : ""));

        private static void Write(string level, string msg)
        {
            lock (Gate)
            {
                // Bound the buffer: if the disk or the flush timer stalls we drop rather
                // than grow without limit inside the CAD process.
                if (Buffer.Length > 512 * 1024) { _dropped++; return; }
                Buffer.Append(DateTime.Now.ToString("HH:mm:ss.fff"))
                      .Append(' ').Append(level).Append(' ')
                      .Append(msg).Append('\n');
            }
        }

        public static void Flush()
        {
            string payload;
            long dropped;
            lock (Gate)
            {
                if (Buffer.Length == 0 && _dropped == 0) return;
                payload = Buffer.ToString();
                Buffer.Clear();
                dropped = _dropped;
                _dropped = 0;
            }
            if (dropped > 0)
                payload += $"{DateTime.Now:HH:mm:ss.fff} WRN {dropped} log lines dropped (buffer full)\n";

            try { File.AppendAllText(LogPath, payload, Encoding.UTF8); }
            catch { /* a failed log write must never surface to the user */ }
        }

        public static void Shutdown()
        {
            try { _flushTimer?.Dispose(); } catch { }
            _flushTimer = null;
            Flush();
        }
    }
}

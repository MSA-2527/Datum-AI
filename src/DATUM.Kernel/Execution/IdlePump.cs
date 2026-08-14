using System;
using System.Collections.Concurrent;
using System.Diagnostics;

namespace Datum.Kernel.Execution
{
    /// <summary>
    /// The bridge between the orchestrator's threads and the SOLIDWORKS STA thread.
    ///
    /// The SOLIDWORKS API is single-threaded-apartment. Calling it from a worker thread
    /// does not fail loudly — it silently degrades, with operations that take
    /// milliseconds on the UI thread taking over a minute through the marshaller. So
    /// work is queued from any thread and drained here, on OnIdleNotify, which is by
    /// definition a moment when SOLIDWORKS is quiescent.
    ///
    /// The budget matters: draining without one would let a long batch make the CAD
    /// application appear hung. Each idle tick does bounded work and returns.
    /// </summary>
    internal sealed class IdlePump
    {
        private readonly ConcurrentQueue<WorkItem> _queue = new ConcurrentQueue<WorkItem>();
        private readonly Stopwatch _sw = new Stopwatch();

        /// <summary>Milliseconds of STA time a single idle tick may consume.</summary>
        public int BudgetMs = 40;

        /// <summary>Set while a long operation is running so a second one cannot interleave.</summary>
        private volatile bool _busy;

        public bool IsBusy => _busy;
        public int PendingCount => _queue.Count;

        private sealed class WorkItem
        {
            public Action Work = null!;
            public string Label = "";
            public bool Exclusive;
        }

        /// <summary>
        /// Queue work for the STA thread. Safe to call from any thread.
        /// <paramref name="exclusive"/> marks long, mutating work (plan apply) that must
        /// not share an idle tick with anything else.
        /// </summary>
        public void Post(string label, Action work, bool exclusive = false)
        {
            _queue.Enqueue(new WorkItem { Work = work, Label = label, Exclusive = exclusive });
        }

        /// <summary>Called from OnIdleNotify. Must return promptly.</summary>
        public void Drain()
        {
            if (_queue.IsEmpty || _busy) return;

            _sw.Restart();
            while (_sw.ElapsedMilliseconds < BudgetMs && _queue.TryDequeue(out var item))
            {
                if (item.Exclusive) _busy = true;
                try
                {
                    item.Work();
                }
                catch (Exception ex)
                {
                    // A failing work item must never propagate into SOLIDWORKS's own
                    // idle handling — that would destabilise the host application.
                    KernelLog.Error($"Idle work item '{item.Label}' threw", ex);
                }
                finally
                {
                    if (item.Exclusive) _busy = false;
                }

                // Exclusive work owns its whole tick.
                if (item.Exclusive) break;
            }
            _sw.Stop();
        }

        public void Clear()
        {
            while (_queue.TryDequeue(out _)) { }
        }
    }
}

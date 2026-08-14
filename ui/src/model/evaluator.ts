import { evaluateDocument, type Document, type EvaluatedDocument } from './document';
import type { EvaluateResponse } from './evaluate.worker';

/**
 * Runs feature-tree evaluation, preferring a worker.
 *
 * Two things this has to get right beyond simply moving work off the thread.
 *
 * **Superseding.** Dragging a slider fires a rebuild per frame. Queueing them all means the
 * geometry lags seconds behind the control and every intermediate result is wasted work. Only
 * the newest request matters, so older replies are discarded on arrival and, while one is in
 * flight, only the most recent pending document is kept.
 *
 * **Falling back.** Workers are unavailable in some embedded hosts, blocked by some content
 * policies, and absent under jsdom. Rather than degrade to a broken viewport, evaluation
 * simply runs inline — slower and blocking, exactly as it was before, but working.
 */

export interface EvaluatorOptions {
  /** Called with each completed evaluation, newest only. */
  onResult: (result: EvaluatedDocument) => void;
  /** Called when the kernel threw. */
  onError: (message: string) => void;
  /** Called when work starts and stops, for a progress indicator. */
  onBusy?: (busy: boolean) => void;
}

export class Evaluator {
  private worker: Worker | null = null;
  private nextId = 1;
  private inFlight = 0;
  /** The most recent document received while a rebuild was already running. */
  private pending: Document | null = null;
  private disposed = false;

  constructor(private readonly opts: EvaluatorOptions) {
    this.worker = createWorker();
    if (!this.worker) return;

    this.worker.onmessage = (event: MessageEvent<EvaluateResponse>) => {
      const message = event.data;

      // A reply for anything but the newest request is stale. Acting on it would show
      // geometry the user has already edited past.
      if (message.id !== this.inFlight) return;
      this.inFlight = 0;

      if (message.ok) this.opts.onResult(message.result);
      else this.opts.onError(message.message);

      this.drain();
    };

    this.worker.onerror = (event) => {
      // The worker died. Fall back to inline evaluation rather than leaving the application
      // permanently unable to rebuild.
      this.opts.onError(
        `Background geometry stopped (${event.message || 'unknown error'}). ` +
        'Rebuilds will continue on the main thread, which may pause the window briefly.',
      );
      this.worker?.terminate();
      this.worker = null;
      this.inFlight = 0;
      this.drain();
    };
  }

  /** Queues a document. Returns immediately; the result arrives through `onResult`. */
  evaluate(doc: Document): void {
    if (this.disposed) return;

    if (!this.worker) {
      this.opts.onBusy?.(true);
      try {
        this.opts.onResult(evaluateDocument(doc));
      } catch (e) {
        this.opts.onError(e instanceof Error ? e.message : 'The model could not be rebuilt.');
      } finally {
        this.opts.onBusy?.(false);
      }
      return;
    }

    if (this.inFlight !== 0) {
      // Replace rather than queue: only the latest state is worth building.
      this.pending = doc;
      return;
    }

    this.post(doc);
  }

  private post(doc: Document): void {
    if (!this.worker) return;
    this.inFlight = this.nextId++;
    this.opts.onBusy?.(true);
    this.worker.postMessage({ id: this.inFlight, doc });
  }

  private drain(): void {
    const next = this.pending;
    this.pending = null;

    if (next) this.post(next);
    else this.opts.onBusy?.(false);
  }

  /** True when geometry is being rebuilt in the background. */
  get busy(): boolean {
    return this.inFlight !== 0 || this.pending !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
  }
}

/**
 * Creates the worker, or returns null where that is not possible.
 *
 * The `new URL(..., import.meta.url)` form is what lets the bundler find and compile the
 * worker as its own module; a plain string path resolves at runtime and breaks in a
 * production build.
 */
function createWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;

  try {
    return new Worker(new URL('./evaluate.worker.ts', import.meta.url), {
      type: 'module',
      name: 'datum-geometry',
    });
  } catch {
    // Blocked by a content security policy, or an environment without module workers.
    return null;
  }
}

/** Evaluates inline. Used by tests and by anything that needs a result immediately. */
export const evaluateNow = evaluateDocument;

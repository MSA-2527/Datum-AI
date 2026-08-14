/// <reference lib="webworker" />

/**
 * Feature-tree evaluation, off the main thread.
 *
 * Geometry is the slow part of this application by a wide margin — a car takes about two
 * seconds, a fillet on a complex body longer — and until now all of it ran on the thread that
 * also paints the window. The whole interface locked for the duration: no cursor, no scroll,
 * no way to cancel, and no way to tell a slow rebuild from a crash.
 *
 * Everything the evaluator needs is plain data. A `Document` is JSON, and an
 * `EvaluatedDocument` is typed arrays plus Maps, all of which the structured clone algorithm
 * handles. So the worker needs no special protocol: it receives a document, evaluates it, and
 * posts the result back.
 *
 * Each request carries an id. The main thread discards results whose id is not the newest,
 * which is what makes dragging a slider workable — twenty rebuilds may be queued and only the
 * last one matters.
 */

import { evaluateDocument, type Document, type EvaluatedDocument } from './document';
import { initManifold } from '../kernel/ops/manifold';

export interface EvaluateRequest {
  id: number;
  doc: Document;
}

export type EvaluateResponse =
  | { id: number; ok: true; result: EvaluatedDocument }
  | { id: number; ok: false; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/**
 * The boolean engine, loading in the background from the moment the worker starts.
 *
 * Awaited per request rather than blocking module evaluation, so the very first rebuild is
 * not held up behind a WASM instantiation it may not even need — and a rebuild that arrives
 * before the engine is ready simply runs on the BSP, which is what every rebuild did until
 * now. Nothing waits and nothing fails.
 */
const engine = initManifold();

ctx.onmessage = async (event: MessageEvent<EvaluateRequest>) => {
  const { id, doc } = event.data;
  await engine;

  try {
    const result = evaluateDocument(doc);

    // The mesh's typed arrays are transferred rather than copied. On a large assembly that
    // is several megabytes, and copying it would put back a chunk of the pause this whole
    // change exists to remove.
    //
    // Transferring detaches the buffers here, which is safe because the worker keeps no
    // reference to the result after posting it.
    ctx.postMessage({ id, ok: true, result } satisfies EvaluateResponse, [
      result.mesh.positions.buffer,
      result.mesh.indices.buffer,
      result.mesh.faceIds.buffer,
      result.edges.buffer,
    ]);
  } catch (e) {
    // A throw here is a kernel defect, not a user error. It must still come back as a
    // message: a worker that dies silently leaves the interface waiting forever.
    ctx.postMessage({
      id,
      ok: false,
      message: e instanceof Error ? e.message : 'The model could not be rebuilt.',
    } satisfies EvaluateResponse);
  }
};

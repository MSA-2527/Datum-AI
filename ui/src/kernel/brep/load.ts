/**
 * Loading the exact kernel, once, and only when something needs it.
 *
 * DATUM's own kernel is triangles. That is why a fillet is approximated by cutting with a swept
 * tool rather than built as a true rolling-ball blend, why a 6 mm hole measures 5.94 mm, and why
 * exported STEP carries faceted surfaces wherever the shape was not recognised. Writing a
 * boundary-representation kernel to fix that is decades of work; adopting one is an afternoon,
 * and OpenCascade is the one with thirty years behind it.
 *
 * The cost is 66 MB of WebAssembly, which is most of a minute on a slow connection and would
 * destroy the thing DATUM is actually good at — opening instantly, with no install and no
 * account. So it is never loaded at startup. It loads the first time an operation genuinely
 * needs exact geometry, once, and everything that does not need it keeps working as it did.
 *
 * That is the whole architectural decision here: exact geometry is opt-in, per operation, and
 * the mesh kernel remains the thing that runs when you open the page.
 */

/** What the parts of this module actually use. Widened as more operations are wrapped. */
export type OpenCascade = Record<string, unknown>;

let pending: Promise<OpenCascade> | null = null;

/** Progress while the module downloads, for a UI that has to say why it is waiting. */
export type LoadListener = (state: { loaded: boolean; note: string }) => void;

const listeners = new Set<LoadListener>();

export function onKernelLoad(listener: LoadListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(loaded: boolean, note: string): void {
  for (const l of listeners) l({ loaded, note });
}

/**
 * The kernel, loading it if this is the first call.
 *
 * One instance for the life of the page. OpenCascade holds its own heap and its own handle
 * table; a second instance would double a 66 MB allocation and hand back shapes the first one
 * cannot read.
 */
export function exactKernel(): Promise<OpenCascade> {
  if (pending) return pending;

  announce(false, 'Loading the exact-geometry kernel. 66 MB, once.');

  pending = (async () => {
    const init = await loadModule();
    announce(true, 'Exact geometry ready.');
    return init;
  })().catch((e) => {
    // Cleared so a failure — a slow network, a blocked request — can be retried rather than
    // leaving the application permanently convinced the kernel is unavailable.
    pending = null;
    announce(false, e instanceof Error ? e.message : 'The exact kernel could not be loaded.');
    throw e;
  });

  return pending;
}

/** True once the kernel is in memory, for a UI that wants to say so without triggering a load. */
export const kernelReady = (): boolean => pending !== null;

/**
 * Instantiates the module, in whichever environment this is.
 *
 * The browser and Node need the WebAssembly located differently: Vite rewrites an asset import
 * to a URL it will serve, and Node has a path on disk. Both routes end at the same module, and
 * keeping them in one place stops the difference leaking into everything that uses it.
 */
async function loadModule(): Promise<OpenCascade> {
  const { default: init } = await import('opencascade.js/dist/opencascade.wasm.js');
  const factory = init as unknown as (o: unknown) => Promise<OpenCascade>;

  // Node: read the binary off disk. `import.meta.env` is absent there, which is the cheapest
  // reliable test for which environment this is.
  const inBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

  if (!inBrowser) {
    const { readFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('opencascade.js/dist/opencascade.wasm.wasm');

    return factory({
      wasmBinary: readFileSync(wasmPath),
      locateFile: (p: string) => (p.endsWith('.wasm') ? wasmPath : p),
    });
  }

  const wasmUrl = (await import('opencascade.js/dist/opencascade.wasm.wasm?url')).default;
  return factory({ locateFile: (p: string) => (p.endsWith('.wasm') ? wasmUrl : p) });
}

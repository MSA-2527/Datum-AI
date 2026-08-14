import { beforeAll } from 'vitest';
import { initManifold, manifoldReady } from './kernel/ops/manifold';

/**
 * Loads the boolean engine before any test runs.
 *
 * Without this the whole suite silently exercises the BSP fallback, which is a different
 * engine from the one the application ships — so every geometry assertion would be measuring
 * code the user never reaches. Awaited once per worker rather than per file, because
 * instantiating the WASM is the expensive part and it is entirely reusable.
 *
 * Deliberately not conditional. If the engine cannot load in CI, the tests should record the
 * fallback's numbers rather than pretending, and `manifoldReady()` is exported so a test can
 * ask which one it is talking to.
 */
beforeAll(async () => {
  await initManifold();
}, 60_000);

export { manifoldReady };

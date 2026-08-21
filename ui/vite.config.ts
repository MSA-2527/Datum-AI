/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative base: the same bundle is served from the WebView2 virtual host
  // (https://datum.local/) and from the orchestrator's static file middleware.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120', // WebView2 evergreen — no need to down-level
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5273,
    strictPort: true,
  },
  test: {
    // jsdom because persistence touches localStorage and the exporters touch Blob/URL.
    environment: 'jsdom',
    /*
     * The exact-kernel tests run in Node instead.
     *
     * OpenCascade is 66 MB of WebAssembly, and instantiating it inside a jsdom worker exhausts
     * the worker and takes the whole run down with it — the suite reported no tests at all
     * rather than a failure, which is the worst way to find out. It needs none of jsdom, so it
     * runs where it fits.
     */
    environmentMatchGlobs: [['src/kernel/brep/**', 'node']],
    include: ['src/**/*.test.ts'],
    // The readable report is excluded from the ordinary suite — it asserts nothing and would
    // print a table on every commit. `npm run eval` runs it through `vitest.eval.config.ts`.
    // The regression gate that *does* assert, `src/eval/eval.test.ts`, stays in.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/eval/report.test.ts'],
    restoreMocks: true,
    // Loads the WASM boolean engine before any test. Without it the suite measures the BSP
    // fallback rather than the engine the application actually ships.
    setupFiles: ['./src/test-setup.ts'],
    testTimeout: 30_000,
  },
});

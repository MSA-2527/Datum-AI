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

/// <reference types="vitest" />
import { defineConfig } from 'vite';

/**
 * `npm run eval` — the benchmark report on its own.
 *
 * A separate config rather than a filter argument, because the ordinary config excludes the
 * report (it asserts nothing and would print a table on every commit) and an exclude cannot be
 * overridden by naming the file on the command line.
 *
 * Written out rather than merged with `vite.config.ts`: `mergeConfig` concatenates `include`
 * arrays instead of replacing them, so merging ran the entire suite. The two settings that
 * matter are repeated here deliberately — jsdom, and the setup file that loads the real
 * boolean engine, so the report measures the same kernel the product ships.
 */
export default defineConfig({
  test: {
    include: ['src/eval/report.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    testTimeout: 300_000,
  },
});

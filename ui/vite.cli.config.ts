import { defineConfig } from 'vite';

/**
 * The headless build.
 *
 * A separate config from the application's, because the two targets have nothing in common:
 * the app is a browser bundle with a WASM chunk and relative asset paths, and this is one
 * Node file with no assets at all.
 *
 * `ssr` rather than `lib` so Node's own modules stay external — bundling `node:fs` would be
 * both impossible and pointless — and so the output is a single file that runs with no
 * install step beyond the one the repository already needs.
 */
export default defineConfig({
  build: {
    ssr: 'src/cli.ts',
    outDir: 'dist-cli',
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: {
      output: { entryFileNames: 'datum.mjs' },
    },
  },
});

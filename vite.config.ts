import { defineConfig } from 'vite';

/**
 * `base` must match the Pages sub-path. GitHub Actions sets PAGES_BASE from the
 * repository name; local dev serves from the root.
 */
export default defineConfig({
  base: process.env.PAGES_BASE ?? '/',
  build: {
    outDir: 'dist',
    // PMTiles archives live in public/ and are copied verbatim; they are large
    // and must never be inlined.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
  server: { port: 5173 },
});

import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';

/**
 * The commit the bundle is built from, for the footer's build stamp.
 *
 * Read here rather than passed in by the workflow, so a local `vite build` and
 * the nightly deploy stamp the same way, and asked of git rather than of the
 * environment: `actions/checkout` clones at depth 1, which is enough for both
 * of these and would not be enough for anything more ambitious. A tree with no
 * git behind it - a source tarball, a `dist` rebuilt elsewhere - yields empty
 * strings, and the footer then prints no stamp at all rather than a placeholder
 * that would read as a real build.
 */
function buildStamp(): { commit: string; time: string } {
  const git = (...args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    return { commit: git('rev-parse', '--short', 'HEAD'), time: git('log', '-1', '--format=%cI') };
  } catch {
    return { commit: '', time: '' };
  }
}

const stamp = buildStamp();

/**
 * `base` must match the Pages sub-path. GitHub Actions sets PAGES_BASE from the
 * repository name; local dev serves from the root.
 */
export default defineConfig({
  base: process.env.PAGES_BASE ?? '/',
  define: {
    __BUILD_COMMIT__: JSON.stringify(stamp.commit),
    __BUILD_TIME__: JSON.stringify(stamp.time),
  },
  build: {
    outDir: 'dist',
    // PMTiles archives live in public/ and are copied verbatim; they are large
    // and must never be inlined.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
  server: { port: 5173 },
});

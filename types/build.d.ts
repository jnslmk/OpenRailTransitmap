/**
 * Build stamp, substituted by Vite's `define` (see vite.config.ts). Both are
 * empty strings when the site is built outside a git checkout, which is the
 * footer's cue to print nothing rather than a placeholder.
 */

/** Abbreviated hash of the commit the bundle was built from. */
declare const __BUILD_COMMIT__: string;
/** That commit's date, ISO 8601 with an offset. */
declare const __BUILD_TIME__: string;

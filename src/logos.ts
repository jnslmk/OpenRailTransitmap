/**
 * The seam through which the app reads operator logos, the same shape as the
 * punctuality one: a static file built beside lines.json, fetched once, and
 * absent without complaint.
 *
 * The file is pipeline/logos.ts' committed manifest - operator string to a
 * filename under `logos/` - and the marks themselves are public-domain files
 * from Wikimedia Commons. A checkout that has never run the pipeline has
 * neither, and the operator panel then shows what it always showed: names.
 */

export interface LogoEntry {
  /** Filename under `logos/`, e.g. `db-regio-logo-1a2b3c.svg`. */
  file: string;
  /** The Wikidata item this operator was matched to - the claim being made. */
  qid: string;
  label: string;
  licence: string;
}

export type LogoManifest = Record<string, LogoEntry>;

let loaded: Promise<Map<string, string>> | null = null;

/**
 * Operator name to logo URL, empty when there is no manifest.
 *
 * Fetched once per session and shared: the panel asks for it on every redraw,
 * and the answer cannot change under a running tab.
 */
export function loadLogos(base: string): Promise<Map<string, string>> {
  loaded ??= fetch(`${base}operator-logos.json`)
    .then((r) => (r.ok ? (r.json() as Promise<LogoManifest>) : {}))
    .catch((): LogoManifest => ({}))
    .then(
      (manifest) =>
        new Map(
          Object.entries(manifest)
            .filter(([, entry]) => entry?.file)
            .map(([operator, entry]) => [operator, `${base}logos/${entry.file}`]),
        ),
    );
  return loaded;
}

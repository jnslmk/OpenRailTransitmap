/**
 * Operator logos, from Wikidata by way of Wikimedia Commons.
 *
 * The operator panel lists whoever runs something in the current view, and a
 * list of names like "Verkehrsverbund Mittelsachsen GmbH" next to "Rhein-
 * Neckar-Verkehr" is read letter by letter. A rider knows these companies by
 * their marks, off the front of the train, so the panel shows the mark.
 *
 * ## Two stages, and why they are separate
 *
 * **Resolving** (`--resolve`) turns the operator strings in data/lines.json
 * into Wikidata items and Commons filenames, and writes data/operator-logos.json.
 * It is a *human* step, run when the operator set has moved, because matching an
 * OSM free-text `operator` tag to a company is a guess: "DB RegioNetz Verkehrs
 * GmbH;Kurhessenbahn" resolves, if nothing stops it, to the Erzgebirgsbahn. The
 * manifest is committed so that guess arrives as a reviewable diff - one line
 * per operator, naming the company it was matched to - and data/logo-overrides.yaml
 * is where a wrong one is corrected or refused.
 *
 * **Fetching** (no flag) is the build step: it reads the committed manifest,
 * downloads exactly the files it names into public/logos/, and never asks
 * Wikidata anything. So the nightly build cannot silently change which logo a
 * company gets, and a Wikidata edit cannot reach the site without going past a
 * person first. It fails soft, like the coach feed and the closure plan: a
 * Commons outage costs a night of logos, not the deploy.
 *
 * ## Licensing
 *
 * Only files Commons records as public domain or CC0 are kept - in practice
 * `PD-textlogo`, a logo whose lettering and shapes are below the threshold of
 * originality. Measured over the 293 operator strings in the registry, that is
 * 219 of the 221 that resolve at all, so refusing everything else costs two
 * logos and buys a site with no per-file attribution obligations. The two
 * CC BY-SA files are dropped rather than credited, because a credit that has to
 * name individual files would be a footnote nobody reads and an obligation
 * nobody checks.
 *
 * Nearly all of these marks are trademarks. Showing a company's mark against
 * that company's own lines, in a legend whose whole job is to say who runs
 * what, is the use trademark law is for; the map claims no affiliation, and
 * says so nowhere because it never implies otherwise. Wikimedia Commons is
 * credited in the sidebar whenever a logo is on screen, on the same latch the
 * other sources use.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

const DATA = 'data';
const WORK = process.env.WORK_DIR ?? '.work';
const CACHE = `${WORK}/logos`;
const OUT = 'public/logos';

export const MANIFEST_PATH = `${DATA}/operator-logos.json`;
const OVERRIDES_PATH = `${DATA}/logo-overrides.yaml`;

/**
 * Wikimedia asks for a descriptive User-Agent that reaches a human, and
 * answers a generic one with 403.
 */
const UA = 'OpenRailTransitmap/0.1 (https://github.com/jnslmk/openrailtransitmap)';

/** Milliseconds between API calls. See `getJson`. */
const PACE = 150;

/**
 * Languages a label is looked for in, in order.
 *
 * The manifest exists to be *read* - the whole point of committing it is that a
 * reviewer can see which company each operator was taken to be - and an entry
 * saying `Q55499626` says nothing. FlixTrain's item, as it happens, is labelled
 * in neither German nor English.
 */
const LABEL_LANGUAGES = 'de|en|nl|fr|pl|cs|da|it';

/**
 * A logo has to read at the size of a sidebar row, which is about 20 pixels
 * tall. Commons has some remarkable SVGs - two of the matches are over a
 * megabyte of vector detail - and shipping those to draw a 20-pixel mark is
 * indefensible. Measured, the median file is 10 kB and this cap drops three.
 */
export const MAX_BYTES = 250_000;

/** What the panel can put in an `<img>`. Commons also holds TIFF and PDF. */
export const KEPT_TYPES = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const EXTENSIONS: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Commons licence short names this map is prepared to ship. See the header. */
export function licenceAllowed(short: string | null | undefined): boolean {
  if (!short) return false;
  return /^(public domain|cc0)/i.test(short.replace(/<[^>]*>/g, '').trim());
}

export interface LogoEntry {
  /** The Wikidata item the operator was matched to, for review. */
  qid: string;
  /** That item's label, which is the claim this match is making. */
  label: string;
  /** The Commons filename, as `P154` gives it. */
  commons: string;
  /** What the file is called under public/logos/. */
  file: string;
  licence: string;
}

export type Manifest = Record<string, LogoEntry>;

/**
 * A filename for the site, derived from the Commons one.
 *
 * Commons names carry spaces, commas, brackets and every letter German and
 * Polish have; a URL path made of those works but is unreadable in a network
 * tab and needs escaping at three different layers. The slug keeps the name
 * recognisable and the path plain ASCII, with a short hash of the original so
 * that two files that slug the same cannot collide.
 */
export function slugFor(commons: string, mime: string): string {
  const dot = commons.lastIndexOf('.');
  const stem = dot > 0 ? commons.slice(0, dot) : commons;
  const ascii = stem
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/Ø/gi, 'o')
    .replace(/Ł/gi, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .replace(/-$/, '');
  let hash = 0;
  for (const ch of commons) hash = (hash * 31 + ch.charCodeAt(0)) % 0xffffff;
  return `${ascii || 'logo'}-${hash.toString(36)}.${EXTENSIONS[mime] ?? 'svg'}`;
}

/**
 * The names an OSM `operator` tag might be findable under.
 *
 * The tag is free text written by whoever mapped the relation, so it arrives
 * with legal forms attached ("Rheinbahn AG"), with an abbreviation in brackets
 * ("Bayerische Regiobahn (BRB)"), with several operators joined by semicolons
 * on a cross-border service ("CFL;DB Fernverkehr AG"), and once with a postal
 * address ("Ilztalbahn GmbH, Färbergasse 1, 94065 Waldkirchen"). A joint
 * service is matched on its first operator, since the row can only hold one
 * mark and the first name is the one the tag leads with.
 *
 * Every variant is searched, not just the first that finds something: searching
 * for "S-Bahn Berlin GmbH" turns up three items about the *company's history*
 * before the company, and stopping at the first non-empty answer meant a
 * shelfful of near-misses hid a logo that "S-Bahn Berlin" finds first time.
 */
export function searchVariants(raw: string): string[] {
  const first = raw.split(';')[0].trim();
  const noAddress = first.replace(/,.*$/, '').trim();
  const noBrackets = noAddress
    .replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const noLegalForm = noBrackets
    .replace(/\b(GmbH|mbH|AG|KG|SE|e\.?\s?V\.?|Co\.?KG|Co\.?|&)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...new Set([first, noAddress, noBrackets, noLegalForm].filter((s) => s.length > 2))];
}

/**
 * The logos an item is wearing *now*, best first.
 *
 * `P154` is repeatable and holds a company's whole history of marks - CFL's
 * item leads with the 1946 one - so a claim with an end date is a logo that has
 * been retired, and a preferred-rank claim is Wikidata's own answer to which of
 * several applies. `P8972` (small logo or icon) comes last, since it is often a
 * favicon-shaped crop.
 *
 * All of them are returned rather than just the best, because "best" here is
 * not only Wikidata's opinion: the Hallesche Verkehrs-AG leads with a 1.2 MB
 * scan and carries a 12 kB SVG of the same mark behind it, and the caller - who
 * knows what each file weighs and what licence it carries - is the one that can
 * tell those apart.
 */
export function logoCandidates(entity: WikidataEntity): string[] {
  const out: string[] = [];
  for (const property of ['P154', 'P8972']) {
    const usable = (entity.claims?.[property] ?? []).filter((c) => {
      if (c.rank === 'deprecated') return false;
      // An end date - "end time" - means this mark is no longer in use.
      if (c.qualifiers?.P582?.length) return false;
      return typeof c.mainsnak?.datavalue?.value === 'string';
    });
    // Wikidata's own ranking first, then the rest in the order the item lists.
    for (const claim of [...usable].sort(
      (a, b) => Number(b.rank === 'preferred') - Number(a.rank === 'preferred'),
    )) {
      const value = claim.mainsnak?.datavalue?.value;
      if (typeof value === 'string' && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

/** The best name this item has, in any language the resolver asked for. */
function labelOf(entity: WikidataEntity | undefined): string | null {
  for (const language of LABEL_LANGUAGES.split('|')) {
    const label = entity?.labels?.[language]?.value;
    if (label) return label;
  }
  // An item labelled in none of them still describes itself in one of them.
  // Clipped, because a description is a sentence and this is a column in a
  // file someone reads down.
  for (const language of LABEL_LANGUAGES.split('|')) {
    const description = entity?.descriptions?.[language]?.value;
    if (description) return description.length > 60 ? `${description.slice(0, 57)}…` : description;
  }
  return null;
}

interface WikidataClaim {
  rank?: string;
  mainsnak?: { datavalue?: { value?: unknown } };
  qualifiers?: Record<string, unknown[]>;
}
export interface WikidataEntity {
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  claims?: Record<string, WikidataClaim[]>;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One call, paced.
 *
 * Resolving the whole registry is on the order of a thousand calls, and
 * Wikimedia answers a burst of those with "You are making too many requests to
 * the API" - measured, while writing this. The gap between calls is what keeps
 * a one-off human step from behaving like a scraper; `Retry-After` is obeyed
 * when the answer carries one, because that is the server saying how long it
 * wants to be left alone.
 */
async function getJson(url: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(PACE);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' } });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
      const after = Number(res.headers.get('retry-after'));
      if (Number.isFinite(after) && after > 0) await sleep(Math.min(after, 30) * 1000);
    } catch {
      /* fall through to the backoff */
    }
    await sleep(800 * (attempt + 1));
  }
  return null;
}

/**
 * One file, paced the same way and for the same reason.
 *
 * A hundred and forty files fetched back to back earns a `429` with a
 * `Retry-After` about seventy files in - measured - and every file after it
 * fails, which is how a build ends up shipping half a set of logos.
 */
async function getBinary(url: string): Promise<Buffer | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(PACE);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      const after = Number(res.headers.get('retry-after'));
      if (Number.isFinite(after) && after > 0) await sleep(Math.min(after, 30) * 1000);
    } catch {
      /* fall through to the backoff */
    }
    await sleep(800 * (attempt + 1));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolving: operator strings -> Wikidata items -> Commons files
// ---------------------------------------------------------------------------

interface Overrides {
  /** operator string -> a Wikidata item id, or `none` to refuse a logo. */
  operators: Record<string, string>;
}

function readOverrides(): Overrides {
  if (!existsSync(OVERRIDES_PATH)) return { operators: {} };
  const parsed = parseYaml(readFileSync(OVERRIDES_PATH, 'utf8')) as Partial<Overrides> | null;
  return { operators: parsed?.operators ?? {} };
}

function operatorsFromRegistry(): string[] {
  const registry = JSON.parse(readFileSync(`${DATA}/lines.json`, 'utf8')) as {
    lines: { operator?: string }[];
  };
  const seen = new Set<string>();
  for (const line of registry.lines) if (line.operator) seen.add(line.operator);
  return [...seen].sort((a, b) => a.localeCompare(b, 'de'));
}

/**
 * Candidate items for one operator, best guess first.
 *
 * Both languages, because a German company is not always labelled in German
 * ("Polregio") and an foreign one not always in English. The list is capped
 * because it is only a shortlist: the first candidate carrying a usable logo
 * wins, and a tenth-best search hit that happens to have one would be a worse
 * answer than no logo at all.
 */
async function searchItems(name: string): Promise<string[]> {
  const found: string[] = [];
  for (const variant of searchVariants(name)) {
    for (const language of ['de', 'en']) {
      const url =
        'https://www.wikidata.org/w/api.php?action=wbsearchentities' +
        `&search=${encodeURIComponent(variant)}&language=${language}&uselang=${language}` +
        '&type=item&limit=3&format=json';
      const body = (await getJson(url)) as { search?: { id: string }[] } | null;
      for (const hit of body?.search ?? []) found.push(hit.id);
    }
    if (found.length >= 6) break;
  }
  return [...new Set(found)].slice(0, 8);
}

async function fetchEntities(ids: string[]): Promise<Map<string, WikidataEntity>> {
  const out = new Map<string, WikidataEntity>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url =
      'https://www.wikidata.org/w/api.php?action=wbgetentities' +
      `&ids=${batch.join('|')}&props=claims|labels|descriptions&languages=${LABEL_LANGUAGES}` +
      '&format=json';
    const body = (await getJson(url)) as { entities?: Record<string, WikidataEntity> } | null;
    for (const [id, entity] of Object.entries(body?.entities ?? {})) out.set(id, entity);
  }
  return out;
}

interface CommonsFile {
  mime: string;
  size: number;
  licence: string;
}

async function fetchCommonsMeta(files: string[]): Promise<Map<string, CommonsFile>> {
  const out = new Map<string, CommonsFile>();
  for (let i = 0; i < files.length; i += 25) {
    const titles = files
      .slice(i, i + 25)
      .map((f) => `File:${f}`)
      .join('|');
    const url =
      'https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo' +
      `&iiprop=extmetadata|size|mime&titles=${encodeURIComponent(titles)}&format=json`;
    const body = (await getJson(url)) as {
      query?: {
        pages?: Record<
          string,
          {
            title: string;
            missing?: string;
            imageinfo?: [
              {
                mime: string;
                size: number;
                extmetadata?: { LicenseShortName?: { value: string } };
              },
            ];
          }
        >;
      };
    } | null;
    for (const page of Object.values(body?.query?.pages ?? {})) {
      const info = page.imageinfo?.[0];
      if (page.missing !== undefined || !info) continue;
      out.set(page.title.replace(/^File:/, ''), {
        mime: info.mime,
        size: info.size,
        licence: (info.extmetadata?.LicenseShortName?.value ?? '').replace(/<[^>]*>/g, '').trim(),
      });
    }
  }
  return out;
}

async function resolve(): Promise<void> {
  const overrides = readOverrides();
  const operators = operatorsFromRegistry();
  console.log(`==> resolving ${operators.length} operators`);

  // Every item that might carry a logo, whether it came from a search or from
  // the overrides file, fetched once.
  const candidates = new Map<string, string[]>();
  for (const [i, name] of operators.entries()) {
    const forced = overrides.operators[name];
    if (forced === 'none') {
      candidates.set(name, []);
      continue;
    }
    candidates.set(name, forced ? [forced] : await searchItems(name));
    if ((i + 1) % 50 === 0) console.log(`    searched ${i + 1}/${operators.length}`);
  }

  const entities = await fetchEntities([...new Set([...candidates.values()].flat())]);

  // Every file any candidate item offers, in the order they would be preferred.
  const offered = new Map<string, { qid: string; commons: string }[]>();
  for (const [name, ids] of candidates) {
    const list: { qid: string; commons: string }[] = [];
    for (const qid of ids) {
      const entity = entities.get(qid);
      if (entity) for (const commons of logoCandidates(entity)) list.push({ qid, commons });
    }
    offered.set(name, list);
  }

  const meta = await fetchCommonsMeta([
    ...new Set([...offered.values()].flat().map((o) => o.commons)),
  ]);

  /** Why this file cannot ship, or null if it can. See the licensing note. */
  const refuse = (commons: string): string | null => {
    const file = meta.get(commons);
    if (!file) return 'not on Commons';
    if (!licenceAllowed(file.licence)) return file.licence || 'no licence';
    if (!KEPT_TYPES.includes(file.mime)) return file.mime;
    if (file.size > MAX_BYTES) return `${(file.size / 1024).toFixed(0)} kB`;
    return null;
  };

  const manifest: Manifest = {};
  const refused: string[] = [];
  for (const [name, list] of offered) {
    const reasons: string[] = [];
    for (const { qid, commons } of list) {
      const why = refuse(commons);
      if (why) {
        reasons.push(`${commons} (${why})`);
        continue;
      }
      manifest[name] = {
        qid,
        label: labelOf(entities.get(qid)) ?? qid,
        commons,
        file: slugFor(commons, meta.get(commons)!.mime),
        licence: meta.get(commons)!.licence,
      };
      break;
    }
    if (!manifest[name] && reasons.length) refused.push(`${name}: ${reasons.join(', ')}`);
  }

  // Sorted, so the committed manifest diffs by operator rather than by the
  // order Wikidata happened to answer in.
  const sorted: Manifest = {};
  for (const name of Object.keys(manifest).sort((a, b) => a.localeCompare(b, 'de'))) {
    sorted[name] = manifest[name];
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(sorted, null, 1)}\n`);

  const files = new Set(Object.values(sorted).map((e) => e.file));
  console.log(
    `==> ${Object.keys(sorted).length}/${operators.length} operators matched, ` +
      `${files.size} distinct files`,
  );
  for (const line of refused) console.log(`    refused ${line}`);
  const missing = operators.filter((o) => !sorted[o]);
  console.log(
    `==> no logo for ${missing.length}: ${missing.slice(0, 12).join(', ')}` +
      (missing.length > 12 ? ', …' : ''),
  );
}

// ---------------------------------------------------------------------------
// Fetching: the committed manifest -> public/logos/
// ---------------------------------------------------------------------------

async function download(): Promise<void> {
  if (!existsSync(MANIFEST_PATH)) {
    console.log('==> no logo manifest; skipping (run `npm run resolve:logos` to make one)');
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  const files = new Map<string, string>(); // site filename -> Commons filename
  for (const entry of Object.values(manifest)) files.set(entry.file, entry.commons);

  mkdirSync(CACHE, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  // Anything the manifest no longer names, from a resolve that dropped an
  // operator; left behind it would ship for ever.
  for (const stale of readdirSync(OUT)) {
    if (!files.has(stale)) rmSync(`${OUT}/${stale}`);
  }

  let fetched = 0,
    cached = 0,
    failed = 0;
  for (const [file, commons] of files) {
    const cache = `${CACHE}/${file}`;
    if (!existsSync(cache)) {
      // Special:FilePath redirects to the file itself, which keeps this off
      // the API and lets Commons serve it from its own CDN.
      const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(commons)}`;
      const body = await getBinary(url);
      if (!body) {
        console.log(`    failed ${commons}`);
        failed++;
        continue;
      }
      writeFileSync(cache, body);
      fetched++;
    } else cached++;
    writeFileSync(`${OUT}/${file}`, readFileSync(cache));
  }
  console.log(`==> logos: ${fetched} fetched, ${cached} from cache, ${failed} unavailable`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const main = process.argv.includes('--resolve') ? resolve : download;
  // Soft failure: the map is complete without logos, and neither Wikidata nor
  // Commons being down is a reason to fail a build of a rail map.
  main().catch((err) => {
    console.error(`==> logos: ${err}`);
    process.exitCode = 0;
  });
}

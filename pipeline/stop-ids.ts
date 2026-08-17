/**
 * Resolve OSM stations to Transitous/MOTIS stop ids, for the live departure
 * board (`stopId` on station features - see stationFeatures in build.ts).
 *
 * MOTIS ids are opaque and feed-specific and cannot be derived from OSM tags
 * by string-mangling: Bremen Hbf is `ref:IFOPT=de:04011:13925` in OSM but
 * `de-DELFI_de:04011:13927_G` in MOTIS - unrelated numbers. So each station
 * is looked up against the public Transitous API
 * (https://api.transitous.org/api/v1) and the result is validated on
 * distance *and* name before being trusted; an unvalidated candidate is
 * treated the same as no match.
 *
 * ## Why a committed, budgeted cache
 * The nightly workflow runs with `contents: read` (.github/workflows/*.yml)
 * and cannot push, so anything CI resolves is thrown away at the end of the
 * run. Without a persistent cache every nightly build would re-resolve all
 * ~20,830 stations against Transitous - a volunteer-run service whose terms
 * ask to be contacted before heavy use. So:
 *   - the mapping lives in the repo at data/stop-ids.json, keyed by OSM
 *     station id, and a run always consults it first;
 *   - a run only ever resolves *new* stations, up to a small budget
 *     (DEFAULT_BUDGET, overridable via STOP_ID_BUDGET) so an unattended
 *     nightly build stays polite;
 *   - a human periodically runs `npm run resolve:stop-ids` (no budget cap)
 *     locally and commits the refreshed cache.
 *
 * Confirmed-no-match stations are cached as `''` so they are never re-probed
 * (a station genuinely absent from MOTIS doesn't become present tomorrow).
 * Stations that errored (network down, API outage, timeout) are left out of
 * the cache entirely, so they're retried on the next run instead of being
 * stuck with a bogus negative.
 *
 * That permanence is only sound as long as `lookup()` itself doesn't change:
 * a negative records "this resolver found nothing", not "MOTIS has nothing".
 * So the cache carries the RESOLVER_VERSION that produced it, and a run whose
 * resolver is newer than the file drops every negative before it starts - see
 * dropStaleNegatives.
 *
 * ## Duplicates vs. ambiguity
 * Transitous merges several GTFS feeds, and at busy interchanges more than
 * one feed emits a `STOP` for the *same physical stop* under a near-identical
 * name a few centimetres apart (verified live: Berlin Alexanderplatz shows up
 * as both "Berlin Alexanderplatz" and "Berlin,Alexanderplatz" from two
 * different feeds, ~0.1 m apart - see report). Left alone, the distance-margin
 * check below would read that as two candidates and decline the match, which
 * would permanently blackhole exactly the major hubs this feature matters
 * most for. So near-identical, near-zero-distance candidates are first
 * collapsed into one, deterministically - by connected components over the
 * candidate set, not by scan order, so the partition can't depend on
 * whatever order the API happens to return results in (lowest id wins within
 * each component, so the same duplicate is picked every run and the
 * committed cache doesn't churn) - and the ambiguity margin is then applied
 * to what's left, which is genuinely distinct stops sharing a name.
 *
 * A genuine ambiguity is cached under `AMBIGUOUS_MARKER`, its own state
 * distinct from both a resolved id and a confirmed negative: unlike a
 * negative, it's eligible for a later re-probe (today's ambiguity may not
 * survive the next Transitous feed update); unlike leaving it out of the
 * cache entirely, it doesn't compete with genuinely new stations for budget
 * on equal footing. `resolveStopIds` always spends the run's budget on
 * never-tried stations first and only gives the leftover (capped) budget to
 * re-probing the ambiguous backlog - see AMBIGUOUS_REPROBE_CAP.
 */

import {
  readFileSync, writeFileSync, existsSync, renameSync, unlinkSync,
} from 'node:fs';

const API = 'https://api.transitous.org/api/v1';
const USER_AGENT = 'OpenRailTransitmap/0.1 (+https://github.com/jnslmk/OpenRailTransitmap; claude@lemke.dev)';
const CACHE_PATH = 'data/stop-ids.json';

// OSM places a station node wherever mappers put it - a building entrance,
// a platform midpoint, sometimes the whole station area's centroid - while
// MOTIS resolves to one specific stop/platform within that same area. 500 m
// comfortably spans a large Hbf complex without reaching into a
// neighbouring, differently-named station; the name check (below) catches
// the rest.
const MAX_DISTANCE_M = 500;

// A name match is only trustworthy when it's not a tie: e.g. Hannover's rail
// Hbf ("Hannover Hbf") and the adjacent tram stop
// ("Hannover Hauptbahnhof/Rosenstraße", ~205 m away) both pass the name
// filter, since the latter contains the former after normalisation. Verified
// live against api.transitous.org/geocode?text=Hannover%20Hbf. Two such
// candidates within this margin of each other are treated as ambiguous and
// rejected outright - a wrong stopId would show a rider real departures from
// the wrong physical stop, which is worse than showing none.
const AMBIGUITY_MARGIN_M = 150;

// Two same-named candidates this close together are almost certainly one
// physical stop counted twice by two merged feeds (observed live at ~0.1 m
// for Berlin Alexanderplatz), not a genuine ambiguity - collapse them before
// the margin check above ever sees them. Comfortably below AMBIGUITY_MARGIN_M
// so a real nearby-but-distinct stop (e.g. Hannover's ~205 m case) is never
// mistaken for a duplicate.
const DUPLICATE_DISTANCE_M = 20;

// Conservative default so an unattended nightly run stays well within a
// "please contact us before heavy use" budget even if thousands of new
// stations appear at once (e.g. a region switch). Override with
// STOP_ID_BUDGET for a bigger one-off pass; the standalone CLI below runs
// with no cap at all.
const DEFAULT_BUDGET = 500;

const THROTTLE_MS = 200; // spacing between outgoing requests - serialised, never concurrent
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2; // 3 attempts total per request
// If the service is down, every remaining lookup in the budget would each
// pay full retry backoff for nothing; stop after a short run of failures
// instead of burning the whole nightly build's time budget on a dead API.
// Untried stations stay out of the cache, so they're simply retried later.
const CIRCUIT_BREAKER = 5;

// The uncapped local pass (`npm run resolve:stop-ids`) is hours of serialised
// requests over ~20k stations, so a single save at the end would mean a
// Ctrl-C, a laptop lid, or a flaky VPN throwing away the whole run. Saving
// every this-many lookups instead caps that loss at a couple of minutes'
// work, and makes the pass restartable: a re-run reads what landed and
// carries on from there. Cheap to do often - saveCache writes to a temp file
// and renames, so an interrupted checkpoint can't corrupt the committed one.
const SAVE_EVERY = 100;

export interface StationInput {
  id: string; // OSM feature id, e.g. "n123456" - the cache key
  name: string;
  lon: number;
  lat: number;
}

// A '#' prefix can never collide with a real MOTIS id (ids are plain feed
// identifiers like "de-DELFI_de:04011:13927_G", none start with '#') or
// with '' (confirmed no match), and stays legible in a `git diff` of the
// committed cache, unlike a control character would.
const AMBIGUOUS_MARKER = '#ambiguous';

/**
 * The generation of `lookup()` that produced the cached negatives, stamped
 * into the cache file.
 *
 * A `''` entry means "this resolver found nothing", which is only the same as
 * "MOTIS has nothing" for as long as the resolver stands still. Since a
 * negative is otherwise permanent (see the file header), an improvement to
 * `lookup()` would never reach the stations it was written to fix - they are
 * precisely the ones already written off. Bumping this discards every
 * negative on load so the new resolver gets its shot at them.
 *
 * Resolved ids are deliberately *not* discarded: a bump says the search got
 * better at finding stops, not that the stops it already found moved, and
 * re-probing thousands of settled stations would spend a nightly budget on
 * confirming what is already known.
 *
 *   1  geocode by bare OSM name, reverse-geocode fallback.
 *   2  + locality-qualified geocode retry (see `lookup`), which is what
 *      finally resolves generically-named urban stops ("Rathaus", "Schloss")
 *      whose bare name matches a dozen towns before it matches this one.
 *   3  + `type=STOP` on all three searches, so a stop is no longer crowded
 *      out of its own coordinate search by the addresses around it.
 *   4  + abbreviation-aware name matching (see `tokensMatch`), for the feed
 *      names that shorten what OSM spells out in full.
 */
const RESOLVER_VERSION = 4;

// osmId -> MOTIS stop id, '' = confirmed no match, AMBIGUOUS_MARKER = see T1-8 below.
type Cache = Record<string, string>;

interface CacheFile {
  /** RESOLVER_VERSION of the run that last wrote the negatives in `stops`. */
  version: number;
  stops: Cache;
}

/**
 * Accepts both the wrapped shape and the original flat `{osmId: stopId}` map,
 * which predates versioning and is therefore version 1 by definition. Anything
 * else (a hand-edit gone wrong, a half-written file) is treated as no cache at
 * all rather than trusted into the run.
 */
function parseCache(raw: unknown): CacheFile {
  if (!raw || typeof raw !== 'object') return { version: RESOLVER_VERSION, stops: {} };
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version === 'number' && obj.stops && typeof obj.stops === 'object') {
    return { version: obj.version, stops: obj.stops as Cache };
  }
  const flat: Cache = {};
  for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') flat[k] = v;
  return { version: 1, stops: flat };
}

// Tolerant on purpose: a cache that fails to parse (e.g. truncated by a
// killed process - see saveCache) must not take the whole build down with
// it. Worst case we lose a run's worth of memoisation and re-resolve within
// budget; saveCache's atomic rename means this should be rare to begin with.
function loadCache(): CacheFile {
  if (!existsSync(CACHE_PATH)) return { version: RESOLVER_VERSION, stops: {} };
  try {
    return parseCache(JSON.parse(readFileSync(CACHE_PATH, 'utf8')));
  } catch (err) {
    console.log(`==> stop ids: ${CACHE_PATH} is unreadable (${(err as Error).message}), starting empty`);
    return { version: RESOLVER_VERSION, stops: {} };
  }
}

/**
 * Removes the entries a newer resolver deserves a fresh attempt at, leaving
 * resolved ids alone. Returns how many were dropped; 0 when the cache is
 * already current, which is every run but the first after a bump.
 */
function dropStaleNegatives(cache: CacheFile): number {
  if (cache.version >= RESOLVER_VERSION) return 0;
  let dropped = 0;
  for (const [id, value] of Object.entries(cache.stops)) {
    if (value === '' || value === AMBIGUOUS_MARKER) { delete cache.stops[id]; dropped++; }
  }
  cache.version = RESOLVER_VERSION;
  return dropped;
}

function saveCache(cache: Cache): void {
  const sorted: Cache = {};
  for (const key of Object.keys(cache).sort()) sorted[key] = cache[key];
  // JSON.stringify's pretty-printer puts one key per line, so a nightly
  // diff shows exactly which stations changed.
  const body = JSON.stringify({ version: RESOLVER_VERSION, stops: sorted }, null, 2) + '\n';
  // Write-then-rename: a process kill mid-write leaves the temp file
  // corrupt but never touches the committed CACHE_PATH, so a crash here
  // can't leave a truncated file for the next run's loadCache to trip over.
  const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, CACHE_PATH);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp); // rename failed - don't litter a stray temp file
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function fetchJson(url: string): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1) + Math.random() * 200);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      lastErr = err; // network error / timeout - retryable
      continue;
    }
    if (res.ok) return await res.json();
    if (!RETRY_STATUSES.has(res.status)) throw new Error(`${url}: HTTP ${res.status}`);
    lastErr = new Error(`${url}: HTTP ${res.status}`);
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Name normalisation - strip the usual German station-name noise so
// "Bremen Hbf" and "Bremen Hauptbahnhof" (or "Haste(b Wunstorf)" vs
// "Haste") compare equal.
// ---------------------------------------------------------------------------

const UMLAUT: Record<string, string> = { ü: 'ue', ö: 'oe', ä: 'ae', ß: 'ss' };

function normaliseName(raw: string): string {
  let s = raw.replace(/\([^)]*\)/g, ' ').toLowerCase(); // "(b Wunstorf)" style suffixes
  s = s.replace(/[üöäß]/g, (c) => UMLAUT[c]);
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // any remaining diacritics
  s = s
    .replace(/\bhauptbahnhof\b/g, ' ')
    .replace(/\bhbf\.?\b/g, ' ')
    .replace(/\bbahnhof\b/g, ' ')
    .replace(/\bbf\.?\b/g, ' ');
  return s.replace(/[^a-z0-9]+/g, ' ').trim();
}

// A feed name may carry the town in front of the stop name ("Braunschweig,
// J.-F.-Kennedy-Pl."). Two tokens is enough for the ones that come in parts
// ("Bad Oeynhausen"); allowing more would let the alignment below skip half a
// name looking for something to line up with.
const MAX_TOWN_PREFIX_TOKENS = 2;

/**
 * Do two token lists describe the same stop, allowing either side to
 * abbreviate? German feeds are written for fixed-width departure displays and
 * shorten anything long, word by word, in ways no dictionary covers:
 * "Stadtfriedhof Seelhorst" ships as "Stadtfriedhof Seelh.",
 * "Friedrich-Wilhelm-Straße" as "Fr.-Wilhelm-Str.", "John-F.-Kennedy-Platz"
 * as "J.-F.-Kennedy-Pl." - each 3 m to 90 m from the OSM node that spells it
 * out in full. What survives the shortening is the order of the words and
 * their opening letters, so that is what this compares: after skipping a
 * leading town prefix, the two lists must be the same length and each pair
 * must share a prefix, in either direction.
 *
 * The same-length requirement is the guard. Without it "Am Wall" would align
 * against the first two words of any longer name starting the same way; with
 * it, a candidate has to be the *whole* name, abbreviated - a missing or an
 * extra word is a different stop.
 */
function tokensMatch(station: string[], candidate: string[]): boolean {
  for (let skip = 0; skip <= MAX_TOWN_PREFIX_TOKENS; skip++) {
    const tail = candidate.slice(skip);
    if (tail.length !== station.length) continue;
    if (tail.every((t, i) => t.startsWith(station[i]) || station[i].startsWith(t))) return true;
  }
  return false;
}

function namesMatch(a: string, b: string): boolean {
  const na = normaliseName(a), nb = normaliseName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Feeds sometimes qualify a name with its town or drop/add a suffix;
  // accept when one normalised form is wholly contained in the other.
  if ((na.length >= 3 && nb.includes(na)) || (nb.length >= 3 && na.includes(nb))) return true;
  const ta = na.split(' '), tb = nb.split(' ');
  return tokensMatch(ta, tb) || tokensMatch(tb, ta);
}

// ---------------------------------------------------------------------------
// Geo + candidate selection
// ---------------------------------------------------------------------------

/** Equirectangular approximation - accurate enough at a 500 m radius. */
function metres(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const mPerDegLat = 111320;
  const dx = (aLon - bLon) * mPerDegLat * Math.cos((aLat * Math.PI) / 180);
  const dy = (aLat - bLat) * mPerDegLat;
  return Math.hypot(dx, dy);
}

/**
 * `areas` is the admin hierarchy MOTIS attaches to every geocoder result
 * (country, state, city, quarter). Only the city-level entry is read, and
 * only to qualify a retry query - see `locality`.
 */
interface CandidateArea { name: string; adminLevel: number; default?: boolean }
interface Candidate {
  type: string; id: string; name: string; lat: number; lon: number;
  areas?: CandidateArea[];
}

/**
 * `{ id }` - a single trustworthy match.
 * `null` - no candidate passed the distance/name filters at all; a genuine
 *   negative, cached as `''` and never re-probed (see resolveStopIds).
 * `{ ambiguous: true }` - more than one *distinct* stop plausibly matches;
 *   cached under AMBIGUOUS_MARKER, its own state distinct from both a
 *   resolved id and a confirmed negative, so it's neither treated as
 *   permanent nor left to compete with never-tried stations for budget on
 *   equal footing (see resolveStopIds).
 */
type MatchResult = { id: string } | { ambiguous: true } | null;

function bestMatch(candidates: Candidate[], station: StationInput): MatchResult {
  interface Match { id: string; d: number; name: string; lon: number; lat: number; }
  const matches: Match[] = [];
  for (const c of candidates) {
    if (c.type !== 'STOP') continue;
    const d = metres(c.lon, c.lat, station.lon, station.lat);
    if (d > MAX_DISTANCE_M) continue;
    if (!namesMatch(c.name, station.name)) continue;
    matches.push({ id: c.id, d, name: normaliseName(c.name), lon: c.lon, lat: c.lat });
  }
  if (matches.length === 0) return null;

  // Collapse feed duplicates (see file header) before judging ambiguity:
  // group candidates that share a normalised name AND sit within
  // DUPLICATE_DISTANCE_M of another member of the group, then keep one
  // deterministic representative (lowest id) per group.
  //
  // This has to be a real connected-components partition, not a greedy
  // first-match grouping (T1-7): with three same-named candidates A, B, C
  // where A-B <= DUPLICATE_DISTANCE_M, B-C <= DUPLICATE_DISTANCE_M, but
  // A-C > DUPLICATE_DISTANCE_M, a greedy left-to-right scan puts all three
  // in one group if A appears first but splits them into two groups if C
  // appears first - the partition depended on API response order, which
  // Transitous doesn't document as stable. That made the committed cache
  // churn between runs with no upstream change, and could under-collapse
  // the exact multi-feed hubs this was built to rescue. Union-find below
  // computes connectivity from the pairwise relation alone, so the result
  // is a function of the candidate *set*, independent of array order.
  //
  // This does mean a *chain* transitively merges A with C even though they
  // are individually further apart than DUPLICATE_DISTANCE_M - e.g. up to
  // ~2x the threshold for a 3-node chain, more for a longer one. Chosen
  // deliberately over rejecting chains as ambiguous: DUPLICATE_DISTANCE_M
  // (20 m) is already an order of magnitude tighter than AMBIGUITY_MARGIN_M
  // (150 m), and a chain additionally requires every hop to share the exact
  // normalised name, so an accidental chain linking two genuinely different
  // stops needs several independent coincidences at once. Rejecting chains
  // would reintroduce the blackholing this revision exists to fix at
  // exactly the busiest, most-duplicated interchanges (more feeds serving
  // one hub -> more chained duplicate pairs, not fewer).
  const parent = matches.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let i = 0; i < matches.length; i++) {
    for (let j = i + 1; j < matches.length; j++) {
      if (
        matches[i].name === matches[j].name
        && metres(matches[i].lon, matches[i].lat, matches[j].lon, matches[j].lat) <= DUPLICATE_DISTANCE_M
      ) union(i, j);
    }
  }
  const groups = new Map<number, Match[]>();
  matches.forEach((m, i) => {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(m); else groups.set(root, [m]);
  });
  const representatives = [...groups.values()]
    .map((g) => [...g].sort((a, b) => a.id.localeCompare(b.id))[0])
    // Distance ties are possible (e.g. two collapsed groups equidistant from
    // the station); break on id too so the chosen [best, runnerUp] pair -
    // and therefore the ambiguity verdict - never depends on Array.sort's
    // handling of equal keys either.
    .sort((a, b) => a.d - b.d || a.id.localeCompare(b.id));

  const [best, runnerUp] = representatives;
  // Two validated, distinct stops this close together (see AMBIGUITY_MARGIN_M)
  // - guessing which one is right risks a wrong-but-confident answer, so
  // decline instead.
  if (runnerUp && runnerUp.d - best.d < AMBIGUITY_MARGIN_M) return { ambiguous: true };
  return { id: best.id };
}

/** Union of two candidate lists, dropping repeats of the same stop. An entry
 *  with no id can't be deduplicated and is kept as-is; `bestMatch` discards
 *  anything that isn't a stop regardless. */
function mergeCandidates(a: Candidate[], b: Candidate[]): Candidate[] {
  const seen = new Set(a.map((c) => c.id).filter(Boolean));
  return a.concat(b.filter((c) => !c.id || !seen.has(c.id)));
}

/**
 * The town a set of geocoder results sits in, used to qualify a retry query.
 *
 * MOTIS marks one area per result as `default` - the one a human would name
 * to say where this is ("Braunschweig"), which is what the feeds themselves
 * prefix their stop names with. `adminLevel` 6 is the fallback for a result
 * whose areas carry no default flag; anything above that is a state or a
 * country and too coarse to narrow a search by.
 */
function locality(candidates: Candidate[]): string | null {
  for (const c of candidates) {
    const areas = c.areas ?? [];
    const area = areas.find((a) => a.default) ?? areas.find((a) => a.adminLevel === 6);
    if (area?.name) return area.name;
  }
  return null;
}

/**
 * Geocode-by-name first (best hit rate - see report). If that alone doesn't
 * produce a clean single match (nothing found, or an unresolved ambiguity),
 * also try reverse-geocode by coordinate and re-run the match over the
 * *union* of both candidate lists - a station missing from one search or
 * looking ambiguous in isolation may be disambiguated by candidates only the
 * other search surfaces. Both lists are validated identically.
 *
 * Every call passes `type=STOP`. A candidate of any other type is thrown out
 * by `bestMatch` anyway, and without the filter a response spends its ten
 * (five, for reverse-geocode) slots on whatever POI happens to share the name
 * or the pavement: unfiltered, the coordinate search at Braunschweig's
 * "Botanischer Garten" returns four addresses and a bakery, and the stop 12 m
 * away never appears at all. Filtered, that same call returns the five
 * nearest *stops* in distance order - which is what this function has wanted
 * from it all along.
 *
 * Failing that, geocode once more with the town name in front of the station
 * name. Neither search above can find an urban stop with a generic name: a
 * bare "Rathaus" is a name a hundred German towns use, and the geocoder
 * answers with its ten globally best-scoring "Rathaus" stops - Stuttgart,
 * Hamburg, Wien - none of them this one, and no location-bias parameter moves
 * it (`place`/`placeBias` were both measured against api.transitous.org and
 * neither surfaced the local stop). The coordinate search only rescues the
 * ones that sit within its handful of nearest stops. But
 * "Braunschweig Rathaus" returns the right stop as its first hit, and the
 * town name is free - it's already sitting in the `areas` of the
 * reverse-geocode results just fetched. Skipped when the station name already
 * carries its town, since that query is the one that already came back empty.
 */
async function lookup(station: StationInput): Promise<MatchResult> {
  const byName = await fetchJson(
    `${API}/geocode?text=${encodeURIComponent(station.name)}&type=STOP`,
  ) as Candidate[];
  const direct = bestMatch(byName, station);
  if (direct && 'id' in direct) return direct;

  await sleep(THROTTLE_MS);
  const nearby = await fetchJson(
    `${API}/reverse-geocode?place=${station.lat},${station.lon}&type=STOP`,
  ) as Candidate[];
  const pool = mergeCandidates(byName, nearby);
  const merged = bestMatch(pool, station);
  if (merged && 'id' in merged) return merged;

  const town = locality(nearby);
  if (!town || normaliseName(station.name).includes(normaliseName(town))) return merged;

  await sleep(THROTTLE_MS);
  const qualified = await fetchJson(
    `${API}/geocode?text=${encodeURIComponent(`${town} ${station.name}`)}&type=STOP`,
  ) as Candidate[];
  return bestMatch(mergeCandidates(pool, qualified), station);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ResolveResult {
  stopIds: Map<string, string>;
  cached: number;
  resolved: number;
  unresolved: number;
  ambiguous: number;
  errored: number;
  budgetUsed: number;
}

/**
 * `STOP_ID_BUDGET=0` is a valid, meaningful setting ("cache only, no
 * network") and must not fall back to the default just because 0 is falsy -
 * only an unset/empty/non-numeric value should.
 */
function envBudget(): number | undefined {
  const raw = process.env.STOP_ID_BUDGET;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

// Ambiguous re-probes share the run's budget with never-tried stations (see
// T1-8), capped at this many per run once the run is picking from the
// AMBIGUOUS_MARKER backlog rather than genuinely new stations. Two reasons:
// it keeps a night with few/no new stations from spending its *entire*
// budget re-checking a large accumulated backlog that's likely to still be
// ambiguous tomorrow (Transitous feed updates aren't that frequent), and it
// keeps the nightly request volume roughly predictable regardless of how
// large that backlog happens to grow. The uncapped standalone CLI (`npm run
// resolve:stop-ids`, `budget: Infinity`) is exempt - a human explicitly
// asking for a full refresh should get the whole backlog re-checked too.
const AMBIGUOUS_REPROBE_CAP = 100;

export async function resolveStopIds(
  stations: StationInput[],
  opts: { budget?: number } = {},
): Promise<ResolveResult> {
  const budget = opts.budget ?? envBudget() ?? DEFAULT_BUDGET;
  const cacheFile = loadCache();
  const cache = cacheFile.stops;
  const stopIds = new Map<string, string>();

  let cachedN = 0, resolved = 0, unresolved = 0, ambiguous = 0, errored = 0, budgetUsed = 0;
  let dirty = false;

  // Before the split below reads the cache, so a station whose negative was
  // just discarded lands in `neverTried` and competes for this run's budget.
  const cacheVersion = cacheFile.version;
  const staleDropped = dropStaleNegatives(cacheFile);
  if (staleDropped) {
    dirty = true; // the version stamp has to land even if every lookup below errors
    console.log(
      `==> stop ids: cache written by resolver v${cacheVersion}, dropped ${staleDropped} ` +
      `stale negatives for re-probing under v${RESOLVER_VERSION}`,
    );
  }
  let consecutiveErrors = 0;
  let breakerTripped = false;
  let sinceSave = 0;

  // Split up front, purely from the cache, before any network call: stations
  // never looked up at all vs. stations cached as AMBIGUOUS_MARKER (T1-8) -
  // known-ambiguous as of a past run, eligible for a bounded re-probe. This
  // separation is what lets never-tried stations claim the budget first
  // below; without it, a fixed iteration order plus a growing ambiguous
  // backlog would starve new-station resolution indefinitely (that was the
  // bug - a single merged loop that hit ambiguous stations before it ever
  // reached the untried tail of the station list).
  const neverTried: StationInput[] = [];
  const retryAmbiguous: StationInput[] = [];
  for (const st of stations) {
    const existing = cache[st.id];
    if (existing === undefined) {
      neverTried.push(st);
    } else if (existing === AMBIGUOUS_MARKER) {
      cachedN++;
      retryAmbiguous.push(st);
      stopIds.set(st.id, ''); // current best knowledge; overwritten below if re-probed this run
    } else {
      cachedN++;
      stopIds.set(st.id, existing);
    }
  }

  async function attempt(st: StationInput): Promise<void> {
    budgetUsed++;
    try {
      const result = await lookup(st);
      consecutiveErrors = 0;
      if (result && 'id' in result) {
        cache[st.id] = result.id;
        stopIds.set(st.id, result.id);
        dirty = true;
        resolved++;
      } else if (result && 'ambiguous' in result) {
        // Cached under its own marker (T1-8), not left absent like an error:
        // absent would put it back in `neverTried` next run and let it
        // compete for budget on equal footing with genuinely new stations
        // forever. Still distinct from '' so it stays eligible for the
        // bounded re-probe below instead of being treated as a permanent
        // negative.
        cache[st.id] = AMBIGUOUS_MARKER;
        stopIds.set(st.id, '');
        dirty = true;
        ambiguous++;
      } else {
        cache[st.id] = '';
        stopIds.set(st.id, '');
        dirty = true;
        unresolved++;
      }
      // Every branch above wrote to the cache; checkpoint periodically so a
      // long uncapped pass survives being interrupted (see SAVE_EVERY).
      if (++sinceSave >= SAVE_EVERY) {
        saveCache(cache);
        sinceSave = 0;
        console.log(`    ${budgetUsed} looked up (${resolved} resolved) - cache checkpointed`);
      }
    } catch {
      // Network/API failure: don't touch the cache entry (if any) - a
      // never-tried station stays absent and a previously-ambiguous one
      // stays AMBIGUOUS_MARKER, either way retried later instead of being
      // stuck with a bogus outcome from a transient failure.
      errored++;
      consecutiveErrors++;
      if (consecutiveErrors >= CIRCUIT_BREAKER) breakerTripped = true;
    }
    await sleep(THROTTLE_MS);
  }

  for (const st of neverTried) {
    if (breakerTripped || budgetUsed >= budget) break;
    await attempt(st);
  }

  const reprobeBudget = budget === Infinity
    ? Infinity
    : Math.min(Math.max(budget - budgetUsed, 0), AMBIGUOUS_REPROBE_CAP);
  let reprobed = 0;
  for (const st of retryAmbiguous) {
    if (breakerTripped || reprobed >= reprobeBudget) break;
    reprobed++;
    await attempt(st);
  }

  if (dirty) saveCache(cache);

  console.log(
    `==> stop ids: ${cachedN} from cache, ${resolved} newly resolved, ` +
    `${unresolved} confirmed unresolved, ${ambiguous} ambiguous (${reprobed}/${retryAmbiguous.length} known-ambiguous re-probed), ` +
    `${errored} lookup errors` +
    `${breakerTripped ? ' (circuit breaker tripped - Transitous looked down)' : ''}, ` +
    `${budgetUsed}/${budget === Infinity ? 'unlimited' : budget} of budget used`,
  );

  return { stopIds, cached: cachedN, resolved, unresolved, ambiguous, errored, budgetUsed };
}

// ---------------------------------------------------------------------------
// Standalone CLI: `npm run resolve:stop-ids`
//
// Reads the same stations.geojsonseq that build.ts parses, so it must run
// after `npm run fetch && npm run extract` (or the start of `npm run
// pipeline`). No budget cap by default - meant for an occasional full local
// refresh whose diff a human reviews and commits. Set STOP_ID_BUDGET to cap
// it too, e.g. for a quick manual top-up.
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const { createInterface } = await import('node:readline');
  const { createReadStream } = await import('node:fs');

  const WORK = process.env.WORK_DIR ?? '.work';
  const EXTRACT = `${WORK}/extract`;

  const stations: StationInput[] = [];
  for await (const raw of createInterface({
    input: createReadStream(`${EXTRACT}/stations.geojsonseq`),
    crlfDelay: Infinity,
  })) {
    const text = raw.replace(/^\x1e/, '').trim();
    if (!text) continue;
    const f = JSON.parse(text);
    if (f.geometry?.type !== 'Point' || !f.properties?.name) continue;
    stations.push({
      id: String(f.id),
      name: f.properties.name,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    });
  }
  console.log(`==> resolving stop ids for ${stations.length} stations (no budget cap unless STOP_ID_BUDGET is set)`);
  const budget = envBudget() ?? Infinity;
  await resolveStopIds(stations, { budget });
}

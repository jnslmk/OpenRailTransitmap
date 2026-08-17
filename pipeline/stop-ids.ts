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

// osmId -> MOTIS stop id, '' = confirmed no match, AMBIGUOUS_MARKER = see T1-8 below.
type Cache = Record<string, string>;

// Tolerant on purpose: a cache that fails to parse (e.g. truncated by a
// killed process - see saveCache) must not take the whole build down with
// it. Worst case we lose a run's worth of memoisation and re-resolve within
// budget; saveCache's atomic rename means this should be rare to begin with.
function loadCache(): Cache {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch (err) {
    console.log(`==> stop ids: ${CACHE_PATH} is unreadable (${(err as Error).message}), starting empty`);
    return {};
  }
}

function saveCache(cache: Cache): void {
  const sorted: Cache = {};
  for (const key of Object.keys(cache).sort()) sorted[key] = cache[key];
  // JSON.stringify's pretty-printer puts one key per line, so a nightly
  // diff shows exactly which stations changed.
  const body = JSON.stringify(sorted, null, 2) + '\n';
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

function namesMatch(a: string, b: string): boolean {
  const na = normaliseName(a), nb = normaliseName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Feeds sometimes qualify a name with its town or drop/add a suffix;
  // accept when one normalised form is wholly contained in the other.
  return (na.length >= 3 && nb.includes(na)) || (nb.length >= 3 && na.includes(nb));
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

interface Candidate { type: string; id: string; name: string; lat: number; lon: number; }

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

/**
 * Geocode-by-name first (best hit rate - see report). If that alone doesn't
 * produce a clean single match (nothing found, or an unresolved ambiguity),
 * also try reverse-geocode by coordinate and re-run the match over the
 * *union* of both candidate lists - a station missing from one search or
 * looking ambiguous in isolation may be disambiguated by candidates only the
 * other search surfaces. Both lists are validated identically; reverse-geocode
 * results are frequently POIs inside the station building that outrank the
 * stop itself, which `bestMatch`'s type filter throws out regardless.
 */
async function lookup(station: StationInput): Promise<MatchResult> {
  const byName = await fetchJson(`${API}/geocode?text=${encodeURIComponent(station.name)}`) as Candidate[];
  const direct = bestMatch(byName, station);
  if (direct && 'id' in direct) return direct;

  await sleep(THROTTLE_MS);
  const nearby = await fetchJson(`${API}/reverse-geocode?place=${station.lat},${station.lon}`) as Candidate[];
  const seen = new Set(byName.map((c) => c.id));
  const merged = byName.concat(nearby.filter((c) => !seen.has(c.id)));
  return bestMatch(merged, station);
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
  const cache = loadCache();
  const stopIds = new Map<string, string>();

  let cachedN = 0, resolved = 0, unresolved = 0, ambiguous = 0, errored = 0, budgetUsed = 0;
  let dirty = false;
  let consecutiveErrors = 0;
  let breakerTripped = false;

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

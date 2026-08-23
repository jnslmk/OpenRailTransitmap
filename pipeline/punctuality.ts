/**
 * Punctuality scores per line and per station, from Deutsche Bahn's published
 * delay record - the number the line detail panel shows when a rider selects
 * a line ("how often does this actually run on time, and where does it go
 * wrong").
 *
 * ## Source
 * `piebro/deutsche-bahn-data` on HuggingFace, the maintained successor to
 * Daniel Kriesel's 36C3 "BahnMining" dataset: it polls DB's Timetables and
 * StaDa APIs and publishes one Parquet file per month, CC BY 4.0 (attribute
 * Deutsche Bahn). Each row is one train at one station, with the planned and
 * the actually-announced arrival and departure time.
 *
 * ## Why this reads the files over the network, column by column
 * A rolling 12-month window is ~5.7 GB of Parquet, which is a silly thing to
 * download to compute six counters per station. But Parquet is columnar and
 * HuggingFace serves range requests, so `hyparquet` fetches only the byte
 * ranges of the columns actually named in `COLUMNS` - seven of eighteen:
 * measured across the whole file (data-2026-07.parquet, 115 row groups,
 * 591 MB - the exact Content-Length), those seven columns sum to 127.56 MB,
 * i.e. ~128 MB per monthly file rather than ~591 MB. The whole window costs
 * ~1.5 GB and no disk at all - see `COLUMNS` for what the seventh column buys.
 *
 * ## Why it is not in the nightly pipeline
 * The upstream files are published monthly, so a nightly recompute would
 * re-read the same 1.5 GB for the same answer, off a free volunteer-adjacent
 * host. Instead this is a standalone `npm run build:punctuality` whose output
 * is committed at `data/punctuality.json`, the same shape as data/stop-ids.json:
 * CI never pushes (the workflow runs with `contents: read`), it just copies
 * the committed file into `public/`. A human re-runs it when a new month lands.
 *
 * ## The join, which is the actual hard part
 * DB's feed names a line ("S1") and a station ("Hannover Hbf"). The map has 22
 * different lines called S1. There is no network or operator field in the feed
 * to disambiguate with, so the station name *is* the disambiguator: a row for
 * S1 at Hannover Hbf belongs to the Hannover S1 and to no other. That is why
 * build.ts emits data/line-stations.json - see `buildIndex` below.
 *
 * ## Long-distance is a different join, not the same one widened
 * `line_number` is 0% populated for every long-distance train_type - measured
 * across a full month (data-2025-12.parquet, 15.46M rows): ICE, IC, EC, ECE,
 * NJ, RJ, RJX, EN, TGV and IR all read empty, FLX alone is 100% populated
 * (it's a bare corridor number, "10"/"20"/"30", not a train ref). So there is
 * no ref to join on at all - `rowRef` returns '' for every one of these and
 * always has (see "gives up on a row that names no line" below).
 *
 * What the row does carry is `train_line_ride_id` and `train_line_station_num`,
 * which turn out to identify something more useful than a single physical
 * journey: sampled against ICE 618 (München Hbf -> Kiel Hbf) in
 * data-2025-01.parquet, one ride id covers 31 different calendar days of that
 * same train number, `train_line_station_num` restarting at 1 and increasing
 * monotonically each day. So a "ride" here means one scheduled long-distance
 * service's stops accumulated over the whole month, not one train's one trip -
 * which is *better* for matching: it is the fullest itinerary the month can
 * show, gaps from any single day's diversions or a partial read averaged out.
 * `train_line_station_num` itself is not read: matching below is set-based
 * (which stops does the ride touch, not in what order), and order carries no
 * information the station set doesn't already have for this purpose.
 *
 * `buildLongDistanceIndex` attributes a whole ride to the one long-distance
 * line whose station list contains every stop the ride touched - see the
 * function for the measured numbers behind that rule.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';

import { namesMatch, normaliseName } from './stop-ids.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATA = 'data';
const OUT_PATH = `${DATA}/punctuality.json`;
const LINE_STATIONS_PATH = `${DATA}/line-stations.json`;
const REGISTRY_PATH = `${DATA}/lines.json`;

const REPO = 'piebro/deutsche-bahn-data';
const TREE_URL = `https://huggingface.co/api/datasets/${REPO}/tree/main/monthly_processed_data`;
const FILE_URL = (month: string) =>
  `https://huggingface.co/datasets/${REPO}/resolve/main/monthly_processed_data/data-${month}.parquet`;

/** Rolling window, in monthly files, most recent first. */
const DEFAULT_MONTHS = 12;

/**
 * DB's own "pünktlich" threshold: under six minutes late counts as on time.
 * Using DB's line means the number here can be compared against the ones DB
 * publishes, rather than being a private definition nobody can check.
 */
export const ON_TIME_THRESHOLD_MIN = 6;

/**
 * The seven columns the join and the counters need, out of the eighteen in
 * the file. Every name added here costs bandwidth on every row group of
 * every month - see the header.
 *
 * `train_line_ride_id` is the expensive one: measured across the whole file
 * (data-2026-07.parquet, 115 row groups, 591 MB total), the other six
 * columns together sum to 76.45 MB but this one column alone is another
 * 51.11 MB - a high-entropy per-ride identifier compresses far worse than the
 * booleans and timestamps around it. That takes a monthly file from ~76 MB to
 * ~128 MB and the 12-month window from ~0.9 GB to ~1.5 GB. It earns its place
 * anyway: without it, long-distance has no ref and no way to group a train's
 * stops together at all - see "Long-distance is a different join" in the
 * header. `train_line_station_num` is *not* read, despite being the other
 * half of that pair - see the same section for why order is not needed here.
 */
const COLUMNS = [
  'station_name',
  'line_number',
  'train_type',
  'departure_is_canceled',
  'departure_planned_time',
  'departure_change_time',
  'train_line_ride_id',
] as const;

/**
 * Modes whose refs this can join ref-first, the way `buildIndex` below does
 * it. Tram/subway refs are bare numbers against an operator-abbreviated
 * `train_type`, which collides far too readily to attribute safely - that one
 * stays deferred. Long-distance used to be deferred for the same kind of
 * reason (no usable ref at all, not just a colliding one) but is scored
 * separately below, by whole-ride itinerary rather than by ref - see
 * `buildLongDistanceIndex` and `LONGDISTANCE_TRAIN_TYPES`.
 */
const SCORED_MODES = new Set(['regional', 'suburban']);

/** The registry mode long-distance lines are filed under. */
const LONGDISTANCE_MODE = 'longdistance';

/**
 * Feed spellings of `train_type` that name a long-distance product, i.e. rows
 * worth holding for ride grouping at all - everything else takes the ref+
 * station path above (or is dropped there, for the modes this doesn't score).
 *
 * ICE/IC/EC obviously; ECE, EN, RJ, RJX and TGV are their Austrian, night and
 * cross-border siblings; FLX is the open-access competitor (whose rows *do*
 * carry a usable `line_number` - "10", "20", "30" - but are still routed
 * through ride-matching rather than given a second code path, since itinerary
 * matching gets the right answer for FLX too and a train_type check is one
 * path, not two). IR and D are rare (0.007% and 0.0002% of rows in the
 * measured month) but real: the registry's own longdistance refs include an
 * SBB "IR75" and a legacy "D25".
 *
 * Measured on a full month (data-2025-12.parquet, 15,463,467 rows): these
 * types are 1.85% of all rows, close to the ballpark the regional/suburban
 * path already runs at.
 */
const LONGDISTANCE_TRAIN_TYPES = new Set([
  'ICE',
  'IC',
  'EC',
  'ECE',
  'EN',
  'RJ',
  'RJX',
  'NJ',
  'FLX',
  'TGV',
  'IR',
  'D',
]);

/**
 * A delay this large is a feed artefact (a stale change-time left on a row, a
 * clock problem), not a train. Dropping it keeps one bad row from swamping a
 * station's mean, which is otherwise measured in single-digit minutes.
 */
const MAX_PLAUSIBLE_DELAY_MIN = 24 * 60;

// ---------------------------------------------------------------------------
// Ref matching
// ---------------------------------------------------------------------------

/**
 * Line refs to a comparable form. Deliberately the same reduction the app
 * applies in src/main.ts `lineKey` - drop a trailing parenthetical, drop
 * spaces, lowercase - because a ref's spacing is tagged inconsistently even
 * within one network ("RB44" and "RB 45" in the same registry) and the feed
 * has its own spelling again.
 */
export function normaliseRef(raw: string): string {
  return raw
    .replace(/\s*\([^()]*\)\s*$/, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * Mode prefixes that may be recovered from `train_type` when `line_number` is
 * a bare number. `train_type` is *mostly* an operator abbreviation - the real
 * values include `CAN`, `BRB`, `TL`, `ag`, `NX`, `AVG`, `NBE`, `RSM`, `ENO`,
 * `ARV` - so it is only trusted when it happens to spell a mode and there is
 * nothing else to go on.
 */
const MODE_PREFIXES = new Set(['re', 'rb', 's', 'rs', 'mex', 'r']);

/**
 * The ref a feed row claims, or `''` when the row cannot name a line at all.
 *
 * `line_number` is usually already prefixed (`"S6"`, `"RB58"`), in which case
 * it is taken as-is. It is sometimes a bare number (`"6"`), which alone
 * matches nothing - `S6`, `RE6` and `RB6` all exist - so the mode prefix is
 * borrowed from `train_type` when `train_type` spells one. It is null for
 * long-distance, which is out of scope.
 */
export function rowRef(lineNumber: string | null, trainType: string | null): string {
  const line = normaliseRef(lineNumber ?? '');
  if (!line) return '';
  if (!/^\d+[a-z]?$/.test(line)) return line;
  const type = normaliseRef(trainType ?? '');
  return MODE_PREFIXES.has(type) ? type + line : '';
}

// ---------------------------------------------------------------------------
// The (ref, station) -> line index
// ---------------------------------------------------------------------------

export interface LineIndex {
  /**
   * The line a feed row belongs to, or `null` when no line claims that ref at
   * that station, or when more than one does and the row cannot be attributed
   * to either.
   */
  match(ref: string, stationName: string): string | null;
  /** Diagnostics for the run report; not part of the output file. */
  readonly stats: { hits: number; misses: number; ambiguous: number };
}

interface Candidate {
  id: string;
  /** Normalised station names, for the exact path. */
  exact: Set<string>;
  /** Raw station names, for the abbreviation-tolerant path. */
  raw: string[];
}

/**
 * Build the lookup a row goes through: ref -> the handful of map lines
 * carrying that ref -> the one whose station list contains the row's station.
 *
 * Both stages are needed. Ref alone is hopeless (132 of 285 regional refs are
 * shared, `RE7` alone by ten different lines); station alone is worse still.
 * Together they are near-unique, and where they are not - two lines with the
 * same ref genuinely calling at the same station - the row is dropped rather
 * than guessed at, because a wrong attribution silently corrupts a published
 * score in a way nothing downstream can detect.
 *
 * Results are memoised per `(ref, station name)` pair. The feed has a few
 * thousand distinct station names and the fuzzy fallback is a linear scan of a
 * line's stations, so without the memo the fallback would run tens of millions
 * of times over a 12-month window instead of once per distinct pair.
 */
export function buildIndex(
  lineStations: Record<string, string[]>,
  modeOf: (lineId: string) => string | undefined,
  refOf: (lineId: string) => string | undefined,
): LineIndex {
  const byRef = new Map<string, Candidate[]>();

  for (const [id, names] of Object.entries(lineStations)) {
    const mode = modeOf(id);
    if (!mode || !SCORED_MODES.has(mode)) continue;
    const ref = normaliseRef(refOf(id) ?? '');
    if (!ref) continue;
    const candidate: Candidate = {
      id,
      exact: new Set(names.map((n) => normaliseName(n)).filter(Boolean)),
      raw: names,
    };
    const bucket = byRef.get(ref);
    if (bucket) bucket.push(candidate);
    else byRef.set(ref, [candidate]);
  }

  const memo = new Map<string, string | null>();
  const stats = { hits: 0, misses: 0, ambiguous: 0 };

  function resolve(ref: string, stationName: string): string | null {
    const candidates = byRef.get(ref);
    if (!candidates) return null;

    // Exact first, and if exactly one line claims the station exactly, that is
    // the answer even when a second line's fuzzy rule would also have fired -
    // an abbreviation match is a weaker claim than the name spelled out.
    const normalised = normaliseName(stationName);
    let matched: string | null = null;
    let count = 0;
    if (normalised) {
      for (const c of candidates) {
        if (c.exact.has(normalised)) {
          matched = c.id;
          count++;
        }
      }
      if (count === 1) return matched;
      if (count > 1) {
        stats.ambiguous++;
        return null;
      }
    }

    for (const c of candidates) {
      if (c.raw.some((n) => namesMatch(n, stationName))) {
        matched = c.id;
        count++;
      }
    }
    if (count === 1) return matched;
    if (count > 1) stats.ambiguous++;
    return null;
  }

  return {
    stats,
    match(ref, stationName) {
      const key = `${ref} ${stationName}`;
      let hit = memo.get(key);
      if (hit === undefined) {
        hit = resolve(ref, stationName);
        memo.set(key, hit);
      }
      if (hit) stats.hits++;
      else stats.misses++;
      return hit;
    },
  };
}

// ---------------------------------------------------------------------------
// Long-distance: whole-ride itinerary matching
// ---------------------------------------------------------------------------

/**
 * A ride with only one distinct station name proves nothing - every
 * long-distance line calling anywhere near it "covers" it, so the row is
 * unattributable in principle, not just in practice. Two is the minimum that
 * can discriminate at all.
 */
const MIN_RIDE_STATIONS = 2;

export interface LongDistanceIndex {
  /**
   * The line whose station list contains every one of these stops, or `null`
   * when no long-distance line covers all of them, when more than one does,
   * or when there are too few stops to tell.
   */
  match(stationNames: Iterable<string>): string | null;
  /** Diagnostics for the run report; not part of the output file. */
  readonly stats: { attributed: number; ambiguous: number; unmatched: number; tooSmall: number };
}

/**
 * Build the lookup a ride goes through: is there exactly one long-distance
 * line whose stations are a superset of everywhere this ride called?
 *
 * There is no ref to bucket by first (see the header), so every ride is
 * checked against all 110 long-distance lines in `data/line-stations.json` -
 * cheap enough, since the expensive part (does line L serve station S) is
 * memoised per distinct station name, and there are only a few thousand of
 * those in a month, not per ride.
 *
 * The rule is full containment of the *ride's* stops, not overlap count and
 * not overlap of the *line's* stops: a candidate only wins if every station
 * the ride touched is on its list, however much of the candidate's own route
 * that leaves untouched. That is what makes a partial ride attributable (a
 * train terminating early, or a ride assembled from a partial month, still
 * has every one of its real stops explained by its real line) while keeping
 * a wrong candidate from winning just by being large - a giant trunk line
 * happening to contain two or three of a ride's stops does not get credit for
 * the ones it is missing, because it is disqualified the moment it is missing
 * any of them. Overlap *count* alone would not do this: scored by raw count a
 * large line that coincidentally contains most of a small ride's stops can
 * outscore the true, smaller line, because count has no sense of "and nothing
 * left over" the way full containment does.
 *
 * The failure mode this rule accepts, silently, is a single bad day taking
 * down a whole month. A ride pools every calendar day of one scheduled
 * service (see the header) into one station set, so one anomalous day - a
 * reroute, a rail-replacement bus leg standing in for a closed section, a
 * feed glitch that logs the wrong station once - adds a stop the real line
 * does not serve, and full containment then fails for *every* day that ride
 * covers, not just the bad one. The ride is dropped as if the line were
 * never seen at all that month, indistinguishable from a service genuinely
 * missing from `data/line-stations.json` - the same kind of silence
 * `Aggregator.hasRealtime` calls out at Waldshut, where a station with no
 * realtime looks perfect rather than unmeasured. There is no cheap way to
 * tell "one bad day" apart from "this line's OSM route is genuinely
 * incomplete" from the station set alone, so nothing here tries to. What is
 * measurable: of the rides `data-2025-12.parquet` left unmatched (991, see
 * below), 442 (45%) missed full containment by exactly one station and
 * another 369 (37%) by two or three - most "no line covers this ride"
 * verdicts are near misses, not wild ones, which is consistent with (but
 * does not prove) a single contaminating stop rather than a wrong month.
 *
 * Ties are dropped rather than guessed at, the same call `buildIndex` makes
 * for two lines sharing a ref at the same station - and here they are common:
 * long-distance lines share corridors for real (IC 30/31/32 down the Rhine),
 * and 16 of the 110 long-distance entries in `data/line-stations.json` are
 * *exactly* the same three stations (München Hbf, München Ost, Rosenheim) -
 * a clutch of EC services whose OSM route relation stops at the Austrian
 * border, so nothing this month's data can see tells them apart.
 *
 * Measured on two full months (data-2025-12.parquet, data-2026-01.parquet):
 * of the rides with 2+ distinct stations, 18-24% attribute (346/1,910 and
 * 246/1,450), 30-35% tie between two or more lines and are dropped, and the
 * rest touch no long-distance line's stations at all - not necessarily wrong,
 * since the candidate pool is only the 110 lines `data/line-stations.json`
 * carries a station list for, not every long-distance service DB operates.
 * Attribution reaches 24/110 and 18/110 distinct lines in those two months
 * respectively; the rolling 12-month window a real run reads sees more months
 * and more calendar variation, so the true reach is at least that.
 */
export function buildLongDistanceIndex(
  lineStations: Record<string, string[]>,
  modeOf: (lineId: string) => string | undefined,
): LongDistanceIndex {
  const candidates: Candidate[] = [];
  for (const [id, names] of Object.entries(lineStations)) {
    if (modeOf(id) !== LONGDISTANCE_MODE) continue;
    candidates.push({
      id,
      exact: new Set(names.map((n) => normaliseName(n)).filter(Boolean)),
      raw: names,
    });
  }

  const stats = { attributed: 0, ambiguous: 0, unmatched: 0, tooSmall: 0 };

  // Per distinct station name: which candidates serve it. Memoised because
  // the same station name recurs across many rides within a month.
  const servesMemo = new Map<string, boolean[]>();
  function servesVector(stationName: string): boolean[] {
    let hit = servesMemo.get(stationName);
    if (hit) return hit;
    const normalised = normaliseName(stationName);
    hit = candidates.map(
      (c) =>
        (normalised !== '' && c.exact.has(normalised)) ||
        c.raw.some((n) => namesMatch(n, stationName)),
    );
    servesMemo.set(stationName, hit);
    return hit;
  }

  return {
    stats,
    match(stationNames) {
      const stations = [...new Set(stationNames)];
      if (stations.length < MIN_RIDE_STATIONS) {
        stats.tooSmall++;
        return null;
      }

      let winner = -1;
      let winners = 0;
      for (let i = 0; i < candidates.length; i++) {
        if (stations.every((s) => servesVector(s)[i])) {
          winner = i;
          winners++;
        }
      }
      if (winners === 0) {
        stats.unmatched++;
        return null;
      }
      if (winners > 1) {
        stats.ambiguous++;
        return null;
      }
      stats.attributed++;
      return candidates[winner].id;
    },
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Delay buckets, as the lower bound of each. Per-minute to 20 because that is
 * where essentially all the mass is - measured over 1.1 M departures, 80% come
 * in under six minutes and 95% under sixteen - then coarsening through a tail
 * that runs to 291 minutes.
 *
 * A histogram rather than a running sum because departure delay is nothing
 * like a normal distribution and the moments of one describe it badly. The
 * measured shape is zero-inflated (30.4% at *exactly* zero) with a hard floor
 * at zero and a long right tail, so:
 *
 *   - the mean sits at the 70th percentile - it is worse than what 70% of
 *     departures actually experience, and reporting it as "typical" overstates
 *     the ordinary trip while understating the bad one;
 *   - the standard deviation describes symmetric spread that is not there. A
 *     normal curve fitted to the measured mean 3.91 and sd 7.76 would place
 *     31% of departures at a *negative* delay, which cannot happen.
 *
 * Percentiles do not have that problem, and a bucketed histogram yields them
 * (exactly, below 21 minutes) plus the shares the band bar draws, for a few
 * dozen integers per line. The full line-level histogram is published even
 * though the panel currently only draws four bands from it: it costs ~50 KB
 * across the whole file, and the alternative to already having it is another
 * 13-minute pass behind the rate limiter in `politeFetch`.
 */
export const BUCKET_EDGES = [
  ...Array.from({ length: 21 }, (_, i) => i), // 0..20, one bucket per minute
  21,
  31,
  46,
  61,
  91, // 21-30, 31-45, 46-60, 61-90, 91+
];

/** The bucket a whole-minute delay falls in. */
export function bucketOf(delayMin: number): number {
  const min = Math.max(0, Math.floor(delayMin));
  if (min <= 20) return min;
  if (min <= 30) return 21;
  if (min <= 45) return 22;
  if (min <= 60) return 23;
  if (min <= 90) return 24;
  return 25;
}

/**
 * The p-th percentile of a bucketed delay histogram, in whole minutes.
 *
 * Below 21 minutes every bucket is one minute wide, so the answer is exact -
 * which covers the median and, for all but the worst lines, the 90th
 * percentile too. Above that a bucket's departures are assumed spread evenly
 * across the minutes it spans, which is the standard reading of a histogram
 * and errs by at most half a bucket. The open-ended top bucket has no upper
 * edge to interpolate towards, so it reports its own lower bound and the UI
 * renders that as "91+".
 */
export function quantile(hist: readonly number[], p: number): number {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const target = p * total;
  let cum = 0;
  for (let i = 0; i < hist.length; i++) {
    const next = cum + hist[i];
    if (next >= target) {
      const lo = BUCKET_EDGES[i];
      const hi = i + 1 < BUCKET_EDGES.length ? BUCKET_EDGES[i + 1] - 1 : lo;
      if (hi <= lo) return lo;
      return Math.round(lo + ((target - cum) / hist[i]) * (hi - lo));
    }
    cum = next;
  }
  return BUCKET_EDGES[BUCKET_EDGES.length - 1];
}

interface Counters {
  /** Scheduled departures observed, cancellations included. */
  n: number;
  cancelled: number;
  /** Departures that ran, by delay bucket - see BUCKET_EDGES. */
  hist: number[];
}

const zero = (): Counters => ({
  n: 0,
  cancelled: 0,
  hist: new Array<number>(BUCKET_EDGES.length).fill(0),
});

/** What a rider is actually asking: the ordinary trip, and the bad one. */
export interface StationScore {
  onTime: number;
  /** Median delay in whole minutes - the "typical" figure. */
  median: number;
  /** 90th percentile: one departure in ten is at least this late. */
  p90: number;
  /** Scheduled departures observed, cancellations included. */
  n: number;
}
export interface LineScore {
  aggregate: StationScore & { cancelRate: number };
  /** Counts per BUCKET_EDGES bucket, over the departures that ran. */
  hist: number[];
  stations: Record<string, StationScore>;
}
export interface PunctualityFile {
  generated: string;
  source: string;
  attribution: string;
  window: { from: string; to: string; months: number };
  onTimeThresholdMin: number;
  bucketEdges: number[];
  lines: Record<string, LineScore>;
}

/**
 * Running counters per line and per `(line, station)`.
 *
 * Cancellations are counted in `n` but excluded from the delay histogram: a
 * train that never ran has no departure delay, and folding it in as either
 * "late" or "on time" would misreport it either way. So `cancelRate` is over
 * all scheduled departures and everything else is over the ones that actually
 * ran, which is also how DB reports its own.
 */
export class Aggregator {
  private readonly lines = new Map<string, Counters>();
  private readonly stations = new Map<string, Map<string, Counters>>();

  add(lineId: string, station: string, delayMin: number, cancelled: boolean) {
    let line = this.lines.get(lineId);
    if (!line) {
      line = zero();
      this.lines.set(lineId, line);
    }

    let perStation = this.stations.get(lineId);
    if (!perStation) {
      perStation = new Map();
      this.stations.set(lineId, perStation);
    }
    let atStation = perStation.get(station);
    if (!atStation) {
      atStation = zero();
      perStation.set(station, atStation);
    }

    const bucket = cancelled ? -1 : bucketOf(delayMin);
    for (const c of [line, atStation]) {
      c.n++;
      if (cancelled) c.cancelled++;
      else c.hist[bucket]++;
    }
  }

  /**
   * A station seen only a handful of times over a year is a mis-join or a
   * rail-replacement oddity, not a service pattern, and a "0% on time (n=2)"
   * row would be read as a finding. Below this it is dropped from the
   * breakdown; it stays in the line aggregate, where it is one row in
   * thousands and cannot mislead.
   */
  static readonly MIN_STATION_SAMPLES = 100;

  /**
   * And a station must be somewhere the line actually *calls*, not somewhere
   * it has occasionally been sent. The breakdown is read as a ranking, so its
   * top row is the strongest claim the panel makes - and the thinnest samples
   * land there by construction, because a handful of diverted runs are late
   * almost by definition.
   *
   * Measured on the 12-month window, 78 of 730 lines had their worst-ranked
   * station drawn from under a tenth of that line's typical sample: RE 1 (RRX)
   * was "worst at Köln Süd, 23% on time" on **39** departures against 11,014
   * per station elsewhere. That is a true statement about 39 diversions and a
   * false one about the line.
   *
   * A flat floor cannot separate the two, because what counts as thin depends
   * on the line: 300 departures is noise on an S-Bahn and a full year of
   * service on a rural branch. So the floor is relative to the line's *median*
   * station - median, not mean, so a cluster of diversion stops cannot drag
   * the bar down to admit itself. At a tenth, a station served by even one
   * train in ten survives; the measured effect is to drop 4.6% of station
   * rows, empty exactly one line's breakdown, and remove all 78 bad top rows.
   * Raising the flat floor alone to 200 fixes only 33 of them.
   */
  static readonly MIN_STATION_SHARE = 0.1;
  /** Same argument one level up: a line this thinly seen is not reportable. */
  static readonly MIN_LINE_SAMPLES = 200;

  /**
   * A station where *every* departure came in at exactly zero delay is not a
   * perfectly punctual station - it is a station DB publishes no realtime for,
   * so the change time is only ever the planned time echoed back. Observed at
   * Waldshut on the border, where the Swiss S27 and S36 scored 1.00 on-time
   * across 569 departures with no departure ever moving by a minute, while
   * still reporting cancellations.
   *
   * Publishing it would put a fabricated 100% at the top of a breakdown that
   * riders read as a ranking, so it is dropped instead - silence is the honest
   * answer for a station nobody measures. A genuinely punctual line still
   * records the odd late minute (rural RB 60 at Rottenbach) and is kept.
   */
  private static hasRealtime(c: Counters): boolean {
    return c.hist[0] < c.n - c.cancelled;
  }

  private static score(c: Counters): StationScore {
    const ran = c.n - c.cancelled;
    // Every bucket below the six-minute threshold, i.e. buckets 0..5, which
    // are one minute wide each - so this stays exact rather than interpolated.
    let onTime = 0;
    for (let i = 0; i < ON_TIME_THRESHOLD_MIN; i++) onTime += c.hist[i];
    return {
      onTime: round(onTime / ran, 3),
      median: quantile(c.hist, 0.5),
      p90: quantile(c.hist, 0.9),
      n: c.n,
    };
  }

  result(): Record<string, LineScore> {
    const out: Record<string, LineScore> = {};
    for (const [id, line] of [...this.lines].sort(([a], [b]) => a.localeCompare(b))) {
      if (line.n < Aggregator.MIN_LINE_SAMPLES) continue;
      const ran = line.n - line.cancelled;
      if (!ran || !Aggregator.hasRealtime(line)) continue;

      const stations: Record<string, StationScore> = {};
      const perStation = this.stations.get(id)!;
      const reportable = [...perStation.entries()].filter(
        ([, c]) => c.n - c.cancelled > 0 && Aggregator.hasRealtime(c),
      );
      const floor = Math.max(
        Aggregator.MIN_STATION_SAMPLES,
        medianOf(reportable.map(([, c]) => c.n)) * Aggregator.MIN_STATION_SHARE,
      );
      for (const [name, c] of reportable.sort(([a], [b]) => a.localeCompare(b))) {
        if (c.n < floor) continue;
        stations[name] = Aggregator.score(c);
      }

      out[id] = {
        aggregate: { ...Aggregator.score(line), cancelRate: round(line.cancelled / line.n, 4) },
        hist: line.hist,
        stations,
      };
    }
    return out;
  }
}

/** The middle value, or 0 for an empty list. */
function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Departure delay in minutes, or `null` when the row is not a departure at
 * all - the last stop of a run has an arrival and no planned departure.
 *
 * Computed from the two explicit timestamps rather than from the feed's own
 * `delay_in_min`, whose documentation never says whether it means arrival or
 * departure. (Sampled against 2026-07 it does turn out to be the departure
 * delay, differing from the arrival delay on the same row - but "it matched
 * on the day someone checked" is a weaker guarantee than reading the columns
 * that say what they are.) A row with no change time was never re-announced,
 * which is the feed's way of saying it left as planned.
 *
 * Early departures clamp to zero: they are a rounding artefact of a
 * minute-resolution feed, and letting them net off real lateness would pull a
 * line's mean delay towards a punctuality it does not have.
 */
export function departureDelayMin(
  planned: Date | null | undefined,
  changed: Date | null | undefined,
): number | null {
  if (!planned) return null;
  if (!changed) return 0;
  const minutes = (changed.getTime() - planned.getTime()) / 60000;
  if (!Number.isFinite(minutes) || Math.abs(minutes) > MAX_PLAUSIBLE_DELAY_MIN) return null;
  return Math.max(0, minutes);
}

// ---------------------------------------------------------------------------
// Reading the monthly files
// ---------------------------------------------------------------------------

/**
 * A 12-month window is ~8,300 range requests (six column chunks per row group,
 * 115 groups per monthly file), and HuggingFace meters exactly that: an
 * unthrottled first attempt got six months in before every request came back
 * 429 and the whole pass died, twenty minutes of work discarded.
 *
 * It is metered openly, which is what makes this tractable - every response
 * carries the budget and the clock:
 *
 *     ratelimit-policy: "fixed window";"resolvers";q=3000;w=300
 *     ratelimit: "resolvers";r=0;t=52
 *
 * 3,000 requests per 300 seconds, `r` left in this window, `t` seconds until
 * it resets. So rather than discovering the limit by being refused, this reads
 * `r` off every response and parks *all* workers until the window turns over
 * once the allowance runs low - a 12-month pass needs about three windows and
 * spends most of its wall clock waiting for them, which is the honest price of
 * the data and far better than being cut off mid-run.
 *
 * A 429 is still handled (another process on the same IP, a policy change),
 * and there `t` is the only thing worth waiting for: blind exponential backoff
 * capped out at 31 s against a window that had 52 s left to run, which is
 * precisely how the second attempt died.
 *
 * `HF_TOKEN` raises the ceiling - HuggingFace's own advice in the 429 body -
 * and is used when set. Nothing here needs it; it just makes the run shorter.
 */
const MAX_ATTEMPTS = 8;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Requests still in flight when the allowance is read, plus a margin. Stopping
 * with a few left unspent costs nothing; overshooting costs the 429 this
 * exists to avoid.
 */
const RATE_LIMIT_RESERVE = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shared across workers: the wall-clock time before which nobody may fetch. */
let rateGateUntil = 0;

/** Seconds until the current window resets, from a `ratelimit` header. */
function resetIn(res: Response): number | null {
  const header = res.headers.get('ratelimit');
  if (!header) return null;
  const remaining = Number(/[;\s]r=(\d+)/.exec(header)?.[1]);
  const reset = Number(/[;\s]t=(\d+)/.exec(header)?.[1]);
  if (!Number.isFinite(remaining) || !Number.isFinite(reset)) return null;
  return remaining <= RATE_LIMIT_RESERVE ? reset : null;
}

async function politeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = process.env.HF_TOKEN;
  const authed: RequestInit | undefined = token
    ? {
        ...init,
        headers: new Headers({
          ...headersToObject(init?.headers),
          authorization: `Bearer ${token}`,
        }),
      }
    : init;

  let blindWait = 1000;
  for (let attempt = 1; ; attempt++) {
    const hold = rateGateUntil - Date.now();
    if (hold > 0) await sleep(hold);

    let res: Response;
    try {
      res = await fetch(input, authed);
    } catch (err) {
      // A dropped connection is the same situation as a 503 from here.
      if (attempt >= MAX_ATTEMPTS) throw err;
      await sleep(blindWait);
      blindWait *= 2;
      continue;
    }

    const reset = resetIn(res);
    if (reset !== null) {
      // +1 s so the next request lands after the window has actually turned
      // over rather than on the boundary the server rounds the other way.
      rateGateUntil = Math.max(rateGateUntil, Date.now() + (reset + 1) * 1000);
    }
    if (!RETRY_STATUS.has(res.status) || attempt >= MAX_ATTEMPTS) return res;
    if (reset === null) {
      await sleep(blindWait);
      blindWait *= 2;
    }
  }
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

/** Months present upstream, oldest first, as `YYYY-MM`. */
export async function listMonths(fetchImpl: typeof fetch = politeFetch): Promise<string[]> {
  const res = await fetchImpl(TREE_URL);
  if (!res.ok) throw new Error(`HuggingFace listing failed: HTTP ${res.status}`);
  const tree = (await res.json()) as { type: string; path: string }[];
  return tree
    .filter((e) => e.type === 'file')
    .map((e) => /data-(\d{4}-\d{2})\.parquet$/.exec(e.path)?.[1])
    .filter((m): m is string => !!m)
    .sort();
}

interface Row {
  station_name: string | null;
  line_number: string | null;
  train_type: string | null;
  departure_is_canceled: boolean | null;
  departure_planned_time: Date | null;
  departure_change_time: Date | null;
  train_line_ride_id: string | null;
}

/** One buffered long-distance row, held until its ride's line is known. */
interface RideRow {
  station: string;
  delay: number | null;
  cancelled: boolean;
}

/**
 * Read one monthly file into the aggregator, one row group at a time.
 *
 * Row-group at a time is what keeps this in a normal heap: a monthly file is
 * 14 M rows and the whole window is ~170 M, but a group is ~123 k rows and is
 * discarded before the next is fetched. `CONCURRENCY` groups are in flight at
 * once so the next fetch overlaps the current decode - the aggregator itself
 * needs no locking, since `await` only yields between whole groups.
 *
 * Long-distance rows are the exception to "discarded before the next group":
 * a ride's rows are scattered across the whole file (a ride is a month of one
 * scheduled service's calendar days, not a contiguous slice of it - see the
 * header), so which line a ride belongs to cannot be known until every group
 * has been read. Those rows - ~1.85% of the file, see
 * `LONGDISTANCE_TRAIN_TYPES` - are buffered by ride id instead of being
 * dropped per group, and matched once, after the loop below.
 */
async function readMonth(
  month: string,
  index: LineIndex,
  ldIndex: LongDistanceIndex,
  agg: Aggregator,
): Promise<number> {
  // Deliberately modest. The rate limit is on request *count*, not on how many
  // are in flight, so parallelism cannot buy more throughput than the window
  // allows - all it can do is spend the allowance in a burst and arrive at the
  // wall sooner. Two is enough to keep a fetch overlapping the decode.
  const CONCURRENCY = 2;
  const file = await asyncBufferFromUrl({ url: FILE_URL(month), fetch: politeFetch });
  const metadata = await parquetMetadataAsync(file);

  const groups: { start: number; end: number }[] = [];
  let offset = 0;
  for (const rg of metadata.row_groups) {
    const rows = Number(rg.num_rows);
    groups.push({ start: offset, end: offset + rows });
    offset += rows;
  }

  let used = 0;
  const rides = new Map<string, RideRow[]>();
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < groups.length; i = next++) {
      const rows = (await parquetReadObjects({
        file,
        metadata,
        columns: COLUMNS as unknown as string[],
        rowStart: groups[i].start,
        rowEnd: groups[i].end,
      })) as unknown as Row[];

      for (const row of rows) {
        const station = row.station_name;
        if (!station) continue;

        if (row.train_type && LONGDISTANCE_TRAIN_TYPES.has(row.train_type)) {
          const rideId = row.train_line_ride_id;
          if (!rideId) continue; // measured 100% populated for these types; defensive only
          const delay = departureDelayMin(row.departure_planned_time, row.departure_change_time);
          const bucket = rides.get(rideId);
          const entry: RideRow = { station, delay, cancelled: row.departure_is_canceled === true };
          if (bucket) bucket.push(entry);
          else rides.set(rideId, [entry]);
          continue;
        }

        const ref = rowRef(row.line_number, row.train_type);
        if (!ref) continue;
        const delay = departureDelayMin(row.departure_planned_time, row.departure_change_time);
        if (delay === null) continue;
        const lineId = index.match(ref, station);
        if (!lineId) continue;
        agg.add(lineId, station, delay, row.departure_is_canceled === true);
        used++;
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Every group is in by now, so every ride's stops are all accounted for -
  // attribute the whole ride at once, and only then feed its rows in.
  for (const rows of rides.values()) {
    const lineId = ldIndex.match(rows.map((r) => r.station));
    if (!lineId) continue;
    for (const r of rows) {
      if (r.delay === null) continue;
      agg.add(lineId, r.station, r.delay, r.cancelled);
      used++;
    }
  }

  return used;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `PUNCTUALITY_MONTHS` shortens the window for a development run - one month
 * is ~128 MB and a couple of minutes, against ~1.5 GB for the real twelve.
 */
function envMonths(): number {
  const raw = process.env.PUNCTUALITY_MONTHS;
  if (!raw) return DEFAULT_MONTHS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`PUNCTUALITY_MONTHS must be a positive integer, got "${raw}"`);
  }
  return n;
}

function save(file: PunctualityFile) {
  // Write-then-rename, as in stop-ids.ts: an interrupted run must not leave a
  // half-written file where the committed one was.
  const tmp = `${OUT_PATH}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n');
    renameSync(tmp, OUT_PATH);
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
}

async function main() {
  if (!existsSync(LINE_STATIONS_PATH)) {
    throw new Error(`${LINE_STATIONS_PATH} is missing - run \`npm run build:data\` first`);
  }
  const lineStations = JSON.parse(readFileSync(LINE_STATIONS_PATH, 'utf8')) as Record<
    string,
    string[]
  >;
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as {
    lines: { id: string; ref: string; mode: string }[];
  };
  const byId = new Map(registry.lines.map((l) => [l.id, l]));
  const index = buildIndex(
    lineStations,
    (id) => byId.get(id)?.mode,
    (id) => byId.get(id)?.ref,
  );
  const ldIndex = buildLongDistanceIndex(lineStations, (id) => byId.get(id)?.mode);

  const months = (await listMonths()).slice(-envMonths());
  if (!months.length) throw new Error('no monthly files found upstream');
  console.log(`==> window: ${months[0]} .. ${months[months.length - 1]} (${months.length} months)`);

  const agg = new Aggregator();
  for (const month of months) {
    const started = Date.now();
    const used = await readMonth(month, index, ldIndex, agg);
    console.log(
      `==> ${month}: ${used} departures matched in ${((Date.now() - started) / 1000).toFixed(0)}s`,
    );
  }

  const s = index.stats;
  const total = s.hits + s.misses;
  console.log(
    `==> join: ${s.hits}/${total} rows attributed (${Math.round((100 * s.hits) / (total || 1))}%), ` +
      `${s.ambiguous} distinct (ref, station) pairs left ambiguous`,
  );

  const ld = ldIndex.stats;
  const ldTotal = ld.attributed + ld.ambiguous + ld.unmatched + ld.tooSmall;
  console.log(
    `==> long-distance: ${ld.attributed}/${ldTotal} rides attributed, ` +
      `${ld.ambiguous} tied between lines, ${ld.unmatched} matched no line, ${ld.tooSmall} too small to tell`,
  );

  const lines = agg.result();
  save({
    generated: new Date().toISOString().slice(0, 10),
    source: `https://huggingface.co/datasets/${REPO}`,
    attribution: 'Delay data: Deutsche Bahn, via piebro/deutsche-bahn-data (CC BY 4.0)',
    window: { from: months[0], to: months[months.length - 1], months: months.length },
    onTimeThresholdMin: ON_TIME_THRESHOLD_MIN,
    bucketEdges: BUCKET_EDGES,
    lines,
  });

  const scored = Object.keys(lines).length;
  const scoreable = registry.lines.filter(
    (l) => SCORED_MODES.has(l.mode) || l.mode === LONGDISTANCE_MODE,
  ).length;
  console.log(
    `==> ${scored}/${scoreable} regional, suburban and long-distance lines scored -> ${OUT_PATH}`,
  );
}

// Only when run directly; importing this from a test must not start a 1.5 GB
// download.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

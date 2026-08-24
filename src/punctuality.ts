/**
 * The seam through which the app reads punctuality scores, the same way
 * live.ts is the seam for live departures.
 *
 * Unlike departures, this is not live: the scores are a static file built by
 * pipeline/punctuality.ts from Deutsche Bahn's published delay record and
 * shipped next to lines.json. It is fetched lazily - on the first line
 * selection rather than at startup - because a rider who only ever pans the
 * map should not pay ~1 MB for a panel they never open, and it is fetched
 * once, because the file does not change under a running tab.
 *
 * A missing or unreadable file is not an error the rider needs to hear about:
 * the map is a map with or without punctuality, so a failed load reads as "no
 * scores" and the panel omits the section. That also keeps a checkout with no
 * committed data/punctuality.json from throwing on selection.
 */

export interface StationScore {
  /** Share of departures that ran less than `onTimeThresholdMin` late, 0..1. */
  onTime: number;
  /** Median delay in whole minutes - what an ordinary trip looks like. */
  median: number;
  /** 90th percentile: one departure in ten is at least this late. */
  p90: number;
  /** Scheduled departures observed, cancellations included. */
  n: number;
}

export interface LineScore {
  aggregate: StationScore & { cancelRate: number };
  /** Counts per `bucketEdges` bucket, over the departures that ran. */
  hist: number[];
  stations: Record<string, StationScore>;
}

export interface PunctualityFile {
  generated: string;
  source: string;
  attribution: string;
  window: { from: string; to: string; months: number };
  onTimeThresholdMin: number;
  /** Lower bound of each histogram bucket; the last one is open-ended. */
  bucketEdges: number[];
  lines: Record<string, LineScore>;
}

let pending: Promise<PunctualityFile | null> | null = null;

/**
 * Load the score file, once per page. Concurrent callers share the one
 * request; a failed load is remembered as "no scores" rather than retried on
 * every selection, since the file is static and a 404 will still be a 404.
 */
export function loadPunctuality(base: string): Promise<PunctualityFile | null> {
  pending ??= fetch(`${base}punctuality.json`)
    .then((r) => (r.ok ? (r.json() as Promise<PunctualityFile>) : null))
    .catch(() => null);
  return pending;
}

/** A line's stations, worst first - the order the breakdown is read in. */
export function worstFirst(score: LineScore): [string, StationScore][] {
  return Object.entries(score.stations).sort(
    ([an, a], [bn, b]) => a.onTime - b.onTime || b.n - a.n || an.localeCompare(bn, 'de'),
  );
}

export interface Band {
  key: 'punctual' | 'slight' | 'late' | 'severe' | 'cancelled';
  /** Share of all scheduled departures, 0..1. */
  share: number;
}

/**
 * The bands the summary bar draws, over *all* scheduled departures including
 * the cancelled ones - so the segments sum to the whole timetable and the bar
 * cannot quietly omit the trains that never ran.
 *
 * The split is chosen so the picture stays honest at a glance. `punctual` and
 * `slight` together are exactly the published on-time share (both sit under
 * the six-minute threshold), so the bar agrees with the headline percentage
 * rather than offering a second, subtly different one. Separating them is what
 * shows the shape the headline hides: 30% of departures nationally leave at
 * *exactly* zero delay, and a line whose punctuality is all "five minutes
 * late" is a different experience from one that is genuinely on the minute.
 */
export function bands(score: LineScore, edges: number[], threshold: number): Band[] {
  const scheduled = score.aggregate.n;
  if (!scheduled) return [];
  const sum = (from: number, to: number) =>
    score.hist.filter((_, i) => edges[i] >= from && edges[i] < to).reduce((a, b) => a + b, 0);
  const cancelled = Math.round(score.aggregate.cancelRate * scheduled);
  const all: Band[] = [
    { key: 'punctual', share: sum(0, 1) / scheduled },
    { key: 'slight', share: sum(1, threshold) / scheduled },
    { key: 'late', share: sum(threshold, 16) / scheduled },
    { key: 'severe', share: sum(16, Infinity) / scheduled },
    { key: 'cancelled', share: cancelled / scheduled },
  ];
  return all.filter((b) => b.share > 0);
}

/**
 * A percentile for display. The histogram's top bucket is open-ended, so a
 * value sitting on its floor means "at least this, and we cannot say how much
 * more" - which has to read as `91+`, not as a precise 91.
 */
export function formatMinutes(value: number, edges: number[]): string {
  return value >= edges[edges.length - 1] ? `${value}+` : String(value);
}

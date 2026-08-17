/**
 * The one seam through which the app talks to a live-data backend. Nothing
 * else in src/ is allowed to call Transitous (or any other live source)
 * directly - see docs/live-data.md §6 for the reasoning: the project ships as
 * static files with no server of its own, but if Transitous ever needs a
 * proper `User-Agent` (a header a browser cannot set) or request volume grows
 * past what an unkeyed public instance should carry, the fix is a small
 * caching edge-function proxy. Routing every call through `request()` below
 * means that day's fix is a one-line change to BASE_URL here, not a hunt
 * through the UI for scattered `fetch()` calls.
 *
 * The same shape is meant to carry a future `trips` fetcher (moving-train
 * positions, see docs/live-data.md §2): another thin function that calls
 * `request()` with its own path/params and response type, sitting next to
 * `fetchDepartures` below.
 */

const BASE_URL = 'https://api.transitous.org/api/v1';

/** Rail-borne mode filter for the request: heavy rail, light rail, tram, and
 *  subway. Mandatory: an unfiltered query against a Hauptbahnhof returns
 *  mostly buses departing the forecourt ZOB, which is wrong for a rail map. */
const RAIL_REQUEST_MODES =
  'HIGHSPEED_RAIL,LONG_DISTANCE,REGIONAL_RAIL,SUBURBAN,TRAM,SUBWAY';

/**
 * Response `mode` values accepted. The request and response mode
 * vocabularies do not line up - asking for SUBURBAN yields entries whose
 * response `mode` reads METRO - so entries are matched against this set,
 * never by equality with the mode that was requested.
 */
const RAIL_RESPONSE_MODES = new Set([
  'HIGHSPEED_RAIL', 'LONG_DISTANCE', 'REGIONAL_RAIL', 'SUBURBAN', 'METRO',
  'TRAM', 'SUBWAY',
]);

/**
 * A live-data call that failed in an expected way: a bad HTTP status, a
 * network hiccup, a body that didn't parse. The UI treats every one of these
 * the same - a quiet "unavailable" note, no console noise - because a public
 * API timing out or erroring is normal operation, not a bug in this app. An
 * `AbortError` (our own cancellation) is left unwrapped so callers can still
 * tell "we gave up on this one" apart from "the request failed". Anything
 * that throws something other than `LiveDataError`/`AbortError` is, by
 * construction, not one of the above - it's a real defect and callers should
 * let it be loud.
 */
export class LiveDataError extends Error {}

async function request<T>(
  path: string, params: Record<string, string>, signal: AbortSignal,
): Promise<T> {
  const url = `${BASE_URL}${path}?${new URLSearchParams(params)}`;

  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new LiveDataError(`${path} request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new LiveDataError(`${path} responded ${res.status}`);

  try {
    return (await res.json()) as T;
  } catch {
    throw new LiveDataError(`${path} returned a body that did not parse as JSON`);
  }
}

// --- /stoptimes -------------------------------------------------------------
// Raw shapes are kept private and narrow (only the fields this app reads);
// `trips[]` is deliberately not modelled here - it comes back empty on this
// endpoint, the badge is read from `routeShortName` on the entry itself.

interface RawPlace {
  scheduledDeparture?: string;
  departure?: string;
  scheduledTrack?: string;
  track?: string;
  tz?: string;
}

interface RawStopTime {
  routeShortName?: string;
  headsign?: string;
  mode?: string;
  realTime?: boolean;
  cancelled?: boolean;
  tripCancelled?: boolean;
  place?: RawPlace;
}

interface RawStopTimesResponse {
  stopTimes?: RawStopTime[];
}

export interface Departure {
  line: string;
  headsign: string;
  /** Cancelled at either the stop-time or the whole-trip level - both read as cancelled. */
  cancelled: boolean;
  realTime: boolean;
  scheduled: Date | null;
  /** Real-time estimate, or the scheduled time again when there is no live estimate. */
  actual: Date | null;
  /** `actual - scheduled` in whole minutes, or null when either side is missing. */
  delayMinutes: number | null;
  track: string | null;
  /** IANA zone for rendering `scheduled`/`actual` in the station's own local time. */
  tz: string | null;
}

function toDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDeparture(raw: RawStopTime): Departure {
  const place = raw.place ?? {};
  const scheduled = toDate(place.scheduledDeparture);
  const actual = toDate(place.departure) ?? scheduled;
  const delayMinutes = scheduled && actual
    ? Math.round((actual.getTime() - scheduled.getTime()) / 60000)
    : null;

  return {
    line: raw.routeShortName ?? '',
    headsign: raw.headsign ?? '',
    cancelled: !!(raw.cancelled || raw.tripCancelled),
    realTime: !!raw.realTime,
    scheduled,
    actual,
    delayMinutes,
    track: place.track ?? place.scheduledTrack ?? null,
    tz: place.tz ?? null,
  };
}

/** Next `n` rail departures at `stopId`, soonest first as the API returns them. */
export async function fetchDepartures(
  stopId: string, signal: AbortSignal, n = 6,
): Promise<Departure[]> {
  const data = await request<RawStopTimesResponse>('/stoptimes', {
    stopId, n: String(n), mode: RAIL_REQUEST_MODES,
  }, signal);

  // An entry with no `mode` at all is dropped rather than kept: the whole
  // point of matching against a response-side set instead of the requested
  // value is distrust of this field's shape, so an entry we can't classify
  // does not get the benefit of the doubt on a rail map.
  return (data.stopTimes ?? [])
    .filter((e): e is RawStopTime & { mode: string } => !!e.mode && RAIL_RESPONSE_MODES.has(e.mode))
    .map(toDeparture);
}

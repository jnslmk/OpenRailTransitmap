/**
 * The journey planner's half of the live-data seam (`live.ts`, and
 * docs/live-data.md §6 for why there is a seam at all). Every call goes through
 * `request()` over there, so a caching proxy is still a one-line change.
 *
 * ## What this models
 *
 * MOTIS returns a great deal per itinerary - measured, 140 KB for three - and
 * most of it is of no interest to a map. The types below are the subset the UI
 * actually draws, converted once here so that nothing downstream has to know
 * that times arrive as ISO strings, that geometry arrives as a precision-7
 * encoded polyline, or that the mode vocabulary of the request does not match
 * the mode vocabulary of the response.
 *
 * ## Two things the API says that are not quite true
 *
 * **`bikesAllowed: false` means "the feed did not say".** MOTIS reports the
 * GTFS `bikes_allowed` value, and where the field is absent - which is most of
 * Germany, measured in docs/spike-transitous.md - it reports `false` rather
 * than nothing. So `false` and "no bikes" are indistinguishable, and this module
 * deliberately narrows the type to `true | null`: a promise where the feed makes
 * one, and silence otherwise. Rendering `false` as "no bikes" would be inventing
 * a refusal the operator never published.
 *
 * **`routeShortName` is not a badge.** It comes back as `RE8 (14045)` - the line
 * and the trip number together - so the trailing number is stripped for display
 * and kept nowhere, since the map has no use for a trip id.
 *
 * ## Load
 *
 * Transitous names routing as resource-intensive and asks to be contacted before
 * heavy use. Two things here honour that: nothing calls `plan()` except a
 * deliberate act by the user (never a pan, never a keystroke), and identical
 * queries are answered from `planCache` rather than re-asked. Debouncing the
 * geocoder is the UI's job, because only the UI knows what a keystroke is.
 */

import { request, LiveDataError } from './live.ts';
import { normaliseColour } from '../shared/lnvg.ts';

export { LiveDataError };

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * The transit modes the planner offers, in the request vocabulary.
 *
 * Not the same set as the map's `Mode`: MOTIS splits long-distance rail into
 * high-speed and the rest, and has no notion of the operator families this map
 * draws. `MODE_GROUPS` below is the mapping between the two, which is what lets
 * the planner start from whatever the map is currently showing.
 */
export type TransitMode =
  | 'HIGHSPEED_RAIL'
  | 'LONG_DISTANCE'
  | 'REGIONAL_RAIL'
  | 'SUBURBAN'
  | 'SUBWAY'
  | 'TRAM'
  | 'BUS'
  | 'COACH'
  | 'FERRY';

/** The chips the Plan panel offers, in the order it offers them. */
export const MODE_GROUPS: { key: string; label: string; modes: TransitMode[] }[] = [
  { key: 'rail', label: 'Rail', modes: ['HIGHSPEED_RAIL', 'LONG_DISTANCE', 'REGIONAL_RAIL'] },
  { key: 'urban', label: 'S/U/Tram', modes: ['SUBURBAN', 'SUBWAY', 'TRAM'] },
  { key: 'bus', label: 'Bus', modes: ['BUS'] },
  { key: 'coach', label: 'Coach', modes: ['COACH'] },
  { key: 'ferry', label: 'Ferry', modes: ['FERRY'] },
];

export const ALL_TRANSIT_MODES: TransitMode[] = MODE_GROUPS.flatMap((g) => g.modes);

/**
 * Response-side modes that count as a transit leg. The request and response
 * vocabularies do not line up - asking for `SUBURBAN` yields legs whose mode
 * reads `METRO` - so this is matched as a set, never by equality with what was
 * requested. Same trap `live.ts` documents for `/stoptimes`.
 */
const TRANSIT_RESPONSE_MODES = new Set([
  'HIGHSPEED_RAIL',
  'LONG_DISTANCE',
  'NIGHT_RAIL',
  'REGIONAL_FAST_RAIL',
  'REGIONAL_RAIL',
  'SUBURBAN',
  'METRO',
  'SUBWAY',
  'TRAM',
  'BUS',
  'COACH',
  'FERRY',
  'AIRPLANE',
  'RAIL',
  'TRANSIT',
]);

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export interface Place {
  name: string;
  lat: number;
  lon: number;
  /** MOTIS stop id where the place is a stop; null for an address or a POI. */
  stopId: string | null;
  /** The town it is in, for the second line of a suggestion. */
  area: string;
  kind: 'STOP' | 'PLACE' | 'ADDRESS';
}

/** `lat,lon` is accepted anywhere a stop id is, which is how a map pin becomes a place. */
export function placeParam(p: Place): string {
  return p.stopId ?? `${p.lat},${p.lon}`;
}

export function placeFromLonLat(lon: number, lat: number, name: string): Place {
  return { name, lat, lon, stopId: null, area: '', kind: 'PLACE' };
}

interface RawArea {
  name?: string;
  adminLevel?: number;
  default?: boolean;
}

interface RawGeocode {
  type?: string;
  name?: string;
  id?: string;
  lat?: number;
  lon?: number;
  areas?: RawArea[];
}

/**
 * The town, for the suggestion's second line. MOTIS marks one area `default`,
 * which is the one a person would name; failing that the admin level closest to
 * a municipality wins, because "Deutschland" is not a useful disambiguator.
 */
function areaName(areas: RawArea[] | undefined): string {
  if (!areas?.length) return '';
  const preferred = areas.find((a) => a.default) ?? areas.find((a) => a.adminLevel === 8);
  return (preferred ?? areas[areas.length - 1]).name ?? '';
}

function toPlace(raw: RawGeocode): Place | null {
  if (typeof raw.lat !== 'number' || typeof raw.lon !== 'number' || !raw.name) return null;
  const kind = raw.type === 'STOP' ? 'STOP' : raw.type === 'ADDRESS' ? 'ADDRESS' : 'PLACE';
  return {
    name: raw.name,
    lat: raw.lat,
    lon: raw.lon,
    // Only a STOP carries an id the router can be given directly; a PLACE's id
    // is an OSM reference (`node/[123]`), which MOTIS will not accept back.
    stopId: kind === 'STOP' && raw.id ? raw.id : null,
    area: areaName(raw.areas),
    kind,
  };
}

export async function geocode(text: string, signal: AbortSignal, limit = 8): Promise<Place[]> {
  if (!text.trim()) return [];
  const raw = await request<RawGeocode[]>('/geocode', { text, language: 'de' }, signal);
  return (Array.isArray(raw) ? raw : [])
    .map(toPlace)
    .filter((p): p is Place => !!p)
    .slice(0, limit);
}

export async function reverseGeocode(
  lon: number,
  lat: number,
  signal: AbortSignal,
): Promise<Place | null> {
  const raw = await request<RawGeocode[]>('/reverse-geocode', { place: `${lat},${lon}` }, signal);
  const list = (Array.isArray(raw) ? raw : []).map(toPlace).filter((p): p is Place => !!p);
  // Stops first: a shop in the station outranked the station itself in the
  // probe recorded in docs/live-data.md, and a planner wants the station.
  return list.find((p) => p.kind === 'STOP') ?? list[0] ?? null;
}

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

export interface BikeProfile {
  /**
   * How long the rider will cycle at each end, in seconds. Zero means walk:
   * the bike controls disappear from the request entirely rather than asking
   * for a zero-length bike leg.
   */
  maxRideSeconds: number;
  /**
   * Require every transit leg to accept a bike. Off by default and it must stay
   * that way - measured in docs/spike-transitous.md, turning it on returns zero
   * itineraries for Hannover-Bremen and München-Stuttgart, because the feeds do
   * not populate `bikes_allowed` and MOTIS reads absent as forbidden.
   */
  carriage: boolean;
}

export const NO_BIKE: BikeProfile = { maxRideSeconds: 0, carriage: false };

export interface PlanQuery {
  from: Place;
  to: Place;
  time: Date;
  arriveBy: boolean;
  modes: Set<TransitMode>;
  bike: BikeProfile;
  /** From a previous result, for Earlier / Later. */
  pageCursor?: string;
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

export interface LegPlace {
  name: string;
  stopId: string | null;
  lon: number;
  lat: number;
  scheduled: Date | null;
  actual: Date | null;
  track: string | null;
  /**
   * IANA zone of this stop. Kept per place rather than per journey because a
   * coach to Prague crosses one: a departure board reads in local time, and
   * showing 14:20 for a train that leaves at 15:20 where it leaves from would
   * be a worse error than any this planner can otherwise make.
   */
  tz: string | null;
}

export interface Leg {
  /** The response's own mode string, e.g. `BIKE`, `WALK`, `REGIONAL_RAIL`. */
  mode: string;
  /** Whether this is a public transport leg rather than a street leg. */
  transit: boolean;
  /** The badge - `RE8`, `765`, `FlixBus 170` - or '' on a street leg. */
  line: string;
  headsign: string;
  operator: string;
  /** The feed's own colour, or null. The UI prefers the map's own. */
  colour: string | null;
  from: LegPlace;
  to: LegPlace;
  seconds: number;
  metres: number | null;
  realTime: boolean;
  cancelled: boolean;
  /**
   * `true` when the feed says bikes are carried, `null` when it says nothing.
   * Never `false` - see the module note: MOTIS cannot tell those two apart, so
   * neither can this.
   */
  bikesAllowed: true | null;
  /** The service must be booked ahead - every coach, and rural Rufbus. */
  reservationRequired: boolean;
  /** How many stops it calls at in between, for the "11 stops" fold. */
  intermediateStops: number;
  /** The operator's page for this service, where the feed gives one. */
  url: string;
  /** Decoded `[lon, lat]`, ready for GeoJSON. */
  path: [number, number][];
}

export interface Itinerary {
  id: string;
  start: Date;
  end: Date;
  seconds: number;
  transfers: number;
  legs: Leg[];
  /** Seconds in the saddle across the whole journey - the headline for this map. */
  bikeSeconds: number;
  /** True when there is no transit at all: cycled or walked the whole way. */
  direct: boolean;
}

export interface PlanResult {
  itineraries: Itinerary[];
  earlierCursor: string | null;
  laterCursor: string | null;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Encoded-polyline decoder. MOTIS reports the precision per geometry (7 on
 * every leg measured, against Google's original 5), so it is read from the
 * response rather than assumed.
 */
export function decodePolyline(encoded: string, precision = 7): [number, number][] {
  const factor = 10 ** precision;
  const out: [number, number][] = [];
  let lat = 0;
  let lon = 0;
  let i = 0;

  while (i < encoded.length) {
    let value: number;
    for (let k = 0; k < 2; k++) {
      let shift = 0;
      let result = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && i < encoded.length);
      value = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += value;
      else lon += value;
    }
    out.push([lon / factor, lat / factor]);
  }
  return out;
}

interface RawGeometry {
  points?: string;
  precision?: number;
}

interface RawLegPlace {
  name?: string;
  stopId?: string;
  lat?: number;
  lon?: number;
  scheduledDeparture?: string;
  departure?: string;
  scheduledArrival?: string;
  arrival?: string;
  track?: string;
  scheduledTrack?: string;
  tz?: string;
}

interface RawLeg {
  mode?: string;
  routeShortName?: string;
  displayName?: string;
  headsign?: string;
  agencyName?: string;
  routeColor?: string;
  routeUrl?: string;
  from?: RawLegPlace;
  to?: RawLegPlace;
  duration?: number;
  distance?: number;
  realTime?: boolean;
  cancelled?: boolean;
  bikesAllowed?: boolean;
  reservation?: string;
  intermediateStops?: unknown[];
  legGeometry?: RawGeometry;
}

interface RawItinerary {
  duration?: number;
  startTime?: string;
  endTime?: string;
  transfers?: number;
  legs?: RawLeg[];
}

interface RawPlanResponse {
  itineraries?: RawItinerary[];
  direct?: RawItinerary[];
  previousPageCursor?: string;
  nextPageCursor?: string;
}

function toDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toLegPlace(raw: RawLegPlace | undefined, side: 'from' | 'to'): LegPlace {
  const r = raw ?? {};
  const scheduled = toDate(side === 'from' ? r.scheduledDeparture : r.scheduledArrival);
  return {
    name: r.name ?? '',
    stopId: r.stopId ?? null,
    lon: r.lon ?? 0,
    lat: r.lat ?? 0,
    scheduled,
    actual: toDate(side === 'from' ? r.departure : r.arrival) ?? scheduled,
    track: r.track ?? r.scheduledTrack ?? null,
    tz: r.tz ?? null,
  };
}

/** `RE8 (14045)` is a line and a trip number; only the line belongs on a badge. */
export function badgeOf(routeShortName: string): string {
  return routeShortName.replace(/\s*\(\d+\)\s*$/, '').trim();
}

function toLeg(raw: RawLeg): Leg {
  const mode = raw.mode ?? '';
  const geometry = raw.legGeometry;
  return {
    mode,
    transit: TRANSIT_RESPONSE_MODES.has(mode),
    line: badgeOf(raw.routeShortName ?? raw.displayName ?? ''),
    headsign: raw.headsign ?? '',
    operator: raw.agencyName ?? '',
    colour: normaliseColour(raw.routeColor ? `#${raw.routeColor.replace(/^#/, '')}` : undefined),
    from: toLegPlace(raw.from, 'from'),
    to: toLegPlace(raw.to, 'to'),
    seconds: raw.duration ?? 0,
    metres: typeof raw.distance === 'number' ? raw.distance : null,
    realTime: !!raw.realTime,
    cancelled: !!raw.cancelled,
    // Narrowed to `true | null` on purpose - see the module note.
    bikesAllowed: raw.bikesAllowed === true ? true : null,
    reservationRequired: raw.reservation === 'COMPULSORY',
    intermediateStops: raw.intermediateStops?.length ?? 0,
    url: raw.routeUrl ?? '',
    path: geometry?.points ? decodePolyline(geometry.points, geometry.precision ?? 7) : [],
  };
}

const BIKE_MODES = new Set(['BIKE', 'RENTAL', 'BIKE_RENTAL']);

function toItinerary(raw: RawItinerary, index: number): Itinerary | null {
  const start = toDate(raw.startTime);
  const end = toDate(raw.endTime);
  if (!start || !end) return null;

  const legs = (raw.legs ?? []).map(toLeg);
  const bikeSeconds = legs.filter((l) => BIKE_MODES.has(l.mode)).reduce((n, l) => n + l.seconds, 0);

  return {
    // Stable within one result set, which is all the UI needs it for: it keys
    // the selected itinerary and the URL, and both are re-read on every plan.
    id: `${start.getTime()}-${end.getTime()}-${index}`,
    start,
    end,
    seconds: raw.duration ?? Math.round((end.getTime() - start.getTime()) / 1000),
    transfers: raw.transfers ?? 0,
    legs,
    bikeSeconds,
    direct: !legs.some((l) => l.transit),
  };
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

function planParams(q: PlanQuery): Record<string, string> {
  const params: Record<string, string> = {
    fromPlace: placeParam(q.from),
    toPlace: placeParam(q.to),
    time: q.time.toISOString(),
    arriveBy: String(q.arriveBy),
    numItineraries: '5',
    transitModes: [...q.modes].join(','),
  };

  if (q.bike.maxRideSeconds > 0) {
    params.preTransitModes = 'BIKE';
    params.postTransitModes = 'BIKE';
    params.maxPreTransitTime = String(q.bike.maxRideSeconds);
    params.maxPostTransitTime = String(q.bike.maxRideSeconds);
    // Cycling the whole way is a real answer to "how do I get there", and
    // without this MOTIS only offers to walk it.
    params.directModes = 'BIKE,WALK';
    if (q.bike.carriage) params.requireBikeTransport = 'true';
  }

  if (q.pageCursor) params.pageCursor = q.pageCursor;
  return params;
}

/**
 * Identical queries are answered from here rather than re-asked, which is what
 * makes dragging the bike slider back over a value free. Capped because a
 * session can generate a lot of these and each is a couple of hundred KB of
 * decoded geometry; oldest out first, which for a planner is also least likely
 * to be wanted again.
 */
const planCache = new Map<string, PlanResult>();
const PLAN_CACHE_MAX = 24;

function cacheKey(q: PlanQuery): string {
  return JSON.stringify([
    placeParam(q.from),
    placeParam(q.to),
    // To the quarter hour: "leave now" moves every second, and re-planning
    // because a clock ticked is exactly the load Transitous asked us not to add.
    Math.floor(q.time.getTime() / 900_000),
    q.arriveBy,
    [...q.modes].sort(),
    q.bike.maxRideSeconds,
    q.bike.carriage,
    q.pageCursor ?? '',
  ]);
}

export async function plan(q: PlanQuery, signal: AbortSignal): Promise<PlanResult> {
  const key = cacheKey(q);
  const hit = planCache.get(key);
  if (hit) return hit;

  const data = await request<RawPlanResponse>('/plan', planParams(q), signal);

  const itineraries = (data.itineraries ?? []).map(toItinerary).filter((i): i is Itinerary => !!i);

  // MOTIS returns the cycle-the-whole-way options in a separate array. They are
  // real answers to "how do I get there" and belong in the same list - but at
  // the end of it, not sorted in by departure time. A direct ride has no
  // timetable to be early or late for, so it always "leaves now" and would
  // otherwise sit above every train regardless of how much slower it is.
  const direct = (data.direct ?? [])
    .map((raw, i) => toItinerary(raw, itineraries.length + i))
    .filter((i): i is Itinerary => !!i);

  const result: PlanResult = {
    itineraries: [...itineraries, ...direct].sort(
      (a, b) => Number(a.direct) - Number(b.direct) || a.start.getTime() - b.start.getTime(),
    ),
    earlierCursor: data.previousPageCursor ?? null,
    laterCursor: data.nextPageCursor ?? null,
  };

  planCache.set(key, result);
  if (planCache.size > PLAN_CACHE_MAX) {
    planCache.delete(planCache.keys().next().value!);
  }
  return result;
}

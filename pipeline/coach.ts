/**
 * Long-distance coach (Fernbus) lines, from the operators' own GTFS.
 *
 * ## Why not OSM
 *
 * Everything else this map draws comes out of the Geofabrik extract. Coach
 * cannot: measured over Germany, `route=coach` is **2 relations nationally**
 * (against 218 trolleybus and 16,462 bus in Niedersachsen alone). The Fernbus
 * network is simply not mapped in OSM, and no amount of pipeline work will
 * conjure it out of an extract that does not contain it. See
 * docs/buses-and-routing.md §1.2.
 *
 * ## Why not MOTIS
 *
 * The first candidate was Transitous' `/api/v1/map/trips`, which does return
 * road-routed coach polylines - measured, 588 COACH segments in one national
 * z6 call. Three things ruled it out:
 *
 *   - it is a *live* endpoint, so coverage is whatever happens to be running in
 *     the requested window (measured: 285 distinct routes in 10 minutes, 312 in
 *     60), and full coverage means several multi-megabyte calls per build;
 *   - Transitous names routing and map endpoints as the resource-intensive ones
 *     and asks to be contacted before heavy use - a nightly national sweep is
 *     exactly that, for data that does not change nightly;
 *   - it carries no route long name, no operator and no colour, and the
 *     national bbox drags in foreign domestic feeds (`cz-JDF-merged`,
 *     `lt-kautra`) that have to be filtered back out by feed prefix.
 *
 * The operator's own GTFS has none of those problems. It ships `shapes.txt` -
 * 2.8 M points over 3,586 shapes, median 618 points per shape, so the geometry
 * is the operator's real road alignment rather than a reconstruction - plus
 * route names, colours and the full network at once, in a single cached
 * download that costs Transitous nothing.
 *
 * ## Licensing
 *
 * FlixBus publishes this feed openly but attaches no licence to it, and
 * Transitous - which records `ODbL-1.0` for BlaBlaCar, `CC0-1.0` for Optima and
 * `ODbL-1.0` for European Sleeper - records none for FlixBus either. That is the
 * same footing as DB InfraGO's possession register, so it gets the same
 * treatment this repository already established for that source: the feed is
 * **never committed**, only the rendering derived from it ships, and the
 * publisher is credited in the sidebar and in the map's attribution control
 * whenever a coach line is on screen. See docs/closures.md for the precedent.
 *
 * ## What this module does not do
 *
 * Corridor bundling. The rail pipeline bundles for free because routes sharing
 * a corridor are built from the same OSM way ids; GTFS shapes are independent
 * polylines with no shared identity, so twenty lines down the A9 stack rather
 * than fanning into bands. It costs less than it sounds: every coach line in
 * the feed carries the same brand colour, so a stack reads as one green trunk,
 * which is what it is. Proper geometric bundling is docs/buses-and-routing.md
 * §5.2 and its own problem.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import type { Coord } from './lib/track.ts';

const WORK = process.env.WORK_DIR ?? '.work';
const OUT = `${WORK}/build`;
const CACHE = `${WORK}/coach`;

/** The map's copy, written into the build directory rather than committed. */
export const SNAPSHOT_PATH = `${OUT}/coach.json`;

/**
 * Where the feeds come from.
 *
 * `agencies` is an allowlist within the feed, because FlixMobility publishes
 * FlixBus and FlixTrain in one file and FlixTrain is *rail* - it is already on
 * this map as `longdistance`, out of OSM, under its FLX refs. Letting it
 * through here would draw every FlixTrain line twice.
 */
export interface CoachSource {
  /** Cache filename and the network name lines get. */
  name: string;
  url: string;
  /** GTFS `agency_id` values to keep. Everything else in the feed is dropped. */
  agencies: string[];
  /** Stripped off the front of `route_short_name` to leave a usable badge. */
  refPrefix: string;
  operator: string;
  /**
   * What Transitous calls this feed. MOTIS namespaces every stop id with it, so
   * `<motisPrefix>_<gtfs stop_id>` is the id the departure board wants - checked
   * against `/api/v1/stoptimes`, which returns Munich ZOB for
   * `eu-flixbus_dcbabbfa-9603-11e6-9066-549f350fcb0c`. That is the whole reason
   * coach stops need none of `stop-ids.ts`: their ids are already the right ones.
   */
  motisPrefix: string;
}

export const COACH_SOURCES: CoachSource[] = [
  {
    name: 'flixbus',
    url: 'https://gtfs.gis.flix.tech/gtfs_generic_eu.zip',
    agencies: ['FLIXBUS-eu'],
    refPrefix: 'FlixBus ',
    operator: 'FlixBus',
    motisPrefix: 'eu-flixbus',
  },
];

/** A feed that could not be read. Never fatal - see `loadCoachNetwork`. */
export class CoachFeedError extends Error {}

// ---------------------------------------------------------------------------
// Reading a zip without a dependency
// ---------------------------------------------------------------------------

/**
 * Minimal ZIP reader: central directory, then raw inflate of the members we
 * name. GTFS is a flat zip of deflated text files, which is the easy case, and
 * pulling in a zip library for it would be the only runtime dependency in the
 * pipeline. Same reasoning as `coastline.ts` reprojecting in pure JS rather
 * than adding GDAL to CI for one job.
 *
 * ZIP64 is not handled and does not need to be: the archive is 32 MB packed,
 * 188 MB unpacked, both comfortably under the 4 GB point at which a zip is
 * required to switch. If that ever changes the guard below says so plainly
 * rather than silently reading a truncated offset.
 */
export function readZipMembers(zip: Buffer, wanted: string[]): Map<string, Buffer> {
  const EOCD_SIG = 0x06054b50;
  const CDH_SIG = 0x02014b50;

  // The end-of-central-directory record is last, but a trailing comment may sit
  // after it, so scan back from the end for the signature.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0 && i >= zip.length - 22 - 0xffff; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new CoachFeedError('not a zip file: no end-of-central-directory record');

  const entryCount = zip.readUInt16LE(eocd + 10);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    throw new CoachFeedError('zip64 archive: this reader handles the classic format only');
  }

  const want = new Set(wanted);
  const out = new Map<string, Buffer>();

  let p = cdOffset;
  for (let i = 0; i < entryCount && p + 46 <= zip.length; i++) {
    if (zip.readUInt32LE(p) !== CDH_SIG) {
      throw new CoachFeedError(`corrupt central directory at entry ${i}`);
    }
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (!want.has(name)) continue;

    // The local header repeats the name and carries its own extra field, whose
    // length routinely differs from the central directory's - so it has to be
    // read here rather than assumed.
    const lnameLen = zip.readUInt16LE(localOffset + 26);
    const lextraLen = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lnameLen + lextraLen;
    const body = zip.subarray(start, start + compressedSize);

    if (method === 0) out.set(name, Buffer.from(body));
    else if (method === 8) out.set(name, inflateRawSync(body));
    else throw new CoachFeedError(`${name}: unsupported compression method ${method}`);
  }

  const missing = wanted.filter((w) => !out.has(w));
  if (missing.length) throw new CoachFeedError(`feed is missing ${missing.join(', ')}`);
  return out;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Split one CSV record. GTFS quotes any field containing a comma - route long
 * names routinely do, `"Berlin, ZOB - Munich"` - and doubles an embedded quote,
 * so a naive `split(',')` corrupts exactly the fields the map displays.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c !== '"') { field += c; continue; }
      if (line[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      out.push(field); field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

/**
 * Iterate a GTFS table as records. Yields plain arrays plus a column index so
 * hot tables (`stop_times`, 26 MB; `shapes`, 155 MB) are not turned into a
 * million short-lived objects.
 */
function* csvRows(buf: Buffer): Generator<{ cols: Map<string, number>; row: string[] }> {
  const text = buf.toString('utf8');
  let start = 0;
  let header: Map<string, number> | null = null;

  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const raw = text.charCodeAt(end - 1) === 13 ? text.slice(start, end - 1) : text.slice(start, end);
    start = end + 1;
    if (!raw) continue;

    const row = splitCsvLine(raw);
    if (!header) {
      // Strip a UTF-8 BOM off the first column name, which several GTFS
      // publishers emit and which otherwise breaks every lookup on that column.
      row[0] = row[0].replace(/^﻿/, '');
      header = new Map(row.map((name, i) => [name.trim(), i]));
      continue;
    }
    yield { cols: header, row };
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export type Bbox = [west: number, south: number, east: number, north: number];

const inside = (b: Bbox, lon: number, lat: number) =>
  lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

/**
 * Clip one segment to the box (Liang-Barsky), or null if it misses entirely.
 * Returned in the segment's own direction, so clipped ends chain together.
 */
function clipSegment(a: Coord, b: Coord, [w, s, e, n]: Bbox): [Coord, Coord] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - w, e - a[0], a[1] - s, n - a[1]];

  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) {
      // Parallel to this edge: either wholly outside it, or unconstrained by it.
      if (q[k] < 0) return null;
      continue;
    }
    const r = q[k] / p[k];
    if (p[k] < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  if (t1 - t0 <= 0) return null;  // touches a corner, encloses no length
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/**
 * Cut a shape down to the parts that run through the region.
 *
 * The rail network arrives pre-clipped, because osmium only ever gave us the
 * region's extract. A European coach feed does not: the Berlin - Barcelona
 * shape is a real polyline across France, and drawn whole it would push tiles
 * over half a continent the rest of the map has no data for.
 *
 * Clipping is per *segment*, against the box, rather than per point. Two
 * reasons, both measured on this feed:
 *
 *   - keeping the neighbouring out-of-region point so the line reaches the
 *     border only works where shape points are dense. They are not: the Kyiv
 *     and Bucharest services stride 600 km between points once they leave the
 *     EU core, so that rule drew a 627 km spike out of the region - the exact
 *     chording the closure overlay exists to avoid;
 *   - a segment can cross the region with *neither* endpoint inside it, and a
 *     point-wise test drops that line altogether.
 *
 * Each run of consecutive clipped segments becomes one part, so a service that
 * leaves the region and comes back is a MultiLineString with the excursion
 * missing rather than a straight line across it.
 */
export function clipToBbox(points: Coord[], bbox: Bbox): Coord[][] {
  const parts: Coord[][] = [];
  let part: Coord[] | null = null;

  for (let i = 1; i < points.length; i++) {
    const seg = clipSegment(points[i - 1], points[i], bbox);
    if (!seg) {
      if (part) { parts.push(part); part = null; }
      continue;
    }
    const [from, to] = seg;
    // Continuing the run only if this segment starts where the last one ended;
    // an exact comparison is right, because an unclipped endpoint is the
    // original coordinate untouched.
    if (part && part[part.length - 1][0] === from[0] && part[part.length - 1][1] === from[1]) {
      part.push(to);
    } else {
      if (part) parts.push(part);
      part = [from, to];
    }
  }
  if (part) parts.push(part);
  return parts;
}

// ---------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------

export interface CoachStop {
  /** The feed's own stop id. */
  id: string;
  /** The same stop as MOTIS names it, ready for the departure board. */
  motisId: string;
  name: string;
  code: string;
  lon: number;
  lat: number;
}

export interface CoachLine {
  /** `coach|<network>|<ref>`, matching the rail pipeline's line key format. */
  id: string;
  ref: string;
  name: string;
  colour: string;
  operator: string;
  network: string;
  /** Clipped to the region; a MultiLineString when the route re-enters it. */
  parts: Coord[][];
  /** In-region stops, in the order the representative trip calls at them. */
  stops: CoachStop[];
}

export interface CoachNetwork {
  lines: CoachLine[];
  /** Every distinct in-region stop across all lines, deduplicated by id. */
  stops: CoachStop[];
  /** For the attribution control: who to credit for what is on screen. */
  publishers: string[];
}

const MEMBERS = ['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'shapes.txt'];

/** Normalise a GTFS `route_color` (`73D700`, no hash) to `#rrggbb`. */
function feedColour(raw: string | undefined): string | null {
  const v = (raw ?? '').trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toLowerCase()}` : null;
}

export function parseFeed(source: CoachSource, zip: Buffer, bbox: Bbox): CoachLine[] {
  const members = readZipMembers(zip, MEMBERS);
  const keepAgency = new Set(source.agencies);

  // --- routes ---------------------------------------------------------------
  interface Route { ref: string; name: string; colour: string }
  const routes = new Map<string, Route>();
  for (const { cols, row } of csvRows(members.get('routes.txt')!)) {
    if (!keepAgency.has(row[cols.get('agency_id')!])) continue;
    const id = row[cols.get('route_id')!];
    const short = row[cols.get('route_short_name')!] ?? '';
    const ref = short.startsWith(source.refPrefix) ? short.slice(source.refPrefix.length) : short;
    routes.set(id, {
      ref: ref.trim(),
      name: (row[cols.get('route_long_name')!] ?? '').trim(),
      colour: feedColour(row[cols.get('route_color')!]) ?? '',
    });
  }

  // --- trips: the dominant shape, and one trip that runs it -----------------
  // A route has many trips over several shape variants. The rail pipeline
  // collapses `A -> B` and `B -> A` into one logical line; the equivalent here
  // is to draw the variant most trips actually run, which is also the one whose
  // stop list best describes the line.
  const shapeUse = new Map<string, Map<string, number>>();
  const tripForShape = new Map<string, string>();
  for (const { cols, row } of csvRows(members.get('trips.txt')!)) {
    const routeId = row[cols.get('route_id')!];
    if (!routes.has(routeId)) continue;
    const shapeId = row[cols.get('shape_id')!];
    if (!shapeId) continue;

    let uses = shapeUse.get(routeId);
    if (!uses) { uses = new Map(); shapeUse.set(routeId, uses); }
    uses.set(shapeId, (uses.get(shapeId) ?? 0) + 1);

    const key = `${routeId} ${shapeId}`;
    if (!tripForShape.has(key)) tripForShape.set(key, row[cols.get('trip_id')!]);
  }

  const chosenShape = new Map<string, string>();   // routeId -> shapeId
  const chosenTrip = new Map<string, string>();    // tripId  -> routeId
  for (const [routeId, uses] of shapeUse) {
    // Ties broken on the shape id so a rebuild of an unchanged feed is a no-op
    // in the diff rather than a coin toss.
    let best = '';
    let bestN = -1;
    for (const [shapeId, n] of uses) {
      if (n > bestN || (n === bestN && shapeId < best)) { best = shapeId; bestN = n; }
    }
    chosenShape.set(routeId, best);
    chosenTrip.set(tripForShape.get(`${routeId} ${best}`)!, routeId);
  }

  // --- stops ----------------------------------------------------------------
  const stops = new Map<string, CoachStop>();
  for (const { cols, row } of csvRows(members.get('stops.txt')!)) {
    const lat = Number(row[cols.get('stop_lat')!]);
    const lon = Number(row[cols.get('stop_lon')!]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const stopId = row[cols.get('stop_id')!];
    stops.set(stopId, {
      id: stopId,
      motisId: `${source.motisPrefix}_${stopId}`,
      name: (row[cols.get('stop_name')!] ?? '').trim(),
      code: (row[cols.get('stop_code')!] ?? '').trim(),
      lon,
      lat,
    });
  }

  // --- stop_times: the call list of each representative trip ----------------
  const calls = new Map<string, { seq: number; stopId: string }[]>();  // routeId -> calls
  for (const { cols, row } of csvRows(members.get('stop_times.txt')!)) {
    const routeId = chosenTrip.get(row[cols.get('trip_id')!]);
    if (!routeId) continue;
    const list = calls.get(routeId);
    const call = {
      seq: Number(row[cols.get('stop_sequence')!]),
      stopId: row[cols.get('stop_id')!],
    };
    if (list) list.push(call); else calls.set(routeId, [call]);
  }

  // --- shapes ---------------------------------------------------------------
  // Only the chosen shapes are kept; the feed carries 3,586 and the region uses
  // a fraction of them.
  const wantShape = new Map<string, string>();  // shapeId -> routeId
  for (const [routeId, shapeId] of chosenShape) wantShape.set(shapeId, routeId);

  const shapePoints = new Map<string, { seq: number; coord: Coord }[]>();
  for (const { cols, row } of csvRows(members.get('shapes.txt')!)) {
    const shapeId = row[cols.get('shape_id')!];
    if (!wantShape.has(shapeId)) continue;
    const lat = Number(row[cols.get('shape_pt_lat')!]);
    const lon = Number(row[cols.get('shape_pt_lon')!]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const entry = { seq: Number(row[cols.get('shape_pt_sequence')!]), coord: [lon, lat] as Coord };
    const list = shapePoints.get(shapeId);
    if (list) list.push(entry); else shapePoints.set(shapeId, [entry]);
  }

  // --- assemble -------------------------------------------------------------
  const lines: CoachLine[] = [];
  for (const [routeId, route] of routes) {
    const shapeId = chosenShape.get(routeId);
    if (!shapeId) continue;

    const raw = shapePoints.get(shapeId);
    if (!raw || raw.length < 2) continue;
    raw.sort((a, b) => a.seq - b.seq);
    const parts = clipToBbox(raw.map((p) => p.coord), bbox);
    if (parts.length === 0) continue;

    const lineStops = (calls.get(routeId) ?? [])
      .sort((a, b) => a.seq - b.seq)
      .map((c) => stops.get(c.stopId))
      .filter((s): s is CoachStop => !!s && inside(bbox, s.lon, s.lat));

    // A shape can cross the region without the line stopping in it - a
    // Copenhagen - Milan coach on the A7. It runs here, so it is drawn here,
    // but it serves nobody here and gets no stops.
    const ref = route.ref || routeId;
    lines.push({
      id: `coach|${source.name}|${ref}`.toLowerCase(),
      ref,
      name: route.name,
      colour: route.colour,
      operator: source.operator,
      network: source.operator,
      parts,
      stops: lineStops,
    });
  }

  lines.sort((a, b) => a.id.localeCompare(b.id));
  return lines;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * How long a cached feed is reused before it is fetched again. The published
 * timetable spans six months (`feed_info.feed_start_date` to `feed_end_date`),
 * so a day-old copy is not meaningfully staler than a fresh one, and CI starts
 * from an empty work directory anyway.
 */
const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

async function fetchFeed(source: CoachSource): Promise<Buffer> {
  mkdirSync(CACHE, { recursive: true });
  const path = `${CACHE}/${source.name}.zip`;

  if (existsSync(path) && Date.now() - statSync(path).mtimeMs < CACHE_MAX_AGE_MS) {
    return readFileSync(path);
  }

  const res = await fetch(source.url, {
    headers: { 'user-agent': 'OpenRailTransitmap/0.1 (+https://github.com/jnslmk/OpenRailTransitmap)' },
  });
  if (!res.ok) throw new CoachFeedError(`${source.url}: HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(path, buf);
  return buf;
}

/**
 * The whole stage. Never throws: a coach layer is a nice-to-have next to the
 * rail network, and an operator changing a URL must not be able to fail the
 * nightly build - the same stance `build.ts` takes on stop-id resolution and
 * `tiles.sh` takes on the closure layer.
 */
export async function loadCoachNetwork(bbox: Bbox): Promise<CoachNetwork> {
  const lines: CoachLine[] = [];
  const publishers: string[] = [];

  for (const source of COACH_SOURCES) {
    try {
      const zip = await fetchFeed(source);
      const found = parseFeed(source, zip, bbox);
      lines.push(...found);
      if (found.length) publishers.push(source.operator);
      console.log(`==> coach: ${found.length} ${source.name} lines in region`);
    } catch (err) {
      console.log(`==> coach: ${source.name} unavailable, skipping (${(err as Error).message})`);
    }
  }

  const stops = new Map<string, CoachStop>();
  for (const line of lines) for (const s of line.stops) stops.set(s.id, s);

  return { lines, stops: [...stops.values()], publishers };
}

export function readSnapshot(path = SNAPSHOT_PATH): CoachNetwork | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CoachNetwork;
  } catch {
    return null;
  }
}

async function main() {
  const { parse: parseYaml } = await import('yaml');
  const cfg = parseYaml(readFileSync('config/regions.yaml', 'utf8'));
  const active: string = process.env.REGION || cfg.active;
  const region = cfg.regions[active];
  if (!region) throw new Error(`unknown region '${active}'`);

  const network = await loadCoachNetwork(region.bbox as Bbox);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(network));

  const points = network.lines.reduce((n, l) => n + l.parts.reduce((m, p) => m + p.length, 0), 0);
  console.log(
    `==> ${network.lines.length} coach lines, ${network.stops.length} stops, ` +
    `${points} shape points -> ${SNAPSHOT_PATH}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

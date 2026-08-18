/**
 * Stage 2: turn the osmium extract into renderable GeoJSON plus a line registry.
 *
 *   routes.opl            -> route relations (tags + member way ids)
 *   rail-ways.geojsonseq  -> way geometry, keyed by way id
 *   stations.geojsonseq   -> station points
 *
 * The interesting part is bundling. Routes sharing a corridor must be drawn as
 * parallel bands rather than stacked on one another, which is what makes a
 * transit map legible. Because routes are built from the *same OSM ways*, we can
 * bundle on way ids instead of doing expensive geometric matching: ways carrying
 * an identical set of lines form one segment, and each line in that segment gets
 * a perpendicular offset ordinal.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { writeFeatures } from './lib/write.ts';
import { resolveStopIds } from './stop-ids.ts';
import {
  MODE_SPECS, fallbackColour, normaliseColour, type Mode,
} from '../shared/lnvg.ts';
import { chainWays, collapseParallelTracks, type Coord } from './lib/track.ts';

const WORK = process.env.WORK_DIR ?? '.work';
const EXTRACT = `${WORK}/extract`;
const OUT = `${WORK}/build`;
const DATA = 'data';

// ---------------------------------------------------------------------------
// OPL parsing
// ---------------------------------------------------------------------------

/** OPL escapes non-literal characters as %<hex>% - e.g. `%20%` is a space. */
function unescapeOpl(s: string): string {
  return s.replace(/%([0-9a-fA-F]+)%/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

interface Relation {
  id: string;
  tags: Record<string, string>;
  wayIds: string[];
  stopIds: string[];
}

function parseTags(field: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const pair of field.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    tags[unescapeOpl(pair.slice(0, eq))] = unescapeOpl(pair.slice(eq + 1));
  }
  return tags;
}

async function parseRelations(path: string): Promise<Relation[]> {
  const out: Relation[] = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.startsWith('r')) continue;

    let tags: Record<string, string> = {};
    const wayIds: string[] = [];
    const stopIds: string[] = [];
    let id = '';

    // Fields are space-separated; tag/member values have spaces escaped, so a
    // plain split is safe.
    for (const field of line.split(' ')) {
      if (!field) continue;
      const kind = field[0];
      if (!id) { id = field.slice(1); continue; }
      if (kind === 'T') tags = parseTags(field.slice(1));
      else if (kind === 'M') {
        for (const member of field.slice(1).split(',')) {
          if (!member) continue;
          const at = member.lastIndexOf('@');
          const ref = at < 0 ? member : member.slice(0, at);
          const role = at < 0 ? '' : unescapeOpl(member.slice(at + 1));
          if (ref[0] === 'w' && (role === '' || role === 'forward' || role === 'backward')) {
            wayIds.push(ref.slice(1));
          } else if (ref[0] === 'n' && role.startsWith('stop')) {
            stopIds.push(ref.slice(1));
          }
        }
      }
    }
    if (id && tags.type) out.push({ id, tags, wayIds, stopIds });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mode classification
// ---------------------------------------------------------------------------

const LONG_DISTANCE_REFS = /^(ICE|IC|EC|ECE|NJ|EN|RJ|TGV|THA|FLX|D|CNL)\s*\d*/i;

function classify(tags: Record<string, string>): Mode | null {
  const route = tags.route;
  if (route === 'subway') return 'subway';
  if (route === 'tram') return 'tram';
  if (route === 'light_rail') return 'suburban';
  if (route !== 'train' && route !== 'monorail' && route !== 'funicular') return null;

  const service = tags.service ?? '';
  if (service === 'high_speed' || service === 'long_distance') return 'longdistance';
  if (service === 'car' || service === 'car_shuttle' || service === 'motorail') return null;

  const ref = (tags.ref ?? '').trim();
  // S-Bahn: tagged network:metro, or an S-prefixed ref.
  if (tags['network:metro'] === 's-bahn' || /^S\s?\d+/i.test(ref)) return 'suburban';
  if (service === 'commuter') return 'suburban';
  if (LONG_DISTANCE_REFS.test(ref)) return 'longdistance';
  if (service === 'regional' || service === 'night') return 'regional';
  return ref ? 'regional' : null;
}

// ---------------------------------------------------------------------------
// Lines: collapse directional variants into a single logical line
// ---------------------------------------------------------------------------

interface Line {
  id: string;
  ref: string;
  name: string;
  mode: Mode;
  colour: string;
  colourSource: 'osm' | 'override' | 'fallback';
  operator: string;
  network: string;
  wayIds: string[];
  stopIds: Set<string>;
  relations: string[];
}

function lineKey(tags: Record<string, string>, mode: Mode): string {
  const network = tags['network:short'] ?? tags.network ?? '';
  const ref = pickRef(tags.ref ?? '');
  const ident = ref || (tags.name ?? '').split(':')[0].trim();
  return `${mode}|${network}|${ident}`.toLowerCase();
}

/**
 * Some routes carry several refs at once, e.g. `661A;ICE 83` for a train that
 * runs under a French and a German number, or `P11;RB 28` across a tariff
 * border. Prefer the token that looks like a German passenger line number,
 * since that is what a rider recognises; otherwise keep the first.
 */
const PASSENGER_REF = /^(ICE|IC|EC|ECE|RE|RB|S|U|STR|FLX|NJ|EN|RJ|TGV)\s?\d/i;

function pickRef(raw: string): string {
  const tokens = raw.split(';').map((t) => t.trim()).filter(Boolean);
  if (tokens.length <= 1) return raw.trim();
  return tokens.find((t) => PASSENGER_REF.test(t)) ?? tokens[0];
}

/** A route's name is usually "S5: A => B"; keep only the descriptive half. */
function cleanName(tags: Record<string, string>): string {
  const name = tags.name ?? '';
  const colon = name.indexOf(':');
  const base = colon > 0 && colon <= 6 ? name.slice(colon + 1) : name;
  return base.replace(/\s*=>\s*/g, ' – ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * How far apart the two tracks of one corridor may sit before they stop counting
 * as the same corridor. Heavy rail spreads wider than a tram does - Berlin's S1
 * is still drawn twice at 15 m and reads as one line at 20 - while a tram is held
 * tighter on purpose, so that a pair of one-way streets a block apart stays two
 * streets rather than collapsing into one. Past 20 m the collapse starts cutting
 * through junction throats and leaving the line in pieces for little further gain.
 */
const TRACK_PAIR_M: Record<Mode, number> = {
  tram: 15, subway: 20, suburban: 20, regional: 20, longdistance: 20,
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(DATA, { recursive: true });

  const cfg = parseYaml(readFileSync('config/regions.yaml', 'utf8'));
  // REGION overrides the committed default, so a one-off national run needs no
  // config change. CI sets it only via the workflow_dispatch input.
  const active: string = process.env.REGION || cfg.active;
  const region = cfg.regions[active];
  if (!region) throw new Error(`unknown region '${active}'`);
  console.log(`==> region: ${active} (${region.name})`);

  const overrides: Record<string, { colour?: string; name?: string }> =
    existsSync(`${DATA}/overrides.yaml`)
      ? (parseYaml(readFileSync(`${DATA}/overrides.yaml`, 'utf8'))?.lines ?? {})
      : {};

  // --- relations -> lines ---------------------------------------------------
  const relations = await parseRelations(`${EXTRACT}/routes.opl`);
  console.log(`==> parsed ${relations.length} relations`);

  const lines = new Map<string, Line>();
  let skipped = 0;
  for (const rel of relations) {
    if (rel.tags.type !== 'route') { skipped++; continue; }
    const mode = classify(rel.tags);
    if (!mode || rel.wayIds.length === 0) { skipped++; continue; }

    const key = lineKey(rel.tags, mode);
    let line = lines.get(key);
    if (!line) {
      const network = rel.tags['network:short'] ?? rel.tags.network ?? '';
      const ref = pickRef(rel.tags.ref ?? '');
      line = {
        id: key,
        ref: ref || cleanName(rel.tags).slice(0, 24),
        name: cleanName(rel.tags),
        mode,
        colour: '',
        colourSource: 'fallback',
        operator: rel.tags.operator ?? '',
        network,
        wayIds: [],
        stopIds: new Set(),
        relations: [],
      };
      lines.set(key, line);
    }
    line.relations.push(rel.id);
    line.wayIds.push(...rel.wayIds);
    for (const s of rel.stopIds) line.stopIds.add(s);

    // First usable colour wins; OSM colour is used verbatim per project decision.
    if (line.colourSource !== 'osm') {
      const c = normaliseColour(rel.tags.colour ?? rel.tags.color);
      if (c) { line.colour = c; line.colourSource = 'osm'; }
    }
  }

  for (const line of lines.values()) {
    const ov = overrides[line.id];
    if (ov?.colour) { line.colour = ov.colour; line.colourSource = 'override'; }
    if (ov?.name) line.name = ov.name;
    if (!line.colour) line.colour = fallbackColour(`${line.network}|${line.ref}`, line.mode);
    // De-duplicate ways contributed by opposite-direction variants.
    line.wayIds = [...new Set(line.wayIds)];
  }
  console.log(`==> ${lines.size} lines (${skipped} non-rail relations skipped)`);

  // --- way geometry ---------------------------------------------------------
  const geom = new Map<string, Coord[]>();
  {
    const rl = createInterface({
      input: createReadStream(`${EXTRACT}/rail-ways.geojsonseq`),
      crlfDelay: Infinity,
    });
    for await (const raw of rl) {
      const text = raw.replace(/^\x1e/, '').trim(); // geojsonseq record separator
      if (!text) continue;
      const f = JSON.parse(text);
      if (f.geometry?.type === 'LineString' && typeof f.id === 'string' && f.id[0] === 'w') {
        geom.set(f.id.slice(1), f.geometry.coordinates as Coord[]);
      }
    }
  }
  console.log(`==> ${geom.size} way geometries`);

  // Collapse the second track of every double-track corridor, so each line is
  // drawn once rather than as two strokes a lane apart. Once over the whole
  // network settles which track of each corridor is the one to draw, so that
  // lines sharing a street stay on the same ways and still bundle; then once
  // per line, at its own mode's tolerance, keeping anything the network-wide
  // choice does not cover for it. Must run after geometry is loaded and before
  // bundling, which keys on the surviving way ids.
  const useCount = new Map<string, number>();
  for (const line of lines.values()) {
    for (const w of line.wayIds) useCount.set(w, (useCount.get(w) ?? 0) + 1);
  }
  const everyWay = [...useCount.keys()];
  const canonical = new Set(collapseParallelTracks(
    everyWay, geom, Math.max(...Object.values(TRACK_PAIR_M)),
    { linesOn: (w) => useCount.get(w) ?? 0 },
  ));
  console.log(`==> ${everyWay.length - canonical.size} of ${everyWay.length} ways are a second track`);

  let dropped = 0;
  for (const line of lines.values()) {
    const before = line.wayIds.length;
    line.wayIds = collapseParallelTracks(line.wayIds, geom, TRACK_PAIR_M[line.mode], { canonical });
    dropped += before - line.wayIds.length;
  }
  console.log(`==> ${dropped} second-track ways collapsed`);

  // --- bundling -------------------------------------------------------------
  // Ways carrying an identical set of lines become one segment; each line in
  // the segment gets a perpendicular offset ordinal.
  const wayLines = new Map<string, string[]>();
  for (const line of lines.values()) {
    for (const w of line.wayIds) {
      if (!geom.has(w)) continue;
      const list = wayLines.get(w);
      if (list) list.push(line.id); else wayLines.set(w, [line.id]);
    }
  }

  const segments = new Map<string, { lineIds: string[]; wayIds: string[] }>();
  for (const [wayId, ids] of wayLines) {
    // Sort by mode order then ref so bundle ordering is stable across rebuilds
    // and trunk modes sit consistently on the same side.
    const sorted = [...new Set(ids)].sort((a, b) => {
      const la = lines.get(a)!, lb = lines.get(b)!;
      const d = MODE_SPECS[lb.mode].order - MODE_SPECS[la.mode].order;
      return d !== 0 ? d : la.ref.localeCompare(lb.ref, 'de', { numeric: true });
    });
    // NUL separator: network names contain spaces, so a space could in principle
    // merge two distinct route sets into one bundle key.
    const key = sorted.join('\u0000');
    const seg = segments.get(key);
    if (seg) seg.wayIds.push(wayId);
    else segments.set(key, { lineIds: sorted, wayIds: [wayId] });
  }
  console.log(`==> ${segments.size} bundle segments`);

  // --- emit route features --------------------------------------------------
  const features: unknown[] = [];
  let maxBundle = 0;
  for (const { lineIds, wayIds } of segments.values()) {
    // Snap up to the width the collapse could have left between two stretches
    // of one corridor, so a track change does not read as a break in the line.
    const snapM = Math.max(...lineIds.map((id) => TRACK_PAIR_M[lines.get(id)!.mode]));
    const chains = chainWays(wayIds, geom, snapM);
    if (chains.length === 0) continue;
    const n = lineIds.length;
    maxBundle = Math.max(maxBundle, n);

    lineIds.forEach((lineId, i) => {
      const line = lines.get(lineId)!;
      features.push({
        type: 'Feature',
        geometry: chains.length === 1
          ? { type: 'LineString', coordinates: chains[0] }
          : { type: 'MultiLineString', coordinates: chains },
        properties: {
          line: line.id,
          ref: line.ref,
          name: line.name,
          mode: line.mode,
          colour: line.colour,
          operator: line.operator,
          network: line.network,
          // Floored so every slot lands on an integer lattice: a change in
          // bundle membership can never produce a half-pitch parity slide.
          // Even-sized bundles lean half a pitch to one side of the true
          // alignment instead of straddling it - an accepted trade-off.
          offset: i - Math.floor((n - 1) / 2),
          bundle: n,
        },
      });
    });
  }
  console.log(`==> ${features.length} route features (largest bundle: ${maxBundle} lines)`);

  // --- stations -------------------------------------------------------------
  // Read the station points first; each one becomes a bucket that nearby stop
  // positions are snapped into.
  interface Station {
    id: string;
    geometry: { type: 'Point'; coordinates: Coord };
    props: Record<string, string>;
    served: Set<string>;
  }

  const stations: Station[] = [];
  const stationByNode = new Map<string, Station>();

  for await (const raw of createInterface({
    input: createReadStream(`${EXTRACT}/stations.geojsonseq`),
    crlfDelay: Infinity,
  })) {
    const text = raw.replace(/^\x1e/, '').trim();
    if (!text) continue;
    const f = JSON.parse(text);
    if (f.geometry?.type !== 'Point' || !f.properties?.name) continue;
    const st: Station = {
      id: String(f.id),
      geometry: f.geometry,
      props: f.properties,
      served: new Set<string>(),
    };
    stations.push(st);
    if (st.id[0] === 'n') stationByNode.set(st.id.slice(1), st);
  }

  // Grid index over station points. Cell ~0.01deg, so a 3x3 neighbourhood
  // always covers the snap radius.
  const CELL = 0.01;
  const SNAP_M = 300;
  const cellKey = (lon: number, lat: number) =>
    `${Math.floor(lon / CELL)}:${Math.floor(lat / CELL)}`;

  const grid = new Map<string, Station[]>();
  for (const st of stations) {
    const [lon, lat] = st.geometry.coordinates;
    const k = cellKey(lon, lat);
    const cell = grid.get(k);
    if (cell) cell.push(st); else grid.set(k, [st]);
  }

  /** Equirectangular approximation - accurate enough at a 300 m radius. */
  function metres(a: Coord, b: Coord): number {
    const mPerDegLat = 111320;
    const dx = (a[0] - b[0]) * mPerDegLat * Math.cos((a[1] * Math.PI) / 180);
    const dy = (a[1] - b[1]) * mPerDegLat;
    return Math.hypot(dx, dy);
  }

  function nearestStation(c: Coord): Station | null {
    const [lon, lat] = c;
    const ci = Math.floor(lon / CELL), cj = Math.floor(lat / CELL);
    let best: Station | null = null;
    let bestD = SNAP_M;
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        for (const st of grid.get(`${i}:${j}`) ?? []) {
          const d = metres(c, st.geometry.coordinates);
          if (d < bestD) { bestD = d; best = st; }
        }
      }
    }
    return best;
  }

  // Stop-position coordinates, so relation stop members can be located.
  const stopCoords = new Map<string, Coord>();
  for await (const raw of createInterface({
    input: createReadStream(`${EXTRACT}/stops.geojsonseq`),
    crlfDelay: Infinity,
  })) {
    const text = raw.replace(/^\x1e/, '').trim();
    if (!text) continue;
    const f = JSON.parse(text);
    if (f.geometry?.type === 'Point' && typeof f.id === 'string' && f.id[0] === 'n') {
      stopCoords.set(f.id.slice(1), f.geometry.coordinates as Coord);
    }
  }

  let direct = 0, snapped = 0, unmatched = 0;
  for (const line of lines.values()) {
    for (const stopId of line.stopIds) {
      // Some relations reference the station node itself - use it directly.
      const exact = stationByNode.get(stopId);
      if (exact) { exact.served.add(line.id); direct++; continue; }

      const c = stopCoords.get(stopId);
      if (!c) { unmatched++; continue; }
      const st = nearestStation(c);
      if (st) { st.served.add(line.id); snapped++; } else unmatched++;
    }
  }
  console.log(`==> stop members: ${direct} direct, ${snapped} snapped, ${unmatched} unmatched`);

  // Resolve OSM stations to Transitous/MOTIS stop ids for the live departure
  // board. Run against the full station list (not just served ones) so an
  // unserved station that later gains a line doesn't need a fresh resolve
  // pass; see pipeline/stop-ids.ts for the cache/budget/validation design.
  // Belt-and-braces: stop-ids.ts already degrades internally (tolerant cache
  // load, atomic save, per-station try/catch), but a station lookup board is
  // a nice-to-have next to the whole map build - nothing in this module may
  // ever be allowed to fail the build, so an unforeseen bug here still can't.
  let stopIds = new Map<string, string>();
  try {
    ({ stopIds } = await resolveStopIds(
      stations.map((st) => ({
        id: st.id,
        name: st.props.name,
        lon: st.geometry.coordinates[0],
        lat: st.geometry.coordinates[1],
      })),
    ));
  } catch (err) {
    console.log(`==> stop id resolution failed, continuing without it: ${(err as Error).message}`);
  }

  const stationFeatures = stations.map((st) => {
    const served = [...st.served];
    const modes = [...new Set(served.map((id) => lines.get(id)!.mode))];
    return {
      type: 'Feature',
      geometry: st.geometry,
      properties: {
        id: st.id,
        name: st.props.name,
        // Retained for MOTIS stop matching in the journey planner.
        uic_ref: st.props.uic_ref ?? '',
        ifopt: st.props['ref:IFOPT'] ?? '',
        wikidata: st.props.wikidata ?? '',
        // Resolved against Transitous at build time; '' when unmatched, in
        // which case the departure board simply doesn't render - see
        // pipeline/stop-ids.ts.
        stopId: stopIds.get(st.id) ?? '',
        lines: served.join(','),
        lineCount: served.length,
        modes: modes.join(','),
        interchange: served.length >= 3 ? 1 : 0,
        major: /Hbf|Hauptbahnhof/.test(st.props.name) ? 1 : 0,
        // Tram-only stops are far denser than rail stations and are held back
        // to high zoom by a separate style layer.
        tramOnly: modes.length > 0 && modes.every((m) => m === 'tram') ? 1 : 0,
      },
    };
  });

  const servedCount = stationFeatures.filter((f) => f.properties.lineCount > 0).length;
  console.log(`==> ${stationFeatures.length} stations (${servedCount} with at least one line)`);

  // The station list of every line, keyed by line id: the join key the
  // punctuality pipeline needs, since DB's delay feed names a station but has
  // no notion of which of the 22 lines called "S1" it belongs to (see
  // pipeline/punctuality.ts). Committed rather than left in .work/ so that
  // pipeline is a standalone run - it would otherwise need a 4 GB OSM extract
  // and a full rebuild just to learn which stations a line calls at.
  const lineStations = new Map<string, Set<string>>();
  for (const st of stations) {
    for (const id of st.served) {
      const names = lineStations.get(id);
      if (names) names.add(st.props.name);
      else lineStations.set(id, new Set([st.props.name]));
    }
  }

  // --- write ----------------------------------------------------------------
  await writeFeatures(`${OUT}/routes.geojsonl`, features);
  await writeFeatures(`${OUT}/stations.geojsonl`, stationFeatures);

  // The committed registry: small, diffable, and the thing a human reviews when
  // a nightly rebuild changes something.
  const registry = [...lines.values()]
    .map((l) => ({
      id: l.id,
      ref: l.ref,
      name: l.name,
      mode: l.mode,
      colour: l.colour,
      colourSource: l.colourSource,
      operator: l.operator,
      network: l.network,
      stops: l.stopIds.size,
      ways: l.wayIds.length,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const byMode = Object.fromEntries(
    Object.keys(MODE_SPECS).map((m) => [m, registry.filter((l) => l.mode === m).length]),
  );
  const tagged = registry.filter((l) => l.colourSource === 'osm').length;

  writeFileSync(
    `${DATA}/lines.json`,
    JSON.stringify({
      region: active,
      regionName: region.name,
      counts: { lines: registry.length, stations: stationFeatures.length, byMode },
      colourCoverage: { osmTagged: tagged, total: registry.length },
      lines: registry,
    }, null, 2) + '\n',
  );

  // One line per line id: the file is ~1 MB, and a rebuild that moves a single
  // route should show up in review as a single changed row, not a reflow.
  const stationLists = [...lineStations.keys()]
    .sort()
    .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify([...lineStations.get(id)!].sort())}`)
    .join(',\n');
  writeFileSync(`${DATA}/line-stations.json`, `{\n${stationLists}\n}\n`);

  console.log('==> by mode:', byMode);
  console.log(`==> OSM colour coverage: ${tagged}/${registry.length} (${Math.round(100 * tagged / registry.length)}%)`);
}

main().catch((err) => { console.error(err); process.exit(1); });

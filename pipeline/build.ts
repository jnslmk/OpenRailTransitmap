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
  MODE_SPECS, STOP_TIER_BY_RANK, fallbackColour, normaliseColour, stopRank, type Mode,
} from '../shared/lnvg.ts';
import {
  chainWays, collapseParallelTracks, endpointKey, type Coord,
} from './lib/track.ts';
import {
  slotOffset, taperLengthM, taperMinzoom, buildTaper, trimEnd, chainLengthM, type TaperStep,
} from './lib/taper.ts';
import { adjacentSegmentPairs, groupCorridors, rankCorridorLines } from './lib/corridor.ts';
import { buildStopMarks, type MarkBundle } from './lib/stopmarks.ts';
import {
  buildRailGraph, nearestNode, routeBetween, metres, type RailWay,
} from './lib/railpath.ts';
import {
  readLog, replayLog, windowsOn, SNAPSHOT_PATH, EFFECT_RANK,
  type Closure, type LoggedClosure,
} from './closures.ts';
import { readSnapshot as readCoachSnapshot } from './coach.ts';

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
  /** `feed` is a colour the operator published with the data, as coach does. */
  colourSource: 'osm' | 'override' | 'feed' | 'fallback';
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
// Closures
// ---------------------------------------------------------------------------

/**
 * Two operating points closer together than this are the same place, and the
 * restriction is a point on the map rather than a section of it. 43% of a day's
 * feed is of this kind - work inside one station - and DB states both ends as
 * the same coordinate for them.
 */
const POINT_CLOSURE_M = 100;

/** How far a stated operating point may sit from the network and still match. */
const CLOSURE_SNAP_M = 2000;

interface ClosureSnapshot {
  day: string;
  closures: Closure[];
}

/** The clock window in effect on `day`, as `03:00-04:00`, or '' for all day. */
function hoursOn(closure: Closure, day: string): string {
  const spans = windowsOn(closure, day)
    .map((w) => `${w.fromTime.slice(0, 5)}\u2013${w.toTime.slice(0, 5)}`)
    // "00:00-00:00" is how the feed writes a possession that does not stop at
    // a clock time; saying so is worse than saying nothing.
    .filter((s) => s !== '00:00\u201300:00');
  return [...new Set(spans)].join(', ');
}

/**
 * Closure features for the tiles.
 *
 * Geometry comes from pipeline/lib/railpath.ts, which puts each restriction on
 * the track it names rather than on the straight line between its ends. A
 * restriction whose ends cannot be matched to the network is dropped rather
 * than drawn as a chord: on a map whose whole claim is that the geometry is
 * true to OSM, a red line lying across open country would be read as track.
 *
 * The history the panel shows is folded in here too, from the committed log -
 * `since` is the day the restriction entered DB's plan as far as we ever saw,
 * and `extended` counts the times its dates have moved since. Both are empty
 * on a checkout with no log yet, which is the honest answer: we have no record,
 * not "it has never been revised".
 */
async function writeClosures(railWays: RailWay[]): Promise<void> {
  if (!existsSync(SNAPSHOT_PATH)) {
    console.log('==> no closure snapshot in .work - skipping the closure layer');
    await writeFeatures(`${OUT}/closures.geojsonl`, []);
    return;
  }

  const snapshot: ClosureSnapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  let history = new Map<string, LoggedClosure>();
  try {
    history = replayLog(readLog());
  } catch (err) {
    // A malformed log is a data problem to fix, not a reason to lose the layer.
    console.log(`==> closure log unreadable, continuing without history: ${(err as Error).message}`);
  }

  const graph = buildRailGraph(railWays);
  const out: unknown[] = [];
  let points = 0, routed = 0, unmatched = 0;

  // Worst first, so that where several restrictions share a section the one a
  // rider cares about is the feature drawn on top.
  const ordered = [...snapshot.closures]
    .sort((a, b) => EFFECT_RANK[a.effect] - EFFECT_RANK[b.effect]);

  for (const c of ordered) {
    const from: Coord = [c.from.lon, c.from.lat];
    const to: Coord = [c.to.lon, c.to.lat];
    const isPoint = metres(from, to) < POINT_CLOSURE_M;

    let geometry: unknown;
    if (isPoint) {
      // A point still has to be *on* the network we drew. Without that check a
      // regional build - which reads the whole country's feed against one
      // state's extract - scatters markers across track it has never loaded.
      if (nearestNode(graph, from, CLOSURE_SNAP_M) === null) { unmatched++; continue; }
      geometry = { type: 'Point', coordinates: from };
      points++;
    } else {
      const path = routeBetween(graph, from, to, {
        routes: c.routes, snapM: CLOSURE_SNAP_M,
      });
      if (!path) { unmatched++; continue; }
      geometry = { type: 'LineString', coordinates: path.coords };
      routed++;
    }

    const logged = history.get(c.id);
    out.push({
      type: 'Feature',
      geometry,
      properties: {
        id: c.id,
        // The day this reading of the plan describes. Carried on every feature
        // rather than in a side file so the app can state the overlay's date
        // without a second fetch that could disagree with the tiles.
        day: snapshot.day,
        effect: c.effect,
        direction: c.direction,
        works: c.works,
        routes: c.routes.join(', '),
        fromName: c.from.name,
        toName: c.to.name,
        section: isPoint ? c.from.name : `${c.from.name} \u2013 ${c.to.name}`,
        // Dates only: the panel reads them, and the feed's midnight-to-four
        // timestamps say less about the possession than its hours do.
        begin: c.begin.slice(0, 10),
        end: c.end.slice(0, 10),
        hours: hoursOn(c, snapshot.day),
        since: logged?.since ?? '',
        firstEnd: logged ? logged.firstEnd.slice(0, 10) : '',
        extended: logged?.revisions ?? 0,
      },
    });
  }

  await writeFeatures(`${OUT}/closures.geojsonl`, out);
  console.log(
    `==> ${out.length} closure features for ${snapshot.day}: ` +
    `${routed} on the network, ${points} at a single operating point, ` +
    `${unmatched} dropped as unmatchable`);
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
  // Coach carries no way ids at all - its geometry is a GTFS shape, not a
  // stitched set of OSM ways - so there is no second track to collapse.
  coach: 0,
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

  // --- long-distance coach --------------------------------------------------
  // Read from the snapshot pipeline/coach.ts writes, exactly as closures are.
  // Null when that stage has not run or its feed was unavailable, in which case
  // the map is simply built without a coach layer: it is an addition to the rail
  // network, and an operator changing a URL must not fail the nightly build.
  //
  // Coach lines join `lines` here, before the pass below, so that overrides and
  // the colour fallback apply to them on exactly the same terms as everything
  // else - `data/overrides.yaml` can repaint a coach line without this module
  // growing a second code path to let it.
  const coach = readCoachSnapshot();
  if (coach) {
    for (const cl of coach.lines) {
      lines.set(cl.id, {
        id: cl.id,
        ref: cl.ref,
        name: cl.name,
        mode: 'coach',
        colour: cl.colour,
        colourSource: cl.colour ? 'feed' : 'fallback',
        operator: cl.operator,
        network: cl.network,
        wayIds: [],
        stopIds: new Set(cl.stops.map((st) => st.id)),
        relations: [],
      });
    }
    console.log(`==> ${coach.lines.length} coach lines from ${coach.publishers.join(', ') || 'no feed'}`);
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
  // Heavy-rail ways are collected as they go past, with the two tags the
  // closure router reads: `ref`, which on a German railway way is its VzG line
  // number, and `service`, which marks a siding or yard. They share the
  // coordinate arrays with `geom`, so the second list costs a pointer each.
  const geom = new Map<string, Coord[]>();
  const railWays: RailWay[] = [];
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
        const id = f.id.slice(1);
        const coords = f.geometry.coordinates as Coord[];
        geom.set(id, coords);
        // Only `railway=rail`: closures are DB InfraGO's, and a tram or metro
        // way is not track its restrictions can be on.
        if (f.properties?.railway === 'rail') {
          railWays.push({ id, coords, ref: f.properties.ref, service: f.properties.service });
        }
      }
    }
  }
  console.log(`==> ${geom.size} way geometries (${railWays.length} heavy rail)`);

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

  // Sort by mode order then ref so bundle ordering is stable across rebuilds
  // and trunk modes sit consistently on the same side. Shared with the
  // corridor-wide ranking below, so a line's rank there agrees with where it
  // would have sorted locally.
  function lineCompare(a: string, b: string): number {
    const la = lines.get(a)!, lb = lines.get(b)!;
    const d = MODE_SPECS[lb.mode].order - MODE_SPECS[la.mode].order;
    return d !== 0 ? d : la.ref.localeCompare(lb.ref, 'de', { numeric: true });
  }

  const segments = new Map<string, { lineIds: string[]; wayIds: string[] }>();
  for (const [wayId, ids] of wayLines) {
    const sorted = [...new Set(ids)].sort(lineCompare);
    // NUL separator: network names contain spaces, so a space could in principle
    // merge two distinct route sets into one bundle key.
    const key = sorted.join('\u0000');
    const seg = segments.get(key);
    if (seg) seg.wayIds.push(wayId);
    else segments.set(key, { lineIds: sorted, wayIds: [wayId] });
  }
  console.log(`==> ${segments.size} bundle segments`);

  // --- bundle chains, ready for tapering -------------------------------------
  // The stitched corridors are kept rather than dropped, for two reasons now:
  // the tapers below need both sides of every junction before any feature can
  // be emitted, and the station marks are laid across these exact bands, so
  // they have to be measured on this exact geometry (see lib/stopmarks.ts).
  // Note these chains stay untrimmed - taper trimming is applied per line when
  // the feature is built, so what the marks measure is the full band.
  interface SegInfo { lineIds: string[]; chains: Coord[][] }
  const segInfos: SegInfo[] = [];
  let maxBundle = 0;
  for (const { lineIds, wayIds } of segments.values()) {
    // Snap up to the width the collapse could have left between two stretches
    // of one corridor, so a track change does not read as a break in the line.
    const snapM = Math.max(...lineIds.map((id) => TRACK_PAIR_M[lines.get(id)!.mode]));
    const chains = chainWays(wayIds, geom, snapM);
    if (chains.length === 0) continue;
    maxBundle = Math.max(maxBundle, lineIds.length);
    segInfos.push({ lineIds, chains });
  }

  // --- corridor-wide slots ----------------------------------------------------
  // A line's slot used to be assigned per segment, purely from that segment's
  // own membership - so a line joining or leaving the corridor renumbered
  // every line outboard of it, even along one physically continuous corridor.
  // Instead, group segments that plausibly form one corridor and rank each
  // corridor's line union once, so a line holds a single slot for as long as
  // it stays in the corridor. See pipeline/lib/corridor.ts for how the
  // grouping is bounded - the transitive blow-up that a looser rule invites
  // is the main risk here, not the ranking itself.
  const corridorPairs = adjacentSegmentPairs(segInfos);
  const corridorOf = groupCorridors(segInfos.map((s) => s.lineIds), corridorPairs);
  const corridorLineOrder = rankCorridorLines(corridorOf, segInfos.map((s) => s.lineIds), lineCompare);
  const corridorSlots = new Map<number, Map<string, number>>();
  for (const [root, sortedLines] of corridorLineOrder) {
    const slots = new Map<string, number>();
    sortedLines.forEach((id, idx) => slots.set(id, slotOffset(idx, sortedLines.length)));
    corridorSlots.set(root, slots);
  }
  const slotFor = (segIdx: number, lineId: string) => corridorSlots.get(corridorOf[segIdx])!.get(lineId)!;

  {
    const corridorCount = new Set(corridorOf).size;
    const sizes = [...corridorLineOrder.values()].map((v) => v.length);
    const biggest = Math.max(...sizes, 0);
    // Slots spanned vs lines actually present, per segment: how wide a gap
    // corridor-wide slots can leave when only some of a corridor's lines are
    // present in a given segment. 0 means every segment draws exactly as
    // wide as its own membership, same as the old per-segment scheme.
    let gapSum = 0, gapMax = 0, segCount = 0;
    segInfos.forEach((seg, segIdx) => {
      if (seg.lineIds.length === 0) return;
      const offsets = seg.lineIds.map((id) => slotFor(segIdx, id));
      const spanned = Math.max(...offsets) - Math.min(...offsets) + 1;
      const gap = spanned - seg.lineIds.length;
      gapSum += gap;
      gapMax = Math.max(gapMax, gap);
      segCount++;
    });
    console.log(
      `==> ${corridorCount} corridors (${segInfos.length} segments), biggest carries ${biggest} lines`,
    );
    console.log(
      `==> slot span vs membership gap: avg ${(gapSum / segCount).toFixed(2)}, max ${gapMax}, `
      + `over ${segCount} segments`,
    );
  }

  // --- slot tapers ------------------------------------------------------------
  // A slot change between two adjacent segments is now the exception rather
  // than the rule - it happens where the corridor grouping above genuinely
  // draws a line, not on every segment boundary. Where it does still happen,
  // ramp between the two slots rather than letting the chains butt together:
  // see pipeline/lib/taper.ts for why that ramp has to be a staircase of
  // short constant-offset sub-features rather than baked-in diagonal
  // geometry.
  interface EndRef { segIdx: number; chainIdx: number; atStart: boolean }
  const byEnd = new Map<string, EndRef[]>();
  segInfos.forEach((seg, segIdx) => {
    seg.chains.forEach((chain, chainIdx) => {
      for (const atStart of [true, false]) {
        const key = endpointKey(atStart ? chain[0] : chain[chain.length - 1]);
        const ref = { segIdx, chainIdx, atStart };
        const list = byEnd.get(key);
        if (list) list.push(ref); else byEnd.set(key, [ref]);
      }
    });
  });

  const trimKey = (segIdx: number, chainIdx: number, lineId: string) => `${segIdx}:${chainIdx}:${lineId}`;

  interface Candidate {
    lineId: string; bundle: number; steps: TaperStep[]; minzoom: number;
    aIdx: number; aChainIdx: number; aFromStart: boolean; aHalf: number;
    bIdx: number; bChainIdx: number; bFromStart: boolean; bHalf: number;
  }
  const candidates: Candidate[] = [];
  let skippedAmbiguous = 0, skippedShort = 0;

  for (const refs of byEnd.values()) {
    const bySeg = new Map<number, EndRef[]>();
    for (const r of refs) {
      const list = bySeg.get(r.segIdx);
      if (list) list.push(r); else bySeg.set(r.segIdx, [r]);
    }
    if (bySeg.size < 2) continue; // only one segment touches here

    // Ambiguity is judged per line, not per point: a busy node can carry
    // several unrelated bundle changes at once (e.g. a tram joining an
    // existing corridor changes both its own bundle and everyone else's, at
    // the same coordinate), and a line whose own pairing here is a clean two
    // segments should still get its taper even though the point itself sees
    // three or more segments overall.
    const segIdxs = [...bySeg.keys()];
    const linesHere = new Set<string>();
    for (const s of segIdxs) for (const l of segInfos[s].lineIds) linesHere.add(l);

    for (const lineId of linesHere) {
      const relevant = segIdxs.filter((s) => segInfos[s].lineIds.includes(lineId));
      if (relevant.length < 2) continue; // this line doesn't carry on past here
      if (relevant.length > 2 || relevant.some((s) => bySeg.get(s)!.length > 1)) {
        // Three or more of the line's own segments meet here, or one of them
        // touches this point with more than one chain end: no well-defined
        // upstream/downstream pair for this line.
        skippedAmbiguous++;
        continue;
      }

      const [idxA, idxB] = relevant;
      const segA = segInfos[idxA], segB = segInfos[idxB];
      const [refA] = bySeg.get(idxA)!, [refB] = bySeg.get(idxB)!;

      const line = lines.get(lineId)!;
      const nA = segA.lineIds.length;
      const slotA = slotFor(idxA, lineId), slotB = slotFor(idxB, lineId);

      // buildTaper wants a chain ending at the junction and one starting
      // there. Which original end sits at the junction is arbitrary per
      // segment - chainWays seeds each segment independently, so segment A's
      // and B's orientations have no relation to one another - so a side that
      // does not already fit is handed in reversed, with its slot negated to
      // match: line-offset is relative to a feature's own direction of
      // travel, so reversing a copy of the geometry without also flipping the
      // sign it is offset by would flip which physical side it draws on.
      const chainA = segA.chains[refA.chainIdx];
      const chainB = segB.chains[refB.chainIdx];
      const up = refA.atStart
        ? { chain: [...chainA].reverse(), slot: -slotA }
        : { chain: chainA, slot: slotA };
      const down = refB.atStart
        ? { chain: chainB, slot: slotB }
        : { chain: [...chainB].reverse(), slot: -slotB };

      // Whether there is really a jump to ramp has to be judged on up/down,
      // not on the raw slotA/slotB: when one side needed the reversal above,
      // slotA and slotB live in two unrelated coordinate frames and comparing
      // them directly means nothing. A raw-value check here would both miss
      // real jumps (equal raw slots after an unequal-magnitude reversal can
      // still be physically discontinuous) and manufacture fake ones (equal
      // and opposite raw slots - e.g. slotA=1, slotB=-1 - can cancel out to
      // up.slot===down.slot once canonicalised, i.e. no real jump at all).
      if (up.slot === down.slot) continue;

      const L = taperLengthM(line.mode);
      const steps = buildTaper(up.chain, down.chain, up.slot, down.slot, L);
      if (!steps) { skippedShort++; continue; }

      candidates.push({
        lineId, bundle: nA, steps, minzoom: taperMinzoom(L),
        // Trims apply to each side's own chain in its own, never-reversed
        // orientation, so they are recorded against that chain's actual end
        // rather than the up/down role it was given above.
        aIdx: idxA, aChainIdx: refA.chainIdx, aFromStart: refA.atStart, aHalf: L / 2,
        bIdx: idxB, bChainIdx: refB.chainIdx, bFromStart: refB.atStart, bHalf: L / 2,
      });
    }
  }

  // A chain touched by two tapers, one at each end, could have them ask for
  // more trimming than the chain is long. Drop that pair rather than let the
  // trims cross over and emit a line that folds back on itself.
  const trimTotal = new Map<string, number>();
  const bump = (segIdx: number, chainIdx: number, lineId: string, m: number) => {
    const k = trimKey(segIdx, chainIdx, lineId);
    trimTotal.set(k, (trimTotal.get(k) ?? 0) + m);
  };
  for (const c of candidates) {
    bump(c.aIdx, c.aChainIdx, c.lineId, c.aHalf);
    bump(c.bIdx, c.bChainIdx, c.lineId, c.bHalf);
  }
  const collides = (segIdx: number, chainIdx: number, lineId: string) => {
    const total = trimTotal.get(trimKey(segIdx, chainIdx, lineId)) ?? 0;
    return total >= chainLengthM(segInfos[segIdx].chains[chainIdx]);
  };

  const trimStart = new Map<string, number>();
  const trimEndM = new Map<string, number>();
  const staircases: { lineId: string; bundle: number; minzoom: number; step: TaperStep }[] = [];
  let tapered = 0, skippedCollision = 0, integerLanding = 0;
  for (const c of candidates) {
    if (collides(c.aIdx, c.aChainIdx, c.lineId) || collides(c.bIdx, c.bChainIdx, c.lineId)) {
      skippedCollision++;
      continue;
    }
    const aKey = trimKey(c.aIdx, c.aChainIdx, c.lineId);
    const bKey = trimKey(c.bIdx, c.bChainIdx, c.lineId);
    if (c.aFromStart) trimStart.set(aKey, (trimStart.get(aKey) ?? 0) + c.aHalf);
    else trimEndM.set(aKey, (trimEndM.get(aKey) ?? 0) + c.aHalf);
    if (c.bFromStart) trimStart.set(bKey, (trimStart.get(bKey) ?? 0) + c.bHalf);
    else trimEndM.set(bKey, (trimEndM.get(bKey) ?? 0) + c.bHalf);
    for (const step of c.steps) {
      // buildTaper nudges a step off an integer slot it would otherwise land
      // on exactly (see its comment in taper.ts). This counts how many still
      // land on one regardless, so a change to that nudge - or to the data -
      // surfaces here rather than silently painting over a band again.
      // Expected to be 0.
      if (Number.isInteger(step.offset)) integerLanding++;
      staircases.push({ lineId: c.lineId, bundle: c.bundle, minzoom: c.minzoom, step });
    }
    tapered++;
  }
  console.log(
    `==> ${tapered} slot tapers (${skippedAmbiguous} skipped: ambiguous junction, `
    + `${skippedShort} skipped: chain too short, ${skippedCollision} skipped: trims collided)`,
  );
  console.log(`==> ${integerLanding} taper steps land exactly on an integer slot (see taper.ts:buildTaper)`);

  // --- emit route features --------------------------------------------------
  const features: unknown[] = [];
  segInfos.forEach((seg, segIdx) => {
    const n = seg.lineIds.length;
    seg.lineIds.forEach((lineId) => {
      const line = lines.get(lineId)!;
      const parts = seg.chains.map((chain, chainIdx) => {
        const sM = trimStart.get(trimKey(segIdx, chainIdx, lineId)) ?? 0;
        const eM = trimEndM.get(trimKey(segIdx, chainIdx, lineId)) ?? 0;
        if (sM === 0 && eM === 0) return chain;
        let c = chain;
        if (sM > 0) c = trimEnd(c, sM, true)?.kept ?? c;
        if (eM > 0) c = trimEnd(c, eM, false)?.kept ?? c;
        return c;
      });
      features.push({
        type: 'Feature',
        geometry: parts.length === 1
          ? { type: 'LineString', coordinates: parts[0] }
          : { type: 'MultiLineString', coordinates: parts },
        properties: {
          line: line.id,
          ref: line.ref,
          name: line.name,
          mode: line.mode,
          colour: line.colour,
          operator: line.operator,
          network: line.network,
          offset: slotFor(segIdx, lineId),
          bundle: n,
        },
      });
    });
  });

  // A staircase step sits between two segments, and its `bundle` (unlike
  // every other property here) is a deliberate deviation from "carries the
  // parent's properties": there are two parents, sides A and B, which can
  // have different bundle sizes, and the field is never read outside a debug
  // inspect (see src/*.ts), so it just takes side A's value rather than
  // picking a more "correct" answer that nothing would notice either way.
  for (const { lineId, bundle, minzoom, step } of staircases) {
    const line = lines.get(lineId)!;
    features.push({
      type: 'Feature',
      // Below its own minzoom, a taper's on-screen length is sub-pixel and so
      // is the gap it would otherwise leave if tippecanoe dropped it under
      // density pressure - see taperMinzoom in taper.ts. Omitting it there
      // costs nothing visible and frees up room in exactly the tiles
      // (station throats, city hubs) most likely to hit that pressure.
      tippecanoe: { minzoom },
      geometry: { type: 'LineString', coordinates: step.coords },
      properties: {
        line: line.id,
        ref: line.ref,
        name: line.name,
        mode: line.mode,
        colour: line.colour,
        operator: line.operator,
        network: line.network,
        offset: step.offset,
        bundle,
      },
    });
  }
  console.log(`==> ${features.length} route features (largest bundle: ${maxBundle} lines)`);

  // Coach rides in the same tile layer as the rail network, which is what gets
  // it selection, search, the legend, the mode filter and the line panel for
  // nothing. What it does not get is bundling: a GTFS shape is an independent
  // polyline with no way ids to share, so `offset` is 0 and `bundle` 1 on every
  // one of them and lines down the same autobahn stack rather than fanning out.
  // The feed gives every route one brand colour, so a stack reads as one green
  // trunk - which is what it is. See docs/buses-and-routing.md §5.2.
  if (coach) {
    for (const cl of coach.lines) {
      const line = lines.get(cl.id)!;
      features.push({
        type: 'Feature',
        geometry: cl.parts.length === 1
          ? { type: 'LineString', coordinates: cl.parts[0] }
          : { type: 'MultiLineString', coordinates: cl.parts },
        properties: {
          line: line.id,
          ref: line.ref,
          name: line.name,
          mode: line.mode,
          colour: line.colour,
          operator: line.operator,
          network: line.network,
          offset: 0,
          bundle: 1,
        },
      });
    }
    console.log(`==> ${coach.lines.length} coach route features`);
  }

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
  /** See the coach-stop block below for why this is wider than SNAP_M. */
  const COACH_SNAP_M = 400;
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

  function nearestStation(c: Coord, radiusM = SNAP_M): Station | null {
    const [lon, lat] = c;
    const ci = Math.floor(lon / CELL), cj = Math.floor(lat / CELL);
    let best: Station | null = null;
    let bestD = radiusM;
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
    // Coach stop ids are the feed's, not OSM node ids; they are matched below,
    // after stop-id resolution, and would only ever count as unmatched here.
    if (line.mode === 'coach') continue;
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

  // --- coach stops ----------------------------------------------------------
  // These need none of the resolution above: the feed's own stop id, prefixed
  // with its MOTIS feed name, *is* the id the departure board asks for (checked
  // against /stoptimes - `eu-flixbus_<uuid>` returns the board for Munich ZOB).
  // That is why this runs after `resolveStopIds` rather than feeding into it.
  if (coach) {
    const callers = new Map<string, Set<string>>();
    for (const cl of coach.lines) {
      for (const st of cl.stops) {
        const set = callers.get(st.id);
        if (set) set.add(cl.id); else callers.set(st.id, new Set([cl.id]));
      }
    }

    let attached = 0;
    let own = 0;
    for (const cs of coach.stops) {
      const serving = callers.get(cs.id);
      if (!serving) continue;

      // A coach stop at a Hauptbahnhof *is* the station, under the operator's
      // own name and a couple of hundred metres away across the forecourt.
      // Attaching it keeps one dot where a rider sees one place, rather than
      // "Dresden Hbf" and "Dresden central station (Bayrische Straße)" sitting
      // next to each other claiming to be different stations. 400 m rather than
      // the 300 m used for OSM stop positions, because a coach bay is parked at
      // the far side of the forecourt more often than a platform is.
      const st = nearestStation([cs.lon, cs.lat], COACH_SNAP_M);
      if (st) {
        for (const id of serving) st.served.add(id);
        attached++;
        continue;
      }

      const stop: Station = {
        id: `coach/${cs.id}`,
        geometry: { type: 'Point', coordinates: [cs.lon, cs.lat] },
        props: { name: cs.name },
        served: new Set(serving),
      };
      stations.push(stop);
      stopIds.set(stop.id, cs.motisId);
      own++;
    }
    console.log(`==> coach stops: ${attached} at a rail station, ${own} of their own`);
  }

  // --- station marks --------------------------------------------------------
  // The mark a rider actually sees is not drawn at the station node but across
  // the bands, covering the lines that call and no others. Computing that is
  // the one thing here that needs both halves of the build at once - the
  // stitched corridors and the resolved stop members - so it happens now, with
  // both in hand. See pipeline/lib/stopmarks.ts for what it is doing and why.
  // The marks need the slot each line actually landed on, which under
  // corridor-wide assignment is no longer its index in the bundle: a line
  // absent from this stretch keeps its slot reserved, so the ordinals can have
  // gaps. They stay ascending though - a segment's lineIds and its corridor's
  // ranking are sorted by the same comparator - so a run of adjacent lineIds
  // is still a run of ascending ordinals, which is what the bars are built on.
  const markBundles: MarkBundle[] = segInfos.map((seg, segIdx) => ({
    lineIds: seg.lineIds,
    chains: seg.chains,
    slots: seg.lineIds.map((id) => slotFor(segIdx, id)),
  }));

  const marks = buildStopMarks(
    markBundles,
    stations.map((st) => ({ id: st.id, coord: st.geometry.coordinates, served: st.served })),
  );

  const stationFeatures = stations.map((st) => {
    const served = [...st.served];
    const modes = [...new Set(served.map((id) => lines.get(id)!.mode))];
    const major = /Hbf|Hauptbahnhof/.test(st.props.name);
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
        major: major ? 1 : 0,
        // A coach stop that is not also a station is a bus bay - a ZOB, an
        // airport forecourt, a motorway services. Worth drawing, but not at the
        // zoom where the map is showing the shape of the rail network, and not
        // labelled as loudly as a Hauptbahnhof.
        coachOnly: modes.length > 0 && modes.every((m) => m === 'coach') ? 1 : 0,
        // Which zoom this stop earns its mark at - see STOP_TIERS. It replaces
        // the `interchange` and `tramOnly` flags this used to carry, both of
        // which it subsumes. An unserved station is drawn at no zoom at all,
        // so the rank it gets is only somewhere for it to go.
        rank: served.length ? stopRank(modes, served.length, major) : 3,
        // Whether the mark is drawn across the bands or, failing that, on the
        // node. A station whose corridors are all further off than the snap
        // radius keeps the old dot there rather than vanishing - and so does
        // every coach stop, because a GTFS shape is not one of the bundles the
        // marks are measured on.
        pill: marks.get(st.id)?.length ? 1 : 0,
      },
    };
  });

  const servedCount = stationFeatures.filter((f) => f.properties.lineCount > 0).length;
  console.log(`==> ${stationFeatures.length} stations (${servedCount} with at least one line)`);

  const byRank = new Map<number, number>();
  const markFeatures = stationFeatures.flatMap((f) => {
    if (!f.properties.lineCount) return [];
    const rank = f.properties.rank;
    byRank.set(rank, (byRank.get(rank) ?? 0) + 1);

    // A station whose corridors are all further off than the snap radius - OSM
    // has the stop member and the track too far apart to be the same place -
    // still gets a mark, a one-band one on its own node. That is the dot every
    // stop used to be, so a data problem costs the mark's precision and never
    // the mark. `pill` on the station says which of the two happened.
    const list = marks.get(String(f.properties.id)) ?? [{
      coord: (f.geometry as { coordinates: Coord }).coordinates,
      bearing: 0,
      mid: 0,
      span: 1,
      lines: String(f.properties.lines).split(',').filter(Boolean),
    }];

    // One name per station, on the widest of its bars - a junction has a mark
    // per corridor and would otherwise be labelled once per corridor too.
    const widest = list.reduce((a, b) => (b.span > a.span ? b : a));
    return list.map((m) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: m.coord },
      properties: {
        station: f.properties.id,
        name: f.properties.name,
        // The lines *this bar* covers, not the station's - so switching a mode
        // off takes away the bars that were only ever about that mode.
        lines: m.lines.join(','),
        span: m.span,
        mid: Number(m.mid.toFixed(3)),
        bearing: Number(m.bearing.toFixed(1)),
        rank,
        lineCount: f.properties.lineCount,
        major: f.properties.major,
        coachOnly: f.properties.coachOnly,
        primary: m === widest ? 1 : 0,
      },
      // The tier table, written into the tiles: a tram stop is not merely
      // hidden at z8, it is not carried at z8 at all.
      tippecanoe: { minzoom: Math.floor(STOP_TIER_BY_RANK[rank].mark) },
    }));
  });

  const orphans = servedCount - stationFeatures.filter((f) => f.properties.pill).length;
  const ranks = [...byRank].sort((a, b) => a[0] - b[0])
    .map(([r, n]) => `rank ${r}: ${n}`).join(', ');
  console.log(
    `==> ${markFeatures.length} station marks (${ranks}`
    + `${orphans ? `; ${orphans} off their corridor, marked on the node` : ''})`,
  );

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
  await writeFeatures(`${OUT}/stopmarks.geojsonl`, markFeatures);
  await writeClosures(railWays);

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
  // Coach is excluded from both halves: its colour comes from the operator's
  // feed, so counting it would move a statistic that is about how much of OSM
  // carries a `colour` tag.
  const fromOsm = registry.filter((l) => l.mode !== 'coach');
  const tagged = fromOsm.filter((l) => l.colourSource === 'osm').length;

  writeFileSync(
    `${DATA}/lines.json`,
    JSON.stringify({
      region: active,
      regionName: region.name,
      counts: { lines: registry.length, stations: stationFeatures.length, byMode },
      colourCoverage: { osmTagged: tagged, total: fromOsm.length },
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
  const pct = fromOsm.length ? Math.round(100 * tagged / fromOsm.length) : 0;
  console.log(`==> OSM colour coverage: ${tagged}/${fromOsm.length} (${pct}%)`);
}

main().catch((err) => { console.error(err); process.exit(1); });

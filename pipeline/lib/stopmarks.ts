/**
 * Where a station's mark goes, and how wide it is.
 *
 * The reference poster does not draw a stop where the station building stands.
 * It draws a bar laid across the bundle, covering exactly the lines that call
 * there and no others, so a glance answers the only question a stop symbol is
 * asked: *which of these lines can I board here?* Two lines through a station
 * with one bar between them share the stop; two lines with two bars do not.
 *
 * Reproducing that on a geographic map means the mark cannot sit on the station
 * node. The node is off to one side of the track - a building, a car park, the
 * middle of a platform group - and the bands are drawn on the alignment, so a
 * mark at the node is a mark that misses its own lines. So for every corridor a
 * station is served from, this module finds:
 *
 *   - the point on that corridor's *drawn* geometry nearest the station,
 *   - the direction the corridor runs there, so the bar can be laid across it,
 *   - the run of band ordinals belonging to the lines that actually stop.
 *
 * The band ordinals are the same offsets `build.ts` gives the route
 * features, so a mark measured in them lines up with the bands at every zoom
 * without anything having to agree about pixels.
 *
 * A station on a junction gets one mark per corridor, at different angles -
 * which is what the poster does too. A station where a corridor *changes*
 * composition, though - a line terminating, a branch peeling off - sits between
 * two bundles drawn on the same alignment, and two bars stacked on one another
 * is not a junction, it is a seam. Those are merged back together.
 */

import type { Coord } from './track.ts';

const M_PER_DEG = 111320;
const DEG = 180 / Math.PI;

/** One bundle as `build.ts` emits it: ordered lines, and the geometry drawn. */
export interface MarkBundle {
  /** Line ids in draw order, ascending by band ordinal. */
  lineIds: string[];
  /**
   * The band ordinal each line in `lineIds` actually sits at, same index.
   * Carried rather than derived: slots are assigned per corridor, not per
   * bundle, so a line absent from this stretch leaves its slot reserved and
   * the ordinals here can have gaps in them - `build.ts` is the only thing
   * that knows where they landed. See its corridor-wide slot block.
   */
  slots: number[];
  /** The stitched corridor. Marks are anchored on these exact coordinates. */
  chains: Coord[][];
}

/** The station side of the join. `served` holds line ids, as `build.ts` has it. */
export interface MarkStation {
  id: string;
  coord: Coord;
  served: Set<string>;
}

export interface StopMark {
  station: string;
  /** Anchor on the corridor alignment - where the bar is centred. */
  coord: Coord;
  /**
   * `icon-rotate` in degrees clockwise, already turned so the bar lies *across*
   * the corridor rather than along it.
   */
  bearing: number;
  /** Centre of the covered band run, in offset ordinals. */
  mid: number;
  /** How many band slots the bar covers. 1 is a plain dot. */
  span: number;
  /** The lines that stop here, in bundle order. */
  lines: string[];
}

export interface MarkOptions {
  /**
   * How far a station may sit from the corridor drawn for it. Stop members are
   * already snapped to a station within 300 m (see `build.ts`), so a corridor
   * further off than that is not the one this station is served from.
   */
  maxM?: number;
  /**
   * Two marks on one station closer than this in heading are candidates for
   * being the same corridor seen twice - a bundle split at a terminus or a
   * junction. Wide enough to absorb the wobble of two stretches of one
   * alignment, narrow enough to leave a real fork as two marks.
   */
  mergeDeg?: number;
  /**
   * ...and they are only actually merged if their anchors are within this far
   * of each other *across* the corridor. Two stretches of one alignment differ
   * along the heading and sit on the same track; two alignments running side by
   * side - an S-Bahn beside its mainline - differ across it, and are two marks
   * however similar their heading, because they are drawn in two places.
   */
  mergeCrossM?: number;
}

/** Grid cell for the station index. ~1.1 km, comfortably wider than `maxM`. */
const CELL = 0.01;
const cellKey = (lon: number, lat: number) =>
  `${Math.floor(lon / CELL)}:${Math.floor(lat / CELL)}`;

/**
 * Distance from `p` to segment `a->b`, in metres, with the projected foot.
 *
 * Equirectangular, which over a single OSM way segment is exact to well under
 * the metre this is measuring in.
 */
function projectToSegment(a: Coord, b: Coord, p: Coord): { d: number; foot: Coord } {
  const kx = M_PER_DEG * Math.cos((p[1] * Math.PI) / 180);
  const ax = a[0] * kx, ay = a[1] * M_PER_DEG;
  const bx = b[0] * kx, by = b[1] * M_PER_DEG;
  const px = p[0] * kx, py = p[1] * M_PER_DEG;
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  const fx = ax + vx * t, fy = ay + vy * t;
  return { d: Math.hypot(px - fx, py - fy), foot: [fx / kx, fy / M_PER_DEG] };
}

/**
 * The `icon-rotate` that lays a bar across a corridor running `a -> b`.
 *
 * MapLibre rotates an icon clockwise from screen-up, and the pill image runs
 * along its own +x, so a corridor at `theta` counter-clockwise from east needs
 * `90 - theta` to end up perpendicular to it. The result is deliberately *not*
 * folded into [0,180): the sign of the band ordinals is "right of the drawing
 * direction", the same convention `line-offset` uses, so reversing the heading
 * would silently mirror the bar onto the wrong lines.
 */
function crossBearing(a: Coord, b: Coord): number {
  const east = (b[0] - a[0]) * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const north = b[1] - a[1];
  const theta = Math.atan2(north, east) * DEG;
  const deg = 90 - theta;
  return ((deg % 360) + 360) % 360;
}

/** Signed smallest angle between two headings, ignoring which way each points. */
function headingDelta(a: number, b: number): number {
  const d = Math.abs(((a - b) % 180) + 180) % 180;
  return Math.min(d, 180 - d);
}

/** True when `a` and `b` are the same heading reversed rather than repeated. */
function isOpposed(a: number, b: number): boolean {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 90 && d < 270;
}

/** Contiguous runs of `true` in a boolean array, as `[first, last]` index pairs. */
function runs(flags: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    if (i < flags.length && flags[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

/** A mark before merging, carried in ordinals rather than centre + span. */
interface Draft {
  station: string;
  /** Which bundle drew it: two runs of one bundle are a skip-stop, never a seam. */
  bundle: number;
  coord: Coord;
  bearing: number;
  lo: number;
  hi: number;
  lines: string[];
}

/** How far `b` lies from `a` across a corridor running at `bearing`, in metres. */
function crossTrackM(a: Coord, b: Coord, bearing: number): number {
  const theta = ((90 - bearing) * Math.PI) / 180;
  const kx = M_PER_DEG * Math.cos((a[1] * Math.PI) / 180);
  const east = (b[0] - a[0]) * kx, north = (b[1] - a[1]) * M_PER_DEG;
  // The corridor runs along (cos, sin); its normal is (-sin, cos).
  return Math.abs(-east * Math.sin(theta) + north * Math.cos(theta));
}

/**
 * Lay one bar across each corridor each station is served from.
 *
 * Returns marks keyed by station id; a station whose corridors are all further
 * off than `maxM` - which happens where OSM's stop member and its track are
 * genuinely unrelated - simply gets none, and the caller falls back to drawing
 * it where the node is.
 */
export function buildStopMarks(
  bundles: MarkBundle[],
  stations: MarkStation[],
  opts: MarkOptions = {},
): Map<string, StopMark[]> {
  const maxM = opts.maxM ?? 300;
  const mergeDeg = opts.mergeDeg ?? 25;
  const mergeCrossM = opts.mergeCrossM ?? 12;

  // Stations are smeared over their 3x3 cell neighbourhood, so a corridor
  // vertex only ever needs to look in the one cell it falls in. 20k stations
  // times nine entries is nothing; a nine-cell scan per vertex, over millions
  // of vertices, is not.
  const near = new Map<string, MarkStation[]>();
  const byLine = new Map<string, MarkStation[]>();
  for (const st of stations) {
    if (st.served.size === 0) continue;
    const ci = Math.floor(st.coord[0] / CELL), cj = Math.floor(st.coord[1] / CELL);
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        const k = `${i}:${j}`;
        const cell = near.get(k);
        if (cell) cell.push(st); else near.set(k, [st]);
      }
    }
    for (const id of st.served) {
      const list = byLine.get(id);
      if (list) list.push(st); else byLine.set(id, [st]);
    }
  }

  const drafts = new Map<string, Draft[]>();

  for (let bi = 0; bi < bundles.length; bi++) {
    const bundle = bundles[bi];
    // Only stations one of this bundle's own lines calls at are candidates.
    // Without it every corridor would claim every station beside it, and a
    // through track past a terminus would grow a bar it has no stop on.
    const candidates = new Set<MarkStation>();
    for (const id of bundle.lineIds) {
      for (const st of byLine.get(id) ?? []) candidates.add(st);
    }
    if (candidates.size === 0) continue;

    // Nearest vertex per candidate, then refined onto the segments either side
    // of it. Vertices on OSM rail are tens of metres apart, so the vertex alone
    // would already be close; the refinement stops consecutive stations on one
    // corridor from stepping about between whichever vertex happened to win.
    const best = new Map<MarkStation, { d: number; ci: number; vi: number }>();
    for (let ci = 0; ci < bundle.chains.length; ci++) {
      const chain = bundle.chains[ci];
      for (let vi = 0; vi < chain.length; vi++) {
        const v = chain[vi];
        const cell = near.get(cellKey(v[0], v[1]));
        if (!cell) continue;
        for (const st of cell) {
          if (!candidates.has(st)) continue;
          const kx = M_PER_DEG * Math.cos((st.coord[1] * Math.PI) / 180);
          const d = Math.hypot(
            (v[0] - st.coord[0]) * kx, (v[1] - st.coord[1]) * M_PER_DEG,
          );
          if (d > maxM) continue;
          const prev = best.get(st);
          if (!prev || d < prev.d) best.set(st, { d, ci, vi });
        }
      }
    }

    for (const [st, hit] of best) {
      const chain = bundle.chains[hit.ci];
      let anchor: Coord = chain[hit.vi];
      let a = chain[Math.max(0, hit.vi - 1)];
      let b = chain[Math.min(chain.length - 1, hit.vi + 1)];
      let bestD = Infinity;
      for (const [p, q] of [
        [chain[hit.vi - 1], chain[hit.vi]],
        [chain[hit.vi], chain[hit.vi + 1]],
      ] as [Coord | undefined, Coord | undefined][]) {
        if (!p || !q) continue;
        const { d, foot } = projectToSegment(p, q, st.coord);
        if (d < bestD) { bestD = d; anchor = foot; a = p; b = q; }
      }
      if (bestD > maxM) continue;

      const flags = bundle.lineIds.map((id) => st.served.has(id));
      const bearing = crossBearing(a, b);
      const list = drafts.get(st.id) ?? [];
      for (const [first, last] of runs(flags)) {
        list.push({
          station: st.id,
          bundle: bi,
          coord: anchor,
          bearing,
          lo: bundle.slots[first],
          hi: bundle.slots[last],
          lines: bundle.lineIds.slice(first, last + 1),
        });
      }
      if (list.length) drafts.set(st.id, list);
    }
  }

  // Merge the seams: bars on one station lying along the same heading are one
  // corridor whose bundle changed composition, not two corridors.
  const out = new Map<string, StopMark[]>();
  for (const [id, list] of drafts) {
    const groups: Draft[] = [];
    for (const d of [...list].sort((x, y) => (y.hi - y.lo) - (x.hi - x.lo))) {
      const host = groups.find((g) => g.bundle !== d.bundle
        && headingDelta(g.bearing, d.bearing) <= mergeDeg
        && crossTrackM(g.coord, d.coord, g.bearing) <= mergeCrossM);
      if (!host) { groups.push({ ...d, lines: [...d.lines] }); continue; }
      // A bundle stitched the other way round numbers its bands from the other
      // side, so its ordinals have to be flipped before they can be unioned.
      const [lo, hi] = isOpposed(host.bearing, d.bearing) ? [-d.hi, -d.lo] : [d.lo, d.hi];
      host.lo = Math.min(host.lo, lo);
      host.hi = Math.max(host.hi, hi);
      for (const line of d.lines) if (!host.lines.includes(line)) host.lines.push(line);
    }
    out.set(id, groups.map((g) => ({
      station: g.station,
      coord: g.coord,
      bearing: g.bearing,
      mid: (g.lo + g.hi) / 2,
      span: Math.round(g.hi - g.lo) + 1,
      lines: g.lines,
    })));
  }
  return out;
}

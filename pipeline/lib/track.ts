/**
 * Turning a line's set of OSM ways into the strokes we draw for it.
 *
 * Two problems live here. `chainWays` stitches ways back into as few continuous
 * linestrings as possible, because MapLibre offsets a line perpendicular to its
 * drawing direction and a corridor drawn as loose fragments would push its lines
 * to inconsistent sides. `collapseParallelTracks` throws away the second track of
 * a double-track corridor, because OSM maps each direction of travel as its own
 * way and a line that unions both directions would be drawn twice.
 */

export type Coord = [number, number];

/** A way end, rounded to OSM's coordinate precision so shared nodes compare equal. */
export const endpointKey = (c: Coord) => `${c[0].toFixed(7)},${c[1].toFixed(7)}`;

export const M_PER_DEG = 111320;

/** Equirectangular approximation - accurate enough over a single way. */
export function metres(a: Coord, b: Coord): number {
  const dx = (a[0] - b[0]) * M_PER_DEG * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot(dx, (a[1] - b[1]) * M_PER_DEG);
}

/**
 * Chain a set of ways into as few continuous linestrings as possible, flipping
 * ways where needed. Consistent orientation matters: MapLibre's `line-offset`
 * is perpendicular to the drawing direction, so a reversed way in a corridor
 * would push its line to the wrong side of the bundle.
 *
 * `snapM` closes the seams the double-track collapse leaves behind. Where the
 * collapse changes track, the two kept stretches carry on in the same direction
 * but a track's width apart, sharing no node, and the line is drawn with a nick
 * in it. Chains whose ends sit within `snapM` of each other and still head the
 * same way are joined across that step; ends that meet at an angle are a real
 * junction and are left alone.
 */
export function chainWays(wayIds: string[], geom: Map<string, Coord[]>, snapM = 0): Coord[][] {
  const pending = new Map<string, Coord[]>();
  for (const id of wayIds) {
    const g = geom.get(id);
    if (g && g.length >= 2) pending.set(id, g);
  }
  if (pending.size === 0) return [];

  // Index way ends so we can walk the corridor instead of scanning repeatedly.
  const byEnd = new Map<string, string[]>();
  const index = (k: string, id: string) => {
    const list = byEnd.get(k);
    if (list) list.push(id); else byEnd.set(k, [id]);
  };
  for (const [id, g] of pending) {
    index(endpointKey(g[0]), id);
    index(endpointKey(g[g.length - 1]), id);
  }

  const take = (key: string): { id: string; coords: Coord[] } | null => {
    for (const id of byEnd.get(key) ?? []) {
      const g = pending.get(id);
      if (!g) continue;
      pending.delete(id);
      // Orient so the chain continues from `key`.
      return { id, coords: endpointKey(g[0]) === key ? g : [...g].reverse() };
    }
    return null;
  };

  const chains: Coord[][] = [];
  while (pending.size > 0) {
    const [seedId, seedGeom] = pending.entries().next().value as [string, Coord[]];
    pending.delete(seedId);
    let chain = [...seedGeom];

    // Extend forwards, then backwards from the seed.
    for (;;) {
      const next = take(endpointKey(chain[chain.length - 1]));
      if (!next) break;
      chain = chain.concat(next.coords.slice(1));
    }
    for (;;) {
      const prev = take(endpointKey(chain[0]));
      if (!prev) break;
      chain = [...prev.coords].reverse().slice(0, -1).concat(chain);
    }
    chains.push(chain);
  }
  return snapM > 0 ? stitchChains(chains, snapM) : chains;
}

/** Widest angle between two chain ends that still counts as carrying straight on. */
const STITCH_TURN = (25 * Math.PI) / 180;

/** The direction a chain would continue in, taken at one of its ends. */
function outwardBearing(chain: Coord[], atStart: boolean): number {
  return atStart
    ? bearing(chain[Math.min(1, chain.length - 1)], chain[0])
    : bearing(chain[chain.length - 2], chain[chain.length - 1]);
}

function stitchChains(chains: Coord[][], snapM: number): Coord[][] {
  // Every candidate join, shortest first, so a chain end takes its nearest
  // partner rather than whichever it happens to be compared with first.
  const joins: { from: string; to: string; gap: number }[] = [];
  const endKey = (chain: number, atStart: boolean) => `${chain}:${atStart}`;
  for (let a = 0; a < chains.length; a++) {
    for (let b = a + 1; b < chains.length; b++) {
      for (const aStart of [true, false]) {
        for (const bStart of [true, false]) {
          const ea = aStart ? chains[a][0] : chains[a][chains[a].length - 1];
          const eb = bStart ? chains[b][0] : chains[b][chains[b].length - 1];
          const gap = metres(ea, eb);
          if (gap > snapM) continue;
          // Carrying straight on means one chain leaves where the other arrives:
          // their outward directions are opposite.
          let turn = Math.abs(
            outwardBearing(chains[a], aStart) - outwardBearing(chains[b], bStart) - Math.PI,
          );
          while (turn > Math.PI) turn = Math.abs(turn - 2 * Math.PI);
          if (turn > STITCH_TURN) continue;
          joins.push({ from: endKey(a, aStart), to: endKey(b, bStart), gap });
        }
      }
    }
  }
  if (joins.length === 0) return chains;
  joins.sort((x, y) => x.gap - y.gap);

  // A piece remembers which original chain end sits at each of its own ends, so
  // a later join still knows which way round to turn it.
  interface Piece { coords: Coord[]; head: string; tail: string }
  const pieces = new Map<string, Piece>(); // keyed by both of its end keys
  const all: Piece[] = chains.map((coords, i) => ({
    coords, head: endKey(i, true), tail: endKey(i, false),
  }));
  for (const piece of all) { pieces.set(piece.head, piece); pieces.set(piece.tail, piece); }

  const live = new Set(all);
  const used = new Set<string>(); // an end can only be joined onto once
  for (const { from, to } of joins) {
    if (used.has(from) || used.has(to)) continue;
    const a = pieces.get(from)!, b = pieces.get(to)!;
    if (a === b) continue; // already one chain: joining would close a ring

    if (a.head === from) { a.coords.reverse(); [a.head, a.tail] = [a.tail, a.head]; }
    if (b.tail === to) { b.coords.reverse(); [b.head, b.tail] = [b.tail, b.head]; }
    a.coords = a.coords.concat(b.coords);
    a.tail = b.tail;
    pieces.set(a.tail, a);
    live.delete(b);
    used.add(from);
    used.add(to);
  }
  return [...live].map((p) => p.coords);
}

// ---------------------------------------------------------------------------
// Double-track collapse
// ---------------------------------------------------------------------------

/** A grid of line segments, queried for "is this point within `tol` of any of them". */
class SegmentIndex {
  private readonly cells = new Map<string, [Coord, Coord][]>();

  /** One cell is ~100 m tall and ~60 m wide in Germany - wider than any tolerance here. */
  private static readonly CELL = 0.0009;

  add(g: Coord[]): void {
    for (let i = 1; i < g.length; i++) {
      const seg: [Coord, Coord] = [g[i - 1], g[i]];
      const cx0 = Math.floor(Math.min(seg[0][0], seg[1][0]) / SegmentIndex.CELL);
      const cx1 = Math.floor(Math.max(seg[0][0], seg[1][0]) / SegmentIndex.CELL);
      const cy0 = Math.floor(Math.min(seg[0][1], seg[1][1]) / SegmentIndex.CELL);
      const cy1 = Math.floor(Math.max(seg[0][1], seg[1][1]) / SegmentIndex.CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = `${cx}:${cy}`;
          const cell = this.cells.get(key);
          if (cell) cell.push(seg); else this.cells.set(key, [seg]);
        }
      }
    }
  }

  /** True when `p` lies within `tol` metres of an indexed segment. */
  covers(p: Coord, tol: number): boolean {
    const cx = Math.floor(p[0] / SegmentIndex.CELL);
    const cy = Math.floor(p[1] / SegmentIndex.CELL);
    // Project to metres once, so the point-segment maths is plain Euclidean.
    const lonScale = M_PER_DEG * Math.cos((p[1] * Math.PI) / 180);
    const px = p[0] * lonScale, py = p[1] * M_PER_DEG;

    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const seg of this.cells.get(`${cx + i}:${cy + j}`) ?? []) {
          const ax = seg[0][0] * lonScale, ay = seg[0][1] * M_PER_DEG;
          const dx = seg[1][0] * lonScale - ax, dy = seg[1][1] * M_PER_DEG - ay;
          const len2 = dx * dx + dy * dy;
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
          if (Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) <= tol) return true;
        }
      }
    }
    return false;
  }
}

/** Way vertices plus enough intermediate points that no gap exceeds `step` metres. */
function samplePoints(g: Coord[], step: number): Coord[] {
  const out: Coord[] = [g[0]];
  let carry = 0;
  for (let i = 1; i < g.length; i++) {
    const d = metres(g[i - 1], g[i]);
    for (let pos = step - carry; pos < d; pos += step) {
      const t = pos / d;
      out.push([
        g[i - 1][0] + (g[i][0] - g[i - 1][0]) * t,
        g[i - 1][1] + (g[i][1] - g[i - 1][1]) * t,
      ]);
    }
    carry = d === 0 ? carry : (carry + d) % step;
    out.push(g[i]);
  }
  return out;
}

/** Compass bearing of the step from `from` to `to`, in radians. */
function bearing(from: Coord, to: Coord): number {
  return Math.atan2(to[1] - from[1], (to[0] - from[0]) * Math.cos((to[1] * Math.PI) / 180));
}

/**
 * Drop the ways of a line that only retrace ground the line already covers.
 *
 * OSM maps a double-track corridor as two ways a few metres apart, one per
 * direction of travel, and the two directional route relations reference
 * disjoint ways. A line unions both relations, so without this it is drawn as
 * two parallel strokes along the same street. Deduplicating way ids cannot help:
 * the two tracks share no ways at all.
 *
 * A way is dropped when *every* point along it is within `toleranceM` of a way
 * already kept. Requiring full coverage is what makes this safe: a way that
 * merely converges at one end - a crossover, a turnout, the entry to a terminal
 * loop - runs away from the kept track along the rest of its length and stays.
 * Nothing is ever dropped that is not already drawn by something kept, so the
 * corridor cannot develop a hole.
 *
 * Ways are walked in the order the track runs, not in the order they arrive:
 * from each kept way we continue with the straightest way out of its ends, which
 * is how a train would travel. That keeps the collapse on one track for the
 * length of the corridor instead of hopping to whichever track happens to hold
 * the next longest way, which would leave both tracks half-drawn and the line
 * shattered into fragments that no longer meet.
 *
 * Where the collapse does have to change track - the kept one ends, or was never
 * mapped - the crossover between them is itself covered and goes, and the two
 * kept stretches are left a track's width apart with nothing joining them. A
 * final pass puts those short connectors back: a dropped way returns if it is
 * the only thing linking two stretches that are now separate. It is short and it
 * runs under geometry that is already drawn, so it costs nothing visually and
 * buys back a line that reads as one line.
 *
 * `canonical` is how lines sharing a corridor end up on the *same* track. Run
 * over the whole network first, this returns one track per corridor; passed back
 * in per line, those ways are kept outright and everything else is measured
 * against them. Without it each line picks its own track and two lines down one
 * street land a track's width apart, which loses the bundling that draws them as
 * neat parallel bands. A way of the line's that the canonical choice does not
 * cover - a corridor it rides in one direction only, a tram beside a railway the
 * network-wide pass collapsed - is still kept, so this can only align lines, not
 * take ground away from one.
 */
export interface CollapseOptions {
  /**
   * The network-wide choice of track, from a first pass over every way any line
   * uses. Ways in it are kept outright and everything else is measured against
   * them, which is what puts lines sharing a corridor on the same ways.
   */
  canonical?: ReadonlySet<string>;
  /** How many lines run over a way; the busier track is the one worth keeping. */
  linesOn?: (wayId: string) => number;
}

export function collapseParallelTracks(
  wayIds: string[],
  geom: Map<string, Coord[]>,
  toleranceM: number,
  options: CollapseOptions = {},
): string[] {
  const { canonical, linesOn = () => 0 } = options;
  const ways = wayIds.filter((id) => (geom.get(id)?.length ?? 0) >= 2);
  if (ways.length === 0) return [];

  const byEnd = new Map<string, string[]>();
  for (const id of ways) {
    const g = geom.get(id)!;
    for (const end of [g[0], g[g.length - 1]]) {
      const key = endpointKey(end);
      const list = byEnd.get(key);
      if (list) list.push(id); else byEnd.set(key, [id]);
    }
  }

  const index = new SegmentIndex();
  const kept: string[] = [];
  const dropped: string[] = [];
  const decided = new Set<string>();
  // Busiest track first, then longest: where the two tracks of a corridor are
  // not carried by the same lines, the one more lines actually have is the one
  // to keep, since every line without it has to go its own way.
  const bestFirst = [...ways].sort((a, b) => {
    const busier = linesOn(b) - linesOn(a);
    if (busier !== 0) return busier;
    const longer = wayLength(geom.get(b)!) - wayLength(geom.get(a)!);
    return longer !== 0 ? longer : (a < b ? -1 : 1); // id break keeps rebuilds identical
  });

  // The network-wide choice comes first and unconditionally: it is already free
  // of duplicates, and everything below is then measured against it.
  for (const id of bestFirst) {
    if (!canonical?.has(id)) continue;
    decided.add(id);
    kept.push(id);
    index.add(geom.get(id)!);
  }

  for (const seed of bestFirst) {
    if (decided.has(seed)) continue;
    // Depth-first from the seed so we follow one track through the corridor.
    const stack = [seed];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (decided.has(id)) continue;
      decided.add(id);

      const g = geom.get(id)!;
      if (samplePoints(g, toleranceM).every((p) => index.covers(p, toleranceM))) {
        dropped.push(id);
        continue;
      }
      kept.push(id);
      index.add(g);

      // Push both ends' neighbours straightest-last, so the straightest pops first.
      const ends: [Coord, Coord][] = [[g[g.length - 1], g[g.length - 2]], [g[0], g[1]]];
      for (const [node, inbound] of ends) {
        const arriving = bearing(inbound, node);
        const neighbours = (byEnd.get(endpointKey(node)) ?? [])
          .filter((n) => n !== id && !decided.has(n))
          .map((n) => {
            const ng = geom.get(n)!;
            const leaving = endpointKey(ng[0]) === endpointKey(node)
              ? bearing(ng[0], ng[1])
              : bearing(ng[ng.length - 1], ng[ng.length - 2]);
            const turn = Math.abs(arriving - leaving);
            return { id: n, turn: turn > Math.PI ? 2 * Math.PI - turn : turn };
          })
          .sort((a, b) => b.turn - a.turn);
        for (const n of neighbours) stack.push(n.id);
      }
    }
  }
  return kept.concat(reconnectors(kept, dropped, geom, 2 * toleranceM));
}

/**
 * The dropped ways worth having back: the shortest ones that each join two
 * stretches of kept track nothing else connects. Longer than a crossover and a
 * restored way would start redrawing the track it was dropped for, so the search
 * is capped at `maxLengthM`, and stretches left apart by a genuine hole in the
 * data - a way the extract never carried - stay apart, since no dropped way
 * bridges them either.
 */
function reconnectors(
  kept: string[],
  dropped: string[],
  geom: Map<string, Coord[]>,
  maxLengthM: number,
): string[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(id) !== root) { const next = parent.get(id)!; parent.set(id, root); id = next; }
    return root;
  };
  // One way per node end; joining a way to whoever already claimed its ends
  // merges the two into a single stretch.
  const claimed = new Map<string, string>();
  const join = (id: string) => {
    parent.set(id, id);
    const g = geom.get(id)!;
    for (const end of [g[0], g[g.length - 1]]) {
      const key = endpointKey(end);
      const owner = claimed.get(key);
      if (owner) {
        const a = find(id), b = find(owner);
        if (a !== b) parent.set(a, b);
      } else {
        claimed.set(key, id);
      }
    }
  };
  for (const id of kept) join(id);

  const restored: string[] = [];
  const candidates = dropped
    .filter((id) => wayLength(geom.get(id)!) <= maxLengthM)
    .sort((a, b) => wayLength(geom.get(a)!) - wayLength(geom.get(b)!));
  for (const id of candidates) {
    const g = geom.get(id)!;
    const from = claimed.get(endpointKey(g[0]));
    const to = claimed.get(endpointKey(g[g.length - 1]));
    if (!from || !to || find(from) === find(to)) continue;
    join(id);
    restored.push(id);
  }
  return restored;
}

function wayLength(g: Coord[]): number {
  let sum = 0;
  for (let i = 1; i < g.length; i++) sum += metres(g[i - 1], g[i]);
  return sum;
}

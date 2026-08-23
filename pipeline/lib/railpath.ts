/**
 * Putting a closure on the track it actually closes.
 *
 * DB InfraGO states a restriction as two operating points and a line number -
 * "Meinerzhagen to Krummenerl on line 2815" - and gives a coordinate for each
 * end. Drawing the straight line between them is what strecken.info itself
 * falls back to, and it is wrong in a way that matters on a geographic map:
 * over half the restrictions in a day's feed span more than 6 km and some span
 * 125, so the chord leaves the railway entirely and lies across whatever
 * happens to be in the way.
 *
 * The extract already contains every railway way in the country, so the honest
 * geometry is available: treat the ways as a graph, snap each end of the
 * closure to it, and take the shortest path. Two things keep that path on the
 * right line rather than on a plausible parallel one:
 *
 *   - German railway ways carry the VzG line number in `ref`, the same number
 *     the closure states, so ways off the stated line are made expensive rather
 *     than forbidden - expensive, because `ref` coverage is only about half and
 *     a hard filter would simply lose the closures whose line is untagged.
 *   - Yard and siding tracks (`service=*`) are made expensive too. They connect
 *     things the running line does not, and a shortest path is happy to cut
 *     through a goods yard to save 200 m.
 *
 * When no path is found - the ends are on unmapped track, or on two networks
 * with no rail connection between them - the caller is told, and says so, rather
 * than being handed a chord that looks like track.
 */

export type Coord = [number, number];

export interface RailWay {
  id: string;
  coords: Coord[];
  /** OSM `ref`, which on a German railway way is its VzG line number(s). */
  ref?: string;
  /** OSM `service` - `siding`, `yard`, `spur`, `crossover`. */
  service?: string;
}

const M_PER_DEG = 111320;

/** Equirectangular approximation; over a single way the error is negligible. */
export function metres(a: Coord, b: Coord): number {
  const dx = (a[0] - b[0]) * M_PER_DEG * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot(dx, (a[1] - b[1]) * M_PER_DEG);
}

function length(coords: Coord[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += metres(coords[i - 1], coords[i]);
  return total;
}

/**
 * Vertex identity. Rounded to about 10 cm, which is far finer than the gap
 * between two parallel tracks and coarse enough that two ways OSM joins at one
 * node always compare equal, whatever floating point did to the export.
 */
const nodeKey = (c: Coord) => `${Math.round(c[0] * 1e6)},${Math.round(c[1] * 1e6)}`;

interface Edge {
  to: number;
  wayId: string;
  metres: number;
  /** VzG numbers this way is tagged with, or null - most ways carry none. */
  refs: number[] | null;
  service: boolean;
  /** The way's own geometry, shared by both directed edges. */
  coords: Coord[];
  /** Whether traversing from this edge's own node runs along `coords`. */
  forward: boolean;
}

/**
 * How much longer an off-line or yard detour has to look before the search
 * takes it. Four is enough to keep a path on its stated line wherever the line
 * is tagged - 52% of German heavy-rail ways carry `ref` - and small enough that
 * a genuine gap in that tagging, a few hundred metres through a station throat
 * say, does not push the path onto a different railway altogether.
 */
const OFF_LINE_PENALTY = 4;
const SERVICE_PENALTY = 4;

/** Grid cell for the endpoint index, in degrees - roughly 1 km of latitude. */
const CELL = 0.01;

export interface RailGraph {
  nodes: Coord[];
  edges: Edge[][];
  /** Grid index over node positions, for snapping a closure end to the graph. */
  cells: Map<string, number[]>;
}

/**
 * VzG numbers out of an OSM `ref`, which may hold several (`6100;6107`), or
 * null for the half of the network that carries none.
 *
 * An array rather than a `Set`, and null rather than an empty one: this is the
 * single most numerous object in the graph - one per way segment, 288k of them
 * nationally - and it holds one or two numbers that are scanned, never looked
 * up. A `Set` per segment costs far more than the scan saves.
 */
function parseRefs(ref: string | undefined): number[] | null {
  if (!ref) return null;
  const out: number[] = [];
  for (const token of ref.split(/[;,]/)) {
    const n = Number.parseInt(token.trim(), 10);
    if (Number.isFinite(n)) out.push(n);
  }
  return out.length ? out : null;
}

const cellKey = (c: Coord) => `${Math.floor(c[0] / CELL)}:${Math.floor(c[1] / CELL)}`;

/**
 * Build the routable graph.
 *
 * The one subtlety is where a way is allowed to connect to another. Joining
 * ways only at their two ends looks right - OSM convention is to split a way
 * where something joins it - but the convention is not the data: a branch or a
 * siding routinely *ends* on a node partway along an unsplit main line, and a
 * graph that ignores those nodes leaves that main line as a single edge with no
 * way on or off it. Measured on the Niedersachsen extract, only 30 of 107
 * routable closures found a path until this was fixed.
 *
 * So the ways are read twice: once to collect every way's two endpoints, then
 * once more to cut each way wherever another way ends on it. That is cheap -
 * the endpoint set is two entries per way, not one per vertex - and it catches
 * every junction that a train could actually take. What it does not catch is
 * two ways crossing at a shared node with neither of them ending there, which
 * is a flat crossing: not a connection a train can use anyway.
 */
export function buildRailGraph(ways: Iterable<RailWay>): RailGraph {
  const all = [...ways].filter((w) => w.coords.length >= 2);

  const wayEnds = new Set<string>();
  for (const way of all) {
    wayEnds.add(nodeKey(way.coords[0]));
    wayEnds.add(nodeKey(way.coords[way.coords.length - 1]));
  }

  const nodes: Coord[] = [];
  const edges: Edge[][] = [];
  const byKey = new Map<string, number>();
  const cells = new Map<string, number[]>();

  const node = (c: Coord): number => {
    const key = nodeKey(c);
    let id = byKey.get(key);
    if (id === undefined) {
      id = nodes.length;
      byKey.set(key, id);
      nodes.push(c);
      edges.push([]);
      const ck = cellKey(c);
      const bucket = cells.get(ck);
      if (bucket) bucket.push(id);
      else cells.set(ck, [id]);
    }
    return id;
  };

  const link = (way: RailWay, piece: Coord[]) => {
    const a = node(piece[0]);
    const b = node(piece[piece.length - 1]);
    // A closed loop gets a train back where it started and nowhere else, so it
    // would only add a zero-progress self-edge to the search.
    if (a === b) return;
    const edge = {
      wayId: way.id,
      metres: length(piece),
      refs: parseRefs(way.ref),
      service: !!way.service,
      coords: piece,
    };
    edges[a].push({ ...edge, to: b, forward: true });
    edges[b].push({ ...edge, to: a, forward: false });
  };

  for (const way of all) {
    let start = 0;
    for (let i = 1; i < way.coords.length - 1; i++) {
      if (!wayEnds.has(nodeKey(way.coords[i]))) continue;
      link(way, way.coords.slice(start, i + 1));
      start = i;
    }
    link(way, start === 0 ? way.coords : way.coords.slice(start));
  }

  return { nodes, edges, cells };
}

/** Nearest graph node to `point`, or null if none is within `maxM`. */
export function nearestNode(graph: RailGraph, point: Coord, maxM: number): number | null {
  const reach = Math.ceil(maxM / (CELL * M_PER_DEG)) + 1;
  const cx = Math.floor(point[0] / CELL);
  const cy = Math.floor(point[1] / CELL);

  let best: number | null = null;
  let bestD = maxM;
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dy = -reach; dy <= reach; dy++) {
      for (const id of graph.cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
        const d = metres(point, graph.nodes[id]);
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
    }
  }
  return best;
}

/**
 * A binary min-heap keyed on cost. `Array.sort` on every pop turned the
 * national run from seconds into minutes; the queue is the whole hot loop.
 */
class Heap {
  private cost: number[] = [];
  private item: number[] = [];

  get size() {
    return this.item.length;
  }

  push(item: number, cost: number) {
    this.cost.push(cost);
    this.item.push(item);
    let i = this.item.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.cost[parent] <= this.cost[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): { item: number; cost: number } {
    const top = { item: this.item[0], cost: this.cost[0] };
    const lastItem = this.item.pop()!;
    const lastCost = this.cost.pop()!;
    if (this.item.length) {
      this.item[0] = lastItem;
      this.cost[0] = lastCost;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let small = i;
        if (l < this.cost.length && this.cost[l] < this.cost[small]) small = l;
        if (r < this.cost.length && this.cost[r] < this.cost[small]) small = r;
        if (small === i) break;
        this.swap(small, i);
        i = small;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    [this.cost[a], this.cost[b]] = [this.cost[b], this.cost[a]];
    [this.item[a], this.item[b]] = [this.item[b], this.item[a]];
  }
}

export interface RoutedPath {
  coords: Coord[];
  /** True track distance along the path, in metres. */
  metres: number;
  /** Ways used, in order - the caller uses these to trim the ends. */
  wayIds: string[];
}

export interface RouteOptions {
  /** VzG numbers the closure states. Ways off them cost more, never nothing. */
  routes?: number[];
  /** How far a closure end may be from the network before it is unmatchable. */
  snapM?: number;
  /**
   * Cost ceiling, as a multiple of the straight-line distance plus a floor for
   * the short ones. Without it a pair of ends with no rail connection between
   * them - two closures either side of a border, an end snapped onto an
   * isolated siding - walks the whole national graph before giving up.
   */
  detourFactor?: number;
  detourFloorM?: number;
}

/**
 * Shortest on-network path between two points, or null when there is none
 * within the search bound.
 */
export function routeBetween(
  graph: RailGraph,
  from: Coord,
  to: Coord,
  options: RouteOptions = {},
): RoutedPath | null {
  const { routes = [], snapM = 2000, detourFactor = 3.5, detourFloorM = 8000 } = options;

  const start = nearestNode(graph, from, snapM);
  const goal = nearestNode(graph, to, snapM);
  if (start === null || goal === null || start === goal) return null;

  const wanted = new Set(routes);
  const budget =
    Math.max(detourFloorM, metres(from, to) * detourFactor) * (wanted.size ? OFF_LINE_PENALTY : 1);

  const best = new Map<number, number>([[start, 0]]);
  const cameFrom = new Map<number, { node: number; edge: Edge }>();
  const queue = new Heap();
  queue.push(start, 0);

  while (queue.size) {
    const { item: node, cost } = queue.pop();
    if (node === goal) return trimTo(reconstruct(cameFrom, start, goal), from, to);
    if (cost > (best.get(node) ?? Infinity)) continue; // stale queue entry
    if (cost > budget) break; // everything left in the queue costs at least this

    for (const edge of graph.edges[node]) {
      let weight = edge.metres;
      // A way with no `ref` at all is not evidence of being off the line - most
      // of the network is untagged - so only a way tagged with a *different*
      // line is penalised.
      if (wanted.size && edge.refs && !edge.refs.some((r) => wanted.has(r))) {
        weight *= OFF_LINE_PENALTY;
      }
      if (edge.service) weight *= SERVICE_PENALTY;

      const next = cost + weight;
      if (next >= (best.get(edge.to) ?? Infinity)) continue;
      best.set(edge.to, next);
      cameFrom.set(edge.to, { node, edge });
      queue.push(edge.to, next);
    }
  }

  return null;
}

/**
 * Walk the search back to the start, laying out each way's own geometry rather
 * than a line between its ends: a way is split only at junctions, so a
 * kilometre of curve can sit between two nodes and joining the nodes directly
 * would cut every corner on the route.
 */
function reconstruct(
  cameFrom: Map<number, { node: number; edge: Edge }>,
  start: number,
  goal: number,
): RoutedPath {
  const steps: Edge[] = [];
  for (let node = goal; node !== start;) {
    const step = cameFrom.get(node)!;
    steps.push(step.edge);
    node = step.node;
  }
  steps.reverse();

  const coords: Coord[] = [];
  const wayIds: string[] = [];
  for (const edge of steps) {
    const piece = edge.forward ? edge.coords : [...edge.coords].reverse();
    // The shared node is already the last coordinate written.
    coords.push(...(coords.length ? piece.slice(1) : piece));
    wayIds.push(edge.wayId);
  }
  return { coords, metres: length(coords), wayIds };
}

/**
 * Cut the path back to the stretch the closure actually covers.
 *
 * Both ends were snapped to a junction, and a junction can be some way past the
 * operating point the closure names - a way is only split where something joins
 * it, so an intermediate station sits mid-way. Trimming to the vertex nearest
 * each stated end stops a two-station possession from being drawn across four.
 * Only ever a trim: if the nearest vertices come out in the wrong order the
 * path is left whole rather than reversed or emptied.
 */
function trimTo(path: RoutedPath, from: Coord, to: Coord): RoutedPath {
  const nearest = (target: Coord) => {
    let best = 0;
    let bestD = Infinity;
    path.coords.forEach((c, i) => {
      const d = metres(c, target);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const a = nearest(from);
  const b = nearest(to);
  if (a >= b) return path;
  const coords = path.coords.slice(a, b + 1);
  return { coords, metres: length(coords), wayIds: path.wayIds };
}

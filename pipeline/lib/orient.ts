/**
 * One physical band, one physical side.
 *
 * A slot is a signed ordinal and `line-offset` applies it perpendicular to a
 * feature's *own* direction of travel, so a slot only names a physical band
 * once the chain carrying it has a direction agreed with its neighbours.
 * `chainWays` gives it no such thing: it seeds each chain from whichever way
 * came first out of a map and walks outward, so two stretches of one corridor
 * are stitched in whichever directions their seeds happened to face.
 *
 * Where two consecutive stretches disagree, `+s` in the first is the band
 * opposite `+s` in the second, and the bundle mirrors at the seam: every line
 * in it steps sideways to the band on the far side, the outermost pair
 * swapping the width of the whole bundle. The taper machinery then reads that
 * as a real slot change and ramps each line across the bundle to meet it,
 * which draws the seam as a bundle-wide diagonal braid rather than closing it.
 * Station marks mirror with it - `crossBearing` keeps the sign of the heading
 * for exactly this reason - so a bar on a mirrored stretch covers the mirror
 * image of the lines that actually stop.
 *
 * The fix is upstream of all of that: agree the directions first, and a slot
 * means one side for as long as the geometry runs. Two chain ends that meet at
 * a point and carry on in the same direction constrain their chains to agree;
 * ends that meet head-on constrain them to disagree. That is a parity system
 * over the chains, and a union-find with a parity bit solves it in one pass.
 *
 * What it cannot solve, it leaves alone. Constraints are taken most-collinear
 * first, so a fork's straight-through pair is settled before its branch, and
 * one that contradicts what is already established - the odd cycle a balloon
 * loop makes, where a chain must disagree with itself - is dropped rather than
 * propagated. Ends meeting at more than `minAlign` apart are not a corridor
 * carrying on at all and are never constrained.
 */

import { endpointKey, metres, type Coord } from './track.ts';

export type { Coord };

/**
 * How straight two chain ends have to run into each other to count as one
 * corridor carrying on, as the dot product of their directions of travel.
 * 0.5 is 60 degrees: wide enough to hold a junction's diverging branch to the
 * same side as its trunk, tight enough that two alignments merely crossing at
 * a point never drag each other's bundles around.
 */
const MIN_ALIGN = 0.5;

/**
 * How much of a chain's end the direction is measured over, in metres. A
 * single vertex pair is whatever the last OSM node happened to be - often a
 * metre of platform edge or switch detail, pointing somewhere the corridor
 * does not go. Averaging over a short run of the end reads the alignment
 * instead of the noise, and 25 m is shorter than any junction spacing this
 * has to tell apart.
 */
const DIRECTION_SPAN_M = 25;

export interface CoorientOptions {
  minAlign?: number;
  directionSpanM?: number;
}

/**
 * Unit direction of travel along `chain` at one of its ends, measured over
 * `spanM` metres of it - pointing *forwards along the chain* at both ends, so
 * two ends agree exactly when their chains agree.
 *
 * Scaled to metres before normalising, so a direction at 52 degrees north is
 * not stretched by the 1.6:1 the raw degrees would give it.
 */
export function endDirection(chain: Coord[], atStart: boolean, spanM = DIRECTION_SPAN_M): [number, number] {
  const near = atStart ? chain[0] : chain[chain.length - 1];
  let far = atStart ? chain[1] : chain[chain.length - 2];
  let acc = 0;
  const step = atStart ? 1 : -1;
  let i = atStart ? 0 : chain.length - 1;
  while (i + step >= 0 && i + step < chain.length) {
    acc += metres(chain[i], chain[i + step]);
    far = chain[i + step];
    if (acc >= spanM) break;
    i += step;
  }

  const kx = Math.cos((near[1] * Math.PI) / 180);
  // Forwards along the chain: away from the start, towards the end.
  const dx = (far[0] - near[0]) * kx * (atStart ? 1 : -1);
  const dy = (far[1] - near[1]) * (atStart ? 1 : -1);
  const n = Math.hypot(dx, dy);
  return n === 0 ? [0, 0] : [dx / n, dy / n];
}

/** Total length of a chain in metres - what picks a component's anchor. */
function chainLength(chain: Coord[]): number {
  let sum = 0;
  for (let i = 1; i < chain.length; i++) sum += metres(chain[i - 1], chain[i]);
  return sum;
}

/**
 * Whether a chain runs the canonical way: eastwards, or northwards when it
 * runs too close to due north-south for east to decide.
 */
function runsCanonically(chain: Coord[]): boolean {
  const a = chain[0], b = chain[chain.length - 1];
  const east = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180);
  const north = b[1] - a[1];
  if (Math.abs(east) > Math.abs(north)) return east >= 0;
  return north >= 0;
}

/** Union-find over chain indices carrying a parity bit against the root. */
function parityUnion(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const parity = new Array<number>(n).fill(0); // parity of i relative to parent[i]
  const rank = new Array<number>(n).fill(0);

  const find = (i: number): [number, number] => {
    let root = i;
    let p = 0;
    while (parent[root] !== root) { p ^= parity[root]; root = parent[root]; }
    // Second walk compresses the path, rewriting each parity against the root.
    let node = i;
    let acc = p;
    while (parent[node] !== node) {
      const next = parent[node];
      const nextAcc = acc ^ parity[node];
      parent[node] = root;
      parity[node] = acc;
      node = next;
      acc = nextAcc;
    }
    return [root, p];
  };

  /**
   * Constrain `a` and `b` to differ by `want` (0 = agree, 1 = disagree).
   * Returns false when that contradicts what is already established, in which
   * case nothing is changed.
   */
  const union = (a: number, b: number, want: number): boolean => {
    const [ra, pa] = find(a);
    const [rb, pb] = find(b);
    if (ra === rb) return (pa ^ pb) === want;
    const rel = pa ^ pb ^ want;
    if (rank[ra] < rank[rb]) { parent[ra] = rb; parity[ra] = rel; }
    else {
      parent[rb] = ra;
      parity[rb] = rel;
      if (rank[ra] === rank[rb]) rank[ra]++;
    }
    return true;
  };

  return { find, union };
}

/**
 * Decide which of `chains` to reverse so that every pair of chain ends that
 * meet and carry on in the same direction ends up drawn the same way round.
 *
 * Returns one flag per input chain, `true` meaning "reverse this one". A chain
 * with fewer than two points is never reversed and never constrains anything.
 */
export function coorientChains(
  chains: readonly Coord[][],
  opts: CoorientOptions = {},
): boolean[] {
  const { minAlign = MIN_ALIGN, directionSpanM = DIRECTION_SPAN_M } = opts;
  const n = chains.length;
  const flips = new Array<boolean>(n).fill(false);
  if (n === 0) return flips;

  interface End { chain: number; dir: [number, number] }
  const byPoint = new Map<string, End[]>();
  for (let i = 0; i < n; i++) {
    const chain = chains[i];
    if (chain.length < 2) continue;
    for (const atStart of [true, false]) {
      const dir = endDirection(chain as Coord[], atStart, directionSpanM);
      if (dir[0] === 0 && dir[1] === 0) continue;
      const key = endpointKey(atStart ? chain[0] : chain[chain.length - 1]);
      const list = byPoint.get(key);
      if (list) list.push({ chain: i, dir }); else byPoint.set(key, [{ chain: i, dir }]);
    }
  }

  // Every pair of ends that could be one corridor carrying on. `align` is the
  // dot product of the two directions of travel: positive means the chains
  // already agree, negative that one of them has to be turned round.
  const constraints: { a: number; b: number; want: number; align: number }[] = [];
  for (const ends of byPoint.values()) {
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        if (ends[i].chain === ends[j].chain) continue; // a chain closing on itself
        const align = ends[i].dir[0] * ends[j].dir[0] + ends[i].dir[1] * ends[j].dir[1];
        if (Math.abs(align) < minAlign) continue;
        constraints.push({
          a: Math.min(ends[i].chain, ends[j].chain),
          b: Math.max(ends[i].chain, ends[j].chain),
          want: align > 0 ? 0 : 1,
          align: Math.abs(align),
        });
      }
    }
  }

  // Straightest first, so a fork settles its through pair before its branch
  // and a contradiction is dropped from the weaker evidence rather than the
  // stronger. The index tiebreak keeps rebuilds identical.
  constraints.sort((x, y) => y.align - x.align || x.a - y.a || x.b - y.b);

  const uf = parityUnion(n);
  for (const c of constraints) uf.union(c.a, c.b, c.want);

  // The constraints only tie a component's chains to each other; which way the
  // component as a whole faces is still free, and something has to choose or
  // the answer depends on which chain the union-find happened to root. Choose
  // by length: leave the component the way round that has more of its own
  // metres running canonically. A single anchor chain would do as well on any
  // one build and far worse across builds - the longest chain in a component
  // spanning half a country changes with the data, and taking it with it would
  // mirror every bundle in that half. A majority of the metres does not move
  // for anything short of the corridor itself being redrawn.
  const canonicalM = new Map<number, number>(); // metres already running canonically
  const totalM = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (chains[i].length < 2) continue;
    const [root, parity] = uf.find(i);
    const len = chainLength(chains[i] as Coord[]);
    // How this chain would run if the component were left alone (base flip
    // false): reversed exactly when its parity against the root says so.
    const canonicalIfKept = runsCanonically(chains[i] as Coord[]) !== (parity === 1);
    totalM.set(root, (totalM.get(root) ?? 0) + len);
    if (canonicalIfKept) canonicalM.set(root, (canonicalM.get(root) ?? 0) + len);
  }

  for (let i = 0; i < n; i++) {
    if (chains[i].length < 2) continue;
    const [root, parity] = uf.find(i);
    // Turn the whole component round only if that puts more of it canonical;
    // a tie keeps it as found, which is deterministic for a given input.
    const kept = canonicalM.get(root) ?? 0;
    const base = kept * 2 < (totalM.get(root) ?? 0);
    flips[i] = base !== (parity === 1);
  }
  return flips;
}

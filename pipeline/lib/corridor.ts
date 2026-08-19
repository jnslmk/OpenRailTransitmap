/**
 * Corridor-wide slot assignment.
 *
 * `slotOffset` (see taper.ts) is cheap to compute per bundle segment, but a
 * segment only knows the lines *it* carries: when a line joins or leaves the
 * corridor, every line outboard of it is renumbered, even though nothing
 * about their own alignment changed. This module gives a line one slot for as
 * long as it stays in the same corridor, so that renumbering - and the taper
 * it forces - only happens where the corridor itself genuinely changes.
 *
 * The approach in two steps:
 *
 *   1. `groupCorridors` unions adjacent bundle segments into corridors, but
 *      only where they carry substantially the same lines. This is a
 *      correctness-critical bound, not a tuning nicety: adjacency alone
 *      ("touches the next segment") chains transitively across the whole
 *      network, because every junction touches the next one. Two guards stop
 *      that: a per-junction overlap threshold (segments merge only when most
 *      of the smaller one's lines are also in the larger one), and a hard cap
 *      on how many distinct lines a single corridor may accumulate, checked
 *      at every merge so a long run of individually-plausible merges still
 *      cannot blow a corridor up.
 *
 *   2. `rankCorridorLines` sorts each corridor's line union with the same
 *      comparator the segment-level bundling already uses, once per corridor
 *      rather than once per segment. Combined with `slotOffset`, a line's
 *      slot is then its rank within that single sort - fixed for the whole
 *      corridor, and centred on zero by construction (the same centring
 *      `slotOffset` already gives a per-segment bundle), so there is no
 *      separate re-normalisation step to get right.
 *
 * A segment whose lines never satisfy the overlap threshold with any
 * neighbour is its own one-segment corridor - slot assignment for it is then
 * identical to the old per-segment scheme, so the corridor-wide scheme never
 * makes an isolated segment worse.
 */

import { endpointKey, type Coord } from './track.ts';

export type { Coord };

/**
 * Unordered pairs of segment indices whose chains share an endpoint - the
 * physical junctions where a corridor could plausibly continue from one
 * segment into the next.
 */
export function adjacentSegmentPairs(
  segments: readonly { chains: readonly Coord[][] }[],
): [number, number][] {
  const bySeg = new Map<string, Set<number>>();
  segments.forEach((seg, segIdx) => {
    for (const chain of seg.chains) {
      if (chain.length === 0) continue;
      for (const end of [chain[0], chain[chain.length - 1]]) {
        const key = endpointKey(end);
        const set = bySeg.get(key);
        if (set) set.add(segIdx); else bySeg.set(key, new Set([segIdx]));
      }
    }
  });

  const seen = new Set<string>();
  const pairs: [number, number][] = [];
  for (const segs of bySeg.values()) {
    if (segs.size < 2) continue;
    const arr = [...segs].sort((a, b) => a - b);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = `${arr[i]}:${arr[j]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([arr[i], arr[j]]);
      }
    }
  }
  return pairs;
}

export interface GroupCorridorsOptions {
  /**
   * How much of the smaller segment's line set must also be in the larger
   * one for the pair to merge, as a fraction. Judged on the two segments'
   * own membership at that junction, not on the corridor each has grown
   * into so far - a corridor's overlap with a fresh neighbour naturally
   * shrinks as it accumulates lines, which would make merging steadily
   * easier to satisfy for no reason connected to the junction itself.
   */
  minOverlap?: number;
  /**
   * Hard ceiling on the number of distinct lines a corridor may carry across
   * its whole run. Checked at every merge, so a chain of individually
   * plausible merges still cannot union the network transitively - the
   * failure mode `minOverlap` alone does not stop, since each step in a long
   * chain can look locally fine while the ends of the chain share nothing.
   */
  maxCorridorLines?: number;
}

/**
 * Union adjacent segments into corridors. Returns one corridor id per
 * segment (its array index), where the id is the lowest segment index in
 * that corridor - stable and deterministic across rebuilds regardless of the
 * order `pairs` arrives in.
 */
export function groupCorridors(
  lineIdsBySeg: readonly (readonly string[])[],
  pairs: readonly (readonly [number, number])[],
  opts: GroupCorridorsOptions = {},
): number[] {
  const { minOverlap = 0.8, maxCorridorLines = 12 } = opts;
  const n = lineIdsBySeg.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const corridorLines: Set<string>[] = lineIdsBySeg.map((ids) => new Set(ids));

  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) { const next = parent[i]; parent[i] = root; i = next; }
    return root;
  };

  const overlapRatio = (a: readonly string[], b: readonly string[]): number => {
    if (a.length === 0 || b.length === 0) return 0;
    const setB = new Set(b);
    let shared = 0;
    for (const id of a) if (setB.has(id)) shared++;
    return shared / Math.min(a.length, b.length);
  };

  // Strongest evidence first, then a deterministic tiebreak: the merge order
  // only matters for which pair first bumps a corridor up against the line
  // cap, so it has to be reproducible rather than dependent on `pairs`' order.
  const scored = pairs
    .map(([a, b]) => ({ a, b, overlap: overlapRatio(lineIdsBySeg[a], lineIdsBySeg[b]) }))
    .filter((e) => e.overlap >= minOverlap)
    .sort((x, y) => y.overlap - x.overlap || x.a - y.a || x.b - y.b);

  for (const { a, b } of scored) {
    const ra = find(a), rb = find(b);
    if (ra === rb) continue;
    const merged = new Set([...corridorLines[ra], ...corridorLines[rb]]);
    if (merged.size > maxCorridorLines) continue; // would blow the corridor up - leave both sides as they are

    const keep = Math.min(ra, rb), drop = Math.max(ra, rb);
    parent[drop] = keep;
    corridorLines[keep] = merged;
  }

  return Array.from({ length: n }, (_, i) => find(i));
}

/**
 * The union of lines in each corridor, sorted once with `compare` - the same
 * comparator the caller uses to order a segment's own members, so a line's
 * rank here agrees with where it would have sorted locally. Combine with
 * `slotOffset(rank, sorted.length)` (taper.ts) for the corridor-wide slot.
 */
export function rankCorridorLines(
  corridorOf: readonly number[],
  lineIdsBySeg: readonly (readonly string[])[],
  compare: (a: string, b: string) => number,
): Map<number, string[]> {
  const byRoot = new Map<number, Set<string>>();
  corridorOf.forEach((root, segIdx) => {
    let set = byRoot.get(root);
    if (!set) { set = new Set<string>(); byRoot.set(root, set); }
    for (const id of lineIdsBySeg[segIdx]) set.add(id);
  });

  const ranked = new Map<number, string[]>();
  for (const [root, set] of byRoot) ranked.set(root, [...set].sort(compare));
  return ranked;
}

/**
 * Corridor grouping is the part of the slot-lattice change that can go wrong
 * silently: adjacency alone chains transitively across the whole network, so
 * these fixtures pin the two guards - per-junction overlap and a hard line
 * cap - that keep a corridor from blowing up, plus the ranking step that
 * turns a corridor's line union into one fixed order.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjacentSegmentPairs, groupCorridors, rankCorridorLines, type Coord,
} from './lib/corridor.ts';

const refCompare = (a: string, b: string) => a.localeCompare(b, 'de', { numeric: true });

test('adjacentSegmentPairs links segments whose chains share an endpoint', () => {
  const segments = [
    { chains: [[[0, 0], [1, 0]] as Coord[]] },
    { chains: [[[1, 0], [2, 0]] as Coord[]] }, // touches segment 0 at (1,0)
    { chains: [[[5, 5], [6, 5]] as Coord[]] }, // isolated
  ];
  const pairs = adjacentSegmentPairs(segments);
  assert.deepEqual(pairs, [[0, 1]]);
});

test('adjacentSegmentPairs dedupes a pair touching at both ends', () => {
  // A short loop: segments 0 and 1 share both their start and end nodes.
  const segments = [
    { chains: [[[0, 0], [1, 1]] as Coord[]] },
    { chains: [[[0, 0], [1, 1]] as Coord[]] },
  ];
  const pairs = adjacentSegmentPairs(segments);
  assert.deepEqual(pairs, [[0, 1]]);
});

test('adjacentSegmentPairs ignores an empty chain list', () => {
  const segments = [{ chains: [] as Coord[][] }, { chains: [[[0, 0], [1, 0]] as Coord[]] }];
  assert.deepEqual(adjacentSegmentPairs(segments), []);
});

test('groupCorridors merges segments that carry the same lines', () => {
  const lineIdsBySeg = [['1', '2', '3'], ['1', '2', '3'], ['1', '2', '3']];
  const pairs: [number, number][] = [[0, 1], [1, 2]];
  const corridorOf = groupCorridors(lineIdsBySeg, pairs);
  assert.equal(corridorOf[0], corridorOf[1]);
  assert.equal(corridorOf[1], corridorOf[2]);
});

test('groupCorridors keeps segments apart below the overlap threshold', () => {
  // Segment 1 shares only one of three lines with segment 0 - a branch
  // point, not a continuation of the same corridor.
  const lineIdsBySeg = [['1', '2', '3'], ['3', '4', '5']];
  const corridorOf = groupCorridors(lineIdsBySeg, [[0, 1]], { minOverlap: 0.5 });
  assert.notEqual(corridorOf[0], corridorOf[1]);
});

test('groupCorridors merges a line joining or leaving a stable trunk', () => {
  // Segment 1 is segment 0 plus one extra line - overlap is 3/3 = 1 measured
  // against the smaller side, so a line joining the corridor does not by
  // itself block the merge.
  const lineIdsBySeg = [['1', '2', '3'], ['1', '2', '3', '4']];
  const corridorOf = groupCorridors(lineIdsBySeg, [[0, 1]], { minOverlap: 0.5 });
  assert.equal(corridorOf[0], corridorOf[1]);
});

test('groupCorridors does not transitively chain across weak links', () => {
  // 0-1 and 1-2 individually clear the threshold, but 0 and 2 share nothing.
  // A naive "adjacent and share >=1 line" rule would still chain all three
  // into one corridor; the overlap threshold must stop it segment-by-segment,
  // not just at the ends.
  const lineIdsBySeg = [
    ['1', '2'],
    ['2', '3'],
    ['3', '4'],
  ];
  const corridorOf = groupCorridors(lineIdsBySeg, [[0, 1], [1, 2]], { minOverlap: 0.9 });
  assert.notEqual(corridorOf[0], corridorOf[1]);
  assert.notEqual(corridorOf[1], corridorOf[2]);
});

test('groupCorridors caps corridor size even when every merge clears the overlap bar', () => {
  // Segments 0-1 share enough to merge (union = {1,2,3,4}, size 4, within
  // the cap); merging that corridor with 2 would push the union to
  // {1,2,3,4,5,6,7} = 7, over a cap of 4, so nothing but the cap stops it.
  const lineIdsBySeg = [
    ['1', '2', '3'],
    ['1', '2', '3', '4'],
    ['4', '5', '6', '7'],
  ];
  const corridorOf = groupCorridors(lineIdsBySeg, [[0, 1], [1, 2]], { minOverlap: 0.5, maxCorridorLines: 4 });
  assert.equal(corridorOf[0], corridorOf[1]);
  assert.notEqual(corridorOf[1], corridorOf[2]);
});

test('groupCorridors corridor id is deterministic regardless of pair order', () => {
  const lineIdsBySeg = [['1'], ['1'], ['1']];
  const forward = groupCorridors(lineIdsBySeg, [[0, 1], [1, 2]]);
  const backward = groupCorridors(lineIdsBySeg, [[1, 2], [0, 1]]);
  assert.deepEqual(forward, backward);
});

test('groupCorridors leaves an isolated segment as its own corridor', () => {
  const lineIdsBySeg = [['1', '2']];
  const corridorOf = groupCorridors(lineIdsBySeg, []);
  assert.deepEqual(corridorOf, [0]);
});

test('rankCorridorLines sorts the union of a corridor once, by the given comparator', () => {
  const corridorOf = [0, 0, 0];
  const lineIdsBySeg = [['3', '1'], ['2'], ['10']];
  const ranked = rankCorridorLines(corridorOf, lineIdsBySeg, refCompare);
  assert.deepEqual(ranked.get(0), ['1', '2', '3', '10']); // numeric compare: 10 sorts after 3
});

test('rankCorridorLines keeps separate corridors independent', () => {
  const corridorOf = [0, 1];
  const lineIdsBySeg = [['9', '8'], ['1']];
  const ranked = rankCorridorLines(corridorOf, lineIdsBySeg, refCompare);
  assert.deepEqual(ranked.get(0), ['8', '9']);
  assert.deepEqual(ranked.get(1), ['1']);
});

/**
 * The double-track collapse decides which half of a corridor is never drawn, and
 * it fails in both directions visibly: too timid and the line is drawn twice,
 * too eager and it swallows a branch, a terminal loop or a one-way street pair
 * that a rider actually rides. The fixtures below are the shapes that came up
 * while tuning it against Braunschweig tram 1, so a future loosening has to
 * argue with a case rather than with an opinion.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainWays, collapseParallelTracks, type Coord } from './lib/track.ts';

/** Metres, at Braunschweig's latitude, as a longitude/latitude delta. */
const M_LAT = 1 / 111320;
const M_LON = M_LAT / Math.cos((52.26 * Math.PI) / 180);

/** A way running east from (x, y) for `len` metres, offset `off` metres north. */
function eastward(x: number, y: number, len: number, off = 0): Coord[] {
  const lat = y + off * M_LAT;
  return [[x, lat], [x + len * M_LON, lat]];
}

const geomOf = (ways: Record<string, Coord[]>) => new Map(Object.entries(ways));

test('collapses the opposite track of a double-track corridor', () => {
  const geom = geomOf({
    up: eastward(10.52, 52.26, 800),
    down: eastward(10.52, 52.26, 800, 4), // the other direction, 4 m away
  });
  assert.deepEqual(collapseParallelTracks(['up', 'down'], geom, 15), ['up']);
});

test('keeps a track pair that is further apart than the tolerance allows', () => {
  // A tram running up one street and back down the next one over is two streets
  // on the map, not one corridor drawn twice.
  const geom = geomOf({
    up: eastward(10.52, 52.26, 800),
    down: eastward(10.52, 52.26, 800, 40),
  });
  assert.equal(collapseParallelTracks(['up', 'down'], geom, 15).length, 2);
});

test('keeps a way that only converges at one end', () => {
  // A turnout leaves the kept track at a shared node and runs away from it -
  // covered where it starts, uncovered along the rest, so it has to stay.
  const geom = geomOf({
    main: eastward(10.52, 52.26, 800),
    turnout: [[10.52, 52.26], [10.52 + 800 * M_LON, 52.26 + 60 * M_LAT]],
  });
  assert.equal(collapseParallelTracks(['main', 'turnout'], geom, 15).length, 2);
});

test('keeps consecutive ways along the same track', () => {
  // The failure that sank an earlier heuristic: two ways of one track share an
  // end and point the same way, but neither retraces the other.
  const geom = geomOf({
    first: eastward(10.52, 52.26, 400),
    second: eastward(10.52 + 400 * M_LON, 52.26, 400),
  });
  assert.equal(collapseParallelTracks(['first', 'second'], geom, 15).length, 2);
});

test('collapses a corridor split into differently cut ways', () => {
  // The two tracks are rarely cut at the same nodes: one direction is a single
  // way where the other is three. Whichever side is kept, the corridor is drawn
  // exactly once and every dropped way sits under a kept one.
  const geom = geomOf({
    up: eastward(10.52, 52.26, 900),
    downA: eastward(10.52, 52.26, 300, 4),
    downB: eastward(10.52 + 300 * M_LON, 52.26, 300, 4),
    downC: eastward(10.52 + 600 * M_LON, 52.26, 300, 4),
  });
  assert.deepEqual(collapseParallelTracks(['up', 'downA', 'downB', 'downC'], geom, 15), ['up']);
});

test('leaves the surviving track connected end to end', () => {
  // What matters downstream is that the kept ways still chain: a corridor that
  // survives as fragments gets its offsets pushed to inconsistent sides.
  const geom = geomOf({
    upA: eastward(10.52, 52.26, 300),
    upB: eastward(10.52 + 300 * M_LON, 52.26, 300),
    downA: eastward(10.52, 52.26, 300, 4),
    downB: eastward(10.52 + 300 * M_LON, 52.26, 300, 4),
  });
  const kept = collapseParallelTracks(['upA', 'upB', 'downA', 'downB'], geom, 15);
  assert.equal(kept.length, 2);
  assert.equal(chainWays(kept, geom).length, 1);
});

test('puts back the crossover that links two kept stretches', () => {
  // The kept track runs out and the line continues on the other one. The
  // crossover between them is covered and would go, leaving the two stretches
  // a track apart with nothing joining them, so it comes back.
  const geom = geomOf({
    upA: eastward(10.52, 52.26, 400),
    downA: eastward(10.52, 52.26, 400, 4),
    crossover: [[10.52 + 400 * M_LON, 52.26], [10.52 + 410 * M_LON, 52.26 + 4 * M_LAT]],
    downB: eastward(10.52 + 410 * M_LON, 52.26, 400, 4),
  });
  const kept = collapseParallelTracks(['upA', 'downA', 'crossover', 'downB'], geom, 15);
  assert.ok(kept.includes('crossover'), 'the crossover is the only link left');
  assert.equal(chainWays(kept, geom).length, 1);
});

test('does not put back a whole second track to close a gap', () => {
  // Both stretches are separated by a hole the data never filled, and the only
  // dropped way long enough to bridge it is the track we collapsed away. Two
  // strokes are worse than one gap, so it stays dropped.
  const geom = geomOf({
    up: eastward(10.52, 52.26, 900),
    down: eastward(10.52, 52.26, 900, 4),
    farther: eastward(10.52 + 900 * M_LON, 52.26, 400, 4),
  });
  const kept = collapseParallelTracks(['up', 'down', 'farther'], geom, 15);
  assert.ok(!kept.includes('down'));
});

test('keeps a branch that leaves the corridor', () => {
  const geom = geomOf({
    trunk: eastward(10.52, 52.26, 800),
    trunkBack: eastward(10.52, 52.26, 800, 4),
    branch: [[10.52 + 800 * M_LON, 52.26], [10.52 + 800 * M_LON, 52.26 + 500 * M_LAT]],
  });
  const kept = collapseParallelTracks(['trunk', 'trunkBack', 'branch'], geom, 15);
  assert.deepEqual(new Set(kept), new Set(['trunk', 'branch']));
});

test('ignores ways with no geometry to compare', () => {
  const geom = geomOf({ up: eastward(10.52, 52.26, 800) });
  assert.deepEqual(collapseParallelTracks(['up', 'missing'], geom, 15), ['up']);
});

test('is stable whatever order the ways arrive in', () => {
  const geom = geomOf({
    a: eastward(10.52, 52.26, 800),
    b: eastward(10.52, 52.26, 800, 4),
    c: eastward(10.52 + 800 * M_LON, 52.26, 500),
  });
  const forward = collapseParallelTracks(['a', 'b', 'c'], geom, 15);
  const reversed = collapseParallelTracks(['c', 'b', 'a'], geom, 15);
  assert.deepEqual(new Set(forward), new Set(reversed));
});

test('stitches across the step where the kept track changes side', () => {
  // Two stretches of one corridor, carrying on in the same direction but a
  // track's width apart, because the crossover between them was collapsed away.
  const geom = geomOf({
    north: eastward(10.52, 52.26, 400),
    south: eastward(10.52 + 402 * M_LON, 52.26, 400, 4),
  });
  assert.equal(chainWays(['north', 'south'], geom).length, 2);
  assert.equal(chainWays(['north', 'south'], geom, 15).length, 1);
});

test('leaves ends that meet at an angle alone', () => {
  // A junction, not a step: the second way heads off at 60 degrees, so joining
  // the two would draw a corner no track makes.
  const geom = geomOf({
    trunk: eastward(10.52, 52.26, 400),
    branch: [
      [10.52 + 404 * M_LON, 52.26],
      [10.52 + 604 * M_LON, 52.26 + 350 * M_LAT],
    ] as Coord[],
  });
  assert.equal(chainWays(['trunk', 'branch'], geom, 15).length, 2);
});

test('does not stitch a chain onto itself', () => {
  // A loop whose two ends come back within snapping distance stays open rather
  // than being closed into a ring that no longer has a start.
  const geom = geomOf({
    out: eastward(10.52, 52.26, 300),
    back: [
      [10.52 + 300 * M_LON, 52.26],
      [10.52 + 300 * M_LON, 52.26 + 4 * M_LAT],
      [10.52 + 2 * M_LON, 52.26 + 4 * M_LAT],
    ] as Coord[],
  });
  const chains = chainWays(['out', 'back'], geom, 15);
  assert.equal(chains.length, 1);
  assert.notDeepEqual(chains[0][0], chains[0][chains[0].length - 1]);
});

test('chains ways into one line however they are oriented', () => {
  const geom = geomOf({
    first: eastward(10.52, 52.26, 300),
    second: [...eastward(10.52 + 300 * M_LON, 52.26, 300)].reverse() as Coord[],
  });
  const chains = chainWays(['first', 'second'], geom);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].length, 3);
});

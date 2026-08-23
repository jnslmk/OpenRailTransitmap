/**
 * Chain co-orientation is the step that turns a slot into a physical band: a
 * slot only names a side once the chains carrying it agree which way they
 * run. These fixtures pin what "agree" has to mean - a chain stitched
 * backwards is turned round, a corridor keeps one direction across a whole
 * run of chains, a fork carries its branch with it, and geometry that cannot
 * be reconciled is left alone rather than propagated.
 *
 * Coordinates are degrees, and the pipeline reads them as such, so the
 * fixtures are laid out around 52 N at spacings of a few hundred metres -
 * far enough apart that the 25 m the end direction is measured over falls
 * inside a single segment.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coorientChains, endDirection, type Coord } from './lib/orient.ts';

/** An east-west run at 52 N: 0.01 deg of longitude is about 690 m. */
const P = (i: number, lat = 52): Coord => [10 + i * 0.01, lat];

/** Apply the flags the way build.ts does, so a case can assert on geometry. */
function applied(chains: Coord[][], flips: boolean[]): Coord[][] {
  return chains.map((c, i) => (flips[i] ? [...c].reverse() : c));
}

/** Which way a chain ends up running, as the sign of its west-east span. */
const eastwards = (chain: Coord[]) => chain[chain.length - 1][0] > chain[0][0];

test('endDirection points forwards along the chain at both ends', () => {
  const chain: Coord[] = [P(0), P(1), P(2)];
  const [sx, sy] = endDirection(chain, true);
  const [ex, ey] = endDirection(chain, false);
  assert.ok(sx > 0.99 && Math.abs(sy) < 0.01, `start ${sx},${sy}`);
  assert.ok(ex > 0.99 && Math.abs(ey) < 0.01, `end ${ex},${ey}`);
});

test('endDirection reads past a short leading segment', () => {
  // A metre of switch detail heading due north, then the corridor's real run
  // east. Judging on the first vertex pair alone would call this northbound.
  const chain: Coord[] = [[10, 52], [10, 52.00001], [10.01, 52.00001], [10.02, 52.00001]];
  const [dx, dy] = endDirection(chain, true);
  assert.ok(dx > 0.9, `expected an eastward reading, got ${dx},${dy}`);
});

test('a chain stitched backwards is turned round to match its neighbour', () => {
  const forward: Coord[] = [P(0), P(1)];
  const backward: Coord[] = [P(2), P(1)]; // meets `forward` at P(1), running the other way
  const flips = coorientChains([forward, backward]);
  assert.deepEqual(flips, [false, true]);
  assert.ok(applied([forward, backward], flips).every(eastwards));
});

test('a chain already agreeing with its neighbour is left alone', () => {
  const a: Coord[] = [P(0), P(1)];
  const b: Coord[] = [P(1), P(2)];
  assert.deepEqual(coorientChains([a, b]), [false, false]);
});

test('one direction carries along a whole run of chains', () => {
  // Every other chain stitched backwards - the shape chainWays leaves when
  // each segment seeds on whichever way came first out of the map.
  const chains: Coord[][] = [
    [P(0), P(1)],
    [P(2), P(1)],
    [P(2), P(3)],
    [P(4), P(3)],
    [P(4), P(5)],
  ];
  const flips = coorientChains(chains);
  assert.deepEqual(flips, [false, true, false, true, false]);
  assert.ok(applied(chains, flips).every(eastwards));
});

test('a fork takes its branch to the same side as its trunk', () => {
  // Trunk running east to the junction at P(2); one branch carries straight
  // on, the other peels away to the north-east. Both branches are stitched
  // pointing back at the junction.
  const trunk: Coord[] = [P(0), P(1), P(2)];
  const straight: Coord[] = [P(4), P(3), P(2)];
  const branch: Coord[] = [[10.04, 52.014], [10.03, 52.007], P(2)];
  const flips = coorientChains([trunk, straight, branch]);
  assert.deepEqual(flips, [false, true, true]);
});

test('two alignments merely crossing do not drag each other round', () => {
  // A north-south chain touching an east-west one at a point. Nothing about
  // one says anything about which side the other draws on.
  const eastWest: Coord[] = [P(0), P(1), P(2)];
  const northSouth: Coord[] = [[10.01, 51.99], [10.01, 52], [10.01, 52.01]];
  const flips = coorientChains([eastWest, northSouth]);
  assert.equal(flips[0], false);
  // The crossing chain is anchored on its own geometry, not on the other's.
  assert.ok(applied([eastWest, northSouth], flips)[1][2][1] > 52);
});

test('a component faces whichever way most of its length already faces', () => {
  // Both chains stitched westwards; the whole component turns to run east.
  const long: Coord[] = [P(4), P(3), P(2), P(1)];
  const short: Coord[] = [P(1), P(0)];
  const flips = coorientChains([long, short]);
  assert.ok(applied([long, short], flips).every(eastwards));
});

test('a short chain against the run does not turn the component round', () => {
  // Three quarters of the metres already run east, so the odd stub stitched
  // the other way is the one that moves - not the corridor it hangs off.
  const run: Coord[] = [P(0), P(1), P(2), P(3)];
  const stub: Coord[] = [P(4), P(3)];
  const flips = coorientChains([run, stub]);
  assert.deepEqual(flips, [false, true]);
  assert.ok(applied([run, stub], flips).every(eastwards));
});

test('a north-south component is anchored running north', () => {
  const chain: Coord[] = [[10, 52.02], [10, 52.01], [10, 52]];
  const flips = coorientChains([chain]);
  assert.deepEqual(flips, [true]);
});

test('the same input always gives the same answer', () => {
  const chains: Coord[][] = [
    [P(0), P(1)], [P(2), P(1)], [P(2), P(3)], [P(3), P(4)],
  ];
  const once = coorientChains(chains);
  const twice = coorientChains(chains);
  assert.deepEqual(once, twice);
});

test('a contradiction is dropped rather than propagated', () => {
  // A balloon loop: one chain leaves the junction east and comes back to it
  // from the north, so it would have to disagree with itself. Whichever of
  // the two constraints loses, every chain still gets exactly one answer and
  // the straight-through pair - the stronger evidence - is the one honoured.
  const trunk: Coord[] = [P(0), P(1), P(2)];
  const loop: Coord[] = [P(2), [10.03, 52], [10.03, 52.01], [10.02, 52.01], P(2)];
  const flips = coorientChains([trunk, loop]);
  assert.equal(flips.length, 2);
  assert.equal(flips[0], false);
  assert.equal(typeof flips[1], 'boolean');
});

test('a chain too short to have a direction is neither turned nor consulted', () => {
  const chains: Coord[][] = [[P(0)], [P(1), P(0)]];
  const flips = coorientChains(chains);
  assert.equal(flips[0], false);
  assert.ok(applied(chains, flips)[1][1][0] > applied(chains, flips)[1][0][0]);
});

test('an empty input is an empty answer', () => {
  assert.deepEqual(coorientChains([]), []);
});

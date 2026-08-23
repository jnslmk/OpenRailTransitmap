/**
 * The closure router has one job the rest of the pipeline does not: it takes
 * two points that came from somewhere other than OSM and decides which stretch
 * of OSM track sits between them. Every way it can get that wrong is a wrong
 * line drawn in red across a map, so the shapes below are the ones that decide
 * it - a branch leaving mid-way, a yard offering a shortcut, a parallel line
 * that is not the one the closure names.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRailGraph,
  nearestNode,
  routeBetween,
  metres,
  type Coord,
  type RailWay,
} from './lib/railpath.ts';

/** Metres as a lon/lat delta, at about the latitude of Hannover. */
const M_LAT = 1 / 111320;
const M_LON = M_LAT / Math.cos((52.4 * Math.PI) / 180);

const at = (eastM: number, northM: number): Coord => [9.7 + eastM * M_LON, 52.4 + northM * M_LAT];

/** A straight way through the given points, given in metres from the origin. */
function way(id: string, points: [number, number][], extra: Partial<RailWay> = {}): RailWay {
  return { id, coords: points.map(([e, n]) => at(e, n)), ...extra };
}

test('routes along a chain of ways and returns their own geometry', () => {
  // A curve in the middle way: the path must follow it rather than cutting the
  // corner between the two junctions it sits between.
  const graph = buildRailGraph([
    way('a', [
      [0, 0],
      [1000, 0],
    ]),
    way('b', [
      [1000, 0],
      [1500, 400],
      [2000, 0],
    ]),
    way('c', [
      [2000, 0],
      [3000, 0],
    ]),
  ]);

  const path = routeBetween(graph, at(0, 0), at(3000, 0));
  assert.ok(path);
  assert.equal(path.wayIds.join(','), 'a,b,c');
  // The apex of the curve is in the output, so this is track and not a chord.
  assert.ok(path.coords.some((c) => metres(c, at(1500, 400)) < 1));
  assert.ok(path.metres > 3000);
});

test('joins a way that ends partway along another, unsplit way', () => {
  // The case that OSM convention says should not happen and routinely does. The
  // branch ends on a node in the middle of the main line; without cutting the
  // main line there, the two are separate components.
  const graph = buildRailGraph([
    way('main', [
      [0, 0],
      [1000, 0],
      [2000, 0],
    ]),
    way('branch', [
      [1000, 0],
      [1000, 1200],
    ]),
  ]);

  const path = routeBetween(graph, at(0, 0), at(1000, 1200));
  assert.ok(path);
  assert.deepEqual(path.wayIds, ['main', 'branch']);
});

test('prefers the line the closure names over a shorter parallel one', () => {
  // Two railways between the same pair of places. The closure is on 1700, and
  // 1700 is the longer way round - which is exactly when the preference has to
  // be doing the work rather than agreeing with the shortest path by accident.
  const ways = [
    way(
      'west-a',
      [
        [0, 0],
        [0, 900],
      ],
      { ref: '1700' },
    ),
    way(
      'west-b',
      [
        [0, 900],
        [2000, 900],
      ],
      { ref: '1700' },
    ),
    way(
      'west-c',
      [
        [2000, 900],
        [2000, 0],
      ],
      { ref: '1700' },
    ),
    way(
      'direct',
      [
        [0, 0],
        [2000, 0],
      ],
      { ref: '2200' },
    ),
  ];
  const graph = buildRailGraph(ways);

  const onLine = routeBetween(graph, at(0, 0), at(2000, 0), { routes: [1700] });
  assert.deepEqual(onLine?.wayIds, ['west-a', 'west-b', 'west-c']);

  // With no line stated there is nothing to prefer, so the short one wins.
  const plain = routeBetween(graph, at(0, 0), at(2000, 0));
  assert.deepEqual(plain?.wayIds, ['direct']);
});

test('an untagged way is not treated as being off the line', () => {
  // `ref` coverage on German railway ways is about 43%, so a gap in tagging
  // must not make a path expensive - only a way tagged with a *different* line
  // is evidence of leaving it.
  const graph = buildRailGraph([
    way('gap', [
      [0, 0],
      [1000, 0],
    ]),
    way(
      'tagged',
      [
        [1000, 0],
        [2000, 0],
      ],
      { ref: '1700' },
    ),
    way(
      'detour-a',
      [
        [0, 0],
        [0, 400],
      ],
      { ref: '1700' },
    ),
    way(
      'detour-b',
      [
        [0, 400],
        [1000, 400],
      ],
      { ref: '1700' },
    ),
    way(
      'detour-c',
      [
        [1000, 400],
        [1000, 0],
      ],
      { ref: '1700' },
    ),
  ]);

  const path = routeBetween(graph, at(0, 0), at(2000, 0), { routes: [1700] });
  assert.deepEqual(path?.wayIds, ['gap', 'tagged']);
});

test('takes the running line rather than a shortcut through a yard', () => {
  const graph = buildRailGraph([
    way('running-a', [
      [0, 0],
      [1000, 600],
    ]),
    way('running-b', [
      [1000, 600],
      [2000, 0],
    ]),
    way(
      'yard',
      [
        [0, 0],
        [2000, 0],
      ],
      { service: 'yard' },
    ),
  ]);

  const path = routeBetween(graph, at(0, 0), at(2000, 0));
  assert.deepEqual(path?.wayIds, ['running-a', 'running-b']);
});

test('trims the path back to the operating points the closure names', () => {
  // Both ends snap to the junctions at 0 and 3000, but the closure is only the
  // middle stretch. Drawing it end to end would shut two extra sections.
  const graph = buildRailGraph([
    way('a', [
      [0, 0],
      [1000, 0],
    ]),
    way('b', [
      [1000, 0],
      [2000, 0],
    ]),
    way('c', [
      [2000, 0],
      [3000, 0],
    ]),
    way('branch-1', [
      [1000, 0],
      [1000, 800],
    ]),
    way('branch-2', [
      [2000, 0],
      [2000, 800],
    ]),
  ]);

  const path = routeBetween(graph, at(1000, 0), at(2000, 0));
  assert.ok(path);
  assert.ok(Math.abs(path.metres - 1000) < 1, `expected ~1000 m, got ${path.metres}`);
  assert.ok(metres(path.coords[0], at(1000, 0)) < 1);
  assert.ok(metres(path.coords[path.coords.length - 1], at(2000, 0)) < 1);
});

test('gives up rather than inventing a path between disconnected networks', () => {
  const graph = buildRailGraph([
    way('north', [
      [0, 0],
      [1000, 0],
    ]),
    way('south', [
      [0, -4000],
      [1000, -4000],
    ]),
  ]);
  assert.equal(routeBetween(graph, at(0, 0), at(1000, -4000)), null);
});

test('gives up when an end is nowhere near the network', () => {
  const graph = buildRailGraph([
    way('a', [
      [0, 0],
      [1000, 0],
    ]),
  ]);
  assert.equal(nearestNode(graph, at(0, 40_000), 2000), null);
  assert.equal(routeBetween(graph, at(0, 40_000), at(1000, 0)), null);
});

test('a closed loop contributes no self-edge', () => {
  const graph = buildRailGraph([
    way('loop', [
      [0, 0],
      [500, 500],
      [1000, 0],
      [0, 0],
    ]),
  ]);
  // Every node it does create must at least not point at itself.
  for (const [node, edges] of graph.edges.entries()) {
    assert.ok(edges.every((e) => e.to !== node));
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journeyView } from './itinerary.ts';
import type { Itinerary, Leg, LegPlace } from './routing.ts';

const place = (name: string, lon = 9.73): LegPlace => ({
  name,
  lon,
  lat: 52.37,
  stopId: name,
  scheduled: null,
  actual: null,
  track: null,
  tz: null,
});
const leg = (from: LegPlace, to: LegPlace, transit = true, seconds = 300): Leg => ({
  mode: transit ? 'REGIONAL_RAIL' : 'WALK',
  transit,
  from,
  to,
  seconds,
  line: transit ? 'RE1' : '',
  headsign: '',
  operator: '',
  colour: '#ff0000',
  metres: null,
  realTime: false,
  cancelled: false,
  bikesAllowed: null,
  reservationRequired: false,
  intermediateStops: 0,
  url: '',
  path: [],
});
const itinerary = (legs: Leg[]): Itinerary => ({
  id: 'test',
  start: new Date(0),
  end: new Date(3600000),
  seconds: 3600,
  transfers: 99,
  legs,
  bikeSeconds: 0,
  direct: false,
});

test('journey changes group only transit connections and retain their leg colours without geometry', () => {
  const origin = place('Origin', 9.7);
  const a = place('Central', 9.73);
  const b = place('Central', 9.731); // Same station, distinct arrival/departure positions.
  const c = place('East', 9.75);
  const d = place('East tram', 9.752);
  const end = place('Destination', 9.78);
  const view = journeyView(
    itinerary([
      leg(origin, a, false), // Access is never a train change.
      leg(a, a),
      leg(a, b, false, 0), // Zero-distance/zero-duration transfer still counts.
      leg(b, c),
      leg(c, d, false, 180), // Connecting stations share one change.
      leg(d, end),
      leg(end, end), // Directly adjacent transit legs also change.
      leg(end, end, false), // Egress is never a train change.
    ]),
  );
  assert.deepEqual(
    view.interchanges.map((c) => [c.number, c.arrivalIndex, c.departureIndex]),
    [
      [1, 1, 3],
      [2, 3, 5],
      [3, 5, 6],
    ],
  );
  assert.deepEqual(
    view.interchanges.map((c) => [c.label, c.walkingSeconds, c.hasWalking]),
    [
      ['Central', 0, true],
      ['East → East tram', 180, true],
      ['Destination', 0, false],
    ],
  );
  assert.deepEqual(view.interchanges[0].at, [(a.lon + b.lon) / 2, a.lat]);
  assert.deepEqual(view.interchanges[1].path, [
    [c.lon, c.lat],
    [c.lon, c.lat],
    [d.lon, d.lat],
    [d.lon, d.lat],
  ]);
  assert.deepEqual(view.interchanges[2].connectionIndices, []);
  const transit = view.legs.filter(({ leg }) => leg.transit);
  assert.deepEqual(
    transit.map(({ number }) => number),
    [1, 2, 3, 4],
  );
  assert.equal(transit[0].colour, journeyView(itinerary([leg(a, end)])).legs[0].colour);
  for (let i = 1; i < transit.length; i++)
    assert.notEqual(transit[i].colour, transit[i - 1].colour);
  const longer = journeyView(itinerary(Array.from({ length: 7 }, () => leg(a, end)))).legs;
  for (let i = 1; i < longer.length; i++) assert.notEqual(longer[i].colour, longer[i - 1].colour);
  assert.deepEqual(journeyView(itinerary([leg(origin, end, false)])).interchanges, []);
  assert.deepEqual(journeyView(itinerary([leg(a, end)])).interchanges, []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geocode, plan, placeFromLonLat, LiveDataError, type PlanQuery } from './routing.ts';

test('city searches prefer their main railway station without replacing specific places', async (t) => {
  const areas = [{ name: 'Berlin', adminLevel: 4, default: true }];
  const city = {
    type: 'PLACE',
    category: 'place_6',
    name: 'Berlin',
    lat: 52.517,
    lon: 13.395,
    country: 'DE',
    areas,
  };
  const stop = {
    type: 'STOP',
    name: 'Berlin Ostbf',
    id: 'ostbf',
    lat: 52.51,
    lon: 13.435,
    country: 'DE',
    areas,
    modes: ['REGIONAL_RAIL'],
  };
  const main = { ...stop, name: 'Berlin Hbf', id: 'hbf' };
  let response = [
    city,
    { ...main, country: 'US', id: 'foreign' },
    { ...main, modes: ['BUS'], id: 'bus' },
    stop,
    main,
  ];
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json(response)));
  const signal = new AbortController().signal;

  const [preferred] = await geocode('  berlin  ', signal, 1);
  assert.equal(preferred.name, 'Berlin Hbf');
  assert.equal(preferred.stopId, 'hbf');

  const braunschweigAreas = [{ name: 'Braunschweig', adminLevel: 8, default: true }];
  const braunschweig = { ...city, name: 'Braunschweig', areas: braunschweigAreas };
  const braunschweigHbf = {
    ...main,
    name: 'Braunschweig Hbf',
    id: 'braunschweig-hbf',
    areas: braunschweigAreas,
  };
  response = [braunschweig, { ...braunschweigHbf, areas, id: 'other-city' }, braunschweigHbf];
  const [partialCity] = await geocode('  bRaUnScH  ', signal, 1);
  assert.equal(partialCity.name, 'Braunschweig Hbf');
  assert.equal(partialCity.stopId, braunschweigHbf.id);
  assert.equal(partialCity.kind, 'STOP');

  response = [city, main];
  assert.equal((await geocode('Berlin Ostbahnhof', signal))[0].kind, 'PLACE');

  response = [city, stop];
  assert.equal((await geocode('Berlin', signal))[0].stopId, 'ostbf');

  response = [city, { ...main, modes: ['BUS'], id: 'bus' }];
  assert.equal((await geocode('Berlin', signal))[0].kind, 'PLACE');

  response = [stop, main];
  assert.equal((await geocode('Berlin Ostbahnhof', signal))[0].stopId, 'ostbf');
  assert.equal((await geocode('Berlin Ost', signal))[0].stopId, 'ostbf');

  const address = { ...city, type: 'ADDRESS', name: 'Berlin, Invalidenstraße 1' };
  response = [address, main];
  assert.equal((await geocode(address.name, signal))[0].kind, 'ADDRESS');
  assert.equal((await geocode('Berlin, Invaliden', signal))[0].kind, 'ADDRESS');

  const poi = { ...city, category: 'tourism', name: 'Berlin Museum' };
  response = [poi, main];
  assert.equal((await geocode('Berlin', signal))[0].name, poi.name);
});

const routeQuery = (name: string): PlanQuery => ({
  from: placeFromLonLat(9.732, 52.376, name),
  to: placeFromLonLat(10.2, 52.35, 'Destination'),
  time: new Date('2026-10-03T09:00:00Z'),
  arriveBy: false,
  modes: new Set(['REGIONAL_RAIL']),
  bike: { maxRideSeconds: 1800, carriage: false },
});

const routeResponse = (line: string) => ({
  itineraries: [
    {
      startTime: '2026-10-03T09:00:00Z',
      endTime: '2026-10-03T10:00:00Z',
      legs: [
        {
          mode: 'REGIONAL_RAIL',
          routeShortName: line,
          from: { departure: '2026-10-03T09:00:00Z', track: '2' },
          to: { arrival: '2026-10-03T10:00:00Z' },
        },
      ],
    },
  ],
  nextPageCursor: 'later',
});

test('route cache expires exactly two minutes after the response body completes', async (t) => {
  // Distinct coordinates keep these public-interface tests independent of the cache.
  const q = routeQuery('TTL');
  q.from.lon = 9.733;
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  let completeBody!: () => void;
  const bodyReady = new Promise<void>((resolve) => {
    completeBody = resolve;
  });
  let calls = 0;
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    if (++calls === 1) {
      const response = Response.json({});
      t.mock.method(response, 'json', async () => {
        await bodyReady;
        return routeResponse('RE1');
      });
      return Promise.resolve(response);
    }
    return Promise.resolve(Response.json(routeResponse('RE9')));
  });
  const signal = new AbortController().signal;
  const pending = plan(q, signal);
  now = 61_000;
  completeBody();
  const initial = await pending;
  assert.equal(initial.itineraries[0].legs[0].line, 'RE1');

  now = 180_999;
  const withinQuarterHour = {
    ...q,
    time: new Date('2026-10-03T09:14:59Z'),
  };
  assert.equal((await plan(withinQuarterHour, signal)).itineraries[0].legs[0].line, 'RE1');
  assert.equal(fetch.mock.callCount(), 1);

  now = 181_000;
  assert.equal(fetch.mock.callCount(), 1, 'expiry alone does not request anything');
  const expired = await plan(q, signal);
  assert.equal(expired.itineraries[0].legs[0].line, 'RE9');
  assert.equal(fetch.mock.callCount(), 2, 'cache reads do not extend the TTL');
});

test('explicit refresh replaces fresh journeys and empty results; failures remain retryable', async (t) => {
  const q = routeQuery('Refresh');
  q.from.lon = 9.734;
  t.mock.method(Date, 'now', () => 10_000);
  let response = routeResponse('RE1');
  let status = 200;
  const fetch = t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(Response.json(response, { status })),
  );
  const signal = new AbortController().signal;
  assert.equal((await plan(q, signal)).itineraries[0].legs[0].line, 'RE1');

  response = routeResponse('RE9');
  response.itineraries[0].legs[0].from = {
    departure: '2026-10-03T09:10:00Z',
    track: '4',
  };
  assert.equal((await plan(q, signal)).itineraries[0].legs[0].line, 'RE1');
  assert.equal(fetch.mock.callCount(), 1);
  const refreshed = await plan(q, signal, true);
  assert.equal(refreshed.itineraries[0].legs[0].line, 'RE9');
  assert.equal(refreshed.itineraries[0].legs[0].from.track, '4');
  assert.equal(
    refreshed.itineraries[0].legs[0].from.actual?.toISOString(),
    '2026-10-03T09:10:00.000Z',
  );
  assert.equal((await plan(q, signal)).itineraries[0].legs[0].line, 'RE9');
  assert.equal(fetch.mock.callCount(), 2);

  response = { ...response, itineraries: [] };
  assert.deepEqual((await plan(q, signal, true)).itineraries, []);
  response = routeResponse('RE2');
  assert.deepEqual((await plan(q, signal)).itineraries, []);
  assert.equal((await plan(q, signal, true)).itineraries[0].legs[0].line, 'RE2');

  status = 503;
  await assert.rejects(plan(q, signal, true), LiveDataError);
  status = 200;
  response = routeResponse('RE3');
  assert.equal((await plan(q, signal)).itineraries[0].legs[0].line, 'RE3');
  assert.equal(fetch.mock.callCount(), 6, 'failed refresh does not restore the old cached journey');
});

test('route caching keeps query variants separate and stays bounded', async (t) => {
  const q = routeQuery('Variants');
  q.from.lon = 9.735;
  t.mock.method(Date, 'now', () => 20_000);
  let calls = 0;
  const fetch = t.mock.method(globalThis, 'fetch', () =>
    Promise.resolve(Response.json(routeResponse(`RE${++calls}`))),
  );
  const signal = new AbortController().signal;
  assert.equal((await plan(q, signal)).itineraries[0].legs[0].line, 'RE1');
  const variants: PlanQuery[] = [
    { ...q, time: new Date('2026-10-03T09:15:00Z') },
    { ...q, arriveBy: true },
    { ...q, modes: new Set(['BUS']) },
    { ...q, bike: { ...q.bike, maxRideSeconds: 3600 } },
    { ...q, bike: { ...q.bike, carriage: true } },
    { ...q, pageCursor: 'later' },
  ];
  for (const [index, variant] of variants.entries()) {
    assert.equal((await plan(variant, signal)).itineraries[0].legs[0].line, `RE${index + 2}`);
  }
  assert.equal((await plan(q, signal)).itineraries[0].legs[0].line, 'RE1');
  assert.equal(fetch.mock.callCount(), 7);
  for (let i = 0; i < 24; i++) await plan({ ...q, pageCursor: `page-${i}` }, signal);
  assert.equal((await plan(q, signal)).itineraries[0].legs[0].line, 'RE32');
});

test('a cancelled refresh does not cache a late response over the next search', async (t) => {
  const q = routeQuery('Cancellation');
  q.from.lon = 9.736;
  t.mock.method(Date, 'now', () => 30_000);
  let complete!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  let calls = 0;
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 2 ? pending : Response.json(routeResponse('RE9')),
  );
  const signal = new AbortController().signal;
  await plan(q, signal);
  const ac = new AbortController();
  const refresh = plan(q, ac.signal, true);
  ac.abort();
  assert.equal((await plan(q, signal)).itineraries[0].legs[0].line, 'RE9');
  complete(Response.json(routeResponse('RE1')));
  await assert.rejects(refresh, { name: 'AbortError' });
  assert.equal((await plan(q, signal)).itineraries[0].legs[0].line, 'RE9');
  assert.equal(fetch.mock.callCount(), 3);
});

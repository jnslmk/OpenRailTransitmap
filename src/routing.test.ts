import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geocode } from './routing.ts';

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

  response = [city, stop];
  assert.equal((await geocode('Berlin', signal))[0].stopId, 'ostbf');

  response = [city, { ...main, modes: ['BUS'], id: 'bus' }];
  assert.equal((await geocode('Berlin', signal))[0].kind, 'PLACE');

  response = [stop, main];
  assert.equal((await geocode('Berlin Ostbahnhof', signal))[0].stopId, 'ostbf');

  const address = { ...city, type: 'ADDRESS', name: 'Berlin, Invalidenstraße 1' };
  response = [address, main];
  assert.equal((await geocode(address.name, signal))[0].kind, 'ADDRESS');
});

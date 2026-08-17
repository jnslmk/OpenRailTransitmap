/**
 * The name matcher decides whether a MOTIS stop is *this* OSM station, and it
 * fails in both directions expensively: too strict and a station shows no
 * departure board at all, too loose and it shows a rider real times from the
 * wrong platform. Every case below is a real pair observed against
 * api.transitous.org, with the measured distance where it matters - so a
 * future loosening has to argue with the data rather than with an opinion.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { namesMatch, namesEqual, bestMatch } from './stop-ids.ts';

test('accepts the same name spelled differently', () => {
  assert.ok(namesMatch('Bremen Hbf', 'Bremen Hauptbahnhof'));
  assert.ok(namesMatch('Haste(b Wunstorf)', 'Haste'));
  assert.ok(namesMatch('Lübeck-St. Jürgen', 'Lübeck St Jürgen'));
});

test('accepts a feed name qualified by its town', () => {
  assert.ok(namesMatch('Rathaus', 'Braunschweig, Rathaus'));
  assert.ok(namesMatch('Hornusstraße', 'Freiburg, Hornusstraße'));
});

test('accepts the abbreviations German feeds ship', () => {
  // Each pair sits 3 m to 90 m apart on the ground.
  assert.ok(namesMatch('John-F.-Kennedy-Platz', 'Braunschweig, J.-F.-Kennedy-Pl.'));
  assert.ok(namesMatch('Friedrich-Wilhelm-Straße', 'Braunschweig, Fr.-Wilhelm-Str.'));
  assert.ok(namesMatch('Stadtfriedhof Seelhorst', 'Hannover Stadtfriedhof Seelh.'));
  assert.ok(namesMatch('Medizinische Hochschule', 'Hannover Med. Hochschule'));
});

test('a station named nothing but Hauptbahnhof still compares', () => {
  // Stripping the station words empties one side out; both sides then fall
  // back to the unstripped spelling rather than comparing against nothing.
  assert.ok(namesMatch('Hauptbahnhof', 'Darmstadt Hauptbahnhof'));
  assert.ok(namesMatch('Hauptbahnhof (U)', 'Bielefeld Hbf'));
  assert.ok(namesMatch('Hauptbahnhof (tief)', 'Frankfurt (Main) Hauptbahnhof'));
});

test('rejects a neighbour that merely starts the same way', () => {
  assert.ok(!namesMatch('Winsen Nord', 'Winsen, Friesenweg'));
  assert.ok(!namesMatch('Kirchweyhe Ort', 'Kirchweyhe(Weyhe) Schule'));
  assert.ok(!namesMatch('Heinrich-Büssing-Ring', 'Braunschweig, Berliner Platz'));
  assert.ok(!namesMatch('Ostbahnhof (ODF)', 'Osnabrück Elbestraße'));
});

test('namesEqual is equality, not plausibility', () => {
  assert.ok(namesEqual('Sondern', 'Sondern Bf'));
  assert.ok(namesEqual('Bremen Hbf', 'Bremen Hauptbahnhof'));
  assert.ok(!namesEqual('Sondern', 'Sondern Kirche'));
  assert.ok(!namesEqual('Rathaus', 'Braunschweig, Rathaus'));
});

// --- bestMatch ---------------------------------------------------------------

const stop = (id: string, name: string, lat: number, lon: number) =>
  ({ type: 'STOP', id, name, lat, lon });

/** Metres east of a point, as a longitude offset at ~51°N. */
const east = (lon: number, m: number) => lon + m / (111320 * Math.cos((51 * Math.PI) / 180));

test('an exact name wins over the plausible neighbours around it', () => {
  // The "Sondern" shape: three bus stops whose names contain the station's
  // name outright, and the actual station 54 m away.
  const station = { id: 'n1', name: 'Sondern', lon: 8.0, lat: 51.0 };
  const result = bestMatch([
    stop('bus-1', 'Sondern Kirche', 51.0, east(8.0, 218)),
    stop('bus-2', 'Sondern Seebahnhof', 51.0, east(8.0, 126)),
    stop('rail', 'Sondern Bf', 51.0, east(8.0, 54)),
  ], station);
  assert.deepEqual(result, { id: 'rail' });
});

test('two exact names really are ambiguous', () => {
  // Torgau has a station and a bus stop of the same name; guessing between
  // them would show a rider departures from the wrong one.
  const station = { id: 'n2', name: 'Torgau', lon: 13.0, lat: 51.0 };
  const result = bestMatch([
    stop('a', 'Torgau', 51.0, east(13.0, 40)),
    stop('b', 'Torgau', 51.0, east(13.0, 120)),
  ], station);
  assert.deepEqual(result, { ambiguous: true });
});

test('one stop published by two feeds collapses despite a town prefix', () => {
  const station = { id: 'n3', name: 'Forchheim (b Karlsruhe)', lon: 8.3, lat: 51.0 };
  const result = bestMatch([
    stop('de-KVV_1', 'Forchheim (b Karlsruhe)', 51.0, east(8.3, 10)),
    stop('de-amarillo_2', 'Rheinstetten, Forchheim (b Karlsruhe)', 51.0, east(8.3, 25)),
  ], station);
  // Same stop, two feeds: one id, not a decline.
  assert.deepEqual(result, { id: 'de-KVV_1' });
});

test('nothing within range is a negative, not a guess', () => {
  const station = { id: 'n4', name: 'Philosophenweg', lon: 9.59, lat: 52.84 };
  assert.equal(bestMatch([stop('far', 'Kassel Philosophenweg', 51.3, 9.48)], station), null);
});

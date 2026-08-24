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
import { namesMatch, namesEqual, bestMatch, boxCandidates, stopsBox } from './stop-ids.ts';

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

const stop = (id: string, name: string, lat: number, lon: number) => ({
  type: 'STOP',
  id,
  name,
  lat,
  lon,
});

/** Metres east of a point, as a longitude offset at ~51°N. */
const east = (lon: number, m: number) => lon + m / (111320 * Math.cos((51 * Math.PI) / 180));

test('an exact name wins over the plausible neighbours around it', () => {
  // The "Sondern" shape: three bus stops whose names contain the station's
  // name outright, and the actual station 54 m away.
  const station = { id: 'n1', name: 'Sondern', lon: 8.0, lat: 51.0 };
  const result = bestMatch(
    [
      stop('bus-1', 'Sondern Kirche', 51.0, east(8.0, 218)),
      stop('bus-2', 'Sondern Seebahnhof', 51.0, east(8.0, 126)),
      stop('rail', 'Sondern Bf', 51.0, east(8.0, 54)),
    ],
    station,
  );
  assert.deepEqual(result, { id: 'rail' });
});

test('two exact names really are ambiguous', () => {
  // Torgau has a station and a bus stop of the same name; guessing between
  // them would show a rider departures from the wrong one.
  const station = { id: 'n2', name: 'Torgau', lon: 13.0, lat: 51.0 };
  const result = bestMatch(
    [stop('a', 'Torgau', 51.0, east(13.0, 40)), stop('b', 'Torgau', 51.0, east(13.0, 120))],
    station,
  );
  assert.deepEqual(result, { ambiguous: true });
});

test('one stop published by two feeds collapses despite a town prefix', () => {
  const station = { id: 'n3', name: 'Forchheim (b Karlsruhe)', lon: 8.3, lat: 51.0 };
  const result = bestMatch(
    [
      stop('de-KVV_1', 'Forchheim (b Karlsruhe)', 51.0, east(8.3, 10)),
      stop('de-amarillo_2', 'Rheinstetten, Forchheim (b Karlsruhe)', 51.0, east(8.3, 25)),
    ],
    station,
  );
  // Same stop, two feeds: one id, not a decline.
  assert.deepEqual(result, { id: 'de-KVV_1' });
});

test('nothing within range is a negative, not a guess', () => {
  const station = { id: 'n4', name: 'Philosophenweg', lon: 9.59, lat: 52.84 };
  assert.equal(bestMatch([stop('far', 'Kassel Philosophenweg', 51.3, 9.48)], station), null);
});

// --- the spatial sweep (/map/stops) ------------------------------------------
//
// Every fixture below is a verbatim `/api/v1/map/stops` response observed
// against api.transitous.org for a 500 m box around the named OSM station's
// own coordinates, trimmed only of the fields the matcher doesn't read
// (importance, tz, level, vertexType, description, and modes - which the
// sweep does return, and which `boxCandidates` drops for now). The station
// coordinates are the ones in .work/extract/stations.geojsonseq.

/** One `/map/stops` element, as the endpoint spells it. */
const mapStop = (stopId: string, name: string, lat: number, lon: number) => ({
  stopId,
  name,
  lat,
  lon,
});

test('the sweep response is reshaped into what bestMatch reads', () => {
  // /map/stops calls the id `stopId` and has no `type` field at all, where the
  // geocoder calls it `id` and types every result. bestMatch reads `.id` and
  // discards anything not typed 'STOP', so an unreshaped sweep result would
  // match nothing whatsoever.
  const [c] = boxCandidates([
    {
      stopId: 'de-DELFI_de:06439:11318',
      name: 'Idstein Bahnhof',
      lat: 50.21599197387695,
      lon: 8.257540702819824,
      modes: ['REGIONAL_RAIL'],
    },
  ]);
  assert.equal(c.id, 'de-DELFI_de:06439:11318');
  assert.equal(c.type, 'STOP');
  assert.equal(c.name, 'Idstein Bahnhof');
});

test('the box covers the whole match radius in every direction', () => {
  // The box has to be at least as large as the distance filter it feeds, or a
  // stop bestMatch would have accepted never reaches it - and a station whose
  // stop fell just outside would be cached as a permanent negative.
  const station = { id: 'n5', name: 'Idstein (Taunus)', lon: 8.2575508, lat: 50.2159384 };
  const q = new URLSearchParams(stopsBox(station));
  const [minLat, minLon] = q.get('min')!.split(',').map(Number);
  const [maxLat, maxLon] = q.get('max')!.split(',').map(Number);
  assert.ok(minLat < station.lat && station.lat < maxLat);
  assert.ok(minLon < station.lon && station.lon < maxLon);
  // 500 m of latitude is ~0.00449°; 500 m of longitude at 50°N is ~0.00699°.
  assert.ok(Math.abs((station.lat - minLat) * 111320 - 500) < 1);
  assert.ok(
    Math.abs((station.lon - minLon) * 111320 * Math.cos((50.2159384 * Math.PI) / 180) - 500) < 1,
  );
});

test('the sweep never sees the unserved record that ties the geocoder up', () => {
  // Rammingen (Württ) is cached ambiguous under v5 because the geocoder also
  // returns `ch-opentransportdataswiss26_Parent8029711` "Rammingen (Württ)",
  // an exact-name rival that ties with the real stop and gets the station
  // declined.
  //
  // Note what does *not* exclude it: distance. That record sits 6 m from the
  // OSM node - measured, not assumed - and `country=DE`; it is a Swiss
  // operator's entry for a German place, not a stop in Switzerland. It is
  // excluded because it carries `modes: []` (nothing calls there) and
  // /map/stops does not return such records at any box size, while /geocode
  // does. So the box below, the observed 500 m sweep, holds one stop.
  const station = { id: 'n6', name: 'Rammingen (Württ)', lon: 10.1909194, lat: 48.5124141 };
  const result = bestMatch(
    boxCandidates([
      mapStop('de-DELFI_de:08425:2261', 'Rammingen Bahnhof', 48.512489318847656, 10.19048023223877),
    ]),
    station,
  );
  assert.deepEqual(result, { id: 'de-DELFI_de:08425:2261' });
});

test('the sweep picks the station out of the bus stops sharing its village name', () => {
  // Same shape as Rammingen - the v5 ambiguity came from a Dutch feed's
  // exact-name "Lette (Kr Coesfeld)" (`nl-OpenOV_stoparea:17880`), likewise
  // unserved, likewise nearby rather than far: 23 m from the OSM node. Within
  // the box the only exact match on the normalised form is the Bahnhof, and
  // the three "Lette, ..." bus stops that merely start the same way are
  // rejected on the name, not the distance.
  const station = { id: 'n7', name: 'Lette (Kr Coesfeld)', lon: 7.1868406, lat: 51.8926972 };
  const result = bestMatch(
    boxCandidates([
      mapStop(
        'de-DELFI_de:05558:17295:0:1',
        'Lette, Ortsmitte',
        51.8969841003418,
        7.1919121742248535,
      ),
      mapStop(
        'de-DELFI_de:05558:17298:0:1',
        'Lette, Grundschule',
        51.894187927246094,
        7.184967994689941,
      ),
      mapStop(
        'de-DELFI_de:05558:17318:0:1',
        'Lette, Busbahnhof',
        51.89448928833008,
        7.189846038818359,
      ),
      mapStop(
        'de-DELFI_de:05558:19113',
        'Lette (Kreis COE), Bahnhof',
        51.892696380615234,
        7.186934947967529,
      ),
    ]),
    station,
  );
  assert.deepEqual(result, { id: 'de-DELFI_de:05558:19113' });
});

test('the exact-name tier still settles a busy box', () => {
  // Dresden-Neustadt's box holds two Flixbus stops whose names contain the
  // station's name outright, plus five tram stops. Only the rail station
  // normalises equal to "dresden neustadt", so the exact tier takes it and the
  // rest stop counting - the same rule the "Sondern" case above tests, now
  // over a whole neighbourhood's worth of candidates rather than a geocoder's
  // ten best.
  const station = { id: 'n8', name: 'Dresden-Neustadt', lon: 13.7405404, lat: 51.0658669 };
  const result = bestMatch(
    boxCandidates([
      mapStop(
        'de-DELFI_de:14612:241:1:1',
        'Dresden Lößnitzstraße',
        51.06947326660156,
        13.73808765411377,
      ),
      mapStop(
        'eu-flixbus_dcbb7943-9603-11e6-9066-549f350fcb0c',
        'Dresden Neustadt station (Hansastraße)',
        51.066375732421875,
        13.739383697509766,
      ),
      mapStop(
        'de-DELFI_de:14612:16_G',
        'Dresden Bahnhof Neustadt',
        51.06589889526367,
        13.740700721740723,
      ),
      mapStop(
        'de-DELFI_de:14612:17:1:3',
        'Dresden Anton-/Leipziger Str.',
        51.06260299682617,
        13.736048698425293,
      ),
      mapStop(
        'de-DELFI_de:14612:13:1:1',
        'Dresden Albertplatz',
        51.06277847290039,
        13.746065139770508,
      ),
      mapStop(
        'de-DELFI_de:14612:260:1:1',
        'Dresden Dammweg',
        51.06827163696289,
        13.745355606079102,
      ),
      mapStop(
        'de-DELFI_de:14612:199:0:1',
        'Dresden Eisenbahnstraße',
        51.064849853515625,
        13.737800598144531,
      ),
      mapStop(
        'eu-flixbus_eaab22b0-cdc3-43eb-8b7a-cd507f3c40ba',
        'Dresden Neustadt station (Dr.-Friedrich-Wolf-Straße)',
        51.06544876098633,
        13.742239952087402,
      ),
    ]),
    station,
  );
  assert.deepEqual(result, { id: 'de-DELFI_de:14612:16_G' });
});

test('an ungrouped sweep would resolve a rail station to a bus bay', () => {
  // Why `lookup` passes grouped=true, as a fixture rather than a claim. The
  // ungrouped /map/stops response at Idstein (Taunus) has 14 elements; these
  // are the 8 that can affect the verdict (the 6 omitted are both platforms of
  // each of Am Bahndamm, Im Güldenstück and Wiesbadener Straße - which is why
  // it is six and not three - none of which name-matches). The station itself,
  // de-DELFI_de:06439:11318, is absent, and
  // in its place are its three rail platforms and its four bus bays, all named
  // "Idstein Bahnhof". The platforms are the ones carrying parentId, so
  // filtering on parentId - the obvious way to drop platform-level entries -
  // deletes exactly the rail half and leaves a bus bay to win.
  const station = { id: 'n9', name: 'Idstein (Taunus)', lon: 8.2575508, lat: 50.2159384 };
  const ungrouped = [
    {
      ...mapStop(
        'de-DELFI_de:06439:18719:1:1',
        'Idstein Eichenweg',
        50.211467999999996,
        8.260076999999999,
      ),
    },
    {
      ...mapStop('de-DELFI_de:06439:11318:7:7', 'Idstein Bahnhof', 50.21577500000001, 8.257615),
      parentId: 'de-DELFI_de:06439:11318',
    },
    {
      ...mapStop('de-DELFI_de:06439:11318:6:8', 'Idstein Bahnhof', 50.215794, 8.257446000000002),
      parentId: 'de-DELFI_de:06439:11318',
    },
    {
      ...mapStop('de-DELFI_de:06439:11318:6:6', 'Idstein Bahnhof', 50.215794, 8.257446000000002),
      parentId: 'de-DELFI_de:06439:11318',
    },
    { ...mapStop('de-DELFI_de:06439:11318:4:4', 'Idstein Bahnhof', 50.217052, 8.257637) },
    { ...mapStop('de-DELFI_de:06439:11318:3:3', 'Idstein Bahnhof', 50.217, 8.257652) },
    { ...mapStop('de-DELFI_de:06439:11318:2:2', 'Idstein Bahnhof', 50.216879999999996, 8.257667) },
    {
      ...mapStop(
        'de-DELFI_de:06439:11318:1:1',
        'Idstein Bahnhof',
        50.217079999999996,
        8.257594000000001,
      ),
    },
  ];
  const withoutParents = ungrouped.filter((s) => !('parentId' in s));
  assert.deepEqual(
    bestMatch(boxCandidates(withoutParents), station),
    { id: 'de-DELFI_de:06439:11318:1:1' }, // bus bay A - wrong, and confidently so
  );

  // Grouped, the same box returns the station-level id the cache is made of.
  const grouped = [
    mapStop(
      'de-DELFI_de:06439:18209:1:1',
      'Idstein Im Güldenstück',
      50.218074798583984,
      8.260114669799805,
    ),
    mapStop(
      'de-DELFI_de:06439:18719:1:1',
      'Idstein Eichenweg',
      50.21146774291992,
      8.260077476501465,
    ),
    mapStop(
      'de-DELFI_de:06439:18710:1:1',
      'Idstein Wiesbadener Straße',
      50.21775436401367,
      8.26219367980957,
    ),
    mapStop('de-DELFI_de:06439:11318', 'Idstein Bahnhof', 50.21599197387695, 8.257540702819824),
    mapStop(
      'de-DELFI_de:06439:18707:1:1',
      'Idstein Am Bahndamm',
      50.21392059326172,
      8.258651733398438,
    ),
  ];
  assert.deepEqual(bestMatch(boxCandidates(grouped), station), { id: 'de-DELFI_de:06439:11318' });
});

test('the box corners bring in stops past 500 m, and the distance filter drops them', () => {
  // The box is a square around the station, so its corners reach ~707 m and it
  // returns stops `bestMatch` must reject. These two are from the observed
  // Korntal sweep, at 544 m and 510 m. Both *pass* the name filter - "korntal"
  // is contained in each - so the distance check is the only thing that can
  // reject them, which is what makes this worth asserting.
  const station = { id: 'n10', name: 'Korntal', lon: 9.1214162, lat: 48.8265137 };
  assert.equal(
    bestMatch(
      boxCandidates([
        mapStop(
          'de-DELFI_de:08118:2626:0:3',
          'Korntal Bergstraße',
          48.8298225402832,
          9.126882553100586,
        ),
        mapStop(
          'de-DELFI_de:08118:2632:0:3',
          'Korntal Hauffstraße',
          48.82984161376953,
          9.116641998291016,
        ),
      ]),
      station,
    ),
    null,
  );
});

test('a sweep can be legitimately ambiguous, and that verdict is now final', () => {
  // The whole observed Korntal box. Two entries normalise to exactly "korntal"
  // - the stop itself at 26 m and "Korntal Bf (Warthstr.)" at 120 m, once the
  // parenthetical and the "Bf" are stripped - so they land in the exact tier
  // together. Their distances from the station differ by 94 m, inside
  // AMBIGUITY_MARGIN_M. That is a real tie between two distinct stops, not a
  // feed duplicate: they are 131 m from each other, far beyond
  // DUPLICATE_DISTANCE_M.
  //
  // Worth pinning because `lookup` no longer lets the geocoder overturn this:
  // an {ambiguous} from the sweep is returned as-is and the fallbacks are not
  // requested. The station stays re-probeable rather than being handed a
  // confident id by a search that never saw the rival.
  const station = { id: 'n11', name: 'Korntal', lon: 9.1214162, lat: 48.8265137 };
  assert.deepEqual(
    bestMatch(
      boxCandidates([
        mapStop('de-DELFI_de:08118:7603', 'Korntal', 48.8264045715332, 9.121097564697266),
        mapStop(
          'de-DELFI_de:08111:2630:0:3',
          'Greutterstraße',
          48.82299041748047,
          9.120981216430664,
        ),
        mapStop(
          'de-DELFI_de:08118:2631:1:3',
          'Korntal Bf (Warthstr.)',
          48.827579498291016,
          // Real coordinate from the fixture feed; round-trips exactly
          // (Number(x).toString() === '9.121170043945312'), a known false
          // positive for this rule.
          // eslint-disable-next-line no-loss-of-precision
          9.121170043945312,
        ),
        mapStop(
          'de-DELFI_de:08118:2626:0:3',
          'Korntal Bergstraße',
          48.8298225402832,
          9.126882553100586,
        ),
        mapStop(
          'de-DELFI_de:08118:2632:0:3',
          'Korntal Hauffstraße',
          48.82984161376953,
          9.116641998291016,
        ),
        mapStop(
          'de-DELFI_de:08118:2627:0:3',
          'Korntal Stadthalle',
          48.8297233581543,
          9.120001792907715,
        ),
        mapStop(
          'de-DELFI_de:08118:2628:0:3',
          'Korntal Tachenbergstraße',
          48.826297760009766,
          9.124367713928223,
        ),
      ]),
      station,
    ),
    { ambiguous: true },
  );
});

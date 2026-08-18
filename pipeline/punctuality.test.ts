/**
 * The punctuality pipeline turns DB's delay feed into a number the map
 * publishes as fact, so the two places it can silently lie are what is tested
 * here: the join (a row attributed to the wrong S1 puts another city's delays
 * on a line) and the counters (a cancellation folded in as "late", an early
 * departure netting off a real one).
 *
 * The feed values below - the `train_type` spellings especially - are real
 * ones sampled from data-2026-07.parquet.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseRef, rowRef, buildIndex, departureDelayMin, Aggregator,
  ON_TIME_THRESHOLD_MIN, BUCKET_EDGES, bucketOf, quantile,
} from './punctuality.ts';

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

test('normalises a ref the same way the app does', () => {
  assert.equal(normaliseRef('RB 45'), 'rb45');
  assert.equal(normaliseRef('RB44'), 'rb44');
  assert.equal(normaliseRef('S 1 (Nord)'), 's1');
});

test('takes a prefixed line_number as the ref', () => {
  assert.equal(rowRef('S3', 'S'), 's3');
  assert.equal(rowRef('RB55', 'BRB'), 'rb55');
  assert.equal(rowRef('RE9', 'ARV'), 're9');
  // train_type is mostly an operator abbreviation and must not override a
  // line_number that already names the line.
  assert.equal(rowRef('S28', 'R'), 's28');
  assert.equal(rowRef('S46', 'Bus'), 's46');
});

test('borrows a mode prefix for a bare line_number, but only a real one', () => {
  assert.equal(rowRef('6', 'S'), 's6');
  assert.equal(rowRef('58', 'RB'), 'rb58');
  // An operator abbreviation says nothing about which of S6/RE6/RB6 this is.
  assert.equal(rowRef('6', 'AVG'), '');
  assert.equal(rowRef('6', ''), '');
});

test('gives up on a row that names no line', () => {
  // Long-distance: ICE rows carry a train number only.
  assert.equal(rowRef(null, 'ICE'), '');
  assert.equal(rowRef('', 'RE'), '');
});

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

const STATIONS = {
  'suburban|s-bahn hannover|s1': ['Hannover Hbf', 'Wunstorf', 'Haste'],
  'suburban|s-bahn berlin|s1': ['Berlin Friedrichstraße', 'Berlin Hbf', 'Potsdam Hbf'],
  'regional|vrb|re1': ['Braunschweig Hbf', 'Hannover Hbf'],
  'tram|vrb|1': ['Braunschweig Rathaus', 'Hannover Hbf'],
};
const MODES: Record<string, string> = {
  'suburban|s-bahn hannover|s1': 'suburban',
  'suburban|s-bahn berlin|s1': 'suburban',
  'regional|vrb|re1': 'regional',
  'tram|vrb|1': 'tram',
};
const REFS: Record<string, string> = {
  'suburban|s-bahn hannover|s1': 'S1',
  'suburban|s-bahn berlin|s1': 'S1',
  'regional|vrb|re1': 'RE1',
  'tram|vrb|1': '1',
};
const index = () => buildIndex(STATIONS, (id) => MODES[id], (id) => REFS[id]);

test('the station name is what separates two lines sharing a ref', () => {
  const ix = index();
  assert.equal(ix.match('s1', 'Hannover Hbf'), 'suburban|s-bahn hannover|s1');
  assert.equal(ix.match('s1', 'Potsdam Hbf'), 'suburban|s-bahn berlin|s1');
});

test('matches the feed spelling of a station, not just the OSM one', () => {
  const ix = index();
  assert.equal(ix.match('s1', 'Hannover Hauptbahnhof'), 'suburban|s-bahn hannover|s1');
});

test('declines a station the ref does not call at', () => {
  const ix = index();
  assert.equal(ix.match('s1', 'Braunschweig Hbf'), null);
  assert.equal(ix.match('re1', 'Wunstorf'), null);
});

test('declines a ref no line carries', () => {
  assert.equal(index().match('rb99', 'Hannover Hbf'), null);
});

test('drops a row two lines could equally claim rather than guessing', () => {
  const ambiguous = buildIndex(
    { a: ['Hannover Hbf'], b: ['Hannover Hbf'] },
    () => 'regional',
    () => 'RE1',
  );
  assert.equal(ambiguous.match('re1', 'Hannover Hbf'), null);
  assert.equal(ambiguous.stats.ambiguous, 1);
});

test('scores only the modes whose refs can be joined', () => {
  // Tram 1 calls at Hannover Hbf too, but a bare "1" against an
  // operator-abbreviated train_type is not attributable - see SCORED_MODES.
  assert.equal(index().match('1', 'Hannover Hbf'), null);
});

test('memoises without changing the answer', () => {
  const ix = index();
  const first = ix.match('s1', 'Hannover Hbf');
  assert.equal(ix.match('s1', 'Hannover Hbf'), first);
  assert.equal(ix.stats.hits, 2);
});

// ---------------------------------------------------------------------------
// Delay
// ---------------------------------------------------------------------------

const at = (iso: string) => new Date(iso);

test('reads the delay off the two departure timestamps', () => {
  assert.equal(departureDelayMin(at('2026-07-01T08:00:00Z'), at('2026-07-01T08:21:00Z')), 21);
});

test('no re-announced time means it left as planned', () => {
  assert.equal(departureDelayMin(at('2026-07-01T08:00:00Z'), null), 0);
});

test('a stop with no planned departure is not a departure', () => {
  // The last stop of a run: an arrival, and nothing to be punctual about.
  assert.equal(departureDelayMin(null, at('2026-07-01T08:00:00Z')), null);
});

test('an early departure is zero, never a credit against a late one', () => {
  assert.equal(departureDelayMin(at('2026-07-01T08:00:00Z'), at('2026-07-01T07:58:00Z')), 0);
});

test('discards a delay too large to be a train', () => {
  assert.equal(departureDelayMin(at('2026-07-01T08:00:00Z'), at('2026-07-03T08:00:00Z')), null);
});

// ---------------------------------------------------------------------------
// Counters and percentiles
// ---------------------------------------------------------------------------

test('buckets a delay by the minute where the mass is, coarsely in the tail', () => {
  assert.equal(bucketOf(0), 0);
  assert.equal(bucketOf(5), 5);
  assert.equal(bucketOf(20), 20);
  assert.equal(bucketOf(21), 21);
  assert.equal(bucketOf(30), 21);
  assert.equal(bucketOf(31), 22);
  assert.equal(bucketOf(291), 25); // the largest delay in the measured month
  // A sub-minute value is whatever whole minute it has actually reached.
  assert.equal(bucketOf(5.9), 5);
});

/** A histogram with `count` departures in the bucket for `min` minutes late. */
function hist(...pairs: [min: number, count: number][]): number[] {
  const h = new Array(BUCKET_EDGES.length).fill(0);
  for (const [min, count] of pairs) h[bucketOf(min)] += count;
  return h;
}

test('reads a percentile exactly where the buckets are one minute wide', () => {
  const h = hist([0, 30], [1, 40], [2, 20], [10, 10]);
  assert.equal(quantile(h, 0.5), 1);
  assert.equal(quantile(h, 0.9), 2);
  assert.equal(quantile(h, 0.95), 10);
});

test('interpolates across a wide tail bucket rather than pretending precision', () => {
  // 90 on time, 10 spread somewhere in the 31-45 minute bucket. The 95th
  // percentile is halfway into that bucket's mass, so halfway across its span.
  const h = hist([0, 90], [40, 10]);
  assert.equal(quantile(h, 0.95), 38);
});

test('the open-ended top bucket reports its own floor', () => {
  // Nothing above it to interpolate towards; the UI renders this as "91+".
  assert.equal(quantile(hist([0, 90], [200, 10]), 0.95), 91);
});

test('an empty histogram is zero, not a division by zero', () => {
  assert.equal(quantile(hist(), 0.5), 0);
});

/** `n` samples at one station, `late` of them past the threshold. */
function fill(agg: Aggregator, line: string, station: string, n: number, late: number) {
  for (let i = 0; i < n; i++) {
    agg.add(line, station, i < late ? ON_TIME_THRESHOLD_MIN + 4 : 1, false);
  }
}

test('reports the ordinary trip and the bad one, not their average', () => {
  const agg = new Aggregator();
  // A deliberately skewed line: mostly punctual, with a tail that would drag a
  // mean well above anything a rider usually sees.
  for (let i = 0; i < 700; i++) agg.add('l', 'A', 0, false);
  for (let i = 0; i < 200; i++) agg.add('l', 'A', 2, false);
  for (let i = 0; i < 100; i++) agg.add('l', 'A', 60, false);
  const { aggregate } = agg.result().l;
  assert.equal(aggregate.median, 0, 'the typical departure leaves on time');
  assert.equal(aggregate.p90, 2, 'nine in ten are within two minutes');
  assert.equal(aggregate.onTime, 0.9);
  // The mean would have been 6.2 min - worse than 90% of departures, and past
  // the on-time threshold for a line that meets it nine times out of ten.
});

test('scores on-time share over the departures that ran', () => {
  const agg = new Aggregator();
  fill(agg, 'l', 'A', 400, 100);
  const { aggregate, stations } = agg.result().l;
  assert.equal(aggregate.onTime, 0.75);
  assert.equal(stations.A.n, 400);
  assert.equal(stations.A.onTime, 0.75);
  assert.equal(stations.A.median, 1);
  assert.equal(stations.A.p90, ON_TIME_THRESHOLD_MIN + 4);
});

test('a cancellation counts against the cancel rate, not against punctuality', () => {
  const agg = new Aggregator();
  fill(agg, 'l', 'A', 200, 0);
  for (let i = 0; i < 50; i++) agg.add('l', 'A', 0, true);
  const { aggregate, hist: h } = agg.result().l;
  // Every train that ran was on time; a fifth of them never ran.
  assert.equal(aggregate.onTime, 1);
  assert.equal(aggregate.cancelRate, 0.2);
  assert.equal(aggregate.n, 250);
  // A cancelled departure has no delay, so it is not in the histogram either.
  assert.equal(h.reduce((a, b) => a + b, 0), 200);
});

test('breaks the line down by station, worst station included', () => {
  const agg = new Aggregator();
  fill(agg, 'l', 'Good', 100, 0);
  fill(agg, 'l', 'Bad', 100, 90);
  const { stations, aggregate } = agg.result().l;
  assert.equal(stations.Good.onTime, 1);
  assert.equal(stations.Bad.onTime, 0.1);
  assert.equal(aggregate.onTime, 0.55);
  // The breakdown carries the same pair of figures as the line itself.
  assert.equal(stations.Good.p90, 1);
  assert.equal(stations.Bad.median, ON_TIME_THRESHOLD_MIN + 4);
});

test('drops a station the line is merely diverted through, not calling at', () => {
  const agg = new Aggregator();
  // A line calling three times daily for a year at its real stops, plus a
  // handful of diversions through a station it does not serve. The diversions
  // are late, so worst-first would put them top of the ranking - the strongest
  // claim the panel makes, drawn from its weakest sample.
  for (const stop of ['A', 'B', 'C']) fill(agg, 'l', stop, 1000, 100);
  fill(agg, 'l', 'Diverted', 39, 39);
  const { stations, aggregate } = agg.result().l;
  assert.ok(!('Diverted' in stations), 'a diversion is not a calling pattern');
  assert.deepEqual(Object.keys(stations), ['A', 'B', 'C']);
  // Dropped from the breakdown, still counted in what the line did overall.
  assert.equal(aggregate.n, 3039);
});

test('the floor scales with the line, so a rural branch is still reportable', () => {
  const agg = new Aggregator();
  // Every station thin in absolute terms, but none thin *for this line* - a
  // flat national floor would silently delete the whole breakdown.
  for (const stop of ['A', 'B', 'C']) fill(agg, 'l', stop, 400, 40);
  assert.deepEqual(Object.keys(agg.result().l.stations), ['A', 'B', 'C']);
});

test('holds back a sample too small to mean anything', () => {
  const agg = new Aggregator();
  fill(agg, 'l', 'Real', 300, 0);
  const rare = Aggregator.MIN_STATION_SAMPLES - 1;
  fill(agg, 'l', 'Rare', rare, 0);
  const { stations, aggregate } = agg.result().l;
  assert.ok(!('Rare' in stations), 'a station seen a handful of times is not a finding');
  // Held back from the breakdown, still counted in the line's own total.
  assert.equal(aggregate.n, 300 + rare);

  const thin = new Aggregator();
  fill(thin, 'l', 'A', Aggregator.MIN_LINE_SAMPLES - 1, 0);
  assert.deepEqual(thin.result(), {});
});

test('a station with no realtime is dropped, not published as perfect', () => {
  const agg = new Aggregator();
  // 569 departures, every one at exactly zero delay, cancellations reported:
  // the Waldshut signature. Nothing here was ever measured.
  for (let i = 0; i < 569; i++) agg.add('l', 'Waldshut', 0, false);
  for (let i = 0; i < 2; i++) agg.add('l', 'Waldshut', 0, true);
  assert.deepEqual(agg.result(), {});

  // One late minute in a year is enough to show the station is measured, and
  // a near-perfect score is then reported as the real thing it is.
  const measured = new Aggregator();
  for (let i = 0; i < 569; i++) measured.add('l', 'Rottenbach', i === 0 ? 2 : 0, false);
  assert.equal(measured.result().l.aggregate.onTime, 1);
});

/**
 * The coach stage reads a format nothing else in this pipeline reads - a zip of
 * CSV - and cuts a continent-wide network down to one region. Both are places
 * where a quiet mistake produces a map that looks fine and is wrong: a
 * mis-split CSV row silently renames every line whose long name has a comma in
 * it, and a clip that keeps the wrong point draws a coach straight across
 * country it never touches.
 *
 * The zip fixtures are built here rather than committed, so the reader is
 * tested against bytes it did not also produce.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  splitCsvLine, clipToBbox, readZipMembers, parseFeed,
  type Bbox, type CoachSource,
} from './coach.ts';
import type { Coord } from './lib/track.ts';

// ---------------------------------------------------------------------------
// Building a zip to read back
// ---------------------------------------------------------------------------

/**
 * A classic (non-zip64) archive with one local header per member and a central
 * directory, which is exactly the shape GTFS publishers emit. `store` writes a
 * member uncompressed, to cover the other branch of the reader.
 */
function makeZip(members: Record<string, string>, store = new Set<string>()): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(members)) {
    const raw = Buffer.from(text, 'utf8');
    const stored = store.has(name);
    const body = stored ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, body);

    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(stored ? 0 : 8, 10);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    nameBuf.copy(cdh, 46);
    central.push(cdh);

    offset += local.length + body.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(members).length, 8);
  eocd.writeUInt16LE(Object.keys(members).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cd, eocd]);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

test('a quoted field keeps the commas inside it', () => {
  // FlixBus long names carry these constantly - "Berlin, ZOB - Munich" - and a
  // naive split renames the line and shifts every column after it.
  assert.deepEqual(
    splitCsvLine('FLIXBUS-eu,001,"Berlin, ZOB - Munich",3,73D700'),
    ['FLIXBUS-eu', '001', 'Berlin, ZOB - Munich', '3', '73D700'],
  );
});

test('a doubled quote inside a quoted field is one quote', () => {
  assert.deepEqual(
    splitCsvLine('a,"say ""hi""",b'),
    ['a', 'say "hi"', 'b'],
  );
});

test('empty fields survive at both ends', () => {
  assert.deepEqual(splitCsvLine(',a,,b,'), ['', 'a', '', 'b', '']);
});

// ---------------------------------------------------------------------------
// Clipping
// ---------------------------------------------------------------------------

const BOX: Bbox = [0, 0, 10, 10];

test('a line wholly inside the box is returned unchanged', () => {
  const pts: Coord[] = [[1, 1], [2, 2], [3, 3]];
  assert.deepEqual(clipToBbox(pts, BOX), [pts]);
});

test('a line leaving the box stops at the edge, not at the last point inside', () => {
  // The measured failure this replaces: the Kyiv and Bucharest services stride
  // 600 km between shape points once they leave the EU core, so keeping the
  // neighbouring point drew a spike that long out of the region.
  const parts = clipToBbox([[5, 5], [5, 9], [5, 600]], BOX);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0][parts[0].length - 1], [5, 10]);
});

test('a segment crossing the box with neither end inside is still drawn', () => {
  // A point-wise test drops this line entirely, which is how a sparse shape
  // through the region disappears from the map.
  const parts = clipToBbox([[-5, 5], [15, 5]], BOX);
  assert.deepEqual(parts, [[[0, 5], [10, 5]]]);
});

test('a service that leaves the region and returns comes back in two parts', () => {
  const parts = clipToBbox([[1, 5], [4, 5], [-4, 5], [-4, 8], [4, 8], [8, 8]], BOX);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], [[1, 5], [4, 5], [0, 5]]);
  assert.deepEqual(parts[1], [[0, 8], [4, 8], [8, 8]]);
});

test('a line that misses the box entirely yields nothing', () => {
  assert.deepEqual(clipToBbox([[20, 20], [30, 30]], BOX), []);
});

test('touching a corner encloses no length and yields nothing', () => {
  // Passes through (10, 0) exactly, entering and leaving at the same instant.
  assert.deepEqual(clipToBbox([[5, -5], [15, 5]], BOX), []);
});

test('running along the edge counts as being in the region', () => {
  // Not a corner case to be discarded: a coach on a road that follows the
  // region boundary is in the region for the whole of that stretch.
  assert.deepEqual(clipToBbox([[10, -5], [10, 15]], BOX), [[[10, 0], [10, 10]]]);
});

// ---------------------------------------------------------------------------
// The zip reader
// ---------------------------------------------------------------------------

test('reads the members it asks for, deflated or stored', () => {
  const zip = makeZip(
    { 'a.txt': 'hello,world\n1,2\n', 'b.txt': 'x'.repeat(5000), 'c.txt': 'ignored' },
    new Set(['a.txt']),
  );
  const out = readZipMembers(zip, ['a.txt', 'b.txt']);
  assert.equal(out.get('a.txt')!.toString(), 'hello,world\n1,2\n');
  assert.equal(out.get('b.txt')!.toString(), 'x'.repeat(5000));
  assert.equal(out.has('c.txt'), false);
});

test('a feed missing a table it needs says which one', () => {
  const zip = makeZip({ 'routes.txt': 'route_id\n1\n' });
  assert.throws(
    () => readZipMembers(zip, ['routes.txt', 'shapes.txt']),
    /missing shapes\.txt/,
  );
});

// ---------------------------------------------------------------------------
// The feed as a whole
// ---------------------------------------------------------------------------

const SOURCE: CoachSource = {
  name: 'testbus',
  url: '',
  agencies: ['KEEP'],
  refPrefix: 'TestBus ',
  operator: 'TestBus',
  motisPrefix: 'eu-testbus',
};

/**
 * Two agencies, three routes and two shape variants on one route, which is the
 * combination the real feed presents: FlixMobility ships FlixBus and FlixTrain
 * together, and every route runs several variants.
 */
function fixture(): Buffer {
  return makeZip({
    'routes.txt':
      'agency_id,route_id,route_short_name,route_long_name,route_type,route_color\n' +
      'KEEP,r1,TestBus 100,"Hamburg, ZOB - Berlin",3,73D700\n' +
      'KEEP,r2,TestBus 200,Elsewhere - Elsewhere,3,73D700\n' +
      'DROP,r3,TestTrain T1,Should not appear,2,111111\n',
    'trips.txt':
      'route_id,trip_id,shape_id\n' +
      'r1,t1,minor\n' +
      'r1,t2,major\n' +
      'r1,t3,major\n' +
      'r2,t4,away\n' +
      'r3,t5,railshape\n',
    'stops.txt':
      'stop_id,stop_name,stop_lat,stop_lon,stop_code\n' +
      's1,Hamburg ZOB,5,5,HAM\n' +
      's2,Berlin ZOB,8,8,BER\n' +
      's3,Far Away,80,80,FAR\n',
    'stop_times.txt':
      'trip_id,stop_id,stop_sequence\n' +
      't2,s2,2\n' +
      't2,s1,1\n' +
      't1,s3,1\n' +
      't4,s3,1\n',
    'shapes.txt':
      'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n' +
      'major,5,5,0\n' +
      'major,8,8,1\n' +
      'minor,1,1,0\n' +
      'minor,2,2,1\n' +
      'away,80,80,0\n' +
      'away,81,81,1\n' +
      'railshape,5,5,0\n' +
      'railshape,6,6,1\n',
  });
}

test('keeps only the allowed agency, so FlixTrain is not drawn twice', () => {
  const lines = parseFeed(SOURCE, fixture(), BOX);
  assert.deepEqual(lines.map((l) => l.ref), ['100']);
});

test('draws the shape most trips actually run, not the first one seen', () => {
  // `minor` appears first in trips.txt and runs one trip; `major` runs two.
  const [line] = parseFeed(SOURCE, fixture(), BOX);
  assert.deepEqual(line.parts, [[[5, 5], [8, 8]]]);
});

test('strips the operator prefix off the badge but keeps it as the operator', () => {
  const [line] = parseFeed(SOURCE, fixture(), BOX);
  assert.equal(line.ref, '100');
  assert.equal(line.id, 'coach|testbus|100');
  assert.equal(line.operator, 'TestBus');
  assert.equal(line.name, 'Hamburg, ZOB - Berlin');
});

test('the feed colour arrives as a usable hex, not the bare GTFS value', () => {
  const [line] = parseFeed(SOURCE, fixture(), BOX);
  assert.equal(line.colour, '#73d700');
});

test('stops come back in calling order and carry their MOTIS id', () => {
  // stop_times is deliberately out of order in the fixture, as GTFS permits.
  const [line] = parseFeed(SOURCE, fixture(), BOX);
  assert.deepEqual(line.stops.map((s) => s.name), ['Hamburg ZOB', 'Berlin ZOB']);
  assert.equal(line.stops[0].motisId, 'eu-testbus_s1');
});

test('a route that never enters the region is dropped entirely', () => {
  const lines = parseFeed(SOURCE, fixture(), BOX);
  assert.equal(lines.some((l) => l.ref === '200'), false);
});

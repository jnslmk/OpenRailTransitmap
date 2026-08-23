/**
 * The station-mark join: a bar laid across the bundle, covering the lines that
 * stop and only those.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStopMarks, type MarkBundle, type MarkStation } from './lib/stopmarks.ts';
import type { Coord } from './lib/track.ts';
import { slotOffset } from './lib/taper.ts';

/**
 * A bundle with the slots `build.ts` would give it. Real bundles can have gaps
 * in their ordinals, because slots are assigned per corridor rather than per
 * bundle; these test bundles stand alone, so theirs are the plain lattice.
 */
const mb = (lineIds: string[], chains: Coord[][]): MarkBundle => ({
  lineIds,
  chains,
  slots: lineIds.map((_, i) => slotOffset(i, lineIds.length)),
});

/** A due-east corridor at latitude 52, one vertex every ~70 m. */
function eastward(lon0: number, lon1: number, lat = 52): Coord[] {
  const out: Coord[] = [];
  for (let lon = lon0; lon <= lon1 + 1e-9; lon += 0.001) out.push([+lon.toFixed(6), lat]);
  return out;
}

const station = (id: string, coord: Coord, served: string[]): MarkStation => ({
  id,
  coord,
  served: new Set(served),
});

test('a bar spans only the lines that call, centred on their bands', () => {
  // Four lines abreast; the middle two stop here.
  const bundle: MarkBundle = mb(['a', 'b', 'c', 'd'], [eastward(13.0, 13.02)]);
  const marks = buildStopMarks([bundle], [station('n1', [13.01, 52.0005], ['b', 'c'])]);

  const list = marks.get('n1')!;
  assert.equal(list.length, 1);
  const [m] = list;
  assert.equal(m.span, 2);
  assert.deepEqual(m.lines, ['b', 'c']);
  // Ordinals of a four-band bundle are -1.5 -0.5 0.5 1.5, so b..c centres on 0.
  assert.equal(m.mid, 0);
  // Laid across a due-east corridor, the bar runs north-south: 90 degrees.
  assert.equal(Math.round(m.bearing), 90);
});

test('the anchor lands on the corridor, not on the station node', () => {
  const bundle: MarkBundle = mb(['a'], [eastward(13.0, 13.02)]);
  // 0.0009 deg of latitude is ~100 m north of the track.
  const marks = buildStopMarks([bundle], [station('n1', [13.0105, 52.0009], ['a'])]);

  const [m] = marks.get('n1')!;
  assert.ok(Math.abs(m.coord[1] - 52) < 1e-9, `anchor pulled onto the track: ${m.coord[1]}`);
  assert.ok(Math.abs(m.coord[0] - 13.0105) < 1e-6, `anchor kept its position along it`);
});

test('lines that skip the station leave a gap, and the gap splits the bar', () => {
  const bundle: MarkBundle = mb(['a', 'b', 'c'], [eastward(13.0, 13.02)]);
  // The outer two stop, the middle one runs through: two bars, not one.
  const marks = buildStopMarks([bundle], [station('n1', [13.01, 52], ['a', 'c'])]);

  const list = marks.get('n1')!.sort((x, y) => x.mid - y.mid);
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((m) => m.lines),
    [['a'], ['c']],
  );
  assert.deepEqual(
    list.map((m) => m.span),
    [1, 1],
  );
  assert.deepEqual(
    list.map((m) => m.mid),
    [-1, 1],
  );
});

test('a corridor whose bundle changes at the station gets one bar, not two', () => {
  // `x` terminates here: west of the station it runs with `a`, east it does not.
  // Two bundles, same alignment, same heading - one stop.
  const bundles: MarkBundle[] = [
    mb(['a', 'x'], [eastward(13.0, 13.01)]),
    mb(['a'], [eastward(13.01, 13.02)]),
  ];
  const marks = buildStopMarks(bundles, [station('n1', [13.01, 52], ['a', 'x'])]);

  const list = marks.get('n1')!;
  assert.equal(list.length, 1, 'the seam is merged');
  assert.deepEqual(list[0].lines.sort(), ['a', 'x']);
});

// The seam flip only merges cleanly because the slot lattice is symmetric:
// `offset` is signed right-of-drawing-direction, so flipping a stretch negates
// its ordinals, and only a lattice closed under negation lands the band back
// on itself. See slotOffset in lib/taper.ts - this test is what fails first if
// that ever stops being centred.
test('a bundle stitched the other way round is flipped before it is merged', () => {
  const forward = eastward(13.0, 13.01);
  const bundles: MarkBundle[] = [
    mb(['a', 'x'], [forward]),
    // Same lines, same corridor, drawn east-to-west: its ordinals are mirrored.
    mb(['a', 'x'], [[...eastward(13.01, 13.02)].reverse()]),
  ];
  const marks = buildStopMarks(bundles, [station('n1', [13.01, 52], ['a', 'x'])]);

  const list = marks.get('n1')!;
  assert.equal(list.length, 1);
  // Both bundles cover ordinals -0.5..0.5; a flip that was missed would union
  // them into -0.5..0.5 anyway, so check the span rather than trusting equality.
  assert.equal(list[0].span, 2);
  assert.equal(list[0].mid, 0);
});

test('a real junction keeps one bar per corridor', () => {
  const northward: Coord[] = [];
  for (let lat = 51.99; lat <= 52.01 + 1e-9; lat += 0.001) northward.push([13.01, +lat.toFixed(6)]);
  const bundles: MarkBundle[] = [mb(['a'], [eastward(13.0, 13.02)]), mb(['b'], [northward])];
  const marks = buildStopMarks(bundles, [station('n1', [13.01, 52], ['a', 'b'])]);

  const list = marks.get('n1')!;
  assert.equal(list.length, 2);
  const bearings = list.map((m) => Math.round(m.bearing)).sort((x, y) => x - y);
  assert.deepEqual(bearings, [0, 90]);
});

test('a station further off than the snap radius gets no mark at all', () => {
  const bundle: MarkBundle = mb(['a'], [eastward(13.0, 13.02)]);
  // ~1.1 km north of the corridor.
  const marks = buildStopMarks([bundle], [station('n1', [13.01, 52.01], ['a'])]);
  assert.equal(marks.get('n1'), undefined);
});

test('a corridor a station is not served from does not claim it', () => {
  const bundles: MarkBundle[] = [
    mb(['fast'], [eastward(13.0, 13.02)]),
    mb(['slow'], [eastward(13.0, 13.02, 52.0005)]),
  ];
  // Only the slow line calls; the fast track runs past 55 m away.
  const marks = buildStopMarks(bundles, [station('n1', [13.01, 52.0005], ['slow'])]);

  const list = marks.get('n1')!;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].lines, ['slow']);
});

test('two alignments side by side stay two bars, however alike their heading', () => {
  // An S-Bahn on its own pair of tracks 55 m from the mainline, both due east,
  // both calling. They are drawn 55 m apart, so one bar spanning both would be
  // a bar lying on neither.
  const bundles: MarkBundle[] = [
    mb(['re'], [eastward(13.0, 13.02)]),
    mb(['s1'], [eastward(13.0, 13.02, 52.0005)]),
  ];
  const marks = buildStopMarks(
    [bundles[0], bundles[1]],
    [station('n1', [13.01, 52.00025], ['re', 's1'])],
  );

  const list = marks.get('n1')!;
  assert.equal(list.length, 2);
  assert.deepEqual(
    list
      .map((m) => m.lines)
      .flat()
      .sort(),
    ['re', 's1'],
  );
});

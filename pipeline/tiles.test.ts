/**
 * The tile buffer is a number in a shell script, and the thing it has to cover
 * lives in the style. Nothing at runtime relates the two - a band clipped off
 * at a tile edge is not an error anywhere, it is simply a line that stops - so
 * the relation is asserted here instead.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bandReachPx } from '../src/style.ts';
import { MAX_CORRIDOR_LINES } from './lib/corridor.ts';

/** The `--buffer` tiles.sh passes tippecanoe, in 256ths of a tile. */
function tileBuffer(): number {
  const sh = readFileSync('pipeline/tiles.sh', 'utf8');
  const declared = /^BUFFER=(\d+)$/m.exec(sh);
  assert.ok(declared, 'tiles.sh no longer declares BUFFER');
  assert.match(sh, /--buffer="\$BUFFER"/, 'tiles.sh declares BUFFER but does not pass it');
  return Number(declared[1]);
}

/**
 * A tile is 512 px wide when drawn at its own zoom, so one buffer unit is 2 px
 * there. Overzooming - which is all a z13 tile ever gets above z13 - doubles
 * that per zoom step, so native zoom is the thin end and the only one worth
 * checking.
 */
const BUFFER_PX_PER_UNIT = 512 / 256;

/** The zooms tiles.sh builds, plus the two `--extend-zooms-if-still-dropping` can add. */
const TILE_ZOOMS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

test('every tile carries enough of its neighbour for the widest band to be drawn', () => {
  const buffer = tileBuffer() * BUFFER_PX_PER_UNIT;
  for (const zoom of TILE_ZOOMS) {
    const reach = bandReachPx(zoom, MAX_CORRIDOR_LINES);
    assert.ok(
      reach <= buffer,
      `z${zoom}: a band reaches ${reach.toFixed(1)} px from its geometry, `
      + `but a tile only carries ${buffer.toFixed(1)} px of its neighbour's`,
    );
  }
});

test('and not so much more that the tiles are padded for nothing', () => {
  // The other half of the bound: a buffer far wider than any band needs is
  // bytes in every tile in the archive for geometry nothing will ever draw.
  const buffer = tileBuffer() * BUFFER_PX_PER_UNIT;
  const widest = Math.max(...TILE_ZOOMS.map((z) => bandReachPx(z, MAX_CORRIDOR_LINES)));
  assert.ok(
    buffer <= widest * 1.5,
    `the buffer is ${buffer.toFixed(1)} px against a widest reach of ${widest.toFixed(1)} px`,
  );
});

test('a bundle of one still needs the buffer to cover its own stroke', () => {
  // The floor: even where nothing is offset at all, half a line's width hangs
  // over the tile edge, and the selected line's casing is wider still.
  assert.ok(bandReachPx(13, 1) > 0);
  assert.ok(bandReachPx(13, 1) <= tileBuffer() * BUFFER_PX_PER_UNIT);
});

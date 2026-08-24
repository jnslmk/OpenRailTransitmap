/**
 * The tile buffer is a number build.ts writes and a shell script reads, and
 * what it has to cover is a distance the style paints. Nothing at runtime
 * relates the two - a band clipped off at a tile edge is not an error
 * anywhere, it is simply a line that stops - so the relation is asserted here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BUNDLE_SPREAD_STOPS,
  TILE_BUFFER_PX_PER_UNIT,
  TILE_BUFFER_REFERENCE_ZOOM,
  bandReachPx,
  tileBufferUnits,
} from '../shared/lnvg.ts';

const tilesSh = readFileSync('pipeline/tiles.sh', 'utf8');

/** The zooms tiles.sh builds, plus the ones extend-zooms-if-still-dropping can add. */
const TILE_ZOOMS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/** Bundle sizes from a single line to wider than anything Germany carries. */
const BUNDLES = [1, 2, 3, 6, 12, 23, 24, 40];

test('the buffer covers the band at every zoom a tile is drawn at', () => {
  // z14 is where both curves flatten, so tileBufferUnits sizes off it alone.
  // That is only sound if no other zoom asks for more.
  for (const bundle of BUNDLES) {
    const maxAbsOffset = (bundle - 1) / 2;
    const buffer = tileBufferUnits(maxAbsOffset) * TILE_BUFFER_PX_PER_UNIT;
    for (const zoom of TILE_ZOOMS) {
      const reach = bandReachPx(zoom, maxAbsOffset);
      assert.ok(
        reach <= buffer,
        `a bundle of ${bundle} reaches ${reach.toFixed(1)} px at z${zoom}, ` +
          `but its tiles carry only ${buffer.toFixed(1)} px of their neighbours`,
      );
    }
  }
});

test('and the curves it is sized off really are flat above the reference zoom', () => {
  // If a stop is ever added past z14 the reference zoom stops being the
  // widest, and sizing off it would quietly under-cover the zooms beyond.
  const last = BUNDLE_SPREAD_STOPS[BUNDLE_SPREAD_STOPS.length - 1][0];
  assert.ok(
    last <= TILE_BUFFER_REFERENCE_ZOOM,
    `the spread still grows past z${TILE_BUFFER_REFERENCE_ZOOM}`,
  );
});

test('and it is not wider than the widest band needs', () => {
  // The other half of the bound: a buffer far past any band is bytes in every
  // tile in the archive, for geometry nothing will ever draw.
  for (const bundle of BUNDLES) {
    const maxAbsOffset = (bundle - 1) / 2;
    const buffer = tileBufferUnits(maxAbsOffset) * TILE_BUFFER_PX_PER_UNIT;
    const reach = bandReachPx(TILE_BUFFER_REFERENCE_ZOOM, maxAbsOffset);
    assert.ok(
      buffer - reach < TILE_BUFFER_PX_PER_UNIT,
      `bundle of ${bundle}: ${buffer} vs ${reach}`,
    );
  }
});

test('tiles.sh reads the buffer build.ts writes, and falls back wide enough', () => {
  assert.match(
    tilesSh,
    /BUFFER="\$\(cat "\$BUILD\/tile-buffer"/,
    'tiles.sh no longer reads the buffer build.ts writes',
  );
  assert.match(
    tilesSh,
    /--buffer="\$BUFFER"/,
    'tiles.sh reads the buffer but does not pass it to tippecanoe',
  );
  assert.match(
    readFileSync('pipeline/build.ts', 'utf8'),
    /\$\{OUT\}\/tile-buffer/,
    'build.ts no longer writes the buffer tiles.sh reads',
  );

  const fallback = /\|\| echo (\d+)\)"/.exec(tilesSh);
  assert.ok(fallback, 'tiles.sh has no fallback buffer');
  // The fallback stands in for a hand-run against a .work from before this
  // existed, so it has to clear the busiest corridor on the national build.
  assert.ok(
    Number(fallback[1]) >= tileBufferUnits((23 - 1) / 2),
    `the fallback ${fallback[1]} does not cover Germany's widest bundle`,
  );
});

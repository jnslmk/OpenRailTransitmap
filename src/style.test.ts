/**
 * The style is expressions, and an expression fails at runtime or not at all -
 * MapLibre logs a warning and paints nothing. These are the invariants the
 * station marks rest on, checked without a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExpression, validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { STOP_TIERS, stopRank } from '../shared/lnvg.ts';
import { buildStyle, servedByModes, STATION_FILTERS, STOP_MARK_LAYERS } from './style.ts';
import { PILL_PITCH, PILL_THICKNESS, pillLength } from './stopmarks.ts';

const style = buildStyle({ base: '/' });
const layer = (id: string) => {
  const found = style.layers.find((l) => l.id === id);
  assert.ok(found, `no layer ${id}`);
  return found as unknown as { layout?: Record<string, unknown>; paint?: Record<string, unknown> };
};

type Compiled = { evaluate: (globals: unknown, feature: unknown) => unknown };

const evaluate = (value: unknown) => {
  const compiled = createExpression(value);
  assert.equal(compiled.result, 'success', `expression did not compile: ${JSON.stringify(value)}`);
  const expr = (compiled as unknown as { value: Compiled }).value;
  return (zoom: number, properties: Record<string, unknown>) =>
    expr.evaluate({ zoom }, { properties });
};

test('the style validates', () => {
  assert.deepEqual(
    validateStyleMin(style as never).map((e) => e.message),
    [],
  );
});

test('and still validates once the mode filter is folded into it', () => {
  // What applyFilters does at runtime, which is where a bad base filter would
  // otherwise first show up - on a click, in a user's browser.
  const filtered = structuredClone(style);
  const served = servedByModes(['regional', 'tram']);
  for (const l of filtered.layers) {
    const base = STATION_FILTERS[l.id];
    if (base) (l as { filter?: unknown }).filter = ['all', base, served];
  }
  assert.deepEqual(
    validateStyleMin(filtered as never).map((e) => e.message),
    [],
  );
});

test('every layer the app reaches for by name is in the style', () => {
  for (const id of [...STOP_MARK_LAYERS, ...Object.keys(STATION_FILTERS)]) {
    assert.ok(
      style.layers.some((l) => l.id === id),
      `${id} is missing`,
    );
  }
});

test('a bar sits on exactly the bands its centre ordinal names', () => {
  // The whole mechanism in one assertion: `icon-offset` is multiplied by
  // `icon-size`, and the product has to come out at the pixel `line-offset`
  // puts the band at. If these two ever drift apart, the marks slide off the
  // lines they are supposed to be marking and nothing else catches it.
  const size = evaluate(layer('stop-marks-r2').layout!['icon-size']);
  const offset = evaluate(layer('stop-marks-r2').layout!['icon-offset']);
  const band = evaluate(layer('route-regional').paint!['line-offset']);

  for (const zoom of [11, 12, 13.4, 14, 16]) {
    for (const mid of [-7, -3, -0.5, 0, 2.5, 11.5]) {
      const centre = (size(zoom, { mid }) as number) * (offset(zoom, { mid }) as number[])[0];
      const drawn = band(zoom, { offset: mid }) as number;
      assert.ok(
        Math.abs(centre - drawn) < 1e-6,
        `z${zoom} ordinal ${mid}: mark at ${centre}, band at ${drawn}`,
      );
    }
  }
});

test('a bar is as long as the bands it covers', () => {
  assert.equal(pillLength(1), PILL_THICKNESS, 'one line is a round dot');
  for (const span of [2, 5, 12, 24]) {
    assert.ok(
      Math.abs(pillLength(span) - pillLength(span - 1) - PILL_PITCH) < 1e-9,
      `span ${span} did not grow by one band`,
    );
  }
});

test('a rank 0 bar is exact as soon as the spread is big enough to be exact', () => {
  // Rank 0 crosses over to bars at z7, where the spread has collapsed so far
  // that a bar drawn at it would be a speck - so below z8.5 the bar is drawn
  // larger than its bands and is an approximation (see the next test). From the
  // crossing up it is the same exact mechanism every other tier uses, and the
  // compensation in `icon-offset` has to have gone back to 1 to leave it alone.
  const size = evaluate(layer('stop-marks-r0').layout!['icon-size']);
  const offset = evaluate(layer('stop-marks-r0').layout!['icon-offset']);
  const band = evaluate(layer('route-regional').paint!['line-offset']);

  for (const zoom of [9, 10, 11, 13]) {
    for (const mid of [-11.5, -3, -0.5, 0, 2.5, 7]) {
      const centre = (size(zoom, { mid }) as number) * (offset(zoom, { mid }) as number[])[0];
      const drawn = band(zoom, { offset: mid }) as number;
      assert.ok(
        Math.abs(centre - drawn) < 1e-6,
        `z${zoom} ordinal ${mid}: mark at ${centre}, band at ${drawn}`,
      );
    }
  }
});

test('and between those zooms it still lies across the lines it names', () => {
  // The one place the bar is not exact. Its offset is fixed for the width of a
  // zoom bucket while the bands it names keep spreading apart continuously, so
  // within a bucket the bar drifts towards the middle of the bundle. What must
  // survive that drift is the only thing the mark claims: that these lines, the
  // ones under the bar, are the ones that stop. So the drawn bar has to go on
  // covering the drawn bands, from the outermost to the outermost.
  const size = evaluate(layer('stop-marks-r0').layout!['icon-size']);
  const offset = evaluate(layer('stop-marks-r0').layout!['icon-offset']);
  const band = evaluate(layer('route-regional').paint!['line-offset']);

  // Outermost band ordinals a rank 0 stop might cover, worst cases first: a
  // stop at one edge of a 24-band trunk is where the drift is largest.
  for (const zoom of [6.5, 7.4, 7.99, 8.4, 9.6]) {
    for (const [lo, hi] of [
      [-23, 0],
      [-11.5, 11.5],
      [0, 3],
      [4.5, 11.5],
      [-2, -2],
    ]) {
      const mid = (lo + hi) / 2;
      const span = hi - lo + 1;
      const scale = size(zoom, { mid }) as number;
      const centre = scale * (offset(zoom, { mid }) as number[])[0];
      const reach = (pillLength(span) * scale) / 2;
      const bands = [band(zoom, { offset: lo }) as number, band(zoom, { offset: hi }) as number];
      for (const b of bands) {
        assert.ok(
          b >= centre - reach - 1e-9 && b <= centre + reach + 1e-9,
          `z${zoom} bands ${lo}..${hi}: band at ${b} is outside the bar ${centre}+/-${reach}`,
        );
      }
    }
  }
});

test('nothing changes size as a rank 0 dot becomes a rank 0 bar', () => {
  // The changeover swaps the shape and must not swap the size with it: at z7
  // the dot is exactly as wide as the bar is thick, so the mark stays put and
  // only fills out. This is what pins the icon-size floor to its value.
  const radius = evaluate(layer('stop-dots-r0').paint!['circle-radius']);
  const size = evaluate(layer('stop-marks-r0').layout!['icon-size']);
  const dotWidth = 2 * (radius(7, {}) as number);
  const barThickness = (size(7, {}) as number) * PILL_THICKNESS;
  assert.ok(
    Math.abs(dotWidth - barThickness) < 1e-6,
    `dot is ${dotWidth} across, bar is ${barThickness} thick`,
  );
});

test('rank 0 changes over at z7 and the other tiers still change over at z11', () => {
  const changeover = (rank: number) => ({
    dotsEnd: (layer(`stop-dots-r${rank}`) as unknown as { maxzoom: number }).maxzoom,
    barAt: (z: number) => evaluate(layer(`stop-marks-r${rank}`).paint!['icon-opacity'])(z, {}),
    dotAt: (z: number) => evaluate(layer(`stop-dots-r${rank}`).paint!['circle-opacity'])(z, {}),
  });

  const main = changeover(0);
  assert.equal(main.dotsEnd, 7);
  assert.equal(main.barAt(6.4), 0);
  assert.equal(main.barAt(7), 1);
  assert.equal(main.dotAt(7), 0);

  // Rank 1 is the only other tier drawn as a dot first: ranks 2 and 3 are not
  // on the map at all until z11 and z12, by which time the bar is the mark.
  const rest = changeover(1);
  assert.equal(rest.dotsEnd, 11);
  assert.equal(rest.barAt(10.2), 0);
  assert.equal(rest.barAt(11), 1);
  assert.equal(rest.dotAt(11), 0);

  for (const rank of [2, 3]) {
    assert.ok(
      !style.layers.some((l) => l.id === `stop-dots-r${rank}`),
      `rank ${rank} is drawn as a dot, which it has never been`,
    );
    const bars = evaluate(layer(`stop-marks-r${rank}`).paint!['icon-opacity']);
    assert.equal(bars(11, {}), 1, `rank ${rank} bars are not solid where the tier starts`);
  }
});

test('every tier has a mark layer, and its name comes later than its mark', () => {
  for (const tier of STOP_TIERS) {
    const marks = style.layers.find((l) => l.id === `stop-marks-r${tier.rank}`);
    const labels = style.layers.find((l) => l.id === `stop-labels-r${tier.rank}`);
    assert.ok(marks && labels, `rank ${tier.rank} is not drawn`);
    assert.ok(tier.label > tier.mark, `rank ${tier.rank} labels before it marks`);
    // The bars run from the tier's mark zoom without end - a junction's second
    // bar has no name and would otherwise stop being drawn at the label zoom.
    assert.equal((marks as { maxzoom?: number }).maxzoom, undefined);
    assert.equal((marks as { minzoom?: number }).minzoom, tier.mark);
    assert.equal((labels as { minzoom?: number }).minzoom, tier.label);
  }
});

test('an important stop is placed before, and painted over, a lesser one', () => {
  // MapLibre places symbols from the top layer down, so the later a layer is
  // pushed the earlier it is placed and the higher it paints - which for once
  // wants the same order out of both.
  const at = (rank: number) => style.layers.findIndex((l) => l.id === `stop-labels-r${rank}`);
  for (const tier of STOP_TIERS.slice(1)) {
    assert.ok(
      at(tier.rank - 1) > at(tier.rank),
      `rank ${tier.rank - 1} loses collisions to rank ${tier.rank}`,
    );
  }
});

test('a name clears the bar it belongs to, however long that bar is', () => {
  // Its own icon is the one box a symbol's text is never tested against, so
  // the clearance has to be built into the offset or an eight-line bar gets a
  // name lying across it.
  const offset = evaluate(layer('stop-labels-r2').layout!['text-radial-offset']);
  const size = evaluate(layer('stop-labels-r2').layout!['icon-size']);
  for (const zoom of [11, 12, 13, 14, 17]) {
    for (const span of [1, 4, 12, 30]) {
      const clearance = (offset(zoom, { span }) as number) * 12;
      const halfBar = (pillLength(span) / 2) * (size(zoom, {}) as number);
      assert.ok(
        clearance > halfBar,
        `z${zoom} span ${span}: name at ${clearance}px, bar reaches ${halfBar}px`,
      );
    }
  }
});

test('the ranking sorts the stops it is meant to', () => {
  assert.equal(stopRank(['longdistance', 'regional'], 4, false), 0, 'an ICE stop');
  assert.equal(stopRank(['regional'], 2, true), 1, 'a two-line Hbf is an anchor');
  assert.equal(stopRank(['regional'], 4, false), 1, 'four lines is an interchange');
  assert.equal(stopRank(['regional', 'suburban'], 2, false), 1, 'so is a mode change');
  assert.equal(stopRank(['regional'], 1, false), 2, 'a one-line halt waits for z11');
  assert.equal(stopRank(['tram'], 6, false), 3, 'a busy tram stop is still a tram stop');
  assert.equal(stopRank(['tram', 'subway'], 2, false), 1, 'unless the U-Bahn calls too');
});

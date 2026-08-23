/**
 * The style is expressions, and an expression fails at runtime or not at all -
 * MapLibre logs a warning and paints nothing. These are the invariants the
 * station marks rest on, checked without a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExpression, validateStyleMin,
} from '@maplibre/maplibre-gl-style-spec';
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
  const compiled = createExpression(value as never);
  assert.equal(compiled.result, 'success', `expression did not compile: ${JSON.stringify(value)}`);
  const expr = (compiled as unknown as { value: Compiled }).value;
  return (zoom: number, properties: Record<string, unknown>) =>
    expr.evaluate({ zoom }, { properties });
};

test('the style validates', () => {
  assert.deepEqual(validateStyleMin(style as never).map((e) => e.message), []);
});

test('and still validates once the mode filter is folded into it', () => {
  // What applyFilters does at runtime, which is where a bad base filter would
  // otherwise first show up - on a click, in a user's browser.
  const filtered = structuredClone(style) as typeof style;
  const served = servedByModes(['regional', 'tram']);
  for (const l of filtered.layers) {
    const base = STATION_FILTERS[l.id];
    if (base) (l as { filter?: unknown }).filter = ['all', base, served];
  }
  assert.deepEqual(validateStyleMin(filtered as never).map((e) => e.message), []);
});

test('every layer the app reaches for by name is in the style', () => {
  for (const id of [...STOP_MARK_LAYERS, ...Object.keys(STATION_FILTERS)]) {
    assert.ok(style.layers.some((l) => l.id === id), `${id} is missing`);
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
      Math.abs((pillLength(span) - pillLength(span - 1)) - PILL_PITCH) < 1e-9,
      `span ${span} did not grow by one band`,
    );
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
  const at = (rank: number) =>
    style.layers.findIndex((l) => l.id === `stop-labels-r${rank}`);
  for (const tier of STOP_TIERS.slice(1)) {
    assert.ok(at(tier.rank - 1) > at(tier.rank),
      `rank ${tier.rank - 1} loses collisions to rank ${tier.rank}`);
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
      assert.ok(clearance > halfBar,
        `z${zoom} span ${span}: name at ${clearance}px, bar reaches ${halfBar}px`);
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

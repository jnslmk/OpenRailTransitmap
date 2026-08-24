/**
 * The operator filter is two things that have to agree: a predicate the
 * sidebar filters its line index with, and an expression MapLibre filters the
 * map with. A disagreement between them is a line listed but not drawn, which
 * is exactly the sort of thing a browser reports as nothing at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExpression } from '@maplibre/maplibre-gl-style-spec';
import {
  allOperators, drawsEveryOperator, drawsNoOperator, noOperators, operatorExpression,
  operatorKey, operatorShown, readOperators, withOperator, writeOperators,
  type OperatorFilter,
} from './operators.ts';

const filter = (only: boolean, ...names: string[]): OperatorFilter =>
  ({ only, names: new Set(names) });

/** What MapLibre would make of the filter, for a route with this operator. */
function drawn(f: OperatorFilter): (operator: string | undefined) => boolean {
  const expr = operatorExpression(f);
  if (!expr) return () => true;
  const compiled = createExpression(expr as never);
  assert.equal(compiled.result, 'success', `did not compile: ${JSON.stringify(expr)}`);
  const value = (compiled as unknown as {
    value: { evaluate: (g: unknown, f: unknown) => unknown };
  }).value;
  return (operator) => value.evaluate({ zoom: 8 }, {
    properties: operator === undefined ? {} : { operator },
  }) === true;
}

test('no filter draws everything, including a route with no operator', () => {
  const f = allOperators();
  assert.ok(drawsEveryOperator(f));
  assert.equal(operatorExpression(f), null);
  assert.ok(operatorShown(f, 'erixx'));
  assert.ok(operatorShown(f, ''));
});

test('the master switch turned off draws nothing', () => {
  const f = noOperators();
  assert.ok(drawsNoOperator(f));
  assert.equal(operatorShown(f, 'erixx'), false);
  assert.equal(drawn(f)('erixx'), false);
});

test('an allow-list draws only what it names', () => {
  const f = filter(true, 'erixx', 'metronom');
  assert.equal(operatorShown(f, 'erixx'), true);
  assert.equal(operatorShown(f, 'DB Regio AG'), false);
  assert.equal(drawn(f)('metronom'), true);
  assert.equal(drawn(f)('DB Regio AG'), false);
});

test('a deny-list draws everything but', () => {
  const f = filter(false, 'DB Regio AG');
  assert.equal(operatorShown(f, 'DB Regio AG'), false);
  assert.equal(operatorShown(f, 'erixx'), true);
  assert.equal(drawn(f)('DB Regio AG'), false);
  assert.equal(drawn(f)('erixx'), true);
});

test('a route with no operator property is a value, not an error', () => {
  // `['in', null, [...]]` throws at evaluation, and a throwing filter takes
  // the whole layer down rather than the one feature.
  assert.equal(drawn(filter(false, 'DB Regio AG'))(undefined), true);
  assert.equal(drawn(filter(true, 'DB Regio AG'))(undefined), false);
});

test('the predicate and the map filter agree, whichever way the filter is put', () => {
  const operators = ['erixx', 'metronom', 'DB Regio AG', ''];
  for (const only of [true, false]) {
    for (const named of [[], ['erixx'], ['erixx', 'metronom'], operators]) {
      const f = filter(only, ...named);
      const map = drawn(f);
      for (const operator of operators) {
        assert.equal(map(operator), operatorShown(f, operator),
          `${only ? 'only' : 'except'} [${named}] disagreed about ${JSON.stringify(operator)}`);
      }
    }
  }
});

test('a switch adds to the list it belongs in and removes from the other', () => {
  const off = withOperator(allOperators(), 'erixx', false);
  assert.deepEqual(off, filter(false, 'erixx'));
  assert.deepEqual(withOperator(off, 'erixx', true), allOperators());

  const on = withOperator(noOperators(), 'erixx', true);
  assert.deepEqual(on, filter(true, 'erixx'));
  assert.deepEqual(withOperator(on, 'erixx', false), noOperators());
});

test('switching one operator leaves the filter it came from alone', () => {
  const before = filter(false, 'DB Regio AG');
  withOperator(before, 'erixx', false);
  assert.deepEqual(before, filter(false, 'DB Regio AG'));
});

const roundTrip = (f: OperatorFilter): OperatorFilter => {
  const q = new URLSearchParams();
  writeOperators(q, f);
  return readOperators(new URLSearchParams(q.toString()));
};

test('every filter survives the link it is written into', () => {
  for (const f of [
    allOperators(),
    noOperators(),
    filter(true, 'erixx', 'metronom'),
    filter(false, 'DB Regio AG'),
    // The one operator in the data whose name contains the separator the mode
    // list uses, which is why this one does not use it.
    filter(true, 'Ilztalbahn GmbH, Färbergasse 1, 94065 Waldkirchen'),
  ]) {
    assert.deepEqual(roundTrip(f), f, operatorKey(f));
  }
});

test('an unfiltered map puts nothing in the link at all', () => {
  const q = new URLSearchParams();
  writeOperators(q, allOperators());
  assert.equal(q.toString(), '');
});

test('a link from the old single-operator drop-down still means what it said', () => {
  const f = readOperators(new URLSearchParams('op=DB+Regio+AG'));
  assert.deepEqual(f, filter(true, 'DB Regio AG'));
});

test('the signature ignores the order the reader clicked in', () => {
  assert.equal(operatorKey(filter(true, 'a', 'b')), operatorKey(filter(true, 'b', 'a')));
  assert.notEqual(operatorKey(filter(true, 'a')), operatorKey(filter(false, 'a')));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSelection, readState } from './state.ts';

const registry = new Map<string, { mode: 'tram'; operator: string }>();
registry.set('tram|test|1', { mode: 'tram', operator: 'Test Transit' });

function restored(query: string) {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { search: query, hash: '', pathname: '/' },
  });
  return readState({ center: [9.73, 52.63], zoom: 7 });
}

test('a restored selection is cleared when its registered mode is disabled', () => {
  const state = restored('?modes=regional&line=tram%7Ctest%7C1');

  assert.equal(normalizeSelection(state, registry), true);
  assert.equal(state.selected, null);
});

test('a restored selection is cleared when it is absent from the loaded registry', () => {
  const state = restored('?line=unknown%7Cline');

  assert.equal(normalizeSelection(state, registry), true);
  assert.equal(state.selected, null);
});

test('a restored selection is cleared when its operator is excluded', () => {
  const state = restored('?opoff=Test+Transit&line=tram%7Ctest%7C1');

  assert.equal(normalizeSelection(state, registry), true);
  assert.equal(state.selected, null);
});

test('a restored selection survives while its line remains visible', () => {
  const state = restored('?modes=tram&op=Test+Transit&line=tram%7Ctest%7C1');

  assert.equal(normalizeSelection(state, registry), false);
  assert.equal(state.selected, 'tram|test|1');
});

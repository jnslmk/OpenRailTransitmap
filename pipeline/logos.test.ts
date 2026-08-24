/**
 * The parts of the logo pipeline that decide *which* file ships, checked
 * without a network. Everything these guard is a judgement made once, in a
 * step a human runs by hand and then forgets about for months.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEPT_TYPES, MAX_BYTES, licenceAllowed, logoCandidates, searchVariants, slugFor,
  type WikidataEntity,
} from './logos.ts';

// ---------------------------------------------------------------------------
// Licensing
// ---------------------------------------------------------------------------

test('only public domain and CC0 are shippable', () => {
  for (const ok of ['Public domain', 'public domain', 'CC0', 'CC0 1.0']) {
    assert.ok(licenceAllowed(ok), ok);
  }
  for (const no of ['CC BY-SA 4.0', 'CC BY 3.0', 'Fair use', '', null, undefined]) {
    assert.equal(licenceAllowed(no), false, String(no));
  }
});

test('the licence is read through the markup Commons wraps it in', () => {
  assert.ok(licenceAllowed('<span class="licence">Public domain</span>'));
  assert.equal(licenceAllowed('<a href="/wiki/CC-BY-SA">CC BY-SA 4.0</a>'), false);
});

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

test('an operator tag is searched under the names it might be found by', () => {
  assert.deepEqual(searchVariants('Rheinbahn AG'), ['Rheinbahn AG', 'Rheinbahn']);
  // The one operator in the registry registered with its postal address.
  assert.deepEqual(
    searchVariants('Ilztalbahn GmbH, Färbergasse 1, 94065 Waldkirchen')
      .includes('Ilztalbahn GmbH'), true,
  );
  // A joint service is matched on the operator its tag leads with.
  assert.equal(searchVariants('CFL;DB Fernverkehr AG')[0], 'CFL');
  assert.ok(searchVariants('Bayerische Regiobahn (BRB)').includes('Bayerische Regiobahn'));
});

test('a variant that collapses to nothing is not searched for', () => {
  // Stripping the legal form off "AG" leaves an empty string, and an empty
  // search matches the whole of Wikidata.
  for (const variant of searchVariants('AG')) assert.ok(variant.length > 2, variant);
});

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

test('a Commons filename becomes a plain, unambiguous path', () => {
  const name = slugFor('Logo Südostbayernbahn (2015).svg', 'image/svg+xml');
  assert.match(name, /^[a-z0-9-]+-[a-z0-9]+\.svg$/);
  assert.ok(name.startsWith('logo-sudostbayernbahn'), name);
});

test('two files that read alike still get different names', () => {
  const a = slugFor('DB Regio Logo.svg', 'image/svg+xml');
  const b = slugFor('DB-Regio-Logo.svg', 'image/svg+xml');
  assert.notEqual(a, b);
});

test('the extension follows the file, not the name it came with', () => {
  assert.ok(slugFor('Havag logo.svg', 'image/png').endsWith('.png'));
  assert.ok(slugFor('SWH logo.jpg', 'image/jpeg').endsWith('.jpg'));
  for (const mime of KEPT_TYPES) assert.match(slugFor('x.svg', mime), /\.[a-z]+$/);
});

// ---------------------------------------------------------------------------
// Which logo an item is wearing
// ---------------------------------------------------------------------------

const claim = (value: string, extra: Record<string, unknown> = {}) => ({
  mainsnak: { datavalue: { value } }, ...extra,
});
const item = (claims: Record<string, unknown[]>): WikidataEntity =>
  ({ claims } as WikidataEntity);

test('a retired mark is not the current one', () => {
  // CFL's item leads with the logo it wore in 1946.
  const entity = item({
    P154: [claim('Logo CFL (1946).svg', { qualifiers: { P582: [{}] } }), claim('CFL logo.svg')],
  });
  assert.deepEqual(logoCandidates(entity), ['CFL logo.svg']);
});

test('a deprecated claim is not offered at all', () => {
  const entity = item({ P154: [claim('Old.svg', { rank: 'deprecated' })] });
  assert.deepEqual(logoCandidates(entity), []);
});

test("Wikidata's preferred mark leads, and the rest follow in order", () => {
  const entity = item({
    P154: [claim('Second.svg'), claim('Preferred.svg', { rank: 'preferred' }), claim('Third.svg')],
  });
  assert.deepEqual(logoCandidates(entity), ['Preferred.svg', 'Second.svg', 'Third.svg']);
});

test('the icon property is a fallback, never the first answer', () => {
  const entity = item({ P154: [claim('Wordmark.svg')], P8972: [claim('Favicon.png')] });
  assert.deepEqual(logoCandidates(entity), ['Wordmark.svg', 'Favicon.png']);
  assert.deepEqual(logoCandidates(item({ P8972: [claim('Favicon.png')] })), ['Favicon.png']);
});

test('every candidate is offered, so the caller can skip an unshippable one', () => {
  // The Hallesche Verkehrs-AG: a 1.2 MB scan in front of a 12 kB SVG of the
  // same mark. Returning only the first would cost the logo entirely.
  const entity = item({ P154: [claim('Huge.jpg'), claim('Small.svg')] });
  assert.deepEqual(logoCandidates(entity), ['Huge.jpg', 'Small.svg']);
});

test('an item with no logo claim at all yields nothing', () => {
  assert.deepEqual(logoCandidates(item({})), []);
  assert.deepEqual(logoCandidates(item({ P154: [{ mainsnak: {} }] })), []);
});

// ---------------------------------------------------------------------------
// The committed manifest
// ---------------------------------------------------------------------------

test('the committed manifest only names files the panel can use', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  if (!existsSync('data/operator-logos.json')) return; // A checkout without one.
  const manifest = JSON.parse(readFileSync('data/operator-logos.json', 'utf8'));
  const seen = new Map<string, string>();
  for (const [operator, entry] of Object.entries(manifest) as [string, {
    qid: string; label: string; commons: string; file: string; licence: string;
  }][]) {
    assert.ok(licenceAllowed(entry.licence), `${operator}: ${entry.licence}`);
    assert.match(entry.qid, /^Q\d+$/, `${operator}: ${entry.qid}`);
    assert.match(entry.file, /^[a-z0-9.-]+$/, `${operator}: ${entry.file}`);
    // One Commons file, one site filename, in both directions - the fetch
    // stage writes by site filename and would otherwise overwrite one with
    // the other.
    const already = seen.get(entry.file);
    assert.ok(already === undefined || already === entry.commons,
      `${entry.file} is claimed by both ${already} and ${entry.commons}`);
    seen.set(entry.file, entry.commons);
  }
});

test('the size cap is smaller than the files it exists to refuse', () => {
  assert.ok(MAX_BYTES < 469_000, 'the 469 kB scan must not pass');
  assert.ok(MAX_BYTES > 100_000, 'but an ordinary detailed SVG must');
});

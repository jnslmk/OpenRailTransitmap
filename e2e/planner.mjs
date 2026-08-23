/**
 * End-to-end check of the journey planner, driven against a real deployment.
 *
 *   node e2e/planner.mjs                                  # the published site
 *   node e2e/planner.mjs --url http://127.0.0.1:5173/     # a local dev server
 *   node e2e/planner.mjs --headed                         # watch it run
 *   node e2e/planner.mjs --relay-api                      # see below
 *
 * The planner is the one part of this app that cannot be checked from the
 * tiles: it is a live conversation with Transitous, and the shapes it returns
 * change with the timetable. So these cases pin down the things that must hold
 * whatever comes back - that a place resolves, that an itinerary is drawn on
 * the map in the map's own colours, that the bike slider actually reaches the
 * request, and that a link restores the whole plan - rather than any particular
 * journey.
 *
 * `--relay-api` answers the Transitous calls from Node instead of from the
 * browser. It exists for sandboxes whose browser cannot reach the open internet
 * even through a proxy; the page still issues its own requests and parses the
 * real responses, only the transport underneath is substituted. Do not use it
 * against a deployment you are actually trying to test the network path of.
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const BASE = flag('url', 'https://jnslmk.github.io/OpenRailTransitmap/').replace(/\/?$/, '/');
const HEADED = args.includes('--headed');
const RELAY = args.includes('--relay-api');

/**
 * A village in the Aller valley, and Hannover Hbf.
 *
 * Chosen because it is the journey this feature exists for: the origin is
 * nowhere near a station, so the planner has to cycle out of it to reach one,
 * and every itinerary is bike + bus/rail. A city-to-city pair would pass these
 * cases without ever exercising the part that matters.
 */
const RURAL = '~52.75500~9.38300~Aller+valley';
const HANNOVER = '~52.37590~9.73200~Hannover+Hbf';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const results = [];
let currentCase = null;

function check(ok, what, detail = '') {
  currentCase.checks.push({ ok, what, detail });
  if (!ok) currentCase.failed = true;
}

const eq = (actual, expected, what) =>
  check(
    Object.is(actual, expected),
    what,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

async function testCase(name, fn) {
  currentCase = { name, checks: [], failed: false };
  results.push(currentCase);
  try {
    await fn();
  } catch (err) {
    check(false, 'threw', String(err?.stack ?? err));
  }
}

/** Wait for the map and the first paint, as legend.mjs does. */
const ready = (page) => page.waitForSelector('body.ready', { timeout: 40000 });

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function run(page) {
  await testCase('the sidebar offers a Plan tab, and coach as a mode', async () => {
    await page.goto(BASE, { waitUntil: 'load' });
    await ready(page);

    const tabs = await page.$$eval('.tab', (n) => n.map((x) => x.textContent));
    check(tabs.includes('Plan'), 'a Plan tab exists', JSON.stringify(tabs));

    const modes = await page.$$eval('.toggle .label', (n) => n.map((x) => x.textContent));
    check(modes.includes('Long-distance coach'), 'coach has a legend row', JSON.stringify(modes));

    await page.click('.tab:nth-child(2)');
    await page.waitForSelector('.plan-form', { timeout: 10000 });
    const chips = await page.$$eval('.plan-form .chip', (n) => n.map((x) => x.textContent));
    check(chips.includes('Coach'), 'coach can be routed on', JSON.stringify(chips));
  });

  await testCase('typing a place name offers places to start from', async () => {
    await page.fill('.plan-places > .plan-field:nth-of-type(1) input', 'Hannover Hauptbahnhof');
    await page.waitForSelector('.plan-suggestions.open .plan-suggestion', { timeout: 25000 });
    const names = await page.$$eval('.plan-suggestion-name', (n) => n.map((x) => x.textContent));
    check(names.length > 0, 'the geocoder returned something', JSON.stringify(names.slice(0, 3)));
    // A stop is what the router can plan from exactly, and at a Hauptbahnhof
    // the geocoder must be offering one rather than only the surrounding POIs.
    const stops = await page.$$('.plan-suggestion.is-stop');
    check(stops.length > 0, 'at least one suggestion is a stop');
  });

  await testCase('a link with both ends plans and draws the journey', async () => {
    await page.goto(`${BASE}?tab=plan&from=${RURAL}&to=${HANNOVER}&bike=45`, { waitUntil: 'load' });
    await ready(page);
    await page.waitForSelector('.itin', { timeout: 40000 });

    const n = await page.$$eval('.itin', (x) => x.length);
    check(n > 0, 'itineraries came back', `${n}`);

    const readout = await page.$eval('.plan-readout', (x) => x.textContent);
    eq(readout, '45 min', 'the bike slider restored from the link');

    // The point of the whole feature: an origin off the network is reached by
    // bike, and the itinerary says how long that is.
    const bike = await page.$('.itin-street.is-bike');
    check(!!bike, 'a bike leg is in the mode strip');
    const notes = await page.$$eval('.itin-note', (x) => x.map((y) => y.textContent));
    check(
      notes.some((t) => /riding/.test(t)),
      'riding time is stated',
      JSON.stringify(notes),
    );

    const drawn = await page.evaluate(() => {
      const m = window.__map;
      return {
        transit: m.queryRenderedFeatures({ layers: ['itinerary-transit'] }).length,
        ends: m.queryRenderedFeatures({ layers: ['itinerary-ends'] }).length,
        dimmed: m.getPaintProperty('route-regional', 'line-opacity'),
      };
    });
    check(drawn.transit > 0, 'transit legs are drawn on the map', JSON.stringify(drawn));
    eq(drawn.ends, 2, 'both ends of the journey are marked');
    check(
      typeof drawn.dimmed === 'number' && drawn.dimmed < 1,
      'the network dims behind the journey',
      String(drawn.dimmed),
    );
  });

  await testCase('a leg says what it cannot promise about bikes', async () => {
    await page.waitForSelector('.leg-list .leg', { timeout: 10000 });
    const flags = await page.$$eval('.leg-flags', (n) => n.map((x) => x.textContent).join(' | '));
    // `bikesAllowed: false` and "the feed did not say" are indistinguishable in
    // the API, so the UI must never render the first as a refusal. See the note
    // in src/routing.ts.
    check(
      /not published|Bikes carried/.test(flags),
      'bike carriage is stated honestly',
      flags.slice(0, 200),
    );
  });

  await testCase('the plan survives being shared', async () => {
    const url = page.url();
    const q = new URL(url).searchParams;
    eq(q.get('tab'), 'plan', 'the tab is in the URL');
    check(!!q.get('from') && !!q.get('to'), 'both ends are in the URL', url);
    check(q.get('itin') !== null, 'the drawn itinerary is in the URL', url);
  });

  await testCase('a fresh visit plans with a bike, not without one', async () => {
    // Regression: `Number(null)` is 0 and 0 is a valid slider step, so reading
    // an absent `bike` parameter as a number turned every plain visit into
    // "no bike" - silently disabling the one thing this planner is for.
    await page.goto(`${BASE}?tab=plan`, { waitUntil: 'load' });
    await ready(page);
    const readout = await page.$eval('.plan-readout', (x) => x.textContent);
    eq(readout, '30 min', 'the bike slider defaults to riding, not to walking');
  });
}

// ---------------------------------------------------------------------------

// PLAYWRIGHT_CHROMIUM lets a preinstalled browser stand in for the one the
// installed Playwright build would otherwise download. Chromium does not read
// HTTPS_PROXY, so a network that only goes out through a proxy has to be told
// about it here - and told to leave a local dev server alone.
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const browser = await chromium.launch({
  headless: !HEADED,
  ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
  ...(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {}),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

if (RELAY) {
  await context.route('**://api.transitous.org/**', async (route) => {
    const res = await fetch(route.request().url(), {
      headers: {
        // Transitous asks for a descriptive User-Agent and refuses the default
        // Node one outright, which a browser never sends anyway.
        'user-agent': 'OpenRailTransitmap-e2e/0.1 (+https://github.com/jnslmk/OpenRailTransitmap)',
      },
    });
    await route.fulfill({
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
      body: Buffer.from(await res.arrayBuffer()),
    });
  });
}

const page = await context.newPage();
page.on('pageerror', (err) => console.error('[page error]', err.message));

console.log(`planner e2e against ${BASE}${RELAY ? ' (API relayed through Node)' : ''}\n`);
await run(page);
await browser.close();

let failed = 0;
for (const c of results) {
  console.log(`${c.failed ? 'FAIL' : 'ok  '}  ${c.name}`);
  for (const chk of c.checks) {
    if (!chk.ok) console.log(`        ✗ ${chk.what}${chk.detail ? ` — ${chk.detail}` : ''}`);
  }
  if (c.failed) failed++;
}
console.log(`\n${results.length - failed}/${results.length} cases passed`);
process.exit(failed ? 1 : 0);

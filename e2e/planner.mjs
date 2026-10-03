/**
 * End-to-end check of the journey planner, driven against a real deployment.
 *
 *   node e2e/planner.mjs                                  # the published site
 *   node e2e/planner.mjs --url http://127.0.0.1:5173/     # a local dev server
 *   node e2e/planner.mjs --headed                         # watch it run
 *   node e2e/planner.mjs --relay-api                      # see below
 *   node e2e/planner.mjs --autocomplete-only              # deterministic keyboard regression
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
const AUTOCOMPLETE_ONLY = args.includes('--autocomplete-only');

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

async function autocomplete(page) {
  await testCase('autocomplete highlights and commits the current keyboard choice', async () => {
    const from = '.plan-field input[name="from"]';
    const to = '.plan-field input[name="to"]';
    const area = [{ name: 'Braunschweig', adminLevel: 8, default: true }];
    const places = [
      { type: 'PLACE', category: 'place_city', name: 'Braunschweig', lat: 52.26, lon: 10.52 },
      {
        type: 'STOP',
        id: 'hbf',
        name: 'Braunschweig Hbf',
        lat: 52.25,
        lon: 10.54,
        modes: ['REGIONAL_RAIL'],
      },
      ...Array.from({ length: 5 }, (_, i) => ({
        type: 'STOP',
        id: `bus-${i}`,
        name: `Braunschweig Bus ${i}`,
        lat: 52.26,
        lon: 10.52,
        modes: ['BUS'],
      })),
      { type: 'ADDRESS', name: 'Braunschweig Schloss 1', lat: 52.26, lon: 10.52 },
    ].map((place) => ({ ...place, areas: area, country: 'DE' }));
    const address = (name) => ({ type: 'ADDRESS', name, lat: 52.26, lon: 10.52 });
    const gates = new Map();
    const hold = (text) => {
      let release;
      const response = new Promise((resolve) => {
        release = resolve;
      });
      gates.set(text, { response, release });
      const request = page.waitForRequest(
        (request) => new URL(request.url()).searchParams.get('text') === text,
        { timeout: 5000 },
      );
      return { request, release };
    };
    const routeHandler = async (route) => {
      const text = new URL(route.request().url()).searchParams.get('text');
      const gate = gates.get(text);
      if (gate) await gate.response;
      const body = text === 'Braunsch' ? places : [address(`${text} 1`), address(`${text} 2`)];
      // A superseded query can already have been aborted by the browser.
      await route.fulfill({ json: body }).catch(() => {});
    };
    await page.route('**/api/v1/geocode?**', routeHandler);
    const active = async (field, name) => {
      await page.waitForFunction(
        ({ field, name }) => {
          const input = document.querySelector(field);
          const row = document.getElementById(input?.getAttribute('aria-activedescendant'));
          return row?.querySelector('.plan-suggestion-name')?.textContent === name;
        },
        { field, name },
      );
      const state = await page.$eval(field, (input) => {
        const list = document.getElementById(input.getAttribute('aria-controls'));
        const row = document.getElementById(input.getAttribute('aria-activedescendant'));
        const bounds = row.getBoundingClientRect();
        const viewport = list.getBoundingClientRect();
        return {
          expanded: input.getAttribute('aria-expanded'),
          listRole: list.getAttribute('role'),
          optionRole: row.getAttribute('role'),
          selected: row.getAttribute('aria-selected'),
          count: list.querySelectorAll('[aria-selected="true"]').length,
          highlighted: row.classList.contains('is-active'),
          visible: bounds.top >= viewport.top && bounds.bottom <= viewport.bottom,
          focused: document.activeElement === input,
        };
      });
      eq(state.expanded, 'true', `${name}: combobox is expanded`);
      eq(state.listRole, 'listbox', `${name}: controls its listbox`);
      eq(state.optionRole, 'option', `${name}: active descendant is an option`);
      eq(state.selected, 'true', `${name}: active option is selected`);
      eq(state.count, 1, `${name}: only one option is selected`);
      check(
        state.highlighted && state.visible && state.focused,
        `${name}: highlighted, visible, input focused`,
        JSON.stringify(state),
      );
    };
    const chosen = async (field, name) => {
      await page.waitForFunction(
        ({ field, name }) => document.querySelector(field)?.value === name,
        { field, name },
      );
      eq(await page.getAttribute(field, 'aria-expanded'), 'false', `${name}: list closed`);
      eq(
        await page.getAttribute(field, 'aria-activedescendant'),
        null,
        `${name}: no stale active descendant`,
      );
      check(
        await page.$eval(field, (input) => document.activeElement === input),
        `${name}: focus survives form redraw`,
      );
    };
    try {
      await page.goto(`${BASE}?tab=plan`, { waitUntil: 'load' });
      await ready(page);
      const controls = await page.$$eval('.plan-field input', (inputs) =>
        inputs.map((input) => ({
          role: input.getAttribute('role'),
          controls: input.getAttribute('aria-controls'),
          expanded: input.getAttribute('aria-expanded'),
        })),
      );
      check(
        controls.every((input) => input.role === 'combobox' && input.expanded === 'false'),
        'both fields start as closed comboboxes',
      );
      check(
        controls[0].controls !== controls[1].controls,
        'the two fields control independent lists',
      );
      await page.fill(to, 'Braunsch');
      await active(to, 'Braunschweig Hbf');
      eq(
        await page.getAttribute(from, 'aria-expanded'),
        'false',
        'destination suggestions do not expand origin',
      );
      const names = await page.$$eval('#plan-to-suggestions .plan-suggestion-name', (rows) =>
        rows.map((row) => row.textContent),
      );
      check(
        names.includes('Braunschweig') && names.includes('Braunschweig Schloss 1'),
        'city and address remain available',
      );
      await page.press(to, 'ArrowDown');
      await active(to, 'Braunschweig');
      await page.press(to, 'ArrowUp');
      await active(to, 'Braunschweig Hbf');
      await page.press(to, 'ArrowUp');
      await active(to, 'Braunschweig Schloss 1');
      await page.press(to, 'ArrowDown');
      await active(to, 'Braunschweig Hbf');
      await page.press(to, 'Enter');
      await chosen(to, 'Braunschweig Hbf');
      await page.keyboard.type('x');
      eq(
        await page.inputValue(to),
        'Braunschweig Hbfx',
        'typing continues in destination after selection',
      );

      // Start with no committed destination so selecting origin does not plan.
      await page.goto(`${BASE}?tab=plan`, { waitUntil: 'load' });
      await ready(page);
      await page.fill(from, 'Braunsch');
      await active(from, 'Braunschweig Hbf');
      eq(
        await page.getAttribute(to, 'aria-expanded'),
        'false',
        'origin suggestions do not expand destination',
      );
      await page.press(from, 'ArrowDown');
      await active(from, 'Braunschweig');
      await page.press(from, 'Enter');
      await chosen(from, 'Braunschweig');
      await page.fill(from, 'Schloss');
      eq(
        await page.getAttribute(from, 'aria-activedescendant'),
        null,
        'typing immediately clears stale active option',
      );
      await active(from, 'Schloss 1');
      await page.click('#plan-from-option-1');
      await chosen(from, 'Schloss 2');
      await page.fill(from, 'Braunsch');
      await page.press(from, 'Enter');
      await chosen(from, 'Braunschweig Hbf');

      const early = hold('Frueh');
      await page.fill(from, 'Frueh');
      await early.request;
      await page.press(from, 'Enter');
      early.release();
      await chosen(from, 'Frueh 1');

      const old = hold('Alt');
      await page.fill(from, 'Alt');
      await page.press(from, 'Enter');
      await old.request;
      await page.fill(from, 'Schloss');
      old.release();
      await active(from, 'Schloss 1');
      eq(
        await page.inputValue(from),
        'Schloss',
        'new query cancels pending Enter and ignores stale response',
      );
      await page.press(from, 'ArrowDown');
      await active(from, 'Schloss 2');
      await page.press(from, 'Enter');
      await chosen(from, 'Schloss 2');

      const cancelled = hold('Abbruch');
      await page.fill(from, 'Abbruch');
      await page.press(from, 'Enter');
      await cancelled.request;
      await page.press(from, 'Escape');
      cancelled.release();
      await page.waitForTimeout(450);
      eq(await page.inputValue(from), 'Abbruch', 'Escape cancels pending selection');
      eq(
        await page.getAttribute(from, 'aria-expanded'),
        'false',
        'Escape keeps suggestions closed',
      );
      eq(
        await page.getAttribute(from, 'aria-activedescendant'),
        null,
        'Escape clears active descendant',
      );
    } finally {
      for (const gate of gates.values()) gate.release();
      await page.unroute('**/api/v1/geocode?**', routeHandler);
    }
  });
}

async function run(page) {
  let navigatorLanguage = '';

  await testCase('the sidebar offers a Plan tab, and coach as a mode', async () => {
    await page.goto(BASE, { waitUntil: 'load' });
    await ready(page);
    navigatorLanguage = await page.evaluate(() => navigator.language);

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

  await testCase('Enter takes the first suggestion', async () => {
    // A rider who types a station name and hits return means the top hit, so
    // the key must commit it rather than do nothing.
    const from = '.plan-places > .plan-field:nth-of-type(1) input';
    const first = await page.$eval('.plan-suggestion-name', (x) => x.textContent);
    await page.press(from, 'Enter');
    await page
      .waitForSelector('.plan-suggestions.open', { state: 'detached', timeout: 5000 })
      .catch(() => {});
    eq(await page.inputValue(from), first, 'the field holds the first suggestion');
    check(
      await page.$eval(from, (input) => document.activeElement === input),
      'Enter keeps the origin field focused',
    );
    await page.keyboard.type('x');
    eq(await page.inputValue(from), `${first}x`, 'typing continues without clicking the field');
    await page.keyboard.press('Backspace');
  });

  await testCase("a departure has a day and a clock, in the browser's locale", async () => {
    await page.selectOption('.plan-when select', 'depart');
    await page.waitForSelector('.plan-at', { timeout: 5000 });

    // Regression: a single `datetime-local` fitted the date and pushed the time
    // out of the sidebar, so the hour could be read but never set.
    const fields = await page.$$eval('.plan-at input', (n) =>
      n.map((x) => ({
        type: x.type,
        lang: x.lang,
        width: Math.round(x.getBoundingClientRect().width),
      })),
    );
    eq(
      fields.map((f) => f.type).join('+'),
      'date+time',
      'the day and the clock are separate fields',
    );
    check(
      fields.every((f) => f.width > 60),
      'both are wide enough to use',
      JSON.stringify(fields),
    );
    check(
      fields.every((f) => f.lang === navigatorLanguage),
      'both format for the rider, not the page',
      JSON.stringify(fields),
    );

    await page.fill('.plan-date', '2026-08-25');
    await page.fill('.plan-time', '07:12');
    const at = await page.evaluate(() => new URL(location.href).searchParams.get('at'));
    const clock = await page.evaluate((iso) => {
      const d = new Date(iso);
      return `${d.getHours()}:${d.getMinutes()}`;
    }, at);
    eq(clock, '7:12', 'the chosen clock time is what gets planned with');
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
await autocomplete(page);
if (!AUTOCOMPLETE_ONLY) await run(page);
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

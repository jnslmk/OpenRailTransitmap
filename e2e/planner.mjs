/**
 * End-to-end check of the journey planner, driven against a real deployment.
 *
 *   node e2e/planner.mjs                                  # the published site
 *   node e2e/planner.mjs --url http://127.0.0.1:5173/     # a local dev server
 *   node e2e/planner.mjs --headed                         # watch it run
 *   node e2e/planner.mjs --relay-api                      # see below
 *   node e2e/planner.mjs --autocomplete-only              # deterministic keyboard regression
 *   node e2e/planner.mjs --journey-only --url http://127.0.0.1:5173/
 *
 * The planner is the one part of this app that cannot be checked from the
 * tiles: it is a live conversation with Transitous, and the shapes it returns
 * change with the timetable. So these cases pin down the things that must hold
 * whatever comes back - that a place resolves, that an itinerary is drawn with
 * shared journey-leg colours, that the bike slider actually reaches the request,
 * and that a link restores the whole plan - rather than any particular journey.
 *
 * `--relay-api` answers the Transitous calls from Node instead of from the
 * browser. It exists for sandboxes whose browser cannot reach the open internet
 * even through a proxy; the page still issues its own requests and parses the
 * real responses, only the transport underneath is substituted. Do not use it
 * against a deployment you are actually trying to test the network path of.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const BASE = flag('url', 'https://jnslmk.github.io/OpenRailTransitmap/').replace(/\/?$/, '/');
const HEADED = args.includes('--headed');
const RELAY = args.includes('--relay-api');
const AUTOCOMPLETE_ONLY = args.includes('--autocomplete-only');
const JOURNEY_ONLY = args.includes('--journey-only');
const SCREENSHOTS = flag('screenshots', '/tmp/openrail-journey');

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

async function journeyLegibility(page) {
  // Fixture-only interception: exercise the real parser, planner, map and controls
  // without depending on a particular live timetable or adding app fallbacks.
  const stop = (name, lon, lat = 52.3759, track = null) => ({
    name,
    stopId: name,
    lon,
    lat,
    track,
    tz: 'Europe/Berlin',
  });
  const origin = stop('Origin', 9.724);
  const central = stop('Hannover Hbf', 9.732);
  const arrival = stop('Lehrte', 9.974, 52.376, '2');
  const departure = stop('Lehrte tram', 9.976, 52.377, '4');
  const east = stop('East', 10.12, 52.36, '1');
  const destination = stop('Destination', 10.2, 52.35);
  const time = (clock) => `2026-10-03T${clock}:00+02:00`;
  const geometry = (points) => {
    let lat = 0,
      lon = 0,
      encoded = '';
    for (const point of points) {
      const nextLat = Math.round(point.lat * 1e5);
      const nextLon = Math.round(point.lon * 1e5);
      for (let value of [nextLat - lat, nextLon - lon]) {
        value = value < 0 ? ~(value << 1) : value << 1;
        while (value >= 0x20) {
          encoded += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
          value >>= 5;
        }
        encoded += String.fromCharCode(value + 63);
      }
      lat = nextLat;
      lon = nextLon;
    }
    return { points: encoded, precision: 5 };
  };
  const leg = (mode, from, to, start, end, duration, withGeometry = true) => ({
    mode,
    duration,
    routeShortName: mode === 'WALK' ? '' : 'RE1',
    routeColor: 'ff0000',
    agencyName: 'Fixture rail',
    from: { ...from, departure: time(start) },
    to: { ...to, arrival: time(end) },
    ...(withGeometry ? { legGeometry: geometry([from, to]) } : {}),
  });
  const legs = [
    leg('WALK', origin, central, '08:55', '09:00', 300),
    leg('REGIONAL_RAIL', central, arrival, '09:00', '09:20', 1200),
    leg('WALK', arrival, departure, '09:20', '09:23', 180),
    leg('REGIONAL_RAIL', departure, east, '09:25', '09:40', 900),
    leg('WALK', east, east, '09:40', '09:40', 0, false),
    leg('REGIONAL_RAIL', east, destination, '09:45', '10:00', 900),
    leg('WALK', destination, destination, '10:00', '10:00', 0, false),
  ];
  const body = {
    itineraries: [
      { startTime: time('08:55'), endTime: time('10:00'), duration: 3900, transfers: 2, legs },
      {
        startTime: time('09:00'),
        endTime: time('10:00'),
        duration: 3600,
        transfers: 0,
        legs: [leg('REGIONAL_RAIL', central, destination, '09:00', '10:00', 3600)],
      },
    ],
  };
  let askedModes = '';
  const handler = (route) => {
    askedModes = new URL(route.request().url()).searchParams.get('transitModes') ?? '';
    return route.fulfill({ json: body });
  };
  await page.route('**/api/v1/plan?**', handler);
  await mkdir(SCREENSHOTS, { recursive: true });
  try {
    for (const [surface, width, height] of [
      ['desktop', 1280, 900],
      ['mobile', 390, 844],
    ]) {
      await testCase(
        `${surface}: numbered journey, keyboard selection and restoration`,
        async () => {
          await page.setViewportSize({ width, height });
          await page.emulateMedia({ reducedMotion: 'reduce' });
          await page.goto(`${BASE}?tab=plan&from=${RURAL}&to=${HANNOVER}&bike=0&modes=regional`, {
            waitUntil: 'load',
          });
          await ready(page);
          await page.waitForSelector('.interchange-select');
          await page.waitForFunction(
            () =>
              window.__map.queryRenderedFeatures({
                layers: ['itinerary-changes'],
              }).length === 2,
          );
          const source = await page.evaluate(
            async () => (await window.__map.getSource('itinerary').getData()).features,
          );
          eq(
            source.filter((f) => f.properties.kind === 'change').length,
            2,
            'walking boundary pairs are two changes, not four; access and egress excluded',
          );
          eq(
            await page
              .locator('.interchange-number')
              .allTextContents()
              .then((a) => a.join(',')),
            '1,2',
            'sidebar numbers match the map changes',
          );
          const details = await page.locator('.interchange-select').first().textContent();
          check(
            /Lehrte → Lehrte tram/.test(details) && /Walk 3 min/.test(details),
            'connecting-station label includes walking duration',
            details,
          );
          check(
            /Arrive · 09:20 · Lehrte · Pl. 2/.test(details) &&
              /Depart · 09:25 · Lehrte tram · Pl. 4/.test(details),
            'connection times and platforms',
            details,
          );
          check(
            (await page.locator('.interchange-select').nth(1).textContent()).includes('Walk 0 min'),
            'zero-duration transfer remains a numbered change',
          );
          const colours = await page.$$eval(
            '.itin-wrap.open .leg:not(.leg-street):not(.leg-end) .badge',
            (badges) => badges.map((badge) => badge.style.backgroundColor),
          );
          const mapped = await page.evaluate(async () => {
            const features = (await window.__map.getSource('itinerary').getData()).features;
            return features
              .filter((f) => f.properties.kind === 'transit')
              .map((f) => {
                const el = document.createElement('span');
                el.style.backgroundColor = f.properties.colour;
                return el.style.backgroundColor;
              });
          });
          eq(colours.join(','), mapped.join(','), 'map and sidebar share journey colours');
          check(
            colours[0] !== colours[1] && colours[1] !== colours[2],
            'same official route gets distinct adjacent journey colours',
          );
          const marks = await page.evaluate(
            () =>
              window.__map.queryRenderedFeatures({
                layers: window.__map
                  .getStyle()
                  .layers.filter((l) => l.id.startsWith('stop-') || l.id === 'station-positions')
                  .map((l) => l.id),
              }).length,
          );
          eq(marks, 0, 'unrelated network station marks hidden in Plan');
          eq(
            await page.locator('.itin button, .itin a, .itin input').count(),
            0,
            'overview button contains no interactive controls',
          );
          await page.waitForFunction(
            () =>
              new Set(
                window.__map
                  .queryRenderedFeatures({
                    layers: ['itinerary-labels'],
                  })
                  .map((feature) => feature.properties.label),
              ).size === 4,
          );
          const labelSafety = await page.evaluate(() => {
            const map = window.__map;
            const rect = map.getContainer().getBoundingClientRect();
            const labelsIn = (box) =>
              map
                .queryRenderedFeatures(box, {
                  layers: ['itinerary-labels'],
                })
                .map((feature) => feature.properties.label);
            const controls = [
              ...map
                .getContainer()
                .querySelectorAll(
                  '.maplibregl-ctrl-top-right .maplibregl-ctrl-group, .maplibregl-ctrl-bottom-right .maplibregl-ctrl-group',
                ),
            ].flatMap((control) => {
              const bounds = control.getBoundingClientRect();
              return bounds.width
                ? labelsIn([
                    [bounds.left - rect.left, bounds.top - rect.top],
                    [bounds.right - rect.left, bounds.bottom - rect.top],
                  ])
                : [];
            });
            // Query the actual rendered symbol hit boxes, not estimated text width.
            const edges = [
              [
                [0, 0],
                [2, rect.height],
              ],
              [
                [rect.width - 2, 0],
                [rect.width, rect.height],
              ],
              [
                [0, 0],
                [rect.width, 2],
              ],
              [
                [0, rect.height - 2],
                [rect.width, rect.height],
              ],
            ].flatMap(labelsIn);
            return {
              labels: [
                ...new Set(
                  labelsIn([
                    [0, 0],
                    [rect.width, rect.height],
                  ]),
                ),
              ],
              controls,
              edges,
            };
          });
          eq(
            labelSafety.labels.sort().join('|'),
            'East|Lehrte → Lehrte tram|Origin|Destination'.split('|').sort().join('|'),
            'origin, destination and change labels remain rendered',
          );
          eq(
            labelSafety.controls.join(','),
            '',
            'journey labels do not intersect map control rail',
          );
          eq(labelSafety.edges.join(','), '', 'journey labels do not intersect map edges');
          await page.screenshot({ path: `${SCREENSHOTS}/${surface}-overview.png` });
          const before = new URL(page.url()).searchParams;
          const legControl = page.locator('[data-focus-kind="leg"][data-focus-index="3"]');
          await legControl.focus();
          await page.keyboard.press('Enter');
          eq(await legControl.getAttribute('aria-pressed'), 'true', 'keyboard selects a leg');
          check(
            await legControl.evaluate((el) => document.activeElement === el),
            'selection retains native keyboard focus',
          );
          const opacity = await page.evaluate(() =>
            window.__map.getPaintProperty('itinerary-transit', 'line-opacity'),
          );
          eq(
            JSON.stringify(opacity),
            JSON.stringify(['case', ['in', ['get', 'leg'], ['literal', [3]]], 1, 0.25]),
            'selected leg emphasized, other segments quietened',
          );
          const changeControl = page.locator('.interchange-select').first();
          await changeControl.focus();
          await page.keyboard.press('Space');
          eq(
            await changeControl.getAttribute('aria-pressed'),
            'true',
            'keyboard selects interchange',
          );
          eq(await legControl.getAttribute('aria-pressed'), 'false', 'leg selection cleared');
          const zoom = await page.evaluate(() => window.__map.getZoom());
          check(zoom > 13, 'interchange zooms into walking connection', String(zoom));
          check(
            await page.evaluate(() => !window.__map.isMoving()),
            'reduced-motion map move is immediate',
          );
          for (const key of ['from', 'to', 'bike', 'itin']) {
            eq(
              new URL(page.url()).searchParams.get(key),
              before.get(key),
              `${key}: trip state preserved`,
            );
          }
          await page.screenshot({ path: `${SCREENSHOTS}/${surface}-connection.png` });
          await page.locator('.itin').nth(1).click();
          eq(
            await page.locator('[data-focus-kind][aria-pressed="true"]').count(),
            0,
            'changing itinerary resets focused-leg state',
          );
          eq(await page.locator('.interchange').count(), 0, 'single transit journey has no change');
          await page.locator('.tab').first().click();
          const restored = await page.evaluate(() => ({
            opacity: window.__map.getPaintProperty('route-regional', 'line-opacity'),
            tram: window.__map.getLayoutProperty('route-tram', 'visibility'),
            filters: window.__map
              .getStyle()
              .layers.filter((l) => l.id.startsWith('stop-'))
              .map((l) => l.filter),
          }));
          eq(restored.opacity, 1, 'Explore restores normal network opacity');
          eq(restored.tram, 'none', 'active mode filter survives restoration');
          check(
            restored.filters.every((filter) => filter.at(-1) === true),
            'Explore restores station filters',
          );
          await page.locator('.tab').nth(1).click();
          await page.locator('.itin').nth(1).click();
          eq(
            await page.evaluate(() =>
              window.__map.getPaintProperty('route-regional', 'line-opacity'),
            ),
            1,
            'clearing itinerary restores network',
          );
        },
      );
    }

    // The fare presets are a request contract: what the router is allowed to
    // offer, not a client-side prune of what came back. So the check is on the
    // parameter, which is also the part that cannot drift with the timetable.
    await testCase('a ticket preset replaces the mode chips', async () => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${BASE}?tab=plan&from=${RURAL}&to=${HANNOVER}&bike=0`, {
        waitUntil: 'load',
      });
      await ready(page);
      await page.waitForSelector('.plan-fare', { timeout: 10000 });
      check(
        await page.locator('.plan-form .chip').first().isVisible(),
        'chips decide while the preset is All services',
      );

      const settle = async (expected) => {
        for (let i = 0; i < 50 && askedModes !== expected; i++) {
          await page.waitForTimeout(100);
        }
      };
      const TICKET = 'REGIONAL_RAIL,SUBURBAN,SUBWAY,TRAM,BUS,FERRY';
      const ANY = 'HIGHSPEED_RAIL,LONG_DISTANCE,REGIONAL_RAIL,SUBURBAN,SUBWAY,TRAM,BUS,COACH,FERRY';

      await page.selectOption('.plan-fare', 'ticket');
      await settle(TICKET);
      eq(askedModes, TICKET, 'Deutschland-Ticket routes on Nahverkehr only');
      check(
        !askedModes.includes('HIGHSPEED_RAIL') &&
          !askedModes.includes('LONG_DISTANCE') &&
          !askedModes.includes('COACH'),
        'no ICE, IC/EC, FlixTrain or FlixBus is asked for',
      );
      check(await page.locator('.plan-form .chip').first().isHidden(), 'chips stand down');
      eq(new URL(page.url()).searchParams.get('fare'), 'ticket', 'the preset is in the URL');

      await page.selectOption('.plan-fare', 'regional');
      await settle('REGIONAL_RAIL,SUBURBAN');
      eq(askedModes, 'REGIONAL_RAIL,SUBURBAN', 'regional is trains only');

      await page.selectOption('.plan-fare', 'any');
      await settle(ANY);
      await page.waitForFunction(() => !!document.querySelector('.plan-form .chip'));
      eq(askedModes, ANY, 'All services hands the decision back to the chips');
    });
  } finally {
    await page.unroute('**/api/v1/plan?**', handler);
    await page.emulateMedia({ reducedMotion: null });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
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
if (!JOURNEY_ONLY) await autocomplete(page);
if (!AUTOCOMPLETE_ONLY) await journeyLegibility(page);
if (!AUTOCOMPLETE_ONLY && !JOURNEY_ONLY) await run(page);
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

/**
 * End-to-end check of the browse + inspector workspace, driven against a real
 * deployment.
 *
 *   node e2e/workspace.mjs                                 # the published site
 *   node e2e/workspace.mjs --url http://127.0.0.1:5191/    # a local preview
 *   node e2e/workspace.mjs --headed                        # watch it run
 *
 * The cases pin down the things this layout exists to get right and that are
 * easy to lose without noticing: a phone shows one content slot, so a detail
 * can never stack over the rail; Back hands the slot back with the query,
 * filters, disclosure state and scroll the reader left behind; the sheet has a
 * fold for each intent and the fold survives a shared link and a resize; and
 * the filter summary states the restriction that is actually on.
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const BASE = flag('url', 'https://jnslmk.github.io/OpenRailTransitmap/').replace(/\/?$/, '/');
const HEADED = args.includes('--headed');

/** Berlin at city zoom: every mode, every operator, closures in view. */
const BERLIN = '#11.50/52.5170/13.4050';
/** A phone and the desktop the same state has to read sensibly on. */
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

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

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

const idleCount = (page) => page.evaluate(() => window.__idle ?? 0);

/** Wait until the map has finished loading tiles and has settled once more. */
async function settle(page, since = -1) {
  await page.waitForFunction(
    (n) => {
      const m = window.__map;
      return !!m && m.loaded() && !m.isMoving() && window.__idle > n;
    },
    since,
    { timeout: 30000 },
  );
  await page.waitForTimeout(150);
}

async function goto(page, hash, query = '', viewport = DESKTOP) {
  if (page.viewportSize()?.width !== viewport.width) await page.setViewportSize(viewport);
  // Cleared first, because a URL differing only in its hash is a same-document
  // navigation: nothing reloads and the case runs against the last one's state.
  await page.goto('about:blank');
  await page.goto(`${BASE}${query}${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body.ready', { timeout: 30000 });
  await settle(page, 0);
}

/** An element the app is actually painting, not merely holding. */
const shown = (page, sel) =>
  page.evaluate((s) => {
    const n = document.querySelector(s);
    return !!n && n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
  }, sel);

/** What the chrome is doing this instant: body classes, controls and slots. */
const chrome = (page) =>
  page.evaluate(() => {
    const paint = (sel) => {
      const n = document.querySelector(sel);
      return !!n && n.getClientRects().length > 0;
    };
    return {
      peek: document.body.classList.contains('sheet-collapsed'),
      expanded: document.body.classList.contains('sheet-expanded'),
      hidden: document.body.classList.contains('chrome-hidden'),
      controls: paint('.sheet-controls'),
      sidebar: paint('#sidebar'),
      detail: paint('#detail'),
      urlFold: new URLSearchParams(location.search).get('ui'),
    };
  });

const uiParam = (page) => page.evaluate(() => new URLSearchParams(location.search).get('ui'));

/**
 * The text of the collapsed filter summary - the one line a reader has without
 * opening anything, and where the active restrictions have to be stated.
 */
const filterSummary = (page) =>
  page.evaluate(() => {
    const n = document.querySelector('details.filter-disclosure .filter-summary');
    return n ? n.textContent.replace(/\s+/g, ' ').trim() : null;
  });

const filterOpen = (page) =>
  page.evaluate(() => !!document.querySelector('details.filter-disclosure')?.open);

/** Open the native filter disclosure the way a reader does. */
async function openFilters(page) {
  if (!(await filterOpen(page))) await page.click('details.filter-disclosure > summary');
  await page.waitForTimeout(50);
}

/** Mode rows as label/checked, or null when the panel is missing. */
const modeRows = (page) =>
  page.evaluate(() => {
    const panel = [...document.querySelectorAll('#sidebar .panel')].find(
      (p) => p.querySelector('h2')?.textContent === 'Modes',
    );
    if (!panel) return null;
    return [...panel.querySelectorAll('label.toggle')].map((r) => ({
      label: r.querySelector('.label')?.textContent ?? '',
      checked: r.querySelector('input').checked,
    }));
  });

/** The mode checkboxes alone, in panel order. */
const modeState = (page) =>
  page.evaluate(() => {
    const panel = [...document.querySelectorAll('#sidebar .panel')].find(
      (p) => p.querySelector('h2')?.textContent === 'Modes',
    );
    return panel ? [...panel.querySelectorAll('label.toggle input')].map((b) => b.checked) : [];
  });

/**
 * Click a feature the app is drawing, by projecting one of its coordinates
 * back to the screen. Picks points comfortably inside the map so the click
 * lands on the map and not on the chrome around it, and prefers point layers
 * whose geometry is where the mark is.
 *
 * A station mark is a symbol, so its anchor can sit a little off the painted
 * mark; several candidates are tried until one actually opens a station. The
 * other kinds take the first point, as they always have.
 */
async function clickMapFeature(page, kind) {
  const points = await page.evaluate((which) => {
    const m = window.__map;
    const rect = m.getContainer().getBoundingClientRect();
    const mode = Object.keys({
      longdistance: 1,
      regional: 1,
      suburban: 1,
      subway: 1,
      tram: 1,
      coach: 1,
    });
    const layers =
      which === 'route'
        ? mode.map((x) => `route-${x}`)
        : which === 'closure'
          ? (m.getStyle().layers ?? [])
              .map((l) => l.id)
              .filter((id) => /^closures-.*-(hazard|point)$/.test(id))
          : (m.getStyle().layers ?? [])
              .map((l) => l.id)
              .filter((id) => id.startsWith('stop-') || id === 'station-positions');
    const live = layers.filter(
      (id) => m.getLayer(id) && m.getLayoutProperty(id, 'visibility') !== 'none',
    );

    const coord = (g) => {
      if (!g) return null;
      if (g.type === 'Point') return g.coordinates;
      if (g.type === 'LineString') return g.coordinates[0];
      if (g.type === 'MultiLineString') return g.coordinates[0][0];
      return null;
    };
    const margin = 44;
    const inside = (p) =>
      p.x > margin && p.y > margin && p.x < rect.width - margin && p.y < rect.height - margin;

    const feats = m.queryRenderedFeatures({ layers: live });
    // Circles paint where the geometry is; symbols and lines are hit near it.
    const ranked = [
      ...feats.filter((f) => m.getLayer(f.layer.id)?.type === 'circle'),
      ...feats.filter((f) => m.getLayer(f.layer.id)?.type !== 'circle'),
    ];
    const out = [];
    const want = which === 'station' ? 8 : 1;
    for (const f of ranked) {
      const c = coord(f.geometry);
      if (!c) continue;
      const p = m.project(c);
      if (!inside(p)) continue;
      out.push({ x: rect.left + p.x, y: rect.top + p.y });
      if (out.length >= want) break;
    }
    return out;
  }, kind);

  for (const point of points) {
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(220);
    if (kind !== 'station') return true;
    const opened = await page.evaluate(
      () => document.querySelectorAll('#detail .pop-actions .pop-action').length > 0,
    );
    if (opened) return true;
  }
  return false;
}

/** A station name that is actually in the loaded tiles, for a real search. */
const aStationName = (page) =>
  page.evaluate(() => {
    const f = window.__map
      .querySourceFeatures('rail', { sourceLayer: 'stations' })
      .find((x) => (x.properties?.name ?? '').length >= 4 && x.properties?.lineCount);
    return f ? String(f.properties.name) : null;
  });

/**
 * Search for a station the tiles actually carry and open it from the result
 * list. Returns the name the app showed on the row, or null when the view
 * holds no station to search for.
 */
async function openStationFromSearch(page) {
  const name = await aStationName(page);
  if (!name) return null;
  await page.locator('#sidebar .search').first().fill(name);
  const result = page
    .locator('#sidebar .results .line-row')
    .filter({ has: page.locator('.dot') })
    .first();
  await result.waitFor({ timeout: 15000 });
  const opened = await result.locator('.line-name').textContent();
  await result.click();
  await page.waitForTimeout(250);
  return opened;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function run(page) {
  // --- the active-filter summary -------------------------------------------

  await testCase('the filter summary names the modes held back and resets', async () => {
    await goto(page, BERLIN);
    const clean = await filterSummary(page);
    check(!!clean, 'the collapsed disclosure carries a summary', String(clean));

    await goto(page, BERLIN, '?modes=tram');
    const restricted = await filterSummary(page);
    check(
      restricted !== clean,
      'restricting the modes changes the summary',
      `${clean} -> ${restricted}`,
    );
    const rows = (await modeRows(page)) ?? [];
    const off = rows.filter((r) => !r.checked).map((r) => r.label);
    check(off.length > 0, 'the link holds modes back', off.join(','));
    check(
      off.every((l) => restricted.includes(l)),
      'and the summary names every one of them',
      `${off.join(', ')} vs ${restricted}`,
    );

    // The way out is the same checkboxes, so reset through them.
    await openFilters(page);
    const n = await idleCount(page);
    await page.evaluate(() => {
      const panel = [...document.querySelectorAll('#sidebar .panel')].find(
        (p) => p.querySelector('h2')?.textContent === 'Modes',
      );
      for (const box of panel.querySelectorAll('label.toggle input')) if (!box.checked) box.click();
    });
    await settle(page, n);
    eq(await filterSummary(page), clean, 'and switching them back restores the default summary');
  });

  await testCase('the filter summary counts the operators held back and resets', async () => {
    await goto(page, BERLIN);
    const clean = await filterSummary(page);
    await openFilters(page);
    const rows = await page.evaluate(
      () => document.querySelectorAll('#sidebar .operator-list label.toggle').length,
    );
    if (!rows) {
      check(true, 'no operators in view to restrict', '');
      return;
    }

    const n = await idleCount(page);
    await page.evaluate(() =>
      document.querySelector('#sidebar .operator-list label.toggle input').click(),
    );
    await settle(page, n);
    const one = await filterSummary(page);
    check(one !== clean, 'switching one operator off changes the summary', `${clean} -> ${one}`);
    check(/\b1\b/.test(one), 'and it counts the one that is off', one);

    // The master switch is the declared way out of any mixture.
    const n2 = await idleCount(page);
    await page.evaluate(() => document.querySelector('.toggle.master input').click());
    await settle(page, n2);
    eq(await filterSummary(page), clean, 'and the master switch clears it again');
  });

  await testCase('the filter summary reflects the construction overlay', async () => {
    await goto(page, BERLIN);
    const clean = await filterSummary(page);
    await openFilters(page);

    const n = await idleCount(page);
    const clicked = await page.evaluate(() => {
      // The third panel of the filter toolbar: neither the modes nor the
      // operators, which are the other two.
      const panel = [...document.querySelectorAll('#sidebar .filter-content .panel')].find((p) => {
        const h = p.querySelector('h2')?.textContent;
        return !!h && h !== 'Modes' && h !== 'Operators';
      });
      const box = panel?.querySelector('label.toggle input');
      if (!box) return false;
      box.click();
      return true;
    });
    if (!clicked) {
      check(true, 'no construction switch in the filters', '');
      return;
    }
    await settle(page, n);

    const off = await filterSummary(page);
    check(off !== clean, 'switching the overlay off changes the summary', `${clean} -> ${off}`);

    const n2 = await idleCount(page);
    await page.evaluate(() => {
      const panel = [...document.querySelectorAll('#sidebar .filter-content .panel')].find((p) => {
        const h = p.querySelector('h2')?.textContent;
        return !!h && h !== 'Modes' && h !== 'Operators';
      });
      panel.querySelector('label.toggle input').click();
    });
    await settle(page, n2);
    eq(await filterSummary(page), clean, 'and switching it back restores the default summary');
  });

  // --- the single content slot ---------------------------------------------

  await testCase('a phone shows one content slot and Back hands it back', async () => {
    await goto(page, BERLIN, '', PHONE);
    check(await shown(page, '#sidebar'), 'the rail is the slot to begin with');
    check(!(await shown(page, '#detail')), 'with no inspector on screen');

    const rows = page.locator('#sidebar .line-list .line-row');
    check((await rows.count()) > 0, 'the index has lines to open');
    await rows.first().click();
    await page.waitForTimeout(250);
    check(await shown(page, '#detail'), 'a line takes the slot');
    check(!(await shown(page, '#sidebar')), 'and the rail is not left behind it');
    eq(
      await page.evaluate(() => document.querySelectorAll('.maplibregl-popup').length),
      0,
      'and nothing is stacked over the map either',
    );

    await page.click('#detail .inspector-back');
    await page.waitForTimeout(250);
    check(await shown(page, '#sidebar'), 'Back hands the slot back to the rail');
    check(!(await shown(page, '#detail')), 'and closes the inspector');
  });

  await testCase('station search opens the station in that same slot, not a popup', async () => {
    await goto(page, BERLIN, '', PHONE);
    const name = await aStationName(page);
    if (!name) {
      check(true, 'no station in view to search for', '');
      return;
    }

    await page.locator('#sidebar .search').first().fill(name);
    const result = page
      .locator('#sidebar .results .line-row')
      .filter({ has: page.locator('.dot') })
      .first();
    await result.waitFor({ timeout: 15000 });
    await result.click();
    await page.waitForTimeout(250);

    check(await shown(page, '#detail'), 'the station opens the inspector');
    check(!(await shown(page, '#sidebar')), 'in the same slot as the rail');
    eq(
      await page.evaluate(() => document.querySelectorAll('.maplibregl-popup').length),
      0,
      'and not as a popup stacked on the map',
    );
    const title = await page.evaluate(
      () => document.querySelector('#detail .detail-title')?.textContent?.trim() ?? '',
    );
    check(title.includes(name), 'the inspector names the station that was opened', title);
  });

  await testCase(
    'Directions hands the phone slot to a usable planner without losing its context',
    async () => {
      const destination = '~52.52508~13.36940~Berlin Hbf';
      const query = new URLSearchParams({
        tab: 'plan',
        to: destination,
        at: '2030-08-25T07:12:00.000Z',
        arrive: '1',
        pmodes: 'rail,bus',
        bike: '45',
        carry: '1',
      });
      await goto(page, BERLIN, `?${query}`, PHONE);
      const field = (i) =>
        page.locator('#sidebar .plan-places .plan-field').nth(i).locator('input');
      const selectedTab = () => page.getByRole('tab', { selected: true }).allTextContents();
      const settings = () =>
        page.evaluate(() => ({
          when: document.querySelector('.plan-when select').value,
          day: document.querySelector('.plan-date').value,
          time: document.querySelector('.plan-time').value,
          modes: [...document.querySelectorAll('.plan-form .chip')].map((n) => [
            n.textContent,
            n.getAttribute('aria-pressed'),
          ]),
          bike: document.querySelector('.plan-range').value,
          carriage: document.querySelector('.plan-bike input[type="checkbox"]').checked,
        }));
      const before = await settings();
      // Editing a confirmed destination must preserve both its raw text and the
      // confirmed place until the rider deliberately chooses a replacement.
      await field(1).fill('Hannover Hbf raw');

      await page.getByRole('tab', { name: 'Explore', exact: true }).click();
      eq((await selectedTab()).join(', '), 'Explore', 'Explore is selected before the handoff');
      const origin = await openStationFromSearch(page);
      check(!!origin, 'the loaded station can be opened from search');
      if (!origin) return;
      check(await shown(page, '#detail'), 'the station opens the inspector');
      check(!(await shown(page, '#sidebar')), 'the inspector owns the phone slot');

      await page.click('#detail .pop-actions .pop-action:nth-child(1)');
      await page.waitForTimeout(300);

      check(!(await shown(page, '#detail')), 'Directions-from relinquishes the inspector slot');
      check(await shown(page, '#sidebar .plan-form'), 'Directions-from reveals the planner');
      eq((await selectedTab()).join(', '), 'Plan', 'Plan is the selected accessible tab');
      eq(await field(0).inputValue(), origin, 'the origin is the station selected from search');
      eq(
        await field(1).inputValue(),
        'Hannover Hbf raw',
        'the other uncommitted field text survives',
      );
      eq(
        await page.evaluate(() => new URLSearchParams(location.search).get('to')),
        destination,
        'the other confirmed destination survives in the shareable journey',
      );
      eq(
        JSON.stringify(await settings()),
        JSON.stringify(before),
        'Directions-from preserves the journey settings',
      );
      check(
        await page.locator('.plan-submit').isEnabled(),
        'the confirmed ends leave the planner ready to search',
      );
      await field(0).click();
      check(
        await field(0).evaluate((n) => n === document.activeElement),
        'the origin field can actually be reached and edited',
      );

      // Desktop Directions retains evidence beside Plan. Returning to phone
      // then exercises the already-active tab without station-bar hit guesses.
      await page.setViewportSize(DESKTOP);
      await settle(page, -1);
      await page.getByRole('tab', { name: 'Explore', exact: true }).click();
      const nextStation = await openStationFromSearch(page);
      check(!!nextStation, 'a loaded station can be opened for the destination');
      if (!nextStation) return;
      for (const [i, direction] of ['from', 'to'].entries()) {
        await page.click(`#detail .pop-actions .pop-action:nth-child(${i + 1})`);
        await page.waitForTimeout(300);
        check(
          await shown(page, '#detail.open .inspector-body'),
          `desktop Directions-${direction} keeps the station evidence visible`,
        );
        check(
          await shown(page, '#sidebar'),
          `desktop Directions-${direction} keeps the workspace visible beside evidence`,
        );
        check(
          await shown(page, '#sidebar .plan-form'),
          `desktop Directions-${direction} reveals the planner beside evidence`,
        );
        eq(
          (await selectedTab()).join(', '),
          'Plan',
          `desktop Directions-${direction} selects the accessible Plan tab`,
        );
        eq(
          await page.locator('#detail .detail-title').textContent(),
          nextStation,
          `desktop Directions-${direction} retains the selected station identity`,
        );
        eq(
          await field(i).inputValue(),
          nextStation,
          `desktop Directions-${direction} fills the selected station endpoint`,
        );
        eq(
          JSON.stringify(await settings()),
          JSON.stringify(before),
          `desktop Directions-${direction} preserves the journey settings`,
        );
      }
      const confirmedOrigin = await page.evaluate(() =>
        new URLSearchParams(location.search).get('from'),
      );
      eq((await selectedTab()).join(', '), 'Plan', 'Plan is already selected before Directions-to');
      await page.setViewportSize(PHONE);
      await page.waitForTimeout(300);
      check(await shown(page, '#detail'), 'the station inspector takes the phone slot again');
      check(
        !(await shown(page, '#sidebar')),
        'the already-active planner is hidden behind the inspector',
      );

      await page.click('#detail .pop-actions .pop-action:nth-child(2)');
      await page.waitForTimeout(300);

      check(!(await shown(page, '#detail')), 'Directions-to relinquishes the inspector slot');
      check(
        await shown(page, '#sidebar .plan-form'),
        'the already-active planner becomes visible again',
      );
      eq(
        (await selectedTab()).join(', '),
        'Plan',
        'Plan remains the selected accessible tab after handoff',
      );
      eq(
        await field(0).inputValue(),
        nextStation,
        'Directions-to retains the other confirmed origin',
      );
      eq(
        await field(1).inputValue(),
        nextStation,
        'the destination is the station selected from search',
      );
      eq(
        await page.evaluate(() => new URLSearchParams(location.search).get('from')),
        confirmedOrigin,
        'Directions-to retains the origin in the shareable journey',
      );
      eq(
        JSON.stringify(await settings()),
        JSON.stringify(before),
        'Directions-to preserves the journey settings',
      );
      check(
        await page.locator('.plan-submit').isEnabled(),
        'the planner remains ready to search after both handoffs',
      );
      await field(1).click();
      check(
        await field(1).evaluate((n) => n === document.activeElement),
        'the destination field can actually be reached and edited',
      );
    },
  );

  await testCase('a closure takes the same slot when one is in view', async () => {
    await goto(page, BERLIN, '', PHONE);
    const clicked = await clickMapFeature(page, 'closure');
    if (!clicked) {
      check(true, 'no closure drawn in this view to open', '');
      return;
    }
    check(await shown(page, '#detail'), 'a closure takes the slot');
    check(!(await shown(page, '#sidebar')), 'without stacking the rail behind it');
  });

  // --- Back restores the browse context ------------------------------------

  await testCase('Back restores the query, filters, disclosure and scroll', async () => {
    await goto(page, BERLIN, '?modes=regional,tram', PHONE);
    await openFilters(page);
    const n0 = await idleCount(page);
    await page.evaluate(() => {
      const panel = [...document.querySelectorAll('#sidebar .panel')].find(
        (p) => p.querySelector('h2')?.textContent === 'Modes',
      );
      const box = [...panel.querySelectorAll('label.toggle')].find(
        (r) => r.querySelector('.label')?.textContent === 'S-Bahn',
      );
      box.querySelector('input').click();
    });
    await settle(page, n0);

    // A query with results, and a scroll position to come back to.
    const query = await page.evaluate(
      () => document.querySelector('#sidebar .line-list .line-row .line-name')?.textContent ?? '',
    );
    await page.locator('#sidebar .search').first().fill(query.slice(0, 4));
    await page.locator('#sidebar .results .line-row').first().waitFor({ timeout: 10000 });

    const rows = page.locator('#sidebar .line-list .line-row');
    const target = rows.nth(Math.min(4, (await rows.count()) - 1));
    await target.scrollIntoViewIfNeeded();

    const modesBefore = await modeState(page);
    const before = await page.evaluate(() => ({
      query: document.querySelector('#sidebar .search').value,
      scroll: document.querySelector('.workspace-body')?.scrollTop ?? 0,
      open: !!document.querySelector('details.filter-disclosure')?.open,
    }));

    await target.click();
    await page.waitForTimeout(250);
    check(await shown(page, '#detail'), 'the line opens the inspector');

    await page.click('#detail .inspector-back');
    await page.waitForTimeout(300);
    await settle(page, -1);

    const modesAfter = await modeState(page);
    const after = await page.evaluate(() => ({
      query: document.querySelector('#sidebar .search').value,
      scroll: document.querySelector('.workspace-body')?.scrollTop ?? 0,
      open: !!document.querySelector('details.filter-disclosure')?.open,
      line: new URLSearchParams(location.search).get('line'),
      focusHidden: (() => {
        const a = document.activeElement;
        return !!a && a !== document.body && a.getClientRects().length === 0;
      })(),
    }));

    eq(after.query, before.query, 'the search query is still there');
    eq(modesAfter.join(','), modesBefore.join(','), 'the filters are still where they were');
    check(
      Math.abs(after.scroll - before.scroll) <= 4,
      'the scroll position came back',
      `${before.scroll} -> ${after.scroll}`,
    );
    check(after.open, 'the disclosure is still open');
    eq(after.line, null, 'and the selection left the URL');
    check(!after.focusHidden, 'focus did not land on something invisible');
  });

  // --- the planner keeps its state behind a detail -------------------------

  await testCase('a detail opens over the planner without losing its raw text', async () => {
    await goto(page, BERLIN, '?tab=plan', PHONE);
    const from = page.locator('#sidebar .plan-places .plan-field').first().locator('input');
    await from.fill('Hannover Hbf raw');
    const raw = await from.inputValue();

    // Tag the node: a redraw that rebuilds the form would lose the mark.
    await page.evaluate(() => {
      document.querySelector('#sidebar .plan-places .plan-field input').dataset.probe = 'kept';
    });

    const clicked = await clickMapFeature(page, 'route');
    if (!clicked) {
      check(true, 'nothing drawn on the map to select', '');
      return;
    }
    check(await shown(page, '#detail'), 'the selection opens a detail');

    const kept = await page.evaluate(
      () =>
        document.querySelector('#sidebar .plan-places .plan-field input')?.dataset.probe === 'kept',
    );
    check(kept, 'the plan form is the same one, not a rebuild');
    eq(
      await page.evaluate(
        () => document.querySelector('#sidebar .plan-places .plan-field input')?.value,
      ),
      raw,
      'and it still holds the raw text',
    );

    await page.click('#detail .inspector-back');
    await page.waitForTimeout(250);
    check(await shown(page, '#sidebar'), 'Back returns the planner');
    eq(
      await page.evaluate(
        () => document.querySelector('#sidebar .plan-places .plan-field input')?.value,
      ),
      raw,
      'with the raw text untouched',
    );
  });

  // --- the sheet's folds ----------------------------------------------------

  await testCase(
    'the phone sheet peeks, works and expands, and the URL carries the fold',
    async () => {
      await goto(page, BERLIN, '', PHONE);
      let c = await chrome(page);
      check(c.controls && c.sidebar, 'the sheet starts working, with its controls');
      check(!c.peek && !c.expanded && !c.hidden, 'in no special fold', JSON.stringify(c));
      eq(c.urlFold, null, 'and adds nothing to the URL');

      await page.click('.sheet-controls .sheet-handle');
      c = await chrome(page);
      check(c.peek, 'a tap on the handle peeks the sheet');
      check(!c.sidebar && !c.detail, 'hiding both content bodies');
      check(c.controls, 'while the shared controls stay');

      await page.click('.sheet-controls .sheet-handle');
      check(!(await chrome(page)).peek, 'and a second tap works it again');

      await page.click('.sheet-controls .sheet-expand');
      c = await chrome(page);
      check(c.expanded, 'Expand reads the sheet');
      eq(c.urlFold, 'expanded', 'and the fold lands in the URL');
      check(c.sidebar, 'the rail being what is read');
    },
  );

  await testCase('a shared URL brings the expanded sheet back', async () => {
    await goto(page, BERLIN, '?ui=expanded', PHONE);
    const c = await chrome(page);
    check(c.expanded, 'expanded restored from the link');
    check(c.sidebar && c.controls, 'with the rail and its controls showing');
    check(!c.peek, 'and not peeked');
  });

  await testCase('map-only hides the whole chrome and the toggle brings it back', async () => {
    await goto(page, BERLIN, '?ui=map', PHONE);
    const c = await chrome(page);
    check(c.hidden, 'the map is alone');
    check(
      !c.controls && !c.sidebar && !c.detail,
      'with no controls, rail or inspector',
      JSON.stringify(c),
    );

    await page.click('.maplibregl-ctrl-chrome');
    await page.waitForTimeout(200);
    const back = await chrome(page);
    check(!back.hidden && back.controls && back.sidebar, 'the toggle restores the sheet');
    eq(await uiParam(page), null, 'and the URL drops the flag');
  });

  await testCase('a selection from map-only brings the sheet back within reach', async () => {
    await goto(page, BERLIN, '?ui=map', PHONE);
    const clicked = await clickMapFeature(page, 'route');
    if (!clicked) {
      check(true, 'nothing drawn on the map to select', '');
      return;
    }
    const c = await chrome(page);
    check(!c.hidden && c.controls, 'the sheet comes back to where a selection can be reached');
    check(c.peek, 'peeked rather than thrown over the whole phone');

    // Peek folds the body, so the selection is one real tap away.
    await page.click('.sheet-controls .sheet-handle');
    await page.waitForTimeout(250);
    check(await shown(page, '#detail'), 'and one tap on the handle reveals it');
  });

  await testCase(
    'a desktop selection out of map-only is shown, and Back returns to it',
    async () => {
      await goto(page, BERLIN, '?ui=map', DESKTOP);
      const clicked = await clickMapFeature(page, 'route');
      if (!clicked) {
        check(true, 'nothing drawn on the map to select', '');
        return;
      }
      check(!(await chrome(page)).hidden, 'selecting leaves map-only so the evidence is visible');
      check(await shown(page, '#detail'), 'and the inspector is on screen');

      await page.click('#detail .close');
      await page.waitForTimeout(300);
      check((await chrome(page)).hidden, 'closing restores map-only');
      eq(await uiParam(page), 'map', 'and the link still says so');
    },
  );

  await testCase('the fold is a phone affordance; the desktop keeps the rail', async () => {
    await goto(page, BERLIN, '?ui=peek', PHONE);
    check((await chrome(page)).peek, 'peeked on the phone');

    await page.setViewportSize(DESKTOP);
    await page.waitForTimeout(300);
    const desktop = await chrome(page);
    check(!desktop.controls, 'the sheet controls are not on the desktop');
    check(desktop.sidebar, 'but the rail is, whatever fold the phone left');
    check(desktop.peek, 'with the fold itself still recorded');

    await page.setViewportSize(PHONE);
    await page.waitForTimeout(300);
    check((await chrome(page)).controls, 'and the controls come back at phone width');
  });
}

// ---------------------------------------------------------------------------

// PLAYWRIGHT_CHROMIUM lets a preinstalled browser stand in for the one the
// installed Playwright build would otherwise download. Chromium does not read
// HTTPS_PROXY, so a network that only goes out through a proxy has to be told
// about it here - and told to leave a local dev server alone, or the documented
// `--url http://127.0.0.1:5191/` run is sent to the proxy and hangs.
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const browser = await chromium.launch({
  headless: !HEADED,
  ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
  ...(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {}),
});
const context = await browser.newContext({ viewport: DESKTOP });
await context.addInitScript(() => {
  window.__idle = 0;
  const wait = setInterval(() => {
    if (!window.__map) return;
    clearInterval(wait);
    window.__map.on('idle', () => {
      window.__idle++;
    });
  }, 10);
});
// The street underlay comes from OSM's own tile server. Serving it a blank tile
// keeps the run off that server and out of its rate limits, and keeps the map's
// `load` event from waiting on a network that a CI box may not have.
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
await context.route('https://tile.openstreetmap.org/**', (route) =>
  route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_PNG }),
);

const page = await context.newPage();
page.on('pageerror', (err) => console.error('[page error]', err.message));

console.log(`workspace e2e against ${BASE}\n`);
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

/**
 * End-to-end check of the sidebar's view-scoped filters - the mode legend and
 * the operator panel - driven against a real deployment.
 *
 *   node e2e/legend.mjs                                  # the published site
 *   node e2e/legend.mjs --url http://127.0.0.1:5173/     # a local dev server
 *   node e2e/legend.mjs --headed                         # watch it run
 *
 * Both are scoped to the view, which is exactly what makes them easy to get
 * wrong: a row must never disappear as a result of the click that toggled it,
 * or the toggle cannot be undone. These cases pin that behaviour down.
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const BASE = flag('url', 'https://jnslmk.github.io/OpenRailTransitmap/').replace(/\/?$/, '/');
const HEADED = args.includes('--headed');

/** Mode ids paired with the label the legend prints for them. */
const LABELS = {
  longdistance: 'Long-distance',
  regional: 'Regional',
  suburban: 'S-Bahn',
  subway: 'Metro',
  tram: 'Tram',
};

/**
 * Views the cases run in, as `#zoom/lat/lon`.
 *
 * Modes are zoom-gated (tram only draws from z10, U-Bahn from z9), so "every
 * mode at once" means a city at city zoom, not the country at national zoom.
 */
const VIEWS = {
  // Braunschweig at street level: trams everywhere, no long-distance line.
  braunschweigStreets: '#14.50/52.2712/10.5385',
  // Berlin: the only kind of view where all five modes are drawn together.
  berlin: '#11.50/52.5170/13.4050',
  // Open sea north-west of Sylt: no rail of any kind.
  northSea: '#8.00/54.90/6.90',
};

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

/** Read every legend row, keyed by mode. Absent rows read as invisible. */
async function legend(page) {
  const raw = await page.evaluate((labels) => {
    const panel = [...document.querySelectorAll('#sidebar .panel')].find(
      (p) => p.querySelector('h2')?.textContent === 'Modes',
    );
    if (!panel) return null;

    const shown = (n) => !!n && !!n.offsetParent;
    const rows = {};
    for (const row of panel.querySelectorAll('label.toggle')) {
      const label = row.querySelector('.label')?.textContent ?? '';
      const mode = Object.keys(labels).find((m) => labels[m] === label);
      if (!mode) continue;
      rows[mode] = {
        visible: shown(row),
        checked: row.querySelector('input').checked,
        count: row.querySelector('.count')?.textContent ?? '',
        focused: document.activeElement === row.querySelector('input'),
      };
    }
    const note = [...panel.querySelectorAll('p')].find((p) => p.textContent === 'No lines in view');
    return { rows, note: shown(note) };
  }, LABELS);

  if (!raw) throw new Error('mode panel not found');
  for (const mode of Object.keys(LABELS)) {
    raw.rows[mode] ??= { visible: false, checked: false, count: '', focused: false };
  }
  return raw;
}

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

const idleCount = (page) => page.evaluate(() => window.__idle ?? 0);

async function goto(page, hash, query = '') {
  // Cleared first, because a URL that differs from the current one only in its
  // hash is a same-document navigation: nothing reloads, the map does not move,
  // and the case runs against whatever the case before it left on screen.
  await page.goto('about:blank');
  await page.goto(`${BASE}${query}${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body.ready', { timeout: 30000 });
  // The first idle is the one that counts what is in view; before it the legend
  // is still showing national totals.
  await settle(page, 0);
}

/** Jump to a view without a reload, so filter state survives. */
async function jumpTo(page, hash) {
  const [, zoom, lat, lon] = hash.match(/#([\d.]+)\/([-\d.]+)\/([-\d.]+)/);
  const n = await idleCount(page);
  await page.evaluate(
    ([lng, la, z]) => window.__map.jumpTo({ center: [lng, la], zoom: z }),
    [Number(lon), Number(lat), Number(zoom)],
  );
  await settle(page, n);
}

/** Click a legend checkbox by mode, then wait for the map to catch up. */
async function toggle(page, mode) {
  const n = await idleCount(page);
  await page.evaluate(
    ([labels, m]) => {
      const panel = [...document.querySelectorAll('#sidebar .panel')].find(
        (p) => p.querySelector('h2')?.textContent === 'Modes',
      );
      const row = [...panel.querySelectorAll('label.toggle')].find(
        (r) => r.querySelector('.label')?.textContent === labels[m],
      );
      if (!row) throw new Error(`no legend row for ${m}`);
      row.querySelector('input').click();
    },
    [LABELS, mode],
  );
  await settle(page, n);
}

/** How many route features of a mode the map is actually drawing. */
const drawn = (page, mode) =>
  page.evaluate((m) => {
    const map = window.__map;
    if (map.getLayoutProperty(`route-${m}`, 'visibility') === 'none') return 0;
    return map.queryRenderedFeatures({ layers: [`route-${m}`] }).length;
  }, mode);

/**
 * The operator panel: the master switch, and every row the current view has
 * put in the list. Unlike the mode legend the rows are not fixed - the list is
 * whoever runs something on screen - so they come back as an array.
 */
const operators = (page) =>
  page.evaluate(() => {
    const panel = [...document.querySelectorAll('#sidebar .panel')].find(
      (p) => p.querySelector('h2')?.textContent === 'Operators',
    );
    if (!panel) throw new Error('operator panel not found');
    const master = panel.querySelector('.toggle.master input');
    const note = [...panel.querySelectorAll('p')].find(
      (p) => p.textContent === 'No operators in view',
    );
    return {
      master: { on: master.checked, mixed: master.indeterminate },
      count: panel.querySelector('.toggle.master .count').textContent,
      note: !!note && !!note.offsetParent,
      rows: [...panel.querySelectorAll('.operator-list label.toggle')].map((row) => ({
        name: row.querySelector('.label').textContent,
        checked: row.querySelector('input').checked,
        count: row.querySelector('.count').textContent,
        focused: document.activeElement === row.querySelector('input'),
      })),
    };
  });

/** Click one operator's checkbox, then wait for the map to catch up. */
async function toggleOperator(page, name) {
  const n = await idleCount(page);
  await page.evaluate((who) => {
    const row = [...document.querySelectorAll('.operator-list label.toggle')].find(
      (r) => r.querySelector('.label').textContent === who,
    );
    if (!row) throw new Error(`no operator row for ${who}`);
    row.querySelector('input').click();
  }, name);
  await settle(page, n);
}

/** The master switch: everything on, or - from anywhere else - everything off. */
async function toggleAllOperators(page) {
  const n = await idleCount(page);
  await page.evaluate(() => document.querySelector('.toggle.master input').click());
  await settle(page, n);
}

/** Route features on screen whose operator is this one, drawn or not. */
const drawnBy = (page, name) =>
  page.evaluate((who) => {
    const map = window.__map;
    const layers = ['longdistance', 'regional', 'suburban', 'subway', 'tram', 'coach']
      .map((m) => `route-${m}`)
      .filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');
    return map
      .queryRenderedFeatures({ layers })
      .filter((f) => String(f.properties.operator ?? '') === who).length;
  }, name);

const modesParam = (page) => page.evaluate(() => new URLSearchParams(location.search).get('modes'));

const opParams = (page) =>
  page.evaluate(() => {
    const q = new URLSearchParams(location.search);
    return { op: q.get('op'), opoff: q.get('opoff') };
  });

const lineIndexSize = (page) =>
  page.evaluate(() => document.querySelectorAll('#sidebar .line-list .line-row').length);

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function run(page) {
  await testCase('the legend is scoped to the view', async () => {
    await goto(page, VIEWS.braunschweigStreets);
    const { rows } = await legend(page);
    for (const [mode, row] of Object.entries(rows)) {
      if (row.visible && row.checked) {
        check(
          Number(row.count) > 0,
          `${mode}: a shown, checked row has lines in view`,
          `count=${row.count}`,
        );
      }
      if (!row.visible) {
        check(row.checked, `${mode}: only a checked row may be hidden`, '');
        eq(await drawn(page, mode), 0, `${mode}: a hidden row means nothing of it is drawn`);
      }
    }
    check(
      Object.values(rows).some((r) => r.visible),
      'some mode is on screen here',
    );
  });

  await testCase('switching a mode off keeps its row and clears its count', async () => {
    await goto(page, VIEWS.berlin);
    const before = await legend(page);
    check(
      before.rows.tram.checked && Number(before.rows.tram.count) > 0,
      'tram starts on, with lines in view',
      JSON.stringify(before.rows.tram),
    );

    await toggle(page, 'tram');
    const after = await legend(page);
    check(after.rows.tram.visible, 'the tram row survives being switched off');
    eq(after.rows.tram.checked, false, 'the tram box is now clear');
    eq(after.rows.tram.count, '', 'a switched-off mode shows no count');
    eq(await drawn(page, 'tram'), 0, 'no tram line is drawn');
    check((await modesParam(page))?.includes('tram') === false, 'the URL drops tram');
  });

  await testCase('switching a mode on that runs nowhere in the view keeps its row', async () => {
    // The reported bug: at street level in Braunschweig there is no ICE, so
    // ticking Long-distance used to delete the row it was ticked on.
    await goto(page, VIEWS.braunschweigStreets, '?modes=tram');
    const start = await legend(page);
    check(start.rows.longdistance.visible, 'the switched-off long-distance row is there');
    eq(await drawn(page, 'longdistance'), 0, 'and nothing of it is drawn yet');

    await toggle(page, 'longdistance');
    const on = await legend(page);
    check(on.rows.longdistance.visible, 'the row is still there after being switched on');
    eq(on.rows.longdistance.checked, true, 'and it is ticked');
    eq(on.rows.longdistance.count, '0', 'and it counts the view, not the country');

    await toggle(page, 'longdistance');
    const off = await legend(page);
    check(off.rows.longdistance.visible, 'the row survives being switched back off');
    eq(off.rows.longdistance.checked, false, 'and the toggle undid itself');
  });

  await testCase('a row held open by a toggle is released by the next pan', async () => {
    await goto(page, VIEWS.braunschweigStreets, '?modes=tram');
    await toggle(page, 'longdistance');
    check((await legend(page)).rows.longdistance.visible, 'held open where it was toggled');

    await jumpTo(page, VIEWS.braunschweigStreets.replace('52.2712', '52.2812'));
    const moved = await legend(page);
    eq(moved.rows.longdistance.visible, false, 'and gone once the view moved on');
    eq(moved.rows.longdistance.checked, true, 'while staying switched on');

    await jumpTo(page, VIEWS.berlin);
    const wide = await legend(page);
    check(wide.rows.longdistance.visible, 'and back where the mode has lines');
    check(Number(wide.rows.longdistance.count) > 0, 'with a count of what is in view');
  });

  await testCase('every mode can be switched off and back on again', async () => {
    await goto(page, VIEWS.berlin);
    for (const mode of Object.keys(LABELS)) {
      await toggle(page, mode);
      const off = await legend(page);
      check(off.rows[mode].visible && !off.rows[mode].checked, `${mode}: off, row kept`);
      eq(await drawn(page, mode), 0, `${mode}: nothing drawn while off`);

      await toggle(page, mode);
      const on = await legend(page);
      check(on.rows[mode].visible && on.rows[mode].checked, `${mode}: on again, row kept`);
      check(Number(on.rows[mode].count) > 0, `${mode}: counted again`, on.rows[mode].count);
    }
    eq(await modesParam(page), null, 'the URL is back to no filter');
  });

  await testCase('all modes off leaves every row reachable', async () => {
    await goto(page, VIEWS.berlin, '?modes=tram');
    await toggle(page, 'tram');
    const rows = (await legend(page)).rows;
    for (const mode of Object.keys(LABELS)) {
      check(rows[mode].visible, `${mode}: row reachable with everything off`);
      eq(rows[mode].checked, false, `${mode}: switched off`);
    }
    eq(await lineIndexSize(page), 0, 'the line index is empty');
  });

  await testCase('the empty-view note stands in for the rows', async () => {
    await goto(page, VIEWS.northSea);
    const { rows, note } = await legend(page);
    check(note, 'the note is shown where there is no rail at all');
    for (const mode of Object.keys(LABELS)) {
      eq(rows[mode].visible, false, `${mode}: no row out at sea`);
    }
    await jumpTo(page, VIEWS.berlin);
    check(!(await legend(page)).note, 'and it goes away over the network');
  });

  await testCase('a mode takes its stops with it', async () => {
    await goto(page, VIEWS.braunschweigStreets, '?modes=tram');
    // z14.5, so the tram stops are drawn as bars across their bundle rather
    // than as the dots they collapse to below z11 - see STOP_TIERS.
    const stops = () =>
      page.evaluate(() => window.__map.queryRenderedFeatures({ layers: ['stop-marks-r3'] }).length);
    check((await stops()) > 0, 'tram stops are on screen to begin with');

    await toggle(page, 'tram');
    eq(await stops(), 0, 'and they go with the mode');
    await toggle(page, 'tram');
    check((await stops()) > 0, 'and come back with it');
  });

  await testCase('switching a mode off drops a selection it carried', async () => {
    await goto(page, VIEWS.braunschweigStreets, '?modes=tram');
    await page.evaluate(() => document.querySelector('#sidebar .line-list .line-row').click());
    await page.waitForTimeout(150);
    check(
      await page.evaluate(() => document.getElementById('detail').classList.contains('open')),
      'a line from the index opens the detail panel',
    );
    check(
      await page.evaluate(() => !!new URLSearchParams(location.search).get('line')),
      'and lands in the URL',
    );

    await toggle(page, 'tram');
    check(
      await page.evaluate(() => !document.getElementById('detail').classList.contains('open')),
      'switching its mode off closes the panel',
    );
    check(
      await page.evaluate(() => !new URLSearchParams(location.search).get('line')),
      'and clears the selection from the URL',
    );
    const dimmed = await page.evaluate(() =>
      window.__map.getPaintProperty('route-regional', 'line-opacity'),
    );
    eq(dimmed, 1, 'so nothing is left dimmed against a selection that is gone');
  });

  await testCase('a keyboard toggle keeps its focus', async () => {
    await goto(page, VIEWS.berlin);
    const n = await idleCount(page);
    await page.evaluate((labels) => {
      const panel = [...document.querySelectorAll('#sidebar .panel')].find(
        (p) => p.querySelector('h2')?.textContent === 'Modes',
      );
      const row = [...panel.querySelectorAll('label.toggle')].find(
        (r) => r.querySelector('.label')?.textContent === labels.regional,
      );
      row.querySelector('input').focus();
    }, LABELS);
    await page.keyboard.press('Space');
    await settle(page, n);

    const rows = (await legend(page)).rows;
    eq(rows.regional.checked, false, 'space toggled the mode');
    check(rows.regional.focused, 'and the focus stayed on the box that was pressed');
  });

  await testCase('the operator list is scoped to the view', async () => {
    await goto(page, VIEWS.berlin);
    const { rows, count, note, master } = await operators(page);
    check(rows.length > 1, 'a city view lists the operators running in it', `${rows.length} rows`);
    eq(count, String(rows.length), 'the master switch counts them');
    eq(note, false, 'and the empty note is out of the way');
    check(master.on && !master.mixed, 'everything is on to begin with');
    for (const row of rows) {
      check(Number(row.count) > 0, `${row.name}: listed because it has lines in view`, row.count);
      check(row.checked, `${row.name}: switched on`);
    }

    await jumpTo(page, VIEWS.northSea);
    const empty = await operators(page);
    eq(empty.rows.length, 0, 'nobody runs anything out at sea');
    check(empty.note, 'so the note stands in for the list');
    eq(empty.count, '0', 'and the count says so');
  });

  await testCase(
    'switching an operator off keeps its row, its count and the way back',
    async () => {
      await goto(page, VIEWS.berlin);
      const [first] = (await operators(page)).rows;
      check((await drawnBy(page, first.name)) > 0, `${first.name} is on the map to begin with`);

      await toggleOperator(page, first.name);
      const off = (await operators(page)).rows.find((r) => r.name === first.name);
      check(!!off, 'the row survives being switched off');
      eq(off?.checked, false, 'the box is now clear');
      // The count comes off the unfiltered layers, so it stays true - it is what
      // switching the operator back on would put back.
      eq(off?.count, first.count, 'and it still says how much of the view it runs');
      eq(await drawnBy(page, first.name), 0, 'while none of it is drawn');
      eq((await opParams(page)).opoff, first.name, 'the URL names what is left out');
      check((await operators(page)).master.mixed, 'and the master switch shows a mixture');

      await toggleOperator(page, first.name);
      check(
        (await drawnBy(page, first.name)) > 0,
        'and switching it back on draws its lines again',
      );
      eq((await opParams(page)).opoff, null, 'and the URL drops the filter entirely');
    },
  );

  await testCase('the master switch clears the whole list and puts it back', async () => {
    await goto(page, VIEWS.berlin);
    const before = await lineIndexSize(page);
    check(before > 0, 'the index starts with lines in it');

    await toggleAllOperators(page);
    const none = await operators(page);
    check(!none.master.on && !none.master.mixed, 'the master switch reads off, not mixed');
    eq(
      none.rows.some((r) => r.checked),
      false,
      'every row went with it',
    );
    check(none.rows.length > 0, 'while the rows themselves stay listed');
    eq(await lineIndexSize(page), 0, 'and the line index empties');
    eq((await opParams(page)).op, '', 'an empty allow-list is what the URL says');

    await toggleAllOperators(page);
    const all = await operators(page);
    check(all.master.on && !all.master.mixed, 'and one more click brings everyone back');
    eq(
      all.rows.some((r) => !r.checked),
      false,
      'with every row ticked',
    );
    eq(await lineIndexSize(page), before, 'and the index as it was');
    eq((await opParams(page)).op, null, 'leaving nothing in the URL');
  });

  await testCase('the master switch is the way out of any mixture', async () => {
    await goto(page, VIEWS.berlin);
    const [first, second] = (await operators(page)).rows;
    await toggleOperator(page, first.name);
    await toggleOperator(page, second.name);
    check((await operators(page)).master.mixed, 'two off is a mixture');

    await toggleAllOperators(page);
    const all = await operators(page);
    check(all.master.on && !all.master.mixed, 'the switch resolves it to everything on');
    eq(
      all.rows.some((r) => !r.checked),
      false,
      'including the two that were off',
    );
  });

  await testCase('a chosen handful of operators round-trips through the URL', async () => {
    await goto(page, VIEWS.berlin);
    const [first, second] = (await operators(page)).rows;

    await goto(page, VIEWS.berlin, `?op=${encodeURIComponent(`${first.name}~${second.name}`)}`);
    const restored = await operators(page);
    check(restored.master.mixed, 'the master switch shows the mixture the link asked for');
    for (const row of restored.rows) {
      eq(
        row.checked,
        [first.name, second.name].includes(row.name),
        `${row.name}: restored from the link`,
      );
    }
    check((await drawnBy(page, first.name)) > 0, `${first.name} is drawn`);
    const others = restored.rows.filter((r) => ![first.name, second.name].includes(r.name));
    if (others.length) eq(await drawnBy(page, others[0].name), 0, `${others[0].name} is not`);
  });

  await testCase('a keyboard toggle keeps its focus on an operator row too', async () => {
    // The rows are rebuilt as the view changes, which is exactly what can take
    // the focus off the box being pressed.
    await goto(page, VIEWS.berlin);
    const [first] = (await operators(page)).rows;
    const n = await idleCount(page);
    await page.evaluate((who) => {
      [...document.querySelectorAll('.operator-list label.toggle')]
        .find((r) => r.querySelector('.label').textContent === who)
        .querySelector('input')
        .focus();
    }, first.name);
    await page.keyboard.press('Space');
    await settle(page, n);

    const row = (await operators(page)).rows.find((r) => r.name === first.name);
    eq(row?.checked, false, 'space switched the operator off');
    check(row?.focused, 'and the focus stayed on the box that was pressed');
  });

  await testCase('filtering an operator away drops a selection it carried', async () => {
    await goto(page, VIEWS.berlin);
    const who = await page.evaluate(() => {
      document.querySelector('#sidebar .line-list .line-row').click();
      const dl = document.querySelector('#detail .detail-meta');
      const keys = [...dl.querySelectorAll('dt')].map((d) => d.textContent);
      return [...dl.querySelectorAll('dd')][keys.indexOf('Operator')].textContent;
    });
    check(
      await page.evaluate(() => !!new URLSearchParams(location.search).get('line')),
      'a line from the index lands in the URL',
    );

    await toggleOperator(page, who);
    check(
      await page.evaluate(() => !document.getElementById('detail').classList.contains('open')),
      'switching off the operator that runs it closes the panel',
    );
    check(
      await page.evaluate(() => !new URLSearchParams(location.search).get('line')),
      'and clears the selection from the URL',
    );
    const dimmed = await page.evaluate(() =>
      window.__map.getPaintProperty('route-regional', 'line-opacity'),
    );
    eq(dimmed, 1, 'so nothing is left dimmed against a selection that is gone');
  });

  await testCase("operator rows wear their operator's mark", async () => {
    await goto(page, VIEWS.berlin);
    // A deployment built before the logo pipeline has no manifest, and the
    // panel is meant to be complete without one - so this reports rather than
    // fails when there is nothing to draw.
    const published = await page.evaluate(async () => {
      const res = await fetch(new URL('operator-logos.json', location.href));
      return res.ok ? Object.keys(await res.json()).length : 0;
    });
    if (!published) {
      check(true, 'no logo manifest on this deployment - nothing to check', '');
      return;
    }

    const marks = await page.evaluate(() =>
      [...document.querySelectorAll('.operator-list .toggle')].map((row) => {
        const img = row.querySelector('img');
        return {
          name: row.querySelector('.label').textContent,
          src: img?.getAttribute('src') ?? null,
          // A file that 404s decodes to nothing, which is exactly the failure
          // a manifest naming an unfetched file would produce.
          drawn: !!img && img.complete && img.naturalWidth > 0,
          // The box is there either way, so the names stay in one column.
          boxWidth: row.querySelector('.op-mark')?.getBoundingClientRect().width ?? 0,
        };
      }),
    );

    const withMark = marks.filter((m) => m.src);
    check(withMark.length > 0, 'some operator in view has a mark', `${marks.length} rows`);
    for (const mark of withMark) {
      check(mark.drawn, `${mark.name}: its mark loaded`, mark.src ?? '');
    }
    const widths = new Set(marks.map((m) => Math.round(m.boxWidth)));
    eq(widths.size, 1, 'every row reserves the same width for a mark', [...widths].join(','));

    check(
      await page.evaluate(() => !document.querySelector('.logo-attrib')?.hidden),
      'and Commons is credited once a mark is on screen',
    );
  });

  await testCase('the mode selection round-trips through the URL', async () => {
    await goto(page, VIEWS.berlin, '?modes=suburban,tram');
    const rows = (await legend(page)).rows;
    for (const mode of Object.keys(LABELS)) {
      eq(rows[mode].checked, ['suburban', 'tram'].includes(mode), `${mode}: restored from the URL`);
    }
    const filtered = await lineIndexSize(page);

    await toggle(page, 'regional');
    eq((await legend(page)).rows.regional.checked, true, 'regional switched on');
    check((await lineIndexSize(page)) > filtered, 'the line index grew with it');
    const param = (await modesParam(page))?.split(',').sort().join(',');
    eq(param, 'regional,suburban,tram', 'and the URL followed');
  });
}

// ---------------------------------------------------------------------------

// PLAYWRIGHT_CHROMIUM lets a preinstalled browser stand in for the one the
// installed Playwright build would otherwise download. Chromium does not read
// HTTPS_PROXY, so a network that only goes out through a proxy has to be told
// about it here - and told to leave a local dev server alone, or the documented
// `--url http://127.0.0.1:5173/` run is sent to the proxy and hangs.
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const browser = await chromium.launch({
  headless: !HEADED,
  ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
  ...(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {}),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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

console.log(`legend e2e against ${BASE}\n`);
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

/** Geographic labels and station-detail check: node e2e/cities.mjs [URL] */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = (process.argv[2] ?? 'http://127.0.0.1:5173/').replace(/\/?$/, '/');
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
  ...(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {}),
});

try {
  const page = await browser.newPage({
    viewport: { width: 948, height: 1030 },
    deviceScaleFactor: 1,
  });
  await page.addInitScript(() => {
    window.__idle = 0;
    const wait = setInterval(() => {
      if (!window.__map) return;
      clearInterval(wait);
      window.__map.on('idle', () => window.__idle++);
    }, 10);
  });
  const settle = async (since) => {
    await page.waitForFunction(
      (n) => {
        const map = window.__map;
        return !!map && map.loaded() && !map.isMoving() && window.__idle > n;
      },
      since,
      { timeout: 30000 },
    );
    await page.waitForTimeout(150);
  };

  await page.goto(`${base}#7.69/51.6/9.8`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('body.ready', { timeout: 30000 });
  await settle(0);
  await page.screenshot({ path: '/tmp/openrail-cities-regional.png' });
  const cities = await page.evaluate(() => {
    const map = window.__map;
    if (!map.getLayer('city-labels')) return null;
    return Object.fromEntries(
      map.queryRenderedFeatures({ layers: ['city-labels'] }).map((feature) => {
        const point = map.project(feature.geometry.coordinates);
        return [feature.properties.name, { x: point.x, y: point.y }];
      }),
    );
  });
  assert.ok(cities, 'The actual app has a city-labels layer');
  for (const name of ['Hannover', 'Hildesheim', 'Göttingen', 'Kassel']) {
    assert.ok(
      cities[name],
      `${name} is rendered in the regional view; found: ${Object.keys(cities).join(', ')}`,
    );
  }
  assert.ok(
    cities.Hannover.y < cities.Hildesheim.y &&
      cities.Hildesheim.y < cities.Göttingen.y &&
      cities.Göttingen.y < cities.Kassel.y,
    'Cities orient the regional view from Hannover in the north to Kassel in the south',
  );
  assert.ok(cities.Kassel.x < cities.Göttingen.x, 'Kassel is west of Göttingen');

  const since = await page.evaluate(() => {
    const n = window.__idle;
    window.__map.jumpTo({ center: [9.935, 51.534], zoom: 12 });
    return n;
  });
  await settle(since);
  await page.screenshot({ path: '/tmp/openrail-cities-detail.png' });
  const detail = await page.evaluate(() => {
    const map = window.__map;
    const layers = map.getStyle().layers;
    const names = (prefix) =>
      map
        .queryRenderedFeatures({
          layers: layers.filter((layer) => layer.id.startsWith(prefix)).map((layer) => layer.id),
        })
        .map((feature) => feature.properties.name);
    return {
      zoom: map.getZoom(),
      cities: map.queryRenderedFeatures({ layers: ['city-labels'] }).length,
      marks: names('stop-marks-'),
      labels: names('stop-labels-'),
    };
  });
  assert.equal(detail.zoom, 12, 'The detail view is at street zoom');
  assert.equal(detail.cities, 0, 'City labels disappear at z12');
  assert.ok(
    detail.marks.some((name) => name?.includes('Göttingen')),
    'Göttingen station marks still render',
  );
  assert.ok(
    detail.labels.some((name) => name?.includes('Göttingen')),
    'Göttingen station labels still render',
  );
  console.log(
    'City orientation and station-detail transition passed; screenshots: /tmp/openrail-cities-{regional,detail}.png',
  );
} finally {
  await browser.close();
}

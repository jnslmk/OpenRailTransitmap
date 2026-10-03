/** Stop-icon edge check against a local Vite server: node e2e/stopmarks.mjs [URL] */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = (process.argv[2] ?? 'http://127.0.0.1:5173/').replace(/\/?$/, '/');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 640, height: 288 },
    deviceScaleFactor: 1,
  });
  // No map tiles, fonts or routing requests: only the production icon renderer.
  await page.goto(`${base}lines.json`);
  await page.setContent('<div id="map" style="width:640px;height:288px"></div>');
  await page.addScriptTag({ url: `${base}node_modules/maplibre-gl/dist/maplibre-gl.js` });
  const result = await page.evaluate(async (base) => {
    const { registerPillImages, pillLength, PILL_THICKNESS } = await import(
      `${base}src/stopmarks.ts`
    );
    const { buildStyle } = await import(`${base}src/style.ts`);
    const layer = buildStyle({ base: '/' }).layers.find((l) => l.id === 'stop-marks-r0');
    const map = new window.maplibregl.Map({
      container: 'map',
      center: [0, 0],
      zoom: 10,
      pixelRatio: 1,
      canvasContextAttributes: { preserveDrawingBuffer: true },
      style: {
        version: 8,
        sources: {},
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#b0c4de' } },
        ],
      },
    });
    registerPillImages(map);
    await new Promise((resolve) => map.on('load', resolve));
    const samples = [0.5, 0.85, 1.6].flatMap((scale, row) =>
      [0, 22.5, 45, 67.5].map((angle, col) => ({
        scale,
        angle,
        x: 80.3 + col * 160,
        y: 48.2 + row * 96,
      })),
    );
    map.addSource('icons', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: samples.map((s) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: map.unproject([s.x, s.y]).toArray() },
          properties: { span: 4, bearing: s.angle, scale: s.scale, mid: 0, lineCount: 4, major: 0 },
        })),
      },
    });
    map.addLayer({
      id: 'icons',
      type: 'symbol',
      source: 'icons',
      layout: { ...layer.layout, 'icon-size': ['get', 'scale'], 'icon-offset': [0, 0] },
      paint: { ...layer.paint, 'icon-opacity': 1, 'icon-halo-width': ['*', 1.5, ['get', 'scale']] },
    });
    await new Promise((resolve) => map.once('idle', resolve));
    const actual = document.createElement('canvas');
    actual.width = 640;
    actual.height = 288;
    const ctx = actual.getContext('2d');
    ctx.drawImage(map.getCanvas(), 0, 0);
    const pixels = ctx.getImageData(0, 0, 640, 288).data;
    // An independent, area-averaged Canvas reference keeps the original bar dimensions.
    const reference = document.createElement('canvas');
    reference.width = 640 * 8;
    reference.height = 288 * 8;
    const ref = reference.getContext('2d');
    ref.scale(8, 8);
    ref.fillStyle = '#b0c4de';
    ref.fillRect(0, 0, 640, 288);
    for (const s of samples) {
      ref.save();
      ref.translate(s.x, s.y);
      ref.rotate((s.angle * Math.PI) / 180);
      ref.scale(s.scale, s.scale);
      const length = pillLength(4),
        thickness = PILL_THICKNESS,
        stroke = 1.5;
      ref.beginPath();
      ref.roundRect(
        -length / 2 + stroke / 2,
        -thickness / 2 + stroke / 2,
        length - stroke,
        thickness - stroke,
        (thickness - stroke) / 2,
      );
      ref.fillStyle = '#fff';
      ref.fill();
      ref.strokeStyle = '#1a1a1a';
      ref.lineWidth = stroke;
      ref.stroke();
      ref.restore();
    }
    const expected = ref.getImageData(0, 0, reference.width, reference.height).data;
    const errors = samples.map((s) => {
      let error = 0,
        area = 0;
      for (let y = Math.floor(s.y - 40); y < s.y + 40; y++) {
        for (let x = Math.floor(s.x - 40); x < s.x + 40; x++) {
          const avg = [0, 0, 0];
          for (let sy = 0; sy < 8; sy++)
            for (let sx = 0; sx < 8; sx++) {
              const i = ((y * 8 + sy) * reference.width + x * 8 + sx) * 4;
              for (let c = 0; c < 3; c++) avg[c] += expected[i + c] / 64;
            }
          const i = (y * 640 + x) * 4;
          for (let c = 0; c < 3; c++) error += Math.abs(pixels[i + c] - avg[c]) / (3 * 255);
          if (avg.some((v, c) => Math.abs(v - [176, 196, 222][c]) > 1)) area++;
        }
      }
      return { scale: s.scale, angle: s.angle, error: error / area };
    });
    map.remove();
    return errors;
  }, base);
  console.table(result);
  for (const s of result)
    assert.ok(
      s.error < 0.055,
      `Aliased bar at size ${s.scale}, angle ${s.angle}: ${s.error.toFixed(4)} edge error`,
    );
} finally {
  await browser.close();
}

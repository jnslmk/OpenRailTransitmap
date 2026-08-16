/**
 * Stage 2b: the minimal basemap.
 *
 * Deliberately sparse - water, state borders, populated places. The reference
 * poster puts nothing else under its network, and every extra feature competes
 * with the rail lines for attention.
 */

import { createReadStream, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { writeFeatures } from './lib/write.ts';

const WORK = process.env.WORK_DIR ?? '.work';
const EXTRACT = `${WORK}/extract`;
const OUT = `${WORK}/build`;

/** Rough planar area, used only to drop ponds that would never be visible. */
function ringArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(a / 2);
}

const MIN_WATER_AREA = 2e-5; // ~ a few hundred metres across

/**
 * Zoom at which a water body first appears, by area.
 *
 * Without this the low-zoom tiles carried every pond in the country - over 2000
 * water polygons in a single z5 tile - which blew tippecanoe's 500 KB tile
 * budget and got city labels silently dropped to make room. Only the Bodensee
 * and the big Mecklenburg lakes are legible at z5 anyway.
 */
function waterMinzoom(area: number): number {
  if (area >= 5e-3) return 4;
  if (area >= 5e-4) return 6;
  if (area >= 5e-5) return 8;
  return 9;
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  const water: unknown[] = [];
  const boundaries: unknown[] = [];
  const places: unknown[] = [];

  const rl = createInterface({
    input: createReadStream(`${EXTRACT}/base.geojsonseq`),
    crlfDelay: Infinity,
  });

  for await (const raw of rl) {
    const text = raw.replace(/^\x1e/, '').trim();
    if (!text) continue;
    let f: any;
    try { f = JSON.parse(text); } catch { continue; }
    const p = f.properties ?? {};
    const g = f.geometry;
    if (!g) continue;

    if (p.place === 'city' || p.place === 'town') {
      if (g.type !== 'Point' || !p.name) continue;
      const pop = parseInt(p.population ?? '0', 10) || 0;
      places.push({
        type: 'Feature',
        geometry: g,
        // No per-feature minzoom here on purpose. Combining one with
        // tippecanoe's point drop rate is what reduced a national tile to a
        // single city: the drop rate thins whatever candidates remain, so
        // narrowing the candidates first makes it worse, not better. Instead
        // tiles.sh passes -r1 to keep every place, and the style layers filter
        // by population and zoom.
        properties: {
          name: p.name,
          place: p.place,
          population: pop,
          // Bigger cities appear earlier and win label collisions.
          rank: p.place === 'city' ? (pop > 500000 ? 1 : 2) : 3,
        },
      });
      continue;
    }

    // Only Bundesland-level borders; anything finer is visual noise at these zooms.
    if (p.boundary === 'administrative') {
      if (p['admin_level'] !== '4') continue;
      // Border *ways* carry the tag too and are what we actually draw; keeping
      // the relation polygons as well would double-draw every border.
      if (g.type !== 'LineString' && g.type !== 'MultiLineString') continue;
      boundaries.push({
        type: 'Feature',
        geometry: g,
        properties: { name: p.name ?? '', admin_level: 4 },
      });
      continue;
    }

    if (p.natural === 'water' || p.waterway === 'riverbank') {
      let area = 0;
      if (g.type === 'Polygon') {
        area = ringArea(g.coordinates[0]);
      } else if (g.type === 'MultiPolygon') {
        area = g.coordinates.reduce(
          (sum: number, poly: [number, number][][]) => sum + ringArea(poly[0]), 0);
      } else {
        continue;
      }
      if (area < MIN_WATER_AREA) continue;
      water.push({
        type: 'Feature',
        geometry: g,
        tippecanoe: { minzoom: waterMinzoom(area) },
        properties: { kind: 'water' },
      });
    }
  }

  await writeFeatures(`${OUT}/water.geojsonl`, water);
  await writeFeatures(`${OUT}/boundaries.geojsonl`, boundaries);
  await writeFeatures(`${OUT}/places.geojsonl`, places);

  console.log(`==> basemap: ${water.length} water, ${boundaries.length} borders, ${places.length} places`);
}

main().catch((err) => { console.error(err); process.exit(1); });

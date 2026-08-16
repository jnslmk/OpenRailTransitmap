/**
 * Stage 2b: the minimal basemap.
 *
 * Deliberately sparse - water, state borders, populated places. The reference
 * poster puts nothing else under its network, and every extra feature competes
 * with the rail lines for attention.
 */

import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

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
      if (g.type === 'Polygon') {
        if (ringArea(g.coordinates[0]) < MIN_WATER_AREA) continue;
      } else if (g.type === 'MultiPolygon') {
        const total = g.coordinates.reduce(
          (s: number, poly: [number, number][][]) => s + ringArea(poly[0]), 0);
        if (total < MIN_WATER_AREA) continue;
      } else {
        continue;
      }
      water.push({ type: 'Feature', geometry: g, properties: { kind: 'water' } });
    }
  }

  const fc = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features });
  writeFileSync(`${OUT}/water.geojson`, fc(water));
  writeFileSync(`${OUT}/boundaries.geojson`, fc(boundaries));
  writeFileSync(`${OUT}/places.geojson`, fc(places));

  console.log(`==> basemap: ${water.length} water, ${boundaries.length} borders, ${places.length} places`);
}

main().catch((err) => { console.error(err); process.exit(1); });

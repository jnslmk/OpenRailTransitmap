/**
 * Ocean polygons for the basemap.
 *
 * OSM models the sea as `natural=coastline` *ways*, which have to be assembled
 * into polygons before anything can fill them - so the sea is simply absent
 * from a `natural=water` tag filter, and the North Sea coast renders as flat
 * land. osmdata.openstreetmap.de publishes the already-assembled polygons.
 *
 * The simplified set is used because the basemap tiles stop at z10, and it is
 * 24 MB rather than ~800 MB. It ships in EPSG:3857, so coordinates are
 * projected back to WGS84 here rather than pulling in GDAL for one job.
 */

import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { open as openShapefile } from 'shapefile';

const WORK = process.env.WORK_DIR ?? '.work';
const OUT = `${WORK}/build`;
const CACHE = `${WORK}/water-polygons`;

const URL =
  'https://osmdata.openstreetmap.de/download/simplified-water-polygons-split-3857.zip';

/** Inverse spherical Web Mercator. */
const R = 6378137;
function toWgs84([x, y]: number[]): [number, number] {
  return [
    (x / R) * (180 / Math.PI),
    (Math.atan(Math.exp(y / R)) * 2 - Math.PI / 2) * (180 / Math.PI),
  ];
}

type Ring = [number, number][];

function projectRings(rings: number[][][]): Ring[] {
  return rings.map((ring) => ring.map(toWgs84));
}

/** Bounding box of a projected polygon, for cheap region filtering. */
function bbox(rings: Ring[]): [number, number, number, number] {
  let w = 180, s = 90, e = -180, n = -90;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  }
  return [w, s, e, n];
}

const intersects = (
  a: [number, number, number, number],
  b: [number, number, number, number],
) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(CACHE, { recursive: true });

  const cfg = parseYaml(readFileSync('config/regions.yaml', 'utf8'));
  const region = cfg.regions[cfg.active];

  // Whole polygons are kept or dropped rather than clipped, so a tight box
  // leaves a straight edge where the sea simply stops. The margin is generous
  // enough to push that seam well outside any view of the region; tippecanoe
  // clips to tile boundaries anyway, so the cost is only in build memory.
  const [w, s, e, n] = region.bbox as number[];
  const pad = 5;
  const target: [number, number, number, number] = [w - pad, s - pad, e + pad, n + pad];

  const zip = `${CACHE}/water.zip`;
  if (!existsSync(zip)) {
    console.log(`==> downloading ${URL}`);
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`water polygons: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zip));
  } else {
    console.log('==> water polygons: cached');
  }

  const shp = `${CACHE}/simplified_water_polygons.shp`;
  if (!existsSync(shp)) {
    execFileSync('unzip', ['-o', '-j', zip, '-d', CACHE], { stdio: 'ignore' });
  }

  const features: unknown[] = [];
  let total = 0;
  const source = await openShapefile(shp);
  for (;;) {
    const { done, value } = await source.read();
    if (done) break;
    total++;
    const g = value?.geometry;
    if (!g) continue;

    // The dataset is Polygon-only, but guard anyway.
    const polys: number[][][][] =
      g.type === 'Polygon' ? [g.coordinates as number[][][]]
        : g.type === 'MultiPolygon' ? (g.coordinates as number[][][][])
          : [];

    for (const poly of polys) {
      const rings = projectRings(poly);
      if (!intersects(bbox(rings), target)) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: rings },
        properties: { kind: 'ocean' },
      });
    }
  }

  writeFileSync(
    `${OUT}/ocean.geojson`,
    JSON.stringify({ type: 'FeatureCollection', features }),
  );
  console.log(`==> ocean: ${features.length} polygons kept of ${total}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

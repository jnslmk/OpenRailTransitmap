#!/usr/bin/env bash
#
# Stage 3: GeoJSON -> PMTiles.
#
# Two archives so the basemap can be cached independently of the network, which
# changes every night:
#   base.pmtiles  water, borders, place labels
#   rail.pmtiles  route bands, stations
#
# Neither is committed. CI builds them and uploads them with the Pages artifact
# (see .github/workflows/build.yml).

set -euo pipefail

WORK="${WORK_DIR:-.work}"
BUILD="$WORK/build"
OUT="${TILE_OUT:-public/tiles}"
mkdir -p "$OUT"

# Modes are zoom-gated in shared/lnvg.ts; matching the tile minzoom keeps the
# urban layers out of low-zoom tiles entirely rather than just hiding them.
echo "==> building rail.pmtiles"
tippecanoe \
  -o "$OUT/rail.pmtiles" --force \
  --minimum-zoom=4 --maximum-zoom=13 \
  -P \
  --drop-densest-as-needed \
  --extend-zooms-if-still-dropping \
  --simplification=2 \
  --no-tiny-polygon-reduction \
  --detect-shared-borders \
  -L routes:"$BUILD/routes.geojsonl" \
  -L stations:"$BUILD/stations.geojsonl" \
  2>&1 | tail -3

echo "==> building base.pmtiles"
tippecanoe \
  -o "$OUT/base.pmtiles" --force \
  --minimum-zoom=4 --maximum-zoom=10 \
  -P \
  --drop-densest-as-needed \
  --coalesce-densest-as-needed \
  --simplification=4 \
  -L ocean:"$BUILD/ocean.geojsonl" \
  -L water:"$BUILD/water.geojsonl" \
  -L boundaries:"$BUILD/boundaries.geojsonl" \
  -L places:"$BUILD/places.geojsonl" \
  2>&1 | tail -3

echo "==> tiles:"
ls -lh "$OUT"/*.pmtiles | awk '{print "    " $9 "  " $5}'

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

# Closures come from an upstream that can be down, so the layer is included
# only when the build actually produced features for it. An empty -L argument
# is a tippecanoe error, and a failed rebuild of the whole map is a far worse
# outcome than a night without the construction overlay.
CLOSURES=()
if [[ -s "$BUILD/closures.geojsonl" ]]; then
  CLOSURES=(-L closures:"$BUILD/closures.geojsonl")
  echo "==> including $(wc -l < "$BUILD/closures.geojsonl") closure features"
else
  echo "==> no closure features - building without the closure layer"
fi

# Modes are zoom-gated in shared/lnvg.ts; matching the tile minzoom keeps the
# urban layers out of low-zoom tiles entirely rather than just hiding them.
#
# `stopmarks` carries the same idea per feature: build.ts stamps each mark with
# the zoom its tier appears at (STOP_TIERS), so the tile covering the whole of
# Germany holds the 400-odd long-distance stops and not the 12,000 tram ones.
# That stamp is also what keeps them: tippecanoe implements its point drop rate
# *as* a per-feature minzoom, so an explicit one replaces it, and the ranking
# decides what a low-zoom tile keeps instead of a pseudo-random sample.
#
# `stations` is left to the drop rate as before. It is no longer what the map
# draws below z16, only what the search box reads and what a stop off its own
# corridor falls back to.
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
  -L stopmarks:"$BUILD/stopmarks.geojsonl" \
  "${CLOSURES[@]}" \
  2>&1 | tail -3

# -r1 disables tippecanoe's point drop rate, which defaults to 2.5 and thins
# points at low zoom by pseudo-random sampling. Left on, a tile covering the
# whole country kept exactly one city - Nürnberg, not Berlin - which is why the
# map used to label arbitrary villages. All 2324 places are cheap to carry, so
# they all go in and the style layers filter by population and zoom instead.
#
# The density-based thinning flags are off for the same reason: the basemap is
# only a few thousand features, and both discard or merge points by density.
# Water is still zoom-gated per feature in build-basemap.ts - that is polygons,
# which the drop rate does not touch.
echo "==> building base.pmtiles"
tippecanoe \
  -o "$OUT/base.pmtiles" --force \
  --minimum-zoom=4 --maximum-zoom=10 \
  -P \
  -r1 \
  --simplification=4 \
  -L ocean:"$BUILD/ocean.geojsonl" \
  -L water:"$BUILD/water.geojsonl" \
  -L boundaries:"$BUILD/boundaries.geojsonl" \
  -L places:"$BUILD/places.geojsonl" \
  2>&1 | tail -3

echo "==> tiles:"
ls -lh "$OUT"/*.pmtiles | awk '{print "    " $9 "  " $5}'

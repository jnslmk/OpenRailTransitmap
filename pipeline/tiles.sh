#!/usr/bin/env bash
#
# Stage 3: GeoJSON -> PMTiles.
#
# One archive - rail.pmtiles, holding the route bands, the stations and the
# stop marks. The ground under them is the OpenStreetMap raster, fetched by the
# browser from openstreetmap.org, so there is no basemap to tile here.
#
# It is not committed. CI builds it and uploads it with the Pages artifact
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

# How much of a neighbouring tile's geometry every tile carries, in 256ths of
# a tile. tippecanoe's default 5 is sized for geometry that is drawn where it
# lies; a route band is not. MapLibre stencil-clips each tile's lines to the
# tile's own square and only then moves them sideways, so a band whose slot
# carries it over the edge is cut there, and the tile on the other side - which
# holds its own geometry, not the stretch whose band lands there - has nothing
# to put in its place. On a corridor crossing an edge at a shallow angle that
# takes the line out from the crossing until the track itself is clear of the
# edge by the whole offset: hundreds of metres of missing band, ending in a
# round cap in open country.
#
# build.ts writes the width this build's own widest band needs (see
# `bandReachPx` and `tileBufferUnits` in shared/lnvg.ts). The fallback is for
# a hand-run of this stage against an older .work: enough for a bundle of 24,
# which is one wider than the busiest corridor in Germany.
BUFFER="$(cat "$BUILD/tile-buffer" 2>/dev/null || echo 41)"
echo "==> tile buffer: $BUFFER"

echo "==> building rail.pmtiles"
tippecanoe \
  -o "$OUT/rail.pmtiles" --force \
  --minimum-zoom=4 --maximum-zoom=13 \
  --buffer="$BUFFER" \
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

echo "==> tiles:"
ls -lh "$OUT"/*.pmtiles | awk '{print "    " $9 "  " $5}'

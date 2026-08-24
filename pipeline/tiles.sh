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

echo "==> building the route and station layers"
tippecanoe \
  -o "$WORK/base.pmtiles" --force \
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
  "${CLOSURES[@]}" \
  2>&1 | tail -3

# The stop marks get a pass of their own per tier, and are then joined back in.
#
# They cannot ride along in the pass above. A mark is the map's anchor - the bar
# that says a train stops here, and the thing its name is hung on - so dropping
# one is not a thinning, it is a station gone. But tippecanoe drops points by
# default, and the per-feature `tippecanoe.minzoom` stamp that used to hold the
# tiers apart does not stop it - it causes it. Give a point layer an explicit
# minzoom and tippecanoe (2.49 here) keeps *one feature per tile* of it, at
# every zoom including the maximum, whatever the drop rate is set to. That is
# what emptied this layer: a z11 tile held one mark where it should hold twenty,
# so the map drew a bar at the odd station and named almost none of them.
#
# What does hold is the pair of options a whole pass can carry: `-Z` for the
# zoom the tier starts at, `-r1` for no dot-dropping at all. So build.ts writes
# the marks one file per tier, each pass is gated at its own `-Z`, and tile-join
# stacks them back into the single `stopmarks` layer the style reads.
JOIN=("$WORK/base.pmtiles")
for marks in "$BUILD"/stopmarks-z*.geojsonl; do
  [[ -s "$marks" ]] || continue
  z="${marks##*stopmarks-z}"
  z="${z%.geojsonl}"
  echo "==> building the stop marks from z$z ($(wc -l < "$marks") marks)"
  tippecanoe \
    -o "$WORK/stopmarks-z$z.pmtiles" --force \
    --minimum-zoom="$z" --maximum-zoom=13 \
    -P \
    --drop-rate=1 \
    --no-tile-size-limit \
    -L stopmarks:"$marks" \
    2>&1 | tail -1
  JOIN+=("$WORK/stopmarks-z$z.pmtiles")
done

# -pk here for the same reason as above: the join must not be where a mark that
# survived its own pass is dropped for the sake of a byte count.
echo "==> joining into rail.pmtiles"
tile-join -f -pk -o "$OUT/rail.pmtiles" "${JOIN[@]}" 2>&1 | tail -2
rm -f "${JOIN[@]}"

echo "==> tiles:"
ls -lh "$OUT"/*.pmtiles | awk '{print "    " $9 "  " $5}'

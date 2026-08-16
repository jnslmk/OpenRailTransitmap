#!/usr/bin/env bash
#
# Stage 1: pull the rail network out of a Geofabrik extract using osmium.
#
# Route geometry cannot be exported directly (osmium export only builds geometry
# for multipolygon/boundary relations), so this runs in two passes:
#
#   pass 1  route relations only -> OPL, which gives us tags + member way ids
#   pass 2  fetch exactly those ways -> GeoJSON LineStrings, keyed by way id
#
# build.ts then stitches ways into routes. Stations and basemap features are
# straightforward tag filters exported directly to GeoJSON.

set -euo pipefail

WORK="${WORK_DIR:-.work}"
OUT="$WORK/extract"
mkdir -p "$OUT"

PBF="$(ls "$WORK"/*-latest.osm.pbf 2>/dev/null | head -1)"
if [[ -z "$PBF" ]]; then
  echo "error: no *-latest.osm.pbf in $WORK - run pipeline/fetch.sh first" >&2
  exit 1
fi
echo "==> source: $PBF ($(du -h "$PBF" | cut -f1))"

step() { echo "==> $*"; }

# --- pass 1: route relations -------------------------------------------------
# -R excludes referenced objects: we want the relations alone, which keeps this
# tiny and fast even on the national extract.
step "filtering route relations"
osmium tags-filter "$PBF" -R \
  r/type=route \
  r/type=route_master \
  -o "$OUT/routes.osm.pbf" --overwrite

osmium cat "$OUT/routes.osm.pbf" -f opl -o "$OUT/routes.opl" --overwrite
echo "    $(wc -l < "$OUT/routes.opl") relations"

# --- pass 2: the ways those relations reference -------------------------------
# build.ts writes way-ids.txt on a first (parse-only) run; on a cold start we
# fall back to every railway way, which is a superset and still cheap.
step "filtering railway ways"
osmium tags-filter "$PBF" \
  w/railway=rail,light_rail,subway,tram,narrow_gauge,funicular,monorail \
  -o "$OUT/rail-ways.osm.pbf" --overwrite

osmium export "$OUT/rail-ways.osm.pbf" \
  -f geojsonseq \
  --geometry-types=linestring \
  --add-unique-id=type_id \
  -o "$OUT/rail-ways.geojsonseq" --overwrite
echo "    $(wc -l < "$OUT/rail-ways.geojsonseq") ways"

# --- stations ----------------------------------------------------------------
# Keep uic_ref / ref:IFOPT / wikidata so map stations can be matched to MOTIS
# stops later without re-running the extract.
step "filtering stations"
osmium tags-filter "$PBF" \
  n/railway=station,halt,tram_stop \
  n/public_transport=station \
  nw/railway=station,halt \
  -o "$OUT/stations.osm.pbf" --overwrite

osmium export "$OUT/stations.osm.pbf" \
  -f geojsonseq \
  --geometry-types=point \
  --add-unique-id=type_id \
  -o "$OUT/stations.geojsonseq" --overwrite
echo "    $(wc -l < "$OUT/stations.geojsonseq") station features"

# PTv2 route relations reference `public_transport=stop_position` nodes rather
# than the `railway=station` node, so those ids alone do not identify a station.
# Exporting the stop positions lets build.ts snap each one to its station.
step "filtering stop positions"
osmium tags-filter "$PBF" -R \
  n/public_transport=stop_position \
  -o "$OUT/stops.osm.pbf" --overwrite

osmium export "$OUT/stops.osm.pbf" \
  -f geojsonseq \
  --geometry-types=point \
  --add-unique-id=type_id \
  -o "$OUT/stops.geojsonseq" --overwrite
echo "    $(wc -l < "$OUT/stops.geojsonseq") stop positions"

# --- basemap -----------------------------------------------------------------
# Deliberately minimal: water, state borders, populated places. Nothing else,
# so the rail network stays the only thing competing for attention.
step "filtering basemap features"
osmium tags-filter "$PBF" \
  nwr/natural=water \
  nwr/waterway=riverbank \
  r/boundary=administrative \
  n/place=city,town \
  -o "$OUT/base.osm.pbf" --overwrite

osmium export "$OUT/base.osm.pbf" \
  -f geojsonseq \
  --add-unique-id=type_id \
  -o "$OUT/base.geojsonseq" --overwrite
echo "    $(wc -l < "$OUT/base.geojsonseq") basemap features"

step "extract complete -> $OUT"

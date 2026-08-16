# OpenRailTransitmap

An interactive map of Germany's passenger rail network, built from OpenStreetMap
data and styled after the **LNVG Niedersachsen *Streckenfahrplan***. Published to
GitHub Pages and rebuilt nightly.

> The reference document is a strictly octilinear schematic. This project is a
> *geographic* map — the geometry stays true to OSM. What carries the reference's
> look across is its palette, its three-step line-weight hierarchy, parallel
> route bundling, station symbology and line-number badges.

## What it does

- **Every passenger mode, individually selectable** — long-distance (ICE/IC/EC),
  regional (RE/RB), S-Bahn, U-Bahn and tram.
- **Parallel route bundling.** Lines sharing a corridor draw as adjacent coloured
  bands instead of stacking into one indistinguishable stroke.
- **Click a line** to highlight it end-to-end and open a detail panel; **click a
  station** for every line calling there.
- **Search, mode and operator filters, a live legend**, and deep-linkable URLs
  that restore position, filters and selection.
- **Full-screen map.** A button on the map hides the whole sidebar so the map
  fills the window — the difference between usable and unusable on a phone — and
  a second one goes to browser fullscreen. On narrow screens the sidebar is a
  bottom sheet that folds to its handle by tap or drag, for a big map that still
  has search one tap away. Both states are part of the URL (`?ui=map`, `?ui=peek`).
- **Own location**, with an accuracy circle and continuous tracking, and a
  compass that puts the map back to north after an accidental twist.
- **Streets where they help.** From zoom 13 the OSM standard raster fades in
  under the network, heavily desaturated, so a tram stop can be placed on an
  actual street. Off with one checkbox (`?streets=0`).
- **Bilingual** (DE/EN), with a minimal LNVG-styled basemap and an OpenStreetMap
  raster toggle.

## How it is built

```
config/regions.yaml        one value switches the whole pipeline's region
pipeline/
  fetch.sh                 download the Geofabrik extract
  extract.sh               osmium -> route relations, ways, stations, basemap
  build.ts                 stitch routes, bundle corridors, snap stops
  build-basemap.ts         water, state borders, place labels
  coastline.ts             ocean polygons (the sea is not natural=water)
  fonts.ts                 self-hosted MapLibre glyphs (no font CDN)
  tiles.sh                 tippecanoe -> rail.pmtiles + base.pmtiles
shared/lnvg.ts             design tokens read out of the reference PDF
src/                       MapLibre app (style, state, UI, controls, i18n)
```

### Region switching

`config/regions.yaml` selects the extract. Germany (4.5 GB) is the deployed
default and runs the whole pipeline in about 8 minutes — 6m30s of that is the
osmium extraction — producing 1,413 lines, 20,830 stations and 23 MB of tiles.
Niedersachsen (479 MB) runs in about a minute and is what makes style iteration
bearable. Same code either way, and `REGION=niedersachsen` overrides the file
for a one-off run.

```yaml
active: germany   # or: niedersachsen
```

### Route stitching and bundling

Route geometry cannot be exported directly — osmium only builds geometry for
multipolygon and boundary relations — so `extract.sh` runs two passes: route
relations to OPL (tags plus member way ids), then the referenced railway ways to
GeoJSON. `build.ts` stitches them, flipping ways where needed so a corridor keeps
a consistent direction.

Bundling then falls out of the way ids for free: routes sharing a corridor are
built from the *same OSM ways*, so ways carrying an identical set of lines form
one segment, and each line in that segment gets a centred perpendicular offset
ordinal. No geometric matching required.

Directional variants (`A → B` and `B → A`) are collapsed into one logical line
keyed on `mode | network | ref`.

### Station matching

PTv2 relations reference `public_transport=stop_position` nodes rather than the
`railway=station` node, so stop members are snapped to the nearest station within
300 m using a grid index. This lifted station coverage from 11 to 1,264 of 1,748
stations on the Niedersachsen extract, and yields 16,865 of 20,830 nationally.

### The sea

OSM models the sea as `natural=coastline` *ways* that must be assembled into
polygons, so a `natural=water` filter yields no ocean at all and the coast
renders as flat land. `coastline.ts` pulls the pre-assembled simplified water
polygons from osmdata.openstreetmap.de and reprojects them from EPSG:3857 to
WGS84 in pure JS, which avoids adding GDAL to CI for a single job.

### Colours

OSM `colour` is used **verbatim** where tagged, so Hamburg and Berlin S-Bahn and
every U-Bahn look locally correct. Untagged lines — most RE/RB — get a
deterministic colour hashed on `network` + `ref` from the reference palette, so a
line keeps its colour across nightly rebuilds. Long-distance stays red as one
family. `data/overrides.yaml` overrides either.

Nationally, 55% of lines carry an OSM `colour` (43% on the Niedersachsen extract).

## Running it locally

```bash
sudo apt-get install -y osmium-tool tippecanoe
npm ci

bash pipeline/fetch.sh          # download the extract
bash pipeline/extract.sh        # osmium filtering
npx tsx pipeline/build.ts       # routes, bundling, stations
npx tsx pipeline/build-basemap.ts
npx tsx pipeline/coastline.ts   # ocean polygons (24 MB download, cached)
npx tsx pipeline/fonts.ts       # glyphs (cached after the first run)
bash pipeline/tiles.sh          # PMTiles
cp data/lines.json public/lines.json

npm run dev                     # http://localhost:5173
```

## What is committed

Only `data/lines.json` — a small, diffable registry of every line with its
colour, mode, operator and stop count — plus `data/overrides.yaml`. Tiles,
glyphs and the extract are built in CI and shipped as the Pages artifact, so the
repository does not grow by tens of megabytes a night.

## Roadmap

Phases 1–3 (pipeline, style, interactions, scale-up) are the map itself.

**Phase 4 is a bike + train journey planner**: enter A and B, get itineraries
with a bike/train time split you can bias with a slider — "cycle an hour, take
the train an hour". It will run on the [Transitous](https://transitous.org)
MOTIS API behind a `RoutingProvider` interface.

That backend was validated up front — see
[`docs/spike-transitous.md`](docs/spike-transitous.md). Two findings worth
knowing: hour-long bike legs work fine on the public instance, so no self-hosted
routing engine is needed; but `requireBikeTransport` cannot be the default,
because most German GTFS feeds omit `bikes_allowed` and requiring it silently
returns zero regional journeys.

## Attribution and licensing

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
licensed under the **ODbL**. The OpenStreetMap raster basemap toggle uses
openstreetmap.org tiles and is subject to the OSMF tile usage policy.

Labels are set in Fira Sans (SIL Open Font License) as a free stand-in for the
reference document's proprietary DB Sans. This project is not affiliated with
LNVG or Deutsche Bahn; the reference document is used only as a design study.

Code is MIT licensed.

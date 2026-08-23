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
  regional (RE/RB), S-Bahn, U-Bahn, tram and long-distance coach.
- **Long-distance coach, which OSM does not have.** `route=coach` is two
  relations in the whole of Germany, so the Fernbus network is read from the
  operator's own GTFS instead — 347 lines and 337 stops, drawn on the road
  alignment the operator publishes rather than chorded between stops, dashed
  because it is not a railway, and merged into the same layers as the rail
  network so it selects, searches and filters like any other mode. A coach stop
  within 400 m of a station becomes part of that station rather than a second
  dot beside it. See [`docs/buses-and-routing.md`](docs/buses-and-routing.md).
- **Parallel route bundling.** Lines sharing a corridor draw as adjacent coloured
  bands instead of stacking into one indistinguishable stroke.
- **Click a line** to highlight it end-to-end and open a detail panel; **click a
  station** for every line calling there.
- **Punctuality on the line panel.** How often the line actually departs on
  time over a rolling 12 months, broken down by station, worst first — so
  "RE70 runs at 73%" comes with the fact that it is 39% at Hannover-Linden and
  96% at Bielefeld, where it starts. Reported as a median ("typically 1 min
  late") and a 90th percentile ("1 train in 10 is 10+ min"), never a mean:
  measured over 1.1 M departures the distribution is zero-inflated and
  long-tailed, so its mean sits at the 70th percentile and a bell curve fitted
  to it would put a third of departures at a negative delay. Built from
  Deutsche Bahn's published delay record (CC BY 4.0); regional and S-Bahn only,
  for now. See [`docs/punctuality.md`](docs/punctuality.md).
- **What is shut today.** Construction closures from DB InfraGO's own
  possession register, drawn as a hazard stripe along the track they actually
  close — routed onto the real alignment rather than chorded between the two
  operating points DB names, which for the longest of them is 125 km of straight
  line across open country. Full closures and single-track working show from
  zoom 6, lesser restrictions from zoom 10, and clicking one gives the works,
  the hours it applies today and the dates it runs between. Off with one
  checkbox (`?closures=0`). See [`docs/closures.md`](docs/closures.md).
- **A closure history, because nobody else keeps one.** strecken.info serves the
  plan as it stands and nothing before it, so the archive is ours:
  `data/closure-log.jsonl` is appended to daily and records a possession
  entering the plan, its dates moving, and its withdrawal. The panel reads it
  back — "was to finish 12 Dec" is a fact no snapshot of the current plan can
  tell you.
- **Search, mode and operator filters**, and deep-linkable URLs that restore
  position, filters and selection.
- **A legend of what is actually on screen.** Only modes with lines in the
  current view get a row, and the number beside each is how many of them are in
  view — not a national total that says nothing about where you are looking.
  Switching a mode off hides its lines *and* its stops, and keeps its row so it
  can come back. A row you have just ticked is held open until you move the map,
  even where that mode runs nowhere near the view — a toggle that deleted the
  row it was made on could not be undone.
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
- **A minimal LNVG-styled basemap** with an OpenStreetMap raster toggle. The
  interface is English; station and line names stay as OSM has them, in German.

## How it is built

```
config/regions.yaml        one value switches the whole pipeline's region
pipeline/
  fetch.sh                 download the Geofabrik extract
  extract.sh               osmium -> route relations, ways, stations, basemap
  closures.ts              DB InfraGO possessions + the history log
  coach.ts                 long-distance coach from the operators' GTFS
  lib/railpath.ts          route a closure onto the track it closes
  build.ts                 stitch routes, bundle corridors, snap stops
  build-basemap.ts         water, state borders, place labels
  coastline.ts             ocean polygons (the sea is not natural=water)
  fonts.ts                 self-hosted MapLibre glyphs (no font CDN)
  tiles.sh                 tippecanoe -> rail.pmtiles + base.pmtiles
shared/lnvg.ts             design tokens read out of the reference PDF
src/                       MapLibre app (style, state, UI, controls, strings)
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
npx tsx pipeline/closures.ts    # today's construction closures (optional)
npx tsx pipeline/coach.ts       # long-distance coach network (optional)
npx tsx pipeline/build.ts       # routes, bundling, stations
npx tsx pipeline/build-basemap.ts
npx tsx pipeline/coastline.ts   # ocean polygons (24 MB download, cached)
npx tsx pipeline/fonts.ts       # glyphs (cached after the first run)
bash pipeline/tiles.sh          # PMTiles
npm run publish:data            # committed data -> public/

npm run dev                     # http://localhost:5173
```

Punctuality is refreshed separately, because its upstream files change monthly
rather than nightly and a pass costs ~0.9 GB of range requests:

```bash
npm run build:punctuality       # ~15 min; commit the data/punctuality.json it writes
PUNCTUALITY_MONTHS=1 npm run build:punctuality   # one month, for development
```

The closure log is refreshed on its own daily schedule rather than with the map,
because a day missed is a day of the plan gone for good — see
[`.github/workflows/closures.yml`](.github/workflows/closures.yml). It is the
only job in this repository with `contents: write`, and it writes one file:

```bash
npm run log:closures            # append today's changes to data/closure-log.jsonl
```

## Checking the deployed map

`e2e/` drives a real browser against a real deployment — the published site by
default — and covers the legend, which is the fiddliest part of the interface
because it is scoped to the view. It has its own `package.json` so the nightly
build never installs a browser to build tiles.

```bash
npm --prefix e2e install
npx playwright install chromium     # once, unless a browser is already present

node e2e/legend.mjs                                # https://jnslmk.github.io/OpenRailTransitmap/
node e2e/legend.mjs --url http://127.0.0.1:5173/   # a local dev server
node e2e/legend.mjs --headed                       # watch it run
```

A local run needs tiles, which the pipeline builds; the quickest way to get
them without running it is to copy the deployed ones into `public/`.

## What is committed

`data/lines.json` — a small, diffable registry of every line with its colour,
mode, operator and stop count — plus `data/overrides.yaml`,
`data/line-stations.json` (each line's stations, the key the punctuality join
needs) and `data/punctuality.json` (the scores themselves). The last two are
committed because the build runs with `contents: read` and cannot push, so
anything it computed would be thrown away; a human refreshes them and commits
the diff.

`data/closure-log.jsonl` is the exception that is written by CI, by the one job
that may. It is append-only and it is the archive: 4.6 MB seeded, then about
50 KB of events a day. The closures the map *draws* are not committed at all —
they change daily, they ride in the tiles, and the build reads them fresh.

Tiles, glyphs and the extract are built in CI and shipped as the Pages artifact,
so the repository does not grow by tens of megabytes a night.

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

**Buses come with it.** MOTIS routes on the DELFI GTFS aggregate, so a plan
already returns local and regional bus legs — measured, a village near Rethem to
Hannover Hbf comes back as `bike 19 → bus 510 → RB38 → bike 4` with no pipeline
change at all. Drawing buses on the map is the separate, much larger question:
eighteen `route=bus` relations for every rail one in Niedersachsen alone. The
design for both, and for a Google-Maps-shaped planner that stays inside this map
instead of taking it over, is in
[`docs/buses-and-routing.md`](docs/buses-and-routing.md).

## Attribution and licensing

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
licensed under the **ODbL**. The OpenStreetMap raster basemap toggle uses
openstreetmap.org tiles and is subject to the OSMF tile usage policy.

Construction closures come from **DB InfraGO**'s
[strecken.info](https://strecken-info.de), the infrastructure manager's own
public possession register. It is published as information rather than under an
open licence, so it is credited in the sidebar and in the map's attribution
control whenever a closure is on screen, and the feed itself is not
redistributed — only the change log described above.

Long-distance coach comes from **FlixBus**'s own GTFS feed, published by
FlixMobility Tech GmbH. Like the possession register it carries no licence — the
Transitous feed registry records one for BlaBlaCar and Optima and none for this
one — so it gets the same handling: the feed is not redistributed, only the
lines derived from it are drawn, and FlixMobility is credited in the sidebar and
in the map's attribution control whenever a coach line is in view.

Punctuality is derived from Deutsche Bahn's published delay record via the
[`piebro/deutsche-bahn-data`](https://huggingface.co/datasets/piebro/deutsche-bahn-data)
dataset, licensed **CC BY 4.0** — attributed to Deutsche Bahn in the sidebar and
in the map's own attribution control whenever a score is on screen.

Labels are set in Fira Sans (SIL Open Font License) as a free stand-in for the
reference document's proprietary DB Sans. This project is not affiliated with
LNVG or Deutsche Bahn; the reference document is used only as a design study.

Code is MIT licensed.

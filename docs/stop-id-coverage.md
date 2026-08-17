# Stop-id coverage: where it stands and how to push it further

Handoff, 2026-08-17. Everything below marked "measured" was measured against
`https://api.transitous.org/api/v1` on that date, with the pipeline's own
`User-Agent`.

The station popup shows a departure board only when the station feature in the
tiles carries a non-empty `stopId` (`pipeline/build.ts` stamps it,
`src/main.ts` reads it). That id comes from `data/stop-ids.json`, resolved at
build time by `pipeline/stop-ids.ts`. So coverage of that cache *is* coverage
of the feature.

## Where it stands

All 20 832 stations are now in the cache (they were not: the cache held 1749
entries, and those only because `.work/extract/stations.geojsonseq` had been
built from the Niedersachsen extract — `pipeline/extract.sh` takes whichever
`*-latest.osm.pbf` sorts first in `.work/`, regardless of
`config/regions.yaml`).

| | after the national pass (v4) | after the v5 re-probe |
|---|---|---|
| resolved | 16 164 (78%) | **17 933 (86%)** |
| ambiguous | 2 590 | 896 |
| negative | 2 078 | 2 003 |

Two passes, 22 733 lookups, zero errors. The v5 re-probe alone converted 1769
of the 4668 previously-declined stations without a single new idea being
applied to the *search* — only to the matching. That is the shape of the
remaining problem: the answers are mostly already in reach.

## What the remaining 2899 actually are

Measured over the current cache, joined against the OSM tags in the extract.

**Negatives (2003)**

| count | what |
|---|---|
| 973 | plausible rail stop, still unmatched |
| 545 | no `railway=*` tag at all |
| 369 | ferry landing, chairlift, funicular, museum railway by name |
| 116 | `disused_*` / `abandoned_*` |

**Ambiguous (896)** — 63% carry `railway:ref`, 53% `uic_ref`, 17% `ref:IFOPT`.
These are overwhelmingly rail stations, not tram stops: the ambiguity is
usually a rail station and a bus stop of the same name at the same place.

## Ideas, in the order I would do them

### 1. Replace the geocoder search with a spatial sweep — `/api/v1/map/stops`

This is the big one. The undocumented-in-our-notes endpoint

```
GET /api/v1/map/stops?min=<lat>,<lon>&max=<lat>,<lon>
```

returns **every stop in a bounding box**, each with `stopId`, `name`, `lat`,
`lon` and — crucially — `modes`. Measured: 47 stops in a 0.01° box, 910 in
0.05°, 6796 in 0.2°, no sign of a result cap; a 1.0° box returns HTTP 422, so
the limit sits somewhere between 0.2° and 1.0°.

Why this changes things:

- **It removes the recall problem, which is now the dominant failure.** Today's
  three searches are all globally ranked, so a common street name never
  surfaces the local stop. Measured on the Halle tram stop
  "Geschwister-Scholl-Straße": `geocode` returns 10 matches, the
  town-qualified retry another 10, reverse-geocode 5 — 13 of them pass the
  name test and the nearest is **69 km away** in Jena. The stop the search
  wanted was never in any of the three lists. Same shape for Osnabrück's
  "Ostbahnhof (ODF)", whose name-matching candidates are Berlin, Diez and Graz.
- **A negative becomes provable.** The same box query for that Halle stop
  returns all 10 stops within 500 m, none named anything like it — so it is a
  true negative, and we know it rather than assume it. That distinction is
  worth more than the extra hits: it is the difference between "the resolver
  gave up" and "no feed carries this stop".
- **It is an order of magnitude politer.** 22 733 requests over two passes
  becomes one sweep of tiles that contain stations. Tiling at 0.05–0.1° and
  skipping empty tiles should land in the low thousands of requests, matched
  entirely offline afterwards. A full re-resolve stops being a two-hour ritual.

Suggested shape: sweep tiles → build one local index of (stop id, name, coords,
modes) → run the existing `bestMatch` against the stops within `MAX_DISTANCE_M`
of each station. The matcher stays; only the candidate source changes. Keep
`/geocode` as a fallback for the handful of stations whose box comes back empty.

### 2. Disambiguate on mode

`modes` from the sweep (or from one `/stoptimes` call) settles most of the 896.
Measured on the canonical case, Torgau:

```
de-DELFI_de:14730:8010351   modes = [METRO, REGIONAL_RAIL]   <- the station
de-DELFI_de:14730:915:1     modes = [BUS]                    <- the bus stop
```

and on Eschhofen, currently ambiguous, where the box makes it obvious:

```
 46m  "Limburg (Lahn)-Eschhofen Am Bahnhof"   modes=[BUS]
 94m  "Limburg (Lahn)-Eschhofen Bahnhof"      modes=[REGIONAL_RAIL]
```

This map only ever shows rail, and `src/live.ts` already filters the response
to rail modes — so when two candidates tie on name and distance and exactly one
serves the OSM station's mode class (`tram_stop` → `TRAM`, `station`/`halt` →
the rail modes), taking it is not a guess. Where both serve rail, decline as
today.

Expected: most of the 896, and it also protects against the failure mode where
a rail station resolves to the bus stop in front of it and the board shows
buses.

### 3. Join on `ref:IFOPT` (DHID) where OSM has one

German MOTIS ids embed the DHID: `de-DELFI_de:08337:6576`. OSM carries the same
identifier as `ref:IFOPT` on 3932 stations. Measured: for stations that have
the tag *and* already resolved, the resolved id contains the DHID stem in **82%**
of cases — the geocoder has been rediscovering by name what the tags state
outright.

Measured on 8 currently-unresolved stations carrying `ref:IFOPT`, constructing
`de-DELFI_<dhid>` and falling back to the three-component stem: **8 of 8**
returned live departures.

Caveat worth respecting: the DHID is not always the stop you want. Albbruck's
`de:08337:6576` resolves to "Albbruck ehem. Papierfabrik", a bus stop 176 m
from the station. So treat the join as a *candidate*, then run it through the
same name and distance validation as anything else. 263 of the unresolved
stations carry the tag.

Do **not** bother with `uic_ref`/`ref:ibnr`: measured, only 285 resolved ids
contain the station's UIC ref against 5851 that do not. The identifier space
does not line up.

### 4. Stop counting the impossible as failure

369 ferry landings, chairlifts and funiculars, 116 disused or abandoned halts,
and a good part of the 545 with no `railway=*` tag will never appear in a GTFS
feed. Classifying them up front — by tag, not by name regex — and recording
them as "not expected" rather than "confirmed absent" does two things: it stops
them consuming lookups on every version bump, and it makes the coverage number
mean something. The honest ceiling is likely around 93–95%, not 100%.

### 5. Smaller ideas, unmeasured

- **Inherit within a `stop_area`.** OSM groups the platforms and stop positions
  of one station into a `public_transport=stop_area` relation. Where one member
  resolves, the others are the same physical stop. `pipeline/extract.sh` does
  not currently extract those relations, so this needs a pipeline change before
  it can be evaluated. Note that duplicate OSM nodes for one stop are already
  visible in the data (two nodes named "Geschwister-Scholl-Straße", two
  "Jacob-Mayer-Straße/Jahrhunderthalle").
- **Cross-border stations** resolve through foreign feeds — measured, Frankfurt
  Hbf currently resolves to an `at-Railway-…` id, and it returns the full local
  board (ICE, U-Bahn, tram, bus), because MOTIS merges feeds per stop. So a
  foreign feed prefix is not a defect and should not be filtered out.
- **Confirm ids stay alive.** An id that returns zero departures across several
  probes at different times of day is probably stale; the cache has no notion
  of that today.

## Rules of engagement for whoever picks this up

- **A negative is permanent** unless `RESOLVER_VERSION` is bumped, which
  discards every `''` and `#ambiguous` entry on load and re-probes them.
  Resolved ids are kept. Bump it when `lookup()` or the matcher changes — that
  is the whole mechanism by which an improvement reaches the stations it was
  written to fix.
- **`STOP_ID_BUDGET=0` is genuinely network-free.** No lookups means `dirty`
  stays false and `saveCache` never fires, so a build cannot clobber a resolve
  pass running alongside it. Use it for every build that is not deliberately
  resolving.
- **The cache alone changes nothing on screen.** The `stopId` is baked into
  `rail.pmtiles`, so tiles must be rebuilt: `npx tsx pipeline/build.ts &&
  pipeline/build-basemap.ts && coastline.ts && bash pipeline/tiles.sh`.
- **CI cannot improve coverage.** `.github/workflows/build.yml` runs with
  `contents: read`, so the 500 lookups every build spends are thrown away.
  Coverage only moves when a locally-run pass is committed. Worth fixing with a
  token if this becomes a habit.
- **`npm test`** covers the matcher (`pipeline/stop-ids.test.ts`); every pair in
  it is one observed against the live API. Add the case before the fix.
- **The API returns 403 to Python's default `urllib` User-Agent.** An ad-hoc
  probe script without the pipeline's UA sees every request come back empty and
  will conclude the stops do not exist. This cost me half an hour.

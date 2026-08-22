# Live data: departures, moving trains, disruptions

Feasibility probes against the public Transitous MOTIS instance
(`https://api.transitous.org/api/`, server reports MOTIS v2.11.1). All three
requested features are supported; the constraint is request volume, not
capability.

Re-verified 2026-08-17. Everything below that says "measured" was measured on
that date; the numbers that changed since the first probe are marked.

## 1. Departures and delays — `/api/v1/stoptimes`

Works today. One call per station id returns the next *n* departures with both
scheduled and real-time values, so the delay is `departure - scheduledDeparture`.
Times come back as UTC with a `tz` field per place.

Live sample, Bremen Hbf (`de-DELFI_de:04011:13927_G`):

```
RS1      -> Verden(Aller)        sched 10:27Z  real 10:27Z  track 5   rt=true
ICE 1036 -> Ostseebad Binz       sched 09:53Z  real 10:29Z  track 10  rt=true   +36 min
RS3      -> Wilhelmshaven Hbf    sched 10:31Z  real 10:31Z  track 3   rt=true
```

Each entry carries `realTime`, `cancelled`, `tripCancelled`, `headsign`,
`scheduledTrack`/`track`, `agencyName`, `routeId` and `tripId`. ~12 KB for 6
departures.

**Correction to the first probe:** `routeShortName` (the line badge, e.g.
`ICE 1036`) sits on the stop-time entry itself, *not* under `trips[]` — that
array comes back empty on this endpoint. Read it from the entry.

**Always pass `mode`.** Without it, a query against a Hauptbahnhof returns mostly
buses departing from the forecourt ZOB, which is not what a rail map wants.
`mode=HIGHSPEED_RAIL,LONG_DISTANCE,REGIONAL_RAIL,SUBURBAN` gives rail. Note that
requesting `SUBURBAN` yields entries whose `mode` reads `METRO` — the request
vocabulary and the response vocabulary do not line up, so match on the set, not
on equality.

**Fit:** one request when a station popup opens. Negligible load. This is the
cheapest of the three and should be built first.

### Matching a map station to a MOTIS stop — not the freebie it looked like

The first probe assumed the preserved `ref:IFOPT` *is* the MOTIS stop id, minus a
feed prefix. It is not, reliably:

| | |
|---|---|
| Bremen Hbf in OSM | `ref:IFOPT=de:04011:13925` |
| Bremen Hbf in MOTIS | `de-DELFI_de:04011:13927_G` |

`de-DELFI_` + the OSM value returns an empty response. MOTIS serves the
**group-level** stop (the `_G` suffix), which aggregates the platform-level DHIDs
that OSM tends to carry; the two ids need not even share a number. Hannover Hbf
(`de:03241:31`) happens to work, which is what made the assumption look sound.

Two lookups do resolve correctly:

- `/api/v1/geocode?text=Bremen Hauptbahnhof` → `de-DELFI_de:04011:13927_G` as the
  first hit.
- `/api/v1/reverse-geocode?place=53.0834,8.8137` → the same stop, though mixed in
  with POIs (a shop in the station ranked above it), so results must be filtered
  to `type=STOP` and sanity-checked against the name.

Neither belongs at popup-open time — that is a second round-trip and a
geocoder query for every click. **Resolve the mapping once in the nightly
pipeline** and ship a `stopId` per station in the tiles, the same way `uic_ref`
is shipped now. Stations that fail to resolve simply get no departure board.

Id coverage in OSM, measured over Germany via Overpass: 8,650
`railway=station|halt` nodes, of which 5,456 carry `uic_ref` (~63%). The
equivalent count for `ref:IFOPT` timed out twice and is still unknown — worth
measuring off the extract during the pipeline run instead, where the data is
already local.

## 2. Trains moving along the lines — `/api/v1/map/trips`

Also works, and better than expected. Required parameters are `min`, `max`
(`lat,lon` corners), `zoom`, `startTime`, `endTime`.

Each returned segment carries everything needed to animate a vehicle **without
re-polling**:

| Field | Use |
|---|---|
| `polyline` | encoded shape of the segment — the path to move along |
| `departure` / `arrival` | real-time window for traversing it |
| `scheduledDeparture` / `scheduledArrival` | delay, by difference |
| `realTime` | whether the times are live or scheduled |
| `mode` | `HIGHSPEED_RAIL`, `REGIONAL_RAIL`, `SUBWAY`, `TRAM`, `BUS`, … |
| `trips[].routeShortName` | the line badge — populated here, unlike `/stoptimes` |

So position is interpolated client-side along the polyline between the two
timestamps, and a poll is only needed every minute or so to pick up new trips and
delay changes — the animation itself is local. That is what makes this viable at
all.

**Measured cost (revised upward).** A Hannover-area bbox
(`52.20,9.55` – `52.50,9.95`) at z12 over a 3-minute window returned **1,017
segments, 1.51 MB raw / 410 KB gzipped** — the first probe recorded 500 segments
/ 1.1 MB for the same shape of request, so treat this figure as variable with
time of day rather than fixed. Mode mix was `BUS` 659, `SUBWAY` 279, `METRO` 23,
`HIGHSPEED_RAIL` 22, `COACH` 21, `REGIONAL_RAIL` 7, `LONG_DISTANCE` 3. Keeping
only rail modes leaves 334 segments, about 630 KB raw — a two-thirds cut, and the
single most effective mitigation available.

**This is the one with a real constraint.** Half a megabyte per poll for one city
does not scale to a national viewport, and Transitous explicitly asks to be
contacted before sending many requests or using resource-intensive endpoints.
Mitigations, in order of importance:

1. Only fetch above a zoom threshold (say z10) — never for the whole country.
2. Filter to the modes the user has enabled.
3. Poll at ~60 s, interpolating locally in between; never on every frame.
4. Pause polling when the tab is hidden.
5. Ask Transitous first, and be ready to self-host MOTIS if the answer is no.

## 3. Disruptions, construction, closures

Two different things, from two different sources.

**Operational disruptions** come from MOTIS as GTFS-RT service alerts. The API has
a `withAlerts` parameter on `/stoptimes` and a full `Alert` schema:
`headerText`, `descriptionText`, `cause`, `effect`, `severityLevel`,
`effectPeriod`, `url`, `image`. Per-departure `cancelled` and `tripCancelled`
flags are always present.

Coverage remains the open question. The first probe at Hannover Hbf returned 41
departures, 7 delayed and **0 alerts**; a repeat with `withAlerts=true` returned
0 alerts again. Two samples are not evidence of absence, but nothing so far
suggests German feeds populate alerts densely. Worth observing over a few days
before designing UI around it.

**Physical infrastructure state** is not live data at all — it is in OSM, and our
own pipeline can render it: `railway=construction`, `railway=proposed`,
`railway=disused`, `railway=abandoned`. Drawing those as dashed or greyed lines
needs only an extract change, no API.

**Resolved, and not this way.** Neither of the above is what a rider means by
"is the line shut this weekend". OSM's `railway=construction` describes the state
of the asset — a line rebuilt over one weekend is `railway=rail` before and
after — and a GTFS-RT alert is per *service*, so it cannot say which section is
closed. The answer turned out to be DB InfraGO's own possession register at
strecken.info, read at build time and drawn on the track it closes; see
[`closures.md`](closures.md), which also records why the alerts route was
dropped. Alerts remain worth revisiting for *unplanned* disruption, which is a
different question and a different endpoint.

## 4. Suggested build order

0. **Station → MOTIS stop id in the pipeline.** Nothing else works without it, and
   it is build-time work with no runtime cost.
1. **Departures on station click** — one cheap call, immediate payoff.
2. ~~**Construction/disused lines from OSM**~~ — done differently and better:
   construction possessions from DB InfraGO, in the pipeline, no runtime cost
   ([`closures.md`](closures.md)).
3. **Moving trains** — highest impact, highest care; zoom-gated and throttled,
   after checking in with Transitous.
4. **Alerts** — once there is evidence the feeds actually carry them.

## 5. Terms, and what a browser can and cannot honour

Transitous is free for open-source, non-commercial use, requires a descriptive
`User-Agent` with contact details, requires visible attribution, and asks to be
contacted before heavy use.

Three of those four a static browser app can honour outright. The `User-Agent`
one it cannot: the header is on the Fetch spec's forbidden list, so a page cannot
set it, and requests arrive carrying the browser's own string. What the browser
*does* send unbidden is `Origin` (and `Referer`), which names the deployment
precisely — measured: `Origin: https://jnslmk.github.io` is accepted and the
response carries `access-control-allow-origin: *`, so cross-origin calls straight
from the page work.

Whether Origin-based identification is acceptable to Transitous in place of a
`User-Agent` is a question to put to them, and it is the only compliance question
that separates the two deployment shapes below.

## 6. Client-side, or a small server?

Live data is a runtime feature, and this project has no runtime: the deploy
artifact is static files on GitHub Pages, rebuilt nightly by `build.yml`.
Introducing a server is therefore not a refactor, it is a new category of thing —
uptime, a host, a deploy path, a second failure domain. The question deserves an
answer before any live code is written, because it decides where that code lives.

**The usual reason to proxy does not apply.** Transitous needs no API key, so
there is no secret to hide. That removes the single strongest argument for a
backend before the comparison starts.

**What the browser can do unaided.** CORS is `*`, so `/stoptimes`,
`/map/trips`, `/geocode` and the routing endpoints are all directly reachable.
Departures are one ~12 KB request per popup — a rounding error at any plausible
traffic. The trips poll is 410 KB gzipped per viewer per minute, zoom-gated and
mode-filtered, paused on a hidden tab. For a personal open-source map with
single-digit concurrent viewers, that is a few hundred KB a minute against a
service sized for a community of such apps.

**What a server would buy.**

- *Compliance.* It can send the exact `User-Agent` Transitous asks for. A browser
  cannot. This is the one genuine advantage, and it is worth exactly as much as
  their answer to the question in §5.
- *Coalescing.* One upstream poll per bbox per minute serves every viewer looking
  at the same city, instead of one per viewer. This matters only once concurrent
  viewers are plural — precisely the point at which Transitous asks to be
  contacted anyway.
- *Access to sources a browser cannot use.* The DB API Marketplace products need
  a key; the gtfs.de GTFS-RT stream is a 46 MB protobuf updated every 10 s and
  has to be decoded somewhere. Both are fallbacks, not the plan.

**What it would cost.** A service to keep alive for a map that is currently
indestructible — static files behind a CDN. If Transitous is down today, the map
loses departures; with a proxy in front, the map can lose departures *or* the
proxy can be down. It also splits local development, which today is `npm run dev`
and nothing else, and complicates `e2e/`, which drives a real browser against a
real deployment on the assumption that the deployment is one artifact.

**Decision: build it client-side.** The two arguments for a server are a
compliance question that has not been asked yet, and a scaling problem this
project does not have. Neither justifies standing up infrastructure now, and
neither is hard to retrofit later — a proxy that only adds a header and a cache
is a URL change in one module, provided every live call goes through a single
`LiveProvider` seam rather than being sprinkled through the UI. Build that seam;
it is the whole cost of keeping the option open.

Revisit the moment any of these fires:

- Transitous answers that `Origin` is not acceptable identification, or asks the
  map to reduce load.
- Concurrent viewers make the trips poll material rather than theoretical.
- A feature needs a keyed source or server-side feed decoding.

If that day comes, the cheapest adequate shape is an edge function (Cloudflare
Workers, Deno Deploy) that attaches the `User-Agent` and caches responses for
30–60 s. Stateless, free-tier, no database — a header and a cache, not a backend.

The one piece that is *not* runtime, and should be done on the server side
regardless, is the station → stop id mapping: it belongs in the nightly pipeline,
where a server already exists in the form of CI.

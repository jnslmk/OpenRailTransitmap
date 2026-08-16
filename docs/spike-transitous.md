# Spike: Transitous / MOTIS for the bike + train planner

Run before writing any routing code, because the result could have invalidated
the chosen backend. It did not — but it changed one design decision.

## What was tested

`https://api.transitous.org/api/` — a community-run [MOTIS](https://github.com/motis-project/motis)
instance over Germany's open GTFS. No API key.

All of `/api/v1` … `/api/v6` respond, so the version can be pinned; `v1` was used
for these probes.

## Result 1 — long bike legs work (the open risk is closed)

The plan flagged `street_routing_max_prepost_transit_seconds` as the one unknown
that could force self-hosting: if the server capped pre/post-transit street legs
below ~60 min, the "1 hour train, 1 hour bike" use case would be impossible.

Probing a rural origin/destination pair with `preTransitModes=BIKE`:

| `maxPreTransitTime` | reachable stops from origin | longest bike leg returned |
|---|---|---|
| 1800 s | 88 | 27 min |
| 3600 s | 1321 | 52 min |
| 7200 s | 3739 | 52 min |
| 10800 s | 3739 | 52 min |

Reachable stops keep growing well past 3600 s and then plateau because the
search has found everything in range, not because a cap kicked in. **Hour-long
bike legs are fine on the public instance. No self-hosted MOTIS needed.**

A representative result — exactly the shape of journey the feature is for:

```
BIKE 52 min → RE3 22 min → WALK 5 min → RE2 22 min → BIKE 47 min
```

## Result 2 — `requireBikeTransport=true` cannot be the default

MOTIS exposes `requireBikeTransport`: *"all used transit trips are required to
allow bike carriage"*. That maps perfectly onto "own bike, taken on the train",
which is the chosen bike mode. In practice the underlying GTFS rarely carries
`bikes_allowed`, and a missing value is treated as "not allowed":

| Journey | `requireBikeTransport=true` | `=false` |
|---|---|---|
| Hannover → Bremen | **0 itineraries** | 3 |
| München → Stuttgart | **0 itineraries** | 3 |
| Hamburg → Berlin | 3 | 3 |

Only some feeds populate the field. Using it as a hard filter silently erases
regional journeys — precisely the network this map is about.

**Design decision:** expose bike carriage as a toggle that is **off by default**,
and approximate carriage plausibility from the mode instead (regional and
S-Bahn services generally accept bikes; ICE generally requires a reservation and
often refuses them). The UI must say that this is an approximation rather than a
guarantee, and link out to the operator for the real rule.

## Usage terms to honour

From the Transitous API documentation:

- No API key, but **free and open-source projects only** — no commercial use.
- Requests must send a descriptive `User-Agent` with application name, version
  and contact details.
- Data sources must be attributed visibly, including OpenStreetMap attribution.
- Routing is explicitly called out as resource-intensive; they ask to be
  contacted before sending many requests.

So the planner must debounce input, cache results client-side, and identify
itself. A staging instance exists at `https://staging.api.transitous.org/api/`.

## Parameters the planner will use

| Parameter | Purpose |
|---|---|
| `preTransitModes=BIKE`, `postTransitModes=BIKE` | cycle to and from the station |
| `maxPreTransitTime`, `maxPostTransitTime` | **the bike/train split slider** |
| `requireBikeTransport` | optional bike-carriage filter (default off, see above) |
| `cyclingSpeed`, `elevationCosts` | rider profile |
| `/api/v1/geocode`, `/api/v1/reverse-geocode` | origin/destination autocomplete |

Geocoding returns DELFI stop ids (e.g. `de-DELFI_de:03355:8000238`) alongside
`lat`/`lon`, `modes` and admin areas — enough to match map stations, which is
why the pipeline preserves `uic_ref` and `ref:IFOPT`.

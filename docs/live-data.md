# Live data: departures, moving trains, disruptions

Feasibility probes against the public Transitous MOTIS instance
(`https://api.transitous.org/api/`). All three requested features are supported;
the constraint is request volume, not capability.

## 1. Departures and delays — `/api/v1/stoptimes`

Works today. One call per station id returns the next *n* departures with both
scheduled and real-time values, so the delay is `departure - scheduledDeparture`.

Live sample, Hannover Hbf (`de-DELFI_de:03241:31`), 41 departures requested:

```
S5       -> Hameln                     sched 17:25  real 17:25  rt=true
ICE 885  -> München Hbf                sched 17:27  real 17:27  rt=true
...
41 departures | 7 delayed | 0 cancelled
```

Each entry carries `realTime`, `cancelled`, `tripCancelled`, `routeShortName`,
`headsign`, `scheduledTrack`/`track`. ~12 KB for 6 departures.

**Fit:** one request when a station popup opens. Negligible load. This is the
cheapest of the three and should be built first.

**Prerequisite:** station popups currently key off OSM. Matching a map station to
a MOTIS stop id needs either the preserved `uic_ref`/`ref:IFOPT`, or a
`/api/v1/geocode` lookup by name. The pipeline already keeps both ids.

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
| `trips[].routeShortName` | the line badge, e.g. `ICE 885` |

So position is interpolated client-side along the polyline between the two
timestamps, and a poll is only needed every minute or so to pick up new trips and
delay changes — the animation itself is local. That is what makes this viable at
all.

**Measured cost:** a Hannover-area bbox at z12 returned **500 segments / 1.1 MB**
for a 3-minute window — about 2.2 KB per segment. Mode mix was mostly `BUS` (257)
and `SUBWAY` (172), so filtering to rail modes cuts it substantially.

**This is the one with a real constraint.** 1.1 MB per poll for one city does not
scale to a national viewport, and Transitous explicitly asks to be contacted
before sending many requests or using resource-intensive endpoints. Mitigations,
in order of importance:

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

Coverage is the open question — a sample at Hannover Hbf returned 41 departures,
7 delayed, and **0 alerts**, so German feeds may populate alerts sparsely. Worth
observing over a few days before designing UI around it, rather than assuming
either way.

**Physical infrastructure state** is not live data at all — it is in OSM, and our
own pipeline can render it: `railway=construction`, `railway=proposed`,
`railway=disused`, `railway=abandoned`. Drawing those as dashed or greyed lines
needs only an extract change, no API. That covers "this line is being rebuilt"
much better than a real-time feed does, and it costs nothing at runtime.

## Suggested build order

1. **Departures on station click** — one cheap call, immediate payoff.
2. **Construction/disused lines from OSM** — pipeline-only, no runtime cost.
3. **Moving trains** — highest impact, highest care; zoom-gated and throttled,
   after checking in with Transitous.
4. **Alerts** — once there is evidence the feeds actually carry them.

## Terms

Transitous is free for open-source, non-commercial use, requires a descriptive
`User-Agent` with contact details, requires visible attribution, and asks to be
contacted before heavy use. Any live feature must honour all four.

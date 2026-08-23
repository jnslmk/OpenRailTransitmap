# Buses, and a journey planner with a bike in it

Brainstorm for Phase 4. Everything below marked *measured* was measured on
2026-08-23 against the public Transitous MOTIS instance and the Overpass API.

The short version: **"buses on the map" and "buses in the planner" are two
different features with two different data sources, two different costs, and
they should not be built together.** The planner already has buses — it needs no
pipeline change at all. Drawing buses is a twentyfold increase in the size of the
map's subject matter and deserves its own decision, taken later, with evidence
this project does not yet have.

---

## 1. What is actually there

### 1.1 The planner has buses today

A single probe, no code written, no data built:

```
GET /api/v1/plan
    fromPlace=52.7550,9.3830        # a village near Rethem (Aller)
    toPlace=52.3759,9.7320          # Hannover Hbf
    preTransitModes=BIKE  postTransitModes=BIKE
    maxPreTransitTime=2400  maxPostTransitTime=1200
```

returned three itineraries, every one of them exactly the shape Phase 4 is for:

```
102 min  BIKE 19 → BUS 510 24 → WALK 5 → RB38 49 → BIKE 4
111 min  BIKE 19 → BUS 765 24 → WALK 5 → RE8  53 → BIKE 4
130 min  BIKE 28 → BUS 35  26 → WALK 2 → BUS 32 3 → WALK 5 → RE1 45 → BIKE 4
```

Those bus legs come from the DELFI GTFS aggregate that Transitous already
merges. Local buses, rural connector buses, the works. **The bus half of the ask
is free.** Nothing in `pipeline/` has to change for a rider to be routed onto
the 510 out of Rethem.

Each transit leg carries, measured:

| Field | Why it matters here |
|---|---|
| `routeShortName`, `routeLongName`, `headsign` | the badge and the direction, ready to render |
| `bikesAllowed` | per-leg bike carriage — see §4 |
| `reservation` | Rufbus / AST / on-demand, which rural Germany runs on |
| `wheelchairAccessible` | accessibility filter, for free |
| `intermediateStops[]` | the expandable stop list, without a second call |
| `legGeometry` | encoded polyline, `precision: 7` — the line to draw |
| `routeUrl`, `agencyFareUrl`, `agencyName` | where to send someone for the real rule |
| `realTime`, `cancelled`, `scheduledStartTime` | live delay on the itinerary |

Response size, measured: **140 KB for three itineraries** with geometry and
intermediate stops. That is the number that governs caching (§6).

`/api/v1/geocode` also resolves POIs, not just stops — measured, `Herrenhäuser
Gärten` returns the tram stop *and* the park itself as `type=PLACE` with OSM
ids. So origin and destination are not limited to the 20,830 stations in the
tiles, which is what "like Google Maps" requires.

### 1.2 Drawing buses is a different animal

Measured over the Niedersachsen bounding box (`6.35,51.29 – 11.60,54.20`),
which is the development region:

| | relations |
|---|---|
| `route=bus` | **16,462** |
| `route=train\|tram\|subway\|light_rail` | 878 |

**Eighteen buses for every rail line.** Nationally the ratio is worse, because
the NDS box is disproportionately rural: the Germany-wide `route=bus` count
could not be taken at all — Overpass ran out of its 2 GB budget trying. A query
the public API cannot even count is a fair warning about what the pipeline would
be asked to stitch.

Stops are worse still. `highway=bus_stop` nodes in the same box: **129,506**,
against 20,830 rail stations *nationally*. Bus stops are roughly a 30× increase
in point features, and unlike stations they are one per direction, unnamed as
often as not, and clustered ten to a village.

And the geometry is the real cost, not the counts. `extract.sh` pass 2 filters
`w/railway=rail,light_rail,subway,…`, which is a small, well-behaved tag class.
Bus routes run on `highway=*`, the largest tag class in the extract by a wide
margin, and the two-pass stitch in `build.ts` would have to hold all of it.

Two smaller families are the opposite — cheap enough to draw tomorrow:

| | relations, Germany |
|---|---|
| `route=trolleybus` | 218 (Solingen, Esslingen, Eberswalde) |
| `route=share_taxi` | 129 |
| `route=coach` | **2** |

`route=coach` being 2 nationally is worth sitting with: **Fernbus is not in OSM.**
FlixBus exists in Transitous — `pipeline/stop-ids.test.ts` already has
`eu-flixbus_…` stop ids in its fixtures — so long-distance coach cannot come out
of the extract.

> **Superseded, and built.** This section originally concluded that coach was
> therefore "a *routing* feature and a *departures* feature, never a tiles
> feature". That was wrong, and only because it looked no further than OSM and
> MOTIS. The operator publishes its own GTFS, `shapes.txt` and all — 2.8 M
> points over 3,586 shapes, median 618 points a shape, which is real road
> alignment rather than a chord between stops. `pipeline/coach.ts` reads it and
> `build.ts` merges the result into the same tile layers as the rail network, so
> coach is drawn, selectable, searchable and in the legend like any other mode.
> See §10.

### 1.3 "Globus"

Measured: **zero** route or route_master relations in Central Europe
(45–56 N, 4–17 E) carry `network`, `operator` or `ref` matching `globus`, case
insensitive. Every hit for the string is a **stop name** — the hypermarket
chain — on ordinary local lines:

```
VRM     Bus 7   Koblenz Hbf ⇄ Globus
VMT     Bus 16  Jena Busbahnhof ⇄ Isserstedt Globus
RGTR    401     Luxexpo ⇄ Losheim, Globus Baumarkt
IDOL    Bus 14  Liberec, Fügnerova ⇄ Globus
```

So there is no "Globus network" to add. **This is an open question — see §8.**
The reading the rest of this document assumes is that "lines like Globus" means
*ordinary local and regional bus lines, including the out-of-town ones that
serve a shopping centre or a works gate* — the services that make a rural
station reachable. That is precisely what §1.1 shows already works in the
planner, and what §5 proposes to draw.

---

## 2. The decision that falls out of §1

**Build the planner first, entirely, with buses in it, and change nothing in the
pipeline.** Then decide what to draw, using what people actually plan with.

This is not a scheduling convenience. Section 5 has to answer "which buses go on
the map", and there is no good way to answer it from tags. Three months of a
working planner answers it from behaviour instead: the lines that keep turning up
in itineraries are the lines worth drawing. Building the map layer first means
guessing, and guessing wrong costs a 20× tile budget.

---

## 3. The planner

### 3.1 The seam

`src/live.ts` exists because `docs/live-data.md` §6 decided every live call goes
through one module, so a future proxy is a one-line change. The planner gets the
same treatment: **`src/routing.ts`, exporting a `RoutingProvider`**, sharing
`live.ts`'s `request()`, `LiveDataError` and `BASE_URL`. Nothing in `ui.ts` calls
Transitous.

```ts
export interface RoutingProvider {
  geocode(text: string, signal: AbortSignal): Promise<Place[]>;
  reverseGeocode(lonLat: [number, number], signal: AbortSignal): Promise<Place | null>;
  plan(query: PlanQuery, signal: AbortSignal): Promise<PlanResult>;
}

export interface PlanQuery {
  from: Place; to: Place;
  time: Date; arriveBy: boolean;
  transitModes: Set<TransitMode>;     // rail tiers + BUS + coach
  bike: BikeProfile;
  pageCursor?: string;                // "Earlier" / "Later"
}
```

`PlanResult` carries `itineraries`, `direct` (the bike-the-whole-way option,
measured working via `directModes=BIKE`) and the two page cursors, which are
measured present on every response and are exactly Google's *Earlier / Later*
buttons.

### 3.2 Request parameters

| MOTIS parameter | Bound to |
|---|---|
| `fromPlace` / `toPlace` | the two search fields, `lat,lon` or a stop id |
| `time` + `arriveBy` | the *Leave now / Depart at / Arrive by* control |
| `transitModes` | the mode chips, seeded from the map's current `modes` filter |
| `preTransitModes` / `postTransitModes` | `WALK`, `BIKE`, or `RENTAL` |
| `maxPreTransitTime` / `maxPostTransitTime` | **the bike/train split slider** |
| `requireBikeTransport` | the carriage toggle, off by default (§4) |
| `cyclingSpeed`, `elevationCosts` | the rider profile |
| `pageCursor` | Earlier / Later |
| `numItineraries` | 5 |

### 3.3 What the map already gives it

Four things exist and should be reused rather than rebuilt:

- **the search field** in the sidebar becomes the geocoder, keeping its current
  station-index behaviour as the instant local tier above the network results;
- **the station popup** grows *Directions from here / to here*, which is how
  Google seeds a journey and how this map turns a departure board into a plan;
- **`data/lines.json`** already holds the colour of every rail line, so a
  `REGIONAL_RAIL RE8` leg can be painted in RE8's own colour rather than a
  generic transit blue (§5.3);
- **the street underlay** already fades in from z13, which the planner needs the
  moment it draws a bus or a bike leg on a road that is not in the rail tiles.

---

## 4. The bike, which is the whole point

Google Maps has a transit planner. It does not have *this*. The bike is the
reason to build it, so it should not be a checkbox in a corner.

There are **three different things** a rider means by "with my bike", and they
map onto three different sets of MOTIS parameters:

| | What it is | MOTIS |
|---|---|---|
| **Ride to the station** | cycle, park, take the train, walk the far end | `preTransitModes=BIKE`, `postTransitModes=WALK` |
| **Take it with you** | the bike goes on the train | `requireBikeTransport`, plus `bikesAllowed` per leg |
| **Hire one there** | train, then a rental bike at the far end | `postTransitModes=RENTAL` |

The default should be **ride to the station at both ends** — that is the "cycle
an hour, take the train an hour" journey in the README, and it is the one the
spike proved works: measured in `spike-transitous.md`, a 3600 s pre-transit
budget reaches 1,321 stops and returns 52-minute bike legs.

**The slider is the feature.** One control, labelled by what it does rather than
by its parameter: *how far are you willing to ride?* — 10 min · 30 min · 1 h ·
1 h 30. It writes `maxPreTransitTime` and `maxPostTransitTime`. Dragging it right
is the difference between "the station near me" and "any station in the county",
and it is the single interaction that makes this map's planner not a worse
Google Maps.

**Carriage stays off by default and stays honest.** The spike measured that
`requireBikeTransport=true` returns *zero* itineraries for Hannover → Bremen and
München → Stuttgart, because German feeds mostly omit `bikes_allowed` and MOTIS
reads absent as forbidden. So: leave it off, read the per-leg `bikesAllowed`
that comes back anyway, and render it as one of three honest states —

- `bikesAllowed: true` → "bikes carried"
- `bikesAllowed: false` on an ICE → "reservation required, often refused"
- absent → "the operator does not publish this", linked to `routeUrl`

— never as a green tick the feed cannot support. A planner that silently drops
every regional journey, or silently promises a bike space that is not there, is
worse than one that says it does not know.

**Elevation is not a nicety here.** `elevationCosts` exists, and a bike planner
covering the Harz, the Sauerland and the Schwäbische Alb that routes as if
Germany were flat will produce hour-long legs nobody can ride. Worth a probe
before the profile UI is designed.

---

## 5. Buses on the map, when the time comes

Four options, in increasing cost.

**A — never.** The planner uses them, the map does not draw them. Defensible: the
reference document is a *Streckenfahrplan*, a rail schematic, and a national bus
layer is a different map wearing this one's clothes. Zero cost, and it is the
honest baseline every other option has to beat.

**B — the small families only.** `trolleybus` (218) and `share_taxi` (129), plus
whatever `route=bus` carries a Verkehrsverbund express marker. Fits the existing
pipeline unchanged in shape, adds two `Mode` values, costs almost nothing. The
problem is "whatever carries an express marker": the discriminators available in
tags — `ref` starting `X`/`S`/`M`/`N`, `name` containing *Schnellbus* or
*Expressbus* — are inconsistent between Verbünde, and a tier defined by a tag
heuristic will be wrong in a way nobody can explain.

**C — all of it from OSM.** 16k relations in one state, `highway=*` in pass 2,
bus stops at 30× the station count. Zoom-gate to z12+ and it is *renderable*, but
the pipeline cost is the issue, not the tiles: the extraction is the 6m30s step
already, and this is the tag class that would make it the whole build.

**D — all of it from GTFS, not OSM.** The one worth thinking hardest about. The
DELFI national GTFS aggregate — the same data Transitous routes on — has
`shapes.txt`, so bus geometry arrives already drawn, already matched to a `ref`,
a colour and an operator, with no way stitching and no `highway` extraction at
all. And it carries `trips.txt`, which means **"significant" stops being a
judgement call and becomes a measurement**: trips per weekday per line. Draw
everything above a threshold and let the threshold be a documented number.

D also fixes an inconsistency that A–C all have: with OSM geometry the map draws
one network and the planner routes on another, and they disagree about which
lines exist. With D they are the same data.

Its costs are real — a second pipeline stage on a multi-gigabyte feed, GTFS
shapes that are sometimes missing or crude, and a licence to honour (DELFI, CC BY
4.0, which this project is already set up to credit properly). But it is the only
option that answers "which buses" with a number.

### 5.1 What it does to `Mode`

Adding modes is cheap by construction: `MODES` and `MODE_SPECS` in
`shared/lnvg.ts` already drive the legend, the URL state, the tile minzooms, the
line weights and the strings. A bus tier is a row in that table plus a string.

```ts
bus:        { weightPt: 1.68, minzoom: 12, defaultColour: LNVG.grey,   order: 5 }
busexpress: { weightPt: 2.24, minzoom: 10, defaultColour: LNVG.yellow, order: 8 }
```

Below tram in weight and in draw order, because on this map rail is the subject
and bus is the connection to it.

### 5.2 Bundling

The corridor-bundling trick — routes sharing OSM ways get a perpendicular offset
ordinal, no geometric matching — is *more* valuable for buses than for rail (a
city-centre street can carry twenty lines) and does not survive option D, where
there are no shared way ids, only independent GTFS shapes. If D wins, bundling
buses means real geometric matching for the first time in this pipeline. That is
a genuine new problem and belongs in its own document, not in a bullet.

### 5.3 The itinerary on the map

This is where the map earns the planner rather than the other way round. MOTIS
returns a `precision: 7` polyline per leg; decoded into one GeoJSON source, the
selected itinerary draws as:

- **transit legs in the line's own colour**, looked up in `data/lines.json` by
  `mode|network|ref` — the RE8 leg is RE8-coloured, matching the band the map
  already draws underneath it;
- **bike legs as a dashed casing** in the accent colour, walk legs finer and
  dotted;
- **the rest of the network dimmed**, the way clicking a line already dims it;
- **interchange dots** at leg boundaries, reusing the existing station symbology.

Google draws a generic blue snake. Drawing the itinerary in the map's own visual
language is the thing only this map can do, and it costs one source and four
layers.

---

## 6. Load, and the terms

Transitous singles routing out as resource-intensive and asks to be contacted
before heavy use. At 140 KB per plan response, the mitigations are:

1. **Never plan on keystroke.** Geocode is debounced at ~400 ms; `plan` fires on
   submit, on a slider release, and on Earlier/Later — never on pan or zoom.
2. **Cache client-side** on the rounded query (from, to, time to the quarter
   hour, modes, bike profile). Sliding the split back and forth is then free.
3. **Reuse the `live.ts` seam** so a caching edge function stays a one-line
   change, per the standing decision in `docs/live-data.md` §6.
4. **Ask them first.** This is a gating action, not a courtesy: the map already
   plans to send them departures and possibly a trips poll, and routing is the
   endpoint they name. It should go in the same message.

Attribution is already handled the way this project handles attribution —
sidebar plus the map's own attribution control, shown when the feature is in use.
Transitous, OpenStreetMap, and DELFI if option D happens.

---

## 7. UI: what "like Google Maps" should and should not mean

### 7.1 Copy this

The two-field origin/destination with a swap button; *Leave now / Depart at /
Arrive by*; a ranked list of itineraries where each row is a duration, a
departure–arrival span and a **strip of mode badges** you can read in one glance;
tap a row to expand the step list; Earlier / Later at the ends.

### 7.2 Do not copy this

Google's planner **takes over the screen**. Here the network *is* the product —
the whole map exists to show what runs where. So the planner is a **mode of the
existing sidebar**, not a new page: a two-tab header, *Explore* and *Plan*, with
the map underneath continuous and never replaced. Planning stays inside the map
rather than covering it.

The mobile half is already built. The sidebar is a bottom sheet that folds to its
handle by tap or drag (`?ui=peek`), which *is* the Google Maps mobile pattern.
The planner inherits it for nothing: results in the sheet, drag it down, see the
route on the map, drag it back.

### 7.3 Sketch

```
┌─ sidebar ──────────────────┐   ┌─ sidebar, results ─────────┐
│  Explore │ ▸Plan◂          │   │  Explore │ ▸Plan◂          │
├────────────────────────────┤   ├────────────────────────────┤
│ ◉ Rethem (Aller)      [⇅]  │   │ ‹ Rethem → Hannover Hbf    │
│ ◎ Hannover Hbf             │   ├────────────────────────────┤
├────────────────────────────┤   │            ‹ Earlier       │
│ Leave now ▾   23 Aug 14:20 │   ├────────────────────────────┤
├────────────────────────────┤   │ 1h42  14:31 → 16:13   1 ⇄  │
│ 🚆 🚇 🚊 🚌  all on         │   │ 🚲19 ▬ 510 ▬ 🚶 ▬ RB38 ▬🚲4│
├────────────────────────────┤   │ 🚲 38 min riding           │
│ Bike                       │   ├────────────────────────────┤
│  how far will you ride?    │   │ 1h51  14:31 → 16:22   1 ⇄  │
│  ├──────●─────────┤  30min │   │ 🚲19 ▬ 765 ▬ 🚶 ▬ RE8 ▬ 🚲4│
│  □ bring it on the train   │   │ ⚠ bike carriage unpublished│
│    ⓘ feeds rarely say      │   ├────────────────────────────┤
├────────────────────────────┤   │ 2h10  🚲 the whole way     │
│         [ Find routes ]    │   ├────────────────────────────┤
└────────────────────────────┘   │            Later ›         │
                                 └────────────────────────────┘
```

Expanded itinerary: the leg list with times, platforms from `scheduledTrack`,
`intermediateStops` collapsed behind "11 stops", the `bikesAllowed` state per
transit leg, `reservation` flagged where the bus must be booked, and delay shown
against `scheduledStartTime` — all of it already in the response.

### 7.4 State and deep links

`src/state.ts` is already the pattern: everything in the URL, `replaceState`, no
history spam. The planner adds `?from=`, `?to=`, `?at=`, `?arriveBy=1`,
`?bike=30` and `?itin=2`, so a plan is as linkable as a line is today — including
the selected itinerary, which is what makes it shareable.

---

## 8. Open questions

1. **"Globus".** Measured to be a stop name, not a network (§1.3). Three
   readings, and which one is meant changes §5:
   *(a)* ordinary local/regional bus, out-of-town destinations included — this
   document's assumption, needs nothing extra;
   *(b)* long-distance coach / FlixBus — MOTIS-only, since OSM has 2 coach
   relations nationally;
   *(c)* a specific network under a name that is not in OSM under that name.
2. **Where does the bus tier line get drawn** — and is it a tag heuristic (B) or
   a trips-per-day threshold from GTFS (D)?
3. **Has Transitous been contacted?** Gating for anything in §3.
4. **`elevationCosts`** — unprobed, and it decides whether the bike profile has
   one control or three.
5. **On-demand.** `reservation` comes back on legs, and rural Germany runs on
   Rufbus and AST. Is an unbookable itinerary a result or a trap?

## 9. Suggested order

| | | Cost |
|---|---|---|
| **4a** | `RoutingProvider` seam, Plan tab, bike split slider, itineraries as a list. Rail *and* bus, from MOTIS. | No pipeline change |
| **4b** | The itinerary drawn on the map in the map's own language (§5.3), station popup → *Directions*, deep links | No pipeline change |
| **4c** | Buses on the map, tier chosen with 4a's usage as evidence, probably via GTFS (§5, option D) | A new pipeline stage |

4a and 4b together are the whole user-visible feature. 4c is a separate map.

**Done since:** long-distance coach (§10) and the routing seam. Local bus on the
map — the 16,462-relations-per-state problem — is still 4c, and still waiting on
the evidence 4a is there to produce.

## 10. What was built: long-distance coach

Option D of §5, scoped to Fernbus, which is the part of it small enough to be
certain about: **347 lines and 337 stops nationally**, against the 16,462
`route=bus` relations in one state that make the local layer a separate decision.

`pipeline/coach.ts` reads FlixBus's own GTFS — a 32 MB zip, cached 12 hours,
parsed with a ~70-line ZIP reader rather than a new dependency — and writes a
snapshot in the shape `closures.ts` established. `build.ts` reads that snapshot
and merges coach into `routes.geojsonl`, `stations.geojsonl` and
`data/lines.json`, which is what buys selection, search, the legend, the mode
filter, the line panel and deep links without a line of new UI code.

Five decisions worth recording:

- **Not MOTIS.** `/api/v1/map/trips` does return road-routed coach polylines
  (measured: 588 COACH segments in one national z6 call), but coverage is
  whatever happens to be running in the window — 285 distinct routes in ten
  minutes, 312 in sixty — so full coverage costs several multi-megabyte calls a
  night against the endpoint Transitous names as resource-intensive, for data
  that does not change nightly. The GTFS is complete, cheaper and better
  described.
- **The whole feed, then clipped — per segment, not per point.** A European
  coach network is not pre-clipped the way an osmium extract is. Point-wise
  clipping drew a **627 km spike** out of the region on the Kyiv and Bucharest
  services, whose shapes stride that far between points once they leave the EU
  core, and it silently dropped any line crossing the region without a point
  inside it. Liang-Barsky against the region box fixes both.
- **FlixTrain is excluded by agency id.** FlixMobility ships FlixBus and
  FlixTrain in one file; FlixTrain is rail, already on this map from OSM under
  its FLX refs, and letting it through would draw those three lines twice.
- **Coach stops attach to a rail station within 400 m.** "Dresden Hbf" and
  "Dresden central station (Bayrische Straße)" are one place, and two dots say
  they are not. The 334 that are genuinely their own — ZOBs, airport forecourts,
  motorway services — get a lighter symbol held back to z8, because a bus bay
  drawn like a Hauptbahnhof at national zoom misdescribes the network.
- **No bundling, deliberately.** GTFS shapes share no way ids, so the trick that
  makes rail corridors legible is unavailable and coach lines down the same
  autobahn stack. It costs little: the feed gives every route one brand colour,
  so a stack reads as one green trunk, which is what it is. §5.2 stays open.

The feed carries no licence, and Transitous — which records `ODbL-1.0` for
BlaBlaCar and `CC0-1.0` for Optima — records none for it either. That is the same
footing as DB InfraGO's possession register, so it gets the same treatment: never
committed, only the rendering ships, FlixMobility credited in the sidebar and in
the map's attribution control whenever a coach line is in view. **This is a
judgement call rather than a settled licence question** — if it needs revisiting,
BlaBlaCar's feed *is* ODbL and `COACH_SOURCES` takes a second entry.

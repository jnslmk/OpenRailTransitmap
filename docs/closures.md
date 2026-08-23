# Construction closures

What is shut on the German rail network today, drawn on the track it shuts, and
an archive of how the plan for it changed.

Measured 22 August 2026 unless stated otherwise.

## Picking a source

Four candidates, and only one of them is actually about closures.

| Source | What it has | Why not |
|---|---|---|
| OSM `railway=construction` / `disused` / `abandoned` | Track being built or lifted | Describes the *state of the asset*, not a possession. A line rebuilt over one weekend is `railway=rail` before and after, and nothing in OSM says it was shut on Saturday. It is also a description of the world at extract time, so it cannot say *when*. |
| GTFS-RT service alerts via Transitous | Cancellations and prose alerts per trip | Coverage is the problem. Two probes at Hannover Hbf returned 41 departures and **zero** alerts (`docs/live-data.md` §3). And an alert is per *service*: it says the RE60 is cancelled, not that the line between Wunstorf and Minden is shut, so a map cannot draw it. |
| DB API Marketplace (Timetables, StaDa) | Timetable deviations, station data | Keyed, and none of the products is a construction register. |
| **DB InfraGO strecken.info** | **The infrastructure manager's own possession plan** | **Chosen.** |

[strecken-info.de](https://strecken-info.de) is DB InfraGO's public map of
`Baustellen`, `Störungen` and `Streckenruhen` on its own network — the public
tier of the paid DB LiveMaps product, and the successor to the strecken.info
that ran on `db-livemaps.hafas.de` until mid-2024. It is the right source for
three reasons:

- It is the **infrastructure manager's** register, not an operator's. It covers
  the whole DB network including the freight-only lines this map does not draw
  services on, and it is the record the timetable deviations are derived *from*.
- Every record carries **both endpoints as coordinates** and the **VzG line
  number**, which is what makes a restriction drawable rather than merely
  readable.
- It is **forward-looking**. The feed's own horizon runs to
  `endeBauplanung=2027-12-11`, so a possession is in it months before it starts.

### What it costs, and what it is not

DB InfraGO publishes this as information, not as open data. There is no licence
grant: the disclaimer calls it "unverbindliche Information auf Basis der
Baubetriebsplanungsdatenbank", disclaims accuracy, and points at the INB. So the
map **credits DB InfraGO strecken.info wherever a closure is drawn** — in the
sidebar and in the map's own attribution control — and does not redistribute the
feed. What is committed here is the diff-level history described below, not a
copy of their database.

Their own known limitation is worth repeating because this map inherits the
shape of it: where a restriction spans several sections, "werden die
benachbarten Betriebsstellen per Luftlinie verbunden" — neighbouring operating
points are joined by a straight line. That is exactly what
`pipeline/lib/railpath.ts` exists to avoid.

## The API

Undocumented but stable and unauthenticated. Base `https://strecken-info.de/api`.

```
POST /api/baustellen      construction possessions   <- what this uses
POST /api/stoerungen      unplanned disruptions
POST /api/streckenruhen   hours a line is not staffed
wss://strecken-info.de/api/websocket
```

Only `baustellen` is read. `stoerungen` are incidents rather than construction
and belong with the live-data work in `docs/live-data.md`; `streckenruhen` are
signal-box opening hours, which are neither.

**Every read wants a `revision`** — the planning database's version counter —
and rejects one that is stale (`Angefragte Revision N zu alt`) or ahead
(`Revision N existiert noch nicht`). No endpoint serves it: the app subscribes
to the websocket and is pushed it. `fetchRevision()` does the same, takes the
first message, and closes the socket. The counter advances every few seconds as
trains report in, so the fetch retries once with a fresh one.

The request body:

```jsonc
{
  "revision": 3503909,
  "filter": {
    "baustellenAktiv": true, "streckenruhenAktiv": false, "stoerungenAktiv": false,
    "baustellenNurTotalsperrung": false, "wirkungsdauer": 0,
    "zeitraum": {                       // or {"type":"ROLLIEREND","stunden":2}
      "type": "FIX",
      "beginn": "2026-08-22T00:00:00", "ende": "2026-08-22T23:59:59",
      "wochentage": ["MONTAG", "…", "SONNTAG"]
    },
    "regionalbereiche": ["MITTE","NORD","OST","SUED","SUEDOST","SUEDWEST","WEST"],
    "streckennummern": [], "betriebsstellen": []
  }
}
```

Response size is entirely a function of the window, which is why there are two
of them:

| Window | Restrictions | Raw JSON |
|---|---|---|
| One day — what the map draws | 2,684 | 2.9 MB |
| 14 days — what the log reads | 13,340 | 12.5 MB |
| Whole horizon, to Dec 2027 | 75,897 | 62 MB |

**CORS is `access-control-allow-origin: https://strecken-info.de`.** A browser on
this site's origin cannot call the API at all, so unlike departures there was no
client-versus-server decision to make (`docs/live-data.md` §6): the only place
this data can be read is the build.

### The fields that matter

```jsonc
{
  "baustellenID": "1ACEC.2",              // stable id - what the log is keyed on
  "wirkung": "TOTALSPERRUNG",             // effect: see the table below
  "richtung": "BEIDE",                    // which track, by kilometrage
  "arbeiten": "Tunnelarbeiten",           // 54 known values, translated in closures.ts
  "streckennummern": [3600],              // VzG line number(s)
  "langnameVon": "Bebra Tunnel Üst", "ril100Von": "FBT   ",
  "langnameBis": "Cornberg",              "ril100Bis": "FCG   ",
  "koordinaten": { "von": {"x":1095159,"y":6625535}, "bis": {…} },  // EPSG:3857
  "zeitraum": { "beginn": "2026-08-13T00:00:00", "ende": "2026-12-12T04:00:00" },
  "gueltigkeiten": [ … ]                  // one entry per date, see below
}
```

`wirkung`, over a day's feed:

| `wirkung` | Ours | Share |
|---|---|---|
| `TOTALSPERRUNG` | `closed` | 19% |
| `GGL_MIT_ZS_6`, `GGL_MIT_ZS_8` | `single-track` | 10% |
| `ABWEICHUNG_VOM_FPL` | `diverted` | 26% |
| `FAHRZEITVERLAENGERUNG` | `slower` | 23% |
| `SONSTIGES` | `other` | 22% |

`gleisEinschraenkung` (`SCHWER`/`LEICHT`) is *not* read. It looks like a second
axis — DB's own judgement of how bad a restriction is — but over a day's feed it
is exactly `wirkung === 'TOTALSPERRUNG'`: 512 `SCHWER`, 512 full closures, no
other combination. Carrying it would add a column to the tiles, the log and the
panel that restates the effect already there.

`gueltigkeiten` is the one field that needs work rather than mapping. A
four-month nightly possession arrives as ~120 entries, one per date, each
carrying an all-days weekday mask that means nothing — a single date has one
weekday whatever the mask says. `compactWindows()` folds consecutive dates with
the same clock times back into ranges and derives the mask from the dates they
actually cover: the Cornberg tunnel possession above goes from 120 entries to
four, and a day's feed from 8,483 to 6,164. Two things it deliberately does not
do: it will not bridge a gap in the dates,
because a gap is a real fact about the possession, and it will not recompute a
mask the feed *did* state as a range ("weekends only"), because there the mask
is the restriction.

## Drawing it on the right track

DB gives two endpoints and a line number. 43% of a day's restrictions have both
endpoints at the same operating point — work inside one station — and are drawn
as a marker. The rest span a section: median 7.3 km, 90th percentile 20.3 km,
longest 125 km. A straight line between the ends of one of those is off
the railway entirely, which on a map whose whole claim is that its geometry is
true to OSM would read as a line that does not exist.

`pipeline/lib/railpath.ts` routes them instead. The extract already holds every
railway way in the country, so the ways become a graph, each end of the
restriction snaps to it, and the shortest path between them is the geometry.
Three details carry it:

- **Ways join wherever another way ends on them**, not only end to end. OSM
  convention is to split a way at a junction, but a branch or siding routinely
  ends on a node partway along an unsplit main line, and a graph that ignores
  those nodes leaves that main line as one edge with no way on or off it.
  Joining only at endpoints routed **30 of 107** matchable Niedersachsen
  closures; cutting each way where another way ends on it routed **98**.
- **Ways tagged with a different VzG number cost four times their length.** 52%
  of heavy-rail ways in the German extract carry `ref`, so a hard filter would
  lose the rest — but a penalty keeps the path on the stated line wherever the
  line is tagged. It changes the chosen route on 14% of closures. A way with
  *no* `ref` is not penalised: an untagged way is missing evidence, not evidence
  of being off the line.
- **Yard and siding track (`service=*`) costs four times its length too**, so a
  shortest path does not cut through a goods yard to save 200 m.

Over the national extract, on the feed for 22 August 2026:

| | |
|---|---|
| Heavy-rail ways read | 226,162 → 257,311 nodes, 287,815 edges |
| Graph build | 3.7 s |
| Sections routed | 1,495 of 1,533 (98%), 1.2 s, 0.8 ms each |
| Restrictions matched overall | 2,646 of 2,684 (99%) |
| Drawn path ÷ straight line | 1.07 median, 1.37 at p90 |
| Drawn end → stated operating point | 14 m median, 97 m at p90 |

The tail is worth looking at rather than smoothing away: 35 of 1,495 paths are
more than twice their chord, and the very worst — 2.5 km apart, 13.5 km of track
— is **Hornberg Schloßberg to Triberg Seelenwald on line 4250**, which is the
Schwarzwaldbahn climbing the valley wall in spirals. The router is right and the
chord would have been badly, confidently wrong. That case is the argument for
the whole approach.

A restriction whose ends cannot be matched to the network is **dropped, not
drawn as a chord**: 38 nationally. On a regional build it is most of the
country's feed, which is the same mechanism doing the same job.

## The history log

### Looking for a historical source

There isn't one. strecken.info serves the plan as it stands and nothing before
it — the API takes a date range but rejects one that has passed. DB's open-data
portal moved to Mobilithek and GovData in 2024 and publishes no construction
register at all, historical or current. The `piebro/deutsche-bahn-data` archive
this project already uses for punctuality records *departures*, not possessions.
The old `db-livemaps.hafas.de` API that
[Nakaner/bahnstoerungen](https://github.com/Nakaner/bahnstoerungen) documented
was shut down in mid-2024, and that project kept no archive either.

So the archive is one this repository keeps. `data/closure-log.jsonl` starts the
day the job first ran, and that limitation is stated on the panel rather than
hidden: a closure with nothing recorded says so.

### Shape

Append-only JSONL, one event per line, keyed on DB's own `baustellenID`:

```jsonc
{"t":"2026-08-22","e":"planned","id":"1A7FF.2","effect":"single-track", … }
{"t":"2026-09-02","e":"revised","id":"1A7FF.2","was":{"end":"2026-09-11T18:00:00"},
                                               "now":{"end":"2026-10-02T18:00:00"}}
{"t":"2026-09-14","e":"withdrawn","id":"1A7FF.2"}
```

An event stream rather than a daily snapshot, because a snapshot of 13,000
restrictions rewritten every night would add a gigabyte a year to a repository
whose point is that its data is diffable. Keyed on the restriction id rather
than on "what was shut today", because a possession that runs weekend nights for
four months is **one** entry in the plan, and logging it per weekend would say
nothing new 30 times.

`planned` carries everything the log keeps — which is the record minus its
validity windows. The windows are the shift pattern, DB restates them in full on
every reading, and keeping them would roughly triple the archive to record
something the current snapshot always has.

`revised` watches `effect`, `direction`, `works`, `begin` and `end`.
The date fields are the point: a possession being extended is the fact no
snapshot of the current plan can tell you, and the reason the log exists.

`withdrawn` is only ever emitted for a restriction whose recorded dates fall
inside the window that was actually queried. Without that rule the sliding
14-day window would report every restriction it moved past as cancelled, and
then reinstate it. A withdrawn restriction that comes back is a `revised`, not a
second `planned`.

Replaying the log gives, per restriction: the day it entered our record, the end
date it was first recorded with, how many times the plan has moved since, and
whether it is currently withdrawn. `pipeline/build.ts` folds the first three
into the tiles, so the panel can say "was to finish 12 Dec" with no runtime
fetch.

### Cost

The seed is 13,340 events, 4.6 MB (380 KB gzipped). After that only changes are
appended: roughly 150 new restrictions and a few dozen revisions a day, about
50 KB, which is what an append-only text file is good at storing in git.

## How it runs

```
.github/workflows/closures.yml   03:30 UTC  --log   -> data/closure-log.jsonl, committed
.github/workflows/build.yml      04:00 UTC          -> the map
```

Two jobs because they need different permissions and different windows. The log
job is the only thing in this repository that writes to the repository, and it
writes exactly one file; `build.yml` keeps `contents: read` and still cannot push
anything it computes. The log job reads a fortnight so it can see a plan change
before the possession starts; the build reads one day, because the map says what
is shut *now* and a week of lookahead drawn on the same lines would say something
else while looking identical.

The log job's push is normally what triggers the build, so the map is drawn from
the same reading of the plan the log just recorded. `build.yml`'s own 04:00
schedule stays as the fallback for a day on which nothing changed.

Locally:

```bash
npm run build:closures    # .work/build/closures.json, what the build draws
npm run log:closures      # append to data/closure-log.jsonl
```

Both need network. Neither is required: with no `.work/build/closures.json` the
build writes an empty closure layer, `tiles.sh` omits the layer entirely, and the
app draws no overlay and shows no construction credit.

## What the map does with it

- **Closed and single-track from zoom 6**, everything else from zoom 10. Two
  thousand minor restrictions drawn across Germany at national zoom would bury
  the network they annotate.
- **A hazard stripe**, dark under the reference palette's yellow, rather than
  another coloured band: every solid colour on this map already means a line of
  some kind, and a closure has to read as "not a service" at a glance.
- **On the true alignment**, so a closure sits in the middle of whatever bundle
  it interrupts — route bands are offset around the alignment, nothing else
  draws on it.
- **Above the routes, below the stations.** A station dot is the smallest thing
  on the map and has to stay clickable where a closure crosses it.
- One toggle, `?closures=0` in the URL. The *selection* is not in the URL,
  unlike a line: a possession is a fact about one day, and a link to
  "restriction 48EE0.3" would resolve to nothing by the time anyone opened it.

## Known limits

- **The overlay is a build-time reading, not live.** It describes the day the
  tiles were built, and the sidebar says which day that is. A possession lifted
  this morning is still drawn until tonight's rebuild.
- **Restrictions on track OSM does not carry as `railway=rail` are dropped** —
  38 of 2,684 nationally. That is the right call for a regional build and a
  small loss on the national one; the build logs the count either way.
- **The section drawn is the shortest reasonable path, not DB's own
  kilometrage.** Where a line number is untagged in OSM for the whole section
  and two parallel routes exist, the shorter one is chosen and can be the wrong
  one.
- **The archive starts when the job did.** There is no way to backfill it.

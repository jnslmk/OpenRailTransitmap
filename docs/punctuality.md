# Punctuality scores

Per-connection punctuality: how often trains on a line run on time, with
per-station granularity, shown when a line is selected. **Built and verified**
against the real dataset; this document is now the record of how it works and
what the data turned out to be, not a plan.

## Locked decisions (from the user)

| Decision | Choice |
|---|---|
| Score unit | **Station-pair segment** — per-line, per-station *departure* punctuality |
| Display | **Line detail panel** (`ui.ts:setLinePunctuality`) |
| Window | **Rolling 12 months** |

A "station-pair segment" reduces to *departure punctuality at the segment's
origin station*: the delay dataset is per train-stop, so a train's delay at
station A **is** the on-time-ness of the A→B segment. No route-ordering of
stations is needed.

## What it is

| Piece | Where |
|---|---|
| Per-line station lists (the join key) | `pipeline/build.ts` → `data/line-stations.json` |
| Download, join, aggregate | `pipeline/punctuality.ts` → `data/punctuality.json` |
| Tests | `pipeline/punctuality.test.ts` (`npm test`) |
| Client seam | `src/punctuality.ts` |
| Rendering | `src/ui.ts:setLinePunctuality`, wired in `src/main.ts:showPunctuality` |
| Refresh | `npm run build:punctuality`, then commit `data/punctuality.json` |
| Publish | `npm run publish:data` (CI step "Publish committed data to the site") |

## Data source

`piebro/deutsche-bahn-data` on HuggingFace — the maintained successor to Daniel
Kriesel's 36C3 "BahnMining" dataset. Polls DB's Timetables + StaDa APIs and
publishes monthly Parquet. License **CC BY 4.0**, so Deutsche Bahn is credited
in the sidebar footer and in the map's attribution control from the first score
shown.

Files `monthly_processed_data/data-YYYY-MM.parquet`, 2024-07 onwards. ~100 MB
each to 2025-10 (**top-100 stations only**), ~600 MB from 2025-11 (**all
stations**).

## What the data turned out to be (measured, not assumed)

Probed against `data-2026-07.parquet` — 14,052,153 rows, 115 row groups,
591 MB, **SNAPPY only** (so `hyparquet` alone decodes it; no
`hyparquet-compressors`).

- **`delay_in_min` is the departure delay.** It matched
  `departure_change_time − departure_planned_time` exactly on every sampled
  row, and differed from the arrival delay on several (21 vs 22, 3 vs 1,
  61 vs 60). The old open question is answered — but the pipeline still
  computes from the two explicit timestamp columns, because "it matched on the
  day someone checked" is weaker than reading columns that say what they are.
- **A null `departure_planned_time` is a terminus arrival**, not a missing
  value: every row with a planned departure also had a change time.
- **`train_type` is mostly an operator abbreviation** — real values include
  `CAN`, `BRB`, `TL`, `ag`, `NX`, `AVG`, `NBE`, `RSM`, `ENO`, `ARV`, and `Bus`
  against an `S46`. It is only trusted to supply a mode prefix when
  `line_number` is a bare number.
- **`line_number` is usually already prefixed** (`S3`, `RB55`, `RE5`) and is
  null for long-distance.
- **Column projection is the whole ballgame.** The six columns needed are
  0.68 MB of a 5.14 MB row group, so a monthly file costs ~78 MB rather than
  591 MB and the 12-month window ~0.9 GB rather than 5.7 GB, with no disk used.

### A station with no realtime looks perfect

The Swiss S27 and S36 scored **1.00 on time, 0.0 min mean, standard deviation
exactly 0** across 569 departures at Waldshut — while still reporting
cancellations. That is not a punctual service, it is a station DB publishes no
realtime for, so the change time is only ever the planned time echoed back.
`Aggregator.hasRealtime` drops any line or station whose delays are *all*
exactly zero. A genuinely excellent line still records the odd late minute:
rural RB 60 at Rottenbach scores 1.00 with a standard deviation of 0.3 and is
kept.

### Delay is not normally distributed, so no curve is drawn

Measured over 1,116,649 matched departures:

```
mean 3.91   sd 7.76

exactly 0 min  30.4%  ████████████████████
1-2 min        32.5%  ██████████████████████
3-5 min        17.1%  ███████████
6-10 min       10.8%  ███████
11-15 min       4.0%  ███
16-30 min       3.6%  ██
31-60 min       1.2%  █
60+ min         0.3%          max observed 291 min

p50 1   p75 4   p90 10   p95 16   p99 37
```

The distribution is zero-inflated, floored at zero and long-tailed to the
right. Three consequences, all of which changed the design:

- **A fitted Gaussian would be a lie.** A normal curve on that mean and
  standard deviation places **31% of departures at a negative delay**, which
  cannot happen. No bell curve is drawn anywhere.
- **The mean is not "typical".** It sits at the **70th percentile** — worse
  than the trip 70% of riders actually take. The median is 1 minute. `meanDelay`
  was removed in favour of `median`.
- **The standard deviation describes symmetry that is not there.** `sdDelay`
  was removed outright; it was the least useful number in the file.

What replaced them is a bucketed histogram per line and per station —
per-minute to 20 minutes, coarsening through the tail (`BUCKET_EDGES`). It
yields exact percentiles where the mass is, the shares the band bar draws, and
costs a few dozen integers per line. The line-level histogram is published in
full even though the panel currently draws only four bands from it: it is ~50 KB
across the whole file, against a 13-minute rate-limited pass to recompute it.

### HuggingFace meters the download, and says so

A 12-month pass is ~8,300 range requests, and the first unthrottled attempt
died with 429s six months in. Every response carries the budget:

```
ratelimit-policy: "fixed window";"resolvers";q=3000;w=300
ratelimit: "resolvers";r=0;t=52
```

3,000 requests per 300 s. `politeFetch` reads `r` off every response and parks
all workers until the window resets when the allowance runs low, rather than
discovering the limit by being refused. Blind exponential backoff is not enough
on its own — it capped out at 31 s against a window with 52 s left to run,
which is exactly how the second attempt died. `HF_TOKEN` raises the ceiling if
set; nothing requires it.

## Matching — the crux

The map's line `ref` (`RE1`, `RB58`, `S6`) is joined to the feed's
`line_number` + `train_type`. Ref alone is hopeless — **132 of 285 regional
refs collide (539 lines), 19 of 81 suburban refs (145 lines)**, `RE7` alone
across ten lines — and the feed has no network field. The only disambiguator is
the station name.

A row matches a line when **both** hold:

1. `rowRef(line_number, train_type)` equals the line's normalised `ref`; and
2. the row's `station_name` matches one of that line's station names
   (`normaliseName` for the exact path, `namesMatch` from `pipeline/stop-ids.ts`
   for the abbreviation-tolerant fallback).

Where two lines with the same ref genuinely call at the same station, the row is
**dropped, not guessed at** — a wrong attribution silently corrupts a published
score in a way nothing downstream can detect.

Measured over the full 12-month window (2025-08 … 2026-07): **110,787,442 of
122,717,388 rows with a usable ref attributed (90%)**, 477 distinct
`(ref, station)` pairs left ambiguous, **730 of 899** regional and suburban
lines scored. Weighted mean on-time share across them is **85.0%**, which sits
where DB's own published regional figures do.

## Design

- **Modes:** regional + suburban (`SCORED_MODES`). Long-distance carries no
  `line_number`; tram and subway refs are bare numbers against an
  operator-abbreviated `train_type`. Both deferred — the data model is not
  mode-specific, so widening scope means solving their ref problem, nothing else.
- **On time:** departure delay `< 6 min`, DB's own "pünktlich" threshold, so the
  number is comparable with the ones DB publishes.
- **Reported statistics:** on-time share, **median** ("typically X min late"),
  **p90** ("1 train in 10"), and cancel rate — per line *and* per station. No
  mean, no standard deviation; see the distribution section above.
- **The band bar** splits all scheduled departures into to-the-minute /
  under 6 / 6–15 / 16+ / cancelled. The first two sum to exactly the published
  on-time share, so the bar cannot disagree with the headline percentage; the
  segments sum to the whole timetable, so cancellations cannot be quietly
  dropped from the picture.
- **Cancellations** count in `n` and against `cancelRate`, but are excluded from
  the delay histogram: a train that never ran has no departure delay.
- **Early departures clamp to zero** — a minute-resolution artefact must not net
  off real lateness.
- **Reporting floors.** A line needs `MIN_LINE_SAMPLES = 200`. A station needs
  `MIN_STATION_SAMPLES = 100` **and** at least `MIN_STATION_SHARE = 10%` of its
  line's *median* station sample — because the breakdown is read as a ranking,
  and the thinnest samples land at the top of it by construction: a handful of
  diverted runs are late almost by definition. Measured on the 12-month window,
  78 of 730 lines had their worst-ranked station drawn from under a tenth of the
  line's typical sample (RE 1 (RRX) read "worst at Köln Süd, 23% on time" from
  **39** departures, against 11,014 per station elsewhere). A flat floor cannot
  separate that from a rural branch where 300 departures is a full year of
  service, which is why the second floor is relative; raising the flat floor to
  200 instead fixes only 33 of the 78. Together they drop 4.6% of station rows
  and empty exactly one line's breakdown.

### Output shape

```json
{
  "generated": "2026-08-18",
  "source": "https://huggingface.co/datasets/piebro/deutsche-bahn-data",
  "attribution": "Delay data: Deutsche Bahn, via piebro/deutsche-bahn-data (CC BY 4.0)",
  "window": { "from": "2025-08", "to": "2026-07", "months": 12 },
  "onTimeThresholdMin": 6,
  "bucketEdges": [0, 1, 2, "…", 20, 21, 31, 46, 61, 91],
  "lines": {
    "<lineId>": {
      "aggregate": { "onTime": 0.83, "median": 1, "p90": 10, "cancelRate": 0.02, "n": 12345 },
      "hist": [3812, 2104, "…"],
      "stations": { "<stationName>": { "onTime": 0.9, "median": 1, "p90": 6, "n": 400 } }
    }
  }
}
```

## Why it is not in the nightly build

The upstream files are published monthly, so a nightly recompute would re-read
~0.9 GB for the same answer. CI runs with `contents: read` and cannot push, so —
exactly like `data/stop-ids.json` — the output is committed and CI only copies
it into `public/`. A human runs `npm run build:punctuality` when a new month
lands. `PUNCTUALITY_MONTHS=1` shortens the window for a development run.

## Remaining

- **Coverage skew.** Files before 2025-11 only cover the top 100 stations, so
  regional lines through small stations have ~9 months of real data in a
  12-month window, not 12. Self-correcting from 2026-11 onwards.
- **Long-distance, tram, subway** are unscored — see `SCORED_MODES`.
- **Time of day is not split.** "My 07:42" is a different question from "this
  line on average", and `departure_planned_time` makes a peak/off-peak or
  hour-of-day profile computable. Deliberately deferred.
- **The full histogram is published but only four bands are drawn from it.** A
  histogram or exceedance chart in the panel needs no pipeline change.
- The 169 regional/suburban lines that score nothing are mostly below the
  reporting floors or run entirely through stations without realtime; no one
  has walked the list to confirm there is no matcher bug hiding in it.
- A full pass takes ~13 min wall clock, most of it parked on rate-limit
  windows rather than transferring.

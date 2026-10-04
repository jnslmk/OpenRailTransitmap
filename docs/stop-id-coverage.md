# Stop-id coverage: current state and resolver notes

The station popup shows a departure board only when its tile feature carries a
non-empty `stopId`: [`pipeline/build.ts`](../pipeline/build.ts#L1255-L1265)
reads the committed [`data/stop-ids.json`](../data/stop-ids.json), and
[`src/ui.ts`](../src/ui.ts#L1752-L1756) uses that value to decide whether to
render the board. Cache coverage therefore determines departure-board coverage.

## Current committed snapshot

As prepared on 2026-10-04, the v7 cache contains **18,122 entries**:

| state | entries |
|---|---:|
| resolved id | **18,055** |
| confirmed negative (`""`) | **53** |
| ambiguous (`"#ambiguous"`) | **14** |

The combined v7 bump for mode-aware matching and `ref:IFOPT` invalidated 911 v6
negative/ambiguous entries while retaining all 18,022 resolved mappings. One
deliberately bounded live refresh used 100 of 100 station attempts: 33 resolved,
53 negative, 14 ambiguous, and 0 lookup errors. It therefore repopulated 100 of
those invalidated entries; the other 811 remain absent and eligible for later
budgeted runs. This is an intentional partial refresh, not a complete national
pass.

These are cache-entry counts, not the denominator of every station in the
current 20,832-station extract. In particular, do not turn 18,055/18,122 into a
national coverage percentage. “Confirmed negative” means “v7 found no validated
match,” not that Transitous can never contain the station.

For historical comparison, the 2026-08-17 handoff measured a 20,832-station
extract:

| state | after national pass (v4) | after v5 re-probe |
|---|---:|---:|
| resolved | 16,164 (78%) | 17,933 (86%) |
| ambiguous | 2,590 | 896 |
| negative | 2,078 | 2,003 |

Those two passes made 22,733 lookups with zero errors. The v5 re-probe converted
1,769 of 4,668 previously declined stations. These figures describe that dated
extract and resolver generation; they are not current totals.

The same 2026-08-17 analysis classified the 2,003 v5 negatives as 973 plausible
rail stops, 545 features without a `railway=*` tag, 369 ferry/chairlift/
funicular/museum-railway features, and 116 disused or abandoned features. It
also found that 63% of the 896 v5 ambiguities had `railway:ref`, 53% had
`uic_ref`, and 17% had `ref:IFOPT`. Those are historical diagnostics, not
properties guaranteed for the current v7 cache.

## What resolver v7 does

The source of truth is the resolver itself:

- [cache states, versioning, and request budget](../pipeline/stop-ids.ts#L13-L62)
- [name, distance, and mode validation](../pipeline/stop-ids.ts#L296-L613)
- [candidate and fallback sequence](../pipeline/stop-ids.ts#L696-L933)

For an uncached station with a syntactically valid `ref:IFOPT`, v7 first asks
`/stoptimes` about at most two DELFI candidates: the complete DHID and, when
different, its first three components (the station-level stem). The returned
place must identify the exact requested id, lie within 500 m, name-match the OSM
station, and serve a mode compatible with that station. Nothing derived from
the tag is cached without those checks. In particular, `uic_ref` and `ref:ibnr`
are not candidates.

A missing or malformed tag makes no candidate request. An unknown, unavailable,
wrong-name, too-distant, or mode-incompatible candidate falls through to the
same grouped spatial sweep used by v6:

```text
GET /api/v1/map/stops?min=<lat>,<lon>&max=<lat>,<lon>&grouped=true
```

`grouped=true` is required. Ungrouped `/map/stops` is a leaf-level view: it can
return separate platforms and bus bays while omitting the station-level id.
`parentId` cannot repair that reliably because feeds do not parent every bay.
In the 2026-10-03 evaluation of 100 already-resolved stations, the ungrouped
request reproduced 27 ids, found no match for 59, and returned a clean but
different id for 14. The grouped request reproduced 96 ids and returned **no
different ids**; four had no match. “Grouped” still is not a promise that every
id is station-level: unparented feed entries remain unparented.

Every source is passed through the same matcher. It:

1. rejects candidates beyond 500 m or whose normalized name does not match;
2. prefers exact normalized names over merely plausible containment or
   abbreviation matches;
3. collapses same-stop feed duplicates within 20 m;
4. uses compatible rail/tram modes to settle a close name-and-distance tie; and
5. returns ambiguity rather than guessing when multiple compatible candidates
   remain within the 150 m margin.

A box verdict, including ambiguity, is final. Only a box with no matching
candidate falls back to name geocoding, reverse geocoding, and then an optional
locality-qualified name query. The geocoder requests still use `type=STOP`;
`/map/stops` has no equivalent type filter because its observed rows are transit
vertices.

### What the sweep measurements do and do not show

The v6 sweep produced a **modest measured yield**, not the wholesale recovery
suggested by the old handoff. In the 2026-10-03 evaluation sample it resolved
**5 of 60** v5 ambiguities and **0 of 60** v5 negatives. The earlier estimate
of roughly 70 additional resolutions was an extrapolation from that sample,
not a measured cache-wide result.

The useful effect was also not simply geography. In the 2026-10-03 evaluation,
two geocoder rivals were only 5.6 m and 23.2 m from their OSM stations. They
were absent from `/map/stops` because they were unserved parent/stop-area rows
with `modes: []`, while the geocoder included them. Across 2,301 records from
four roughly 11 km sweeps, that served/unserved split had no observed exception.
This remains an observation about the API, not a documented contract. The
matcher now rejects explicit `modes: []` and preserves mode data from both the
sweep and geocoder for disambiguation.

Likewise, the 2026-10-03 observation of an HTTP 422 from a 1.0° request does
not establish a dimension limit. The observed limit is tied to **stop count**:
a rural Bavaria 1.0° box returned HTTP 200 with 13,566 stops, while a denser
1.0° box returned 422. The resolver’s
small per-station box has worked in the measured cases, but there is no
supported “maximum degree width” to quote.

## Current identifier behavior

Mode-aware disambiguation is active for both sweep and geocoder candidates.
It is only a tie-breaker after name and distance validation; a compatible mode
does not rescue an otherwise implausible stop.

The 2026-08-17 measurement that motivated `ref:IFOPT` support found that 82% of
then-resolved tagged stations had an id containing the DHID stem. The observed
Hannover, Bochum, and Singen fixtures validate under v7. The tag remains only a
candidate: Albbruck’s DHID returns the wrong-name, bus-only “Albbruck ehem.
Papierfabrik” 176 m from the rail station and is rejected before the grouped
sweep runs. The same historical analysis found `uic_ref` unsuitable (285
matching resolved ids versus 5,851 non-matching ids).

## Remaining experiment, not current behavior

### Classifying stations outside the feed’s scope

Ferries, chairlifts, disused infrastructure, and other features that are not
expected in a GTFS feed should eventually be classified from OSM tags rather
than counted as resolver failures. That classification is not represented in
the three current cache states.

## Operating rules

- A `""` result is retained while the resolver version is unchanged.
  Increasing `RESOLVER_VERSION` drops both negatives and ambiguous markers so
  the new resolver can retry them; resolved ids remain.
- `STOP_ID_BUDGET=0` is the network-free build setting. A deliberate local
  refresh uses `npm run resolve:stop-ids`; the implementation throttles and
  checkpoints that uncapped run.
- Updating the cache alone does not update deployed station features. Rebuild
  the data and tiles after a deliberate refresh.
- Use the resolver’s configured `User-Agent` for API probes. Transitous returns
  403 to Python’s default `urllib` user agent.

### CI status

The mode-aware resolver changes were revalidated on 2026-10-04 at
`c1a6e7c46f01158560f75a4e9a228e7427a87d5f`. The
[build step](../.github/workflows/build.yml#L102-L108) sets
`STOP_ID_BUDGET: '0'`, so CI is cache-only: it consumes the committed mapping
without making stop-id lookup requests or trying to persist a refresh.

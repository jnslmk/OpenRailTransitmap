# Stop-id coverage: current state and resolver notes

The station popup shows a departure board only when its tile feature carries a
non-empty `stopId`: [`pipeline/build.ts`](../pipeline/build.ts#L1255-L1265)
reads the committed [`data/stop-ids.json`](../data/stop-ids.json), and
[`src/ui.ts`](../src/ui.ts#L1752-L1756) uses that value to decide whether to
render the board. Cache coverage therefore determines departure-board coverage.

## Current committed snapshot

As committed on 2026-10-03, the v6 cache contains **18,933 entries**:

| state | entries |
|---|---:|
| resolved id | **18,022** |
| confirmed negative (`""`) | **678** |
| ambiguous (`"#ambiguous"`) | **233** |

These are cache-entry counts, not the denominator of every station in the
current OSM extract. In particular, do not turn 18,022/18,933 into a national
coverage percentage without joining this snapshot to the same extract that
produced it. “Confirmed negative” also means “v6 found no validated match,” not
that Transitous can never contain the station.

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
properties guaranteed for the v6 cache.

## What resolver v6 does

The source of truth is the resolver itself:

- [cache states, versioning, and request budget](../pipeline/stop-ids.ts#L13-L62)
- [name and distance validation](../pipeline/stop-ids.ts#L277-L562)
- [spatial request and fallback sequence](../pipeline/stop-ids.ts#L590-L836)

For each uncached station, v6 first requests a box whose half-extent is the
matcher’s 500 m radius:

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

The box does not replace validation. The resolver reshapes its results into the
same candidate form used by the geocoder, then:

1. rejects candidates beyond 500 m or whose normalized name does not match;
2. prefers exact normalized names over merely plausible containment or
   abbreviation matches;
3. collapses same-stop feed duplicates within 20 m; and
4. returns ambiguity rather than guessing when the two nearest distinct
   candidates differ by less than 150 m in distance.

A box verdict, including ambiguity, is final. Only a box with no matching
candidate falls back to name geocoding, reverse geocoding, and then an optional
locality-qualified name query. The geocoder requests still use `type=STOP`;
`/map/stops` has no equivalent type filter because its observed rows are
transit vertices. `grouped=true` solves the separate platform-vs-parent
problem.

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
This remains an observation about the API, not a documented contract: v6 does **not** filter
`modes` itself, and the matcher currently discards the field.

Likewise, the 2026-10-03 observation of an HTTP 422 from a 1.0° request does
not establish a dimension limit. The observed limit is tied to **stop count**:
a rural Bavaria 1.0° box returned HTTP 200 with 13,566 stops, while a denser
1.0° box returned 422. The resolver’s
small per-station box has worked in the measured cases, but there is no
supported “maximum degree width” to quote.

## Remaining experiments, not current behavior

The following measurements are retained as leads. None describes matching that
v6 currently performs.

### Mode-aware disambiguation

The 2026-08-17 handoff showed same-name rail and bus candidates at Torgau and
Eschhofen whose modes could distinguish them. Implementing that would require
carrying `modes` through both sweep and geocoder candidates; filtering only one
source would make fallback behavior inconsistent.

### `ref:IFOPT` candidate

On 2026-08-17, 82% of then-resolved stations carrying `ref:IFOPT` had a
resolved id containing the DHID stem, and 8 of 8 probed unresolved examples
returned departures when a DELFI id was constructed. This must remain a
validated candidate, not a direct join: Albbruck’s apparent DHID resolved to a
bus stop 176 m from the station. The same analysis found `uic_ref` unsuitable
(285 matching resolved ids versus 5,851 non-matching ids).

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

Current `main` was revalidated on 2026-10-04 at
`6b9e10106139a471075e409a1d6628050fc2512b`. The
[build step](../.github/workflows/build.yml#L102-L108) now sets
`STOP_ID_BUDGET: '0'`, so CI is cache-only: it consumes the committed mapping
without making stop-id lookup requests or trying to persist a refresh.

This document change was prepared from the older pinned base
`0986d8869cf375cced645e130806abb9b527c37d`, where
[#2](https://github.com/jnslmk/OpenRailTransitmap/issues/2) had **not** landed.
That base still performed budgeted lookups which its `contents: read` workflow
could not commit. Do not read the landed `main` behavior back into that
historical base.

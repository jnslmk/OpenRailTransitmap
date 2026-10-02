# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

OpenRailTransitmap serves everyday travellers, bike-and-rail travellers, rail
enthusiasts and explorers, and transport analysts. All four audiences are in
scope; no single audience has been given precedence.

## Product Purpose

Help people evaluate service quality across Germany's passenger transport
network. When product priorities conflict, evaluating service quality takes
precedence over network exploration or journey planning. Exploration and
planning remain supported capabilities, not features to remove.

Success means users can understand the available evidence about reliability,
disruptions, and service coverage in geographic context, and use that information
to evaluate their travel options.

## Positioning

A geographic network map brings individual services, stopping patterns,
operators, construction restrictions, and line/station punctuality into one
interface. Its journey planner also accounts for cycling time at either end of a
trip, rather than assuming the nearest station is the only useful option.

These mechanisms are documented in the repository; they are not claims of
exclusive capability or proven superiority over another product.

## Operating Context

Users explore a shared map and switch between Explore and Plan in the sidebar.
They inspect lines and stops, filter the current view, review service-quality
information, or select journey endpoints. URLs preserve map position, filters,
selection, panel visibility, and journey state for sharing and returning later.

Phone use is first-class alongside desktop use. Both exploration and planning
must remain usable on phones.

The existing interface is English; station and service names retain their source
wording, commonly German. The application is published to GitHub Pages with a
nightly data/build workflow.

## Capabilities and Constraints

The user explicitly requires preservation of the current capabilities:

- Geographic passenger-network exploration, with individually selectable
  long-distance rail, regional rail, S-Bahn, U-Bahn, tram, and long-distance coach.
- Individual line and station inspection, including the services calling at a stop.
- Search, view-scoped mode and operator filters, and shareable state URLs.
- Line and station punctuality information where the dataset provides it.
- Construction closures and restrictions, their duration, and recorded changes.
- Journey planning across rail, local transit, bus, coach, and ferry, with walking
  and configurable cycling access at either end.
- Map-only viewing, a collapsible mobile panel, location, and map navigation.

Repository-documented data limitations remain factual constraints:

- Construction overlays describe the built data snapshot, not a guaranteed
  real-time operational picture.
- Punctuality coverage depends on available source data; not every service has a
  score.
- Live departures and journey planning depend on external Transitous services.
- Bicycle-carriage information can be unavailable; missing information does not
  establish either permission or refusal.

## Brand Commitments

The product name is OpenRailTransitmap. The repository references the LNVG
Niedersachsen Streckenfahrplan as the incumbent map's inspiration, while retaining
geographic rather than schematic alignment. This is existing context, not a new
user-approved visual specification.

No replacement interface palette or visual system has been approved during init.

## Evidence on Hand

- `README.md`: documented features, data sources, deployment, and limitations.
- `data/lines.json` and `data/line-stations.json`: services and station relationships.
- `data/punctuality.json`: available punctuality evidence.
- `data/closure-log.jsonl`: archived construction-plan changes.
- `data/operator-logos.json`: operator-logo provenance manifest.
- `docs/closures.md`, `docs/punctuality.md`, and `docs/buses-and-routing.md`:
  domain-specific mechanisms and source limitations.
- The runnable web application and `e2e/` browser checks: evidence of existing
  workflows, not evidence of usability outcomes for all audiences.

## Product Principles

1. Prioritize evaluating service quality when goals compete.
2. Preserve exploration and journey planning as complementary workflows.
3. Keep the current capabilities available rather than simplifying by deletion.
4. Treat mobile exploration and planning as full product experiences.

## Open Decisions

- How to resolve differing needs among the four supported audiences beyond the
  agreed service-quality priority.
- Specific usability success measures and any accessibility standard beyond
  baseline accessible web interaction.

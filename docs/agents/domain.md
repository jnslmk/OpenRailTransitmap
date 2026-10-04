# Domain docs

## Layout and reading rules

This is a single-context repository: domain vocabulary belongs in root `CONTEXT.md`, and architecture decisions in `docs/adr/`.

Before domain exploration, read `CONTEXT.md` if present and the ADRs relevant to the work. If either is absent, proceed silently; create domain documentation only when actual terminology or decisions are resolved through domain modeling.

Read `PRODUCT.md` for product priorities and preserved capabilities. Consult existing topic documentation for the area being changed:

- Journey planning and transport modes: `docs/buses-and-routing.md`.
- Construction restrictions: `docs/closures.md`.
- Reliability and punctuality data: `docs/punctuality.md`.
- Live departures: `docs/live-data.md`.
- Stop-ID resolution and coverage: `docs/stop-id-coverage.md`; distinguish historical measurements from current implementation evidence.
- Interface layout and interaction: `DESIGN.md`.

## Vocabulary and decisions

Use terms defined in `CONTEXT.md` when naming domain concepts. Note genuine terminology gaps for domain modeling rather than inventing synonyms.

Surface any proposed change that contradicts an existing ADR, citing the decision and the reason to reconsider it.

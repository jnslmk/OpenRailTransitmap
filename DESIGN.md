---
name: OpenRailTransitmap
description: A compact, geographic railway workbench for browsing the network and inspecting service evidence.
colors:
  ground: "#f2f2f2"
  grey: "#dadad9"
  ink: "#1a1a1a"
  muted: "#6b6b6b"
  accent: "#014895"
  panel: "#fff"
typography:
  body:
    fontFamily: "'Fira Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
rounded:
  sm: "4px"
  md: "6px"
  pill: "999px"
spacing:
  sm: "4px"
  md: "8px"
  lg: "12px"
components:
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.md}"
    padding: "12px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  chip:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  tab-active:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    padding: "7px 10px"
  sheet-expand:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
---

# Design System: OpenRailTransitmap

## Overview

**Creative North Star: "The Railway Workbench"**

OpenRailTransitmap is an information-dense, light railway workbench: a geographic map remains the working surface while compact controls and evidence panels make the network legible. Its incumbent LNVG-inspired character is practical rather than ornamental—light-grey ground, white working surfaces, a restrained blue interface accent, and workhorse sans typography sit beside the many route colours required by the map itself. The product preserves geographic route geometry and railway marks rather than turning the network into a schematic.

Wide desktop (1200px and above) gives browsing and planning a persistent left rail, the map the largest area, and selected evidence a right-hand inspector. Compact desktop (821–1199px) uses one collapsible left drawer: browse/plan and selected evidence take turns while the map remains interactive. On phones (up to 820px), the map stays above a single contextual sheet that changes between browse/plan and selected evidence; the sheet can peek, work, or expand for reading. This is an ordinary extension of the existing map identity, not a replacement visual world.

**Key Characteristics:**
- Map-first and geographically grounded.
- Compact, workhorse controls; information before decoration.
- Neutral application chrome alongside data-driven railway colours.
- One active compact-desktop drawer or phone content sheet, with visible access to map controls.

## Colors

The chrome palette is light and restrained; route and operator colours remain data marks, not extra interface accents.

### Primary
- **Railway Blue Accent** ({colors.accent}): Interface links, selected controls, focus outlines, and location affordances.

### Neutral
- **Light Map Ground** ({colors.ground}): The page and exposed workspace ground behind map and controls.
- **Divider Grey** ({colors.grey}): Panel edges, separators, inactive tab bed, and quiet controls.
- **Ink** ({colors.ink}): Primary text and high-contrast marks.
- **Muted Text** ({colors.muted}): Secondary labels, supporting copy, and inactive navigation.
- **White Panel** ({colors.panel}): Cards, inputs, active tabs, and panel surfaces.

**The Chrome-Not-Route Rule.** Use the blue accent for interface state and focus; line, operator, punctuality, and construction colours communicate their own map or evidence data and are not a general-purpose UI palette.

## Typography

**Display Font:** None; the interface has no display-headline role.
**Body Font:** Fira Sans, with system, Apple, Segoe UI, and sans-serif fallbacks.
**Label/Mono Font:** No distinct label or mono family is established.

**Character:** One compact sans family supports a workmanlike, scan-friendly interface. Body text is 14px; smaller supporting labels and uppercase section labels create hierarchy without introducing a separate display voice.

### Hierarchy
- **Title** (500, 18px): The main workspace heading, where present.
- **Section label** (regular, 12px, 0.06em letter spacing, uppercase): Quiet panel section headings.
- **Body** (regular, 14px): Default controls, rows, and readable content.
- **Supporting text** (regular, 12px): Subtitles, metadata, and secondary labels; muted unless it is an interactive link or evidence highlight.

**The Workhorse Type Rule.** Keep hierarchy compact and functional; do not add a display face or oversized marketing headline to this map workspace.

## Layout

At widths of 1200px and above, desktop uses a 320px browsing/planning rail beside a flexible map; an open selection adds a separate 340px right inspector. Compact desktop (821–1199px) shares a single collapsible 320px left drawer between browse/plan and selected evidence, leaving more than half the viewport for the map. At widths up to 820px, the workspace becomes a map above shared sheet controls and one content slot. The browse/plan rail and selection inspector take turns in that slot rather than stacking. The phone sheet has peek, working, and expanded reading modes. The map remains interactive without a backdrop; map-only viewing folds the chrome away without clearing the selection or its highlight.

Keep identity, tabs, search, and filter access in the rail's fixed head while its content body owns the scroll. In the inspector, keep the selection identity/header fixed and let evidence scroll. The mobile sheet controls remain visible between map and content; scrolling belongs to the active panel, not the page. Preserve comfortable touch targets on coarse pointers and allow long evidence to scroll within its panel.

Filters and the browse list have no full-width divider between them; tabs, search, filters, and the list use consistent 10px vertical gaps. Counts, attribution, and the build stamp sit at the bottom of the rail when content fits, following the content in the scroll region when it overflows.

Map attribution is a small, muted text strip at the map's bottom-right edge on a translucent white backing, with no border or shadow. The linked OpenStreetMap credit is always visible; a native **Credits** disclosure opens other map-source links above the strip. It remains accessible in map-only and fullscreen views, stays above the phone sheet, and gives touch links and the disclosure at least 44px-high targets. Routing attribution belongs in the sidebar, not the map strip.

At regional zooms, larger cities are geographic anchors above the railway bands:
Fira Sans Bold, dark ink and a white text halo, with collision placement favouring
larger populations. Use OSM city centres, not station coordinates or names.
Station marks remain visible; city labels fade between z11 and z12 as station
names and the detailed basemap take over.

## Elevation & Depth

The UI is flat and structural, not shadow-led. White surfaces are set against the light-grey ground and separated with fine grey borders; a selected tab or open panel is distinguished by its surface, border, and state rather than a drop shadow. Route geometry and explicit evidence marks supply visual emphasis.

**The Border-Defines-Surface Rule.** Separate chrome surfaces with the established grey border; do not add ambient shadows or gradients to manufacture depth.

## Shapes

Controls and cards use restrained, mostly small corners: inputs and outlined buttons use 4px; panels use 6px; filter chips are fully pill-shaped (999px). Tabs sit in a softly rounded segmented control. Borders are thin and functional; map stations, route strokes, and closure hatching retain their domain-specific geometry rather than being softened into generic UI shapes.

## Components

### Buttons and controls
Compact, familiar controls keep their labels visible. Outlined controls use a white surface, grey stroke, and blue interaction cue; the phone sheet's Expand action is a small blue-text button. Focus remains a visible 2px blue outline. Coarse-pointer controls retain at least a 44px target where implemented.

### Chips
Filter chips are white, grey-outlined pills with dark text; hover shifts the border to blue. An active chip becomes blue with white text so selected filters remain unambiguous.

### Cards / Containers
Panels are white with a 1px grey border, 6px corners, and 12px internal padding. The inspector is a full-height white surface with a dividing edge; its fixed heading is separated from the independently scrolling evidence body.

### Inputs / Fields
Search and select fields use white fill, 1px grey border, 4px corners, and 8px by 10px padding. Focus receives a 2px blue outline inset by 1px. Keep native input semantics and visible focus rather than replacing fields with decorative lookalikes.

### Navigation
Explore and Plan share a segmented tab bed in the desktop browse rail. The selected tab is white with ink text; the inactive tab is muted over grey. On compact desktop, evidence replaces that rail until Back returns to the workspace. On phones, the same tabs remain in the active sheet's browsing/planning content.

### Browse rail and mobile sheet
The rail gives search, filter access, browse results, and planning a stable place beside the map. On compact desktop, selection replaces the left drawer's content; on a phone, a shared control row remains between the map and the single active sheet, and selection replaces the sheet body. Back restores query, filters, disclosures, planner input, scroll and visible focus, including across layout changes. Collapsing and reopening the chrome retains selected evidence and its map highlight. Sheet sizing transitions briefly unless reduced motion is requested.

### Evidence inspector
Keep selected identity before evidence. Pin the header while evidence scrolls, and keep dates, coverage, snapshot qualifications, and unavailable/error/empty states close to the claims they qualify. Native disclosures hold secondary metadata and explanatory legends without displacing the primary evidence.

### Journey legibility
In Plan, a selected journey is the foreground: keep its white casing, quiet the
network routes, and hide network station marks while retaining active mode,
operator and line-selection filters for restoration. Origin, destination and
interchange labels sit above the route with white text halos. Explore or clearing
the journey restores normal network marks and route emphasis.

Successive transit legs use Okabe–Ito hues (blue, vermilion, green, purple and
contrast-darkened amber), shared by map strokes, numbered badges and timeline
bars. These colours identify journey legs, not official lines; Explore retains
the network palette. Service text and leg numbers carry the meaning without
colour. The palette cycles on longer journeys without equal adjacent leg colours.

Each transit-to-transit connection has one larger white, dark-outline numbered
marker with a persistent station label and a matching sidebar change number.
Walking arrival/departure boundaries form one interchange, including zero-length
walks and adjacent trains; access/egress is not a train change. Connecting station
names and walking duration remain explicit in the sidebar. One grouped marker
is retained at every zoom; choosing it in the sidebar fits the walking connection.

Use native, visible-focus buttons beside the timeline to select a leg or a change,
never nested inside the itinerary overview button. A pressed leg keeps its map
segment vivid while other legs quieten; a pressed change emphasizes its numbered
mark and fits the connection, with arrival/departure times and platforms shown
when published. Touch targets are at least 44px on coarse pointers. Focused-leg
state is temporary, resets when the itinerary changes, and does not alter trip
URL state. Added map fitting is immediate for reduced-motion users.


## Do's and Don'ts

### Do:
- **Do** preserve the LNVG-inspired workhorse map identity, geographic routes, and station marks.
- **Do** use the exact light-ground, grey-divider, ink, muted, blue-accent, and white-panel roles documented above.
- **Do** keep browse/plan at left and a separate right inspector on wide desktop; use one replacing left drawer on compact desktop and one replacing content slot on phones.
- **Do** keep focus visible, controls labelled, touch targets comfortable, and long evidence independently scrollable.
- **Do** state evidence dates and source coverage limits beside the relevant facts.

### Don't:
- **Don't** invent a dark theme, new identity palette, prestige styling, warmth, gradients, or shadow vocabulary.
- **Don't** use the blue UI accent as a substitute for line, operator, punctuality, or construction data colours.
- **Don't** stack browse/planning and evidence on phones or show both sidebars on compact desktop; selection occupies their shared content slot.
- **Don't** turn this dense map interface into a dashboard or oversized display-led landing page.

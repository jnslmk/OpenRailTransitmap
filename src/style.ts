/**
 * The MapLibre style, built to match the LNVG Streckenfahrplan.
 *
 * Three things carry the look across from the poster to a geographic map:
 *   1. the extracted colour palette (shared/lnvg.ts)
 *   2. the three-step line-weight hierarchy
 *   3. parallel bundling - routes sharing a corridor draw as adjacent bands,
 *      using the `offset` ordinal precomputed by the pipeline
 *
 * Each mode gets its own layer so the mode filter is a visibility toggle and
 * the draw order (tram at the bottom, long-distance on top) is explicit.
 */

import type {
  StyleSpecification, LayerSpecification, ExpressionSpecification,
  SymbolLayerSpecification,
} from 'maplibre-gl';
import {
  BUNDLE_PITCH_PX, LNVG, MODES, MODE_SPECS, PT_TO_PX, STOP_TIERS, type Mode,
} from '../shared/lnvg.ts';
import { PILL_IMAGE_PREFIX, PILL_PITCH, PILL_THICKNESS, pillLength } from './stopmarks.ts';

export const FONT_REGULAR = ['Fira Sans Regular'];
export const FONT_MEDIUM = ['Fira Sans Medium'];
export const FONT_BOLD = ['Fira Sans Bold'];

/**
 * How line weights grow with zoom.
 *
 * MapLibre requires `zoom` to be the input of a *top-level* interpolate, so the
 * scaling factor is baked into each stop's output rather than multiplied around
 * the interpolate.
 */
const ZOOM_STOPS: [number, number][] = [
  [5, 0.45],
  [8, 0.7],
  [11, 1.0],
  [14, 1.6],
];

/** Line width in px for a reference weight given in points. */
const scaled = (pt: number, multiplier = 1): ExpressionSpecification =>
  ['interpolate', ['linear'], ['zoom'],
    ...ZOOM_STOPS.flatMap(([z, f]) => [z, pt * PT_TO_PX * f * multiplier]),
  ] as ExpressionSpecification;

/**
 * Bundle spread, which deliberately does *not* follow the width curve.
 *
 * Germany's busiest corridors carry 20+ lines. At national zoom a proportional
 * spread turns those into wide coloured blobs that read as noise, so the offset
 * collapses to zero below z6: bundles stack on the true alignment and the map
 * shows one trunk per corridor, which is what the reference poster does at that
 * scale. The bands fan out again as soon as there is room for them.
 */
const OFFSET_STOPS: [number, number][] = [
  [5, 0],
  [6, 0.08],
  [8, 0.4],
  [11, 1.0],
  [14, 1.6],
];

/**
 * Perpendicular displacement for one band of a bundle. `offset` is a centred
 * ordinal so a bundle straddles the true alignment: whole numbers for an
 * odd-sized bundle, half pitches for an even one. 1.02 leaves a hairline
 * between bands.
 *
 * A data expression inside the stop outputs is allowed; only `zoom` itself is
 * constrained to the top level.
 */
const bandOffset: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'],
  ...OFFSET_STOPS.flatMap(([z, f]) => [z, ['*', ['get', 'offset'], BUNDLE_PITCH_PX * f]]),
] as ExpressionSpecification;

/**
 * Selection is expressed as a paint expression rather than feature-state:
 * there are thousands of route features, and swapping one expression per layer
 * is far cheaper than setting state on each of them.
 * `selected === null` means nothing is selected and everything paints normally.
 */
export function selectionOpacity(
  selected: string | null, base = 1, dimmed = 0.1,
): number | ExpressionSpecification {
  if (!selected) return base;
  return ['case', ['==', ['get', 'line'], selected], base, dimmed];
}

/** Visible only for the selected line - used for the white lift-off casing. */
export function highlightOpacity(selected: string | null): number | ExpressionSpecification {
  if (!selected) return 0;
  return ['case', ['==', ['get', 'line'], selected], 1, 0];
}

function routeLayers(): LayerSpecification[] {
  // Reverse so higher-order modes are appended last and paint on top.
  const ordered = [...MODES].sort((a, b) => MODE_SPECS[a].order - MODE_SPECS[b].order);

  return ordered.flatMap((mode: Mode): LayerSpecification[] => {
    const spec = MODE_SPECS[mode];
    return [
      // A white casing under the selected line only, to lift it off the bundle.
      {
        id: `route-${mode}-highlight`,
        type: 'line',
        source: 'rail',
        'source-layer': 'routes',
        minzoom: spec.minzoom,
        filter: ['==', ['get', 'mode'], mode],
        // Round caps: route features are emitted per bundle segment, so one
        // logical line is drawn as many chains that meet end to end. Where two
        // consecutive chains sit at the same offset, a butt cap leaves a
        // hairline notch at the join, and round caps close it.
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': LNVG.white,
          'line-width': scaled(spec.weightPt, 2.1),
          'line-offset': bandOffset,
          'line-opacity': highlightOpacity(null),
        },
      },
      {
        id: `route-${mode}`,
        type: 'line',
        source: 'rail',
        'source-layer': 'routes',
        minzoom: spec.minzoom,
        filter: ['==', ['get', 'mode'], mode],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'colour'] as ExpressionSpecification,
          'line-width': scaled(spec.weightPt),
          'line-offset': bandOffset,
          'line-opacity': selectionOpacity(null),
          // Only a mode that does not run on rails carries one; see MODE_SPECS.
          ...(spec.dash ? { 'line-dasharray': [...spec.dash] } : {}),
        },
      },
    ];
  });
}

/** Line-number badges: white text on a thick coloured halo reads as a chip. */
function badgeLayer(): LayerSpecification {
  return {
    id: 'route-badges',
    type: 'symbol',
    source: 'rail',
    'source-layer': 'routes',
    minzoom: 9,
    filter: ['all', ['has', 'ref'], ['!=', ['get', 'ref'], '']],
    layout: {
      'symbol-placement': 'line-center',
      'text-field': ['get', 'ref'],
      'text-font': FONT_BOLD,
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 9, 13, 12],
      'text-padding': 12,
      'text-allow-overlap': false,
      'text-rotation-alignment': 'viewport',
      'text-pitch-alignment': 'viewport',
    },
    paint: {
      'text-color': LNVG.white,
      'text-halo-color': ['get', 'colour'] as ExpressionSpecification,
      'text-halo-width': 2.4,
      'text-opacity': selectionOpacity(null),
    },
  };
}

/**
 * A station carries `lines` - the comma-joined ids of the lines serving it -
 * and an id is `mode|network|ref`, so a substring test for `mode|` is enough to
 * tell which modes stop there without shipping a second property. Without this
 * the stop marks and their names survived a mode being switched off, which left
 * a place like Braunschweig looking untouched when the trams were hidden.
 *
 * On a `stopmarks` feature `lines` is the run *that bar* covers rather than
 * everything the station sees, so switching a mode off takes away the bars that
 * were only ever about that mode and leaves the rest of the station standing.
 */
export function servedByModes(modes: Mode[]): ExpressionSpecification {
  return ['any', ...modes.map((m) =>
    ['>=', ['index-of', `${m}|`, ['to-string', ['get', 'lines']]], 0],
  )] as ExpressionSpecification;
}

// ---------------------------------------------------------------------------
// Station marks
//
// The reference poster marks a stop with a bar laid across the bundle, covering
// exactly the lines that call there. That is a far better answer to "can I get
// this train from here?" than a dot beside the corridor, which says a station
// exists and nothing about which of the six bands running past it stop at it.
//
// The bar cannot go on the station node - the node is a building or a car park,
// off to one side of the alignment the bands are drawn on - so the pipeline
// anchors each one on the corridor itself and gives it the band ordinals it
// covers (pipeline/lib/stopmarks.ts). What is left here is arithmetic:
//
//   icon-size   := the bundle's own spread factor at this zoom
//   icon-offset := the bar's centre ordinal, in band pitches
//
// and because MapLibre multiplies the second by the first and rotates it with
// `icon-rotate`, the bar sits on its bands at every zoom without either
// expression knowing about the other. See src/stopmarks.ts.
//
// Below z11 the spread deliberately collapses, so that there is nothing to span
// and the marks are drawn as plain dots - on the corridor still, so nothing
// moves at the changeover, only fills out.
// ---------------------------------------------------------------------------

const INK = '#1a1a1a';
/** For a stop that is on the map but is not a railway station. */
const MUTED_INK = '#5a5a5a';

/** Where the bars start to fade in, and where they have wholly replaced dots. */
const PILL_IN = 10.2;
const PILL_FULL = 11;

/** Zoom at which the true position of the station itself is finally drawn. */
const TRUE_POSITION_ZOOM = 16;

/** The bundle spread factor at a zoom, read off the same table the bands use. */
function spreadAt(zoom: number): number {
  const stops = OFFSET_STOPS;
  if (zoom <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [z0, f0] = stops[i - 1], [z1, f1] = stops[i];
    if (zoom <= z1) return f0 + ((f1 - f0) * (zoom - z0)) / (z1 - z0);
  }
  return stops[stops.length - 1][1];
}

const fadeIn: ExpressionSpecification =
  ['interpolate', ['linear'], ['zoom'], PILL_IN, 0, PILL_FULL, 1];
const fadeOut: ExpressionSpecification =
  ['interpolate', ['linear'], ['zoom'], PILL_IN, 1, PILL_FULL, 0];

/** `icon-size`: exactly the factor the bundle spread uses, and nothing else. */
const spreadFactor: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'], ...OFFSET_STOPS.flatMap(([z, f]) => [z, f]),
] as ExpressionSpecification;

/**
 * The bar's centre, in image pixels along its own long axis.
 *
 * `icon-offset` is an `array<number, 2>` and expressions cannot build an array
 * from a computed value, so the only data-driven form available is a `match`
 * that picks between literals. Centre ordinals are always whole half-bands, so
 * the table is finite: half-band steps out to +/-24 bands covers every bundle
 * on the network with room to spare, and anything beyond it falls back to the
 * alignment rather than to a wrong band.
 */
const HALF_BANDS = 48;
const barCentre = [
  'match', ['round', ['*', ['get', 'mid'], 2]],
  ...Array.from({ length: 2 * HALF_BANDS + 1 }, (_, i) => i - HALF_BANDS)
    .flatMap((half) => [half, ['literal', [(half / 2) * PILL_PITCH, 0]]]),
  ['literal', [0, 0]],
] as unknown as ExpressionSpecification;

/** Everything that puts a bar on its bands, shared by the two layers that do. */
const barLayout: SymbolLayerSpecification['layout'] = {
  'icon-image': ['concat', PILL_IMAGE_PREFIX,
    ['to-string', ['round', ['get', 'span']]]] as ExpressionSpecification,
  'icon-size': spreadFactor,
  'icon-offset': barCentre,
  'icon-rotate': ['get', 'bearing'] as ExpressionSpecification,
  'icon-rotation-alignment': 'map',
  'icon-pitch-alignment': 'map',
  // A stop is the map's anchor and is never dropped for want of room, but it
  // still goes into the collision index, so names step around the bars.
  'icon-allow-overlap': true,
  'icon-ignore-placement': false,
  // Interchanges and Hauptbahnhöfe win what collisions there are.
  'symbol-sort-key': [
    '-', 0, ['+', ['get', 'lineCount'], ['*', 10, ['get', 'major']]],
  ] as ExpressionSpecification,
};

/**
 * How far a name sits from its own bar, in ems.
 *
 * A symbol's text is never collision-tested against its own icon, so a fixed
 * offset that clears a one-line dot is a name lying across an eight-line bar.
 * The clearance is therefore the bar's own half-length - which, being radial,
 * works whichever of the four anchors the placement picks and whichever way the
 * bar is turned. `pillLength` is affine in span, so two stops interpolate it
 * exactly. Below the changeover the mark is a dot and none of this applies.
 */
const LABEL_EM = 12;
const radialEm = (span: number, spread: number) =>
  (pillLength(span) * spread) / 2 / LABEL_EM + 0.45;

/**
 * ...and it steps rather than interpolates with zoom, because a symbol's layout
 * is evaluated once per tile at that tile's own zoom. A step whose thresholds
 * are whole numbers changes exactly when the buckets are rebuilt anyway, so
 * nothing jumps; an interpolate would quantise into a jump of its own.
 */
const byLength = (spread: number): ExpressionSpecification =>
  ['interpolate', ['linear'], ['number', ['get', 'span']],
    1, radialEm(1, spread), 64, radialEm(64, spread)] as ExpressionSpecification;

const nameOffset: ExpressionSpecification = [
  'step', ['zoom'],
  0.9,
  ...[PILL_FULL, 12, 13, 14].flatMap((z) => [z, byLength(spreadAt(z))]),
] as ExpressionSpecification;

const rankIs = (rank: number): ExpressionSpecification =>
  ['==', ['get', 'rank'], rank];

const primary: ExpressionSpecification =
  ['all', ['==', ['get', 'primary'], 1]];

const dotLayer = (rank: number) => `stop-dots-r${rank}`;
const markLayer = (rank: number) => `stop-marks-r${rank}`;
const labelLayer = (rank: number) => `stop-labels-r${rank}`;

/**
 * Layers that carry a station mark, and are therefore what a click on a stop
 * has to be tested against. The name layers are in it because above a tier's
 * label zoom they are what draws the bar - the mark-only layer has ended by
 * then, so leaving them out would make the bars unclickable exactly where they
 * are largest.
 */
export const STOP_MARK_LAYERS: string[] = STOP_TIERS.flatMap((t) => [
  ...(t.mark < PILL_FULL ? [dotLayer(t.rank)] : []),
  markLayer(t.rank),
  labelLayer(t.rank),
]);

/** Station layers and the base filter each one is built with. */
export const STATION_FILTERS: Record<string, ExpressionSpecification> = {
  ...Object.fromEntries(STOP_TIERS.flatMap((t) => [
    ...(t.mark < PILL_FULL ? [[dotLayer(t.rank), rankIs(t.rank)]] : []),
    [markLayer(t.rank), rankIs(t.rank)],
    [labelLayer(t.rank),
      ['all', rankIs(t.rank), primary] as ExpressionSpecification],
  ])),
  'station-positions': ['all', ['>', ['get', 'lineCount'], 0], ['==', ['get', 'pill'], 1]],
};

function stationLayers(): LayerSpecification[] {
  const layers: LayerSpecification[] = [];

  // Rank still shows through below the changeover: a long-distance stop is a
  // little larger than the interchange beside it, as it is on the poster.
  const dotRadius: ExpressionSpecification = [
    'interpolate', ['linear'], ['zoom'],
    6, ['case', rankIs(0), 1.9, 1.5],
    9, ['case', rankIs(0), 2.9, 2.3],
    // Meets the bar's own thickness exactly, so the changeover only widens.
    PILL_FULL, PILL_THICKNESS / 2,
  ] as ExpressionSpecification;

  // Placement runs from the top layer down, so a tier pushed later is placed
  // earlier and wins its collisions. Ranks therefore go out backwards: rank 0
  // ends up last, which makes it both the first placed and the last painted.
  for (const tier of [...STOP_TIERS].sort((a, b) => b.rank - a.rank)) {
    if (tier.mark < PILL_FULL) {
      layers.push({
        id: dotLayer(tier.rank),
        type: 'circle',
        source: 'rail',
        'source-layer': 'stopmarks',
        minzoom: tier.mark,
        maxzoom: PILL_FULL,
        filter: rankIs(tier.rank),
        paint: {
          'circle-radius': dotRadius,
          'circle-color': LNVG.white,
          'circle-stroke-color': INK,
          'circle-stroke-width': [
            'interpolate', ['linear'], ['zoom'], 6, 0.7, PILL_FULL, 1.5,
          ] as ExpressionSpecification,
          'circle-opacity': fadeOut,
          'circle-stroke-opacity': fadeOut,
        },
      });
    }

    // Every bar of the tier. Below the changeover it is invisible and the dots
    // above are what is seen - but it is still placed, so it holds the space
    // its name will later need and city labels give it the room they always
    // did. It keeps drawing above the label zoom too, because a junction has a
    // bar per corridor and only one of them is the one that carries the name.
    layers.push({
      id: markLayer(tier.rank),
      type: 'symbol',
      source: 'rail',
      'source-layer': 'stopmarks',
      minzoom: tier.mark,
      filter: rankIs(tier.rank),
      layout: barLayout,
      paint: { 'icon-opacity': fadeIn },
    });

    // ...and, over the top of one of them, that same bar again with its name
    // attached. Drawn twice deliberately: a name is only ever kept off its own
    // bar by being placed *with* it, as one symbol, and the second copy of an
    // opaque white bar in the same place at the same size is invisible.
    const muted = tier.rank === 3;
    layers.push({
      id: labelLayer(tier.rank),
      type: 'symbol',
      source: 'rail',
      'source-layer': 'stopmarks',
      minzoom: tier.label,
      filter: STATION_FILTERS[labelLayer(tier.rank)],
      layout: {
        ...barLayout,
        'text-field': ['get', 'name'],
        'text-font': muted ? FONT_REGULAR : FONT_MEDIUM,
        'text-size': muted
          ? 11
          : ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 13] as ExpressionSpecification,
        'text-variable-anchor': ['left', 'right', 'top', 'bottom'],
        'text-radial-offset': nameOffset,
        'text-justify': 'auto',
        // A name that cannot be fitted is dropped; the stop it belongs to is
        // not. Losing the mark would be losing the fact that there is a stop.
        'text-optional': true,
      },
      paint: {
        'icon-opacity': fadeIn,
        // Trams get the quieter colour by tier; a coach bay of its own gets it
        // by being one, wherever it has been ranked. It is not a railway
        // station and is not named as loudly as one.
        'text-color': muted ? MUTED_INK
          : ['case', ['==', ['get', 'coachOnly'], 1], MUTED_INK, INK] as ExpressionSpecification,
        'text-halo-color': LNVG.ground,
        'text-halo-width': 1.6,
      },
    });
  }

  // --- and, at last, where the station actually is --------------------------
  // Held back to the zoom at which the difference is a fact about the place
  // rather than noise: which side of the tracks the entrance is on, how far the
  // platforms run. A hollow ring, so it reads as a position and not as a stop.
  layers.push({
    id: 'station-positions',
    type: 'circle',
    source: 'rail',
    'source-layer': 'stations',
    minzoom: TRUE_POSITION_ZOOM,
    filter: STATION_FILTERS['station-positions'],
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'], TRUE_POSITION_ZOOM, 2.4, 18, 4,
      ] as ExpressionSpecification,
      'circle-opacity': 0,
      'circle-stroke-color': INK,
      'circle-stroke-width': 1.3,
      'circle-stroke-opacity': [
        'interpolate', ['linear'], ['zoom'], TRUE_POSITION_ZOOM, 0, TRUE_POSITION_ZOOM + 0.6, 0.8,
      ] as ExpressionSpecification,
    },
  });

  return layers;
}

// ---------------------------------------------------------------------------
// Construction closures
//
// These are an overlay, not part of the network: they sit above the route bands
// so they can be seen against them, and below the stations, which are the map's
// anchors and must not be buried under a possession.
//
// The mark is a hazard stripe - a dark line with the reference palette's yellow
// dashed over it - rather than another coloured band. It has to read as "not a
// service" at a glance, and every solid colour on this map already means a line
// of some kind. Nothing is drawn on the true alignment except this, so a
// closure sits in the middle of whatever bundle it interrupts.
// ---------------------------------------------------------------------------

/**
 * A full closure or a line down to one track is the thing the layer exists for
 * and shows from the zoom the regional network appears at. The rest - a
 * timetable deviation, a few minutes of extra running time, an unspecified
 * restriction - is real but minor, and the 1,900 of them in an ordinary day's
 * feed, drawn across Germany at national zoom, would bury the network they
 * annotate. They wait until the view
 * is close enough for them to be about somewhere.
 */
export const CLOSURE_TIERS = {
  major: { effects: ['closed', 'single-track'], minzoom: 6, weight: 1 },
  minor: { effects: ['diverted', 'slower', 'other'], minzoom: 10, weight: 0.62 },
} as const;

/**
 * Closure width, which deliberately does not follow the route weight curve.
 *
 * Around 500 sections of the German network are closed outright on an ordinary
 * day and another 280 are down to one track - not a quirk of one reading, and
 * their median spell in effect is seven hours, so they cannot be filtered down
 * to a handful of "real" ones without lying about the rest. Drawn at the route
 * bands' weight, that many stripes at national zoom bury the network they are
 * annotating: the map stops being a rail map with construction on it and
 * becomes a construction map.
 *
 * So the stripe is thinner than a route band while the whole country is on
 * screen - enough to read where the work is concentrated, not enough to
 * compete - and grows past the bands only once the view is close enough for one
 * closure to be about one place.
 */
const CLOSURE_WIDTH_STOPS: [number, number][] = [
  [5, 1.2], [8, 2.4], [11, 5.0], [14, 8.0],
];

const closureWidth = (weight: number): ExpressionSpecification =>
  ['interpolate', ['linear'], ['zoom'],
    ...CLOSURE_WIDTH_STOPS.flatMap(([z, px]) => [z, px * weight]),
  ] as ExpressionSpecification;

export type ClosureTier = keyof typeof CLOSURE_TIERS;

/** Every closure layer, in draw order - for visibility toggling. */
export const CLOSURE_LAYER_IDS = (Object.keys(CLOSURE_TIERS) as ClosureTier[])
  .flatMap((tier) => [
    `closures-${tier}-casing`, `closures-${tier}-hazard`, `closures-${tier}-point`,
  ]);

/** Layers a click should hit-test - the visible marks, not the casings. */
export const CLOSURE_HIT_LAYER_IDS = (Object.keys(CLOSURE_TIERS) as ClosureTier[])
  .flatMap((tier) => [`closures-${tier}-hazard`, `closures-${tier}-point`]);

const HAZARD_DARK = '#2b2b2b';

function closureLayers(): LayerSpecification[] {
  return (Object.keys(CLOSURE_TIERS) as ClosureTier[]).flatMap((tier) => {
    const { effects, minzoom, weight } = CLOSURE_TIERS[tier];
    const width = closureWidth(weight);
    const ofTier: ExpressionSpecification =
      ['in', ['get', 'effect'], ['literal', [...effects]]];
    // A circle layer draws one circle per *vertex*, so without this the marker
    // layer beads every routed closure along its own geometry - which reads as
    // a row of stations that are not there.
    const lines: ExpressionSpecification =
      ['all', ofTier, ['!=', ['geometry-type'], 'Point']];
    const points: ExpressionSpecification =
      ['all', ofTier, ['==', ['geometry-type'], 'Point']];

    return [
      {
        id: `closures-${tier}-casing`,
        type: 'line',
        source: 'rail',
        'source-layer': 'closures',
        minzoom,
        filter: lines,
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: { 'line-color': HAZARD_DARK, 'line-width': width },
      },
      {
        // The stripes. `line-dasharray` is in multiples of the line width, so
        // the pattern keeps its proportions as the width grows with zoom
        // instead of turning into a solid line at one end of the range. A dash
        // longer than it is wide survives the thin end of that range, where a
        // square one aliases into a dotted grey.
        id: `closures-${tier}-hazard`,
        type: 'line',
        source: 'rail',
        'source-layer': 'closures',
        minzoom,
        filter: lines,
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': LNVG.yellow,
          'line-width': width,
          'line-dasharray': [1.6, 1.2],
        },
      },
      {
        // 43% of a day's restrictions are inside one station and have no
        // extent to draw, so they get a mark rather than being left off.
        id: `closures-${tier}-point`,
        type: 'circle',
        source: 'rail',
        'source-layer': 'closures',
        minzoom,
        filter: points,
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'], 6, 1.6, 11, 3.4, 14, 5.4,
          ] as ExpressionSpecification,
          'circle-color': LNVG.yellow,
          'circle-stroke-color': HAZARD_DARK,
          'circle-stroke-width': [
            'interpolate', ['linear'], ['zoom'], 6, 0.8, 14, 2,
          ] as ExpressionSpecification,
        },
      },
    ];
  });
}

/**
 * The OpenStreetMap standard raster, the ground everything else is drawn on.
 *
 * Desaturated and half-transparent over the flat LNVG ground, so it reads as
 * context rather than as the map: the rail bands have to dominate, and OSM's
 * own colours - motorway orange, forest green - would otherwise argue with
 * them. Its labels are the map's place names too, which is why the style
 * carries none of its own.
 */
const osmRasterSource = () => ({
  type: 'raster' as const,
  tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  tileSize: 256,
  maxzoom: 19,
});

export interface StyleOptions {
  /** Base path the site is served from, e.g. "/OpenRailTransitmap/". */
  base: string;
}

export function buildStyle({ base }: StyleOptions): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    name: 'OpenRailTransitmap',
    glyphs: `${base}fonts/{fontstack}/{range}.pbf`,
    sources: {
      rail: { type: 'vector', url: `pmtiles://${base}tiles/rail.pmtiles` },
      osm: osmRasterSource(),
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': LNVG.ground } },
      {
        id: 'osm',
        type: 'raster',
        source: 'osm',
        paint: { 'raster-opacity': 0.55, 'raster-saturation': -0.7 },
      },
    ],
  };

  // Symbol placement priority runs from the *top* layer down, so whatever is
  // pushed last wins collisions. Station names matter more than repeated line
  // badges, so the badge layer goes underneath them.
  style.layers.push(...routeLayers(), badgeLayer(), ...closureLayers(), ...stationLayers());
  return style;
}

/** Layer ids that carry per-line features, for filtering and feature-state. */
export const ROUTE_LAYER_IDS = [
  ...MODES.map((m) => `route-${m}`),
  ...MODES.map((m) => `route-${m}-highlight`),
  'route-badges',
];

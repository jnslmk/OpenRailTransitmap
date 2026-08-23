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
import { LNVG, MODES, MODE_SPECS, PT_TO_PX, type Mode } from '../shared/lnvg.ts';

export const FONT_REGULAR = ['Fira Sans Regular'];
export const FONT_MEDIUM = ['Fira Sans Medium'];
export const FONT_BOLD = ['Fira Sans Bold'];

/** Bundle pitch: one nominal band width, so mixed-mode bundles stay aligned. */
const PITCH_PT = MODE_SPECS.regional.weightPt;

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
 * Perpendicular displacement for one band of a bundle. `offset` is centred
 * (…-1, 0, 1…) so a bundle straddles the true alignment rather than growing
 * to one side. 1.02 leaves a hairline between bands.
 *
 * A data expression inside the stop outputs is allowed; only `zoom` itself is
 * constrained to the top level.
 */
const bandOffset: ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'],
  ...OFFSET_STOPS.flatMap(([z, f]) => [
    z, ['*', ['get', 'offset'], PITCH_PT * PT_TO_PX * 1.02 * f],
  ]),
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
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
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
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
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

// Tram stops outnumber rail stations by an order of magnitude, so they are
// held back to high zoom rather than being allowed to swamp the network. A
// coach stop that is not also a station - a ZOB, an airport forecourt - is held
// back for the same reason and one better: it is not a railway station at all,
// and drawing it as one at national zoom would misdescribe the network.
//
// `!= 1` rather than `== 0` on coachOnly, deliberately: a tile built before this
// property existed carries no value for it, and `null == 0` is false, which
// would empty the station layer against any tile set older than this style.
const isRail: ExpressionSpecification =
  ['all',
    ['>', ['get', 'lineCount'], 0],
    ['==', ['get', 'tramOnly'], 0],
    ['!=', ['get', 'coachOnly'], 1],
  ];
const isTram: ExpressionSpecification =
  ['all', ['>', ['get', 'lineCount'], 0], ['==', ['get', 'tramOnly'], 1]];
const isCoach: ExpressionSpecification =
  ['all', ['>', ['get', 'lineCount'], 0], ['==', ['get', 'coachOnly'], 1]];

/** Station layers and the base filter each one is built with. */
export const STATION_FILTERS: Record<string, ExpressionSpecification> = {
  stations: isRail,
  'station-labels': isRail,
  'stations-tram': isTram,
  'station-labels-tram': isTram,
  'stations-coach': isCoach,
  'station-labels-coach': isCoach,
};

/**
 * Stations that at least one of `modes` calls at.
 *
 * A station carries `lines` - the comma-joined ids of the lines serving it -
 * and an id is `mode|network|ref`, so a substring test for `mode|` is enough to
 * tell which modes stop there without shipping a second property. Without this
 * the stop dots and their names survived a mode being switched off, which left
 * a place like Braunschweig looking untouched when the trams were hidden.
 */
export function servedByModes(modes: Mode[]): ExpressionSpecification {
  return ['any', ...modes.map((m) =>
    ['>=', ['index-of', `${m}|`, ['to-string', ['get', 'lines']]], 0],
  )] as ExpressionSpecification;
}

function stationLayers(): LayerSpecification[] {
  // Interchanges are the map's anchors, so they get the larger white-filled
  // symbol; ordinary halts stay small ticks.
  const radius: ExpressionSpecification = [
    'interpolate', ['linear'], ['zoom'],
    7, ['case', ['>=', ['get', 'lineCount'], 3], 2.6, 1.4],
    11, ['case', ['>=', ['get', 'lineCount'], 3], 5.0, 3.0],
    14, ['case', ['>=', ['get', 'lineCount'], 3], 7.5, 4.5],
  ];

  const circlePaint = {
    'circle-radius': radius,
    'circle-color': LNVG.white,
    'circle-stroke-color': '#1a1a1a',
    'circle-stroke-width': [
      'interpolate', ['linear'], ['zoom'], 7, 0.7, 14, 1.8,
    ] as ExpressionSpecification,
  };

  return [
    {
      id: 'stations-tram',
      type: 'circle',
      source: 'rail',
      'source-layer': 'stations',
      minzoom: 12,
      filter: isTram,
      paint: circlePaint,
    },
    {
      id: 'stations-coach',
      type: 'circle',
      source: 'rail',
      'source-layer': 'stations',
      minzoom: 8,
      filter: isCoach,
      paint: circlePaint,
    },
    {
      id: 'stations',
      type: 'circle',
      source: 'rail',
      'source-layer': 'stations',
      minzoom: 7,
      filter: isRail,
      paint: circlePaint,
    },
    {
      id: 'station-labels-coach',
      type: 'symbol',
      source: 'rail',
      'source-layer': 'stations',
      minzoom: 10,
      filter: isCoach,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': FONT_REGULAR,
        'text-size': 11,
        'text-anchor': 'left',
        'text-offset': [0.6, 0],
      },
      paint: {
        'text-color': '#5a5a5a',
        'text-halo-color': LNVG.ground,
        'text-halo-width': 1.4,
      },
    },
    {
      id: 'station-labels-tram',
      type: 'symbol',
      source: 'rail',
      'source-layer': 'stations',
      minzoom: 13,
      filter: isTram,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': FONT_REGULAR,
        'text-size': 11,
        'text-anchor': 'left',
        'text-offset': [0.6, 0],
      },
      paint: {
        'text-color': '#5a5a5a',
        'text-halo-color': LNVG.ground,
        'text-halo-width': 1.4,
      },
    },
    {
      id: 'station-labels',
      type: 'symbol',
      source: 'rail',
      'source-layer': 'stations',
      minzoom: 9,
      filter: isRail,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': FONT_MEDIUM,
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 13],
        'text-anchor': 'left',
        'text-offset': [0.7, 0],
        // Interchanges and Hauptbahnhöfe win label collisions.
        'symbol-sort-key': [
          '-', 0, ['+', ['get', 'lineCount'], ['*', 10, ['get', 'major']]],
        ] as ExpressionSpecification,
      },
      paint: {
        'text-color': '#1a1a1a',
        'text-halo-color': LNVG.ground,
        'text-halo-width': 1.6,
      },
    },
  ];
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

function baseLayers(): LayerSpecification[] {
  return [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': LNVG.ground },
    },
    // The sea comes from assembled coastline polygons, not from natural=water,
    // which contains no ocean at all (see pipeline/coastline.ts).
    {
      id: 'ocean',
      type: 'fill',
      source: 'base',
      'source-layer': 'ocean',
      paint: { 'fill-color': LNVG.paleBlue },
    },
    {
      id: 'water',
      type: 'fill',
      source: 'base',
      'source-layer': 'water',
      paint: { 'fill-color': LNVG.paleBlue },
    },
    {
      id: 'boundaries',
      type: 'line',
      source: 'base',
      'source-layer': 'boundaries',
      paint: {
        'line-color': LNVG.grey,
        'line-width': 1.1,
        'line-dasharray': [3, 2],
      },
    },
  ];
}

/**
 * City labels, appended last so they hold the highest symbol-placement priority.
 *
 * Placement runs from the top layer down, so when these sat at the bottom of the
 * style every rail label outranked them and Berlin, Hamburg and München lost
 * their labels to whichever village happened to be nearby.
 *
 * Major and minor are separate layers so the two can be zoom-gated apart: at
 * national zoom only the big cities appear, which is all there is room for.
 */
function placeLayers(): LayerSpecification[] {
  const MAJOR = 250000;

  // Lower sort keys are placed first, so negating population makes the largest
  // city win any collision.
  const byPopulation: ExpressionSpecification =
    ['-', 0, ['get', 'population']];

  const label = (id: string, size: ExpressionSpecification): SymbolLayerSpecification => ({
    id,
    type: 'symbol',
    source: 'base',
    'source-layer': 'places',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': FONT_REGULAR,
      'text-size': size,
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.08,
      'text-padding': 6,
      'symbol-sort-key': byPopulation,
    },
    paint: {
      'text-color': '#8a8a8a',
      'text-halo-color': LNVG.ground,
      'text-halo-width': 1.5,
    },
  });

  const major = label('places-major',
    ['interpolate', ['linear'], ['zoom'], 4, 10, 8, 13, 11, 15]);
  major.minzoom = 4;
  major.maxzoom = 11;
  major.filter = ['>=', ['get', 'population'], MAJOR];

  const minor = label('places-minor',
    ['interpolate', ['linear'], ['zoom'], 7, 9, 10, 12]);
  minor.minzoom = 7;
  minor.maxzoom = 10;
  minor.filter = ['<', ['get', 'population'], MAJOR];

  return [major, minor];
}

/**
 * Zoom at which the street underlay starts to fade in.
 *
 * The vector basemap carries water, borders and place labels and nothing else,
 * so once you are close enough to read tram stop names there is no context left
 * to place them against. Streets come from the OSM standard raster rather than
 * the pipeline: Germany's highway network at this zoom is orders of magnitude
 * larger than the whole rail extract and could not be tiled nightly. Gating it
 * to the top two zoom levels keeps the request volume off that tile server for
 * ordinary browsing of the network.
 */
const STREETS_MINZOOM = 13;

const osmRasterSource = () => ({
  type: 'raster' as const,
  tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  tileSize: 256,
  maxzoom: 19,
});

export interface StyleOptions {
  /** Base path the site is served from, e.g. "/OpenRailTransitmap/". */
  base: string;
  /** Draw the OSM standard raster underneath instead of the flat LNVG ground. */
  osmBasemap: boolean;
  /** Fade the OSM raster in at high zoom for street-level context. */
  streets: boolean;
}

export function buildStyle({ base, osmBasemap, streets }: StyleOptions): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    name: 'OpenRailTransitmap',
    glyphs: `${base}fonts/{fontstack}/{range}.pbf`,
    sources: {
      base: { type: 'vector', url: `pmtiles://${base}tiles/base.pmtiles` },
      rail: { type: 'vector', url: `pmtiles://${base}tiles/rail.pmtiles` },
    },
    layers: [],
  };

  if (osmBasemap) {
    style.sources.osm = osmRasterSource();
    style.layers = [
      { id: 'background', type: 'background', paint: { 'background-color': LNVG.ground } },
      // Desaturated so the rail bands still dominate.
      {
        id: 'osm',
        type: 'raster',
        source: 'osm',
        paint: { 'raster-opacity': 0.55, 'raster-saturation': -0.7 },
      },
    ];
  } else {
    style.layers = baseLayers();

    if (streets) {
      style.sources.osm = osmRasterSource();
      // Above the vector water and borders, below every rail layer.
      style.layers.push({
        id: 'streets',
        type: 'raster',
        source: 'osm',
        minzoom: STREETS_MINZOOM,
        paint: {
          'raster-opacity': [
            'interpolate', ['linear'], ['zoom'],
            STREETS_MINZOOM, 0,
            STREETS_MINZOOM + 1, 0.5,
            STREETS_MINZOOM + 2, 0.62,
          ],
          // Nearly grey: streets are there to locate a stop, not to be read.
          'raster-saturation': -0.85,
        },
      });
    }
  }

  // Symbol placement priority runs from the *top* layer down, so whatever is
  // pushed last wins collisions. Station names matter more than repeated line
  // badges, so the badge layer goes underneath them, and city labels sit above
  // both - they are the map's orientation anchors and there are few of them.
  style.layers.push(...routeLayers(), badgeLayer(), ...closureLayers(), ...stationLayers());

  // Place labels live in the vector basemap, which the raster mode replaces.
  if (!osmBasemap) style.layers.push(...placeLayers());
  return style;
}

/** Layer ids that carry per-line features, for filtering and feature-state. */
export const ROUTE_LAYER_IDS = [
  ...MODES.map((m) => `route-${m}`),
  ...MODES.map((m) => `route-${m}-highlight`),
  'route-badges',
];

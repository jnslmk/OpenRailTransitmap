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

  // Tram stops outnumber rail stations by an order of magnitude, so they are
  // held back to high zoom rather than being allowed to swamp the network.
  const isRail: ExpressionSpecification =
    ['all', ['>', ['get', 'lineCount'], 0], ['==', ['get', 'tramOnly'], 0]];
  const isTram: ExpressionSpecification =
    ['all', ['>', ['get', 'lineCount'], 0], ['==', ['get', 'tramOnly'], 1]];

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
      id: 'stations',
      type: 'circle',
      source: 'rail',
      'source-layer': 'stations',
      minzoom: 7,
      filter: isRail,
      paint: circlePaint,
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
  style.layers.push(...routeLayers(), badgeLayer(), ...stationLayers());

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

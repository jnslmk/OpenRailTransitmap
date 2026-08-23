import maplibregl, {
  Map as MLMap, Popup,
  type MapGeoJSONFeature, type ExpressionSpecification,
} from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';

import { LNVG, MODES, MODE_SPECS, textOn, type Mode } from '../shared/lnvg.ts';
import {
  buildStyle, selectionOpacity, highlightOpacity, servedByModes, STATION_FILTERS,
  STOP_MARK_LAYERS, CLOSURE_LAYER_IDS, CLOSURE_HIT_LAYER_IDS,
} from './style.ts';
import { registerPillImages } from './stopmarks.ts';
import { readState, writeState, type ViewState, type ChromeMode, type Tab } from './state.ts';
import { t } from './strings.ts';
import {
  renderChrome, renderLinePanel, renderClosurePanel, setStatus, compareLines,
  syncSheetHandle, setVisibleModes, unpinModes, setLiveAttributionUsed,
  setVisibleLines, setLinePunctuality, setPunctualityAttributionUsed,
  setVisibleClosures, setClosureDay, setClosureAttributionUsed,
  setCoachAttributionUsed, setRoutingAttributionUsed,
} from './ui.ts';
import { setPlannerPlace, restorePlannerResult, type PlannerHost } from './planner.ts';
import type { Itinerary, Leg, Place } from './routing.ts';
import { ChromeToggleControl, labelControls } from './controls.ts';
import { fetchDepartures, LiveDataError, type Departure } from './live.ts';
import { loadPunctuality } from './punctuality.ts';
import { parseClosure } from './closures.ts';
import './styles.css';

/** Vite injects the Pages sub-path here; ensures tile/glyph URLs resolve. */
const BASE = import.meta.env.BASE_URL;

export interface LineRecord {
  id: string; ref: string; name: string; mode: Mode; colour: string;
  colourSource: string; operator: string; network: string;
  stops: number; ways: number;
}
export interface Registry {
  region: string; regionName: string;
  counts: { lines: number; stations: number; byMode: Record<string, number> };
  colourCoverage: { osmTagged: number; total: number };
  lines: LineRecord[];
}

async function main() {
  maplibregl.addProtocol('pmtiles', new Protocol().tile);

  const registry: Registry = await fetch(`${BASE}lines.json`).then((r) => r.json());
  const byId = new Map(registry.lines.map((l) => [l.id, l]));

  const initial = { center: [9.73, 52.63] as [number, number], zoom: 7 };
  const state: ViewState = readState(initial);
  // Before the map is constructed, so it measures the final container size.
  applyChromeClasses();

  const map = new MLMap({
    container: 'map',
    style: buildStyle({ base: BASE, osmBasemap: state.osmBasemap, streets: state.streets }),
    center: state.center,
    zoom: state.zoom,
    // Far enough in that a platform is a platform: from z16 the map stops
    // pretending the stop mark is the station and draws where the station
    // actually is, beside the mark that stands for its lines.
    maxZoom: 18,
    minZoom: 4,
    attributionControl: false,
  });

  // The station marks are bars of arbitrary length, so they are images rather
  // than a primitive, drawn on demand. Registered before anything renders, and
  // once only: the handler survives the setStyle a basemap toggle does.
  registerPillImages(map);

  // --- map chrome -----------------------------------------------------------

  const chromeToggle = new ChromeToggleControl(
    () => state.chrome === 'hidden',
    // Hiding and showing returns to whatever fold the sheet was left at.
    () => setChrome(state.chrome === 'hidden' ? lastVisible : 'hidden'),
  );
  map.addControl(chromeToggle, 'top-left');

  let lastVisible: ChromeMode = state.chrome === 'hidden' ? 'full' : state.chrome;

  function applyChromeClasses() {
    document.body.classList.toggle('chrome-hidden', state.chrome === 'hidden');
    document.body.classList.toggle('sheet-collapsed', state.chrome === 'peek');
  }

  function setChrome(mode: ChromeMode) {
    state.chrome = mode;
    if (mode !== 'hidden') lastVisible = mode;
    applyChromeClasses();
    chromeToggle.sync();
    syncSheetHandle(mode === 'peek');
    // The sidebar is a flex sibling, so folding it changes the canvas size.
    map.resize();
    persist();
  }

  const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserLocation: true,
    showAccuracyCircle: true,
  });
  map.addControl(geolocate, 'bottom-right');
  geolocate.on('error', (e: GeolocationPositionError) => {
    setStatus(e?.code === 1 ? t().locateDenied : t().locateError);
  });

  // The compass doubles as the reset: a two-finger twist is easy to trigger by
  // accident on a phone, and clicking it puts the map back to north-up.
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');
  if (document.fullscreenEnabled) {
    // Fullscreen the whole document, not just the canvas: the detail panel and
    // the status toast live outside the map container and would be hidden.
    map.addControl(new maplibregl.FullscreenControl({ container: document.body }), 'bottom-right');
  }
  const OSM_ATTRIBUTION =
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)';
  let attribution = new maplibregl.AttributionControl({ compact: true, customAttribution: OSM_ATTRIBUTION });
  map.addControl(attribution, 'bottom-right');
  collapseAttribution();

  /**
   * A compact attribution control expands itself the moment it is added, which
   * on a phone means the credits cover a third of the map on every page load
   * until they are tapped away. Collapse it back to the "i" button.
   *
   * The state written here is the one the control's own toggle leaves behind
   * when it closes - `open` on the `<details>`, the `-show` class off - reached
   * through the DOM rather than through an underscore-prefixed method, for the
   * reason spelled out below. Doing it once after `addControl` is enough:
   * MapLibre only expands the control on the pass that first marks it compact,
   * so neither a resize nor a later source credit re-opens it.
   */
  function collapseAttribution() {
    const el = map.getContainer()
      .querySelector('.maplibregl-ctrl-attrib.maplibregl-compact');
    if (!el) return;
    el.setAttribute('open', '');
    el.classList.remove('maplibregl-compact-show');
  }

  /**
   * Credits beyond OSM are added only once the data behind them is actually on
   * screen, not unconditionally - a build that never resolves a `stopId` has no
   * departures to credit, and a checkout with no closure tiles has no
   * construction data to credit either.
   *
   * `AttributionControl` has no supported way to change its own
   * `customAttribution` after construction and force a re-render - mutating
   * `options.customAttribution` in place only takes effect on the control's own
   * `sourcedata`/`styledata`/`terrain` listeners, none of which a station click
   * guarantees. So the control is dropped and rebuilt with the full set of
   * credits earned so far: `removeControl`/`addControl` are the public, stable
   * API MapLibre offers for changing what a control shows, unlike reaching into
   * `_updateAttributions()` (underscore-prefixed, not in the public surface, and
   * free to disappear on any `^5.0.0` bump with no compiler warning).
   *
   * Every earned credit is replayed on each rebuild, because a rebuilt control
   * starts empty - which is exactly what made this one function rather than one
   * copy of it per source.
   */
  const earned = new Set<'live' | 'punctuality' | 'closures' | 'coach' | 'routing'>();

  function credit(source: 'live' | 'punctuality' | 'closures' | 'coach' | 'routing') {
    if (earned.has(source)) return;
    earned.add(source);
    const s = t();
    map.removeControl(attribution);
    attribution = new maplibregl.AttributionControl({
      compact: true,
      customAttribution: [
        OSM_ATTRIBUTION,
        ...(earned.has('live') ? [s.liveAttribution] : []),
        ...(earned.has('punctuality') ? [s.punctualityAttribution] : []),
        ...(earned.has('closures') ? [s.closureAttribution] : []),
        ...(earned.has('coach') ? [s.coachAttribution] : []),
        ...(earned.has('routing') ? [s.planAttribution] : []),
      ],
    });
    map.addControl(attribution, 'bottom-right');
    collapseAttribution();
  }

  function markLiveDataUsed() {
    credit('live');
    setLiveAttributionUsed();
  }
  labelControls();
  // MapLibre rewrites the fullscreen button's own title when it flips state.
  document.addEventListener('fullscreenchange', () => labelControls());

  // --- selection & filtering ------------------------------------------------

  /**
   * How loudly the network paints.
   *
   * A drawn itinerary needs the network behind it quietened, or the route
   * disappears into the corridor it runs along - but only while the planner is
   * the tab in front. Switch back to Explore and the network comes up again
   * with the journey still drawn over it, because the map is one map and the
   * tab is only which half of the sidebar is showing.
   */
  function routeOpacity(): number | ExpressionSpecification {
    if (state.selected) return selectionOpacity(state.selected);
    return shownItinerary && state.tab === 'plan' ? 0.22 : 1;
  }

  function applySelection() {
    for (const mode of MODES) {
      map.setPaintProperty(`route-${mode}`, 'line-opacity', routeOpacity());
      map.setPaintProperty(`route-${mode}-highlight`, 'line-opacity', highlightOpacity(state.selected));
    }
    map.setPaintProperty('route-badges', 'text-opacity', routeOpacity());
    const line = state.selected ? byId.get(state.selected) ?? null : null;
    renderLinePanel(line, { onClose: () => select(null) });
    if (line) showPunctuality(line.id);
  }

  /**
   * The score file is fetched on the first selection and cached by
   * punctuality.ts, so this is a no-op read on every selection after it. The
   * guard is against the first one: the panel may have moved on to another
   * line - or closed - while the file was in flight, and a late response must
   * not paint one line's record under another line's name.
   */
  function showPunctuality(lineId: string) {
    loadPunctuality(BASE).then((file) => {
      if (state.selected !== lineId) return;
      const score = file?.lines[lineId] ?? null;
      setLinePunctuality(lineId, score, file);
      if (score) markPunctualityUsed();
    });
  }

  /**
   * The delay data's CC BY 4.0 licence wants Deutsche Bahn credited on the map
   * itself, not only in the sidebar.
   */
  function markPunctualityUsed() {
    credit('punctuality');
    setPunctualityAttributionUsed();
  }

  /**
   * The construction plan is DB InfraGO's, published as information rather than
   * under an open licence, so it is credited wherever it is drawn. Unlike the
   * other two this is earned by the map painting a frame with closures in it
   * rather than by a click, since the overlay is on screen before anyone
   * touches it.
   */
  function markClosuresUsed() {
    credit('closures');
    setClosureAttributionUsed();
  }

  /**
   * FlixBus publishes its GTFS without a licence attached, so the operator is
   * credited whenever a line built from it is on screen. Earned off the legend
   * count rather than a click, for the same reason closures are: the coach
   * layer is drawn before anyone interacts with it.
   */
  function markCoachUsed() {
    credit('coach');
    setCoachAttributionUsed();
  }

  /** Transitous asks for visible credit while its data is on screen. A drawn
   *  itinerary is its data as much as a departure board is. */
  function markRoutingUsed() {
    credit('routing');
    setRoutingAttributionUsed();
  }

  /**
   * Which closure, if any, currently owns the detail panel. A closure and a
   * line cannot both own it, and this is what tells the two apart afterwards:
   * without it, closing the closure panel could not know whether to leave the
   * slot empty or hand it back to a line that was never deselected.
   */
  let shownClosure: string | null = null;

  /**
   * The construction overlay is one visibility switch across all six of its
   * layers, not a data filter: what it hides is a whole annotation, and there
   * is nothing to keep on screen dimmed. Closing the panel with it is the same
   * reasoning as dropping a line selection when its mode is switched off - a
   * panel describing something the reader can no longer see is a dead end.
   */
  function applyClosures() {
    for (const id of CLOSURE_LAYER_IDS) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', state.closures ? 'visible' : 'none');
      }
    }
    if (!state.closures && shownClosure) closeClosure();
    legendKey = '';
    persist();
  }

  function applyFilters() {
    for (const mode of MODES) {
      const on = state.modes.has(mode);
      for (const id of [`route-${mode}`, `route-${mode}-highlight`]) {
        map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      }
    }
    // Operator is a data-driven filter rather than a layer toggle.
    const modeFilter: unknown[] = ['in', ['get', 'mode'], ['literal', [...state.modes]]];
    const filter: unknown[] = state.operator
      ? ['all', modeFilter, ['==', ['get', 'operator'], state.operator]]
      : modeFilter;
    map.setFilter('route-badges', filter as never);

    if (state.operator) {
      for (const mode of MODES) {
        map.setFilter(`route-${mode}`, [
          'all', ['==', ['get', 'mode'], mode], ['==', ['get', 'operator'], state.operator],
        ] as never);
      }
    } else {
      for (const mode of MODES) {
        map.setFilter(`route-${mode}`, ['==', ['get', 'mode'], mode] as never);
      }
    }

    // Stations follow the mode filter too. Without this the stop dots and their
    // names stayed put when a mode was switched off, so switching one off often
    // looked as though nothing had happened at all.
    const served = servedByModes([...state.modes]);
    for (const [id, base] of Object.entries(STATION_FILTERS)) {
      map.setFilter(id, ['all', base, served] as never);
    }

    // Not refreshLegend() here: the layers have changed but nothing has been
    // drawn yet, so a query now returns the old frame. Drop the guard instead
    // and let the `idle` that follows the redraw do the counting.
    legendKey = '';
    persist();
  }

  /**
   * The legend lists what is on screen, so it is recomputed whenever the view
   * settles. `idle` fires once per settled view rather than per frame, and the
   * signature guard drops the repeats that survive that (a resize, a hover).
   */
  let legendKey = '';

  function refreshLegend() {
    const layers = MODES.map((m) => `route-${m}`).filter((id) => map.getLayer(id));
    if (!layers.length) return;

    const c = map.getCenter();
    const key = `${c.lng.toFixed(3)}/${c.lat.toFixed(3)}/${map.getZoom().toFixed(2)}/` +
      `${[...state.modes].sort().join(',')}/${state.operator ?? ''}/${state.closures}`;
    if (key === legendKey) return;
    legendKey = key;

    countClosures();

    // Count distinct lines, not features: one line is many tile segments.
    const lines = new Map<Mode, Set<string>>();
    const ids = new Set<string>();
    for (const f of map.queryRenderedFeatures({ layers })) {
      const mode = f.properties.mode as Mode;
      const id = String(f.properties.line);
      const set = lines.get(mode) ?? new Set<string>();
      set.add(id);
      lines.set(mode, set);
      ids.add(id);
    }
    setVisibleModes(new Map([...lines].map(([mode, set]) => [mode, set.size])));
    setVisibleLines(ids);
    if (lines.get('coach')?.size) markCoachUsed();
  }

  /**
   * Closures in view, counted by id rather than by feature: one possession can
   * be several tile segments, and a section split across a tile boundary would
   * otherwise read as two.
   *
   * This is also where the construction credit is earned, because the overlay
   * arrives with the map rather than with a click, and where the day the
   * overlay describes is read off the first feature - it is the same for all of
   * them, being a property of the build.
   */
  function countClosures() {
    const layers = CLOSURE_HIT_LAYER_IDS.filter((id) => map.getLayer(id));
    if (!layers.length || !state.closures) { setVisibleClosures(0); return; }

    const ids = new Set<string>();
    for (const f of map.queryRenderedFeatures({ layers })) {
      ids.add(String(f.properties.id));
    }
    setVisibleClosures(ids.size);
    if (ids.size) markClosuresUsed();
  }

  map.on('idle', refreshLegend);

  /**
   * Basemap and street underlay are style-level choices, so both go through a
   * full rebuild. The sidebar is redrawn with it: the basemap chips and the
   * street checkbox read their state at draw time.
   */
  function rebuildStyle() {
    map.setStyle(buildStyle({ base: BASE, osmBasemap: state.osmBasemap, streets: state.streets }));
    map.once('styledata', () => {
      applyFilters(); applyClosures(); ensureItineraryLayers(); applySelection();
    });
    renderChrome.rerender();
    persist();
  }

  function select(id: string | null) {
    state.selected = id;
    applySelection();
    persist();
  }

  const persist = () => writeState(state);

  // --- the planned journey on the map ---------------------------------------
  //
  // The thing only this map can do. Google draws a generic blue snake; here a
  // transit leg is painted in the colour the network underneath is already
  // painted in, so an itinerary reads as a path *through* the map rather than
  // as an overlay on top of one.

  const ITINERARY_SOURCE = 'itinerary';
  const NO_ITINERARY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
  const BIKE_LEG_MODES = new Set(['BIKE', 'RENTAL', 'BIKE_RENTAL']);
  let shownItinerary: Itinerary | null = null;

  /**
   * The map's own colour for a line the planner names.
   *
   * Keyed on the normalised ref, and *only* where that ref is unambiguous
   * across the whole registry. Twenty-two German lines are called "S1"; the
   * departure board can disambiguate because it knows which station it is
   * standing at, and this cannot, so where a ref maps to more than one colour
   * the honest answer is none and the feed's own colour is used instead.
   */
  const unambiguousRefColours = (() => {
    const byRef = new Map<string, Set<string>>();
    for (const l of registry.lines) {
      const k = lineKey(l.ref);
      const set = byRef.get(k);
      if (set) set.add(l.colour); else byRef.set(k, new Set([l.colour]));
    }
    const out = new Map<string, string>();
    for (const [k, colours] of byRef) if (colours.size === 1) out.set(k, [...colours][0]);
    return out;
  })();

  const legColour = (leg: Leg): string | null =>
    (leg.line ? unambiguousRefColours.get(lineKey(leg.line)) ?? null : null);

  function itineraryData(it: Itinerary | null): GeoJSON.FeatureCollection {
    if (!it) return NO_ITINERARY;
    const features: GeoJSON.Feature[] = [];

    for (const leg of it.legs) {
      if (leg.path.length < 2) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: leg.path },
        properties: {
          kind: leg.transit ? 'transit' : BIKE_LEG_MODES.has(leg.mode) ? 'bike' : 'walk',
          colour: leg.transit ? (legColour(leg) ?? leg.colour ?? '#1a1a1a') : '#1a1a1a',
        },
      });
    }

    // A dot at every leg boundary - which is every place the rider changes
    // from one thing to another - and a larger one at each end of the journey.
    it.legs.forEach((leg, i) => {
      if (i === 0) return;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [leg.from.lon, leg.from.lat] },
        properties: { kind: 'change' },
      });
    });
    const first = it.legs[0];
    const last = it.legs[it.legs.length - 1];
    for (const p of [first?.from, last?.to]) {
      if (p) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          properties: { kind: 'end' },
        });
      }
    }
    return { type: 'FeatureCollection', features };
  }

  const itineraryWidth = (scale: number): ExpressionSpecification =>
    ['interpolate', ['linear'], ['zoom'], 5, 2.5 * scale, 11, 5 * scale, 15, 8 * scale];

  /**
   * Added after the style rather than inside it, because the style is rebuilt
   * whenever the basemap or the street underlay changes and these layers must
   * survive that - `styledata` calls this again and it is idempotent.
   */
  function ensureItineraryLayers() {
    if (!map.getSource(ITINERARY_SOURCE)) {
      map.addSource(ITINERARY_SOURCE, {
        type: 'geojson', data: itineraryData(shownItinerary),
      });
    }
    if (map.getLayer('itinerary-casing')) return;

    map.addLayer({
      id: 'itinerary-casing',
      type: 'line',
      source: ITINERARY_SOURCE,
      filter: ['==', ['geometry-type'], 'LineString'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': LNVG.white, 'line-width': itineraryWidth(2.1), 'line-opacity': 0.9 },
    });
    map.addLayer({
      id: 'itinerary-street',
      type: 'line',
      source: ITINERARY_SOURCE,
      filter: ['!=', ['get', 'kind'], 'transit'],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': '#1a1a1a',
        'line-width': itineraryWidth(0.8),
        // Dashed, because a bike or a walk is not a service: it is the rider
        // getting themselves between two that are.
        'line-dasharray': [1.6, 1.6],
      },
    });
    map.addLayer({
      id: 'itinerary-transit',
      type: 'line',
      source: ITINERARY_SOURCE,
      filter: ['==', ['get', 'kind'], 'transit'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'colour'] as ExpressionSpecification,
        'line-width': itineraryWidth(1),
      },
    });
    map.addLayer({
      id: 'itinerary-changes',
      type: 'circle',
      source: ITINERARY_SOURCE,
      filter: ['==', ['get', 'kind'], 'change'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 11, 4.5, 15, 6],
        'circle-color': LNVG.white,
        'circle-stroke-color': '#1a1a1a',
        'circle-stroke-width': 1.6,
      },
    });
    map.addLayer({
      id: 'itinerary-ends',
      type: 'circle',
      source: ITINERARY_SOURCE,
      filter: ['==', ['get', 'kind'], 'end'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4, 11, 6.5, 15, 8.5],
        'circle-color': '#1a1a1a',
        'circle-stroke-color': LNVG.white,
        'circle-stroke-width': 2,
      },
    });
  }

  function drawItinerary(it: Itinerary | null) {
    shownItinerary = it;
    ensureItineraryLayers();
    const source = map.getSource(ITINERARY_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData(itineraryData(it));
    applySelection();
    if (it) fitItinerary(it);
  }

  /** Bring the whole journey into view, the way picking a route out of a list should. */
  function fitItinerary(it: Itinerary) {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const leg of it.legs) {
      for (const [lon, lat] of leg.path) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
    }
    if (!Number.isFinite(west)) return;
    map.fitBounds([[west, south], [east, north]], { padding: 48, maxZoom: 13, duration: 600 });
  }

  // --- interactions ---------------------------------------------------------

  const routeLayers = MODES.map((m) => `route-${m}`);
  const STATION_LAYERS = [...STOP_MARK_LAYERS, 'station-positions'];
  const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 10 });

  // A slow departures response must never paint into a popup that has moved
  // on: `liveToken` identifies the request that is currently allowed to
  // write, and is bumped whenever the popup closes or another station is
  // clicked, which also aborts whatever was still in flight.
  let liveController: AbortController | null = null;
  let liveToken = 0;

  popup.on('close', () => {
    liveController?.abort();
    liveController = null;
    liveToken++;
  });

  /**
   * Hit-test order is station, then closure, then route, and it follows how
   * specific the mark is: a station dot is the smallest thing on the map and
   * has to stay clickable where a closure crosses it, and a closure is drawn
   * over the bundle it interrupts, so a click landing on the stripes means the
   * stripes rather than whichever band happens to be underneath.
   */
  const clickable = () => [
    ...STATION_LAYERS,
    ...CLOSURE_HIT_LAYER_IDS.filter((id) => map.getLayer(id)),
    ...routeLayers,
  ];

  map.on('click', (e) => {
    const hits = map.queryRenderedFeatures(e.point, { layers: clickable() });
    const station = hits.find((f) => STATION_LAYERS.includes(f.layer.id));
    if (station) { showStation(station); return; }

    const closure = hits.find((f) => CLOSURE_HIT_LAYER_IDS.includes(f.layer.id));
    if (closure) { showClosure(closure); return; }

    // Only now is a bare click on the map a change of line selection - and a
    // click on nothing at all clears it, as it always has.
    closeClosure();
    const route = hits.find((f) => routeLayers.includes(f.layer.id));
    select(route ? String(route.properties.line) : null);
  });

  map.on('mousemove', (e) => {
    const hits = map.queryRenderedFeatures(e.point, { layers: clickable() });
    map.getCanvas().style.cursor = hits.length ? 'pointer' : '';
  });

  function showClosure(f: MapGeoJSONFeature) {
    if (state.selected) select(null);
    const record = parseClosure(f.properties, f.geometry.type === 'Point');
    shownClosure = record.id;
    renderClosurePanel(record, { onClose: closeClosure });
  }

  function closeClosure() {
    if (!shownClosure) return;
    shownClosure = null;
    // Re-rendering the (empty) line panel is what closes the slot, and it also
    // restores a line panel if one is somehow still selected.
    applySelection();
  }

  /**
   * The station record behind a mark.
   *
   * A mark carries only what drawing it takes - the run of lines that bar
   * covers, and the name - because a junction has one per corridor and copying
   * a station's whole record onto each of them would be paid for in every tile.
   * The rest is read back out of the tiles that are already loaded: the mark is
   * on screen, so the station it belongs to is in one of them. If it somehow is
   * not, the mark's own properties are a working subset.
   */
  function stationOf(f: MapGeoJSONFeature): {
    p: Record<string, string>;
    at: [number, number];
  } {
    const mark = (f.geometry as GeoJSON.Point).coordinates as [number, number];
    const id = f.properties?.station;
    if (!id) return { p: f.properties as Record<string, string>, at: mark };
    const [hit] = map.querySourceFeatures('rail', {
      sourceLayer: 'stations',
      filter: ['==', ['get', 'id'], id],
    });
    if (!hit) return { p: f.properties as Record<string, string>, at: mark };
    return {
      p: hit.properties as Record<string, string>,
      // The station's own position, not the mark's, for anything that is about
      // the place rather than about the symbol - a journey planned from here
      // starts at the station, however far along the corridor its bar sits.
      at: (hit.geometry as GeoJSON.Point).coordinates as [number, number],
    };
  }

  function showStation(f: MapGeoJSONFeature) {
    const { p, at } = stationOf(f);
    const served = String(p.lines ?? '').split(',').filter(Boolean)
      .map((id) => byId.get(id)).filter((l): l is LineRecord => !!l)
      .sort(compareLines);

    const badges = served.map((l) =>
      `<button class="badge" data-line="${l.id}" style="background:${l.colour};color:${textOn(l.colour)}" title="${l.name}">${l.ref}</button>`,
    ).join('');

    // Departure badges are painted from the lines this station serves, so a
    // board sitting under the "lines serving this station" row uses the same
    // colour for the same line - the feed's own colour is only a fallback for
    // services the map does not draw (see Departure.colour).
    const stationColours = new Map(served.map((l) => [lineKey(l.ref), l.colour]));
    const colourOf = (d: Departure) => stationColours.get(lineKey(d.line)) ?? d.colour;

    const stopId = String(p.stopId ?? '');

    // Whatever departures request was in flight belongs to the popup that is
    // about to be replaced, whether or not the new station has its own
    // stopId - a click on a plain station must still cancel a slow fetch
    // from the previous one.
    liveController?.abort();
    liveController = null;
    liveToken++;

    const geom = f.geometry as GeoJSON.Point;
    popup
      .setLngLat(geom.coordinates as [number, number])
      .setHTML(`
        <div class="pop">
          <strong>${p.name}</strong>
          ${p.uic_ref ? `<span class="uic">UIC ${p.uic_ref}</span>` : ''}
          <div class="pop-lines-label">${t().servedBy}</div>
          <div class="pop-lines">${badges || '—'}</div>
          <div class="pop-actions">
            <button class="pop-action" data-dir="from">${t().planDirectionsFrom}</button>
            <button class="pop-action" data-dir="to">${t().planDirectionsTo}</button>
          </div>
          ${stopId ? '<div class="pop-live"></div>' : ''}
        </div>`)
      .addTo(map);

    popup.getElement()?.querySelectorAll<HTMLElement>('.badge').forEach((el) => {
      el.onclick = () => { select(el.dataset.line!); popup.remove(); };
    });

    // Turning a station you are looking at into one end of a journey is the
    // whole reason the planner lives inside the map rather than beside it.
    popup.getElement()?.querySelectorAll<HTMLElement>('.pop-action').forEach((el) => {
      el.onclick = () => {
        const [lon, lat] = at;
        const place: Place = {
          name: String(p.name ?? ''),
          lat,
          lon,
          // The resolved MOTIS id where the pipeline found one, so the router
          // plans from the stop itself rather than from a point near it.
          stopId: stopId || null,
          area: '',
          kind: stopId ? 'STOP' : 'PLACE',
        };
        popup.remove();
        if (state.chrome === 'hidden') setChrome(lastVisible);
        state.tab = 'plan';
        // Renders the Plan tab, which is what gives `setPlannerPlace` a host.
        renderChrome.rerender();
        setPlannerPlace(el.dataset.dir === 'to' ? 'to' : 'from', place);
        persist();
      };
    });

    // A station with no resolved stopId (most of them, until the pipeline
    // ships one) shows exactly what it always has - no departures section.
    const liveEl = stopId ? popup.getElement()?.querySelector<HTMLElement>('.pop-live') : null;
    if (liveEl) loadDepartures(liveEl, stopId, colourOf);
  }

  /** Fetches and renders the departure board into an already-open popup. */
  function loadDepartures(
    container: HTMLElement, stopId: string, colourOf: (d: Departure) => string | null,
  ) {
    // showStation already bumped liveToken and cleared liveController just
    // above, synchronously, so this read sees that same generation.
    const token = liveToken;
    const controller = new AbortController();
    liveController = controller;
    // The API has no timeout of its own; abort a request that never
    // resolves rather than leave the popup loading forever.
    const timer = window.setTimeout(() => controller.abort(), 8000);

    container.innerHTML = departuresSection(`<p class="muted">${t().loadingDepartures}</p>`);

    fetchDepartures(stopId, controller.signal)
      .then((departures) => {
        window.clearTimeout(timer);
        if (token !== liveToken) return; // superseded - popup has moved on
        // Built before marking anything "used": if a malformed entry makes
        // departureRow throw, this rejects and falls to .catch below instead
        // of crediting Transitous for a board that never actually rendered.
        const body = departures.length
          ? departures.map((d) => departureRow(d, colourOf(d))).join('')
          : `<p class="muted">${t().noDepartures}</p>`;
        markLiveDataUsed();
        container.innerHTML = departuresSection(body);
      })
      .catch((err: unknown) => {
        window.clearTimeout(timer);
        if (token !== liveToken) return;
        // Quiet degrade either way - the popup works without departures,
        // plus a brief note, no retry. But only a LiveDataError (a bad
        // status, a network failure, an unparseable body - see live.ts) or
        // our own timeout abort is an *expected* reason for this to fail.
        // Anything else is a bug in the render path, and swallowing it here
        // would make every future call look identical to "the API is down"
        // with nothing anywhere pointing at the real cause.
        const expected = err instanceof LiveDataError
          || (err instanceof DOMException && err.name === 'AbortError');
        if (!expected) console.error('[live] departures render failed unexpectedly:', err);
        container.innerHTML = departuresSection(`<p class="muted">${t().departuresUnavailable}</p>`);
      });
  }

  map.on('moveend', () => {
    const c = map.getCenter();
    state.center = [c.lng, c.lat];
    state.zoom = map.getZoom();
    // A legend row held open by a toggle belongs to the view it was toggled in.
    unpinModes();
    persist();
  });

  // --- chrome ---------------------------------------------------------------

  const plannerHost: PlannerHost = {
    state: state.plan,
    onItinerary: drawItinerary,
    legColour,
    persist,
    onRoutingUsed: markRoutingUsed,
  };

  renderChrome({
    registry,
    state,
    plannerHost,
    onTab: (tab: Tab) => {
      state.tab = tab;
      // The drawn journey survives the switch - see routeOpacity() - so this
      // only has to repaint the network at the volume the new tab wants.
      renderChrome.rerender();
      applySelection();
      persist();
    },
    onToggleMode: (mode: Mode, on: boolean) => {
      if (on) state.modes.add(mode); else state.modes.delete(mode);
      // Everything but the selected line paints dimmed, so a selection whose
      // own mode has just been switched off would leave the map greyed out
      // with nothing lit. Drop it with the mode that carried it.
      if (!on && state.selected && byId.get(state.selected)?.mode === mode) {
        state.selected = null;
        applySelection();
      }
      applyFilters();
    },
    onOperator: (op) => { state.operator = op; applyFilters(); },
    onBasemap: (osm) => { state.osmBasemap = osm; rebuildStyle(); },
    onStreets: (on) => { state.streets = on; rebuildStyle(); },
    onToggleClosures: (on) => { state.closures = on; applyClosures(); },
    onToggleSheet: () => setChrome(state.chrome === 'peek' ? 'full' : 'peek'),
    onSelect: (id) => {
      select(id);
      const l = byId.get(id);
      if (l) setStatus(`${l.ref} — ${l.name}`);
    },
    onFlyToStation: (lngLat) => map.flyTo({ center: lngLat, zoom: 12 }),
    searchStations: (q) => searchStations(map, q),
  });

  map.on('load', () => {
    applyFilters();
    applyClosures();
    ensureItineraryLayers();
    applySelection();
    readClosureDay();
    document.body.classList.add('ready');
    // A shared link that names both ends carries no geometry, only the query
    // that produced it, so the journey has to be asked for again to be drawn.
    if (state.tab === 'plan') restorePlannerResult();
  });

  /**
   * The day the closure overlay describes, taken from the tiles themselves so
   * the sidebar cannot claim a freshness the data does not have.
   *
   * Read from *source* features rather than rendered ones: the minor tier is
   * not drawn below zoom 10 and neither tier below 6, and the note should still
   * say which day the overlay is from at national zoom.
   *
   * Source features only exist once a tile covering the view has loaded, so
   * this retries - on `idle`, which is one attempt per settled view rather than
   * one per tile - and gives up after a few. Giving up is the answer for a
   * build with no closure layer at all: there is no day to state, the note
   * stays hidden, and nothing keeps querying the source for the rest of the
   * session on the off-chance.
   */
  function readClosureDay() {
    let attempts = 0;
    const read = () => {
      const [feature] = map.querySourceFeatures('rail', { sourceLayer: 'closures' });
      const day = feature?.properties?.day;
      if (typeof day === 'string' && day) { setClosureDay(day); return true; }
      return ++attempts >= 5;
    };
    const onIdle = () => { if (read()) map.off('idle', onIdle); };
    map.on('idle', onIdle);
  }

  map.on('error', (e) => console.error('[map]', e.error));

  // Exposed for automated visual checks.
  (window as unknown as { __map: MLMap }).__map = map;
}

/**
 * Station search runs against rendered features, which keeps it instant and
 * avoids shipping a separate index. It therefore only finds stations within the
 * current viewport's loaded tiles - the UI says so when nothing matches.
 */
function searchStations(map: MLMap, query: string) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const seen = new Set<string>();
  return map
    .querySourceFeatures('rail', { sourceLayer: 'stations' })
    .filter((f) => {
      const name = String(f.properties?.name ?? '');
      if (!name.toLowerCase().includes(q) || seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .slice(0, 8)
    .map((f) => ({
      name: String(f.properties!.name),
      lngLat: (f.geometry as GeoJSON.Point).coordinates as [number, number],
    }));
}

function departuresSection(bodyHtml: string): string {
  return `<div class="pop-live-label">${t().departures}</div>${bodyHtml}`;
}

/** Departure text (headsigns, line refs) comes from an external API - escape
 *  it before it lands in innerHTML, unlike the tile-sourced strings above
 *  which are our own build output. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function formatTime(date: Date, tz: string | null): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz ?? undefined,
  }).format(date);
}

/**
 * Key a line label so the registry and the feed agree on it, across the two
 * ways they disagree in practice: feeds append the train number of the
 * individual run (`RB45 (14253)` is the line OSM knows as `RB 45`), and
 * spacing inside a ref is tagged inconsistently even within one network -
 * the Braunschweig registry carries both `RB44` and `RB 45`.
 *
 * Note this deliberately does *not* strip trailing digits: `ICE 276` is a
 * train number rather than a line, and must not collapse onto `ICE 12`.
 */
function lineKey(ref: string): string {
  return ref.replace(/\s*\([^()]*\)\s*$/, '').replace(/\s+/g, '').toLowerCase();
}

function departureRow(d: Departure, colour: string | null): string {
  const s = t();
  const track = d.track ? `<span class="dep-track">${esc(s.platform(d.track))}</span>` : '';
  // No colour anywhere for this service (a feed that doesn't set one, for a
  // line off this map) leaves the badge on its neutral CSS default.
  const lineStyle = colour ? ` style="background:${colour};color:${textOn(colour)}"` : '';

  if (d.cancelled) {
    const time = d.scheduled ? formatTime(d.scheduled, d.tz) : '';
    return `
      <div class="dep-row cancelled">
        <span class="dep-line"${lineStyle}>${esc(d.line)}</span>
        <span class="dep-dest">${esc(d.headsign)}</span>
        ${track}
        <span class="dep-time">${time}</span>
        <span class="dep-status">${s.cancelled}</span>
      </div>`;
  }

  // A delay under a minute reads as on-time - MOTIS timestamps carry
  // seconds, and rounding noise shouldn't make an on-time train look late.
  const delayed = d.delayMinutes !== null && d.delayMinutes >= 1;
  const time = d.actual ?? d.scheduled;
  // `realTime` distinguishes a confirmed live estimate from a bare schedule -
  // shown as a quiet italic, since "no live data yet" is a different fact
  // from "on time" and shouldn't read the same as either that or a delay.
  const timeHtml = time
    ? `<span class="dep-time-value${d.realTime ? '' : ' scheduled-only'}"` +
      `${d.realTime ? '' : ` title="${esc(s.scheduledOnly)}"`}>${formatTime(time, d.tz)}</span>` +
      (delayed ? ` <span class="dep-delay">+${d.delayMinutes}</span>` : '')
    : '';

  return `
    <div class="dep-row${delayed ? ' delayed' : ''}">
      <span class="dep-line"${lineStyle}>${esc(d.line)}</span>
      <span class="dep-dest">${esc(d.headsign)}</span>
      ${track}
      <span class="dep-time">${timeHtml}</span>
    </div>`;
}

main().catch((err) => {
  console.error(err);
  setStatus('Fehler beim Laden / Failed to load');
});

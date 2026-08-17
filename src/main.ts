import maplibregl, { Map as MLMap, Popup, type MapGeoJSONFeature } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';

import { MODES, MODE_SPECS, type Mode } from '../shared/lnvg.ts';
import {
  buildStyle, selectionOpacity, highlightOpacity, servedByModes, STATION_FILTERS,
} from './style.ts';
import { readState, writeState, type ViewState, type ChromeMode } from './state.ts';
import { t } from './strings.ts';
import {
  renderChrome, renderLinePanel, setStatus, compareLines, syncSheetHandle, setVisibleModes,
} from './ui.ts';
import { ChromeToggleControl, labelControls } from './controls.ts';
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
    maxZoom: 15,
    minZoom: 4,
    attributionControl: false,
  });

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
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)',
    }),
    'bottom-right',
  );
  labelControls();
  // MapLibre rewrites the fullscreen button's own title when it flips state.
  document.addEventListener('fullscreenchange', () => labelControls());

  // --- selection & filtering ------------------------------------------------

  function applySelection() {
    for (const mode of MODES) {
      map.setPaintProperty(`route-${mode}`, 'line-opacity', selectionOpacity(state.selected));
      map.setPaintProperty(`route-${mode}-highlight`, 'line-opacity', highlightOpacity(state.selected));
    }
    map.setPaintProperty('route-badges', 'text-opacity', selectionOpacity(state.selected));
    renderLinePanel(state.selected ? byId.get(state.selected) ?? null : null, {
      onClose: () => select(null),
    });
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
      `${[...state.modes].sort().join(',')}/${state.operator ?? ''}`;
    if (key === legendKey) return;
    legendKey = key;

    // Count distinct lines, not features: one line is many tile segments.
    const lines = new Map<Mode, Set<string>>();
    for (const f of map.queryRenderedFeatures({ layers })) {
      const mode = f.properties.mode as Mode;
      const set = lines.get(mode) ?? new Set<string>();
      set.add(String(f.properties.line));
      lines.set(mode, set);
    }
    setVisibleModes(new Map([...lines].map(([mode, set]) => [mode, set.size])));
  }

  map.on('idle', refreshLegend);

  /**
   * Basemap and street underlay are style-level choices, so both go through a
   * full rebuild. The sidebar is redrawn with it: the basemap chips and the
   * street checkbox read their state at draw time.
   */
  function rebuildStyle() {
    map.setStyle(buildStyle({ base: BASE, osmBasemap: state.osmBasemap, streets: state.streets }));
    map.once('styledata', () => { applyFilters(); applySelection(); });
    renderChrome.rerender();
    persist();
  }

  function select(id: string | null) {
    state.selected = id;
    applySelection();
    persist();
  }

  const persist = () => writeState(state);

  // --- interactions ---------------------------------------------------------

  const routeLayers = MODES.map((m) => `route-${m}`);
  const STATION_LAYERS = ['stations', 'stations-tram'];
  const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 10 });

  map.on('click', (e) => {
    const hits = map.queryRenderedFeatures(e.point, { layers: [...routeLayers, ...STATION_LAYERS] });
    const station = hits.find((f) => STATION_LAYERS.includes(f.layer.id));
    const route = hits.find((f) => !STATION_LAYERS.includes(f.layer.id));

    if (station) { showStation(station); return; }
    select(route ? String(route.properties.line) : null);
  });

  map.on('mousemove', (e) => {
    const hits = map.queryRenderedFeatures(e.point, { layers: [...routeLayers, ...STATION_LAYERS] });
    map.getCanvas().style.cursor = hits.length ? 'pointer' : '';
  });

  function showStation(f: MapGeoJSONFeature) {
    const p = f.properties as Record<string, string>;
    const served = String(p.lines ?? '').split(',').filter(Boolean)
      .map((id) => byId.get(id)).filter((l): l is LineRecord => !!l)
      .sort(compareLines);

    const badges = served.map((l) =>
      `<button class="badge" data-line="${l.id}" style="background:${l.colour}" title="${l.name}">${l.ref}</button>`,
    ).join('');

    const geom = f.geometry as GeoJSON.Point;
    popup
      .setLngLat(geom.coordinates as [number, number])
      .setHTML(`
        <div class="pop">
          <strong>${p.name}</strong>
          ${p.uic_ref ? `<span class="uic">UIC ${p.uic_ref}</span>` : ''}
          <div class="pop-lines-label">${t().servedBy}</div>
          <div class="pop-lines">${badges || '—'}</div>
        </div>`)
      .addTo(map);

    popup.getElement()?.querySelectorAll<HTMLElement>('.badge').forEach((el) => {
      el.onclick = () => { select(el.dataset.line!); popup.remove(); };
    });
  }

  map.on('moveend', () => {
    const c = map.getCenter();
    state.center = [c.lng, c.lat];
    state.zoom = map.getZoom();
    persist();
  });

  // --- chrome ---------------------------------------------------------------

  renderChrome({
    registry,
    state,
    onToggleMode: (mode: Mode, on: boolean) => {
      if (on) state.modes.add(mode); else state.modes.delete(mode);
      applyFilters();
    },
    onOperator: (op) => { state.operator = op; applyFilters(); },
    onBasemap: (osm) => { state.osmBasemap = osm; rebuildStyle(); },
    onStreets: (on) => { state.streets = on; rebuildStyle(); },
    onToggleSheet: () => setChrome(state.chrome === 'peek' ? 'full' : 'peek'),
    onSelect: (id) => {
      select(id);
      const l = byId.get(id);
      if (l) setStatus(`${l.ref} — ${l.name}`);
    },
    onFlyToStation: (lngLat) => map.flyTo({ center: lngLat, zoom: 12 }),
    onReset: () => map.flyTo({ center: initial.center, zoom: initial.zoom }),
    searchStations: (q) => searchStations(map, q),
  });

  map.on('load', () => {
    applyFilters();
    applySelection();
    document.body.classList.add('ready');
  });

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

main().catch((err) => {
  console.error(err);
  setStatus('Fehler beim Laden / Failed to load');
});

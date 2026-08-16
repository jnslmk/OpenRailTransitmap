import maplibregl, { Map as MLMap, Popup, type MapGeoJSONFeature } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';

import { MODES, MODE_SPECS, type Mode } from '../shared/lnvg.ts';
import { buildStyle, selectionOpacity, highlightOpacity } from './style.ts';
import { readState, writeState, type ViewState } from './state.ts';
import { t, lang, setLang, type Lang } from './i18n.ts';
import { renderChrome, renderLinePanel, setStatus } from './ui.ts';
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
  document.documentElement.lang = lang();

  const map = new MLMap({
    container: 'map',
    style: buildStyle({ base: BASE, osmBasemap: state.osmBasemap }),
    center: state.center,
    zoom: state.zoom,
    maxZoom: 15,
    minZoom: 4,
    attributionControl: false,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)',
    }),
    'bottom-right',
  );

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
    persist();
  }

  function select(id: string | null) {
    state.selected = id;
    applySelection();
    persist();
  }

  const persist = () => writeState(state, lang());

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
      .sort((a, b) => MODE_SPECS[b.mode].order - MODE_SPECS[a.mode].order
        || a.ref.localeCompare(b.ref, 'de', { numeric: true }));

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
    onBasemap: (osm) => {
      state.osmBasemap = osm;
      map.setStyle(buildStyle({ base: BASE, osmBasemap: osm }));
      map.once('styledata', () => { applyFilters(); applySelection(); });
      persist();
    },
    onLang: (l: Lang) => {
      setLang(l);
      renderChrome.rerender();
      applySelection();
      persist();
    },
    onSelect: (id) => {
      select(id);
      const l = byId.get(id);
      if (l) setStatus(`${l.ref} — ${l.name}`);
    },
    onFlyToStation: (lngLat) => map.flyTo({ center: lngLat, zoom: 12 }),
    onReset: () => map.flyTo({ center: initial.center, zoom: initial.zoom }),
    onShare: async () => {
      await navigator.clipboard.writeText(location.href);
      setStatus(t().copied);
    },
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

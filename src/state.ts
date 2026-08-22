/**
 * URL-encoded view state, so any view is linkable and survives a reload.
 *
 *   #10.45/51.16/6.2        map position (lon/lat/zoom)
 *   ?line=regional|gvh|re1  selected line
 *   ?modes=longdistance,regional
 *   ?op=DB%20Regio          operator filter
 *   ?base=osm               basemap choice
 *   ?streets=0              street underlay off
 *   ?closures=0             construction overlay off
 *   ?ui=map|peek            sidebar hidden / collapsed to its handle
 */

import { MODES, type Mode } from '../shared/lnvg.ts';

/**
 * How much of the chrome is showing. `peek` only differs from `full` in the
 * narrow layout, where the sidebar is a bottom sheet that collapses to its
 * handle; `hidden` drops it entirely at any width.
 */
export type ChromeMode = 'full' | 'peek' | 'hidden';

export interface ViewState {
  center: [number, number];
  zoom: number;
  selected: string | null;
  modes: Set<Mode>;
  operator: string | null;
  osmBasemap: boolean;
  streets: boolean;
  closures: boolean;
  chrome: ChromeMode;
}

export function readState(fallback: { center: [number, number]; zoom: number }): ViewState {
  const q = new URLSearchParams(location.search);

  let center = fallback.center;
  let zoom = fallback.zoom;
  const hash = location.hash.replace(/^#/, '');
  if (hash) {
    const [z, lat, lon] = hash.split('/').map(Number);
    if ([z, lat, lon].every(Number.isFinite)) {
      zoom = z;
      center = [lon, lat];
    }
  }

  const modesParam = q.get('modes');
  const modes = modesParam
    ? new Set(modesParam.split(',').filter((m): m is Mode => (MODES as readonly string[]).includes(m)))
    : new Set<Mode>(MODES);

  return {
    center,
    zoom,
    selected: q.get('line'),
    modes: modes.size ? modes : new Set<Mode>(MODES),
    operator: q.get('op'),
    osmBasemap: q.get('base') === 'osm',
    streets: q.get('streets') !== '0',
    closures: q.get('closures') !== '0',
    chrome: q.get('ui') === 'map' ? 'hidden' : q.get('ui') === 'peek' ? 'peek' : 'full',
  };
}

/** Replace (never push) so panning does not fill the browser history. */
export function writeState(s: ViewState) {
  const q = new URLSearchParams();
  if (s.selected) q.set('line', s.selected);
  if (s.modes.size !== MODES.length) q.set('modes', [...s.modes].join(','));
  if (s.operator) q.set('op', s.operator);
  if (s.osmBasemap) q.set('base', 'osm');
  if (!s.streets) q.set('streets', '0');
  if (!s.closures) q.set('closures', '0');
  if (s.chrome === 'hidden') q.set('ui', 'map');
  if (s.chrome === 'peek') q.set('ui', 'peek');

  const hash = `#${s.zoom.toFixed(2)}/${s.center[1].toFixed(4)}/${s.center[0].toFixed(4)}`;
  const query = q.size ? `?${q}` : '';
  history.replaceState(null, '', `${location.pathname}${query}${hash}`);
}

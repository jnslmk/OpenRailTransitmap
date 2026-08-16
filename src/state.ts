/**
 * URL-encoded view state, so any view is linkable and survives a reload.
 *
 *   #10.45/51.16/6.2        map position (lon/lat/zoom)
 *   ?line=regional|gvh|re1  selected line
 *   ?modes=longdistance,regional
 *   ?op=DB%20Regio          operator filter
 *   ?base=osm               basemap choice
 *   ?ui=map                 sidebar hidden, map fills the window
 *   ?lang=de
 */

import { MODES, type Mode } from '../shared/lnvg.ts';

export interface ViewState {
  center: [number, number];
  zoom: number;
  selected: string | null;
  modes: Set<Mode>;
  operator: string | null;
  osmBasemap: boolean;
  chromeHidden: boolean;
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
    chromeHidden: q.get('ui') === 'map',
  };
}

/** Replace (never push) so panning does not fill the browser history. */
export function writeState(s: ViewState, langCode: string) {
  const q = new URLSearchParams();
  if (s.selected) q.set('line', s.selected);
  if (s.modes.size !== MODES.length) q.set('modes', [...s.modes].join(','));
  if (s.operator) q.set('op', s.operator);
  if (s.osmBasemap) q.set('base', 'osm');
  if (s.chromeHidden) q.set('ui', 'map');
  q.set('lang', langCode);

  const hash = `#${s.zoom.toFixed(2)}/${s.center[1].toFixed(4)}/${s.center[0].toFixed(4)}`;
  history.replaceState(null, '', `${location.pathname}?${q}${hash}`);
}

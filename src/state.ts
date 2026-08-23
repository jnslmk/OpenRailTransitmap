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
 *   ?tab=plan               the journey planner rather than the line index
 *   ?from= / ?to=           the planner's two ends (see `encodePlace`)
 *   ?at= / ?arrive=1        depart-at / arrive-by, absent meaning "leave now"
 *   ?pmodes=rail,bus        which modes the planner may use
 *   ?bike=30&carry=1        minutes in the saddle at each end, bike carriage
 *   ?itin=2                 which itinerary is drawn
 */

import { MODES, type Mode } from '../shared/lnvg.ts';
import { MODE_GROUPS, type Place } from './routing.ts';
import { BIKE_STEPS, defaultPlannerState, type PlannerState } from './planner.ts';

/**
 * How much of the chrome is showing. `peek` only differs from `full` in the
 * narrow layout, where the sidebar is a bottom sheet that collapses to its
 * handle; `hidden` drops it entirely at any width.
 */
export type ChromeMode = 'full' | 'peek' | 'hidden';

/** Which half of the sidebar is showing. The map underneath is the same either way. */
export type Tab = 'explore' | 'plan';

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
  tab: Tab;
  plan: PlannerState;
}

/**
 * A place as one URL parameter: `stopId~lat~lon~name`.
 *
 * The name is carried so a restored link can fill the field in without a
 * geocode round trip, and the coordinates so a place that is not a stop - an
 * address, a park, a pin dropped on the map - survives at all. `~` is the
 * separator because it is the one ASCII punctuation mark German station names
 * do not use; any that turns up anyway is replaced rather than escaped, since
 * losing a tilde from a label costs nothing and a broken parse costs the link.
 */
export function encodePlace(p: Place): string {
  const clean = p.name.replace(/~/g, '-');
  return `${p.stopId ?? ''}~${p.lat.toFixed(5)}~${p.lon.toFixed(5)}~${clean}`;
}

export function decodePlace(raw: string | null): Place | null {
  if (!raw) return null;
  const [stopId, lat, lon, ...rest] = raw.split('~');
  // Empty before numeric, for the same reason the bike parameter is read that
  // way below: `Number('')` is 0, and 0/0 is a real coordinate in the Gulf of
  // Guinea, so a truncated link would silently plan a journey from there.
  if (!lat || !lon) return null;
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    name: rest.join('~') || `${latitude}, ${longitude}`,
    lat: latitude,
    lon: longitude,
    stopId: stopId || null,
    area: '',
    kind: stopId ? 'STOP' : 'PLACE',
  };
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

  const plan = defaultPlannerState();
  plan.from = decodePlace(q.get('from'));
  plan.to = decodePlace(q.get('to'));
  const at = q.get('at');
  const when = at ? new Date(at) : null;
  plan.time = when && !Number.isNaN(when.getTime()) ? when : null;
  plan.arriveBy = q.get('arrive') === '1';
  const pmodes = q.get('pmodes');
  if (pmodes) {
    const keys = new Set(MODE_GROUPS.map((g) => g.key));
    const chosen = pmodes.split(',').filter((k) => keys.has(k));
    if (chosen.length) plan.groups = new Set(chosen);
  }
  // Read the raw string first, and only then convert. `Number(null)` is 0, and
  // 0 is a legitimate value for both of these - "no bike" and "the first
  // itinerary" - so converting before checking for absence silently turns every
  // link without a `bike` parameter into a link that says the rider has no
  // bike, which is the one setting this map exists to argue against.
  const bikeParam = q.get('bike');
  if (bikeParam !== null) {
    const bike = Number(bikeParam);
    // Snapped to a step rather than accepted verbatim: the slider has no
    // position for 37 minutes, and a value it cannot show is a control that lies.
    if (BIKE_STEPS.includes(bike)) plan.bikeMinutes = bike;
  }
  plan.carriage = q.get('carry') === '1';
  const itinParam = q.get('itin');
  if (itinParam !== null) {
    const itin = Number(itinParam);
    plan.selected = Number.isInteger(itin) && itin >= 0 ? itin : null;
  }

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
    tab: q.get('tab') === 'plan' ? 'plan' : 'explore',
    plan,
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

  if (s.tab === 'plan') q.set('tab', 'plan');
  const p = s.plan;
  if (p.from) q.set('from', encodePlace(p.from));
  if (p.to) q.set('to', encodePlace(p.to));
  if (p.time) q.set('at', p.time.toISOString());
  if (p.arriveBy) q.set('arrive', '1');
  if (p.groups.size !== MODE_GROUPS.length) q.set('pmodes', [...p.groups].join(','));
  // Only when it differs from the default, so an untouched planner adds nothing
  // to a link that is mostly about the map.
  if (p.bikeMinutes !== defaultPlannerState().bikeMinutes) q.set('bike', String(p.bikeMinutes));
  if (p.carriage) q.set('carry', '1');
  if (p.selected !== null) q.set('itin', String(p.selected));

  const hash = `#${s.zoom.toFixed(2)}/${s.center[1].toFixed(4)}/${s.center[0].toFixed(4)}`;
  const query = q.size ? `?${q}` : '';
  history.replaceState(null, '', `${location.pathname}${query}${hash}`);
}

/** Map controls that are not part of MapLibre's own set. */

import type { IControl, Map as MLMap } from 'maplibre-gl';

import { t } from './strings.ts';

/**
 * A panel icon rather than fullscreen arrows: the two buttons sit on the same
 * map and mean different things — this one hides the chrome, MapLibre's
 * fullscreen button takes over the screen.
 */
const icon = (filled: boolean) => `<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
  <rect x="2.75" y="4.75" width="14.5" height="10.5" rx="1.75"
        fill="none" stroke="currentColor" stroke-width="1.6"/>
  <path d="M8.25 4.75v10.5" stroke="currentColor" stroke-width="1.6"/>
  ${filled ? '<path d="M3.6 5.6h4.65v9H3.6z" fill="currentColor"/>' : ''}</svg>`;

const ICON_PANEL_ON = icon(true);
const ICON_PANEL_OFF = icon(false);

/**
 * Collapses the sidebar so the map fills the window — the only way to get a
 * usable map on a phone, where the chrome otherwise eats half the screen.
 * The button stays on the map so the chrome can always be brought back.
 */
export class ChromeToggleControl implements IControl {
  private container: HTMLDivElement | null = null;
  private button: HTMLButtonElement | null = null;

  constructor(
    private readonly isHidden: () => boolean,
    private readonly onToggle: () => void,
  ) {}

  onAdd(_map: MLMap): HTMLElement {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'maplibregl-ctrl-chrome';
    button.addEventListener('click', () => this.onToggle());
    container.appendChild(button);

    this.container = container;
    this.button = button;
    this.sync();
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
    this.button = null;
  }

  /** Refresh icon and label after a toggle. */
  sync(): void {
    const btn = this.button;
    if (!btn) return;
    const hidden = this.isHidden();
    const label = hidden ? t().showChrome : t().hideChrome;
    btn.innerHTML = hidden ? ICON_PANEL_OFF : ICON_PANEL_ON;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(hidden));
  }
}

/**
 * MapLibre's own control labels are close but not ours - the compass reads
 * "Reset bearing to north" whatever the map is for - so relabel them from the
 * DOM once they are added. Missing buttons (fullscreen is unsupported on some
 * browsers) are simply skipped.
 */
export function labelControls(): void {
  const s = t();
  const labels: [string, string][] = [
    ['.maplibregl-ctrl-zoom-in', s.zoomIn],
    ['.maplibregl-ctrl-zoom-out', s.zoomOut],
    ['.maplibregl-ctrl-compass', s.northUp],
    ['.maplibregl-ctrl-geolocate', s.locate],
    ['.maplibregl-ctrl-fullscreen', s.fullscreen],
    ['.maplibregl-ctrl-shrink', s.exitFullscreen],
  ];
  for (const [selector, label] of labels) {
    document.querySelectorAll<HTMLElement>(selector).forEach((btn) => {
      btn.title = label;
      btn.setAttribute('aria-label', label);
    });
  }
}

/**
 * Whether the debugging aids are wanted: always under `vite dev`, and on a
 * built site only when it is opened with `?debug`. The second half is what
 * keeps the deployed map answerable - "which zoom is this actually at?" is a
 * question about a real screen on a real device, and that is the build the
 * question gets asked of.
 */
export const DEBUG = import.meta.env.DEV
  || new URLSearchParams(location.search).has('debug');

/**
 * The current zoom, printed on the map.
 *
 * This map is a stack of zoom thresholds - which stop tier marks, where its
 * name follows one step behind, where the bars take over from dots, which
 * closures show - and tuning any of them means knowing the zoom to better than
 * "about eleven". Two decimals, because several of the thresholds are
 * fractional (10.2, 13.5) and an integer would not say which side of one the
 * view is on.
 */
export class ZoomReadoutControl implements IControl {
  private container: HTMLDivElement | null = null;
  private map: MLMap | null = null;

  private readonly render = (): void => {
    if (this.container && this.map) {
      this.container.textContent = `z ${this.map.getZoom().toFixed(2)}`;
    }
  };

  onAdd(map: MLMap): HTMLElement {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-zoom-readout';
    this.container = container;
    this.map = map;
    // `zoom` rather than `zoomend`: the number is worth watching *while* the
    // map moves, which is when a threshold is crossed and something appears.
    map.on('zoom', this.render);
    this.render();
    return container;
  }

  onRemove(): void {
    this.map?.off('zoom', this.render);
    this.container?.remove();
    this.container = null;
    this.map = null;
  }
}

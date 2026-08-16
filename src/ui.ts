/** Sidebar, legend, filters, search and the line detail panel. */

import { MODES, MODE_SPECS, type Mode } from '../shared/lnvg.ts';
import { t, lang, type Lang } from './i18n.ts';
import type { LineRecord, Registry } from './main.ts';
import type { ViewState } from './state.ts';

export { compareLines };

export interface ChromeOptions {
  registry: Registry;
  state: ViewState;
  onToggleMode: (mode: Mode, on: boolean) => void;
  onOperator: (op: string | null) => void;
  onBasemap: (osm: boolean) => void;
  onStreets: (on: boolean) => void;
  onToggleSheet: () => void;
  onLang: (l: Lang) => void;
  onSelect: (lineId: string) => void;
  onFlyToStation: (lngLat: [number, number]) => void;
  onReset: () => void;
  onShare: () => void;
  searchStations: (q: string) => { name: string; lngLat: [number, number] }[];
}

/**
 * Ordering for the line index.
 *
 * A plain localeCompare on `ref` puts oddities like `661A` and `8358` above
 * `ICE 1`, because digits sort before letters. Riders look for the service
 * prefix first, so known prefixes lead in service order and everything else
 * falls to the end, with the number compared numerically within each group.
 */
const REF_PREFIXES = [
  'ICE', 'IC', 'EC', 'ECE', 'FLX', 'NJ', 'EN', 'RJ', 'TGV',
  'RE', 'RB', 'S', 'U', 'STR',
];

function refSortKey(ref: string): [number, string, number, string] {
  const m = /^([A-Za-zÄÖÜäöü]*)\s*(\d*)(.*)$/.exec(ref.trim()) ?? [];
  const prefix = (m[1] ?? '').toUpperCase();
  const num = m[2] ? parseInt(m[2], 10) : Number.MAX_SAFE_INTEGER;
  const known = REF_PREFIXES.indexOf(prefix);
  // Unknown prefixes (and bare numbers) sort after every known service.
  return [known >= 0 ? known : REF_PREFIXES.length, prefix, num, m[3] ?? ''];
}

function compareLines(a: LineRecord, b: LineRecord): number {
  const byMode = MODE_SPECS[b.mode].order - MODE_SPECS[a.mode].order;
  if (byMode !== 0) return byMode;

  const ka = refSortKey(a.ref), kb = refSortKey(b.ref);
  return ka[0] - kb[0]
    || ka[1].localeCompare(kb[1], 'de')
    || ka[2] - kb[2]
    || ka[3].localeCompare(kb[3], 'de');
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, html?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

let opts: ChromeOptions;

export function renderChrome(o: ChromeOptions) {
  opts = o;
  draw();
}

renderChrome.rerender = () => draw();

// ---------------------------------------------------------------------------
// Bottom-sheet handle
//
// In the narrow layout the sidebar is a sheet under the map. The handle
// collapses it to a strip so the map gets the screen without losing the way
// back — the map's own toggle hides the chrome entirely, this only folds it.
// ---------------------------------------------------------------------------

let handleEl: HTMLButtonElement | null = null;

function sheetHandle(): HTMLElement {
  const btn = el('button', 'sheet-handle');
  btn.type = 'button';

  // A drag on the handle is the gesture people try before they try a tap, so
  // both work; `dragged` keeps the pointerup from also firing the click.
  let startY = 0;
  let dragged = false;

  btn.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    dragged = false;
    // Without capture the pointerup lands on whatever the drag ended over.
    btn.setPointerCapture(e.pointerId);
  });
  btn.addEventListener('pointerup', (e) => {
    const dy = e.clientY - startY;
    if (Math.abs(dy) < 24) return;
    dragged = true;
    const collapsed = opts.state.chrome === 'peek';
    const wantsCollapsed = dy > 0;
    if (wantsCollapsed !== collapsed) opts.onToggleSheet();
  });
  btn.onclick = () => { if (!dragged) opts.onToggleSheet(); };

  btn.append(el('span', 'grabber'), el('span', 'sheet-label'));
  handleEl = btn;
  syncSheetHandle(opts.state.chrome === 'peek');
  return btn;
}

/** Update the handle in place; redrawing the sidebar for a fold is wasteful. */
export function syncSheetHandle(collapsed: boolean) {
  if (!handleEl) return;
  const s = t();
  const label = collapsed ? s.expandPanel : s.collapsePanel;
  handleEl.title = label;
  handleEl.setAttribute('aria-label', label);
  handleEl.setAttribute('aria-expanded', String(!collapsed));
  handleEl.querySelector('.sheet-label')!.textContent = collapsed ? s.panelPeek : '';
}

function draw() {
  const { registry, state } = opts;
  const s = t();
  const root = document.getElementById('sidebar')!;
  root.innerHTML = '';

  root.appendChild(sheetHandle());

  // --- header ---------------------------------------------------------------
  const header = el('header', 'panel');
  header.appendChild(el('h1', '', s.title));
  header.appendChild(el('p', 'sub', s.subtitle));

  const meta = el('p', 'meta',
    `${registry.regionName} · ${s.lineCount(registry.counts.lines)} · ${s.stationCount(registry.counts.stations)}`);
  header.appendChild(meta);

  const langRow = el('div', 'row');
  (['de', 'en'] as Lang[]).forEach((l) => {
    const b = el('button', `chip${lang() === l ? ' on' : ''}`, l.toUpperCase());
    b.onclick = () => opts.onLang(l);
    langRow.appendChild(b);
  });
  const share = el('button', 'chip', s.share);
  share.onclick = () => opts.onShare();
  langRow.appendChild(share);
  const reset = el('button', 'chip', s.reset);
  reset.onclick = () => opts.onReset();
  langRow.appendChild(reset);
  header.appendChild(langRow);
  root.appendChild(header);

  // --- search ---------------------------------------------------------------
  const searchBox = el('div', 'panel');
  const input = el('input', 'search');
  input.type = 'search';
  input.placeholder = s.search;
  const results = el('div', 'results');
  searchBox.append(input, results);
  root.appendChild(searchBox);

  let timer: number | undefined;
  input.oninput = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => runSearch(input.value, results), 120);
  };

  // --- modes / legend -------------------------------------------------------
  const modeBox = el('div', 'panel');
  modeBox.appendChild(el('h2', '', s.modes));
  for (const mode of MODES) {
    const count = registry.counts.byMode[mode] ?? 0;
    if (count === 0) continue;

    const row = el('label', 'toggle');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = opts.state.modes.has(mode);
    cb.onchange = () => opts.onToggleMode(mode, cb.checked);

    const swatch = el('span', 'swatch');
    swatch.style.background = MODE_SPECS[mode].defaultColour;
    swatch.style.height = `${MODE_SPECS[mode].weightPt * 1.4}px`;

    row.append(cb, swatch, el('span', 'label', s[mode]), el('span', 'count', String(count)));
    modeBox.appendChild(row);
  }

  // Station symbology, matching the map.
  const legend = el('div', 'legend');
  legend.innerHTML = `
    <div class="legend-row"><span class="dot interchange"></span>${s.interchange}</div>
    <div class="legend-row"><span class="dot"></span>${s.station}</div>`;
  modeBox.appendChild(legend);
  root.appendChild(modeBox);

  // --- operator -------------------------------------------------------------
  const operators = [...new Set(registry.lines.map((l) => l.operator).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'de'));

  const opBox = el('div', 'panel');
  opBox.appendChild(el('h2', '', s.operator));
  const sel = el('select', 'select');
  sel.appendChild(new Option(s.allOperators, ''));
  for (const o of operators) sel.appendChild(new Option(o, o));
  sel.value = state.operator ?? '';
  sel.onchange = () => opts.onOperator(sel.value || null);
  opBox.appendChild(sel);
  root.appendChild(opBox);

  // --- basemap --------------------------------------------------------------
  const baseBox = el('div', 'panel');
  baseBox.appendChild(el('h2', '', s.basemap));
  const baseRow = el('div', 'row');
  ([[false, s.baseLnvg], [true, s.baseOsm]] as [boolean, string][]).forEach(([osm, label]) => {
    const b = el('button', `chip${state.osmBasemap === osm ? ' on' : ''}`, label);
    b.onclick = () => opts.onBasemap(osm);
    baseRow.appendChild(b);
  });
  baseBox.appendChild(baseRow);

  // The raster basemap already is streets, so the underlay has nothing to add.
  const streetsRow = el('label', 'toggle');
  const streetsBox = el('input');
  streetsBox.type = 'checkbox';
  streetsBox.checked = state.streets;
  streetsBox.disabled = state.osmBasemap;
  streetsBox.onchange = () => opts.onStreets(streetsBox.checked);
  streetsRow.append(streetsBox, el('span', 'label', s.streets));
  baseBox.appendChild(streetsRow);
  root.appendChild(baseBox);

  // --- line index -----------------------------------------------------------
  const linesBox = el('div', 'panel');
  linesBox.appendChild(el('h2', '', s.lines));
  const list = el('div', 'line-list');
  const visible = registry.lines
    .filter((l) => state.modes.has(l.mode))
    .filter((l) => !state.operator || l.operator === state.operator)
    .sort(compareLines);

  for (const l of visible) list.appendChild(lineRow(l));
  linesBox.appendChild(list);
  root.appendChild(linesBox);

  root.appendChild(el('footer', 'panel attrib', `
    <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> contributors · ODbL<br>
    <a href="https://github.com/jnslmk/openrailtransitmap">Source on GitHub</a>`));
}

function lineRow(l: LineRecord): HTMLElement {
  const row = el('button', 'line-row');
  row.onclick = () => opts.onSelect(l.id);
  const badge = el('span', 'badge', l.ref);
  badge.style.background = l.colour;
  row.append(badge, el('span', 'line-name', l.name || l.ref));
  return row;
}

function runSearch(query: string, container: HTMLElement) {
  container.innerHTML = '';
  const q = query.trim().toLowerCase();
  if (q.length < 2) return;

  const lines = opts.registry.lines
    .filter((l) => l.ref.toLowerCase().includes(q) || l.name.toLowerCase().includes(q))
    .slice(0, 6);
  for (const l of lines) container.appendChild(lineRow(l));

  for (const st of opts.searchStations(query)) {
    const row = el('button', 'line-row');
    row.onclick = () => opts.onFlyToStation(st.lngLat);
    row.append(el('span', 'dot'), el('span', 'line-name', st.name));
    container.appendChild(row);
  }

  if (!container.childElementCount) {
    container.appendChild(el('p', 'muted', t().noResults));
  }
}

// ---------------------------------------------------------------------------
// Line detail panel
// ---------------------------------------------------------------------------

export function renderLinePanel(line: LineRecord | null, handlers: { onClose: () => void }) {
  const host = document.getElementById('detail')!;
  host.innerHTML = '';
  host.classList.toggle('open', !!line);
  if (!line) return;

  const s = t();
  const head = el('div', 'detail-head');
  const badge = el('span', 'badge big', line.ref);
  badge.style.background = line.colour;
  head.append(badge, el('div', 'detail-title', line.name || line.ref));

  const close = el('button', 'close', '×');
  close.title = s.close;
  close.onclick = handlers.onClose;
  head.appendChild(close);
  host.appendChild(head);

  const rows: [string, string][] = [
    [s.modes, s[line.mode]],
    [s.operator, line.operator || '—'],
    [s.network, line.network || '—'],
    [s.stations, String(line.stops)],
  ];
  const table = el('dl', 'detail-meta');
  for (const [k, v] of rows) {
    table.append(el('dt', '', k), el('dd', '', v));
  }
  host.appendChild(table);
}

export function setStatus(message: string) {
  const node = document.getElementById('status');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  window.setTimeout(() => node.classList.remove('show'), 2400);
}

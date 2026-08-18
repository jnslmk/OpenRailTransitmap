/** Sidebar, legend, filters, search and the line detail panel. */

import { MODES, MODE_SPECS, textOn, type Mode } from '../shared/lnvg.ts';
import { t } from './strings.ts';
import type { LineRecord, Registry } from './main.ts';
import {
  worstFirst, bands, formatMinutes, type LineScore, type PunctualityFile,
} from './punctuality.ts';
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
  onSelect: (lineId: string) => void;
  onFlyToStation: (lngLat: [number, number]) => void;
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

// ---------------------------------------------------------------------------
// Legend
//
// The legend describes what is on the screen, not what exists in the country:
// only modes with lines in the current view get a row, and the count is how
// many of them are in view. A mode that is switched off keeps its row whatever
// the view holds - it is the only way back.
//
// Every mode has a row in the DOM from the start and the view only toggles
// `hidden` on it. Rebuilding the rows on each recount threw away the row that
// was clicked, which lost keyboard focus mid-toggle and made a row that was
// about to be hidden disappear from under the pointer.
// ---------------------------------------------------------------------------

interface ModeRow { row: HTMLElement; box: HTMLInputElement; count: HTMLElement }

let modeBox: HTMLElement | null = null;
let modeRows = new Map<Mode, ModeRow>();
let emptyNote: HTMLElement | null = null;
/** Lines in view per mode, or null until the map has first settled. */
let inView: Map<Mode, number> | null = null;
/**
 * Modes whose row stays open no matter what the view holds, because the reader
 * has just toggled them. Switching a mode *on* used to move it from "always
 * shown" to "shown only if in view", so enabling a mode that runs nowhere near
 * the current view took its own row away and with it the way to undo the
 * click. A pinned row shows the honest count - `0` - and survives until the
 * view itself changes, which is when a view-scoped legend is meant to change.
 */
const pinnedModes = new Set<Mode>();

export function setVisibleModes(counts: Map<Mode, number>) {
  inView = counts;
  syncModes();
}

/**
 * Line ids drawn in the current view, or null until the map has first settled.
 * The index is scoped to the view for the same reason the mode rows are: it
 * answers "what am I looking at", and a national list of every line the country
 * runs cannot.
 */
let inViewLines: Set<string> | null = null;

export function setVisibleLines(ids: Set<string>) {
  inViewLines = ids;
  fillLines();
}

/** Called when the map has moved: the pins only outlive the view they were set in. */
export function unpinModes() {
  pinnedModes.clear();
}

function buildModes(): HTMLElement {
  const s = t();
  const box = el('div', 'panel');
  box.appendChild(el('h2', '', s.modes));

  modeRows = new Map();
  for (const mode of MODES) {
    const row = el('label', 'toggle');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.onchange = () => {
      pinnedModes.add(mode);
      opts.onToggleMode(mode, cb.checked);
      // The map recounts on its next idle; sync now so the count clears with
      // the click rather than a frame later.
      syncModes();
      fillLines();
    };

    const swatch = el('span', 'swatch');
    swatch.style.background = MODE_SPECS[mode].defaultColour;
    swatch.style.height = `${MODE_SPECS[mode].weightPt * 1.4}px`;

    const count = el('span', 'count');
    row.append(cb, swatch, el('span', 'label', s[mode]), count);
    modeRows.set(mode, { row, box: cb, count });
    box.appendChild(row);
  }

  emptyNote = el('p', 'muted', s.noLinesInView);
  box.appendChild(emptyNote);

  // Station symbology, matching the map.
  const legend = el('div', 'legend');
  legend.innerHTML = `
    <div class="legend-row"><span class="dot interchange"></span>${s.interchange}</div>
    <div class="legend-row"><span class="dot"></span>${s.station}</div>`;
  box.appendChild(legend);

  modeBox = box;
  syncModes();
  return box;
}

function syncModes() {
  if (!modeBox) return;

  let shown = 0;
  for (const mode of MODES) {
    const { row, box, count } = modeRows.get(mode)!;
    const on = opts.state.modes.has(mode);
    // Until the map has settled once there is nothing in view to count, so the
    // national total stands in.
    const n = inView ? inView.get(mode) ?? 0 : opts.registry.counts.byMode[mode] ?? 0;
    const visible = !on || pinnedModes.has(mode) || n > 0;

    row.hidden = !visible;
    box.checked = on;
    // A hidden mode has no count: nothing of it is drawn to count.
    count.textContent = on ? String(n) : '';
    if (visible) shown++;
  }
  emptyNote!.hidden = shown > 0;
}

function draw() {
  const { registry, state } = opts;
  const s = t();
  const root = document.getElementById('sidebar')!;
  root.innerHTML = '';

  root.appendChild(sheetHandle());

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
  root.appendChild(buildModes());

  // --- operator -------------------------------------------------------------
  const operators = [...new Set(registry.lines.map((l) => l.operator).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'de'));

  const opBox = el('div', 'panel');
  opBox.appendChild(el('h2', '', s.operator));
  const sel = el('select', 'select');
  sel.appendChild(new Option(s.allOperators, ''));
  for (const o of operators) sel.appendChild(new Option(o, o));
  sel.value = state.operator ?? '';
  sel.onchange = () => { opts.onOperator(sel.value || null); fillLines(); };
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
  lineList = el('div', 'line-list');
  fillLines();
  linesBox.appendChild(lineList);
  root.appendChild(linesBox);

  const footer = el('footer', 'panel attrib', `
    <p class="meta">${s.lineCount(registry.counts.lines)} · ${s.stationCount(registry.counts.stations)}</p>
    <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> contributors · ODbL<br>
    <a href="https://github.com/jnslmk/openrailtransitmap">Source on GitHub</a>
    <span class="live-attrib" hidden>${s.liveAttribution}</span>
    <span class="punct-attrib" hidden>${s.punctualityAttribution}</span>`);
  root.appendChild(footer);
  liveAttribEl = footer.querySelector('.live-attrib');
  liveAttribEl!.hidden = !liveDataUsed;
  punctAttribEl = footer.querySelector('.punct-attrib');
  punctAttribEl!.hidden = !punctualityUsed;
}

/**
 * Transitous requires visible attribution, but only while its data is
 * actually on screen - a static build that never resolves a `stopId` has
 * nothing to attribute. Set once, on the first successful departure fetch;
 * the flag survives a sidebar redraw so the line does not flicker in and out
 * on every toggle.
 */
let liveAttribEl: HTMLElement | null = null;
let liveDataUsed = false;

export function setLiveAttributionUsed() {
  if (liveDataUsed) return;
  liveDataUsed = true;
  if (liveAttribEl) liveAttribEl.hidden = false;
}

/**
 * The delay data is CC BY 4.0, which requires crediting Deutsche Bahn wherever
 * it is shown - so the credit appears with the first score displayed and, like
 * the Transitous one, stays for the rest of the session.
 */
let punctAttribEl: HTMLElement | null = null;
let punctualityUsed = false;

export function setPunctualityAttributionUsed() {
  if (punctualityUsed) return;
  punctualityUsed = true;
  if (punctAttribEl) punctAttribEl.hidden = false;
}

/**
 * The line index lists what the current filters let through *and* what the
 * current view holds, so it is refilled whenever either changes - in place,
 * because redrawing the whole sidebar for a checkbox would take the checkbox's
 * focus with it.
 */
let lineList: HTMLElement | null = null;

function fillLines() {
  if (!lineList) return;
  const { registry, state } = opts;
  lineList.innerHTML = '';
  const visible = registry.lines
    .filter((l) => state.modes.has(l.mode))
    .filter((l) => !state.operator || l.operator === state.operator)
    // A selected line keeps its row after being panned off screen: that row
    // carries the selection, and dropping it drops the way to clear it.
    .filter((l) => !inViewLines || inViewLines.has(l.id) || state.selected === l.id)
    .sort(compareLines);
  for (const l of visible) lineList.appendChild(lineRow(l));
  if (!visible.length) lineList.appendChild(el('p', 'muted', t().noLinesInView));
}

function lineRow(l: LineRecord): HTMLElement {
  const row = el('button', 'line-row');
  row.onclick = () => opts.onSelect(l.id);
  const badge = el('span', 'badge', l.ref);
  badge.style.background = l.colour;
  badge.style.color = textOn(l.colour);
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
  badge.style.color = textOn(line.colour);
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
  // Filled in by setLinePunctuality once the score file has loaded. Empty
  // until then rather than showing a spinner: the panel's own content is
  // already on screen and complete, and a placeholder for a section that may
  // turn out not to exist for this line is worse than a section that appears.
  host.appendChild(el('div', 'detail-punctuality'));
}

/**
 * Add the punctuality section to the open line panel, or leave it empty when
 * this line has no score.
 *
 * A line is unscored for ordinary reasons - it is a tram, it runs too rarely
 * to measure, DB publishes no realtime at the stations it calls at - so the
 * absence is stated once, plainly, and not explained away. `line` is passed
 * back in so a score arriving after the rider has selected something else can
 * be discarded rather than painted onto the wrong line.
 */
export function setLinePunctuality(
  lineId: string, score: LineScore | null, meta: PunctualityFile | null,
) {
  const host = document.getElementById('detail')?.querySelector<HTMLElement>('.detail-punctuality');
  if (!host || host.dataset.line === lineId) return;
  host.dataset.line = lineId;
  host.innerHTML = '';
  if (!meta) return; // No score file at all - say nothing, not "no data".

  const s = t();
  const head = el('div', 'punct-head');
  head.append(
    el('h3', '', s.punctuality),
    el('span', 'punct-window', s.punctualityWindow(meta.window.months, formatMonth(meta.window.to))),
  );
  host.appendChild(head);

  if (!score) {
    host.appendChild(el('p', 'muted small', s.noPunctuality));
    return;
  }

  const { aggregate } = score;
  const pct = Math.round(aggregate.onTime * 100);
  const headline = el('div', 'punct-headline');
  headline.append(el('span', 'punct-pct', `${pct}%`), el('span', 'punct-unit', s.onTimeShare));
  host.appendChild(headline);

  // The band bar, not a bell curve. Departure delay is zero-inflated with a
  // hard floor and a long right tail - a normal curve fitted to its mean and
  // standard deviation would put nearly a third of departures at a *negative*
  // delay - so the shape is shown as the measured shares themselves.
  const bar = el('div', 'punct-bands');
  bar.title = s.onTimeExplainer(meta.onTimeThresholdMin);
  for (const band of bands(score, meta.bucketEdges, meta.onTimeThresholdMin)) {
    const seg = el('span', `punct-band punct-band-${band.key}`);
    seg.style.width = `${band.share * 100}%`;
    seg.title = `${s.band[band.key]} — ${(band.share * 100).toFixed(1)}%`;
    bar.appendChild(seg);
  }
  host.appendChild(bar);

  const legend = el('div', 'punct-legend');
  for (const band of bands(score, meta.bucketEdges, meta.onTimeThresholdMin)) {
    const item = el('span', 'punct-legend-item');
    item.append(el('span', `punct-swatch punct-band-${band.key}`), el('span', '', s.band[band.key]));
    legend.appendChild(item);
  }
  host.appendChild(legend);

  // Median and 90th percentile rather than mean and standard deviation: the
  // mean of this distribution sits at about its 70th percentile, so it is
  // worse than the trip most riders actually take, and reporting it as
  // "typical" is wrong in both directions at once.
  const facts = el('dl', 'detail-meta');
  const mins = (v: number) => s.minutesLate(formatMinutes(v, meta.bucketEdges));
  facts.append(
    el('dt', '', s.typicalDelay), el('dd', '', mins(aggregate.median)),
    el('dt', '', s.oneInTen), el('dd', '', mins(aggregate.p90)),
    el('dt', '', s.cancelRate), el('dd', '', `${(aggregate.cancelRate * 100).toFixed(1)}%`),
  );
  host.append(facts, el('p', 'punct-n muted small', s.departureCount(aggregate.n)));

  const stations = worstFirst(score);
  if (!stations.length) return;
  host.appendChild(el('h4', 'punct-sub', s.byStation));
  const list = el('div', 'punct-stations');

  const header = el('div', 'punct-row punct-row-head');
  header.append(
    el('span', '', ''),
    el('span', '', s.onTimeShare),
    el('span', '', s.typicalShort),
    el('span', '', s.p90Short),
  );
  list.appendChild(header);

  for (const [name, st] of stations) {
    const row = el('div', 'punct-row');
    const share = el('span', 'punct-value', `${Math.round(st.onTime * 100)}%`);
    // The on-time column carries the ramp the gauge used, so the list still
    // scans as a red-to-green ranking now that the per-row bar is gone.
    share.style.color = punctualityColour(st.onTime);
    row.append(
      el('span', 'punct-station', name),
      share,
      el('span', 'punct-value muted', formatMinutes(st.median, meta.bucketEdges)),
      el('span', 'punct-value muted', formatMinutes(st.p90, meta.bucketEdges)),
    );
    row.title = `${name} — ${s.departureCount(st.n)}`;
    list.appendChild(row);
  }
  host.appendChild(list);
}

/** "2026-07" as the month a rider reads, not as a key. */
function formatMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en', {
    month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * On-time share to a colour, ramped over 50%-100%. LNVG red at the bottom -
 * the same attention colour the reference map gives its long-distance spines,
 * and the one the departure board already uses for a delay - through amber to
 * green.
 */
function punctualityColour(onTime: number): string {
  const scaled = Math.min(1, Math.max(0, (onTime - 0.5) / 0.5));
  const hue = Math.round(scaled * 120); // 0 red -> 120 green
  return `hsl(${hue} 70% 42%)`;
}

export function setStatus(message: string) {
  const node = document.getElementById('status');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  window.setTimeout(() => node.classList.remove('show'), 2400);
}

/** Sidebar, legend, filters, search and the line detail panel. */

import { MODES, MODE_SPECS, textOn, type Mode } from '../shared/lnvg.ts';
import { t } from './strings.ts';
import type { LineRecord, Registry } from './main.ts';
import {
  worstFirst,
  bands,
  formatMinutes,
  type LineScore,
  type PunctualityFile,
} from './punctuality.ts';
import type { Tab, ViewState } from './state.ts';
import { renderPlanner, type PlannerHost } from './planner.ts';
import { endMoved, formatDate, type ClosureRecord } from './closures.ts';
import {
  allOperators,
  drawsEveryOperator,
  drawsNoOperator,
  noOperators,
  operatorShown,
  withOperator,
  type OperatorFilter,
} from './operators.ts';

export { compareLines };

export interface ChromeOptions {
  registry: Registry;
  state: ViewState;
  onToggleMode: (mode: Mode, on: boolean) => void;
  onOperators: (filter: OperatorFilter) => void;
  onToggleClosures: (on: boolean) => void;
  onToggleSheet: () => void;
  onSelect: (lineId: string) => void;
  onFlyToStation: (lngLat: [number, number]) => void;
  searchStations: (q: string) => { name: string; lngLat: [number, number] }[];
  onTab: (tab: Tab) => void;
  plannerHost: PlannerHost;
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
  'ICE',
  'IC',
  'EC',
  'ECE',
  'FLX',
  'NJ',
  'EN',
  'RJ',
  'TGV',
  'RE',
  'RB',
  'S',
  'U',
  'STR',
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

  const ka = refSortKey(a.ref),
    kb = refSortKey(b.ref);
  return (
    ka[0] - kb[0] ||
    ka[1].localeCompare(kb[1], 'de') ||
    ka[2] - kb[2] ||
    ka[3].localeCompare(kb[3], 'de')
  );
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string,
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
  btn.onclick = () => {
    if (!dragged) opts.onToggleSheet();
  };

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

interface ModeRow {
  row: HTMLElement;
  box: HTMLInputElement;
  count: HTMLElement;
}

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

  // Stop symbology, matching the map: a bar laid across the lines that call,
  // so its length is the answer and not decoration. The third row is the one
  // worth spelling out - a gap in a bar is a line that does not stop.
  const legend = el('div', 'legend');
  legend.innerHTML = `
    <div class="legend-row"><span class="stopmark"><i></i></span>${s.stopOne}</div>
    <div class="legend-row"><span class="stopmark"><i class="wide"></i></span>${s.stopShared}</div>
    <div class="legend-row"><span class="stopmark"><i class="upper"></i><i class="lower"></i>
      </span>${s.stopSkipped}</div>`;
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
    const n = inView ? (inView.get(mode) ?? 0) : (opts.registry.counts.byMode[mode] ?? 0);
    const visible = !on || pinnedModes.has(mode) || n > 0;

    row.hidden = !visible;
    box.checked = on;
    // A hidden mode has no count: nothing of it is drawn to count.
    count.textContent = on ? String(n) : '';
    if (visible) shown++;
  }
  emptyNote!.hidden = shown > 0;
}

// ---------------------------------------------------------------------------
// Construction
//
// Its own panel rather than a sixth row in the mode legend: closures are not a
// mode of transport, they are an annotation over all of them, and a rider
// reading "Regional 14" next to "Construction 9" would reasonably take the
// second number to mean nine more lines.
//
// The count follows the same rule as the mode counts - what is on the screen,
// not what the country has - because that is the only number a reader can check
// against what they are looking at.
// ---------------------------------------------------------------------------

let closureCountEl: HTMLElement | null = null;
let closureDayEl: HTMLElement | null = null;
let closuresInView: number | null = null;

export function setVisibleClosures(n: number) {
  closuresInView = n;
  syncClosures();
}

function syncClosures() {
  if (!closureCountEl) return;
  const s = t();
  if (!opts.state.closures) {
    closureCountEl.textContent = '';
    return;
  }
  closureCountEl.textContent =
    closuresInView === null
      ? ''
      : closuresInView
        ? s.closureCount(closuresInView)
        : s.noClosuresInView;
}

function buildClosures(): HTMLElement {
  const s = t();
  const box = el('div', 'panel');
  box.appendChild(el('h2', '', s.closures));

  const row = el('label', 'toggle');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = opts.state.closures;
  cb.onchange = () => {
    opts.onToggleClosures(cb.checked);
    syncClosures();
  };
  closureCountEl = el('span', 'count');
  row.append(cb, el('span', 'label', s.showClosures), closureCountEl);
  box.appendChild(row);

  const legend = el('div', 'legend');
  legend.innerHTML = `
    <div class="legend-row"><span class="hazard major"></span>${s.closureLegendMajor}</div>
    <div class="legend-row"><span class="hazard minor"></span>${s.closureLegendMinor}</div>`;
  box.appendChild(legend);

  // Said once, in the sidebar, rather than on every panel: the overlay is the
  // plan as it stood when the tiles were built, not a live picture.
  closureDayEl = el('p', 'muted small');
  box.appendChild(closureDayEl);
  syncClosureDay();

  syncClosures();
  return box;
}

/**
 * The day the drawn closures describe, read off the tiles rather than passed in
 * through `ChromeOptions`: it is not known when the sidebar is first drawn,
 * because no tile has loaded yet.
 *
 * Written into the note in place rather than by redrawing the sidebar. The
 * redraw arrives a second or so after load, which is exactly when someone may
 * already be typing in the search box, and rebuilding the sidebar under them
 * would take what they had typed with it.
 */
let closureDay = '';

function syncClosureDay() {
  if (!closureDayEl) return;
  closureDayEl.textContent = closureDay ? t().closureAsOf(formatDate(closureDay)) : '';
  closureDayEl.hidden = !closureDay;
}

export function setClosureDay(day: string) {
  if (day === closureDay) return;
  closureDay = day;
  syncClosureDay();
}

// ---------------------------------------------------------------------------
// Operators
//
// The same shape as the mode legend, and for the same reason: a drop-down that
// can hold one value can only ever answer "show me this operator", where the
// question riders actually have - which of these companies am I looking at,
// and what does the map look like without that one - needs a set. So the
// section is a master switch over a list of checkboxes: all on by default, all
// off in one click, and any mixture in between.
//
// The list is scoped to the view like everything else in this sidebar. Nearly
// three hundred operators run something in the data and a dozen or so are ever
// on screen, so a national list would be a scroll through companies that run
// nothing the reader can see. Which also means the rows come and go as the map
// moves, so the list is reconciled rather than rebuilt, and a row already in
// its place is left alone rather than re-inserted: both would keep the reader's
// pointer over the same box, only the second keeps their keyboard focus on it.
// ---------------------------------------------------------------------------

interface OperatorRow {
  row: HTMLElement;
  box: HTMLInputElement;
  count: HTMLElement;
}

let operatorList: HTMLElement | null = null;
let operatorMaster: HTMLInputElement | null = null;
let operatorCount: HTMLElement | null = null;
let operatorEmpty: HTMLElement | null = null;
const operatorRows = new Map<string, OperatorRow>();

/** Lines in view per operator, or null until the map has first settled. */
let operatorsInView: Map<string, number> | null = null;

export function setVisibleOperators(counts: Map<string, number>) {
  operatorsInView = counts;
  syncOperators();
}

function buildOperators(): HTMLElement {
  const s = t();
  const box = el('div', 'panel');
  box.appendChild(el('h2', '', s.operators));

  const master = el('label', 'toggle master');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.onchange = () => {
    // Read from the filter rather than from the box: a tri-state checkbox
    // clicked out of its indeterminate state reports whatever the browser
    // decided, and the switch means one thing in each direction - if anything
    // at all is filtered, show everything; otherwise show nothing.
    opts.onOperators(drawsEveryOperator(opts.state.operators) ? noOperators() : allOperators());
    syncOperators();
    fillLines();
  };
  operatorMaster = cb;
  operatorCount = el('span', 'count');
  master.append(cb, el('span', 'label', s.allOperators), operatorCount);
  box.appendChild(master);

  operatorRows.clear();
  operatorList = el('div', 'operator-list');
  box.appendChild(operatorList);

  operatorEmpty = el('p', 'muted', s.noOperatorsInView);
  box.appendChild(operatorEmpty);

  syncOperators();
  return box;
}

function operatorRow(name: string): OperatorRow {
  const row = el('label', 'toggle');
  const box = el('input');
  box.type = 'checkbox';
  box.onchange = () => {
    opts.onOperators(withOperator(opts.state.operators, name, box.checked));
    // The map recounts on its next idle; sync now so the row answers the click
    // rather than a frame later.
    syncOperators();
    fillLines();
  };
  const count = el('span', 'count');
  // Text, not markup: the name is whatever an OSM `operator` tag says, and
  // this is the one label in the sidebar that does not come from strings.ts.
  const label = el('span', 'label');
  label.textContent = name;
  // They run long - "Verkehrsverbund Mittelsachsen GmbH" - and the row is not
  // that wide, so the full name goes on the title for the ones the ellipsis
  // eats.
  label.title = name;
  row.append(box, label, count);
  return { row, box, count };
}

function syncOperators() {
  if (!operatorList || !operatorMaster || !operatorCount || !operatorEmpty) return;
  const filter = opts.state.operators;
  const counts = operatorsInView;

  const names = counts ? [...counts.keys()].sort((a, b) => a.localeCompare(b, 'de')) : [];

  for (const [name, row] of operatorRows) {
    if (counts?.has(name)) continue;
    row.row.remove();
    operatorRows.delete(name);
  }
  names.forEach((name, i) => {
    let row = operatorRows.get(name);
    if (!row) {
      row = operatorRow(name);
      operatorRows.set(name, row);
    }
    row.box.checked = operatorShown(filter, name);
    // Unlike a switched-off mode, a switched-off operator keeps its count. The
    // number is read off the unfiltered layers, so it stays true either way,
    // and on an off row it answers the only question that row raises: how much
    // of what I am looking at would come back.
    row.count.textContent = String(counts?.get(name) ?? 0);
    // Only moved when it is not already where it belongs. Re-inserting a node
    // that is already in place is not free: it blurs whatever inside it had
    // the focus, which on a settled view is the checkbox the reader has just
    // reached with the keyboard.
    const at = operatorList!.children[i];
    if (at !== row.row) operatorList!.insertBefore(row.row, at ?? null);
  });

  // Everything, nothing, or some mixture - which is the one state a plain
  // checkbox cannot show, so it gets the indeterminate dash.
  const every = drawsEveryOperator(filter);
  const none = drawsNoOperator(filter);
  operatorMaster.checked = !none;
  operatorMaster.indeterminate = !every && !none;

  operatorCount.textContent = counts ? String(names.length) : '';
  // Before the map has settled there is no view to have operators in, and
  // "none in view" would be a claim about a count nobody has taken yet.
  operatorEmpty.hidden = !counts || names.length > 0;
}

/**
 * Explore and Plan share the sidebar, so every reference the Explore half keeps
 * into the DOM has to be dropped when the Plan half replaces it. Each `sync*`
 * already no-ops on a null, which turns "the legend is not on screen" from a
 * crash into nothing happening - which is what it should be.
 */
function clearExploreRefs() {
  modeBox = null;
  modeRows = new Map();
  emptyNote = null;
  closureCountEl = null;
  closureDayEl = null;
  operatorList = null;
  operatorMaster = null;
  operatorCount = null;
  operatorEmpty = null;
  operatorRows.clear();
  lineList = null;
}

function tabBar(): HTMLElement {
  const s = t();
  const bar = el('div', 'tabs');
  bar.setAttribute('role', 'tablist');
  (
    [
      ['explore', s.tabExplore],
      ['plan', s.tabPlan],
    ] as [Tab, string][]
  ).forEach(([tab, label]) => {
    const on = opts.state.tab === tab;
    const b = el('button', `tab${on ? ' on' : ''}`, label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(on));
    b.onclick = () => opts.onTab(tab);
    bar.appendChild(b);
  });
  return bar;
}

function draw() {
  const { state } = opts;
  const s = t();
  const root = document.getElementById('sidebar')!;
  root.innerHTML = '';

  root.appendChild(sheetHandle());
  root.appendChild(tabBar());

  if (state.tab === 'plan') {
    clearExploreRefs();
    const box = el('div', 'plan-root');
    root.appendChild(box);
    renderPlanner(box, opts.plannerHost);
    root.appendChild(buildFooter());
    return;
  }

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

  // --- construction ---------------------------------------------------------
  root.appendChild(buildClosures());

  // --- operators ------------------------------------------------------------
  root.appendChild(buildOperators());

  // --- line index -----------------------------------------------------------
  const linesBox = el('div', 'panel');
  linesBox.appendChild(el('h2', '', s.lines));
  lineList = el('div', 'line-list');
  fillLines();
  linesBox.appendChild(lineList);
  root.appendChild(linesBox);

  root.appendChild(buildFooter());
}

const REPO = 'https://github.com/jnslmk/openrailtransitmap';

/**
 * Which build this is: the commit the bundle was made from, linked to that
 * commit, and the moment it was made. The site redeploys nightly off whatever
 * `main` holds, so "the current version" is otherwise unanswerable from the
 * page itself - and a bug report that names a build is worth several that do
 * not.
 *
 * The date is shown in the reader's own time zone, with the exact stamp kept on
 * the `title` for anyone comparing against a workflow run. A bundle built
 * outside a git checkout carries no commit, and then the line is omitted
 * rather than filled with a placeholder that would read as a real build.
 */
function buildStamp(): string {
  if (!__BUILD_COMMIT__) return '';
  const when = new Date(__BUILD_TIME__);
  const time = Number.isNaN(when.getTime())
    ? ''
    : when.toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
  const link = `<a href="${REPO}/commit/${__BUILD_COMMIT__}"><code>${__BUILD_COMMIT__}</code></a>`;
  return `<p class="build" title="${__BUILD_TIME__}">${t().buildStamp(link, time)}</p>`;
}

/**
 * The credits, which belong under either tab: a route drawn in the Plan tab is
 * as much Transitous' work as a departure board is, and the coach lines under
 * both are FlixMobility's.
 */
function buildFooter(): HTMLElement {
  const s = t();
  const { registry } = opts;
  const footer = el(
    'footer',
    'panel attrib',
    `
    <p class="meta">${s.lineCount(registry.counts.lines)} · ${s.stationCount(registry.counts.stations)}</p>
    <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> contributors · ODbL<br>
    <a href="${REPO}">Source on GitHub</a>
    <span class="live-attrib" hidden>${s.liveAttribution}</span>
    <span class="punct-attrib" hidden>${s.punctualityAttribution}</span>
    <span class="closure-attrib" hidden>${s.closureAttribution}</span>
    <span class="coach-attrib" hidden>${s.coachAttribution}</span>
    <span class="routing-attrib" hidden>${s.planAttribution}</span>
    ${buildStamp()}`,
  );
  liveAttribEl = footer.querySelector('.live-attrib');
  liveAttribEl!.hidden = !liveDataUsed;
  punctAttribEl = footer.querySelector('.punct-attrib');
  punctAttribEl!.hidden = !punctualityUsed;
  closureAttribEl = footer.querySelector('.closure-attrib');
  closureAttribEl!.hidden = !closuresUsed;
  coachAttribEl = footer.querySelector('.coach-attrib');
  coachAttribEl!.hidden = !coachUsed;
  routingAttribEl = footer.querySelector('.routing-attrib');
  routingAttribEl!.hidden = !routingUsed;
  return footer;
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
 * DB InfraGO publishes the construction plan as information rather than as open
 * data, so it is credited wherever it is shown - the same once-only latch the
 * other two sources use, set the first time a closure is actually drawn.
 */
let closureAttribEl: HTMLElement | null = null;
let closuresUsed = false;

export function setClosureAttributionUsed() {
  if (closuresUsed) return;
  closuresUsed = true;
  if (closureAttribEl) closureAttribEl.hidden = false;
}

/**
 * The coach network comes out of the operator's own GTFS, which - like the
 * construction plan, and unlike everything else on this map - is published
 * without a licence attached. Same latch, earned the first time a coach line is
 * counted in view rather than by a click, since it is drawn before anyone
 * touches it. See pipeline/coach.ts.
 */
let coachAttribEl: HTMLElement | null = null;
let coachUsed = false;

export function setCoachAttributionUsed() {
  if (coachUsed) return;
  coachUsed = true;
  if (coachAttribEl) coachAttribEl.hidden = false;
}

/**
 * Transitous asks for visible attribution while its data is on screen, which
 * for the planner means from the first itinerary it returns.
 */
let routingAttribEl: HTMLElement | null = null;
let routingUsed = false;

export function setRoutingAttributionUsed() {
  if (routingUsed) return;
  routingUsed = true;
  if (routingAttribEl) routingAttribEl.hidden = false;
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
    .filter((l) => operatorShown(state.operators, l.operator))
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
  lineId: string,
  score: LineScore | null,
  meta: PunctualityFile | null,
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
    el(
      'span',
      'punct-window',
      s.punctualityWindow(meta.window.months, formatMonth(meta.window.to)),
    ),
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
    item.append(
      el('span', `punct-swatch punct-band-${band.key}`),
      el('span', '', s.band[band.key]),
    );
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
    el('dt', '', s.typicalDelay),
    el('dd', '', mins(aggregate.median)),
    el('dt', '', s.oneInTen),
    el('dd', '', mins(aggregate.p90)),
    el('dt', '', s.cancelRate),
    el('dd', '', `${(aggregate.cancelRate * 100).toFixed(1)}%`),
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

// ---------------------------------------------------------------------------
// Closure detail panel
// ---------------------------------------------------------------------------

/**
 * The panel for one construction closure, in the same slot as the line panel -
 * only one of the two can be the answer to "what did I just click".
 *
 * It leads with the effect rather than with the works, because "Line closed" is
 * the fact a reader is after and "Points renewal" is why. The history section
 * only appears once the log has something to say: on a closure first seen today
 * there is nothing to report but the fact that we started watching, and a row
 * reading "Rescheduled 0 times" would dress that up as a finding.
 */
export function renderClosurePanel(closure: ClosureRecord, handlers: { onClose: () => void }) {
  const host = document.getElementById('detail')!;
  host.innerHTML = '';
  host.classList.add('open');

  const s = t();
  const head = el('div', 'detail-head');
  const badge = el('span', `badge big hazard-badge effect-${closure.effect}`, '\u26A0');
  head.append(badge, el('div', 'detail-title', s.closureEffect[closure.effect]));

  const close = el('button', 'close', '\u00d7');
  close.title = s.close;
  close.onclick = handlers.onClose;
  head.appendChild(close);
  host.appendChild(head);

  host.appendChild(el('p', 'closure-section', closure.section));

  const rows: [string, string][] = [
    [s.closureWorks, closure.works || '\u2014'],
    [s.closureLine, closure.routes || '\u2014'],
  ];
  // Which track only where there is a choice. A full closure takes both by
  // definition, and a restriction inside one station is not about a running
  // direction at all - stating it there is noise dressed as detail.
  if (!closure.point && closure.effect !== 'closed') {
    rows.push([s.closureTrack, s.closureDirection[closure.direction]]);
  }
  rows.push([s.closureHours, closure.hours || s.closureAllDay]);
  rows.push([s.closureFrom, formatDate(closure.begin)]);
  rows.push([s.closureUntil, formatDate(closure.end)]);

  const table = el('dl', 'detail-meta');
  for (const [k, v] of rows) table.append(el('dt', '', k), el('dd', '', v));
  host.appendChild(table);

  host.appendChild(closureHistory(closure));
}

/**
 * What our own log knows about this closure.
 *
 * There is no upstream archive to read - DB publishes the plan as it stands and
 * nothing before it - so this is the record the nightly job has kept since it
 * first ran, and it says so when it has nothing. The interesting case is a
 * possession whose end date has moved: that is the fact no snapshot of the
 * current plan can tell you, and the reason the log exists at all.
 */
function closureHistory(closure: ClosureRecord): HTMLElement {
  const s = t();
  const box = el('div', 'closure-history');
  box.appendChild(el('h4', 'punct-sub', s.closureHistory));

  if (!closure.since) {
    box.appendChild(el('p', 'muted small', s.closureNoHistory));
    return box;
  }

  const list = el('ul', 'closure-log');
  list.appendChild(el('li', '', `${s.closureSince} ${formatDate(closure.since)}`));

  const moved = endMoved(closure);
  if (moved === 'later') {
    list.appendChild(el('li', 'moved-later', s.closureMovedLater(formatDate(closure.firstEnd))));
  } else if (moved === 'earlier') {
    list.appendChild(el('li', '', s.closureMovedEarlier(formatDate(closure.firstEnd))));
  }
  if (closure.extended > 0) {
    list.appendChild(el('li', '', s.closureExtended(closure.extended)));
  }
  box.appendChild(list);
  return box;
}

/** "2026-07" as the month a rider reads, not as a key. */
function formatMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
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

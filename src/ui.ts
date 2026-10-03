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
import type { ChromeMode, Tab, ViewState } from './state.ts';
import { renderPlanner, type PlannerHost } from './planner.ts';
import {
  endMoved,
  formatDate,
  progressOn,
  projectSearchUrl,
  type ClosureRecord,
} from './closures.ts';
import { MAX_MOVES, spanDays } from '../shared/closures.ts';
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
  /** Ask for a different sheet size: peek, working, reading or map-only. */
  onSheetMode: (mode: ChromeMode) => void;
  onSelect: (lineId: string) => void;
  /** Fly to a station and open its inspector. */
  onOpenStation: (station: StationRecord) => void;
  searchStations: (q: string) => StationRecord[];
  onTab: (tab: Tab) => void;
  plannerHost: PlannerHost;
}

/**
 * A station as both the map's hit test and the search can describe it: what it
 * is called, how to write a link to it, where it is, and the lines that call.
 * Built in main.ts from the tiles, rendered here, so the inspector never has to
 * look a line up in the registry itself.
 */
export interface StationRecord {
  id: string;
  name: string;
  uicRef: string;
  stopId: string;
  at: [number, number];
  lines: LineRecord[];
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

/**
 * Build an element.
 *
 * The third argument is text, never markup. Almost every label in this file
 * comes from a tile or a feed - a station name, an operator name, a line ref,
 * a UIC - and a shared boundary that escapes by default is the only kind that
 * stays escaped as callers change. The two places that genuinely need markup
 * (the legend keys and the footer credits) set `innerHTML` themselves, on
 * strings this file owns.
 */
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let opts: ChromeOptions;

/**
 * What the inspector is currently showing, so the sheet's handle can name it
 * rather than calling every selection "search, filters and lines".
 */
let inspectorTitle: string | null = null;
/** Where focus goes when the inspector closes: whatever opened it. */
let returnFocus: HTMLElement | null = null;
/** Scroll in both workspace regions survives a hidden drawer or sheet. */
let workspaceScroll = { head: 0, body: 0 };
let workspaceVisible = false;
let lastFocus: HTMLElement | null = null;
/**
 * What the inspector is showing, as `kind:id`, so a repaint of the same thing
 * is a no-op. `applySelection` runs on every tab switch, filter change and
 * drawn itinerary; rebuilding the panel each time would put the reader's scroll
 * and their place in a long evidence list back to the top for no reason.
 */
let shownKey: string | null = null;
/**
 * The one close owner. Every panel's Back and × call through this, so a caller
 * that repaints the same selection only has to re-point the handler rather than
 * rebuild the buttons.
 */
let inspectorClose: (() => void) | null = null;

export function renderChrome(o: ChromeOptions) {
  opts = o;
  mountSheetControls();
  buildSidebar();
  renderChrome.rerender();
  document.addEventListener('focusin', (event) => {
    if (event.target instanceof HTMLElement) lastFocus = event.target;
  });
  window.matchMedia('(max-width: 820px)').addEventListener('change', syncWorkspaceLayout);
  window.matchMedia('(max-width: 1199px)').addEventListener('change', syncWorkspaceLayout);
  syncWorkspaceLayout();
}

/**
 * Refresh only what a context switch changes: which half of the workspace is
 * showing, the filter summary and the sheet's own label.
 *
 * The bodies themselves are mounted once and never rebuilt. That is what lets
 * an open filter disclosure, a search query, a half-typed journey and a scroll
 * position all survive selecting a line, and what makes closing a selection
 * unable to move the reader's place in the workspace.
 */
renderChrome.rerender = () => syncChrome();

function syncChrome() {
  syncTab();
  syncFilterSummary();
  syncSheetSummary();
}

// ---------------------------------------------------------------------------
// Sheet controls
//
// On a phone the workspace and the inspector share one content slot under the
// map, and these controls are the only part of it that stays put: a handle that
// folds the slot to a summary and a button that takes it to reading size.
// Mounted once, outside the sidebar, so a fold never redraws what it folds.
// ---------------------------------------------------------------------------

let handleEl: HTMLButtonElement | null = null;
let expandEl: HTMLButtonElement | null = null;

function mountSheetControls() {
  const host = document.querySelector<HTMLElement>('.sheet-controls');
  if (!host || host.dataset.mounted) return;
  host.dataset.mounted = '1';
  host.append(sheetHandle(), sheetExpand());
  syncSheetHandle(opts.state.chrome);
}

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
    // Up asks for more room, down for less: the gesture names the direction,
    // so the sheet takes the nearest state that way.
    opts.onSheetMode(dy < 0 ? 'expanded' : 'peek');
  });
  btn.onclick = () => {
    if (dragged) return;
    opts.onSheetMode(opts.state.chrome === 'full' ? 'peek' : 'full');
  };

  btn.append(el('span', 'grabber'), el('span', 'sheet-label'));
  handleEl = btn;
  return btn;
}

/** The explicit way between working and reading size, beside the handle. */
function sheetExpand(): HTMLElement {
  const btn = el('button', 'sheet-expand');
  btn.type = 'button';
  btn.onclick = () => opts.onSheetMode(opts.state.chrome === 'expanded' ? 'full' : 'expanded');
  expandEl = btn;
  return btn;
}

/**
 * Update the sheet controls in place; redrawing the sheet for a fold is
 * wasteful, and on the narrow layout it is the one thing that must never
 * flicker.
 */
export function syncSheetHandle(mode: ChromeMode) {
  const s = t();
  if (expandEl) {
    const expanded = mode === 'expanded';
    const label = expanded ? s.reducePanel : s.expandReading;
    expandEl.textContent = label;
    expandEl.setAttribute('aria-label', label);
    expandEl.setAttribute('aria-pressed', String(expanded));
  }
  syncSheetSummary();
  syncWorkspaceLayout();
}

/**
 * What the slot is showing, as the handle's visible label and as half of its
 * accessible name - the other half being what tapping it will do, so a screen
 * reader hears both what is folded away and how to open it.
 */
function syncSheetSummary() {
  if (!handleEl) return;
  const s = t();
  const summary = inspectorTitle ?? (opts.state.tab === 'plan' ? s.sheetPlan : s.panelPeek);
  const action = opts.state.chrome === 'peek' ? s.expandPanel : s.collapsePanel;
  const text = handleEl.querySelector('.sheet-label');
  if (text) text.textContent = summary;
  handleEl.title = action;
  handleEl.setAttribute('aria-label', `${summary} \u2014 ${action}`);
  handleEl.setAttribute('aria-expanded', String(opts.state.chrome !== 'peek'));
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

/**
 * A key, folded away until it is asked for. Native `<details>` so it is
 * labelled, keyboard-operable and remembered by the browser without a line of
 * script - and so opening filters never turns the sidebar into a wall of
 * symbols before the reader has seen a single line.
 */
function legendDisclosure(body: HTMLElement, label: string): HTMLElement {
  const details = el('details', 'legend-disclosure');
  details.appendChild(el('summary', '', label));
  details.appendChild(body);
  return details;
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
  // Its own disclosure, because a key is only wanted by the reader who is
  // already puzzled by a mark.
  const legend = el('div', 'legend');
  legend.innerHTML = `
    <div class="legend-row"><span class="stopmark"><i></i></span>${s.stopOne}</div>
    <div class="legend-row"><span class="stopmark"><i class="wide"></i></span>${s.stopShared}</div>
    <div class="legend-row"><span class="stopmark"><i class="upper"></i><i class="lower"></i>
      </span>${s.stopSkipped}</div>`;
  box.appendChild(legendDisclosure(legend, s.legend));

  modeBox = box;
  syncModes();
  return box;
}

function syncModes() {
  if (!modeBox) return;
  syncFilterSummary();

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
  if (closureCountEl) {
    const s = t();
    closureCountEl.textContent = !opts.state.closures
      ? ''
      : closuresInView === null
        ? ''
        : closuresInView
          ? s.closureCount(closuresInView)
          : s.noClosuresInView;
  }
  syncFilterSummary();
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

  // Four rows rather than two: the effect and the length are separate axes on
  // the map now, and a key that only explained one of them would leave the
  // other looking like a rendering accident.
  const legend = el('div', 'legend');
  legend.innerHTML = `
    <div class="legend-row"><span class="hazard closed"></span>${s.closureLegendMajor}</div>
    <div class="legend-row"><span class="hazard single"></span>${s.closureLegendSingle}</div>
    <div class="legend-row"><span class="hazard minor"></span>${s.closureLegendMinor}</div>
    <div class="legend-row"><span class="hazard-bands"><i></i><i></i><i></i></span>${s.closureLegendBands}</div>`;
  box.appendChild(legendDisclosure(legend, s.legend));

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
  mark: HTMLElement;
}

let operatorList: HTMLElement | null = null;
let operatorMaster: HTMLInputElement | null = null;
let operatorCount: HTMLElement | null = null;
let operatorEmpty: HTMLElement | null = null;
const operatorRows = new Map<string, OperatorRow>();

/** Lines in view per operator, or null until the map has first settled. */
let operatorsInView: Map<string, number> | null = null;

/**
 * Operator name to logo URL. Empty until the manifest has loaded, and empty
 * for good in a checkout that has never run the pipeline - a row without a
 * mark is a row with a name in it, which is what the panel had before.
 */
let operatorLogos = new Map<string, string>();

export function setVisibleOperators(counts: Map<string, number>) {
  operatorsInView = counts;
  syncOperators();
}

/** Called once, when the logo manifest arrives. */
export function setOperatorLogos(logos: Map<string, string>) {
  operatorLogos = logos;
  // Rows built before the manifest landed have an empty mark waiting for it.
  for (const [name, row] of operatorRows) fillOperatorMark(row, name);
  syncLogoAttribution();
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
  // The mark, in a box of its own whether or not there is one to put in it:
  // two thirds of operators have a logo, and a column that collapsed on the
  // other third would step the names in and out down the list.
  const mark = el('span', 'op-mark');
  const count = el('span', 'count');
  // Text, not markup: the name is whatever an OSM `operator` tag says, and
  // this is the one label in the sidebar that does not come from strings.ts.
  const label = el('span', 'label');
  label.textContent = name;
  // They run long - "Verkehrsverbund Mittelsachsen GmbH" - and the row is not
  // that wide, so the full name goes on the title for the ones the ellipsis
  // eats.
  label.title = name;
  row.append(box, mark, label, count);
  const built = { row, box, count, mark };
  fillOperatorMark(built, name);
  return built;
}

/**
 * Put this operator's mark in its box, if there is one.
 *
 * `alt` is empty on purpose: the name is right beside it in the same row, and
 * a screen reader that read both would say every operator twice. A logo that
 * fails to load - a manifest naming a file the build did not fetch - takes
 * itself out of the row rather than leaving a broken-image glyph in it, and
 * the empty box holds the column open either way.
 */
function fillOperatorMark(row: OperatorRow, name: string) {
  const src = operatorLogos.get(name);
  row.mark.innerHTML = '';
  if (!src) return; // An empty box, holding the column open.
  const img = el('img');
  img.src = src;
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.onerror = () => img.remove();
  img.onload = () => markLogosUsed();
  row.mark.appendChild(img);
}

function syncOperators() {
  syncFilterSummary();
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

let exploreBody: HTMLElement | null = null;
let planRoot: HTMLElement | null = null;
let searchBoxEl: HTMLElement | null = null;
let filterDisclosure: HTMLDetailsElement | null = null;
let filterSummaryEl: HTMLElement | null = null;

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
    b.dataset.tab = tab;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(on));
    b.onclick = () => opts.onTab(tab);
    bar.appendChild(b);
  });
  return bar;
}

/**
 * Build the workspace once.
 *
 * Explore and Plan are two bodies inside one shell, both mounted and only one
 * shown: the planner's half-typed journey and result list are as much the
 * reader's work as a search query is, and rebuilding either on a tab switch
 * would throw them away. The head - tabs, search, filters - is shared, and the
 * filter summary is what keeps a restriction visible when the disclosure that
 * set it is closed.
 */
function buildSidebar() {
  const s = t();
  const root = document.getElementById('sidebar')!;
  root.innerHTML = '';

  const head = el('div', 'workspace-head');
  head.appendChild(tabBar());

  // --- search ---------------------------------------------------------------
  const searchBox = el('div', 'panel');
  const input = el('input', 'search');
  input.type = 'search';
  input.placeholder = s.search;
  input.setAttribute('aria-label', s.search);
  const results = el('div', 'results');
  searchBox.append(input, results);
  searchBoxEl = searchBox;

  let timer: number | undefined;
  input.oninput = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => runSearch(input.value, results), 120);
  };

  head.append(searchBox, buildFilters());

  // --- body -----------------------------------------------------------------
  const body = el('div', 'workspace-body');

  exploreBody = el('div', 'explore-body');
  const linesBox = el('div', 'panel');
  linesBox.appendChild(el('h2', '', s.lines));
  lineList = el('div', 'line-list');
  fillLines();
  linesBox.appendChild(lineList);
  exploreBody.appendChild(linesBox);

  planRoot = el('div', 'plan-root');
  renderPlanner(planRoot, opts.plannerHost);

  body.append(exploreBody, planRoot, buildFooter());
  root.append(head, body);
  for (const region of [head, body]) {
    region.addEventListener('scroll', () => {
      if (root.getClientRects().length) rememberWorkspaceScroll();
    });
  }
  syncTab();
}

/** Show the half of the workspace the state names; the other is left mounted. */
function syncTab() {
  const plan = opts.state.tab === 'plan';
  document.querySelectorAll<HTMLButtonElement>('.tabs .tab').forEach((button) => {
    const on = button.dataset.tab === opts.state.tab;
    button.classList.toggle('on', on);
    button.setAttribute('aria-selected', String(on));
  });
  if (exploreBody) exploreBody.hidden = plan;
  if (planRoot) planRoot.hidden = !plan;
  if (searchBoxEl) searchBoxEl.hidden = plan;
  if (filterDisclosure) filterDisclosure.hidden = plan;
}

/**
 * The filter toolbar: one summary line that always states what is being held
 * back, and a native disclosure holding the switches themselves. Closed by
 * default, so the browse list is the first thing under the search box rather
 * than a wall of modes and operators the reader has not asked about.
 */
function buildFilters(): HTMLElement {
  const s = t();
  const details = el('details', 'filter-disclosure');
  const summary = el('summary');
  summary.append(el('span', '', s.filters), el('span', 'filter-summary'));
  filterSummaryEl = summary.querySelector<HTMLElement>('.filter-summary');

  const content = el('div', 'filter-content');
  content.append(buildModes(), buildClosures(), buildOperators());
  details.append(summary, content);
  filterDisclosure = details;

  // On a phone the head can only hold so much before the body disappears
  // behind it, so opening the filters takes the sheet to reading size. They
  // exist to be used, and a switch the reader then has to hunt for is worse
  // than a sheet that is briefly taller than they asked for; the handle, a
  // drag down and the Reduce button all bring it back.
  details.addEventListener('toggle', () => {
    if (!details.open || opts.state.chrome === 'expanded') return;
    if (window.matchMedia('(max-width: 820px)').matches) opts.onSheetMode('expanded');
  });

  syncFilterSummary();
  return details;
}

/**
 * What the current filters are actually holding back.
 *
 * Not a count of what is left - a count is the one thing a reader cannot check
 * against what they are looking at. Modes are named, because there are six and
 * half of them fit; operators are counted, because the list can run to three
 * hundred and the disclosure is one tap away; closures are named because the
 * switch hides a whole layer of the map. When nothing is filtered the line
 * says so, so its presence never reads as a restriction.
 */
function syncFilterSummary() {
  if (!filterSummaryEl) return;
  const s = t();
  const parts: string[] = [];

  const off = MODES.filter((m) => !opts.state.modes.has(m)).map((m) => s[m]);
  if (off.length) parts.push(s.modesOff(off.join(', ')));

  // The set names every operator the reader has deliberately moved, whichever
  // way round the filter is stated - so its size is the honest count of what
  // they have restricted, view or no view.
  const filter = opts.state.operators;
  if (drawsNoOperator(filter)) parts.push(s.operatorsAllOff);
  else if (!drawsEveryOperator(filter)) parts.push(s.operatorsOff(filter.names.size));

  if (!opts.state.closures) parts.push(s.closuresOff);

  filterSummaryEl.textContent = parts.join(' \u00b7 ') || s.allFilters;
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
  const footer = el('footer', 'panel attrib');
  // The credits are the one place that is markup rather than text: links and
  // the build stamp, built from strings and constants this file owns.
  footer.innerHTML = `
    <p class="meta">${s.lineCount(registry.counts.lines)} · ${s.stationCount(registry.counts.stations)}</p>
    <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> contributors · ODbL<br>
    <a href="${REPO}">Source on GitHub</a>
    <span class="live-attrib" hidden>${s.liveAttribution}</span>
    <span class="punct-attrib" hidden>${s.punctualityAttribution}</span>
    <span class="closure-attrib" hidden>${s.closureAttribution}</span>
    <span class="coach-attrib" hidden>${s.coachAttribution}</span>
    <span class="logo-attrib" hidden>${s.logoAttribution}</span>
    <span class="routing-attrib" hidden>${s.planAttribution}</span>
    ${buildStamp()}`;
  liveAttribEl = footer.querySelector('.live-attrib');
  liveAttribEl!.hidden = !liveDataUsed;
  punctAttribEl = footer.querySelector('.punct-attrib');
  punctAttribEl!.hidden = !punctualityUsed;
  closureAttribEl = footer.querySelector('.closure-attrib');
  closureAttribEl!.hidden = !closuresUsed;
  coachAttribEl = footer.querySelector('.coach-attrib');
  coachAttribEl!.hidden = !coachUsed;
  logoAttribEl = footer.querySelector('.logo-attrib');
  logoAttribEl!.hidden = !logosUsed;
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
 * The marks in the operator panel are public-domain files from Wikimedia
 * Commons, which asks for no attribution and gets it anyway: a reader is owed
 * the provenance of every mark on the page, and a logo carries more of an
 * implied claim than a line colour does. Same latch as the rest - set when a
 * mark actually paints, not when the manifest loads.
 */
let logoAttribEl: HTMLElement | null = null;
let logosUsed = false;

function markLogosUsed() {
  if (logosUsed) return;
  logosUsed = true;
  syncLogoAttribution();
}

function syncLogoAttribution() {
  if (logoAttribEl) logoAttribEl.hidden = !logosUsed;
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

  // A station result opens the station in the inspector and flies to it: the
  // panel is where its lines, departures and planner links live, and centring
  // the map alone would answer half the question.
  for (const st of opts.searchStations(query)) {
    const row = el('button', 'line-row');
    row.onclick = () => opts.onOpenStation(st);
    row.append(el('span', 'dot'), el('span', 'line-name', st.name));
    container.appendChild(row);
  }

  if (!container.childElementCount) {
    container.appendChild(el('p', 'muted', t().noResults));
  }
}

// ---------------------------------------------------------------------------
// Inspector
//
// The right-hand column on a desktop and the content slot on a phone, holding
// whatever is selected: a line, a station or a closure. Identity sits in the
// sticky head, the evidence scrolls under it, and metadata folds away at the
// bottom. All three open through the same shell, so Back always means the same
// thing and only ever one of them owns the column.
// ---------------------------------------------------------------------------

/**
 * Open the inspector on a selection. `identity` is the head's title row - a
 * badge and a name - and `title` the same thing as one line of plain text, for
 * the sheet's handle on a phone.
 *
 * The element holding focus before this opens is remembered as the place Back
 * should return to, but only when it lives outside the panel about to be
 * replaced: a close must never land on something the reader cannot see.
 */
function openInspector(title: string, identity: HTMLElement[]): HTMLElement {
  const host = document.getElementById('detail')!;
  const active = document.activeElement;
  const workspace = document.getElementById('sidebar')!;
  if (
    active instanceof HTMLElement &&
    !host.contains(active) &&
    (!host.classList.contains('open') || workspace.getClientRects().length)
  ) {
    returnFocus = active;
  }
  if (workspace.getClientRects().length) rememberWorkspaceScroll();

  host.innerHTML = '';
  host.classList.add('open');
  inspectorTitle = title;
  syncSheetSummary();

  const s = t();
  const head = el('div', 'inspector-head');
  const back = el('button', 'inspector-back');
  back.type = 'button';
  const chevron = el('span', 'back-chevron');
  chevron.innerHTML =
    '<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="m12 5-5 5 5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  back.append(chevron, el('span', '', s.back));
  back.onclick = () => inspectorClose?.();

  const row = el('div', 'detail-head');
  row.append(...identity);
  const close = el('button', 'close');
  close.innerHTML =
    '<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  close.type = 'button';
  close.title = s.close;
  close.setAttribute('aria-label', s.close);
  close.onclick = () => inspectorClose?.();
  row.appendChild(close);

  head.append(back, row);
  const body = el('div', 'inspector-body');
  host.append(head, body);
  syncWorkspaceLayout();
  return body;
}

/**
 * Close the inspector and hand focus back to whatever opened it.
 *
 * Called on every empty re-render, so it no-ops unless the panel is actually
 * open - otherwise merely repainting the map would move the reader's focus.
 */
function closeInspector() {
  const host = document.getElementById('detail')!;
  inspectorTitle = null;
  shownKey = null;
  inspectorClose = null;
  syncSheetSummary();
  if (!host.classList.contains('open')) return;
  host.classList.remove('open');
  host.innerHTML = '';
  const target = returnFocus;
  returnFocus = null;
  // Class removal reveals the original mounted workspace, including its inputs
  // and disclosures; put its scroll back before returning focus.
  syncWorkspaceLayout();
  if (target && target.isConnected && target.getClientRects().length) {
    target.focus({ preventScroll: true });
  } else focusWorkspace();
}

function rememberWorkspaceScroll() {
  workspaceScroll = {
    head: document.querySelector<HTMLElement>('.workspace-head')?.scrollTop ?? 0,
    body: document.querySelector<HTMLElement>('.workspace-body')?.scrollTop ?? 0,
  };
}

/** CSS owns layout; only restore context and move focus out of hidden content. */
function syncWorkspaceLayout() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const visible = sidebar.getClientRects().length > 0;
  if (visible && !workspaceVisible) {
    const head = sidebar.querySelector<HTMLElement>('.workspace-head');
    const body = sidebar.querySelector<HTMLElement>('.workspace-body');
    if (head) head.scrollTop = workspaceScroll.head;
    if (body) body.scrollTop = workspaceScroll.body;
  }
  workspaceVisible = visible;

  // A display:none transition can already have blurred the active element.
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && active !== document.body ? active : lastFocus;
  if (!focused || focused.getClientRects().length) return;
  if (sidebar.contains(focused)) returnFocus = focused;
  const detail = document.getElementById('detail');
  if (detail?.getClientRects().length) {
    const back = detail.querySelector<HTMLElement>('.inspector-back');
    const close = detail.querySelector<HTMLElement>('.close');
    (back?.getClientRects().length ? back : close)?.focus({ preventScroll: true });
  } else {
    focusWorkspace();
  }
}

/**
 * Where focus goes when the thing that opened the inspector is gone - a line's
 * row can be filtered off the map while its panel is open. Never a source the
 * reader cannot see: the sheet handle when the sheet is showing, the map
 * otherwise.
 */
function focusWorkspace() {
  if (handleEl && handleEl.getClientRects().length) {
    handleEl.focus();
    return;
  }
  document.querySelector<HTMLElement>('#map canvas')?.focus();
}

/**
 * Metadata, folded into a native disclosure after the evidence: factual, and
 * only wanted by the reader who is checking a claim rather than reading the
 * answer.
 */
function metaDisclosure(rows: [string, string][]): HTMLElement {
  const details = el('details', 'meta-disclosure');
  details.appendChild(el('summary', '', t().details));
  const table = el('dl', 'detail-meta');
  for (const [k, v] of rows) table.append(el('dt', '', k), el('dd', '', v));
  details.appendChild(table);
  return details;
}

export function renderLinePanel(line: LineRecord | null, handlers: { onClose: () => void }) {
  inspectorClose = handlers.onClose;
  if (!line) {
    closeInspector();
    return;
  }
  // Already showing this line: keep the panel, its scroll and its focus.
  const key = `line:${line.id}`;
  if (key === shownKey) return;

  const s = t();
  const badge = el('span', 'badge big', line.ref);
  badge.style.background = line.colour;
  badge.style.color = textOn(line.colour);
  const title = el('div', 'detail-title', line.name || line.ref);
  const body = openInspector(`${line.ref} \u2014 ${line.name || line.ref}`, [badge, title]);
  shownKey = key;

  // Evidence before metadata: the reader came for how the line runs, not for
  // which network filed it. The section states the wait rather than sitting
  // empty, so "still loading" and "nothing to show" cannot read the same.
  const punct = el('div', 'detail-punctuality');
  punct.dataset.line = line.id;
  punct.appendChild(el('p', 'muted small', s.loadingPunctuality));
  body.appendChild(punct);

  body.appendChild(
    metaDisclosure([
      [s.modes, s[line.mode]],
      [s.operator, line.operator || '\u2014'],
      [s.network, line.network || '\u2014'],
      [s.stations, String(line.stops)],
    ]),
  );
}

/**
 * Add the punctuality section to the open line panel, or state plainly that
 * there is none.
 *
 * A line is unscored for ordinary reasons - it is a tram, it runs too rarely
 * to measure, DB publishes no realtime at the stations it calls at - so the
 * absence is stated once, plainly, and not explained away. `lineId` is checked
 * against the panel's own record so a score arriving after the rider has
 * selected something else can be discarded rather than painted onto the wrong
 * line.
 */
export function setLinePunctuality(
  lineId: string,
  score: LineScore | null,
  meta: PunctualityFile | null,
) {
  const host = document.getElementById('detail')?.querySelector<HTMLElement>('.detail-punctuality');
  if (!host || host.dataset.line !== lineId || host.dataset.filled === lineId) return;
  host.dataset.filled = lineId;
  host.innerHTML = '';

  const s = t();
  if (!meta) {
    // A missing or unreadable score file is a fact about the panel, not
    // silence: an empty section reads as "nothing to report".
    host.appendChild(el('p', 'muted small', s.punctualityUnavailable));
    return;
  }
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
 * the fact a reader is after and "Points renewal" is why. Effect and span are
 * the evidence; the works, the line and the hours are metadata, folded away
 * behind the same disclosure the other panels use. The history section only
 * appears once the log has something to say: on a closure first seen today
 * there is nothing to report but the fact that we started watching, and a row
 * reading "Rescheduled 0 times" would dress that up as a finding.
 */
export function renderClosurePanel(closure: ClosureRecord, handlers: { onClose: () => void }) {
  inspectorClose = handlers.onClose;
  const key = `closure:${closure.id}`;
  if (key === shownKey) return;

  const s = t();
  const badge = el('span', `badge big hazard-badge effect-${closure.effect}`, '\u26A0');
  const title = el('div', 'detail-title', s.closureEffect[closure.effect]);
  const body = openInspector(s.closureEffect[closure.effect], [badge, title]);
  shownKey = key;

  body.appendChild(el('p', 'closure-section', closure.section));
  body.appendChild(closureSpan(closure));

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
  body.appendChild(metaDisclosure(rows));

  body.appendChild(closureHistory(closure));
  body.appendChild(closureLinks(closure));
}

/**
 * How long the possession runs, and how much of it is left.
 *
 * The block that answers the question the overlay could not: a weekend
 * possession and a four-month one draw as the same kind of thing on a map, and
 * the only way to tell which one you had clicked was to subtract two dates
 * yourself. The bar is measured against the day the tiles describe rather than
 * the reader's clock, for the same reason the sidebar states that day at all -
 * one clock for the whole overlay, so the bar can never say "finished" about
 * something the map is still drawing.
 *
 * A bar is only drawn once there is enough of it to read. Under a week it is
 * three fat blocks that say less than the dates either side of it, so those
 * dates are all a short possession gets.
 */
const BAR_MIN_DAYS = 7;

function closureSpan(closure: ClosureRecord): HTMLElement {
  const s = t();
  const box = el('div', `closure-span band-${closure.band}`);
  const progress = progressOn(closure, closureDay);

  const head = el('div', 'span-head');
  head.appendChild(el('span', 'span-length', s.closureSpan(closure.days)));
  if (progress) {
    head.appendChild(
      el('span', 'span-left', progress.left ? s.closureLeft(progress.left) : s.closureEndsToday),
    );
  }
  box.appendChild(head);

  if (progress && progress.total >= BAR_MIN_DAYS) {
    const bar = el('div', 'span-bar');
    const pct = (v: number) => `${(Math.min(1, Math.max(0, v)) * 100).toFixed(1)}%`;

    // The stretch first, so the elapsed fill and the tick paint over it: it is
    // background about the plan, not a third thing competing for the eye.
    if (progress.firstEndThrough !== null) {
      const added = el('div', 'span-added');
      added.style.left = pct(progress.firstEndThrough);
      added.title = s.closureFirstEndTick(formatDate(closure.firstEnd));
      bar.appendChild(added);
      const tick = el('div', 'span-tick');
      tick.style.left = pct(progress.firstEndThrough);
      bar.appendChild(tick);
    }
    const gone = el('div', 'span-gone');
    gone.style.width = pct(progress.through);
    bar.appendChild(gone);

    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', s.closureThrough(progress.gone, progress.total));
    box.appendChild(bar);
  }

  // The two dates read as the ends of the bar above them and carry no visible
  // labels for it; a reader who cannot see the bar gets the labels instead.
  const ends = el('div', 'span-ends');
  const from = el('span', '', formatDate(closure.begin));
  from.setAttribute('aria-label', `${s.closureFrom} ${formatDate(closure.begin)}`);
  const until = el('span', '', formatDate(closure.end));
  until.setAttribute('aria-label', `${s.closureUntil} ${formatDate(closure.end)}`);
  ends.append(from, until);
  box.appendChild(ends);
  return box;
}

/**
 * Where to read DB's own account of the work.
 *
 * Two links and a caveat, because a per-possession link does not exist: DB
 * InfraGO's own map puts nothing in its URL, and the feed carries no reference
 * beyond the fields already on this panel. The search is offered as a search -
 * it matches the prose on project pages, so it will sometimes turn up works
 * that merely mention the place - and the register is credited as the source
 * this record came from rather than as a page about it.
 */
function closureLinks(closure: ClosureRecord): HTMLElement {
  const s = t();
  const box = el('div', 'closure-links');
  box.appendChild(el('h4', 'punct-sub', s.closureOfficial));

  const list = el('ul', 'closure-link-list');
  const link = (href: string, text: string) => {
    const a = el('a', '', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const li = el('li');
    li.appendChild(a);
    return li;
  };
  list.append(
    link(projectSearchUrl(closure), s.closureProjectSearch),
    link('https://strecken-info.de', s.closureRegister),
  );
  box.appendChild(list);
  box.appendChild(el('p', 'muted small', s.closureProjectNote));
  return box;
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

  // Where the moves themselves are on the tile these two would only restate,
  // less precisely, what the list below says - so they are the fallback for a
  // tile built before the moves were carried, not a summary of them.
  const moved = endMoved(closure);
  if (!closure.moves.length) {
    if (moved === 'later') {
      list.appendChild(el('li', 'moved-later', s.closureMovedLater(formatDate(closure.firstEnd))));
    } else if (moved === 'earlier') {
      list.appendChild(el('li', '', s.closureMovedEarlier(formatDate(closure.firstEnd))));
    }
    if (closure.extended > 0) {
      list.appendChild(el('li', '', s.closureExtended(closure.extended)));
    }
  }
  box.appendChild(list);
  box.appendChild(closureMoves(closure));
  return box;
}

/**
 * Each time the end date moved, in the order it moved.
 *
 * "Rescheduled 3 times" is a count, and a count of a possession being pushed
 * back is the least interesting form of the fact: it cannot say whether that
 * was three weeks or three months, nor whether the moves are getting bigger -
 * which is what tells a reader whether to believe the date now on the panel.
 * Each move is a row, and the net is stated once at the end so the headline is
 * not something the reader has to add up.
 *
 * The dates are the days our log noticed, not the days DB decided: nothing
 * upstream publishes the second, and labelling one as the other would invent a
 * record. That is why the row leads with the dates that moved rather than with
 * when it happened.
 */
function closureMoves(closure: ClosureRecord): HTMLElement {
  const s = t();
  const box = el('div', 'closure-moves');
  if (!closure.moves.length) return box;

  box.appendChild(el('h4', 'punct-sub', s.closureMoves));
  const list = el('ol', 'closure-move-list');
  for (const m of closure.moves) {
    const later = m.delta > 0;
    const row = el(
      'li',
      later ? 'moved-later' : '',
      later
        ? s.closureMoveLater(formatDate(m.was), formatDate(m.now), m.delta)
        : s.closureMoveEarlier(formatDate(m.was), formatDate(m.now), -m.delta),
    );
    row.title = formatDate(m.logged);
    list.appendChild(row);
  }
  box.appendChild(list);

  // The net against the *first* end we ever recorded, not the sum of the moves:
  // the two differ once a possession has been pushed back and then pulled
  // forward again, and the one a reader means by "how much longer" is the
  // distance from where it started.
  const net = spanDays(closure.firstEnd, closure.end) - 1;
  if (net > 0) box.appendChild(el('p', 'muted small', s.closureNetLater(net)));
  if (closure.moves.length >= MAX_MOVES) {
    box.appendChild(el('p', 'muted small', s.closureMovesTruncated));
  }
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

// ---------------------------------------------------------------------------
// Station panel
// ---------------------------------------------------------------------------

export interface StationHandlers {
  onClose: () => void;
  /** A badge was clicked: select that line. */
  onLine: (lineId: string) => void;
  /** "Directions from/to here": hand this end to the planner. */
  onDirections: (dir: 'from' | 'to', station: StationRecord) => void;
  /**
   * Fill the board. main.ts owns the request, its abort generation and its
   * late-response guards; this only provides the container and the frame around
   * it.
   */
  loadDepartures: (container: HTMLElement) => void;
}

/**
 * The inspector for a station.
 *
 * Identity first, then what serves it, then what is about to leave it. The
 * departure board is the evidence and states its own loading, empty and error
 * cases; the station's own codes are metadata and fold away. Line badges are
 * the same buttons the map has always opened a line from, and the two action
 * buttons are the reason the planner lives inside the map rather than beside
 * it.
 *
 * Every piece of text here is inserted as text, not markup: the name is an OSM
 * tag and the departures come from an external API, so neither is trusted to be
 * HTML.
 */
export function renderStationPanel(station: StationRecord, handlers: StationHandlers) {
  inspectorClose = handlers.onClose;
  // A station with no id is keyed by where it is as well as what it is called:
  // two places can share a name, and reusing one's board under the other's
  // heading would be evidence for the wrong station.
  const key = station.id
    ? `station:${station.id}`
    : `station:${station.name}@${station.at[0]},${station.at[1]}`;
  if (key === shownKey) return;

  const s = t();
  const title = el('div', 'detail-title', station.name);
  const body = openInspector(station.name, [title]);
  shownKey = key;

  body.appendChild(el('div', 'pop-lines-label', s.servedBy));
  const badges = el('div', 'pop-lines');
  if (station.lines.length) {
    for (const line of station.lines) {
      const badge = el('button', 'badge', line.ref);
      badge.type = 'button';
      badge.style.background = line.colour;
      badge.style.color = textOn(line.colour);
      badge.title = line.name || line.ref;
      badge.onclick = () => handlers.onLine(line.id);
      badges.appendChild(badge);
    }
  } else {
    badges.textContent = '\u2014';
  }
  body.appendChild(badges);

  const actions = el('div', 'pop-actions');
  const action = (dir: 'from' | 'to', label: string) => {
    const b = el('button', 'pop-action', label);
    b.type = 'button';
    b.onclick = () => handlers.onDirections(dir, station);
    return b;
  };
  actions.append(action('from', s.planDirectionsFrom), action('to', s.planDirectionsTo));
  body.appendChild(actions);

  // A station with no resolved stopId has no board to show, and a labelled
  // empty section would be a claim about a station rather than about the data.
  if (station.stopId) {
    const live = el('div', 'pop-live');
    body.appendChild(live);
    handlers.loadDepartures(live);
  }

  const rows: [string, string][] = [];
  if (station.uicRef) rows.push([s.uicRef, station.uicRef]);
  if (station.stopId) rows.push([s.stopRef, station.stopId]);
  if (rows.length) body.appendChild(metaDisclosure(rows));
}

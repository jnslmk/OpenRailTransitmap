/**
 * The Plan panel: two places, a time, some chips, a bike slider, and a list of
 * ways to get there.
 *
 * ## Why it is a tab and not a page
 *
 * Google Maps' planner takes over the screen. Here the network *is* the
 * product - the whole map exists to show what runs where - so planning happens
 * in the sidebar the map already has, with the map continuous underneath and
 * never replaced. On a narrow screen that sidebar is already a bottom sheet
 * that folds to its handle, which is the phone pattern this borrows, and the
 * planner inherits it for nothing.
 *
 * ## Where the bike sits
 *
 * Not in a corner. A transit planner is a solved problem and this map does not
 * need to solve it again; what it can do that the big ones will not is take
 * seriously that a rider will cycle for an hour to reach a better train. So the
 * ride-distance slider is a first-class control with a plain-language label,
 * and the two things the data cannot honestly support - a bike-carriage
 * guarantee, and a "no bikes" claim - are refused rather than faked. See the
 * note on `bikesAllowed` in routing.ts.
 *
 * ## Load
 *
 * `plan()` is called only on a deliberate act: submit, a slider release, a
 * mode chip, Earlier/Later, Refresh routes. Never on a pan, never on a keystroke.
 * The geocoder is debounced here, because only this module knows what a keystroke is.
 */

import { t } from './strings.ts';
import {
  geocode,
  plan,
  MODE_GROUPS,
  FARE_MODES,
  ALL_TRANSIT_MODES,
  type Place,
  type PlanResult,
  type Itinerary,
  type Leg,
  type TransitMode,
  type FareFilter,
} from './routing.ts';
import { journeyView, type JourneyLeg, type Interchange, type JourneyFocus } from './itinerary.ts';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The stops on the ride slider, in minutes.
 *
 * Not a continuous range: the difference that matters is between "the station
 * near me" and "any station in the county", and it is four or five steps wide,
 * not sixty. Measured in docs/spike-transitous.md, an hour's budget reaches
 * 1,321 stops against 88 at half an hour, and the returned legs plateau at 52
 * minutes - so 90 is the last step that buys anything.
 */
export const BIKE_STEPS = [0, 10, 20, 30, 45, 60, 90];

export interface PlannerState {
  from: Place | null;
  to: Place | null;
  /** null means "leave now", which is re-evaluated at each search. */
  time: Date | null;
  arriveBy: boolean;
  /** Keys from `MODE_GROUPS`. */
  groups: Set<string>;
  /** Fare preset; anything other than `any` overrides the chips entirely. */
  fare: FareFilter;
  bikeMinutes: number;
  carriage: boolean;
  /** Index into the current result, or null. Kept in the URL so a plan is shareable. */
  selected: number | null;
}

export function defaultPlannerState(): PlannerState {
  return {
    from: null,
    to: null,
    time: null,
    arriveBy: false,
    groups: new Set(MODE_GROUPS.map((g) => g.key)),
    fare: 'any',
    bikeMinutes: 30,
    carriage: false,
    selected: null,
  };
}

export interface PlannerHost {
  state: PlannerState;
  /** Draw this itinerary on the map, or clear it. */
  onItinerary: (itinerary: Itinerary | null) => void;
  /** Highlight a leg, or zoom to a numbered interchange. Not part of URL state. */
  onFocus: (focus: JourneyFocus) => void;
  /** Write the planner's state back into the URL. */
  persist: () => void;
  /** Reveal the sidebar's routing credit when the first route comes back. */
  onRoutingUsed: () => void;
}

let host: PlannerHost;
let result: PlanResult | null = null;
let status: 'idle' | 'loading' | 'error' | 'empty' = 'idle';
let statusDetail = '';
let inFlight: AbortController | null = null;
let focusedPart: JourneyFocus = null;

/**
 * What is currently in each place field, including text the rider has typed but
 * not chosen from the suggestions.
 *
 * `redraw` rebuilds the form, and a field that fell back to the committed place
 * would silently eat whatever was being typed in it - most visibly when one end
 * is seeded from a station on the map while the other is half-written. The
 * committed `Place` is the fallback, not the source of truth for the field.
 */
const fieldText: Record<'from' | 'to', string | null> = { from: null, to: null };

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

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function clockAt(date: Date, tz: string | null): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: tz ?? undefined,
  }).format(date);
}

/** `1h42` / `47 min` - a duration a rider compares at a glance, not a precise one. */
function duration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * `<input type="date">` and `<input type="time">` want wall-clock in the
 * browser's own zone, in the fixed shapes `2026-08-25` and `07:12`. That is the
 * *value* only: what the rider sees in the field is formatted by the browser,
 * in their own locale - see the note on `plan-at` in `buildForm`.
 */
function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function toTimeInput(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** A bicycle, drawn rather than typed: no icon font, and no emoji to render badly. */
function bikeGlyph(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 16');
  svg.setAttribute('class', 'glyph');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<circle cx="5" cy="11" r="4"/><circle cx="19" cy="11" r="4"/>' +
    '<path d="M5 11 L10 4 L15 11 M10 4 L14 4 M9.5 11 L15 11"/>';
  return svg;
}

function walkGlyph(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 10 16');
  svg.setAttribute('class', 'glyph');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<circle cx="5" cy="2.4" r="2"/><path d="M5 5 L5 9 M5 9 L2.5 14 M5 9 L7.5 14 M2 6.5 L8 6.5"/>';
  return svg;
}

const BIKE_MODES = new Set(['BIKE', 'RENTAL', 'BIKE_RENTAL']);
const isBike = (leg: Leg) => BIKE_MODES.has(leg.mode);

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

function query(): void {
  const s = host.state;
  if (!s.from || !s.to) {
    status = 'error';
    statusDetail = t().planNeedBoth;
    redraw();
    return;
  }

  runPlan(undefined);
}

/**
 * `keepSelection` exists for one case: a link restored from the URL names both
 * ends *and* which itinerary was being shown, and re-running the search to get
 * the geometry back must not then reset that to the first result.
 */
function runPlan(pageCursor: string | undefined, keepSelection = false, refresh = false): void {
  const s = host.state;
  if (!s.from || !s.to) return;

  inFlight?.abort();
  const ac = new AbortController();
  inFlight = ac;
  status = 'loading';
  redraw();

  // A fare preset answers the whole "which services" question on its own, so
  // the chips stand down rather than half-apply - they cannot express "rail,
  // but no ICE" in the first place, which is the very restriction asked for.
  const modes = new Set<TransitMode>(
    s.fare !== 'any'
      ? FARE_MODES[s.fare]
      : MODE_GROUPS.filter((g) => s.groups.has(g.key)).flatMap((g) => g.modes),
  );
  if (!modes.size) ALL_TRANSIT_MODES.forEach((m) => modes.add(m));

  plan(
    {
      from: s.from,
      to: s.to,
      time: s.time ?? new Date(),
      arriveBy: s.arriveBy,
      modes,
      bike: { maxRideSeconds: s.bikeMinutes * 60, carriage: s.carriage },
      pageCursor,
    },
    ac.signal,
    refresh,
  )
    .then((r) => {
      if (ac.signal.aborted) return;
      // Earlier/Later replace the list rather than growing it: an unbounded list
      // of near-identical departures is not what the buttons are for, and the
      // cursors come back fresh on each page so paging stays possible.
      result = r;
      status = r.itineraries.length ? 'idle' : 'empty';
      // A page of results is a different set, so the old index means nothing.
      const wanted = host.state.selected;
      const restorable = keepSelection && wanted !== null && wanted < r.itineraries.length;
      host.state.selected = restorable
        ? wanted
        : r.itineraries.length && pageCursor === undefined
          ? 0
          : null;
      if (r.itineraries.length) host.onRoutingUsed();
      showSelected();
      host.persist();
      redraw();
    })
    .catch((err) => {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      result = null;
      host.state.selected = null;
      showSelected();
      status = 'error';
      // Deliberately one message for every failure. A public API timing out, a
      // bad status and an unparseable body are the same event to a rider, and
      // `LiveDataError` exists precisely so the UI does not have to tell them
      // apart - the same stance the departure board takes in live.ts.
      statusDetail = t().planFailed;
      redraw();
    });
}

function showSelected(): void {
  focusedPart = null;
  const i = host.state.selected;
  host.onItinerary(i !== null ? (result?.itineraries[i] ?? null) : null);
}

// ---------------------------------------------------------------------------
// The place fields
// ---------------------------------------------------------------------------

/**
 * One origin/destination field with its own suggestion list.
 *
 * Debounced at 350 ms and cancelled on every fresh keystroke, so typing a place
 * name costs one geocode rather than one per letter - the cheapest of the two
 * things this module owes Transitous.
 */
function placeField(which: 'from' | 'to'): HTMLElement {
  const s = t();
  const state = host.state;
  const current = which === 'from' ? state.from : state.to;

  const box = el('div', 'plan-field');
  const input = el('input', 'search');
  input.type = 'text';
  input.name = which;
  input.placeholder = which === 'from' ? s.planFrom : s.planTo;
  input.setAttribute('aria-label', which === 'from' ? s.planFrom : s.planTo);
  input.value = fieldText[which] ?? current?.name ?? '';
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', `plan-${which}-suggestions`);

  const list = el('div', 'plan-suggestions');
  list.id = `plan-${which}-suggestions`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', input.placeholder);
  box.append(input, list);

  let timer: number | undefined;
  let ac: AbortController | null = null;
  let offered: Place[] = [];
  let active = -1;
  /** An Enter that arrived before the geocoder answered, to honour when it does. */
  let takeFirst = false;

  const close = () => {
    window.clearTimeout(timer);
    ac?.abort();
    ac = null;
    takeFirst = false;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    list.innerHTML = '';
    list.classList.remove('open');
    offered = [];
  };

  const activate = (index: number) => {
    active = index;
    for (let i = 0; i < list.children.length; i++) {
      const row = list.children[i];
      row.classList.toggle('is-active', i === active);
      row.setAttribute('aria-selected', String(i === active));
    }
    const row = list.children[active];
    input.setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({ block: 'nearest' });
  };

  function choose(place: Place) {
    if (which === 'from') state.from = place;
    else state.to = place;
    fieldText[which] = place.name;
    input.value = place.name;
    close();
    input.focus({ preventScroll: true });
    host.persist();
    // Both ends known is the moment a search is worth making unasked; it is
    // the one place this module plans without an explicit submit, and it
    // matches what a rider means by filling in the second box.
    if (state.from && state.to) query();
    else redraw();
  }

  function search(text: string): void {
    if (!input.isConnected) return;
    ac?.abort();
    ac = new AbortController();
    const signal = ac.signal;
    offered = [];
    active = -1;
    input.removeAttribute('aria-activedescendant');
    input.setAttribute('aria-expanded', 'true');
    list.classList.add('open');
    list.innerHTML = '';
    list.appendChild(el('p', 'muted', s.planSearching));
    geocode(text, signal)
      .then((places) => {
        if (signal.aborted || !input.isConnected) return;
        ac = null;
        list.innerHTML = '';
        if (!places.length) {
          takeFirst = false;
          list.appendChild(el('p', 'muted', s.planNoPlaces));
          return;
        }
        offered = places;
        for (const [index, p] of places.entries()) {
          const row = el('button', 'plan-suggestion');
          row.type = 'button';
          row.id = `plan-${which}-option-${index}`;
          row.setAttribute('role', 'option');
          row.tabIndex = -1;
          row.onmousedown = (e) => e.preventDefault();
          row.append(el('span', 'plan-suggestion-name', p.name));
          if (p.area) row.append(el('span', 'plan-suggestion-area', p.area));
          if (p.kind === 'STOP') row.classList.add('is-stop');
          row.onclick = () => choose(p);
          list.appendChild(row);
        }
        activate(0);
        if (takeFirst) {
          takeFirst = false;
          choose(places[0]);
        }
      })
      .catch(() => {
        if (signal.aborted || !input.isConnected) return;
        ac = null;
        takeFirst = false;
        list.innerHTML = '';
        list.appendChild(el('p', 'muted', s.planFailed));
      });
  }

  input.oninput = () => {
    close();
    const text = input.value;
    fieldText[which] = text;
    if (text.trim().length < 2) return;
    timer = window.setTimeout(() => search(text), 350);
  };

  /**
   * Enter takes the highlighted suggestion, initially the geocoder's best hit.
   *
   * If nothing is on offer yet the request has not been made or not come back:
   * rather than swallow the key, the debounce is skipped, the search goes out
   * at once, and the choice is made when it lands. So Enter never does nothing.
   */
  input.onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && offered.length) {
      e.preventDefault();
      activate((active + (e.key === 'ArrowDown' ? 1 : -1) + offered.length) % offered.length);
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (offered.length) {
      choose(offered[active]);
      return;
    }
    if (input.value.trim().length < 2) return;
    window.clearTimeout(timer);
    takeFirst = true;
    if (!ac) search(input.value);
  };

  // A blur that lands on a suggestion must not close the list before the click.
  input.onblur = () =>
    window.setTimeout(() => {
      if (document.activeElement !== input) close();
    }, 150);
  return box;
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

function buildForm(): HTMLElement {
  const s = t();
  const state = host.state;
  const box = el('div', 'panel plan-form');

  // --- where ---------------------------------------------------------------
  const places = el('div', 'plan-places');
  places.append(placeField('from'), placeField('to'));

  const swap = el('button', 'plan-swap');
  swap.type = 'button';
  swap.title = s.planSwap;
  swap.setAttribute('aria-label', s.planSwap);
  swap.textContent = '⇅';
  swap.onclick = () => {
    [state.from, state.to] = [state.to, state.from];
    [fieldText.from, fieldText.to] = [fieldText.to, fieldText.from];
    host.persist();
    if (state.from && state.to) query();
    else redraw();
  };
  places.appendChild(swap);
  box.appendChild(places);

  // --- when ----------------------------------------------------------------
  const when = el('div', 'plan-when');
  const mode = el('select', 'select');
  mode.appendChild(new Option(s.planLeaveNow, 'now'));
  mode.appendChild(new Option(s.planDepartAt, 'depart'));
  mode.appendChild(new Option(s.planArriveBy, 'arrive'));
  mode.value = state.time === null ? 'now' : state.arriveBy ? 'arrive' : 'depart';

  /**
   * A day and a clock, as two native fields rather than one `datetime-local`.
   *
   * Two reasons. A combined field has to fit a date *and* a clock in one
   * control, and in a sidebar this narrow the browser drops the clock off the
   * end - which leaves a planner that cannot be asked for the 07:12.
   *
   * And the fields are told the rider's own locale rather than inheriting the
   * page's. This interface is English and the document says so, but the day a
   * German rider writes 25.08.2026 is not a day to offer them as 08/25/2026 -
   * and Firefox formats a date field by the document's language, not the
   * browser's. Where the browser's own locale already governs (Chrome, Safari)
   * `lang` says the same thing, so all three end up formatting for the rider.
   */
  const at = el('div', 'plan-at');
  const day = el('input', 'select plan-date');
  day.type = 'date';
  day.lang = navigator.language;
  day.setAttribute('aria-label', s.planDate);

  const clock = el('input', 'select plan-time');
  clock.type = 'time';
  clock.lang = navigator.language;
  clock.setAttribute('aria-label', s.planTime);

  const seed = state.time ?? new Date();
  day.value = toDateInput(seed);
  clock.value = toTimeInput(seed);
  at.append(day, clock);
  at.hidden = state.time === null;

  /** The two fields read as one instant, or null while either is empty. */
  const picked = (): Date | null => {
    const [y, m, d] = day.value.split('-').map(Number);
    const [hh, mm] = clock.value.split(':').map(Number);
    if ([y, m, d, hh, mm].some((n) => !Number.isFinite(n))) return null;
    const instant = new Date(y, m - 1, d, hh, mm);
    // `new Date(25, ...)` means 1925, and the field can hold a year that small.
    instant.setFullYear(y);
    return instant;
  };

  mode.onchange = () => {
    if (mode.value === 'now') {
      state.time = null;
      state.arriveBy = false;
    } else {
      state.time = picked() ?? new Date();
      state.arriveBy = mode.value === 'arrive';
    }
    at.hidden = state.time === null;
    host.persist();
    if (state.from && state.to) query();
  };

  // Half a time is not a time. An emptied field is put back to what was already
  // chosen rather than searched with, so the pair always says something true.
  const chosen = () => {
    const instant = picked();
    if (!instant) {
      const fallback = state.time ?? new Date();
      if (!day.value) day.value = toDateInput(fallback);
      if (!clock.value) clock.value = toTimeInput(fallback);
      return;
    }
    state.time = instant;
    host.persist();
    if (state.from && state.to) query();
  };
  day.onchange = chosen;
  clock.onchange = chosen;

  when.append(mode, at);
  box.appendChild(when);

  // --- modes ---------------------------------------------------------------
  box.appendChild(el('h2', '', s.planModes));

  /** A fare preset replaces the chips rather than constraining them: it is
   *  the answer to the same question, given more precisely. */
  const fare = el('select', 'select plan-fare');
  fare.appendChild(new Option(s.planFareAny, 'any'));
  fare.appendChild(new Option(s.planFareRegional, 'regional'));
  fare.appendChild(new Option(s.planFareTicket, 'ticket'));
  fare.value = state.fare;
  fare.setAttribute('aria-label', s.planFare);
  fare.onchange = () => {
    state.fare = fare.value as FareFilter;
    host.persist();
    if (state.from && state.to) query();
    else redraw();
  };
  box.appendChild(fare);

  const chips = el('div', 'row');
  for (const group of MODE_GROUPS) {
    const on = state.groups.has(group.key);
    const chip = el('button', `chip${on ? ' on' : ''}`, group.label);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(on));
    chip.onclick = () => {
      if (state.groups.has(group.key)) state.groups.delete(group.key);
      else state.groups.add(group.key);
      host.persist();
      if (state.from && state.to) query();
      else redraw();
    };
    chips.appendChild(chip);
  }
  box.appendChild(chips);
  // Hidden rather than disabled: greyed-out chips would still claim a say the
  // preset has taken over, and hidden leaves their choice intact for "any".
  chips.hidden = state.fare !== 'any';

  // --- bike ----------------------------------------------------------------
  box.appendChild(el('h2', '', s.planBike));
  const bike = el('div', 'plan-bike');
  bike.appendChild(el('p', 'sub', s.planBikeQuestion));

  const row = el('div', 'plan-slider');
  const slider = el('input', 'plan-range');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(BIKE_STEPS.length - 1);
  slider.step = '1';
  const stepIndex = Math.max(0, BIKE_STEPS.indexOf(state.bikeMinutes));
  slider.value = String(stepIndex);
  slider.setAttribute('aria-label', s.planBikeQuestion);

  const readout = el('span', 'plan-readout');
  const label = (m: number) => (m === 0 ? s.planBikeNone : s.planBikeMinutes(m));
  readout.textContent = label(state.bikeMinutes);
  slider.setAttribute('aria-valuetext', readout.textContent);

  // `input` moves the label as the thumb moves; only `change` - the release -
  // sends a request, so dragging across the range costs one search, not seven.
  slider.oninput = () => {
    const m = BIKE_STEPS[Number(slider.value)] ?? 0;
    readout.textContent = label(m);
    slider.setAttribute('aria-valuetext', readout.textContent);
  };
  slider.onchange = () => {
    state.bikeMinutes = BIKE_STEPS[Number(slider.value)] ?? 0;
    host.persist();
    if (state.from && state.to) query();
  };
  row.append(slider, readout);
  bike.appendChild(row);

  const carriage = el('label', 'toggle');
  const carriageBox = el('input');
  carriageBox.type = 'checkbox';
  carriageBox.checked = state.carriage;
  carriageBox.disabled = state.bikeMinutes === 0;
  carriageBox.onchange = () => {
    state.carriage = carriageBox.checked;
    host.persist();
    if (state.from && state.to) query();
    else redraw();
  };
  carriage.append(carriageBox, el('span', 'label', s.planCarriage));
  bike.appendChild(carriage);
  if (state.carriage) bike.appendChild(el('p', 'muted', s.planCarriageNote));
  box.appendChild(bike);

  // --- go ------------------------------------------------------------------
  const submit = el('button', 'plan-submit', s.planSubmit);
  submit.type = 'button';
  submit.disabled = !state.from || !state.to;
  submit.onclick = () => query();
  box.appendChild(submit);

  const refresh = el('button', 'plan-page plan-refresh', s.planRefresh);
  refresh.type = 'button';
  refresh.disabled = !state.from || !state.to;
  // Keep keyboard focus while loading, but ignore repeated activation.
  refresh.setAttribute('aria-disabled', String(refresh.disabled || status === 'loading'));
  refresh.onclick = () => {
    if (status !== 'loading') runPlan(undefined, false, true);
  };
  box.appendChild(refresh);

  return box;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** The at-a-glance row of what you would be on, in order. */
function modeStrip(itinerary: Itinerary): HTMLElement {
  const s = t();
  const strip = el('div', 'itin-strip');
  const { legs } = journeyView(itinerary);

  legs.forEach(({ leg, number, colour }, i) => {
    if (i > 0) strip.appendChild(el('span', 'itin-join'));
    const mins = Math.round(leg.seconds / 60);

    if (!leg.transit) {
      const pill = el('span', `itin-street ${isBike(leg) ? 'is-bike' : 'is-walk'}`);
      pill.append(isBike(leg) ? bikeGlyph() : walkGlyph(), el('span', '', String(mins)));
      pill.title = `${isBike(leg) ? s.planBikeLeg : s.planWalk} ${mins} min`;
      strip.appendChild(pill);
      return;
    }

    const badge = el('span', 'badge', `${number} · ${leg.line || leg.mode}`);
    badge.style.background = colour;
    badge.style.color = textColour(colour);
    strip.appendChild(badge);
  });

  return strip;
}

/** White on a dark badge, near-black on a light one. Same rule as the map's. */
function textColour(colour: string): string {
  const channel = (i: number) => {
    const c = parseInt(colour.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  if (!/^#[0-9a-f]{6}$/i.test(colour)) return '#ffffff';
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.179 ? '#1a1a1a' : '#ffffff';
}

function delayMinutes(scheduled: Date | null, actual: Date | null): number {
  if (!scheduled || !actual) return 0;
  return Math.round((actual.getTime() - scheduled.getTime()) / 60000);
}

function legDetail({ leg, index, number, colour }: JourneyLeg): HTMLElement {
  const s = t();
  const li = el('li', `leg${leg.transit ? '' : ' leg-street'}`);
  li.dataset.leg = String(index);

  const time = el('span', 'leg-time');
  if (leg.from.actual) time.textContent = clockAt(leg.from.actual, leg.from.tz);
  li.appendChild(time);

  const mark = el('span', 'leg-mark');
  mark.style.background = colour;
  li.appendChild(mark);

  const body = el('div', 'leg-body');
  const title = el('button', 'leg-title leg-select');
  title.type = 'button';
  title.dataset.focusKind = 'leg';
  title.dataset.focusIndex = String(index);
  title.setAttribute('aria-pressed', 'false');
  title.setAttribute(
    'aria-label',
    s.planShowLeg(number, leg.line || (isBike(leg) ? s.planBikeLeg : s.planWalk)),
  );
  title.onclick = () => selectPart({ kind: 'leg', index });

  if (leg.transit) {
    const badge = el('span', 'badge', `${number} · ${leg.line || leg.mode}`);
    badge.style.background = colour;
    badge.style.color = textColour(colour);
    title.append(badge);
    if (leg.headsign) title.append(el('span', 'leg-dest', `→ ${leg.headsign}`));
  } else {
    const pill = el('span', `itin-street ${isBike(leg) ? 'is-bike' : 'is-walk'}`);
    pill.append(isBike(leg) ? bikeGlyph() : walkGlyph());
    title.append(pill);
    const km = leg.metres !== null ? ` · ${(leg.metres / 1000).toFixed(1)} km` : '';
    title.append(
      el(
        'span',
        'leg-dest',
        `${isBike(leg) ? s.planBikeLeg : s.planWalk} ${duration(leg.seconds)}${km}`,
      ),
    );
  }
  body.appendChild(title);

  const parts: string[] = [];
  if (leg.from.name) parts.push(leg.from.name);
  if (leg.transit && leg.from.track) parts.push(s.planPlatform(leg.from.track));
  if (leg.transit) parts.push(duration(leg.seconds));
  if (leg.intermediateStops) parts.push(s.planStops(leg.intermediateStops));
  if (parts.length) body.appendChild(el('div', 'leg-sub', parts.join(' · ')));

  // The two facts a rider with a bike actually needs, and the one the API
  // cannot give honestly is said as not-given rather than as no.
  if (leg.transit) {
    const flags = el('div', 'leg-flags');
    if (leg.bikesAllowed === true)
      flags.appendChild(el('span', 'flag flag-yes', s.planBikesCarried));
    else if (host.state.bikeMinutes > 0) flags.appendChild(el('span', 'flag', s.planBikesUnknown));
    if (leg.reservationRequired) flags.appendChild(el('span', 'flag', s.planReservation));
    if (leg.cancelled) flags.appendChild(el('span', 'flag flag-bad', s.planCancelled));
    const late = delayMinutes(leg.from.scheduled, leg.from.actual);
    if (leg.realTime && late > 0) {
      flags.appendChild(el('span', 'flag flag-bad', s.planDelayed(late)));
    }
    if (leg.url) {
      const a = document.createElement('a');
      a.className = 'flag flag-link';
      a.href = leg.url;
      a.rel = 'noopener';
      a.target = '_blank';
      a.textContent = leg.operator || leg.url;
      flags.appendChild(a);
    } else if (leg.operator) {
      flags.appendChild(el('span', 'flag flag-quiet', leg.operator));
    }
    if (flags.childElementCount) body.appendChild(flags);
  }

  li.appendChild(body);
  return li;
}

function selectPart(focus: Exclude<JourneyFocus, null>): void {
  focusedPart =
    focusedPart?.kind === focus.kind && focusedPart.index === focus.index ? null : focus;
  host.onFocus(focusedPart);
  syncFocusedPart();
}

function syncFocusedPart(): void {
  for (const button of mount?.querySelectorAll<HTMLButtonElement>('[data-focus-kind]') ?? []) {
    const selected =
      button.dataset.focusKind === focusedPart?.kind &&
      Number(button.dataset.focusIndex) === focusedPart?.index;
    button.setAttribute('aria-pressed', String(selected));
    button.closest('li')?.classList.toggle('is-focused', selected);
  }
}

function interchangeDetail(change: Interchange): HTMLElement {
  const s = t();
  const row = el('li', 'interchange');
  const button = el('button', 'interchange-select');
  button.type = 'button';
  button.dataset.focusKind = 'change';
  button.dataset.focusIndex = String(change.number);
  button.setAttribute('aria-pressed', 'false');
  button.onclick = () => selectPart({ kind: 'change', index: change.number });
  const number = el('span', 'interchange-number', String(change.number));
  number.setAttribute('aria-hidden', 'true');
  const content = el('span', 'interchange-body');
  content.appendChild(el('span', 'interchange-label', s.planChange(change.number, change.label)));
  if (change.hasWalking) {
    content.appendChild(
      el('span', 'interchange-walk', `${s.planWalk} ${duration(change.walkingSeconds)}`),
    );
  }
  const details = el('span', 'interchange-details');
  for (const [label, place] of [
    [s.planArrival, change.arrival],
    [s.planDeparture, change.departure],
  ] as const) {
    const time = place.actual ?? place.scheduled;
    const parts = [label, time ? clockAt(time, place.tz) : s.planTimeUnknown];
    if (place.name) parts.push(place.name);
    if (place.track) parts.push(s.planPlatform(place.track));
    details.appendChild(el('span', '', parts.join(' · ')));
  }
  content.appendChild(details);
  button.append(number, content);
  row.appendChild(button);
  return row;
}

function itineraryRow(itinerary: Itinerary, index: number): HTMLElement {
  const s = t();
  const wrap = el('div', `itin-wrap${host.state.selected === index ? ' open' : ''}`);

  const row = el('button', 'itin');
  row.type = 'button';
  row.dataset.itinerary = String(index);
  row.setAttribute('aria-expanded', String(host.state.selected === index));

  const head = el('div', 'itin-head');
  head.append(el('span', 'itin-dur', duration(itinerary.seconds)));
  const from = itinerary.legs[0]?.from;
  const to = itinerary.legs[itinerary.legs.length - 1]?.to;
  head.append(
    el(
      'span',
      'itin-span',
      `${clockAt(itinerary.start, from?.tz ?? null)} → ${clockAt(itinerary.end, to?.tz ?? null)}`,
    ),
  );
  head.append(
    el('span', 'itin-transfers', s.planTransfers(journeyView(itinerary).interchanges.length)),
  );
  row.appendChild(head);

  if (itinerary.direct) {
    const only = itinerary.legs[0];
    row.appendChild(
      el('div', 'itin-note', only && isBike(only) ? s.planWholeWayBike : s.planWholeWayWalk),
    );
  } else {
    row.appendChild(modeStrip(itinerary));
  }

  if (itinerary.bikeSeconds > 0 && !itinerary.direct) {
    const note = el('div', 'itin-note');
    note.append(bikeGlyph(), el('span', '', s.planRiding(duration(itinerary.bikeSeconds))));
    row.appendChild(note);
  }

  row.onclick = () => {
    host.state.selected = host.state.selected === index ? null : index;
    showSelected();
    host.persist();
    redraw();
  };
  wrap.appendChild(row);

  if (host.state.selected === index) {
    const list = el('ul', 'leg-list');
    if (!itinerary.direct) wrap.appendChild(el('p', 'journey-colour-note', s.planJourneyColours));
    const view = journeyView(itinerary);
    for (const leg of view.legs) {
      list.appendChild(legDetail(leg));
      const change = view.interchanges.find((c) => c.arrivalIndex === leg.index);
      if (change) list.appendChild(interchangeDetail(change));
    }
    // The arrival has no leg of its own, and a journey that does not say when
    // it ends is not an itinerary.
    const last = itinerary.legs[itinerary.legs.length - 1];
    if (last) {
      const end = el('li', 'leg leg-end');
      end.append(
        el('span', 'leg-time', last.to.actual ? clockAt(last.to.actual, last.to.tz) : ''),
        el('span', 'leg-mark leg-mark-end'),
        el('div', 'leg-body', last.to.name),
      );
      list.appendChild(end);
    }
    wrap.appendChild(list);
  }

  return wrap;
}

function buildResults(): HTMLElement {
  const s = t();
  const box = el('div', 'panel plan-results');

  if (status === 'loading') {
    box.appendChild(el('p', 'muted', s.planLoading));
    return box;
  }
  if (status === 'error') {
    box.appendChild(el('p', 'muted', statusDetail || s.planFailed));
    return box;
  }
  if (status === 'empty') {
    box.appendChild(el('p', 'muted', s.planNothing));
    return box;
  }
  if (!result) return box;

  if (result.earlierCursor) {
    const earlier = el('button', 'plan-page', s.planEarlier);
    earlier.type = 'button';
    earlier.onclick = () => runPlan(result!.earlierCursor!);
    box.appendChild(earlier);
  }

  result.itineraries.forEach((it, i) => box.appendChild(itineraryRow(it, i)));

  if (result.laterCursor) {
    const later = el('button', 'plan-page', s.planLater);
    later.type = 'button';
    later.onclick = () => runPlan(result!.laterCursor!);
    box.appendChild(later);
  }

  return box;
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

let mount: HTMLElement | null = null;

function redraw(): void {
  if (!mount) return;
  const focused = mount.querySelector<HTMLInputElement>('.plan-field input:focus');
  const overview = mount.querySelector<HTMLButtonElement>('.itin:focus')?.dataset.itinerary;
  const refreshFocused = !!mount.querySelector('.plan-refresh:focus');
  mount.innerHTML = '';
  mount.append(buildForm(), buildResults());
  syncFocusedPart();
  if (overview !== undefined) {
    mount
      .querySelector<HTMLButtonElement>(`.itin[data-itinerary="${overview}"]`)
      ?.focus({ preventScroll: true });
  }
  if (refreshFocused) {
    mount.querySelector<HTMLButtonElement>('.plan-refresh')?.focus({ preventScroll: true });
  }
  // Selection and arriving route results rebuild the form without ending typing.
  if (focused) {
    const input = mount.querySelector<HTMLInputElement>(`input[name="${focused.name}"]`);
    input?.focus({ preventScroll: true });
    if (input) input.setSelectionRange(focused.selectionStart, focused.selectionEnd);
  }
}

export function renderPlanner(container: HTMLElement, h: PlannerHost): void {
  host = h;
  mount = container;
  redraw();
}

/**
 * Seed an end of the journey from somewhere else in the app - the station
 * popup's "Directions from/to here". Searches straight away when that completes
 * the pair, because the click already said what the rider wants.
 */
export function setPlannerPlace(which: 'from' | 'to', place: Place): void {
  if (!host) return;
  if (which === 'from') host.state.from = place;
  else host.state.to = place;
  fieldText[which] = place.name;
  host.persist();
  if (host.state.from && host.state.to) query();
  else redraw();
}

/** Re-show whatever the URL restored, once the planner is on screen. */
export function restorePlannerResult(): void {
  if (host?.state.from && host?.state.to) runPlan(undefined, true);
}

/** Drop the drawn itinerary without touching the form. */
export function clearPlannerSelection(): void {
  if (!host) return;
  host.state.selected = null;
  showSelected();
  redraw();
}

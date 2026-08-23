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
 * mode chip, Earlier/Later. Never on a pan, never on a keystroke. The geocoder
 * is debounced here, because only this module knows what a keystroke is.
 */

import { t } from './strings.ts';
import {
  geocode,
  plan,
  MODE_GROUPS,
  ALL_TRANSIT_MODES,
  type Place,
  type PlanResult,
  type Itinerary,
  type Leg,
  type TransitMode,
} from './routing.ts';

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
    bikeMinutes: 30,
    carriage: false,
    selected: null,
  };
}

export interface PlannerHost {
  state: PlannerState;
  /** Draw this itinerary on the map, or clear it. */
  onItinerary: (itinerary: Itinerary | null) => void;
  /** The colour this map draws that line in, so an itinerary matches the network. */
  legColour: (leg: Leg) => string | null;
  /** Write the planner's state back into the URL. */
  persist: () => void;
  /** Earned the first time a route comes back, for the attribution control. */
  onRoutingUsed: () => void;
}

let host: PlannerHost;
let result: PlanResult | null = null;
let status: 'idle' | 'loading' | 'error' | 'empty' = 'idle';
let statusDetail = '';
let inFlight: AbortController | null = null;

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

/** `<input type="datetime-local">` wants wall-clock in the browser's own zone. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
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
function runPlan(pageCursor: string | undefined, keepSelection = false): void {
  const s = host.state;
  if (!s.from || !s.to) return;

  inFlight?.abort();
  const ac = new AbortController();
  inFlight = ac;
  status = 'loading';
  redraw();

  const modes = new Set<TransitMode>(
    MODE_GROUPS.filter((g) => s.groups.has(g.key)).flatMap((g) => g.modes),
  );
  // Every chip off would ask MOTIS for no transit at all, which returns
  // nothing and reads as a broken planner. Fall back to everything.
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
  input.placeholder = which === 'from' ? s.planFrom : s.planTo;
  input.setAttribute('aria-label', which === 'from' ? s.planFrom : s.planTo);
  input.value = current?.name ?? '';
  input.autocomplete = 'off';

  const list = el('div', 'plan-suggestions');
  box.append(input, list);

  let timer: number | undefined;
  let ac: AbortController | null = null;

  const close = () => {
    list.innerHTML = '';
    list.classList.remove('open');
  };

  function choose(place: Place) {
    if (which === 'from') state.from = place;
    else state.to = place;
    input.value = place.name;
    close();
    host.persist();
    // Both ends known is the moment a search is worth making unasked; it is
    // the one place this module plans without an explicit submit, and it
    // matches what a rider means by filling in the second box.
    if (state.from && state.to) query();
    else redraw();
  }

  input.oninput = () => {
    window.clearTimeout(timer);
    const text = input.value;
    if (text.trim().length < 2) {
      close();
      return;
    }
    timer = window.setTimeout(() => {
      ac?.abort();
      ac = new AbortController();
      const signal = ac.signal;
      list.classList.add('open');
      list.innerHTML = '';
      list.appendChild(el('p', 'muted', s.planSearching));
      geocode(text, signal)
        .then((places) => {
          if (signal.aborted) return;
          list.innerHTML = '';
          if (!places.length) {
            list.appendChild(el('p', 'muted', s.planNoPlaces));
            return;
          }
          for (const p of places) {
            const row = el('button', 'plan-suggestion');
            row.type = 'button';
            row.append(el('span', 'plan-suggestion-name', p.name));
            if (p.area) row.append(el('span', 'plan-suggestion-area', p.area));
            if (p.kind === 'STOP') row.classList.add('is-stop');
            row.onclick = () => choose(p);
            list.appendChild(row);
          }
        })
        .catch(() => {
          if (signal.aborted) return;
          list.innerHTML = '';
          list.appendChild(el('p', 'muted', s.planFailed));
        });
    }, 350);
  };

  // A blur that lands on a suggestion must not close the list before the click
  // registers, so the close is deferred by one frame.
  input.onblur = () => window.setTimeout(close, 150);
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

  const at = el('input', 'select plan-time');
  at.type = 'datetime-local';
  at.value = toLocalInput(state.time ?? new Date());
  at.hidden = state.time === null;

  mode.onchange = () => {
    if (mode.value === 'now') {
      state.time = null;
      state.arriveBy = false;
    } else {
      state.time = at.value ? new Date(at.value) : new Date();
      state.arriveBy = mode.value === 'arrive';
    }
    at.hidden = state.time === null;
    host.persist();
    if (state.from && state.to) query();
  };
  at.onchange = () => {
    if (!at.value) return;
    state.time = new Date(at.value);
    host.persist();
    if (state.from && state.to) query();
  };

  when.append(mode, at);
  box.appendChild(when);

  // --- modes ---------------------------------------------------------------
  box.appendChild(el('h2', '', s.planModes));
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

  return box;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** The at-a-glance row of what you would be on, in order. */
function modeStrip(itinerary: Itinerary): HTMLElement {
  const s = t();
  const strip = el('div', 'itin-strip');

  itinerary.legs.forEach((leg, i) => {
    if (i > 0) strip.appendChild(el('span', 'itin-join'));
    const mins = Math.round(leg.seconds / 60);

    if (!leg.transit) {
      const pill = el('span', `itin-street ${isBike(leg) ? 'is-bike' : 'is-walk'}`);
      pill.append(isBike(leg) ? bikeGlyph() : walkGlyph(), el('span', '', String(mins)));
      pill.title = `${isBike(leg) ? s.planBikeLeg : s.planWalk} ${mins} min`;
      strip.appendChild(pill);
      return;
    }

    const colour = host.legColour(leg) ?? leg.colour ?? '#4a4a4a';
    const badge = el('span', 'badge', leg.line || leg.mode);
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

function legDetail(leg: Leg): HTMLElement {
  const s = t();
  const li = el('li', `leg${leg.transit ? '' : ' leg-street'}`);

  const time = el('span', 'leg-time');
  if (leg.from.actual) time.textContent = clockAt(leg.from.actual, leg.from.tz);
  li.appendChild(time);

  const colour = leg.transit ? (host.legColour(leg) ?? leg.colour ?? '#4a4a4a') : '#8a8a8a';
  const mark = el('span', 'leg-mark');
  mark.style.background = colour;
  li.appendChild(mark);

  const body = el('div', 'leg-body');
  const title = el('div', 'leg-title');

  if (leg.transit) {
    const badge = el('span', 'badge', leg.line || leg.mode);
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

function itineraryRow(itinerary: Itinerary, index: number): HTMLElement {
  const s = t();
  const wrap = el('div', `itin-wrap${host.state.selected === index ? ' open' : ''}`);

  const row = el('button', 'itin');
  row.type = 'button';
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
  head.append(el('span', 'itin-transfers', s.planTransfers(itinerary.transfers)));
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
    for (const leg of itinerary.legs) list.appendChild(legDetail(leg));
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
  mount.innerHTML = '';
  mount.append(buildForm(), buildResults());
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
  host.onItinerary(null);
  redraw();
}

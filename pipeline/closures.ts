/**
 * Construction closures and other infrastructure restrictions on the German
 * rail network, from DB InfraGO's own strecken.info.
 *
 * ## Why this source
 *
 * The alternatives were weighed in docs/closures.md. In short: OSM's
 * `railway=construction` describes track that is *being built*, not track that
 * is shut this weekend; GTFS-RT service alerts, which is what a live API would
 * give us, are barely populated by German feeds (measured in docs/live-data.md
 * §3); and everything else DB publishes about construction is either behind the
 * API Marketplace's keys or is prose for passengers rather than data. strecken.info
 * is the infrastructure manager's own planning database, it covers the whole DB
 * network rather than the passenger services running on it, and every record
 * carries both endpoints as coordinates - which is what makes it drawable.
 *
 * ## Why it is a build-time fetch and not a live one
 *
 * `access-control-allow-origin` on the API is `https://strecken-info.de`, so a
 * browser on our origin cannot call it at all. That settles a question
 * docs/live-data.md §6 had to reason about for departures: there is no
 * client-side option here, and the data belongs in the nightly build the same
 * way the network itself does.
 *
 * ## The revision handshake
 *
 * Every read endpoint wants a `revision` - the planning database's version
 * counter - and rejects one that is stale or from the future. It is not served
 * over HTTP; the app subscribes to `/api/websocket` and is pushed the current
 * number. So does this: one socket, one message, then closed.
 *
 * ## Two windows, two jobs
 *
 * `snapshot()` asks for the restrictions in effect on a single day, which is
 * what the map draws. `reconcileLog()` asks for a fortnight, because the log's
 * job is to notice a closure being planned, moved or dropped, and a one-day
 * window can only ever see it once it has already started.
 */

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { toWgs84 } from './lib/mercator.ts';
import type { ClosureDirection, ClosureEffect, EndMove } from '../shared/closures.ts';

export { EFFECT_RANK } from '../shared/closures.ts';
export type { EndMove } from '../shared/closures.ts';
export type { ClosureDirection, ClosureEffect } from '../shared/closures.ts';

const WORK = process.env.WORK_DIR ?? '.work';
const OUT = `${WORK}/build`;
const DATA = 'data';

const BASE_URL = 'https://strecken-info.de/api';
const WS_URL = 'wss://strecken-info.de/api/websocket';

/** Where the history lives. Append-only, one JSON event per line. */
export const LOG_PATH = `${DATA}/closure-log.jsonl`;
/** The map's copy, written into the build directory rather than committed. */
export const SNAPSHOT_PATH = `${OUT}/closures.json`;

/** How far ahead the log looks, in days. See the module note above. */
const LOG_HORIZON_DAYS = 14;

/** DB InfraGO's seven regional divisions - all of them, i.e. all of Germany. */
const REGIONS = ['MITTE', 'NORD', 'OST', 'SUED', 'SUEDOST', 'SUEDWEST', 'WEST'];

const WEEKDAYS = [
  'MONTAG', 'DIENSTAG', 'MITTWOCH', 'DONNERSTAG', 'FREITAG', 'SAMSTAG', 'SONNTAG',
] as const;

// ---------------------------------------------------------------------------
// The shape we keep
// ---------------------------------------------------------------------------

/** `wirkung` as the feed spells it, to the vocabulary in shared/closures.ts. */
const EFFECTS: Record<string, ClosureEffect> = {
  TOTALSPERRUNG: 'closed',
  GGL_MIT_ZS_6: 'single-track',
  GGL_MIT_ZS_8: 'single-track',
  ABWEICHUNG_VOM_FPL: 'diverted',
  FAHRZEITVERLAENGERUNG: 'slower',
  SONSTIGES: 'other',
};

/** `richtung` as the feed spells it. */
const DIRECTIONS: Record<string, ClosureDirection> = {
  BEIDE: 'both',
  MIT_KILOMETRIERUNG: 'with-km',
  GEGEN_KILOMETRIERUNG: 'against-km',
};

/**
 * The work being done, as English. The feed's `arbeiten` is a closed
 * vocabulary of 54 German values, so translating it is a table rather than a
 * guess - and unlike a station name, which this map deliberately leaves in
 * German, "Schienenauswechslung" is a description and belongs in the interface
 * language. Anything not listed falls through verbatim, so a new category
 * appears in its own words rather than as "Other".
 *
 * `IH_*Container` are DB's internal names for a booked maintenance slot: a
 * window reserved on a line section (Strecke), at a junction (Knoten), on an
 * S-Bahn, or for preventive work - not a description of any particular job.
 */
const WORKS: Record<string, string> = {
  'IH_StreckenContainer': 'Booked maintenance slot (line)',
  'IH_KnotenContainer': 'Booked maintenance slot (junction)',
  'IH_S-BahnContainer': 'Booked maintenance slot (S-Bahn)',
  'IH_PräventionsContainer': 'Booked maintenance slot (preventive)',
  'Invest-Container': 'Booked slot (investment project)',
  'Container': 'Booked slot',
  'sonstige Arbeiten': 'Other works',
  'Planbare kleine Instandhaltung': 'Minor scheduled maintenance',
  'Brückenarbeiten': 'Bridge works',
  'Brückenprüfung': 'Bridge inspection',
  'Tunnelarbeiten': 'Tunnel works',
  'Tunnelprüfung': 'Tunnel inspection',
  'Durchlassarbeiten': 'Culvert works',
  'Stützmauerarbeiten': 'Retaining wall works',
  'Fels-/Hangsanierung': 'Rock face and embankment works',
  'Untergrundverbesserung': 'Subgrade improvement',
  'Baugrunduntersuchung': 'Ground investigation',
  'Tiefenentwässerung': 'Deep drainage',
  'Einbau Planumsschutzschicht': 'Formation protection layer',
  'Arbeiten an LST-Anlagen': 'Signalling works',
  'Arbeiten an Schalthäusern': 'Switchgear building works',
  'Arbeiten an Telekommunikationsanlagen': 'Telecoms works',
  'Kabelarbeiten': 'Cable works',
  'Oberleitungsarbeiten': 'Overhead line works',
  'Oberleitungsvollinspektion': 'Overhead line inspection',
  'Stromschienenarbeiten': 'Conductor rail works',
  'Bahnsteigarbeiten': 'Platform works',
  'Arbeiten am Bahnübergang': 'Level crossing works',
  'Arbeiten an Lärmschutzanlagen': 'Noise barrier works',
  'Vegetationsarbeiten': 'Vegetation clearance',
  'Kampfmittelsondierung': 'Ordnance survey of the site',
  'Inbetriebnahme': 'Commissioning',
  'Gleiserneuerung': 'Track renewal',
  'Gleiserneuerung mit Bettungsreinigung': 'Track renewal with ballast cleaning',
  'Gleiserneuerung mit BR und PSS': 'Track renewal with ballast cleaning and formation layer',
  'Gleiserneuerung mit BR, PSS und TE': 'Track renewal with ballast cleaning, formation layer and drainage',
  'Gleisauswechslung': 'Track replacement',
  'Gleisumbau ohne Schienenwechsel': 'Track rebuild, rails retained',
  'Durcharbeitung von Gleisen': 'Track overhaul',
  'Durcharbeitung Gleise und Weichen': 'Track and points overhaul',
  'Durcharbeitung von Weichen': 'Points overhaul',
  'Weichenerneuerung': 'Points renewal',
  'Weichenerneuerung mit PSS': 'Points renewal with formation layer',
  'Weicheneinbau': 'Points installation',
  'Weichenausbau': 'Points removal',
  'Auswechslung v Weichengroßteilen': 'Replacement of major points components',
  'Schienenschleifen Weichen': 'Points rail grinding',
  'Schienenauswechslung': 'Rail replacement',
  'Schienenerneuerung': 'Rail renewal',
  'Schleifen von Schienen': 'Rail grinding',
  'Schraublochsanierung': 'Bolt hole repair',
  'Oberbauschweißen': 'Track welding',
  'Schwellenauswechslung': 'Sleeper replacement',
  'Schwellenerneuerung': 'Sleeper renewal',
};

export interface ClosureEnd {
  /** Betriebsstelle name as DB writes it - a place name, so left in German. */
  name: string;
  /** DS100 / RIL 100 code, the stable id for a German operating point. */
  ril100: string;
  lon: number;
  lat: number;
}

/**
 * One validity window. A closure is rarely continuous: most are nightly or
 * weekend possessions, and `zeitraum` only gives the outer envelope.
 * `days` is a bitmask, Monday = 1 through Sunday = 64.
 */
export interface ClosureWindow {
  from: string;
  to: string;
  days: number;
  fromTime: string;
  toTime: string;
}

export interface Closure {
  /** DB's own id for the restriction; stable across snapshots, which is what
   *  lets the log follow one closure rather than counting rows. */
  id: string;
  effect: ClosureEffect;
  direction: ClosureDirection;
  works: string;
  /** VzG line numbers the restriction sits on; usually one, sometimes two. */
  routes: number[];
  from: ClosureEnd;
  to: ClosureEnd;
  /** Outer envelope, local Berlin time exactly as the feed writes it. */
  begin: string;
  end: string;
  windows: ClosureWindow[];
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

/**
 * `gleisEinschraenkung` is not read, and deliberately.
 *
 * It looks like a second axis - DB's own SCHWER/LEICHT judgement of how bad a
 * restriction is - but over a day's feed it is exactly
 * `wirkung === 'TOTALSPERRUNG'`: 512 SCHWER, 512 full closures, no other
 * combination. Carrying it would put a column in the tiles, the log and the
 * panel that is a restatement of the effect already there.
 */
interface RawPoint { x: number; y: number }

export interface RawRestriction {
  baustellenID: string;
  wirkung: string;
  gleisEinschraenkung: string;
  richtung: string;
  arbeiten: string;
  streckennummern: number[];
  langnameVon: string;
  langnameBis: string;
  ril100Von: string;
  ril100Bis: string;
  koordinaten: { von: RawPoint; bis: RawPoint };
  zeitraum: { beginn: string; ende: string };
  gueltigkeiten: {
    vonDatum: string; bisDatum: string;
    wochentage: string[]; vonUhrzeit: string; bisUhrzeit: string;
  }[];
}

/**
 * A failed read of the closure feed. Every caller treats one the same way the
 * map treats a missing punctuality file: the feature is absent, the build is
 * not. An upstream that is down, throttling, or has moved its schema on must
 * not take the nightly deploy with it.
 */
export class ClosureFeedError extends Error {}

/**
 * The planning database's current version counter, pushed over a websocket
 * because there is no endpoint that serves it. One message is all we need, so
 * the socket is closed as soon as it lands.
 */
async function fetchRevision(timeoutMs = 20_000): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let settled = false;

    // Every path out of here has to go through `done`. The one that is easy to
    // miss is the socket closing before anything arrives - upstream hanging up,
    // a proxy in the way - which without this leaves the promise pending until
    // the job is killed rather than failing in a way the caller can retry.
    const done = (err: Error | null, value?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (err) reject(err); else resolve(value!);
    };

    const timer = setTimeout(
      () => done(new ClosureFeedError('no revision pushed within the timeout')), timeoutMs);

    ws.onerror = () => done(new ClosureFeedError('websocket handshake failed'));
    ws.onclose = () => done(new ClosureFeedError('websocket closed before sending a revision'));
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as { revision?: { nummer?: number } };
        const nummer = msg.revision?.nummer;
        // Other message types exist on this socket; wait for one that carries
        // a revision rather than failing on the first thing that arrives.
        if (typeof nummer === 'number') done(null, nummer);
      } catch {
        done(new ClosureFeedError('websocket sent a body that did not parse as JSON'));
      }
    };
  });
}

/** `POST /api/baustellen` for one date range, both ends inclusive. */
async function fetchRange(
  revision: number, from: string, to: string,
): Promise<RawRestriction[]> {
  const body = {
    revision,
    filter: {
      baustellenAktiv: true,
      baustellenNurTotalsperrung: false,
      streckenruhenAktiv: false,
      stoerungenAktiv: false,
      wirkungsdauer: 0,
      zeitraum: {
        type: 'FIX',
        beginn: `${from}T00:00:00`,
        ende: `${to}T23:59:59`,
        wochentage: [...WEEKDAYS],
      },
      regionalbereiche: REGIONS,
      streckennummern: [],
      betriebsstellen: [],
    },
  };

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/baustellen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ClosureFeedError(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new ClosureFeedError(`responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ClosureFeedError('returned a body that did not parse as JSON');
  }
  if (!Array.isArray(data)) throw new ClosureFeedError('body was not an array of restrictions');
  return data as RawRestriction[];
}

/**
 * Restrictions in effect between `from` and `to`, both `YYYY-MM-DD`.
 *
 * The revision is fetched fresh for each call and retried once: it advances
 * every few seconds as trains report in, and a request carrying one that has
 * just rolled over is rejected rather than served stale.
 */
export async function fetchClosures(from: string, to: string): Promise<Closure[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const revision = await fetchRevision();
      const raw = await fetchRange(revision, from, to);
      return raw.map(normalise).sort((a, b) => a.id.localeCompare(b.id));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new ClosureFeedError(String(lastErr));
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function endpoint(name: string, ril100: string, p: RawPoint): ClosureEnd {
  const [lon, lat] = toWgs84(p.x, p.y);
  // Six places is ~10 cm, well past what a Betriebsstelle centroid means, and
  // keeps the snapshot from carrying seventeen digits of false precision.
  return {
    name: name.trim(),
    // RIL 100 is space-padded to six characters in the feed ("TU  R").
    ril100: ril100.trim(),
    lon: Number(lon.toFixed(6)),
    lat: Number(lat.toFixed(6)),
  };
}

function dayMask(days: string[]): number {
  let mask = 0;
  for (const d of days) {
    const i = WEEKDAYS.indexOf(d as (typeof WEEKDAYS)[number]);
    if (i >= 0) mask |= 1 << i;
  }
  return mask;
}

/** Monday = bit 0, matching `WEEKDAYS`, from a `YYYY-MM-DD` date. */
function dayBit(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return 1 << ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7);
}

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * Fold the feed's day-by-day validity list back into date ranges.
 *
 * A closure that shuts a line every night for four months arrives as ~120
 * single-date entries, each one carrying an all-days weekday mask that says
 * nothing (a single date has one weekday, whatever the mask claims). Left as
 * they are, those entries are nine tenths of the snapshot's bytes and unreadable
 * in a panel. Consecutive dates sharing the same clock times collapse into one
 * range whose weekday mask is the union of the days it actually covers - so a
 * gap in the sequence, which is a real fact about the possession, still breaks
 * the range in two rather than being papered over.
 *
 * Ranges the feed states as ranges keep their own mask and merge only with an
 * identical neighbour, because there the mask is the restriction ("weekends
 * only") and recomputing it from the dates would throw it away.
 */
function compactWindows(raw: ClosureWindow[]): ClosureWindow[] {
  const prepared = raw.map((w) => ({
    ...w,
    // A single-date entry's mask is noise; the date itself is the fact.
    days: w.from === w.to ? dayBit(w.from) : w.days,
    derived: w.from === w.to,
  }));
  prepared.sort((a, b) => a.from.localeCompare(b.from) || a.fromTime.localeCompare(b.fromTime));

  const merged: typeof prepared = [];
  for (const w of prepared) {
    const last = merged[merged.length - 1];
    const contiguous = last
      && last.fromTime === w.fromTime && last.toTime === w.toTime
      && nextDay(last.to) === w.from
      && (last.derived && w.derived ? true : last.days === w.days);
    if (contiguous) {
      last.to = w.to;
      last.days |= w.days;
      last.derived = last.derived && w.derived;
      continue;
    }
    merged.push({ ...w });
  }

  return merged.map(({ derived: _derived, ...w }) => w);
}

/** Exported for pipeline/closures.test.ts, which drives it with real records. */
export function normalise(raw: RawRestriction): Closure {
  return {
    id: raw.baustellenID,
    effect: EFFECTS[raw.wirkung] ?? 'other',
    direction: DIRECTIONS[raw.richtung] ?? 'both',
    works: WORKS[raw.arbeiten] ?? raw.arbeiten,
    routes: [...new Set(raw.streckennummern ?? [])].sort((a, b) => a - b),
    from: endpoint(raw.langnameVon, raw.ril100Von, raw.koordinaten.von),
    to: endpoint(raw.langnameBis, raw.ril100Bis, raw.koordinaten.bis),
    begin: raw.zeitraum.beginn,
    end: raw.zeitraum.ende,
    windows: compactWindows((raw.gueltigkeiten ?? []).map((g) => ({
      from: g.vonDatum,
      to: g.bisDatum,
      days: dayMask(g.wochentage ?? []),
      fromTime: g.vonUhrzeit,
      toTime: g.bisUhrzeit,
    }))),
  };
}

// ---------------------------------------------------------------------------
// The history log
// ---------------------------------------------------------------------------

/**
 * An append-only record of what the planning database said and when.
 *
 * There is no historical source to use instead - strecken.info serves the
 * current plan and nothing before it, and nobody publishes an archive of it
 * (docs/closures.md, "Looking for a historical source"). So the history is one
 * we keep: the log is the archive, and it starts the day the job first runs.
 *
 * It is an event stream rather than a daily snapshot because a snapshot of
 * ~8,000 restrictions rewritten every night would add a gigabyte a year to a
 * repository whose whole point is that it stays diffable. Events are keyed on
 * DB's own restriction id, so a closure that runs weekend nights is one
 * `planned` line, not one line per weekend.
 */
/**
 * A closure as the log keeps it: everything but the validity windows.
 *
 * The windows are the shift pattern - which nights, which hours - and DB
 * restates them in full on every reading, so logging them would triple the
 * archive to record something the current snapshot always has. What the log is
 * for is the plan: where, what, how bad, and between which dates.
 */
export type PlannedClosure = Omit<Closure, 'windows'>;

export type ClosureEvent =
  /** First time this id was seen, with everything the log keeps about it. */
  | ({ t: string; e: 'planned' } & PlannedClosure)
  /** The plan moved. Only the fields that changed are carried, old and new. */
  | { t: string; e: 'revised'; id: string; was: Partial<PlannedClosure>; now: Partial<PlannedClosure> }
  /** In the plan yesterday, gone today, and its dates had not yet run out. */
  | { t: string; e: 'withdrawn'; id: string };

/** The fields a `revised` event watches. Everything else is descriptive. */
const TRACKED = ['effect', 'direction', 'works', 'begin', 'end'] as const;

export function readLog(path = LOG_PATH): ClosureEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ClosureEvent);
}

export interface LoggedClosure {
  /** The record as last recorded, i.e. after replaying every revision. */
  current: PlannedClosure;
  /** Date of the `planned` event - when this closure entered the plan. */
  since: string;
  /** The end date it was *first* planned to have, before any revision. */
  firstEnd: string;
  /** How many times the plan has been revised since. */
  revisions: number;
  /**
   * Every move of the end date, oldest first.
   *
   * Separate from `revisions` because they answer different questions: the
   * count includes a revision that only reworded the works, while this is the
   * one thing a reader actually wants a history for - a possession that keeps
   * being pushed back. Kept as a list rather than a total so the panel can say
   * when each move happened rather than only that they happened.
   */
  endMoves: EndMove[];
  withdrawn: boolean;
}

/** Replay the log into the state it describes, keyed by restriction id. */
export function replayLog(events: ClosureEvent[]): Map<string, LoggedClosure> {
  const state = new Map<string, LoggedClosure>();
  for (const ev of events) {
    if (ev.e === 'planned') {
      const { t, e: _e, ...closure } = ev;
      state.set(ev.id, {
        current: closure as PlannedClosure,
        since: t,
        firstEnd: closure.end,
        revisions: 0,
        endMoves: [],
        withdrawn: false,
      });
    } else if (ev.e === 'revised') {
      const entry = state.get(ev.id);
      if (!entry) continue; // A revision with no `planned` before it: skip.
      // The end date moving is the event the archive exists for, so it is
      // recorded in its own right rather than left to be inferred from a
      // counter. A revision that only reworded the works still counts as a
      // revision and adds nothing here, which is the honest split.
      if (typeof ev.was.end === 'string' && typeof ev.now.end === 'string') {
        entry.endMoves.push({
          logged: ev.t, was: ev.was.end.slice(0, 10), now: ev.now.end.slice(0, 10),
        });
      }
      entry.current = { ...entry.current, ...ev.now };
      entry.revisions++;
      // A withdrawn closure that comes back is live again, and its return is
      // itself a revision - so it is not a third event type.
      entry.withdrawn = false;
    } else if (ev.e === 'withdrawn') {
      const entry = state.get(ev.id);
      if (entry) entry.withdrawn = true;
    }
  }
  return state;
}

/** `YYYY-MM-DD` in the timezone every timestamp in this feed is written in. */
export function berlinDate(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/**
 * The validity windows that actually apply on `day`.
 *
 * A window has to contain the date *and* allow its weekday: DB states a
 * weekends-only possession as one range spanning months, so a date test alone
 * would report Saturday's hours on a Tuesday. The server has already filtered
 * the feed to restrictions active on the queried day, so for a snapshot of one
 * day this returns at least one window - but it is the caller's job not to
 * assume that when asking about any other date.
 */
export function windowsOn(closure: Closure, day: string): ClosureWindow[] {
  const bit = dayBit(day);
  return closure.windows.filter((w) => w.from <= day && w.to >= day && (w.days & bit) !== 0);
}

/** Strip the shift pattern: what the log keeps of a reading of the plan. */
function planned(c: Closure): PlannedClosure {
  const { windows: _windows, ...rest } = c;
  return rest;
}

/** Does `c`'s outer envelope overlap the inclusive date range? */
function overlaps(c: PlannedClosure, from: string, to: string): boolean {
  return c.begin.slice(0, 10) <= to && c.end.slice(0, 10) >= from;
}

function changedFields(before: PlannedClosure, after: PlannedClosure) {
  const was: Partial<PlannedClosure> = {};
  const now: Partial<PlannedClosure> = {};
  for (const key of TRACKED) {
    if (before[key] !== after[key]) {
      (was as Record<string, unknown>)[key] = before[key];
      (now as Record<string, unknown>)[key] = after[key];
    }
  }
  return Object.keys(now).length ? { was, now } : null;
}

/**
 * Compare a fresh reading of the plan against the log and return the events
 * that describe the difference. Pure, so the diff is testable without a
 * network or a file.
 *
 * `withdrawn` is only ever emitted for a closure whose dates fall inside the
 * window that was actually queried. Anything outside it is absent because it
 * was not asked for, and calling that a withdrawal would fill the log with
 * closures being cancelled and reinstated as the window slides over them.
 */
export function diffAgainstLog(
  known: Map<string, LoggedClosure>,
  fresh: Closure[],
  today: string,
  window: { from: string; to: string },
): ClosureEvent[] {
  const events: ClosureEvent[] = [];
  const seen = new Set<string>();

  for (const raw of fresh) {
    const closure = planned(raw);
    seen.add(closure.id);
    const entry = known.get(closure.id);
    if (!entry) {
      events.push({ t: today, e: 'planned', ...closure });
      continue;
    }
    const delta = changedFields(entry.current, closure);
    if (delta) events.push({ t: today, e: 'revised', id: closure.id, ...delta });
    // A closure back after a withdrawal, unchanged in every tracked field,
    // still needs an event or the log would say it is still withdrawn.
    else if (entry.withdrawn) {
      events.push({ t: today, e: 'revised', id: closure.id, was: {}, now: {} });
    }
  }

  for (const [id, entry] of known) {
    if (seen.has(id) || entry.withdrawn) continue;
    if (overlaps(entry.current, window.from, window.to)) {
      events.push({ t: today, e: 'withdrawn', id });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Write the restrictions in effect today where the build can find them.
 * Today only: the map says what is shut *now*, and a week of lookahead drawn
 * on the same lines would say something else while looking the same.
 */
async function snapshot(): Promise<void> {
  const day = berlinDate();
  const closures = await fetchClosures(day, day);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify({ day, closures }));
  const closed = closures.filter((c) => c.effect === 'closed').length;
  console.log(`==> ${closures.length} restrictions in effect on ${day} (${closed} full closures)`);
}

/** Bring `data/closure-log.jsonl` up to date with a fresh reading of the plan. */
async function reconcileLog(): Promise<void> {
  const today = berlinDate();
  const window = { from: today, to: berlinDate(LOG_HORIZON_DAYS) };
  const fresh = await fetchClosures(window.from, window.to);

  const known = replayLog(readLog());
  const events = diffAgainstLog(known, fresh, today, window);

  console.log(
    `==> ${fresh.length} restrictions planned ${window.from}..${window.to}, ` +
    `${known.size} already logged`);

  if (!events.length) {
    console.log('==> log already current');
    return;
  }

  mkdirSync(DATA, { recursive: true });
  appendFileSync(LOG_PATH, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const tally = events.reduce<Record<string, number>>((acc, e) => {
    acc[e.e] = (acc[e.e] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`==> appended ${events.length} events: ${JSON.stringify(tally)}`);
}

// `import.meta.main` is Node 24; this project runs on 22.
const invoked = process.argv[1]?.endsWith('closures.ts');
if (invoked) {
  const job = process.argv.includes('--log') ? reconcileLog() : snapshot();
  job.catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

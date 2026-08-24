/**
 * Reading a construction closure back out of the tiles.
 *
 * Unlike departures (src/live.ts) there is no runtime call here and no seam to
 * keep open for one: DB InfraGO's API answers `access-control-allow-origin` with
 * its own origin, so a browser on this origin cannot reach it at all. The
 * closures are baked into `rail.pmtiles` by the nightly build, the same way the
 * network is, and this module's whole job is to turn a tile feature's flat
 * string properties back into something the panel can render.
 *
 * Everything the panel shows therefore describes the day the tiles were built.
 * That is stated on the panel rather than glossed over - a possession that was
 * lifted this morning is still drawn until tonight's rebuild.
 */

import {
  bandOf, parseEndMoves, spanDays,
  type ClosureBand, type ClosureDirection, type ClosureEffect,
  type EndMove as SharedEndMove,
} from '../shared/closures.ts';

export interface ClosureRecord {
  /** DB InfraGO's own id for the restriction. */
  id: string;
  effect: ClosureEffect;
  direction: ClosureDirection;
  /** The work being done, in English where the category is a known one. */
  works: string;
  /** VzG line numbers, comma-joined, as the feed states them. */
  routes: string;
  /** "A – B", or just the place for a restriction inside one station. */
  section: string;
  /** The operating point the restriction starts at, on its own. */
  fromName: string;
  /** Whether this is a section of line or a single operating point. */
  point: boolean;
  /** Outer envelope of the possession, `YYYY-MM-DD`. */
  begin: string;
  end: string;
  /** Length of that envelope in whole days, both ends counted. */
  days: number;
  /** Which of the three length classes the map draws it in. */
  band: ClosureBand;
  /** Clock window(s) in effect on the day the tiles were built, or ''. */
  hours: string;
  /** Day this restriction first appeared in our log, or '' if unrecorded. */
  since: string;
  /** The end date it was first logged with - only interesting once it moves. */
  firstEnd: string;
  /** Times the plan has been revised since we first saw it. */
  extended: number;
  /** Every recorded move of the end date, oldest first. */
  moves: EndMove[];
}

/**
 * One recorded move of the end date, as the panel tells it: the shared record
 * plus how many days it added, which is what a reader is actually after.
 */
export interface EndMove extends SharedEndMove {
  /** Days added; negative where the possession was brought forward. */
  delta: number;
}

const EFFECTS = new Set<ClosureEffect>([
  'closed', 'single-track', 'diverted', 'slower', 'other',
]);
const DIRECTIONS = new Set<ClosureDirection>(['both', 'with-km', 'against-km']);
const BANDS = new Set<ClosureBand>(['days', 'weeks', 'months']);

/**
 * Tile properties are strings and numbers with no schema behind them, so each
 * field is checked rather than asserted. An unknown `effect` falls back to
 * `other`, which is honest - the restriction exists and we cannot say what it
 * does - and keeps a new upstream value from rendering as `undefined`.
 */
export function parseClosure(
  props: Record<string, unknown>, isPoint: boolean,
): ClosureRecord {
  const str = (key: string) => (typeof props[key] === 'string' ? props[key] : '');
  const effect = str('effect') as ClosureEffect;
  const direction = str('direction') as ClosureDirection;
  const band = str('band') as ClosureBand;

  return {
    id: str('id'),
    effect: EFFECTS.has(effect) ? effect : 'other',
    direction: DIRECTIONS.has(direction) ? direction : 'both',
    works: str('works'),
    routes: str('routes'),
    section: str('section'),
    fromName: str('fromName'),
    point: isPoint,
    begin: str('begin'),
    end: str('end'),
    // Both are computed in the build, but neither is trusted here: a tile from
    // before this property existed has no `band` at all, and falling back to
    // the dates keeps such a tile readable instead of rendering a blank class.
    days: typeof props.days === 'number' ? props.days : spanDays(str('begin'), str('end')),
    band: BANDS.has(band) ? band : bandOf(spanDays(str('begin'), str('end'))),
    hours: str('hours'),
    since: str('since'),
    firstEnd: str('firstEnd'),
    extended: typeof props.extended === 'number' ? props.extended : 0,
    moves: readMoves(str('moves')),
  };
}

/**
 * The packed history, with the days each move added worked out.
 *
 * The parsing is shared with the build that wrote the string; what belongs to
 * the panel is the arithmetic - `spanDays` counts both ends, so a move from the
 * 11th to the 2nd of the next month is 22 days inclusive and 21 days added.
 */
function readMoves(packed: string): EndMove[] {
  return parseEndMoves(packed).map((m) => ({ ...m, delta: spanDays(m.was, m.now) - 1 }));
}

/**
 * Has the plan actually moved? A restriction is only worth calling extended or
 * brought forward when the log holds both dates *and* they differ - on a fresh
 * log every restriction has a `firstEnd` equal to its `end`, and reporting that
 * as "unchanged since we started watching" would claim a record we do not have.
 */
export function endMoved(c: ClosureRecord): 'later' | 'earlier' | null {
  if (!c.firstEnd || !c.end || c.firstEnd === c.end) return null;
  return c.end > c.firstEnd ? 'later' : 'earlier';
}

/** `2026-12-12` as a date a reader takes in, in the interface's language. */
export function formatDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * How far through a possession the map's day is.
 *
 * Measured against the day the tiles describe, not against the reader's clock.
 * The overlay is a build-time reading (`docs/closures.md`), and a bar that ran
 * on browser time could show a possession as finished while the map is still
 * drawing it as in force. One clock for the whole overlay is worth more than a
 * few hours of freshness on a bar whose unit is days.
 */
export interface ClosureProgress {
  /** Length of the current plan in days, both ends counted. */
  total: number;
  /** Days of it behind us, including today. 0 before it starts. */
  gone: number;
  /** Days still to run, including today. 0 once it is over. */
  left: number;
  /** `gone / total`, 0 to 1 - what the bar fills to. */
  through: number;
  /** Where the *first* recorded end date sits on the same scale, or null. */
  firstEndThrough: number | null;
  started: boolean;
}

export function progressOn(c: ClosureRecord, day: string): ClosureProgress | null {
  const total = spanDays(c.begin, c.end);
  if (!total || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;

  const gone = Math.min(total, Math.max(0, spanDays(c.begin, day)));
  const left = Math.max(0, total - gone);

  // Only worth a tick where the plan actually moved and the original end is
  // inside the bar we are drawing: a possession brought forward has its first
  // end past the right-hand edge, and pinning that to 1 would draw it as if it
  // had been extended to exactly today's end date.
  const firstEnd = endMoved(c) === 'later' ? spanDays(c.begin, c.firstEnd) : 0;
  const firstEndThrough = firstEnd > 0 && firstEnd <= total ? firstEnd / total : null;

  return { total, gone, left, through: gone / total, firstEndThrough, started: gone > 0 };
}

/**
 * Where to read DB's own account of the work.
 *
 * There is no per-restriction link to be had. strecken.info is a single-route
 * app - its bundle declares `/`, `/admin/*` and a catch-all, and it puts no
 * state in the URL - so a possession cannot be addressed there, and the feed
 * itself carries no description, project name or reference beyond the fields
 * this map already draws.
 *
 * What DB does publish per *project* is the BauInfoPortal, and its search takes
 * a query string. So the link offered is a search for the operating point the
 * restriction names, and it is labelled as a search rather than as this
 * possession's project page: DB's search matches project prose, so it will
 * sometimes return works that are merely mentioned near the place. Handing a
 * reader an honest search beats claiming a match this map cannot verify.
 */
export const BAUINFO_SEARCH = 'https://bauprojekte.deutschebahn.com/suche';

export function projectSearchUrl(c: ClosureRecord): string {
  return `${BAUINFO_SEARCH}?q=${encodeURIComponent(c.fromName || c.section)}`;
}

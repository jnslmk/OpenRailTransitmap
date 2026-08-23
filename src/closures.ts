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

import type { ClosureDirection, ClosureEffect } from '../shared/closures.ts';

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
  /** Whether this is a section of line or a single operating point. */
  point: boolean;
  /** Outer envelope of the possession, `YYYY-MM-DD`. */
  begin: string;
  end: string;
  /** Clock window(s) in effect on the day the tiles were built, or ''. */
  hours: string;
  /** Day this restriction first appeared in our log, or '' if unrecorded. */
  since: string;
  /** The end date it was first logged with - only interesting once it moves. */
  firstEnd: string;
  /** Times the plan has been revised since we first saw it. */
  extended: number;
}

const EFFECTS = new Set<ClosureEffect>([
  'closed', 'single-track', 'diverted', 'slower', 'other',
]);
const DIRECTIONS = new Set<ClosureDirection>(['both', 'with-km', 'against-km']);

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

  return {
    id: str('id'),
    effect: EFFECTS.has(effect) ? effect : 'other',
    direction: DIRECTIONS.has(direction) ? direction : 'both',
    works: str('works'),
    routes: str('routes'),
    section: str('section'),
    point: isPoint,
    begin: str('begin'),
    end: str('end'),
    hours: str('hours'),
    since: str('since'),
    firstEnd: str('firstEnd'),
    extended: typeof props.extended === 'number' ? props.extended : 0,
  };
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

/**
 * The vocabulary of an infrastructure restriction, shared by the pipeline that
 * reads DB InfraGO's feed and the app that draws what it read.
 *
 * Only the enumerations live here. The record shape is the pipeline's business
 * (pipeline/closures.ts) and the wording is the interface's (src/strings.ts) -
 * what both sides have to agree on is the set of values a tile property can
 * hold, which is exactly this.
 */

/**
 * What the restriction does to traffic, from the feed's `wirkung`.
 *
 * `closed` is `TOTALSPERRUNG`: no trains at all. `single-track` is
 * `GGL_MIT_ZS_6`/`_ZS_8` - one track of a two-track line is out and trains use
 * the other one in both directions under hand signals, so the line survives at
 * a fraction of its capacity. The other three are restrictions rather than
 * closures, and are kept because a line that is merely slow still explains a
 * timetable that has gone strange.
 */
export type ClosureEffect =
  | 'closed' | 'single-track' | 'diverted' | 'slower' | 'other';

/** Worst first. Where restrictions overlap, this decides which is drawn on top. */
export const EFFECT_RANK: Record<ClosureEffect, number> = {
  closed: 4, 'single-track': 3, diverted: 2, slower: 1, other: 0,
};

/**
 * Which track is affected, from `richtung`.
 *
 * German railway kilometrage runs in one nominal direction along a line, and DB
 * names a track by whether it runs with that direction or against it. `both` is
 * the whole line, and is what every full closure carries.
 */
export type ClosureDirection = 'both' | 'with-km' | 'against-km';

/**
 * How long the restriction runs, as a class rather than a number.
 *
 * A weekend possession and a four-month one are different facts about a line,
 * and until now the map drew them identically. Over the log's 13,849 records
 * three quarters run three days or less, an eighth run a week to a month, and
 * a twelfth run longer than a month - so these are the joints the data itself
 * has. Drawn on one day the mix is quite different, because a possession is on
 * the map once per day it is in force: a reading of 22 August 2026 put 874
 * restrictions in `days`, 813 in `weeks` and 887 in `months`. That near-even
 * split is what makes the band worth drawing.
 */
export type ClosureBand = 'days' | 'weeks' | 'months';

/** Upper bound of each band in days, inclusive. `months` is everything above. */
export const BAND_DAYS: Record<Exclude<ClosureBand, 'months'>, number> = {
  days: 3, weeks: 31,
};

/**
 * The band an envelope of `n` days falls in.
 *
 * Counted inclusively, so a possession that begins and ends on the same date is
 * one day rather than none - the feed states a single night's work that way and
 * calling it zero would put it in no band at all.
 */
export function bandOf(days: number): ClosureBand {
  if (days <= BAND_DAYS.days) return 'days';
  if (days <= BAND_DAYS.weeks) return 'weeks';
  return 'months';
}

/** Whole days from `begin` to `end` inclusive, both `YYYY-MM-DD`. */
export function spanDays(begin: string, end: string): number {
  const from = Date.parse(`${begin.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${end.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / 86_400_000) + 1;
}

/**
 * One recorded move of a possession's end date.
 *
 * `logged` is the day our own log noticed, which is the only date there is to
 * give: DB publishes the plan as it stands and never says when it changed.
 */
export interface EndMove {
  logged: string;
  was: string;
  now: string;
}

/**
 * How many moves travel in the tiles.
 *
 * Every feature carries every property it has, so an unbounded history would
 * grow the closure layer worst for exactly the possessions already carrying the
 * most of everything else. Six is well past anything in the log, and the panel
 * says when it is showing a list that hit the cap.
 */
export const MAX_MOVES = 6;

const MOVE = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})>(\d{4}-\d{2}-\d{2})$/;

/**
 * The move history as one tile property: `logged:was>now`, newest last.
 *
 * Flat because that is all a vector tile holds, and packed here rather than in
 * the build so the two halves of the format cannot drift: whatever writes it
 * and whatever reads it are the same twenty lines.
 */
export function packEndMoves(moves: EndMove[]): string {
  return moves
    .slice(-MAX_MOVES)
    .map((m) => `${m.logged}:${m.was}>${m.now}`)
    .join(';');
}

/**
 * Back again. An entry that does not parse is dropped rather than shown
 * half-read: this is the one part of the panel making a claim about the past,
 * and a partial row would make it a wrong one.
 */
export function parseEndMoves(packed: string): EndMove[] {
  if (!packed) return [];
  const out: EndMove[] = [];
  for (const entry of packed.split(';')) {
    const match = MOVE.exec(entry);
    if (match) out.push({ logged: match[1], was: match[2], now: match[3] });
  }
  return out;
}

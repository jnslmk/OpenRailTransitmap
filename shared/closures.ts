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
export type ClosureEffect = 'closed' | 'single-track' | 'diverted' | 'slower' | 'other';

/** Worst first. Where restrictions overlap, this decides which is drawn on top. */
export const EFFECT_RANK: Record<ClosureEffect, number> = {
  closed: 4,
  'single-track': 3,
  diverted: 2,
  slower: 1,
  other: 0,
};

/**
 * Which track is affected, from `richtung`.
 *
 * German railway kilometrage runs in one nominal direction along a line, and DB
 * names a track by whether it runs with that direction or against it. `both` is
 * the whole line, and is what every full closure carries.
 */
export type ClosureDirection = 'both' | 'with-km' | 'against-km';

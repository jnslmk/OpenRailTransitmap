/**
 * What the panel says about a possession's length, and about the plan for it
 * having moved.
 *
 * Two things are worth guarding here. The first is that the numbers are read
 * off the day the tiles describe rather than off whatever clock happens to be
 * running - the overlay is a build-time reading, and a bar measured on the
 * reader's own clock could report a possession finished while the map is still
 * drawing it. The second is that nothing is claimed from a tile that does not
 * carry it: a tile built before these properties existed has to degrade to the
 * dates it does have, not to a blank class or an invented history.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClosure, progressOn, projectSearchUrl, endMoved } from './closures.ts';
import { bandOf, spanDays } from '../shared/closures.ts';

/** A tile feature's properties, as flat as MapLibre hands them over. */
function props(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1ACEC.2',
    effect: 'closed',
    direction: 'both',
    works: 'Tunnel works',
    routes: '3600',
    section: 'Bebra Tunnel Üst – Cornberg',
    fromName: 'Bebra Tunnel Üst',
    begin: '2026-08-13',
    end: '2026-12-12',
    days: 122,
    band: 'months',
    hours: '',
    since: '',
    firstEnd: '',
    extended: 0,
    moves: '',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Length
// ---------------------------------------------------------------------------

test('the day count and the band are read straight off the tile', () => {
  const c = parseClosure(props(), false);
  assert.equal(c.days, 122);
  assert.equal(c.band, 'months');
});

test('a tile from before the band existed falls back to its own dates', () => {
  const c = parseClosure(props({ days: undefined, band: undefined }), false);
  assert.equal(c.days, 122, 'the envelope is still countable');
  assert.equal(c.band, 'months');
});

test('an unknown band is not passed through to the style as-is', () => {
  // The style matches on this string, and an unmatched one would silently take
  // the fallback weight - so the check belongs here, where it can be seen.
  const c = parseClosure(props({ band: 'fortnight' }), false);
  assert.equal(c.band, 'months');
});

test('the three bands split where the feed does', () => {
  assert.equal(bandOf(1), 'days', 'a single night');
  assert.equal(bandOf(3), 'days', 'a weekend');
  assert.equal(bandOf(4), 'weeks');
  assert.equal(bandOf(31), 'weeks');
  assert.equal(bandOf(32), 'months');
  assert.equal(spanDays('2026-08-13', '2026-08-13'), 1, 'one date is one day');
});

// ---------------------------------------------------------------------------
// How much is left
// ---------------------------------------------------------------------------

test('progress is measured against the day the tiles describe', () => {
  const c = parseClosure(props(), false);
  const p = progressOn(c, '2026-09-01')!;
  assert.equal(p.total, 122);
  assert.equal(p.gone, 20, '13 Aug to 1 Sep inclusive');
  assert.equal(p.left, 102);
  assert.ok(p.through > 0.16 && p.through < 0.17);
});

test('the last day of a possession has nothing left rather than one day left', () => {
  const c = parseClosure(props(), false);
  const p = progressOn(c, '2026-12-12')!;
  assert.equal(p.gone, p.total);
  assert.equal(p.left, 0);
  assert.equal(p.through, 1);
});

test('a day outside the envelope cannot push the bar past its ends', () => {
  const c = parseClosure(props(), false);
  assert.equal(progressOn(c, '2026-01-01')!.gone, 0, 'before it starts');
  assert.equal(progressOn(c, '2027-06-01')!.through, 1, 'long after it ends');
});

test('with no day read off the tiles yet there is no progress to state', () => {
  assert.equal(progressOn(parseClosure(props(), false), ''), null);
});

// ---------------------------------------------------------------------------
// The plan moving
// ---------------------------------------------------------------------------

test('a possession pushed back marks where it was first meant to finish', () => {
  const c = parseClosure(props({ since: '2026-08-22', firstEnd: '2026-10-02' }), false);
  assert.equal(endMoved(c), 'later');
  const p = progressOn(c, '2026-09-01')!;
  assert.ok(p.firstEndThrough !== null);
  assert.ok(
    p.firstEndThrough > 0.4 && p.firstEndThrough < 0.45,
    `first end at ${p.firstEndThrough}`,
  );
});

test('a possession brought forward gets no tick, because it would be off the bar', () => {
  const c = parseClosure(props({ since: '2026-08-22', firstEnd: '2027-02-01' }), false);
  assert.equal(endMoved(c), 'earlier');
  assert.equal(progressOn(c, '2026-09-01')!.firstEndThrough, null);
});

test('a fresh log claims no movement at all', () => {
  // On the day the job first runs every restriction has firstEnd === end, and
  // reporting that as "unchanged since we started watching" would claim a
  // record we do not have.
  const c = parseClosure(props({ since: '2026-08-22', firstEnd: '2026-12-12' }), false);
  assert.equal(endMoved(c), null);
  assert.equal(progressOn(c, '2026-09-01')!.firstEndThrough, null);
});

test('each move of the end date is read back with the days it added', () => {
  const c = parseClosure(
    props({
      moves: '2026-09-02:2026-09-11>2026-10-02;2026-10-20:2026-10-02>2026-12-12',
    }),
    false,
  );
  assert.equal(c.moves.length, 2);
  assert.deepEqual(c.moves[0], {
    logged: '2026-09-02',
    was: '2026-09-11',
    now: '2026-10-02',
    delta: 21,
  });
  assert.equal(c.moves[1].delta, 71);
});

test('a move that pulled the end date forward reads as negative, not as nothing', () => {
  const c = parseClosure(props({ moves: '2026-09-02:2026-10-02>2026-09-11' }), false);
  assert.equal(c.moves[0].delta, -21);
});

test('a malformed move is dropped rather than shown half-read', () => {
  const c = parseClosure(
    props({ moves: 'rubbish;2026-09-02:2026-09-11>2026-10-02;also-rubbish' }),
    false,
  );
  assert.equal(c.moves.length, 1);
  assert.equal(c.moves[0].was, '2026-09-11');
});

test('a tile with no move history yields no moves', () => {
  assert.deepEqual(parseClosure(props(), false).moves, []);
});

// ---------------------------------------------------------------------------
// Linking out
// ---------------------------------------------------------------------------

test('the official link searches for the operating point, escaped', () => {
  const url = projectSearchUrl(parseClosure(props({ fromName: 'Hann Münden' }), false));
  assert.equal(url, 'https://bauprojekte.deutschebahn.com/suche?q=Hann%20M%C3%BCnden');
});

test('with no operating point on the tile the section is searched instead', () => {
  const url = projectSearchUrl(parseClosure(props({ fromName: '' }), false));
  assert.ok(url.includes('Bebra'), url);
});

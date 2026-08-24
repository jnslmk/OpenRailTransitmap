/**
 * Two things here are worth guarding.
 *
 * The first is what the feed's validity list turns into. DB states a
 * four-month nightly possession as one entry per date, each carrying an
 * all-days weekday mask that means nothing, and the fold back into ranges has
 * to keep the two facts that matter: that a gap in the dates is real, and that
 * a mask the feed *did* state ("weekends only") is not ours to recompute.
 *
 * The second is the history log. It is append-only and it is the archive - no
 * upstream keeps one - so a diff that emits a spurious `withdrawn`, or misses a
 * date change, writes a fact that cannot be corrected by the next run.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalise,
  replayLog,
  diffAgainstLog,
  windowsOn,
  type Closure,
  type ClosureEvent,
  type PlannedClosure,
  type RawRestriction,
} from './closures.ts';

// EPSG:3857 coordinates of two operating points either side of the Cornberg
// tunnel, taken from a real reading of the feed.
const BEBRA = { x: 1095159, y: 6625535 };
const CORNBERG = { x: 1097137, y: 6626530 };

function raw(over: Partial<RawRestriction> = {}): RawRestriction {
  return {
    baustellenID: 'ABC.1',
    wirkung: 'TOTALSPERRUNG',
    gleisEinschraenkung: 'SCHWER',
    richtung: 'BEIDE',
    arbeiten: 'Tunnelarbeiten',
    streckennummern: [3600],
    langnameVon: 'Bebra Tunnel Üst',
    langnameBis: 'Cornberg',
    ril100Von: 'FBT   ',
    ril100Bis: 'FCG   ',
    koordinaten: { von: BEBRA, bis: CORNBERG },
    zeitraum: { beginn: '2026-08-13T00:00:00', ende: '2026-12-12T04:00:00' },
    gueltigkeiten: [],
    ...over,
  };
}

/** The feed's shape for "this date, these hours". */
const day = (date: string, from = '03:00:00', to = '04:00:00') => ({
  vonDatum: date,
  bisDatum: date,
  wochentage: ['MONTAG', 'DIENSTAG', 'MITTWOCH', 'DONNERSTAG', 'FREITAG', 'SAMSTAG', 'SONNTAG'],
  vonUhrzeit: from,
  bisUhrzeit: to,
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test('reads the effect, the direction and the trimmed operating point codes', () => {
  const c = normalise(raw());
  assert.equal(c.effect, 'closed');
  assert.equal(c.direction, 'both');
  assert.equal(c.works, 'Tunnel works');
  assert.equal(c.from.ril100, 'FBT');
  assert.equal(c.to.ril100, 'FCG');
});

test("projects the feed's Mercator coordinates into degrees", () => {
  const c = normalise(raw());
  // Bebra is at roughly 9.83 E, 51.02 N.
  assert.ok(Math.abs(c.from.lon - 9.835) < 0.01, `lon was ${c.from.lon}`);
  assert.ok(Math.abs(c.from.lat - 51.02) < 0.01, `lat was ${c.from.lat}`);
});

test('keeps an unlisted work category in its own words', () => {
  const c = normalise(raw({ arbeiten: 'Neuartige Arbeiten' }));
  assert.equal(c.works, 'Neuartige Arbeiten');
});

test('folds a run of nightly dates into one range', () => {
  const c = normalise(
    raw({
      gueltigkeiten: ['2026-08-14', '2026-08-15', '2026-08-16'].map((d) => day(d)),
    }),
  );
  assert.deepEqual(c.windows, [
    {
      from: '2026-08-14',
      to: '2026-08-16',
      // Friday, Saturday, Sunday - from the dates, not from the feed's mask.
      days: 0b1110000,
      fromTime: '03:00:00',
      toTime: '04:00:00',
    },
  ]);
});

test('a gap in the dates breaks the range in two', () => {
  const c = normalise(
    raw({
      gueltigkeiten: ['2026-08-14', '2026-08-15', '2026-08-17'].map((d) => day(d)),
    }),
  );
  assert.equal(c.windows.length, 2);
  assert.deepEqual(
    c.windows.map((w) => [w.from, w.to]),
    [
      ['2026-08-14', '2026-08-15'],
      ['2026-08-17', '2026-08-17'],
    ],
  );
});

test('a change of hours breaks the range in two', () => {
  const c = normalise(
    raw({
      gueltigkeiten: [day('2026-08-14'), day('2026-08-15', '22:00:00', '05:00:00')],
    }),
  );
  assert.equal(c.windows.length, 2);
});

test('a weekday mask the feed actually states is left alone', () => {
  // "Weekends, all year" must not become "every day, all year" because the
  // dates it spans happen to include every weekday.
  const c = normalise(
    raw({
      gueltigkeiten: [
        {
          vonDatum: '2026-01-10',
          bisDatum: '2026-06-30',
          wochentage: ['SAMSTAG', 'SONNTAG'],
          vonUhrzeit: '00:00:00',
          bisUhrzeit: '23:59:00',
        },
      ],
    }),
  );
  assert.deepEqual(c.windows, [
    {
      from: '2026-01-10',
      to: '2026-06-30',
      days: 0b1100000,
      fromTime: '00:00:00',
      toTime: '23:59:00',
    },
  ]);
});

test('two stated ranges with different masks stay apart', () => {
  const c = normalise(
    raw({
      gueltigkeiten: [
        {
          vonDatum: '2026-01-05',
          bisDatum: '2026-01-09',
          wochentage: ['MONTAG'],
          vonUhrzeit: '01:00:00',
          bisUhrzeit: '05:00:00',
        },
        {
          vonDatum: '2026-01-10',
          bisDatum: '2026-01-16',
          wochentage: ['SAMSTAG'],
          vonUhrzeit: '01:00:00',
          bisUhrzeit: '05:00:00',
        },
      ],
    }),
  );
  assert.equal(c.windows.length, 2);
});

test('the windows in effect on a day exclude a weekday the feed rules out', () => {
  // 2026-01-13 is a Tuesday inside a weekends-only range. A date test alone
  // would report Saturday's hours on it.
  const c = normalise(
    raw({
      gueltigkeiten: [
        {
          vonDatum: '2026-01-10',
          bisDatum: '2026-06-30',
          wochentage: ['SAMSTAG', 'SONNTAG'],
          vonUhrzeit: '22:00:00',
          bisUhrzeit: '05:00:00',
        },
      ],
    }),
  );
  assert.equal(windowsOn(c, '2026-01-13').length, 0);
  assert.equal(windowsOn(c, '2026-01-17').length, 1); // a Saturday
  assert.equal(windowsOn(c, '2026-07-04').length, 0); // past the range
});

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

const WINDOW = { from: '2026-08-22', to: '2026-09-05' };

const closure = (over: Partial<Closure> = {}): Closure => ({ ...normalise(raw()), ...over });

test('a closure that has never been seen is logged with everything known', () => {
  const events = diffAgainstLog(new Map(), [closure()], '2026-08-22', WINDOW);
  assert.equal(events.length, 1);
  assert.equal(events[0].e, 'planned');
  assert.equal(events[0].t, '2026-08-22');
  assert.equal((events[0] as ClosureEvent & PlannedClosure).end, '2026-12-12T04:00:00');
  // The shift pattern is not part of the archive - see `PlannedClosure`.
  assert.ok(!('windows' in events[0]));
});

test('an unchanged closure is not logged again', () => {
  const seen = replayLog(diffAgainstLog(new Map(), [closure()], '2026-08-22', WINDOW));
  assert.deepEqual(diffAgainstLog(seen, [closure()], '2026-08-23', WINDOW), []);
});

test('a closure whose end date moves is logged as a revision, old and new', () => {
  const seen = replayLog(diffAgainstLog(new Map(), [closure()], '2026-08-22', WINDOW));
  const moved = closure({ end: '2027-03-14T04:00:00' });
  const events = diffAgainstLog(seen, [moved], '2026-08-23', WINDOW);

  assert.equal(events.length, 1);
  assert.equal(events[0].e, 'revised');
  assert.deepEqual((events[0] as { was: Partial<PlannedClosure> }).was, {
    end: '2026-12-12T04:00:00',
  });
  assert.deepEqual((events[0] as { now: Partial<PlannedClosure> }).now, {
    end: '2027-03-14T04:00:00',
  });

  // Replaying reaches the new state, and remembers what was first planned.
  const after = replayLog([
    ...diffAgainstLog(new Map(), [closure()], '2026-08-22', WINDOW),
    ...events,
  ]).get('ABC.1')!;
  assert.equal(after.current.end, '2027-03-14T04:00:00');
  assert.equal(after.firstEnd, '2026-12-12T04:00:00');
  assert.equal(after.revisions, 1);
  assert.equal(after.since, '2026-08-22');
});

test('a closure that vanishes from a window its dates fall in is withdrawn', () => {
  const seen = replayLog(diffAgainstLog(new Map(), [closure()], '2026-08-22', WINDOW));
  const events = diffAgainstLog(seen, [], '2026-08-23', WINDOW);
  assert.deepEqual(events, [{ t: '2026-08-23', e: 'withdrawn', id: 'ABC.1' }]);
});

test('a closure outside the queried window is not withdrawn for being absent', () => {
  // The whole failure mode this guards: the window slides forward each day, and
  // anything it has moved past would otherwise be reported as cancelled.
  const seen = replayLog(diffAgainstLog(new Map(), [closure()], '2026-08-22', WINDOW));
  const later = { from: '2027-01-01', to: '2027-01-15' };
  assert.deepEqual(diffAgainstLog(seen, [], '2027-01-01', later), []);
});

test('a withdrawn closure is not withdrawn twice, and its return is recorded', () => {
  let log: ClosureEvent[] = diffAgainstLog(new Map(), [closure()], '2026-08-22', WINDOW);
  log = [...log, ...diffAgainstLog(replayLog(log), [], '2026-08-23', WINDOW)];
  assert.deepEqual(diffAgainstLog(replayLog(log), [], '2026-08-24', WINDOW), []);

  const back = diffAgainstLog(replayLog(log), [closure()], '2026-08-25', WINDOW);
  assert.equal(back.length, 1);
  assert.equal(back[0].e, 'revised');
  assert.equal(replayLog([...log, ...back]).get('ABC.1')!.withdrawn, false);
});

test('replaying an empty log yields no state', () => {
  assert.equal(replayLog([]).size, 0);
});

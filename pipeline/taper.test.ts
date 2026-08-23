/**
 * The taper approximates a slot change as a staircase of short constant-offset
 * sub-features rather than baking a diagonal into the coordinates, because
 * `line-offset` is constant along a feature and its rendered displacement is
 * zoom-dependent - see pipeline/lib/taper.ts.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slotOffset, taperLengthM, taperMinzoom, chainLengthM, trimEnd, splitByLength, buildTaper,
  TAPER_STEPS, type Coord,
} from './lib/taper.ts';

/** Metres, at Braunschweig's latitude, as a longitude/latitude delta. */
const M_LAT = 1 / 111320;
const M_LON = M_LAT / Math.cos((52.26 * Math.PI) / 180);

/** A straight chain running east from (x, y) for `len` metres. */
function eastward(x: number, y: number, len: number): Coord[] {
  return [[x, y], [x + len * M_LON, y]];
}

test('slotOffset spaces a bundle one pitch apart, whatever its size', () => {
  for (let n = 1; n <= 12; n++) {
    const offsets = Array.from({ length: n }, (_, i) => slotOffset(i, n));
    for (let i = 1; i < n; i++) {
      assert.equal(offsets[i] - offsets[i - 1], 1, `n=${n} i=${i}`);
    }
  }
});

test('slotOffset is closed under negation, so a flipped stretch lands on itself', () => {
  // The invariant the whole lattice exists for. `line-offset` is signed
  // relative to a feature's direction of travel and chainWays orients each
  // segment independently, so the same physical band is +s in one stretch and
  // -s in the next. Negating the set has to give the set back, or a corridor
  // stitched both ways steps sideways at the seam and a station mark laid
  // across it spans the wrong number of bands.
  for (let n = 1; n <= 12; n++) {
    const offsets = Array.from({ length: n }, (_, i) => slotOffset(i, n));
    // `o === 0 ? 0 : -o` because negating zero gives -0, which deepEqual
    // treats as a different value from 0.
    const mirrored = offsets.map((o) => (o === 0 ? 0 : -o)).sort((a, b) => a - b);
    assert.deepEqual(mirrored, [...offsets].sort((a, b) => a - b), `n=${n}`);
  }
});

test('slotOffset centres every bundle on the true alignment', () => {
  for (let n = 1; n <= 12; n++) {
    const offsets = Array.from({ length: n }, (_, i) => slotOffset(i, n));
    const mean = offsets.reduce((a, b) => a + b, 0) / n;
    assert.equal(mean, 0, `n=${n}`);
  }
});

test('slotOffset puts an even-sized bundle on half pitches, an odd one on whole', () => {
  // Not a defect to be flattened onto whole numbers: an even bundle has no
  // whole-pitch slot at its centre, and rounding it onto one is what breaks
  // the negation invariant above.
  for (const n of [2, 4, 6]) {
    for (let i = 0; i < n; i++) {
      assert.ok(!Number.isInteger(slotOffset(i, n)), `n=${n} i=${i}`);
    }
  }
  for (const n of [1, 3, 5]) {
    for (let i = 0; i < n; i++) {
      assert.ok(Number.isInteger(slotOffset(i, n)), `n=${n} i=${i}`);
    }
  }
});

test('taperLengthM is 40m for tram and 80m for everything else', () => {
  assert.equal(taperLengthM('tram'), 40);
  for (const mode of ['subway', 'suburban', 'regional', 'longdistance'] as const) {
    assert.equal(taperLengthM(mode), 80);
  }
});

test('taperMinzoom matches the pixel arithmetic for both taper lengths', () => {
  // At ~51 degrees latitude, a 40 m (tram) taper crosses one pixel between
  // z11 (sub-pixel) and z12 (~1.7 px); an 80 m taper between z10 and z11.
  assert.equal(taperMinzoom(40), 12);
  assert.equal(taperMinzoom(80), 11);
});

test('taperMinzoom is monotonically stricter for a shorter taper', () => {
  // A shorter taper is sub-pixel for longer (down to a lower zoom), so it
  // needs a higher minzoom before it is worth drawing.
  assert.ok(taperMinzoom(40) > taperMinzoom(80));
});

test('chainLengthM sums a straight chain', () => {
  assert.ok(Math.abs(chainLengthM(eastward(10.52, 52.26, 500)) - 500) < 0.5);
});

test('trimEnd cuts the requested length off the start', () => {
  const chain = eastward(10.52, 52.26, 500);
  const trim = trimEnd(chain, 120, true)!;
  assert.ok(Math.abs(chainLengthM(trim.cut) - 120) < 0.5);
  assert.ok(Math.abs(chainLengthM(trim.kept) - 380) < 0.5);
  // cut runs from the original start...
  assert.deepEqual(trim.cut[0], chain[0]);
  // ...to where kept picks up.
  assert.deepEqual(trim.cut[trim.cut.length - 1], trim.kept[0]);
});

test('trimEnd cuts the requested length off the end', () => {
  const chain = eastward(10.52, 52.26, 500);
  const trim = trimEnd(chain, 120, false)!;
  assert.ok(Math.abs(chainLengthM(trim.cut) - 120) < 0.5);
  assert.ok(Math.abs(chainLengthM(trim.kept) - 380) < 0.5);
  // cut runs up to the original end...
  assert.deepEqual(trim.cut[trim.cut.length - 1], chain[chain.length - 1]);
  // ...starting where kept leaves off.
  assert.deepEqual(trim.cut[0], trim.kept[trim.kept.length - 1]);
});

test('trimEnd refuses a chain shorter than the cut', () => {
  const chain = eastward(10.52, 52.26, 50);
  assert.equal(trimEnd(chain, 120, true), null);
  assert.equal(trimEnd(chain, 120, false), null);
});

test('trimEnd refuses a degenerate chain', () => {
  assert.equal(trimEnd([[10.52, 52.26]], 10, true), null);
  assert.equal(trimEnd([], 10, true), null);
});

test('splitByLength returns the requested number of roughly equal pieces', () => {
  const path = eastward(10.52, 52.26, 200);
  const pieces = splitByLength(path, 5);
  assert.equal(pieces.length, 5);
  for (const piece of pieces) {
    assert.ok(Math.abs(chainLengthM(piece) - 40) < 0.5);
  }
});

test('splitByLength keeps consecutive pieces touching', () => {
  const path = eastward(10.52, 52.26, 200);
  const pieces = splitByLength(path, 5);
  for (let k = 1; k < pieces.length; k++) {
    assert.deepEqual(pieces[k - 1][pieces[k - 1].length - 1], pieces[k][0]);
  }
});

test('splitByLength subdivides a path with far fewer vertices than parts', () => {
  // Two-point straight chains are the common case at a junction: the whole
  // taper length is one segment on each side.
  const pieces = splitByLength(eastward(10.52, 52.26, 80), 5);
  assert.equal(pieces.length, 5);
});

test('buildTaper steps the offset from upstream to downstream', () => {
  // upChain ends at the junction, downChain starts there - as chainWays would
  // hand back a segment on each side of a bundle-membership change.
  const upChain = eastward(10.52, 52.26, 200);
  const downChain = eastward(10.52 + 200 * M_LON, 52.26, 200);
  const steps = buildTaper(upChain, downChain, -1, 2, 80)!;
  assert.equal(steps.length, TAPER_STEPS);
  // Monotonic from just above -1 towards just below 2.
  for (let k = 1; k < steps.length; k++) assert.ok(steps[k].offset > steps[k - 1].offset);
  assert.ok(steps[0].offset > -1 && steps[0].offset < 2);
  assert.ok(steps[steps.length - 1].offset > -1 && steps[steps.length - 1].offset < 2);
});

test('buildTaper geometry is continuous through the junction', () => {
  const upChain = eastward(10.52, 52.26, 200);
  const downChain = eastward(10.52 + 200 * M_LON, 52.26, 200);
  const steps = buildTaper(upChain, downChain, 0, 1, 80)!;
  for (let k = 1; k < steps.length; k++) {
    assert.deepEqual(steps[k - 1].coords[steps[k - 1].coords.length - 1], steps[k].coords[0]);
  }
  // The staircase starts near the up chain and ends near the down chain,
  // spanning the trimmed L metres either side of the junction.
  const junction = upChain[upChain.length - 1];
  const firstPoint = steps[0].coords[0];
  const lastPoint = steps[steps.length - 1].coords[steps[steps.length - 1].coords.length - 1];
  assert.ok(Math.abs(chainLengthM([firstPoint, junction]) - 40) < 0.5);
  assert.ok(Math.abs(chainLengthM([junction, lastPoint]) - 40) < 0.5);
});

test('buildTaper skips when a chain is shorter than L', () => {
  const short = eastward(10.52, 52.26, 30);
  const long = eastward(10.52 + 30 * M_LON, 52.26, 200);
  assert.equal(buildTaper(short, long, 0, 1, 80), null);
  assert.equal(buildTaper(long, short, 0, 1, 80), null);
});

test('buildTaper is a no-op in effect when slots already match', () => {
  const upChain = eastward(10.52, 52.26, 200);
  const downChain = eastward(10.52 + 200 * M_LON, 52.26, 200);
  const steps = buildTaper(upChain, downChain, 1, 1, 80)!;
  for (const step of steps) assert.equal(step.offset, 1);
});

test('buildTaper nudges a step off an integer slot on an even delta', () => {
  // The case that was broken: TAPER_STEPS=3, delta=2 (even) puts the middle
  // step (k=1) exactly at slotUp + delta/2 = an integer strictly between
  // slotUp and slotDown - the same lattice an unrelated line could rest on.
  const upChain = eastward(10.52, 52.26, 200);
  const downChain = eastward(10.52 + 200 * M_LON, 52.26, 200);
  const steps = buildTaper(upChain, downChain, 0, 2, 80, 3)!;
  assert.equal(steps.length, 3);
  for (const step of steps) assert.ok(!Number.isInteger(step.offset), `offset ${step.offset} is an integer`);
  // Still monotonic and still bounded by the endpoints.
  for (let k = 1; k < steps.length; k++) assert.ok(steps[k].offset > steps[k - 1].offset);
  assert.ok(steps[0].offset > 0 && steps[steps.length - 1].offset < 2);
});

test('buildTaper nudge does not touch an odd-delta ramp', () => {
  // Odd delta never lands a step exactly on an integer with an odd step
  // count in the first place, so nothing here should be nudged away from
  // the plain midpoint formula.
  const upChain = eastward(10.52, 52.26, 200);
  const downChain = eastward(10.52 + 200 * M_LON, 52.26, 200);
  const steps = buildTaper(upChain, downChain, 0, 3, 80, 3)!;
  const expected = [0 + 3 * (0.5 / 3), 0 + 3 * (1.5 / 3), 0 + 3 * (2.5 / 3)];
  steps.forEach((step, k) => assert.equal(step.offset, expected[k]));
});

test('buildTaper nudge keeps the ramp monotonic across a run of even deltas', () => {
  // A wider bundle jump with more steps, so several steps could in principle
  // land on an integer at once - the nudge must still keep every step in
  // strictly increasing order.
  const upChain = eastward(10.52, 52.26, 200);
  const downChain = eastward(10.52 + 200 * M_LON, 52.26, 200);
  const steps = buildTaper(upChain, downChain, -4, 6, 80, 5)!;
  for (const step of steps) assert.ok(!Number.isInteger(step.offset), `offset ${step.offset} is an integer`);
  for (let k = 1; k < steps.length; k++) assert.ok(steps[k].offset > steps[k - 1].offset);
  assert.ok(steps[0].offset > -4 && steps[steps.length - 1].offset < 6);
});

test('buildTaper never nudges onto slotUp or slotDown themselves', () => {
  // The endpoints are owned by the trimmed parent features, not by any step,
  // and must stay exact - the nudge must never manufacture a step sitting
  // exactly on slotUp or slotDown either.
  const upChain = eastward(10.52, 52.26, 200);
  const downChain = eastward(10.52 + 200 * M_LON, 52.26, 200);
  const steps = buildTaper(upChain, downChain, 0, 2, 80, 3)!;
  for (const step of steps) {
    assert.notEqual(step.offset, 0);
    assert.notEqual(step.offset, 2);
  }
});

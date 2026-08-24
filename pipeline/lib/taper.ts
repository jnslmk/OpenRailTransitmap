/**
 * Smoothing a slot change where two bundle segments meet.
 *
 * `offset` is assigned per bundle segment from local membership, so the same
 * logical line commonly lands on a different slot in the segment on each side
 * of a junction, and the two chains just butt together - the line appears to
 * jump sideways. MapLibre's `line-offset` is constant along a feature and the
 * rendered displacement is zoom-dependent (see `bandOffset` in src/style.ts),
 * so the jump cannot be smoothed by baking a diagonal into the coordinates:
 * geometry baked at one zoom would sit at the wrong place at every other zoom.
 * Instead the jump is approximated as a STAIRCASE of short sub-features, each
 * an ordinary constant-`offset` feature, stepping from the upstream slot to
 * the downstream slot. Every sub-feature scales through the same zoom
 * expression as everything else, so the staircase stays correct at all zooms.
 *
 * `slotOffset` also lives here, rather than inline in build.ts, because the
 * taper has to interpolate between the same slot values it produces.
 */

import type { Mode } from '../../shared/lnvg.ts';
import { metres, type Coord } from './track.ts';

export type { Coord };

/** Total length of a chain, in metres. */
export function chainLengthM(chain: Coord[]): number {
  let sum = 0;
  for (let i = 1; i < chain.length; i++) sum += metres(chain[i - 1], chain[i]);
  return sum;
}

/**
 * Perpendicular slot ordinal for band `i` of an `n`-line bundle, centred so
 * the bundle straddles the true alignment. Even-sized bundles therefore sit on
 * half-pitch values.
 *
 * Centred rather than floored onto whole numbers, and the symmetry is the
 * point rather than a preference. `line-offset` is signed relative to a
 * feature's own direction of travel, so one physical band is `+s` read one way
 * and `-s` read the other. Only a lattice closed under negation renders the
 * same either way: a floored one is not - a two-line bundle is {0, 1} forward
 * and {0, -1} reversed - so a stretch read backwards steps a whole band
 * sideways, and a station mark laid across it spans three bands where it
 * should span two.
 *
 * Directions are agreed before slots are assigned now (lib/orient.ts), so that
 * is a backstop rather than the daily case: it covers the chains no set of
 * junction constraints could reconcile, where a stretch still ends up read
 * against its neighbours.
 *
 * Centring does tie a slot to the size of the bundle it centres, so a line
 * joining or leaving flips the parity and slides every band half a pitch -
 * the slide the lattice was once floored onto whole numbers to avoid. That
 * floor is not the answer: it broke the negation invariant above, which is
 * wrong at every seam rather than merely fussy, and it bought its stability
 * with the same trick corridor-wide ranking later did - moving the problem
 * rather than drawing it. Half a pitch is the smallest move the taper below
 * ever ramps, and it ramps it like any other.
 */
export function slotOffset(i: number, n: number): number {
  return i - (n - 1) / 2;
}

/**
 * How much of a line's chain is sacrificed to the taper on each side of a
 * slot-changing junction - the staircase spans `L` metres in total, half from
 * each side. Trams run tight, low-speed corridors where junctions come every
 * block, so a wide taper would visibly eat into the next one; every other
 * mode moves fast enough, and its junctions sit far enough apart, to afford
 * double the room.
 *
 * These are the length of a *one pitch* ramp. Slots are compacted per bundle
 * segment, so a line whose inboard neighbours leave together moves several
 * bands at once, and a fixed length would ramp a four-band move over the same
 * ground as a one-band move - the wider the move, the steeper the diagonal,
 * until it reads as the hard step the taper exists to remove. Length scales
 * with the move so the ramp holds roughly one angle whatever it spans.
 */
const TRAM_TAPER_M = 40;
const OTHER_TAPER_M = 80;

/**
 * Ceiling on that scaling, in pitches. A wide move is nearly always a line
 * merging into or out of a busy corridor, which is exactly where junctions
 * come thickest: past three pitches the ramp is long enough to reach the next
 * junction, and `fitTaperLength` would only claw it back again. Better to
 * accept a slightly steeper diagonal on the rare very wide move than to ask
 * for room that is not there.
 */
const MAX_TAPER_PITCHES = 3;

export function taperLengthM(mode: Mode, slotDelta = 1): number {
  const perPitch = mode === 'tram' ? TRAM_TAPER_M : OTHER_TAPER_M;
  const pitches = Math.min(Math.max(Math.abs(slotDelta), 1), MAX_TAPER_PITCHES);
  return perPitch * pitches;
}

/**
 * The most of its own chain either side may spend on its half of one taper.
 *
 * A chain has two ends and can be tapered at both, so anything above a half
 * lets two junctions ask for more than the chain has between them - which is
 * what the trim-collision check in build.ts exists to catch. At 0.4 the two
 * halves come to at most 0.8 of the chain, so the collision is impossible by
 * construction rather than caught afterwards, and what is left in the middle
 * is still the majority of the chain, drawn at its own slot.
 */
const MAX_CHAIN_SHARE = 0.4;

/**
 * Shortest ramp worth drawing. The tiles stop at z13, where a metre is about
 * a twelfth of a pixel, so below this the staircase - and equally the hard
 * step it would replace - is under one pixel at every zoom that ships. There
 * is nothing to smooth at that size.
 */
const MIN_TAPER_M = 12;

/**
 * The ramp length a junction can actually afford: what it asked for, or as
 * much of it as the shorter of the two chains can give up, whichever is less.
 * Returns 0 when even that is too short to draw, and the caller should leave
 * the hard step alone.
 *
 * Fitting rather than refusing is the point. `buildTaper` used to want both
 * chains at least a full `L` long and gave up otherwise, which cost a ramp at
 * thousands of junctions - and a skipped ramp is precisely the sideways jump
 * this module exists to remove. A short chain does not need the full 80 m to
 * read as a diagonal; it needs a diagonal that fits.
 */
export function fitTaperLength(upM: number, downM: number, wantM: number): number {
  const afford = 2 * MAX_CHAIN_SHARE * Math.min(upM, downM);
  const fitted = Math.min(wantM, afford);
  return fitted >= MIN_TAPER_M ? fitted : 0;
}

/**
 * The zoom below which a taper of `lengthM` metres is sub-pixel, so both the
 * ramp and the gap it would leave if tippecanoe dropped it are themselves
 * invisible - there is nothing lost by not shipping it to that zoom, and it
 * is one less feature competing for room in the tiles that are already
 * densest. Web Mercator resolution is `156543.03392 * cos(lat) / 2^z` m/px;
 * solved for the zoom at which `lengthM` crosses one pixel, at Germany's
 * roughly 51 degrees of latitude. Rounded up, so the taper only ships once
 * it is unambiguously above a pixel rather than right on the edge.
 */
const MERCATOR_M_PER_PX_AT_EQUATOR_Z0 = 156543.03392;
const REFERENCE_LAT_DEG = 51;

export function taperMinzoom(lengthM: number): number {
  const mPerPxAtZ0 =
    MERCATOR_M_PER_PX_AT_EQUATOR_Z0 * Math.cos((REFERENCE_LAT_DEG * Math.PI) / 180);
  return Math.ceil(Math.log2(mPerPxAtZ0 / lengthM));
}

/**
 * How many steps approximate one taper's ramp. Even at the tile build's own
 * maximum zoom (13), the longer (80 m, non-tram) taper is only ~6.6 px end to
 * end, and the shorter (40 m, tram) one ~3.3 px - both below `taperMinzoom`
 * at every zoom below that, where they are not drawn at all. Five steps
 * across a handful of pixels resolves finer than the display can show and
 * multiplies the feature count for comparatively little visible gain; three
 * is enough to read as a diagonal rather than a single hard step, at a
 * noticeably lower tiling cost.
 */
export const TAPER_STEPS = 3;

/**
 * Widest sideways move one step may make, in pitches.
 *
 * Three steps is enough for the one- and two-pitch moves that make up almost
 * every junction, but it is a step *count*, not a step *size*: spread over a
 * six-pitch move the same three steps jump two bands each, and the staircase
 * reads as three hard steps instead of one. Holding the step size instead
 * keeps the tread-to-riser ratio roughly constant, so a wide ramp looks like
 * a long diagonal rather than a coarser one. Three quarters of a pitch keeps
 * every riser below a band's width.
 */
const MAX_STEP_PITCH = 0.75;

/**
 * Hard cap on the step count. A ramp is a handful of pixels end to end even
 * at z13, so past this the extra features resolve finer than the display can
 * show; the very widest moves accept a slightly coarser stair instead.
 */
const MAX_TAPER_STEPS = 8;

/** How many steps a `slotDelta`-pitch move gets. */
export function taperSteps(slotDelta: number): number {
  const wanted = Math.ceil(Math.abs(slotDelta) / MAX_STEP_PITCH);
  return Math.min(MAX_TAPER_STEPS, Math.max(TAPER_STEPS, wanted));
}

export interface Trim {
  /** The chain with the cut stretch removed, in the original vertex order. */
  kept: Coord[];
  /** The removed stretch, in the original vertex order. */
  cut: Coord[];
}

/**
 * Cut `m` metres off one end of a chain. `fromStart` selects which end: the
 * removed stretch always keeps the chain's own vertex order, so `cut` runs
 * away from the cut chain's start when `fromStart` is true, and towards the
 * cut chain's end when it is false - in both cases, from the middle of the
 * original chain out towards whichever end was trimmed.
 *
 * Returns null when the chain has fewer than 2 points or is shorter than `m`
 * - there is nothing sensible to cut, and the caller is expected to leave the
 * chain untouched rather than emit broken geometry.
 */
export function trimEnd(chain: Coord[], m: number, fromStart: boolean): Trim | null {
  if (chain.length < 2) return null;
  // Walking from the end we are cutting turns both directions into the same
  // "cut off the front" problem; the result is flipped back at the end.
  const ordered = fromStart ? chain : [...chain].reverse();

  let acc = 0;
  let cutPoint: Coord | null = null;
  let cutIdx = -1;
  for (let i = 1; i < ordered.length; i++) {
    const d = metres(ordered[i - 1], ordered[i]);
    if (acc + d >= m) {
      const t = d === 0 ? 0 : (m - acc) / d;
      cutPoint = [
        ordered[i - 1][0] + (ordered[i][0] - ordered[i - 1][0]) * t,
        ordered[i - 1][1] + (ordered[i][1] - ordered[i - 1][1]) * t,
      ];
      cutIdx = i;
      break;
    }
    acc += d;
  }
  if (!cutPoint) return null; // chain shorter than m

  const removed = [...ordered.slice(0, cutIdx), cutPoint];
  const remainder = [cutPoint, ...ordered.slice(cutIdx)];

  return fromStart
    ? { cut: removed, kept: remainder }
    : { cut: [...removed].reverse(), kept: [...remainder].reverse() };
}

/**
 * Split a path into `parts` pieces of roughly equal length, cutting new
 * vertices in where a split falls mid-segment so consecutive pieces still
 * share an endpoint and the staircase has no visible gap.
 */
export function splitByLength(path: Coord[], parts: number): Coord[][] {
  if (parts <= 1 || path.length < 2) return [path];
  const target = chainLengthM(path) / parts;

  const out: Coord[][] = [];
  let current: Coord[] = [path[0]];
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    let a = path[i - 1];
    const b = path[i];
    let segLen = metres(a, b);
    // A single long segment can cross several split points at once.
    while (out.length < parts - 1 && acc + segLen >= target) {
      const t = segLen === 0 ? 0 : (target - acc) / segLen;
      const cut: Coord = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      current.push(cut);
      out.push(current);
      current = [cut];
      a = cut;
      segLen = metres(a, b);
      acc = 0;
    }
    current.push(b);
    acc += segLen;
  }
  out.push(current);
  return out;
}

export interface TaperStep {
  coords: Coord[];
  offset: number;
}

/**
 * How far a step is pushed off an occupied slot, in pitches.
 *
 * Fixed in pitches rather than as a fraction of one step, which is what makes
 * it safe: a whole number of pitches is exactly what "occupied" means, and the
 * two lattices in play are one pitch apart and offset from each other by 0 or
 * half a pitch, so 0.2 can never itself land on either. A fraction of a step
 * could - with three steps and a fifteen-slot jump, a fifth of a step is
 * exactly one pitch, and the nudge would move the step onto the next occupied
 * slot instead of off one.
 */
const NUDGE_PITCH = 0.2;

/**
 * Whether `v` sits exactly on a slot another line rests at, strictly between
 * the two ends of the ramp.
 *
 * A bundle's slots are its line ranking centred, so they lie one pitch apart
 * and every one of them shares the fractional part of any other. That makes
 * "is this an occupied slot" a question about the distance to an endpoint
 * being a whole number, not about the value being a whole number - the two
 * only coincide when the lattice happens to be integral. Both ends are
 * checked because a taper fires precisely where two segments disagree, and
 * two bundles of different size sit on lattices half a pitch apart: the
 * everyday case now that slots are compacted per segment, since a line
 * joining or leaving changes the count the lattice is centred on.
 */
export function onOccupiedSlot(v: number, slotUp: number, slotDown: number): boolean {
  const lo = Math.min(slotUp, slotDown);
  const hi = Math.max(slotUp, slotDown);
  if (!(v > lo && v < hi)) return false;
  const onLattice = (anchorSlot: number) => {
    const d = v - anchorSlot;
    return Math.abs(d - Math.round(d)) < 1e-9;
  };
  return onLattice(slotUp) || onLattice(slotDown);
}

/**
 * Build the staircase that replaces a hard slot jump at a junction.
 *
 * `upChain` must end at the junction and `downChain` must start there - i.e.
 * the caller has already worked out which segment is upstream, rather than
 * this function guessing from geometry. `slotUp`/`slotDown` are that line's
 * `slotOffset` in each segment.
 *
 * `lengthM` is expected to have been through `fitTaperLength` already, which
 * is what decides how much of these two chains the ramp may spend. The check
 * below is a backstop for a caller that did not: it returns null - leave the
 * hard jump alone - when either chain is shorter than `lengthM`, since there
 * is then not enough of the line's own chain to trim without eating into
 * whatever lies beyond it, e.g. another junction close by. A fitted length
 * clears it with room to spare, by construction.
 */
export function buildTaper(
  upChain: Coord[],
  downChain: Coord[],
  slotUp: number,
  slotDown: number,
  lengthM: number,
  steps: number = TAPER_STEPS,
): TaperStep[] | null {
  if (chainLengthM(upChain) < lengthM || chainLengthM(downChain) < lengthM) return null;

  const half = lengthM / 2;
  const cutUp = trimEnd(upChain, half, false);
  const cutDown = trimEnd(downChain, half, true);
  if (!cutUp || !cutDown) return null; // defensive: the length check above should prevent this

  // cutUp.cut runs up to the junction; cutDown.cut runs on from it - drop the
  // duplicate junction point where they meet.
  const path = cutUp.cut.concat(cutDown.cut.slice(1));
  const pieces = splitByLength(path, steps);

  const step = (slotDown - slotUp) / pieces.length; // one step's span, signed

  return pieces.map((coords, k) => {
    // Midpoint of each step's span, so the staircase is centred on the
    // straight-line ramp from slotUp to slotDown rather than trailing it.
    let offset = slotUp + step * (k + 0.5);

    // With an odd step count, a step can land exactly on an occupied slot
    // strictly between slotUp and slotDown - most commonly the middle step,
    // at exactly the halfway mark, whenever the jump spans an even number of
    // pitches. That slot is, by construction, one some other line in this
    // bundle rests at for the length of the taper; an un-nudged step would
    // then run pixel-exact collinear with that line's own band. Measured on
    // a national rebuild: low thousands of steps a build, not a theoretical
    // case (see the counter in build.ts).
    //
    // Nudge a fifth of a pitch further along the ramp direction. That
    // guarantees only that no step's offset can still equal an occupied
    // slot afterwards - pixel-exact coincidence, the actual
    // pathology this exists to stop. It is NOT enough to buy visible
    // separation - for the common |slotDown - slotUp| = 2 case the nudge is
    // roughly 13-14% of a band's width on screen, so the step still passes
    // close beside the occupied band rather than clearing it by an
    // eye-catching margin. That residual near-overlap is expected, not a
    // defect to chase with a bigger nudge: a ramp spanning a bundle
    // necessarily crosses every intermediate line's band on the way from
    // slotUp to slotDown - that crossing *is* what a merge looks like - and
    // its extent is bounded by one step's length, a fraction of a pixel at
    // the zooms this taper is even drawn at. A larger nudge would distort
    // the ramp to chase that instead of just clearing the exact-coincidence
    // case.
    //
    // Small enough that it can never push a step's offset past its
    // neighbour's: adjacent steps sit |step| >= 1/3 of a pitch apart at the
    // tightest (a one-pitch jump over three steps), so shifting one by 0.2
    // of a pitch leaves the gap positive and keeps the sign of `step`, and
    // the ramp stays monotonic. slotUp and slotDown themselves are never touched here -
    // they belong to the trimmed parent features, not to any step - so the
    // endpoints stay exact.
    if (onOccupiedSlot(offset, slotUp, slotDown)) offset += NUDGE_PITCH * Math.sign(step);

    return { coords, offset };
  });
}

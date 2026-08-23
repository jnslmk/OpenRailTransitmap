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
 * feature's own direction of travel, so one physical band is `+s` in a stretch
 * stitched one way and `-s` in a stretch stitched the other, and `chainWays`
 * orients each segment independently. Only a lattice closed under negation
 * renders the same either way: a floored one is not - a two-line bundle is
 * {0, 1} forward and {0, -1} reversed - so a corridor stitched both ways would
 * step a whole band sideways at the seam, and a station mark laid across it
 * would span three bands where it should span two.
 *
 * The parity slide this was once floored to avoid is not a reason to give that
 * up: it came from re-indexing a line per segment, and slots are ranked per
 * corridor now (lib/corridor.ts), so it cannot arise.
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
 */
const TRAM_TAPER_M = 40;
const OTHER_TAPER_M = 80;

export function taperLengthM(mode: Mode): number {
  return mode === 'tram' ? TRAM_TAPER_M : OTHER_TAPER_M;
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
  const mPerPxAtZ0 = MERCATOR_M_PER_PX_AT_EQUATOR_Z0 * Math.cos((REFERENCE_LAT_DEG * Math.PI) / 180);
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
 * A corridor's slots are its line ranking centred, so they lie one pitch apart
 * and every one of them shares the fractional part of any other. That makes
 * "is this an occupied slot" a question about the distance to an endpoint
 * being a whole number, not about the value being a whole number - the two
 * only coincide when the lattice happens to be integral. Both ends are
 * checked because a taper fires precisely where two segments disagree, which
 * under corridor-wide ranking means they belong to different corridors, whose
 * lattices can differ by half a pitch.
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
 * Returns null - leave the hard jump alone - when either chain is shorter
 * than `lengthM`: there is not enough of the line's own chain to trim without
 * eating into whatever lies beyond it, e.g. another junction close by.
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

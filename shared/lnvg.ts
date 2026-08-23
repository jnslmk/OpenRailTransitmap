/**
 * Design tokens extracted from the reference document:
 * "Streckenfahrplan LNVG Niedersachsen 2025" (1190.552 x 1133.858 pt).
 *
 * Colours were read directly from the PDF's `scn` colour operators and line
 * weights from its `w` operators, so these are the source document's actual
 * values rather than an approximation.
 */

/** The 13 colours used by the reference map. */
export const LNVG = {
  // Line colours
  darkBlue: '#014895',
  blue: '#0069b4',
  lightBlue: '#87b6dd',
  red: '#e30513', // DB red - long-distance spines
  teal: '#00887d',
  green: '#4b8f46',
  purple: '#951b81',
  yellow: '#fed060',
  paleYellow: '#ffe496',

  // Ground / basemap
  paleBlue: '#c8dcf3', // water
  ground: '#f2f2f2', // land
  grey: '#dadad9', // borders, disused
  white: '#ffffff',
} as const;

/**
 * Deterministic fallback palette for lines with no OSM `colour` tag.
 * Ordered so that adjacent hashes land on visually distinct hues.
 */
export const FALLBACK_PALETTE: readonly string[] = [
  LNVG.darkBlue,
  LNVG.teal,
  LNVG.purple,
  LNVG.green,
  LNVG.blue,
  LNVG.red,
  LNVG.yellow,
  LNVG.lightBlue,
];

/**
 * FlixBus green, the one colour the coach feed publishes - every route in it
 * carries `73D700`. Deliberately *not* in the `LNVG` block above, which is the
 * reference document's own palette read out of its colour operators; this is an
 * operator's brand colour arriving with the data, the same way an OSM `colour`
 * tag does, and it is kept verbatim for the same reason.
 */
export const COACH_GREEN = '#73d700';

/**
 * Mode categories. These are the user-selectable layers, and they drive the
 * three-step line-weight hierarchy of the reference map (2.24 / 2.80 / 3.36 pt).
 *
 * `coach` is the one mode the reference document has no equivalent for, because
 * a Streckenfahrplan is a rail document. It is included because long-distance
 * coach is how a large part of Germany actually travels between cities, and
 * because leaving it out would make the journey planner offer itineraries the
 * map cannot draw. It sits at the bottom of the draw order and on the thinnest
 * weight: rail is the subject here, and coach is how you reach it.
 */
export type Mode = 'longdistance' | 'regional' | 'suburban' | 'subway' | 'tram' | 'coach';

export const MODES: readonly Mode[] = [
  'longdistance',
  'regional',
  'suburban',
  'subway',
  'tram',
  'coach',
];

export interface ModeSpec {
  /** Reference line weight in points. */
  weightPt: number;
  /** Lowest zoom at which this mode is drawn (keeps the urban layers affordable). */
  minzoom: number;
  /** Colour used when a line carries no OSM `colour` tag and no override. */
  defaultColour: string;
  /** Draw order - higher sits on top. */
  order: number;
  /**
   * Dash pattern in line-width units, for a mode that does not run on rails.
   * Solid when absent, which is every mode the reference document draws.
   */
  dash?: readonly [number, number];
}

export const MODE_SPECS: Record<Mode, ModeSpec> = {
  longdistance: { weightPt: 3.364, minzoom: 0, defaultColour: LNVG.red, order: 50 },
  regional: { weightPt: 2.804, minzoom: 6, defaultColour: LNVG.darkBlue, order: 40 },
  suburban: { weightPt: 2.804, minzoom: 7, defaultColour: LNVG.green, order: 30 },
  subway: { weightPt: 2.243, minzoom: 9, defaultColour: LNVG.blue, order: 20 },
  tram: { weightPt: 2.243, minzoom: 10, defaultColour: LNVG.purple, order: 10 },
  // Dashed because it is not a railway, and a coach drawn like a line of route
  // would claim infrastructure that is not there - the same honesty the
  // closure overlay applies when it refuses to chord between operating points.
  coach: {
    weightPt: 2.243,
    minzoom: 5,
    defaultColour: COACH_GREEN,
    order: 5,
    dash: [2.4, 1.6],
  },
};

/** Points -> screen pixels. The reference is a print document; 1pt renders ~1.4px well. */
export const PT_TO_PX = 1.4;

/**
 * Stable hash so a line keeps the same fallback colour across nightly rebuilds.
 * Keyed on network + ref rather than on OSM relation id, which is not stable.
 */
export function fallbackColour(key: string, mode: Mode): string {
  // Long-distance reads as a single family of red spines on the reference map,
  // so it keeps the mode colour rather than getting a per-line hue. Coach is the
  // same case arrived at from the other direction: the feed gives every route
  // one brand colour, so the family *is* the colour and a per-line hue would be
  // this map inventing a distinction the operator does not make.
  if (mode === 'longdistance' || mode === 'coach' || !key) return MODE_SPECS[mode].defaultColour;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return FALLBACK_PALETTE[Math.abs(h) % FALLBACK_PALETTE.length];
}

/**
 * Readable label colour for a badge painted `colour` (a `#rrggbb` value):
 * white on a dark line, near-black on a light one. The threshold is the
 * luminance at which contrast against white and against black is equal, so
 * every badge picks whichever of the two it actually reads better on -
 * needed because line colours span the full range from `#006531` to a pale
 * yellow, and a single hard-coded label colour is unreadable on one end.
 *
 * Deliberately computed rather than taken from a feed's `route_text_color`,
 * which is routinely absent or left at white over a light background.
 */
export function textOn(colour: string): string {
  const channel = (i: number) => {
    const c = parseInt(colour.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.179 ? '#1a1a1a' : '#ffffff';
}

/** Normalise an OSM `colour` value to `#rrggbb`, or null if unusable. */
export function normaliseColour(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v))
    return (
      '#' +
      v
        .slice(1)
        .split('')
        .map((c) => c + c)
        .join('')
    );
  const named: Record<string, string> = {
    red: '#e30513',
    blue: '#0069b4',
    green: '#4b8f46',
    yellow: '#fed060',
    purple: '#951b81',
    violet: '#951b81',
    orange: '#e8720c',
    brown: '#8b5a2b',
    black: '#1a1a1a',
    grey: '#808080',
    gray: '#808080',
    white: '#ffffff',
    magenta: '#e6007e',
    cyan: '#00a5b5',
    pink: '#e6007e',
  };
  return named[v] ?? null;
}

/**
 * One band's pitch in screen pixels at the reference scale (offset factor 1).
 *
 * Every bundled band is one nominal regional weight wide, so mixed-mode bundles
 * stay aligned, and 1.02 leaves a hairline between neighbours. Both the route
 * bands and the station marks that span them measure in this unit, so it lives
 * here rather than in either of them.
 */
export const BUNDLE_PITCH_PX = MODE_SPECS.regional.weightPt * PT_TO_PX * 1.02;

/**
 * Which stops are drawn at which zoom.
 *
 * A geographic map cannot do what the reference poster does - draw every stop
 * at every scale - because at national zoom Germany's 20,830 stations are one
 * grey smear. So stops are ranked once, in the pipeline, and each rank earns
 * its way onto the map at the zoom where there is room for it:
 *
 *   0  long-distance calls and the larger Hauptbahnhöfe - the places a map of
 *      the whole country is *for*. ~400 of them nationally.
 *   1  interchanges: three or more lines, more than one mode, or an Hbf - and
 *      coach stops of their own, which are intercity points and few.
 *   2  every other heavy-rail, S-Bahn and U-Bahn halt.
 *   3  tram-only stops, which outnumber rail stations by an order of magnitude.
 *
 * `mark` is the zoom the symbol appears at, `label` the zoom its name does -
 * always later, because a name costs perhaps ten times the space a mark does.
 * The pipeline writes the same table into the tiles as a per-feature minzoom,
 * so a rank-3 stop is not merely hidden at z8, it is not in the tile at all.
 */
export interface StopTier {
  rank: number;
  mark: number;
  label: number;
}

export const STOP_TIERS: readonly StopTier[] = [
  { rank: 0, mark: 6, label: 8 },
  { rank: 1, mark: 9, label: 10 },
  { rank: 2, mark: 11, label: 12 },
  { rank: 3, mark: 12, label: 13.5 },
];

/** The tier table keyed by rank, for the pipeline's per-feature minzoom. */
export const STOP_TIER_BY_RANK: Record<number, StopTier> = Object.fromEntries(
  STOP_TIERS.map((t) => [t.rank, t]),
);

/**
 * Which tier a stop belongs to. Deliberately built from what the map already
 * knows - the lines calling and the name - rather than from passenger figures,
 * which OSM does not carry and which no open source publishes for all 5,400
 * German stations.
 *
 * The one name test that earns its place is Hbf: a German Hauptbahnhof is the
 * town's principal station by definition, and a two-line Hbf is still the stop
 * a map of the region should show before the halt one street over.
 */
export function stopRank(modes: readonly Mode[], lineCount: number, major: boolean): number {
  if (modes.length > 0 && modes.every((m) => m === 'tram')) return 3;
  // A coach stop of its own - a ZOB, an airport forecourt - is not a railway
  // station and is not ranked as one. But there are a few hundred of them and
  // every one is an intercity point, so it comes in with the interchanges
  // rather than waiting for the zoom the local halts appear at. It is drawn in
  // the quieter of the two label colours all the same; see `coachOnly`.
  if (modes.length > 0 && modes.every((m) => m === 'coach')) return 1;
  if (modes.includes('longdistance') || (major && lineCount >= 3)) return 0;
  if (lineCount >= 3 || major || modes.length >= 2) return 1;
  return 2;
}

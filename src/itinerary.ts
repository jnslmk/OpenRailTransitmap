import type { Itinerary, Leg, LegPlace } from './routing.ts';

// Okabe–Ito hues, with darker amber for contrast against the white route casing.
// Journey colours are independent of official route identities.
const JOURNEY_COLOURS = ['#0072b2', '#d55e00', '#009e73', '#cc79a7', '#a66f00'];

export type JourneyFocus = { kind: 'leg' | 'change'; index: number } | null;

export interface JourneyLeg {
  leg: Leg;
  index: number;
  number: number | null;
  colour: string;
}

export interface Interchange {
  number: number;
  arrivalIndex: number;
  departureIndex: number;
  connectionIndices: number[];
  arrival: LegPlace;
  departure: LegPlace;
  walkingSeconds: number;
  label: string;
  hasWalking: boolean;
  at: [number, number];
  path: [number, number][];
}

export function journeyView(itinerary: Itinerary): {
  legs: JourneyLeg[];
  interchanges: Interchange[];
} {
  let transitNumber = 0;
  const legs = itinerary.legs.map((leg, index) => {
    const number = leg.transit ? ++transitNumber : null;
    return {
      leg,
      index,
      number,
      colour: number ? JOURNEY_COLOURS[(number - 1) % JOURNEY_COLOURS.length] : '#1a1a1a',
    };
  });
  const interchanges: Interchange[] = [];
  let previous: JourneyLeg | undefined;
  for (const next of legs) {
    if (!next.leg.transit) continue;
    if (previous) {
      const arrival = previous.leg.to;
      const departure = next.leg.from;
      const connections = legs.slice(previous.index + 1, next.index);
      const sameStation =
        arrival.name === departure.name ||
        (!!arrival.stopId && arrival.stopId === departure.stopId);
      interchanges.push({
        number: interchanges.length + 1,
        arrivalIndex: previous.index,
        departureIndex: next.index,
        connectionIndices: connections.map(({ index }) => index),
        arrival,
        departure,
        walkingSeconds: connections.reduce(
          (seconds, { leg }) => seconds + (leg.mode === 'WALK' ? leg.seconds : 0),
          0,
        ),
        hasWalking: connections.some(({ leg }) => leg.mode === 'WALK'),
        label: sameStation ? arrival.name : `${arrival.name} → ${departure.name}`,
        at: [(arrival.lon + departure.lon) / 2, (arrival.lat + departure.lat) / 2],
        path: [
          [arrival.lon, arrival.lat],
          ...connections.flatMap(({ leg }) =>
            leg.path.length
              ? leg.path
              : [
                  [leg.from.lon, leg.from.lat] as [number, number],
                  [leg.to.lon, leg.to.lat] as [number, number],
                ],
          ),
          [departure.lon, departure.lat],
        ],
      });
    }
    previous = next;
  }
  return { legs, interchanges };
}

/** UI strings. The interface is English; station and line names stay German. */

import type { ClosureDirection, ClosureEffect } from '../shared/closures.ts';

export interface Strings {
  search: string;
  noResults: string;
  modes: string;
  longdistance: string;
  regional: string;
  suburban: string;
  subway: string;
  tram: string;
  coach: string;
  operator: string;
  operators: string;
  allOperators: string;
  noOperatorsInView: string;
  stations: string;
  lines: string;
  servedBy: string;
  close: string;
  clearSelection: string;
  network: string;
  legend: string;
  noLinesInView: string;
  stopOne: string;
  stopShared: string;
  stopSkipped: string;
  hideChrome: string;
  showChrome: string;
  collapsePanel: string;
  expandPanel: string;
  panelPeek: string;
  fullscreen: string;
  exitFullscreen: string;
  locate: string;
  locateDenied: string;
  locateError: string;
  zoomIn: string;
  zoomOut: string;
  northUp: string;
  lineCount: (n: number) => string;
  stationCount: (n: number) => string;
  loading: string;
  dataDate: string;
  departures: string;
  loadingDepartures: string;
  departuresUnavailable: string;
  noDepartures: string;
  cancelled: string;
  scheduledOnly: string;
  platform: (n: string) => string;
  liveAttribution: string;
  punctuality: string;
  onTimeShare: string;
  cancelRate: string;
  typicalDelay: string;
  oneInTen: string;
  typicalShort: string;
  p90Short: string;
  byStation: string;
  noPunctuality: string;
  punctualityAttribution: string;
  band: Record<'punctual' | 'slight' | 'late' | 'severe' | 'cancelled', string>;
  punctualityWindow: (months: number, to: string) => string;
  onTimeExplainer: (threshold: number) => string;
  departureCount: (n: number) => string;
  minutesLate: (n: string) => string;
  closures: string;
  showClosures: string;
  closureCount: (n: number) => string;
  noClosuresInView: string;
  closureEffect: Record<ClosureEffect, string>;
  closureDirection: Record<ClosureDirection, string>;
  closureLegendMajor: string;
  closureLegendMinor: string;
  closureWorks: string;
  closureLine: string;
  closureTrack: string;
  closureHours: string;
  closureAllDay: string;
  closureUntil: string;
  closureFrom: string;
  closureAtStation: string;
  closureHistory: string;
  closureSince: string;
  closureExtended: (n: number) => string;
  closureMovedLater: (from: string) => string;
  closureMovedEarlier: (from: string) => string;
  closureNoHistory: string;
  closureAsOf: (day: string) => string;
  closureAttribution: string;
  coachAttribution: string;
  logoAttribution: string;
  buildStamp: (commit: string, when: string) => string;

  // --- journey planner ------------------------------------------------------
  tabExplore: string;
  tabPlan: string;
  planFrom: string;
  planTo: string;
  planSwap: string;
  planUseMap: string;
  planSearching: string;
  planNoPlaces: string;
  planWhen: string;
  planLeaveNow: string;
  planDepartAt: string;
  planArriveBy: string;
  planDate: string;
  planTime: string;
  planModes: string;
  planBike: string;
  planBikeQuestion: string;
  planBikeNone: string;
  planBikeMinutes: (n: number) => string;
  planCarriage: string;
  planCarriageNote: string;
  planSubmit: string;
  planLoading: string;
  planFailed: string;
  planNothing: string;
  planNeedBoth: string;
  planEarlier: string;
  planLater: string;
  planTransfers: (n: number) => string;
  planRiding: (mins: string) => string;
  planWholeWayBike: string;
  planWholeWayWalk: string;
  planStops: (n: number) => string;
  planBikesCarried: string;
  planBikesUnknown: string;
  planReservation: string;
  planCancelled: string;
  planDelayed: (mins: number) => string;
  planWalk: string;
  planBikeLeg: string;
  planPlatform: (n: string) => string;
  planDirectionsFrom: string;
  planDirectionsTo: string;
  planAttribution: string;
}

const STRINGS: Strings = {
  search: 'Search for a line or station…',
  noResults: 'No matches',
  modes: 'Modes',
  longdistance: 'Long-distance',
  regional: 'Regional',
  suburban: 'S-Bahn',
  subway: 'Metro',
  tram: 'Tram',
  coach: 'Long-distance coach',
  operator: 'Operator',
  operators: 'Operators',
  allOperators: 'All operators',
  noOperatorsInView: 'No operators in view',
  stations: 'Stations',
  lines: 'Lines',
  servedBy: 'Lines serving this station',
  close: 'Close',
  clearSelection: 'Clear selection',
  network: 'Network',
  legend: 'Legend',
  noLinesInView: 'No lines in view',
  stopOne: 'Stop, one line',
  stopShared: 'Stop shared by several lines',
  stopSkipped: 'A line running through without stopping',
  hideChrome: 'Hide panel',
  showChrome: 'Show panel',
  collapsePanel: 'Collapse panel',
  expandPanel: 'Expand panel',
  panelPeek: 'Search, filters and lines',
  fullscreen: 'Fullscreen',
  exitFullscreen: 'Exit fullscreen',
  locate: 'Show my location',
  locateDenied: 'Location access denied',
  locateError: 'Location unavailable',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  northUp: 'Reset bearing to north',
  lineCount: (n: number) => `${n} lines`,
  stationCount: (n: number) => `${n} stations`,
  loading: 'Loading map…',
  dataDate: 'Data as of',
  departures: 'Next departures',
  loadingDepartures: 'Loading departures…',
  departuresUnavailable: 'Departures unavailable right now',
  noDepartures: 'No departures found',
  cancelled: 'Cancelled',
  scheduledOnly: 'No live estimate — scheduled time shown',
  platform: (n: string) => `Pl. ${n}`,
  liveAttribution: 'Departures via <a href="https://transitous.org">Transitous</a>',
  punctuality: 'Punctuality',
  onTimeShare: 'on time',
  cancelRate: 'Cancelled',
  // Median, not mean: on this distribution the mean is worse than the trip
  // about 70% of riders actually get.
  typicalDelay: 'Typically',
  oneInTen: '1 train in 10',
  typicalShort: 'typ',
  p90Short: 'p90',
  band: {
    punctual: 'To the minute',
    slight: 'Under 6 min',
    late: '6–15 min',
    severe: '16 min or more',
    cancelled: 'Cancelled',
  },
  byStation: 'By station, worst first — minutes late',
  noPunctuality: 'No punctuality record for this line',
  punctualityAttribution:
    'Punctuality: <a href="https://huggingface.co/datasets/piebro/deutsche-bahn-data">Deutsche Bahn open data</a> (CC BY 4.0)',
  punctualityWindow: (months, to) => `${months} month${months === 1 ? '' : 's'} to ${to}`,
  onTimeExplainer: (threshold) => `Departures less than ${threshold} minutes late`,
  // The interface is English, so its numbers are grouped and pointed the
  // English way even though every name in them is German.
  departureCount: (n) => `${n.toLocaleString('en')} departures`,
  minutesLate: (n) => `${n} min late`,
  closures: 'Construction',
  showClosures: 'Closures and works',
  closureCount: (n) => `${n} in view`,
  noClosuresInView: 'None in this view',
  // What DB's `wirkung` means for someone trying to travel, rather than a
  // translation of the operational term.
  closureEffect: {
    closed: 'Line closed',
    'single-track': 'One track only',
    diverted: 'Off the timetable',
    slower: 'Longer journey time',
    other: 'Restriction',
  },
  closureDirection: {
    both: 'Both directions',
    'with-km': 'One direction',
    'against-km': 'One direction',
  },
  closureLegendMajor: 'Closed or single-track',
  closureLegendMinor: 'Other restriction (zoom 10+)',
  closureWorks: 'Works',
  closureLine: 'Line',
  closureTrack: 'Track',
  closureHours: 'Today',
  closureAllDay: 'All day',
  closureUntil: 'Until',
  closureFrom: 'From',
  closureAtStation: 'At one station',
  closureHistory: 'In the plan',
  closureSince: 'First recorded',
  closureExtended: (n) => `Rescheduled ${n} time${n === 1 ? '' : 's'} since`,
  closureMovedLater: (from) => `Was to finish ${from}`,
  closureMovedEarlier: (from) => `Was to run until ${from}`,
  // Said plainly rather than left to be inferred: the log only knows what it
  // has watched, and it started the day the job first ran.
  closureNoHistory: 'Not yet in our record when this closure was first seen',
  closureAsOf: (day) => `Construction as planned on ${day}`,
  closureAttribution:
    'Construction: <a href="https://strecken-info.de">DB InfraGO strecken.info</a>',
  coachAttribution: 'Coach: <a href="https://global.flixbus.com">FlixMobility Tech GmbH</a>',
  // The marks are trademarks of the companies they name; the map shows them to
  // say who runs a line and claims nothing else by it.
  logoAttribution:
    'Operator marks: <a href="https://commons.wikimedia.org">Wikimedia Commons</a>, ' +
    'public domain · trademarks of their owners',
  // `commit` arrives as a link to the commit on GitHub, so this one is markup
  // rather than text. The date is dropped rather than left dangling after the
  // separator when the build has a commit but no readable date behind it.
  buildStamp: (commit, when) => (when ? `Build ${commit} · ${when}` : `Build ${commit}`),

  tabExplore: 'Explore',
  tabPlan: 'Plan',
  planFrom: 'From',
  planTo: 'To',
  planSwap: 'Swap origin and destination',
  planUseMap: 'Pick on the map',
  planSearching: 'Searching…',
  planNoPlaces: 'No place of that name',
  planWhen: 'When',
  planLeaveNow: 'Leave now',
  planDepartAt: 'Depart at',
  planArriveBy: 'Arrive by',
  planDate: 'Date',
  planTime: 'Time',
  planModes: 'Travel by',
  planBike: 'Bike',
  // The control is named by what it decides, not by the parameter it sets.
  planBikeQuestion: 'How far will you ride at each end?',
  planBikeNone: 'No bike',
  planBikeMinutes: (n) => (n >= 60 ? `${n / 60} h${n % 60 ? ` ${n % 60} min` : ''}` : `${n} min`),
  planCarriage: 'Take the bike on board',
  // Said plainly, because turning this on can empty the results for a reason
  // that is nothing to do with the journey - see docs/spike-transitous.md.
  planCarriageNote:
    'Most German timetables do not publish whether bikes are carried, and this ' +
    'filter treats silence as no. It can return nothing at all.',
  planSubmit: 'Find routes',
  planLoading: 'Finding routes…',
  planFailed: 'Could not reach the routing service',
  planNothing: 'No journeys found',
  planNeedBoth: 'Choose where you are starting and where you are going',
  planEarlier: '‹ Earlier',
  planLater: 'Later ›',
  planTransfers: (n) => (n === 0 ? 'direct' : n === 1 ? '1 change' : `${n} changes`),
  planRiding: (mins) => `${mins} riding`,
  planWholeWayBike: 'Cycle the whole way',
  planWholeWayWalk: 'Walk the whole way',
  planStops: (n) => (n === 1 ? '1 stop' : `${n} stops`),
  planBikesCarried: 'Bikes carried',
  // The honest reading of a field the API cannot distinguish from "no".
  planBikesUnknown: 'Bike carriage not published',
  planReservation: 'Booking required',
  planCancelled: 'Cancelled',
  planDelayed: (mins) => `${mins} min late`,
  planWalk: 'Walk',
  planBikeLeg: 'Cycle',
  planPlatform: (n) => `Pl. ${n}`,
  planDirectionsFrom: 'Directions from here',
  planDirectionsTo: 'Directions to here',
  planAttribution: 'Routing: <a href="https://transitous.org">Transitous</a>',
};

export const t = (): Strings => STRINGS;

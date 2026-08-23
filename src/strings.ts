/** UI strings. The interface is English; station and line names stay German. */

import type { ClosureDirection, ClosureEffect } from '../shared/closures.ts';

export interface Strings {
  search: string; noResults: string;
  modes: string; longdistance: string; regional: string; suburban: string;
  subway: string; tram: string; operator: string; allOperators: string;
  basemap: string; baseLnvg: string; baseOsm: string; stations: string;
  lines: string; servedBy: string; close: string; clearSelection: string;
  network: string; legend: string; noLinesInView: string;
  stopOne: string; stopShared: string; stopSkipped: string;
  hideChrome: string; showChrome: string;
  collapsePanel: string; expandPanel: string; panelPeek: string;
  fullscreen: string; exitFullscreen: string;
  locate: string; locateDenied: string; locateError: string;
  zoomIn: string; zoomOut: string; northUp: string;
  streets: string;
  lineCount: (n: number) => string;
  stationCount: (n: number) => string;
  loading: string; dataDate: string;
  departures: string; loadingDepartures: string; departuresUnavailable: string;
  noDepartures: string; cancelled: string; scheduledOnly: string;
  platform: (n: string) => string;
  liveAttribution: string;
  punctuality: string; onTimeShare: string; cancelRate: string;
  typicalDelay: string; oneInTen: string; typicalShort: string; p90Short: string;
  byStation: string; noPunctuality: string; punctualityAttribution: string;
  band: Record<'punctual' | 'slight' | 'late' | 'severe' | 'cancelled', string>;
  punctualityWindow: (months: number, to: string) => string;
  onTimeExplainer: (threshold: number) => string;
  departureCount: (n: number) => string;
  minutesLate: (n: string) => string;
  closures: string; showClosures: string; closureCount: (n: number) => string;
  noClosuresInView: string;
  closureEffect: Record<ClosureEffect, string>;
  closureDirection: Record<ClosureDirection, string>;
  closureLegendMajor: string; closureLegendMinor: string;
  closureWorks: string; closureLine: string; closureTrack: string;
  closureHours: string;
  closureAllDay: string; closureUntil: string; closureFrom: string;
  closureAtStation: string;
  closureHistory: string; closureSince: string;
  closureExtended: (n: number) => string;
  closureMovedLater: (from: string) => string;
  closureMovedEarlier: (from: string) => string;
  closureNoHistory: string;
  closureAsOf: (day: string) => string;
  closureAttribution: string;
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
  operator: 'Operator',
  allOperators: 'All operators',
  basemap: 'Basemap',
  baseLnvg: 'LNVG style',
  baseOsm: 'OpenStreetMap',
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
  streets: 'Streets from zoom 13',
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
};

export const t = (): Strings => STRINGS;

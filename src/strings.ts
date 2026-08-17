/** UI strings. The interface is English; station and line names stay German. */

export interface Strings {
  search: string; noResults: string;
  modes: string; longdistance: string; regional: string; suburban: string;
  subway: string; tram: string; operator: string; allOperators: string;
  basemap: string; baseLnvg: string; baseOsm: string; stations: string;
  lines: string; servedBy: string; close: string; clearSelection: string;
  network: string; legend: string; noLinesInView: string;
  interchange: string; station: string; reset: string;
  hideChrome: string; showChrome: string;
  collapsePanel: string; expandPanel: string; panelPeek: string;
  fullscreen: string; exitFullscreen: string;
  locate: string; locateDenied: string; locateError: string;
  zoomIn: string; zoomOut: string; northUp: string;
  streets: string;
  lineCount: (n: number) => string;
  stationCount: (n: number) => string;
  loading: string; dataDate: string;
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
  interchange: 'Interchange',
  station: 'Station',
  reset: 'Reset view',
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
};

export const t = (): Strings => STRINGS;

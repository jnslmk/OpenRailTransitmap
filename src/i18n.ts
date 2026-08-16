/** Minimal bilingual layer. German is the default: the network and every station name is German. */

export type Lang = 'de' | 'en';

export interface Strings {
  title: string; subtitle: string; search: string; noResults: string;
  modes: string; longdistance: string; regional: string; suburban: string;
  subway: string; tram: string; operator: string; allOperators: string;
  basemap: string; baseLnvg: string; baseOsm: string; stations: string;
  lines: string; servedBy: string; close: string; clearSelection: string;
  network: string; share: string; copied: string; legend: string;
  interchange: string; station: string; reset: string;
  hideChrome: string; showChrome: string;
  fullscreen: string; exitFullscreen: string;
  locate: string; locateDenied: string; locateError: string;
  zoomIn: string; zoomOut: string;
  lineCount: (n: number) => string;
  stationCount: (n: number) => string;
  loading: string; dataDate: string;
}

const STRINGS: Record<Lang, Strings> = {
  de: {
    title: 'Schienennetz',
    subtitle: 'OpenStreetMap-Daten im Stil des LNVG-Streckenfahrplans',
    search: 'Linie oder Station suchen…',
    noResults: 'Keine Treffer',
    modes: 'Verkehrsmittel',
    longdistance: 'Fernverkehr',
    regional: 'Regionalverkehr',
    suburban: 'S-Bahn',
    subway: 'U-Bahn',
    tram: 'Straßenbahn',
    operator: 'Betreiber',
    allOperators: 'Alle Betreiber',
    basemap: 'Hintergrund',
    baseLnvg: 'LNVG-Stil',
    baseOsm: 'OpenStreetMap',
    stations: 'Stationen',
    lines: 'Linien',
    servedBy: 'Linien an dieser Station',
    close: 'Schließen',
    clearSelection: 'Auswahl aufheben',
    network: 'Netz',
    share: 'Link kopieren',
    copied: 'Kopiert',
    legend: 'Legende',
    interchange: 'Umsteigebahnhof',
    station: 'Station',
    reset: 'Ansicht zurücksetzen',
    hideChrome: 'Bedienfeld ausblenden',
    showChrome: 'Bedienfeld einblenden',
    fullscreen: 'Vollbild',
    exitFullscreen: 'Vollbild beenden',
    locate: 'Eigenen Standort anzeigen',
    locateDenied: 'Standortzugriff verweigert',
    locateError: 'Standort nicht verfügbar',
    zoomIn: 'Vergrößern',
    zoomOut: 'Verkleinern',
    lineCount: (n: number) => `${n} Linien`,
    stationCount: (n: number) => `${n} Stationen`,
    loading: 'Karte wird geladen…',
    dataDate: 'Datenstand',
  },
  en: {
    title: 'Rail network',
    subtitle: 'OpenStreetMap data in the style of the LNVG Streckenfahrplan',
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
    share: 'Copy link',
    copied: 'Copied',
    legend: 'Legend',
    interchange: 'Interchange',
    station: 'Station',
    reset: 'Reset view',
    hideChrome: 'Hide panel',
    showChrome: 'Show panel',
    fullscreen: 'Fullscreen',
    exitFullscreen: 'Exit fullscreen',
    locate: 'Show my location',
    locateDenied: 'Location access denied',
    locateError: 'Location unavailable',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    lineCount: (n: number) => `${n} lines`,
    stationCount: (n: number) => `${n} stations`,
    loading: 'Loading map…',
    dataDate: 'Data as of',
  },
};

let current: Lang = detect();

function detect(): Lang {
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (fromUrl === 'de' || fromUrl === 'en') return fromUrl;
  const stored = localStorage.getItem('lang');
  if (stored === 'de' || stored === 'en') return stored;
  return navigator.language.startsWith('de') ? 'de' : 'en';
}

export const lang = (): Lang => current;

export function setLang(l: Lang) {
  current = l;
  localStorage.setItem('lang', l);
  document.documentElement.lang = l;
}

export const t = (): Strings => STRINGS[current];

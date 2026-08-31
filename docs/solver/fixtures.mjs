// Bristol Old City test set. Coordinates are real; dwell times, scores and
// kitchen hours are plausible stand-ins for what OSM/Wikipedia/Places return.

import { hm } from './geo.mjs';

export const ORIGIN = { lat: 51.4546, lng: -2.5945 }; // corner of Broad St

/**
 * kind:  'see' | 'eat'
 * dwell: minutes on site at stroll pace
 * score: 0-1 ranking score from the nearby feed (story strength + rating etc.)
 * window: for 'eat' only — kitchen open/close as minutes since midnight
 */
export const CATALOG = {
  stjohn: {
    id: 'stjohn', name: 'St John on the Wall', kind: 'see',
    lat: 51.45452, lng: -2.59432, dwell: 12, score: 0.91,
    why: 'Last medieval gate in the city wall.',
  },
  exchange: {
    id: 'exchange', name: 'The Exchange & the Nails', kind: 'see',
    lat: 51.45400, lng: -2.59362, dwell: 14, score: 0.88,
    why: '"Pay on the nail" was coined on these four brass pillars.',
  },
  stnicks: {
    id: 'stnicks', name: 'St Nicholas Market', kind: 'see',
    lat: 51.45382, lng: -2.59288, dwell: 8, score: 0.79,
    why: 'Georgian glass arcade — a browse, not a meal.',
  },
  queensq: {
    id: 'queensq', name: 'Queen Square', kind: 'see',
    lat: 51.45062, lng: -2.59492, dwell: 7, score: 0.74,
    why: 'The 1831 riot ground, cut in half by a road until 1999.',
  },
  llandoger: {
    id: 'llandoger', name: 'Llandoger Trow', kind: 'see',
    lat: 51.45083, lng: -2.59304, dwell: 10, score: 0.83,
    why: 'Where Defoe reportedly met the castaway who became Crusoe.',
  },
  kingst: {
    id: 'kingst', name: 'King Street', kind: 'see',
    lat: 51.45118, lng: -2.59366, dwell: 9, score: 0.71,
    why: 'Cobbles, timber frames, the oldest working playhouse in the country.',
  },
  cathedral: {
    id: 'cathedral', name: 'Bristol Cathedral', kind: 'see',
    lat: 51.45153, lng: -2.60031, dwell: 20, score: 0.86,
    why: 'A hall church — nave and aisles at the same height, rare in England.',
  },
  xmassteps: {
    id: 'xmassteps', name: 'Christmas Steps', kind: 'see',
    lat: 51.45524, lng: -2.59641, dwell: 9, score: 0.77,
    why: 'Paved in 1669 by a wine merchant, still lit by its own lamps.',
  },
  castlepark: {
    id: 'castlepark', name: 'Castle Park ruins', kind: 'see',
    lat: 51.45525, lng: -2.58912, dwell: 11, score: 0.69,
    why: 'A bombed-out church left standing as the city\'s Blitz memorial.',
  },

  // --- food ---
  bianchis: {
    id: 'bianchis', name: 'Bianchis', kind: 'eat',
    lat: 51.45441, lng: -2.59521, dwell: 45, score: 0.94,
    window: [hm('12:00'), hm('14:30')], // last seating 14:30
    why: 'Hand-rolled pasta, twelve covers. 4.8 from 1.4k.',
  },
  root: {
    id: 'root', name: 'Root', kind: 'eat',
    lat: 51.44905, lng: -2.59105, dwell: 50, score: 0.89,
    window: [hm('12:00'), hm('15:00')],
    why: 'Small plates, mostly veg, on the harbourside. 4.7.',
  },
  latelunch: {
    id: 'latelunch', name: 'The Ox', kind: 'eat',
    lat: 51.45372, lng: -2.59401, dwell: 40, score: 0.81,
    window: [hm('13:30'), hm('16:00')], // opens late — used to test the wait penalty
    why: 'Basement grill on Corn Street. 4.6.',
  },
};

/** The walk from the mockup: 5 stops, lunch anchored, loop back to origin. */
export function baselinePlan() {
  return {
    origin: ORIGIN,
    startTime: hm('12:40'),
    budget: 120,
    pace: 'stroll',
    returnToOrigin: true,
    orderLocked: false,
    stops: [
      { id: 'stjohn', pinned: true },
      { id: 'exchange', pinned: false },
      { id: 'stnicks', pinned: false },
      { id: 'bianchis', pinned: false },
      { id: 'queensq', pinned: false },
    ],
  };
}

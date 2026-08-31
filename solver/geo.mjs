// Distance and walking-time helpers.
//
// Real walking times come from a routing engine (OSRM). Until that's wired up,
// straight-line distance x 1.35 is the agreed fallback — see the plan doc.
// Everything downstream goes through `legMinutes`, so swapping in OSRM later is
// a one-function change.

const DETOUR_FACTOR = 1.35;

/** metres per minute */
export const PACE = {
  dawdle: 50,   // ~3.0 km/h
  stroll: 67,   // ~4.0 km/h
  brisk: 83,    // ~5.0 km/h
};

/** Dwell multiplier: a dawdler lingers, a brisk walker doesn't. */
export const DWELL_FACTOR = { dawdle: 1.3, stroll: 1.0, brisk: 0.75 };

export function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Straight-line metres between two places, inflated to street distance. */
export function streetMetres(a, b) {
  return haversine(a, b) * DETOUR_FACTOR;
}

/** Whole minutes to walk between two places at a given pace. */
export function legMinutes(a, b, pace = 'stroll') {
  return Math.round(streetMetres(a, b) / PACE[pace]);
}

/** hh:mm <-> minutes-since-midnight, for readable fixtures and assertions. */
export function hm(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}

export function clock(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Do two route legs cross? Used only in tests, to prove 2-opt actually
 * untangles rather than just shaving seconds.
 */
export function segmentsCross(p1, p2, p3, p4) {
  const d = (a, b, c) => (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** Count crossings in an ordered list of points (closed loop if `loop`). */
export function countCrossings(points, loop = true) {
  const pts = loop ? [...points, points[0]] : points;
  let n = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = i + 2; j < pts.length - 1; j++) {
      if (i === 0 && j === pts.length - 2) continue; // adjacent on the loop
      if (segmentsCross(pts[i], pts[i + 1], pts[j], pts[j + 1])) n++;
    }
  }
  return n;
}

// Overpass: pull candidate sights around a point.
//
// The query is deliberately narrow. Asking for everything historic returns
// post boxes, benches and wayside crosses — the very first live response while
// building this contained a Royal Mail post box tagged `historic=memorial`.
// Breadth is not the problem; a feed full of nothing is.

import { through, tileKey, TTL } from './cache.mjs';

// Order matters: the first two send `Access-Control-Allow-Origin: *` and so
// survive into the browser build, which drops the rest. The main instance
// returns a 504 often enough under load that having a second CORS-capable
// mirror is not optional.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',   // no CORS: server build only
];

/** metres -> degrees, near enough at UK latitudes for a bounding box */
function bbox(lat, lng, radius) {
  const dLat = radius / 111_320;
  const dLng = radius / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lat - dLat, lng - dLng, lat + dLat, lng + dLng].map((n) => n.toFixed(6)).join(',');
}

// One query per tab. The sights query is deliberately narrow (see the header);
// the other two are wide, because "every café" and "every shop" is exactly what
// those tabs claim to show, and OSM has no notion of a good one.
const QUERIES = {
  see: (b) => `
  nwr["historic"]["name"](${b});
  nwr["tourism"~"^(attraction|museum|artwork|viewpoint|gallery)$"]["name"](${b});
  nwr["heritage"]["name"](${b});
  nwr["amenity"="place_of_worship"]["name"]["wikidata"](${b});
  nwr["building"]["wikidata"]["name"](${b});
  nwr["man_made"~"^(tower|lighthouse|bridge)$"]["name"](${b});`,

  food: (b) => `
  nwr["amenity"~"^(restaurant|cafe|pub|bar|fast_food|food_court|biergarten|ice_cream)$"]["name"](${b});
  nwr["shop"~"^(bakery|deli|pastry|confectionery|chocolate|coffee|tea)$"]["name"](${b});`,

  // Shops that sell food are on the food tab; the reject list in local.mjs
  // keeps them off this one rather than a second set of tag filters here.
  shop: (b) => `
  nwr["shop"]["name"](${b});
  nwr["amenity"~"^(marketplace)$"]["name"](${b});`,
};

function query(lat, lng, radius, kind) {
  const b = bbox(lat, lng, radius);
  return `[out:json][timeout:25];
(${(QUERIES[kind] ?? QUERIES.see)(b)}
);
out center tags;`;
}

async function post(url, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Footlore/0.1 (personal tour guide; contact via repo)',
    },
    body: new URLSearchParams({ data: body }),
    signal,
  });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  return res.json();
}

/** Normalise a raw OSM element into something the rest of the app can hold. */
function normalise(el, kind) {
  const t = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null || !t.name) return null;

  let wikipedia = null;
  if (t.wikipedia?.startsWith('en:')) wikipedia = t.wikipedia.slice(3);

  return {
    id: `${el.type[0]}${el.id}`,
    name: t.name,
    lat, lng,
    kind,
    tags: t,
    amenity: t.amenity ?? null,
    shop: t.shop ?? null,
    cuisine: t.cuisine ?? null,
    wikidata: t.wikidata ?? null,
    wikipedia,
    heritage: t.heritage ?? t['heritage:operator'] ?? t.listed_status ?? null,
    historic: t.historic ?? null,
    tourism: t.tourism ?? null,
    startDate: t.start_date ?? t['building:start_date'] ?? null,
    website: t.website ?? t['contact:website'] ?? null,
    openingHours: t.opening_hours ?? null,
    fee: t.fee ?? null,
  };
}

/**
 * @returns {Promise<{places: object[], cached: boolean}>}
 */
export async function fetchNearby(lat, lng, radius = 900, kind = 'see') {
  const key = tileKey(lat, lng, radius);
  const ns = kind === 'see' ? 'osm' : `osm-${kind}`;
  const { value, cached } = await through(ns, key, TTL.osm, async () => {
    const q = query(lat, lng, radius, kind);
    let lastErr;
    for (const url of ENDPOINTS) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 30_000);
        const json = await post(url, q, ac.signal);
        clearTimeout(timer);
        return json.elements.map((el) => normalise(el, kind)).filter(Boolean);
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`all Overpass endpoints failed: ${lastErr?.message}`);
  });
  return { places: value, cached };
}

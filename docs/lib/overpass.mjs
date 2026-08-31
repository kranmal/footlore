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

    },
    body: new URLSearchParams({ data: body }),
    signal,
  });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const json = await res.json();
  // A timed-out or rate-limited Overpass query answers 200 with an empty
  // element list and a `remark`. Taken at face value that is indistinguishable
  // from "nothing is mapped here" — and it gets cached under that meaning, so
  // the app then tells somebody standing in central Bristol that there is
  // nothing around them. Treat it as the failure it is and try the next mirror.
  if (json.remark && /error|timed? ?out|rate|memory/i.test(json.remark)) {
    throw new Error(`overpass remark: ${String(json.remark).slice(0, 120)}`);
  }
  // A mirror whose database hasn't finished loading answers 200, with no
  // remark, and with an empty element list for every query on earth — the
  // osm.ch mirror did exactly this while this was being written, reporting
  // `timestamp_osm_base: "116796"` where a working instance reports an ISO
  // date. Without this check the app cheerfully caches "nothing is mapped in
  // central Bristol". An unreadable timestamp means the mirror cannot answer.
  // (Shape, not Date.parse: `Date.parse("116796")` happily reads that as a year.)
  const ts = json.osm3s?.timestamp_osm_base;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(String(ts ?? ''))) {
    throw new Error(`overpass stale mirror: timestamp_osm_base=${ts ?? 'missing'}`);
  }
  return json;
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

// The place service: one function the client calls, four providers behind it.
//
//   Overpass  ->  Wikidata/Wikipedia  ->  story floor  ->  narration  ->  rank
//
// This is the architectural decision from the plan, in one file. The client
// never sees a provider, never holds a key, and gets one shape back.

import { fetchNearby } from './overpass.mjs';
import { enrich } from './wiki.mjs';
import { narrate, cleanExtract } from './narrate.mjs';
import { storyStrength, rank, STORY_FLOOR } from './score.mjs';

/**
 * @returns {Promise<{places:object[], meta:object}>}
 */
// One widening step, not a ladder: every extra radius is another 30-second
// Overpass call, and in exactly the empty countryside where widening is needed
// those calls are also the slowest.
const WIDEN_TO = [2500];
const ENOUGH = 5;

/**
 * @returns {Promise<{places:object[], meta:object}>}
 */
export async function nearby({ lat, lng, radius = 900, limit = 25, seen = [], minResults = ENOUGH }) {
  const t0 = Date.now();
  const origin = { lat, lng };

  // Rural OSM density collapses — the plan's first named risk. Rather than
  // padding a thin feed with petrol stations, widen the circle and say so.
  // Narration runs once, after the radius is settled, so widening is free.
  const ladder = [radius, ...WIDEN_TO.filter((r) => r > radius)];
  let pass = null;
  let widenedFrom = null;

  for (const r of ladder) {
    pass = await candidates({ lat, lng, radius: r, origin, seen, limit });
    if (pass.ranked.length >= minResults || r === ladder.at(-1)) break;
    if (widenedFrom === null) widenedFrom = r;
  }

  const { places, mode, generated, rejected } = await narrate(pass.ranked);

  // A card with no line to show is not a card.
  const final = places.filter((p) => p.why);

  return {
    places: final.map(publicShape),
    meta: {
      found: pass.found,
      belowFloor: pass.belowFloor,
      shown: final.length,
      radius: pass.radius,
      requestedRadius: radius,
      widenedFrom,
      thin: final.length < minResults,
      osmCached: pass.cached,
      narration: mode,
      narrated: generated,
      rejectedLines: rejected,
      ms: Date.now() - t0,
      attribution: ['© OpenStreetMap contributors (ODbL)', 'Wikipedia (CC BY-SA)'],
    },
  };
}

/** One radius: fetch, enrich, floor, rank. No narration — that costs money. */
async function candidates({ lat, lng, radius, origin, seen, limit }) {
  const { places: raw, cached } = await fetchNearby(lat, lng, radius);
  const enriched = await enrich(raw);

  // Story floor. This is where the post boxes go.
  const scored = enriched.map((p) => ({ ...p, ...scoreOf(p) }));
  const kept = scored.filter((p) => !p.rejected && p.story >= STORY_FLOOR);

  // Two OSM nodes often point at one article — St John's Gate and St John the
  // Baptist are the same building tagged twice. Same article, same card.
  const ranked = dedupe(kept.map((p) => rank(p, { origin, seen })).sort((a, b) => b.rankScore - a.rankScore))
    .slice(0, limit);

  return { ranked, radius, cached, found: raw.length, belowFloor: scored.length - kept.length };
}

/** Keep the best-ranked place per Wikipedia article. */
function dedupe(places) {
  const seenTitles = new Set();
  return places.filter((p) => {
    if (!p.wikiTitle) return true;
    if (seenTitles.has(p.wikiTitle)) return false;
    seenTitles.add(p.wikiTitle);
    return true;
  });
}

function scoreOf(p) {
  const { score, signals, rejected } = storyStrength(p);
  return { story: score, storySignals: signals, rejected };
}

/** The single `Place` shape the front end is written against. */
function publicShape(p) {
  return {
    id: p.id,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    kind: p.kind,
    why: p.why,
    whySource: p.whySource,
    walkMinutes: p.walkMinutes,
    metres: p.metres,
    open: p.open,
    fee: p.fee ?? null,
    story: +p.story.toFixed(3),
    rankScore: +p.rankScore.toFixed(3),
    storySignals: p.storySignals,
    label: labelFor(p),
    built: p.startDate,
    heritage: p.heritage,
    extract: cleanExtract(p.extract),
    image: p.image,
    wikiUrl: p.wikiUrl,
    source: p.source,
    readMinutes: p.extract ? Math.max(1, Math.round(p.extract.split(/\s+/).length / 180)) : null,
  };
}

/** The short uppercase chip on the card. */
function labelFor(p) {
  if (p.heritage && /(^|[^0-9])(1|I)([^0-9]|$)/.test(String(p.heritage))) return 'GRADE I';
  if (p.startDate) {
    const year = parseInt(String(p.startDate).match(/\d{3,4}/)?.[0] ?? '', 10);
    if (year && year < 1500) return 'MEDIEVAL';
    if (year) return String(year);
  }
  if (p.tourism === 'museum') return 'MUSEUM';
  if (p.historic) return String(p.historic).replace(/_/g, ' ').toUpperCase();
  if (p.tourism) return String(p.tourism).toUpperCase();
  return 'LANDMARK';
}

// The food and shops tabs.
//
// Everything here is a deliberate step down in ambition from the sights feed,
// and the reason is accuracy. There is no free source of restaurant ratings:
// OpenStreetMap does not carry them, and the ones that do cost money per
// request and cannot be reached from a static page at all. So this side of the
// app makes no claim about quality. It shows what is mapped near you, orders it
// by how close it is and how much is actually recorded about it, and says so on
// screen. A four-star badge nobody checked would be worse than no badge.
//
// Lines under each name are assembled from OSM tags only — cuisine, diet,
// seating, takeaway — or quoted from Wikipedia where the place has an article.
// Nothing is inferred and nothing is written by a model.

import { fetchNearby } from './overpass.mjs';
import { enrich } from './wiki.mjs';
import { cleanExtract } from './narrate.mjs';
import { rank } from './score.mjs';

const WIDEN_TO = [2500];
const ENOUGH = 5;

/** Shop values that belong on the food tab, and so not on the shops one. */
const FOOD_SHOPS = new Set([
  'bakery', 'deli', 'pastry', 'confectionery', 'chocolate', 'coffee', 'tea', 'ice_cream',
]);

/** Not somewhere you walk to and browse. */
const SHOP_REJECT = new Set([
  'vacant', 'car_repair', 'car_parts', 'tyres', 'car', 'truck', 'caravan',
  'funeral_directors', 'storage_rental', 'trade', 'agrarian', 'fuel',
  'estate_agent', 'insurance', 'money_lender', 'pawnbroker', 'bookmaker',
]);

const AMENITY_WORD = {
  restaurant: 'restaurant', cafe: 'café', pub: 'pub', bar: 'bar',
  fast_food: 'takeaway', food_court: 'food court', biergarten: 'beer garden',
  ice_cream: 'ice cream shop', marketplace: 'market',
};

/**
 * OSM shop values that already name a trade or a shopkeeper. Everything else is
 * the goods on sale — shop=photo is a photo shop, not a "photo" — so the
 * fallback adds the word and this list is the exception to it.
 */
const TRADES = new Set([
  'hairdresser', 'barber', 'butcher', 'baker', 'greengrocer', 'fishmonger',
  'florist', 'optician', 'chemist', 'pharmacy', 'newsagent', 'tailor',
  'travel_agency', 'laundry', 'dry_cleaning', 'tattoo', 'beauty', 'massage',
  'copyshop', 'locksmith', 'shoe_repair', 'veterinary', 'bank', 'charity',
  'variety_store', 'general', 'kiosk', 'boutique', 'deli', 'bakery',
]);

function typeWord(p) {
  if (p.amenity && AMENITY_WORD[p.amenity]) return AMENITY_WORD[p.amenity];
  if (p.shop) {
    const w = p.shop.replace(/_/g, ' ');
    if (p.shop === 'convenience') return 'corner shop';
    if (p.shop === 'department_store') return 'department store';
    if (p.shop === 'supermarket') return 'supermarket';
    if (p.shop === 'doityourself') return 'DIY shop';
    return TRADES.has(p.shop) ? w : `${w} shop`;
  }
  return p.kind === 'food' ? 'place to eat' : 'shop';
}

const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** "italian;pizza" -> "Italian and pizza" — the tag's own words, tidied. */
function cuisineWords(cuisine) {
  if (!cuisine) return null;
  const parts = cuisine.split(';').map((c) => c.trim().replace(/_/g, ' ')).filter(Boolean).slice(0, 2);
  if (!parts.length) return null;
  return parts.join(' and ');
}

/**
 * The card line, built only from tags. Every clause here is a tag being read
 * out, not a description being written.
 */
function describe(p) {
  const t = p.tags ?? {};
  const cuisine = cuisineWords(p.cuisine);
  const type = typeWord(p);
  // cuisine=coffee_shop on an amenity=cafe would otherwise read "coffee shop café"
  const stutter = cuisine && (cuisine.includes(type) || /\b(shop|bar|pub|restaurant|café|cafe)\b/.test(cuisine));
  const head = !cuisine ? type : stutter ? cuisine : `${cuisine} ${type}`;

  const extras = [];
  const diet = Object.entries(t)
    .filter(([k, v]) => k.startsWith('diet:') && (v === 'yes' || v === 'only'))
    .map(([k]) => k.slice(5).replace(/_/g, ' '));
  if (diet.length) extras.push(`${diet.slice(0, 2).join(' and ')} options`);
  if (t.outdoor_seating === 'yes') extras.push('outdoor seating');
  if (t.takeaway === 'yes' && p.amenity !== 'fast_food') extras.push('takeaway');
  if (t.wheelchair === 'yes') extras.push('step-free access');
  if (t.real_ale === 'yes') extras.push('real ale');

  if (extras.length) return `${sentence(head)}. ${sentence(extras.join(', '))}.`;
  // The hours are already on the card, and repeating "nothing else is mapped"
  // down a whole list reads as an app apologising rather than as information.
  if (p.openingHours) return `${sentence(head)}.`;
  return `${sentence(head)}. A name and a pin, nothing else mapped.`;
}

/**
 * How much is known — not how good it is. This drives the same 25-point slot
 * story strength drives on the sights feed, so a place somebody has taken the
 * trouble to describe sorts above a bare pin at the same distance.
 */
function detailOf(p) {
  const t = p.tags ?? {};
  let score = 0;
  const words = p.extract ? p.extract.split(/\s+/).length : 0;
  if (words) score += 0.25 + 0.20 * Math.min(words / 120, 1);
  if (p.cuisine) score += 0.2;
  if (p.openingHours) score += 0.15;
  if (p.website || t.phone || t['contact:phone']) score += 0.1;
  if (p.heritage || p.historic) score += 0.15;
  let small = 0;
  for (const k of ['outdoor_seating', 'takeaway', 'wheelchair', 'real_ale', 'delivery']) {
    if (t[k] === 'yes') small += 0.05;
  }
  score += Math.min(small, 0.15);
  for (const k of Object.keys(t)) if (k.startsWith('diet:')) { score += 0.05; break; }
  return Math.min(score, 1);
}

function keep(p, kind) {
  if (kind === 'shop') {
    if (p.amenity === 'marketplace') return true;
    if (!p.shop) return false;
    return !SHOP_REJECT.has(p.shop) && !FOOD_SHOPS.has(p.shop);
  }
  return Boolean(p.amenity || p.shop);
}

/**
 * Same contract as the sights feed: one call, one shape, one list.
 * @returns {Promise<{places:object[], meta:object}>}
 */
export async function nearbyLocal({ lat, lng, radius = 900, limit = 25, seen = [], kind = 'food', minResults = ENOUGH }) {
  const t0 = Date.now();
  const origin = { lat, lng };

  const ladder = [radius, ...WIDEN_TO.filter((r) => r > radius)];
  let pass = null;
  let widenedFrom = null;

  for (const r of ladder) {
    pass = await candidates({ lat, lng, radius: r, origin, seen, limit, kind });
    if (pass.ranked.length >= minResults || r === ladder.at(-1)) break;
    if (widenedFrom === null) widenedFrom = r;
  }

  // Only the shortlist is enriched: most eateries have no article, and the ones
  // that do are worth a quoted sentence in place of the tag line.
  // Enrichment is for the picture and the link only. The article a shop pin
  // carries is frequently about the building it stands in — quoting "It was
  // part rebuilt as a facsimile in 1993" under a travel agent's name would be
  // true of the wall and false of the shop. So the line is always the tags,
  // and the article is shown in the sheet, labelled as what it is.
  const enriched = await enrich(pass.ranked);
  const places = enriched.map((p) => ({ ...p, why: describe(p), whySource: 'osm' }));

  return {
    places: places.map((p) => publicShape(p, kind)),
    meta: {
      kind,
      found: pass.found,
      belowFloor: pass.dropped,
      shown: places.length,
      radius: pass.radius,
      requestedRadius: radius,
      widenedFrom,
      thin: places.length < minResults,
      osmCached: pass.cached,
      narration: 'osm',
      narrated: 0,
      rejectedLines: 0,
      rated: false,
      ms: Date.now() - t0,
      attribution: ['© OpenStreetMap contributors (ODbL)', 'Wikipedia (CC BY-SA)'],
    },
  };
}

async function candidates({ lat, lng, radius, origin, seen, limit, kind }) {
  const { places: raw, cached } = await fetchNearby(lat, lng, radius, kind);
  const kept = raw.filter((p) => keep(p, kind)).map((p) => ({ ...p, story: detailOf(p) }));
  const ranked = kept
    .map((p) => rank(p, { origin, seen }))
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, limit);
  return { ranked, radius, cached, found: raw.length, dropped: raw.length - kept.length };
}

function publicShape(p, kind) {
  return {
    id: p.id,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    kind,
    why: p.why,
    whySource: p.whySource,
    walkMinutes: p.walkMinutes,
    metres: p.metres,
    open: p.open,
    hours: p.openingHours ?? null,
    fee: null,
    story: +p.story.toFixed(3),
    rankScore: +p.rankScore.toFixed(3),
    storySignals: [],
    label: labelFor(p, kind),
    built: null,
    heritage: p.heritage ?? null,
    extract: cleanExtract(p.extract),
    wikiTitle: p.wikiTitle ?? null,
    image: p.image ?? null,
    wikiUrl: p.wikiUrl ?? null,
    source: p.source ?? 'OpenStreetMap',
    website: p.website ?? null,
    readMinutes: null,
  };
}

/** The chip: what the tag says it is, not what anyone thinks of it. */
function labelFor(p, kind) {
  const word = p.cuisine ? cuisineWords(p.cuisine) : typeWord({ ...p, kind });
  return String(word).toUpperCase().slice(0, 18);
}

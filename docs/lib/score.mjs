// Story strength and feed ranking.
//
// Story strength is the part of Footlore that has to be built rather than bought.
// It answers one question: is there anything to SAY about this? Everything
// below the floor is dropped outright — an empty feed with three good things
// beats a full one with twenty bus stops.

import { legMinutes, streetMetres } from './geo.mjs';

/** Things that are tagged historic but are not, in any useful sense, sights. */
const REJECT_TAGS = [
  ['amenity', /^(post_box|bench|waste_basket|telephone|bicycle_parking|drinking_water|parking)$/],
  ['historic', /^(wayside_cross|milestone|boundary_stone|survey_point)$/],
  ['man_made', /^(street_cabinet|surveillance)$/],
];

/** Rough weighting by what the thing actually is. */
const HISTORIC_WEIGHT = {
  castle: 1, city_gate: 1, fort: 0.95, ruins: 0.9, monastery: 0.9,
  church: 0.8, chapel: 0.7, monument: 0.8, tower: 0.75, aqueduct: 0.85,
  archaeological_site: 0.85, ship: 0.8, manor: 0.8, building: 0.6,
  memorial: 0.45, plaque: 0.3, tomb: 0.5,
};

const TOURISM_WEIGHT = {
  museum: 0.85, attraction: 0.6, viewpoint: 0.55, gallery: 0.6, artwork: 0.45,
};

export const STORY_FLOOR = 0.34;

/**
 * @param {object} p   normalised OSM place, optionally with `extract` attached
 * @returns {{score:number, signals:string[], rejected:string|null}}
 */
export function storyStrength(p) {
  const t = p.tags ?? {};
  for (const [k, re] of REJECT_TAGS) {
    if (t[k] && re.test(t[k])) return { score: 0, signals: [], rejected: `${k}=${t[k]}` };
  }

  const signals = [];
  let score = 0;

  // An article is the strongest single signal there is something to tell.
  const words = p.extract ? p.extract.split(/\s+/).length : 0;
  if (words > 0) {
    const depth = Math.min(words / 120, 1); // ~120 words of intro = full marks
    score += 0.20 + 0.25 * depth;
    signals.push(`wikipedia:${words}w`);
  } else if (p.wikidata) {
    score += 0.12;
    signals.push('wikidata');
  }

  if (p.heritage) {
    const grade = /(^|[^0-9])(1|I)([^0-9]|$)/.test(String(p.heritage)) ? 0.22 : 0.15;
    score += grade;
    signals.push(`heritage:${p.heritage}`);
  }

  if (p.historic) {
    const w = HISTORIC_WEIGHT[p.historic] ?? 0.4;
    score += 0.20 * w;
    signals.push(`historic:${p.historic}`);
  }

  if (p.tourism) {
    score += 0.16 * (TOURISM_WEIGHT[p.tourism] ?? 0.4);
    signals.push(`tourism:${p.tourism}`);
  }

  if (p.startDate) {
    score += 0.08;
    signals.push(`dated:${p.startDate}`);
  }

  // A plaque with no article is a plaque.
  if (t.memorial === 'plaque' && !p.extract) score = Math.min(score, 0.2);

  return { score: Math.min(score, 1), signals, rejected: null };
}

/** Is it open, per OSM opening_hours? Deliberately conservative. */
export function openNow(p, now = new Date()) {
  const oh = p.openingHours;
  if (!oh) return null;                       // unknown, not "closed"
  if (/24\/7/.test(oh)) return true;
  const days = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const today = days[now.getDay()];
  const mins = now.getHours() * 60 + now.getMinutes();
  const rules = oh.split(';').map((s) => s.trim());
  for (const rule of rules) {
    const m = rule.match(/^([A-Za-z,\-]+)?\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const [, dayPart, h1, m1, h2, m2] = m;
    if (dayPart && !dayPart.includes(today)) {
      const range = dayPart.match(/^([A-Za-z]{2})-([A-Za-z]{2})$/);
      if (!range) continue;
      const from = days.indexOf(range[1]), to = days.indexOf(range[2]);
      const d = now.getDay();
      const inRange = from <= to ? d >= from && d <= to : d >= from || d <= to;
      if (!inRange) continue;
    }
    const open = +h1 * 60 + +m1, close = +h2 * 60 + +m2;
    if (mins >= open && mins <= close) return true;
  }
  return false;
}

/**
 * Feed rank. The weights from the plan:
 *   walk 30 · story 25 · rating 20 · open now 15 · unseen 10
 *
 * Phase 01 has no ratings for sights, and opening hours are missing more often
 * than not. Rather than scoring a missing signal as zero — which would push
 * every untagged landmark to the bottom for no reason — the available weights
 * are renormalised. A place is only ever compared on what is actually known
 * about it.
 */
export function rank(p, { origin, seen = [], now = new Date() } = {}) {
  const walkMin = legMinutes(origin, p);
  const parts = [];

  // 30 — closeness, falling away past ~15 minutes
  parts.push([30, Math.max(0, 1 - walkMin / 15)]);

  // 25 — story strength
  parts.push([25, p.story]);

  // 20 — rating, only where there is one (food, phase 02)
  if (typeof p.rating === 'number') {
    const conf = Math.min((p.reviews ?? 0) / 300, 1);
    parts.push([20, ((p.rating - 3) / 2) * (0.5 + 0.5 * conf)]);
  }

  // 15 — open right now, only where hours are known
  const open = openNow(p, now);
  if (open !== null) parts.push([15, open ? 1 : 0]);

  // 10 — not shown recently
  parts.push([10, seen.includes(p.id) ? 0 : 1]);

  const totalWeight = parts.reduce((n, [w]) => n + w, 0);
  const score = parts.reduce((n, [w, v]) => n + w * Math.max(0, Math.min(v, 1)), 0) / totalWeight;

  return {
    ...p,
    walkMinutes: walkMin,
    metres: Math.round(streetMetres(origin, p)),
    open,
    rankScore: score,
    rankParts: parts.map(([w, v]) => [w, +v.toFixed(3)]),
  };
}

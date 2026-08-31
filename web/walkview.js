// The Walk tab: turn the nearby feed into an ordered afternoon.
//
// Everything routing-shaped lives in solver/ and is unit-tested there against
// fixtures. This file's only job is the translation either way — feed places
// into a catalogue the solver understands, and a solved plan back into cards —
// plus being straight about which of the numbers are measured and which are
// assumed. Nearly all of them are assumed, and the panel says so.

import { solve } from './solver/solve.mjs';
import { schedule } from './solver/plan.mjs';
import { clock } from './solver/geo.mjs';

export const BUDGETS = [60, 90, 120, 180];

/**
 * How long someone stands in front of a thing.
 *
 * OpenStreetMap does not record this and neither does Wikipedia, so it is a
 * flat guess off the one signal there is: whether anybody wrote an article.
 * Three buckets, stated on screen, rather than a formula that would look
 * derived from something.
 */
function dwellFor(p) {
  if (p.label === 'MUSEUM' || p.label === 'GALLERY') return 45;
  if (p.extract) return 10;
  return 5;
}

/** Sitting down to eat. Also a guess, and the same one for everywhere. */
const MEAL_DWELL = 45;

/**
 * Today's opening range to hold the meal inside, as the solver wants it:
 * a single [open, close] pair, or nothing.
 *
 * `windowToday` can hold several ranges — a kitchen that shuts in the
 * afternoon and opens again for dinner. Pick the one the walk could actually
 * land in; if the walk starts after the last one closes there is no honest
 * pick, and the caller drops the candidate.
 */
function mealWindow(p, startTime) {
  const ranges = p.windowToday;
  if (!Array.isArray(ranges) || !ranges.length) return null;      // hours unmapped
  const live = ranges.find(([, close]) => close > startTime);
  return live ? [...live] : undefined;                            // undefined = shut for today
}

/**
 * Feed places -> a catalogue keyed by id, the shape solver/plan.mjs reads.
 * `kind` is the solver's own vocabulary ('see' | 'eat'), not the tab's.
 */
function catalogue(sights, foods, startTime) {
  const cat = {};
  for (const p of sights) {
    cat[p.id] = {
      id: p.id, name: p.name, kind: 'see', lat: p.lat, lng: p.lng,
      dwell: dwellFor(p), score: p.rankScore ?? p.story ?? 0.5, why: p.why, place: p,
    };
  }
  for (const p of foods) {
    const window = mealWindow(p, startTime);
    if (window === undefined) continue;                           // closed for the rest of today
    cat[p.id] = {
      id: p.id, name: p.name, kind: 'eat', lat: p.lat, lng: p.lng,
      dwell: MEAL_DWELL, score: p.rankScore ?? 0.5, why: p.why, place: p,
      ...(window ? { window } : {}),
    };
  }
  return cat;
}

/**
 * Build one walk.
 *
 * The meal is chosen by trying candidates in feed order until one solves,
 * because a time window is the only hard constraint in the problem and the
 * nearest café is frequently the one that shuts at two. If none of them fits,
 * that is reported rather than quietly turned into a mealless walk.
 *
 * @returns {{ok: boolean, reason?: string, sched?: object, plan?: object, meal?: object, mealHoursKnown?: boolean}}
 */
export function buildWalk({ here, sights, foods, budget, wantMeal, now = new Date() }) {
  const startTime = now.getHours() * 60 + now.getMinutes();
  const catalog = catalogue(sights, foods, startTime);
  const base = {
    origin: { lat: here.lat, lng: here.lng },
    startTime, budget, pace: 'stroll', returnToOrigin: true, catalog,
  };

  if (!sights.length) return { ok: false, reason: 'no-sights' };

  let result = null;
  let meal = null;

  if (wantMeal) {
    // Capped: each attempt is a full re-solve, and the feed is already in the
    // order the ranker put it, so the ninth candidate is not worth the wait.
    const eats = Object.values(catalog).filter((p) => p.kind === 'eat').slice(0, 8);
    if (!eats.length) return { ok: false, reason: 'no-food' };
    for (const e of eats) {
      const attempt = solve(base, { mealId: e.id });
      if (attempt.ok && attempt.plan.stops.some((s) => s.id === e.id)) {
        result = attempt;
        meal = e;
        break;
      }
    }
    if (!result) return { ok: false, reason: 'meal-window-infeasible' };
  } else {
    result = solve(base, {});
  }

  if (!result.ok) return { ok: false, reason: result.reason ?? 'unsolved' };
  if (!result.plan.stops.length) return { ok: false, reason: 'budget-too-small' };

  return {
    ok: true,
    plan: result.plan,
    sched: schedule(result.plan),
    catalog,
    meal,
    // A meal with no mapped hours still gets routed; nothing is checked for it,
    // and pretending otherwise is exactly the failure this app is built against.
    mealHoursKnown: meal ? Boolean(meal.window) : null,
  };
}

/* ---------- rendering ---------- */

const node = (tag, cls, kids = []) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const k of kids) if (k) n.append(k);
  return n;
};
const text = (t) => document.createTextNode(String(t));

const REASONS = {
  'no-sights': ['Nothing to build a walk out of.',
    'The Sights tab is empty at this radius, and a walk between no places is not a walk. Widen the circle and try again.'],
  'no-food': ['Nowhere to eat is mapped here.',
    'A meal has to be a real place with a real pin. Turn the meal off, or widen the circle.'],
  'meal-window-infeasible': ['No meal fits in this walk.',
    'Every mapped place to eat is either shut for the rest of today or cannot be reached inside the time. A longer walk, or no meal.'],
  'budget-too-small': ['Not enough time to reach anything.',
    'Everything nearby is further away than the whole budget. Try a longer walk.'],
};

/**
 * Draw the itinerary.
 * @param {HTMLElement} into
 */
export function renderWalk(into, result, { budget, wantMeal, onDirections }) {
  if (!result.ok) {
    const [head, body] = REASONS[result.reason] ?? ['Could not build a walk.', result.reason];
    into.replaceChildren(html(`<div class="note"><b>${head}</b><br>${body}</div>`));
    return;
  }

  const { sched, catalog, meal, mealHoursKnown } = result;
  const list = node('ol', 'route');

  sched.legs.forEach((leg, i) => {
    const stop = sched.stops[i];
    list.append(node('li', 'leg', [
      node('span', 'legLine'),
      node('span', 'legText', [text(`${leg.minutes} min walk · ${metres(leg.metres)}`)]),
    ]));
    if (!stop) return;                                   // the last leg is the way home
    const p = catalog[stop.id].place;

    const bits = [
      node('div', 'stopWhen', [node('b', '', [text(clock(stop.arrive))]),
        text(`${stop.wait ? `wait ${stop.wait}m · ` : ''}${stop.dwell} min here`)]),
      node('h3', '', [text(stop.name)]),
      node('p', 'why', [text(p.why)]),
    ];
    list.append(node('li', `stop${stop.kind === 'eat' ? ' meal' : ''}`, [
      node('span', 'pip', [text(String(i + 1))]),
      node('div', 'stopBody', bits),
      onDirections(p),
    ]));
  });

  const back = sched.legs.at(-1);
  const summary = node('div', 'routeEnd', [
    node('b', '', [text(clock(sched.finish))]),
    text(`back where you started · ${back.minutes} min from the last stop`),
  ]);

  into.replaceChildren(
    node('div', 'routeStats', [
      stat(`${sched.stops.length}`, sched.stops.length === 1 ? 'stop' : 'stops'),
      // A meal is an anchor, not an optional stop, so a walk can come back a
      // few minutes late rather than dropping it. Said out loud, not rounded away.
      stat(`${sched.total}`, sched.total > budget ? `min · ${sched.total - budget} over` : `min of ${budget}`),
      stat(metres(sched.metres), 'on foot'),
      stat(`${sched.walking}`, 'min walking'),
    ]),
    list, summary,
    html(`<div class="note"><b>Most of these numbers are estimates.</b> Walking times come from ` +
      `straight-line distance multiplied by 1.35 — no routing engine, so a river or a railway between two ` +
      `stops is not accounted for. Time at each stop is a flat guess: 45 minutes for a museum, 10 where ` +
      `there is an article to read, 5 otherwise; nothing in the map records how long a place takes. ` +
      (meal
        ? mealHoursKnown
          ? `The meal is timed against ${meal.name}'s mapped opening hours, which may be out of date.`
          : `<b>${meal.name} has no opening hours mapped</b>, so nothing about the timing of the meal has been checked.`
        : wantMeal ? '' : 'Opening hours are only checked for a meal.') +
      `</div>`),
  );
}

function stat(value, label) {
  return node('div', 'stat', [node('b', '', [text(value)]), node('span', '', [text(label)])]);
}

function metres(m) {
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

function html(s) {
  const t = document.createElement('template');
  t.innerHTML = s.trim();
  return t.content.childNodes.length > 1 ? t.content : t.content.firstChild;
}

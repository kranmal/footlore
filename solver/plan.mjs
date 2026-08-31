// The plan model: turn an ordered list of stops into a timed schedule.
//
// Everything in the builder — the ribbon, the minute deltas on every edit
// button, the "back at 14:47" lines — is read off `schedule()`. There is one
// place that does time arithmetic and this is it.

import { CATALOG } from './fixtures.mjs';
import { legMinutes, streetMetres, DWELL_FACTOR, PACE, clock } from './geo.mjs';

export const place = (id) => {
  const p = CATALOG[id];
  if (!p) throw new Error(`unknown place: ${id}`);
  return p;
};

/**
 * Walk the plan in order, accumulating clock time.
 *
 * The subtle part is `wait`. A stop with a time window (a kitchen) can be
 * arrived at too early, and the person then stands outside a shut door. That
 * waiting is real elapsed time and it counts against the budget, so the cost
 * function used for routing has to see it — otherwise 2-opt happily saves two
 * minutes of walking and buys twenty minutes on a doorstep.
 */
export function schedule(plan) {
  const pace = plan.pace ?? 'stroll';
  const dwellMult = DWELL_FACTOR[pace];
  const legs = [];
  const stops = [];
  const violations = [];

  let t = plan.startTime;
  let here = plan.origin;

  for (const s of plan.stops) {
    const p = place(s.id);
    const minutes = legMinutes(here, p, pace);
    legs.push({
      toId: s.id,
      minutes,
      metres: Math.round(streetMetres(here, p)),
    });

    const arrive = t + minutes;
    let wait = 0;
    if (p.window) {
      const [open, close] = p.window;
      if (arrive < open) wait = open - arrive;
      if (arrive > close) {
        violations.push({
          type: 'window',
          id: s.id,
          message: `${p.name} stops seating at ${clock(close)}; arrival ${clock(arrive)}`,
          lateBy: arrive - close,
        });
      }
    }
    const dwell = Math.round(p.dwell * (p.window ? 1 : dwellMult));
    const depart = arrive + wait + dwell;

    stops.push({ ...s, name: p.name, kind: p.kind, arrive, wait, dwell, depart, why: p.why });
    t = depart;
    here = p;
  }

  if (plan.returnToOrigin) {
    const minutes = legMinutes(here, plan.origin, pace);
    legs.push({ toId: '__origin', minutes, metres: Math.round(streetMetres(here, plan.origin)) });
    t += minutes;
  }

  const walking = legs.reduce((n, l) => n + l.minutes, 0);
  const dwelling = stops.filter((s) => !place(s.id).window).reduce((n, s) => n + s.dwell, 0);
  const mealTime = stops.filter((s) => place(s.id).window).reduce((n, s) => n + s.dwell, 0);
  const waiting = stops.reduce((n, s) => n + s.wait, 0);
  const total = t - plan.startTime;

  return {
    legs, stops, violations,
    walking, dwelling, mealTime, waiting,
    total,
    finish: t,
    finishLabel: clock(t),
    budget: plan.budget,
    overBy: total - plan.budget,
    feasible: violations.length === 0,
    metres: legs.reduce((n, l) => n + l.metres, 0),
  };
}

/**
 * Routing cost. Walking plus waiting — never walking alone.
 * Over-budget time is penalised so an infeasible ordering can still be compared
 * against another infeasible one while the solver is mid-search.
 *
 * Walking is measured in unrounded metres, NOT in the whole minutes shown on
 * screen. Rounding to the minute makes genuinely different routes tie, and a
 * tie means 2-opt stops at whichever it happened to reach first — which is how
 * you end up with a visibly crossed route whose numbers look perfectly fine.
 * Display rounds; the solver must not.
 */
export function routeCost(plan) {
  const s = schedule(plan);
  const lateness = s.violations.reduce((n, v) => n + (v.lateBy ?? 0), 0);
  const walkExact = s.metres / PACE[plan.pace ?? 'stroll'];
  return walkExact + s.waiting + lateness * 10;
}

/** One-line summary used in test output and in the diff copy. */
export function summarise(plan) {
  const s = schedule(plan);
  return `${plan.stops.map((x) => x.id).join(' > ')} | walk ${s.walking} + stops ${s.dwelling} + meal ${s.mealTime} + wait ${s.waiting} = ${s.total}/${s.budget}m, back ${s.finishLabel}${s.feasible ? '' : ' [INFEASIBLE]'}`;
}

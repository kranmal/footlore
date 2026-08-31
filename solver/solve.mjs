// Greedy-insertion solve, used for a fresh walk and for any full re-solve.
//
// Order of operations matters and is the same every time:
//   pinned stops  ->  meal anchor  ->  greedy insertion  ->  2-opt
//
// The meal goes in before anything else is inserted because its time window is
// the only hard constraint in the problem; letting it be chosen last means
// routinely discovering at the end that the kitchen shut twenty minutes ago.

import { CATALOG } from './fixtures.mjs';
import { schedule, place } from './plan.mjs';
import { improve } from './twoopt.mjs';

const has = (stops, id) => stops.some((s) => s.id === id);

/** Cheapest legal position to insert `id`, honouring pinned indices. */
function bestInsertion(plan, id) {
  let best = null;
  for (let pos = 0; pos <= plan.stops.length; pos++) {
    // Inserting before a pinned stop shifts its index, which pinning forbids.
    if (plan.stops.slice(pos).some((s) => s.pinned)) continue;
    const stops = [...plan.stops.slice(0, pos), { id, pinned: false }, ...plan.stops.slice(pos)];
    const s = schedule({ ...plan, stops });
    if (!s.feasible) continue;
    const cost = s.total - schedule(plan).total;
    if (!best || cost < best.cost) best = { pos, cost, total: s.total };
  }
  return best;
}

/**
 * @param {object} base      plan skeleton: origin, startTime, budget, pace, returnToOrigin
 * @param {object} opts
 * @param {string[]} opts.keep      stop ids to preserve (pins), in order
 * @param {string|null} opts.mealId anchor restaurant, or null for no meal
 * @param {string[]} opts.exclude   ids to leave out (recently shown, or dropped by hand)
 */
export function solve(base, { keep = [], mealId = null, exclude = [] } = {}) {
  let plan = {
    ...base,
    orderLocked: false,
    stops: keep.map((id) => ({ id, pinned: true })),
  };

  if (mealId) {
    const ins = bestInsertion(plan, mealId);
    if (!ins) return { plan, ok: false, reason: 'meal-window-infeasible' };
    plan = { ...plan, stops: [...plan.stops.slice(0, ins.pos), { id: mealId, pinned: false, anchor: true }, ...plan.stops.slice(ins.pos)] };
  }

  const candidates = Object.values(CATALOG)
    .filter((p) => p.kind === 'see' && !has(plan.stops, p.id) && !exclude.includes(p.id))
    .sort((a, b) => b.score - a.score);

  let inserting = true;
  while (inserting) {
    inserting = false;
    let pick = null;
    for (const c of candidates) {
      if (has(plan.stops, c.id)) continue;
      const ins = bestInsertion(plan, c.id);
      if (!ins || ins.total > plan.budget) continue;
      const value = c.score / Math.max(ins.cost, 1); // score per added minute
      if (!pick || value > pick.value) pick = { id: c.id, ...ins, value };
    }
    if (pick) {
      plan = { ...plan, stops: [...plan.stops.slice(0, pick.pos), { id: pick.id, pinned: false }, ...plan.stops.slice(pick.pos)] };
      inserting = true;
    }
  }

  const improved = improve(plan, 'solve');
  return { plan: improved.plan, ok: true, twoOpt: improved };
}

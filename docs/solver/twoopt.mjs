// 2-opt route improvement, constrained.
//
// Two rules make this different from textbook 2-opt:
//
//  1. A pinned stop must keep its index. Pinning is the user's one hard lever;
//     a solver that "improves" a pinned stop into a different slot is the
//     single fastest way to lose their trust in the plan.
//  2. Cost is walking + waiting (see plan.js). Reversing a segment can shave
//     walking while pushing arrival at the restaurant before it opens, which is
//     a worse afternoon by any honest measure.
//
// Never call this on a plan the user has hand-ordered — see `improve()`.

import { routeCost } from './plan.mjs';

function reverseSegment(order, i, j) {
  return [
    ...order.slice(0, i),
    ...order.slice(i, j + 1).reverse(),
    ...order.slice(j + 1),
  ];
}

/** Every pinned stop must sit at the same index it started at. */
function pinsHeld(original, candidate) {
  for (let k = 0; k < original.length; k++) {
    if (original[k].pinned && candidate[k].id !== original[k].id) return false;
  }
  return true;
}

/**
 * @returns {{plan, improved:boolean, passes:number, from:number, to:number}}
 */
export function twoOpt(plan, { maxPasses = 12 } = {}) {
  if (plan.orderLocked) {
    return { plan, improved: false, passes: 0, from: routeCost(plan), to: routeCost(plan), skipped: 'orderLocked' };
  }

  let best = plan.stops;
  let bestCost = routeCost({ ...plan, stops: best });
  const startCost = bestCost;
  let passes = 0;
  let improving = true;

  while (improving && passes < maxPasses) {
    improving = false;
    passes++;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = reverseSegment(best, i, j);
        if (!pinsHeld(plan.stops, candidate)) continue;
        const cost = routeCost({ ...plan, stops: candidate });
        if (cost < bestCost - 1e-9) {
          best = candidate;
          bestCost = cost;
          improving = true;
        }
      }
    }
  }

  return {
    plan: { ...plan, stops: best },
    improved: bestCost < startCost,
    passes,
    from: startCost,
    to: bestCost,
  };
}

/**
 * The only sanctioned entry point for reordering.
 *
 * `improve` runs on a fresh solve or a full re-solve. It refuses to touch a
 * plan whose order the user set by hand: honouring a worse hand-made order is
 * the correct behaviour, and quietly fixing it is not.
 */
export function improve(plan, reason) {
  if (plan.orderLocked && reason !== 'user-requested-rebuild') {
    return { plan, improved: false, skipped: 'orderLocked' };
  }
  return twoOpt({ ...plan, orderLocked: false });
}

// Edit semantics: what each gesture does to the plan.
//
// This file is the contract the walk builder UI is written against. The rule
// behind all of it: the plan may only change in ways the person can predict and
// see. Freed time is offered, never spent. A hand-made order is honoured even
// when it is worse. A re-solve reports a diff rather than presenting a new list
// and hoping nobody notices.

import { schedule, place } from './plan.mjs';
import { solve } from './solve.mjs';
import { improve } from './twoopt.mjs';
import { clock } from './geo.mjs';

const ids = (plan) => plan.stops.map((s) => s.id);

/**
 * Compare two plans the way a person would read the change.
 * Returned verbatim to the UI — "Added King Street, dropped nothing".
 */
export function diff(before, after) {
  const a = ids(before);
  const b = ids(after);
  const added = b.filter((id) => !a.includes(id));
  const removed = a.filter((id) => !b.includes(id));
  // Compare relative order of the stops present in both, so an insertion
  // elsewhere doesn't report every later stop as "moved".
  const keptA = a.filter((id) => b.includes(id));
  const keptB = b.filter((id) => a.includes(id));
  const moved = keptB.filter((id) => keptA.indexOf(id) !== keptB.indexOf(id));
  const sb = schedule(before);
  const sa = schedule(after);

  const phrase = [];
  if (added.length) phrase.push(`added ${added.map((id) => place(id, after.catalog).name).join(', ')}`);
  if (removed.length) phrase.push(`dropped ${removed.map((id) => place(id, before.catalog).name).join(', ')}`);
  if (!added.length && !removed.length && moved.length) phrase.push(`reordered ${moved.length} stop${moved.length > 1 ? 's' : ''}`);
  if (!phrase.length) phrase.push('nothing changed');

  return {
    added, removed, moved,
    minutes: sa.total - sb.total,
    finishShift: sa.finish - sb.finish,
    summary: `${phrase.join(', ')} · back at ${sa.finishLabel}`,
  };
}

/**
 * @param {object} plan
 * @param {object} edit  {type, ...}
 * @returns {{plan, diff, offer?, warning?, note?}}
 */
export function applyEdit(plan, edit) {
  switch (edit.type) {

    // --- pin ------------------------------------------------------------
    // A constraint, nothing more. Never triggers a re-solve on its own: the
    // person is telling you what to protect, not asking for a new walk.
    case 'pin':
    case 'unpin': {
      const next = {
        ...plan,
        stops: plan.stops.map((s) => (s.id === edit.id ? { ...s, pinned: edit.type === 'pin' } : s)),
      };
      return { plan: next, diff: diff(plan, next), note: edit.type === 'pin' ? `${place(edit.id, plan.catalog).name} will stay put` : null };
    }

    // --- swap -----------------------------------------------------------
    // Only that slot re-solves. Order and every other stop are held, so the
    // minute delta shown on the button is exactly what the person gets.
    case 'swap': {
      const idx = plan.stops.findIndex((s) => s.id === edit.id);
      if (idx < 0) throw new Error(`not in plan: ${edit.id}`);
      const next = {
        ...plan,
        stops: plan.stops.map((s, i) => (i === idx ? { ...s, id: edit.withId } : s)),
      };
      const d = diff(plan, next);
      return {
        plan: next,
        diff: d,
        warning: schedule(next).feasible ? null : 'that swap breaks the lunch booking',
      };
    }

    // --- drop -----------------------------------------------------------
    // The freed minutes are OFFERED. Auto-filling the gap is the behaviour
    // that makes planners feel like they are arguing with you.
    case 'drop': {
      const next = { ...plan, stops: plan.stops.filter((s) => s.id !== edit.id) };
      const d = diff(plan, next);
      const freed = -d.minutes;
      const alt = solve({ ...next, budget: plan.budget }, {
        keep: next.stops.filter((s) => s.pinned).map((s) => s.id),
        mealId: next.stops.find((s) => place(s.id, plan.catalog).window)?.id ?? null,
        exclude: [edit.id],
      });
      const suggestion = alt.ok ? alt.plan.stops.map((s) => s.id).find((id) => !ids(next).includes(id)) : null;
      return {
        plan: next,
        diff: d,
        offer: {
          freedMinutes: freed,
          options: [
            { label: `Finish ${freed} min earlier`, action: { type: 'noop' }, finish: clock(schedule(next).finish) },
            suggestion
              ? { label: `Add ${place(suggestion, plan.catalog).name} instead`, action: { type: 'add', id: suggestion } }
              : { label: 'Nothing else fits nearby', action: null },
          ],
        },
      };
    }

    // --- add ------------------------------------------------------------
    case 'add': {
      const next = { ...plan, stops: [...plan.stops, { id: edit.id, pinned: false }] };
      const reordered = improve(next, 'solve');
      return { plan: reordered.plan, diff: diff(plan, reordered.plan) };
    }

    // --- reorder --------------------------------------------------------
    // Honoured exactly, even when it is worse. Sets orderLocked, which stops
    // every later solve from quietly undoing it.
    case 'reorder': {
      const stops = [...plan.stops];
      const [moved] = stops.splice(edit.from, 1);
      stops.splice(edit.to, 0, moved);
      const next = { ...plan, stops, orderLocked: true };
      const s = schedule(next);
      return {
        plan: next,
        diff: diff(plan, next),
        warning: s.overBy > 0
          ? `That order runs ${s.overBy} min over — drop a stop, or finish at ${s.finishLabel}?`
          : null,
      };
    }

    // --- budget change --------------------------------------------------
    // Full re-solve, pins preserved, result reported as a diff.
    case 'setBudget': {
      const res = solve({ ...plan, budget: edit.minutes }, {
        keep: plan.stops.filter((s) => s.pinned).map((s) => s.id),
        mealId: plan.stops.find((s) => place(s.id, plan.catalog).window)?.id ?? null,
      });
      if (!res.ok) return { plan, diff: diff(plan, plan), warning: res.reason };
      return { plan: res.plan, diff: diff(plan, res.plan) };
    }

    // --- rebuild --------------------------------------------------------
    // A visibly different walk, not the same one shuffled: everything just
    // shown is excluded unless it is pinned.
    case 'rebuild': {
      const pins = plan.stops.filter((s) => s.pinned).map((s) => s.id);
      const res = solve(plan, {
        keep: pins,
        mealId: plan.stops.find((s) => place(s.id, plan.catalog).window)?.id ?? null,
        exclude: ids(plan).filter((id) => !pins.includes(id)),
      });
      if (!res.ok) return { plan, diff: diff(plan, plan), warning: res.reason };
      return { plan: res.plan, diff: diff(plan, res.plan) };
    }

    default:
      throw new Error(`unknown edit: ${edit.type}`);
  }
}

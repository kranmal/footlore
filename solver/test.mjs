// Behavioural tests for the two decisions the walk builder rests on:
// constrained 2-opt, and edit semantics.
//
//   node solver/test.mjs

import { baselinePlan, ORIGIN, CATALOG } from './fixtures.mjs';
import { schedule, summarise, routeCost } from './plan.mjs';
import { twoOpt, improve } from './twoopt.mjs';
import { applyEdit, diff } from './edits.mjs';
import { solve } from './solve.mjs';
import { hm, clock, countCrossings } from './geo.mjs';

let pass = 0, fail = 0;
const results = [];

function test(name, fn) {
  try {
    const note = fn();
    pass++;
    results.push(`  ok   ${name}${note ? `\n         ${note}` : ''}`);
  } catch (e) {
    fail++;
    results.push(`  FAIL ${name}\n         ${e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}\n         got:      ${JSON.stringify(a)}\n         expected: ${JSON.stringify(b)}`);
const ids = (p) => p.stops.map((s) => s.id);
const m1 = (n) => `${n.toFixed(1)}m`;

console.log('\n\x1b[1mWALK BUILDER — 2-opt\x1b[0m\n');

test('untangles a deliberately crossed route', () => {
  const crossed = {
    ...baselinePlan(),
    stops: [
      { id: 'stjohn', pinned: false },
      { id: 'queensq', pinned: false },
      { id: 'stnicks', pinned: false },
      { id: 'llandoger', pinned: false },
    ],
  };
  const pts = (p) => [ORIGIN, ...p.stops.map((s) => CATALOG[s.id])];
  const before = countCrossings(pts(crossed));
  const r = twoOpt(crossed);
  const after = countCrossings(pts(r.plan));
  assert(before > 0, 'fixture should start with a crossing');
  assert(after < before, `crossings not reduced (${before} -> ${after})`);
  assert(r.to < r.from, 'cost did not fall');
  return `${before} crossing -> ${after}; cost ${m1(r.from)} -> ${m1(r.to)} on foot in ${r.passes} passes\n         ${ids(crossed).join(' > ')}\n         ${ids(r.plan).join(' > ')}`;
});

test('never moves a pinned stop, even when moving it would be cheaper', () => {
  const free = { ...baselinePlan(), stops: [
    { id: 'stjohn', pinned: false }, { id: 'queensq', pinned: false },
    { id: 'stnicks', pinned: false }, { id: 'llandoger', pinned: false },
  ] };
  const pinned = { ...free, stops: free.stops.map((s, i) => (i === 1 ? { ...s, pinned: true } : s)) };
  const freeR = twoOpt(free);
  const pinR = twoOpt(pinned);
  assert(ids(freeR.plan)[1] !== 'queensq', 'unpinned control should have moved the stop');
  eq(ids(pinR.plan)[1], 'queensq', 'pinned stop moved out of its slot');
  assert(pinR.to >= freeR.to, 'pinned result should be no better than free');
  return `free: ${ids(freeR.plan).join(' > ')} (${m1(freeR.to)})\n         pinned: ${ids(pinR.plan).join(' > ')} (${m1(pinR.to)}) — held index 1`;
});

test('prefers a longer walk over waiting outside a shut kitchen', () => {
  // The Ox opens at 13:30. Reaching it first means standing about.
  const base = { origin: ORIGIN, startTime: hm('12:30'), budget: 160, pace: 'stroll', returnToOrigin: true, orderLocked: false };
  const eager = { ...base, stops: [
    { id: 'latelunch', pinned: false },
    { id: 'castlepark', pinned: false },
    { id: 'xmassteps', pinned: false },
  ] };
  const s0 = schedule(eager);
  assert(s0.waiting > 0, 'fixture should start with a wait');
  const r = twoOpt(eager);
  const s1 = schedule(r.plan);
  assert(s1.waiting < s0.waiting, `wait not reduced (${s0.waiting} -> ${s1.waiting})`);
  assert(s1.total < s0.total, 'total elapsed should fall');
  return `wait ${s0.waiting} -> ${s1.waiting} min, total ${s0.total} -> ${s1.total} min\n         walking-only cost would have preferred the ${s1.walking >= s0.walking ? 'shorter' : 'same'} walk: ${s0.walking} -> ${s1.walking} min on foot`;
});

test('refuses to reorder a plan the user hand-ordered', () => {
  const p = { ...baselinePlan(), orderLocked: true, stops: [
    { id: 'queensq', pinned: false }, { id: 'stjohn', pinned: false },
    { id: 'bianchis', pinned: false }, { id: 'stnicks', pinned: false },
  ] };
  const r = improve(p, 'solve');
  eq(ids(r.plan), ids(p), 'hand-made order was silently changed');
  eq(r.skipped, 'orderLocked', 'should report why it declined');
  return 'order preserved; solver stood down';
});

console.log('\n\x1b[1mWALK BUILDER — edit semantics\x1b[0m\n');

const base = baselinePlan();

test('baseline walk fits its budget and makes the lunch window', () => {
  const s = schedule(base);
  assert(s.feasible, `infeasible: ${JSON.stringify(s.violations)}`);
  assert(s.total <= s.budget, `over budget by ${s.overBy}`);
  const lunch = s.stops.find((x) => x.id === 'bianchis');
  assert(lunch.arrive <= CATALOG.bianchis.window[1], 'arrives after last seating');
  return summarise(base);
});

test('swap changes only that slot, and prices itself honestly', () => {
  const r = applyEdit(base, { type: 'swap', id: 'exchange', withId: 'llandoger' });
  eq(ids(r.plan), ['stjohn', 'llandoger', 'stnicks', 'bianchis', 'queensq'], 'order should be untouched');
  eq(r.diff.added, ['llandoger'], 'wrong add');
  eq(r.diff.removed, ['exchange'], 'wrong remove');
  eq(r.diff.moved, [], 'nothing else may move');
  return `${r.diff.summary} (${r.diff.minutes >= 0 ? '+' : ''}${r.diff.minutes} min)`;
});

test('drop offers the freed minutes instead of spending them', () => {
  const r = applyEdit(base, { type: 'drop', id: 'exchange' });
  assert(!ids(r.plan).includes('exchange'), 'stop not removed');
  eq(ids(r.plan).length, 4, 'nothing may be auto-added');
  assert(r.offer.freedMinutes > 0, 'no minutes reported free');
  assert(r.offer.options.length === 2, 'both options should be offered');
  return `freed ${r.offer.freedMinutes} min → "${r.offer.options[0].label}" / "${r.offer.options[1].label}"`;
});

test('reorder is obeyed exactly, even when it is worse', () => {
  const r = applyEdit(base, { type: 'reorder', from: 4, to: 1 });
  eq(ids(r.plan), ['stjohn', 'queensq', 'exchange', 'stnicks', 'bianchis'], 'order not honoured');
  assert(r.plan.orderLocked, 'orderLocked not set');
  const after = improve(r.plan, 'solve');
  eq(ids(after.plan), ids(r.plan), 'a later solve undid the hand order');
  return `${r.warning ?? 'still within budget'}`;
});

test('a hand-ordered plan that overruns says so instead of fixing itself', () => {
  const tight = { ...base, budget: 100 };
  const r = applyEdit(tight, { type: 'reorder', from: 4, to: 0 });
  assert(schedule(r.plan).overBy > 0, 'fixture should overrun');
  assert(r.warning && /over/.test(r.warning), 'no warning offered');
  return r.warning;
});

test('pinning is a constraint, not a re-solve', () => {
  const r = applyEdit(base, { type: 'pin', id: 'stnicks' });
  eq(ids(r.plan), ids(base), 'pinning changed the walk');
  assert(r.plan.stops.find((s) => s.id === 'stnicks').pinned, 'pin not recorded');
  return r.note;
});

test('budget change re-solves, keeps pins, and reports a diff', () => {
  const r = applyEdit(base, { type: 'setBudget', minutes: 165 });
  assert(r.plan.stops.length > base.stops.length, 'extra time bought nothing');
  assert(r.plan.stops.find((s) => s.id === 'stjohn'), 'pinned stop was dropped');
  eq(r.plan.stops[0].id, 'stjohn', 'pinned stop left its slot');
  assert(r.plan.stops.some((s) => s.id === 'bianchis'), 'lunch anchor lost');
  assert(schedule(r.plan).feasible, 're-solve produced an infeasible walk');
  assert(schedule(r.plan).total <= 165, 're-solve blew the new budget');
  return `${r.diff.summary}\n         ${summarise(r.plan)}`;
});

test('rebuild returns a visibly different walk, not a shuffle', () => {
  const r = applyEdit(base, { type: 'rebuild' });
  const shared = ids(r.plan).filter((id) => ids(base).includes(id) && id !== 'stjohn' && id !== 'bianchis');
  eq(shared, [], `unpinned stops were reused: ${shared.join(', ')}`);
  eq(r.plan.stops[0].id, 'stjohn', 'pin not respected on rebuild');
  return `${ids(base).join(' > ')}\n         ${ids(r.plan).join(' > ')}`;
});

test('an unreachable kitchen is caught before the walk is proposed', () => {
  const late = { origin: ORIGIN, startTime: hm('14:20'), budget: 120, pace: 'stroll', returnToOrigin: true };
  const res = solve(late, { keep: ['cathedral'], mealId: 'bianchis' });
  assert(!res.ok, 'should have refused: Bianchis stops seating at 14:30');
  eq(res.reason, 'meal-window-infeasible', 'wrong failure reason');
  return 'refused with meal-window-infeasible → UI offers an earlier meal, a cut stop, or a takeaway';
});

console.log(results.join('\n'));
console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);

// Tests for both caches — the disk one the server uses and the localStorage one
// the static build uses.
//
// These exist because of a specific bug that reached the live site: a broken
// Overpass mirror answered 200 with an empty database, the empty list was
// cached under `TTL.osm`, and for the next week the app told people standing in
// central Bristol that nothing was mapped around them. The guard against the
// bad response lives in overpass.mjs; these are the two things that stop such
// an answer from outliving the request that caused it.
//
//   node server/cache.test.mjs

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32mok  \x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `\n         ${detail}` : ''}`); }
};
const eq = (name, got, want) => ok(name, got === want,
  `got:      ${JSON.stringify(got)}\n         expected: ${JSON.stringify(want)}`);

console.log('\n\x1b[1mdisk cache\x1b[0m\n');

const dir = await mkdtemp(join(tmpdir(), 'footlore-cache-'));
process.env.FOOTLORE_CACHE = dir;
const disk = await import('./cache.mjs');

{
  let calls = 0;
  const empty = async () => { calls += 1; return []; };

  const first = await disk.through('osm-food', 'tile', disk.TTL.osm, empty);
  eq('an empty answer is returned as normal', first.cached, false);
  const second = await disk.through('osm-food', 'tile', disk.TTL.osm, empty);
  // The whole point: the second caller asks again rather than being handed a
  // week-old "nothing is here".
  eq('and is not served from cache next time', second.cached, false);
  eq('so the provider was asked both times', calls, 2);
}

{
  let calls = 0;
  const places = async () => { calls += 1; return [{ id: 'n1' }]; };
  await disk.through('osm', 'tile', disk.TTL.osm, places);
  const hit = await disk.through('osm', 'tile', disk.TTL.osm, places);
  eq('a real answer is cached', hit.cached, true);
  eq('and the provider is asked once', calls, 1);
}

// Not everything stored is a list; only an empty list is refused. An article
// lookup that legitimately found nothing is still worth remembering.
const blank = async () => ({});
await disk.through('wiki', 'q1', disk.TTL.wiki, blank);
eq('an empty object is still cached', (await disk.through('wiki', 'q1', disk.TTL.wiki, blank)).cached, true);

// The generation bump is what abandons entries written before the fix.
ok('entries live under a versioned directory', Object.keys(await disk.stats()).includes('osm'));

await rm(dir, { recursive: true, force: true });

console.log('\n\x1b[1mbrowser cache\x1b[0m\n');

// Enough of localStorage for the module under test: the real one is a string
// map with an index, and the index is what the sweep walks.
const items = new Map();
globalThis.window = {
  localStorage: {
    get length() { return items.size; },
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
  },
};

// A tile poisoned by the old bug, written under the old prefix.
items.set('fl.cache.osm-food.51.4545_-2.5940_900', JSON.stringify({ t: Date.now(), v: [] }));
items.set('somebody.elses.key', 'left alone');

const web = await import('./cache.browser.mjs');

eq('a pre-fix entry is gone after first use', await web.get('osm-food', '51.4545_-2.5940_900'), null);
ok('the old key is swept, not just ignored',
  ![...items.keys()].some((key) => key.startsWith('fl.cache.') && !key.startsWith('fl.cache.v2.')),
  [...items.keys()].join(', '));
ok('another app\'s keys are untouched', items.has('somebody.elses.key'));

{
  let calls = 0;
  const empty = async () => { calls += 1; return []; };
  await web.through('osm-food', 'tile', web.TTL.osm, empty);
  const again = await web.through('osm-food', 'tile', web.TTL.osm, empty);
  eq('an empty answer is not kept here either', again.cached, false);
  eq('so the provider was asked both times', calls, 2);
}

{
  const places = async () => [{ id: 'n1' }];
  await web.through('osm', 'tile', web.TTL.osm, places);
  eq('a real answer is cached', (await web.through('osm', 'tile', web.TTL.osm, places)).cached, true);
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);

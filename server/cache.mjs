// Disk cache, keyed by tile or by place id.
//
// This is the whole reason the client never talks to a provider directly.
// Overpass is slow and rate-limited, Wikipedia is polite-use, and narration
// costs money — all three want caching at different lifetimes, and only the
// backend can do that.

import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// FOOTLORE_CACHE lets a host point this at a writable volume; the default keeps
// the cache next to the code so it survives a restart in development.
const BASE = process.env.FOOTLORE_CACHE ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.cache');
// Bumped when a bug means entries already on disk cannot be trusted. v2: before
// the stale-mirror guard in overpass.mjs, a mirror answering 200 with an empty
// database got its "nothing is mapped here" cached for a week. The guard stops
// new ones; nothing reaches the poisoned entries already written, so the whole
// generation is abandoned instead. Old directories are left alone rather than
// deleted — this process is not the only thing that may have a view on them.
const ROOT = join(BASE, 'v2');

export const TTL = {
  osm: 7 * 24 * 60 * 60 * 1000,      // street furniture barely moves
  wiki: 30 * 24 * 60 * 60 * 1000,    // articles change slowly
  narration: Infinity,               // the story doesn't change; pay once
};

const safe = (s) => String(s).replace(/[^a-z0-9._-]/gi, '_');

// Directories are created once per process, not once per read: a feed makes
// dozens of cache lookups and each used to start with an mkdir syscall.
const made = new Set();
async function path(ns, key) {
  const dir = join(ROOT, safe(ns));
  if (!made.has(dir)) {
    await mkdir(dir, { recursive: true });
    made.add(dir);
  }
  return join(dir, `${safe(key)}.json`);
}

// Hot entries live in memory too, so a repeat request never touches the disk.
// Capped and insertion-ordered like `recent` in index.mjs: this process is meant
// to stay up for weeks. Each entry keeps its write time so TTLs behave exactly
// as they do on disk.
const MEM_MAX = 2000;
const mem = new Map();

function remember(id, t, value) {
  mem.delete(id);
  mem.set(id, { t, value });
  while (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
}

export async function get(ns, key, ttl = TTL.osm) {
  const id = `${ns}\0${key}`;
  const hot = mem.get(id);
  if (hot) {
    if (ttl === Infinity || Date.now() - hot.t <= ttl) return hot.value;
    return null;
  }
  try {
    const p = await path(ns, key);
    const s = await stat(p);
    const value = JSON.parse(await readFile(p, 'utf8'));
    remember(id, s.mtimeMs, value);
    if (ttl !== Infinity && Date.now() - s.mtimeMs > ttl) return null;
    return value;
  } catch {
    return null;
  }
}

export async function set(ns, key, value) {
  remember(`${ns}\0${key}`, Date.now(), value);
  await writeFile(await path(ns, key), JSON.stringify(value), 'utf8');
  return value;
}

// Two people on the same street corner ask for the same tile within seconds of
// each other, and a cold Overpass call can take half a minute. Without this the
// second request starts its own query and both wait; with it they share one.
const inflight = new Map();

/** get-or-compute. Every provider call in the app goes through this. */
export function through(ns, key, ttl, fn) {
  const id = `${ns}\0${key}`;
  if (inflight.has(id)) return inflight.get(id).then((r) => ({ ...r, cached: true }));
  const run = compute(ns, key, ttl, fn).finally(() => inflight.delete(id));
  inflight.set(id, run);
  return run;
}

async function compute(ns, key, ttl, fn) {
  const hit = await get(ns, key, ttl);
  if (hit !== null) return { value: hit, cached: true };
  const value = await fn();
  // An empty list is never worth a week. Every array stored here is a list of
  // places, and "no places" is both the cheapest answer to ask for again and
  // the most expensive one to be wrong about: cached, it tells somebody
  // standing in a city centre that nothing is around them, and keeps telling
  // them until the TTL runs out. Re-asking costs one query.
  if (!(Array.isArray(value) && value.length === 0)) await set(ns, key, value);
  return { value, cached: false };
}

export async function stats() {
  const out = {};
  try {
    for (const ns of await readdir(ROOT)) {
      out[ns] = (await readdir(join(ROOT, ns))).length;
    }
  } catch { /* no cache yet */ }
  return out;
}

/**
 * Tile key. Requests get snapped to a ~150 m grid so two people standing on
 * the same street corner share one Overpass call instead of making two.
 */
export function tileKey(lat, lng, radius) {
  const g = 0.0015;
  return `${(Math.round(lat / g) * g).toFixed(4)}_${(Math.round(lng / g) * g).toFixed(4)}_${radius}`;
}

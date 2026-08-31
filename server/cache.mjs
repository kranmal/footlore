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
const ROOT = process.env.FOOTLORE_CACHE ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.cache');

export const TTL = {
  osm: 7 * 24 * 60 * 60 * 1000,      // street furniture barely moves
  wiki: 30 * 24 * 60 * 60 * 1000,    // articles change slowly
  narration: Infinity,               // the story doesn't change; pay once
};

const safe = (s) => String(s).replace(/[^a-z0-9._-]/gi, '_');

async function path(ns, key) {
  const dir = join(ROOT, safe(ns));
  await mkdir(dir, { recursive: true });
  return join(dir, `${safe(key)}.json`);
}

export async function get(ns, key, ttl = TTL.osm) {
  try {
    const p = await path(ns, key);
    const s = await stat(p);
    if (ttl !== Infinity && Date.now() - s.mtimeMs > ttl) return null;
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

export async function set(ns, key, value) {
  await writeFile(await path(ns, key), JSON.stringify(value), 'utf8');
  return value;
}

/** get-or-compute. Every provider call in the app goes through this. */
export async function through(ns, key, ttl, fn) {
  const hit = await get(ns, key, ttl);
  if (hit !== null) return { value: hit, cached: true };
  const value = await fn();
  await set(ns, key, value);
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

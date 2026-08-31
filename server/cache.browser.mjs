// Browser cache — the static build's stand-in for the disk cache.
//
// On GitHub Pages there is no server to hold a shared cache, so each visitor
// gets their own in localStorage. That is worse in one way (nobody warms the
// cache for anybody else) and better in another (Overpass rate-limits per IP,
// and now every visitor spends only their own budget).
//
// Same exported shape as cache.mjs, so nothing upstream knows the difference.

const PREFIX = 'fl.cache.';
const BUDGET = 4_000_000;   // ~4 MB of the usual 5 MB localStorage allowance

export const TTL = {
  osm: 7 * 24 * 60 * 60 * 1000,
  wiki: 30 * 24 * 60 * 60 * 1000,
  narration: Infinity,
};

const safe = (s) => String(s).replace(/[^a-z0-9._-]/gi, '_');
const k = (ns, key) => `${PREFIX}${safe(ns)}.${safe(key)}`;

// Private browsing and blocked site-data both throw on access rather than
// returning null, so every entry point has to survive the store not existing.
function store() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export async function get(ns, key, ttl = TTL.osm) {
  const ls = store();
  if (!ls) return null;
  try {
    const raw = ls.getItem(k(ns, key));
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (ttl !== Infinity && Date.now() - t > ttl) return null;
    return v;
  } catch {
    return null;
  }
}

/** Oldest-first eviction, and only within our own prefix. */
function evict(ls, need) {
  const mine = [];
  for (let i = 0; i < ls.length; i += 1) {
    const key = ls.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    let t = 0;
    try { t = JSON.parse(ls.getItem(key)).t ?? 0; } catch { /* corrupt: evict first */ }
    mine.push([key, t, (ls.getItem(key) ?? '').length]);
  }
  mine.sort((a, b) => a[1] - b[1]);
  let freed = 0;
  for (const [key, , size] of mine) {
    ls.removeItem(key);
    freed += size;
    if (freed >= need) return;
  }
}

export async function set(ns, key, value) {
  const ls = store();
  if (!ls) return value;
  const body = JSON.stringify({ t: Date.now(), v: value });
  if (body.length > BUDGET) return value;      // too big to be worth keeping
  try {
    ls.setItem(k(ns, key), body);
  } catch {
    evict(ls, body.length * 2);
    try { ls.setItem(k(ns, key), body); } catch { /* give up quietly */ }
  }
  return value;
}

export async function through(ns, key, ttl, fn) {
  const hit = await get(ns, key, ttl);
  if (hit !== null) return { value: hit, cached: true };
  const value = await fn();
  await set(ns, key, value);
  return { value, cached: false };
}

export async function stats() {
  const ls = store();
  const out = {};
  if (!ls) return out;
  for (let i = 0; i < ls.length; i += 1) {
    const key = ls.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    const ns = key.slice(PREFIX.length).split('.')[0];
    out[ns] = (out[ns] ?? 0) + 1;
  }
  return out;
}

export function tileKey(lat, lng, radius) {
  const g = 0.0015;
  return `${(Math.round(lat / g) * g).toFixed(4)}_${(Math.round(lng / g) * g).toFixed(4)}_${radius}`;
}

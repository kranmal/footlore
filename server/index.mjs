// The whole back end: one dependency-free node:http server.
//
//   GET /api/nearby?lat&lng&radius&limit&seen
//   GET /api/place/:id       (from the tile cache — no provider call)
//   GET /healthz             (for whatever is watching the process)
//   everything else          static files out of web/
//
// The client never holds a key and never talks to a provider. That was the
// architectural decision in the plan; this file is where it is enforced.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nearby } from './places.mjs';

const ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// Last result per tile, so the detail view doesn't re-query Overpass. Capped,
// because this process is meant to stay up for weeks and an unbounded map of
// every place anyone has ever scrolled past is a slow leak. Map preserves
// insertion order, so the oldest key is the first one.
const RECENT_MAX = 4000;
const recent = new Map();

function remember(place) {
  recent.delete(place.id);           // re-insert, so a place still in use stays young
  recent.set(place.id, place);
  while (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value);
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
}

async function handleNearby(url, res) {
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return send(res, 400, { error: 'lat and lng are required' });
  }
  const radius = Math.min(Math.max(Number(url.searchParams.get('radius')) || 900, 200), 3000);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 40);
  const seen = (url.searchParams.get('seen') ?? '').split(',').filter(Boolean);

  try {
    const result = await nearby({ lat, lng, radius, limit, seen });
    for (const p of result.places) remember(p);
    send(res, 200, result);
  } catch (e) {
    console.error(`nearby failed: ${e.message}`);
    send(res, 502, { error: 'could not reach the map data right now', detail: e.message });
  }
}

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 403, { error: 'no' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/healthz') {
    return send(res, 200, {
      ok: true,
      narration: process.env.ANTHROPIC_API_KEY ? 'claude' : 'extractive',
      recent: recent.size,
      uptime: Math.round(process.uptime()),
    });
  }

  if (url.pathname === '/api/nearby') return handleNearby(url, res);

  if (url.pathname.startsWith('/api/place/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/place/'.length));
    const place = recent.get(id);
    return place ? send(res, 200, { place }) : send(res, 404, { error: 'unknown place — reload the feed' });
  }

  if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'no such endpoint' });

  serveStatic(url.pathname, res);
});

// A container stops by signal; without this Node ignores SIGTERM and the host
// eventually kills it, mid-request.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

server.listen(PORT, () => {
  console.log(`footlore on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('no ANTHROPIC_API_KEY — narration runs in extractive mode');
  }
});

// Wikipedia / Wikidata: the actual story.
//
// The join is already done for us — OSM elements carry `wikidata=Q…` or
// `wikipedia=en:Title` tags, which is exactly why the free half of the hybrid
// is worth having. Two batched calls cover a whole tile.

import { through, get, set, TTL } from './cache.mjs';

const UA = 'Footlore/0.1 (personal tour guide; contact via repo)';
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function json(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/** Q-ids -> English Wikipedia titles, 50 at a time. */
async function titlesForWikidata(qids) {
  const out = {};
  const missing = [];
  for (const q of qids) {
    const hit = await get('wd', q, TTL.wiki);
    if (hit !== null) out[q] = hit; else missing.push(q);
  }
  for (const batch of chunk(missing, 50)) {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch.join('|')}` +
      `&props=sitelinks&sitefilter=enwiki&format=json&origin=*`;
    try {
      const data = await json(url);
      for (const q of batch) {
        const title = data.entities?.[q]?.sitelinks?.enwiki?.title ?? null;
        out[q] = title;
        await set('wd', q, title);
      }
    } catch {
      for (const q of batch) out[q] = null;
    }
  }
  return out;
}

/** Titles -> intro extract + thumbnail, 20 at a time. */
async function extractsFor(titles) {
  const out = {};
  const missing = [];
  for (const t of titles) {
    const hit = await get('wiki', t, TTL.wiki);
    if (hit !== null) out[t] = hit; else missing.push(t);
  }
  for (const batch of chunk(missing, 20)) {
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1` +
      `&prop=extracts|pageimages|info&inprop=url&exintro=1&explaintext=1&piprop=thumbnail&pithumbsize=800` +
      // origin=* is what makes this callable from a page; the Wikidata call
      // above already had it, and the omission here only showed up in the browser.
      `&origin=*&titles=${batch.map(encodeURIComponent).join('|')}`;
    try {
      const data = await json(url);
      const pages = Object.values(data.query?.pages ?? {});
      const byTitle = {};
      for (const p of pages) {
        if (p.missing !== undefined) continue;
        byTitle[p.title] = {
          title: p.title,
          extract: (p.extract ?? '').trim(),
          image: p.thumbnail?.source ?? null,
          url: p.fullurl ?? null,
        };
      }
      // Follow any redirects Wikipedia resolved for us.
      const redirects = Object.fromEntries((data.query?.redirects ?? []).map((r) => [r.from, r.to]));
      for (const t of batch) {
        const resolved = byTitle[t] ?? byTitle[redirects[t]] ?? null;
        out[t] = resolved;
        await set('wiki', t, resolved);
      }
    } catch {
      for (const t of batch) out[t] = null;
    }
  }
  return out;
}

/**
 * Attach `extract`, `image`, `wikiTitle`, `wikiUrl` to every place that has one.
 * Mutates nothing; returns new objects.
 */
export async function enrich(places) {
  const needsQ = places.filter((p) => !p.wikipedia && p.wikidata).map((p) => p.wikidata);
  const qTitles = needsQ.length ? await titlesForWikidata([...new Set(needsQ)]) : {};

  const withTitle = places.map((p) => ({
    ...p,
    wikiTitle: p.wikipedia ?? (p.wikidata ? qTitles[p.wikidata] ?? null : null),
  }));

  const titles = [...new Set(withTitle.map((p) => p.wikiTitle).filter(Boolean))];
  const extracts = titles.length ? await extractsFor(titles) : {};

  return withTitle.map((p) => {
    const e = p.wikiTitle ? extracts[p.wikiTitle] : null;
    return e
      ? { ...p, extract: e.extract, image: e.image, wikiUrl: e.url, source: 'Wikipedia' }
      : { ...p, extract: null, image: null, wikiUrl: null, source: 'OpenStreetMap' };
  });
}

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
  const hits = await Promise.all(qids.map((q) => get('wd', q, TTL.wiki)));
  qids.forEach((q, i) => { if (hits[i] !== null) out[q] = hits[i]; else missing.push(q); });
  // Batches are independent, so they go out together rather than one after another.
  await Promise.all(chunk(missing, 50).map(async (batch) => {
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch.join('|')}` +
      `&props=sitelinks&sitefilter=enwiki&format=json&origin=*`;
    try {
      const data = await json(url);
      await Promise.all(batch.map((q) => {
        const title = data.entities?.[q]?.sitelinks?.enwiki?.title ?? null;
        out[q] = title;
        return set('wd', q, title);
      }));
    } catch {
      for (const q of batch) out[q] = null;
    }
  }));
  return out;
}

/** Titles -> intro extract + thumbnail, 20 at a time. */
async function extractsFor(titles) {
  const out = {};
  const missing = [];
  const hits = await Promise.all(titles.map((t) => get('wiki', t, TTL.wiki)));
  titles.forEach((t, i) => { if (hits[i] !== null) out[t] = hits[i]; else missing.push(t); });
  await Promise.all(chunk(missing, 20).map(async (batch) => {
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
      await Promise.all(batch.map((t) => {
        const resolved = byTitle[t] ?? byTitle[redirects[t]] ?? null;
        out[t] = resolved;
        return set('wiki', t, resolved);
      }));
    } catch {
      for (const t of batch) out[t] = null;
    }
  }));
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

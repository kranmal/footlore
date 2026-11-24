// The nearby feed. Three tabs, one fetch each, one list, one detail sheet.

import { loadNearby, QUOTING_NOTE } from './api.js';
import { buildWalk, renderWalk, BUDGETS } from './walkview.js';
import { renderMap } from './mapview.js';
// Everything interesting happens behind api.js; this file just shows it.

const BRISTOL = { lat: 51.4546, lng: -2.5945, label: 'Corn Street, Bristol' };
const RADII = [500, 900, 1500, 2500];

// The tabs. `rated: false` on food and shops is the honest part: OpenStreetMap
// carries no ratings, so those two lists are ordered by distance and by how
// much is recorded — never by quality — and the UI has to say so.
const TABS = [
  { kind: 'see', title: 'Sights', empty: 'Nothing worth stopping for' },
  { kind: 'food', title: 'Food', empty: 'Nowhere to eat is mapped' },
  { kind: 'shop', title: 'Shops', empty: 'No shops are mapped' },
  // Walk is the odd one out: it fetches nothing of its own, it orders what the
  // other tabs already loaded. Kept in the same list so the tab wiring below
  // stays one loop rather than a special case.
  { kind: 'walk', title: 'Walk', empty: 'No walk to build' },
  // Map is the same walk drawn on tiles: same solve, same controls, no extra fetch.
  { kind: 'map', title: 'Map', empty: 'No walk to draw' },
];

const el = (id) => document.getElementById(id);
const feed = el('feed'), status = el('status'), sheet = el('sheet');

let radius = 900;
let kind = 'see';
let here = null;
const seen = new Set(JSON.parse(localStorage.getItem('footlore.seen') ?? '[]'));
// Per-tab results, so switching back doesn't re-run the whole pipeline.
const results = new Map();
let places = [];
let budget = 90;
let wantMeal = false;

/** Ask the browser, fall back to Bristol — the app should never show nothing. */
function locate() {
  // ?lat=&lng= stands somewhere else on purpose: for testing thin areas, and
  // for the honest use of looking at a place before you go there.
  const q = new URLSearchParams(location.search);
  if (q.has('lat') && q.has('lng')) {
    return Promise.resolve({ lat: +q.get('lat'), lng: +q.get('lng'), label: 'pinned location', pinned: true });
  }
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ ...BRISTOL, fallback: true });
    const done = (v) => resolve(v);
    navigator.geolocation.getCurrentPosition(
      (pos) => done({ lat: +pos.coords.latitude.toFixed(5), lng: +pos.coords.longitude.toFixed(5), label: 'your location' }),
      () => done({ ...BRISTOL, fallback: true }),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    );
  });
}

function skeletons(n = 4) {
  feed.replaceChildren(...Array.from({ length: n }, () => {
    const d = document.createElement('div');
    d.className = 'skeleton';
    return d;
  }));
}

/**
 * A link that hands the walk to whatever map app the phone actually has:
 * Apple Maps on iOS and macOS, Google Maps everywhere else. Both open the
 * installed app when there is one and the website when there isn't, and both
 * start from wherever the walker is standing rather than from a fixed origin.
 */
const APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);

function directionsUrl(p) {
  const dest = `${p.lat},${p.lng}`;
  return APPLE
    ? `https://maps.apple.com/?daddr=${dest}&q=${encodeURIComponent(p.name)}&dirflg=w`
    : `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=walking`;
}

function directionsLink(p, label = 'Directions') {
  const a = document.createElement('a');
  a.className = 'dirs';
  a.href = directionsUrl(p);
  a.target = '_blank';
  a.rel = 'noopener';
  a.setAttribute('aria-label', `Walking directions to ${p.name}`);
  a.append(html('<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 20 20 4M20 4h-7M20 4v7"/></svg>'), text(label));
  // The card behind it is itself clickable; a walk is not what "tap the card" means.
  a.addEventListener('click', (e) => e.stopPropagation());
  return a;
}

function card(p) {
  const art = node('article', 'card');

  const main = document.createElement('button');
  main.className = 'cardMain';
  main.type = 'button';

  if (p.image && p.kind === 'see') {
    const img = document.createElement('img');
    img.className = 'thumb'; img.src = p.image; img.alt = ''; img.loading = 'lazy';
    main.append(img);
  }

  const meta = [p.walkMinutes < 1 ? null : distance(p), p.built && `built ${p.built}`, p.checked && `checked ${p.checked}`, p.readMinutes && `${p.readMinutes} min read`]
    .filter(Boolean)
    .map((t) => node('span', '', [text(t)]));

  main.append(node('div', 'body', [
    node('div', 'head', [chip(p.label), hoursChip(p)]),
    node('h2', '', [text(p.name)]),
    node('p', 'why', [text(p.why)]),
    node('div', 'meta', meta),
  ]));

  main.append(p.walkMinutes < 1
    ? node('div', 'walk', [text('you are here')])
    : node('div', 'walk', [node('b', '', [text(p.walkMinutes)]), text('min walk')]));
  main.addEventListener('click', () => open(p));

  art.append(main, node('div', 'cardbar', [
    node('span', 'hint', [text(hours(p))]),
    directionsLink(p),
  ]));
  return art;
}

/** Opening hours as OSM has them, trimmed rather than cut mid-rule. */
function hours(p) {
  if (!p.hours) return 'tap for detail';
  if (p.hours.length <= 34) return p.hours;
  return `${p.hours.slice(0, 33).replace(/[;,\s]+$/, '')}…`;
}

function open(p) {
  seen.add(p.id);
  localStorage.setItem('footlore.seen', JSON.stringify([...seen].slice(-200)));

  const body = el('sheetBody');
  body.replaceChildren();
  const close = document.createElement('button');
  close.className = 'close'; close.textContent = 'close';
  close.addEventListener('click', () => sheet.close());

  body.append(
    node('div', 'grab'),
    close,
    node('div', 'head', [chip(p.label), p.open === true ? chip('open now', 'chip open') : null]),
    node('h2', '', [text(p.name)]),
    node('p', 'why', [text(p.why)]),
  );
  const hero = () => {
    if (!p.image) return;
    const img = document.createElement('img');
    img.className = 'hero'; img.src = p.image; img.alt = p.name;
    body.append(img);
  };
  if (p.kind === 'see') hero();
  if (p.extract) {
    // On the food and shops tabs the article usually belongs to the building,
    // not the business standing in it. Saying so is the difference between a
    // useful link and a false claim.
    if (p.kind !== 'see') {
      body.append(node('p', 'wikiNote', [text(
        `OpenStreetMap links this pin to the Wikipedia article “${p.wikiTitle}” — often about the ` +
        `building rather than the business in it:`)]));
    }
    if (p.kind !== 'see') hero();
    body.append(node('p', 'body', [text(p.extract)]));
  }

  const facts = [
    p.walkMinutes < 1 ? distance(p) : `${distance(p)} · ${p.walkMinutes} min walk`,
    p.built && `built ${p.built}`,
    p.heritage && `listed ${p.heritage}`,
    p.hours && `hours ${p.hours}`,
    p.kind === 'see' ? `story ${p.story}` : null,
  ].filter(Boolean).map((t) => node('span', 'fact', [text(t)]));
  body.append(node('div', 'facts', facts));

  const actions = node('div', 'sheetActions', [directionsLink(p, 'Walk me there')]);
  if (p.website) {
    const w = document.createElement('a');
    w.className = 'dirs ghost'; w.href = p.website; w.target = '_blank'; w.rel = 'noopener';
    w.textContent = 'Website';
    actions.append(w);
  }
  body.append(actions);

  const src = node('div', 'source', [text(
    p.whySource === 'claude' ? 'Line written by Claude and checked against '
      : p.whySource === 'osm' ? 'Read from the map tags on '
        : 'Line quoted from ')]);
  const a = document.createElement('a');
  // The link has to go where the line came from. On the food and shops tabs
  // that is the map pin, even when the place also has an article attached.
  a.href = p.whySource === 'osm' || !p.wikiUrl
    ? `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}`
    : p.wikiUrl;
  a.target = '_blank'; a.rel = 'noopener';
  a.textContent = p.whySource === 'osm' ? 'OpenStreetMap' : p.source;
  src.append(a);
  body.append(src);

  sheet.showModal();
}

async function load({ force = false } = {}) {
  const routed = kind === 'walk' || kind === 'map';
  el('walkbar').hidden = !routed;
  if (routed) return loadWalk({ force });

  const want = kind;
  const key = `${want}:${radius}`;
  if (!force && results.has(key)) {
    const hit = results.get(key);
    places = hit.places;
    return render(hit.meta);
  }

  skeletons();
  status.replaceChildren(html('<span class="dot"></span>looking around…'));
  try {
    // Through feedFor, so a tab the prefetcher is already fetching is awaited
    // rather than asked for a second time.
    const data = await feedFor(want, force);
    if (want !== kind) return;              // tab switched while this was in flight
    places = data.places;
    render(data.meta);
    prefetchOthers();
  } catch (e) {
    if (want !== kind) return;
    feed.replaceChildren(html(`<div class="note"><b>Couldn't load the feed.</b><br>${e.message}</div>`));
    status.replaceChildren(html('<span class="dot" style="background:var(--amber)"></span>offline'));
  }
}

// Requests in flight, by tab and radius, so a click on a tab that is already
// being prefetched joins that request instead of starting another.
const pending = new Map();

/** One tab's feed, from the cache if it is already there. */
function feedFor(want, force) {
  const key = `${want}:${radius}`;
  if (!force && results.has(key)) return Promise.resolve(results.get(key));
  if (!force && pending.has(key)) return pending.get(key);
  const p = loadNearby({ lat: here.lat, lng: here.lng, radius, seen: [...seen], kind: want })
    .then((data) => { results.set(key, data); return data; })
    .finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

// Once the tab you opened has drawn, quietly fetch the other two so switching
// is instant. One at a time, and never on a metered connection: Overpass
// rate-limits, and on the static build every visitor spends their own budget.
// A failure here is silent; the tab simply loads normally when it is opened.
let prefetchRun = 0;
async function prefetchOthers() {
  if (navigator.connection?.saveData) return;
  const run = ++prefetchRun;
  for (const k of ['see', 'food', 'shop']) {
    if (run !== prefetchRun) return;          // a newer load took over
    if (k === kind || results.has(`${k}:${radius}`)) continue;
    try { await feedFor(k, false); } catch { /* opened later, loads normally */ }
  }
}

async function loadWalk({ force = false } = {}) {
  const mine = kind;                           // 'walk' or 'map'
  skeletons(3);
  status.replaceChildren(html('<span class="dot"></span>working out a route…'));
  try {
    // The sights feed is the walk. Food is only fetched when a meal is asked
    // for — otherwise it is a second Overpass call for a list nothing reads.
    const [see, food] = await Promise.all([
      feedFor('see', force),
      wantMeal ? feedFor('food', force) : Promise.resolve({ places: [] }),
    ]);
    if (kind !== mine) return;

    const result = buildWalk({
      here, sights: see.places, foods: food.places, budget, wantMeal,
    });
    if (mine === 'map' && result.ok) renderMap(feed, { here, result, budget });
    else renderWalk(feed, result, { budget, wantMeal, onDirections: (p) => directionsLink(p, 'Go') });

    status.replaceChildren(html(result.ok
      ? `<span class="dot"></span>${result.sched.stops.length} stops · ${result.sched.total} of ${budget} min · ` +
        `<span class="warn">times are estimates</span>`
      : `<span class="dot" style="background:var(--amber)"></span>no walk fits`));
    el('attrib').textContent = (see.meta?.attribution ?? []).join('  ·  ');
  } catch (e) {
    if (kind !== mine) return;
    feed.replaceChildren(html(`<div class="note"><b>Couldn't build a walk.</b><br>${e.message}</div>`));
    status.replaceChildren(html('<span class="dot" style="background:var(--amber)"></span>offline'));
  }
}

let lastMeta = null;
let onlyOpen = false;

function render(meta) {
  lastMeta = meta;
  const local = meta.kind === 'food' || meta.kind === 'shop';
  el('openbar').hidden = !local;
  // Food and shops: a place whose mapped hours say it is shut right now is
  // not worth a walk, so it is hidden (and counted). Places with no hours
  // mapped stay, flagged, because "unknown" is not "closed" — unless the
  // reader asks for confirmed-open only.
  const list = !local ? places : places.filter((p) => p.open !== false && (!onlyOpen || p.open === true));
  const hiddenShut = local ? places.filter((p) => p.open === false).length : 0;
  const hiddenUnknown = local && onlyOpen ? places.filter((p) => p.open === null).length : 0;
  const tab = TABS.find((t) => t.kind === (meta.kind ?? 'see'));

  status.replaceChildren(html(
    `<span class="dot"></span>${list.length} nearby · ${(meta.ms / 1000).toFixed(1)}s · ` +
    (meta.kind === 'see' || !meta.kind
      ? `${meta.found} candidates, ${meta.belowFloor} below the story floor · ` +
        (meta.narration === 'extractive'
          ? '<span class="warn">quoted from Wikipedia</span>'
          : `narrated by Claude${meta.rejectedLines ? ` · ${meta.rejectedLines} line(s) rejected as unsourced` : ''}`)
      : `${meta.found} mapped · ` + (hiddenShut ? `${hiddenShut} shut now, hidden · ` : '') + '<span class="warn">not ranked by quality</span>'),
  ));

  feed.replaceChildren(...list.map(card));

  if (meta.widenedFrom) {
    feed.prepend(html(`<div class="note">Not much within ${meta.widenedFrom} m, so this is ` +
      `everything inside ${meta.radius} m. Distances are longer than usual.</div>`));
  }

  if (!list.length) {
    feed.replaceChildren(html(`<div class="note"><b>${tab.empty} within ${meta.radius} m.</b><br>` +
      (meta.kind === 'see' || !meta.kind
        ? `That is a real answer, not an error — ` +
          `${meta.found === 0 ? 'nothing is mapped around here at all' : `${meta.found} thing${meta.found === 1 ? ' is' : 's are'} mapped around here, but none of them has a story attached`}` +
          `. Padding this list with bus shelters would waste your walk.`
        : `Nothing is in OpenStreetMap here. That may mean there is nothing, or ` +
          `that nobody has mapped it — the app can't tell the two apart, so it won't pretend to.`) +
      `</div>`));
  } else if (meta.thin && (meta.kind === 'see' || !meta.kind)) {
    feed.append(html('<div class="note">A short list is the honest one here — everything else nearby ' +
      'fell below the story floor.</div>'));
  }

  if (meta.kind === 'see' || !meta.kind) {
    if (meta.narration === 'extractive') {
      feed.append(html(`<div class="note">Every line here is a sentence quoted from the Wikipedia intro — ` +
        `dull, but nothing is paraphrased or inferred. ${QUOTING_NOTE}</div>`));
    }
  } else if (list.length) {
    feed.append(html(`<div class="note"><b>No ratings, on purpose.</b> OpenStreetMap doesn't record them, ` +
      `and there is no free source that does — so this list is ordered by how close each place is and how ` +
      `much the map actually says about it, never by how good it is. Each line is read straight off the ` +
      `map tags: cuisine, seating, takeaway. Hours are shown where they are mapped, and may be out of date.</div>`));
    feed.append(html(`<div class="note"><b>Open now, as far as the map knows.</b> ` +
      `${hiddenShut ? `${hiddenShut} place${hiddenShut === 1 ? '' : 's'} whose mapped hours say shut right now ${hiddenShut === 1 ? 'is' : 'are'} hidden. ` : ''}` +
      `${hiddenUnknown ? `${hiddenUnknown} with no hours mapped ${hiddenUnknown === 1 ? 'is' : 'are'} hidden too. ` : ''}` +
      `This is OpenStreetMap, edited by volunteers: a shop that closed and was never updated can still be listed, ` +
      `and "open now" is only as current as its hours. Places marked closed or disused on the map are already left out. ` +
      `Tap a card for the map entry, and fix it there if it is wrong.</div>`));
  }
  el('attrib').textContent = meta.attribution.join('  ·  ');
}

/** Say what is actually known: metres are a node centroid, not a doorstep. */
function distance(p) {
  if (p.metres < 30) return 'right here';
  return p.metres < 950 ? `${Math.round(p.metres / 10) * 10} m` : `${(p.metres / 1000).toFixed(1)} km`;
}

/* --- small DOM helpers, so the code above reads like the markup --- */
function node(tag, cls, kids = []) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const k of kids) if (k) n.append(k);
  return n;
}
function text(t) { return document.createTextNode(String(t)); }
function html(s) {
  const t = document.createElement('template');
  t.innerHTML = s.trim();
  // A fragment when the snippet has siblings — returning firstChild silently
  // dropped the text after `<span class="dot"></span>`.
  return t.content.childNodes.length > 1 ? t.content : t.content.firstChild;
}
/** Open now where the map's hours say so; an explicit gap where they are missing. */
function hoursChip(p) {
  if (p.open === true) return chip('open now', 'chip open');
  if (p.open === null && (p.kind === 'food' || p.kind === 'shop')) return chip('hours not mapped', 'chip unknown');
  return null;
}
function chip(label, cls = 'chip') { return label ? node('span', cls, [text(label)]) : null; }

for (const mins of BUDGETS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = `${mins} min`;
  b.setAttribute('aria-pressed', String(mins === budget));
  b.addEventListener('click', () => {
    budget = mins;
    for (const other of el('budgets').children) {
      other.setAttribute('aria-pressed', String(other === b));
    }
    loadWalk();
  });
  el('budgets').append(b);
}
el('onlyOpen').addEventListener('change', (e) => {
  onlyOpen = e.target.checked;
  if (lastMeta && (kind === 'food' || kind === 'shop')) render(lastMeta);
});
el('wantMeal').addEventListener('change', (e) => {
  wantMeal = e.target.checked;
  loadWalk();
});

for (const b of document.querySelectorAll('#tabs button')) {
  b.addEventListener('click', () => {
    if (b.dataset.kind === kind) return;
    kind = b.dataset.kind;
    for (const other of document.querySelectorAll('#tabs button')) {
      other.setAttribute('aria-selected', String(other.dataset.kind === kind));
    }
    load();
  });
}

el('radius').addEventListener('click', () => {
  radius = RADII[(RADII.indexOf(radius) + 1) % RADII.length];
  el('radius').textContent = `${radius} m`;
  load();
});
// Theme. No stored value means "follow the OS", so the first click has to flip
// away from what is *currently* on screen rather than from a remembered choice.
el('theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme
    ? root.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('fl.theme', root.dataset.theme); } catch { /* not fatal */ }
});

el('refresh').addEventListener('click', () => load({ force: true }));
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

here = await locate();
el('where').textContent = here.fallback
  ? `${here.label} — location declined`
  : here.pinned
    ? `${here.lat}, ${here.lng} — pinned`
    : `${here.lat}, ${here.lng}`;
load();

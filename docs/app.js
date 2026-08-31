// The nearby feed. Three tabs, one fetch each, one list, one detail sheet.

import { loadNearby, QUOTING_NOTE } from './api.js';
import { buildWalk, renderWalk, BUDGETS } from './walkview.js';
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

  const meta = [p.walkMinutes < 1 ? null : distance(p), p.built && `built ${p.built}`, p.readMinutes && `${p.readMinutes} min read`]
    .filter(Boolean)
    .map((t) => node('span', '', [text(t)]));

  main.append(node('div', 'body', [
    node('div', 'head', [chip(p.label), p.open === true ? chip('open now', 'chip open') : null]),
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
  el('walkbar').hidden = kind !== 'walk';
  if (kind === 'walk') return loadWalk({ force });

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
    const data = await loadNearby({ lat: here.lat, lng: here.lng, radius, seen: [...seen], kind: want });
    results.set(key, data);
    if (want !== kind) return;              // tab switched while this was in flight
    places = data.places;
    render(data.meta);
  } catch (e) {
    if (want !== kind) return;
    feed.replaceChildren(html(`<div class="note"><b>Couldn't load the feed.</b><br>${e.message}</div>`));
    status.replaceChildren(html('<span class="dot" style="background:var(--amber)"></span>offline'));
  }
}

/** One tab's feed, from the cache if it is already there. */
async function feedFor(want, force) {
  const key = `${want}:${radius}`;
  if (!force && results.has(key)) return results.get(key);
  const data = await loadNearby({ lat: here.lat, lng: here.lng, radius, seen: [...seen], kind: want });
  results.set(key, data);
  return data;
}

async function loadWalk({ force = false } = {}) {
  skeletons(3);
  status.replaceChildren(html('<span class="dot"></span>working out a route…'));
  try {
    // The sights feed is the walk. Food is only fetched when a meal is asked
    // for — otherwise it is a second Overpass call for a list nothing reads.
    const [see, food] = await Promise.all([
      feedFor('see', force),
      wantMeal ? feedFor('food', force) : Promise.resolve({ places: [] }),
    ]);
    if (kind !== 'walk') return;

    const result = buildWalk({
      here, sights: see.places, foods: food.places, budget, wantMeal,
    });
    renderWalk(feed, result, { budget, wantMeal, onDirections: (p) => directionsLink(p, 'Go') });

    status.replaceChildren(html(result.ok
      ? `<span class="dot"></span>${result.sched.stops.length} stops · ${result.sched.total} of ${budget} min · ` +
        `<span class="warn">times are estimates</span>`
      : `<span class="dot" style="background:var(--amber)"></span>no walk fits`));
    el('attrib').textContent = (see.meta?.attribution ?? []).join('  ·  ');
  } catch (e) {
    if (kind !== 'walk') return;
    feed.replaceChildren(html(`<div class="note"><b>Couldn't build a walk.</b><br>${e.message}</div>`));
    status.replaceChildren(html('<span class="dot" style="background:var(--amber)"></span>offline'));
  }
}

function render(meta) {
  const tab = TABS.find((t) => t.kind === (meta.kind ?? 'see'));

  status.replaceChildren(html(
    `<span class="dot"></span>${meta.shown} nearby · ${(meta.ms / 1000).toFixed(1)}s · ` +
    (meta.kind === 'see' || !meta.kind
      ? `${meta.found} candidates, ${meta.belowFloor} below the story floor · ` +
        (meta.narration === 'extractive'
          ? '<span class="warn">quoted from Wikipedia</span>'
          : `narrated by Claude${meta.rejectedLines ? ` · ${meta.rejectedLines} line(s) rejected as unsourced` : ''}`)
      : `${meta.found} mapped · <span class="warn">not ranked by quality</span>`),
  ));

  feed.replaceChildren(...places.map(card));

  if (meta.widenedFrom) {
    feed.prepend(html(`<div class="note">Not much within ${meta.widenedFrom} m, so this is ` +
      `everything inside ${meta.radius} m. Distances are longer than usual.</div>`));
  }

  if (!places.length) {
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
  } else if (places.length) {
    feed.append(html(`<div class="note"><b>No ratings, on purpose.</b> OpenStreetMap doesn't record them, ` +
      `and there is no free source that does — so this list is ordered by how close each place is and how ` +
      `much the map actually says about it, never by how good it is. Each line is read straight off the ` +
      `map tags: cuisine, seating, takeaway. Hours are shown where they are mapped, and may be out of date.</div>`));
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

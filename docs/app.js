// The nearby feed. One fetch, one list, one detail sheet.

import { loadNearby, QUOTING_NOTE } from './api.js';
// Everything interesting happens on the server; this file just shows it.

const BRISTOL = { lat: 51.4546, lng: -2.5945, label: 'Corn Street, Bristol' };
const RADII = [500, 900, 1500, 2500];

const el = (id) => document.getElementById(id);
const feed = el('feed'), status = el('status'), sheet = el('sheet');

let radius = 900;
let here = null;
const seen = new Set(JSON.parse(localStorage.getItem('footlore.seen') ?? '[]'));
let places = [];

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

function card(p) {
  const b = document.createElement('button');
  b.className = 'card';
  b.type = 'button';

  if (p.image) {
    const img = document.createElement('img');
    img.className = 'thumb'; img.src = p.image; img.alt = ''; img.loading = 'lazy';
    b.append(img);
  }

  const meta = [p.walkMinutes < 1 ? null : distance(p), p.built && `built ${p.built}`, p.readMinutes && `${p.readMinutes} min read`]
    .filter(Boolean)
    .map((t) => node('span', '', [text(t)]));

  b.append(node('div', 'body', [
    node('div', 'head', [chip(p.label), p.open === true ? chip('open now', 'chip open') : null]),
    node('h2', '', [text(p.name)]),
    node('p', 'why', [text(p.why)]),
    node('div', 'meta', meta),
  ]));

  b.append(p.walkMinutes < 1
    ? node('div', 'walk', [text('you are here')])
    : node('div', 'walk', [node('b', '', [text(p.walkMinutes)]), text('min walk')]));
  b.addEventListener('click', () => open(p));
  return b;
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
  if (p.image) {
    const img = document.createElement('img');
    img.className = 'hero'; img.src = p.image; img.alt = p.name;
    body.append(img);
  }
  if (p.extract) body.append(node('p', 'body', [text(p.extract)]));

  const facts = [
    p.walkMinutes < 1 ? distance(p) : `${distance(p)} · ${p.walkMinutes} min walk`,
    p.built && `built ${p.built}`,
    p.heritage && `listed ${p.heritage}`,
    `story ${p.story}`,
  ].filter(Boolean).map((t) => node('span', 'fact', [text(t)]));
  body.append(node('div', 'facts', facts));

  const src = node('div', 'source', [text(p.whySource === 'claude'
    ? 'Line written by Claude and checked against '
    : 'Line quoted from ')]);
  const a = document.createElement('a');
  a.href = p.wikiUrl ?? `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}`;
  a.target = '_blank'; a.rel = 'noopener';
  a.textContent = p.source;
  src.append(a);
  const maps = document.createElement('a');
  maps.href = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=walking`;
  maps.target = '_blank'; maps.rel = 'noopener'; maps.textContent = 'walk me there';
  src.append(document.createTextNode(' · '), maps);
  body.append(src);

  sheet.showModal();
}

async function load() {
  skeletons();
  status.replaceChildren(html('<span class="dot"></span>looking around…'));
  try {
    const data = await loadNearby({ lat: here.lat, lng: here.lng, radius, seen: [...seen] });
    places = data.places;
    render(data.meta);
  } catch (e) {
    feed.replaceChildren(html(`<div class="note"><b>Couldn't load the feed.</b><br>${e.message}</div>`));
    status.replaceChildren(html('<span class="dot" style="background:var(--amber)"></span>offline'));
  }
}

function render(meta) {
  status.replaceChildren(html(
    `<span class="dot"></span>${meta.shown} nearby · ${(meta.ms / 1000).toFixed(1)}s` +
    ` · ${meta.found} candidates, ${meta.belowFloor} below the story floor · ` +
    (meta.narration === 'extractive'
      ? '<span class="warn">quoted from Wikipedia</span>'
      : `narrated by Claude${meta.rejectedLines ? ` · ${meta.rejectedLines} line(s) rejected as unsourced` : ''}`),
  ));

  feed.replaceChildren(...places.map(card));

  if (meta.widenedFrom) {
    feed.prepend(html(`<div class="note">Not much within ${meta.widenedFrom} m, so this is ` +
      `everything worth walking to inside ${meta.radius} m. Distances are longer than usual.</div>`));
  }

  if (!places.length) {
    feed.replaceChildren(html(`<div class="note"><b>Nothing worth stopping for within ` +
      `${meta.radius} m.</b><br>That is a real answer, not an error — ` +
      `${meta.found === 0 ? 'nothing is mapped around here at all' : `${meta.found} thing${meta.found === 1 ? ' is' : 's are'} mapped around here, but none of them has a story attached`}` +
      `. Padding this list with bus shelters would waste your walk.</div>`));
  } else if (meta.thin) {
    feed.append(html('<div class="note">A short list is the honest one here — everything else nearby ' +
      'fell below the story floor.</div>'));
  }
  if (meta.narration === 'extractive') {
    feed.append(html(`<div class="note">Every line here is a sentence quoted from the Wikipedia intro — ` +
      `dull, but nothing is paraphrased or inferred. ${QUOTING_NOTE}</div>`));
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

el('refresh').addEventListener('click', load);
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

here = await locate();
el('where').textContent = here.fallback
  ? `${here.label} — location declined`
  : here.pinned
    ? `${here.lat}, ${here.lng} — pinned`
    : `${here.lat}, ${here.lng}`;
load();

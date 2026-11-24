// The Map tab: the walk, drawn on OpenStreetMap tiles.
//
// No map library. A slippy map is a grid of 256px PNGs addressed by zoom/x/y
// plus a projection formula, and this draws exactly that: <img> tiles in a
// clipped box, an SVG on top for the route, pointer-drag to pan, buttons and
// the wheel to zoom. The route is the solver's own — straight lines between
// stops in visiting order, because that is what the time estimates were made
// from. It is not a street route and the panel says so.

import { clock } from './solver/geo.mjs';

const TILE = 256;
const MIN_Z = 3;
const MAX_Z = 19;
const TILES = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const SVG = 'http://www.w3.org/2000/svg';

// Street routing: the FOSSGIS foot profile over OpenStreetMap's own paths. A
// public, keyless demo service that allows browser requests; used once per
// walk, and the map is fully usable without it (straight legs) if it is slow
// or down.
const ROUTER = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';
const ROUTE_TIMEOUT = 8000;

/** One request for the whole loop: [{lat,lng}...] -> {line:[[lat,lng]...], metres, minutes, legs} or null. */
async function streetRoute(points) {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ROUTE_TIMEOUT);
  try {
    const r = await fetch(`${ROUTER}${coords}?overview=full&geometries=geojson&steps=false`, { signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    const route = j.code === 'Ok' ? j.routes?.[0] : null;
    if (!route?.geometry?.coordinates?.length) return null;
    return {
      line: route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      metres: route.distance,
      minutes: route.duration / 60,
    };
  } catch { return null; } finally { clearTimeout(timer); }
}

const world = (z) => TILE * 2 ** z;
const px = (lng, z) => ((lng + 180) / 360) * world(z);
const py = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world(z);
};

const node = (tag, cls, kids = []) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const k of kids) if (k) n.append(k);
  return n;
};
const svg = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const text = (t) => document.createTextNode(String(t));

/** Highest zoom at which every point fits inside w x h with `pad` to spare. */
function fitZoom(points, w, h, pad) {
  for (let z = MAX_Z - 2; z > MIN_Z; z--) {
    const xs = points.map((p) => px(p.lng, z));
    const ys = points.map((p) => py(p.lat, z));
    if (Math.max(...xs) - Math.min(...xs) <= w - 2 * pad &&
        Math.max(...ys) - Math.min(...ys) <= h - 2 * pad) return z;
  }
  return MIN_Z;
}

/**
 * Draw the walk's route on a map.
 * @param {HTMLElement} into
 * @param {{here:{lat:number,lng:number}, result:object, budget:number}} o
 */
export function renderMap(into, { here, result, budget }) {
  if (!result.ok) return false;
  const { sched, catalog } = result;

  // Origin, then each stop in order, then home again.
  const pts = [
    { ...here, n: 0, name: 'Start' },
    ...sched.stops.map((s, i) => ({
      lat: catalog[s.id].lat, lng: catalog[s.id].lng, n: i + 1, name: s.name,
      kind: s.kind, arrive: s.arrive,
    })),
  ];
  const straight = [...pts, pts[0]];

  const box = node('div', 'map');
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `Map of the walk: ${sched.stops.length} stops, returning to the start`);
  const tiles = node('div', 'mapTiles');
  const overlay = svg('svg', { class: 'mapRoute' });
  const ctrl = node('div', 'mapCtrl');
  const plus = node('button'); plus.type = 'button'; plus.textContent = '+'; plus.ariaLabel = 'Zoom in';
  const minus = node('button'); minus.type = 'button'; minus.textContent = '−'; minus.ariaLabel = 'Zoom out';
  const fit = node('button'); fit.type = 'button'; fit.textContent = '⤢'; fit.ariaLabel = 'Fit the whole walk';
  const loc = node('button'); loc.type = 'button'; loc.ariaLabel = 'Go to my location'; loc.title = 'Go to my location';
  loc.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
  const toast = node('div', 'mapToast'); toast.hidden = true; toast.setAttribute('role', 'status');
  ctrl.append(plus, minus, fit, loc);
  box.append(tiles, overlay, ctrl, toast,
    node('div', 'mapCredit', [text('© '), Object.assign(document.createElement('a'),
      { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener', textContent: 'OpenStreetMap contributors' })]));

  const legend = node('ol', 'mapLegend');
  for (const p of pts.slice(1)) {
    legend.append(node('li', p.kind === 'eat' ? 'meal' : '', [
      node('span', 'pip', [text(p.n)]),
      node('span', 'legName', [text(p.name)]),
      node('span', 'legTime', [text(clock(p.arrive))]),
    ]));
  }

  const back = `Back at ${clock(sched.finish)}${sched.total > budget ? `, ${sched.total - budget} min over the ${budget} you asked for` : ''}.`;
  const note = node('div', 'note', [
    node('b', '', [text('Finding the street route… ')]),
    text('Until it arrives, the dashed line joins the stops in order, straight from one to the next. ' + back),
  ]);
  into.replaceChildren(box, legend, note);

  // Set when the street route arrives; draw() prefers it over the straight legs.
  let street = null;
  let me = null;                                   // {lat, lng, acc} once located

  // View state: zoom and the world-pixel point at the centre of the box.
  let z = 15, cx = 0, cy = 0, w = 0, h = 0;
  const imgs = new Map();

  function frame() {
    z = fitZoom(pts, w, h, 44);
    cx = (Math.min(...pts.map((p) => px(p.lng, z))) + Math.max(...pts.map((p) => px(p.lng, z)))) / 2;
    cy = (Math.min(...pts.map((p) => py(p.lat, z))) + Math.max(...pts.map((p) => py(p.lat, z)))) / 2;
  }

  function draw() {
    if (!w || !h) return;
    const left = cx - w / 2, top = cy - h / 2;
    const n = 2 ** z;
    const want = new Set();
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
      for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + h) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue;
        const wx = ((tx % n) + n) % n;
        const key = `${z}/${tx}/${ty}`;
        want.add(key);
        let img = imgs.get(key);
        if (!img) {
          img = new Image();
          img.alt = ''; img.draggable = false; img.decoding = 'async';
          img.src = TILES(z, wx, ty);
          imgs.set(key, img);
          tiles.append(img);
        }
        img.style.transform = `translate(${Math.round(tx * TILE - left)}px,${Math.round(ty * TILE - top)}px)`;
      }
    }
    for (const [key, img] of imgs) if (!want.has(key)) { img.remove(); imgs.delete(key); }

    const at = (p) => [px(p.lng, z) - left, py(p.lat, z) - top];
    overlay.setAttribute('viewBox', `0 0 ${w} ${h}`);
    overlay.replaceChildren();
    const path = (street?.line ?? straight).map((p) => at(p).join(',')).join(' ');
    overlay.append(
      svg('polyline', { class: 'routeCasing', points: path }),
      svg('polyline', { class: `routeLine${street ? ' onStreet' : ''}`, points: path }),
    );
    if (me) {
      const [x, y] = at(me);
      const g = svg('g', { class: 'mapMe', transform: `translate(${x},${y})` });
      // Accuracy ring, capped so a coarse fix doesn't swamp the map.
      const ringPx = Math.min((me.acc || 0) / (156543.03 * Math.cos((me.lat * Math.PI) / 180) / 2 ** z), 120);
      if (ringPx > 9) g.append(svg('circle', { class: 'ring', r: ringPx }));
      g.append(svg('circle', { class: 'dot', r: 8 }));
      const t = svg('title'); t.textContent = 'You are here'; g.append(t);
      overlay.append(g);
    }
    // Start last-but-one so a stop sitting on top of it stays readable.
    for (const p of [...pts].reverse()) {
      const [x, y] = at(p);
      const g = svg('g', { class: `mapPin${p.n === 0 ? ' start' : ''}${p.kind === 'eat' ? ' meal' : ''}`, transform: `translate(${x},${y})` });
      g.append(svg('circle', { r: p.n === 0 ? 8 : 13 }));
      if (p.n) {
        const t = svg('text', { 'text-anchor': 'middle', dy: '.35em' });
        t.textContent = p.n;
        g.append(t);
      }
      const title = svg('title');
      title.textContent = p.n ? `${p.n}. ${p.name} · ${clock(p.arrive)}` : 'Where you started';
      g.append(title);
      overlay.append(g);
    }
  }

  function zoomTo(nz, ax = w / 2, ay = h / 2) {
    nz = Math.max(MIN_Z, Math.min(MAX_Z, nz));
    if (nz === z) return;
    // Keep the point under (ax, ay) where it is while the scale changes.
    const k = 2 ** (nz - z);
    cx = (cx - w / 2 + ax) * k - ax + w / 2;
    cy = (cy - h / 2 + ay) * k - ay + h / 2;
    z = nz;
    draw();
  }

  let toastTimer;
  const say = (m) => {
    toast.textContent = m; toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
  };
  loc.onclick = () => {
    if (!navigator.geolocation) return say('This browser cannot give a location.');
    loc.disabled = true; loc.classList.add('busy');
    navigator.geolocation.getCurrentPosition((pos) => {
      loc.disabled = false; loc.classList.remove('busy');
      me = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
      z = Math.max(z, 16);
      cx = px(me.lng, z); cy = py(me.lat, z);
      draw();
    }, (err) => {
      loc.disabled = false; loc.classList.remove('busy');
      say(err.code === 1 ? 'Location is blocked. Allow it for this site in the browser, then try again.'
        : err.code === 3 ? 'Timed out finding you. Try again.' : 'Could not work out where you are.');
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  };

  plus.onclick = () => zoomTo(z + 1);
  minus.onclick = () => zoomTo(z - 1);
  fit.onclick = () => { frame(); draw(); };

  // Pan.
  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.mapCtrl')) return;
    drag = { x: e.clientX, y: e.clientY, cx, cy };
    box.setPointerCapture(e.pointerId);
    box.classList.add('grab');
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    cx = drag.cx - (e.clientX - drag.x);
    cy = drag.cy - (e.clientY - drag.y);
    draw();
  });
  const release = () => { drag = null; box.classList.remove('grab'); };
  box.addEventListener('pointerup', release);
  box.addEventListener('pointercancel', release);

  // Wheel zoom, stepping once per gesture rather than once per delta tick.
  let wheelAt = 0;
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.timeStamp - wheelAt < 180) return;
    wheelAt = e.timeStamp;
    const r = box.getBoundingClientRect();
    zoomTo(z + (e.deltaY < 0 ? 1 : -1), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // Keyboard, for the same reason the buttons exist.
  box.tabIndex = 0;
  box.addEventListener('keydown', (e) => {
    const step = 60;
    if (e.key === '+' || e.key === '=') zoomTo(z + 1);
    else if (e.key === '-') zoomTo(z - 1);
    else if (e.key === 'ArrowLeft') cx -= step;
    else if (e.key === 'ArrowRight') cx += step;
    else if (e.key === 'ArrowUp') cy -= step;
    else if (e.key === 'ArrowDown') cy += step;
    else return;
    e.preventDefault();
    draw();
  });

  // Sized by CSS, measured once it is in the page, and kept right on rotation.
  let first = true;
  new ResizeObserver(() => {
    const r = box.getBoundingClientRect();
    if (!r.width) return;
    w = r.width; h = r.height;
    if (first) { first = false; frame(); }
    draw();
  }).observe(box);

  streetRoute(straight).then((r) => {
    if (!box.isConnected) return;                       // tab changed while it was in flight
    if (!r) {
      note.replaceChildren(
        node('b', '', [text('Street route unavailable. ')]),
        text('The routing service did not answer, so the dashed line is just the stops in order, straight from one to the next — ' +
          'a river or a railway between two stops is not drawn around. ' + back));
      return;
    }
    street = r;
    note.replaceChildren(
      node('b', '', [text(`Along the streets: ${(r.metres / 1000).toFixed(1)} km, about ${Math.round(r.minutes)} min of walking. `)]),
      text('Routed over OpenStreetMap footpaths and roads by routing.openstreetmap.de. ' +
        `The timings above are still the planner's estimates (${sched.walking} min of walking, straight-line × 1.35), ` +
        'so the two will not match exactly. ' + back));
    draw();
  });

  return true;
}

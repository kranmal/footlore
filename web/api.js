// Data adapter — server build.
//
// The browser build swaps this file for one that runs the whole pipeline in the
// page (see tools/build-static.mjs). Everything above this line is identical in
// both, which is the point: one feed, two ways of being fed.

export const QUOTING_NOTE =
  'Set <b>ANTHROPIC_API_KEY</b> and restart to have Claude write them instead; those lines are ' +
  'checked back against the source and dropped if they contain a name, number or date the source does not.';

export async function loadNearby({ lat, lng, radius, seen, kind = 'see' }) {
  const url = `api/nearby?kind=${kind}&lat=${lat}&lng=${lng}&radius=${radius}&seen=${seen.join(',')}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

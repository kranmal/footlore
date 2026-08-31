// Data adapter — static build. No server: the pipeline runs in this tab.
import { nearby } from './lib/places.mjs';

// This build is quoting-only and always will be. Saying "set a key" here would
// be advice nobody reading it can take.
export const QUOTING_NOTE =
  'This version runs entirely in your browser with no server behind it, so there is nowhere to keep ' +
  'an API key — quoting is the only honest option, and it is the accurate one.';

export async function loadNearby({ lat, lng, radius, seen }) {
  return nearby({ lat, lng, radius, limit: 20, seen });
}

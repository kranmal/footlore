// Live check of the place service against real data.
//   node server/probe.mjs [lat] [lng] [radius]

import { nearby } from './places.mjs';
import { stats } from './cache.mjs';

const [lat = 51.4546, lng = -2.5945, radius = 900] = process.argv.slice(2).map(Number);

const { places, meta } = await nearby({ lat, lng, radius: Number(radius), limit: 12 });

console.log(`\n\x1b[1m${places.length} places · ${meta.ms}ms · osm ${meta.osmCached ? 'cached' : 'live'} · narration ${meta.narration}\x1b[0m`);
console.log(`found ${meta.found} raw, dropped ${meta.belowFloor} below the story floor`);
console.log(meta.widenedFrom
  ? `radius widened ${meta.widenedFrom}m -> ${meta.radius}m — not much within the first circle\n`
  : `radius ${meta.radius}m\n`);

for (const p of places) {
  const open = p.open === null ? '' : p.open ? ' · open' : ' · closed';
  console.log(`  \x1b[1m${p.name}\x1b[0m  \x1b[2m${p.metres}m · ${p.walkMinutes} min · ${p.label}${open}\x1b[0m`);
  console.log(`    ${p.why}`);
  console.log(`    \x1b[2mstory ${p.story} [${p.storySignals.join(' ')}] · rank ${p.rankScore ?? ''}\x1b[0m`);
}

console.log(`\ncache: ${JSON.stringify(await stats())}`);
console.log(`${meta.attribution.join(' · ')}\n`);

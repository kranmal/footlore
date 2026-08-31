// Tests for the food-and-shops pipeline and for the opening-hours parser.
//
// The rule these encode is the same one narrate.test.mjs encodes, applied to a
// tab where there is no article to quote: a line may only say what a tag says.
// So most of what is checked here is a *refusal* — no ratings, no inferred
// quality, no guessed closing time.
//
//   node server/local.test.mjs

import { typeWord, describe, detailOf, keep } from './local.mjs';
import { hoursToday, openNow } from './score.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32mok  \x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `\n         ${detail}` : ''}`); }
};
const eq = (name, got, want) => ok(name, got === want, `got:      ${JSON.stringify(got)}\n         expected: ${JSON.stringify(want)}`);
const same = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `got:      ${JSON.stringify(got)}\n         expected: ${JSON.stringify(want)}`);

const place = (over = {}) => ({
  kind: 'food', amenity: null, shop: null, cuisine: null,
  openingHours: null, tags: {}, ...over,
});

console.log('\n\x1b[1mfood and shops\x1b[0m\n');

// --- typeWord: the long tail is the whole problem --------------------------

eq('an amenity maps to its own word', typeWord(place({ amenity: 'cafe' })), 'café');
eq('fast_food is a takeaway, not "fast food"', typeWord(place({ amenity: 'fast_food' })), 'takeaway');
// The original allow-list of known goods left shop=photo rendering as "Photo."
eq('an unlisted shop value gets the word "shop" added',
  typeWord(place({ kind: 'shop', shop: 'photo' })), 'photo shop');
eq('a trade already names itself', typeWord(place({ kind: 'shop', shop: 'hairdresser' })), 'hairdresser');
eq('underscores become spaces', typeWord(place({ kind: 'shop', shop: 'musical_instrument' })), 'musical instrument shop');
eq('convenience is a corner shop', typeWord(place({ kind: 'shop', shop: 'convenience' })), 'corner shop');
eq('with neither tag, the tab decides the noun', typeWord(place({ kind: 'shop' })), 'shop');
eq('and on the food tab it is the other noun', typeWord(place({ kind: 'food' })), 'place to eat');

// --- describe: tags read out, nothing written ------------------------------

eq('cuisine sits in front of the type',
  describe(place({ amenity: 'restaurant', cuisine: 'italian' })),
  'Italian restaurant. A name and a pin, nothing else mapped.');

eq('two cuisines are joined with "and"',
  describe(place({ amenity: 'restaurant', cuisine: 'italian;pizza' })),
  'Italian and pizza restaurant. A name and a pin, nothing else mapped.');

// cuisine=coffee_shop on amenity=cafe used to read "coffee shop café".
ok('a cuisine that already names the type does not stutter',
  describe(place({ amenity: 'cafe', cuisine: 'coffee_shop' })).startsWith('Coffee shop.'),
  describe(place({ amenity: 'cafe', cuisine: 'coffee_shop' })));

eq('mapped extras are listed, in the tags\' own words',
  describe(place({ amenity: 'pub', tags: { outdoor_seating: 'yes', real_ale: 'yes' } })),
  'Pub. Outdoor seating, real ale.');

eq('diet tags become options, not a claim about the food',
  describe(place({ amenity: 'cafe', tags: { 'diet:vegan': 'yes' } })),
  'Café. Vegan options.');

// "Takeaway. Takeaway." — true twice and useful once.
ok('takeaway is not repeated on a takeaway',
  !/takeaway.*takeaway/i.test(describe(place({ amenity: 'fast_food', tags: { takeaway: 'yes' } }))),
  describe(place({ amenity: 'fast_food', tags: { takeaway: 'yes' } })));

// Repeated down a whole list, this read as an app apologising.
eq('with hours mapped, the apology is dropped',
  describe(place({ amenity: 'cafe', openingHours: 'Mo-Fr 09:00-17:00' })), 'Café.');

eq('with nothing else at all, the card says so',
  describe(place({ amenity: 'cafe' })), 'Café. A name and a pin, nothing else mapped.');

// The line is what is known, never what it is worth.
ok('no line implies quality',
  !/(best|popular|lovely|highly|great|recommended|favourite|top)/i.test(
    [describe(place({ amenity: 'restaurant', cuisine: 'italian' })),
      describe(place({ amenity: 'pub', tags: { real_ale: 'yes' } })),
      describe(place({ kind: 'shop', shop: 'books' }))].join(' ')));

// --- keep: which tab a pin belongs on --------------------------------------

ok('a bakery is food, not a shop', keep(place({ shop: 'bakery' }), 'food') && !keep(place({ shop: 'bakery' }), 'shop'));
ok('a bookshop is a shop', keep(place({ shop: 'books' }), 'shop'));
ok('a car repairer is not somewhere you browse', !keep(place({ shop: 'car_repair' }), 'shop'));
ok('a vacant unit is not a shop', !keep(place({ shop: 'vacant' }), 'shop'));
ok('a market is a shop despite being an amenity', keep(place({ amenity: 'marketplace' }), 'shop'));
ok('a restaurant is not a shop', !keep(place({ amenity: 'restaurant' }), 'shop'));
ok('a restaurant is food', keep(place({ amenity: 'restaurant' }), 'food'));

// --- detailOf: how much is known, never how good ---------------------------

ok('a described place outscores a bare pin',
  detailOf(place({ amenity: 'cafe', cuisine: 'coffee', openingHours: 'Mo-Fr 09:00-17:00' }))
  > detailOf(place({ amenity: 'cafe' })));
eq('a bare pin scores nothing', detailOf(place({ amenity: 'cafe' })), 0);
ok('the score is capped at 1',
  detailOf(place({
    amenity: 'pub', cuisine: 'british', openingHours: '24/7', website: 'https://example.com',
    heritage: '2', extract: new Array(300).fill('word').join(' '),
    tags: { outdoor_seating: 'yes', takeaway: 'yes', wheelchair: 'yes', real_ale: 'yes', delivery: 'yes', 'diet:vegan': 'yes' },
  })) <= 1);

console.log('\n\x1b[1mopening hours\x1b[0m\n');

// A Monday and a Sunday, both at 10:00, so the day-of-week arms are exercised.
const MON = new Date('2026-08-31T10:00:00');
const SUN = new Date('2026-08-30T10:00:00');

same('a weekday range applies on a weekday', hoursToday('Mo-Fr 09:00-17:00', MON), [[540, 1020]]);
same('and does not apply at the weekend', hoursToday('Mo-Fr 09:00-17:00', SUN), []);
same('a second rule is read too', hoursToday('Mo-Fr 07:30-18:00; Sa 07:30-17:00', MON), [[450, 1080]]);
same('24/7 is the whole day', hoursToday('24/7', MON), [[0, 1440]]);
same('a split day keeps both halves', hoursToday('Mo-Su 12:00-14:30,17:00-22:00', MON), [[720, 870], [1020, 1320]]);

// The refusals. A guessed closing time is worse than an admitted gap, because
// the walk builder would route a meal against it.
eq('sunrise-sunset is admitted as unknown', hoursToday('sunrise-sunset', MON), null);
eq('a nth-weekday rule is admitted as unknown', hoursToday('Su[1] 10:00-16:00', MON), null);
eq('no tag at all is unknown', hoursToday(null, MON), null);

eq('open now, inside the range', openNow({ openingHours: 'Mo-Fr 09:00-17:00' }, MON), true);
eq('shut, outside the range', openNow({ openingHours: 'Mo-Fr 12:00-14:00' }, MON), false);
// The distinction the whole app rests on: unknown is not closed.
eq('unknown hours are null, never false', openNow({ openingHours: 'sunrise-sunset' }, MON), null);
eq('no hours at all are null', openNow({ openingHours: null }, MON), null);

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);

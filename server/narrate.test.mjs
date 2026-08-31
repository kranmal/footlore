// Accuracy tests for the narration layer.
//
// The rule these encode: a card may be dull, but it may not be wrong. Anything
// the source doesn't support is rejected, even when it reads well.

import { verify, extractive, cleanExtract } from './narrate.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32mok  \x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `\n         ${detail}` : ''}`); }
};

const COMMERCIAL = {
  name: 'The Commercial Rooms',
  extract: 'The Commercial Rooms (grid reference ST587729) are on Corn Street in Bristol, England. ' +
    'Built in 1810 by Charles Busby, the building has sculpture by J. G. Bubb. Originally it housed a club ' +
    'for mercantile interests. The retained wind vane above the bar would let merchants know whether it was ' +
    'safe for their ships to negotiate the treacherous Avon Gorge. It is now a pub owned by Wetherspoons.',
  heritage: 'Grade II*',
  tags: { historic: 'building' },
};

console.log('\n\x1b[1mnarration accuracy\x1b[0m\n');

// --- verify: what must be rejected -----------------------------------------

ok('a date the source never mentions is rejected',
  !verify('Built in 1723 as a merchants\' club.', COMMERCIAL).ok,
  verify('Built in 1723 as a merchants\' club.', COMMERCIAL).reason);

ok('an architect the source never names is rejected',
  !verify('Designed by John Wood the Elder for Bristol\'s merchants.', COMMERCIAL).ok);

ok('a plausible but unsourced number is rejected',
  !verify('Its 40 columns face Corn Street.', COMMERCIAL).ok);

ok('an over-long line is rejected',
  !verify(Array(40).fill('word').join(' '), COMMERCIAL).ok);

ok('an empty line is rejected', !verify('   ', COMMERCIAL).ok);

// --- verify: what must be allowed ------------------------------------------

const good = 'The wind vane above the bar told merchants whether their ships could clear the Avon Gorge.';
ok('a line built only from the source passes', verify(good, COMMERCIAL).ok, verify(good, COMMERCIAL).reason);

ok('a sourced date passes', verify('Built in 1810 by Charles Busby.', COMMERCIAL).ok);

ok('the place\'s own name passes', verify('The Commercial Rooms began as a merchants\' club.', COMMERCIAL).ok);

ok('a line with no specifics at all passes', verify('Now a pub, once a merchants\' club.', COMMERCIAL).ok);

// --- extractive: quoted, not composed --------------------------------------

const line = extractive(COMMERCIAL);
ok('the fallback line is a verbatim substring of the cleaned source',
  cleanExtract(COMMERCIAL.extract).includes(line.replace(/…$/, '').trim()),
  line);

ok('the fallback passes its own verification', verify(line, COMMERCIAL).ok, line);

ok('grid references are dropped', !line.includes('ST587729') && !cleanExtract(COMMERCIAL.extract).includes('ST587729'));

ok('initials do not end the sentence', extractive(COMMERCIAL) !== 'Built in 1810 by Charles Busby, the building has sculpture by J.');

ok('a place with no article gets no line', extractive({ name: 'Nowhere' }) === null);

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);

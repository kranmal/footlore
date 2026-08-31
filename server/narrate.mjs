// The one-line reason on every feed card.
//
// With ANTHROPIC_API_KEY set, Claude writes them — one call per tile covering
// every place at once, cached permanently, because the story doesn't change.
// Without a key the app still works: it falls back to the best sentence of the
// Wikipedia intro, which is flat but is quoted verbatim from the source.
//
// Accuracy is the constraint, not a preference. A tour guide that invents a
// date is worse than one that says something dull, because the reader is
// standing in front of the building and cannot tell the difference. So every
// model-written line is checked against its source before it is shown, and
// anything that fails falls back to the quoted sentence. Nothing reaches a
// card that the source does not support.

import { get, set, TTL } from './cache.mjs';

const MODEL = process.env.FOOTLORE_MODEL ?? 'claude-sonnet-5';
const KEY = process.env.ANTHROPIC_API_KEY;

// Bumped whenever the fallback picker changes. Narration is cached forever —
// the story doesn't change — but an improved extractor should not leave old,
// worse lines on the cards. Claude-written lines are kept across bumps because
// they cost money and the model, not the picker, wrote them.
const EXTRACTIVE_VERSION = 2;

/**
 * Pick the most interesting sentence from an encyclopedia intro.
 *
 * Naively taking the first sentence gives you "The Commercial Rooms (grid
 * reference ST587729) are on Corn Street in Bristol, England" — a real result
 * from the first live run, and a fair demonstration of why narration is where
 * the value is. This picks the best available sentence instead of the first
 * one, which raises the floor without pretending to be the real thing.
 */
const SUPERLATIVE = /\b(oldest|first|only|last|largest|smallest|surviving|earliest|rare|unique|tallest)\b/i;
const GEOGRAPHY = /\b(is|are|was|were)\s+(a|an|the)?\s*[\w\s-]{0,30}\b(in|on|at|near)\b[^.]*\b(England|Bristol|United Kingdom)\b/i;

/** Wikipedia furniture nobody standing in the street wants to read. */
export function cleanExtract(extract) {
  if (!extract) return null;
  return extract
    .replace(/\s*\([^)]*(?:grid reference|pronounced|pronunciation|listen|IPA|born|\/[^)]*\/)[^)]*\)/gi, '')
    .replace(/\s*\([^)]*\b(?:mi|km|miles|kilometres|kilometers|ft|acres|ha)\b[^)]*\)/gi, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const balanced = (s) => (s.match(/\(/g) ?? []).length === (s.match(/\)/g) ?? []).length;

export function extractive(place) {
  if (!place.extract) return null;
  const cleaned = cleanExtract(place.extract);

  // Hide the full stops that don't end sentences before splitting, or
  // "sculpture by J. Foster" becomes a one-line card that stops at "by J."
  const DOT = '\u0001';
  const masked = cleaned
    .replace(/(\d)\.(\d)/g, `$1${DOT}$2`)                                  // 1.2 miles
    .replace(/\b(?:[A-Z]|St|Mr|Mrs|Dr|Rev|No|c|approx|e\.g|i\.e)\./g, (m) => m.slice(0, -1) + DOT);
  const sentences = (masked.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [masked])
    .map((s) => s.replaceAll(DOT, '.').trim())
    .filter(Boolean)
    // A fragment like "2 km) west from the village of Winsford." is what you
    // get when a bracket is split across sentences. It is not a sentence.
    .filter((s) => balanced(s) && /^[A-Z"'(]/.test(s));

  const rate = (s) => {
    let n = 0;
    if (/\b1[0-9]{3}\b|\b20[0-2][0-9]\b/.test(s)) n += 2;   // a date is a hook
    if (SUPERLATIVE.test(s)) n += 2;
    if (/\d/.test(s)) n += 1;
    if (GEOGRAPHY.test(s)) n -= 2;                            // "is a church in England"
    if (s.length > 200) n -= 2;
    if (s.length < 40) n -= 1;
    if (/^(It|They|He|She|These|Those|Its|Their|His|Her)\b/.test(s)) n -= 2;  // pronoun with no antecedent
    return n;
  };

  if (!sentences.length) return null;
  const best = sentences.slice(0, 4).reduce((a, b) => (rate(b) > rate(a) ? b : a), sentences[0]);
  const out = best.length > 165 ? `${best.slice(0, 162).replace(/[,;:\s]+\S*$/, '')}…` : best;
  return out || null;
}

/**
 * Check a model-written line against the source it was written from.
 *
 * Deliberately mechanical: it doesn't judge whether the line is *good*, only
 * whether every checkable specific in it — years, numbers, proper nouns —
 * appears in the source text. That catches the failure that matters (a
 * plausible invented fact) without a second model call, and it fails closed:
 * anything it can't confirm is rejected in favour of the quoted sentence.
 *
 * @returns {{ok:boolean, reason:string|null}}
 */
export function verify(line, place) {
  if (typeof line !== 'string' || !line.trim()) return { ok: false, reason: 'empty' };
  const words = line.trim().split(/\s+/);
  if (words.length > 32) return { ok: false, reason: 'too long' };

  const source = [
    place.extract ?? '',
    place.name ?? '',
    place.heritage ?? '',
    place.startDate ?? '',
    place.historic ?? '',
    ...Object.values(place.tags ?? {}),
  ].join(' ').toLowerCase();

  // Every number in the line must be in the source. A wrong date is the
  // single most likely invention and the single most embarrassing one.
  for (const n of line.match(/\b\d{1,4}(?:s)?\b/g) ?? []) {
    if (!source.includes(n.replace(/s$/, '').toLowerCase())) {
      return { ok: false, reason: `number not in source: ${n}` };
    }
  }

  // Proper nouns, ignoring the first word of the sentence.
  const KNOWN = new Set(['the', 'a', 'an', 'st', 'saint', 'i', 'ii', 'iii', 'grade', 'listed',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december', 'world', 'war']);
  for (const w of words.slice(1)) {
    const bare = w.replace(/[^A-Za-z'-]/g, '');
    if (bare.length < 3 || !/^[A-Z]/.test(bare)) continue;
    const key = bare.toLowerCase();
    if (KNOWN.has(key)) continue;
    if (!source.includes(key)) return { ok: false, reason: `name not in source: ${bare}` };
  }

  return { ok: true, reason: null };
}

function prompt(places) {
  const items = places.map((p, i) => {
    const facts = [
      p.historic && `type: ${p.historic}`,
      p.heritage && `listed: ${p.heritage}`,
      p.startDate && `built: ${p.startDate}`,
    ].filter(Boolean).join('; ');
    return `${i + 1}. ${p.name}${facts ? ` (${facts})` : ''}\n${(p.extract ?? '').slice(0, 900)}`;
  }).join('\n\n');

  return `You write the one-line reason shown on each card in a walking tour app. Someone is standing nearby with their phone out.

For each numbered place, write ONE sentence — the single most interesting, specific, repeatable thing about it. The test: would someone say it out loud to the person they're with?

Rules:
- Under 20 words. No preamble, no "this is", no "known for".
- Concrete detail over category. "The last surviving gate of the medieval city wall" beats "a historic church".
- Only what the source supports. If the source says nothing interesting, say the plainest true thing — never invent a fact, a date, or an anecdote.
- Every name, number and date you use must appear verbatim in that place's source text below. Lines are checked against it and rejected if they don't.
- If the source genuinely supports nothing worth saying, return a plain description rather than reaching.
- No exclamation marks, no second person, no "nestled" or "iconic".

Return ONLY a JSON array of strings, one per place, in order.

${items}`;
}

async function askClaude(places) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1400,
      messages: [{ role: 'user', content: prompt(places) }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.content.map((b) => b.text ?? '').join('');
  const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
  if (!Array.isArray(arr)) throw new Error('model did not return an array');
  return arr;
}

/**
 * Attach `why` and `whySource` to each place.
 * @returns {Promise<{places:object[], mode:'claude'|'extractive', generated:number}>}
 */
export async function narrate(places) {
  const out = [...places];
  const todo = [];

  for (let i = 0; i < out.length; i++) {
    const hit = await get('why', out[i].id, TTL.narration);
    const stale = hit?.source === 'extractive' && hit.v !== EXTRACTIVE_VERSION;
    if (hit && !stale) out[i] = { ...out[i], why: hit.why, whySource: hit.source };
    else todo.push(i);
  }

  if (!todo.length) return { places: out, mode: KEY ? 'claude' : 'extractive', generated: 0, rejected: 0 };

  let lines = null;
  if (KEY) {
    try {
      lines = await askClaude(todo.map((i) => out[i]));
    } catch (e) {
      console.error(`  narration fell back to extractive: ${e.message}`);
    }
  }

  let rejected = 0;
  for (let n = 0; n < todo.length; n++) {
    const i = todo[n];
    let fromModel = lines?.[n];

    if (fromModel) {
      const check = verify(fromModel, out[i]);
      if (!check.ok) {
        console.error(`  rejected line for ${out[i].name}: ${check.reason}`);
        fromModel = null;
        rejected++;
      }
    }

    const why = (typeof fromModel === 'string' && fromModel.trim()) || extractive(out[i]);
    const source = fromModel ? 'claude' : 'extractive';
    if (why) {
      out[i] = { ...out[i], why, whySource: source };
      await set('why', out[i].id, { why, source, v: EXTRACTIVE_VERSION });
    } else {
      out[i] = { ...out[i], why: null, whySource: null };
    }
  }

  return {
    places: out,
    mode: lines ? 'claude' : 'extractive',
    generated: todo.length,
    rejected,
  };
}

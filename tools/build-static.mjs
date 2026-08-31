// Build the GitHub Pages version: the same app, with the server removed.
//
// Pages serves static files only, so the pipeline that normally runs in
// server/ has to run in the page instead. Overpass, Wikidata and Wikipedia all
// send `Access-Control-Allow-Origin: *`, so the browser can call them directly
// — checked, not assumed.
//
// What is lost is the Claude narration: a static page cannot hold an API key
// without publishing it, so this build is quoting-only, permanently. It says so
// on screen, which was already true of the server build without a key.
//
//   node tools/build-static.mjs [outdir]      default: docs/
//
// docs/ because that is one of the two folders GitHub Pages will serve from,
// and the only one that doesn't need a separate branch.

import { mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(ROOT, 'docs');

const LIB = ['places.mjs', 'local.mjs', 'overpass.mjs', 'wiki.mjs', 'score.mjs', 'narrate.mjs'];

/** Rewrites that turn a server module into a browser module. */
function browserify(src) {
  return src
    .replaceAll("from './cache.mjs'", "from './cache.mjs'")          // filename kept; content swapped
    .replaceAll("from '../solver/geo.mjs'", "from './geo.mjs'")
    // No process in a page. The key is deliberately null: see the header.
    .replace(/process\.env\.FOOTLORE_MODEL \?\? /, '')
    .replace(/process\.env\.ANTHROPIC_API_KEY/, 'null')
    // Browsers refuse to set user-agent and log a console error for trying.
    .replace(/^\s*'user-agent':.*$/gm, '')
    // Mirrors without CORS headers are dead weight in a page: the request fails
    // at the preflight, so they cost a round trip and never answer.
    .replace(/^.*no CORS: server build only.*$\n/gm, '');
}

const read = (p) => readFile(join(ROOT, p), 'utf8');

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'lib'), { recursive: true });

for (const f of LIB) {
  await writeFile(join(OUT, 'lib', f), browserify(await read(`server/${f}`)), 'utf8');
}
await writeFile(join(OUT, 'lib', 'cache.mjs'), await read('server/cache.browser.mjs'), 'utf8');
await writeFile(join(OUT, 'lib', 'geo.mjs'), await read('solver/geo.mjs'), 'utf8');

// The data adapter: run the pipeline here instead of asking a server to.
await writeFile(join(OUT, 'api.js'), `// Data adapter — static build. No server: the pipeline runs in this tab.
import { feed } from './lib/places.mjs';

// This build is quoting-only and always will be. Saying "set a key" here would
// be advice nobody reading it can take.
export const QUOTING_NOTE =
  'This version runs entirely in your browser with no server behind it, so there is nowhere to keep ' +
  'an API key — quoting is the only honest option, and it is the accurate one.';

export async function loadNearby({ lat, lng, radius, seen, kind = 'see' }) {
  return feed({ kind, lat, lng, radius, limit: 20, seen });
}
`, 'utf8');

await cp(join(ROOT, 'web', 'app.js'), join(OUT, 'app.js'));
await cp(join(ROOT, 'web', 'styles.css'), join(OUT, 'styles.css'));

// index.html, plus the things every kranmal.github.io project carries.
const head = `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6981194323350325" crossorigin="anonymous"></script>
</head>`;
const footer = `<footer class="attrib" id="attrib"></footer>
  <footer class="attrib"><a href="https://kranmal.github.io/privacy.html">Privacy</a></footer>`;

let html = await read('web/index.html');
html = html.replace('</head>', head).replace('<footer class="attrib" id="attrib"></footer>', footer);
await writeFile(join(OUT, 'index.html'), html, 'utf8');

// Pages runs Jekyll by default, which skips files it doesn't recognise.
await writeFile(join(OUT, '.nojekyll'), '', 'utf8');

console.log(`static build -> ${OUT}`);
console.log('narration: quoting only (no key can ship in a static page)');

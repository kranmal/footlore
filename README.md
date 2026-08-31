# Footlore

A pocket tour guide. It reads the ground you're standing on: what's nearby, and
one sentence on why it's worth crossing the road for.

Phase 01 — sights only. No food layer, no map, no accounts.

```bash
npm start          # http://localhost:4173
npm test           # 27 tests: route solver + narration accuracy
npm run probe      # the same pipeline, printed to a terminal
```

No dependencies. Node 20 or newer, nothing to install.

## What it does

```
Overpass (OSM)  ->  Wikidata/Wikipedia  ->  story floor  ->  rank  ->  narrate
```

The client never talks to a provider and never holds a key. Everything is
cached server-side at three different lifetimes, because Overpass is slow and
rate-limited, Wikipedia is polite-use, and narration costs money.

**The story floor** is the part that matters. A typical city-centre query
returns ~470 mapped objects and roughly 380 of them are dropped before ranking,
including a Royal Mail post box tagged `historic=memorial`. A short feed of
things worth seeing beats a long one you have to filter yourself.

## Accuracy

A guide that invents a date is worse than a dull one, because the reader is
standing in front of the building and cannot tell the difference.

- Without `ANTHROPIC_API_KEY`, every line is a sentence **quoted verbatim** from
  the Wikipedia intro — chosen, not paraphrased.
- With a key, Claude writes the lines, and each one is checked back against its
  own source: every number, year, and proper noun must appear there. Anything
  unconfirmed is rejected and the quoted sentence is shown instead. The count of
  rejections is displayed in the feed rather than hidden.

`node server/narrate.test.mjs` pins this: an invented date, an unsourced
architect, and a plausible unsourced number are all rejected.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4173` | HTTP port |
| `ANTHROPIC_API_KEY` | unset | Claude narration; falls back to quoted sentences |
| `FOOTLORE_MODEL` | `claude-sonnet-5` | Narration model |
| `FOOTLORE_CACHE` | `./.cache` | Cache directory — point at a writable volume |

## The static build

`npm run build:static` produces `docs/` — the same app with the server removed,
for GitHub Pages. Overpass, Wikidata and Wikipedia all send
`Access-Control-Allow-Origin: *`, so the page calls them directly; the disk
cache is swapped for localStorage and the Overpass mirrors without CORS headers
are dropped from the failover list.

It is **quoting-only, permanently**: a static page has nowhere to keep an API
key, so Claude narration is not available there and the page says so rather than
implying a key would help. Everything else — the story floor, ranking, widening,
the empty state — is the same code.

Live at <https://kranmal.github.io/footlore/>.

## Deploying the server

One long-lived Node process and one writable directory. It listens on `$PORT`,
so it runs as-is on Fly, Render, Railway, or a plain VM behind nginx:

```bash
PORT=8080 FOOTLORE_CACHE=/data/cache ANTHROPIC_API_KEY=… node server/index.mjs
```

`GET /healthz` reports narration mode, uptime, and the size of the recent-places
map, for whatever is watching the process.

A `Dockerfile` and a `fly.toml` are checked in. Fly is the closest fit to the
shape below — a single machine with a volume, never auto-stopped:

```bash
fly launch --no-deploy --copy-config
```

```bash
fly volumes create footlore_cache --size 1 --region lhr
```

```bash
fly secrets set ANTHROPIC_API_KEY=sk-ant-…
```

```bash
fly deploy
```

Skip the third command to run in quoting mode; the app says which mode it is in
on every screen, so nothing is silently degraded.

The cache should be a persistent volume. It isn't required for correctness —
a cold start just re-queries — but Overpass takes up to 30 seconds in sparse
areas and will rate-limit an origin that asks too often.

Not serverless-shaped as written: the in-memory `recent` map backing
`/api/place/:id` and the disk cache both assume one process with a filesystem.
The map is capped at 4000 entries so the process can stay up indefinitely.

## Layout

```
server/   place service — overpass, wiki, score, narrate, cache, http
solver/   walk routing — greedy insertion, constrained 2-opt, edit semantics
web/      the feed and detail sheet
```

`solver/` is Phase 04 work, built early and tested against fixtures; nothing in
the web app calls it yet.

## Attribution

Place data © OpenStreetMap contributors (ODbL). Text and images from Wikipedia
(CC BY-SA). Both are credited in the app footer and on every detail card.

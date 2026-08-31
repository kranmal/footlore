# Footlore

A pocket tour guide. It reads the ground you're standing on: what's nearby, and
one sentence on why it's worth crossing the road for.

Four tabs — **Sights**, **Food**, **Shops**, **Walk** — and a directions button
on every card that hands the walk to the phone's own map app. No map of its own,
no accounts.

```bash
npm start          # http://localhost:4173
npm test           # 66 tests: route solver, narration accuracy, tags and hours
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

Two Overpass failures answer HTTP 200 with an empty result and are therefore
indistinguishable from "nothing is mapped here" — a timed-out query, which
carries a `remark`, and a mirror whose database has not finished loading, which
reports a `timestamp_osm_base` that is not a date. Both are caught and failed
over rather than cached, because the alternative is telling somebody standing in
central Bristol that there is nothing around them.

**The story floor** is the part that matters. A typical city-centre query
returns ~470 mapped objects and roughly 380 of them are dropped before ranking,
including a Royal Mail post box tagged `historic=memorial`. A short feed of
things worth seeing beats a long one you have to filter yourself.

## Food and shops

The other two tabs run the same fetch-rank-show pipeline with the story floor
taken out, because "is there anything to say about this?" is the wrong question
to ask of a sandwich shop. What replaces it is deliberately modest:

- **No ratings, anywhere.** OpenStreetMap does not carry them, and every source
  that does charges per request and cannot be reached from a static page at all.
  So these lists are ordered by distance, by opening hours, and by how much the
  map actually records — never by quality, and the feed says so on screen.
- **Lines are read off the tags**, not written: cuisine, diet, outdoor seating,
  takeaway, step-free access. Where nothing but a name is mapped, the card says
  that too.
- **Wikipedia articles are not quoted here.** A shop pin's article is usually
  about the building it stands in — quoting "part rebuilt as a facsimile in
  1993" under a travel agent's name would be true of the wall and false of the
  business. The article is shown in the detail sheet, labelled as what it is.

## The Walk tab

Greedy insertion, then a constrained 2-opt, over the sights the feed already
loaded — no second round of queries. A meal is optional and, when asked for, is
placed first, because a kitchen's closing time is the only hard constraint in
the problem and choosing the restaurant last means routinely discovering at the
end that it shut twenty minutes ago.

Almost every number on that screen is an estimate, and the panel says which:

- Walking times are straight-line distance × 1.35. No routing engine, so a river
  or a railway between two stops is not accounted for.
- Time at each stop is a flat guess — 45 minutes for a museum, 10 where there is
  an article to read, 5 otherwise. Nothing in the map records how long a place
  takes, so nothing here pretends to have derived it.
- Opening hours are checked only for the meal, only where they are mapped, and
  only in the plain `Mo-Fr 09:00-17:00` forms `hoursToday()` actually reads.
  Anything else comes back as *unknown*, never as *closed* — and when the chosen
  place has no hours at all, the panel says so by name.

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

`solver/` is served to the page as-is by both builds — it is plain browser-safe
ESM — and `web/walkview.js` is the only thing that adapts between the feed and
it. Its tests still run against `solver/fixtures.mjs`; the live catalogue is
injected as `plan.catalog`.

## Attribution

Place data © OpenStreetMap contributors (ODbL). Text and images from Wikipedia
(CC BY-SA). Both are credited in the app footer and on every detail card.

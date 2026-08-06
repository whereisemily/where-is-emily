# ✈️ Where is Emily?

A live tracker for Emily's trip from Charlotte to Wellington, New Zealand — and back
again in October. Static site, no build step, no API keys.

Hosted on **Cloudflare Pages**: <https://where-is-emily.pages.dev>

## How it works

Two sources feed the page, in priority order:

1. **Real ADS-B positions**, via the `/api/live` Cloudflare Pages Function, which
   proxies a public ADS-B feed server-side. The feeds send no CORS headers, so the
   browser cannot call them directly. The page passes the callsigns it already holds,
   so the function never keeps a second copy of the itinerary to drift against.
2. **The schedule.** When there's no recent fix, the position is dead-reckoned along
   the great circle between the two airports, and carried forward from the last real
   fix using its reported track and ground speed.

That fallback isn't a nicety. ADS-B is a network of volunteer ground receivers, so the
13-hour San Francisco → Auckland leg is invisible for nearly all of it. The map should
never go blank over the Pacific.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | Markup and all styling |
| `app.js` | Journey engine, map projection, rendering |
| `data/itinerary.js` | All 8 flights, times stored in UTC |
| `data/mapdata.js` | Natural Earth 110m coastlines + US states, simplified |
| `data/live.json` | Latest ADS-B fix, written by the Action |
| `scripts/track.js` | The poller |
| `.github/workflows/track.yml` | The 10-minute cron |

## Notes for future editing

- **Times are UTC in `data/itinerary.js`.** This is deliberate. NZ28 leaves Auckland
  7:50pm Oct 20 and lands in Houston 3:25pm Oct 20 — "before" it left — because it
  crosses the date line. In UTC it's just a 13h35m flight. Don't convert these to
  local times.
- **Callsigns follow the operating carrier**, not the ticketed United number: Mesa
  flies as `ASH`, Republic as `RPA`, Air New Zealand as `ANZ`. `data/itinerary.js`
  lists candidates per flight and the tracker tries each in order.
- **Displayed times are scheduled times.** Delays aren't reflected unless the aircraft
  is being tracked live, in which case the map position is real but the countdown
  still counts toward the scheduled arrival.
- **The map is centred on longitude 160°W** so the route never crosses the frame edge
  and New Zealand sits beside the US rather than a hemisphere away.
- **The upstream order in `functions/api/live.js` matters.** adsb.lol rate-limits by
  source IP, and Cloudflare Workers egress from IPs shared across the whole platform,
  so adsb.lol returns 429 to the function no matter how little it asks for — while
  answering a home connection perfectly. That is why there are three upstreams and
  why adsb.lol is last. If positions ever stop appearing, call
  `/api/live?cs=UAL382` directly: the `trace` array in a `found:false` response
  reports what each upstream said.
- **The GitHub Action and `data/live.json` are legacy**, kept only as a fallback path
  for a static host with no functions. The workflow is disabled; the Cloudflare
  function replaced it and gives fresher positions.

## Deploying

    npx wrangler pages deploy <folder> --project-name where-is-emily --branch main

Only `index.html`, `app.js`, `robots.txt`, `data/` and `functions/` need to ship.

## Running locally

Open `index.html` directly — the map and itinerary are plain `.js` files so it works
over `file://`. Only `data/live.json` needs a server; without it the page just runs in
schedule mode.

To poll once by hand:

```bash
node scripts/track.js
```

Map data © [Natural Earth](https://www.naturalearthdata.com/). Positions © the
[adsb.lol](https://adsb.lol) contributors.

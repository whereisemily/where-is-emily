# ✈️ Where is Emily?

A live tracker for Emily's trip from Charlotte to Wellington, New Zealand — and back
again in October. Static site, no build step, no API keys.

## How it works

Two sources feed the page, in priority order:

1. **Real ADS-B positions.** A GitHub Action polls [adsb.lol](https://adsb.lol) every
   10 minutes for whichever flight is currently airborne and commits the result to
   `data/live.json`. adsb.lol sends no CORS headers, so the browser can't call it
   directly — polling server-side and committing the answer means the page reads it
   same-origin, with no key to leak in a public repo.
2. **The schedule.** When there's no recent fix, the position is dead-reckoned along
   the great circle between the two airports.

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
- **Don't speed the cron back up to 5 minutes.** Every commit it makes triggers a
  Pages rebuild, and Pages soft-limits builds to 10 per hour. Between polls the page
  carries the last fix forward along its reported track and ground speed (capped at
  20 minutes), so a slower cron costs very little accuracy.
- **The Action heartbeats once a day.** GitHub disables scheduled workflows after 60
  days of repo inactivity, and there are 73 days between arrival and the flight home,
  so the tracker would otherwise be silently dead before the return trip.

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

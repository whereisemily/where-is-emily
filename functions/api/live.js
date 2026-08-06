/* Cloudflare Pages Function: GET /api/live?cs=UAL382,ASH6236
 *
 * adsb.lol serves no CORS headers, so the browser cannot call it directly.
 * This proxies the request server-side and hands back a single normalised
 * position, which is why the site no longer needs a cron job committing
 * data/live.json every ten minutes - positions are fresh on every load.
 *
 * The page sends the callsigns because it already holds the itinerary; keeping
 * a second copy of the schedule in here would only give it something to drift
 * against. Callsigns are format-checked and capped so this cannot be used as a
 * general-purpose open proxy.
 */

const CALLSIGN = /^[A-Z0-9]{3,8}$/;
const MAX_CANDIDATES = 4;

/* Several upstreams, tried in order.
 *
 * adsb.lol rate-limits by source IP, and Cloudflare Workers egress from IPs
 * shared across the whole platform - so it answers a home connection fine while
 * returning 429 to this function regardless of how little we ask for. These
 * feeds are all tar1090-derived and return the same {ac:[...]} shape, so
 * failing over between them costs nothing but makes the endpoint far more
 * robust than any single source. */
const UPSTREAMS = [
  { name: 'adsb.fi', url: cs => 'https://opendata.adsb.fi/api/v2/callsign/' + cs },
  { name: 'airplanes.live', url: cs => 'https://api.airplanes.live/v2/callsign/' + cs },
  { name: 'adsb.lol', url: cs => 'https://api.adsb.lol/v2/callsign/' + cs }
];

function json(body, status = 200, maxAge = 30) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Shared cache: 20 viewers refreshing does not mean 20 hits on adsb.lol.
      'cache-control': `public, max-age=${maxAge}`,
      'access-control-allow-origin': '*'
    }
  });
}

/** Freshest hit that actually carries a position. */
function bestAircraft(list) {
  const withPos = (list || []).filter(
    a => typeof a.lat === 'number' && typeof a.lon === 'number'
  );
  if (!withPos.length) return null;
  return withPos.sort((a, b) => (a.seen_pos ?? 999) - (b.seen_pos ?? 999))[0];
}

export async function onRequest({ request }) {
  const url = new URL(request.url);
  const candidates = (url.searchParams.get('cs') || '')
    .toUpperCase()
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES);

  if (!candidates.length || !candidates.every(c => CALLSIGN.test(c))) {
    return json({ error: 'expected ?cs= one to four A-Z0-9 callsigns' }, 400, 0);
  }

  // Kept so a silent upstream refusal is diagnosable instead of looking
  // identical to "no receiver heard the aircraft".
  const trace = [];

  for (const cs of candidates) {
    for (const src of UPSTREAMS) {
      let res;
      try {
        res = await fetch(src.url(encodeURIComponent(cs)), {
          headers: { 'user-agent': 'where-is-emily/1.0 (personal flight tracker)' },
          cf: { cacheTtl: 20, cacheEverything: true }
        });
      } catch (e) {
        trace.push({ cs, src: src.name, error: String(e && e.message || e).slice(0, 100) });
        continue;   // upstream hiccup: try the next source
      }
      if (!res.ok) {
        trace.push({ cs, src: src.name, status: res.status });
        continue;
      }

      let feed;
      try {
        feed = await res.json();
      } catch (e) {
        trace.push({ cs, src: src.name, parse: 'not json' });
        continue;
      }

      const ac = bestAircraft(feed && feed.ac);
      if (!ac) {
        trace.push({ cs, src: src.name, heard: 0 });
        continue;
      }

      return json({
        found: true,
        callsign: cs,
        source: src.name,
        lat: +ac.lat.toFixed(4),
        lon: +ac.lon.toFixed(4),
        alt: typeof ac.alt_baro === 'number' ? ac.alt_baro : null,
        gs: typeof ac.gs === 'number' ? ac.gs : null,
        track: typeof ac.track === 'number' ? ac.track : null,
        reg: ac.r || null,
        type: ac.t || null,
        ts: Math.round((feed.now || Date.now()) / 1000 - (ac.seen_pos || 0))
      });
    }
  }

  // Nothing heard. Over open ocean this is the normal case, not an error, so
  // it is cached briefly and the page falls back to dead reckoning.
  return json({ found: false, trace }, 200, 20);
}

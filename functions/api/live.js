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
const LEG = /^[A-Z0-9]{2,16}$/;
const MAX_CANDIDATES = 4;
const TRAIL_PREFIX = 'trail:';

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

/* Where the actual flown path comes from. tar1090 keeps a per-aircraft trace
 * for the last day, which is the real track - departure turns, the step climbs,
 * the wind-corrected routing - rather than the idealised great circle between
 * two airports. Only adsb.lol serves these publicly; airplanes.live and
 * adsbexchange both 403 the trace files. */
const TRACE = hex =>
  'https://globe.adsb.lol/data/traces/' + hex.slice(-2) + '/trace_full_' + hex + '.json';

const MAX_TRAIL_POINTS = 220;

function validHex(hex) {
  return typeof hex === 'string' && /^[0-9a-f]{6}$/i.test(hex);
}

/** On the ground or low enough to be a departure/arrival rather than cruise. */
function low(alt) {
  return alt === 'ground' || (typeof alt === 'number' && alt < 500);
}

/**
 * The trace covers the whole day and several flights of the same airframe.
 * Everything after the last on-ground point is the flight it is on now.
 */
function trailFromTrace(feed, completed = false) {
  const pts = Array.isArray(feed && feed.trace) ? feed.trace : [];
  if (pts.length < 2) return null;

  // Once the aircraft has landed, tar1090 continues with ground points. Find
  // the last airborne point, but retain the first touchdown point as the
  // trail's endpoint so a saved leg reaches the destination.
  let end = pts.length - 1;
  if (completed) {
    while (end >= 0 && pts[end][3] === 'ground') end--;
    if (end < 1) return null;
  }

  // A live trace ends at cruise, but a completed one ends on final approach,
  // which is itself below the departure threshold. Step back over that landing
  // tail first, otherwise the search below stops on the arrival and the whole
  // leg collapses to a couple of points over the destination runway.
  let i = end;
  while (i > 0 && low(pts[i][3])) i--;

  let start = 0;
  for (; i >= 0; i--) {
    if (low(pts[i][3])) { start = i; break; }
  }

  const segEnd = completed && end < pts.length - 1 ? end + 1 : end;
  const seg = pts.slice(start, segEnd + 1).filter(p => typeof p[1] === 'number' && typeof p[2] === 'number');
  if (seg.length < 2) return null;

  // Even sampling, but never drop the newest point - that is where the
  // aircraft actually is, and the trail has to meet the plane icon.
  const step = Math.max(1, Math.ceil(seg.length / MAX_TRAIL_POINTS));
  const out = [];
  for (let i = 0; i < seg.length; i += step) {
    out.push([+seg[i][1].toFixed(3), +seg[i][2].toFixed(3)]);
  }
  const last = seg[seg.length - 1];
  const tail = [+last[1].toFixed(3), +last[2].toFixed(3)];
  if (out.length === 0 || out[out.length - 1][0] !== tail[0] || out[out.length - 1][1] !== tail[1]) {
    out.push(tail);
  }
  return out.length >= 2 ? out : null;
}

async function fetchTrail(hex, trace, completed = false) {
  if (!validHex(hex)) return null;
  try {
    const res = await fetch(TRACE(hex.toLowerCase()), {
      headers: { 'user-agent': 'where-is-emily/1.0 (personal flight tracker)' },
      cf: { cacheTtl: 30, cacheEverything: true }
    });
    if (!res.ok) { trace.push({ trail: 'trace', status: res.status }); return null; }
    return trailFromTrace(await res.json(), completed);
  } catch (e) {
    trace.push({ trail: 'trace', error: String(e && e.message || e).slice(0, 100) });
    return null;
  }
}

async function readSavedTrails(env, trace) {
  const store = env && env.FLIGHT_TRAILS;
  if (!store) return {};

  try {
    const listed = await store.list({ prefix: TRAIL_PREFIX });
    const entries = await Promise.all(listed.keys.map(async key => {
      const value = await store.get(key.name, 'json');
      return value && Array.isArray(value.trail) ? [key.name.slice(TRAIL_PREFIX.length), value.trail] : null;
    }));
    return Object.fromEntries(entries.filter(Boolean));
  } catch (e) {
    trace.push({ trailStore: String(e && e.message || e).slice(0, 100) });
    return {};
  }
}

async function saveTrail(env, leg, trail, meta) {
  const store = env && env.FLIGHT_TRAILS;
  if (!store || !LEG.test(leg) || !Array.isArray(trail) || trail.length < 2) return false;

  try {
    const key = TRAIL_PREFIX + leg;
    // The first successful save wins. Repeated viewers and refreshes therefore
    // do not create a write storm or replace a complete trail with a bad one.
    if (await store.get(key)) return false;

    await store.put(key, JSON.stringify({
      leg,
      trail,
      callsign: meta.callsign || null,
      hex: meta.hex || null,
      savedAt: new Date().toISOString()
    }));
    return true;
  } catch {
    // KV is an enhancement; a binding outage must not hide live position data.
    return false;
  }
}

/** Freshest hit that actually carries a position. */
function bestAircraft(list) {
  const withPos = (list || []).filter(
    a => typeof a.lat === 'number' && typeof a.lon === 'number'
  );
  if (!withPos.length) return null;
  return withPos.sort((a, b) => (a.seen_pos ?? 999) - (b.seen_pos ?? 999))[0];
}

export async function onRequest({ request, env }) {
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

  const leg = (url.searchParams.get('leg') || '').toUpperCase();
  const arrivalMs = Number(url.searchParams.get('arr'));
  const finalizing = url.searchParams.get('finalize') === '1';
  const fallbackHex = (url.searchParams.get('hex') || '').toLowerCase();
  const canFinalize = finalizing && LEG.test(leg) && Number.isFinite(arrivalMs) && Date.now() >= arrivalMs;

  // Kept so a silent upstream refusal is diagnosable instead of looking
  // identical to "no receiver heard the aircraft".
  const trace = [];
  const trails = await readSavedTrails(env, trace);

  async function response(body, status = 200) {
    return json(Object.assign({ trails }, body), status, canFinalize ? 0 : 30);
  }

  if (canFinalize && trails[leg]) return response({ found: false, saved: true });

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

      // A missing trail is not fatal — the page falls back to the great circle.
      const trail = await fetchTrail(ac.hex, trace, canFinalize);

      // The trace file lags the live feed by a few minutes, so it stops short
      // of where the aircraft actually is. Extend it to the live fix, or the
      // drawn track ends in mid-air behind the plane icon.
      if (trail) {
        const end = trail[trail.length - 1];
        const here = [+ac.lat.toFixed(3), +ac.lon.toFixed(3)];
        if (end[0] !== here[0] || end[1] !== here[1]) trail.push(here);
      }

      if (canFinalize && trail && await saveTrail(env, leg, trail, { callsign: cs, hex: ac.hex })) {
        trails[leg] = trail;
      }

      return response({
        found: true,
        callsign: cs,
        source: src.name,
        hex: ac.hex || null,
        trail: trail,
        trailNote: trail ? undefined : trace.filter(t => t.trail).slice(-1)[0],
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

  // The aircraft may have disappeared from the live feed immediately after
  // parking. The browser supplies the last known hex from the same page load,
  // so the trace can still be fetched and finalized without trusting its path.
  if (canFinalize && validHex(fallbackHex) && !trails[leg]) {
    const trail = await fetchTrail(fallbackHex, trace, true);
    if (trail && await saveTrail(env, leg, trail, { callsign: candidates[0], hex: fallbackHex })) {
      trails[leg] = trail;
    }
  }

  // Nothing heard. Over open ocean this is the normal case, not an error, so
  // it is cached briefly and the page falls back to dead reckoning.
  return response({ found: false, trace }, 200);
}

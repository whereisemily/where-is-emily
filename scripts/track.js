/* Polls adsb.lol for whichever of Emily's flights is currently airborne and
 * writes data/live.json. Run by hand from .github/workflows/track.yml; the
 * schedule is gone now that /api/live answers from Cloudflare on every load.
 *
 * adsb.lol sends no CORS headers, so the browser can't call it directly — this
 * runs server-side and commits the result, which the page then reads
 * same-origin. Free, keyless, and no secret ends up in a public repo.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, 'data', 'live.json');

// Reuse the page's itinerary rather than keeping a second copy in sync.
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'data', 'itinerary.js'), 'utf8'), sandbox);
const FLIGHTS = sandbox.window.FLIGHTS;

const NOW = Date.now();
const LEAD_MS = 45 * 60 * 1000;   // start looking before scheduled departure
const TRAIL_MS = 45 * 60 * 1000;  // keep looking after scheduled arrival (delays)
const KEEP_MS = 3 * 60 * 60 * 1000;
const HEARTBEAT_MS = 20 * 60 * 60 * 1000;

function active(f) {
  return NOW >= Date.parse(f.dep) - LEAD_MS && NOW <= Date.parse(f.arr) + TRAIL_MS;
}

async function getJSON(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'where-is-emily/1.0 (personal flight tracker)' }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Pick the best ADS-B hit: must have a position, prefer the freshest. */
function bestAircraft(list) {
  const withPos = (list || []).filter(a => typeof a.lat === 'number' && typeof a.lon === 'number');
  if (!withPos.length) return null;
  return withPos.sort((a, b) => (a.seen_pos ?? 999) - (b.seen_pos ?? 999))[0];
}

async function main() {
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
  } catch { /* first run */ }

  const flights = Object.assign({}, prev.flights || {});
  // Drop stale entries so the file doesn't grow a museum of old positions.
  for (const k of Object.keys(flights)) {
    if (!flights[k] || NOW - flights[k].ts * 1000 > KEEP_MS) delete flights[k];
  }

  const live = FLIGHTS.filter(active);
  let found = 0;

  for (const f of live) {
    for (const cs of f.callsigns) {
      const j = await getJSON('https://api.adsb.lol/v2/callsign/' + encodeURIComponent(cs));
      const ac = bestAircraft(j && j.ac);
      if (!ac) continue;

      flights[f.n] = {
        callsign: cs,
        lat: +ac.lat.toFixed(4),
        lon: +ac.lon.toFixed(4),
        alt: typeof ac.alt_baro === 'number' ? ac.alt_baro : null,
        gs: typeof ac.gs === 'number' ? ac.gs : null,
        track: typeof ac.track === 'number' ? ac.track : null,
        reg: ac.r || null,
        type: ac.t || null,
        ts: Math.round((j.now ? j.now : NOW) / 1000 - (ac.seen_pos || 0)),
        source: 'adsb.lol'
      };
      found++;
      console.log(`${f.n} (${cs}): ${ac.lat.toFixed(3)}, ${ac.lon.toFixed(3)} @ ${ac.alt_baro} ft`);
      break;
    }
    if (!flights[f.n]) console.log(`${f.n}: airborne per schedule but no ADS-B contact`);
  }

  if (!live.length) console.log('No flight active right now.');

  const stale = !prev.updated || NOW - Date.parse(prev.updated) > HEARTBEAT_MS;
  if (found === 0 && !live.length && !stale) {
    console.log('Nothing to do; skipping write to avoid an empty commit.');
    return;
  }

  const out = {
    updated: new Date(NOW).toISOString(),
    note: 'Positions from adsb.lol. Absent entries mean no ground receiver could hear the aircraft.',
    flights
  };
  fs.writeFileSync(LIVE, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote live.json (${Object.keys(flights).length} tracked).`);
}

main().catch(e => { console.error(e); process.exit(1); });

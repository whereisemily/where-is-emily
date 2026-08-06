/* Where is Emily? — journey engine + map.
 *
 * Two sources of truth, in priority order:
 *   1. data/live.json  — real ADS-B positions, committed by the GitHub Action.
 *   2. the schedule    — great-circle dead reckoning between departure/arrival.
 *
 * Source 2 always works, which matters more than it sounds: ADS-B is a network
 * of volunteer ground receivers, so the 13-hour SFO->AKL leg is invisible for
 * almost its entire length. The map should never go blank over the Pacific.
 */
(function () {
  'use strict';

  var AIRPORTS = window.AIRPORTS;
  var FLIGHTS = window.FLIGHTS.map(function (f) {
    return Object.assign({}, f, { depMs: Date.parse(f.dep), arrMs: Date.parse(f.arr) });
  });

  var LIVE_MAX_AGE_MS = 25 * 60 * 1000;   // older than this and we stop trusting it
  var MI_PER_KM = 0.621371;

  var liveData = null;      // parsed data/live.json
  var selectedTrip = null;  // 'out' | 'home' — null until first auto-pick

  // ---------------------------------------------------------------- geometry

  var LON0 = -160;          // centre the frame on the Pacific so the route never
                            // crosses the frame edge and NZ sits beside the US
  var X0 = -55, X1 = 95, LAT_TOP = 55, LAT_BOT = -48;
  var W = 1500;

  function mercY(lat) {
    var r = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + r / 2));
  }
  var YT = mercY(LAT_TOP), YB = mercY(LAT_BOT);
  var H = W * (YT - YB) / ((X1 - X0) * Math.PI / 180);

  function shiftLon(lon) {
    return ((lon - LON0) % 360 + 540) % 360 - 180;
  }
  function project(lat, lon) {
    return [
      (shiftLon(lon) - X0) / (X1 - X0) * W,
      (YT - mercY(lat)) / (YT - YB) * H
    ];
  }

  function toVec(lat, lon) {
    var a = lat * Math.PI / 180, b = lon * Math.PI / 180;
    return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)];
  }
  function toLatLon(v) {
    return {
      lat: Math.asin(v[2]) * 180 / Math.PI,
      lon: Math.atan2(v[1], v[0]) * 180 / Math.PI
    };
  }

  /** Point a fraction `t` along the great circle from a to b. */
  function gcInterp(a, b, t) {
    var v1 = toVec(a.lat, a.lon), v2 = toVec(b.lat, b.lon);
    var dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
    var w = Math.acos(dot);
    if (w < 1e-9) return { lat: a.lat, lon: a.lon };
    var s1 = Math.sin((1 - t) * w) / Math.sin(w);
    var s2 = Math.sin(t * w) / Math.sin(w);
    return toLatLon([
      s1 * v1[0] + s2 * v2[0],
      s1 * v1[1] + s2 * v2[1],
      s1 * v1[2] + s2 * v2[2]
    ]);
  }

  /**
   * Move `miles` from a point along a constant bearing (rhumb-ish, but over
   * ten minutes the difference from a great circle is negligible).
   */
  function moveAlong(lat, lon, bearingDeg, miles) {
    var R = 3958.8;
    var d = miles / R;
    var br = bearingDeg * Math.PI / 180;
    var la1 = lat * Math.PI / 180, lo1 = lon * Math.PI / 180;
    var la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
    var lo2 = lo1 + Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2)
    );
    return { lat: la2 * 180 / Math.PI, lon: ((lo2 * 180 / Math.PI + 540) % 360) - 180 };
  }

  /** Great-circle distance in statute miles. */
  function gcDist(a, b) {
    var la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
    var dla = la2 - la1, dlo = (b.lon - a.lon) * Math.PI / 180;
    var h = Math.sin(dla / 2) * Math.sin(dla / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) * Math.sin(dlo / 2);
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h))) * MI_PER_KM;
  }

  // ------------------------------------------------------- where on earth is that

  function inRing(flat, x, y) {
    var inside = false;
    for (var i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
      var xi = flat[i], yi = flat[i + 1], xj = flat[j], yj = flat[j + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inFeature(rings, x, y) {
    // Even-odd across all rings, so holes (lakes, enclaves) subtract correctly.
    var inside = false;
    for (var i = 0; i < rings.length; i++) if (inRing(rings[i], x, y)) inside = !inside;
    return inside;
  }

  function seaName(lat, lon) {
    var l = ((lon % 360) + 540) % 360 - 180;
    if (l >= 147 && l <= 178 && lat <= -29 && lat >= -50) return 'the Tasman Sea';
    if (l >= -98 && l <= -81 && lat >= 18 && lat <= 31) return 'the Gulf of Mexico';
    if (l >= -89 && l <= -59 && lat >= 8 && lat <= 23) return 'the Caribbean Sea';
    if (lat > 66) return 'the Arctic';
    if (l >= 120 || l <= -70) return lat >= 0 ? 'the North Pacific Ocean' : 'the South Pacific Ocean';
    if (l > -70 && l < 20) return lat >= 0 ? 'the North Atlantic Ocean' : 'the South Atlantic Ocean';
    return 'open ocean';
  }

  /** Human name for a coordinate: US state, else country, else sea. */
  function locate(lat, lon) {
    var md = window.MAPDATA;
    var i;
    if (md) {
      if (lon >= -180 && lat > 18 && lat < 72) {
        for (i = 0; i < md.states.length; i++) {
          if (inFeature(md.states[i][1], lon, lat)) return { name: md.states[i][0], over: 'over' };
        }
      }
      for (i = 0; i < md.countries.length; i++) {
        if (inFeature(md.countries[i][1], lon, lat)) return { name: md.countries[i][0], over: 'over' };
      }
    }
    return { name: seaName(lat, lon), over: 'over' };
  }

  // ------------------------------------------------------------------ formatting

  function fmtDur(ms) {
    if (!isFinite(ms) || ms <= 0) return '0m';
    var mins = Math.floor(ms / 60000);
    var d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }
  function fmtMiles(mi) { return Math.round(mi).toLocaleString() + ' mi'; }

  function fmtClock(ms, tz) {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: tz
    }).format(new Date(ms));
  }
  function fmtDayClock(ms, tz) {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz
    }).format(new Date(ms));
  }
  function fmtDate(ms, tz) {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: tz
    }).format(new Date(ms));
  }
  function tzAbbr(ms, tz) {
    var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date(ms));
    var v = '';
    for (var i = 0; i < parts.length; i++) if (parts[i].type === 'timeZoneName') v = parts[i].value;
    // Browsers render Auckland as "GMT+12" rather than NZST/NZDT; say the
    // thing people actually recognise.
    if (tz === 'Pacific/Auckland') return /\+13/.test(v) ? 'NZDT' : 'NZST';
    return v;
  }

  // --------------------------------------------------------------- journey state

  function liveFor(flight, now) {
    if (!liveData || !liveData.flights) return null;
    var rec = liveData.flights[flight.n];
    if (!rec || typeof rec.lat !== 'number' || typeof rec.lon !== 'number') return null;
    var age = now - (rec.ts * 1000);
    if (age > LIVE_MAX_AGE_MS || age < -120000) return null;
    return Object.assign({}, rec, { age: age });
  }

  /** The single source of truth for "what is happening right now". */
  function computeState(now) {
    var s = { now: now, live: null };
    var i;

    for (i = 0; i < FLIGHTS.length; i++) {
      if (now >= FLIGHTS[i].depMs && now < FLIGHTS[i].arrMs) {
        s.phase = 'flight';
        s.index = i;
        break;
      }
    }

    if (s.phase !== 'flight') {
      var nextIdx = -1;
      for (i = 0; i < FLIGHTS.length; i++) {
        if (FLIGHTS[i].depMs > now) { nextIdx = i; break; }
      }
      if (nextIdx === -1) {
        s.phase = 'done';
        s.index = FLIGHTS.length - 1;
      } else if (nextIdx === 0) {
        s.phase = 'pre';
        s.index = 0;
      } else if (FLIGHTS[nextIdx - 1].trip !== FLIGHTS[nextIdx].trip) {
        s.phase = 'gap';                       // the stay in New Zealand
        s.index = nextIdx - 1;
      } else {
        s.phase = 'layover';
        s.index = nextIdx - 1;
      }
      s.nextIndex = nextIdx;
    }

    var f = FLIGHTS[s.index];
    s.flight = f;
    s.trip = f.trip;

    if (s.phase === 'flight') {
      var from = AIRPORTS[f.from], to = AIRPORTS[f.to];
      var legMiles = gcDist(from, to);
      var live = liveFor(f, now);
      var frac;

      if (live) {
        s.live = live;
        s.pos = { lat: live.lat, lon: live.lon };
        // The poller only runs every 10 minutes, so carry the last fix forward
        // at its own reported track and ground speed. Capped, because a fix
        // extrapolated too far stops being a position and becomes a guess.
        if (typeof live.gs === 'number' && typeof live.track === 'number' && live.gs > 40) {
          var secs = Math.min(live.age, 20 * 60 * 1000) / 1000;
          if (secs > 0) {
            s.pos = moveAlong(live.lat, live.lon, live.track, live.gs * 1.15078 * (secs / 3600));
            s.projected = true;
          }
        }
        // Anchor the drawn trail to the real aircraft, not the clock.
        frac = Math.max(0, Math.min(1, gcDist(from, s.pos) / legMiles));
      } else {
        frac = Math.max(0, Math.min(1, (now - f.depMs) / (f.arrMs - f.depMs)));
        s.pos = gcInterp(from, to, frac);
      }
      s.frac = frac;
      s.legMiles = legMiles;
      s.elapsed = now - f.depMs;
      s.remaining = f.arrMs - now;
      s.where = locate(s.pos.lat, s.pos.lon);
      s.tz = frac < 0.5 ? from.tz : to.tz;
    } else if (s.phase === 'pre') {
      s.pos = AIRPORTS[f.from];
      s.airport = AIRPORTS[f.from];
      s.tz = s.airport.tz;
      s.frac = 0;
    } else {
      s.pos = AIRPORTS[f.to];
      s.airport = AIRPORTS[f.to];
      s.tz = s.airport.tz;
      s.frac = 1;
    }

    return s;
  }

  function tripFlights(trip) {
    return FLIGHTS.filter(function (f) { return f.trip === trip; });
  }

  /** Aggregate totals for one trip, evaluated at `now`. */
  function tripStats(trip, now, state) {
    var fl = tripFlights(trip);
    var t = {
      flightTotal: 0, flightDone: 0,
      layoverTotal: 0, layoverDone: 0,
      milesTotal: 0, milesDone: 0,
      completed: 0, count: fl.length,
      start: fl[0].depMs, end: fl[fl.length - 1].arrMs
    };

    fl.forEach(function (f, i) {
      var dur = f.arrMs - f.depMs;
      var miles = gcDist(AIRPORTS[f.from], AIRPORTS[f.to]);
      t.flightTotal += dur;
      t.milesTotal += miles;

      var frac;
      if (now >= f.arrMs) { frac = 1; t.completed++; }
      else if (now <= f.depMs) frac = 0;
      else if (state.phase === 'flight' && state.flight === f) frac = state.frac;
      else frac = (now - f.depMs) / dur;

      t.flightDone += dur * frac;
      t.milesDone += miles * frac;

      if (i > 0) {
        var prev = fl[i - 1];
        var gap = f.depMs - prev.arrMs;
        t.layoverTotal += gap;
        t.layoverDone += Math.max(0, Math.min(gap, now - prev.arrMs));
      }
    });

    t.flightLeft = Math.max(0, t.flightTotal - t.flightDone);
    t.milesLeft = Math.max(0, t.milesTotal - t.milesDone);
    t.progress = Math.max(0, Math.min(1, (now - t.start) / (t.end - t.start)));

    // Door-to-door elapsed already *is* flight time plus layovers, so take it
    // straight off the clock rather than summing the two and risking drift.
    t.travelTotal = t.end - t.start;
    t.travelDone = Math.max(0, Math.min(t.travelTotal, now - t.start));
    t.travelLeft = Math.max(0, Math.min(t.travelTotal, t.end - now));
    return t;
  }

  // ------------------------------------------------------------------ map render

  function ringPath(flat) {
    var d = '', px = null, started = false;
    for (var i = 0; i < flat.length; i += 2) {
      var p = project(flat[i + 1], flat[i]);
      // A ring straddling the frame's cut line would otherwise streak across
      // the whole map; break the subpath instead.
      if (px !== null && Math.abs(p[0] - px) > W * 0.6) { d += 'Z'; started = false; }
      d += (started ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
      started = true;
      px = p[0];
    }
    return d + 'Z';
  }

  function gcPath(a, b, t0, t1) {
    var d = '', n = 96;
    for (var i = 0; i <= n; i++) {
      var t = t0 + (t1 - t0) * (i / n);
      var q = gcInterp(a, b, t);
      var p = project(q.lat, q.lon);
      d += (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
    }
    return d;
  }

  function buildBaseMap() {
    var md = window.MAPDATA;
    var parts = [];
    parts.push('<defs>' +
      '<radialGradient id="glow"><stop offset="0%" stop-color="#ff4f9e" stop-opacity=".38"/>' +
      '<stop offset="100%" stop-color="#ff4f9e" stop-opacity="0"/></radialGradient>' +
      '<filter id="soft"><feGaussianBlur stdDeviation="6"/></filter>' +
      '</defs>');

    // graticule
    var g = '';
    for (var lon = -180; lon < 180; lon += 15) {
      var a = project(LAT_TOP, lon), b = project(LAT_BOT, lon);
      if (Math.abs(a[0] - b[0]) > 1) continue;
      g += '<line x1="' + a[0].toFixed(1) + '" y1="0" x2="' + a[0].toFixed(1) + '" y2="' + H.toFixed(1) + '"/>';
    }
    for (var lat = -45; lat <= 60; lat += 15) {
      var y = project(lat, LON0)[1];
      g += '<line x1="0" y1="' + y.toFixed(1) + '" x2="' + W + '" y2="' + y.toFixed(1) + '"/>';
    }
    parts.push('<g stroke="rgba(150,110,175,.16)" stroke-width="1">' + g + '</g>');

    var land = md.countries.map(function (c) {
      return c[1].map(ringPath).join('');
    }).join('');
    parts.push('<path d="' + land + '" fill="#ffe4f1" stroke="#f2b8d8" stroke-width="1.1" stroke-linejoin="round"/>');

    var states = md.states.map(function (c) {
      return c[1].map(ringPath).join('');
    }).join('');
    parts.push('<path d="' + states + '" fill="none" stroke="#f2b8d8" stroke-width="0.7" opacity=".9"/>');

    return parts.join('');
  }

  var baseMapCache = null;

  function renderMap(state, trip) {
    var svg = document.getElementById('map');
    if (!baseMapCache) baseMapCache = buildBaseMap();
    svg.setAttribute('viewBox', '0 0 ' + W.toFixed(0) + ' ' + H.toFixed(0));

    var fl = tripFlights(trip);
    var out = [baseMapCache];
    var labels = [];
    var now = state.now;

    // The SVG scales to the container, so anything sized in user units shrinks
    // with it — at phone width the airport codes land around 5px and become
    // unreadable. Scale markers and text back up as the viewport narrows.
    var vw = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1200;
    var k = Math.max(1, 900 / Math.max(320, vw));

    fl.forEach(function (f) {
      var A = AIRPORTS[f.from], B = AIRPORTS[f.to];
      var isCurrent = state.phase === 'flight' && state.flight === f;
      var frac = now >= f.arrMs ? 1
               : now <= f.depMs ? 0
               : isCurrent ? state.frac
               : (now - f.depMs) / (f.arrMs - f.depMs);

      // Prefer the saved real track for completed legs; the current leg uses
      // the live trace until the API finalizes it after landing.
      var savedTrail = liveData && liveData.trails && liveData.trails[f.n];
      var trail = (isCurrent && state.live && state.live.trail) || savedTrail;

      // remaining portion — dashed. From the aircraft's real position when we
      // know it, so the dashed line meets the plane instead of the route line.
      if (frac < 1) {
        var fromHere = trail ? gcPath(state.pos, B, 0, 1) : gcPath(A, B, frac, 1);
        out.push('<path d="' + fromHere + '" fill="none" stroke="#ff4f9e" ' +
          'stroke-width="3" stroke-dasharray="9 10" opacity=".65" stroke-linecap="round"/>');
      }

      // completed portion — solid, brighter while it's the active leg
      if (frac > 0) {
        var col = isCurrent ? '#d81b76' : '#9b5cff';
        var d;
        if (trail && trail.length > 1) {
          d = '';
          for (var ti = 0; ti < trail.length; ti++) {
            var tp = project(trail[ti][0], trail[ti][1]);
            d += (ti ? 'L' : 'M') + tp[0].toFixed(1) + ' ' + tp[1].toFixed(1);
          }
        } else {
          d = gcPath(A, B, 0, frac);
        }
        out.push('<path d="' + d + '" fill="none" stroke="' + col + '" ' +
          'stroke-width="4.5" opacity=".95" stroke-linecap="round" stroke-linejoin="round"/>');
      }
    });

    // airport dots + labels
    var seen = {};
    fl.forEach(function (f, i) {
      [f.from, f.to].forEach(function (code) {
        if (seen[code]) return;
        seen[code] = true;
        var A = AIRPORTS[code], p = project(A.lat, A.lon);
        var visited = FLIGHTS.some(function (g) {
          return g.trip === trip && ((g.to === code && now >= g.arrMs) || (g.from === code && now >= g.depMs));
        });
        out.push('<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (7 * k).toFixed(1) +
          '" fill="' + (visited ? '#9b5cff' : '#ffffff') + '" stroke="#8a3a63" stroke-width="' +
          (2.5 * k).toFixed(1) + '"/>');
        var flip = code === 'SFO' || code === 'WLG' || code === 'AKL';
        labels.push('<text x="' + (p[0] + (flip ? -13 : 13) * k).toFixed(1) + '" y="' + (p[1] + 5 * k).toFixed(1) +
          '" fill="#46203a" font-size="' + (21 * k).toFixed(1) + '" font-weight="700" text-anchor="' +
          (flip ? 'end' : 'start') + '" paint-order="stroke" stroke="#ffffff" stroke-width="' +
          (5 * k).toFixed(1) + '" stroke-linejoin="round">' + code + '</text>');
      });
    });
    out.push(labels.join(''));

    // the aircraft (only when the shown trip is the one she's actually flying)
    if (state.phase === 'flight' && state.trip === trip) {
      var f0 = state.flight;
      var A0 = AIRPORTS[f0.from], B0 = AIRPORTS[f0.to];
      var p = project(state.pos.lat, state.pos.lon);
      // Derive the on-screen angle from a point just ahead, so the icon lines up
      // with the Mercator distortion rather than with true north.
      var ahead = (state.live && typeof state.live.track === 'number')
        ? moveAlong(state.pos.lat, state.pos.lon, state.live.track, 60)
        : gcInterp(A0, B0, Math.min(1, state.frac + 0.01));
      var p2 = project(ahead.lat, ahead.lon);
      var ang = Math.atan2(p2[1] - p[1], p2[0] - p[0]) * 180 / Math.PI + 90;

      out.push('<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (70 * k).toFixed(1) + '" fill="url(#glow)"/>');
      out.push('<g transform="translate(' + p[0].toFixed(1) + ',' + p[1].toFixed(1) + ') rotate(' + ang.toFixed(1) + ') scale(' + k.toFixed(2) + ')">' +
        '<path d="M0,-19 L5,-5 L20,4 L20,9 L4,5 L3,15 L9,20 L9,23 L0,20 L-9,23 L-9,20 L-3,15 L-4,5 L-20,9 L-20,4 L-5,-5 Z" ' +
        'fill="#d81b76" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/></g>');
    } else if (state.trip === trip && (state.phase === 'layover' || state.phase === 'gap' || state.phase === 'pre' || state.phase === 'done')) {
      var pa = project(state.pos.lat, state.pos.lon);
      out.push('<circle cx="' + pa[0].toFixed(1) + '" cy="' + pa[1].toFixed(1) + '" r="' + (52 * k).toFixed(1) + '" fill="url(#glow)"/>');
      out.push('<circle cx="' + pa[0].toFixed(1) + '" cy="' + pa[1].toFixed(1) + '" r="' + (10 * k).toFixed(1) +
        '" fill="#ffb020" stroke="#ffffff" stroke-width="' + (2.5 * k).toFixed(1) + '"/>');
    }

    svg.innerHTML = out.join('');
  }

  // ------------------------------------------------------------------- UI render

  function statCard(s) {
    return '<div class="stat' + (s.hl ? ' hl' : '') + '"><small>' + s.label + '</small>' +
      '<div class="v' + (s.sm ? ' sm' : '') + '">' + s.value + '</div>' +
      (s.note ? '<div class="n">' + s.note + '</div>' : '') + '</div>';
  }

  function buildStats(state, trip, t) {
    var out = [];
    var isCurrentTrip = state.trip === trip;
    var label = trip === 'out' ? 'to New Zealand' : 'home';

    if (state.phase === 'flight' && isCurrentTrip) {
      out.push({
        label: 'Currently over', hl: true, sm: true,
        value: state.where.name,
        note: state.pos.lat.toFixed(2) + '°, ' + state.pos.lon.toFixed(2) + '°'
      });
      out.push({
        label: 'Time left on this flight', hl: true,
        value: fmtDur(state.remaining),
        note: 'lands ' + fmtDayClock(state.flight.arrMs, AIRPORTS[state.flight.to].tz) + ' local'
      });
      out.push({
        label: 'On this flight so far',
        value: fmtDur(state.elapsed),
        note: Math.round(state.frac * 100) + '% of the way to ' + AIRPORTS[state.flight.to].name
      });
      if (state.live) {
        out.push({
          label: 'Altitude',
          value: state.live.alt ? Math.round(state.live.alt).toLocaleString() + ' ft' : '—',
          note: state.live.gs ? Math.round(state.live.gs * 1.15078) + ' mph ground speed' : ''
        });
      } else {
        out.push({
          label: 'Distance left on leg',
          value: fmtMiles(state.legMiles * (1 - state.frac)),
          note: 'of ' + fmtMiles(state.legMiles) + ' total'
        });
      }
    } else if (state.phase === 'layover' && isCurrentTrip) {
      out.push({
        label: 'Layover in', hl: true, sm: true,
        value: state.airport.name + ' ✈',
        note: state.airport.region + ' · ' + state.flight.to
      });
      out.push({
        label: 'Next flight boards in', hl: true,
        value: fmtDur(FLIGHTS[state.nextIndex].depMs - state.now),
        note: 'onward to ' + AIRPORTS[FLIGHTS[state.nextIndex].to].name
      });
      out.push({
        label: 'Sitting here',
        value: fmtDur(state.now - state.flight.arrMs),
        note: 'of a ' + fmtDur(FLIGHTS[state.nextIndex].depMs - state.flight.arrMs) + ' layover'
      });
    } else if (state.phase === 'gap' && isCurrentTrip) {
      out.push({
        label: 'Currently in', hl: true, sm: true,
        value: state.airport.name + ' 🇳🇿',
        note: 'She made it.'
      });
      out.push({
        label: 'Flies home in', hl: true,
        value: fmtDur(FLIGHTS[state.nextIndex].depMs - state.now),
        note: 'departs ' + fmtDate(FLIGHTS[state.nextIndex].depMs, AIRPORTS[FLIGHTS[state.nextIndex].from].tz)
      });
    } else if (state.phase === 'pre' && isCurrentTrip) {
      out.push({
        label: 'Departs in', hl: true,
        value: fmtDur(FLIGHTS[0].depMs - state.now),
        note: 'from ' + AIRPORTS[FLIGHTS[0].from].name
      });
    } else if (state.phase === 'done' && isCurrentTrip) {
      out.push({ label: 'Status', hl: true, sm: true, value: 'Home 🏡', note: 'Journey complete' });
    } else {
      // Showing the trip she isn't on — present it as a plan.
      var upcoming = t.start > state.now;
      out.push({
        label: upcoming ? 'This journey starts' : 'This journey ended', hl: true, sm: true,
        value: fmtDate(upcoming ? t.start : t.end, AIRPORTS[tripFlights(trip)[0].from].tz),
        note: upcoming ? fmtDur(t.start - state.now) + ' from now' : 'completed'
      });
    }

    var lastStop = AIRPORTS[tripFlights(trip)[t.count - 1].to].name;
    out.push({
      label: 'Travel time so far', hl: true,
      value: fmtDur(t.travelDone),
      note: 'flights + layovers, door to door'
    });
    out.push({
      label: 'Travel time remaining', hl: true,
      value: fmtDur(t.travelLeft),
      note: t.travelLeft === 0 ? 'she made it' : 'until she reaches ' + lastStop
    });
    out.push({
      label: 'Flight time so far',
      value: fmtDur(t.flightDone),
      note: 'of ' + fmtDur(t.flightTotal) + ' flying ' + label
    });
    var legsLeft = t.count - t.completed;
    out.push({
      label: 'Flight time remaining',
      value: fmtDur(t.flightLeft),
      note: t.flightLeft === 0 ? 'all done'
          : 'across ' + legsLeft + (legsLeft === 1 ? ' more flight' : ' more flights')
    });
    out.push({
      label: 'Time in layovers',
      value: fmtDur(t.layoverDone),
      note: 'of ' + fmtDur(t.layoverTotal) + ' scheduled'
    });
    out.push({
      label: 'Distance covered',
      value: fmtMiles(t.milesDone),
      note: fmtMiles(t.milesLeft) + ' to go'
    });
    out.push({
      label: 'Flights complete',
      value: t.completed + ' of ' + t.count,
      note: tripFlights(trip).map(function (f) { return f.from + '–' + f.to; }).join(' · ')
    });
    out.push({
      label: 'Door to door',
      value: fmtDur(t.end - t.start),
      note: 'gate to gate, ' + label
    });

    return out.map(statCard).join('');
  }

  function buildTimeline(state, trip) {
    var fl = tripFlights(trip);
    var now = state.now;
    var html = '';

    fl.forEach(function (f, i) {
      if (i > 0) {
        var prev = fl[i - 1];
        var gap = f.depMs - prev.arrMs;
        var active = now >= prev.arrMs && now < f.depMs;
        html += '<div class="layover-row">' +
          (active ? '⏱ <b>Now:</b> ' : '') + fmtDur(gap) + ' layover in <b>' + AIRPORTS[prev.to].name + '</b>' +
          (active ? ' — ' + fmtDur(f.depMs - now) + ' until boarding' : '') +
          '</div>';
      }

      var done = now >= f.arrMs;
      var current = now >= f.depMs && now < f.arrMs;
      var chip = done ? '<span class="chip done">Landed</span>'
               : current ? '<span class="chip now">In the air</span>'
               : '<span class="chip next">Upcoming</span>';
      var dot = 'dot' + (done ? ' done' : current ? ' now' : '');

      html += '<div class="leg' + (current ? ' now' : '') + '">' +
        '<span class="' + dot + '"></span>' +
        '<div class="leg-main">' +
          '<div class="leg-route">' + AIRPORTS[f.from].name + ' → ' + AIRPORTS[f.to].name + chip + '</div>' +
          '<div class="leg-meta">' + f.from + '–' + f.to + ' · ' + fmtDur(f.arrMs - f.depMs) +
            ' · ' + fmtMiles(gcDist(AIRPORTS[f.from], AIRPORTS[f.to])) + ' · ' + f.operator + '</div>' +
        '</div>' +
        '<div class="leg-time">' +
          '<b>' + fmtClock(f.depMs, AIRPORTS[f.from].tz) + ' → ' + fmtClock(f.arrMs, AIRPORTS[f.to].tz) + '</b>' +
          fmtDate(f.depMs, AIRPORTS[f.from].tz) + ' local' +
        '</div>' +
      '</div>';
    });

    return html;
  }

  function heroText(state) {
    var f = state.flight;
    switch (state.phase) {
      case 'flight':
        return {
          status: 'In flight to ' + AIRPORTS[f.to].name,
          sub: 'Somewhere over <b>' + state.where.name + '</b> · out of ' +
               AIRPORTS[f.from].name + ' · <b>' + fmtDur(state.remaining) + '</b> to landing'
        };
      case 'layover':
        return {
          status: 'Layover in ' + state.airport.name,
          sub: 'Landed ' + fmtDur(state.now - f.arrMs) + ' ago · next up <b>' +
               AIRPORTS[FLIGHTS[state.nextIndex].to].name +
               '</b> in <b>' + fmtDur(FLIGHTS[state.nextIndex].depMs - state.now) + '</b>'
        };
      case 'gap':
        return {
          status: 'In ' + state.airport.name + ', New Zealand',
          sub: 'Arrived ' + fmtDate(f.arrMs, AIRPORTS[f.to].tz) + ' · flies home in <b>' +
               fmtDur(FLIGHTS[state.nextIndex].depMs - state.now) + '</b>'
        };
      case 'pre':
        return {
          status: 'Not off yet',
          sub: 'Departs ' + AIRPORTS[f.from].name + ' in <b>' + fmtDur(f.depMs - state.now) + '</b>'
        };
      default:
        return {
          status: 'Home in ' + AIRPORTS[f.to].name + ' 🏡',
          sub: 'Landed ' + fmtDate(f.arrMs, AIRPORTS[f.to].tz) + ' · the whole trip is done'
        };
    }
  }

  function render() {
    var now = Date.now();
    var state = computeState(now);

    if (selectedTrip === null) {
      // Default to whichever journey is live; flip to "home" a week before
      // the return flight so the countdown lands on the right map.
      var homeStart = FLIGHTS.filter(function (f) { return f.trip === 'home'; })[0].depMs;
      selectedTrip = (state.trip === 'home' || now >= homeStart - 7 * 864e5) ? 'home' : 'out';
      syncToggle();
    }

    var trip = selectedTrip;
    var t = tripStats(trip, now, state);
    var h = heroText(state);

    document.getElementById('status').innerHTML = h.status;
    document.getElementById('substatus').innerHTML = h.sub;

    var viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    document.getElementById('clock-you').textContent = fmtClock(now, viewerTz);
    document.getElementById('clock-you-zone').textContent = tzAbbr(now, viewerTz);
    document.getElementById('clock-her').textContent = fmtClock(now, state.tz);
    document.getElementById('clock-her-zone').textContent = tzAbbr(now, state.tz) +
      ' · ' + fmtDate(now, state.tz);

    var pulse = document.getElementById('pulse');
    var badge = document.getElementById('source-badge');
    if (state.live) {
      pulse.className = 'pulse';
      badge.className = 'badge live';
      badge.innerHTML = '● Live ADS-B · ' + fmtDur(state.live.age) + ' ago';
      document.getElementById('eyebrow-text').textContent = 'Live position';
    } else {
      pulse.className = 'pulse est';
      badge.className = 'badge est';
      badge.innerHTML = '◐ Estimated from schedule';
      document.getElementById('eyebrow-text').textContent = 'Current status';
    }

    document.getElementById('progress-bar').style.width = (t.progress * 100).toFixed(1) + '%';
    document.getElementById('progress-pct').textContent = Math.round(t.progress * 100) + '% there';
    var fl = tripFlights(trip);
    document.getElementById('progress-from').textContent = AIRPORTS[fl[0].from].name;
    document.getElementById('progress-to').textContent = AIRPORTS[fl[fl.length - 1].to].name;

    document.getElementById('map-title').textContent =
      trip === 'out' ? 'Charlotte → Wellington' : 'Wellington → Charlotte';
    document.getElementById('timeline-title').textContent =
      trip === 'out' ? 'The 4 flights out' : 'The 4 flights home';

    document.getElementById('stats').innerHTML = buildStats(state, trip, t);
    document.getElementById('legs').innerHTML = buildTimeline(state, trip);
    renderMap(state, trip);
  }

  function syncToggle() {
    document.getElementById('btn-out').setAttribute('aria-pressed', String(selectedTrip === 'out'));
    document.getElementById('btn-home').setAttribute('aria-pressed', String(selectedTrip === 'home'));
  }

  /* Two ways to get a position, tried in order:
   *   1. /api/live — the Cloudflare Pages Function proxying adsb.lol live.
   *   2. data/live.json — a file a cron may be committing, for plain static
   *      hosts where no function exists.
   * If neither answers, dead reckoning from the schedule carries the map. */
  function fetchLive() {
    var state = computeState(Date.now());
    if (state.phase === 'pre') return;      // nothing airborne to ask about
    var f = state.flight;
    var finalizing = state.phase !== 'flight';
    var previous = liveData && liveData.flights && liveData.flights[f.n];
    var query = 'api/live?cs=' + f.callsigns.join(',') +
      '&leg=' + encodeURIComponent(f.n) +
      '&arr=' + encodeURIComponent(f.arrMs) +
      '&finalize=' + (finalizing ? '1' : '0') +
      (previous && /^[0-9a-f]{6}$/i.test(previous.hex || '') ? '&hex=' + previous.hex : '') +
      '&t=' + Date.now();

    fetch(query, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('no proxy here');
        return r.json();
      })
      .then(function (j) {
        if (j && j.trails) {
          liveData = liveData || { flights: {} };
          liveData.trails = j.trails;
          render();
        }
        // found:false is the ordinary mid-ocean answer, not a failure.
        if (!j || j.found === false || typeof j.lat !== 'number') return;
        var next = liveData || { updated: new Date().toISOString(), flights: {} };
        next.updated = new Date().toISOString();
        next.flights = next.flights || {};
        next.flights[f.n] = j;
        liveData = next;
        render();
      })
      .catch(fetchLiveFile);
  }

  function fetchLiveFile() {
    fetch('data/live.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j) { liveData = j; render(); } })
      .catch(function () { /* neither source available — schedule mode */ });
  }

  document.getElementById('btn-out').addEventListener('click', function () {
    selectedTrip = 'out'; syncToggle(); render();
  });
  document.getElementById('btn-home').addEventListener('click', function () {
    selectedTrip = 'home'; syncToggle(); render();
  });

  render();
  setInterval(render, 1000);
  fetchLive();
  setInterval(fetchLive, 60000);
})();

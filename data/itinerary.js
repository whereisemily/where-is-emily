/* Emily's itinerary.
 *
 * All times are stored in UTC. Local clock times from the booking were
 * converted using the offset in effect on each date:
 *   Aug 6-8 2026  - CLT/EDT -4, IAH/CDT -5, SFO/PDT -7, AKL+WLG/NZST +12
 *   Oct 19-21 2026 - NZDT +13 (NZ DST began Sep 27), IAH+ORD/CDT -5, CLT/EDT -4
 *
 * Storing UTC is what keeps NZ28 sane: it leaves Auckland 7:50pm Oct 20 and
 * lands in Houston 3:25pm Oct 20, "before" it departed, because it crosses the
 * date line eastbound. In UTC it is simply a 13h35m flight.
 *
 * `callsigns` are ADS-B callsigns, which follow the *operating* carrier, not
 * the ticketed United number: Mesa flies as ASH, Republic as RPA, Air NZ as ANZ.
 * The tracker tries each candidate in order.
 */
window.AIRPORTS = {
  CLT: { name: 'Charlotte',     region: 'North Carolina', lat:  35.2140, lon:  -80.9431, tz: 'America/New_York'   },
  IAH: { name: 'Houston',       region: 'Texas',          lat:  29.9902, lon:  -95.3368, tz: 'America/Chicago'    },
  SFO: { name: 'San Francisco', region: 'California',     lat:  37.6213, lon: -122.3790, tz: 'America/Los_Angeles'},
  AKL: { name: 'Auckland',      region: 'New Zealand',    lat: -37.0082, lon:  174.7850, tz: 'Pacific/Auckland'   },
  WLG: { name: 'Wellington',    region: 'New Zealand',    lat: -41.3272, lon:  174.8053, tz: 'Pacific/Auckland'   },
  ORD: { name: 'Chicago',       region: 'Illinois',       lat:  41.9742, lon:  -87.9073, tz: 'America/Chicago'    }
};

window.FLIGHTS = [
  // --- Trip out: Charlotte -> Wellington ---
  { n: 'UA6236', trip: 'out',  from: 'CLT', to: 'IAH', dep: '2026-08-06T15:48:00Z', arr: '2026-08-06T18:34:00Z',
    cabin: 'United Economy',      operator: 'Mesa (United Express)', callsigns: ['ASH6236', 'UAL6236'] },
  { n: 'UA382',  trip: 'out',  from: 'IAH', to: 'SFO', dep: '2026-08-06T21:25:00Z', arr: '2026-08-07T01:30:00Z',
    cabin: 'United Economy',      operator: 'United',                callsigns: ['UAL382'] },
  { n: 'UA917',  trip: 'out',  from: 'SFO', to: 'AKL', dep: '2026-08-07T06:00:00Z', arr: '2026-08-07T19:10:00Z',
    cabin: 'United Premium Plus', operator: 'United',                callsigns: ['UAL917'] },
  { n: 'NZ425',  trip: 'out',  from: 'AKL', to: 'WLG', dep: '2026-08-08T00:15:00Z', arr: '2026-08-08T01:25:00Z',
    cabin: 'Economy',             operator: 'Air New Zealand',       callsigns: ['ANZ425'] },

  // --- Trip home: Wellington -> Charlotte ---
  { n: 'NZ428',  trip: 'home', from: 'WLG', to: 'AKL', dep: '2026-10-19T23:45:00Z', arr: '2026-10-20T00:50:00Z',
    cabin: 'Economy',             operator: 'Air New Zealand',       callsigns: ['ANZ428'] },
  { n: 'NZ28',   trip: 'home', from: 'AKL', to: 'IAH', dep: '2026-10-20T06:50:00Z', arr: '2026-10-20T20:25:00Z',
    cabin: 'Economy',             operator: 'Air New Zealand',       callsigns: ['ANZ28'] },
  { n: 'UA2197', trip: 'home', from: 'IAH', to: 'ORD', dep: '2026-10-20T23:50:00Z', arr: '2026-10-21T02:42:00Z',
    cabin: 'United Economy',      operator: 'United',                callsigns: ['UAL2197'] },
  { n: 'UA3426', trip: 'home', from: 'ORD', to: 'CLT', dep: '2026-10-21T11:50:00Z', arr: '2026-10-21T14:08:00Z',
    cabin: 'United Economy',      operator: 'Republic (United Express)', callsigns: ['RPA3426', 'UAL3426'] }
];

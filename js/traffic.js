// Real-world road data: bundled speed cameras, plus live traffic from TomTom
// when the driver has added their own API key.
const TOMTOM = 'https://api.tomtom.com';
const INCIDENT_FIELDS = '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,events{description},startTime,length,delay}}}';
const MAX_BOX_KM2 = 9000; // TomTom's limit is 10,000 km² per request.
const MAX_BOXES = 6;

// TomTom iconCategory -> our report types.
const INCIDENT_TYPES = { 1: 'crash', 2: 'hazard', 3: 'hazard', 4: 'hazard', 5: 'hazard', 6: 'jam', 7: 'hazard', 8: 'closure', 9: 'hazard', 10: 'hazard', 11: 'hazard', 14: 'hazard' };

export async function loadCameras() {
  const res = await fetch('data/uae-cameras.json');
  if (!res.ok) throw new Error(`Camera data failed (${res.status})`);
  return (await res.json()).map(([lng, lat, limit], i) => ({ id: `c${i}`, type: 'camera', lngLat: [lng, lat], limit, camera: true, at: 0 }));
}

const incidentsUrl = (key, box) => `${TOMTOM}/traffic/services/5/incidentDetails?key=${encodeURIComponent(key)}&bbox=${box.join(',')}&fields=${encodeURIComponent(INCIDENT_FIELDS)}&language=en-GB&timeValidityFilter=present`;

export async function validateKey(key) {
  const res = await fetch(incidentsUrl(key, [55.27, 25.19, 55.29, 25.21]));
  return res.ok;
}

export function flowTiles(key, dark) {
  return `${TOMTOM}/traffic/map/4/tile/flow/${dark ? 'relative0-dark' : 'relative0'}/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}`;
}

/** Splits the area the routes cover into boxes small enough for TomTom. */
function coverBoxes(routes) {
  const coords = routes.flatMap((r) => r.line.coords);
  const pad = 0.01;
  const minLng = Math.min(...coords.map((c) => c[0])) - pad;
  const maxLng = Math.max(...coords.map((c) => c[0])) + pad;
  const minLat = Math.min(...coords.map((c) => c[1])) - pad;
  const maxLat = Math.max(...coords.map((c) => c[1])) + pad;
  const kmX = (maxLng - minLng) * 111.3 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const kmY = (maxLat - minLat) * 111.3;
  const cells = Math.min(MAX_BOXES, Math.ceil((kmX * kmY) / MAX_BOX_KM2));
  const cols = Math.ceil(Math.sqrt(cells));
  const rows = Math.ceil(cells / cols);
  const boxes = [];
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      boxes.push([
        minLng + ((maxLng - minLng) * x) / cols, minLat + ((maxLat - minLat) * y) / rows,
        minLng + ((maxLng - minLng) * (x + 1)) / cols, minLat + ((maxLat - minLat) * (y + 1)) / rows,
      ].map((v) => Number(v.toFixed(5))));
    }
  }
  return boxes;
}

function toReport(incident) {
  const p = incident.properties;
  const coords = incident.geometry.type === 'Point' ? [incident.geometry.coordinates] : incident.geometry.coordinates;
  return {
    id: `t${p.id}`,
    type: INCIDENT_TYPES[p.iconCategory] || 'hazard',
    lngLat: coords[0],
    coords,
    at: Date.parse(p.startTime) || Date.now(),
    live: true,
    delay: p.delay || 0,
    length: p.length || 0,
    detail: p.events?.[0]?.description || '',
  };
}

export async function fetchIncidents(routes, key) {
  const pages = await Promise.all(coverBoxes(routes).map(async (box) => {
    const res = await fetch(incidentsUrl(key, box));
    if (!res.ok) throw new Error(`Traffic failed (${res.status})`);
    return (await res.json()).incidents || [];
  }));
  const byId = new Map(pages.flat().map(toReport).map((r) => [r.id, r]));
  return [...byId.values()];
}

async function liveEta(route, key) {
  const { coords } = route.line;
  const every = Math.max(1, Math.ceil(coords.length / 300));
  const supportingPoints = coords
    .filter((_, i) => i % every === 0 || i === coords.length - 1)
    .map(([longitude, latitude]) => ({ latitude, longitude }));
  const a = coords[0];
  const b = coords[coords.length - 1];
  const res = await fetch(`${TOMTOM}/routing/1/calculateRoute/${a[1]},${a[0]}:${b[1]},${b[0]}/json?key=${encodeURIComponent(key)}&traffic=true&routeType=fastest&travelMode=car`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ supportingPoints }),
  });
  if (!res.ok) throw new Error(`Live ETA failed (${res.status})`);
  const { summary } = (await res.json()).routes[0];
  route.liveDuration = summary.travelTimeInSeconds;
  route.trafficDelay = summary.trafficDelayInSeconds || 0;
}

/** Sets a traffic-aware travel time on each route that TomTom can match. */
export async function applyLiveEta(routes, key) {
  await Promise.allSettled(routes.map((route) => liveEta(route, key)));
}

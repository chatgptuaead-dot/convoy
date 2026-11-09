import { dist, bearing, angleDelta, pointAt, project, sliceLine } from './geo.js';
import { searchPlaces, reversePlace, fetchRoutes } from './api.js';
import { enrichRoutes, laneGuidance } from './lanes.js';
import { loadCameras, validateKey, flowTiles, fetchIncidents, applyLiveEta } from './traffic.js';

// config.js holds the private key and is not in the repo, so copies without it still run.
const { TOMTOM_KEY = '' } = await import('./config.js').catch(() => ({}));

/* ---------- Constants ---------- */

const $ = (selector) => document.querySelector(selector);
const icon = (inner) => `<svg viewBox="0 0 24 24">${inner}</svg>`;

const DEFAULT_POS = [55.2744, 25.1972]; // Downtown Dubai
const ARABIC = /[؀-ۿ]/;
const STORE_KEY = 'convoy.v1';
const REPORT_TTL = 6 * 3600 * 1000;
const LIVE_REFRESH = 5 * 60 * 1000; // TomTom's free tier allows 2,500 incident requests a month.
const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/liberty',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

// delay is the seconds a report adds to a route's estimate.
const REPORTS = {
  jam: { label: 'Traffic', say: 'Traffic jam', color: '#d9342b', delay: 240, icon: '<path d="M5 18v-6l2.2-5.5h9.6L19 12v6M5 12h14M5 15.5h3M16 15.5h3M7 18v2M17 18v2"/>' },
  police: { label: 'Police', say: 'Police', color: '#2f6bff', delay: 0, icon: '<path d="M12 3l7 3v6c0 4.4-3 7.5-7 9-4-1.5-7-4.6-7-9V6z"/>' },
  crash: { label: 'Crash', say: 'Crash', color: '#8b2fd6', delay: 180, icon: '<path d="M12 2.5l2 6 6-2-3 5.2 4.5 3-6 .8.5 6-4.5-4-4.5 4 .5-6-6-.8 4.5-3-3-5.2 6 2z"/>' },
  hazard: { label: 'Hazard', say: 'Hazard', color: '#ea7f00', delay: 30, icon: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>' },
  closure: { label: 'Closure', say: 'Road closure', color: '#34303f', delay: 600, icon: '<circle cx="12" cy="12" r="9"/><path d="M7 12h10"/>' },
  camera: { label: 'Camera', say: 'Speed camera', color: '#0b8f7a', delay: 0, icon: '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 11l5-3v8l-5-3z"/>' },
};

const LEVELS = [[0, 'Learner'], [100, 'Commuter'], [500, 'Road Regular'], [2000, 'Scout'], [5000, 'Convoy Captain']];
const COLORS = ['#6a45f5', '#ff5a3c', '#0b8f7a', '#e6398f', '#2f6bff'];
const VEHICLES = {
  arrow: '<path d="M12 2l8 19-8-4-8 4z"/>',
  car: '<rect x="6.5" y="2.5" width="11" height="19" rx="4.5"/><path d="M8.5 9.5c2-1 5-1 7 0M8.5 16c2 .8 5 .8 7 0" fill="none"/>',
  van: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M8 8h8M8 12h8" fill="none"/>',
};

const SIM_SPEEDS = [1, 4, 16];
const ICON_HOME = icon('<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>');
const ICON_WORK = icon('<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V5h6v3"/>');
const ICON_CLOCK = icon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>');
const ICON_PIN = icon('<path d="M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>');
const ICON_VOICE_ON = icon('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 8.5a5 5 0 0 1 0 7"/>');
const ICON_VOICE_OFF = icon('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9.5l4.5 5M21.5 9.5l-4.5 5"/>');

/* ---------- Persistent state ---------- */

function loadState() {
  const defaults = {
    points: 0, km: 0, drives: 0, reports: [], recents: [], home: null, work: null, lastPos: null,
    settings: {
      theme: 'auto',
      units: 'km',
      voice: true, vehicle: 'arrow', color: COLORS[0],
    },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved) return { ...defaults, ...saved, settings: { ...defaults.settings, ...saved.settings } };
  } catch { /* storage blocked or corrupt: run with defaults */ }
  return defaults;
}

const state = loadState();
state.reports = state.reports.filter((r) => Date.now() - r.at < REPORT_TTL);
// One-time move for browsers that saved a position before the UAE became home.
if (!state.uaeHome) {
  state.uaeHome = true;
  state.lastPos = null;
  state.settings.units = 'km';
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* non-fatal */ }
}

/* ---------- Session state ---------- */

const s = {
  mode: 'browse', pos: state.lastPos || DEFAULT_POS, heading: 0, speed: 0,
  gpsOK: false, manual: false, gpsWarned: false,
  dest: null, routes: [], sel: 0, planToken: 0, routeError: null,
  incidents: [], cameras: [], nextLive: 0, choosing: null, simMult: 4, trip: null, result: null,
};
let nav = null;

/* ---------- Formatting ---------- */

const metric = () => state.settings.units === 'km';
// A key saved in the menu wins over the one built into config.js.
const trafficKey = () => state.settings.trafficKey || TOMTOM_KEY.trim();

function fmtDist(m) {
  if (metric()) return m >= 1000 ? `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`;
  const mi = m / 1609.34;
  return mi >= 0.1 ? `${mi.toFixed(mi < 10 ? 1 : 0)} mi` : `${Math.max(50, Math.round((m * 3.281) / 50) * 50)} ft`;
}

function sayDist(m) {
  if (metric()) return m >= 1000 ? `${(m / 1000).toFixed(1)} kilometers` : `${Math.round(m / 50) * 50 || 50} meters`;
  const mi = m / 1609.34;
  return mi >= 0.2 ? `${mi.toFixed(1)} miles` : `${Math.round((m * 3.281) / 100) * 100 || 100} feet`;
}

function fmtDur(seconds) {
  const min = Math.max(1, Math.round(seconds / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

const fmtClock = (secondsAhead) => new Date(Date.now() + secondsAhead * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function fmtAge(at) {
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 1) return 'just now';
  return min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

function setText(el, value) {
  if (el.textContent !== value) el.textContent = value;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function speak(text) {
  if (!state.settings.voice || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

/* ---------- Theme and map ---------- */

function resolvedTheme() {
  const { theme } = state.settings;
  if (theme !== 'auto') return theme;
  const hour = new Date().getHours();
  return hour >= 19 || hour < 6 ? 'dark' : 'light';
}

document.documentElement.dataset.theme = resolvedTheme();

const map = new maplibregl.Map({
  container: 'map',
  style: STYLES[resolvedTheme()],
  center: s.pos,
  zoom: 14.5,
  attributionControl: false,
});
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-right');
// Compact attribution starts expanded, which would cover the menu button.
map.once('load', () => {
  const attribution = document.querySelector('.maplibregl-ctrl-attrib');
  attribution?.classList.remove('maplibregl-compact-show');
  attribution?.removeAttribute('open');
});

function applyTheme() {
  const theme = resolvedTheme();
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  map.setStyle(STYLES[theme]);
}

const EMPTY = { type: 'FeatureCollection', features: [] };
const LINE_LAYOUT = { 'line-cap': 'round', 'line-join': 'round' };

// Runs on every style load, because setStyle drops custom layers.
map.on('style.load', () => {
  map.addSource('routes', { type: 'geojson', data: EMPTY });
  map.addSource('traffic', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'route-alt', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], false], layout: LINE_LAYOUT, paint: { 'line-color': '#a597ee', 'line-width': 8 } });
  map.addLayer({ id: 'route-case', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], true], layout: LINE_LAYOUT, paint: { 'line-color': '#351c9e', 'line-width': 13 } });
  map.addLayer({ id: 'route-main', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], true], layout: LINE_LAYOUT, paint: { 'line-color': '#7a58ff', 'line-width': 9 } });
  map.addLayer({ id: 'route-jam', type: 'line', source: 'traffic', layout: LINE_LAYOUT, paint: { 'line-color': '#ef3b2d', 'line-width': 9 } });
  map.addSource('cameras', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'cameras', type: 'circle', source: 'cameras', minzoom: 9,
    paint: { 'circle-color': '#0b8f7a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2.5, 15, 7] },
  });
  renderCameras();
  renderFlow();
  renderRoutes();
});

function renderCameras() {
  map.getSource('cameras')?.setData({
    type: 'FeatureCollection',
    features: s.cameras.map((c) => ({ type: 'Feature', properties: { id: c.id }, geometry: { type: 'Point', coordinates: c.lngLat } })),
  });
}

/** Colors roads by live speed, underneath the route line. */
function renderFlow() {
  if (!map.getSource('routes')) return;
  if (map.getLayer('flow')) map.removeLayer('flow');
  if (map.getSource('flow')) map.removeSource('flow');
  const key = trafficKey();
  if (!key) return;
  map.addSource('flow', { type: 'raster', tiles: [flowTiles(key, resolvedTheme() === 'dark')], tileSize: 256, attribution: 'Traffic © TomTom' });
  map.addLayer({ id: 'flow', type: 'raster', source: 'flow', paint: { 'raster-opacity': 0.85 } }, 'route-alt');
}

const lineFeature = (coordinates, properties = {}) => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates } });

function renderRoutes() {
  const routesSource = map.getSource('routes');
  if (!routesSource) return;
  let lines = [];
  let active = null;
  let from = 0;
  if (s.mode === 'preview' && s.routes.length) {
    lines = s.routes.map((r, i) => lineFeature(r.line.coords, { id: i, selected: i === s.sel }));
    lines.sort((a, b) => Number(a.properties.selected) - Number(b.properties.selected));
    active = s.routes[s.sel];
  } else if (s.mode === 'drive' && nav) {
    const rest = sliceLine(nav.line, nav.d, nav.line.length);
    if (rest.length > 1) lines = [lineFeature(rest, { id: 0, selected: true })];
    active = nav.route;
    from = nav.d;
  }
  const jams = active
    ? active.hits
      .filter((h) => isSlowdown(h) && jamRange(h)[1] > from)
      .map((h) => sliceLine(active.line, Math.max(from, jamRange(h)[0]), jamRange(h)[1]))
      .filter((c) => c.length > 1)
      .map((c) => lineFeature(c))
    : [];
  routesSource.setData({ type: 'FeatureCollection', features: lines });
  map.getSource('traffic').setData({ type: 'FeatureCollection', features: jams });
}

/* ---------- Vehicle puck and destination pin ---------- */

const puckEl = document.createElement('div');
puckEl.className = 'puck';
function renderPuck() {
  puckEl.innerHTML = icon(VEHICLES[state.settings.vehicle]);
  puckEl.firstChild.style.fill = state.settings.color;
}
renderPuck();
const puck = new maplibregl.Marker({ element: puckEl, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat(s.pos).addTo(map);

const destEl = document.createElement('div');
destEl.className = 'dest-pin';
destEl.innerHTML = icon('<path d="M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12z"/>');
const destPin = new maplibregl.Marker({ element: destEl, anchor: 'bottom' });

function moveTo(lngLat) {
  s.pos = lngLat;
  puck.setLngLat(lngLat);
}

/* ---------- Reports ---------- */

const allReports = () => [...state.reports, ...s.incidents, ...s.cameras];
const repDelay = (rep) => rep.delay ?? REPORTS[rep.type].delay;
const isSlowdown = (h) => h.rep.type === 'jam' || h.rep.type === 'crash';
const jamRange = (h) => (h.rep.live ? [h.d, h.d + (h.rep.length || 300)] : [h.d - 320, h.d + 60]);

// Cameras and live incidents are real positions on one carriageway, so they
// need a tighter match than a hand-dropped report, or the opposite side of
// a divided road would trigger alerts.
function onRoute(route, rep, hit) {
  if (hit.offset >= (rep.camera ? 18 : rep.live ? 25 : 35)) return false;
  if (!rep.live || rep.coords.length < 2) return true;
  const incidentBearing = bearing(rep.coords[0], rep.coords[rep.coords.length - 1]);
  return Math.abs(angleDelta(incidentBearing, pointAt(route.line, hit.d).bearing)) < 60;
}

function scoreRoute(route) {
  if (!route.box) {
    const lngs = route.line.coords.map((c) => c[0]);
    const lats = route.line.coords.map((c) => c[1]);
    route.box = [Math.min(...lngs) - 0.002, Math.min(...lats) - 0.002, Math.max(...lngs) + 0.002, Math.max(...lats) + 0.002];
  }
  const [w, south, e, north] = route.box;
  route.hits = allReports()
    .filter(({ lngLat: [x, y] }) => x >= w && x <= e && y >= south && y <= north)
    .map((rep) => ({ rep, ...project(route.line, rep.lngLat) }))
    .filter((h) => onRoute(route, h.rep, h))
    .sort((a, b) => a.d - b.d);
  // A live travel time already includes traffic, so don't add reports on top.
  if (route.liveDuration != null) {
    route.delay = route.trafficDelay;
    route.eta = route.liveDuration;
  } else {
    route.delay = route.hits.reduce((sum, h) => sum + repDelay(h.rep), 0);
    route.eta = route.duration + route.delay;
  }
}

async function applyLive(routes, token) {
  const key = trafficKey();
  if (!key) return;
  const [incidents] = await Promise.allSettled([fetchIncidents(routes, key), applyLiveEta(routes, key)]);
  if (token !== s.planToken || (s.mode !== 'preview' && s.mode !== 'drive')) return;
  if (incidents.status === 'fulfilled') s.incidents = incidents.value;
  else toast('Live traffic is unavailable right now');
  if (s.mode === 'preview') {
    const chosen = s.routes[s.sel];
    s.routes.forEach(scoreRoute);
    s.routes.sort((a, b) => a.eta - b.eta);
    s.sel = Math.max(0, s.routes.indexOf(chosen));
  }
  rescoreActive();
}

const markers = new Map();
let reportPopup = null;

function showReportPopup(rep) {
  reportPopup?.remove();
  const box = document.createElement('div');
  box.className = 'pop';
  box.innerHTML = '<b></b><small></small><div class="row"><button>Not there</button></div>';
  box.querySelector('b').textContent = rep.camera ? `Speed camera${rep.limit ? ` · limit ${rep.limit}` : ''}` : REPORTS[rep.type].label;
  box.querySelector('small').textContent = rep.camera
    ? 'Mapped on OpenStreetMap'
    : rep.live
      ? `${rep.detail ? `${rep.detail} · ` : ''}Live from TomTom`
      : `Reported by you · ${fmtAge(rep.at)}`;
  box.querySelector('button').onclick = () => { reportPopup.remove(); removeReport(rep.id); toast('Removed. Thanks for checking.'); };
  reportPopup = new maplibregl.Popup({ closeButton: false, offset: 30 }).setLngLat(rep.lngLat).setDOMContent(box).addTo(map);
}

function syncMarkers() {
  // Cameras are drawn as a map layer, since there are too many for DOM markers.
  const live = allReports().filter((r) => !r.camera);
  const ids = new Set(live.map((r) => r.id));
  for (const [id, marker] of markers) {
    if (!ids.has(id)) { marker.remove(); markers.delete(id); }
  }
  for (const rep of live) {
    if (markers.has(rep.id)) continue;
    const el = document.createElement('div');
    el.className = 'rep-marker';
    el.style.background = REPORTS[rep.type].color;
    el.innerHTML = icon(REPORTS[rep.type].icon);
    el.addEventListener('click', () => showReportPopup(rep));
    markers.set(rep.id, new maplibregl.Marker({ element: el, anchor: 'bottom-left' }).setLngLat(rep.lngLat).addTo(map));
  }
}

function award(points) {
  state.points += points;
  if (s.trip) s.trip.points += points;
  save();
}

function rescoreActive() {
  s.routes.forEach(scoreRoute);
  if (nav) scoreRoute(nav.route);
  syncMarkers();
  renderRoutes();
  if (s.mode === 'preview') renderPreview();
}

function addReport(type) {
  state.reports.push({ id: `r${Date.now()}`, type, lngLat: s.pos, at: Date.now(), mine: true });
  award(10);
  rescoreActive();
  closeReportSheet();
  toast(`${REPORTS[type].label} reported. +10 points`);
}

function removeReport(id) {
  state.reports = state.reports.filter((r) => r.id !== id);
  s.incidents = s.incidents.filter((r) => r.id !== id);
  if (id.startsWith('c')) {
    s.cameras = s.cameras.filter((r) => r.id !== id);
    renderCameras();
  }
  save();
  rescoreActive();
}

function openReportSheet() {
  $('#reportScrim').hidden = false;
  $('#reportSheet').hidden = false;
}
function closeReportSheet() {
  $('#reportScrim').hidden = true;
  $('#reportSheet').hidden = true;
}

$('#reportGrid').append(...Object.entries(REPORTS).map(([type, r]) => {
  const button = document.createElement('button');
  button.innerHTML = `<span class="badge" style="background:${r.color}">${icon(r.icon)}</span>${r.label}`;
  button.onclick = () => addReport(type);
  return button;
}));

/* ---------- Modes ---------- */

function setMode(mode) {
  s.mode = mode;
  document.body.dataset.mode = mode;
  document.querySelectorAll('[data-modes]').forEach((el) => {
    el.hidden = !el.dataset.modes.split(' ').includes(mode);
  });
  if (mode !== 'drive') {
    $('#alert').hidden = true;
    $('#recenterBtn').hidden = true;
  }
  if (mode === 'browse') renderChips();
  renderRoutes();
}

/* ---------- Search ---------- */

function renderRows(groups) {
  const box = $('#searchResults');
  box.replaceChildren();
  for (const group of groups) {
    if (group.title) {
      const h = document.createElement('h3');
      h.textContent = group.title;
      box.append(h);
    }
    for (const row of group.rows) {
      const button = document.createElement('button');
      button.className = 'result';
      button.innerHTML = `${row.icon}<span><b></b><small></small></span>`;
      button.querySelector('b').textContent = row.name;
      button.querySelector('small').textContent = row.detail || '';
      button.onclick = row.act;
      box.append(button);
    }
  }
}

function renderSearchHome() {
  const saved = [
    { key: 'home', label: 'Home', icon: ICON_HOME },
    { key: 'work', label: 'Work', icon: ICON_WORK },
  ].map(({ key, label, icon: rowIcon }) => ({
    icon: rowIcon,
    name: label,
    detail: state[key] ? state[key].name : `Set your ${key} address`,
    act: () => (state[key] ? planTo(state[key]) : openSearch(key)),
  }));
  const recents = state.recents.map((place) => ({ icon: ICON_CLOCK, name: place.name, detail: place.detail, act: () => planTo(place) }));
  renderRows(s.choosing ? [] : [{ rows: saved }, ...(recents.length ? [{ title: 'Recent', rows: recents }] : [])]);
}

function openSearch(choosing = null) {
  s.choosing = choosing;
  $('#searchPanel').hidden = false;
  const input = $('#searchInput');
  input.value = '';
  input.placeholder = choosing ? `Search for your ${choosing} address` : 'Search a place or address';
  renderSearchHome();
  input.focus();
}

function closeSearch() {
  searchAbort?.abort();
  $('#searchPanel').hidden = true;
  s.choosing = null;
}

function choosePlace(place) {
  if (s.choosing) {
    state[s.choosing] = place;
    save();
    toast(`${s.choosing === 'home' ? 'Home' : 'Work'} saved`);
    closeSearch();
    renderChips();
    return;
  }
  planTo(place);
}

let searchAbort;
let searchTimer;
$('#searchInput').addEventListener('input', (e) => {
  const query = e.target.value.trim();
  clearTimeout(searchTimer);
  searchAbort?.abort();
  if (query.length < 2) { renderSearchHome(); return; }
  searchTimer = setTimeout(async () => {
    searchAbort = new AbortController();
    try {
      const places = await searchPlaces(query, s.pos, searchAbort.signal);
      if (!places.length) {
        $('#searchResults').innerHTML = '<div class="empty">No places found. Try adding a city.</div>';
        return;
      }
      renderRows([{ rows: places.map((place) => ({ icon: ICON_PIN, name: place.name, detail: place.detail, act: () => choosePlace(place) })) }]);
    } catch (err) {
      if (err.name !== 'AbortError') $('#searchResults').innerHTML = '<div class="empty">Search is unavailable right now. Check your connection and try again.</div>';
    }
  }, 280);
});

function renderChips() {
  const box = $('#quickChips');
  box.replaceChildren();
  const chips = [
    state.home && ['Home', state.home],
    state.work && ['Work', state.work],
    ...state.recents.slice(0, 3).map((p) => [p.name, p]),
  ].filter(Boolean);
  for (const [label, place] of chips) {
    const button = document.createElement('button');
    button.textContent = label;
    button.onclick = () => planTo(place);
    box.append(button);
  }
}

/* ---------- Route preview ---------- */

function fitRoute(route) {
  const bounds = route.line.coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(route.line.coords[0], route.line.coords[0]));
  const wide = innerWidth >= 720;
  const sheet = document.querySelector('[data-modes="preview"].sheet');
  map.fitBounds(bounds, {
    padding: { top: 60, right: 60, left: wide ? 470 : 40, bottom: wide ? 60 : Math.min(sheet.offsetHeight + 30, innerHeight * 0.62) },
    duration: 700, pitch: 0, bearing: 0,
  });
}

async function planTo(place) {
  closeSearch();
  popup?.remove();
  state.recents = [place, ...state.recents.filter((p) => p.name !== place.name)].slice(0, 6);
  state.lastPos = s.pos;
  save();
  s.dest = place;
  s.routes = [];
  s.routeError = null;
  s.sel = 0;
  destPin.setLngLat(place.lngLat).addTo(map);
  setMode('preview');
  renderPreview();
  const token = ++s.planToken;
  try {
    const routes = await fetchRoutes(s.pos, place.lngLat);
    if (token !== s.planToken) return;
    routes.forEach(scoreRoute);
    routes.sort((a, b) => a.eta - b.eta);
    s.routes = routes;
    syncMarkers();
    renderPreview();
    renderRoutes();
    fitRoute(routes[0]);
    enrichRoutes(routes)
      .then(() => { if (token === s.planToken && s.mode === 'preview') renderPreview(); })
      .catch(() => {});
    applyLive(routes, token);
  } catch (err) {
    if (token !== s.planToken) return;
    s.routeError = err.message;
    renderPreview();
  }
}

function hitSummary(route) {
  const parts = [];
  if (route.liveDuration != null) parts.push(route.trafficDelay >= 60 ? `Live traffic +${Math.round(route.trafficDelay / 60)} min` : 'Live traffic: clear');
  const counts = {};
  route.hits.forEach((h) => { counts[REPORTS[h.rep.type].label] = (counts[REPORTS[h.rep.type].label] || 0) + 1; });
  parts.push(...Object.entries(counts).map(([label, n]) => (n > 1 ? `${n} ${label}` : label)));
  return parts.join(' · ') || 'No reports on this route';
}

function renderPreview() {
  setText($('#destName'), s.dest.name);
  setText($('#destDetail'), s.dest.detail || '');
  const list = $('#routeList');
  const actions = $('#previewActions');
  list.replaceChildren();
  actions.replaceChildren();

  if (s.routeError) {
    const p = document.createElement('p');
    p.className = 'error-text';
    p.textContent = `${s.routeError}. The free routing service may be busy.`;
    list.append(p);
    actions.append(actionButton('Try again', 'primary', () => planTo(s.dest)));
    return;
  }
  if (!s.routes.length) {
    list.innerHTML = '<div class="skeleton"></div>';
    return;
  }

  s.routes.forEach((route, i) => {
    const button = document.createElement('button');
    button.className = 'route';
    button.setAttribute('aria-pressed', String(i === s.sel));
    const eta = document.createElement('b');
    eta.textContent = fmtDur(route.eta);
    button.append(eta);
    if (i === 0) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'Best';
      button.append(tag);
    }
    const info = document.createElement('small');
    info.textContent = `${fmtDist(route.distance)} · arrive ${fmtClock(route.eta)}${route.via ? ` · via ${route.via}` : ''}`;
    const reports = document.createElement('small');
    reports.textContent = hitSummary(route);
    if (route.delay) reports.className = 'warn';
    button.append(info, reports);
    button.onclick = () => selectRoute(i);
    list.append(button);
  });

  const tripTime = document.createElement('div');
  tripTime.className = 'trip-time';
  tripTime.innerHTML = `<b>${fmtDur(s.routes[s.sel].eta)}</b><small>drive time</small>`;
  actions.append(tripTime);

  if (s.gpsOK && !s.manual) {
    actions.append(actionButton('Simulate', 'secondary', () => startDrive('sim')));
    actions.append(actionButton('Go', 'primary', () => startDrive('gps')));
  } else {
    actions.append(actionButton('Simulate drive', 'primary', () => startDrive('sim')));
  }
}

function actionButton(label, className, onclick) {
  const button = document.createElement('button');
  button.className = className;
  button.textContent = label;
  button.onclick = onclick;
  return button;
}

function selectRoute(i) {
  s.sel = i;
  renderPreview();
  renderRoutes();
}

function exitPreview() {
  s.planToken++;
  s.routes = [];
  s.dest = null;
  s.incidents = [];
  syncMarkers();
  destPin.remove();
  setMode('browse');
  map.easeTo({ center: s.pos, zoom: 14.5, padding: { top: 0, right: 0, bottom: 0, left: 0 }, duration: 600 });
}

/* ---------- Turn-by-turn text and icons ---------- */

const MODIFIERS = {
  straight: 'Continue straight', 'slight right': 'Bear right', right: 'Turn right', 'sharp right': 'Turn sharp right',
  'slight left': 'Bear left', left: 'Turn left', 'sharp left': 'Turn sharp left', uturn: 'Make a U-turn',
};

function ordinal(n) {
  return `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`;
}

function maneuverText(step, spoken = false) {
  // An English voice can't pronounce Arabic script, so speak the road number instead.
  const name = spoken && ARABIC.test(step.name) ? step.ref : step.name;
  const side = step.modifier.includes('left') ? 'left' : step.modifier.includes('right') ? 'right' : '';
  let text;
  switch (step.type) {
    case 'arrive': return 'Arrive at your destination';
    case 'roundabout':
    case 'rotary': text = step.exit ? `At the roundabout, take the ${ordinal(step.exit)} exit` : 'Enter the roundabout'; break;
    case 'exit roundabout':
    case 'exit rotary': text = 'Exit the roundabout'; break;
    case 'merge': text = side ? `Merge ${side}` : 'Merge'; break;
    case 'on ramp':
    case 'off ramp': text = side ? `Take the ramp on the ${side}` : 'Take the ramp'; break;
    case 'fork': text = side ? `Keep ${side} at the fork` : 'Continue at the fork'; break;
    case 'new name': text = 'Continue'; break;
    default: text = MODIFIERS[step.modifier] || 'Continue';
  }
  return name ? `${text} onto ${name}` : text;
}

function turnIcon(step) {
  if (step.type === 'arrive') return icon('<path d="M6 21V4"/><path d="M6 4h12l-3 4 3 4H6"/>');
  if (step.type === 'roundabout' || step.type === 'rotary') return icon('<circle cx="12" cy="9" r="4.5"/><path d="M12 22v-8.5M16 5.5L19 3M19 3h-3.5M19 3v3.5"/>');
  const flip = step.modifier.includes('left') ? ' transform="matrix(-1 0 0 1 24 0)"' : '';
  const shapes = {
    straight: '<path d="M12 21V4M6 10l6-6 6 6"/>',
    slight: '<path d="M9 21v-6.5c0-1 .4-2 1.1-2.7L18 4M11.5 4H18v6.5"/>',
    turn: '<path d="M6 21v-8a3 3 0 0 1 3-3h10M14 5l5 5-5 5"/>',
    uturn: '<path d="M7 21V9a5 5 0 0 1 10 0v9M12 14l5 5 5-5"/>',
  };
  const m = step.modifier;
  const shape = m === 'uturn' ? shapes.uturn : m.startsWith('slight') ? shapes.slight : m.includes('left') || m.includes('right') ? shapes.turn : shapes.straight;
  return icon(`<g${flip}>${shape}</g>`);
}

/* ---------- Driving ---------- */

let wakeLock = null;

function beginRoute(route, source, carry = {}) {
  nav = {
    route, source, line: route.line, steps: route.steps, d: 0, targetD: 0, v: 0, stepIdx: 0,
    heading: carry.heading ?? pointAt(route.line, 0).bearing, zoom: carry.zoom ?? 16.6, following: true,
    spoken: new Set(), alerted: carry.alerted ?? new Set(), alertHit: null,
    offCount: 0, offRoute: false, rerouting: false, nextUi: 0, nextDraw: 0,
  };
}

function startDrive(source) {
  const route = s.routes[s.sel];
  s.routes = [route];
  s.trip = { traveled: 0, points: 0, startedAt: Date.now() };
  s.nextLive = performance.now() + LIVE_REFRESH;
  beginRoute(route, source);
  reportPopup?.remove();
  setMode('drive');
  renderDriveControls();
  speak(`Starting route. ${fmtDur(route.eta).replace('min', 'minutes').replace(' h ', ' hours ')} to your destination.`);
  navigator.wakeLock?.request('screen').then((lock) => { wakeLock = lock; }).catch(() => {});
  lastFrame = performance.now();
}

function renderDriveControls() {
  const chip = $('#simChip');
  chip.hidden = nav?.source !== 'sim';
  chip.textContent = `${s.simMult}×`;
  $('#muteBtn').innerHTML = state.settings.voice ? ICON_VOICE_ON : ICON_VOICE_OFF;
  setText($('#speedUnit'), metric() ? 'km/h' : 'mph');
}

function advanceSim(dt) {
  const step = nav.steps[nav.stepIdx];
  let target = Math.max(4, step.distance / (step.duration || 1));
  const inJam = nav.route.hits.some((h) => isSlowdown(h) && nav.d > jamRange(h)[0] && nav.d < jamRange(h)[1]);
  if (inJam) target *= 0.35;
  nav.v += (target - nav.v) * Math.min(1, dt * 1.5);
  nav.d += nav.v * s.simMult * dt;
  s.speed = nav.v;
}

function remainingSeconds() {
  const step = nav.steps[nav.stepIdx];
  const stepLeft = step.distance ? Math.max(0, 1 - (nav.d - step.at) / step.distance) : 0;
  let total = step.duration * stepLeft;
  for (let i = nav.stepIdx + 1; i < nav.steps.length; i++) total += nav.steps[i].duration;
  if (nav.route.liveDuration != null) return total * (nav.route.liveDuration / nav.route.duration);
  for (const h of nav.route.hits) if (h.d > nav.d) total += repDelay(h.rep);
  return total;
}

function voiceGuidance(step, toGo) {
  // Pick the tightest prompt band we're inside and retire the wider ones.
  for (const band of [45, 220, 800]) {
    if (toGo > band) continue;
    const key = `${nav.stepIdx}:${band}`;
    if (nav.spoken.has(key)) return;
    [45, 220, 800].filter((b) => b >= band).forEach((b) => nav.spoken.add(`${nav.stepIdx}:${b}`));
    const lane = band === 45 ? null : laneGuidance(nav, s.speed);
    speak(band === 45 ? maneuverText(step, true) : `In ${sayDist(toGo)}, ${maneuverText(step, true)}.${lane ? ` ${lane.text}.` : ''}`);
    return;
  }
}

function updateAlert() {
  const live = allReports();
  if (nav.alertHit && (nav.alertHit.d <= nav.d || !live.some((r) => r.id === nav.alertHit.rep.id))) nav.alertHit = null;
  if (!nav.alertHit) {
    const next = nav.route.hits.find((h) => h.d - nav.d > 20 && h.d - nav.d <= 700 && !nav.alerted.has(h.rep.id) && !h.rep.mine);
    if (next) {
      nav.alertHit = next;
      nav.alerted.add(next.rep.id);
      const r = REPORTS[next.rep.type];
      $('#alertIcon').style.background = r.color;
      $('#alertIcon').innerHTML = icon(r.icon);
      const limit = next.rep.limit ? ` · limit ${next.rep.limit}` : '';
      setText($('#alertTitle'), next.rep.camera ? `Speed camera${limit}` : next.rep.live ? `${r.label} (live)` : r.label);
      speak(next.rep.camera ? `Speed camera ahead.${next.rep.limit ? ` Limit ${next.rep.limit}.` : ''}` : `${r.say} reported ahead`);
    }
  }
  $('#alert').hidden = !nav.alertHit;
  if (nav.alertHit) setText($('#alertDist'), `${fmtDist(nav.alertHit.d - nav.d)} ahead`);
}

function resolveAlert(stillThere) {
  const hit = nav?.alertHit;
  if (!hit) return;
  nav.alertHit = null;
  $('#alert').hidden = true;
  award(2);
  if (!stillThere) removeReport(hit.rep.id);
  toast('Thanks for confirming. +2 points');
}

function renderLanes(guidance) {
  const panel = $('#lanePanel');
  const key = guidance ? `${guidance.kind}|${guidance.text}|${guidance.lanes.map((l) => `${l.active}${l.arrow}`).join()}` : '';
  if (panel.dataset.key === key) return;
  panel.dataset.key = key;
  panel.hidden = !guidance;
  if (!guidance) return;
  const row = $('#laneRow');
  row.replaceChildren(...guidance.lanes.map((lane) => {
    const box = document.createElement('span');
    box.className = lane.active ? 'lane active' : 'lane';
    const modifier = lane.arrow === 'none' ? 'straight' : lane.arrow.replace('merge_to_', 'slight ');
    box.innerHTML = turnIcon({ type: 'turn', modifier });
    return box;
  }));
  row.hidden = !guidance.lanes.length;
  setText($('#laneText'), guidance.text);
  setText($('#laneSource'), guidance.source);
}

function updateDriveUi(now) {
  const next = nav.steps[nav.stepIdx + 1];
  const target = next || nav.steps[nav.stepIdx];
  const toGo = (next ? next.at : nav.line.length) - nav.d;
  setText($('#turnDist'), fmtDist(toGo));
  setText($('#turnText'), maneuverText(target));
  const iconKey = `${target.type}|${target.modifier}`;
  const turn = $('#turnIcon');
  if (turn.dataset.key !== iconKey) {
    turn.dataset.key = iconKey;
    turn.innerHTML = turnIcon(target);
  }
  renderLanes(laneGuidance(nav, s.speed));
  voiceGuidance(target, toGo);

  const rest = remainingSeconds();
  setText($('#etaClock'), fmtClock(rest));
  setText($('#etaRest'), `${fmtDur(rest)} · ${fmtDist(nav.line.length - nav.d)}`);
  setText($('#speedVal'), String(Math.round(s.speed * (metric() ? 3.6 : 2.237))));
  updateAlert();

  if (now >= nav.nextDraw) {
    nav.nextDraw = now + 700;
    renderRoutes();
  }
  if (now >= s.nextLive) {
    s.nextLive = now + LIVE_REFRESH;
    applyLive([nav.route], s.planToken);
  }
}

function updateNav(now, dt) {
  if (nav.source === 'sim') advanceSim(dt);
  else nav.d += (nav.targetD - nav.d) * Math.min(1, dt * 3);

  while (nav.stepIdx < nav.steps.length - 1 && nav.d >= nav.steps[nav.stepIdx + 1].at) nav.stepIdx++;

  const point = pointAt(nav.line, nav.d);
  if (!nav.offRoute) moveTo(point.pos);
  const turnRate = nav.source === 'sim' ? Math.sqrt(s.simMult) : 1;
  nav.heading = (nav.heading + angleDelta(nav.heading, point.bearing) * Math.min(1, dt * 4 * turnRate) + 360) % 360;
  puck.setRotation(nav.heading);

  const targetZoom = s.speed > 25 ? 15.4 : s.speed > 13 ? 16.1 : 16.8;
  nav.zoom += (targetZoom - nav.zoom) * Math.min(1, dt);
  if (nav.following) {
    map.jumpTo({ center: s.pos, bearing: nav.heading, pitch: 58, zoom: nav.zoom, padding: { top: innerHeight * 0.42, bottom: 0, left: 0, right: 0 } });
  }

  if (now >= nav.nextUi) {
    nav.nextUi = now + 200;
    updateDriveUi(now);
  }
  if (nav.d >= nav.line.length - 22) finishDrive(true);
}

function onDriveFix(lngLat, speed) {
  s.speed = speed;
  const p = project(nav.line, lngLat, nav.d);
  if (p.offset > 55) {
    nav.offCount++;
    nav.offRoute = nav.offCount >= 2;
    if (nav.offRoute) moveTo(lngLat);
    if (nav.offCount >= 3) reroute(lngLat);
  } else {
    nav.offCount = 0;
    nav.offRoute = false;
    nav.targetD = p.d;
  }
}

async function reroute(from) {
  if (nav.rerouting) return;
  nav.rerouting = true;
  const current = nav;
  speak('Recalculating');
  toast('Recalculating…');
  try {
    const routes = await fetchRoutes(from, s.dest.lngLat);
    if (nav !== current) return;
    routes.forEach(scoreRoute);
    routes.sort((a, b) => a.eta - b.eta);
    s.trip.traveled += current.d;
    beginRoute(routes[0], current.source, { heading: current.heading, zoom: current.zoom, alerted: current.alerted });
    nav.following = current.following;
    s.routes = [routes[0]];
    renderRoutes();
    enrichRoutes([routes[0]]).catch(() => {});
    applyLive([routes[0]], s.planToken);
  } catch {
    if (nav === current) {
      current.rerouting = false;
      current.offCount = 0;
      toast('Could not reroute. Will try again.');
    }
  }
}

function finishDrive(arrived) {
  const km = (s.trip.traveled + nav.d) / 1000;
  const earned = Math.floor(km) + (arrived ? 20 : 0);
  state.km += km;
  state.drives += arrived ? 1 : 0;
  award(earned);
  state.lastPos = s.pos;
  save();
  s.result = { km, points: s.trip.points, min: (Date.now() - s.trip.startedAt) / 60000 };
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  if (arrived) speak('You have arrived');
  else if ('speechSynthesis' in window) speechSynthesis.cancel();
  nav = null;
  s.speed = 0;
  puck.setRotation(0);

  if (arrived) {
    setMode('arrived');
    setText($('#arrivedPlace'), s.dest.name);
    $('#arrivedStats').innerHTML = `<div><dt>Distance</dt><dd>${fmtDist(s.result.km * 1000)}</dd></div><div><dt>Points</dt><dd>+${s.result.points}</dd></div><div><dt>Total</dt><dd>${state.points}</dd></div>`;
    map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 }, duration: 800 });
  } else {
    exitPreview();
    map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
  }
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  if (s.mode === 'drive' && nav) updateNav(now, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function stopFollowing(e) {
  if (e.originalEvent && nav) {
    nav.following = false;
    $('#recenterBtn').hidden = false;
  }
}
map.on('dragstart', stopFollowing);
map.on('zoomstart', stopFollowing);

/* ---------- GPS ---------- */

function onGpsError() {
  if (s.gpsWarned || s.gpsOK) return;
  s.gpsWarned = true;
  toast('Location is off. Tap the map to set a starting point.');
}

function onFix(position) {
  if (s.manual) return;
  const lngLat = [position.coords.longitude, position.coords.latitude];
  const first = !s.gpsOK;
  s.gpsOK = true;
  if (s.mode === 'drive' && nav) {
    if (nav.source === 'gps') onDriveFix(lngLat, position.coords.speed || 0);
    return;
  }
  moveTo(lngLat);
  if (first && s.mode === 'browse') map.flyTo({ center: lngLat, zoom: 15, duration: 900 });
  if (first && s.mode === 'preview' && s.dest) renderPreview();
}

if (navigator.geolocation) {
  navigator.geolocation.watchPosition(onFix, onGpsError, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
} else {
  onGpsError();
}

/* ---------- Dropped pins ---------- */

let popup = null;

map.on('click', async (e) => {
  if (s.mode !== 'browse' || e.originalEvent.target.closest('.rep-marker')) return;
  if (map.queryRenderedFeatures(e.point, { layers: ['cameras'] }).length) return;
  const lngLat = [e.lngLat.lng, e.lngLat.lat];
  const place = { name: 'Dropped pin', detail: '', lngLat };
  const box = document.createElement('div');
  box.className = 'pop';
  box.innerHTML = '<b></b><small></small><div class="row"><button id="popStart">Start here</button><button class="go" id="popDrive">Drive here</button></div>';
  const [title, sub] = [box.querySelector('b'), box.querySelector('small')];
  title.textContent = place.name;
  sub.textContent = 'Finding address…';
  box.querySelector('#popDrive').onclick = () => planTo(place);
  box.querySelector('#popStart').onclick = () => {
    s.manual = true;
    moveTo(lngLat);
    state.lastPos = lngLat;
    save();
    popup.remove();
    toast('Starting point set');
  };
  popup?.remove();
  const thisPopup = new maplibregl.Popup({ closeButton: false, offset: 10 }).setLngLat(lngLat).setDOMContent(box).addTo(map);
  popup = thisPopup;
  try {
    const found = await reversePlace(lngLat);
    if (found) {
      place.name = found.name;
      place.detail = found.detail;
      title.textContent = found.name;
    }
    sub.textContent = found?.detail || '';
  } catch {
    sub.textContent = '';
  }
});

map.on('click', 'cameras', (e) => {
  const camera = s.cameras.find((c) => c.id === e.features[0]?.properties.id);
  if (camera) showReportPopup(camera);
});
map.on('click', 'route-alt', (e) => {
  if (s.mode === 'preview' && e.features[0]) selectRoute(e.features[0].properties.id);
});
map.on('mouseenter', 'route-alt', () => { if (s.mode === 'preview') map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'route-alt', () => { map.getCanvas().style.cursor = ''; });

/* ---------- Menu ---------- */

function segmented(key, options) {
  const buttons = options.map(([value, label]) => `<button data-key="${key}" data-value="${value}" aria-pressed="${state.settings[key] === value}">${label}</button>`).join('');
  return `<div class="seg">${buttons}</div>`;
}

function renderDrawer() {
  const drawer = $('#drawer');
  const levelIndex = LEVELS.findLastIndex(([min]) => state.points >= min);
  const [min, name] = LEVELS[levelIndex];
  const next = LEVELS[levelIndex + 1];
  const pct = next ? ((state.points - min) / (next[0] - min)) * 100 : 100;
  drawer.innerHTML = `
    <div class="brand">${icon('<path d="M4 6l6 6-6 6M12 6l6 6-6 6"/>')}Convoy</div>
    <div class="level">
      <b>${name}</b>
      <span>${state.points} points${next ? ` · ${next[0] - state.points} to ${next[1]}` : ''}</span>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>
    <dl class="stats">
      <div><dt>Distance</dt><dd>${fmtDist(state.km * 1000)}</dd></div>
      <div><dt>Drives</dt><dd>${state.drives}</dd></div>
      <div><dt>Reports</dt><dd>${state.reports.length}</dd></div>
    </dl>
    <h3>Settings</h3>
    <div class="setting">Map ${segmented('theme', [['auto', 'Auto'], ['light', 'Day'], ['dark', 'Night']])}</div>
    <div class="setting">Units ${segmented('units', [['km', 'km'], ['mi', 'mi']])}</div>
    <div class="setting">Voice ${segmented('voice', [[true, 'On'], [false, 'Off']])}</div>
    <div class="setting">Vehicle ${segmented('vehicle', [['arrow', 'Arrow'], ['car', 'Car'], ['van', 'Van']])}</div>
    <div class="setting">Color <div class="swatches">${COLORS.map((c) => `<button style="background:${c}" data-color="${c}" aria-label="Color ${c}" aria-pressed="${state.settings.color === c}"></button>`).join('')}</div></div>
    <div class="setting">Saved places <div class="seg"><button data-saved="home">Set home</button><button data-saved="work">Set work</button></div></div>
    <h3>Live traffic</h3>
    ${state.settings.trafficKey
    ? '<div class="setting">TomTom key saved <div class="seg"><button id="removeKey">Remove</button></div></div>'
    : TOMTOM_KEY.trim()
    ? '<div class="setting">TomTom key built into the app</div>'
    : `<div class="key-row"><input id="keyInput" type="password" placeholder="Paste TomTom API key" autocomplete="off"><button class="secondary" id="saveKey">Save</button></div>
       <p class="credits">Get a free key, no card needed, at <a href="https://developer.tomtom.com" target="_blank" rel="noopener">developer.tomtom.com</a>. It stays in this browser.</p>`}
    <button class="link-danger" id="resetBtn">Reset all data</button>
    <p class="credits">${trafficKey() ? 'Live traffic by TomTom.' : 'Without a TomTom key, routes do not include live traffic.'} Speed cameras come from OpenStreetMap and may be incomplete. Lane advice marked "Estimated" is inferred from the road's lane count, so always follow road signs and markings. Your own reports stay on this device. Map data © OpenStreetMap contributors. Tiles by OpenFreeMap, routing by OSRM, search by Photon.</p>`;
}

async function saveTrafficKey(key) {
  if (!key) return;
  try {
    if (!(await validateKey(key))) {
      toast('TomTom rejected that key. Check it and try again.');
      return;
    }
  } catch {
    toast('Could not reach TomTom. Check your connection.');
    return;
  }
  state.settings.trafficKey = key;
  save();
  renderFlow();
  renderDrawer();
  toast('Live traffic is on');
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#menuScrim').hidden = true;
}

$('#drawer').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  if (button.id === 'resetBtn') {
    if (!confirm('Erase your points, reports and saved places?')) return;
    localStorage.removeItem(STORE_KEY);
    location.reload();
    return;
  }
  if (button.id === 'saveKey') {
    saveTrafficKey($('#keyInput').value.trim());
    return;
  }
  if (button.id === 'removeKey') {
    state.settings.trafficKey = '';
    save();
    renderFlow();
    renderDrawer();
    return;
  }
  if (button.dataset.saved) {
    closeDrawer();
    openSearch(button.dataset.saved);
    return;
  }
  if (button.dataset.color) {
    state.settings.color = button.dataset.color;
  } else if (button.dataset.key) {
    const raw = button.dataset.value;
    state.settings[button.dataset.key] = raw === 'true' ? true : raw === 'false' ? false : raw;
  } else {
    return;
  }
  save();
  applyTheme();
  renderPuck();
  renderDrawer();
});

/* ---------- Wiring ---------- */

$('#whereBtn').onclick = () => openSearch();
$('#searchClose').onclick = closeSearch;
$('#backBtn').onclick = exitPreview;
$('#endBtn').onclick = () => finishDrive(false);
$('#doneBtn').onclick = exitPreview;
$('#reportBtn').onclick = openReportSheet;
$('#reportScrim').onclick = closeReportSheet;
$('#menuScrim').onclick = closeDrawer;
$('#alertYes').onclick = () => resolveAlert(true);
$('#alertNo').onclick = () => resolveAlert(false);
$('#locateBtn').onclick = () => map.easeTo({ center: s.pos, zoom: 15, duration: 500 });
$('#menuBtn').onclick = () => {
  renderDrawer();
  $('#drawer').hidden = false;
  $('#menuScrim').hidden = false;
};
$('#recenterBtn').onclick = () => {
  if (nav) nav.following = true;
  $('#recenterBtn').hidden = true;
};
$('#simChip').onclick = () => {
  s.simMult = SIM_SPEEDS[(SIM_SPEEDS.indexOf(s.simMult) + 1) % SIM_SPEEDS.length];
  renderDriveControls();
};
$('#muteBtn').onclick = () => {
  state.settings.voice = !state.settings.voice;
  if (!state.settings.voice && 'speechSynthesis' in window) speechSynthesis.cancel();
  save();
  renderDriveControls();
};
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeSearch();
  closeReportSheet();
  closeDrawer();
});

loadCameras()
  .then((cameras) => {
    s.cameras = cameras;
    renderCameras();
  })
  .catch(() => toast('Speed cameras could not be loaded'));

setMode('browse');

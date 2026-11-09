// Free, keyless public services: Photon for places, OSRM for routes.
// Both are community-run and rate limited, so a real launch needs paid or
// self-hosted equivalents.
import { buildLine, project } from './geo.js';

const PHOTON = 'https://photon.komoot.io';
const OSRM = 'https://router.project-osrm.org';

function toPlace(feature) {
  const p = feature.properties;
  const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || 'Dropped pin';
  const detail = [p.name ? p.street : null, p.city, p.state, p.country].filter(Boolean);
  return { name, detail: [...new Set(detail)].filter((x) => x !== name).join(', '), lngLat: feature.geometry.coordinates };
}

export async function searchPlaces(query, near, signal) {
  const params = new URLSearchParams({ q: query, limit: '7', lon: near[0], lat: near[1], lang: 'en' });
  const res = await fetch(`${PHOTON}/api/?${params}`, { signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return (await res.json()).features.map(toPlace);
}

export async function reversePlace(lngLat) {
  const res = await fetch(`${PHOTON}/reverse?lon=${lngLat[0]}&lat=${lngLat[1]}&limit=1&lang=en`);
  if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
  const [feature] = (await res.json()).features;
  return feature ? { ...toPlace(feature), lngLat } : null;
}

export async function fetchRoutes(from, to) {
  const url = `${OSRM}/route/v1/driving/${from.join(',')};${to.join(',')}?overview=full&geometries=geojson&steps=true&alternatives=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing failed (${res.status})`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes.length) throw new Error('No driving route found');

  return data.routes.map((route, id) => {
    const line = buildLine(route.geometry.coordinates);
    const raw = route.legs.flatMap((leg) => leg.steps);
    // OSRM's step distances sum to the route length only approximately,
    // so scale them to land exactly on our measured polyline.
    const total = raw.reduce((sum, s) => sum + s.distance, 0) || 1;
    const scale = line.length / total;
    let at = 0;
    const steps = raw.map((s) => {
      const step = {
        at,
        distance: s.distance * scale,
        duration: s.duration,
        type: s.maneuver.type,
        modifier: s.maneuver.modifier || 'straight',
        exit: s.maneuver.exit,
        name: s.name || s.ref || '',
        ref: s.ref || '',
        laneCount: null,
      };
      at += step.distance;
      return step;
    });
    const longest = [...steps].filter((s) => s.name).sort((a, b) => b.distance - a.distance)[0];
    // Junctions with mapped turn lanes where at least one lane is the wrong one.
    const laneHints = raw
      .flatMap((s) => s.intersections)
      .filter((x) => x.lanes?.some((l) => l.valid) && x.lanes.some((l) => !l.valid))
      .map((x) => ({ lanes: x.lanes, ...project(line, x.location) }))
      .filter((h) => h.offset < 20)
      .sort((a, b) => a.d - b.d);
    return { id, line, steps, laneHints, duration: route.duration, distance: route.distance, via: longest ? longest.name : '' };
  });
}

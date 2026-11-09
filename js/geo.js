// Small geometry helpers. Positions are [lng, lat]; distances are metres.
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function dist(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Shortest signed rotation from angle a to angle b, in degrees. */
export function angleDelta(a, b) {
  return ((b - a + 540) % 360) - 180;
}

/** Precompute cumulative distances so a polyline can be queried by distance. */
export function buildLine(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
  return { coords, cum, length: cum[cum.length - 1] };
}

function segmentAt(line, d) {
  let lo = 0;
  let hi = line.cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (line.cum[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function pointAt(line, d) {
  const clamped = Math.max(0, Math.min(line.length, d));
  const i = segmentAt(line, clamped);
  const a = line.coords[i];
  const b = line.coords[i + 1];
  const len = line.cum[i + 1] - line.cum[i] || 1;
  const t = (clamped - line.cum[i]) / len;
  return { pos: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing: bearing(a, b) };
}

/**
 * Closest point on the line to p. Passing hint (a distance along the line)
 * restricts the search to nearby road, so a fix on an overpass or a
 * parallel street can't make the position jump.
 */
export function project(line, p, hint) {
  const from = hint == null ? 0 : segmentAt(line, Math.max(0, hint - 300));
  const to = hint == null ? line.coords.length - 2 : segmentAt(line, Math.min(line.length, hint + 800));
  const kx = Math.cos(rad(p[1])) * rad(1) * R;
  const ky = rad(1) * R;
  let best = { d: 0, offset: Infinity };
  for (let i = from; i <= to; i++) {
    const a = line.coords[i];
    const b = line.coords[i + 1];
    const ax = (a[0] - p[0]) * kx;
    const ay = (a[1] - p[1]) * ky;
    const dx = (b[0] - a[0]) * kx;
    const dy = (b[1] - a[1]) * ky;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    const offset = Math.hypot(ax + t * dx, ay + t * dy);
    if (offset < best.offset) best = { d: line.cum[i] + t * (line.cum[i + 1] - line.cum[i]), offset };
  }
  return best;
}

/** The part of the line between two distances, as a coordinate list. */
export function sliceLine(line, from, to) {
  const a = Math.max(0, from);
  const b = Math.min(line.length, to);
  if (b <= a) return [];
  const out = [pointAt(line, a).pos];
  for (let i = 0; i < line.coords.length; i++) {
    if (line.cum[i] > a && line.cum[i] < b) out.push(line.coords[i]);
  }
  out.push(pointAt(line, b).pos);
  return out;
}

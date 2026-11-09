// Lane guidance. The router only knows turn lanes for a few percent of UAE
// junctions, so guidance comes in three grades, and the UI labels each:
//   exact     - turn-lane markings mapped at this junction
//   estimated - real lane count from OpenStreetMap, lane inferred from the turn
//   side      - lane count unknown, only the side of the road is given
import { angleDelta, buildLine, pointAt, project } from './geo.js';

// Road data is a bundled OpenStreetMap snapshot, split into 0.1-degree tiles,
// because the public live query servers proved too unreliable to drive with.
const tiles = new Map();
let namesRequest = null;

const tileKey = ([lng, lat]) => `${Math.floor(lng * 10)}_${Math.floor(lat * 10)}`;

function pairs(flat) {
  const coords = [];
  for (let i = 0; i < flat.length; i += 2) coords.push([flat[i], flat[i + 1]]);
  return coords;
}

// A tile that doesn't exist just means no lane data there, e.g. outside the UAE.
function loadTile(key) {
  if (!tiles.has(key)) {
    tiles.set(key, fetch(`data/roads/${key}.json`)
      .then((res) => (res.ok ? res.json() : []))
      .then((rows) => rows.map(([oneway, lanes, forward, backward, flat]) => ({
        tags: { oneway: oneway ? 'yes' : 'no', lanes, 'lanes:forward': forward, 'lanes:backward': backward },
        line: buildLine(pairs(flat)),
      })))
      .catch(() => []));
  }
  return tiles.get(key);
}

function loadNames() {
  namesRequest ||= fetch('data/uae-names.json').then((res) => (res.ok ? res.json() : {})).catch(() => ({}));
  return namesRequest;
}

const isOneway = (tags) => tags.oneway === 'yes';

function lanesFor(tags, forward) {
  const num = (key) => {
    const n = parseInt(tags[key], 10);
    return n > 0 && n <= 12 ? n : null;
  };
  if (isOneway(tags)) return num('lanes');
  const directional = num(forward ? 'lanes:forward' : 'lanes:backward');
  if (directional) return directional;
  // An even total on a two-way road is assumed to split equally.
  const all = num('lanes');
  return all && all % 2 === 0 ? all / 2 : null;
}

function matchWay(ways, pos, heading) {
  let best = null;
  let bestOffset = 15;
  for (const way of ways) {
    const p = project(way.line, pos);
    if (p.offset >= bestOffset) continue;
    const diff = Math.abs(angleDelta(heading, pointAt(way.line, p.d).bearing));
    const forward = diff < 45;
    if (!forward && !(diff > 135 && !isOneway(way.tags))) continue;
    best = { tags: way.tags, forward };
    bestOffset = p.offset;
  }
  return best;
}

/**
 * Adds lane counts and English road names to route steps, in place.
 * Optional extra data: on failure the routes simply keep working without it.
 */
export async function enrichRoutes(routes) {
  const english = await loadNames();
  for (const route of routes) {
    route.steps.forEach((step) => { step.name = english[step.name] || step.name; });
    route.via = english[route.via] || route.via;
  }

  await Promise.all(routes.flatMap((route) => route.steps.map(async (step, i) => {
    if (i === 0 || step.type === 'arrive') return;
    const before = pointAt(route.line, Math.max(0, step.at - 15));
    const way = matchWay(await loadTile(tileKey(before.pos)), before.pos, before.bearing);
    if (way) step.laneCount = lanesFor(way.tags, way.forward);
  })));
}

function describe(active, total) {
  const k = active.length;
  const first = active[0];
  const last = active[k - 1];
  if (last - first + 1 !== k) return 'Stay in the highlighted lanes';
  if (first === 0) return k === 1 ? 'Stay in the left lane' : `Stay in the left ${k} lanes`;
  if (last === total - 1) return k === 1 ? 'Stay in the right lane' : `Stay in the right ${k} lanes`;
  if (k === 1 && total === 3) return 'Stay in the center lane';
  return k === 1 ? `Stay in lane ${first + 1} from the left` : `Stay in lanes ${first + 1} to ${last + 1} from the left`;
}

function exactGuidance(hint, target) {
  const lanes = hint.lanes.map((lane) => {
    const options = lane.indications;
    const arrow = lane.valid && target && options.includes(target.modifier) ? target.modifier : options[0];
    return { active: lane.valid, arrow };
  });
  const active = lanes.flatMap((lane, i) => (lane.active ? [i] : []));
  return { kind: 'exact', lanes, text: describe(active, lanes.length), source: 'Mapped lanes' };
}

/** Which way the turn pulls you. The UAE drives on the right, so U-turns go from the left. */
function turnSide(step) {
  if (step.type === 'roundabout' || step.type === 'rotary') {
    if (!step.exit) return null;
    if (step.exit === 1) return { side: 'right', arrow: 'right' };
    return step.exit === 2 ? { side: 'middle', arrow: 'straight' } : { side: 'left', arrow: 'left' };
  }
  if (!['turn', 'end of road', 'fork', 'off ramp', 'on ramp', 'continue'].includes(step.type)) return null;
  if (step.modifier === 'uturn') return { side: 'left', arrow: 'uturn' };
  if (step.modifier.includes('left')) return { side: 'left', arrow: step.modifier };
  if (step.modifier.includes('right')) return { side: 'right', arrow: step.modifier };
  return null;
}

function estimatedGuidance(step) {
  const turn = turnSide(step);
  if (!turn) return null;
  const total = step.laneCount;
  if (!total) {
    if (turn.side === 'middle') return null;
    return { kind: 'side', lanes: [], text: `Keep to the ${turn.side}`, source: 'Lane count not mapped here' };
  }
  if (total < 2 || (turn.side === 'middle' && total < 3)) return null;
  // Only ever recommend lanes on the side of the turn: the outermost lane
  // is the one that reliably leads there.
  const isActive = (i) => {
    if (turn.side === 'left') return i === 0;
    if (turn.side === 'right') return i === total - 1;
    return i > 0 && i < total - 1;
  };
  const lanes = Array.from({ length: total }, (_, i) => ({ active: isActive(i), arrow: isActive(i) ? turn.arrow : 'straight' }));
  const active = lanes.flatMap((lane, i) => (lane.active ? [i] : []));
  return { kind: 'estimated', lanes, text: describe(active, total), source: 'Estimated from lane count' };
}

/** Guidance for the stretch ahead, or null when no lane choice matters yet. */
export function laneGuidance(nav, speed) {
  const range = speed > 20 ? 1500 : speed > 13 ? 800 : 400;
  const target = nav.steps[nav.stepIdx + 1];
  const toTurn = target ? target.at - nav.d : Infinity;
  const stepStart = nav.steps[nav.stepIdx].at;
  const onThisStep = nav.route.laneHints.filter((h) => h.d > stepStart + 5 && h.d <= nav.d + toTurn + 10);
  // A mapped junction just passed keeps its advice, so the last metres before
  // the turn don't swap to a guess that contradicts what the driver was told.
  const hint = onThisStep.find((h) => h.d > nav.d + 5 && h.d - nav.d <= range)
    || onThisStep.findLast((h) => h.d <= nav.d + 5 && h.d > nav.d - 50);
  if (hint) return exactGuidance(hint, target);
  if (!target || toTurn > range) return null;
  return estimatedGuidance(target);
}

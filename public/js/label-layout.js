// Pure label-direction layout. No Leaflet, no DOM — all math in screen
// (container) pixels, unit-testable (label-layout.test.js).
//
// Cost model per label per candidate direction (weights in DEFAULT_WEIGHTS):
//   label↔label overlap + label↔route overlap + offscreen area + bbox growth.
// Product priority: 1) labels don't overlap each other, 2) then they don't
// cover the route line, 3) then route+labels keep the smallest bounding box.
// Weight ranges (overlaps in px², bbox growth in px) make later terms only
// break near-ties. Exact cost ties keep the label's current direction, so
// re-running on the same view (zoomend/resize) never flaps.

export const DEFAULT_WEIGHTS = { label: 1, route: 0.5, offscreen: 0.5, bbox: 0.1 };
// Preference order on near-ties: right is the historical default, then up,
// down, left — matches the pre-algorithm behaviour for isolated stops.
export const DEFAULT_DIR_ORDER = ['right', 'top', 'bottom', 'left'];
export const DEFAULT_OFFSETS = {
  'right': [5, 0], 'left': [-5, 0], 'top': [0, -5], 'bottom': [0, 5]
};
const ARROW_SIZE = 4; // tooltip pointer length sitting between point and box
const EPS = 1e-9;

export function flipClockwise(dir) {
  return { 'top': 'right', 'right': 'bottom', 'bottom': 'left', 'left': 'top' }[dir] || null;
}

// Box of a tooltip of size dims anchored at `point` facing `dir`.
// The pointer (arrow) side is between the point and the box.
export function labelBox(point, dir, dims, offset) {
  let left, top;
  switch (dir) {
    case 'right': left = point.x + offset[0] + ARROW_SIZE; top = point.y + offset[1] - dims.h / 2; break;
    case 'left': left = point.x + offset[0] - ARROW_SIZE - dims.w; top = point.y + offset[1] - dims.h / 2; break;
    case 'top': left = point.x + offset[0] - dims.w / 2; top = point.y + offset[1] - ARROW_SIZE - dims.h; break;
    case 'bottom': left = point.x + offset[0] - dims.w / 2; top = point.y + offset[1] + ARROW_SIZE; break;
    default: return null;
  }
  return { left, top, right: left + dims.w, bottom: top + dims.h, w: dims.w, h: dims.h };
}

// Offscreen area of a box-bearing shape, capped by the viewport term's role:
// it only tie-breaks, so it never outweighs the label↔label term.
const OFFSCREEN_CAP_RATIO = 0.9; // of the label↔label weight × label area

export function overlapArea(a, b) {
  if (!(a.right > b.left && b.right > a.left && a.bottom > b.top && b.bottom > a.top)) return 0;
  const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const yOverlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return xOverlap * yOverlap;
}

// Fattened AABB per polyline segment (input already in pixel coords).
// ponytail: an AABB is fat for diagonal segments, so line overlap is
// over-estimated there — acceptable for a soft cost; upgrade to
// point-segment distance if labels visibly dodge empty space.
export function routeSegmentBoxes(pixelPts, halfWidth = 2.5) {
  const boxes = [];
  for (let i = 0; i + 1 < pixelPts.length; i++) {
    boxes.push({
      left: Math.min(pixelPts[i].x, pixelPts[i + 1].x) - halfWidth,
      right: Math.max(pixelPts[i].x, pixelPts[i + 1].x) + halfWidth,
      top: Math.min(pixelPts[i].y, pixelPts[i + 1].y) - halfWidth,
      bottom: Math.max(pixelPts[i].y, pixelPts[i + 1].y) + halfWidth
    });
  }
  return boxes;
}

function mergeBox(a, b) {
  return {
    left: Math.min(a.left, b.left), right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom)
  };
}

function offscreenArea(box, viewport) {
  if (!viewport) return 0;
  return box.w * box.h - overlapArea(box, viewport);
}

// Total side growth of `current ∪ {box}` relative to `current`.
function growSum(current, box) {
  return Math.max(0, current.left - box.left) + Math.max(0, box.right - current.right)
       + Math.max(0, current.top - box.top) + Math.max(0, box.bottom - current.bottom);
}

// Greedy along-route placement. `labels`: [{x, y, w, h, dir}] in route order
// (dir = current direction; kept on exact ties). Returns the chosen direction
// per input index. Complexity O(n·4·(n + segments)) — trivial for our scale
// (max 66 stops per route).
export function bestDirections(labels, opts = {}) {
  const n = labels.length;
  if (n === 0) return [];

  const dirOrder = opts.dirOrder || DEFAULT_DIR_ORDER;
  const offsets = opts.offsets || DEFAULT_OFFSETS;
  const weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const routeBoxes = opts.routeBoxes || [];
  const viewport = opts.viewport;

  // Bounding box the composition is measured against: the route, or — when no
  // route boxes are given — the stop points themselves.
  const resetBb = () => routeBoxes.length
    ? routeBoxes.reduce(mergeBox)
    : labels.reduce((acc, l) => mergeBox(acc, { left: l.x, right: l.x, top: l.y, bottom: l.y }),
      { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
  let bb = resetBb();

  // Pass 1: greedy along-route placement (each label sees only earlier ones).
  const boxes = [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = cheapest(i, boxes.filter((_, j) => j < i));
    boxes.push(r.box);
    out.push(r.dir);
    bb = mergeBox(bb, r.box);
  }
  // Recompute from scratch so pass 2 also has a valid baseline (null would
  // break growSum). Pass 2 changes directions less often than it keeps them,
  // so a stale-large bb quirk is not worth more bookkeeping.
  bb = resetBb();
  for (let i = 0; i < n; i++) bb = mergeBox(bb, boxes[i]);
  // Pass 2: one refinement sweep — now every label also sees later ones, so
  // the first labels can correct for what pass 1 crowded around them.
  for (let i = 0; i < n; i++) {
    const others = boxes.filter((_, j) => j !== i);
    const r = cheapest(i, others);
    if (r.dir !== out[i]) { boxes[i] = r.box; out[i] = r.dir; }
  }
  return out;

  // Chooses the cheapest candidate direction for label i against the already
  // placed boxes; exact ties keep the label's current direction.
  function cheapest(i, placedBoxes) {
    const label = labels[i];
    const dims = { w: label.w, h: label.h };
    const point = { x: label.x, y: label.y };
    // Spec priority 1 (labels must not overlap each other) is enforced by
    // capping offscreen: the viewport term only breaks near-ties, it can
    // never buy a fully offscreen direction at the price of a real overlap.
    // ponytail: cap is a ratio of the label's own area, not a global px²
    // constant, so it scales with any font size.
    const offCap = OFFSCREEN_CAP_RATIO * dims.w * dims.h;
    const costOf = (dir) => {
      const box = labelBox(point, dir, dims, offsets[dir]);
      let c = weights.offscreen * Math.min(offscreenArea(box, viewport), offCap);
      for (const p of placedBoxes) c += weights.label * overlapArea(box, p);
      for (const rb of routeBoxes) c += weights.route * overlapArea(box, rb);
      c += weights.bbox * growSum(bb, box);
      return { dir, box, c };
    };

    // Current direction is the baseline, so exact ties keep it (no flapping).
    let best = costOf(label.dir);
    for (const dir of dirOrder) {
      if (dir === best.dir) continue;
      const cand = costOf(dir);
      if (cand.c < best.c - EPS) best = cand;
    }
    return best;
  }
}

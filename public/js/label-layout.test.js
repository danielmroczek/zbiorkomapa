import { describe, it, expect } from 'vitest';
import {
  labelBox, overlapArea, routeSegmentBoxes, bestDirections, DEFAULT_WEIGHTS
} from './label-layout.js';

const LBL = (x, y, w, h, dir) => ({ x, y, w, h, dir });
const NO_ROUTE = [];
const W = DEFAULT_WEIGHTS;

describe('labelBox', () => {
  it('right: box starts offset+arrow beyond the point, vertically centred', () => {
    const b = labelBox({ x: 100, y: 100 }, 'right', { w: 60, h: 12 }, [5, 0]);
    expect(b).toEqual({ left: 109, top: 94, right: 169, bottom: 106, w: 60, h: 12 });
  });

  it('left/top/bottom anchor the box to the matching side', () => {
    const dims = { w: 60, h: 12 };
    const left = labelBox({ x: 100, y: 100 }, 'left', dims, [-5, 0]);
    expect(left.right).toBe(91); // 100 - 5 offset - 4 arrow - 60 w + 60
    const top = labelBox({ x: 100, y: 100 }, 'top', dims, [0, -5]);
    expect(top.bottom).toBe(91);
    const bottom = labelBox({ x: 100, y: 100 }, 'bottom', dims, [0, 5]);
    expect(bottom.top).toBe(109);
  });
});

describe('overlapArea', () => {
  it('returns 0 for disjoint or touching boxes', () => {
    const a = { left: 0, top: 0, right: 10, bottom: 10 };
    expect(overlapArea(a, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(0);
    expect(overlapArea(a, { left: 50, top: 50, right: 60, bottom: 60 })).toBe(0);
  });

  it('returns the intersection area', () => {
    const a = { left: 0, top: 0, right: 10, bottom: 10 };
    expect(overlapArea(a, { left: 5, top: 5, right: 15, bottom: 15 })).toBe(25);
  });
});

describe('routeSegmentBoxes', () => {
  it('fattens each segment by halfWidth, diagonal AABB included', () => {
    const boxes = routeSegmentBoxes([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 2.5);
    expect(boxes).toEqual([
      { left: -2.5, right: 102.5, top: -2.5, bottom: 2.5 },
      { left: 97.5, right: 102.5, top: -2.5, bottom: 102.5 }
    ]);
  });
});

describe('bestDirections', () => {
  it('isolated labels inside an ample scene keep their direction (all-zero tie)', () => {
    // A route box generously containing every candidate label: all four
    // directions cost 0 for both labels → every label keeps its direction.
    const scene = [{ left: 0, top: 0, right: 600, bottom: 600 }];
    const out = bestDirections([
      LBL(500, 400, 60, 12, 'right'),
      LBL(300, 150, 40, 12, 'top')
    ], { routeBoxes: scene });
    expect(out).toEqual(['right', 'top']);
  });

  it('second label at the same point must dodge the first', () => {
    // Both start 'right': the first is placed at cost ~0 (nothing placed yet),
    // the second overlaps it completely and must move; among non-overlapping
    // directions 'top' ties 'bottom'/'left' on cost but comes first in dirOrder.
    const out = bestDirections([
      LBL(100, 100, 50, 12, 'right'),
      LBL(100, 100, 50, 12, 'right')
    ], { routeBoxes: NO_ROUTE });
    expect(out).toEqual(['right', 'top']);
  });

  it('prefers the route-empty side over a bbox-smaller side covering the line', () => {
    // Vertical route at x=100. Label must dodge the line even though 'top'
    // would grow the bounding box less.
    const route = routeSegmentBoxes([{ x: 100, y: 0 }, { x: 100, y: 300 }], 2.5);
    const out = bestDirections([LBL(100, 150, 60, 12, 'top')], { routeBoxes: route });
    expect(['left', 'right']).toContain(out[0]);
  });

  it('breaks near-ties by minimizing bbox growth (vertical route hugging left edge)', () => {
    // Node-on-line scenario: no side is route-free (every side overlaps the
    // fattened line), bbox does the tie-break. Line at x=2.5, viewport-wide.
    const route = routeSegmentBoxes([{ x: 2.5, y: 0 }, { x: 2.5, y: 300 }], 2.5);
    const out = bestDirections([LBL(2.5, 150, 60, 12, 'right')], { routeBoxes: route });
    expect(out[0]).toBe('right');
  });

  it('bbox cost stays on the route bounds — an early outward label must not subsidise the rest', () => {
    // L-shaped route (wide top arm + right vertical): stop 1 sits in the
    // corner where every direction but 'right' overlaps the route, so it
    // goes right and pushes the bbox out. Stop 2 sits on the free stem where
    // 'left' costs 0. With a GROWING bbox baseline stop 2's 'right' would be
    // free (stop 1 already paid) and win the tie; with the fixed route
    // bounds 'left' wins outright.
    const route = [
      { left: 100, top: 100, right: 800, bottom: 130 },
      { left: 790, top: 130, right: 802, bottom: 500 }
    ];
    const out = bestDirections([
      LBL(795, 135, 150, 12, 'right'), // corner: only 'right' avoids the route
      LBL(795, 300, 150, 12, 'right')  // free stem: 'left' is strictly cheaper
    ], { routeBoxes: route });
    expect(out[0]).toBe('right');
    expect(out[1]).toBe('left');
  });

  it('ties keep the incoming direction (stable re-runs)', () => {
    // Same all-zero setup as above, single label arriving as 'left'.
    const scene = [{ left: 0, top: 0, right: 600, bottom: 600 }];
    const out = bestDirections([LBL(300, 300, 60, 12, 'left')], { routeBoxes: scene });
    expect(out).toEqual(['left']);
  });

  it('at a route endpoint, growing the bbox far past the line loses to grazing it (486 regression)', () => {
    // Route ends in a point; the stop sits at the end. 'bottom' is route-free
    // but stretches the composition ~100 px below the route; 'left' only
    // grazes the line's end segment. With bbox weight 0.1 bottom won and the
    // whole route rendered with the first label hanging off the bottom.
    // Real route spans the viewport (bb ≈ 113..850 × 63..644) — include far
    // points so the bbox baseline is the route's full extent, not 3 points.
    const route = routeSegmentBoxes([
      { x: 848, y: 642 }, { x: 842, y: 630 }, { x: 810, y: 440 }, { x: 790, y: 120 }, { x: 113, y: 64 }
    ], 2.5);
    const out = bestDirections([LBL(852, 642, 159, 16, 'bottom')], { routeBoxes: route });
    expect(out[0]).toBe('left');
  });

  it('empty input → empty output', () => {
    expect(bestDirections([], { routeBoxes: NO_ROUTE })).toEqual([]);
  });
});

// Sanity: the offscreen term actually pulls labels into the viewport.
describe('offscreen weighting', () => {
  it('prefers a fully-visible direction over an offscreen one', () => {
    const viewport = { left: 0, top: 0, right: 200, bottom: 200 };
    const out = bestDirections([LBL(190, 100, 30, 12, 'right')], { routeBoxes: NO_ROUTE, viewport });
    expect(out[0]).not.toBe('right');
  });
});

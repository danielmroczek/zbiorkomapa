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

  it('ties keep the incoming direction (stable re-runs)', () => {
    // Same all-zero setup as above, single label arriving as 'left'.
    const scene = [{ left: 0, top: 0, right: 600, bottom: 600 }];
    const out = bestDirections([LBL(300, 300, 60, 12, 'left')], { routeBoxes: scene });
    expect(out).toEqual(['left']);
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

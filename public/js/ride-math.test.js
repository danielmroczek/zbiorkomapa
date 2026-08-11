import { describe, it, expect } from 'vitest';
import { segmentSpeedAt, vehicleSector, snapStops } from './ride-math.js';

// --- A minimal, deterministic Turf fake for a horizontal straight line. ---
// Line runs from lon=0 to lon=10 at lat=0 (input as Leaflet [lat,lng]).
// `nearestPointOnLine` projects (clamps) the point's longitude onto [0,10].
function makeStraightLineFake() {
  const lineLenKm = 10; // ≈ 10 km at the equator

  // A horizontal line from lng=a to lng=b at lat=0. Its lng range drives both
  // length and nearestPointOnLine, so lineSliceAlong slices clamp correctly.
  const lineCoords = (a, b) => [[a, 0], [b, 0]]; // [lng, lat]
  const lngRange = (line) => {
    const cs = line.geometry.coordinates;
    return [cs[0][0], cs[cs.length - 1][0]];
  };

  return {
    lineString: (coords) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }),
    length: () => lineLenKm,
    // Real Turf `point()` returns a GeoJSON Feature; nearestPointOnLine reads
    // .geometry.coordinates in [lng, lat] order.
    point: (coords) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: {} }),
    // location (km) = point's lng clamped into the line's own lng range.
    nearestPointOnLine: (line, pt) => {
      const lng = pt.geometry.coordinates[0]; // Turf order [lng, lat]
      const [min, max] = lngRange(line);
      const clamped = Math.max(min, Math.min(max, lng));
      return { properties: { location: clamped, index: Math.round(clamped) } };
    },
    lineSliceAlong: (_line, startKm, endKm) => ({
      type: 'Feature',
      geometry: { coordinates: lineCoords(startKm, endKm) },
      properties: {},
    }),
  };
}

describe('segmentSpeedAt', () => {
  const spec = { segLen: 100, vMax: 10, accelTime: 1 }; // long: full trapezoid

  it('starts at rest (frac 0, speed 0)', () => {
    expect(segmentSpeedAt(spec, 0)).toEqual({ frac: 0, speed: 0 });
  });

  it('cruises at max speed mid-segment', () => {
    const mid = segmentSpeedAt(spec, 0.5);
    expect(mid.speed).toBe(1);
    // frac should have advanced well past 0 and stayed under 1
    expect(mid.frac).toBeGreaterThan(0.3);
    expect(mid.frac).toBeLessThan(0.8);
  });

  it('ends at frac 1 with rest speed', () => {
    expect(segmentSpeedAt(spec, 1)).toEqual({ frac: 1, speed: 0 });
  });

  it('clamps speed to [0,1] and frac is monotone non-decreasing', () => {
    let prevFrac = -1;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const { frac, speed } = segmentSpeedAt(spec, Math.min(t, 1));
      expect(speed).toBeGreaterThanOrEqual(0);
      expect(speed).toBeLessThanOrEqual(1);
      expect(frac).toBeGreaterThanOrEqual(prevFrac);
      prevFrac = frac;
    }
  });

  it('handles a short segment (triangle: symmetric, monotone frac)', () => {
    const short = { segLen: 1, vMax: 10, accelTime: 2 };
    // Triangle profile is symmetric: mid-segment is exactly halfway.
    expect(segmentSpeedAt(short, 0.5).frac).toBeCloseTo(0.5, 5);
    expect(segmentSpeedAt(short, 0).frac).toBe(0);
    expect(segmentSpeedAt(short, 1).frac).toBe(1);
    // Frac is monotone non-decreasing across the whole segment.
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const { frac } = segmentSpeedAt(short, Math.min(t, 1));
      expect(frac).toBeGreaterThanOrEqual(prev);
      prev = frac;
    }
  });
});

describe('vehicleSector', () => {
  // Expected values derived from the exact production algorithm:
  //   b = ((bearing % 360) + 540) % 360 - 180  (normalize to [-180, 180))
  //   b >= 135 || b < -135 → 'oncoming' ; b >= 0 → 'right' ; else 'left'
  it.each([
    [0, 'right'],
    [90, 'right'],
    [180, 'oncoming'], // 180 normalizes to -180 → oncoming
    [-90, 'left'],
    [179, 'oncoming'], // 179 >= 135 → oncoming
    [-179, 'oncoming'], // -179 < -135 → oncoming
    [135, 'oncoming'],
    [-135, 'left'], // -135 is not < -135, not >= 0 → left
    [30, 'right'],
    [-30, 'left'],
    [136, 'oncoming'],
  ])('bearing %s → %s', (bearing, expected) => {
    expect(vehicleSector(bearing)).toBe(expected);
  });
});

describe('snapStops', () => {
  const turf = makeStraightLineFake();

  it('snaps a mid stop to the correct distance', () => {
    // shape [lat,lng] = [ [0,0], [0,10] ]; stops at lng 2,4,6.
    // Exercises the internal [lng,lat] swap: stop_lon is mapped to location.
    const shape = [[0, 0], [0, 10]];
    const stops = [
      { stop_lat: 0, stop_lon: 2 },
      { stop_lat: 0, stop_lon: 4 },
      { stop_lat: 0, stop_lon: 6 },
    ];
    const { stopDists, lineLen } = snapStops(shape, stops, turf);
    expect(lineLen).toBe(10);
    expect(stopDists).toEqual([2, 4, 6]);
  });

  it('restricts the FIRST stop to the first half of a loop line', () => {
    // Stop is geographically near the END of the line (lng 9 of 10).
    // Loop rule must snap it back toward the start (≤ half of lineLen).
    const shape = [[0, 0], [0, 10]];
    const stops = [{ stop_lat: 0, stop_lon: 9 }];
    const { stopDists } = snapStops(shape, stops, turf);
    expect(stopDists[0]).toBeLessThanOrEqual(5); // ≤ lineLen/2
    expect(stopDists[0]).toBeGreaterThanOrEqual(0);
  });

  it('keeps later stops forward along the line (no backwards snap)', () => {
    const shape = [[0, 0], [0, 10]];
    const stops = [
      { stop_lat: 0, stop_lon: 3 },
      { stop_lat: 0, stop_lon: 1 }, // would snap backwards → moved forward
    ];
    const { stopDists } = snapStops(shape, stops, turf);
    expect(stopDists[1]).toBeGreaterThanOrEqual(stopDists[0]);
  });
});

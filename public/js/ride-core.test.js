import { describe, it, expect, vi } from 'vitest';
import { createRide } from './ride-core.js';

// --- A minimal, deterministic Turf fake for a horizontal straight line. ---
// Line runs from lng=0 to lng=10 at lat=0 (input as Leaflet [lat,lng]).
// `nearestPointOnLine` clamps a point's longitude onto [0,10]; `lineSliceAlong`
// slices the [start,end] km range; `bearing` is fixed at 90° (east -> 'right')
// so the sector wiring is deterministic.
function makeStraightLineFake() {
  const lineLenKm = 10;
  const lineCoords = (a, b) => [[a, 0], [b, 0]]; // [lng, lat]
  const lngRange = (line) => {
    const cs = line.geometry.coordinates;
    return [cs[0][0], cs[cs.length - 1][0]];
  };
  return {
    lineString: (coords) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }),
    length: () => lineLenKm,
    point: (coords) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: {} }),
    nearestPointOnLine: (line, pt) => {
      const lng = pt.geometry.coordinates[0];
      const [min, max] = lngRange(line);
      return { properties: { location: Math.max(min, Math.min(max, lng)), index: 1 } };
    },
    lineSliceAlong: (_line, startKm, endKm) => ({
      type: 'Feature',
      geometry: { coordinates: lineCoords(startKm, endKm) },
      properties: {},
    }),
    bearing: () => 90, // east -> vehicleSector(90) === 'right'
  };
}

const TURF = makeStraightLineFake();

// Two stops at lng 0 and lng 10 — stop 0 sits at the shape start (preDist 0),
// so the ride begins by holding at stop 0.
const TwoStopShape = [[0, 0], [0, 10]]; // [lat,lng]
const TwoStops = [
  { stop_lat: 0, stop_lon: 0 },
  { stop_lat: 0, stop_lon: 10 },
];

function startRide(override = {}) {
  const events = [];
  const ride = createRide(TURF);
  const startView = ride.start({
    shape: TwoStopShape,
    stops: TwoStops,
    speed: 'fast',
    onStopReached: (i) => events.push(i),
    ...override,
  });
  return { ride, events, startView };
}

// Advance until the ride emits the given number of stopReached events.
function advanceUntil(ride, events, count, stepSec = 0.5, limit = 2000) {
  for (let i = 0; i < limit && events.length < count; i++) {
    ride.advance(stepSec);
  }
  expect(events.length).toBeGreaterThanOrEqual(count);
}

describe('createRide — start', () => {
  it('returns a startView at the first shape coordinate', () => {
    const { startView } = startRide();
    expect(startView.latLng).toEqual([0, 0]);
    expect(startView.avgSegDistKm).toBe(10);
  });

  it('holds at stop 0 immediately when it sits at the shape start', () => {
    const { ride, events } = startRide();
    const state = ride.advance(0);
    expect(events).toEqual([0]); // stop 0 reported on the first advance
    expect(state.highlightIdx).toBe(0);
    expect(state.speed).toBe(0);
    expect(state.done).toBe(false);
  });
});

describe('createRide — stop sequencing', () => {
  it('walks every stop in order, gating on release() between them', () => {
    const { ride, events } = startRide();
    ride.advance(0); // hold at stop 0
    expect(events).toEqual([0]);

    ride.release(); // leave stop 0, travel toward stop 1
    advanceUntil(ride, events, 2, 0.25); // arrive at stop 1 (last)
    expect(events).toEqual([0, 1]);
    expect(ride.advance(0).highlightIdx).toBe(1);
  });

  it('marks done after the last stop is released', () => {
    const { ride, events } = startRide();
    ride.advance(0);
    ride.release();
    advanceUntil(ride, events, 2, 0.25);
    ride.release(); // leave the final stop
    expect(ride.advance(0).done).toBe(true);
  });

  it('freezes while holding: big advance does not consume or move', () => {
    const { ride, events } = startRide();
    const s0 = ride.advance(0); // hold at stop 0
    const pos0 = s0.position;
    const frozen = ride.advance(500); // huge delta while holding
    expect(frozen.position).toEqual(pos0);
    expect(frozen.highlightIdx).toBe(0);
    expect(events).toEqual([0]); // no additional stop fired
  });
});

describe('createRide — approach segment', () => {
  it('glides to stop 0 first when the shape starts before it', () => {
    // Shape lng 0..10; first stop at lng 2, second at lng 8.
    const stops = [
      { stop_lat: 0, stop_lon: 2 },
      { stop_lat: 0, stop_lon: 8 },
    ];
    const events = [];
    const ride = createRide(TURF);
    ride.start({
      shape: TwoStopShape,
      stops,
      speed: 'fast',
      onStopReached: (i) => events.push(i),
    });

    const early = ride.advance(0.01);
    expect(events).toEqual([]); // approach has not reached stop 0 yet
    expect(early.highlightIdx).toBe(null);
    expect(early.position[1]).toBeGreaterThan(0); // moved off the shape start

    // Run until the approach completes into stop 0.
    for (let i = 0; i < 100 && events.length === 0; i++) ride.advance(0.05);
    expect(events).toEqual([0]);
  });
});

describe('createRide — pause / resume / stop', () => {
  it('pause freezes progress; resume continues from the same segment', () => {
    const { ride, events } = startRide();
    ride.advance(0); // hold at stop 0
    ride.release(); // start traveling to stop 1

    ride.pause();
    const p1 = ride.advance(1.0);
    const p2 = ride.advance(1.0);
    expect(p1.position).toEqual(p2.position); // frozen while paused
    expect(events).toEqual([0]);

    ride.resume();
    advanceUntil(ride, events, 2, 0.25);
    expect(events).toEqual([0, 1]); // resumed and completed
  });

  it('stop() resets so further advances are inert', () => {
    const { ride, events } = startRide();
    ride.advance(0);
    expect(events).toEqual([0]);
    ride.stop();
    const state = ride.advance(0.1);
    expect(state.done).toBe(true);
    expect(state.highlightIdx).toBe(null);
  });

  it('release after stop() is a no-op', () => {
    const { ride, events } = startRide();
    ride.advance(0);
    ride.stop();
    expect(() => ride.release()).not.toThrow();
    expect(events).toEqual([0]);
  });
});

describe('createRide — rendering state during travel', () => {
  it('reports a position and sector while driving along a segment', () => {
    const { ride } = startRide();
    ride.advance(0); // hold at stop 0
    ride.release(); // travel toward stop 1
    const state = ride.advance(0.5); // partway through the 3s segment
    expect(state.done).toBe(false);
    expect(Array.isArray(state.position)).toBe(true);
    expect(state.position[1]).toBeGreaterThan(0); // lng advanced past start
    expect(state.sector).toBe('right'); // from the fixed eastward bearing
    expect(state.highlightIdx).toBe(null); // no stop while traveling
    expect(state.trail.length).toBeGreaterThan(0);
  });

  it('reports speed for the sound adapter to consume', () => {
    const { ride } = startRide();
    ride.advance(0);
    ride.release();
    const state = ride.advance(0.3);
    expect(typeof state.speed).toBe('number');
    expect(state.speed).toBeGreaterThanOrEqual(0);
    expect(state.speed).toBeLessThanOrEqual(1);
  });
});

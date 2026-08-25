// Ride core — the deep state machine behind a vehicle ride.
//
// Deep module: owns the full ride timing model (approach + travel segments,
// stop holds, pause/resume, cancellation) behind a small interface. It is
// Leaflet-free and DOM-free — the geometry adapter (`turf`) is INJECTED, the
// same seam convention `ride-math.js` already uses, so this module stays
// testable under Node/Vitest (which cannot import `https://esm.sh/...` URLs).
//
// The module does NOT render anything. `start()` returns a `startView` (the
// ride-start coordinate + an average segment distance for view framing); the
// caller owns the Leaflet layers and the requestAnimationFrame loop, feeding
// wall-clock deltas into `advance(dt)` and applying the returned state.
//
// Coordination with the caller:
// - When the vehicle reaches a stop, the module sets a HOLD (stationary,
//   `highlightIdx` = that stop) and emits `onStopReached(stopIndex)`. The
//   caller plays stop-name audio, then calls `release()` to let the ride
//   continue. While holding, `advance(dt)` ignores time and returns the frozen
//   state, so elapsed time is never lost during playback.
// - Segments are precomputed at `start()`; a zero-length segment completes
//   immediately (the original code's "skip" behaviour is preserved).

import {
  segmentSpeedAt,
  segmentDurationSec,
  vehicleSector,
  snapStops,
  MIN_TRAIL_SLICE
} from './ride-math.js';

export function createRide(turf) {
  let st = null; // null when idle (never started / stopped)

  const emit = (callback, index) => {
    if (typeof callback === 'function') callback(index);
  };

  // Build one travel segment (approach or between two stops).
  function makeTravel(fromDist, toDist, arriveStop, vMax, accelTime) {
    const segLen = Math.max(toDist - fromDist, 0);
    const arrSec = segLen > 0 ? segmentDurationSec({ segLen, vMax, accelTime }) : 0;
    return { type: 'travel', fromDist, toDist, segLen, arrSec, arriveStop };
  }

  // Slice the shape from 0 up to `endKm`, returning the trail as Leaflet
  // [lat,lng] points plus the raw [lng,lat] slice coordinates (for sector).
  function advanceSlice(endKm, fromKm) {
    const sliceEnd = Math.max(endKm, fromKm + MIN_TRAIL_SLICE);
    const slice = turf.lineSliceAlong(st.turfLine, 0, sliceEnd);
    const coords = slice.geometry.coordinates; // [lng, lat]
    const latLngs = coords.map((c) => [c[1], c[0]]);
    return { coords, latLngs };
  }

  // Vehicle orientation sector at the tip of a slice (mirrors ride.js logic).
  function computeSector(coords) {
    const lastCoord = coords[coords.length - 1]; // [lng, lat]
    const nearest = turf.nearestPointOnLine(st.turfLine, turf.point(lastCoord));
    let prevIdx = nearest.properties.index;
    if (prevIdx > 0 && nearest.properties.location < 0.002) prevIdx--;
    const prevVertex = st.turfLine.geometry.coordinates[Math.max(0, prevIdx)];
    const bearing = turf.bearing(turf.point(prevVertex), turf.point(lastCoord));
    return vehicleSector(bearing);
  }

  function snapshot(speed) {
    if (!st) {
      return { position: null, trail: [], sector: 'left', speed: 0, highlightIdx: null, done: true };
    }
    return {
      position: st.currentPos.slice(),
      trail: st.currentTrail,
      sector: st.currentSector,
      speed: speed ?? 0,
      highlightIdx: st.holding ? st.holdStop : null,
      done: st.done,
    };
  }

  function arriveAtStop(step) {
    const { coords, latLngs } = advanceSlice(step.toDist, step.fromDist);
    st.currentTrail = latLngs;
    if (latLngs.length > 0) st.currentPos = latLngs[latLngs.length - 1];
    if (coords.length >= 2) st.currentSector = computeSector(coords);
    st.holding = true;
    st.holdStop = step.arriveStop;
    st.stepIdx += 1; // point at the hold that follows this travel
    emit(st.onStopReached, step.arriveStop);
    return snapshot(0);
  }

  return {
    start(input) {
      const { shape, stops, speed, onStopReached } = input;
      const { stopDists, lineLen } = snapStops(shape, stops, turf);
      const turfLine = turf.lineString(shape.map((c) => [c[1], c[0]]));
      const isSlow = speed === 'slow';
      const accelTime = isSlow ? 2 : 1;
      const avgSegDist = stops.length > 1 ? lineLen / (stops.length - 1) : lineLen;
      const vMax = avgSegDist / (isSlow ? 4 : 2);

      const steps = [];
      const preDist = stopDists[0] || 0;
      if (preDist > 0) {
        steps.push(makeTravel(0, preDist, 0, vMax, accelTime)); // approach -> stop 0
        steps.push({ type: 'hold', stopIndex: 0 });
      } else {
        steps.push({ type: 'hold', stopIndex: 0 });
      }
      for (let i = 0; i < stops.length - 1; i++) {
        steps.push(makeTravel(stopDists[i], stopDists[i + 1], i + 1, vMax, accelTime));
        steps.push({ type: 'hold', stopIndex: i + 1 });
      }

      st = {
        steps, stopDists, turfLine, vMax, accelTime,
        stepIdx: 0, segTime: 0,
        holding: false, holdStop: null,
        paused: false, done: false,
        currentSector: 'left',
        currentPos: [shape[0][0], shape[0][1]],
        currentTrail: [],
        onStopReached,
      };

      return { latLng: st.currentPos.slice(), avgSegDistKm: avgSegDist };
    },

    // Advance the ride by `dt` seconds of wall clock and return the new state.
    advance(dt) {
      if (!st || st.done) return snapshot(0);
      if (st.paused || st.holding) return snapshot(0);

      const step = st.steps[st.stepIdx];
      if (!step) { st.done = true; return snapshot(0); }

      if (step.type === 'hold') {
        // Reached directly at the start (stop 0 sits at the shape start).
        st.holding = true;
        st.holdStop = step.stopIndex;
        const dist = st.stopDists[step.stopIndex] ?? 0;
        const { coords, latLngs } = advanceSlice(dist, 0);
        st.currentTrail = latLngs;
        if (latLngs.length > 0) st.currentPos = latLngs[latLngs.length - 1];
        if (coords.length >= 2) st.currentSector = computeSector(coords);
        emit(st.onStopReached, step.stopIndex);
        return snapshot(0);
      }

      st.segTime += dt;
      if (st.segTime >= step.arrSec) {
        return arriveAtStop(step);
      }

      const t = Math.min(Math.max(st.segTime / step.arrSec, 0), 1);
      const { frac, speed } = segmentSpeedAt(
        { segLen: step.segLen, vMax: st.vMax, accelTime: st.accelTime },
        t
      );
      const currentKm = step.fromDist + frac * step.segLen;
      const { coords, latLngs } = advanceSlice(currentKm, step.fromDist);
      st.currentTrail = latLngs;
      if (latLngs.length > 0) st.currentPos = latLngs[latLngs.length - 1];
      if (coords.length >= 2) st.currentSector = computeSector(coords);
      return snapshot(speed);
    },

    // Call after the stop-name audio (or a fixed wait) finishes, to continue.
    release() {
      if (!st || !st.holding) return;
      st.holding = false;
      st.holdStop = null;
      st.segTime = 0;
      st.stepIdx += 1;
      if (st.stepIdx >= st.steps.length) st.done = true;
    },

    pause() { if (st) st.paused = true; },
    resume() { if (st) st.paused = false; },
    stop() { st = null; },
  };
}

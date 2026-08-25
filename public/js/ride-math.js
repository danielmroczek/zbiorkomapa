// Ride mechanics — the pure math of a simulated vehicle ride.
//
// Deep, side-effect-free module. No Leaflet, no Turf import: the geometry
// adapter (`turf`) is INJECTED by the caller, so this module stays testable
// under Node/Vitest (which cannot import `https://esm.sh/...` URLs).
//
// Coordinate convention: functions that deal with a shape accept Leaflet
// `[lat, lng]` coordinates. The `[lng, lat]` swap needed by Turf happens
// INSIDE `snapStops`, so the bug-prone convention lives in exactly one place.

const EPS = 0.0001; // km — min trail slice length guard (see caller)

/**
 * Speed/position profile for one segment between two stops.
 * Assumes an accel → cruise → decel trapezoid (or a "triangle" when the
 * segment is too short to reach cruise speed).
 *
 * @param {{ segLen:number, vMax:number, accelTime:number }} spec
 *   segLen = segment length (km), vMax = cruise speed (km/s),
 *   accelTime = seconds for accel & decel phase.
 * @param {number} t normalized time in [0, 1] through the segment.
 * @returns {{ frac:number, speed:number }} frac = fraction of segLen covered,
 *   speed = 0..1 fraction of vMax.
 */
/**
 * Duration (seconds) of one segment between two stops, for the accel → cruise
 * → decel trapezoid (or the "triangle" when the segment is too short to reach
 * cruise speed). Single source of truth for the segment profile's duration —
 * shared by `segmentSpeedAt` and the ride-core step walker, so the trapezoid
 * math can't drift between callers.
 *
 * @param {{ segLen:number, vMax:number, accelTime:number }} spec
 *   segLen = segment length (km), vMax = cruise speed (km/s),
 *   accelTime = seconds for accel & decel phase.
 * @returns {number} duration in seconds.
 */
export function segmentDurationSec({ segLen, vMax, accelTime }) {
  const accelDist = vMax * accelTime;
  if (segLen >= accelDist) {
    return segLen / vMax + accelTime;
  }
  // Triangle profile: 2·t1 where t1 is the (short) accel phase time.
  return 2 * accelTime * Math.sqrt(segLen / accelDist);
}

/**
 * Speed/position profile for one segment between two stops.
 * Assumes an accel → cruise → decel trapezoid (or a "triangle" when the
 * segment is too short to reach cruise speed).
 *
 * @param {{ segLen:number, vMax:number, accelTime:number }} spec
 *   segLen = segment length (km), vMax = cruise speed (km/s),
 *   accelTime = seconds for accel & decel phase.
 * @param {number} t normalized time in [0, 1] through the segment.
 * @returns {{ frac:number, speed:number }} frac = fraction of segLen covered,
 *   speed = 0..1 fraction of vMax.
 */
export function segmentSpeedAt({ segLen, vMax, accelTime }, t) {
  const accelDist = vMax * accelTime;
  const duration = segmentDurationSec({ segLen, vMax, accelTime });

  const elapsed = t * duration;
  let pos, speed;
  if (segLen >= accelDist) {
    const cruiseTime = duration - 2 * accelTime;
    if (elapsed < accelTime) {
      const f = elapsed / accelTime;
      pos = 0.5 * accelDist * f * f;
      speed = f;
    } else if (elapsed < accelTime + cruiseTime) {
      pos = 0.5 * accelDist + vMax * (elapsed - accelTime);
      speed = 1;
    } else {
      const dt = duration - elapsed;
      const f = dt / accelTime;
      pos = segLen - 0.5 * accelDist * f * f;
      speed = f;
    }
  } else {
    const t1 = accelTime * Math.sqrt(segLen / accelDist);
    if (elapsed < t1) {
      const f = elapsed / t1;
      pos = 0.5 * segLen * f * f;
      speed = f;
    } else {
      const dt = 2 * t1 - elapsed;
      const f = dt / t1;
      pos = segLen - 0.5 * segLen * f * f;
      speed = f;
    }
  }
  return { frac: pos / segLen, speed: Math.max(0, Math.min(1, speed)) };
}

/**
 * Bearing (degrees) → coarse vehicle orientation sector.
 * 'left' (default, westward), 'right' (eastward, flipped icon), or
 * 'oncoming' (south-bound, toward the viewer).
 */
export function vehicleSector(bearing) {
  const b = ((bearing % 360) + 540) % 360 - 180;
  if (b >= 135 || b < -135) return 'oncoming';
  if (b >= 0) return 'right';
  return 'left';
}

/**
 * Length of a shape line in kilometers.
 * The shape is given as Leaflet `[lat, lng]`; the Turf swap happens here.
 *
 * @param {Array<[number,number]>} coords Leaflet [lat,lng] vertices.
 * @param {object} turf An injected geometry adapter exposing:
 *   lineString, length.
 * @returns {string} length in km, rounded to 2 decimals (display-ready).
 */
export function routeLengthKm(coords, turf) {
  const turfLine = turf.lineString(coords.map((c) => [c[1], c[0]]));
  return turf.length(turfLine, { units: 'kilometers' }).toFixed(2);
}

/**
 * Snap each stop onto the shape line and return its distance (km) from the
 * start of the line, walking forward so loop routes don't snap backwards.
 *
 * The shape is given as Leaflet `[lat, lng]` coordinates; the Turf-swap
 * (`[lng, lat]`) happens here, so callers never think about the convention.
 *
 * @param {Array<[number,number]>} shapeCoords Leaflet [lat,lng] vertices.
 * @param {Array<{stop_lat:number, stop_lon:number}>} stops Stops in order.
 * @param {object} turf An injected geometry adapter exposing:
 *   lineString, length, point, nearestPointOnLine, lineSliceAlong.
 * @returns {{ stopDists:number[], lineLen:number }}
 */
export function snapStops(shapeCoords, stops, turf) {
  const turfLine = turf.lineString(shapeCoords.map((c) => [c[1], c[0]]));
  const lineLen = turf.length(turfLine, { units: 'kilometers' });

  const stopDists = [];
  let searchStartDist = 0;
  for (let i = 0; i < stops.length; i++) {
    const pt = turf.point([stops[i].stop_lon, stops[i].stop_lat]);
    const nearest = turf.nearestPointOnLine(turfLine, pt);
    let dist = nearest.properties.location;

    // Loop routes: the first stop may snap to the end of the line
    // (geographically close to the start). Restrict the first stop to the
    // first half so the ride begins at the actual start.
    if (i === 0 && dist > lineLen / 2) {
      const firstHalf = turf.lineSliceAlong(turfLine, 0, lineLen / 2);
      const nearestFirstHalf = turf.nearestPointOnLine(firstHalf, pt);
      dist = nearestFirstHalf.properties.location;
    }

    if (dist < searchStartDist && i > 0) {
      const remainingLine = turf.lineSliceAlong(turfLine, searchStartDist, lineLen);
      const nearestFwd = turf.nearestPointOnLine(remainingLine, pt);
      dist = searchStartDist + nearestFwd.properties.location;
    }
    searchStartDist = dist;
    stopDists.push(dist);
  }

  return { stopDists, lineLen };
}

// re-exported for the caller's convenience (used as a minimum trail slice)
export const MIN_TRAIL_SLICE = EPS;

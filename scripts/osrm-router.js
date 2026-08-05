/**
 * OSRM road router — generates road-following shape coordinates
 * for GTFS feeds that lack shapes.txt.
 *
 * Uses the public OSRM demo server. Each segment (stop A → stop B)
 * is routed independently with retry + straight-line fallback.
 *
 * Usage:
 *   import { routeSegments } from "./osrm-router.js";
 *   const coords = await routeSegments(stops); // [[lat,lng], ...]
 */

const OSRM_BASE_URL = "https://router.project-osrm.org/route/v1/driving";
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Route a single segment between two stops using OSRM.
 * Returns an array of [lat, lng] coordinates (the road-following path).
 * Falls back to a straight line if OSRM fails.
 */
async function routeSegment(fromLat, fromLon, toLat, toLon) {
  const url = `${OSRM_BASE_URL}/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        // Rate limited — wait and retry
        if (attempt < MAX_RETRIES) {
          console.log(`    OSRM rate limited, retry ${attempt + 1}/${MAX_RETRIES}...`);
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        break;
      }
      if (!res.ok) {
        if (attempt < MAX_RETRIES) {
          console.log(`    OSRM error ${res.status}, retry ${attempt + 1}/${MAX_RETRIES}...`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        break;
      }

      const data = await res.json();
      if (data.code !== "Ok" || !data.routes || data.routes.length === 0) {
        break;
      }

      // OSRM returns coordinates as [lon, lat] in GeoJSON format
      const coords = data.routes[0].geometry.coordinates;
      return coords.map((c) => [c[1], c[0]]); // → [lat, lon]
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.log(`    OSRM fetch error: ${err.message}, retry ${attempt + 1}/${MAX_RETRIES}...`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
    }
  }

  // Fallback: straight line between stops
  console.log(`    OSRM fallback: prosta linia [${fromLat},${fromLon}] → [${toLat},${toLon}]`);
  return [
    [fromLat, fromLon],
    [toLat, toLon],
  ];
}

/**
 * Route all segments between consecutive stops.
 * Returns a single array of [lat, lng] coordinates forming the full route shape.
 *
 * @param {Array<{stop_lat: number, stop_lon: number}>} stops - ordered list of stops
 * @param {{onSegment?: (i: number, total: number) => void}} [options]
 * @returns {Promise<number[][]>} - array of [lat, lng] coordinates
 */
export async function routeSegments(stops, options = {}) {
  if (stops.length < 2) {
    return stops.map((s) => [parseFloat(s.stop_lat), parseFloat(s.stop_lon)]);
  }

  const totalSegments = stops.length - 1;
  const allCoords = [];
  let straightLineFallbacks = 0;

  for (let i = 0; i < totalSegments; i++) {
    if (options.onSegment) {
      options.onSegment(i, totalSegments);
    }

    const from = stops[i];
    const to = stops[i + 1];
    const fromLat = parseFloat(from.stop_lat);
    const fromLon = parseFloat(from.stop_lon);
    const toLat = parseFloat(to.stop_lat);
    const toLon = parseFloat(to.stop_lon);

    const segmentCoords = await routeSegment(fromLat, fromLon, toLat, toLon);

    // Detect straight-line fallback (only 2 points and same as input)
    const isFallback =
      segmentCoords.length === 2 &&
      segmentCoords[0][0] === fromLat &&
      segmentCoords[0][1] === fromLon;
    if (isFallback) straightLineFallbacks++;

    // Avoid duplicating the junction point between segments
    if (allCoords.length > 0 && segmentCoords.length > 0) {
      const lastCoord = allCoords[allCoords.length - 1];
      const firstCoord = segmentCoords[0];
      if (
        lastCoord[0] === firstCoord[0] &&
        lastCoord[1] === firstCoord[1]
      ) {
        segmentCoords.shift();
      }
    }

    allCoords.push(...segmentCoords);

    // Small delay between requests to be nice to OSRM demo server
    if (i < totalSegments - 1) {
      await sleep(200);
    }
  }

  if (straightLineFallbacks > 0) {
    console.log(
      `    OSRM: ${totalSegments - straightLineFallbacks}/${totalSegments} segmentów po drogach, ${straightLineFallbacks} prostych linii (fallback)`,
    );
  }

  return allCoords;
}

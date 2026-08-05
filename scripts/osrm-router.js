/**
 * OSRM road router — generates road-following shape coordinates
 * for GTFS feeds that lack shapes.txt.
 *
 * Uses the public OSRM demo server. One request per route with all stops
 * as waypoints — much faster and more accurate than per-segment routing.
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
 * Route an entire route in one OSRM request with all stops as waypoints.
 * Returns an array of [lat, lng] coordinates (the road-following path).
 * Falls back to straight lines between stops if OSRM fails.
 *
 * @param {Array<{stop_lat: number, stop_lon: number}>} stops - ordered list of stops
 * @param {{onSegment?: (i: number, total: number) => void}} [options] - unused, kept for API compat
 * @returns {Promise<number[][]>} - array of [lat, lng] coordinates
 */
export async function routeSegments(stops, options = {}) {
  if (stops.length < 2) {
    return stops.map((s) => [parseFloat(s.stop_lat), parseFloat(s.stop_lon)]);
  }

  // Build coordinate string: lon,lat;lon,lat;...
  // OSRM expects [lon, lat] order in the URL
  const coordsStr = stops
    .map((s) => `${parseFloat(s.stop_lon)},${parseFloat(s.stop_lat)}`)
    .join(";");

  // Use waypoints parameter: first and last are stops, intermediates are via points
  // This tells OSRM to snap waypoints and route through them without "stopping"
  const waypoints =
    stops.length > 2 ? `&waypoints=0;${stops.length - 1}` : "";

  const url = `${OSRM_BASE_URL}/${coordsStr}?overview=full&geometries=geojson${waypoints}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        if (attempt < MAX_RETRIES) {
          console.log(
            `    OSRM rate limited, retry ${attempt + 1}/${MAX_RETRIES}...`,
          );
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        break;
      }
      if (!res.ok) {
        if (attempt < MAX_RETRIES) {
          console.log(
            `    OSRM error ${res.status}, retry ${attempt + 1}/${MAX_RETRIES}...`,
          );
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
        console.log(
          `    OSRM fetch error: ${err.message}, retry ${attempt + 1}/${MAX_RETRIES}...`,
        );
        await sleep(RETRY_DELAY_MS);
        continue;
      }
    }
  }

  // Fallback: straight lines between stops
  console.log(
    `    OSRM fallback: proste linie między ${stops.length} przystankami`,
  );
  return stops.map((s) => [parseFloat(s.stop_lat), parseFloat(s.stop_lon)]);
}

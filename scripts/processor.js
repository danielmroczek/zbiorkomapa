/**
 * processor.js — GTFS → per-route JSON assets for the frontend.
 *
 * Built on the `gtfs` (node-gtfs) npm library, replacing the previous bespoke
 * GTFS parser. Handles multiple cities from cities.json (Poznań — recordings
 * audio; Świnoujście / Gorzów Wielkopolski — TTS).
 *
 * Per city it:
 *   1. imports the local GTFS source (data/{slug}/) into a per-city sqlite
 *      cache (data/{slug}/gtfs-cache.sqlite, ignored by git),
 *   2. groups trips by direction_id and writes public/dist/{slug}/<route>.json,
 *   3. resolves audio_id via scripts/audio-matcher.js for recordings cities,
 *      falls back to OSRM (scripts/osrm-router.js) when a direction has no
 *      GTFS shape,
 *   4. writes public/dist/{slug}/routes.json + map_center.
 *
 * Usage:
 *   node scripts/processor.js                  # all cities
 *   node scripts/processor.js --city poznan    # one city
 *   node scripts/processor.js --force          # force re-import of GTFS (skip cache)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  importGtfs,
  openDb,
  closeDb,
  getRoutes,
  getTrips,
  getStoptimes,
  getShapes,
  getStops,
  getAgencies,
  getFeedInfo,
} from "gtfs";
import { routeSegments } from "./osrm-router.js";
import { createAudioMatcher } from "./audio-matcher.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

// GTFS route_type -> human-readable name (subset used by public transport).
// Unknown route_type falls back to "BUS" (matches the old processor).
const ROUTE_TYPES = {
  0: "TRAM",
  1: "METRO",
  2: "RAIL",
  3: "BUS",
  4: "TROLLEYBUS",
  5: "CABLE_CAR",
};

function getRouteTypeString(routeType) {
  return ROUTE_TYPES[Number(routeType)] || "BUS";
}

function slugify(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function loadCitiesConfig() {
  const configPath = path.join(projectRoot, "cities.json");
  if (!fs.existsSync(configPath)) {
    console.error("Brak pliku cities.json w katalogu głównym projektu.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { cityFilter: null, force: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--city" && args[i + 1]) {
      opts.cityFilter = args[i + 1];
      i++;
    } else if (args[i] === "--force") {
      opts.force = true;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Data building (node-gtfs queries)
// ---------------------------------------------------------------------------

// Stop-row cache for this city. Reset per city — stop_ids may collide across
// feeds, so it must not leak between cities in a multi-city run.
let stopCache = new Map();

/** Round a coordinate to 12 decimal places (matches the sample outputs). */
function roundCoord(value) {
  return Number(Number(value).toFixed(12));
}

/** Bounding box for a shape's coordinates. */
function computeBounds(coordinates) {
  const lats = coordinates.map((c) => c[0]);
  const lngs = coordinates.map((c) => c[1]);
  return {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
  };
}

/** Get (and cache) a stop row by stop_id. */
async function getStopRow(stopId) {
  if (stopCache.has(stopId)) return stopCache.get(stopId);
  const rows = await getStops({ stop_id: stopId });
  const row = rows[0] || null;
  stopCache.set(stopId, row);
  return row;
}

/**
 * Build the "stops" array for one direction from a representative trip.
 * stop_ids are de-duplicated preserving stop_sequence order. Adds audio_id
 * for recordings cities (null when unmatched) and skips it for TTS cities.
 */
async function buildStops(tripId, audioOptions) {
  const stoptimes = await getStoptimes(
    { trip_id: tripId },
    [],
    [["stop_sequence", "ASC"]],
  );

  // Ordered de-duplicated stop ids.
  const orderedStopIds = [];
  const seen = new Set();
  for (const st of stoptimes) {
    if (!seen.has(st.stop_id)) {
      seen.add(st.stop_id);
      orderedStopIds.push(st.stop_id);
    }
  }

  // stop_id -> on-demand when any stoptime flags pickup/drop_off type 3.
  const onDemand = new Set();
  for (const st of stoptimes) {
    if (String(st.pickup_type) === "3" || String(st.drop_off_type) === "3") {
      onDemand.add(st.stop_id);
    }
  }

  const stops = [];
  let sequence = 0;
  for (const stopId of orderedStopIds) {
    const row = await getStopRow(stopId);
    if (!row) continue;

    const stop = {
      stop_id: stopId,
      stop_name: sanitize(row.stop_name),
      stop_lat: roundCoord(row.stop_lat),
      stop_lon: roundCoord(row.stop_lon),
      stop_code: row.stop_code,
      stop_sequence: sequence,
      zone_id: row.zone_id,
      is_on_demand: onDemand.has(stopId),
    };

    if (audioOptions.enabled) {
      audioOptions.stats.total++;
      const match = audioOptions.matcher.find(stop.stop_name);
      stop.audio_id = match ? match.audio_id : null;
      if (match) {
        audioOptions.stats.matched++;
        audioOptions.stats.strategies[match.strategy] =
          (audioOptions.stats.strategies[match.strategy] || 0) + 1;
      } else {
        audioOptions.stats.unmatched++;
      }
    }

    stops.push(stop);
    sequence += 1;
  }
  return stops;
}

/** Fetch shape coordinates for a shape_id, ordered by shape_pt_sequence. */
async function buildShape(shapeId) {
  const points = await getShapes(
    { shape_id: shapeId },
    [],
    [["shape_pt_sequence", "ASC"]],
  );
  const coordinates = points.map((p) => [
    roundCoord(p.shape_pt_lat),
    roundCoord(p.shape_pt_lon),
  ]);
  return {
    coordinates,
    bounds: coordinates.length ? computeBounds(coordinates) : null,
  };
}

/** Strip GTFS-encoded quotes and trim whitespace. */
function sanitize(str) {
  return String(str ?? "").replace(/&quot;/g, '"').replace(/"/g, '').trim();
}

/**
 * Build a single direction entry: all trips sharing the same first→last stop
 * pattern use a representative trip (dominant shape) whose stop list defines
 * the route.
 *
 * dirOverrides: optional per-direction overrides (color, text_color) from
 * merged GTFS route entries (Gorzów pattern: same short_name, different
 * route_ids for each direction).
 */
async function buildDirection(routeId, dirTrips, audioOptions, dirOverrides = {}) {
  const shapeCounts = new Map();
  for (const t of dirTrips) {
    shapeCounts.set(t.shape_id, (shapeCounts.get(t.shape_id) || 0) + 1);
  }
  const shapeId = [...shapeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const repTrip = dirTrips.find((t) => t.shape_id === shapeId) || dirTrips[0];

  const stops = await buildStops(repTrip.trip_id, audioOptions);

  // Shape from GTFS, or via OSRM when the feed has no usable shape.
  let shape = await buildShape(shapeId);
  let effectiveShapeId = shapeId;
  if (shape.coordinates.length === 0 && stops.length >= 2) {
    console.log(
      `    OSRM: ${stops[0].stop_name} → ${stops[stops.length - 1].stop_name} (${stops.length} przystanków)...`,
    );
    try {
      const coords = await routeSegments(stops);
      shape = { coordinates: coords, bounds: coords.length ? computeBounds(coords) : null };
      effectiveShapeId = "osrm-generated";
      console.log(`    OSRM: ${coords.length} punktów kształtu`);
    } catch (err) {
      // Fallback: straight lines between stops so the route still renders.
      console.error(`    OSRM error: ${err.message}, używam prostych linii`);
      shape = { coordinates: stops.map((s) => [s.stop_lat, s.stop_lon]), bounds: computeBounds(stops.map((s) => [s.stop_lat, s.stop_lon])) };
      effectiveShapeId = "straight-line-fallback";
    }
  }

  const firstStop = stops[0];
  const lastStop = stops[stops.length - 1];
  const serviceIds = [...new Set(dirTrips.map((t) => t.service_id))].sort();

  // A loop route returns to its starting point: first and last stop share
  // the same name (stop_ids may differ — e.g. opposite sides of a terminus).
  // ponytail: name-based check, not stop_id, because GTFS often assigns
  // different ids to the inbound/outbound platform of the same station.
  const isLoop = stops.length >= 3 &&
    firstStop && lastStop &&
    firstStop.stop_name === lastStop.stop_name;

  const result = {
    first_stop: firstStop ? firstStop.stop_name : "",
    last_stop: lastStop ? lastStop.stop_name : "",
    is_loop: isLoop,
    shape_id: effectiveShapeId,
    shape,
    stops,
    stop_count: stops.length,
    service_ids: serviceIds,
    trip_count: dirTrips.length,
    shape_frequency: shapeCounts.get(shapeId),
  };

  // Per-direction color overrides (Gorzów: each GTFS route_id has its own
  // color, but we merge them into one line with multiple directions).
  if (dirOverrides.color) result.color = dirOverrides.color;
  if (dirOverrides.text_color) result.text_color = dirOverrides.text_color;

  return result;
}

/**
 * Group trips by direction.
 *
 * Strategy: use direction_id when it meaningfully splits the trips into 2+
 * groups (Poznań sets it correctly). When all trips share the same
 * direction_id (Świnoujście omits it, Gorzów sets it uniformly), fall back
 * to grouping by first→last stop pair.
 *
 * ponytail: two-tier strategy because no single GTFS field works across all
 * three feeds. direction_id is the canonical field but many feeds ignore it.
 * The fallback (first→last stop) is coarser — variant trips with different
 * short-turn terminals become separate directions — but that's acceptable
 * because those variants ARE different routes from the rider's perspective.
 */
async function groupTripsByDirection(trips) {
  // Check if direction_id meaningfully splits the trips.
  const byDirId = new Map();
  for (const t of trips) {
    const key = t.direction_id ?? "0";
    if (!byDirId.has(key)) byDirId.set(key, []);
    byDirId.get(key).push(t);
  }

  if (byDirId.size >= 2) {
    // direction_id splits trips into 2+ groups — use it (Poznań path).
    return byDirId;
  }

  // direction_id is uniform — fall back to first→last stop (Świnoujście path).
  const byStopPair = new Map();
  for (const trip of trips) {
    const stoptimes = await getStoptimes(
      { trip_id: trip.trip_id },
      [],
      [["stop_sequence", "ASC"]],
    );
    if (stoptimes.length === 0) continue;

    const firstStopId = stoptimes[0].stop_id;
    const lastStopId = stoptimes[stoptimes.length - 1].stop_id;
    const key = `${firstStopId}|${lastStopId}`;

    if (!byStopPair.has(key)) byStopPair.set(key, []);
    byStopPair.get(key).push(trip);
  }
  return byStopPair;
}

/**
 * Build the full JSON object for a single route.
 *
 * mergedDirections: when GTFS splits one logical line into multiple route_ids
 * (Gorzów pattern), the processor pre-merges them and passes the combined
 * trips + per-direction color overrides here. Each entry is
 * { trips, overrides: { color?, text_color? } }.
 */
async function buildRoute(route, agenciesByAgencyId, feedInfo, audioOptions, mergedDirections = null) {
  const agency = route.agency_id
    ? agenciesByAgencyId.get(route.agency_id)
    : undefined;

  const routeColor = route.route_color || "525252";
  const routeTextColor = route.route_text_color || "FFFFFF";

  let directions;

  if (mergedDirections) {
    // Pre-merged directions (Gorzów: multiple route_ids → one logical line).
    directions = [];
    for (const { trips, overrides } of mergedDirections) {
      // Each "direction" here is already grouped by first→last stop from the
      // merge step, so all trips in this bucket share one direction.
      directions.push(await buildDirection(route.route_id, trips, audioOptions, overrides));
    }
  } else {
    // Normal path: group this route's trips by first→last stop.
    const trips = await getTrips({ route_id: route.route_id });
    const byDirection = await groupTripsByDirection(trips);
    directions = [];
    for (const dirTrips of byDirection.values()) {
      directions.push(await buildDirection(route.route_id, dirTrips, audioOptions));
    }
  }

  return {
    route_id: route.route_id,
    short_name: sanitize(route.route_short_name),
    color: routeColor,
    text_color: routeTextColor,
    type: getRouteTypeString(route.route_type),
    agency_name: agency ? sanitize(agency.agency_name) : "",
    feed_info: feedInfo
      ? {
          feed_start_date: sanitize(feedInfo.feed_start_date),
          feed_end_date: sanitize(feedInfo.feed_end_date),
          feed_publisher_name: feedInfo.feed_publisher_name,
          feed_publisher_url: feedInfo.feed_publisher_url,
        }
      : null,
    directions,
  };
}

// ---------------------------------------------------------------------------
// Per-city processing
// ---------------------------------------------------------------------------

async function processCity(cityConfig, { force }) {
  const slug = slugify(cityConfig.name);
  const dataDir = path.join(projectRoot, "data", slug);
  const outputDir = path.join(projectRoot, "public", "dist", slug);
  const sqlitePath = path.join(dataDir, "gtfs-cache.sqlite");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Przetwarzam: ${cityConfig.name} (${slug})`);
  console.log(`${"=".repeat(60)}`);

  stopCache = new Map(); // per-city; stops may collide across feeds

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  } else {
    // Clean stale route JSONs from previous runs (e.g. after route merging
    // reduces the number of output files).
    for (const f of fs.readdirSync(outputDir)) {
      if (f.endsWith(".json") && f !== "routes.json") {
        fs.unlinkSync(path.join(outputDir, f));
      }
    }
  }

  if (!fs.existsSync(dataDir)) {
    console.error(`  Brak katalogu danych GTFS: ${dataDir}`);
    return;
  }

  // node-gtfs config, generated in-memory (no stray config file).
  const config = {
    agencies: [{ path: dataDir }],
    sqlitePath,
    verbose: false,
    ignoreErrors: true,
  };

  // Import GTFS to sqlite (skipped if already cached unless --force).
  if (force || !fs.existsSync(sqlitePath)) {
    console.log("  Importuję GTFS do SQLite...");
    await importGtfs(config);
  } else {
    console.log("  Używam cache GTFS (--force aby ponownie zaimportować).");
  }

  const db = openDb(config);

  const audioSource = cityConfig.audioSource || "tts";
  const isRecordings = audioSource === "recordings";
  const audioMatcher = isRecordings
    ? createAudioMatcher({ slug, dataDir, audioSource })
    : null;
  const audioStats = {
    total: 0,
    matched: 0,
    unmatched: 0,
    strategies: {
      exception: 0,
      locationSlash: 0,
      locationOnly: 0,
      cityPrefix: 0,
      poznanPrefix: 0,
      partialMatch: 0,
    },
  };
  const audioOptions = {
    enabled: isRecordings,
    matcher: audioMatcher,
    stats: audioStats,
  };

  try {
    const routes = await getRoutes({}, [], [["route_short_name", "ASC"]]);
    const agencies = await getAgencies();
    const feedInfoArr = await getFeedInfo();
    const feedInfo = feedInfoArr[0] || null;

    const agenciesByAgencyId = new Map();
    for (const a of agencies) agenciesByAgencyId.set(a.agency_id, a);

    // Detect duplicate short_names (Gorzów pattern: one logical line split
    // across multiple GTFS route_ids, each representing a direction/variant).
    // Group them so they merge into one output route with multiple directions.
    const byShortName = new Map();
    for (const route of routes) {
      const sn = route.route_short_name;
      if (!byShortName.has(sn)) byShortName.set(sn, []);
      byShortName.get(sn).push(route);
    }

    const routeData = [];
    for (const [shortName, routeGroup] of byShortName) {
      if (routeGroup.length === 1) {
        // Normal case: one GTFS route_id per short_name.
        const route = routeGroup[0];
        const result = await buildRoute(route, agenciesByAgencyId, feedInfo, audioOptions);
        const totalStops = result.directions.reduce((sum, d) => sum + d.stops.length, 0);
        fs.writeFileSync(
          path.join(outputDir, `${result.route_id}.json`),
          JSON.stringify(result, null, 2),
          "utf8",
        );
        routeData.push(result);
        console.log(
          `  Zapisano: ${result.route_id}.json (${result.directions.length} kierunki, ${totalStops} przystanków)`,
        );
      } else {
        // Gorzów pattern: multiple route_ids share the same short_name.
        // Merge them into one logical route with multiple directions.
        // Use the first route_id as the canonical one for the output file.
        const canonical = routeGroup[0];
        console.log(
          `  Łączę ${routeGroup.length} route_ids dla linii ${shortName}: ${routeGroup.map(r => r.route_id).join(', ')}`,
        );

        // For each sub-route, load its trips and group by first→last stop,
        // then attach per-direction color overrides from the sub-route.
        const mergedDirections = [];
        for (const subRoute of routeGroup) {
          const trips = await getTrips({ route_id: subRoute.route_id });
          const byDir = await groupTripsByDirection(trips);
          for (const dirTrips of byDir.values()) {
            mergedDirections.push({
              trips: dirTrips,
              overrides: {
                color: subRoute.route_color || undefined,
                text_color: subRoute.route_text_color || undefined,
              },
            });
          }
        }

        const result = await buildRoute(
          canonical, agenciesByAgencyId, feedInfo, audioOptions,
          mergedDirections,
        );
        const totalStops = result.directions.reduce((sum, d) => sum + d.stops.length, 0);
        fs.writeFileSync(
          path.join(outputDir, `${result.route_id}.json`),
          JSON.stringify(result, null, 2),
          "utf8",
        );
        routeData.push(result);
        console.log(
          `  Zapisano: ${result.route_id}.json (${result.directions.length} kierunki, ${totalStops} przystanków) [połączono ${routeGroup.length} route_ids]`,
        );
      }
    }

    if (isRecordings) {
      console.log("\nStatystyki dopasowania audio_id:");
      console.log(`  przystanki: ${audioStats.total}`);
      console.log(`  dopasowane: ${audioStats.matched}`);
      console.log(`  brak dopasowania: ${audioStats.unmatched}`);
      for (const [name, count] of Object.entries(audioStats.strategies)) {
        console.log(`  ${name}: ${count}`);
      }
    }

    // routes.json index + map_center (centroid of all stops).
    const routesList = routeData
      .map((r) => ({
        route_id: r.route_id,
        short_name: r.short_name,
        color: r.color,
        text_color: r.text_color,
        type: r.type,
        agency_name: r.agency_name,
        direction_count: r.directions.length,
        total_stops: r.directions.reduce((sum, d) => sum + d.stops.length, 0),
        feed_info: r.feed_info,
      }))
      .sort((a, b) =>
        String(a.short_name ?? a.route_id).localeCompare(
          String(b.short_name ?? b.route_id),
          undefined,
          { numeric: true },
        ),
      );

    const allStops = await getStops({});
    let mapCenter = null;
    if (allStops.length > 0) {
      let sumLat = 0;
      let sumLon = 0;
      for (const s of allStops) {
        sumLat += Number(s.stop_lat) || 0;
        sumLon += Number(s.stop_lon) || 0;
      }
      mapCenter = [sumLat / allStops.length, sumLon / allStops.length];
    }

    fs.writeFileSync(
      path.join(outputDir, "routes.json"),
      JSON.stringify({ routes: routesList, map_center: mapCenter }, null, 2),
      "utf8",
    );
    console.log(
      `\nGotowe! Zapisano ${routeData.length} linii w katalogu: ${outputDir}`,
    );
    if (mapCenter) {
      console.log(
        `Centrum mapy: [${mapCenter[0].toFixed(4)}, ${mapCenter[1].toFixed(4)}]`,
      );
    }
  } finally {
    closeDb(db);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    const { cityFilter, force } = parseArgs();
    const config = loadCitiesConfig();

    let cities = config.cities;
    if (cityFilter) {
      cities = cities.filter((c) => slugify(c.name) === cityFilter);
      if (cities.length === 0) {
        console.error(`Nie znaleziono miasta o slug: "${cityFilter}"`);
        console.error(
          "Dostępne:",
          config.cities.map((c) => slugify(c.name)).join(", "),
        );
        process.exit(1);
      }
    }

    for (const city of cities) {
      try {
        await processCity(city, { force });
      } catch (err) {
        console.error(`[${city.name}] Błąd przetwarzania:`, err.message);
        process.exitCode = 1;
      }
    }

    // Frontend-only cities.json in public/dist/.
    const distDir = path.join(projectRoot, "public", "dist");
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
    }
    const frontendCities = config.cities.map((c) => {
      const entry = {
        name: c.name,
        slug: slugify(c.name),
        audioSource: c.audioSource || "tts",
        ttsLang: c.ttsLang || "pl-PL",
      };
      if (c.audioBaseUrl) entry.audioBaseUrl = c.audioBaseUrl;
      return entry;
    });
    fs.writeFileSync(
      path.join(distDir, "cities.json"),
      JSON.stringify(frontendCities, null, 2),
      "utf8",
    );
    console.log(`\nZapisano konfigurację miast: ${distDir}/cities.json`);
  } catch (err) {
    console.error("Błąd:", err);
    process.exitCode = 1;
  }
}

main();

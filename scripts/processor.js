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
import { assemble } from "./route-assembler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

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
// Data building / adapter (node-gtfs queries) → plain-row bundle
// ---------------------------------------------------------------------------

// Stop-row cache for this city. Reset per city — stop_ids may collide across
// feeds, so it must not leak between cities in a multi-city run.
let stopCache = new Map();

/** Get (and cache) a stop row by stop_id. */
async function getStopRow(stopId) {
  if (stopCache.has(stopId)) return stopCache.get(stopId);
  const rows = await getStops({ stop_id: stopId });
  const row = rows[0] || null;
  stopCache.set(stopId, row);
  return row;
}

/**
 * Prefetch a city's plain-row bundle for the route assembler. This is the
 * single place that knows how to turn node-gtfs queries into the plain rows
 * `assemble` consumes — every assembly decision lives in route-assembler.js,
 * so the sqlite specifics stay here behind the seam.
 */
async function fetchCityBundle(routes, agencies, feedInfo) {
  const tripsByRouteId = {};
  const stoptimesByTripId = {};
  const shapesByShapeId = {};
  const stopsByStopId = {};

  for (const route of routes) {
    const trips = await getTrips({ route_id: route.route_id });
    tripsByRouteId[route.route_id] = trips;
    for (const trip of trips) {
      stoptimesByTripId[trip.trip_id] = await getStoptimes(
        { trip_id: trip.trip_id },
        [],
        [["stop_sequence", "ASC"]],
      );
      if (trip.shape_id && !shapesByShapeId[trip.shape_id]) {
        shapesByShapeId[trip.shape_id] = await getShapes(
          { shape_id: trip.shape_id },
          [],
          [["shape_pt_sequence", "ASC"]],
        );
      }
    }
  }

  // Resolve every referenced stop once (cached across the whole city).
  const needStops = new Set();
  for (const tripId of Object.keys(stoptimesByTripId)) {
    for (const st of stoptimesByTripId[tripId]) {
      needStops.add(st.stop_id);
    }
  }
  for (const stopId of needStops) {
    const row = await getStopRow(stopId);
    if (row) stopsByStopId[stopId] = [row];
  }

  return {
    routes,
    tripsByRouteId,
    stoptimesByTripId,
    shapesByShapeId,
    stopsByStopId,
    agencies,
    feedInfo,
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

    // Everything below the plain-row bundle is a pure assembly decision —
    // route grouping, direction splitting, merges, shapes, audio — and lives
    // in route-assembler.js. This file's only remaining job is to fetch the
    // rows (the adapter) and persist the outputs.
    const bundle = await fetchCityBundle(routes, agencies, feedInfo);
    const routeData = await assemble(bundle, {
      audio: audioOptions,
      routeSegments,
    });

    for (const result of routeData) {
      const totalStops = result.directions.reduce((sum, d) => sum + d.stops.length, 0);
      fs.writeFileSync(
        path.join(outputDir, `${result.route_id}.json`),
        JSON.stringify(result, null, 2),
        "utf8",
      );
      console.log(
        `  Zapisano: ${result.route_id}.json (${result.directions.length} kierunki, ${totalStops} przystanków)`,
      );
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
      if (c.audioVolume != null) entry.audioVolume = c.audioVolume;
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

/**
 * route-assembler.js — the Linia/Kierunek assembly module.
 *
 * Turns plain GTFS rows into the per-route JSON objects the frontend consumes.
 * Deep, side-effect-free decisions over a plain-data seam: it does NO
 * querying, NO network routing, NO file I/O. The adapter (node-gtfs in prod,
 * hand-built fixtures in tests) prefetches a `bundle` of plain rows; the
 * assembler makes every Linia/Kierunek decision and returns `routeData[]`.
 *
 * Injected dependencies (same seam convention as osrm-router / audio-matcher):
 *   - audio = { enabled, matcher, stats }
 *       matcher.find(stopName) -> { audio_id, strategy } | null
 *       stats is a mutable tally object the caller introspects for console output
 *   - routeSegments(stops) -> [lat,lng][]   (OSRM road routing; asynchronous)
 *
 * Everything here is deterministic over the bundle (plus stable injection
 * order), so regenerating dist output is byte-identical to the previous
 * hand-written processor logic.
 */

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

/** Strip GTFS-encoded quotes and trim whitespace. */
function sanitize(str) {
  return String(str ?? "").replace(/&quot;/g, '"').replace(/"/g, '').trim();
}

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

/**
 * Group the city's routes by short_name, preserving first-seen order.
 * A short_name shared by >1 route signals one logical line split across
 * route_ids (Gorzów) — those merge into a single output route below.
 */
function groupRoutesByShortName(routes) {
  const byShortName = new Map();
  for (const route of routes) {
    const sn = route.route_short_name;
    if (!byShortName.has(sn)) byShortName.set(sn, []);
    byShortName.get(sn).push(route);
  }
  return byShortName;
}

/**
 * Group trips by direction.
 *
 * Strategy: use direction_id when it meaningfully splits the trips into 2+
 * groups (Poznań sets it correctly). When all trips share the same
 * direction_id (Świnoujście omits it, Gorzów sets it uniformly), fall back
 * to grouping by first→last stop pair + fetch (Świnoujście path).
 *
 * ponytail: two-tier strategy because no single GTFS field works across all
 * three feeds. direction_id is the canonical field but many feeds ignore it.
 * The fallback (first→last stop) is coarser — variant trips with different
 * short-turn terminals become separate directions — but that's acceptable
 * because those variants ARE different routes from the rider's perspective.
 */
function groupTripsByDirection(trips, stoptimesByTripId) {
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

  // direction_id is uniform — fall back to first→last stop.
  const byStopPair = new Map();
  for (const trip of trips) {
    const stoptimes = stoptimesByTripId[trip.trip_id];
    if (!stoptimes || stoptimes.length === 0) continue;
    const firstStopId = stoptimes[0].stop_id;
    const lastStopId = stoptimes[stoptimes.length - 1].stop_id;
    const key = `${firstStopId}|${lastStopId}`;
    if (!byStopPair.has(key)) byStopPair.set(key, []);
    byStopPair.get(key).push(trip);
  }
  return byStopPair;
}

/**
 * Build the "stops" array for one direction from a representative trip.
 * stop_ids are de-duplicated preserving stop_sequence order. Adds audio_id
 * for recordings cities (null when unmatched) and skips it for TTS cities.
 */
function buildStops(repTrip, inventory, audio) {
  const stoptimes = inventory.stoptimesByTripId[repTrip.trip_id] || [];

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
    const row = inventory.stopsByStopId[stopId]?.[0];
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

    if (audio.enabled) {
      audio.stats.total++;
      const match = audio.matcher.find(stop.stop_name);
      stop.audio_id = match ? match.audio_id : null;
      if (match) {
        audio.stats.matched++;
        audio.stats.strategies[match.strategy] =
          (audio.stats.strategies[match.strategy] || 0) + 1;
      } else {
        audio.stats.unmatched++;
      }
    }

    stops.push(stop);
    sequence += 1;
  }
  return stops;
}

/**
 * Resolve a direction's shape coordinates: GTFS shape, else OSRM (via the
 * injected router), else straight lines between stops.
 */
async function resolveShape(shapeId, inventory, stops, routeSegments) {
  const points = inventory.shapesByShapeId[shapeId] || [];
  const coords = points.map((p) => [
    roundCoord(p.shape_pt_lat),
    roundCoord(p.shape_pt_lon),
  ]);
  let shape = { coordinates: coords, bounds: coords.length ? computeBounds(coords) : null };
  let effectiveShapeId = shapeId;

  // No usable GTFS shape — route via OSRM when there are real stops.
  if (shape.coordinates.length === 0 && stops.length >= 2) {
    console.log(
      `    OSRM: ${stops[0].stop_name} → ${stops[stops.length - 1].stop_name} (${stops.length} przystanków)...`,
    );
    try {
      const resCoords = await routeSegments(stops);
      shape = { coordinates: resCoords, bounds: resCoords.length ? computeBounds(resCoords) : null };
      effectiveShapeId = "osrm-generated";
      console.log(`    OSRM: ${resCoords.length} punktów kształtu`);
    } catch (err) {
      // Fallback: straight lines between stops so the route still renders.
      console.error(`    OSRM error: ${err.message}, używam prostych linii`);
      const fallbackCoords = stops.map((s) => [s.stop_lat, s.stop_lon]);
      shape = { coordinates: fallbackCoords, bounds: computeBounds(fallbackCoords) };
      effectiveShapeId = "straight-line-fallback";
    }
  }

  return { shape, effectiveShapeId };
}

/**
 * Build a single direction entry: all trips sharing the same first→last stop
 * pattern use a representative trip (dominant shape) whose stop list defines
 * the route.
 *
 * dirOverrides: optional per-direction overrides (color, text_color) from
 * merged GTFS route entries (Gorzów pattern).
 */
async function buildDirection(routeId, dirTrips, inventory, audio, routeSegments, dirOverrides = {}) {
  const shapeCounts = new Map();
  for (const t of dirTrips) {
    shapeCounts.set(t.shape_id, (shapeCounts.get(t.shape_id) || 0) + 1);
  }
  const shapeId = [...shapeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const repTrip = dirTrips.find((t) => t.shape_id === shapeId) || dirTrips[0];

  const stops = buildStops(repTrip, inventory, audio);
  const { shape, effectiveShapeId } = await resolveShape(shapeId, inventory, stops, routeSegments);

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
 * Build the full per-route JSON object.
 *
 * mergedDirections: when GTFS splits one logical line into multiple route_ids
 * (Gorzów pattern), the assembler pre-merges them and passes the combined
 * trips + per-direction color overrides here. Each entry is
 * { trips, overrides: { color?, text_color? } }.
 */
async function buildRoute(route, inventory, agenciesByAgencyId, audio, routeSegments, mergedDirections = null) {
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
      directions.push(await buildDirection(route.route_id, trips, inventory, audio, routeSegments, overrides));
    }
  } else {
    // Normal path: group this route's trips by direction.
    const trips = inventory.tripsByRouteId[route.route_id] || [];
    const byDirection = groupTripsByDirection(trips, inventory.stoptimesByTripId);
    directions = [];
    for (const dirTrips of byDirection.values()) {
      directions.push(await buildDirection(route.route_id, dirTrips, inventory, audio, routeSegments));
    }
  }

  const feedInfo = inventory.feedInfo;

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

/**
 * Assemble a whole city's per-route JSON objects from a plain-row bundle.
 *
 * @param {object} bundle - prefetched plain rows:
 *   routes: Route[] (already in the feed's route order),
 *   tripsByRouteId: { [route_id]: Trip[] },
 *   stoptimesByTripId: { [trip_id]: Stoptime[] } (ordered by stop_sequence),
 *   shapesByShapeId: { [shape_id]: ShapePoint[] } (ordered by shape_pt_sequence),
 *   stopsByStopId: { [stop_id]: Stop[] },
 *   agencies: Agency[], feedInfo: FeedInfo|null
 * @param {object} inject
 *   audio: { enabled, matcher, stats }
 *   routeSegments: (stops) => Promise<number[][]>
 * @returns {Promise<object[]>} routeData[] (per-route JSON objects)
 */
export async function assemble(bundle, inject) {
  const { audio, routeSegments } = inject;
  const agenciesByAgencyId = new Map();
  for (const a of bundle.agencies) agenciesByAgencyId.set(a.agency_id, a);

  const byShortName = groupRoutesByShortName(bundle.routes);
  const routeData = [];

  for (const [, routeGroup] of byShortName) {
    if (routeGroup.length === 1) {
      // Normal case: one GTFS route_id per short_name.
      const route = routeGroup[0];
      routeData.push(await buildRoute(route, bundle, agenciesByAgencyId, audio, routeSegments));
    } else {
      // Gorzów pattern: multiple route_ids share the same short_name.
      // Merge them into one logical route with multiple directions.
      const canonical = routeGroup[0];
      console.log(
        `  Łączę ${routeGroup.length} route_ids dla linii ${routeGroup[0].route_short_name}: ${routeGroup.map(r => r.route_id).join(', ')}`,
      );

      const mergedDirections = [];
      for (const subRoute of routeGroup) {
        const trips = bundle.tripsByRouteId[subRoute.route_id] || [];
        const byDir = groupTripsByDirection(trips, bundle.stoptimesByTripId);
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

      routeData.push(await buildRoute(canonical, bundle, agenciesByAgencyId, audio, routeSegments, mergedDirections));
    }
  }

  return routeData;
}

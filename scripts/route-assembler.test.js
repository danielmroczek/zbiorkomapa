import { describe, it, expect } from 'vitest';
import { assemble } from './route-assembler.js';

// --- Plain-row fixture helpers (the bundle shape node-gtfs adapter provides) ---

function stop(id, name, extra = {}) {
  return { stop_id: id, stop_name: name, stop_lat: 52.0, stop_lon: 16.9, stop_code: null, zone_id: 'A', ...extra };
}

function stoptime(tripId, stopId, seq, extra = {}) {
  return { trip_id: tripId, stop_id: stopId, stop_sequence: seq, pickup_type: '0', drop_off_type: '0', ...extra };
}

function trip(id, routeId, extra = {}) {
  return { trip_id: id, route_id: routeId, ...extra };
}

function shapePoint(shapeId, seq, lat, lon) {
  return { shape_id: shapeId, shape_pt_sequence: seq, shape_pt_lat: lat, shape_pt_lon: lon };
}

function noopAudio() {
  return { enabled: false, matcher: null, stats: { total: 0, matched: 0, unmatched: 0, strategies: {} } };
}

// A straight-line, no-op router: returns the stops' own coords (LatLng order).
const straightLinesRouter = async (stops) =>
  stops.map((s) => [s.stop_lat, s.stop_lon]);

// Default single-route bundle. Tests override just the parts they care about:
//   makeBundle({ tripsByRouteId: {...}, stoptimesByTripId: {...} })
// The default shape 'sh' spans 2 shape points; default stops a/b/c are defined.
function makeBundle(overrides = {}) {
  return {
    routes: [{ route_id: '1', route_short_name: '1', route_color: '111111', route_text_color: 'FFFFFF', route_type: 3, agency_id: 'AG' }],
    agencies: [{ agency_id: 'AG', agency_name: 'Agencja' }],
    feedInfo: null,
    tripsByRouteId: {
      '1': [trip('t1', '1', { direction_id: '0', service_id: 'S', shape_id: 'sh' })],
    },
    stoptimesByTripId: {
      t1: [stoptime('t1', 'a', 1), stoptime('t1', 'b', 2)],
    },
    shapesByShapeId: { sh: [shapePoint('sh', 1, 52.0, 16.9), shapePoint('sh', 2, 52.1, 17.0)] },
    stopsByStopId: { a: [stop('a', 'Początek')], b: [stop('b', 'Koniec')] },
    ...overrides,
  };
}

const assembleDefault = (bundle, inject = {}) =>
  assemble(bundle, { audio: noopAudio(), routeSegments: straightLinesRouter, ...inject });

// ---------------------------------------------------------------------------
// Direction grouping
// ---------------------------------------------------------------------------

describe('assemble — direction grouping', () => {
  it('splits by direction_id when it produces 2+ groups', async () => {
    const bundle = makeBundle({
      tripsByRouteId: {
        '1': [
          trip('t1', '1', { direction_id: '0', service_id: 'S', shape_id: 'sh' }),
          trip('t2', '1', { direction_id: '1', service_id: 'S', shape_id: 'sh' }),
        ],
      },
      stoptimesByTripId: {
        t1: [stoptime('t1', 'a', 1), stoptime('t1', 'b', 2)],
        t2: [stoptime('t2', 'b', 1), stoptime('t2', 'a', 2)],
      },
    });

    const [route] = await assembleDefault(bundle);
    expect(route.directions.length).toBe(2);
    // direction_id 0 first (first-encountered), then direction_id 1
    expect(route.directions[0].first_stop).toBe('Początek');
    expect(route.directions[1].first_stop).toBe('Koniec');
  });

  it('falls back to first→last stop pair when direction_id is uniform', async () => {
    const bundle = makeBundle({
      tripsByRouteId: {
        '1': [
          trip('t1', '1', { direction_id: '0', service_id: 'S', shape_id: 'sh' }),
          trip('t2', '1', { direction_id: '0', service_id: 'S', shape_id: 'sh' }),
        ],
      },
      stoptimesByTripId: {
        t1: [stoptime('t1', 'a', 1), stoptime('t1', 'b', 2)],
        t2: [stoptime('t2', 'b', 1), stoptime('t2', 'a', 2)],
      },
    });

    const [route] = await assembleDefault(bundle);
    expect(route.directions.length).toBe(2); // two distinct stop pairs
  });
});

// ---------------------------------------------------------------------------
// Representative trip (dominant shape)
// ---------------------------------------------------------------------------

describe('assemble — representative trip', () => {
  it('picks the dominant shape and uses its trip for the stop list', async () => {
    const bundle = makeBundle({
      tripsByRouteId: {
        // 2 trips on shape 'sh1' (dominant), 1 on 'sh2' — stop list comes from sh1's trip.
        '1': [
          trip('t1', '1', { direction_id: '0', service_id: 'S', shape_id: 'sh1' }),
          trip('t2', '1', { direction_id: '0', service_id: 'S', shape_id: 'sh1' }),
          trip('t3', '1', { direction_id: '0', service_id: 'S', shape_id: 'sh2' }),
        ],
      },
      stoptimesByTripId: {
        t1: [stoptime('t1', 'a', 1), stoptime('t1', 'b', 2), stoptime('t1', 'c', 3)],
        t2: [stoptime('t2', 'a', 1), stoptime('t2', 'b', 2), stoptime('t2', 'c', 3)],
        t3: [stoptime('t3', 'a', 1), stoptime('t3', 'b', 2), stoptime('t3', 'c', 3)],
      },
      shapesByShapeId: {
        sh1: [shapePoint('sh1', 1, 52.0, 16.9), shapePoint('sh1', 2, 52.05, 16.95)],
        sh2: [shapePoint('sh2', 1, 52.0, 16.9), shapePoint('sh2', 2, 52.06, 16.96)],
      },
      stopsByStopId: { a: [stop('a', 'Początek')], b: [stop('b', 'Środek')], c: [stop('c', 'Koniec')] },
    });

    const [route] = await assembleDefault(bundle);
    const dir = route.directions[0];
    expect(dir.shape_id).toBe('sh1'); // dominant
    expect(dir.shape_frequency).toBe(2);
    expect(dir.trip_count).toBe(3);
    expect(dir.stop_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Loop detection + on-demand
// ---------------------------------------------------------------------------

describe('assemble — loop + on-demand', () => {
  it('flags is_loop when first/last stop name matches, and marks on-demand', async () => {
    const bundle = makeBundle({
      routes: [{ route_id: 'L', route_short_name: 'L', route_color: '111111', route_text_color: 'FFFFFF', route_type: 0, agency_id: 'AG' }],
      tripsByRouteId: { L: [trip('t1', 'L', { direction_id: '0', service_id: 'S', shape_id: 'sh' })] },
      stoptimesByTripId: {
        t1: [
          stoptime('t1', 'a', 1),
          stoptime('t1', 'b', 2, { pickup_type: '3' }), // on-demand
          stoptime('t1', 'c', 3),
          stoptime('t1', 'a2', 4), // same name as start → loop
        ],
      },
      // a2 is a different stop_id but the SAME stop_name → loop route.
      stopsByStopId: {
        a: [stop('a', 'Dworzec')],
        b: [stop('b', 'Przystanek na żądanie')],
        c: [stop('c', 'Środek')],
        a2: [stop('a2', 'Dworzec')],
      },
    });

    const [route] = await assembleDefault(bundle);
    const dir = route.directions[0];
    expect(dir.is_loop).toBe(true);
    expect(dir.stops[1].is_on_demand).toBe(true);
    expect(dir.stops[0].is_on_demand).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Audio enrichment + stats
// ---------------------------------------------------------------------------

describe('assemble — audio enrichment', () => {
  it('adds audio_id when enabled and tallies stats', async () => {
    const matcher = { find: (name) => (name === 'Początek' ? { audio_id: 'P01', strategy: 'locationOnly' } : null) };
    const audio = {
      enabled: true,
      matcher,
      stats: { total: 0, matched: 0, unmatched: 0, strategies: { locationOnly: 0 } },
    };

    await assembleDefault(makeBundle(), { audio });
    expect(audio.stats.total).toBe(2);
    expect(audio.stats.matched).toBe(1);
    expect(audio.stats.unmatched).toBe(1);
    expect(audio.stats.strategies.locationOnly).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Gorzów merge: multiple route_ids sharing a short_name
// ---------------------------------------------------------------------------

describe('assemble — merge by short_name (Gorzów)', () => {
  it('merges duplicate short_names into one route with per-direction color overrides', async () => {
    const bundle = makeBundle({
      routes: [
        { route_id: 'A', route_short_name: '9', route_color: 'FF0000', route_text_color: 'FFFFFF', route_type: 3, agency_id: 'AG' },
        { route_id: 'B', route_short_name: '9', route_color: '00FF00', route_text_color: '000000', route_type: 3, agency_id: 'AG' },
      ],
      tripsByRouteId: {
        A: [trip('t1', 'A', { direction_id: '0', service_id: 'S', shape_id: 'sh' })],
        B: [trip('t2', 'B', { direction_id: '0', service_id: 'S', shape_id: 'sh' })],
      },
      stoptimesByTripId: {
        t1: [stoptime('t1', 'a', 1), stoptime('t1', 'b', 2)],
        t2: [stoptime('t2', 'c', 1), stoptime('t2', 'd', 2)],
      },
      stopsByStopId: {
        a: [stop('a', 'A1')], b: [stop('b', 'A2')],
        c: [stop('c', 'B1')], d: [stop('d', 'B2')],
      },
    });

    const [route] = await assembleDefault(bundle);
    expect(route.route_id).toBe('A'); // canonical = first route_id
    expect(route.directions.length).toBe(2);
    // Per-direction color overrides survive.
    expect(route.directions[0].color).toBe('FF0000');
    expect(route.directions[1].color).toBe('00FF00');
  });
});

// ---------------------------------------------------------------------------
// Shape resolution fallback
// ---------------------------------------------------------------------------

describe('assemble — shape resolution', () => {
  it('uses the GTFS shape when present', async () => {
    const [route] = await assembleDefault(makeBundle());
    expect(route.directions[0].shape_id).toBe('sh');
  });

  it('calls the injected router when no GTFS shape, marking osrm-generated', async () => {
    const router = async () => [[52.0, 16.9], [52.2, 17.2], [53.0, 18.0]];
    const bundle = makeBundle({
      tripsByRouteId: { '1': [trip('t1', '1', { direction_id: '0', service_id: 'S', shape_id: 'missing' })] },
      shapesByShapeId: {}, // no shape for 'missing'
    });
    const [route] = await assembleDefault(bundle, { routeSegments: router });
    expect(route.directions[0].shape_id).toBe('osrm-generated');
    expect(route.directions[0].shape.coordinates).toEqual([[52.0, 16.9], [52.2, 17.2], [53.0, 18.0]]);
  });

  it('falls back to straight lines when the injected router throws', async () => {
    const failingRouter = async () => { throw new Error('down'); };
    const bundle = makeBundle({
      tripsByRouteId: { '1': [trip('t1', '1', { direction_id: '0', service_id: 'S', shape_id: 'missing' })] },
      shapesByShapeId: {},
    });
    const [route] = await assembleDefault(bundle, { routeSegments: failingRouter });
    expect(route.directions[0].shape_id).toBe('straight-line-fallback');
    // Straight-line fallback = stop coordinates.
    expect(route.directions[0].shape.coordinates).toEqual([[52.0, 16.9], [52.0, 16.9]]);
  });
});

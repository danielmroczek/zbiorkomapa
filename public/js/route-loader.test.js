// One-slot route loader discipline: never more than one fetch in flight; a
// target arriving mid-load waits in the slot and starts after the current
// load finishes. The fetch itself is injectable so Vitest can drive it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCityRouteMixin } from './city-route.js';

// Deferred-fetch harness: we control when each fetch resolves and how it
// sequences, and count which routes were actually requested.
function makeApp() {
  const mixin = createCityRouteMixin();
  const inflight = [];
  const fetched = [];

  const obj = {
    ...mixin,
    routes: [
      { route_id: 'A', short_name: 'A', color: 'ff0000', text_color: 'ffffff', type: 'BUS', direction_count: 1 },
      { route_id: 'B', short_name: 'B', color: '00ff00', text_color: '000000', type: 'BUS', direction_count: 1 },
      { route_id: 'C', short_name: 'C', color: '0000ff', text_color: 'ffffff', type: 'BUS', direction_count: 1 },
      { route_id: 'D', short_name: 'D', color: 'ffff00', text_color: '000000', type: 'BUS', direction_count: 1 },
    ],
    currentCitySlug: 'test',
    currentCityName: 'Test',
    selectedRouteId: 'A',
    currentRoute: null,
    routeDataByRouteId: { A: {}, B: {}, C: {}, D: {} },

    // the harness's fetch replacement on the mixin's injectable seam
    fetchRoute(routeId) {
      fetched.push(routeId);
      return new Promise(resolve => inflight.push({ routeId, resolve: () => resolve({}) }));
    },

    __inflight: inflight,
    __fetched: fetched,
  };
  return obj;
}

const settle = () => new Promise(r => setTimeout(r, 0));

describe('one-slot route loading', () => {
  beforeEach(() => vi.restoreAllMocks?.());

  it('never starts a second fetch while one is in flight; queued target loads after', async () => {
    const app = makeApp();
    // Start loading B (mirror of onRouteChange's entry), then queue C and D mid-flight.
    const p1 = app._loadRouteData('B');
    await settle();
    const p2 = app._loadRouteData('C');
    const p3 = app._loadRouteData('D');
    await settle();

    expect(app.__fetched).toEqual(['B']); // C and D never hit the network
    expect(app.__inflight.length).toBe(1);

    app.__inflight[0].resolve(); // B finishes
    await Promise.all([p1, p2, p3]);
    await settle();
    await settle(); // cascade queued load (fire-and-forget) starts

    expect(app.__fetched).toEqual(['B', 'D']); // only the LAST queued target starts
    expect(app.selectedRouteId).toBe('D');
    // resolve the D fetch so the app settles cleanly
    const dCall = app.__inflight[app.__inflight.length - 1];
    dCall.resolve();
    await settle();
  });

  it('stale result never overwrites a newer one', async () => {
    const app = makeApp();
    // Capture the loader with two overlapped loads on the SAME slot discipline:
    const p1 = app._loadRouteData('B');
    await settle();
    const p2 = app._loadRouteData('D');
    await settle();
    expect(app.__fetched).toEqual(['B']);
    app.__inflight[0].resolve();
    await Promise.all([p1, p2]);
    await settle();
    await settle(); // queued D cascade starts
    const dCall = app.__inflight[app.__inflight.length - 1];
    dCall.resolve();
    await settle();
    // after B finished, the queued D ran; there must be no second in-flight
    expect(app.selectedRouteId).toBe('D');
    expect(app.routeInFlight).toBe(false);
  });

  it('error keeps the map/panel state and restores badge fields from route meta', async () => {
    const app = makeApp();
    app.currentRoute = { short_name: 'A', type: 'BUS' };
    app.routes[0].short_name = 'A';
    app.shortName = 'A';
    // loading route 'ENOENT' fails
    app.fetchRoute = () => Promise.reject(new Error('nope'));

    await app._loadRouteData('ENOENT');
    await settle();

    // currentRoute untouched, badge flipped back to the still-selected route
    expect(app.currentRoute.short_name).toBe('A');
    expect(app.shortName).toBe('A');
    expect(app.routeInFlight).toBe(false);
  });
});

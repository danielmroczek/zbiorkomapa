import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCityRouteMixin } from './city-route.js';

// Minimal harness: just the nav pointer logic, no fetch/map.
function makeNav() {
  const mixin = createCityRouteMixin();
  const obj = {
    ...mixin,
    routes: [
      { route_id: 'A', direction_count: 2 },
      { route_id: 'B', direction_count: 1 },
    ],
    selectedRouteId: 'A',
    selectedDirectionIdx: 0,
    routeChangeCount: 0,
    directionChangeCount: 0,
    // Mimic the real flow: async load, then caller sets the direction.
    async onRouteChange() {
      this.routeChangeCount++;
      return Promise.resolve();
    },
    onDirectionChange() {
      this.directionChangeCount++;
    },
  };
  return obj;
}

describe('advanceNav / flushNav', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const drain = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  it('holding key = pointer moves only; keyup loads the final position once', async () => {
    const app = makeNav();
    app.advanceNav(1); // A dir 1
    app.advanceNav(1); // wrap -> B dir 0
    app.advanceNav(1); // wrap -> A dir 0 (B has a single direction)
    app.advanceNav(1); // A dir 1

    expect(app.pendingNav).toEqual({ routeIndex: 0, dirIndex: 1 });
    expect(app.routeChangeCount).toBe(0);
    expect(app.directionChangeCount).toBe(0);
    app.flushNav(); // keyup
    await Promise.resolve(); // let flushNav's promise chain settle
    expect(app.routeChangeCount).toBe(0);
    expect(app.directionChangeCount).toBe(1);
    expect(app.selectedRouteId).toBe('A');
    expect(app.selectedDirectionIdx).toBe(1);
  });

  it('single step within the same route only changes direction', async () => {
    const app = makeNav();
    app.advanceNav(1);
    app.flushNav(); // keyup
    await Promise.resolve();
    expect(app.routeChangeCount).toBe(0);
    expect(app.directionChangeCount).toBe(1);
    expect(app.selectedDirectionIdx).toBe(1);
  });

  it('keyup flush wins over the pending debounce timer', async () => {
    const app = makeNav();
    app.advanceNav(1); // A dir 1
    app.advanceNav(1); // wrap -> B dir 0
    app.flushNav(); // keyup -> immediate load of pending nav
    await drain();
    expect(app.routeChangeCount).toBe(1);
    expect(app.directionChangeCount).toBe(1);
    expect(app.selectedRouteId).toBe('B');

    // The stale debounce timer must do nothing afterwards.
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    expect(app.routeChangeCount).toBe(1);
  });

  it('advances backwards across routes into the last direction', async () => {
    const app = makeNav();
    app.advanceNav(-1); // A dir -1 -> wrap to B (last dir = 0)
    app.flushNav(); // keyup
    await drain();
    expect(app.selectedRouteId).toBe('B');
    expect(app.selectedDirectionIdx).toBe(0);
  });
});

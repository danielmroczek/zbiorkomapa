import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCityRouteMixin, formatRouteLabel } from './city-route.js';

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

describe('formatRouteLabel', () => {
  it('shows every endpoint when they fit the budget', () => {
    const { label, fullLabel } = formatRouteLabel({
      short_name: '911', type: 'BUS', endpoints: ['Biedrusko/Park', 'Rondo Śródka'],
    });
    expect(label).toBe('🚌 911 · Biedrusko/Park · Rondo Śródka');
    expect(fullLabel).toBe('🚌 911 · Biedrusko/Park · Rondo Śródka');
  });

  it('caps at three endpoints and summarises the rest as +N', () => {
    const endpoints = ['AWF', 'Katedra', 'TPV', 'Słowiańska', 'Londyńska', 'Dworcowa'];
    const { label, fullLabel } = formatRouteLabel({ short_name: '113', type: 'BUS', endpoints });
    expect(label).toBe('🚌 113 · AWF · Katedra · TPV +3');
    expect(fullLabel).toBe(`🚌 113 · ${endpoints.join(' · ')}`); // full list survives in the tooltip
  });

  it('drops whole endpoints instead of cutting names when over budget', () => {
    const endpoints = ['Os. Sobieskiego', 'Suchy Las/Teren Aktywnej Edukacji i Sportu II'];
    const { label } = formatRouteLabel({ short_name: '902', type: 'BUS', endpoints });
    // 15 + 2 + 45 = 62 > 60, so the second name is dropped whole, never cut.
    expect(label).toBe('🚌 902 · Os. Sobieskiego +1');
    expect(label).not.toContain('…');
  });

  it('still reports the hidden endpoints when none fit', () => {
    const endpoints = ['Suchy Las/Teren Aktywnej Edukacji i Sportu (Osiedle Leśne Północ)'];
    const { label, fullLabel } = formatRouteLabel({ short_name: '902', type: 'TRAM', endpoints });
    expect(label).toBe('🚋 902 · +1');
    expect(fullLabel).toBe(`🚋 902 · ${endpoints[0]}`);
  });

  it('falls back to just the line when endpoints are missing', () => {
    expect(formatRouteLabel({ short_name: '5', type: 'TRAM' }))
      .toEqual({ label: '🚋 5', fullLabel: '🚋 5' });
    expect(formatRouteLabel({ short_name: '5', type: 'TRAM', endpoints: [] }))
      .toEqual({ label: '🚋 5', fullLabel: '🚋 5' });
  });
});

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

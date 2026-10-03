// City & route mixin — load, select, hash routing, direction change

import * as turf from '@turf/turf';
import { routeLengthKm } from './ride-math.js';

// Shared badge look (used by full load AND arrow-key preview, so they can't drift).
function badgeLook(routeMeta, hexToRgb) {
  let bgColor = `#${routeMeta.color}`;
  let textColor = `#${routeMeta.text_color}`;

  const isSpecialGray = bgColor.toUpperCase() === '#525252' && textColor.toUpperCase() === '#FFFFFF';
  if (isSpecialGray) {
    bgColor = '#FFFFFF';
    textColor = '#000000';
  }

  let badgeClass = routeMeta.type === 'TRAM' ? 'route-badge' : 'route-badge bus';
  const badgeStyle = {
    'background-color': bgColor,
    'color': textColor
  };

  const rgb = typeof hexToRgb === 'function' ? hexToRgb(bgColor) : null;
  if (rgb && rgb.r > 240 && rgb.g > 240 && rgb.b > 240) {
    badgeClass += ' light-bg';
    badgeStyle['border-color'] = textColor;
  }

  return { badgeClass, badgeStyle };
}

// Panel title line, shared by full load and the arrow-key preview.
function panelTitleFor(routeMeta, cityName) {
  const typeName = routeMeta.type === 'TRAM' ? 'Tramwaj' : 'Autobus';
  const emoji = routeMeta.type === 'TRAM' ? '🚋' : '🚌';
  return { emoji, title: `${emoji} ${typeName} nr ${routeMeta.short_name} — ${cityName}` };
}

export function createCityRouteMixin() {
  return {
    // City data
    cities: [],
    currentCitySlug: '',
    currentCityName: '',
    currentCityConfig: null,
    showCityModal: false,
    showHelpModal: false,

    // Route data
    routes: [],
    selectedRouteId: '',
    currentRoute: null,
    directions: [],
    selectedDirectionIdx: 0,
    currentDirection: null,
    routeInFlight: false,
    routeLoadNext: null,

    async loadCitiesConfig() {
      try {
        const response = await fetch('./dist/cities.json');
        this.cities = await response.json();
      } catch (error) {
        console.error('Błąd ładowania konfiguracji miast:', error);
        this.cities = [];
      }
    },

    initHashRouting() {
      const hashCity = window.location.hash.slice(1);
      if (hashCity && this.cities.some(c => c.slug === hashCity)) {
        this.currentCitySlug = hashCity;
      } else {
        const saved = localStorage.getItem('currentCity');
        if (saved && this.cities.some(c => c.slug === saved)) {
          this.currentCitySlug = saved;
        } else if (this.cities.length > 0) {
          this.showCityModal = true;
          return;
        }
      }

      if (this.currentCitySlug) {
        window.location.hash = this.currentCitySlug;
      }

      window.addEventListener('hashchange', () => {
        const newHash = window.location.hash.slice(1);
        if (newHash && newHash !== this.currentCitySlug && this.cities.some(c => c.slug === newHash)) {
          this.currentCitySlug = newHash;
          this.loadCityData();
        }
      });
    },

    async selectCity(slug) {
      if (this.isRiding) this.stopRide();
      this.currentCitySlug = slug;
      this.showCityModal = false;
      window.location.hash = slug;
      localStorage.setItem('currentCity', slug);
      this.selectedRouteId = '';
      this.currentRoute = null;
      this.directions = [];
      this.currentDirection = null;
      this.selectedDirectionIdx = 0;
      this.cleanUpMap();
      await this.loadCityData();
    },

    async loadCityData() {
      if (!this.currentCitySlug) return;

      const cityConfig = this.cities.find(c => c.slug === this.currentCitySlug);
      if (!cityConfig) return;

      this.currentCityConfig = cityConfig;
      this.currentCityName = cityConfig.name;

      await this.loadRoutesIndex();
      await this.restoreLastRoute();
    },

    async loadRoutesIndex() {
      try {
        const response = await fetch(`./dist/${this.currentCitySlug}/routes.json`);
        const data = await response.json();
        const routeList = Array.isArray(data) ? data : (data.routes || []);
        this.routes = routeList.map(r => ({
          ...r,
          displayName: `${r.short_name} (${r.type === 'TRAM' ? 'Tramwaj' : 'Autobus'})`,
        }));
        if (!Array.isArray(data) && data.map_center) {
          this.map.setView(data.map_center, 13);
        }
      } catch (error) {
        console.error('Błąd ładowania indeksu linii:', error);
        this.routes = [];
      }
    },

    async restoreLastRoute() {
      const lastRoute = localStorage.getItem(`lastRoute_${this.currentCitySlug}`);
      if (lastRoute && this.routes.some(r => r.route_id === lastRoute)) {
        this.selectedRouteId = lastRoute;
        await this.onRouteChange();
        return;
      }

      if (this.routes.length > 0) {
        const randomRoute = this.routes[Math.floor(Math.random() * this.routes.length)];
        this.selectedRouteId = randomRoute.route_id;
        await this.onRouteChange();
      }
    },

    // After choosing from a combobox, drop focus so Space (the ride toggle)
    // never re-opens the dropdown instead of starting/pausing the ride.
    blurSelect() {
      // Zone guard: no DOM in Node tests.
      if (typeof document === 'undefined') return;
      const el = document.activeElement;
      if (el && (el.tagName === 'SELECT' || el.tagName === 'INPUT')) el.blur();
    },

    async onRouteChange() {
      if (this.isRiding) this.stopRide();
      this.blurSelect();

      if (!this.selectedRouteId) {
        this.currentRoute = null;
        this.directions = [];
        this.currentDirection = null;
        this.selectedDirectionIdx = 0;
        return;
      }

      const routeMeta = this.routes.find(r => r.route_id === this.selectedRouteId);
      if (!routeMeta) return;

      const loaded = await this._loadRouteData(this.selectedRouteId);
      if (!loaded) return;
      await this.onDirectionChange();
    },

    // ponytail: one-slot loader instead of per-request aborts — a target
    // arriving mid-load waits in routeLoadNext (newer overwrites older) and
    // starts when the current fetch finishes, so fast scrubbing produces few
    // sequential fetches and never parallel ones. Files are small static
    // JSON; if a route file ever becomes expensive to serve, upgrade path is
    // AbortController here.
    // Injectable seam: fetchRoute can be replaced in tests.
    // Badge + panel header driven by a route's meta (live flip + rollback).
    _setBadgeLook(routeMeta) {
      const look = badgeLook(routeMeta, this.hexToRgb);
      const { emoji, title } = panelTitleFor(routeMeta, this.currentCityName);
      this.shortName = routeMeta.short_name;
      this.routeTypeEmoji = emoji;
      this.badgeClass = look.badgeClass;
      this.badgeStyle = look.badgeStyle;
      this.panelTitle = title;
    },

    async _loadRouteData(routeId) {
      if (this.routeInFlight) {
        this.routeLoadNext = routeId;
        return false;
      }
      this.routeInFlight = true;

      const routeMeta = this.routes.find(r => r.route_id === routeId);
      // Live badge flip: show the requested line immediately (same look as a
      // full load), matching the arrow-key preview.
      if (routeMeta) this._setBadgeLook(routeMeta);

      let ok = false;
      try {
        const routeData = await this.fetchRoute(routeId);
        // route_id isn't in the dist JSON; stamp it so rollback paths know
        // which route the map currently shows.
        routeData.route_id = routeId;
        this.currentRoute = routeData;
        const dirs = routeData.directions;
        const lastStopCounts = new Map();
        for (const d of dirs) {
          lastStopCounts.set(d.last_stop, (lastStopCounts.get(d.last_stop) || 0) + 1);
        }
        this.directions = dirs.map(d => {
          if (d.is_loop) {
            return { ...d, directionLabel: `↻ ${d.last_stop.toUpperCase()}` };
          }
          return lastStopCounts.get(d.last_stop) > 1
            ? { ...d, directionLabel: `${d.first_stop.toUpperCase()} → ${d.last_stop.toUpperCase()}` }
            : { ...d, directionLabel: `→ ${d.last_stop.toUpperCase()}` };
        });

        const savedDir = localStorage.getItem(`lastDirection_${routeId}`);
        const dirIdx = savedDir ? parseInt(savedDir, 10) : 0;
        this.selectedDirectionIdx = (dirIdx >= 0 && dirIdx < this.directions.length) ? dirIdx : 0;

        ok = true;
      } catch (error) {
        console.error(`Błąd ładowania danych dla linii ${routeId}:`, error);
        // Rollback badge to what the map still shows (selectedRouteId may have
        // moved on to a newer pick, so track currentRoute.route_id), or to the
        // empty state when nothing was ever loaded.
        if (this.currentRoute) {
          const shown = this.routes.find(r => r.route_id === this.currentRoute.route_id);
          if (shown) this._setBadgeLook(shown);
        } else {
          this.shortName = '-';
          this.badgeClass = '';
          this.badgeStyle = '';
          this.panelTitle = '';
        }
      } finally {
        this.routeInFlight = false;
        const next = this.routeLoadNext;
        this.routeLoadNext = null;
        if (ok) {
          localStorage.setItem(`lastRoute_${this.currentCitySlug}`, routeId);
        }
        if (next) {
          this.selectedRouteId = next;
          void this.onRouteChange();
        }
      }
      return ok;
    },

    // ponytail: real fetch seam — tests replace this; prod asks the static dist folder.
    fetchRoute(routeId) {
      return fetch(`./dist/${this.currentCitySlug}/${routeId}.json`)
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
    },

    async onDirectionChange() {
      if (this.isRiding) this.stopRide();
      this.blurSelect();

      if (!this.currentRoute || this.selectedDirectionIdx == null) return;

      this.cleanUpMap();
      this.currentDirection = this.directions[this.selectedDirectionIdx];

      localStorage.setItem(`lastDirection_${this.selectedRouteId}`, this.selectedDirectionIdx);

      const dir = this.currentDirection;
      this.routeName = dir.is_loop
        ? `↻ ${dir.last_stop}`
        : `${dir.first_stop} → ${dir.last_stop}`;

      const directionName = dir.is_loop
        ? `↻ ${dir.last_stop.toUpperCase()}`
        : `${dir.first_stop.toUpperCase()} → ${dir.last_stop.toUpperCase()}`;
      const shortName = this.currentRoute.short_name;
      const routeTypeName = this.currentRoute.type === 'TRAM' ? 'Tramwaju' : 'Autobusu';
      document.title = `Trasa ${routeTypeName.toLowerCase()} nr ${shortName}: ${directionName} — ${this.currentCityName}`;

      this.printDirectionName = directionName;
      this.agencyName = this.currentRoute.agency_name || 'Nieznany operator';
      this.stopCount = this.currentDirection.stops.length;
      this.routeLength = routeLengthKm(this.currentDirection.shape.coordinates, turf);

      const feedInfo = this.currentRoute.feed_info || {};
      const startDate = feedInfo.feed_start_date || '';
      const endDate = feedInfo.feed_end_date || '';
      if (startDate && endDate) {
        const fmt = d => `${d.substring(6)}.${d.substring(4, 6)}.${d.substring(0, 4)}`;
        this.printDates = `${fmt(startDate)}–${fmt(endDate)}`;
      } else {
        this.printDates = 'Brak danych';
      }

      this.drawRoute(this.currentRoute.color, this.currentDirection.shape.coordinates);
      this.drawStops(this.currentRoute, this.currentDirection);
    },

    // ponytail: keydown auto-repeat only flips the pending pointer and updates
    // the panel badge (cheap, no fetch/map work); the route itself loads in
    // flushNav on keyup. No debounce auto-flush — holding must never reload.
    // Safety: a stuck/lost keyup still loads after 10s of inactivity.
    advanceNav(step) {
      if (this.routes.length === 0) return;

      let ri = this.routes.findIndex(r => r.route_id === this.selectedRouteId);
      let di = this.selectedDirectionIdx ?? 0;
      if (this.pendingNav) {
        ri = this.pendingNav.routeIndex;
        di = this.pendingNav.dirIndex;
      }
      if (ri === -1) return;

      // ponytail: routes.json index has direction_count, not a directions array.
      const dirCount = () => Math.max(1, this.routes[ri].direction_count || 1);
      if (step > 0) {
        di++;
        while (di >= dirCount()) {
          di = 0;
          ri = (ri + 1) % this.routes.length;
        }
      } else {
        di--;
        while (di < 0) {
          ri = (ri - 1 + this.routes.length) % this.routes.length;
          di = dirCount() - 1;
        }
      }

      this.pendingNav = { routeIndex: ri, dirIndex: di };

      // Live preview: flip the badge/flyout number without loading the route.
      // Same look computation as full load — gray/white routes and light-bg
      // borders must render identically mid-scrub.
      const preview = this.routes[ri];
      const look = badgeLook(preview, this.hexToRgb);
      const { emoji, title } = panelTitleFor(preview, this.currentCityName);
      this.shortName = preview.short_name;
      this.routeTypeEmoji = emoji;
      this.badgeClass = look.badgeClass;
      this.badgeStyle = look.badgeStyle;
      this.panelTitle = title;

      clearTimeout(this.navDebounceTimer);
      this.navDebounceTimer = setTimeout(() => this.flushNav(), 10000);
    },

    flushNav() {
      clearTimeout(this.navDebounceTimer);
      const pending = this.pendingNav;
      this.pendingNav = null;
      if (!pending) return;

      const target = this.routes[pending.routeIndex];
      if (!target) return;
      const dirIdx = Math.min(pending.dirIndex, Math.max(1, target.direction_count || 1) - 1);

      if (target.route_id === this.selectedRouteId) {
        this.selectedDirectionIdx = dirIdx;
        this.onDirectionChange();
      } else {
        this.selectedRouteId = target.route_id;
        this.onRouteChange().then(() => {
          this.selectedDirectionIdx = dirIdx;
          this.onDirectionChange();
        });
      }
    },
  };
}

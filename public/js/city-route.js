// City & route mixin — load, select, hash routing, direction change

import * as turf from '@turf/turf';
import { routeLengthKm } from './ride-math.js';

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

    async onRouteChange() {
      if (this.isRiding) this.stopRide();

      if (!this.selectedRouteId) {
        this.currentRoute = null;
        this.directions = [];
        this.currentDirection = null;
        this.selectedDirectionIdx = 0;
        return;
      }

      const routeMeta = this.routes.find(r => r.route_id === this.selectedRouteId);
      if (!routeMeta) return;

      try {
        const response = await fetch(`./dist/${this.currentCitySlug}/${this.selectedRouteId}.json`);
        const routeData = await response.json();
        this.currentRoute = routeData;
        this.directions = routeData.directions.map(d => ({
          ...d,
          directionLabel: `${d.first_stop.toUpperCase()} → ${d.last_stop.toUpperCase()}`,
        }));

        const shortName = routeMeta.short_name;
        const routeTypeName = routeMeta.type === 'TRAM' ? 'Tramwaj' : 'Autobus';
        const routeTypeEmoji = routeMeta.type === 'TRAM' ? '🚋' : '🚌';
        this.shortName = shortName;
        this.routeTypeEmoji = routeTypeEmoji;

        let bgColor = `#${routeMeta.color}`;
        let textColor = `#${routeMeta.text_color}`;

        const isSpecialGray = bgColor.toUpperCase() === '#525252' && textColor.toUpperCase() === '#FFFFFF';
        if (isSpecialGray) {
          bgColor = '#FFFFFF';
          textColor = '#000000';
        }

        this.badgeClass = routeMeta.type === 'TRAM' ? 'route-badge' : 'route-badge bus';
        this.badgeStyle = {
          'background-color': bgColor,
          'color': textColor
        };

        const rgb = this.hexToRgb(bgColor);
        if (rgb && rgb.r > 240 && rgb.g > 240 && rgb.b > 240) {
          this.badgeClass += ' light-bg';
          this.badgeStyle['border-color'] = textColor;
        }

        this.panelTitle = `${routeTypeEmoji} ${routeTypeName} nr ${shortName} — ${this.currentCityName}`;
        const savedDir = localStorage.getItem(`lastDirection_${this.selectedRouteId}`);
        const dirIdx = savedDir ? parseInt(savedDir, 10) : 0;
        this.selectedDirectionIdx = (dirIdx >= 0 && dirIdx < this.directions.length) ? dirIdx : 0;

        localStorage.setItem(`lastRoute_${this.currentCitySlug}`, this.selectedRouteId);
        await this.onDirectionChange();
      } catch (error) {
        console.error(`Błąd ładowania danych dla linii ${this.selectedRouteId}:`, error);
      }
    },

    async onDirectionChange() {
      if (this.isRiding) this.stopRide();

      if (!this.currentRoute || this.selectedDirectionIdx == null) return;

      this.cleanUpMap();
      this.currentDirection = this.directions[this.selectedDirectionIdx];

      localStorage.setItem(`lastDirection_${this.selectedRouteId}`, this.selectedDirectionIdx);

      const dir = this.currentDirection;
      this.routeName = `${dir.first_stop} → ${dir.last_stop}`;

      const directionName = `${dir.first_stop.toUpperCase()} → ${dir.last_stop.toUpperCase()}`;
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
        this.printDates = `Obowiązuje: ${fmt(startDate)}–${fmt(endDate)}`;
      } else {
        this.printDates = 'Brak danych';
      }

      this.drawRoute(this.currentRoute.color, this.currentDirection.shape.coordinates);
      this.drawStops(this.currentRoute, this.currentDirection);
    },

    nextDirectionOrRoute() {
      if (!this.currentRoute || this.directions.length === 0) return;

      const nextIdx = this.selectedDirectionIdx + 1;
      if (nextIdx < this.directions.length) {
        this.selectedDirectionIdx = nextIdx;
        this.onDirectionChange();
        localStorage.setItem(`lastDirection_${this.selectedRouteId}`, this.selectedDirectionIdx);
      } else {
        const routeIndex = this.routes.findIndex(r => r.route_id === this.selectedRouteId);
        if (routeIndex === -1) return;

        const nextRouteIndex = (routeIndex + 1) % this.routes.length;
        const nextRoute = this.routes[nextRouteIndex];

        this.selectedRouteId = nextRoute.route_id;
        this.onRouteChange().then(() => {
          this.selectedDirectionIdx = 0;
          this.onDirectionChange();
        });
      }
    },

    prevDirectionOrRoute() {
      if (!this.currentRoute || this.directions.length === 0) return;

      const prevIdx = this.selectedDirectionIdx - 1;
      if (prevIdx >= 0) {
        this.selectedDirectionIdx = prevIdx;
        this.onDirectionChange();
        localStorage.setItem(`lastDirection_${this.selectedRouteId}`, this.selectedDirectionIdx);
      } else {
        const routeIndex = this.routes.findIndex(r => r.route_id === this.selectedRouteId);
        if (routeIndex === -1) return;

        const prevRouteIndex = routeIndex === 0 ? this.routes.length - 1 : routeIndex - 1;
        const prevRoute = this.routes[prevRouteIndex];

        this.selectedRouteId = prevRoute.route_id;
        this.onRouteChange().then(() => {
          const routeData = this.currentRoute;
          this.selectedDirectionIdx = routeData.directions.length - 1;
          this.onDirectionChange();
        });
      }
    }
  };
}

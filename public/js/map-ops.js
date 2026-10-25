import * as L from 'leaflet';

import { bestDirections, routeSegmentBoxes, DEFAULT_OFFSETS, flipClockwise } from './label-layout.js';

// Map operations + label optimization mixin

export function createMapOpsMixin() {
  return {
    // Map internals (not reactive)
    map: null,
    currentPolyline: null,
    currentMarkers: [],
    currentLabels: [],
    showStopLabels: true,

    initMap() {
      if (this.map) return;
      this.map = L.map('map', {
        doubleClickZoom: false,
        zoomSnap: 0.1,
        zoomDelta: 0.1,
        // Arrows/space are ours (route nav, ride toggle) and must never pan/zoom
        // the map, regardless of where focus sits.
        keyboard: false
      }).setView([52.0, 19.0], 6);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(this.map);

      this.map.invalidateSize();

      this.map.on('zoomend', () => {
        if (this.currentLabels.length > 0) this.optimizeLabelDirections();
      });

      window.addEventListener('resize', () => {
        this.map.invalidateSize();
        if (this.currentLabels.length > 0) this.optimizeLabelDirections();
      });

      document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

        if (e.key === 'ArrowRight' || (e.key === '>' && e.shiftKey)) {
          e.preventDefault();
          this.advanceNav(1);
        } else if (e.key === 'ArrowLeft' || (e.key === '<' && e.shiftKey)) {
          e.preventDefault();
          this.advanceNav(-1);
        } else if (e.key === ' ') {
          e.preventDefault();
          this.togglePlayPause();
        }
      });

      document.addEventListener('keyup', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === '>' || e.key === '<') {
          this.flushNav();
        }
      });
    },

    cleanUpMap() {
      if (this.isRiding) this.stopRide();

      if (this.currentPolyline) {
        this.map.removeLayer(this.currentPolyline);
        this.currentPolyline = null;
      }
      for (const marker of this.currentMarkers) {
        this.map.removeLayer(marker);
      }
      this.currentMarkers = [];
      this.currentLabels = [];
    },

    drawRoute(color, coordinates) {
      // The panel (x-show toggles, route header, stop list) can resize the
      // flex #map container during a route switch; Leaflet does not detect
      // container resizes itself, so a stale size projects the shape at wrong
      // pixel offsets (or off-screen). Re-measure before drawing/fitting.
      this.map.invalidateSize();
      this.currentPolyline = L.polyline(coordinates, {
        color: `#${color}`,
        weight: 5,
        opacity: 0.8,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(this.map);
      if (coordinates.length > 0) {
        this.map.fitBounds(this.currentPolyline.getBounds(), { padding: [50, 50] });
      }
    },

    getStopZoneLetter(stop) {
      const zoneId = String(stop?.zone_id || stop?.zoneId || '').trim().toUpperCase();
      return zoneId === 'A' || zoneId === 'B' || zoneId === 'C' || zoneId === 'D' ? zoneId : 'A';
    },

    getStopZoneColorVar(stop) {
      const zoneLetter = this.getStopZoneLetter(stop);
      return `var(--line-zone-${zoneLetter})`;
    },

    drawStops(routeData, directionData) {
      this.currentMarkers = [];
      this.currentLabels = [];
      const totalStops = directionData.stops.length;

      directionData.stops.forEach((stop, index) => {
        const stopLat = stop.stop_lat || stop.lat;
        const stopLng = stop.stop_lon || stop.lng;
        const stopNameClean = stop.stop_name || stop.name || '';
        const isFirstStop = index === 0;
        const isLastStop = index === totalStops - 1;
        const zoneLetter = this.getStopZoneLetter(stop);
        const zoneColorVar = this.getStopZoneColorVar(stop);

        const marker = L.marker([stopLat, stopLng], {
          icon: L.divIcon({
            html: `<div class="stop-zone-marker" style="--zone-color: ${zoneColorVar};">${zoneLetter}</div>`,
            className: '',
            iconSize: [18, 18],
            iconAnchor: [9, 9],
            tooltipAnchor: [-1, -1]
          }),
          interactive: true
        }).addTo(this.map);

        const stopNumber = index + 1;

        // Zone dot shows the zone letter (labels on) or the stop number
        // (labels hidden — the number is then only readable here).
        const zoneDotContent = () => (this.showStopLabels ? zoneLetter : String(stopNumber));

        marker.on('click', () => this.playStopAudio(stop, { first: isFirstStop, last: isLastStop }));
        // Right-click on the dot also flips the label (documented in help).
        marker.on('contextmenu', (e) => {
          L.DomEvent.stopPropagation(e);
          L.DomEvent.preventDefault(e);
          this.flipTooltip(marker);
        });

        if (this.showStopLabels) {
          marker.bindTooltip(this.renderLabelTooltip(stopNumber, stopNameClean, 'right', stop));

          marker.on('tooltipopen', (e) => {
            const tooltip = e.tooltip;
            if (!tooltip) return;
            tooltip.addEventListener('click', (event) => {
              // Left click on the label reads the stop (help: "Klik na etykietę").
              L.DomEvent.stopPropagation(event.originalEvent || event);
              this.playStopAudio(stop, { first: isFirstStop, last: isLastStop });
            });
            tooltip.addEventListener('contextmenu', (event) => {
              // Right click on the label itself flips it (help: "Prawy klik").
              L.DomEvent.stopPropagation(event.originalEvent || event);
              L.DomEvent.preventDefault(event.originalEvent || event);
              this.flipTooltip(marker);
            });
          });
        }

        this.currentLabels.push({
          lat: stopLat, lng: stopLng,
          direction: 'right', marker: marker,
          stopName: stopNameClean, stopNumber: stopNumber, stopData: stop,
          zoneDotEl: marker._icon ? marker._icon.querySelector('.stop-zone-marker') : null,
          zoneDotContent
        });
        this.currentMarkers.push(marker);
      });

      this.optimizeLabelDirections();
    },

    setShowStopLabels(show) {
      this.showStopLabels = show;
      if (!this.map) return;
      this.rebindLabelTooltips();
      if (show) this.optimizeLabelDirections();
    },

    // Rebind every tooltip so Leaflet recomputes its position (direction +
    // offset). Used when font size changes or labels toggle — Leaflet does not
    // reposition permanent tooltips on its own when their CSS size changes.
    rebindLabelTooltips() {
      for (const label of this.currentLabels) {
        label.marker.unbindTooltip();
        if (this.showStopLabels) {
          label.marker.bindTooltip(
            this.renderLabelTooltip(label.stopNumber, label.stopName, label.direction, label.stopData)
          );
        }
        // Zone dot: zone letter with labels, stop number without.
        if (!label.zoneDotEl && label.marker._icon) {
          label.zoneDotEl = label.marker._icon.querySelector('.stop-zone-marker');
        }
        if (label.zoneDotEl) label.zoneDotEl.textContent = label.zoneDotContent();
      }
    },

    flipTooltip(marker) {
      if (!this.showStopLabels) return;
      const labelData = this.currentLabels.find(l => l.marker === marker);
      if (!labelData) return;

      const newDir = flipClockwise(labelData.direction);
      if (!newDir) return;

      labelData.direction = newDir;
      this.rebindLabelTooltips();
    },

    renderLabelTooltip(stopNumber, stopName, direction, stopData = null) {
      return this.createStopLabelTooltip(
        direction, DEFAULT_OFFSETS[direction],
        `${stopNumber}. ${stopName}`, stopData
      );
    },

    createStopLabelTooltip(direction, offset, content, stopData = null) {
      const classes = ['stop-label'];
      if (stopData?.is_on_demand) {
        classes.push('on-demand-stop-label');
      }

      return L.tooltip({
        permanent: true, direction: direction, offset: offset,
        className: classes.join(' '), opacity: 1, interactive: true
      }).setContent(content);
    },

    // Label overlap optimization
    getLabelPixelDims(text) {
      const labelEl = document.querySelector('.stop-label');
      const labelStyle = labelEl ? getComputedStyle(labelEl) : null;
      const fontSize = labelStyle ? parseFloat(labelStyle.fontSize) : 8;

      let ctx = this._textMeasureCtx;
      if (!ctx) {
        ctx = document.createElement('canvas').getContext('2d');
        this._textMeasureCtx = ctx;
      }

      const fontFamily = labelStyle ? labelStyle.fontFamily : 'Inter, sans-serif';
      ctx.font = `${fontSize}px ${fontFamily}`;
      const textWidth = ctx.measureText(text).width;
      const textHeight = fontSize * 1.4;
      const padX = 0.3 * fontSize * 2;
      const padY = 0.1 * fontSize * 2;
      const w = textWidth + padX + 2;
      const h = textHeight + padY + 2;
      return { w, h };
    },

    optimizeLabelDirections() {
      if (!this.showStopLabels || this.currentLabels.length === 0) return;

      const size = this.map.getSize();
      const viewport = { left: 0, top: 0, right: size.x, bottom: size.y };

      const labels = this.currentLabels.map((label) => {
        const point = this.map.latLngToContainerPoint([label.lat, label.lng]);
        return {
          x: point.x, y: point.y,
          ...this.getLabelPixelDims(`${label.stopNumber}. ${label.stopName}`),
          dir: label.direction
        };
      });

      // ponytail: costs the label against ALL route segments, not just the
      // ±1-neighbour window agreed during design — full scan is simpler and,
      // at ≤66 stops × small shapes, fast enough; the soft cost makes the
      // difference mostly invisible. Upgrade to a window if a long route
      // ever makes zoomend noticeably slower.
      const routeBoxes = this.currentPolyline
        ? routeSegmentBoxes(
            this.currentPolyline.getLatLngs().map((ll) => {
              const p = this.map.latLngToContainerPoint(ll);
              return { x: p.x, y: p.y };
            }),
            2.5 // half the 5px route stroke, matching drawRoute
          )
        : [];

      const directions = bestDirections(labels, { routeBoxes, viewport });

      this.currentLabels.forEach((label, i) => {
        if (directions[i] !== label.direction) {
          label.direction = directions[i];
          label.marker.unbindTooltip();
          label.marker.bindTooltip(
            this.renderLabelTooltip(label.stopNumber, label.stopName, directions[i], label.stopData)
          );
        }
      });
    }
  };
}

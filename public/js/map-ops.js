// Leaflet as ESM namespace (esm.sh wraps the official ESM build).
// `esm.sh` re-exports Leaflet's named exports (`map`, `marker`, `polyline`, ...)
// so `L.xxx` keeps working exactly as before the CDN <script> was removed.
import * as L from 'https://esm.sh/leaflet@1.9.4';

// Map operations + label optimization mixin

export function createMapOpsMixin() {
  return {
    // Map internals (not reactive)
    map: null,
    currentPolyline: null,
    currentMarkers: [],
    currentLabels: [],

    LABEL_OFFSETS: {
      'right': { direction: 'right', offset: [5, 0] },
      'left': { direction: 'left', offset: [-5, 0] },
      'top': { direction: 'top', offset: [0, -5] },
      'bottom': { direction: 'bottom', offset: [0, 5] }
    },

    initMap() {
      if (this.map) return;
      this.map = L.map('map', {
        doubleClickZoom: false,
        zoomSnap: 0.1,
        zoomDelta: 0.1
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
          this.nextDirectionOrRoute();
        } else if (e.key === 'ArrowLeft' || (e.key === '<' && e.shiftKey)) {
          e.preventDefault();
          this.prevDirectionOrRoute();
        } else if (e.key === ' ') {
          e.preventDefault();
          this.togglePlayPause();
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
        const stopNameClean = (stop.stop_name || stop.name || '').replace(/"/g, '').trim();
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
        const content = `${stopNumber}. ${stopNameClean}`;

        const tooltip = this.createStopLabelTooltip('right', this.LABEL_OFFSETS.right.offset, content, stop);
        marker.bindTooltip(tooltip);

        marker.on('tooltipopen', (e) => {
          tooltip.addEventListener('click', (event) => {
            console.log('tooltip clicked');
            L.DomEvent.stopPropagation(event);
          });
        });

        tooltip.options.marker = marker;
        tooltip.options.isLastStop = isLastStop;
        tooltip.options.isFirstStop = isFirstStop;
        tooltip.options.stopData = stop;

        marker.on('click', () => this.playStopAudio(stop, isLastStop, isFirstStop));

        this.currentLabels.push({
          lat: stopLat, lng: stopLng,
          direction: 'right', marker: marker,
          stopName: stopNameClean, stopNumber: stopNumber, stopData: stop
        });
        this.currentMarkers.push(marker);
      });

      this.optimizeLabelDirections();
    },

    flipTooltip(marker) {
      const labelData = this.currentLabels.find(l => l.marker === marker);
      if (!labelData) return;

      const clockwise = { 'top': 'right', 'right': 'bottom', 'bottom': 'left', 'left': 'top' };
      const newDir = clockwise[labelData.direction];
      if (!newDir) return;

      marker.unbindTooltip();
      marker.bindTooltip(this.createStopLabelTooltip(newDir, this.LABEL_OFFSETS[newDir].offset, `${labelData.stopNumber}. ${labelData.stopName}`, labelData.stopData));
      labelData.direction = newDir;
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
    getLabelPixelBounds(stopLat, stopLng, direction, text) {
      const point = this.map.latLngToContainerPoint([stopLat, stopLng]);
      const offset = this.LABEL_OFFSETS[direction].offset;

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
      const arrowSize = 4;

      let left, top;
      switch (direction) {
        case 'right': left = point.x + offset[0] + arrowSize; top = point.y + offset[1] - h / 2; break;
        case 'left': left = point.x + offset[0] - arrowSize - w; top = point.y + offset[1] - h / 2; break;
        case 'top': left = point.x + offset[0] - w / 2; top = point.y + offset[1] - arrowSize - h; break;
        case 'bottom': left = point.x + offset[0] - w / 2; top = point.y + offset[1] + arrowSize; break;
      }
      return { left, top, right: left + w, bottom: top + h, w, h };
    },

    overlapArea(a, b) {
      if (!(a.right > b.left && b.right > a.left && a.bottom > b.top && b.bottom > a.top)) return 0;
      const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const yOverlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return xOverlap * yOverlap;
    },

    optimizeLabelDirections() {
      const directions = ['right', 'left', 'top', 'bottom'];
      const n = this.currentLabels.length;
      if (n === 0) return;

      const texts = this.currentLabels.map(l => `${l.stopNumber}. ${l.stopName}`);

      const currentBounds = this.currentLabels.map((label, idx) =>
        this.getLabelPixelBounds(label.lat, label.lng, label.direction, texts[idx])
      );

      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < n; i++) {
          const label = this.currentLabels[i];
          let bestDir = label.direction;
          let bestScore = Infinity;

          for (const dir of directions) {
            const testBounds = this.getLabelPixelBounds(label.lat, label.lng, dir, texts[i]);
            let totalOverlap = 0;
            for (let j = 0; j < n; j++) {
              if (i === j) continue;
              totalOverlap += this.overlapArea(testBounds, currentBounds[j]);
            }
            if (totalOverlap < bestScore) { bestScore = totalOverlap; bestDir = dir; }
          }

          if (bestDir !== label.direction) {
            label.direction = bestDir;
            label.marker.unbindTooltip();
            label.marker.bindTooltip(
              this.createStopLabelTooltip(bestDir, this.LABEL_OFFSETS[bestDir].offset, texts[i], label.stopData)
            );
            currentBounds[i] = this.getLabelPixelBounds(label.lat, label.lng, bestDir, texts[i]);
          }
        }
      }
    }
  };
}

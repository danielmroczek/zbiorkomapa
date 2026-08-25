import * as L from 'leaflet';
import * as turf from '@turf/turf';
import { createRide } from './ride-core.js';

// Ride (auto-play) Alpine wrapper — owns the Leaflet layers, the
// requestAnimationFrame loop, audio/voice and engine-sound, and a thin
// `createRide()` state machine from `ride-core.js` (the deep module). All
// timing/cancellation/hold logic lives in ride-core; this file is the
// browser-bound shell that feeds it wall-clock deltas and paints the result.

export function createRideMixin() {
  return {
    // Ride state (mixin-level flags + browser-bound layers/frame)
    isRiding: false,
    isPaused: false,

    get playPauseLabel() {
      return this.isRiding && !this.isPaused ? '⏸ Pauza' : '▶ Przejazd';
    },

    ride: {
      rideCore: null,
      vehicleMarker: null,
      trailLine: null,
      animFrameId: null,
      currentSector: 'left',
      highlightedStopIndex: null,
    },

    async togglePlayPause() {
      if (this.isRiding && !this.isPaused) {
        this.pauseRide();
      } else if (this.isRiding && this.isPaused) {
        this.resumeRide();
      } else {
        await this.startRide();
      }
    },

    pauseRide() {
      if (!this.isRiding || this.isPaused) return;
      this.isPaused = true;
      if (this.ride.animFrameId) {
        cancelAnimationFrame(this.ride.animFrameId);
        this.ride.animFrameId = null;
      }
      this.ride.rideCore?.pause();
      if (this.engineSoundEnabled) this.engineSound.setRPM(0.15);
    },

    resumeRide() {
      if (!this.isRiding || !this.isPaused) return;
      this.isPaused = false;
      this.ride.rideCore?.resume();
      this._startFrameLoop();
    },

    // Called by the ride-core module when the vehicle reaches a stop: highlight
    // the stop and play its audio (or wait a fixed beat), then release the ride.
    _handleStopReached(ride, stopIndex, stops) {
      this._highlightStopLabel(stopIndex);
      const isFirstStop = stopIndex === 0;
      const isLastStop = stopIndex === stops.length - 1;
      const release = () => ride.release();
      if (this.readStopNamesEnabled) {
        this.playStopAudio(stops[stopIndex], isLastStop, isFirstStop).then(release);
      } else {
        setTimeout(release, 1000);
      }
    },

    async startRide() {
      if (!this.currentDirection || this.isRiding) return;
      this.stopRide();
      this.isRiding = true;
      this.isPaused = false;

      try {
        const stops = this.currentDirection.stops;
        const shape = this.currentDirection.shape.coordinates;
        const routeType = this.currentRoute?.type;
        const vehicleEmoji = routeType === 'TRAM' ? '🚋' : '🚌';

        const ride = createRide(turf);
        this.ride.rideCore = ride;

        const startView = ride.start({
          shape,
          stops,
          speed: this.rideSpeed,
          onStopReached: (stopIndex) => this._handleStopReached(ride, stopIndex, stops),
        });

        // Map adapter — owns Layer creation and the initial view.
        const startCoord = startView.latLng;
        this.ride.vehicleMarker = L.marker(startCoord, {
          icon: this._createVehicleIcon(vehicleEmoji),
          zIndexOffset: 1000
        }).addTo(this.map);

        const trailColor = getComputedStyle(document.documentElement).getPropertyValue('--ride-trail-color').trim() || '#2962FF';
        this.ride.trailLine = L.polyline([], {
          color: trailColor,
          weight: 7,
          opacity: 0.9,
          lineCap: 'round',
          lineJoin: 'round'
        }).addTo(this.map);

        this.map.setView(startCoord, this._computeRideZoom(startView.avgSegDistKm), { animate: true });

        if (this.engineSoundEnabled) {
          const engineType = routeType === 'TRAM' ? 'tram' : 'bus';
          await this.engineSound.start(engineType);
          this.engineSound.setRPM(0.15);
        }

        this._startFrameLoop();

      } catch (error) {
        console.error('startRide error:', error);
        this._cleanupRide();
      }
    },

    // Map's own zoom framing for a ride: an average segment distance (km)
    // becomes a view radius, converted to a Web-Mercator zoom clamped to the
    // map's bounds. Kept here because getSize/getMinZoom are map facts; the
    // ride-core module stays free of them.
    _computeRideZoom(avgSegDistKm) {
      const viewRadiusKm = avgSegDistKm * 2;
      const mapHeightPx = this.map.getSize().y;
      const metersPerPixel = (viewRadiusKm * 1000) / (mapHeightPx / 2);
      // See ride.js history: mean-Earth circumference (2·π·earthRadius) is
      // deliberate — <0.2% below WGS84 equatorial, well under zoomSnap 0.1.
      const earthCircumferenceM = 2 * Math.PI * turf.earthRadius;
      const targetZoom = Math.log2(earthCircumferenceM / (256 * metersPerPixel));
      return Math.min(Math.max(targetZoom, this.map.getMinZoom()), this.map.getMaxZoom());
    },

    _startFrameLoop() {
      if (this.ride.animFrameId) return;
      const ride = this.ride.rideCore;
      if (!ride) return;
      let last = performance.now();

      const loop = (now) => {
        this.ride.animFrameId = null;
        if (!this.isRiding) return;

        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;

        let state;
        try {
          state = ride.advance(dt);
        } catch (error) {
          console.error('Ride error:', error);
          this.stopRide();
          return;
        }

        // Paint returned state onto the map.
        if (state.highlightIdx != null) this._highlightStopLabel(state.highlightIdx);
        else this._unhighlightStopLabel();

        if (this.ride.vehicleMarker) this.ride.vehicleMarker.setLatLng(state.position);
        if (this.ride.trailLine) this.ride.trailLine.setLatLngs(state.trail);

        if (state.sector !== this.ride.currentSector) this._updateVehicleIcon(state.sector);

        if (this.engineSoundEnabled) this.engineSound.setRPM(0.15 + state.speed * 0.85);

        this.map.panTo(state.position, { animate: false, duration: 0 });

        if (state.done) { this._finishRide(); return; }
        if (this.isPaused) return;

        this.ride.animFrameId = requestAnimationFrame(loop);
      };

      this.ride.animFrameId = requestAnimationFrame(loop);
    },

    _finishRide() {
      this._cleanupRide();
      if (this.currentPolyline && this.currentPolyline.getLatLngs().length > 0) {
        this.map.fitBounds(this.currentPolyline.getBounds(), { padding: [50, 50] });
      }
    },

    stopRide() {
      this.ride.rideCore?.stop();
      this._cleanupRide();
    },

    _cleanupRide() {
      if (this.ride.animFrameId) {
        cancelAnimationFrame(this.ride.animFrameId);
        this.ride.animFrameId = null;
      }
      if (this.ride.vehicleMarker) {
        this.map.removeLayer(this.ride.vehicleMarker);
        this.ride.vehicleMarker = null;
      }
      if (this.ride.trailLine) {
        this.map.removeLayer(this.ride.trailLine);
        this.ride.trailLine = null;
      }
      this.ride.rideCore = null;
      this.ride.currentSector = 'left';
      this.isRiding = false;
      this.isPaused = false;
      this._unhighlightStopLabel();
      if (this.engineSoundEnabled) this.engineSound.stop();
    },

    _createVehicleIcon(emoji, transform = '') {
      return L.divIcon({
        html: `<div class="vehicle-icon"${transform ? ` style="transform: ${transform}"` : ''}>${emoji}</div>`,
        className: '',
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });
    },

    _updateVehicleIcon(sector) {
      const marker = this.ride.vehicleMarker;
      if (!marker || !marker._icon) return;

      const isTram = this.currentRoute?.type === 'TRAM';

      let emoji, transform;
      if (sector === 'oncoming') {
        emoji = isTram ? '🚊' : '🚍';
        transform = '';
      } else if (sector === 'right') {
        emoji = isTram ? '🚋' : '🚌';
        transform = 'scaleX(-1)';
      } else {
        emoji = isTram ? '🚋' : '🚌';
        transform = '';
      }

      const innerDiv = marker._icon.querySelector('div');
      if (innerDiv) {
        innerDiv.textContent = emoji;
        innerDiv.style.transform = transform;
      }
      this.ride.currentSector = sector;
    },

    _highlightStopLabel(stopIndex) {
      this._unhighlightStopLabel();
      const labelData = this.currentLabels[stopIndex];
      if (!labelData?.marker) return;
      const tooltipEl = labelData.marker.getTooltip();
      if (tooltipEl?.getElement) {
        const el = tooltipEl.getElement();
        if (el) el.classList.add('ride-active-stop');
      }
      this.ride.highlightedStopIndex = stopIndex;
    },

    _unhighlightStopLabel() {
      if (this.ride.highlightedStopIndex == null) return;
      const labelData = this.currentLabels[this.ride.highlightedStopIndex];
      if (labelData?.marker) {
        const tooltipEl = labelData.marker.getTooltip();
        if (tooltipEl?.getElement) {
          const el = tooltipEl.getElement();
          if (el) el.classList.remove('ride-active-stop');
        }
      }
      this.ride.highlightedStopIndex = null;
    }
  };
}

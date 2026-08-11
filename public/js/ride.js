// Leaflet + Turf as ESM namespaces (esm.sh wraps otherwise-UMD builds).
// `esm.sh` re-exports the named exports, so `L.xxx` / `turf.xxx` keep working
// exactly as before the CDN <script> tags were removed.
import * as L from 'https://esm.sh/leaflet@1.9.4';
import * as turf from 'https://esm.sh/@turf/turf@7';
import {
  segmentSpeedAt,
  vehicleSector,
  snapStops,
  MIN_TRAIL_SLICE
} from './ride-math.js';

// Ride (auto-play) mixin — start/stop/pause/resume, animation, vehicle icon

export function createRideMixin() {
  return {
    // Ride state
    isRiding: false,
    isPaused: false,
    ride: {
      token: 0,
      vehicleMarker: null,
      trailLine: null,
      animFrameId: null,
      vMax: 0,
      accelTime: 1,
      pauseState: null,
      currentStopIndex: 0,
      currentT: 0,
      animResolve: null,
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

      this.ride.token++;

      if (this.ride.animFrameId) {
        cancelAnimationFrame(this.ride.animFrameId);
        this.ride.animFrameId = null;
      }

      if (this.ride.animResolve) {
        this.ride.animResolve();
        this.ride.animResolve = null;
      }

      if (!this.ride.pauseState) {
        this.ride.pauseState = { stopIndex: this.ride.currentStopIndex || 0, t: this.ride.currentT || 0 };
      }
      this.ride.currentT = 0;
      if (this.engineSoundEnabled) this.engineSound.setRPM(0.15);
    },

    resumeRide() {
      if (!this.isRiding || !this.isPaused) return;
      this.isPaused = false;

      const pauseState = this.ride.pauseState;
      this.ride.pauseState = null;

      const token = this.ride.token;
      const stops = this.currentDirection.stops;

      this._rideToStop(token, stops, pauseState.stopIndex, pauseState.t, Boolean(pauseState.pre)).catch(e => console.error('Ride error:', e));
    },

    async startRide() {
      if (!this.currentDirection || this.isRiding) return;
      this.stopRide();
      this.isRiding = true;
      this.isPaused = false;

      try {
        const token = ++this.ride.token;
        const stops = this.currentDirection.stops;
        const shapeCoords = this.currentDirection.shape.coordinates;

        // Pure ride mechanics: snap stops onto the shape line and get each
        // stop's distance from the line start. The [lng,lat]↔[lat,lng] swap
        // for Turf lives inside ride-math, so this caller never touches it.
        const { stopDists, lineLen } = snapStops(shapeCoords, stops, turf);
        const turfLine = turf.lineString(shapeCoords.map(c => [c[1], c[0]]));

        this.ride.turfLine = turfLine;
        this.ride.lineLen = lineLen;
        this.ride.stopDists = stopDists;

        const avgSegDist = stops.length > 1 ? lineLen / (stops.length - 1) : lineLen;
        const isSlow = this.rideSpeed === 'slow';
        this.ride.accelTime = isSlow ? 2 : 1;
        this.ride.vMax = avgSegDist / (isSlow ? 4 : 2);

        const routeType = this.currentRoute?.type;
        const vehicleEmoji = routeType === 'TRAM' ? '🚋' : '🚌';
        const startCoord = shapeCoords[0];
        const vehicleMarker = L.marker(startCoord, {
          icon: this._createVehicleIcon(vehicleEmoji),
          zIndexOffset: 1000
        }).addTo(this.map);
        this.ride.vehicleMarker = vehicleMarker;

        const trailColor = getComputedStyle(document.documentElement).getPropertyValue('--ride-trail-color').trim() || '#2962FF';
        const trailLine = L.polyline([], {
          color: trailColor,
          weight: 7,
          opacity: 0.9,
          lineCap: 'round',
          lineJoin: 'round'
        }).addTo(this.map);
        this.ride.trailLine = trailLine;

        const avgStopDist = stops.length > 1 ? lineLen / (stops.length - 1) : lineLen;
        const viewRadiusKm = avgStopDist * 2;
        const mapHeightPx = this.map.getSize().y;
        const metersPerPixel = (viewRadiusKm * 1000) / (mapHeightPx / 2);
        const targetZoom = Math.log2(40075016 / (256 * metersPerPixel));
        const clampedZoom = Math.min(Math.max(targetZoom, this.map.getMinZoom()), this.map.getMaxZoom());
        this.map.setView(startCoord, clampedZoom, { animate: true });

        this.ride.currentStopIndex = 0;

        if (this.engineSoundEnabled) {
          const engineType = this.currentRoute?.type === 'TRAM' ? 'tram' : 'bus';
          await this.engineSound.start(engineType);
          this.engineSound.setRPM(0.15);
        }

        this._rideToStop(token, stops, 0, 0).catch(e => console.error('Ride error:', e));

      } catch (error) {
        console.error('startRide error:', error);
        this._cleanupRide();
      }
    },

    _createVehicleIcon(emoji, transform = '') {
      return L.divIcon({
        html: `<div class="vehicle-icon"${transform ? ` style="transform: ${transform}"` : ''}>${emoji}</div>`,
        className: '',
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });
    },

    _getVehicleSector(bearing) {
      return vehicleSector(bearing);
    },

    _updateVehicleIcon(sector) {
      const marker = this.ride.vehicleMarker;
      if (!marker || !marker._icon) return;

      const routeType = this.currentRoute?.type;
      const isTram = routeType === 'TRAM';

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

    async _rideToStop(token, stops, stopIndex, resumeT = 0, resumePre = false) {
      if (token !== this.ride.token) return;

      this.ride.currentStopIndex = stopIndex;
      const isFirstStop = stopIndex === 0;
      const isLastStop = stopIndex === stops.length - 1;

      const preDist = this.ride.stopDists ? this.ride.stopDists[0] : 0;
      if (isFirstStop && !resumePre && preDist > 0) {
        await this._animateSegment(token, 0, 0, preDist);

        if (token !== this.ride.token) return;
        if (this.isPaused) {
          this.ride.pauseState = { stopIndex: 0, t: 0, pre: true };
          return;
        }
      }

      this._highlightStopLabel(stopIndex);

      if (this.engineSoundEnabled) this.engineSound.setRPM(0.15);

      if (resumeT === 0) {
        if (this.readStopNamesEnabled) {
          await this.playStopAudio(stops[stopIndex], isLastStop, isFirstStop);
        } else {
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (token !== this.ride.token) return;
      if (this.isPaused) {
        this.ride.pauseState = { stopIndex, t: 0 };
        return;
      }

      this._unhighlightStopLabel();

      if (isLastStop) {
        this._finishRide();
        return;
      }

      if (resumePre && stopIndex === 0) {
        await this._animateSegment(token, 0, resumeT, preDist);
      } else {
        await this._animateSegment(token, stopIndex, resumeT);
      }

      if (token !== this.ride.token) return;

      this._rideToStop(token, stops, stopIndex + 1, 0);
    },

    _animateSegment(token, stopIndex, resumeT = 0, preDist = null) {
      return new Promise((resolve) => {
        if (token !== this.ride.token) { resolve(); return; }

        this.ride.animResolve = resolve;

        const turfLine = this.ride.turfLine;
        const stopDists = this.ride.stopDists;
        const startDist = preDist != null ? 0 : stopDists[stopIndex];
        const endDist = preDist != null ? preDist : stopDists[stopIndex + 1];
        const segLen = endDist - startDist;

        if (segLen <= 0) { resolve(); return; }

        const vMax = this.ride.vMax;
        const accelTime = this.ride.accelTime;

        const accelDist = vMax * accelTime;
        let duration;
        if (segLen >= accelDist) {
          duration = segLen / vMax + accelTime;
        } else {
          duration = 2 * accelTime * Math.sqrt(segLen / accelDist);
        }
        const durationMs = duration * 1000;

        const progressAndSpeed = (t) =>
          segmentSpeedAt({ segLen, vMax, accelTime }, t);

        const startTime = performance.now() - resumeT * durationMs;

        const animate = (now) => {
          if (token !== this.ride.token) {
            if (this.isPaused) {
              const elapsed = now - startTime;
              const t = Math.min(Math.max(elapsed / durationMs, 0), 1);
              this.ride.pauseState = preDist != null ? { stopIndex, t, pre: true } : { stopIndex, t };
            }
            this.ride.animResolve = null;
            resolve();
            return;
          }

          const elapsed = now - startTime;
          const t = Math.min(elapsed / durationMs, 1);
          this.ride.currentT = t;

          const { frac, speed } = progressAndSpeed(t);

          if (this.engineSoundEnabled) this.engineSound.setRPM(0.15 + speed * 0.85);

          const currentDist = startDist + frac * segLen;

          const sliceEnd = Math.max(currentDist, startDist + MIN_TRAIL_SLICE);
          const trailSlice = turf.lineSliceAlong(turfLine, 0, sliceEnd);
          const trailLatLngs = trailSlice.geometry.coordinates.map(c => L.latLng(c[1], c[0]));
          this.ride.trailLine.setLatLngs(trailLatLngs);

          const lastCoord = trailSlice.geometry.coordinates[trailSlice.geometry.coordinates.length - 1];
          const pos = [lastCoord[1], lastCoord[0]];
          this.ride.vehicleMarker.setLatLng(pos);

          const nearest = turf.nearestPointOnLine(turfLine, turf.point(lastCoord));
          let prevIdx = nearest.properties.index;
          if (prevIdx > 0 && nearest.properties.location < 0.002) {
            prevIdx--;
          }
          const prevVertex = turfLine.geometry.coordinates[Math.max(0, prevIdx)];
          const bearing = turf.bearing(turf.point(prevVertex), turf.point(lastCoord));
          const sector = this._getVehicleSector(bearing);
          if (sector !== this.ride.currentSector) {
            this._updateVehicleIcon(sector);
          }

          this.map.panTo(pos, { animate: false, duration: 0 });

          if (t < 1) {
            this.ride.animFrameId = requestAnimationFrame(animate);
          } else {
            this.ride.animFrameId = null;
            this.ride.animResolve = null;
            resolve();
          }
        };

        this.ride.animFrameId = requestAnimationFrame(animate);
      });
    },

    _finishRide() {
      this._cleanupRide();
      if (this.currentPolyline && this.currentPolyline.getLatLngs().length > 0) {
        this.map.fitBounds(this.currentPolyline.getBounds(), { padding: [50, 50] });
      }
    },

    stopRide() {
      this.ride.token++;
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
      this.ride.turfLine = null;
      this.ride.stopDists = null;
      this.ride.vMax = 0;
      this.ride.accelTime = 1;
      this.isRiding = false;
      this.isPaused = false;
      this.ride.pauseState = null;
      this.ride.currentStopIndex = 0;
      this.ride.currentT = 0;
      this.ride.animResolve = null;
      this.ride.currentSector = 'left';
      this._unhighlightStopLabel();
      if (this.engineSoundEnabled) this.engineSound.stop();
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

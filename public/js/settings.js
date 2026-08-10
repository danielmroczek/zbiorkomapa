// Settings mixin — localStorage, font, print, engine sound

export function createSettingsMixin() {
  return {
    restoreSettings() {
      const fontSize = localStorage.getItem('stopLabelFontSize');
      if (fontSize) {
        this.fontSize = parseInt(fontSize, 10);
        this.setStopLabelFontSize(fontSize);
      }
      const pos = localStorage.getItem('printPosition');
      if (pos) this.printPosition = pos;
      if (localStorage.getItem('printPreview') === 'true') this.printPreview = true;
      if (localStorage.getItem('engineSoundEnabled') === 'false') this.engineSoundEnabled = false;
      if (localStorage.getItem('readStopNamesEnabled') === 'false') this.readStopNamesEnabled = false;
      const savedSpeed = localStorage.getItem('rideSpeed');
      if (savedSpeed === 'slow' || savedSpeed === 'fast') this.rideSpeed = savedSpeed;
    },

    setStopLabelFontSize(size) {
      document.documentElement.style.setProperty('--stop-label-font-size', size);

      if (this.map && this.currentLabels.length > 0) {
        window.requestAnimationFrame(() => {
          this.optimizeLabelDirections();
        });
      }
    },

    onFontSizeChange() {
      const size = Math.max(6, Math.min(20, this.fontSize || 11));
      this.fontSize = size;
      this.setStopLabelFontSize(`${size}px`);
      localStorage.setItem('stopLabelFontSize', `${size}px`);
    },

    onPrintPositionChange() {
      localStorage.setItem('printPosition', this.printPosition);
    },

    onPrintPreviewChange() {
      localStorage.setItem('printPreview', this.printPreview ? 'true' : 'false');
    },

    async onEngineSoundChange() {
      localStorage.setItem('engineSoundEnabled', this.engineSoundEnabled ? 'true' : 'false');
      if (this.isRiding) {
        if (this.engineSoundEnabled) {
          const engineType = this.currentRoute?.type === 'TRAM' ? 'tram' : 'bus';
          await this.engineSound.start(engineType);
          this.engineSound.setRPM(0.15);
        } else {
          this.engineSound.stop();
        }
      }
    },

    onReadStopNamesChange() {
      localStorage.setItem('readStopNamesEnabled', this.readStopNamesEnabled ? 'true' : 'false');
    },

    onRideSpeedChange() {
      localStorage.setItem('rideSpeed', this.rideSpeed);
    }
  };
}

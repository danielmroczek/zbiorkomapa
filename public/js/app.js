// App composer — imports mixins, merges into Alpine component, display state, init()

import Alpine from 'https://esm.sh/alpinejs@3.15.12';
import { createRideMixin } from './ride.js';
import { createMapOpsMixin } from './map-ops.js';
import { createAudioMixin } from './audio.js';
import { createSettingsMixin } from './settings.js';
import { createCityRouteMixin } from './city-route.js';
import { createEngineSound } from './engine-sound.js';

function _busApp() {
  return {
    // Display state
    panelTitle: '🚌 Wybierz linię',
    shortName: '-',
    routeTypeEmoji: '🚌',
    badgeClass: '',
    badgeStyle: {},
    routeName: '-',
    routeLength: '-',
    stopCount: '-',
    agencyName: '-',
    printDirectionName: '-',
    printDates: '-',
    printPosition: 'bottom-left',
    printPreview: false,
    fontSize: 11,

    // Computed
    get printBoxClasses() {
      const classes = ['preview-visible'].filter(_c => this.printPreview);
      if (this.printPosition !== 'bottom-left') classes.push(`print-${this.printPosition}`);
      return classes.join(' ');
    },

    // Helper: Convert hex to RGB
    hexToRgb(hex) {
      const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
      return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
      } : null;
    },

    async init() {
      this.initMap();
      this.initAudioPlayer();
      this.engineSound = createEngineSound();
      this.restoreSettings();
      await this.loadCitiesConfig();
      this.initHashRouting();
      await this.loadCityData();
    },

    // Merge all mixins
    ...createRideMixin(),
    ...createMapOpsMixin(),
    ...createAudioMixin(),
    ...createSettingsMixin(),
    ...createCityRouteMixin()
  };
}

Alpine.data('busApp', _busApp);
Alpine.start();

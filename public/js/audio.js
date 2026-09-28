// Audio mixin — adapter for <Audio> and speechSynthesis; cue sequencing and
// cancellation live in the stop-announcement module (the seam-owner).
import { createAnnouncer } from './stop-announcement.js';

export function createAudioMixin() {
  return {
    audioPlayer: null,
    engineSound: null,
    engineSoundEnabled: true,
    readStopNamesEnabled: true,
    rideSpeed: 'fast',

    getVoiceAnnouncementUrl(fileName) {
      const baseUrl = this.currentCityConfig?.audioBaseUrl;
      if (!baseUrl) return '';
      return `${baseUrl}${encodeURIComponent(fileName)}`;
    },

    // Expand common abbreviations before reading a stop name aloud so TTS
    // pronounces them as full words ("Os." -> "Osiedle"). Key: raw text token,
    // value: spoken expansion. Add new entries here as needed.
    ttsExceptions: {
      'os.': 'osiedle', // Eg. "Os. Radosne"
      'pl.': 'plac', // Eg. "Jerzykowo/pl. Piastowski"
      'i armii': 'pierwszej armii', //Eg. "I Armii Wojska Polsk"
      'i': 'jeden',
      'ii': 'dwa',
      'iii': 'trzy'
    },

    _expandTtsText(text) {
      if (!text) return text;
      const exceptions = this.ttsExceptions;
      // Anchor each abbreviation to a word boundary so "(os.", ",ul." or
      // "Kruszewnia/Os." still match, but "kios." never becomes part of a
      // longer word. "/" separates location/name parts in stop names.
      const pattern = new RegExp(
        `(^|[\\s(,/\\[\\]])(${Object.keys(exceptions)
          .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|')})(?=[\\s).,;]|$)`,
        'giu',
      );
      return text.replace(pattern, (match, lead, key) => {
        const expansion = String(exceptions[key.toLowerCase()]);
        // Keep the original leading punctuation.
        return lead + expansion;
      });
    },

    async ttsSpeak(text) {
      if (!('speechSynthesis' in window)) return;
      text = this._expandTtsText(text);

      const voices = await this.getTTSVoices();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = this.currentCityConfig?.ttsLang || 'pl-PL';
      utterance.rate = 0.9;

      const targetLang = utterance.lang.split('-')[0];
      const voice = voices.find(v => v.lang.startsWith(targetLang));
      if (voice) utterance.voice = voice;

      return new Promise((resolve) => {
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        speechSynthesis.speak(utterance);
      });
    },

    _ttsVoicesPromise: null,
    getTTSVoices() {
      if (this._ttsVoicesPromise) return this._ttsVoicesPromise;
      this._ttsVoicesPromise = new Promise((resolve) => {
        if (!('speechSynthesis' in window)) { resolve([]); return; }
        const voices = speechSynthesis.getVoices();
        if (voices.length > 0) { resolve(voices); return; }
        speechSynthesis.addEventListener('voiceschanged', () => {
          resolve(speechSynthesis.getVoices());
        }, { once: true });
      });
      return this._ttsVoicesPromise;
    },

    playBeep(frequency = 880, durationMs = 150) {
      return new Promise((resolve) => {
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.value = frequency;
          gain.gain.value = 0.3;
          osc.start();
          setTimeout(() => {
            osc.stop();
            ctx.close();
            resolve();
          }, durationMs);
        } catch (e) {
          resolve();
        }
      });
    },

    playStopAudio(stop, flags = {}) {
      return this.announcer?.announce(stop, flags);
    },

    // Adapter: resolve ONE cue. All knowledge of Audio/cache/speechSynthesis
    // stays here; the announcement module only sequences cues.
    async _playOneCue(cue) {
      if (cue.type === 'beep') return this.playBeep(880, 150);
      if (cue.type === 'text') return this.ttsSpeak(cue.value);
      if (cue.type === 'url') {
        // ponytail: empty url means a hybrid city without audioBaseUrl —
        // old code skipped the static messages then; keep skipping rather
        // than handing the player an empty src.
        if (!cue.value) return;
        return this._playUrl(cue.value);
      }
    },

    _playUrl(url, stop = null) {
      if (!this.audioPlayer) return;
      return this.audioPlayer.play(url, stop);
    },

    initAudioPlayer() {
      const app = this;

      this.audioPlayer = {
        audioCache: new Map(),
        currentAudio: null,
        isLoading: false,
        playbackToken: 0,

        async play(url) {
          const playToken = ++this.playbackToken;

          if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
          }

          if (this.isLoading) {
            // ponytail: 100 ms busy-poll while the first recording buffers;
            // upgrade path = chain onto the cache-miss promise instead of polling.
            await new Promise(resolve => setTimeout(resolve, 100));
            if (playToken !== this.playbackToken) return;
            return this.play(url);
          }

          try {
            const getOrCreateAudio = (audioUrl) => {
              let audio = this.audioCache.get(audioUrl);

              if (!audio) {
                this.isLoading = true;
                audio = new Audio(audioUrl);
                audio.volume = app.currentCityConfig?.audioVolume ?? 1;                
                audio.addEventListener('canplaythrough', () => {
                  this.isLoading = false;
                });
                audio.addEventListener('error', () => {
                  this.isLoading = false;
                  console.error('Failed to load audio:', audioUrl);
                });
                this.audioCache.set(audioUrl, audio);
              }

              return audio;
            };

            const playAudio = async (audioUrl) => {
              if (playToken !== this.playbackToken) return;

              const audio = getOrCreateAudio(audioUrl);
              this.currentAudio = audio;
              audio.currentTime = 0;

              try {
                await audio.play();
              } catch (error) {
                if (error?.name === 'AbortError' && playToken !== this.playbackToken) {
                  return;
                }
                throw error;
              }

              if (playToken !== this.playbackToken) return;

              return new Promise((resolve) => {
                const cleanup = () => {
                  if (this.currentAudio === audio) {
                    this.currentAudio = null;
                  }
                  resolve();
                };

                audio.addEventListener('ended', cleanup, { once: true });
                audio.addEventListener('pause', () => {
                  if (playToken === this.playbackToken) {
                    this.currentAudio = null;
                  }
                }, { once: true });
              });
            };

            await playAudio(url);
          } catch (error) {
            if (error?.name !== 'AbortError') {
              this.isLoading = false;
              console.error('Audio play error:', error);
            }
          }
        }
      };

      // The seam-owner: cue sequence + pre-emption. audio.js only satisfies
      // its playOne adapter (same seam shape as ride-core vs ride.js).
      //
      // ponytail: playback is deliberately split in two — THIS module decides
      // which cues follow which (token #1: "stop reading the old queue"),
      // while audioPlayer below (playbackToken, audioCache, 100ms retry,
      // volume) owns how ONE cue sounds and is cut short (token #2). The
      // original plan was to absorb audioPlayer here too; left as a two-stage
      // rollout. Merge them into this module only if a bug needs both tokens
      // visible in one file — otherwise this split stays.
      this.announcer = createAnnouncer({
        getSource: () => this.currentCityConfig?.audioSource || 'tts',
        urlFor: (fileName) => this.getVoiceAnnouncementUrl(fileName),
        audioIdFor: (stop) => stop?.audio_id || stop?.stop_code || stop?.stop_id,
        playOne: (c) => this._playOneCue(c),
      });
    }
  };
}

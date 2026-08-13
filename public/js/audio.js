// Audio mixin — player, TTS, beep, voice announcements

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

    getStopAudioUrl(stop) {
      const audioId = stop?.audio_id || stop?.stop_code || stop?.stop_id;
      return this.getVoiceAnnouncementUrl(`${audioId}.mp3`);
    },

    async ttsSpeak(text) {
      if (!('speechSynthesis' in window)) return;

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

    playStopAudio(stop, isLastStop = false, isFirstStop = false) {
      const audioSource = this.currentCityConfig?.audioSource || 'tts';

      if (audioSource === 'tts') {
        return this._playStopAudioTTS(stop, isLastStop, isFirstStop);
      } else if (stop?.audio_id == null) {
        // Recording city but stop has no recording: TTS for name, recordings for static messages
        return this._playStopAudioHybrid(stop, isLastStop, isFirstStop);
      } else {
        if (this.audioPlayer) {
          return this.audioPlayer.play(this.getStopAudioUrl(stop), isLastStop, isFirstStop, stop);
        }
      }
    },

    async _playStopAudioTTS(stop, isLastStop = false, isFirstStop = false) {
      const stopName = (stop?.stop_name || '').replace(/"/g, '').trim();
      const isOnDemand = Boolean(stop?.is_on_demand);

      if (isFirstStop) {
        await this.playBeep(880, 150);
      }

      await this.ttsSpeak(stopName);

      if (isOnDemand) {
        await this.ttsSpeak('Przystanek na żądanie');
      }

      if (isLastStop) {
        await this.ttsSpeak('Koniec trasy');
      }
    },

    // TTS for stop name, recordings for static messages (on-demand, last stop, first stop chime)
    async _playStopAudioHybrid(stop, isLastStop = false, isFirstStop = false) {
      const isOnDemand = Boolean(stop?.is_on_demand);
      const baseUrl = this.currentCityConfig?.audioBaseUrl;
      const playRecording = async (fileName) => {
        if (!baseUrl || !this.audioPlayer) return;
        const url = `${baseUrl}${encodeURIComponent(fileName)}`;
        await this.audioPlayer.play(url, false, false, null);
      };

      if (isFirstStop) {
        await playRecording('KBING!.mp3');
      }

      await this.ttsSpeak((stop?.stop_name || '').replace(/"/g, '').trim());

      if (isOnDemand) {
        await playRecording('KZADAN.mp3');
      }

      if (isLastStop) {
        await playRecording('KONCTR.mp3');
      }
    },

    initAudioPlayer() {
      const app = this;

      this.audioPlayer = {
        audioCache: new Map(),
        currentAudio: null,
        isLoading: false,
        playbackToken: 0,

        async play(url, isLastStop = false, isFirstStop = false, stop = null) {
          const playToken = ++this.playbackToken;

          if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
          }

          if (this.isLoading) {
            await new Promise(resolve => setTimeout(resolve, 100));
            if (playToken !== this.playbackToken) return;
            return this.play(url, isLastStop, isFirstStop, stop);
          }

          const isOnDemandStop = Boolean(stop?.is_on_demand);

          try {
            const getOrCreateAudio = (audioUrl) => {
              let audio = this.audioCache.get(audioUrl);

              if (!audio) {
                this.isLoading = true;
                audio = new Audio(audioUrl);
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

            const audioQueue = [];

            if (isFirstStop) {
              audioQueue.push(app.getVoiceAnnouncementUrl('KBING!.mp3'));
            }

            audioQueue.push(url);

            if (isOnDemandStop) {
              audioQueue.push(app.getVoiceAnnouncementUrl('KZADAN.mp3'));
            }

            if (isLastStop) {
              audioQueue.push(app.getVoiceAnnouncementUrl('KONCTR.mp3'));
            }

            for (const audioUrl of audioQueue) {
              if (playToken !== this.playbackToken) break;
              await playAudio(audioUrl);
            }
          } catch (error) {
            if (error?.name !== 'AbortError') {
              this.isLoading = false;
              console.error('Audio play error:', error);
            }
          }
        }
      };
    }
  };
}

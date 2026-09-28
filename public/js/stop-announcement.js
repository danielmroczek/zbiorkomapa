// Zapowiedź przystanku (Stop announcement) — owns the cue sequence
// (first-stop chime → stop name → on-demand → end-of-route) and cancellation
// between announcements (a newer announce pre-empts an older one).
//
// Seam: the adapter is playOne(cue) — it resolves one cue ({type:'beep'|'text'|'url',
// value}). Everything about HOW a cue sounds (Audio element, cache, retry, volume,
// speechSynthesis) lives in the adapter; this module only decides WHAT plays and
// in WHAT order, so the whole sequence is testable in Vitest with a fake adapter.

export function createAnnouncer({ getSource, urlFor, audioIdFor, playOne }) {
  let token = 0;

  return {
    // Invalidate any announcement currently in flight.
    cancel() {
      token++;
    },

    async announce(stop, { first = false, last = false } = {}) {
      const myToken = ++token;
      const live = () => myToken === token;
      const source = getSource();
      // ponytail: single global token, not per-ride channels — enough while
      // only one announcement can be audible at a time.
      const onDemand = Boolean(stop?.is_on_demand);
      const recordings = source === 'recordings';
      // Recording city where THIS stop has no recording: TTS for the name,
      // recordings for the static messages (hybrid).
      const hasRecording = recordings && stop?.audio_id != null;
      const audioId = audioIdFor(stop);

      const queue = [];
      if (first) {
        queue.push(source === 'tts'
          ? cue('beep')
          : cue('url', urlFor('KBING!.mp3')));
      }

      queue.push(hasRecording
        ? cue('url', urlFor(`${audioId}.mp3`))
        : cue('text', stop?.stop_name || ''));

      if (onDemand) {
        queue.push(recordings
          ? cue('url', urlFor('KZADAN.mp3'))
          : cue('text', 'Przystanek na żądanie'));
      }

      if (last) {
        queue.push(recordings
          ? cue('url', urlFor('KONCTR.mp3'))
          : cue('text', 'Koniec trasy'));
      }

      for (const c of queue) {
        if (!live()) return;
        await playOne(c);
      }
    },
  };
}

const cue = (type, value) => ({ type, value });

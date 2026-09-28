// Self-check for the cue-sequencing logic of the stop-announcement module
// (the interface is the test surface: a fake playOne records the sequence).
import { describe, it as test, expect } from 'vitest';
import { createAnnouncer } from './stop-announcement.js';

const make = (source, playOne) => {
  const played = [];
  const announcer = createAnnouncer({
    getSource: () => source,
    urlFor: (f) => `http://x/${f}`,
    audioIdFor: (stop) => stop?.audio_id || stop?.stop_id,
    playOne: (c) => { played.push(c); },
  });
  return { announcer, played };
};

const stop = (over = {}) => ({ stop_name: 'Rynek', audio_id: '123', ...over });

describe('createAnnouncer', () => {
  test('recordings city: chime, recorded name, on-demand, end-of-route', async () => {
    const { announcer, played } = make('recordings');
    await announcer.announce(stop({ is_on_demand: true }), { first: true, last: true });
    expect(played.map(c => c.type === 'url' ? c.value.split('/').pop() : c.type)).toEqual([
      'KBING!.mp3', '123.mp3', 'KZADAN.mp3', 'KONCTR.mp3',
    ]);
  });

  test('tts city: beep, spoken name, spoken extras', async () => {
    const { announcer, played } = make('tts');
    await announcer.announce(stop(), { first: true, last: true });
    expect(played[0]).toEqual({ type: 'beep', value: undefined });
    expect(played[1]).toEqual({ type: 'text', value: 'Rynek' });
    expect(played[2]).toEqual({ type: 'text', value: 'Koniec trasy' });
  });

  test('hybrid: recording city, stop without audio_id → TTS name + recorded messages', async () => {
    const { announcer, played } = make('recordings');
    await announcer.announce(stop({ audio_id: null, is_on_demand: true }));
    expect(played).toEqual([
      { type: 'text', value: 'Rynek' },
      { type: 'url', value: 'http://x/KZADAN.mp3' },
    ]);
  });

  test('a newer announcement cancels the in-flight one', async () => {
    const played = [];
    let releaseFirst;
    const gate = new Promise(r => { releaseFirst = r; });
    const a = createAnnouncer({
      getSource: () => 'recordings',
      urlFor: (f) => f,
      audioIdFor: (s) => s.audio_id,
      playOne: (c) => {
        played.push(c.value);
        if (c.value.includes('KBING')) return gate; // hold the queue open
      },
    });
    const p1 = a.announce(stop(), { first: true, last: true });
    const p2 = a.announce(stop({ audio_id: 'B2' }));
    releaseFirst(); // let the stale chime resolve; the queue must still die here
    await Promise.all([p1, p2]);
    expect(played).toEqual(['KBING!.mp3', 'B2.mp3']); // old queue: chime only, no KONCTR
  });

  test('middle stop of an ordinary route: name only', async () => {
    const { announcer, played } = make('tts');
    await announcer.announce(stop());
    expect(played).toEqual([{ type: 'text', value: 'Rynek' }]);
  });
});

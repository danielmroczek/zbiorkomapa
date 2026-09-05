import { describe, it, expect } from 'vitest';
import { createAudioMixin } from './audio.js';

// Instantiate the mixin without touching the DOM: only the pure expansion
// helper is exercised.
const mixin = createAudioMixin();

describe('_expandTtsText', () => {
  it('expands common abbreviations to full words', () => {
    expect(mixin._expandTtsText('Os. Młodych')).toBe('osiedle Młodych');
    expect(mixin._expandTtsText('UL. POLNA')).toBe('ulica POLNA');
    expect(mixin._expandTtsText('pl. Wolności')).toBe('plac Wolności');
  });

  it('expands abbreviations mid-string and keeps punctuation', () => {
    expect(mixin._expandTtsText('Al. Niepodległości (os. Rusa)'))
      .toBe('aleje Niepodległości (osiedle Rusa)');
    expect(mixin._expandTtsText('(ul. Polna), pl. Wolności'))
      .toBe('(ulica Polna), plac Wolności');
  });

  it('expands abbreviations after a slash separator in stop names', () => {
    expect(mixin._expandTtsText('Kruszewnia/Os. Izabelin'))
      .toBe('Kruszewnia/osiedle Izabelin');
    expect(mixin._expandTtsText('Zalasewo/Os. Leśne'))
      .toBe('Zalasewo/osiedle Leśne');
  });

  it('does not expand inside a longer word', () => {
    expect(mixin._expandTtsText('kios. handlowy')).toBe('kios. handlowy');
  });

  it('leaves unknown tokens and plain names untouched', () => {
    expect(mixin._expandTtsText('Dworzec Główny')).toBe('Dworzec Główny');
    expect(mixin._expandTtsText('Rondo Rataje')).toBe('Rondo Rataje');
  });

  it('is case-insensitive and applies to any token boundary', () => {
    expect(mixin._expandTtsText('os.\tróżne')).toBe('osiedle\tróżne');
  });
});

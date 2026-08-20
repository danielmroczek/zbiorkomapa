import { describe, it, expect } from 'vitest';
import { createPoznanMatcher, createAudioMatcher } from './audio-matcher.js';

// --- Test lookup Map ---
// Mirrors the shape produced by buildAudioLookup: keys are normalized
// "location|name", "location", or "name" strings; values are audio_ids.
function buildTestLookup() {
  return new Map([
    // location|name entries
    ['poznań|pl. ratajskiego', 'P01A1'],
    ['poznań|święty marcin', 'P0371'],
    ['suchy las|sprzeczna', 'P02B1'],
    ['swarzędz|kupiecka', 'P0FA1'],
    ['luboń|straż pożarna', 'P1783'],
    // location-only entries
    ['poznań', 'P0000'],
    ['suchy las', 'P02B0'],
    ['swarzędz', 'P0FA0'],
    // name-only entries
    ['awf', 'P00CF'],
    ['rondo kaponiera', 'P0232'],
    ['os. sobieskiego', 'P01EB'],
    ['krzywoustego', 'P035E'],
    ['kołobrzeska', 'P0159'],
    ['wielkopolska', 'P02AD'],
    ['słowiańska', 'P024D'],
    ['owcza', 'P01F8'],
    ['wiatraczna', 'P0378'],
    ['deszczowa', 'P00FE'],
    ['dworska', 'P039D'],
    ['żelazna', 'P02DA'],
    ['jeziory wielkie', 'P1460'],
  ]);
}

const matcher = createPoznanMatcher(buildTestLookup());

// ---------------------------------------------------------------------------
// Strategy 1: exception
// ---------------------------------------------------------------------------
describe('exception', () => {
  it('matches "wilczak serbska" → P02B2', () => {
    const result = matcher.find('Wilczak Serbska');
    expect(result).toEqual({ audio_id: 'P02B2', strategy: 'exception' });
  });

  it('matches "święty marcin" → P0371 (overrides lookup)', () => {
    const result = matcher.find('Święty Marcin');
    expect(result).toEqual({ audio_id: 'P0371', strategy: 'exception' });
  });

  it('matches "św. marcin" → P0371 (abbreviated form)', () => {
    const result = matcher.find('Św. Marcin');
    expect(result).toEqual({ audio_id: 'P0371', strategy: 'exception' });
  });

  it('matches "Luboń/Kurowskiego" → P178C despite case and slash', () => {
    const result = matcher.find('Luboń/Kurowskiego');
    expect(result).toEqual({ audio_id: 'P178C', strategy: 'exception' });
  });

  it('matches "Luboń / Kurowskiego" → P178C with spaces around slash', () => {
    const result = matcher.find('luboń / kurowskiego');
    expect(result).toEqual({ audio_id: 'P178C', strategy: 'exception' });
  });
});

// ---------------------------------------------------------------------------
// Strategy 2: locationSlash
// ---------------------------------------------------------------------------
describe('locationSlash', () => {
  it('matches "Suchy Las/Sprzeczna" → P02B1', () => {
    const result = matcher.find('Suchy Las/Sprzeczna');
    expect(result).toEqual({ audio_id: 'P02B1', strategy: 'locationSlash' });
  });

  it('matches with spaces around slash', () => {
    const result = matcher.find('Suchy Las / Sprzeczna');
    expect(result).toEqual({ audio_id: 'P02B1', strategy: 'locationSlash' });
  });

  it('does not match when location|name pair is not in lookup', () => {
    const result = matcher.find('Luboń/Nieistniejąca');
    // Falls through to later strategies or null
    expect(result?.strategy).not.toBe('locationSlash');
  });
});

// ---------------------------------------------------------------------------
// Strategy 3: locationOnly
// ---------------------------------------------------------------------------
describe('locationOnly', () => {
  it('matches "AWF" → P00CF (name-only key)', () => {
    const result = matcher.find('AWF');
    expect(result).toEqual({ audio_id: 'P00CF', strategy: 'locationOnly' });
  });

  it('matches "Rondo Kaponiera" → P0232 (name-only key)', () => {
    const result = matcher.find('Rondo Kaponiera');
    expect(result).toEqual({ audio_id: 'P0232', strategy: 'locationOnly' });
  });

  it('is case-insensitive', () => {
    const result = matcher.find('rondo kaponiera');
    expect(result).toEqual({ audio_id: 'P0232', strategy: 'locationOnly' });
  });

  it('matches "Jeziory Wielkie/" → P1460 (locality as stop, trailing slash)', () => {
    const result = matcher.find('Jeziory Wielkie/');
    expect(result).toEqual({ audio_id: 'P1460', strategy: 'locationOnly' });
  });

  it('matches "Jeziory Wielkie" → P1460 (locality as stop, no slash)', () => {
    const result = matcher.find('Jeziory Wielkie');
    expect(result).toEqual({ audio_id: 'P1460', strategy: 'locationOnly' });
  });
});

// ---------------------------------------------------------------------------
// Strategy 4: cityPrefix
// ---------------------------------------------------------------------------
describe('cityPrefix', () => {
  it('matches "Swarzędz Kupiecka" → P0FA1 (city|name)', () => {
    const result = matcher.find('Swarzędz Kupiecka');
    expect(result).toEqual({ audio_id: 'P0FA1', strategy: 'cityPrefix' });
  });

  it('matches "Luboń Straż Pożarna" → P1783', () => {
    const result = matcher.find('Luboń Straż Pożarna');
    expect(result).toEqual({ audio_id: 'P1783', strategy: 'cityPrefix' });
  });
});

// ---------------------------------------------------------------------------
// Strategy 5: poznanPrefix
// ---------------------------------------------------------------------------
describe('poznanPrefix', () => {
  it('matches Poznań stop via poznań|name key', () => {
    // "Pl. Ratajskiego" is not a name-only key in our test lookup,
    // so it falls through to Strategy 5: "poznań|pl. ratajskiego"
    const result = matcher.find('Pl. Ratajskiego');
    expect(result).toEqual({ audio_id: 'P01A1', strategy: 'poznanPrefix' });
  });
});

// ---------------------------------------------------------------------------
// No match → null
// ---------------------------------------------------------------------------
describe('no match', () => {
  it('returns null for completely unknown stop', () => {
    const result = matcher.find('Nieistniejący Przystanek XYZ');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = matcher.find('');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Smoke test: noop matcher
// ---------------------------------------------------------------------------
describe('noop matcher', () => {
  it('returns null for tts city', () => {
    const noopMatcher = createAudioMatcher({
      slug: 'swinoujscie',
      dataDir: '/nonexistent',
      audioSource: 'tts',
    });
    expect(noopMatcher.find('cokolwiek')).toBeNull();
  });
});

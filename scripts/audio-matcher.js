/**
 * Audio-id matcher — resolves a GTFS stop name to a studio audio_id.
 *
 * Modelled on osrm-router.js: a lean, self-contained module consumed by
 * processor.js so that processor stays responsible only for GTFS processing.
 *
 * Per-city strategies are dispatched internally by city slug. Poznań is the
 * only `recordings` city today; every other city gets a no-op matcher whose
 * `find()` always returns null (processor then falls back to its own sentinel).
 *
 * Usage:
 *   import { createAudioMatcher } from "./audio-matcher.js";
 *   const matcher = createAudioMatcher({ slug, dataDir, audioSource });
 *   const hit = matcher.find("Poznań/Pl. Ratajskiego"); // { audio_id, strategy } | null
 */

import fs from "node:fs";
import path from "node:path";

function normalizeLookupValue(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\//g, " ")
    .replace(/\s+/g, " ");
}

function parseCSVLine(text) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  const headers = parseCSVLine(lines[0]);
  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i]);
    if (cells.length >= headers.length) {
      const obj = {};
      for (let j = 0; j < headers.length; j++) {
        obj[headers[j]] = cells[j]?.trim() || "";
      }
      result.push(obj);
    }
  }
  return result;
}

const POZNAN_EXCEPTIONS = new Map([
  ["wilczak serbska", "P02B2"],
  ["święty marcin", "P0371"],
  ["św. marcin", "P0371"],
]);

/**
 * Build a lookup Map from audio.csv rows, mirroring the historical processor
 * behaviour (multiple key shapes per row for fuzzy matching): each row is
 * indexed by its stand-alone name, its location, and a "location|name" pair.
 */
function buildAudioLookup(audioData) {
  const lookup = new Map();
  for (const audio of audioData) {
    const hasStopName = Boolean(
      audio.nazwa_przystanku && String(audio.nazwa_przystanku).trim(),
    );
    const hasLocation = Boolean(
      audio.miejscowosc && String(audio.miejscowosc).trim(),
    );
    if (!audio.audio_id || (!hasStopName && !hasLocation)) continue;

    const name = hasStopName ? normalizeLookupValue(audio.nazwa_przystanku) : "";
    const location = hasLocation
      ? normalizeLookupValue(audio.miejscowosc)
      : "";

    if (location) {
      lookup.set(hasStopName ? `${location}|${name}` : `${location}|`, audio.audio_id);
      lookup.set(location, audio.audio_id);
    }

    if (hasStopName && !lookup.has(name)) {
      lookup.set(name, audio.audio_id);
    }
  }
  return lookup;
}

function createPoznanMatcher(audioLookup) {
  const find = (rawStopName) => {
    const rawName = String(rawStopName || "");
    const stopName = normalizeLookupValue(rawName);

    // Strategy 1: explicit manual overrides
    const exceptionAudioId = POZNAN_EXCEPTIONS.get(stopName);
    if (exceptionAudioId) {
      return { audio_id: exceptionAudioId, strategy: "exception" };
    }

    // Strategy 2: exact match with location/name format like "suchy las|sprzeczna"
    const slashMatch = rawName.match(/^(.+?)\s*\/\s*(.+)$/i);
    if (slashMatch) {
      const location = normalizeLookupValue(slashMatch[1]).replace(/\/$/, "");
      const stopPart = normalizeLookupValue(slashMatch[2]);
      const key = `${location}|${stopPart}`;
      if (audioLookup.has(key)) {
        return { audio_id: audioLookup.get(key), strategy: "locationSlash" };
      }
    }

    // Strategy 3: direct location-only match
    if (audioLookup.has(stopName)) {
      return { audio_id: audioLookup.get(stopName), strategy: "locationOnly" };
    }

    // Strategy 4: city-prefixed stop name -> location|name
    const cityMatch = stopName.match(/^([a-zążśźćęółń]+)\s+/i);
    if (cityMatch) {
      const possibleCity = cityMatch[1];
      const nameWithoutCity = stopName.replace(cityMatch[0], "").trim();
      const key = `${possibleCity}|${nameWithoutCity}`;
      if (audioLookup.has(key)) {
        return { audio_id: audioLookup.get(key), strategy: "cityPrefix" };
      }
    }

    // Strategy 5: "Poznań" prefix
    const poznanKey = `poznań|${stopName}`;
    if (audioLookup.has(poznanKey)) {
      return { audio_id: audioLookup.get(poznanKey), strategy: "poznanPrefix" };
    }

    return null;
  };

  return { find };
}

function createNoopMatcher() {
  return { find: () => null };
}

/**
 * Create an audio matcher for a city.
 *
 * @param {{ slug: string, dataDir: string, audioSource: string }} config
 *   slug - city slug (e.g. "poznan")
 *   dataDir - per-city data dir, resolved independently by the caller
 *   audioSource - "recordings" or "tts" (from cities.json)
 * @returns {{ find: (stopName: string) => ({audio_id: string, strategy: string}|null) }}
 */
export function createAudioMatcher({ slug, dataDir, audioSource }) {
  if (audioSource !== "recordings") {
    return createNoopMatcher();
  }

  const audioPath = path.join(dataDir, "audio.csv");
  let audioData = [];
  if (fs.existsSync(audioPath)) {
    audioData = parseCSV(fs.readFileSync(audioPath, "utf8"));
  }

  if (slug === "poznan") {
    return createPoznanMatcher(buildAudioLookup(audioData));
  }

  // Unknown recordings city with no per-city strategy yet.
  // ponytail: any city with audioSource "recordings" but no strategy here
  // silently matches nothing (all stops get null audio_id). Add a strategy object
  // for it in this function when recordings audio for the city is wired up.
  return createNoopMatcher();
}

export { createPoznanMatcher };

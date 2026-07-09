import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const SOURCE_URL = 'https://www.ztm.poznan.pl/otwarte-dane/zapowiedzi-glosowe/';
const OUTPUT_PATH = path.join(projectRoot, 'data', 'audio.csv');

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripTags(value) {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeCsv(value) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function cleanStopName(value) {
  const cleaned = decodeHtmlEntities(stripTags(value))
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return '';
  }

  if (/^\d+$/.test(cleaned)) {
    return '';
  }

  return cleaned.replace(/\s+\d+$/, '').trim();
}

function parseTableRows(html) {
  const tableMatches = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];

  for (const tableMatch of tableMatches) {
    const tableHtml = tableMatch[1];
    if (!tableHtml.includes('Identyfikator') || !tableHtml.includes('Nazwa przystanku')) {
      continue;
    }

    const rowMatches = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    const rows = [];

    for (const rowMatch of rowMatches) {
      const tdMatches = [...rowMatch[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)];
      if (tdMatches.length === 0) {
        continue;
      }

      const cells = tdMatches.map((m) => m[1]);
      rows.push(cells);
    }

    return rows;
  }

  return [];
}

async function main() {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const rawRows = parseTableRows(html);

  if (rawRows.length === 0) {
    throw new Error('Nie znaleziono tabeli z danymi na stronie.');
  }

  const seen = new Map();

  for (const cells of rawRows) {
    if (cells.length < 4) {
      continue;
    }

    const city = decodeHtmlEntities(stripTags(cells[1] || ''));
    const stopName = cleanStopName(cells[2] || '');
    const identifier = decodeHtmlEntities(stripTags(cells[3] || '')).trim();

    // Skip header row (when identifier equals "Identyfikator")
    if (!identifier || identifier.toLowerCase() === 'identyfikator') {
      continue;
    }

    if (!seen.has(identifier)) {
      seen.set(identifier, {
        miejscowosc: city,
        nazwa_przystanku: stopName,
        identyfikator: identifier,
      });
    }
  }

  const rows = [...seen.values()];
  const csvLines = [
    ['miejscowosc', 'nazwa_przystanku', 'audio_id'].map(escapeCsv).join(','),
    ...rows.map((row) => [row.miejscowosc, row.nazwa_przystanku, row.identyfikator].map(escapeCsv).join(',')),
  ];

  fs.writeFileSync(OUTPUT_PATH, `\uFEFF${csvLines.join('\n')}\n`, 'utf8');

  console.log(`Zapisano ${rows.length} rekordów do ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

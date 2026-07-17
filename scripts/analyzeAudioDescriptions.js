import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const DEFAULT_INPUT_PATH = path.join(projectRoot, "data", "audio.csv");
const DEFAULT_OUTPUT_PATH = path.join(projectRoot, "data", "audio-analysis-results.csv");
const DEFAULT_BASE_URL =
  "https://www.ztm.poznan.pl/pl/dla-deweloperow/getVoiceAnnouncements/?file=";
const DEFAULT_SUFFIX = ".mp3";
const DEFAULT_TEST_SIZE = 5;
const DEFAULT_TRANSCRIPTION_LANGUAGE = "pl";

function printHelp() {
  console.log(`Usage: node scripts/analyzeAudioDescriptions.js [options]\n\nOptions:\n  --input <path>      CSV file with audio metadata (default: ${DEFAULT_INPUT_PATH})\n  --output <path>     Output CSV with analysis results (default: ${DEFAULT_OUTPUT_PATH})\n  --base-url <url>    Base URL used when an audio_id is present (default: ${DEFAULT_BASE_URL})\n  --suffix <text>     Suffix appended to audio IDs (default: ${DEFAULT_SUFFIX})\n  --limit <number>    Only process the first N rows\n  --test              Process a random sample of ${DEFAULT_TEST_SIZE} rows for quick testing\n  --help              Show this help message`);
}

function parseArgs(argv) {
  const options = {
    inputPath: DEFAULT_INPUT_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    baseUrl: DEFAULT_BASE_URL,
    suffix: DEFAULT_SUFFIX,
    limit: null,
    test: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--input") {
      options.inputPath = argv[++index];
      continue;
    }

    if (arg === "--output") {
      options.outputPath = argv[++index];
      continue;
    }

    if (arg === "--base-url") {
      options.baseUrl = argv[++index];
      continue;
    }

    if (arg === "--suffix") {
      options.suffix = argv[++index];
      continue;
    }

    if (arg === "--limit") {
      const parsedLimit = Number(argv[++index]);
      if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = parsedLimit;
      continue;
    }

    if (arg === "--test") {
      options.test = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parseCsv(content) {
  const rows = [];
  let currentRow = [];
  let currentValue = "";
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (inQuotes) {
      if (char === '"') {
        if (content[index + 1] === '"') {
          currentValue += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentValue += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      currentRow.push(currentValue);
      currentValue = "";
      continue;
    }

    if (char === "\n") {
      currentRow.push(currentValue);
      rows.push(currentRow);
      currentRow = [];
      currentValue = "";
      continue;
    }

    if (char === "\r") {
      continue;
    }

    currentValue += char;
  }

  if (currentValue.length > 0 || currentRow.length > 0) {
    currentRow.push(currentValue);
    rows.push(currentRow);
  }

  return rows;
}

function readRows(inputPath) {
  const content = fs.readFileSync(inputPath, "utf8").replace(/^\uFEFF/, "");
  const rows = parseCsv(content);

  if (rows.length === 0) {
    return [];
  }

  const header = rows[0].map((column) => column.trim().toLowerCase());
  const miejscowoscIndex = header.indexOf("miejscowosc");
  const nazwaPrzystankuIndex = header.indexOf("nazwa_przystanku");
  const audioFilePathIndex = header.indexOf("audio_file_path");
  const audioIdIndex = header.indexOf("audio_id");

  const parsedRows = [];

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const values = rows[rowIndex];
    const miejscowosc = values[miejscowoscIndex] || "";
    const nazwaPrzystanku = values[nazwaPrzystankuIndex] || "";
    const audioFilePath = values[audioFilePathIndex] || "";
    const audioId = values[audioIdIndex] || "";

    const description = buildDescription(miejscowosc, nazwaPrzystanku);
    const source = normalizeAudioSource(audioFilePath, audioId);

    if (!description && !source) {
      continue;
    }

    parsedRows.push({
      description,
      audioFilePath: audioFilePath.trim(),
      audioId: audioId.trim(),
      source,
    });
  }

  return parsedRows;
}

function isIgnoredCityName(value) {
  return ["poznan", "poznan"].includes(
    String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim(),
  );
}

function buildDescription(miejscowosc, nazwaPrzystanku) {
  return [miejscowosc, nazwaPrzystanku]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => !isIgnoredCityName(value))
    .join(", ");
}

function normalizeAudioSource(audioFilePath, audioId) {
  const trimmedAudioFilePath = String(audioFilePath || "").trim();
  const trimmedAudioId = String(audioId || "").trim();

  if (trimmedAudioFilePath) {
    return trimmedAudioFilePath;
  }

  if (!trimmedAudioId) {
    return "";
  }

  return trimmedAudioId;
}

function pickRowsToAnalyze(rows, options) {
  if (!options.test) {
    return rows.slice(0, options.limit || rows.length);
  }

  const sampleSize = Math.min(DEFAULT_TEST_SIZE, rows.length);
  const shuffledRows = [...rows].sort(() => Math.random() - 0.5);
  return shuffledRows.slice(0, sampleSize);
}

function loadEnvFile(projectDirectory) {
  const envPath = path.join(projectDirectory, ".env");
  if (!fs.existsSync(envPath)) {
    return {};
  }

  const values = {};
  const content = fs.readFileSync(envPath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    let value = trimmedLine.slice(separatorIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function getApiConfig(envValues) {
  const apiKey = process.env.API_KEY || envValues.API_KEY || "";
  const apiUrl = process.env.API_URL || envValues.API_URL || "";
  const apiModel = process.env.API_MODEL || envValues.API_MODEL || "";
  const apiLanguage =
    process.env.API_LANGUAGE || envValues.API_LANGUAGE || DEFAULT_TRANSCRIPTION_LANGUAGE;

  if (!apiKey || !apiUrl || !apiModel) {
    throw new Error(
      "Missing API_KEY, API_URL or API_MODEL. Set them in the environment or in .env before running the analyzer.",
    );
  }

  return { apiKey, apiUrl, apiModel, apiLanguage };
}

function buildAudioUrl(audioId, baseUrl, suffix) {
  const normalizedAudioId = audioId.endsWith(suffix) ? audioId : `${audioId}${suffix}`;
  return `${baseUrl}${encodeURIComponent(normalizedAudioId)}`;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bos\b/gi, "osiedle")
    .replace(/\bos\.?/gi, "osiedle")
    .replace(/\bpoznan\b/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function levenshteinDistance(left, right) {
  const matrix = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));

  for (let index = 0; index <= left.length; index += 1) {
    matrix[index][0] = index;
  }

  for (let index = 0; index <= right.length; index += 1) {
    matrix[0][index] = index;
  }

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      matrix[leftIndex][rightIndex] = Math.min(
        matrix[leftIndex - 1][rightIndex] + 1,
        matrix[leftIndex][rightIndex - 1] + 1,
        matrix[leftIndex - 1][rightIndex - 1] + cost,
      );
    }
  }

  return matrix[left.length][right.length];
}

function similarityScore(left, right) {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);

  if (!normalizedLeft && !normalizedRight) {
    return 100;
  }

  const maxLength = Math.max(normalizedLeft.length, normalizedRight.length);
  if (maxLength === 0) {
    return 100;
  }

  const distance = levenshteinDistance(normalizedLeft, normalizedRight);
  const similarity = 100 - (distance / maxLength) * 100;
  return Math.max(0, Math.round(similarity * 100) / 100);
}

async function downloadAudio(source, baseUrl, suffix) {
  const trimmedSource = String(source || "").trim();
  if (!trimmedSource) {
    throw new Error("No audio source found");
  }

  const isRemote = /^https?:\/\//i.test(trimmedSource);
  if (isRemote) {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "audio-analysis-"));
    const safeFileName = path.basename(new URL(trimmedSource).pathname) || `audio${suffix}`;
    const filePath = path.join(tempDirectory, safeFileName || `audio${suffix}`);

    const response = await fetch(trimmedSource);
    if (!response.ok) {
      throw new Error(`Failed to download ${trimmedSource}: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    return { filePath, shouldDelete: true, tempDirectory };
  }

  const resolvedPath = path.isAbsolute(trimmedSource)
    ? trimmedSource
    : path.resolve(projectRoot, trimmedSource);

  if (fs.existsSync(resolvedPath)) {
    return { filePath: resolvedPath, shouldDelete: false };
  }

  const remoteUrl = buildAudioUrl(trimmedSource, baseUrl, suffix);
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "audio-analysis-"));
  const safeFileName = path.basename(new URL(remoteUrl).pathname) || `audio${suffix}`;
  const filePath = path.join(tempDirectory, safeFileName || `audio${suffix}`);

  const response = await fetch(remoteUrl);
  if (!response.ok) {
    throw new Error(`Failed to download ${remoteUrl}: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  return { filePath, shouldDelete: true, tempDirectory };
}

async function transcribeAudio(audioPath, apiKey, apiUrl, apiModel, apiLanguage) {
  const fileBuffer = fs.readFileSync(audioPath);
  const boundary = `----audio-analysis-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const filename = path.basename(audioPath);

  const bodyParts = [
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`,
    ),
    Buffer.from("Content-Type: audio/mpeg\r\n\r\n"),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}\r\n`),
    Buffer.from('Content-Disposition: form-data; name="model"\r\n\r\n'),
    Buffer.from(`${apiModel}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from('Content-Disposition: form-data; name="language"\r\n\r\n'),
    Buffer.from(`${apiLanguage}\r\n`),
    Buffer.from(`--${boundary}--\r\n`),
  ];

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(bodyParts),
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Transcription failed: ${response.status} ${response.statusText} ${responseText}`);
  }

  const responseText = await response.text();
  try {
    const payload = JSON.parse(responseText);
    const directText = payload.text || payload.transcription || payload.transcript || payload.result?.text || payload.result?.transcription;
    if (typeof directText === "string" && directText.trim()) {
      return directText.trim();
    }
  } catch {
    // fall through to plain-text parsing
  }

  return responseText.trim();
}

function escapeCsvValue(value) {
  const normalizedValue = String(value ?? "").replace(/\r?\n/g, " ");
  if (normalizedValue.includes(",") || normalizedValue.includes('"')) {
    return `"${normalizedValue.replace(/"/g, '""')}"`;
  }
  return normalizedValue;
}

function writeCsv(outputPath, results) {
  const header = ["audio_file_path", "description", "transcription", "similarity_score"];
  const rows = results.map((result) => [
    result.audio_file_path,
    result.description,
    result.transcription,
    result.similarity_score,
  ]);

  const content = [header, ...rows]
    .map((row) => row.map(escapeCsvValue).join(","))
    .join("\n");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${content}\n`, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.inputPath);
  const outputPath = path.resolve(options.outputPath);
  const envValues = loadEnvFile(projectRoot);
  const { apiKey, apiUrl, apiModel, apiLanguage } = getApiConfig(envValues);
  const rows = readRows(inputPath);
  const selectedRows = pickRowsToAnalyze(rows, options);

  if (selectedRows.length === 0) {
    console.log(`No rows found in ${inputPath}`);
    return;
  }

  const results = [];

  for (let index = 0; index < selectedRows.length; index += 1) {
    const row = selectedRows[index];
    const audioSource = row.audioFilePath || row.audioId;
    const audioReference = row.audioFilePath || row.audioId || row.source;
    const audioUrl = row.audioId ? buildAudioUrl(row.audioId, options.baseUrl, options.suffix) : audioSource;

    console.error(
      `[${index + 1}/${selectedRows.length}] ${audioReference || audioUrl} -> downloading and transcribing`,
    );

    try {
      const { filePath, shouldDelete, tempDirectory } = await downloadAudio(
        audioSource || audioUrl,
        options.baseUrl,
        options.suffix,
      );
      const transcription = await transcribeAudio(
        filePath,
        apiKey,
        apiUrl,
        apiModel,
        apiLanguage,
      );
      const similarityScoreValue = similarityScore(row.description, transcription);
      results.push({
        audio_file_path: audioReference || audioUrl,
        description: row.description,
        transcription,
        similarity_score: similarityScoreValue,
      });

      console.log(`\tSimilarity score: ${similarityScoreValue} (${row.description} vs ${transcription})`);
      
      if (shouldDelete && tempDirectory) {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
      }
      
    } catch (error) {
      console.error(`Failed to process ${audioReference || audioUrl}: ${error.message}`);
      results.push({
        audio_file_path: audioReference || audioUrl,
        description: row.description,
        transcription: "",
        similarity_score: 0,
      });
    }


  }

  const sortedResults = results.sort((left, right) => left.similarity_score - right.similarity_score);
  writeCsv(outputPath, sortedResults);
  console.log(`Wrote ${sortedResults.length} results to ${outputPath}`);
}

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

export {
  buildDescription,
  getApiConfig,
  loadEnvFile,
  normalizeText,
  parseCsv,
  similarityScore,
  pickRowsToAnalyze,
};

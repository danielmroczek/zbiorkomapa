import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Promise from "bluebird";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const DEFAULT_INPUT_PATH = path.join(projectRoot, "data", "audio.csv");
const DEFAULT_BASE_URL =
  "https://www.ztm.poznan.pl/pl/dla-deweloperow/getVoiceAnnouncements/?file=";
const DEFAULT_SUFFIX = ".mp3";
const DEFAULT_CONCURRENCY = 5;

function printHelp() {
  console.log(
    `Usage: node scripts/checkAudioLinks.js [options]\n\nOptions:\n  --input <path>      CSV file with an audio_id column (default: data/audio.csv)\n  --base-url <url>    Base URL for the audio file check (default: ${DEFAULT_BASE_URL})\n  --suffix <text>     Suffix added to each audio ID before checking (default: ${DEFAULT_SUFFIX})\n  --concurrency <n>   Number of requests to run in parallel (default: ${DEFAULT_CONCURRENCY})\n  --limit <number>    Only check the first N audio IDs\n  --help              Show this help message`,
  );
}

function parseArgs(argv) {
  const options = {
    inputPath: DEFAULT_INPUT_PATH,
    baseUrl: DEFAULT_BASE_URL,
    suffix: DEFAULT_SUFFIX,
    concurrency: DEFAULT_CONCURRENCY,
    limit: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--input") {
      options.inputPath = argv[++i];
      continue;
    }

    if (arg === "--base-url") {
      options.baseUrl = argv[++i];
      continue;
    }

    if (arg === "--suffix") {
      options.suffix = argv[++i];
      continue;
    }

    if (arg === "--concurrency") {
      const concurrencyValue = Number(argv[++i]);
      if (!Number.isInteger(concurrencyValue) || concurrencyValue <= 0) {
        throw new Error("--concurrency must be a positive integer");
      }
      options.concurrency = concurrencyValue;
      continue;
    }

    if (arg === "--limit") {
      const limitValue = Number(argv[++i]);
      if (!Number.isInteger(limitValue) || limitValue <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = limitValue;
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

function readAudioIds(inputPath) {
  const content = fs.readFileSync(inputPath, "utf8").replace(/^\uFEFF/, "");
  const rows = parseCsv(content);

  if (rows.length === 0) {
    return [];
  }

  const header = rows[0].map((column) => column.trim().toLowerCase());
  const audioIdIndex = header.indexOf("audio_id");

  if (audioIdIndex === -1) {
    throw new Error(
      `The file ${inputPath} does not contain an audio_id column.`,
    );
  }

  const audioIds = [];
  const seen = new Set();

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const audioId = (rows[rowIndex][audioIdIndex] || "").trim();
    if (!audioId || seen.has(audioId)) {
      continue;
    }

    seen.add(audioId);
    audioIds.push(audioId);
  }

  return audioIds;
}

function buildAudioUrl(audioId, baseUrl, suffix = DEFAULT_SUFFIX) {
  return `${baseUrl}${encodeURIComponent(`${audioId}${suffix}`)}`;
}

async function checkAudioLink(audioId, baseUrl, suffix) {
  const url = buildAudioUrl(audioId, baseUrl, suffix);
  const response = await fetch(url, { method: "HEAD" });
  return {
    audioId,
    url,
    status: response.status,
    ok: response.ok,
  };
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.inputPath);
  const audioIds = readAudioIds(inputPath);
  const limitedAudioIds = options.limit
    ? audioIds.slice(0, options.limit)
    : audioIds;
  const startedAt = Date.now();
  const concurrency = Math.min(
    options.concurrency,
    limitedAudioIds.length || 1,
  );

  console.error(
    `Checking ${limitedAudioIds.length} audio IDs from ${inputPath} with concurrency ${concurrency}`,
  );

  const failures = [];
  let completedCount = 0;

  const results = await Promise.map(
    limitedAudioIds,
    async (audioId) => {
      const startedCheckAt = Date.now();

      try {
        const result = await checkAudioLink(
          audioId,
          options.baseUrl,
          options.suffix,
        );
        const elapsedMs = Date.now() - startedCheckAt;
        const totalElapsedMs = Date.now() - startedAt;
        completedCount += 1;
        const remaining = limitedAudioIds.length - completedCount;
        const avgMsPerCheck =
          completedCount > 0 ? totalElapsedMs / completedCount : 0;
        const etaMs = remaining > 0 ? avgMsPerCheck * remaining : 0;
        const label = result.ok && result.status < 400 ? "OK" : "FAIL";
        console.error(
          `[${completedCount}/${limitedAudioIds.length}] ${audioId} -> ${label} ${result.status}${result.statusText ? ` ${result.statusText}` : ""} | ${elapsedMs}ms | elapsed ${formatDuration(totalElapsedMs)} | ETA ${formatDuration(etaMs)}`,
        );

        return result.ok && result.status < 400 ? null : result;
      } catch (error) {
        const elapsedMs = Date.now() - startedCheckAt;
        const totalElapsedMs = Date.now() - startedAt;
        completedCount += 1;
        const remaining = limitedAudioIds.length - completedCount;
        const avgMsPerCheck =
          completedCount > 0 ? totalElapsedMs / completedCount : 0;
        const etaMs = remaining > 0 ? avgMsPerCheck * remaining : 0;
        const failure = {
          audioId,
          url: buildAudioUrl(audioId, options.baseUrl, options.suffix),
          status: "network-error",
          error: error.message,
        };

        console.error(
          `[${completedCount}/${limitedAudioIds.length}] ${audioId} -> FAIL network-error | ${elapsedMs}ms | elapsed ${formatDuration(totalElapsedMs)} | ETA ${formatDuration(etaMs)}`,
        );
        return failure;
      }
    },
    { concurrency },
  );

  failures.push(...results.filter(Boolean));

  console.log(JSON.stringify(failures.map((item) => item.audioId)));

  if (failures.length > 0) {
    console.error(`Found ${failures.length} failing audio ID(s).`);
    process.exitCode = 1;
  } else {
    console.error(
      `Completed ${limitedAudioIds.length} checks in ${formatDuration(Date.now() - startedAt)}.`,
    );
    console.error("All checked audio URLs returned success responses.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

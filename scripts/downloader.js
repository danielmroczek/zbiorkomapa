import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import unzipper from "unzipper";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function slugify(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function loadCitiesConfig() {
  const configPath = path.join(projectRoot, "cities.json");
  if (!fs.existsSync(configPath)) {
    console.error("Brak pliku cities.json w katalogu głównym projektu.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function parseArgs() {
  const args = process.argv.slice(2);
  let cityFilter = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--city" && args[i + 1]) {
      cityFilter = args[i + 1];
      i++;
    }
  }
  return { cityFilter };
}

async function downloadCity(cityConfig) {
  const slug = slugify(cityConfig.name);
  const cityDataDir = path.join(projectRoot, "data", slug);
  const tmpDir = `${cityDataDir}.tmp-${process.pid}`;
  const zipPath = path.join(tmpDir, "gtfs.zip");

  // Sprzątamy ewentualne pozostałości po poprzednich nieudanych próbach.
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log(`[${cityConfig.name}] Pobieram GTFS z ${cityConfig.gtfsUrl}...`);

  const res = await fetch(cityConfig.gtfsUrl, {
    method: "GET",
    headers: {
      Accept: "application/octet-stream",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(zipPath, buffer);
  console.log(`[${cityConfig.name}] Zapisano: ${zipPath}`);

  console.log(`[${cityConfig.name}] Rozpakowuję ZIP...`);

  await fs
    .createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: tmpDir }))
    .promise();

  // Podmieniamy dopiero po pełnym sukcesie — nieudany download nie
  // zostawia starych plików GTFS, którym processor by zaufał.
  // ponytail: Windows potrafi chwilowo blokować katalog (indekser/AV) —
  // 3 retry z 200 ms odstępu; jeśli to zawiedzie, upgrade path to kopiowanie.
  fs.rmSync(cityDataDir, { recursive: true, force: true });
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmpDir, cityDataDir);
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log(`[${cityConfig.name}] Gotowe: pliki GTFS w data/${slug}/`);
}

async function main() {
  try {
    const { cityFilter } = parseArgs();
    const config = loadCitiesConfig();

    let cities = config.cities;
    if (cityFilter) {
      cities = cities.filter((c) => slugify(c.name) === cityFilter);
      if (cities.length === 0) {
        console.error(`Nie znaleziono miasta o slug: "${cityFilter}"`);
        console.error(
          "Dostępne:",
          config.cities.map((c) => slugify(c.name)).join(", "),
        );
        process.exit(1);
      }
    }

    for (const city of cities) {
      try {
        await downloadCity(city);
      } catch (err) {
        console.warn(
          `[${city.name}] Ostrzeżenie: pomijam miasto (${err.message})`,
        );
      }
    }
  } catch (err) {
    console.warn("Ostrzeżenie:", err.message);
  }
}

main();

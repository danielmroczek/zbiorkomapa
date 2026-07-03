import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import unzipper from 'unzipper';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const GTFS_URL = 'https://www.ztm.poznan.pl/pl/dla-deweloperow/getGTFSFile';
const dataDir = path.join(projectRoot, 'data');
const zipPath = path.join(dataDir, 'ZTMPoznanGTFS.zip');

async function main() {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      console.log(`Created directory: ${dataDir}`);
    }

    console.log(`Downloading GTFS from ${GTFS_URL}...`);

    const res = await fetch(GTFS_URL, {
      method: 'GET',
      headers: {
        'Accept': 'application/octet-stream',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!res.ok) {
      throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(zipPath, buffer);
    console.log(`Saved: ${zipPath}`);

    console.log('Extracting ZIP to data directory...');

    await fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: dataDir }))
      .promise();

    console.log('Done: GTFS files extracted to ./data');
  } catch (err) {
    console.error('Error:', err);
    process.exitCode = 1;
  }
}

main();
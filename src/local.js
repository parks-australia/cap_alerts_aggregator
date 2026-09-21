import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadLocalConfig, pollSources } from './index.js';
import { buildParkOutputs, loadBoundaries } from './geometry.js';

await loadDotEnv();

const outputFile = resolve(process.env.LOCAL_OUTPUT_FILE ?? '.local-output/aggregator.json');
const output = await pollSources(loadLocalConfig(), false);

await mkdir(dirname(outputFile), { recursive: true });
await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`Wrote local aggregator output to ${outputFile}`);

const boundariesDirectory = resolve(process.env.BOUNDARIES_DIR ?? 'assets/boundary_data');
if (process.env.BOUNDARIES_DIR !== 'none') {
  const boundaries = await loadBoundaries(boundariesDirectory);
  const features = output.sources.flatMap((source) => source.alerts);
  const parkOutputs = buildParkOutputs(features, boundaries, output.generatedAt);
  const outputDirectory = resolve(process.env.LOCAL_OUTPUT_DIR ?? '.local-output/parks');
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(Object.entries(parkOutputs).map(([parkId, parkOutput]) => (
    writeFile(`${outputDirectory}/${parkId}.json`, `${JSON.stringify(parkOutput, null, 2)}\n`, 'utf8')
  )));
  console.log(`Wrote ${Object.keys(parkOutputs).length} per-park files to ${outputDirectory}`);
}

function loadDotEnv() {
  const envPath = resolve('.env');
  return readFile(envPath, 'utf8')
    .then((contents) => {
      for (const line of contents.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const separator = trimmed.indexOf('=');
        if (separator < 1) continue;
        const name = trimmed.slice(0, separator).trim();
        const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, '');
        if (!process.env[name]) process.env[name] = value;
      }
    })
    .catch((error) => {
      if (error.code === 'ENOENT') {
        throw new Error('Missing .env; copy .env.example to .env and set the local Drupal values.');
      }
      throw error;
    });
}
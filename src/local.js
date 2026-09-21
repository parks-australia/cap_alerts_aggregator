import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadLocalConfig, pollSources } from './index.js';

await loadDotEnv();

const outputFile = resolve(process.env.LOCAL_OUTPUT_FILE ?? '.local-output/aggregator.json');
const output = await pollSources(loadLocalConfig(), false);

await mkdir(dirname(outputFile), { recursive: true });
await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`Wrote local aggregator output to ${outputFile}`);

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
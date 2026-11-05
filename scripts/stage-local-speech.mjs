import { createReadStream, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { downloadPinned } from './stage-bundled-embedding.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'resources', 'speech-models');
const manifest = JSON.parse(readFileSync(path.join(source, 'manifest.json'), 'utf8'));

export async function verifyLocalSpeechAssets(directory) {
  if (JSON.stringify(JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'))) !== JSON.stringify(manifest)) throw Error('Local speech manifest differs from the pinned release.');
  for (const asset of manifest.files) {
    const file = path.join(directory, asset.path), digest = createHash('sha256');
    if ((await stat(file)).size !== asset.bytes) throw Error(`Invalid local speech asset size: ${asset.path}`);
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    if (digest.digest('hex') !== asset.sha256) throw Error(`Invalid local speech checksum: ${asset.path}`);
  }
  for (const name of ['LICENSE.source.txt', 'MODEL_LICENSE.txt', 'SHERPA_LICENSE.txt', 'SILERO_LICENSE.txt', 'DSH_LICENSE.txt']) {
    if (!readFileSync(path.join(directory, name)).equals(readFileSync(path.join(source, name)))) throw Error(`Local speech license differs: ${name}`);
  }
  return { model: manifest.model, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) };
}
async function main() {
  const directory = process.argv.includes('--bundle-dir') ? path.resolve(process.argv[process.argv.indexOf('--bundle-dir') + 1]) : source;
  if (!process.argv.includes('--verify')) {
    mkdirSync(directory, { recursive: true });
    for (const asset of manifest.files) await downloadPinned(asset.url, path.join(directory, asset.path), asset);
  }
  process.stdout.write(JSON.stringify(await verifyLocalSpeechAssets(directory)) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });

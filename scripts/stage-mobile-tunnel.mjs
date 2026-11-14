import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import release from '../resources/mobile-tunnel-release.json' with { type: 'json' };

const verifyOnly = process.argv[2] === '--verify';
const directory = verifyOnly
  ? path.resolve(process.argv[3])
  : path.resolve(import.meta.dirname, '../.tools/mobile-cloudflared');

async function matches(file, expected) {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === expected;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

async function prepare(name, entry) {
  const file = path.join(directory, name);
  if (await matches(file, entry.sha256)) return;
  if (verifyOnly) throw new Error(`Cloudflare Tunnel component failed verification: ${name}`);
  const temporary = file + '.' + randomUUID() + '.download';
  try {
    const response = await fetch(entry.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`Cloudflare Tunnel download failed for ${name} (HTTP ${response.status}).`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    if (!await matches(temporary, entry.sha256)) throw new Error(`Cloudflare Tunnel download failed verification: ${name}`);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (!verifyOnly) await mkdir(directory, { recursive: true });
await Promise.all([
  prepare('cloudflared.exe', release.exe),
  prepare('LICENSE', release.license),
]);
console.log(`Cloudflare Tunnel ${release.version} ${verifyOnly ? 'verified' : 'staged'}.`);

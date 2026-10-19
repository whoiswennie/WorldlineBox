import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { setGlobalProxyFromEnv } from 'node:http';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const downloadLock = path.join(projectRoot, 'resources/portable-tools/download-lock.json');
const cache = path.join(projectRoot, '.tools/portable-downloads');
const stagingParent = path.join(projectRoot, '.tools/portable-acquisition');

async function hash(file) {
  const handle = await open(file, 'r');
  try {
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    return digest.digest('hex');
  } finally { await handle.close(); }
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: projectRoot, stdio: 'inherit', windowsHide: true, shell: false });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code !== 0) reject(new Error(`${path.basename(executable)} failed (${signal ?? code}).`));
      else resolve();
    });
  });
}

async function download(name, source) {
  const archive = path.join(cache, `${name}.archive`);
  try { if (await hash(archive) === source.sha256) return archive; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log(`[portable-tools] Downloading ${name} from ${source.url}`);
  const partial = `${archive}.partial`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(source.url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      if (response.url && !response.url.startsWith('https://')) throw new Error('Download redirected away from HTTPS.');
      if (Number(response.headers.get('content-length') ?? 0) > 1024 ** 3) throw new Error('Archive exceeds 1 GiB.');
      let received = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          callback(received > 1024 ** 3 ? new Error('Archive exceeds 1 GiB.') : null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(partial));
      break;
    } catch (error) {
      if (attempt === 3) throw new Error(`Portable ${name} download failed: ${error.message}`, { cause: error });
      console.warn(`[portable-tools] ${name} download interrupted; retrying (${attempt + 1}/3)...`);
      await setTimeout(1000 * (attempt + 1));
    }
  }
  if (await hash(partial) !== source.sha256) throw new Error(`Portable ${name} archive SHA-256 mismatch.`);
  await rename(partial, archive);
  return archive;
}

function extractZip(archive, destination) {
  const zip = new AdmZip(archive);
  let totalSize = 0;
  for (const entry of zip.getEntries()) {
    const relative = entry.entryName.replaceAll('\\', '/');
    const normalized = path.posix.normalize(relative);
    if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || relative.includes(':') ||
        ((entry.header.attr >>> 16) & 0o170000) === 0o120000) throw new Error(`Unsafe portable ZIP entry: ${relative}`);
    totalSize += entry.header.size;
    if (totalSize > 1024 ** 3) throw new Error('Portable ZIP expands beyond 1 GiB.');
  }
  // All entries were checked before writing any files.
  zip.extractAllTo(destination, false);
}

async function cleanup(staging) {
  const parent = await realpath(stagingParent);
  if (!staging.startsWith(`${parent}${path.sep}`)) throw new Error('Refusing cleanup outside portable acquisition staging.');
  await rm(staging, { recursive: true, force: true });
}

async function acquire() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Portable acquisition requires Windows x64.');
  setGlobalProxyFromEnv();
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--promote-reviewed-sources')) throw new Error('Unknown portable acquisition argument.');
  const lock = JSON.parse(await readFile(downloadLock, 'utf8'));
  if (lock.format !== 'worldlinebox-portable-downloads-v1' || lock.platform !== 'win32-x64') throw new Error('Invalid portable download lock.');
  const sources = Object.entries(lock.archives);
  if (sources.map(([name]) => name).sort().join(',') !== 'ffmpeg,git,node,pnpm,python') throw new Error('Incomplete portable download lock.');
  for (const [, source] of sources) {
    if (!source.url.startsWith('https://') || !/^[a-f0-9]{64}$/.test(source.sha256) ||
        !['zip', 'tgz', '7z'].includes(source.type) || !/^[a-zA-Z0-9._-]+$/.test(source.directory) || source.directory === '..') {
      throw new Error('Invalid portable archive source.');
    }
  }
  // Refuse to replace an existing bundle, including an incomplete/untrusted one.
  const target = path.join(projectRoot, 'resources/portable-tools/win32-x64');
  try {
    await lstat(target);
    throw new Error('Portable payload already exists. Run tools:verify or explicitly move it before acquiring a replacement.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(cache, { recursive: true });
  await mkdir(stagingParent, { recursive: true });
  const staging = await mkdtemp(path.join(stagingParent, 'sources-'));
  try {
    const archives = await Promise.all(sources.map(async ([name, source]) => [name, await download(name, source)]));
    const stageArgs = [path.join(projectRoot, 'scripts/portable-tools.mjs'), 'stage', '--download-lock', downloadLock];
    for (const [name, archive] of archives) {
      const source = lock.archives[name];
      const directory = path.join(staging, name);
      await mkdir(directory);
      console.log(`[portable-tools] Extracting verified ${name} archive...`);
      if (source.type === 'zip') extractZip(archive, directory);
      else if (source.type === 'tgz') await run('tar.exe', ['-xzf', archive, '-C', directory]);
      else await run(path.join(projectRoot, 'node_modules/7zip-bin/win/x64/7za.exe'), ['x', '-y', '-bso0', `-o${directory}`, archive]);
      stageArgs.push(`--${name}`, path.join(directory, source.directory));
    }
    if (!args.includes('--promote-reviewed-sources')) stageArgs.push('--locked', 'true');
    console.log('[portable-tools] Staging the pinned tool versions and verifying their runtime behavior...');
    await run(process.execPath, stageArgs);
  } finally {
    await cleanup(staging);
  }
}

await acquire();

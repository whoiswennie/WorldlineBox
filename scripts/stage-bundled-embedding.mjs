#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestFile = path.join(root, 'resources', 'embedding-models', 'manifest.json');
const runtimePackages = runtime => [{ ...runtime, directory: 'runtime-cpu' }, ...Object.values(runtime.accelerators ?? {})];
const runtimeFiles = runtime => runtimePackages(runtime).flatMap(item => item.files);

function contained(directory, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || path.isAbsolute(relative)
    || relative.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Invalid embedding resource path.');
  const resolved = path.resolve(directory, relative);
  const fromRoot = path.relative(path.resolve(directory), resolved);
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) throw new Error('Embedding resource escaped its bundle directory.');
  return resolved;
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function verifyFile(file, entry) {
  if (!existsSync(file)) throw new Error(`Missing bundled embedding file: ${entry.path}`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes || await digest(file) !== entry.sha256) {
    throw new Error(`Bundled embedding checksum mismatch: ${entry.path}`);
  }
}

export async function verifyBundledEmbedding(directory, platform = `${process.platform}-${process.arch}`) {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const runtime = manifest.runtime.platforms[platform];
  if (!runtime) throw new Error(`No CPU embedding package has been validated for ${platform}.`);
  const files = [...manifest.files, ...runtimeFiles(runtime)];
  for (const entry of files) await verifyFile(contained(directory, entry.path), entry);
  const embeddedManifest = path.join(directory, 'manifest.json');
  if (!existsSync(embeddedManifest) || JSON.stringify(JSON.parse(readFileSync(embeddedManifest, 'utf8'))) !== JSON.stringify(manifest)) {
    throw new Error('Bundled embedding manifest differs from the pinned release manifest.');
  }
  return { modelId: manifest.modelId, dimension: manifest.dimension, platform, files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

async function isVerified(file, entry) {
  try { await verifyFile(file, entry); return true; } catch { return false; }
}

/** Build-machine acquisition only. Application installation always consumes the verified bundled files. */
export async function downloadPinned(url, destination, entry, fetchFn = globalThis.fetch) {
  if (await isVerified(destination, entry)) return false;
  mkdirSync(path.dirname(destination), { recursive: true });
  if (process.platform === 'win32' && fetchFn === globalThis.fetch) {
    // Windows PowerShell uses the system TLS/proxy stack. Bounded ranges survive
    // gateways that terminate otherwise valid long responses after 20 MiB.
    process.stderr.write(`Acquiring pinned embedding build resource ${entry.path} (${entry.bytes} bytes) in verified ranges.\n`);
    const chunkSize = 1024 * 1024, count = Math.ceil(entry.bytes / chunkSize);
    const pieces = Array.from({ length: count }, (_, index) => `${destination}.range-${index}`);
    const systemDirectory = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    let powershell = path.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      const installed = execFileSync(path.join(systemDirectory, 'where.exe'), ['pwsh.exe'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/u).find(file => existsSync(file));
      if (installed) powershell = installed;
    } catch { /* Windows PowerShell is available without installing another build dependency. */ }
    const psLiteral = text => `'${String(text).replaceAll("'", "''")}'`;
    let next = 0;
    const transfers = await Promise.allSettled(Array.from({ length: Math.min(4, count) }, async () => {
      while (next < count) {
        const index = next++, start = index * chunkSize, end = Math.min(entry.bytes, start + chunkSize) - 1;
        if (existsSync(pieces[index]) && lstatSync(pieces[index]).size === end - start + 1) continue;
        const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; `
          + `if ($PSVersionTable.PSVersion.Major -lt 6) { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12 }; try { `
          + `$response=Invoke-WebRequest -UseBasicParsing -Uri ${psLiteral(url)} -Headers @{Range=${psLiteral(`bytes=${start}-${end}`)}} `
          + `-OutFile ${psLiteral(pieces[index])} -PassThru -TimeoutSec 60; `
          + `if ([int]$response.StatusCode -ne 206 -or $response.Headers['Content-Range'] -ne ${psLiteral(`bytes ${start}-${end}/${entry.bytes}`)}) { throw 'Invalid pinned download range response.' } `
          + `} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
              { windowsHide: true, maxBuffer: 128 * 1024, timeout: 75_000 });
            break;
          } catch (error) {
            const detail = String(error.stderr || 'Network request timed out.').replace(/[\r\n]+/gu, ' ').trim().slice(0, 240);
            process.stderr.write(`Embedding build range ${start}-${end}, attempt ${attempt + 1}/3 failed: ${detail}\n`);
            if (attempt === 2) throw new Error(`Pinned build download ${entry.path}, range ${start}-${end}, failed after three bounded attempts.`, { cause: error });
          }
        }
        if (!existsSync(pieces[index]) || lstatSync(pieces[index]).size !== end - start + 1) throw new Error('A pinned embedding download range was incomplete.');
      }
    }));
    const transferFailure = transfers.find(result => result.status === 'rejected');
    if (transferFailure) throw transferFailure.reason;
    const temporary = `${destination}.download-${process.pid}`;
    try {
      async function* chunks() { for (const piece of pieces) for await (const bytes of createReadStream(piece)) yield bytes; }
      await pipeline(Readable.from(chunks()), createWriteStream(temporary));
      await verifyFile(temporary, entry); renameSync(temporary, destination);
      for (const piece of pieces) unlinkSync(piece);
      return true;
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      for (const piece of pieces) if (existsSync(piece)) unlinkSync(piece);
      throw error;
    }
  }
  const temporary = `${destination}.download-${process.pid}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      process.stderr.write(`Acquiring pinned embedding build resource ${entry.path} (${entry.bytes} bytes).\n`);
      const response = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
      if (!response.ok || !response.body) throw new Error(`Pinned embedding download returned HTTP ${response.status}.`);
      let received = 0;
      const limit = new Transform({ transform(chunk, _encoding, next) {
        received += chunk.length;
        next(received > entry.bytes ? new Error('Pinned embedding download exceeded its expected size.') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(temporary));
      await verifyFile(temporary, entry);
      renameSync(temporary, destination);
      return true;
    } catch (error) {
      lastError = error;
      if (existsSync(temporary)) unlinkSync(temporary);
      process.stderr.write(`Embedding build download ${entry.path}, attempt ${attempt + 1}/3 failed: ${error.message}\n`);
    }
  }
  throw lastError;
}

export async function acquireBundledEmbedding(directory, platform = `${process.platform}-${process.arch}`, options = {}) {
  try { return { ...await verifyBundledEmbedding(directory, platform), downloads: 0, cached: true }; } catch { /* Reconstruct only from pinned sources below. */ }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const runtime = manifest.runtime.platforms[platform];
  if (!runtime) throw new Error(`No CPU embedding package has been validated for ${platform}.`);
  const cache = path.resolve(options.cacheDirectory ?? path.join(tmpdir(), 'worldlinebox-embedding-build', manifest.revision, platform));
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  let downloads = 0;
  for (const entry of manifest.files) {
    const destination = contained(directory, entry.path);
    if (await isVerified(destination, entry)) continue;
    const cached = contained(cache, entry.path);
    const url = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${encodeURIComponent(entry.path)}`;
    if (await downloadPinned(url, cached, entry, fetchFn)) downloads++;
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(cached, destination);
  }
  for (const runtimePackage of runtimePackages(runtime)) {
    if ((await Promise.all(runtimePackage.files.map(entry => isVerified(contained(directory, entry.path), entry)))).every(Boolean)) continue;
    const archive = contained(cache, runtimePackage.archive);
    if (await downloadPinned(runtimePackage.url, archive, { path: runtimePackage.archive, bytes: runtimePackage.archiveBytes, sha256: runtimePackage.archiveSha256 }, fetchFn)) downloads++;
    const zip = new AdmZip(archive);
    for (const entry of runtimePackage.files) {
      const archiveEntry = zip.getEntry(entry.path.slice(runtimePackage.directory.length + 1));
      if (!archiveEntry || archiveEntry.isDirectory) throw new Error(`Pinned CPU archive is missing ${entry.path}.`);
      const destination = contained(directory, entry.path);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, archiveEntry.getData());
      await verifyFile(destination, entry);
    }
  }
  mkdirSync(directory, { recursive: true });
  if (path.resolve(manifestFile) !== path.resolve(path.join(directory, 'manifest.json'))) copyFileSync(manifestFile, path.join(directory, 'manifest.json'));
  return { ...await verifyBundledEmbedding(directory, platform), downloads, cached: downloads === 0 };
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const platform = value('--platform') ?? `${process.platform}-${process.arch}`;
  const directory = path.resolve(value('--bundle-dir') ?? path.join(root, 'resources', 'embedding-models'));
  if (args.includes('--acquire')) {
    const result = await acquireBundledEmbedding(directory, platform, { cacheDirectory: value('--cache-dir') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const source = value('--source-root');
  if (source) {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const runtime = manifest.runtime.platforms[platform];
    if (!runtime) throw new Error(`No CPU embedding package has been validated for ${platform}.`);
    for (const entry of [...manifest.files, ...runtimeFiles(runtime)]) {
      const from = entry.path.startsWith('runtime-cpu/')
        ? contained(source, `runtime/${entry.path.slice('runtime-cpu/'.length)}`)
        : contained(source, entry.path);
      await verifyFile(from, entry);
      const to = contained(directory, entry.path);
      mkdirSync(path.dirname(to), { recursive: true });
      if (path.resolve(from) !== path.resolve(to)) copyFileSync(from, to);
    }
    mkdirSync(directory, { recursive: true });
    if (path.resolve(manifestFile) !== path.resolve(path.join(directory, 'manifest.json'))) copyFileSync(manifestFile, path.join(directory, 'manifest.json'));
  }
  const result = await verifyBundledEmbedding(directory, platform);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

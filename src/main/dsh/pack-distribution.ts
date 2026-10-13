import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { dshPackDistributionSchema, type DshPackDistribution, type DshPackPublication } from '../../shared/dsh-pack-distribution';
import { dshRepositorySchema } from '../../shared/dsh-marketplace';
import { extractSealedArchive, parseSealedManifest } from './archive';
import { createReadStream, createWriteStream, lstat, mkdir, writeFile } from './disk';
import { atomicJson, contained, hashFile, removeManaged, safeRelative } from './files';
import { fetchHttpsDownload, httpsDownloadUrl } from './https-download';
import type { DshMarketplaceNetwork } from './marketplace';
import type { OperationContext } from './operations';

export interface PackPublishRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; headers?: Record<string, string>; body?: string | Uint8Array | Readable; signal: AbortSignal;
}
export interface PackDistributionOptions {
  rootPath: string; network: DshMarketplaceNetwork;
  exportArchive(packId: string, file: string, signal: AbortSignal): Promise<unknown>;
  importArchive?(file: string, operation: OperationContext): Promise<unknown>;
  request?(url: string, input: PackPublishRequest): Promise<Response>;
}
const MANIFEST_LIMIT = 32 * 1024 ** 2;
function validateDistribution(value: unknown): DshPackDistribution {
  const parsed = dshPackDistributionSchema.parse(value); safeRelative(parsed.archive.fileName);
  if (parsed.archive.fileName.includes('/') || !parsed.archive.fileName.endsWith('.dshpack')) throw new Error('The distribution requires a .dshpack archive filename.');
  if (parsed.archive.url) httpsDownloadUrl(parsed.archive.url);
  parseSealedManifest(parsed.lock);
  if (parsed.format === 'worldlinebox-dshpack-distribution-v2' && !parsed.lock.files.some(file => file.path === 'runtime-lock/package-lock.json')) throw new Error('The public Node pack requires its sealed replay dependency lock.');
  for (const file of parsed.lock.files) {
    if (file.path !== 'home/cordis.patch.yml' && !(parsed.format === 'worldlinebox-dshpack-distribution-v2' && file.path === 'runtime-lock/package-lock.json')
      && !/^(?:home\/(?:profiles|skills|skills-disabled)|agents\/skills)\//.test(file.path)) throw new Error('The public pack lock contains a private or unexpected path.');
    if (file.path.split('/').some(segment => /^\.credentials(?:\.|$)|^\.env(?:\.|$)|^(?:sessions|attachments|storages)$/i.test(segment))) throw new Error('The public pack lock contains private data.');
  }
  return parsed;
}
/** Publishable artifacts use the same sealed pack bytes as offline export, with a public digest and file lock. */
export class PackDistributionService {
  constructor(private readonly options: PackDistributionOptions) {}
  async createDistribution(packId: string, archivePath: string, downloadUrl?: string, outerSignal?: AbortSignal): Promise<{
    manifest: DshPackDistribution; manifestPath: string; checksumPath: string;
  }> {
    const signal = outerSignal ?? AbortSignal.timeout(30 * 60_000); signal.throwIfAborted();
    if (!/^[a-z0-9-]{1,80}$/.test(packId) || path.extname(archivePath).toLowerCase() !== '.dshpack') throw new Error('Invalid pack export identity or filename.');
    if (downloadUrl) httpsDownloadUrl(downloadUrl);
    const exported = await this.options.exportArchive(packId, archivePath, signal);
    const seal = parseSealedManifest(exported); const metadata = exported as Record<string, unknown>;
    const info = await lstat(archivePath); if (!info.isFile() || info.isSymbolicLink()) throw new Error('The exported pack is not a regular archive file.');
    const manifest = validateDistribution({ format: metadata.format === 'worldlinebox-dshpack-v2' ? 'worldlinebox-dshpack-distribution-v2' : 'worldlinebox-dshpack-distribution-v1', name: metadata.name, version: metadata.version,
      createdAt: metadata.createdAt, runtime: metadata.runtime,
      archive: { fileName: path.basename(archivePath), byteLength: info.size, sha256: await hashFile(archivePath, signal), url: downloadUrl },
      lock: { files: seal.files, contentSha256: seal.contentSha256, fileCount: seal.fileCount, byteLength: seal.byteLength } });
    const manifestPath = `${archivePath}.manifest.json`; const checksumPath = `${archivePath}.sha256`;
    await atomicJson(manifestPath, manifest); await writeFile(checksumPath, `${manifest.archive.sha256}  ${manifest.archive.fileName}\n`, { mode: 0o600 });
    return { manifest, manifestPath, checksumPath };
  }
  async inspectManifest(url: string, outerSignal?: AbortSignal): Promise<DshPackDistribution> {
    const signal = outerSignal ? AbortSignal.any([outerSignal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const response = await fetchHttpsDownload(url, this.options.network.fetch, signal);
    return validateDistribution(await boundedJson(response, MANIFEST_LIMIT, signal));
  }
  async importDistribution(manifestUrl: string, operation: OperationContext): Promise<unknown> {
    if (!this.options.importArchive) throw new Error('Pack import is unavailable.');
    await operation.update('Loading the public pack manifest', 5); const manifest = await this.inspectManifest(manifestUrl, operation.signal);
    if (!manifest.archive.url) throw new Error('The public manifest has no archive download URL.');
    const staging = path.join(this.options.rootPath, 'marketplace', 'pack-staging');
    await managedDirectory(this.options.rootPath, staging);
    const directory = contained(staging, randomUUID()); await mkdir(directory); const file = contained(directory, manifest.archive.fileName);
    try {
      await operation.update('Downloading the version-locked pack', 15);
      const response = await fetchHttpsDownload(manifest.archive.url, this.options.network.fetch, operation.signal);
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('The pack archive request failed.'); }
      const announced = response.headers.get('content-length'); if (announced !== null && Number(announced) !== manifest.archive.byteLength) { await response.body.cancel(); throw new Error('The pack download length differs from the public manifest.'); }
      let length = 0; const digest = createHash('sha256'); let lastPercent = -1;
      await operation.download?.begin(manifest.archive.byteLength);
      const guard = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        length += chunk.length; digest.update(chunk);
        if (length > manifest.archive.byteLength) { callback(new Error('The pack download exceeds its public size.')); return; }
        const percent = Math.min(80, Math.floor(15 + length / manifest.archive.byteLength * 65));
        if (percent > lastPercent + 4) { lastPercent = percent; void operation.update('Downloading the version-locked pack', percent).catch(() => undefined); }
        void (async () => { await operation.download?.wait(); operation.download?.report(length); callback(null, chunk); })().catch(callback);
      } });
      try { await pipeline(Readable.fromWeb(response.body as WebReadableStream), guard, createWriteStream(file, { flags: 'wx' }), { signal: operation.signal }); }
      finally { await operation.download?.end(); }
      if (length !== manifest.archive.byteLength || digest.digest('hex') !== manifest.archive.sha256) throw new Error('The downloaded pack failed its public SHA-256 or size verification.');
      await operation.update('Verifying and importing the sealed pack', 85);
      const sealed = await extractSealedArchive(file, contained(directory, 'validated'), operation.signal);
      const matching = validateDistribution({ ...manifest, name: sealed.name, version: sealed.version, createdAt: sealed.createdAt, runtime: sealed.runtime,
        lock: { files: sealed.files, contentSha256: sealed.contentSha256, fileCount: sealed.fileCount, byteLength: sealed.byteLength } });
      if (matching.name !== manifest.name || matching.version !== manifest.version || matching.createdAt !== manifest.createdAt
        || JSON.stringify(matching.runtime) !== JSON.stringify(manifest.runtime) || matching.lock.contentSha256 !== manifest.lock.contentSha256) throw new Error('The sealed archive differs from the public pack manifest.');
      const result = await this.options.importArchive(file, operation);
      await operation.log(`Imported public pack ${manifest.name} ${manifest.version}; archive SHA-256 ${manifest.archive.sha256}.`); return result;
    } finally { await removeManaged(staging, directory); }
  }
  async publishGithub(input: { packId: string; repository: string; tag: string; token: string; archivePath: string;
    title?: string; notes?: string; draft?: boolean }, operation: OperationContext): Promise<DshPackPublication> {
    if (!this.options.request) throw new Error('GitHub release publication is unavailable.');
    const repository = dshRepositorySchema.parse(input.repository);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(input.tag) || input.tag.includes('..') || input.tag.endsWith('/')) throw new Error('Invalid release tag.');
    if (!input.token || input.token.length > 1024 || /[\r\n]/.test(input.token)) throw new Error('A valid GitHub token is required for this publication.');
    const title = input.title?.trim().slice(0, 200) || input.tag; const notes = input.notes?.slice(0, 30_000) ?? '';
    await operation.update('Verifying the public pack before publication', 5);
    const exported = await this.createDistribution(input.packId, input.archivePath, undefined, operation.signal);
    const auth = { authorization: `Bearer ${input.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
    const call = async (url: string, request: PackPublishRequest): Promise<Response> => {
      const parsed = httpsDownloadUrl(url);
      if (parsed.hostname !== 'api.github.com' && parsed.hostname !== 'uploads.github.com') throw new Error('Publication requests must use the official GitHub API hosts.');
      let response: Response;
      try { response = await this.options.request!(parsed.href, { ...request, headers: { ...request.headers, ...auth } }); }
      catch { throw new Error('The GitHub publication request failed. Check the network settings and repository permissions.'); }
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('Authenticated GitHub publication redirects are refused.'); }
      return response;
    };
    const releaseApi = `https://api.github.com/repos/${repository}/releases`; let release: Record<string, unknown>;
    const lookup = await call(`${releaseApi}/tags/${encodeURIComponent(input.tag)}`, { method: 'GET', signal: operation.signal });
    if (lookup.status === 404) {
      await lookup.body?.cancel(); const created = await call(releaseApi, { method: 'POST', signal: operation.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag_name: input.tag, name: title, body: notes, draft: true }) });
      release = object(await boundedJson(created, 2 * 1024 ** 2, operation.signal));
    } else release = object(await boundedJson(lookup, 2 * 1024 ** 2, operation.signal));
    if (!Number.isSafeInteger(release.id) || typeof release.upload_url !== 'string' || typeof release.html_url !== 'string') throw new Error('GitHub returned an invalid release identity.');
    const uploadBase = release.upload_url.replace(/\{.*$/, ''); const releaseId = Number(release.id);
    if (httpsDownloadUrl(uploadBase).hostname !== 'uploads.github.com' || !new URL(uploadBase).pathname.startsWith(`/repos/${repository}/releases/${releaseId}/assets`)) throw new Error('GitHub returned an unexpected upload destination.');
    const existingAssets = Array.isArray(release.assets) ? release.assets.map(object) : [];
    const upload = async (file: string, fileName: string, mime: string): Promise<string> => {
      const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('A publication asset is not a regular file.');
      const digest = await hashFile(file, operation.signal); const label = `worldlinebox-sha256:${digest}`;
      const existing = existingAssets.find(asset => asset.name === fileName);
      if (existing) {
        if (existing.label !== label || existing.size !== info.size || typeof existing.browser_download_url !== 'string') throw new Error('A release asset with this name already exists with different content. Choose a new pack version or release tag.');
        return githubAssetUrl(existing.browser_download_url);
      }
      const source = createReadStream(file); const streamedHash = createHash('sha256'); let streamedBytes = 0;
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { streamedBytes += chunk.length; streamedHash.update(chunk);
        callback(streamedBytes > info.size ? new Error('A publication asset changed during upload.') : null, chunk); } });
      // A rejected transport may stop before attaching its stream iterator.
      meter.on('error', () => undefined);
      source.on('error', error => meter.destroy(error)); source.pipe(meter);
      let asset: Record<string, unknown>;
      try {
        const response = await call(`${uploadBase}?name=${encodeURIComponent(fileName)}&label=${encodeURIComponent(label)}`, { method: 'POST', signal: operation.signal,
          headers: { 'content-type': mime, 'content-length': String(info.size) }, body: meter });
        asset = object(await boundedJson(response, 2 * 1024 ** 2, operation.signal));
        if (streamedBytes !== info.size || streamedHash.digest('hex') !== digest) throw new Error('A publication asset changed during upload. The release remains a draft for inspection.');
      } finally { source.destroy(); meter.destroy(); }
      if (asset.name !== fileName || asset.size !== info.size || typeof asset.browser_download_url !== 'string') throw new Error('GitHub did not confirm the complete uploaded asset. The release remains a draft for inspection.');
      return githubAssetUrl(asset.browser_download_url);
    };
    await operation.update('Uploading the sealed pack archive', 30); const archiveUrl = await upload(input.archivePath, exported.manifest.archive.fileName, 'application/zip');
    exported.manifest.archive.url = archiveUrl; await atomicJson(exported.manifestPath, exported.manifest);
    await operation.update('Uploading the public manifest and checksum', 75);
    const manifestUrl = await upload(exported.manifestPath, path.basename(exported.manifestPath), 'application/json');
    await upload(exported.checksumPath, path.basename(exported.checksumPath), 'text/plain');
    let draft = release.draft === true;
    if (input.draft === false && draft) {
      const finalized = await call(`${releaseApi}/${releaseId}`, { method: 'PATCH', signal: operation.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft: false }) });
      release = object(await boundedJson(finalized, 2 * 1024 ** 2, operation.signal)); draft = release.draft === true;
      if (draft) throw new Error('The assets uploaded, but GitHub did not publish the draft release.');
    }
    await operation.log(`Pack assets uploaded to ${repository}, tag ${input.tag}; ${draft ? 'draft retained' : 'published'}.`);
    return { repository, tag: input.tag, releaseUrl: githubAssetUrl(String(release.html_url)), archiveUrl, manifestUrl, draft };
  }
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function githubAssetUrl(value: string): string { const parsed = httpsDownloadUrl(value); if (parsed.hostname !== 'github.com') throw new Error('GitHub returned an unexpected public asset URL.'); return parsed.href; }
async function boundedJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Remote request failed (HTTP ${response.status}).`); }
  const chunks: Uint8Array[] = []; let length = 0; const reader = response.body.getReader();
  try { for (;;) { signal.throwIfAborted(); const next = await reader.read(); if (next.done) break; length += next.value.byteLength;
    if (length > limit) throw new Error('The remote JSON exceeds the size limit.'); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
async function managedDirectory(root: string, directory: string): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The distribution staging path is invalid.');
  let current = path.resolve(root); await mkdir(current, { recursive: true });
  if ((await lstat(current)).isSymbolicLink()) throw new Error('The distribution storage cannot be linked.');
  for (const segment of relative.split(path.sep)) { current = path.join(current, segment); await mkdir(current, { recursive: true });
    const info = await lstat(current); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('The distribution storage cannot be linked.'); }
}

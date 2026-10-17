import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, lstat, mkdir, open, readFile, readdir, rename } from './disk';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { DSH_OFFICIAL_WINDOWS_URL, dshRuntimeSchema, type DshRuntime } from '../../shared/dsh-launcher';
import { assertOwnedDirectory, contained, copyTree, hashFile, inventoryTree, readJson, removeManaged, safeRelative, type TreeInventory, type TreeHashCacheEntry, atomicJson } from './files';
import type { OperationContext } from './operations';
import { fetchHttpsDownload, type HttpsDownloadFetch } from './https-download';
import { atomicRuntimeJson, publishSealedArtifact, retryFileOperation } from './runtime-commit';
import { canonicalRuntimeEntryPaths } from './runtime-paths';
import type { DshNodePackRuntimeLock } from '../../shared/dsh-pack-runtime';
import { prepareNodeRuntimeLockInstall,validatePortableNodeRuntimeLock } from './node-runtime-lock';
import { nodeRuntimePayloadShaFromInventory } from './node-runtime-payload';
import { prepareOfficialNodeRuntime, validateNodeRuntimeInventory, validateOfficialNodeProgram, validateOfficialNodeRelease, type NodeInstallNetwork, type NodeInstallTools, type NodeRuntimeReceipt, type NodeRuntimeInstallPreparation, type OfficialNodeRelease } from './node-runtime-service';
import { RuntimeCompatibility, assertRuntimeCompatibility } from './runtime-compatibility';
import { supportsSharedDataRuntime, type DshCompatibilityReport } from '../../shared/dsh-runtime-compatibility';
import { RuntimeIntegrity } from './runtime-integrity';
import { DshTaskPreparationError } from './task-preparation';

export interface RuntimeServiceLike {
  list(): DshRuntime[];
  get(id: string): DshRuntime;
  directory(id: string): string;
  plan(id: string): { executable: string; cli: string; env: NodeJS.ProcessEnv };
  verify(id: string, signal?: AbortSignal): Promise<void>;
}

/** Read only small manifest entries without executing anything from the supplied ASAR. */
export async function readAsarEntry(archive: string, relative: string): Promise<Buffer> {
  const handle = await open(archive, 'r');
  try {
    const fileSize = (await handle.stat()).size;
    const prefix = Buffer.alloc(8);
    if ((await handle.read(prefix, 0, 8, 0)).bytesRead !== 8) throw new Error('Truncated DSH ASAR header.');
    const headerSize = prefix.readUInt32LE(4);
    if (headerSize < 8 || headerSize > 32 * 1024 * 1024) throw new Error('Invalid DSH ASAR header.');
    if (headerSize + 8 > fileSize) throw new Error('Truncated DSH ASAR file table.');
    const header = Buffer.alloc(headerSize);
    if ((await handle.read(header, 0, headerSize, 8)).bytesRead !== headerSize) throw new Error('Truncated DSH ASAR file table.');
    const jsonSize = header.readUInt32LE(4);
    if (jsonSize > headerSize - 8) throw new Error('Invalid ASAR file table.');
    type Entry = { files?: Record<string, Entry>; offset?: string; size?: number; unpacked?: boolean; link?: string };
    let entry: Entry = JSON.parse(header.subarray(8, 8 + jsonSize).toString('utf8')) as Entry;
    for (const part of safeRelative(relative).split('/')) { if (!entry.files?.[part]) throw new Error(`DSH package is missing ${relative}.`); entry = entry.files[part]; }
    if (entry.link || !Number.isSafeInteger(entry.size) || (entry.size ?? -1) < 0 || (entry.size ?? 0) > 4 * 1024 * 1024) throw new Error('Invalid ASAR manifest.');
    if (entry.unpacked) return readFile(contained(`${archive}.unpacked`, relative));
    const offset = Number(entry.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || 8 + headerSize + offset + entry.size! > fileSize) throw new Error('Invalid ASAR manifest offset.');
    const buffer = Buffer.alloc(entry.size!);
    if ((await handle.read(buffer, 0, buffer.length, 8 + headerSize + offset)).bytesRead !== buffer.length) throw new Error('Truncated ASAR manifest.');
    return buffer;
  } finally { await handle.close(); }
}
export async function readAsarJson(archive: string, relative: string): Promise<unknown> { return JSON.parse((await readAsarEntry(archive, relative)).toString('utf8')); }

export async function runTool(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = ''; let size = 0;
    const append = (chunk: Buffer) => { size += chunk.length; if (size > 32 * 1024 * 1024) { child.kill(); reject(new Error('Archive listing exceeded the allowed size.')); } else output += chunk.toString(); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`Archive tool exited with ${code}: ${output.slice(-1500)}`)));
  });
}

export function validate7zListing(listing: string): void {
  const entries = listing.split(/\r?\n----------\r?\n/).slice(1).join('\n').split(/\r?\n\r?\n/);
  if (!entries.length) throw new Error('Could not inspect installer contents.');
  const names = new Set<string>(); let bytes = 0;
  for (const block of entries) {
    const name = /^Path = ([^\r\n]+)\r?$/m.exec(block)?.[1];
    if (!name) continue;
    const relative = safeRelative(name);
    const key = relative.toLowerCase();
    if (names.has(key)) throw new Error('Archive contains colliding paths.');
    names.add(key);
    if (/^(?:Symbolic Link|Hard Link|Link) =/m.test(block) || /^Attributes = .*L/m.test(block) || /^Mode = l/m.test(block)) throw new Error('Installer contains unsupported links.');
    bytes += Number(/^Size = (\d+)$/m.exec(block)?.[1] ?? 0);
    if (!Number.isSafeInteger(bytes) || bytes > 6 * 1024 ** 3 || names.size > 150_000) throw new Error('Installer is too large.');
  }
  if (!names.size) throw new Error('Installer contains no files.');
}

export class RuntimeService implements RuntimeServiceLike {
  private readonly integrity = new RuntimeIntegrity();
  private records: DshRuntime[] = [];
  private importing = false;
  private readonly installingVersions = new Set<string>();
  private writes = Promise.resolve();
  private readonly compatibility: RuntimeCompatibility;
  private readonly sharedAdmissions = new Map<string, Promise<DshCompatibilityReport>>();
  private maintaining = false;
  constructor(private readonly options: {
    rootPath: string; sevenZipPath: string; onChanged: () => void;
    fetch?: HttpsDownloadFetch;
    nodeTools?: (signal: AbortSignal) => Promise<NodeInstallTools>;
    nodeInstallNetwork?: (signal: AbortSignal) => Promise<NodeInstallNetwork>;
  }) { this.compatibility = new RuntimeCompatibility({ rootPath: options.rootPath, runtimes: this, onChanged: options.onChanged }); }
  async init(): Promise<void> {
    await mkdir(path.join(this.options.rootPath, 'runtimes'), { recursive: true });
    const raw = await readJson<unknown[]>(path.join(this.options.rootPath, 'runtimes.json')) ?? [];
    this.records = raw.map(record => dshRuntimeSchema.parse(record));
    for (const record of this.records) {
      const destination = contained(path.join(this.options.rootPath, 'runtimes'), record.id);
      if (await lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; })) continue;
      // Crash before the index commit: restore the still-registered artifact. After the
      // index commit the ID is absent, so a pending physical deletion cannot resurrect.
      const trashRoot = path.join(this.options.rootPath, 'runtime-trash');
      if (await lstat(trashRoot).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; })) await assertOwnedDirectory(this.options.rootPath, trashRoot);
      const entries = await readdir(trashRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith(`${record.id}-`)) continue;
        const source = contained(trashRoot, entry.name);
        if ((await this.readCompleteArtifact(source, record.id))?.contentSha256 === record.contentSha256) {
          await assertOwnedDirectory(this.options.rootPath, source); await assertOwnedDirectory(this.options.rootPath, path.dirname(destination));
          await retryFileOperation(() => rename(source, destination)); break;
        }
      }
    }
    for(const record of this.records)if(record.adapter==='node-cli-web-v1'&&(!record.npmIntegrity||!record.dependencyLockSha256)){
      const receipt=await this.nodeSourceIdentity(record.id);
      record.npmIntegrity=receipt.npmIntegrity;record.dependencyLockSha256=receipt.dependencyLockSha256;
    }
    // A fully sealed directory survives a crash between directory commit and index commit.
    for (const entry of await readdir(path.join(this.options.rootPath, 'runtimes'), { withFileTypes: true })) {
      if (!entry.isDirectory() || this.records.some(record => record.id === entry.name)) continue;
      const directory = path.join(this.options.rootPath, 'runtimes', entry.name);
      const record = await this.readCompleteArtifact(directory, entry.name);
      if (record) this.records.push(record);
    }
    await this.save();
    await this.compatibility.init();
  }
  list(): DshRuntime[] { return this.records.map(record => ({ ...record, compatibility: this.compatibility.report(record) })); }
  get(id: string): DshRuntime { const record = this.records.find(record => record.id === id); if (!record) throw new Error('This DSH runtime is not installed.'); return { ...record, compatibility: this.compatibility.report(record) }; }
  checkCompatibility(id: string, operation?: OperationContext): Promise<DshCompatibilityReport> {
    this.sharedAdmissions.delete(id); return this.compatibility.check(this.get(id), operation);
  }
  async assertSharedCompatible(id: string, signal?: AbortSignal): Promise<void> {
    const runtime = this.get(id);
    if (!supportsSharedDataRuntime(runtime)) {
      let pending = this.sharedAdmissions.get(id);
      if (!pending) { pending = this.compatibility.check(runtime); this.sharedAdmissions.set(id, pending); }
      if (!signal) await pending;
      else {
        signal.throwIfAborted();
        let removeAbort = () => {};
        try { await Promise.race([pending, new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
          removeAbort = () => signal.removeEventListener('abort', abort);
          if (signal.aborted) abort();
        })]); } finally { removeAbort(); }
      }
    }
    // Re-read evidence even after a cached admission: invalidation must fail closed.
    await assertRuntimeCompatibility(this.options.rootPath, this.get(id));
  }
  unchecked(): DshRuntime[] { return this.list().filter(record => this.compatibility.needsCheck(record)); }
  directory(id: string): string { this.get(id); return contained(path.join(this.options.rootPath, 'runtimes'), `${id}/program`); }
  plan(id: string) {
    const runtime = this.get(id);
    return { ...canonicalRuntimeEntryPaths(this.directory(id), runtime.adapter),
      env: runtime.adapter === 'node-cli-web-v1' ? {} : { ELECTRON_RUN_AS_NODE: '1' } };
  }
  async nodeSourceIdentity(id:string,signal?:AbortSignal):Promise<NodeRuntimeReceipt>{
    const record=this.get(id);if(record.adapter!=='node-cli-web-v1')throw new Error('This runtime does not have an official Node source lock.');
    const receipt=await validateOfficialNodeProgram(this.directory(id),signal);
    if(receipt.version!==record.version||receipt.nodeVersion!==record.nodeVersion||receipt.sourceSha256!==record.sourceSha256)throw new Error('Node runtime record does not match its sealed source identity.');
    return receipt;
  }
  async verify(id: string, signal?: AbortSignal, force = false): Promise<void> {
    const record = this.get(id);
    try {
      await this.integrity.verify(path.dirname(this.directory(id)), async () => {
        const sealed = await readJson<TreeInventory>(contained(path.join(this.options.rootPath, 'runtimes'), `${id}/seal.json`));
        const cache = new Map<string, TreeHashCacheEntry>();
        const indexPath = path.join(this.options.rootPath, 'integrity', `${id}.json`);
        const indexDirectory = path.dirname(indexPath); await mkdir(indexDirectory, { recursive: true }); await assertOwnedDirectory(this.options.rootPath, indexDirectory);
        const stored = await lstat(indexPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (!force && stored?.isFile() && !stored.isSymbolicLink() && stored.size < 48 * 1024 * 1024) {
          const index = await readJson<{ digest: string; entries: Array<[string, TreeHashCacheEntry]> }>(indexPath).catch(() => undefined);
          if (index?.digest === record.contentSha256 && Array.isArray(index.entries) && index.entries.length <= 150000) {
            const expected = new Map(sealed?.files.map(file => [file.path, file.sha256]));
            for (const entry of index.entries) if (Array.isArray(entry) && entry.length === 2 && expected.get(entry[0]) === entry[1]?.sha256 && typeof entry[1]?.fingerprint === 'string' && entry[1].fingerprint.length < 300) cache.set(entry[0], entry[1]);
          }
        }
        const current = await inventoryTree(this.directory(id), AbortSignal.timeout(300000), undefined, cache);
        if (!sealed || current.contentSha256 !== sealed.contentSha256 || current.contentSha256 !== record.contentSha256) throw new Error('Runtime seal mismatch.');
        await atomicJson(indexPath, { digest: record.contentSha256, entries: current.files.map(file => [file.path, cache.get(file.path)]) });
      }, signal, force);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof Error && error.name === 'TimeoutError') throw new DshTaskPreparationError('integrity', '运行文件完整性检查超时，请稍后重试；存档未修改。');
      const message = 'DSH runtime files changed or are missing. Import a clean installer; existing instance data is preserved.';
      await this.compatibility.invalidate(record, message); throw new DshTaskPreparationError('integrity', message);
    }
  }
  cancelChecks(): void { this.compatibility.cancel(); }
  close(): void { this.cancelChecks(); this.integrity.close(); }
  async delete(id: string, referenced: boolean): Promise<void> {
    if (referenced) throw new Error('此运行版本仍被实例、快照、整合包或任务引用，请先处理页面列出的引用。');
    if (this.importing || this.installingVersions.size || this.maintaining) throw new Error('请等待版本安装或清理操作结束。');
    const record = this.get(id); this.maintaining = true;
    this.integrity.forget(path.dirname(this.directory(id)));
    const source = contained(path.join(this.options.rootPath, 'runtimes'), id);
    const trash = path.join(this.options.rootPath, 'runtime-trash', `${id}-${randomUUID()}`);
    try {
      const info = await lstat(source);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('运行版本目录不是受管的普通目录，已停止删除。');
      await assertOwnedDirectory(this.options.rootPath, source);
      await mkdir(path.dirname(trash), { recursive: true });
      await assertOwnedDirectory(this.options.rootPath, path.dirname(trash));
      await retryFileOperation(() => rename(source, trash));
      const previous = this.records; this.records = this.records.filter(item => item.id !== id);
      try { await this.save(); }
      catch (error) { this.records = previous; await retryFileOperation(() => rename(trash, source)); throw error; }
      this.options.onChanged();
      // A failed physical removal stays in runtime-trash, which startup never re-registers.
      try { await removeManaged(this.options.rootPath, trash); }
      catch (error) { throw new Error('版本已从安装列表移除，但部分文件仍被系统占用。请稍后使用「清理下载缓存」继续清理。', { cause: error }); }
      await removeManaged(this.options.rootPath, path.join(this.options.rootPath, 'compatibility', `${id}.json`));
      await removeManaged(this.options.rootPath, path.join(this.options.rootPath, 'integrity', `${id}.json`));
      if (!this.records.some(item => item.sourceSha256 === record.sourceSha256)) {
        await removeManaged(this.options.rootPath, path.join(this.options.rootPath, 'cache', `${record.sourceSha256}.exe`));
      }
    } finally { this.maintaining = false; this.options.onChanged(); }
  }
  async cleanup(operation: OperationContext): Promise<void> {
    if (this.importing || this.installingVersions.size || this.maintaining) throw new Error('请等待版本安装或清理操作结束。');
    this.maintaining = true;
    try {
      for (const name of ['cache', 'staging', 'quarantine', 'runtime-trash', 'compatibility-scratch']) {
        const directory = path.join(this.options.rootPath, name);
        const present = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (!present) continue;
        await assertOwnedDirectory(this.options.rootPath, directory);
        const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
        for (const entry of entries) {
          operation.signal.throwIfAborted();
          if (name === 'cache' && !/^(?:[a-f0-9]{64}\.exe|[a-z0-9-]+\.download)$/.test(entry.name)) continue;
          const target = contained(directory, entry.name); const info = await lstat(target);
          if (info.isSymbolicLink()) throw new Error(`拒绝清理链接目录：${name}/${entry.name}`);
          await operation.update(`正在清理 ${name}/${entry.name}`);
          await removeManaged(this.options.rootPath, target); await operation.log(`已清理 ${name}/${entry.name}`);
        }
      }
    } finally { this.maintaining = false; this.options.onChanged(); }
  }
  private save(): Promise<void> {
    const records = structuredClone(this.records);
    this.writes = this.writes.catch(() => undefined).then(() => atomicRuntimeJson(path.join(this.options.rootPath, 'runtimes.json'), records));
    return this.writes;
  }
  private async readCompleteArtifact(directory: string, id?: string, signal?: AbortSignal): Promise<DshRuntime | undefined> {
    try {
      const record = dshRuntimeSchema.safeParse(await readJson(path.join(directory, 'artifact.json')));
      if (!record.success || (id && record.data.id !== id)
        || record.data.id !== `runtime-${record.data.contentSha256.slice(0, 24)}`) return undefined;
      const seal = await readJson<TreeInventory>(path.join(directory, 'seal.json'));
      if (!seal || seal.contentSha256 !== record.data.contentSha256) return undefined;
      const current = await inventoryTree(path.join(directory, 'program'), signal);
      if (current.contentSha256 !== record.data.contentSha256 || current.fileCount !== record.data.fileCount
        || current.byteLength !== record.data.byteLength || JSON.stringify(current) !== JSON.stringify(seal)) return undefined;
      return record.data;
    } catch (error) { signal?.throwIfAborted(); if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM') throw error; return undefined; }
  }
  private async retainedArtifact(sourceDigest: string, operation: OperationContext): Promise<string | undefined> {
    const stagingRoot = path.join(this.options.rootPath, 'staging');
    const entries = await readdir(stagingRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
      operation.signal.throwIfAborted();
      if (!entry.isDirectory()) continue;
      const artifact = path.join(stagingRoot, entry.name, 'artifact');
      const candidate = dshRuntimeSchema.safeParse(await readJson(path.join(artifact, 'artifact.json')).catch(() => undefined));
      if (!candidate.success || candidate.data.sourceSha256 !== sourceDigest) continue;
      if (await this.readCompleteArtifact(artifact, candidate.data.id, operation.signal)) return artifact;
    }
    return undefined;
  }
  private async commitArtifact(artifact: string, record: DshRuntime, seal: TreeInventory, operation: OperationContext): Promise<DshRuntime> {
    const destination = path.join(this.options.rootPath, 'runtimes', record.id);
    const present = await lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (present) {
      if (!present.isDirectory() || present.isSymbolicLink()) throw new Error('The runtime destination is not an owned directory.');
      const committed = await this.readCompleteArtifact(destination, record.id, operation.signal);
      if (committed?.contentSha256 === record.contentSha256) record = committed;
      else {
        if (this.records.some(item => item.id === record.id)) throw new Error('An installed runtime changed; refusing to overwrite files used by existing instances.');
        // Preserve an unregistered interrupted copy outside the next destination.
        const quarantine = path.join(this.options.rootPath, 'quarantine', `${record.id}-${randomUUID()}`);
        await mkdir(path.dirname(quarantine), { recursive: true });
        await retryFileOperation(() => rename(destination, quarantine), { signal: operation.signal });
        await operation.log(`Retained incomplete runtime output at ${quarantine}.`);
      }
      if (committed?.contentSha256 === record.contentSha256) return this.register(record, operation);
    }
    await operation.update('committing', 96);
    await publishSealedArtifact(artifact, destination, {
      signal: operation.signal,
      verifyCopy: async directory => {
        const copied = await inventoryTree(path.join(directory, 'program'), operation.signal);
        if (JSON.stringify(copied) !== JSON.stringify(seal)) throw new Error('The runtime copy did not match its sealed file inventory.');
      },
      onCopyFallback: async () => {
        await operation.update('committing: verifying file copy', 97);
        await operation.log('Windows kept the extracted files open; copying and verifying all bytes before registration.');
      },
    });
    return this.register(record, operation);
  }
  private async register(record: DshRuntime, operation: OperationContext): Promise<DshRuntime> {
    // Serialize only the short index commit. Downloads and extraction remain independent.
    this.writes = this.writes.catch(() => undefined).then(async () => {
      operation.signal.throwIfAborted();
      const existing = this.records.find(item => item.id === record.id);
      if (existing) {
        if (existing.contentSha256 !== record.contentSha256) throw new Error('Runtime identity collides with different content.');
        return;
      }
      const records = [...this.records, record];
      await atomicRuntimeJson(path.join(this.options.rootPath, 'runtimes.json'), records, operation.signal);
      this.records = records; this.options.onChanged();
    });
    await this.writes;
    await operation.log(`Imported DSH ${record.version}; source SHA-256 ${record.sourceSha256}; sealed ${record.fileCount} files.`);
    await operation.update('正在隔离检测共享存档兼容性');
    await this.checkCompatibility(record.id, operation);
    return this.get(record.id);
  }
  async download(operation: OperationContext, expectedSha256?: string): Promise<DshRuntime> {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Official DSH installer management currently requires Windows x64.');
    const cache = path.join(this.options.rootPath, 'cache'); await mkdir(cache, { recursive: true });
    const temporary = path.join(cache, `${operation.id}.download`);
    const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(15 * 60_000)]);
    try {
      await operation.update('downloading', 0);
      const response = await fetchHttpsDownload(DSH_OFFICIAL_WINDOWS_URL, this.options.fetch ?? globalThis.fetch, signal);
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Could not download the official DSH installer (HTTP ${response.status}).`);
      }
      const length = Number(response.headers.get('content-length') ?? 0);
      // A proxy may still compress despite our identity request. Fetch bodies are decoded.
      const encoded = response.headers.get('content-encoding');
      const total = (!encoded || encoded === 'identity') && Number.isSafeInteger(length) && length > 0 ? length : 0; let loaded = 0; let reported = 0;
      if (total > 2 * 1024 ** 3) { await response.body.cancel(); throw new Error('Installer download exceeded 2 GiB.'); }
      await operation.download?.begin(total || undefined);
      const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        loaded += chunk.length;
        if (loaded > 2 * 1024 ** 3) { callback(new Error('Installer download exceeded 2 GiB.')); return; }
        const progress = total > 0 ? Math.min(95, Math.floor(loaded / total * 95)) : 0;
        void (async () => {
          await operation.download?.wait(); operation.download?.report(loaded);
          if (progress > reported + 2) { reported = progress; await operation.update('downloading', progress); }
          callback(null, chunk);
        })().catch(callback);
      } });
      try { await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(temporary, { flags: 'wx' }), { signal }); }
      finally { await operation.download?.end(); }
      if (total && loaded !== total) throw new Error('The installer download was incomplete.');
      const digest = await hashFile(temporary, signal);
      if (expectedSha256 && digest !== expectedSha256) throw new Error('Downloaded installer SHA-256 did not match.');
      const cached = path.join(cache, `${digest}.exe`);
      try { await retryFileOperation(() => rename(temporary, cached), { signal }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      return await this.import(cached, 'installer', DSH_OFFICIAL_WINDOWS_URL, operation, digest);
    } finally { await removeManaged(this.options.rootPath, temporary); }
  }
  /** Install one real, exact official npm release without changing any existing instance. */
  async installNode(release: OfficialNodeRelease, operation: OperationContext,prepareInstall?:NodeRuntimeInstallPreparation,expectedLock?:DshNodePackRuntimeLock): Promise<DshRuntime> {
    release = validateOfficialNodeRelease(release);
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Managed DSH Node runtimes currently require Windows x64.');
    if (this.importing || this.maintaining || this.installingVersions.has(release.version)) throw new Error('This runtime version is already being installed or cleaned.');
    if (!this.options.nodeTools || !this.options.nodeInstallNetwork) throw new Error('Managed Node tools and installation network settings are unavailable.');
    this.installingVersions.add(release.version);
    const staging = path.join(this.options.rootPath, 'staging', randomUUID());
    let retained = false;
    try {
      const artifact = path.join(staging, 'artifact'); const program = path.join(artifact, 'program');
      const tools = await this.options.nodeTools(operation.signal);
      const receipt = await prepareOfficialNodeRuntime({ release, staging, program, tools,
        contentCache: path.join(this.options.rootPath, 'npm-cache'),
        network: () => this.options.nodeInstallNetwork!(operation.signal),
        fetch: this.options.fetch ?? globalThis.fetch, operation,prepareInstall });
      if(expectedLock&&(receipt.dependencyLockSha256!==expectedLock.dependencyLockSha256||receipt.nodeExecutableSha256!==expectedLock.nodeExecutableSha256
        ||receipt.npmVersion!==expectedLock.npmVersion||receipt.nodeVersion!==expectedLock.nodeVersion||receipt.npmIntegrity!==expectedLock.npmIntegrity||receipt.sourceSha256!==expectedLock.sourceSha256))throw new Error('Replayed runtime does not match the portable source identity.');
      await operation.update('sealing official Node runtime', 80);
      const seal = await inventoryTree(program, operation.signal, async (count) => {
        if (count % 500 === 0) await operation.update('sealing official Node runtime', Math.min(94, 80 + count / 2000));
      });
      if(expectedLock&&nodeRuntimePayloadShaFromInventory(seal)!==expectedLock.payloadSha256)throw new Error('Replayed runtime SDK and binary payload does not match the portable source identity.');
      await validateNodeRuntimeInventory(program, release.version, seal, operation.signal);
      const existing = this.records.find(record => record.contentSha256 === seal.contentSha256);
      if (existing) { await this.verify(existing.id, operation.signal); if (!existing.compatibility) await this.checkCompatibility(existing.id, operation); return this.get(existing.id); }
      const record = dshRuntimeSchema.parse({
        id: `runtime-${seal.contentSha256.slice(0, 24)}`, version: release.version,
        nodeVersion: receipt.nodeVersion, npmVersion: receipt.npmVersion,
        npmIntegrity:receipt.npmIntegrity,dependencyLockSha256:receipt.dependencyLockSha256,
        platform: 'win32-x64', adapter: 'node-cli-web-v1',
        source: `npm:@deepseek-ai/dsh@${release.version}`, sourceSha256: receipt.sourceSha256,
        contentSha256: seal.contentSha256, installedAt: new Date().toISOString(),
        fileCount: seal.fileCount, byteLength: seal.byteLength,
      });
      await atomicRuntimeJson(path.join(artifact, 'seal.json'), seal, operation.signal);
      await atomicRuntimeJson(path.join(artifact, 'artifact.json'), record, operation.signal);
      retained = true;
      const committed = await this.commitArtifact(artifact, record, seal, operation);
      retained = false; return committed;
    } finally {
      this.installingVersions.delete(release.version);
      if (retained) await operation.log(`Installation was not registered; sealed runtime retained at ${staging}.`).catch(() => undefined);
      else {
        try { await retryFileOperation(() => removeManaged(this.options.rootPath, staging)); }
        catch { await operation.log('Official runtime scratch cleanup deferred.').catch(() => undefined); }
      }
    }
  }
  async installNodeFromLock(lock:DshNodePackRuntimeLock,lockFile:string,operation:OperationContext):Promise<DshRuntime>{
    await validatePortableNodeRuntimeLock(lock,lockFile,operation.signal);
    const release={version:lock.version,tarball:`https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${lock.version}.tgz`,integrity:lock.npmIntegrity};
    const result=await this.installNode(release,operation,options=>prepareNodeRuntimeLockInstall({...options,lock,lockFile}),lock);
    const receipt=await this.nodeSourceIdentity(result.id,operation.signal);
    if(receipt.dependencyLockSha256!==lock.dependencyLockSha256||receipt.nodeExecutableSha256!==lock.nodeExecutableSha256
      ||receipt.npmVersion!==lock.npmVersion||receipt.nodeVersion!==lock.nodeVersion||receipt.npmIntegrity!==lock.npmIntegrity||receipt.sourceSha256!==lock.sourceSha256)throw new Error('Replayed runtime does not match the portable source identity.');
    return result;
  }
  async import(source: string, kind: 'installer' | 'directory', provenance: string, operation: OperationContext, knownDigest?: string): Promise<DshRuntime> {
    if (this.importing || this.maintaining) throw new Error('Another runtime import or cleanup is running.');
    this.importing = true;
    let staging = path.join(this.options.rootPath, 'staging', randomUUID());
    let retained = false;
    try {
      let sourceDigest = knownDigest;
      if (kind === 'installer') {
        sourceDigest ??= await hashFile(source, operation.signal);
        const prepared = await this.retainedArtifact(sourceDigest, operation);
        if (prepared) {
          staging = path.dirname(prepared); retained = true;
          await operation.log('Retrying the preserved, verified runtime without downloading or extracting again.');
          const record = dshRuntimeSchema.parse(await readJson(path.join(prepared, 'artifact.json')));
          const seal = (await readJson<TreeInventory>(path.join(prepared, 'seal.json')))!;
          const result = await this.commitArtifact(prepared, record, seal, operation);
          retained = false; return result;
        }
      }
      const artifactStage = path.join(staging, 'artifact');
      const program = path.join(artifactStage, 'program');
      await mkdir(artifactStage, { recursive: true });
      await operation.update('extracting', 0);
      if (kind === 'installer') {
        const listing = await runTool(this.options.sevenZipPath, ['l', '-slt', source], operation.signal);
        validate7zListing(listing);
        // SFX extracts straight into its final staging layout. NSIS wrappers use
        // a separate scratch tree; their payload also extracts straight there.
        const wrapped = /^Path = (?:\$PLUGINSDIR[\\/])?app-64\.7z\r?$/m.test(listing);
        const outer = wrapped ? path.join(staging, 'installer') : program;
        await runTool(this.options.sevenZipPath, ['x', '-y', `-o${outer}`, source], operation.signal);
        const candidates = [path.join(outer, '$PLUGINSDIR', 'app-64.7z'), path.join(outer, 'app-64.7z')];
        let extractedPayload = false;
        for (const nested of candidates) if (await lstat(nested).catch(() => undefined)) {
          validate7zListing(await runTool(this.options.sevenZipPath, ['l', '-slt', nested], operation.signal));
          await runTool(this.options.sevenZipPath, ['x', '-y', `-o${program}`, nested], operation.signal); extractedPayload = true; break;
        }
        if (wrapped && !extractedPayload) throw new Error('The installer wrapper is missing its inspected runtime payload.');
      } else await copyTree(source, program, { signal: operation.signal });
      let version:string;let nodeVersion:string;let electronVersion:string|undefined;let nodeReceipt:NodeRuntimeReceipt|undefined;
      if(kind==='directory'&&await lstat(path.join(program,'node-runtime.json')).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;})){
        nodeReceipt=await validateOfficialNodeProgram(program,operation.signal);
        version=nodeReceipt.version;nodeVersion=nodeReceipt.nodeVersion;sourceDigest??=nodeReceipt.sourceSha256;
      }else{
        const archive = path.join(program, 'resources', 'app.asar');
        const manifest = await readAsarJson(archive, 'package.json') as { name?: string; version?: string;dependencies?:{electron?:string} };
        const runtime = await readAsarJson(archive, 'dsh/desktop-runtime.json') as { release?: { nodeVersion?: string }; platform?: string; arch?: string };
        const host = await readAsarJson(archive, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/package.json') as { version?: string };
        if (manifest.name !== '@deepseek-ai/dsh-desktop' || !manifest.version || host.version !== manifest.version || runtime.platform !== 'win32' || runtime.arch !== 'x64') throw new Error('This installer does not contain a supported Windows x64 DSH Desktop CLI runtime.');
        // Checking the published adapter entry never executes untrusted installer code.
        await readAsarJson(archive, 'dsh/node_modules/@deepseek-ai/dsh/package.json');
        await readAsarEntry(archive, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
        if (!(await lstat(path.join(program, 'DeepSeek Harness.exe'))).isFile()) throw new Error('DSH executable is missing.');
        version=manifest.version;nodeVersion=runtime.release?.nodeVersion??'unknown';electronVersion=manifest.dependencies?.electron??'bundled';
      }
      await operation.update('verifying', 80);
      const seal = await inventoryTree(program, operation.signal, async (count, file) => {
        if (count % 250 === 0) await operation.update(`verifying: ${file}`, Math.min(94, 80 + count / 1000));
      });
      if(nodeReceipt)await validateNodeRuntimeInventory(program,version,seal,operation.signal);
      const existing = this.records.find(record => record.contentSha256 === seal.contentSha256);
      if (existing) { await this.verify(existing.id, operation.signal); return { ...existing }; }
      const id = `runtime-${seal.contentSha256.slice(0, 24)}`;
      const record: DshRuntime = dshRuntimeSchema.parse({ id, version,nodeVersion,electronVersion,
        npmVersion:nodeReceipt?.npmVersion,npmIntegrity:nodeReceipt?.npmIntegrity,dependencyLockSha256:nodeReceipt?.dependencyLockSha256,
        platform: 'win32-x64', adapter: nodeReceipt?'node-cli-web-v1':'desktop-cli-web-v1', source: provenance,
        sourceSha256: sourceDigest ?? seal.contentSha256, contentSha256: seal.contentSha256,
        installedAt: new Date().toISOString(), fileCount: seal.fileCount, byteLength: seal.byteLength });
      operation.signal.throwIfAborted();
      await atomicRuntimeJson(path.join(artifactStage, 'seal.json'), seal, operation.signal);
      await atomicRuntimeJson(path.join(artifactStage, 'artifact.json'), record, operation.signal);
      retained = true;
      const result = await this.commitArtifact(artifactStage, record, seal, operation);
      retained = false; return result;
    } finally {
      this.importing = false;
      if (retained) await operation.log(`Installation was not registered; verified output is preserved at ${staging} for retry.`).catch(() => undefined);
      else {
        // Obsolete scratch cleanup must not hide a completed commit or its real error.
        try { await retryFileOperation(() => removeManaged(this.options.rootPath, staging)); }
        catch (error) { await operation.log(`Scratch cleanup deferred (${(error as NodeJS.ErrnoException).code ?? 'error'}): ${staging}`).catch(() => undefined); }
      }
    }
  }
}

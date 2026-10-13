import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from './disk';
import path from 'node:path';
import { z } from 'zod';
import { dshPackSchema, type DshInstance, type DshLauncherRequest, type DshLauncherResponse, type DshPack, type DshRuntime } from '../../shared/dsh-launcher';
import { dshNodePackRuntimeLockSchema, dshPackRuntimeV1Schema, type DshNodePackRuntimeLock } from '../../shared/dsh-pack-runtime';
import { extractSealedArchive, parseSealedManifest, validateSealedDirectory, writeSealedArchive, type SealedArchiveManifest } from './archive';
import { atomicJson, contained, copyTree, inventoryTree, readJson, removeManaged } from './files';
import type { OperationContext, OperationStore } from './operations';
import type { RuntimeServiceLike } from './runtime-service';
import { installPackPnpmMetadata, sealPackPnpmMetadata, validatePackPnpmMetadata } from './pack-pnpm-metadata';
import { writeSharedModels } from './shared-settings';
import { validateOfficialNodeProgram } from './node-runtime-service';
import { validatePortableNodeRuntimeLock } from './node-runtime-lock';
import { nodeRuntimePayloadSha256 } from './node-runtime-payload';

export interface PackInstanceService {
  list(): DshInstance[];
  create(name: string, runtimeId: string, operation?: OperationContext): Promise<DshInstance>;
  getRoot(id: string): string;
  withStoppedInstance<T>(id: string, work: () => Promise<T>): Promise<T>;
  remove(id: string): Promise<void>;
}
const packShape = { name: z.string().trim().min(1).max(100), version: z.string().trim().min(1).max(100), createdAt: z.string() };
const packMetadataSchema = z.discriminatedUnion('format', [
  z.object({ ...packShape, format: z.literal('worldlinebox-dshpack-v1'), runtime: dshPackRuntimeV1Schema }),
  z.object({ ...packShape, format: z.literal('worldlinebox-dshpack-v2'), runtime: dshNodePackRuntimeLockSchema }),
]);
export type PackManifest = z.infer<typeof packMetadataSchema> & SealedArchiveManifest;

function parsePackManifest(value: unknown): PackManifest {
  const manifest = { ...parseSealedManifest(value), ...packMetadataSchema.parse(value) };
  for (const file of manifest.files) {
    if (file.path !== 'home/cordis.patch.yml' && !(manifest.format === 'worldlinebox-dshpack-v2' && file.path === 'runtime-lock/package-lock.json')
      && !/^(?:home\/(?:profiles|skills|skills-disabled)|agents\/skills)\//.test(file.path)) throw new Error('A DSH pack contains private instance data or an unexpected file.');
    if (excludedProfilePath(file.path)) throw new Error('A DSH pack contains credentials, environment files or private state.');
  }
  return manifest;
}

/** This audit rejects known nonportable configuration and explicit secrets; plugin code retains its native permissions. */
export function auditPortableConfiguration(text: string, file: string): void {
  if (/\bsk-[a-z0-9_-]{8,}\b/i.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw new Error(`A secret was found in ${file}. Remove it before packaging.`);
  if (/(?:^|[\s"'=:(])(?:[a-z]:[\\/]|\\\\[^\s]+\\)/im.test(text)) throw new Error(`An absolute filesystem path was found in ${file}. Use instance-relative paths.`);
  if (/\b(?:file|link):[\\/]?|\bworkspace:/i.test(text)) throw new Error(`A local dependency reference was found in ${file}. Install a portable dependency first.`);
  for (const line of text.split(/\r?\n/)) {
    const pathValue = /["']?(?:path|root|directory|dir|home|agentsHome|dshHome|cwd|source|workingDirectory)["']?\s*[:=]\s*["']?(\S+)/i.exec(line)?.[1];
    if (pathValue?.startsWith('/') || pathValue?.startsWith('~') || /\b(?:homedir\s*\(|process\.env\.(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA))/i.test(line)) throw new Error(`An external filesystem path was found in ${file}. Use instance-relative paths.`);
    const secret = /(?:^\s*(?:-\s*)?|[,{]\s*)["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*(.+)/i.exec(line)?.[1]?.trim().replace(/[,#].*$/, '').replace(/^['"]|['"]$/g, '');
    if (secret && !/^(?:null|undefined|false|\{\}|\[\]|!!js\s+|process\.env\.|\$\{|\$[A-Z_]|<|\[redacted\]|your[_ -]|example|placeholder)/i.test(secret)) throw new Error(`A credential value was found in ${file}. Package credential references instead.`);
  }
}

function excludedProfilePath(relative: string): boolean {
  if (!relative) return false;
  const segments = relative.replaceAll('\\', '/').split('/');
  if (segments.some(segment => /^\.env(?:\.|$)|^\.credentials(?:\.|$)|^\.anonymous-user-id$/i.test(segment))) return true;
  if (segments.includes('node_modules')) return false;
  return segments.some(segment => /^\.env(?:\.|$)|^\.credentials(?:\.|$)|^\.anonymous-user-id$|^(?:sessions|storages|attachments|logs|cache|caches)$/i.test(segment)) || segments.at(-1) === 'lock' || segments.at(-1) === 'cordis.yml';
}

async function auditPackData(directory: string): Promise<void> {
  const walk = async (folder: string, prefix: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('A portable pack cannot contain filesystem links.');
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') await walk(target, relative); }
      else if (entry.isFile() && /(?:\.ya?ml|\.json|\.toml|\.ini|\.cfg|\.conf|\.md|\.txt|\.py|\.js|\.ts|\.sh|\.ps1)$/i.test(entry.name)) {
        const size = (await lstat(target)).size;
        if (size > 8 * 1024 ** 2) throw new Error(`Configuration file is too large to audit: ${relative}`);
        const text = await readFile(target, 'utf8');
        if (/(?:\.ya?ml|\.json|\.toml|\.ini|\.cfg|\.conf)$/i.test(entry.name)) auditPortableConfiguration(text, relative);
        else if (/\bsk-[a-z0-9_-]{8,}\b/i.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw new Error(`A secret was found in ${relative}. Remove it before packaging.`);
      }
    }
  };
  await walk(directory, '');
}

async function removeSharedModelSettings(directory: string): Promise<void> {
  const homePatch = path.join(directory, 'home', 'cordis.patch.yml');
  const homeText = await readFile(homePatch, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (homeText !== undefined) await writeFile(homePatch, writeSharedModels(homeText, {}));
  const profiles = path.join(directory, 'home', 'profiles');
  for (const entry of await readdir(profiles, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!entry.isDirectory()) continue;
    const patch = path.join(profiles, entry.name, 'cordis.patch.yml');
    const text = await readFile(patch, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (text !== undefined) await writeFile(patch, writeSharedModels(text, {}));
  }
}

export class PackService {
  private records: DshPack[] = [];
  private writes = Promise.resolve();
  constructor(private readonly options: { rootPath: string; runtimes: RuntimeServiceLike; instances: PackInstanceService; operations: OperationStore; onChanged: () => void;
    ensureRuntime?: (lock: DshNodePackRuntimeLock, lockFile: string, operation: OperationContext) => Promise<DshRuntime> }) {}
  private get directory(): string { return path.join(this.options.rootPath, 'packs'); }
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const values = await readJson<unknown[]>(path.join(this.options.rootPath, 'packs.json')) ?? [];
    this.records = values.map(value => dshPackSchema.parse(value));
    let recovered = false;
    for (const entry of await readdir(this.directory)) {
      if (/^\.staging-[a-f0-9-]{36}$/.test(entry)) { await removeManaged(this.directory, contained(this.directory, entry)); continue; }
      if (!/^[a-f0-9-]{36}$/.test(entry) || this.records.some(record => record.id === entry)) continue;
      // A committed directory can survive a crash immediately before registry persistence.
      try {
        const manifest = parsePackManifest(await readJson(path.join(this.directory, entry, 'manifest.json')));
        await validateSealedDirectory(path.join(this.directory, entry, 'data'), manifest);
        await auditPackData(path.join(this.directory, entry, 'data'));
        await validatePackPnpmMetadata(path.join(this.directory, entry, 'data'));
        await this.validateRuntimeLock(manifest, path.join(this.directory, entry, 'data'));
        const runtime = await this.resolveRuntime(manifest);
        this.records.push({ id: entry, name: manifest.name, version: manifest.version, runtimeId: runtime.id, runtimeVersion: runtime.version,
          createdAt: manifest.createdAt, contentSha256: manifest.contentSha256, fileCount: manifest.fileCount, byteLength: manifest.byteLength });
        recovered = true;
      } catch { /* Retain an unregistered directory for manual recovery; never expose unverified bytes. */ }
    }
    if (recovered) await this.save();
  }
  list(): DshPack[] { return this.records.map(record => ({ ...record })); }
  private get(id: string): DshPack {
    const result = this.records.find(record => record.id === id);
    if (!result) throw new Error('This DSH pack is not available.');
    return { ...result };
  }
  private save(): Promise<void> {
    const values = this.list();
    this.writes = this.writes.catch(() => undefined).then(() => atomicJson(path.join(this.options.rootPath, 'packs.json'), values));
    return this.writes;
  }
  private async nodeIdentity(runtime: DshRuntime, signal?: AbortSignal): Promise<DshNodePackRuntimeLock> {
    const receipt = await validateOfficialNodeProgram(this.options.runtimes.directory(runtime.id), signal);
    if (receipt.version !== runtime.version || receipt.sourceSha256 !== runtime.sourceSha256 || receipt.nodeVersion !== runtime.nodeVersion
      || receipt.npmVersion !== runtime.npmVersion) throw new Error('The Node runtime receipt differs from its registered artifact.');
    return dshNodePackRuntimeLockSchema.parse({ contentSha256: runtime.contentSha256, version: runtime.version, platform: runtime.platform, adapter: runtime.adapter,
      sourceSha256: receipt.sourceSha256, npmIntegrity: receipt.npmIntegrity, dependencyLockSha256: receipt.dependencyLockSha256,
      nodeVersion: receipt.nodeVersion, npmVersion: receipt.npmVersion, nodeExecutableSha256: receipt.nodeExecutableSha256,
      payloadSha256: await nodeRuntimePayloadSha256(this.options.runtimes.directory(runtime.id), signal) });
  }
  private async matchesRuntime(runtime: DshRuntime, manifest: PackManifest, signal?: AbortSignal): Promise<boolean> {
    const expected = manifest.runtime;
    if (runtime.version !== expected.version || runtime.platform !== expected.platform || runtime.adapter !== expected.adapter) return false;
    if (manifest.format === 'worldlinebox-dshpack-v1') return runtime.contentSha256 === expected.contentSha256;
    const actual = await this.nodeIdentity(runtime, signal); const lock = manifest.runtime;
    return actual.sourceSha256 === lock.sourceSha256 && actual.npmIntegrity === lock.npmIntegrity && actual.dependencyLockSha256 === lock.dependencyLockSha256
      && actual.nodeVersion === lock.nodeVersion && actual.npmVersion === lock.npmVersion && actual.nodeExecutableSha256 === lock.nodeExecutableSha256 && actual.payloadSha256 === lock.payloadSha256;
  }
  private async resolveRuntime(manifest: PackManifest, data?: string, operation?: OperationContext): Promise<DshRuntime> {
    for (const runtime of this.options.runtimes.list()) {
      if (await this.matchesRuntime(runtime, manifest, operation?.signal)) return runtime;
    }
    if (manifest.format === 'worldlinebox-dshpack-v2' && data && operation && this.options.ensureRuntime) {
      const runtime = await this.options.ensureRuntime(manifest.runtime, path.join(data, 'runtime-lock', 'package-lock.json'), operation);
      if (!await this.matchesRuntime(runtime, manifest, operation.signal)) throw new Error('The installed runtime differs from the pack’s recorded source, dependency graph or interpreter.');
      return runtime;
    }
    throw new Error(`Install the exact DSH runtime ${manifest.runtime.version} (${manifest.runtime.contentSha256.slice(0, 12)}) before importing or installing this pack.`);
  }
  private async validateRuntimeLock(manifest: PackManifest, data: string, signal?: AbortSignal): Promise<void> {
    if (manifest.format === 'worldlinebox-dshpack-v2') await validatePortableNodeRuntimeLock(manifest.runtime, path.join(data, 'runtime-lock', 'package-lock.json'), signal);
  }
  private async load(id: string, operation: OperationContext): Promise<{ manifest: PackManifest; data: string }> {
    const record = this.get(id);
    const directory = contained(this.directory, id);
    const manifest = parsePackManifest(await readJson(path.join(directory, 'manifest.json')));
    const data = path.join(directory, 'data');
    if (record.contentSha256 !== manifest.contentSha256 || record.runtimeVersion !== manifest.runtime.version
      || !await this.matchesRuntime(this.options.runtimes.get(record.runtimeId), manifest, operation.signal)) throw new Error('Stored pack metadata failed verification.');
    await validateSealedDirectory(data, manifest, operation.signal);
    await auditPackData(data);
    await validatePackPnpmMetadata(data);
    await this.validateRuntimeLock(manifest, data, operation.signal);
    return { manifest, data };
  }
  private async commit(staging: string, id: string, manifest: PackManifest): Promise<void> {
    const runtime = await this.resolveRuntime(manifest);
    await atomicJson(path.join(staging, 'manifest.json'), manifest);
    await rename(staging, contained(this.directory, id));
    this.records.unshift({ id, name: manifest.name, version: manifest.version, runtimeId: runtime.id, runtimeVersion: runtime.version,
      createdAt: manifest.createdAt, contentSha256: manifest.contentSha256, fileCount: manifest.fileCount, byteLength: manifest.byteLength });
    await this.save(); this.options.onChanged();
  }
  private async create(instanceId: string, name: string, version: string, operation: OperationContext): Promise<void> {
    await this.options.instances.withStoppedInstance(instanceId, async () => {
      const instance = this.options.instances.list().find(record => record.id === instanceId);
      if (!instance || instance.status !== 'stopped') throw new Error('Stop this instance before creating a pack.');
      const runtime = this.options.runtimes.get(instance.runtimeId);
      await operation.update('verifying-runtime', 5);
      await this.options.runtimes.verify(runtime.id, operation.signal);
      const id = randomUUID(); const staging = contained(this.directory, `.staging-${id}`);
      await mkdir(path.join(staging, 'data'), { recursive: true });
      try {
        const sources: [string, string][] = [
          [path.join(instance.homePath, 'profiles'), 'home/profiles'], [path.join(instance.homePath, 'cordis.patch.yml'), 'home/cordis.patch.yml'],
          [path.join(instance.homePath, 'skills'), 'home/skills'], [path.join(instance.homePath, 'skills-disabled'), 'home/skills-disabled'], [path.join(instance.agentsPath, 'skills'), 'agents/skills'],
        ];
        await operation.update('copying-pack', 20);
        const runtimeRoot = await realpath(this.options.runtimes.directory(runtime.id));
        const managerRoot = await realpath(this.options.rootPath);
        const instanceRoot = await realpath(this.options.instances.getRoot(instance.id));
        const instanceRelative = path.relative(managerRoot, instanceRoot);
        if (!instanceRelative || instanceRelative.startsWith('..') || path.isAbsolute(instanceRelative)) throw new Error('The instance directory points outside managed storage.');
        for (const [source, relative] of sources) {
          const info = await lstat(source).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
          if (!info) continue;
          const sourceRelative = path.relative(instanceRoot, await realpath(source));
          if (sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative)) throw new Error('A pack source points outside its isolated instance.');
          const skipped = new Set<string>();
          if (relative === 'home/profiles') {
            const inspect = async (folder: string, prefix: string) => {
              for (const entry of await readdir(folder, { withFileTypes: true })) {
                const item = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (excludedProfilePath(item)) { skipped.add(item); continue; }
                if (entry.isSymbolicLink()) {
                  const actual = await realpath(path.join(folder, entry.name));
                  const rel = path.relative(runtimeRoot, actual);
                  if (!rel.startsWith('..') && !path.isAbsolute(rel)) skipped.add(item);
                } else if (entry.isDirectory()) await inspect(path.join(folder, entry.name), item);
              }
            };
            if (info.isDirectory()) await inspect(source, '');
          }
          await copyTree(source, path.join(staging, 'data', relative), { signal: operation.signal, skip: item => skipped.has(item) || excludedProfilePath(item) });
        }
        await removeSharedModelSettings(path.join(staging, 'data'));
        await sealPackPnpmMetadata(path.join(staging, 'data'));
        const nodeLock = runtime.adapter === 'node-cli-web-v1' ? await this.nodeIdentity(runtime, operation.signal) : undefined;
        if (nodeLock) { const lockDirectory = path.join(staging, 'data', 'runtime-lock'); await mkdir(lockDirectory);
          await copyFile(path.join(this.options.runtimes.directory(runtime.id), 'dsh', 'package-lock.json'), path.join(lockDirectory, 'package-lock.json'));
          await validatePortableNodeRuntimeLock(nodeLock, path.join(lockDirectory, 'package-lock.json'), operation.signal); }
        await auditPackData(path.join(staging, 'data'));
        const inventory = await inventoryTree(path.join(staging, 'data'), operation.signal);
        const manifest = parsePackManifest({ format: nodeLock ? 'worldlinebox-dshpack-v2' : 'worldlinebox-dshpack-v1', name, version, createdAt: new Date().toISOString(),
          runtime: nodeLock ?? { contentSha256: runtime.contentSha256, version: runtime.version, platform: runtime.platform, adapter: runtime.adapter }, ...inventory });
        operation.signal.throwIfAborted();
        await this.commit(staging, id, manifest);
      } finally { await removeManaged(this.directory, staging); }
    });
  }
  private async install(packId: string, name: string, operation: OperationContext): Promise<void> {
    await operation.update('verifying-pack', 5);
    const { manifest, data } = await this.load(packId, operation);
    const runtime = await this.resolveRuntime(manifest, data, operation);
    await this.options.runtimes.verify(runtime.id, operation.signal);
    const instance = await this.options.instances.create(name, runtime.id, operation);
    try {
      await this.options.instances.withStoppedInstance(instance.id, async () => {
        await operation.update('installing-pack', 50);
        await copyTree(data, this.options.instances.getRoot(instance.id), { signal: operation.signal, skip: relative => relative === 'runtime-lock' || relative.startsWith('runtime-lock/') });
        // Older packs may predate shared accounts/models. Their copied settings must not replace the current shared choices.
        await removeSharedModelSettings(this.options.instances.getRoot(instance.id));
        await installPackPnpmMetadata(this.options.instances.getRoot(instance.id));
        operation.signal.throwIfAborted();
        await operation.log(`Installed pack ${packId} into instance ${instance.id}.`);
      });
    } catch (error) { await this.options.instances.remove(instance.id); throw error; }
  }
  async exportArchive(packId: string, filePath: string, signal: AbortSignal): Promise<PackManifest> {
    const operation: OperationContext = { id: 'public-pack-export', signal, update: async () => undefined, log: async () => undefined };
    const { manifest, data } = await this.load(packId, operation);
    return parsePackManifest(await writeSealedArchive(data, filePath, manifest, signal));
  }
  async importArchive(filePath: string, operation: OperationContext): Promise<DshPack> {
    const id = randomUUID(); const staging = contained(this.directory, `.staging-${id}`);
    try {
      await operation.update('verifying-archive', 10);
      const manifest = parsePackManifest(await extractSealedArchive(filePath, path.join(staging, 'data'), operation.signal));
      await auditPackData(path.join(staging, 'data')); await validatePackPnpmMetadata(path.join(staging, 'data'));
      await this.validateRuntimeLock(manifest, path.join(staging, 'data'), operation.signal);
      const runtime = await this.resolveRuntime(manifest, path.join(staging, 'data'), operation); await this.options.runtimes.verify(runtime.id, operation.signal);
      operation.signal.throwIfAborted(); await this.commit(staging, id, manifest); return this.get(id);
    } finally { await removeManaged(this.directory, staging); }
  }
  async handle(request: DshLauncherRequest, filePath?: string): Promise<DshLauncherResponse> {
    const { operations } = this.options;
    switch (request.type) {
      case 'pack.create': return { ok: true, operationId: await operations.run(request.type, `Create pack ${request.name}`, request.instanceId, operation => this.create(request.instanceId, request.name, request.version, operation)) };
      case 'pack.install': this.get(request.packId); return { ok: true, operationId: await operations.run(request.type, `Install pack ${request.name}`, undefined, operation => this.install(request.packId, request.name, operation)) };
      case 'pack.export': {
        if (!filePath) return { ok: true, cancelled: true };
        this.get(request.packId);
        return { ok: true, operationId: await operations.run(request.type, 'Export DSH pack', undefined, async operation => {
          await operation.update('exporting-pack', 25);
          await this.exportArchive(request.packId, filePath, operation.signal);
        }) };
      }
      case 'pack.import': {
        if (!filePath) return { ok: true, cancelled: true };
        return { ok: true, operationId: await operations.run(request.type, 'Import DSH pack', undefined, async operation => {
          await this.importArchive(filePath, operation);
        }) };
      }
      case 'pack.delete': {
        this.get(request.packId);
        await removeManaged(this.directory, contained(this.directory, request.packId));
        this.records = this.records.filter(record => record.id !== request.packId);
        await this.save(); this.options.onChanged(); return { ok: true };
      }
      default: throw new Error('Unsupported DSH pack action.');
    }
  }
}

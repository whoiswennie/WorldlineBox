import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { openPromise, type Entry, type ZipFile } from 'yauzl';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { DshInstance } from '../../shared/dsh-launcher';
import { dshInstalledSkillSchema, dshRepositorySchema, dshSkillInspectionSchema, dshSkillNameSchema, dshSkillTargetSchema,
  type DshInstalledSkill, type DshSkillInspection, type DshSkillTarget } from '../../shared/dsh-marketplace';
import { createWriteStream, lstat, mkdir, readFile, readdir, rename, rm } from './disk';
import { atomicJson, contained, hashFile, inventoryTree, readJson, removeManaged, safeRelative, type TreeInventory } from './files';
import { fetchHttpsDownload } from './https-download';
import type { DshMarketplaceNetwork } from './marketplace';
import type { OperationContext } from './operations';

const LIMITS = { archive: 64 * 1024 ** 2, entries: 30_000, total: 256 * 1024 ** 2, document: 1024 ** 2, component: 64 * 1024 ** 2, files: 2000 };
const receiptSchema = z.object({ version: z.literal(1), entries: z.array(dshInstalledSkillSchema.extend({ inventory: z.object({
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/), fileCount: z.number().int(), byteLength: z.number().int(),
  files: z.array(z.object({ path: z.string(), size: z.number().int(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })) }) })).max(1000) });
type Receipt = z.infer<typeof receiptSchema>['entries'][number];
const portableReceiptSchema = dshSkillTargetSchema.extend({ format: z.literal('worldlinebox-skill-v1'), installedAt: z.string(),
  inventory: receiptSchema.shape.entries.element.shape.inventory });
const ORIGIN_FILE = '.worldlinebox-skill.json';
interface IndexedEntry { entry: Entry; name: string; relative: string; directory: boolean }
interface ArchiveIndex { root: string; entries: IndexedEntry[] }
function readSkillDocument(source: string): { name: string; description: string } {
  if (Buffer.byteLength(source) > LIMITS.document) throw new Error('The skill document exceeds the limit.');
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) throw new Error('A skill requires YAML front matter with a name and description.');
  const parsed = parseDocument(match[1]!, { uniqueKeys: true });
  if (parsed.errors.length) throw new Error('The skill YAML front matter is invalid.');
  const data = parsed.toJS({ maxAliasCount: 0 }) as unknown;
  if (!data || typeof data !== 'object') throw new Error('The skill YAML front matter is invalid.');
  const fields = data as Record<string, unknown>; const name = dshSkillNameSchema.parse(fields.name);
  if (typeof fields.description !== 'string' || !fields.description.trim() || fields.description.length > 4000) throw new Error('The skill description is missing or exceeds the limit.');
  return { name, description: fields.description.trim() };
}
async function readEntry(zip: ZipFile, entry: Entry, signal: AbortSignal): Promise<string> {
  if (entry.uncompressedSize > LIMITS.document) throw new Error('The skill document exceeds the limit.');
  const stream = await zip.openReadStreamPromise(entry); const chunks: Buffer[] = []; let length = 0;
  try { for await (const chunk of stream) { signal.throwIfAborted(); length += chunk.length;
    if (length > LIMITS.document) throw new Error('The skill document exceeds the limit.'); chunks.push(Buffer.from(chunk)); } }
  finally { stream.destroy(); }
  if (length !== entry.uncompressedSize) throw new Error('The skill document size is inconsistent.');
  return Buffer.concat(chunks).toString('utf8');
}
/** Validate the entire ZIP before extracting any selected component, including unselected paths. */
async function indexArchive(zip: ZipFile, signal: AbortSignal): Promise<ArchiveIndex> {
  if (zip.entryCount > LIMITS.entries) throw new Error('The skill repository has too many archive entries.');
  const entries: IndexedEntry[] = []; const kinds = new Map<string, 'file' | 'directory'>(); const canonical = new Map<string, string>(); const seen = new Set<string>(); let root = ''; let bytes = 0;
  for await (const entry of zip.eachEntry()) {
    signal.throwIfAborted(); const name = safeRelative(entry.fileName); const directory = entry.fileName.endsWith('/');
    const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (entry.isEncrypted() || !entry.canDecodeFileData() || (mode !== 0 && mode !== 0o100000 && mode !== 0o040000)) throw new Error('The skill repository contains a linked or unsupported archive entry.');
    const archiveKey = name.normalize('NFC').toUpperCase(); if (seen.has(archiveKey)) throw new Error('The repository archive contains duplicate entries.'); seen.add(archiveKey);
    const parts = name.split('/'); if (!root) root = parts[0]!;
    if (parts[0] !== root || (!directory && parts.length < 2)) throw new Error('The repository archive requires one root directory.');
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]!; const key = prefix.normalize('NFC').toUpperCase();
      const nextKind = i === parts.length - 1 && !directory ? 'file' : 'directory'; const oldKind = kinds.get(key);
      if ((oldKind === 'file') || (oldKind !== undefined && nextKind === 'file') || (canonical.has(key) && canonical.get(key) !== prefix)) throw new Error('The repository archive contains duplicate or colliding paths.');
      kinds.set(key, nextKind); canonical.set(key, prefix);
    }
    if (!directory) { bytes += entry.uncompressedSize; if (entry.uncompressedSize > LIMITS.component || bytes > LIMITS.total) throw new Error('The skill repository expanded size exceeds the limit.'); }
    entries.push({ entry, name, relative: parts.slice(1).join('/'), directory });
  }
  return { root, entries };
}
export class SkillInstaller {
  private readonly archiveRoot: string;
  private readonly temporaryRoot: string;
  constructor(private readonly options: { rootPath: string; network: DshMarketplaceNetwork; sourceResponseTimeoutMs?: number; sourceIdleTimeoutMs?: number }) {
    this.archiveRoot = path.join(options.rootPath, 'marketplace', 'archives'); this.temporaryRoot = path.join(options.rootPath, 'marketplace', 'staging');
  }
  private async init(): Promise<void> { await this.directory(this.options.rootPath); await this.directory(path.join(this.options.rootPath, 'marketplace'));
    await this.directory(this.archiveRoot); await this.directory(this.temporaryRoot); }
  private async directory(directory: string): Promise<void> {
    const relative = path.relative(path.resolve(this.options.rootPath), path.resolve(directory));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Skill storage escapes the launcher data directory.');
    let current = path.resolve(this.options.rootPath); await mkdir(current, { recursive: true });
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Skill storage cannot be linked.');
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment); await mkdir(current, { recursive: true }); const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Skill storage cannot be linked or replaced by a file.');
    }
  }
  private async instancePaths(instance: DshInstance): Promise<{ active: string; disabled: string; receipt: string; launcher: string }> {
    if (!/^[a-z0-9-]{1,80}$/.test(instance.id)) throw new Error('Invalid instance identity.');
    const root = path.join(this.options.rootPath, 'instances', instance.id); const expectedAgents = path.join(root, 'agents');
    if (path.resolve(instance.agentsPath).toLowerCase() !== path.resolve(expectedAgents).toLowerCase()) throw new Error('Skill installation requires the selected instance’s private agents directory.');
    const active = path.join(expectedAgents, 'skills'); const launcher = path.join(root, 'launcher'); const disabled = path.join(root, 'home', 'skills-disabled');
    await this.directory(active); await this.directory(disabled); await this.directory(launcher);
    return { active, disabled, launcher, receipt: path.join(launcher, 'skill-receipts.json') };
  }
  private async receipts(file: string): Promise<Receipt[]> {
    try { const info = await lstat(file); if (info.isSymbolicLink() || !info.isFile() || info.size > 16 * 1024 ** 2) throw new Error('Invalid skill receipt file.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return receiptSchema.parse(await readJson(file)).entries;
  }
  private async portableReceipt(directory: string, enabled: boolean): Promise<Receipt | undefined> {
    const file = contained(directory, ORIGIN_FILE);
    try {
      const info = await lstat(file); if (info.isSymbolicLink() || !info.isFile() || info.size > 2 * 1024 ** 2) return undefined;
      const source = portableReceiptSchema.parse(await readJson(file));
      const actual = await inventoryTree(directory); const files = actual.files.filter(item => item.path !== ORIGIN_FILE);
      if (createHash('sha256').update(JSON.stringify(files)).digest('hex') !== source.inventory.contentSha256 || files.length !== source.inventory.fileCount) return undefined;
      return { ...source, managed: true, enabled, path: directory };
    } catch { return undefined; }
  }
  private async archive(repository: string, commit: string, signal: AbortSignal, expectedDigest?: string): Promise<{ file: string; digest: string }> {
    await this.init();
    if (expectedDigest) {
      const existing = contained(this.archiveRoot, `${expectedDigest}.zip`);
      try { const info = await lstat(existing); if (!info.isSymbolicLink() && info.isFile() && info.size <= LIMITS.archive && await hashFile(existing, signal) === expectedDigest) return { file: existing, digest: expectedDigest }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const target = contained(this.temporaryRoot, `${randomUUID()}.zip`); let succeeded = false;
    try {
      let fetched = false;
      for (const candidate of this.options.network.githubCandidates(`https://codeload.github.com/${repository}/zip/${commit}`)) {
        signal.throwIfAborted();
        const stalled = new AbortController(); const candidateSignal = AbortSignal.any([signal, stalled.signal]);
        let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => stalled.abort(new Error('The skill archive source did not respond.')), this.options.sourceResponseTimeoutMs ?? 15_000);
        const restartIdleTimer = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => stalled.abort(new Error('The skill archive source stopped sending data.')), this.options.sourceIdleTimeoutMs ?? 30_000); };
        try {
          const response = await fetchHttpsDownload(candidate, this.options.network.fetch, candidateSignal);
          restartIdleTimer();
          if (!response.ok || !response.body || countContentLength(response) > LIMITS.archive) { await response.body?.cancel(); throw new Error('The skill archive request failed.'); }
          let length = 0;
          const guard = new Transform({ transform(chunk: Buffer, _encoding, callback) { restartIdleTimer(); length += chunk.length;
            callback(length > LIMITS.archive ? new Error('The skill archive exceeds the download limit.') : null, chunk); } });
          await pipeline(Readable.fromWeb(response.body as WebReadableStream), guard, createWriteStream(target, { flags: 'wx' }), { signal: candidateSignal });
          fetched = true; break;
        } catch (error) { await rm(target, { force: true }); if (signal.aborted) throw error; }
        finally { if (timer) clearTimeout(timer); }
      }
      if (!fetched) throw new Error('The skill repository could not be downloaded. Check the launcher network settings.');
      const digest = await hashFile(target, signal); if (expectedDigest && digest !== expectedDigest) throw new Error('The skill repository bytes differ from the inspected archive. Inspect the repository again.');
      const file = contained(this.archiveRoot, `${digest}.zip`);
      if (await exists(file)) {
        const info = await lstat(file); if (info.isSymbolicLink() || !info.isFile() || await hashFile(file, signal) !== digest) throw new Error('The cached skill archive failed integrity verification.');
        await rm(target, { force: true });
      } else await rename(target, file);
      succeeded = true; return { file, digest };
    } finally { if (!succeeded) await rm(target, { force: true }); }
  }
  async inspectSkill(repositoryValue: string, revision?: string, outerSignal?: AbortSignal): Promise<DshSkillInspection> {
    const repository = dshRepositorySchema.parse(repositoryValue); const signal = boundedSignal(outerSignal);
    let ref = revision;
    if (!ref) { const metadata = await this.options.network.json(`https://api.github.com/repos/${repository}`, signal) as { default_branch?: unknown };
      if (typeof metadata?.default_branch !== 'string') throw new Error('The repository did not provide a default branch.'); ref = metadata.default_branch; }
    if (!/^[A-Za-z0-9_./-]{1,200}$/.test(ref) || ref.split('/').some(segment => !segment || segment === '..' || segment === '.')) throw new Error('Invalid repository revision.');
    const metadata = await this.options.network.json(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`, signal) as { sha?: unknown };
    if (typeof metadata?.sha !== 'string' || !/^[a-f0-9]{40}$/.test(metadata.sha)) throw new Error('The repository revision did not resolve to an immutable commit.');
    const commit = metadata.sha; const archive = await this.archive(repository, commit, signal);
    const zip = await openPromise(archive.file, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true });
    const targets: DshSkillTarget[] = [];
    try {
      const index = await indexArchive(zip, signal);
      for (const item of index.entries) {
        if (item.directory || !/(^|\/)SKILL\.md$/.test(item.relative) || item.relative.split('/').some(segment => segment === 'node_modules' || segment === '.git')) continue;
        if (targets.length >= 1000) throw new Error('The repository has too many skill components.');
        let skill: { name: string; description: string };
        try { skill = readSkillDocument(await readEntry(zip, item.entry, signal)); } catch (error) { if (signal.aborted) throw error; continue; }
        const sourcePath = item.relative === 'SKILL.md' ? '.' : item.relative.slice(0, -'/SKILL.md'.length);
        targets.push({ repository, commit, archiveSha256: archive.digest, sourcePath, ...skill });
      }
      if (!targets.length) throw new Error('This repository has no supported SKILL.md components.');
      return dshSkillInspectionSchema.parse({ repository, commit, archiveSha256: archive.digest, targets });
    } finally { zip.close(); }
  }
  async installSkill(instance: DshInstance, targetValue: DshSkillTarget, op?: OperationContext): Promise<DshInstalledSkill> {
    this.assertMutable(instance);
    const target = dshSkillTargetSchema.parse(targetValue); const signal = boundedSignal(op?.signal);
    const sourcePath = target.sourcePath === '.' ? '' : safeRelative(target.sourcePath);
    const locations = await this.instancePaths(instance); const receipts = await this.receipts(locations.receipt);
    const destination = contained(locations.active, target.name); const inactive = contained(locations.disabled, target.name);
    if (await exists(destination) || await exists(inactive) || receipts.some(receipt => receipt.name === target.name)) throw new Error('A skill with this name already exists in this instance. Remove it before installing another revision.');
    await op?.update('Downloading the selected skill commit', 15);
    const archive = await this.archive(target.repository, target.commit, signal, target.archiveSha256);
    const staging = contained(locations.launcher, `skill-staging-${randomUUID()}`); await this.directory(staging); let committed = false;
    const zip = await openPromise(archive.file, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true });
    try {
      const index = await indexArchive(zip, signal); const prefix = sourcePath ? `${sourcePath}/` : '';
      const selected = index.entries.filter(item => !item.directory && item.relative.startsWith(prefix));
      if (!selected.length || selected.length > LIMITS.files || selected.reduce((sum, item) => sum + item.entry.uncompressedSize, 0) > LIMITS.component) throw new Error('The selected skill component exceeds the installation limit.');
      for (const item of selected) {
        signal.throwIfAborted(); const relative = safeRelative(item.relative.slice(prefix.length));
        if (relative.split('/').some(segment => segment === 'node_modules' || segment === '.git') || relative === ORIGIN_FILE) throw new Error('The selected skill contains repository internals or reserved launcher metadata.');
        const file = contained(staging, relative); await mkdir(path.dirname(file), { recursive: true });
        await pipeline(await zip.openReadStreamPromise(item.entry), createWriteStream(file, { flags: 'wx' }), { signal });
      }
      const observed = readSkillDocument(await readFile(path.join(staging, 'SKILL.md'), 'utf8'));
      if (observed.name !== target.name || observed.description !== target.description) throw new Error('The selected skill no longer matches the inspected document.');
      const inventory = await inventoryTree(staging, signal); const installed: DshInstalledSkill = { ...target, ...observed,
        enabled: true, managed: true, path: destination, installedAt: new Date().toISOString() };
      await atomicJson(path.join(staging, ORIGIN_FILE), { ...target, format: 'worldlinebox-skill-v1', installedAt: installed.installedAt, inventory });
      await op?.update('Committing this instance’s private skill', 90); signal.throwIfAborted(); await rename(staging, destination); committed = true;
      try { await atomicJson(locations.receipt, { version: 1, entries: [...receipts, { ...installed, inventory }] }); }
      catch (error) { await removeManaged(locations.active, destination); committed = false; throw error; }
      await op?.log(`Installed private skill ${target.name}; commit ${target.commit}; archive SHA-256 ${archive.digest}.`); return installed;
    } finally { zip.close(); if (!committed) await removeManaged(locations.launcher, staging); }
  }
  async listSkills(instance: DshInstance): Promise<DshInstalledSkill[]> {
    const locations = await this.instancePaths(instance); const receipts = await this.receipts(locations.receipt); const results: DshInstalledSkill[] = [];
    for (const [root, enabled] of [[locations.active, true], [locations.disabled, false]] as const) {
      for (const name of (await readdir(root)).sort()) {
        if (!dshSkillNameSchema.safeParse(name).success) continue;
        const directory = contained(root, name); const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) continue;
        try { const documentPath = path.join(directory, 'SKILL.md'); const documentStat = await lstat(documentPath);
          if (!documentStat.isFile() || documentStat.isSymbolicLink() || documentStat.size > LIMITS.document) continue;
          const skill = readSkillDocument(await readFile(documentPath, 'utf8')); const receipt = receipts.find(item => item.name === name) ?? await this.portableReceipt(directory, enabled);
          if (skill.name !== name) continue;
          const saved = receipt ? { repository: receipt.repository, commit: receipt.commit, archiveSha256: receipt.archiveSha256,
            sourcePath: receipt.sourcePath, installedAt: receipt.installedAt } : {};
          results.push(dshInstalledSkillSchema.parse({ ...saved, ...skill, enabled, path: directory, managed: !!receipt }));
        } catch { /* Unsupported local documents remain untouched. */ }
      }
    }
    return results;
  }
  async setSkillEnabled(instance: DshInstance, nameValue: string, enabled: boolean): Promise<void> {
    this.assertMutable(instance);
    const name = dshSkillNameSchema.parse(nameValue); const locations = await this.instancePaths(instance); const receipts = await this.receipts(locations.receipt);
    const receipt = await this.ownedSkill(locations, name, receipts);
    if (receipt.enabled === enabled) return;
    const source = contained(receipt.enabled ? locations.active : locations.disabled, name); const destination = contained(enabled ? locations.active : locations.disabled, name);
    await inventoryTree(source); if (await exists(destination)) throw new Error('The target skill directory already exists.');
    await rename(source, destination);
    try { await atomicJson(locations.receipt, { version: 1, entries: [...receipts.filter(item => item.name !== name), { ...receipt, enabled, path: destination }] }); }
    catch (error) { await rename(destination, source); throw error; }
  }
  async removeSkill(instance: DshInstance, nameValue: string): Promise<void> {
    this.assertMutable(instance);
    const name = dshSkillNameSchema.parse(nameValue); const locations = await this.instancePaths(instance); const receipts = await this.receipts(locations.receipt);
    const receipt = await this.ownedSkill(locations, name, receipts);
    const source = contained(receipt.enabled ? locations.active : locations.disabled, name); await inventoryTree(source);
    const retired = contained(locations.launcher, `skill-removed-${randomUUID()}`); await rename(source, retired);
    try { await atomicJson(locations.receipt, { version: 1, entries: receipts.filter(item => item.name !== name) }); }
    catch (error) { await rename(retired, source); throw error; }
    await removeManaged(locations.launcher, retired);
  }
  /** Physical private directories determine activation; receipts only supply recorded source metadata. */
  private async ownedSkill(locations: Awaited<ReturnType<SkillInstaller['instancePaths']>>, name: string, receipts: Receipt[]): Promise<Receipt> {
    const active = contained(locations.active, name); const disabled = contained(locations.disabled, name);
    const activeExists = await exists(active); const disabledExists = await exists(disabled);
    if (activeExists === disabledExists) throw new Error(activeExists ? 'This skill exists in both active and disabled storage; resolve the duplicate before managing it.' : 'The selected private skill is unavailable.');
    const directory = activeExists ? active : disabled; const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Private skill directories cannot be linked or replaced by a file.');
    const document = path.join(directory, 'SKILL.md'); const documentInfo = await lstat(document);
    if (!documentInfo.isFile() || documentInfo.isSymbolicLink() || documentInfo.size > LIMITS.document) throw new Error('Invalid private skill document.');
    const skill = readSkillDocument(await readFile(document, 'utf8'));
    if (skill.name !== name) throw new Error('The private skill document does not match its directory name.');
    const recorded = receipts.find(item => item.name === name) ?? await this.portableReceipt(directory, activeExists);
    const inventory = await inventoryTree(directory);
    return { ...recorded, ...skill, enabled: activeExists, managed: true, path: directory, inventory };
  }
  private assertMutable(instance: DshInstance): void {
    if (['starting', 'stopping'].includes(instance.status)) throw new Error('Wait for the native DSH Host to finish starting or stopping.');
  }
}
function boundedSignal(signal?: AbortSignal): AbortSignal { return signal ? AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]) : AbortSignal.timeout(5 * 60_000); }
async function exists(file: string): Promise<boolean> { try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
function countContentLength(response: Response): number { const value = Number(response.headers.get('content-length')); return Number.isFinite(value) && value >= 0 ? value : 0; }
export type DshSkillInventory = TreeInventory;

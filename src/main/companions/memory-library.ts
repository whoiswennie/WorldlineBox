import { createHash, randomUUID } from 'node:crypto';
import type { Dir } from 'node:fs';
import { lstat, mkdir, opendir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Companion, CompanionMemory } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { VcpMemoryOwnerIdentity, VcpMemoryTimelineArtifacts } from '../vcp-memory/contracts';
import { removeOwnedDirectory } from './owned-directory-cleanup';
import { companionMemoryIdentity, sameCompanionMemoryIdentity } from './memory-identity';
import { CompanionAssetProfileStore } from './asset-profile';

export const companionMemoryLibraryCategories = ['日记', '资料', '自我认识', '世界经历', '时间线'] as const;
const categories = companionMemoryLibraryCategories;
type Category = typeof categories[number];
export type MemoryLibraryEntry = {
  noteId?: string; conversationId?: string; version?: number; hash?: string; state: 'projecting' | 'tracked' | 'forgotten';
  conflict?: boolean;
  /** A hidden projection can be restored only by a freshly authorized host page. */
  withdrawn?: boolean;
  missingCycle?: number; moveConflict?: boolean;
  pending?: { operationId: string; hash: string; expectedVersion?: number; noteId?: string; sourceMessageId?: string; tags: string[]; diaryName?: string;
    autoTags?: boolean;
    kind?: 'record'; sourceChecksum?: string };
};
type Entry = MemoryLibraryEntry;
export type MemoryLibraryManifest = { version: 1; files: Record<string, Entry>; hostCursor: number; fileCursor: number; scanCycle: number; profileHash?: string;
  move?: { from: string; to: string; hash: string } };
type Manifest = MemoryLibraryManifest;
type Scan = { category: number; notebooks?: string[]; directories?: Array<{ relative: string; directory: Dir }> };
export interface MemoryLibraryTimelineScope { companionId: string; conversationId: string; beforeSequence?: number }
type TimelineManifest = { version: 1; files: Record<string, { scope: MemoryLibraryTimelineScope; sourceRevision: string; contentHash: string; ownerIdentity?: VcpMemoryOwnerIdentity }>; cursor: number };
export interface MemoryLibrarySyncReport {
  exported: number; imported: number; forgotten: number;
  conflicts: Array<{ companionId: string; file: string; message: string }>;
}
export interface CompanionMemoryLibraryOptions {
  profileStore?: CompanionAssetProfileStore;
  /** The selected library's absolute 伙伴记忆 directory, with no extra nesting. */
  libraryDirectory: string;
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  report?(error: unknown): void;
  maxOwnersPerSync?: number; maxFilesPerOwner?: number;
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const empty = (): Manifest => ({ version: 1, files: {}, hostCursor: 0, fileCursor: 0, scanCycle: 0 });
const id = /^[a-zA-Z0-9_-]{1,100}$/;
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
function category(note: CompanionMemory): Category {
  if (note.diaryName === '资料' || note.diaryName === '自我认识') return note.diaryName;
  if (note.sources.some(source => source.sourceType === 'world_observation')) return '世界经历';
  return categories.find(name => note.diaryName === name) ?? '日记';
}

/** Relative human document paths; bookkeeping and Windows aliases are reserved. */
export function memoryLibraryPathParts(relative: string): string[] {
  const parts = relative.split('/');
  if (!relative || relative.length > 768 || parts.length > 12 || parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')
    || /[\\/:<>"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)
    || [...part].some(character => character.charCodeAt(0) < 32))) throw new Error('记忆文件路径无效。');
  return parts;
}

export interface MemoryLibraryDocumentSession {
  owner: Companion; root: string; manifest: MemoryLibraryManifest;
  readOnly?: boolean;
  file(relative: string): string;
  text(relative: string, optional?: boolean): Promise<string | undefined>;
  atomic(relative: string, content: string): Promise<void>;
  directory(relative: string): Promise<string>;
  current(entry: MemoryLibraryEntry): Promise<CompanionMemory | undefined>;
  currentEntry(relative: string): Promise<MemoryLibraryEntry | undefined>;
  readVersion(relative: string): number;
  project(relative: string, note: CompanionMemory): Promise<void>;
  reconcile(relative: string): Promise<void>;
  recoverMove(): Promise<void>;
  timelineValid(relative: string, contentHash?: string): Promise<boolean>;
  save(): Promise<void>;
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
}

/** Human-readable projections and explicit manual input; files never confer source permissions. */
export class CompanionMemoryLibrary {
  private readonly profiles: CompanionAssetProfileStore;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<MemoryLibrarySyncReport>;
  private closed = false;
  private readonly resetting = new Set<string>();
  private root?: string;
  private ownerCursor = 0;
  private readonly scans = new Map<string, Scan>();
  private readonly conflicts = new Set<string>();
  private readonly timelineTails = new Map<string, Promise<void>>();
  private readonly timelineGenerations = new Map<string, number>();
  private readonly fileTails = new Map<string, Promise<unknown>>();
  private readonly readers = new Set<Promise<unknown>>();
  private readonly layoutTails = new Map<string, Promise<unknown>>();
  private readonly fileVersions = new Map<string, { revision: number; publishing: boolean }>();
  private readonly publications = new Map<string, Set<string>>();
  constructor(private readonly options: CompanionMemoryLibraryOptions) {
    if (!path.isAbsolute(options.libraryDirectory)) throw new Error('伙伴记忆目录必须是绝对路径。');
    this.profiles = options.profileStore ?? new CompanionAssetProfileStore(options.libraryDirectory);
  }
  start(intervalMs = 5000): void {
    if (this.timer || this.closed) return;
    const next = () => {
      this.timer = undefined;
      void this.sync().catch(this.options.report).finally(() => {
        if (!this.closed) { this.timer = setTimeout(next, intervalMs); this.timer.unref(); }
      });
    };
    this.timer = setTimeout(next, 0); this.timer.unref();
  }
  sync(): Promise<MemoryLibrarySyncReport> {
    if (this.closed) return Promise.resolve({ exported: 0, imported: 0, forgotten: 0, conflicts: [] });
    if (this.running) return this.running;
    const pending = this.perform(); this.running = pending;
    void pending.finally(() => { if (this.running === pending) this.running = undefined; }).catch(() => undefined);
    return pending;
  }
  private serial<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const pending = (this.fileTails.get(owner) ?? Promise.resolve()).catch(() => undefined).then(() => {
      if (this.closed || this.resetting.has(owner)) throw new Error('伙伴记忆目录正在关闭或重置。');
      return work();
    });
    this.fileTails.set(owner, pending);
    void pending.finally(() => { if (this.fileTails.get(owner) === pending) this.fileTails.delete(owner); }).catch(() => undefined);
    return pending;
  }
  private async perform(): Promise<MemoryLibrarySyncReport> {
    const result: MemoryLibrarySyncReport = { exported: 0, imported: 0, forgotten: 0, conflicts: [] };
    await this.initializeRoot();
    const state = await this.call({ type: 'state', includeConversations: false });
    const resetting = new Set((state.state?.resetJobs ?? []).filter(job => job.status !== 'completed').map(job => job.companionId));
    const owners = (state.state?.companions ?? []).filter(owner => id.test(owner.id) && !this.resetting.has(owner.id) && !resetting.has(owner.id)).sort((a, b) => a.id.localeCompare(b.id));
    if (!owners.length) return result;
    const count = Math.min(owners.length, Math.max(1, this.options.maxOwnersPerSync ?? 4));
    for (let n = 0; n < count && !this.closed; n++) {
      const owner = owners[this.ownerCursor++ % owners.length]!;
      const conflictStart = result.conflicts.length;
      await this.serial(owner.id, async () => {
        try { await this.owner(owner, result); }
        catch (error) { this.conflict(result, owner.id, owner.id, error instanceof Error ? error.message : '目录同步失败。'); }
        try { await this.statusFile(owner.id, result.conflicts.slice(conflictStart)); }
        catch (error) { this.options.report?.(error); }
      });
    }
    return result;
  }
  private async call(command: CompanionStorageCommand): Promise<CompanionStorageResponse> {
    const response = await this.options.request(command);
    if (!response.ok) throw new Error(response.error ?? '伙伴记忆存储不可用。');
    return response;
  }
  private async initializeRoot(): Promise<void> {
    const rejectRootLink = async () => {
      const stat = await lstat(this.options.libraryDirectory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('伙伴记忆根目录不能是链接、目录联接或普通文件。');
    };
    try { await rejectRootLink(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(this.options.libraryDirectory, { recursive: true });
    }
    await rejectRootLink();
    if (!this.root) this.root = await realpath(this.options.libraryDirectory);
    if (await realpath(this.options.libraryDirectory) !== this.root) throw new Error('资产库目录指向已经改变，同步已停止。');
  }
  private conflict(report: MemoryLibrarySyncReport, owner: string, file: string, message: string): void {
    report.conflicts.push({ companionId: owner, file, message });
    const key = JSON.stringify([owner, file, message]);
    if (!this.conflicts.has(key)) { this.conflicts.add(key); this.options.report?.(new Error(`伙伴记忆文件 ${owner}/${file}：${message}`)); }
  }
  private async directory(parent: string, name: string): Promise<string> {
    const target = path.join(parent, name);
    if (!inside(this.root!, target)) throw new Error('目录超出所选资产库。');
    try {
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('记忆目录不能是符号链接、目录联接或普通文件。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await mkdir(target); }
      catch (creating) {
        if ((creating as NodeJS.ErrnoException).code !== 'EEXIST') throw creating;
        const concurrent = await lstat(target);
        if (concurrent.isSymbolicLink() || !concurrent.isDirectory()) throw new Error('记忆目录不能是符号链接、目录联接或普通文件。', { cause: creating });
      }
    }
    const resolved = await realpath(target);
    if (!inside(this.root!, resolved)) throw new Error('记忆目录指向资产库外部。');
    return target;
  }
  private file(ownerRoot: string, relative: string): string {
    const parts = memoryLibraryPathParts(relative);
    if (parts.length < 2) throw new Error('受管记忆文件必须放在日记本目录内。');
    const target = path.join(ownerRoot, ...parts);
    if (!inside(ownerRoot, target)) throw new Error('记忆文件超出伙伴目录。');
    return target;
  }
  private async text(file: string, optional = false): Promise<string | undefined> {
    try {
      let ancestor = this.root!;
      for (const segment of path.relative(this.root!, path.dirname(file)).split(path.sep).filter(Boolean)) {
        ancestor = path.join(ancestor, segment);
        const info = await lstat(ancestor);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('记忆文件所在路径不能包含链接或目录联接。');
      }
      if (!inside(this.root!, await realpath(path.dirname(file)))) throw new Error('记忆文件所在目录指向资产库外部。');
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('记忆文件不能是链接或特殊文件。');
      const maxBytes = path.basename(file) === '.同步状态.json' || path.basename(file).startsWith('VCP-') ? 64 * 1024 * 1024 : 1024 * 1024;
      if (stat.size > maxBytes) throw new Error('记忆文本超过单文件读取上限，请拆分后导入。');
      return await readFile(file, 'utf8');
    } catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async atomic(file: string, content: string): Promise<void> {
    await this.text(file, true);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  private async save(ownerRoot: string, manifest: Manifest): Promise<void> {
    const file = path.join(ownerRoot, '.同步状态.json'), content = JSON.stringify(manifest, null, 2) + '\n';
    if (await this.text(file, true) !== content) await this.atomic(file, content);
    const publishing = this.publications.get(ownerRoot);
    for (const target of publishing ?? []) {
      const relative = path.relative(ownerRoot, target).replaceAll('\\', '/'), entry = manifest.files[relative];
      // A later repair transaction can also finish a failed publication, but
      // only after the persisted mapping agrees with its actual authorized body.
      if (entry?.state !== 'forgotten') {
        const actual = await this.text(target, true);
        if (!entry || entry.state === 'projecting' || actual === undefined || entry.hash !== digest(actual)) continue;
      }
      const current = this.fileVersions.get(target);
      this.fileVersions.set(target, { revision: (current?.revision ?? 0) + 1, publishing: false });
      publishing?.delete(target);
    }
    if (!publishing?.size) this.publications.delete(ownerRoot);
  }
  private publishing(root: string, relative: string): void {
    const file = this.file(root, relative), previous = this.fileVersions.get(file);
    this.fileVersions.set(file, { revision: (previous?.revision ?? 0) + 1, publishing: true });
    const files = this.publications.get(root) ?? new Set<string>(); files.add(file); this.publications.set(root, files);
  }
  private async load(ownerRoot: string): Promise<Manifest> {
    const text = await this.text(path.join(ownerRoot, '.同步状态.json'), true);
    if (text === undefined) return empty();
    const parsed = JSON.parse(text) as Manifest;
    if (parsed.version !== 1 || !parsed.files || typeof parsed.files !== 'object' || !Number.isSafeInteger(parsed.hostCursor) || !Number.isSafeInteger(parsed.fileCursor)) throw new Error('同步登记损坏；已停止自动导入，文件原文保留。');
    for (const [relative, entry] of Object.entries(parsed.files)) {
      this.file(ownerRoot, relative);
      if (!entry || !['projecting', 'tracked', 'forgotten'].includes(entry.state) || entry.noteId && !id.test(entry.noteId)) throw new Error('同步登记包含无效条目；已停止自动导入。');
    }
    if (parsed.move) {
      this.file(ownerRoot, parsed.move.from); this.file(ownerRoot, parsed.move.to);
      if (!/^[a-f0-9]{64}$/u.test(parsed.move.hash) || parsed.move.from === parsed.move.to) throw new Error('文件移动登记无效。');
    }
    parsed.scanCycle = Number.isSafeInteger(parsed.scanCycle) && parsed.scanCycle >= 0 ? parsed.scanCycle : 0;
    return parsed;
  }
  private async recoverMove(root: string, manifest: Manifest): Promise<void> {
    const move = manifest.move; if (!move) return;
    const source = this.file(root, move.from), target = this.file(root, move.to);
    const before = await this.text(source, true), after = await this.text(target, true);
    if (before !== undefined && after !== undefined || before === undefined && after === undefined
      || digest(before ?? after!) !== move.hash) throw new Error('移动期间文件已变化，原文保留，请核对后再操作。');
    const entry = manifest.files[move.from];
    if (!entry || entry.state === 'forgotten') throw new Error('移动来源登记已经改变。');
    if (before !== undefined) await rename(source, target);
    const sidecar = await this.text(source + '.meta.json', true);
    if (sidecar !== undefined) {
      if (await this.text(target + '.meta.json', true) !== undefined) throw new Error('移动目标已有说明文件，未覆盖。');
      await rename(source + '.meta.json', target + '.meta.json');
    }
    manifest.files[move.to] = { ...entry };
    manifest.files[move.from] = { ...entry, state: 'forgotten', withdrawn: false };
    delete manifest.move;
    await this.save(root, manifest);
  }
  /** Human file operations share the watcher/publication queue and the same ledger. */
  documentsWriting(companionId: string): boolean { return this.fileTails.has(companionId); }
  withDocuments<T>(companionId: string, work: (session: MemoryLibraryDocumentSession) => Promise<T>, options?: { synchronize?: boolean; readOnly?: boolean; sourceDelivery?: boolean }): Promise<T> {
    if (!id.test(companionId)) return Promise.reject(new Error('伙伴标识无效。'));
    const open = async () => {
      if (this.closed || this.resetting.has(companionId)) throw new Error('伙伴记忆目录正在关闭或重置。');
      await this.initializeRoot();
      const state = await this.call({ type: 'state', companionId, includeConversations: false });
      const owner = state.state?.companions.find(owner => owner.id === companionId);
      if (!owner) throw new Error('伙伴不存在或已经移除。');
      let prepared = false;
      if (!options?.sourceDelivery && !options?.readOnly && options?.synchronize !== false) {
        await this.owner(owner, { exported: 0, imported: 0, forgotten: 0, conflicts: [] });
        prepared = true;
        const scan = this.scans.get(companionId);
        for (const frame of scan?.directories ?? []) await frame.directory.close();
        this.scans.delete(companionId);
      }
      const root = await this.directory(this.root!, companionId);
      // Opening a notebook needs its local layout, not an import/reconciliation
      // pass (which may wait for a model-backed write policy).
      if (!options?.sourceDelivery && options?.readOnly && await this.text(path.join(root, '.伙伴配置.json'), true) === undefined) {
        await this.layout(companionId, async () => {
          const initial = await this.load(root);
          await this.prepareOwnerFiles(owner, root, initial);
          await this.save(root, initial);
        });
      } else if (options?.readOnly && !options.sourceDelivery) await this.profiles.load(owner.id);
      let manifest = await this.load(root);
      if (options?.readOnly && !options.sourceDelivery && manifest.move) {
        await this.serial(companionId, async () => { const latest = await this.load(root); await this.recoverMove(root, latest); });
        manifest = await this.load(root);
      }
      // owner() has already prepared, recovered and saved this same owner's
      // layout while holding the writer queue. Reopening every prompt module
      // here repeats the complete role read without adding a new operation.
      if (!options?.readOnly && !options?.sourceDelivery && !prepared) {
        const previousProfileHash = manifest.profileHash;
        await this.prepareOwner(owner, root, manifest);
        if (manifest.profileHash !== previousProfileHash) await this.save(root, manifest);
        await this.recoverMove(root, manifest);
      }
      const writable = () => { if (options?.readOnly) throw new Error('只读日记本视图不能修改文件或同步登记。'); };
      let latest: { stamp: string; manifest: Manifest } | undefined;
      const manifestStamp = async () => {
        try {
          const info = await lstat(path.join(root, '.同步状态.json'));
          return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        } catch (error) {
          // The first writer can have created profile.md before waiting on an
          // import, without publishing its first manifest yet. A missing ledger
          // is a real empty snapshot, not evidence that existing files vanished.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
          throw error;
        }
      };
      const target = (relative: string) => {
        const file = path.join(root, ...memoryLibraryPathParts(relative));
        if (!inside(root, file)) throw new Error('文件超出伙伴目录。');
        return file;
      };
      return work({ owner, root, manifest, ...(options?.readOnly ? { readOnly: true } : {}), file: target,
        text: (relative, optional) => this.text(target(relative), optional),
        atomic: (relative, content) => { writable(); this.publishing(root, relative); return this.atomic(target(relative), content); },
        directory: async relative => {
          writable();
          let parent = root;
          for (const part of memoryLibraryPathParts(relative)) parent = await this.directory(parent, part);
          return parent;
        },
        current: entry => this.current(owner.id, entry),
        readVersion: relative => {
          const current = this.fileVersions.get(target(relative));
          if (current?.publishing) throw Object.assign(new Error('文档正在发布，请稍后重新读取。'), { code: 'MEMORY_DOCUMENT_WITHDRAWN' });
          return current?.revision ?? 0;
        },
        currentEntry: async relative => {
          const before = await manifestStamp();
          if (latest?.stamp === before) return latest.manifest.files[relative];
          const current = await this.load(root), after = await manifestStamp();
          if (before !== after) throw Object.assign(new Error('文档登记正在更新，请重新读取。'), { code: 'MEMORY_DOCUMENT_WITHDRAWN' });
          latest = { stamp: after, manifest: current };
          return current.files[relative];
        },
        project: (relative, note) => { writable(); return this.project(root, manifest, relative, note); },
        reconcile: async relative => {
          writable();
          const result: MemoryLibrarySyncReport = { exported: 0, imported: 0, forgotten: 0, conflicts: [] };
          await this.reconcile(owner, root, manifest, relative, result);
          if (result.conflicts.length) throw new Error(result.conflicts.map(item => item.message).join('\n'));
        },
        recoverMove: () => { writable(); return this.recoverMove(root, manifest); },
        timelineValid: async (relative, contentHash) => {
          const file = relative.slice('时间线/'.length), timelines = await this.timelineManifest(root), entry = timelines.files[file];
          if (!relative.startsWith('时间线/') || file.includes('/') || !entry || entry.scope.companionId !== owner.id
            || !sameCompanionMemoryIdentity(entry.ownerIdentity, companionMemoryIdentity(owner))) return false;
          const content = contentHash ?? digest(await this.text(target(relative), true) ?? '');
          if (!entry.contentHash || entry.contentHash !== content) return false;
          const snapshot = (await this.call({ type: 'memory.snapshot', ...entry.scope })).memorySnapshot;
          const revision = snapshot?.semanticRevision ?? snapshot?.revision;
          return revision === entry.sourceRevision;
        },
        save: () => { writable(); return this.save(root, manifest); }, request: command => this.call(command),
      });
    };
    if (!options?.readOnly) return this.serial(companionId, open);
    // Readers use an immutable manifest snapshot and re-authorize every result.
    // They never edit exports or registration while an import waits on a model.
    const pending = open(); this.readers.add(pending);
    void pending.finally(() => this.readers.delete(pending)).catch(() => undefined);
    return pending;
  }
  private async statusFile(owner: string, conflicts: MemoryLibrarySyncReport['conflicts']): Promise<void> {
    const root = await this.directory(this.root!, owner), file = path.join(root, '同步状态.md');
    const messages = [...new Set(conflicts.map(conflict => `- ${conflict.file}：${conflict.message}`))];
    const body = `状态：${messages.length ? '需要核对' : '已同步'}\n\n${messages.length ? messages.join('\n') : '已完成本轮有界核对，未发现待处理冲突。'}\n\n处理方式：版本冲突时，在记忆管理中查看宿主版本，保留需要的正文后再保存；移动无法确认时，可恢复原文件名，或明确遗忘旧条目后再将新文件作为资料导入。profile.md与提示词目录是本伙伴当前资料的权威文件，修改后会用于后续上下文；缺失或损坏不会回退内置设定。VCP-前缀时间线是自动产物，需要学习时请另存到资料或自我认识。\n`;
    const previous = await this.text(file, true), last = previous?.match(/最近核对：([^\n]+)/)?.[1];
    if (previous?.endsWith(body) && last && Date.now() - Date.parse(last) < 3600000) return;
    await this.atomic(file, `# 伙伴记忆同步状态\n\n最近核对：${new Date().toISOString()}\n\n${body}`);
  }
  private layout<T>(owner: string, work: () => Promise<T>): Promise<T> {
    const pending = (this.layoutTails.get(owner) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.layoutTails.set(owner, pending);
    void pending.finally(() => { if (this.layoutTails.get(owner) === pending) this.layoutTails.delete(owner); }).catch(() => undefined);
    return pending;
  }
  private prepareOwner(owner: Companion, root: string, manifest: Manifest, report?: MemoryLibrarySyncReport): Promise<void> {
    return this.layout(owner.id, () => this.prepareOwnerFiles(owner, root, manifest, report));
  }
  private async prepareOwnerFiles(owner: Companion, root: string, manifest: Manifest, report?: MemoryLibrarySyncReport): Promise<void> {
    for (const name of categories) await this.directory(root, name);
    const snapshot = await this.profiles.bootstrap(owner);
    manifest.profileHash = snapshot.profileRevision;
    void report;
  }
  private async owner(owner: Companion, result: MemoryLibrarySyncReport): Promise<void> {
    const root = await this.directory(this.root!, owner.id);
    const manifest = await this.load(root), limit = Math.max(1, Math.min(256, this.options.maxFilesPerOwner ?? 32));
    await this.recoverMove(root, manifest);
    await this.prepareOwner(owner, root, manifest, result);
    await this.pruneTimelines(owner, root, limit);

    const keys = Object.keys(manifest.files);
    for (let n = 0; n < Math.min(limit, keys.length); n++) {
      const relative = keys[manifest.fileCursor++ % keys.length]!;
      await this.reconcile(owner, root, manifest, relative, result);
    }
    const page = (await this.call({ type: 'memory.library.page', companionId: owner.id, cursor: manifest.hostCursor, limit })).memoryPage;
    const pathsByNote = new Map(Object.entries(manifest.files).flatMap(([file, entry]) => entry.noteId && (entry.state !== 'forgotten' || entry.withdrawn) ? [[entry.noteId, file] as const] : []));
    for (const { memory: note } of page?.items ?? []) {
      const relative = pathsByNote.get(note.id) ?? `${category(note)}/${note.id}.md`;
      const entry = manifest.files[relative];
      if (!entry) {
        manifest.files[relative] = { noteId: note.id, conversationId: note.sourceConversationId, version: note.version, hash: digest(note.content), state: 'projecting' };
        await this.save(root, manifest);
        const actual = await this.text(this.file(root, relative), true);
        if (actual !== undefined && actual !== note.content) {
          manifest.files[relative]!.conflict = true;
          this.conflict(result, owner.id, relative, '已有未登记文本与日记不同，未覆盖也未自动恢复旧导出。');
          continue;
        }
        await this.project(root, manifest, relative, note); result.exported++;
      } else if (entry.withdrawn) {
        entry.state = 'projecting';
        await this.project(root, manifest, relative, note); result.exported++;
      } else if (entry.state !== 'forgotten') await this.reconcile(owner, root, manifest, relative, result, note);
    }
    manifest.hostCursor = page?.hasMore ? page.nextCursor ?? 0 : 0;
    await this.discover(owner, root, manifest, result, limit);
    for (const [relative, entry] of Object.entries(manifest.files).filter(([, entry]) => entry.state !== 'forgotten' && entry.missingCycle !== undefined).slice(0, limit)) {
      if (entry.moveConflict || manifest.scanCycle < entry.missingCycle! + 2) {
        this.conflict(result, owner.id, relative, entry.moveConflict ? '疑似移动或重命名但身份无法确定，未遗忘也未新建，请恢复原名或在记忆管理中明确处理。' : '文件缺失，正在完成目录核对以区分移动与删除。');
        continue;
      }
      if (await this.text(this.file(root, relative), true) !== undefined) { delete entry.missingCycle; continue; }
      const note = await this.current(owner.id, entry);
      if (note) { await this.call({ type: 'memory.delete', id: note.id }); result.forgotten++; }
      entry.state = 'forgotten';
      await unlink(this.file(root, relative) + '.meta.json').catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
    manifest.fileCursor %= Math.max(1, Object.keys(manifest.files).length);
    if (!Object.values(manifest.files).some(entry => entry.state !== 'forgotten' && entry.missingCycle !== undefined)) manifest.scanCycle = 0;
    await this.save(root, manifest);
  }
  private async current(owner: string, entry: Entry): Promise<CompanionMemory | undefined> {
    if (!entry.noteId) return undefined;
    return (await this.call({ type: 'memory.library.read', companionId: owner, id: entry.noteId })).memoryRead?.memory;
  }
  private async project(root: string, manifest: Manifest, relative: string, note: CompanionMemory): Promise<void> {
    const entry = manifest.files[relative], actual = await this.text(this.file(root, relative), true);
    if (actual !== undefined && actual !== note.content && digest(actual) !== (entry?.pending?.hash ?? entry?.hash))
      throw new Error('文件在同步期间再次修改，保留外部内容，未覆盖。');
    this.publishing(root, relative);
    await this.atomic(this.file(root, relative), note.content);
    await this.atomic(this.file(root, relative) + '.meta.json', JSON.stringify({ id: note.id, companionId: note.companionId, version: note.version,
      contentRevision: note.contentRevision, annotationRevision: note.annotationRevision, semanticRevision: note.semanticRevision, procedure: note.procedure,
      diaryName: note.diaryName, tags: note.tags, occurredAt: note.occurredAt, status: note.status,
      conversationId: note.sourceConversationId, captureMethod: note.captureMethod, sources: note.sources,
      authority: '正文可编辑；此说明文件不授予来源、身份或可见范围权限。' }, null, 2) + '\n');
    manifest.files[relative] = { noteId: note.id, conversationId: note.sourceConversationId, version: note.version, hash: digest(note.content), state: 'tracked' };
    const current = await this.current(note.companionId, manifest.files[relative]!);
    if (!current || current.version !== note.version) {
      await unlink(this.file(root, relative)); await unlink(this.file(root, relative) + '.meta.json');
      manifest.files[relative]!.state = current ? 'projecting' : 'forgotten';
      manifest.files[relative]!.withdrawn = !current;
    }
  }
  private async reconcile(owner: Companion, root: string, manifest: Manifest, relative: string, result: MemoryLibrarySyncReport, supplied?: CompanionMemory): Promise<void> {
    const entry = manifest.files[relative]!, file = this.file(root, relative), actual = await this.text(file, true);
    if (entry.state === 'forgotten') {
      if (actual !== undefined) { await unlink(file); this.conflict(result, owner.id, relative, '已遗忘日记的旧导出已移除，未重新导入。'); }
      return;
    }
    if (entry.pending && !entry.noteId) {
      const committed = (await this.call({ type: 'memory.operation.inspect', companionId: owner.id, operationId: entry.pending.operationId })).memories?.[0];
      if (committed) { entry.noteId = committed.id; entry.conversationId = committed.sourceConversationId; }
    }
    const note = supplied ?? await this.current(owner.id, entry);
    if (entry.noteId && !note) {
      if (actual !== undefined) await unlink(file);
      await unlink(file + '.meta.json').catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      entry.state = 'forgotten'; entry.withdrawn = true; delete entry.pending; return;
    }
    if (actual === undefined) {
      if (entry.state === 'projecting' && note) { await this.project(root, manifest, relative, note); result.exported++; return; }
      if (note) entry.missingCycle ??= manifest.scanCycle;
      return;
    }
    delete entry.missingCycle; delete entry.moveConflict;
    const actualHash = digest(actual);
    if (entry.conflict && note && actual !== note.content) {
      this.conflict(result, owner.id, relative, '未登记文本存在冲突，请在记忆管理中核对后再同步。'); return;
    }
    if (note && actual === note.content && (entry.conflict || note.version !== entry.version) && !entry.pending) {
      await this.project(root, manifest, relative, note); result.exported++; return;
    }
    if (entry.pending && note && actual.trim() === note.content) {
      await this.project(root, manifest, relative, note); result.imported++; return;
    }
    if (entry.pending || actualHash !== entry.hash) {
      if (entry.pending && entry.pending.hash !== actualHash || note && entry.version !== note.version && !entry.pending) {
        this.conflict(result, owner.id, relative, '文件与宿主日记均已变化，保留文件并停止自动覆盖；请在记忆管理中核对修订。'); return;
      }
      if (!actual.trim() || actual.trim().length > 65536) { this.conflict(result, owner.id, relative, '日记须为1至65536个字符，原文件保留。'); return; }
      if (!entry.conversationId) entry.conversationId = (await this.call({ type: 'memory.library.scope', companionId: owner.id })).conversation!.id;
      entry.pending ??= { operationId: 'library_' + randomUUID().replaceAll('-', ''), hash: actualHash, expectedVersion: entry.version,
        noteId: entry.noteId, sourceMessageId: note?.sourceMessageId, tags: note?.tags ?? [] };
      await this.save(root, manifest);
      let saved: CompanionMemory | undefined;
      if (entry.pending.kind === 'record') {
        const source = (await this.call({ type: 'memory.sources.filter', companionId: owner.id, conversationId: entry.conversationId,
          ids: [entry.pending.sourceMessageId!] })).memorySources?.[0];
        if (!source || entry.pending.sourceChecksum !== digest(source.content)) throw new Error('所选原消息已变化或不再可见，未创建新日记。');
        saved = (await this.call({ type: 'memory.record', companionId: owner.id, conversationId: entry.conversationId,
          operationId: entry.pending.operationId, candidate: { content: actual, tags: entry.pending.tags, metadata: { manualDocument: true, autoTags: entry.pending.autoTags ?? true },
            diaryName: entry.pending.diaryName ?? relative.split('/')[0], sourceMessageIds: [source.id],
            sourceChecksums: { [source.id]: entry.pending.sourceChecksum }, evidence: [{ sourceMessageId: source.id, quote: source.content.slice(0, 16000) }] } })).memories?.[0];
      } else saved = (await this.call({ type: 'memory.save', memory: { companionId: owner.id, conversationId: entry.conversationId,
        id: entry.pending.noteId, expectedVersion: entry.pending.expectedVersion, operationId: entry.pending.operationId,
        content: actual, diaryName: entry.pending.diaryName ?? note?.diaryName ?? relative.split('/')[0], tags: entry.pending.tags, autoTags: entry.pending.autoTags, sourceMessageId: entry.pending.sourceMessageId } })).memories?.[0];
      if (!saved) throw new Error('手工输入尚未登记。');
      await this.project(root, manifest, relative, saved); await this.save(root, manifest); result.imported++; return;
    }
    if (note && (note.version !== entry.version || actual !== note.content)) { await this.project(root, manifest, relative, note); result.exported++; }
  }
  private async discover(owner: Companion, root: string, manifest: Manifest, result: MemoryLibrarySyncReport, limit: number): Promise<void> {
    const scan = this.scans.get(owner.id) ?? { category: 0 }; this.scans.set(owner.id, scan);
    for (let n = 0; n < limit && !this.closed; n++) {
      if (!scan.notebooks) {
        const iterator = await opendir(root), notebooks: string[] = [];
        try {
          for (;;) {
            const entry = await iterator.read(); if (!entry) break;
            if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !['提示词', '形象', '来源'].includes(entry.name)) {
              memoryLibraryPathParts(entry.name); notebooks.push(entry.name);
              if (notebooks.length > 512) throw new Error('日记本目录数量超过单次扫描上限。');
            }
          }
        } finally { await iterator.close(); }
        scan.notebooks = notebooks.sort();
      }
      if (!scan.notebooks.length) break;
      const notebook = scan.notebooks[scan.category % scan.notebooks.length]!;
      scan.directories ??= [{ relative: notebook, directory: await opendir(await this.directory(root, notebook)) }];
      const frame = scan.directories.at(-1)!, file = await frame.directory.read();
      if (!file) {
        await frame.directory.close(); scan.directories.pop();
        if (scan.directories.length) continue;
        delete scan.directories; scan.category = (scan.category + 1) % scan.notebooks.length;
        if (!scan.category && Object.values(manifest.files).some(entry => entry.state !== 'forgotten' && entry.missingCycle !== undefined && manifest.scanCycle < entry.missingCycle + 2)) manifest.scanCycle++;
        if (!scan.category) delete scan.notebooks;
        continue;
      }
      if (file.isSymbolicLink()) { this.conflict(result, owner.id, file.name, '链接文件或目录未导入。'); continue; }
      if (file.isDirectory() && !file.name.startsWith('.')) {
        const relative = frame.relative + '/' + file.name;
        memoryLibraryPathParts(relative);
        scan.directories.push({ relative, directory: await opendir(await this.directory(path.join(root, ...frame.relative.split('/')), file.name)) });
        continue;
      }
      if (!file.isFile() || !/\.(?:md|txt)$/i.test(file.name)) continue;
      if (notebook === '时间线' && file.name.startsWith('VCP-')) continue;
      const relative = `${frame.relative}/${file.name}`;
      if (manifest.files[relative]) continue;
      const actual = await this.text(this.file(root, relative));
      const missing = Object.entries(manifest.files).filter(([, entry]) => entry.state !== 'forgotten' && entry.noteId && entry.missingCycle !== undefined);
      const newSidecar = await this.text(this.file(root, relative) + '.meta.json', true);
      let metadataId: string | undefined;
      if (newSidecar) { try { const metadata = JSON.parse(newSidecar) as { id?: unknown }; if (typeof metadata.id === 'string') metadataId = metadata.id; } catch { /* No identity can be granted by malformed metadata. */ } }
      const matches = missing.filter(([, entry]) => metadataId ? entry.noteId === metadataId : entry.hash === digest(actual!));
      if (matches.length === 1) {
        const [previous, entry] = matches[0]!, note = await this.current(owner.id, entry);
        if (note && entry.version === note.version && note.content === actual) {
          manifest.files[relative] = { ...entry }; entry.state = 'forgotten';
          await this.project(root, manifest, relative, note);
          await unlink(this.file(root, previous) + '.meta.json').catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
          result.exported++; continue;
        }
      }
      if (missing.length) {
        for (const [, entry] of missing) entry.moveConflict = true;
        this.conflict(result, owner.id, relative, '存在缺失的旧日记，无法安全判断此文件是否为移动修订；未静默遗忘或重复导入。'); continue;
      }
      if (/^note_[a-f0-9]{48}\.md$/i.test(file.name)) { this.conflict(result, owner.id, relative, '未登记的旧日记导出不会自动恢复；请作为新资料明确导入。'); continue; }
      const sidecar = await this.text(this.file(root, relative) + '.meta.json', true);
      if (sidecar) {
        try {
          const metadata = JSON.parse(sidecar) as { id?: unknown; authority?: unknown };
          if (typeof metadata.id === 'string' && typeof metadata.authority === 'string') {
            this.conflict(result, owner.id, relative, '未登记的日记导出说明不会授予重新导入权限。'); continue;
          }
        } catch { /* A document's unrelated sidecar grants no authority. */ }
      }
      manifest.files[relative] = { state: 'tracked' };
      await this.reconcile(owner, root, manifest, relative, result);
    }
  }
  async reset(owner: string, jobId: string): Promise<void> {
    if (!id.test(owner)) throw new Error('伙伴归属无效。');
    this.resetting.add(owner);
    this.timelineGenerations.set(owner, (this.timelineGenerations.get(owner) ?? 0) + 1);
    try {
      await this.running?.catch(() => undefined);
      await Promise.allSettled([this.timelineTails.get(owner), this.fileTails.get(owner), ...this.readers, ...this.layoutTails.values()]);
      const scan = this.scans.get(owner);
      for (const frame of scan?.directories ?? []) await frame.directory.close();
      this.scans.delete(owner);
      await removeOwnedDirectory(this.options.libraryDirectory, owner, jobId);
    } finally { this.resetting.delete(owner); }
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
    await Promise.allSettled(this.timelineTails.values());
    await Promise.allSettled(this.fileTails.values());
    await Promise.allSettled(this.readers);
    await Promise.allSettled(this.layoutTails.values());
    for (const scan of this.scans.values()) for (const frame of scan.directories ?? []) await frame.directory.close();
    this.scans.clear();
  }
  private timelineSerial(owner: string, work: () => Promise<void>): Promise<void> {
    const pending = (this.timelineTails.get(owner) ?? Promise.resolve()).catch(() => undefined).then(() => this.serial(owner, work));
    this.timelineTails.set(owner, pending);
    void pending.finally(() => { if (this.timelineTails.get(owner) === pending) this.timelineTails.delete(owner); }).catch(() => undefined);
    return pending;
  }
  private async timelineManifest(root: string): Promise<TimelineManifest> {
    const content = await this.text(path.join(root, '.时间线索引.json'), true);
    if (!content) return { version: 1, files: {}, cursor: 0 };
    const parsed = JSON.parse(content) as TimelineManifest;
    if (parsed.version !== 1 || !parsed.files || typeof parsed.files !== 'object') throw new Error('时间线投影登记损坏，已停止自动发布。');
    for (const [file, entry] of Object.entries(parsed.files)) if (!/^VCP-[a-zA-Z0-9_-]+(?:\.summary)?\.md$/.test(file)
      || !entry || typeof entry.sourceRevision !== 'string' || !entry.scope || !id.test(entry.scope.companionId) || !id.test(entry.scope.conversationId)) throw new Error('时间线投影登记无效。');
    parsed.cursor = Number.isSafeInteger(parsed.cursor) && parsed.cursor >= 0 ? parsed.cursor : 0;
    return parsed;
  }
  private async removeTimeline(root: string, file: string): Promise<void> {
    for (const suffix of ['', '.meta.json']) {
      const target = path.join(root, '时间线', file + suffix);
      await this.text(target, true);
      await unlink(target).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }
  private async pruneTimelines(owner: Companion, root: string, limit: number): Promise<void> {
    const manifest = await this.timelineManifest(root), files = Object.keys(manifest.files);
    const revisions = new Map<string, string | undefined>();
    for (let n = 0; n < Math.min(limit, files.length); n++) {
      const file = files[manifest.cursor++ % files.length]!, entry = manifest.files[file]!;
      if (entry.scope.companionId !== owner.id) throw new Error('时间线投影不属于该伙伴。');
      if (!sameCompanionMemoryIdentity(entry.ownerIdentity, companionMemoryIdentity(owner))) {
        await this.removeTimeline(root, file); delete manifest.files[file]; continue;
      }
      const key = JSON.stringify(entry.scope);
      if (!revisions.has(key)) {
        const snapshot = (await this.call({ type: 'memory.snapshot', ...entry.scope })).memorySnapshot;
        revisions.set(key, snapshot?.semanticRevision ?? snapshot?.revision);
      }
      if (revisions.get(key) !== entry.sourceRevision) { await this.removeTimeline(root, file); delete manifest.files[file]; }
    }
    if (files.length) {
      manifest.cursor %= Math.max(1, Object.keys(manifest.files).length);
      const file = path.join(root, '.时间线索引.json'), content = JSON.stringify(manifest, null, 2) + '\n';
      if (await this.text(file, true) !== content) await this.atomic(file, content);
    }
  }
  /** Native timeline text is a projection and is never fed back as a new diary source. */
  async publishTimelines(scope: MemoryLibraryTimelineScope, artifacts: VcpMemoryTimelineArtifacts, stillValid: () => Promise<boolean>): Promise<void> {
    if (this.closed || !id.test(scope.companionId) || !id.test(scope.conversationId)) return;
    if (artifacts.schema !== 'worldlinebox.vcp-timeline-artifacts' || !artifacts.sourceRevision) throw new Error('时间线来源版本无效。');
    const generation = this.timelineGenerations.get(scope.companionId) ?? 0;
    if (!await stillValid()) return;
    await this.timelineSerial(scope.companionId, async () => {
      if (this.closed || !await stillValid() || generation !== (this.timelineGenerations.get(scope.companionId) ?? 0)) return;
      const state = (await this.call({ type: 'state', companionId: scope.companionId, includeConversations: false, includeHidden: true })).state;
      const owner = state?.companions.find(companion => companion.id === scope.companionId);
      if (!owner || !sameCompanionMemoryIdentity(artifacts.owner, companionMemoryIdentity(owner))
        || artifacts.agents.some(agent => agent.agentName !== artifacts.owner!.agentName)) throw new Error('时间线归属身份已变化，需要基于该伙伴的原始日记重新整理。');
      await this.initializeRoot();
      const root = await this.directory(this.root!, scope.companionId); await this.directory(root, '时间线');
      const manifest = await this.timelineManifest(root), output = new Map<string, string>();
      for (const agent of artifacts.agents) for (const month of agent.months) {
        if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month.month)) throw new Error('时间线月份无效。');
        const suffix = artifacts.agents.length > 1 ? '-' + digest(agent.agentName).slice(0, 8) : '';
        // One owner has one monthly history. Entering through another chat must
        // not publish a second copy of the same unified cognitive timeline.
        const base = `VCP-${scope.companionId}-${month.month}${suffix}`;
        if (month.content !== undefined) output.set(base + '.md', month.content);
        if (month.summary !== undefined) output.set(base + '.summary.md', month.summary);
      }
      for (const file of Object.keys(manifest.files)) if (manifest.files[file]!.scope.companionId === scope.companionId && !output.has(file)) {
        await this.removeTimeline(root, file); delete manifest.files[file];
      }
      for (const [file, content] of output) manifest.files[file] = { scope, sourceRevision: artifacts.sourceRevision, contentHash: digest(content), ownerIdentity: artifacts.owner };
      await this.atomic(path.join(root, '.时间线索引.json'), JSON.stringify(manifest, null, 2) + '\n');
      for (const [file, content] of output) {
        await this.atomic(path.join(root, '时间线', file), content);
        await this.atomic(path.join(root, '时间线', file + '.meta.json'), JSON.stringify({ sourceRevision: artifacts.sourceRevision, scope, ownerIdentity: artifacts.owner, automatic: true,
          authority: 'VCP自动时间线；修改不会自动成为新记忆，需要学习时请另存到资料或自我认识。' }, null, 2) + '\n');
      }
      if (!await stillValid() || generation !== (this.timelineGenerations.get(scope.companionId) ?? 0)) {
        for (const file of output.keys()) { await this.removeTimeline(root, file); delete manifest.files[file]; }
        await this.atomic(path.join(root, '.时间线索引.json'), JSON.stringify(manifest, null, 2) + '\n');
      }
    });
  }
  /** Synchronous generation bump prevents an in-flight old publication from winning. */
  async invalidate(owner: string): Promise<void> {
    if (!id.test(owner) || this.closed || this.resetting.has(owner)) return;
    this.timelineGenerations.set(owner, (this.timelineGenerations.get(owner) ?? 0) + 1);
    await this.timelineSerial(owner, async () => {
      await this.initializeRoot(); const root = await this.directory(this.root!, owner), directory = await this.directory(root, '时间线');
      const iterator = await opendir(directory);
      try {
        for (;;) {
          const file = await iterator.read(); if (!file) break;
          if (file.isFile() && /^VCP-[a-zA-Z0-9_-]+(?:\.summary)?\.md(?:\.meta\.json)?$/.test(file.name)) {
            await this.text(path.join(directory, file.name), true); await unlink(path.join(directory, file.name));
          }
        }
      } finally { await iterator.close(); }
      await this.atomic(path.join(root, '.时间线索引.json'), JSON.stringify({ version: 1, files: {}, cursor: 0 }, null, 2) + '\n');
    });
  }
}

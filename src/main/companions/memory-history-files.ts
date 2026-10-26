import { createHash } from 'node:crypto';
import { lstat, open, realpath, link, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { CompanionMemory } from '../../shared/companions';
import { companionMemorySchema } from '../../shared/companion-memory';
import { companionMemoryHistoryPath, renderCompanionMemoryHistory, type CompanionMemoryHistoryOutbox, type CompanionMemoryHistoryPayload } from '../../shared/companion-memory-history';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionMemoryLibrary, MemoryLibraryDocumentSession } from './memory-library';
import { inspectVcpOwnedDirectory } from '../vcp-memory/filesystem';
import { companionMemorySourceFilePath } from './memory-source-files';

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
type HistoryRead = { active: Set<string>; seen: Set<string>; memo: Map<string, CompanionMemory> };
const checksum = (text: string) => createHash('sha256').update(text).digest('hex');
const stamp = (stat: Awaited<ReturnType<typeof lstat>>) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Immutable historical bodies live beside the owner's other managed assets.
 * SQL is a publication/authorization journal, never a historical-body fallback. */
export class CompanionMemoryHistoryFiles {
  private readonly failedOwners = new Map<string, number>();
  constructor(private readonly options: { library: CompanionMemoryLibrary; report?(error: unknown): void;
    /** A deterministic fault boundary for crash-window integration tests. */
    afterLink?(job: CompanionMemoryHistoryOutbox): Promise<void> }) {}
  private async parent(session: MemoryLibraryDocumentSession, file: string): Promise<void> {
    if (!await inspectVcpOwnedDirectory(session.root) || !await inspectVcpOwnedDirectory(path.dirname(file)))
      throw Object.assign(new Error('历史目录缺失。'), { code: 'ENOENT' });
    const actualRoot = await realpath(session.root), actualParent = await realpath(path.dirname(file)), relative = path.relative(actualRoot, actualParent);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('历史文件超出伙伴目录。');
  }
  private file(session: MemoryLibraryDocumentSession, relative: string): string {
    if (relative.startsWith('.认知索引/历史发布/')) {
      const name = relative.slice('.认知索引/历史发布/'.length);
      if (!/^[a-zA-Z0-9_-]{1,100}\.tmp$/u.test(name)) throw new Error('历史宿主临时身份无效。');
      return path.join(session.root, '.认知索引', '历史发布', name);
    }
    return session.file(relative);
  }
  private async temporaryDirectory(session: MemoryLibraryDocumentSession): Promise<void> {
    let directory = session.root;
    if (!await inspectVcpOwnedDirectory(directory)) throw new Error('历史宿主目录不安全。');
    for (const part of ['.认知索引', '历史发布']) {
      directory = path.join(directory, part);
      try { await mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!await inspectVcpOwnedDirectory(directory)) throw new Error('历史宿主临时目录被外部改为链接。');
    }
  }
  private async text(session: MemoryLibraryDocumentSession, relative: string, optional = false, recoveryTemporary?: string): Promise<string | undefined> {
    const file = this.file(session, relative);
    try {
      await this.parent(session, file); const before = await lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 2 * 1024 * 1024) throw new Error('历史文件不是有界普通文件。');
      if (before.nlink !== 1) {
        if (before.nlink !== 2 || !recoveryTemporary) throw new Error('历史文件不能是硬链接。');
        await this.parent(session, recoveryTemporary); const temporary = await lstat(recoveryTemporary);
        if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink !== 2 || temporary.dev !== before.dev || temporary.ino !== before.ino)
          throw new Error('历史发布恢复链接不属于本次耐久任务。');
      }
      const handle = await open(file, 'r');
      try {
        if (stamp(await handle.stat()) !== stamp(before)) throw new Error('历史文件在打开前发生变化。');
        const bytes = Buffer.alloc(before.size + 1); let length = 0;
        while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
        if (length !== before.size || stamp(await handle.stat()) !== stamp(before) || stamp(await lstat(file)) !== stamp(before)) throw new Error('历史文件在读取期间发生变化。');
        await this.parent(session, file);
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
      } finally { await handle.close(); }
    } catch (error) { if (optional && missing(error)) return; throw error; }
  }
  private temporary(job: CompanionMemoryHistoryOutbox): string { return `.认知索引/历史发布/${job.id}.tmp`; }
  private async remove(session: MemoryLibraryDocumentSession, relative: string): Promise<void> {
    const file = this.file(session, relative);
    try { await this.parent(session, file); const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('历史撤回目标不是普通文件。'); await unlink(file); }
    catch (error) { if (!missing(error)) throw error; }
  }
  private async check(session: MemoryLibraryDocumentSession, job: CompanionMemoryHistoryOutbox): Promise<void> {
    if (!(await session.request({ type: 'memory.history.outbox.check', id: job.id, leaseToken: job.leaseToken })).memoryHistoryOutboxAccepted)
      throw new Error('历史发布租约或来源权限已撤回。');
  }
  private async publish(session: MemoryLibraryDocumentSession, job: CompanionMemoryHistoryOutbox): Promise<void> {
    const payload = job.payload as CompanionMemoryHistoryPayload | undefined;
    if (!payload || payload.memory.companionId !== job.companionId || payload.memory.id !== job.memoryId || payload.memory.contentRevision !== job.contentRevision)
      throw new Error('历史发布正文不属于本次不可变修订。');
    if (job.relativePath !== companionMemoryHistoryPath(job.memoryId, job.contentRevision, job.bodyHash)) throw new Error('历史发布路径身份不一致。');
    const content = renderCompanionMemoryHistory(payload, job.bodyHash);
    if (checksum(content) !== job.documentHash) throw new Error('历史发布正文与耐久hash不一致。');
    await session.directory(`记忆历史/${job.memoryId}`); await this.temporaryDirectory(session);
    const temporaryRelative = this.temporary(job), temporary = this.file(session, temporaryRelative), target = session.file(job.relativePath);
    // A crash may leave exactly our durable job's two links. Only this publisher
    // may recognize that pair; ordinary readers always require nlink=1.
    const existing = await this.text(session, job.relativePath, true, temporary);
    if (existing !== undefined) {
      if (checksum(existing) !== job.documentHash) throw new Error('已登记历史文件被外部编辑，不能覆盖或SQL重建。');
      try { const targetInfo = await lstat(target), temporaryInfo = await lstat(temporary);
        if (targetInfo.nlink === 2 && temporaryInfo.nlink === 2 && targetInfo.dev === temporaryInfo.dev && targetInfo.ino === temporaryInfo.ino
          && await this.text(session, temporaryRelative, false, target) === content) await unlink(temporary);
        else if (targetInfo.nlink !== 1) throw new Error('历史发布恢复出现未知硬链接。');
      } catch (error) { if (!missing(error)) throw error; }
      if (checksum((await this.text(session, job.relativePath))!) !== job.documentHash) throw new Error('历史恢复后文件不一致。');
      await this.check(session, job); return;
    }
    try { const previous = await lstat(temporary); if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1) throw new Error('历史临时路径不是本宿主可恢复的普通文件。'); await unlink(temporary); }
    catch (error) { if (!missing(error)) throw error; }
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await this.parent(session, target); await this.check(session, job);
    // Atomic no-replace publication. An external file created after the check
    // causes EEXIST; it is never overwritten by a rename from stale SQL.
    await link(temporary, target);
    await this.options.afterLink?.(job);
    await unlink(temporary);
    if (checksum((await this.text(session, job.relativePath))!) !== job.documentHash) throw new Error('历史发布后被并发修改。');
  }
  private async deliver(session: MemoryLibraryDocumentSession, limit: number, target?: { id: string; contentRevision: number }): Promise<{ completed: number; pending: boolean }> {
    let completed = 0;
    for (; completed < limit; completed++) {
      const job = (await session.request({ type: 'memory.history.outbox.claim', companionId: session.owner.id,
        ...(target ? { memoryId: target.id, contentRevision: target.contentRevision } : {}) })).memoryHistoryOutbox;
      if (!job) break;
      if (job.companionId !== session.owner.id) throw new Error('历史发布任务不属于当前伙伴目录。');
      try {
        if (job.operation === 'retract') { await this.remove(session, job.relativePath); await this.remove(session, this.temporary(job)); }
        else await this.publish(session, job);
        const result = await session.request({ type: 'memory.history.outbox.complete', id: job.id, leaseToken: job.leaseToken, documentHash: job.documentHash });
        if (!result.memoryHistoryOutboxAccepted) { await this.remove(session, job.relativePath); await this.remove(session, this.temporary(job)); }
      } catch (error) {
        if (job.operation === 'publish') {
          const current = await session.request({ type: 'memory.history.outbox.check', id: job.id, leaseToken: job.leaseToken }).catch(() => undefined);
          if (current?.memoryHistoryOutboxAccepted === false) {
            await this.remove(session, job.relativePath); await this.remove(session, this.temporary(job));
            await session.request({ type: 'memory.history.outbox.complete', id: job.id, leaseToken: job.leaseToken, documentHash: job.documentHash }).catch(() => undefined);
            continue;
          }
        }
        await session.request({ type: 'memory.history.outbox.fail', id: job.id, leaseToken: job.leaseToken,
          error: error instanceof Error ? error.message.slice(0, 1000) : '历史文件发布失败。', retryAfterMs: 30000 }).catch(() => undefined);
        throw error;
      }
    }
    return { completed, pending: completed === limit };
  }
  flush(owner: string, input: { limit?: number } = {}): Promise<{ completed: number; pending: boolean }> {
    return this.options.library.withDocuments(owner, session => this.deliver(session, Math.max(1, Math.min(256, input.limit ?? 64))), { synchronize: false, sourceDelivery: true });
  }
  async flushPending(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, limitOwners = 4): Promise<void> {
    for (const [owner, until] of this.failedOwners) if (until <= Date.now()) this.failedOwners.delete(owner);
    const owners = (await request({ type: 'memory.history.outbox.owners', limit: limitOwners, excludedOwners: [...this.failedOwners.keys()].slice(-128) })).memoryHistoryPendingOwners ?? [];
    for (const owner of owners) try { await this.flush(owner); } catch (error) { this.failedOwners.set(owner, Date.now() + 30000); this.options.report?.(error); }
  }
  read(scope: Scope, id: string, contentRevision: number): Promise<CompanionMemory> {
    const normalized: Scope = { companionId: scope.companionId, conversationId: scope.conversationId,
      ...(scope.beforeSequence !== undefined ? { beforeSequence: scope.beforeSequence } : {}) };
    return this.options.library.withDocuments(normalized.companionId, session => this.readInSession(session, normalized, id, contentRevision, undefined, true),
      { synchronize: false, sourceDelivery: true });
  }
  async readInSession(session: MemoryLibraryDocumentSession, scope: Scope, id: string, contentRevision: number,
    traversal: HistoryRead = { active: new Set(), seen: new Set(), memo: new Map() }, publishPending = false): Promise<CompanionMemory> {
    const key = `${id}:${contentRevision}`, remembered = traversal.memo.get(key);
    if (remembered) return remembered;
    if (session.owner.id !== scope.companionId || traversal.active.has(key) || !traversal.seen.has(key) && traversal.seen.size >= 10000)
      throw new Error('历史记忆依赖归属、环路或完整闭包预算无效。');
    traversal.seen.add(key); traversal.active.add(key);
    try {
    if (publishPending) await this.deliver(session, 2, { id, contentRevision });
    const describe = async () => { const result = await session.request({ type: 'memory.revision.describe', companionId: scope.companionId,
      conversationId: scope.conversationId, ...(scope.beforeSequence !== undefined ? { beforeSequence: scope.beforeSequence } : {}), id, contentRevision });
      if (!result.ok || !result.memoryHistoryDescriptor) throw new Error(result.error ?? '历史正文尚未发布或授权无效。'); return result.memoryHistoryDescriptor; };
    const before = await describe();
    if (before.companionId !== scope.companionId || before.id !== id || before.contentRevision !== contentRevision
      || before.relativePath !== companionMemoryHistoryPath(id, contentRevision, before.bodyHash)) throw new Error('历史发布描述身份不一致。');
    const content = await this.text(session, before.relativePath);
    if (content === undefined || checksum(content) !== before.documentHash) throw new Error('历史文件缺失或被修改，不使用SQL正文代替。');
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(content); if (!match) throw new Error('历史正文或真实元数据格式无效。');
    const header = JSON.parse(match[1]!) as { schema: string; companionId: string; id: string; contentRevision: number; bodyHash: string; memory: object; dependencies: unknown };
    if (header.schema !== 'worldlinebox.companion-memory-history-v1' || header.companionId !== scope.companionId || header.id !== id || header.contentRevision !== contentRevision
      || header.bodyHash !== before.bodyHash || JSON.stringify(header.dependencies) !== JSON.stringify(before.dependencies)) throw new Error('历史文件的正文身份或元数据不一致。');
    const memory = companionMemorySchema.parse({ ...header.memory, content: match[2]! });
    if (memory.id !== id || memory.companionId !== scope.companionId || memory.contentRevision !== contentRevision) throw new Error('历史文件不属于当前伙伴或修订。');
    for (const dependency of before.dependencies) await this.readInSession(session, scope, dependency.id, dependency.contentRevision, traversal, publishPending);
    for (const source of memory.sources) {
      const sourcePath = companionMemorySourceFilePath({ sourceId: source.messageId, sourceRevision: source.revision, sourceChecksum: source.checksum });
      if (checksum((await this.text(session, sourcePath))!) !== source.checksum) throw new Error('历史记忆的真实原始资料文件缺失或被修改。');
    }
    const after = await describe();
    if (before.documentHash !== after.documentHash || before.bodyHash !== after.bodyHash) throw new Error('历史来源授权在读取期间发生变化。');
    // Practice validation is a host-derived outcome annotation, never file text
    // or a model's assertion. The immutable procedure proposal stays in file.
    if (memory.procedure && after.procedureValidation) memory.procedure.validation = after.procedureValidation;
    traversal.memo.set(key, memory); return memory;
    } finally { traversal.active.delete(key); }
  }
}

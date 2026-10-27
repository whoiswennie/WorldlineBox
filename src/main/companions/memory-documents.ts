import { createHash, randomUUID } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { CompanionMemory } from '../../shared/companions';
import type { CompanionMemoryDocument, CompanionMemoryDocumentCommand, CompanionMemoryDocumentRead, CompanionMemoryDocumentsPage } from '../../shared/companion-memory-documents';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import { memoryLibraryPathParts, type CompanionMemoryLibrary, type MemoryLibraryDocumentSession } from './memory-library';
import { CompanionMemoryDocumentCatalog } from './memory-document-catalog';

export interface CompanionMemoryDocumentsOptions {
  library: CompanionMemoryLibrary;
  libraryDirectory: string;
  requestStorage(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  search?(owner: string, query: string, limit?: number, cursor?: string): Promise<{ hits: Array<{ noteId: string; version: number }>; state: 'building' | 'ready' | 'error'; indexed: number; total: number; error?: string; nextCursor?: string }>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const automatic = (relative: string) => relative === 'profile.md' || relative === '同步状态.md'
  || relative.startsWith('来源/')
  || ['提示词', '形象', '记忆历史'].includes(relative.split('/')[0]!)
  || relative.startsWith('时间线/') && path.posix.basename(relative).startsWith('VCP-');
const categories: Record<string, CompanionMemoryDocument['category']> = { 日记: 'diary', 资料: 'material', 自我认识: 'self', 世界经历: 'world', 时间线: 'timeline' };
const category = (relative: string): CompanionMemoryDocument['category'] => categories[relative.split('/')[0]!] ?? (relative === 'profile.md' ? 'profile' : 'other');
const isDocument = (name: string) => /\.(?:md|txt)$/iu.test(name) && !name.startsWith('.');
const operationId = () => 'library_' + randomUUID().replaceAll('-', '');

/** Human file views with a derived catalogue; memory authority stays in the ledger. */
export class CompanionMemoryDocuments {
  private closed = false;
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly catalog: CompanionMemoryDocumentCatalog;
  constructor(private readonly options: CompanionMemoryDocumentsOptions) {
    if (!path.isAbsolute(options.libraryDirectory)) throw new Error('伙伴记忆目录必须是绝对路径。');
    this.catalog = new CompanionMemoryDocumentCatalog({ library: options.library, request: options.requestStorage,
      describe: (...args) => this.describe(...args) });
  }
  handle(command: CompanionMemoryDocumentCommand): Promise<CompanionWorkspaceResponse> {
    if (this.closed) return Promise.resolve({ ok: false, error: '伙伴记忆文档管理已关闭。' });
    const synchronize = !['memory.documents.list', 'memory.documents.read', 'memory.documents.locate', 'memory.documents.tags.status'].includes(command.type);
    const pending = this.options.library.withDocuments(command.companionId, async session => {
      switch (command.type) {
        case 'memory.documents.locate': {
          const found = Object.entries(session.manifest.files).find(([, entry]) => entry.noteId === command.noteId && entry.state !== 'forgotten');
          if (!found) throw new Error('这篇记忆的文档已移动、撤回或尚未投影，请返回记忆库核对。');
          const document = await this.read(session, found[0]);
          if (document.memory?.id !== command.noteId) throw new Error('文档与记忆的关联已变化，请重新核对。');
          return { ok: true, document };
        }
        case 'memory.documents.list': return { ok: true, documents: await this.list(session, command) };
        case 'memory.documents.read': return { ok: true, document: await this.read(session, command.path, command.sourceLimit, command.sourceCursor) };
        case 'memory.documents.tags.status': return { ok: true, document: await this.read(session, command.path) };
        case 'memory.documents.tags.retry':
        case 'memory.documents.tags.cancel': {
          const current = await this.read(session, command.path); this.requireRevision(current, command.expectedRevision);
          if (current.document.readOnly || !current.memory) throw new Error('只能管理实际日记的自动标签。');
          await session.request({ type: command.type === 'memory.documents.tags.retry' ? 'memory.tags.retry' : 'memory.tags.cancel',
            companionId: session.owner.id, noteId: current.memory.id });
          return { ok: true, document: await this.read(session, command.path) };
        }
        case 'memory.documents.create': return { ok: true, document: await this.create(session, command) };
        case 'memory.documents.save': return { ok: true, document: await this.save(session, command) };
        case 'memory.documents.move': return { ok: true, document: await this.move(session, command) };
        case 'memory.documents.delete': await this.delete(session, command); return { ok: true, deletedPath: command.path };
        case 'memory.documents.mkdir': this.editableDirectory(command.path); await session.directory(command.path); return { ok: true, createdDirectory: command.path };
      }
    }, { synchronize, readOnly: !synchronize }).then(async response => {
      if (!['memory.documents.list', 'memory.documents.read', 'memory.documents.locate', 'memory.documents.tags.status'].includes(command.type)) {
        if ('path' in command) this.catalog.mark(command.companionId, command.path);
        if ('targetPath' in command) this.catalog.mark(command.companionId, command.targetPath);
        if (response.ok && response.document) {
          await this.catalog.published(command.companionId, response.document);
          if (command.type === 'memory.documents.move') await this.catalog.dropped(command.companionId, command.path);
        }
        if (response.ok && response.deletedPath) await this.catalog.dropped(command.companionId, response.deletedPath);
      }
      return response;
    }).catch((error: unknown): CompanionWorkspaceResponse => ({ ok: false, error: error instanceof Error ? error.message : '记忆文档操作失败。' }));
    this.jobs.add(pending);
    void pending.finally(() => this.jobs.delete(pending));
    return pending;
  }
  async forgetOwner(owner: string): Promise<void> { await this.catalog.forgetOwner(owner); }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled(this.jobs); await this.catalog.close(); }
  private editableDirectory(relative: string): void {
    memoryLibraryPathParts(relative);
    if (automatic(relative) || isDocument(path.posix.basename(relative))) throw new Error('目录名称不能占用受保护文档。');
  }
  private editableFile(relative: string): void {
    if (memoryLibraryPathParts(relative).length < 2 || !isDocument(path.posix.basename(relative))) throw new Error('请在日记本目录内使用 .md 或 .txt 文本文件。');
    if (automatic(relative)) throw new Error('伙伴资料与提示词请在对应配置管理中编辑；自动时间线需要学习时请另存到资料。');
  }
  private async remove(session: MemoryLibraryDocumentSession, relative: string): Promise<void> {
    if (session.readOnly) {
      // Re-enter the writer queue only for a withdrawn candidate, then check a
      // fresh manifest before erasing it. A stale reader cannot erase a newer
      // authorized export or overwrite an import's registration.
      const writing = this.options.library.documentsWriting(session.owner.id);
      const cleanup = this.options.library.withDocuments(session.owner.id, async fresh => {
        const entry = fresh.manifest.files[relative];
        if (relative.startsWith('时间线/')) { if (await fresh.timelineValid(relative)) return; }
        else if (entry?.state === 'forgotten') { /* This path has been explicitly withdrawn. */ }
        else if (entry?.noteId) {
          if ((await fresh.request({ type: 'memory.library.read', companionId: fresh.owner.id, id: entry.noteId, sourceLimit: 1 })).memoryRead) return;
        } else if (entry?.pending?.kind === 'record') {
          const source = (await fresh.request({ type: 'memory.sources.filter', companionId: fresh.owner.id, conversationId: entry.conversationId!, ids: [entry.pending.sourceMessageId!] })).memorySources?.[0];
          if (source && hash(source.content) === entry.pending.sourceChecksum) return;
        } else return;
        await this.remove(fresh, relative);
        if (entry) { entry.state = 'forgotten'; entry.withdrawn = !!entry.noteId; delete entry.pending; await fresh.save(); }
      }, { synchronize: false });
      this.jobs.add(cleanup);
      void cleanup.finally(() => this.jobs.delete(cleanup)).catch(() => undefined);
      if (!writing) await cleanup;
      return;
    }
    for (const suffix of ['', '.meta.json']) {
      if (await session.text(relative + suffix, true) !== undefined) await unlink(session.file(relative + suffix));
    }
  }
  private async authorized(session: MemoryLibraryDocumentSession, relative: string, sourceLimit = 30, sourceCursor?: number): Promise<CompanionStorageResponse['memoryRead']> {
    const entry = session.manifest.files[relative];
    if (entry?.state === 'forgotten') { await this.remove(session, relative); throw new Error('此文档已经遗忘，旧导出不会重新导入。'); }
    if (!entry?.noteId) {
      if (entry?.pending?.kind === 'record') {
        const source = await session.request({ type: 'memory.sources.filter', companionId: session.owner.id, conversationId: entry.conversationId!, ids: [entry.pending.sourceMessageId!] });
        if (!source.memorySources?.length || hash(source.memorySources[0]!.content) !== entry.pending.sourceChecksum) {
          await this.remove(session, relative);
          if (!session.readOnly) { entry.state = 'forgotten'; await session.save(); }
          throw new Error('文档原消息已变化或已撤回。');
        }
      }
      return undefined;
    }
    const result = (await session.request({ type: 'memory.library.read', companionId: session.owner.id, id: entry.noteId, sourceLimit, sourceCursor })).memoryRead;
    if (!result) {
      await this.remove(session, relative);
      if (!session.readOnly) { entry.state = 'forgotten'; entry.withdrawn = true; delete entry.pending; await session.save(); }
      throw new Error('日记来源已经失效，旧文档已撤回。');
    }
    return result;
  }
  private describe(relative: string, content: string, updatedAt: string, note?: CompanionMemory, entry?: MemoryLibraryDocumentSession['manifest']['files'][string], fileCreatedAt?: string): CompanionMemoryDocument {
    const readOnly = automatic(relative), contentHash = hash(content), name = path.posix.basename(relative);
    const revision = hash(JSON.stringify([relative, contentHash, note?.id, note?.version, note?.tags, note?.diaryName, note?.metadata?.autoTags, readOnly]));
    const naturalTitle = note && /^note_[a-f0-9]{48}\.(?:md|txt)$/iu.test(name)
      ? (note.content.match(/^#{1,6}\s+(.+)$/mu)?.[1] ?? note.content.split('\n').find(line => line.trim()) ?? '').trim().replace(/^[-*>\s]+/u, '').split(/(?<=[。！？.!?])\s*/u)[0]?.slice(0, 80)
      : undefined;
    return { path: relative, name, title: naturalTitle || name.replace(/\.(?:md|txt)$/iu, ''), directory: path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative),
      kind: relative === 'profile.md' ? 'profile' : relative.startsWith('时间线/') && name.startsWith('VCP-') ? 'timeline' : note ? 'note' : 'document',
      category: category(relative), updatedAt: note && Date.parse(note.updatedAt) > Date.parse(updatedAt) ? note.updatedAt : updatedAt,
      ...(note ? { createdAt: note.createdAt, createdAtSource: 'memory' as const, ...(note.occurredAt ? { occurredAt: note.occurredAt } : {}) }
        : fileCreatedAt ? { createdAt: fileCreatedAt, createdAtSource: 'file_birthtime' as const } : {}),
      bytes: Buffer.byteLength(content), revision, contentHash, readOnly, tags: note?.tags ?? [],
      syncState: readOnly ? 'generated' : entry?.conflict || note && entry?.version !== note.version ? 'conflict'
        : entry?.pending || note?.status === 'queued' || note && contentHash !== hash(note.content) ? 'pending' : note?.status === 'indexed' ? 'indexed' : 'untracked',
      ...(note ? { noteId: note.id, version: note.version, sourceConversationId: note.sourceConversationId, sourceCount: note.sources.length, captureMethod: note.captureMethod, autoTagsEnabled: note.metadata?.autoTags !== false } : {}),
      excerpt: content.replace(/\s+/gu, ' ').slice(0, 600) };
  }
  private async read(session: MemoryLibraryDocumentSession, relative: string, sourceLimit = 30, sourceCursor?: number): Promise<CompanionMemoryDocumentRead> {
    memoryLibraryPathParts(relative);
    if (!isDocument(path.posix.basename(relative))) throw new Error('只能读取 Markdown 或纯文本记忆文档。');
    const readVersion = session.readOnly ? session.readVersion(relative) : undefined;
    const timeline = relative.startsWith('时间线/') && path.posix.basename(relative).startsWith('VCP-');
    if (timeline && !await session.timelineValid(relative)) {
      await this.remove(session, relative); throw Object.assign(new Error('自动时间线的原始来源已经变化，旧文档已撤回。'), { code: 'MEMORY_DOCUMENT_WITHDRAWN' });
    }
    const ledger = await this.authorized(session, relative, sourceLimit, sourceCursor);
    const content = await session.text(relative);
    if (content === undefined) throw new Error('记忆文档不存在。');
    if (content.length > 2_000_000) throw new Error('文档超过 200 万字符阅读上限，请在系统文件管理器中拆分。');
    const info = await lstat(session.file(relative));
    if (ledger) {
      const entry = session.manifest.files[relative];
      if ((entry?.version !== ledger.memory.version || entry?.state === 'projecting') && hash(content) !== hash(ledger.memory.content)) {
        throw Object.assign(new Error('宿主日记已经更新，文档正在同步，请稍后重新读取。'), { code: 'MEMORY_DOCUMENT_WITHDRAWN' });
      }
    }
    const tagStatus = ledger ? (await session.request({ type: 'memory.tags.status', companionId: session.owner.id, noteId: ledger.memory.id })).memoryTagStatus : undefined;
    if (session.readOnly && JSON.stringify(await session.currentEntry(relative)) !== JSON.stringify(session.manifest.files[relative])) {
      throw Object.assign(new Error('文档在读取过程中已移动或重新登记，请重新读取。'), { code: 'MEMORY_DOCUMENT_WITHDRAWN' });
    }
    if (timeline && !await session.timelineValid(relative, hash(content))) {
      await this.remove(session, relative); throw Object.assign(new Error('自动时间线的来源在读取过程中变化，旧文档已撤回。'), { code: 'MEMORY_DOCUMENT_WITHDRAWN' });
    }
    // Keep authority last: tag status and the latest manifest may themselves
    // yield while the original source is withdrawn.
    const fresh = await this.authorized(session, relative, sourceLimit, sourceCursor);
    if (ledger && (!fresh || fresh.memory.version !== ledger.memory.version)) throw new Error('日记在读取过程中已修订，请重新载入。');
    if (session.readOnly && session.readVersion(relative) !== readVersion) {
      throw Object.assign(new Error('文档在读取过程中重新发布，请重新读取。'), { code: 'MEMORY_DOCUMENT_WITHDRAWN' });
    }
    return { document: this.describe(relative, content, info.mtime.toISOString(), ledger?.memory, session.manifest.files[relative], info.birthtimeMs > 0 ? info.birthtime.toISOString() : undefined), content,
      ...(tagStatus ? { tagStatus } : {}),
      ...(ledger ? { memory: ledger.memory } : {}), sources: ledger?.sources ?? [], hasMoreSources: ledger?.hasMore ?? false,
      ...(ledger?.nextSourceCursor !== undefined ? { nextSourceCursor: ledger.nextSourceCursor } : {}) };
  }
  private async list(session: MemoryLibraryDocumentSession, command: Extract<CompanionMemoryDocumentCommand, { type: 'memory.documents.list' }>): Promise<CompanionMemoryDocumentsPage> {
    if (command.directory) memoryLibraryPathParts(command.directory);
    const state = await this.catalog.ensure(session, command.directory), query = command.query?.trim() ?? '', tags = command.tags ?? [];
    const from = command.from ? new Date(command.from).toISOString() : undefined, to = command.to ? new Date(command.to).toISOString() : undefined;
    if (from && to && from > to) throw new Error('开始时间不能晚于结束时间。');
    const sort = command.sort ?? 'updated_desc', dateField = command.dateField ?? 'updatedAt';
    const semanticMode = command.mode === 'semantic' && !!query;
    const fingerprint = hash(JSON.stringify([session.owner.id, command.directory, query, [...tags].sort(), sort, dateField, from ?? null, to ?? null, !!command.recordsOnly]));
    let semanticCursor: string | undefined;
    if (semanticMode && command.cursor) {
      try {
        const value = JSON.parse(Buffer.from(command.cursor, 'base64url').toString('utf8')) as { kind: string; fingerprint: string; inner: string };
        if (value.kind !== 'memory-documents-semantic-v1' || value.fingerprint !== fingerprint || typeof value.inner !== 'string' || value.inner.length > 2048) throw new Error();
        semanticCursor = value.inner;
      } catch { throw new Error('搜索条件或排序已经变化，请从第一页重新查询。'); }
    }
    const semantic = semanticMode ? await this.options.search?.(session.owner.id, query, command.limit, semanticCursor) : undefined;
    if (command.mode === 'semantic' && query && !this.options.search) throw new Error('原版 VCP 语义检索暂不可用。');
    const result = await session.request({ type: 'document.catalog.query', companionId: session.owner.id, directory: command.directory, recordsOnly: command.recordsOnly,
      query: semantic ? '' : query, tags, sort, dateField, from, to,
      ...(semantic ? { noteIds: semantic.hits.map(hit => hit.noteId) } : { cursor: command.cursor }), limit: command.limit });
    const page = result.documentCatalog;
    if (!page) throw new Error('记忆文档目录索引不可用。');
    const paths = semantic ? page.paths.sort((a, b) => {
      const order = (file: string) => semantic.hits.findIndex(hit => hit.noteId === session.manifest.files[file]?.noteId);
      return order(a) - order(b);
    }) : page.paths;
    const hydrated: Array<CompanionMemoryDocument | undefined> = new Array(paths.length);
    const readCandidate = async (file: string): Promise<CompanionMemoryDocument | undefined> => {
      try {
        const read = await this.read(session, file, 1), item = read.document;
        const hit = semantic?.hits.find(hit => hit.noteId === item.noteId);
        if (semantic && (!hit || item.version !== hit.version)) return;
        // A persisted catalogue only supplies candidates. Recheck the current file,
        // source visibility, version, keyword and tags before returning any result.
        const searchable = (item.title + '\n' + read.content + '\n' + item.tags.join(' ')).toLowerCase();
        if (!semantic && query.toLowerCase().split(/\s+/u).some(token => !searchable.includes(token))) { this.catalog.mark(session.owner.id, file); return; }
        if (tags.some(tag => !item.tags.includes(tag))) { this.catalog.mark(session.owner.id, file); return; }
        const date = item[dateField];
        if ((from || to) && (!date || from && Date.parse(date) < Date.parse(from) || to && Date.parse(date) > Date.parse(to))) { this.catalog.mark(session.owner.id, file); return; }
        return item;
      } catch (error) {
        if (session.manifest.files[file]?.state !== 'forgotten' && (error as NodeJS.ErrnoException).code !== 'ENOENT'
          && !(error instanceof Error && 'code' in error && error.code === 'MEMORY_DOCUMENT_WITHDRAWN')) throw error;
        await session.request({ type: 'document.catalog.drop', companionId: session.owner.id, paths: [file] });
      }
    };
    let next = 0;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(4, paths.length) }, async () => {
      while (next < paths.length) {
        const index = next++;
        hydrated[index] = await readCandidate(paths[index]!);
      }
    }));
    // Drain every bounded reader before leaving this validation/session frame,
    // including when another row fails; never leave orphan authority checks.
    const failure = workers.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
    const items = hydrated.filter((item): item is CompanionMemoryDocument => item !== undefined);
    const pendingImport = page.pendingImport ?? 0;
    const index = semantic ? { state: semantic.state === 'ready' && (!state.complete || pendingImport > 0) ? 'building' as const : semantic.state,
      indexed: semantic.indexed, total: semantic.total + pendingImport, ...(semantic.error ? { error: semantic.error } : {}) }
      : { state: state.error ? 'error' as const : state.complete && !state.dirty.size ? 'ready' as const : 'building' as const, indexed: state.indexed, ...(state.error ? { error: state.error } : {}) };
    const nextCursor = semantic ? semantic.nextCursor ? Buffer.from(JSON.stringify({ kind: 'memory-documents-semantic-v1', fingerprint, inner: semantic.nextCursor })).toString('base64url') : undefined : page.nextCursor;
    return { companionId: session.owner.id, directory: command.directory, folders: page.folders, items,
      // River returns a bounded ranked candidate set, not an exact corpus match
      // count. Keep corpus progress in index.total and avoid a misleading total.
      ...(semantic ? {} : { total: page.total }), index,
      hasMore: semantic ? !!semantic.nextCursor : page.hasMore,
      ...(nextCursor ? { nextCursor } : {}) };
  }

  private requireRevision(read: CompanionMemoryDocumentRead, expected: string): void {
    if (read.document.revision !== expected) throw new Error('文件或宿主日记已发生变化，请重新载入后保存。');
  }
  private async create(session: MemoryLibraryDocumentSession, command: Extract<CompanionMemoryDocumentCommand, { type: 'memory.documents.create' }>): Promise<CompanionMemoryDocumentRead> {
    this.editableFile(command.path);
    if (await session.text(command.path, true) !== undefined || session.manifest.files[command.path]) throw new Error('文件名已存在或曾属于已遗忘日记，请使用新文件名。');
    await session.directory(path.posix.dirname(command.path));
    const conversation = (await session.request({ type: 'memory.library.scope', companionId: session.owner.id })).conversation;
    if (!conversation) throw new Error('伙伴输入范围不可用。');
    let checksum: string | undefined;
    if (command.sourceMessageId) {
      const source = (await session.request({ type: 'memory.sources.filter', companionId: session.owner.id, conversationId: conversation.id, ids: [command.sourceMessageId] })).memorySources?.[0];
      if (!source) throw new Error('原消息不属于此伙伴的真实可见来源。');
      checksum = hash(source.content);
    }
    await session.atomic(command.path, command.content);
    session.manifest.files[command.path] = { state: 'tracked', conversationId: conversation.id,
      pending: { operationId: operationId(), hash: hash(command.content), tags: [...command.tags], autoTags: command.autoTags ?? true, diaryName: command.diaryName ?? command.path.split('/')[0],
        ...(command.sourceMessageId ? { kind: 'record', sourceMessageId: command.sourceMessageId, sourceChecksum: checksum } : {}) } };
    await session.save(); await session.reconcile(command.path); await session.save();
    return this.read(session, command.path);
  }
  private async save(session: MemoryLibraryDocumentSession, command: Extract<CompanionMemoryDocumentCommand, { type: 'memory.documents.save' }>): Promise<CompanionMemoryDocumentRead> {
    this.editableFile(command.path);
    const current = await this.read(session, command.path); this.requireRevision(current, command.expectedRevision);
    const note = current.memory, tags = command.tags ?? note?.tags ?? [], diaryName = command.diaryName ?? note?.diaryName ?? command.path.split('/')[0]!;
    if (note && command.content === note.content) {
      if (JSON.stringify(tags) !== JSON.stringify(note.tags) || diaryName !== note.diaryName || command.autoTags !== undefined && command.autoTags !== (note.metadata?.autoTags !== false)) {
        const updated = (await session.request({ type: 'memory.library.organize', companionId: session.owner.id, id: note.id, expectedVersion: note.version, tags, diaryName, autoTags: command.autoTags })).memories?.[0];
        if (!updated) throw new Error('日记分类尚未保存。');
        if (command.autoTags === false) await session.request({ type: 'memory.tags.cancel', companionId: session.owner.id, noteId: updated.id });
        await session.project(command.path, updated); await session.save();
      } else if (current.content !== note.content) { await session.project(command.path, note); await session.save(); }
      return this.read(session, command.path);
    }
    const entry = session.manifest.files[command.path] ??= { state: 'tracked' };
    entry.conversationId ??= note?.sourceConversationId ?? (await session.request({ type: 'memory.library.scope', companionId: session.owner.id })).conversation?.id;
    if (!entry.conversationId) throw new Error('伙伴输入范围不可用。');
    entry.pending = { operationId: operationId(), hash: hash(command.content), noteId: note?.id, expectedVersion: note?.version,
      sourceMessageId: note?.sourceMessageId, tags: [...tags], autoTags: command.autoTags ?? (note?.metadata?.autoTags !== false), diaryName };
    entry.noteId = note?.id; entry.version = note?.version; entry.state = 'tracked';
    await session.atomic(command.path, command.content); await session.save(); await session.reconcile(command.path); await session.save();
    return this.read(session, command.path);
  }
  private async move(session: MemoryLibraryDocumentSession, command: Extract<CompanionMemoryDocumentCommand, { type: 'memory.documents.move' }>): Promise<CompanionMemoryDocumentRead> {
    this.editableFile(command.path); this.editableFile(command.targetPath);
    const current = await this.read(session, command.path); this.requireRevision(current, command.expectedRevision);
    if (command.path.toLocaleLowerCase('en-US') === command.targetPath.toLocaleLowerCase('en-US')) throw new Error('新文件名必须与原文件名不同。');
    if (await session.text(command.targetPath, true) !== undefined || session.manifest.files[command.targetPath]) throw new Error('目标文件已经存在或属于旧日记。');
    await session.directory(path.posix.dirname(command.targetPath));
    session.manifest.files[command.path] ??= { state: 'tracked', hash: hash(current.content) };
    session.manifest.move = { from: command.path, to: command.targetPath, hash: hash(current.content) };
    await session.save();
    // Recovery uses the same durable move intent after a crash, and never calls
    // memory.save: renaming text cannot invent evidence or a learned revision.
    await session.recoverMove();
    return this.read(session, command.targetPath);
  }
  private async delete(session: MemoryLibraryDocumentSession, command: Extract<CompanionMemoryDocumentCommand, { type: 'memory.documents.delete' }>): Promise<void> {
    this.editableFile(command.path);
    const current = await this.read(session, command.path); this.requireRevision(current, command.expectedRevision);
    if (current.memory) await session.request({ type: 'memory.library.delete', companionId: session.owner.id, id: current.memory.id, expectedVersion: current.memory.version });
    await this.remove(session, command.path);
    const entry = session.manifest.files[command.path] ??= { state: 'forgotten' };
    entry.state = 'forgotten'; entry.withdrawn = false; delete entry.pending; await session.save();
  }
}

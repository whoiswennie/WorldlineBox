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
  private readonly initializedOwners = new Set<string>();
  constructor(private readonly options: CompanionMemoryDocumentsOptions) {
    if (!path.isAbsolute(options.libraryDirectory)) throw new Error('伙伴记忆目录必须是绝对路径。');
    this.catalog = new CompanionMemoryDocumentCatalog({ library: options.library, request: options.requestStorage,
      describe: (...args) => this.describe(...args) });
  }
  handle(command: CompanionMemoryDocumentCommand): Promise<CompanionWorkspaceResponse> {
    if (this.closed) return Promise.resolve({ ok: false, error: '伙伴记忆文档管理已关闭。' });
    const synchronize = !this.initializedOwners.has(command.companionId) || !['memory.documents.list', 'memory.documents.read', 'memory.documents.tags.status'].includes(command.type);
    const pending = this.options.library.withDocuments(command.companionId, async session => {
      this.initializedOwners.add(command.companionId);
      switch (command.type) {
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
    }, { synchronize }).then(response => {
      if (command.type !== 'memory.documents.list' && command.type !== 'memory.documents.read' && command.type !== 'memory.documents.tags.status') {
        if ('path' in command) this.catalog.mark(command.companionId, command.path);
        if ('targetPath' in command) this.catalog.mark(command.companionId, command.targetPath);
      }
      return response;
    }).catch((error: unknown): CompanionWorkspaceResponse => ({ ok: false, error: error instanceof Error ? error.message : '记忆文档操作失败。' }));
    this.jobs.add(pending);
    void pending.finally(() => this.jobs.delete(pending));
    return pending;
  }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled(this.jobs); await this.catalog.close(); }
  private editableDirectory(relative: string): void {
    memoryLibraryPathParts(relative);
    if (automatic(relative) || isDocument(path.posix.basename(relative))) throw new Error('目录名称不能占用受保护文档。');
  }
  private editableFile(relative: string): void {
    if (memoryLibraryPathParts(relative).length < 2 || !isDocument(path.posix.basename(relative))) throw new Error('请在日记本目录内使用 .md 或 .txt 文本文件。');
    if (automatic(relative)) throw new Error('稳定人格和 VCP 自动时间线只供查阅；需要学习时请另存到资料。');
  }
  private async remove(session: MemoryLibraryDocumentSession, relative: string): Promise<void> {
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
          await this.remove(session, relative); entry.state = 'forgotten'; await session.save(); throw new Error('文档原消息已变化或已撤回。');
        }
      }
      return undefined;
    }
    const result = (await session.request({ type: 'memory.library.read', companionId: session.owner.id, id: entry.noteId, sourceLimit, sourceCursor })).memoryRead;
    if (!result) {
      await this.remove(session, relative); entry.state = 'forgotten'; entry.withdrawn = true; delete entry.pending; await session.save();
      throw new Error('日记来源已经失效，旧文档已撤回。');
    }
    return result;
  }
  private describe(relative: string, content: string, updatedAt: string, note?: CompanionMemory, entry?: MemoryLibraryDocumentSession['manifest']['files'][string]): CompanionMemoryDocument {
    const readOnly = automatic(relative), contentHash = hash(content), name = path.posix.basename(relative);
    const revision = hash(JSON.stringify([relative, contentHash, note?.id, note?.version, note?.tags, note?.diaryName, note?.metadata?.autoTags, readOnly]));
    const naturalTitle = note && /^note_[a-f0-9]{48}\.(?:md|txt)$/iu.test(name)
      ? (note.content.match(/^#{1,6}\s+(.+)$/mu)?.[1] ?? note.content.split('\n').find(line => line.trim()) ?? '').trim().replace(/^[-*>\s]+/u, '').split(/(?<=[。！？.!?])\s*/u)[0]?.slice(0, 80)
      : undefined;
    return { path: relative, name, title: naturalTitle || name.replace(/\.(?:md|txt)$/iu, ''), directory: path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative),
      kind: relative === 'profile.md' ? 'profile' : relative.startsWith('时间线/') && name.startsWith('VCP-') ? 'timeline' : note ? 'note' : 'document',
      category: category(relative), updatedAt, bytes: Buffer.byteLength(content), revision, contentHash, readOnly, tags: note?.tags ?? [],
      syncState: readOnly ? 'generated' : entry?.conflict || note && entry?.version !== note.version ? 'conflict'
        : entry?.pending || note?.status === 'queued' || note && contentHash !== hash(note.content) ? 'pending' : note?.status === 'indexed' ? 'indexed' : 'untracked',
      ...(note ? { noteId: note.id, version: note.version, sourceConversationId: note.sourceConversationId, sourceCount: note.sources.length, captureMethod: note.captureMethod, autoTagsEnabled: note.metadata?.autoTags !== false } : {}),
      excerpt: content.replace(/\s+/gu, ' ').slice(0, 600) };
  }
  private async read(session: MemoryLibraryDocumentSession, relative: string, sourceLimit = 30, sourceCursor?: number): Promise<CompanionMemoryDocumentRead> {
    memoryLibraryPathParts(relative);
    if (!isDocument(path.posix.basename(relative))) throw new Error('只能读取 Markdown 或纯文本记忆文档。');
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
      const fresh = await this.authorized(session, relative, sourceLimit, sourceCursor);
      if (!fresh || fresh.memory.version !== ledger.memory.version) throw new Error('日记在读取过程中已修订，请重新载入。');
    }
    if (timeline && !await session.timelineValid(relative)) {
      await this.remove(session, relative); throw Object.assign(new Error('自动时间线的来源在读取过程中变化，旧文档已撤回。'), { code: 'MEMORY_DOCUMENT_WITHDRAWN' });
    }
    const tagStatus = ledger ? (await session.request({ type: 'memory.tags.status', companionId: session.owner.id, noteId: ledger.memory.id })).memoryTagStatus : undefined;
    return { document: this.describe(relative, content, info.mtime.toISOString(), ledger?.memory, session.manifest.files[relative]), content,
      ...(tagStatus ? { tagStatus } : {}),
      ...(ledger ? { memory: ledger.memory } : {}), sources: ledger?.sources ?? [], hasMoreSources: ledger?.hasMore ?? false,
      ...(ledger?.nextSourceCursor !== undefined ? { nextSourceCursor: ledger.nextSourceCursor } : {}) };
  }
  private async list(session: MemoryLibraryDocumentSession, command: Extract<CompanionMemoryDocumentCommand, { type: 'memory.documents.list' }>): Promise<CompanionMemoryDocumentsPage> {
    if (command.directory) memoryLibraryPathParts(command.directory);
    const state = await this.catalog.ensure(session), query = command.query?.trim() ?? '', tags = command.tags ?? [];
    const semantic = command.mode === 'semantic' && query ? await this.options.search?.(session.owner.id, query, command.limit, command.cursor) : undefined;
    if (command.mode === 'semantic' && query && !this.options.search) throw new Error('原版 VCP 语义检索暂不可用。');
    const result = await session.request({ type: 'document.catalog.query', companionId: session.owner.id, directory: command.directory,
      query: semantic ? '' : query, tags, ...(semantic ? { noteIds: semantic.hits.map(hit => hit.noteId) } : { cursor: command.cursor }), limit: command.limit });
    const page = result.documentCatalog;
    if (!page) throw new Error('记忆文档目录索引不可用。');
    const paths = semantic ? page.paths.sort((a, b) => {
      const order = (file: string) => semantic.hits.findIndex(hit => hit.noteId === session.manifest.files[file]?.noteId);
      return order(a) - order(b);
    }) : page.paths;
    const items: CompanionMemoryDocument[] = [];
    for (const file of paths) {
      try {
        const read = await this.read(session, file, 1), item = read.document;
        const hit = semantic?.hits.find(hit => hit.noteId === item.noteId);
        if (semantic && (!hit || item.version !== hit.version)) continue;
        // A persisted catalogue only supplies candidates. Recheck the current file,
        // source visibility, version, keyword and tags before returning any result.
        const searchable = (item.title + '\n' + read.content + '\n' + item.tags.join(' ')).toLowerCase();
        if (!semantic && query.toLowerCase().split(/\s+/u).some(token => !searchable.includes(token))) { this.catalog.mark(session.owner.id, file); continue; }
        if (tags.some(tag => !item.tags.includes(tag))) { this.catalog.mark(session.owner.id, file); continue; }
        items.push(item);
      } catch (error) {
        if (session.manifest.files[file]?.state !== 'forgotten' && (error as NodeJS.ErrnoException).code !== 'ENOENT'
          && !(error instanceof Error && 'code' in error && error.code === 'MEMORY_DOCUMENT_WITHDRAWN')) throw error;
        await session.request({ type: 'document.catalog.drop', companionId: session.owner.id, paths: [file] });
      }
    }
    const pendingImport = page.pendingImport ?? 0;
    const index = semantic ? { state: semantic.state === 'ready' && (!state.complete || pendingImport > 0) ? 'building' as const : semantic.state,
      indexed: semantic.indexed, total: semantic.total + pendingImport, ...(semantic.error ? { error: semantic.error } : {}) }
      : { state: state.error ? 'error' as const : state.complete ? 'ready' as const : 'building' as const, indexed: state.indexed, ...(state.error ? { error: state.error } : {}) };
    return { companionId: session.owner.id, directory: command.directory, folders: page.folders, items,
      total: semantic ? semantic.total : page.total, index,
      hasMore: semantic ? !!semantic.nextCursor : page.hasMore,
      ...((semantic?.nextCursor ?? page.nextCursor) ? { nextCursor: semantic?.nextCursor ?? page.nextCursor } : {}) };
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

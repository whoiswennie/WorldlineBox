import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CompanionMemory } from '../../shared/companions';
import type { CompanionMemoryDocument, CompanionMemoryDocumentCommand, CompanionMemoryDocumentRead, CompanionMemoryDocumentsPage } from '../../shared/companion-memory-documents';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import { memoryLibraryPathParts, type CompanionMemoryLibrary, type MemoryLibraryDocumentSession } from './memory-library';
import { CompanionMemoryDocumentCatalog } from './memory-document-catalog';
import { companionHistoryView, companionNarrativeText } from '../../shared/companion-memory-content';
import { withCompanionExecutionValidation } from './source-execution-evidence';

export interface CompanionMemoryDocumentsOptions {
  library: CompanionMemoryLibrary; libraryDirectory: string;
  requestStorage(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  search?(owner: string, query: string, limit?: number, cursor?: string): Promise<{ hits: Array<{ noteId: string; version: number }>; state: 'building' | 'ready' | 'error'; indexed: number; total: number; error?: string; nextCursor?: string }>;
}
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const readonlyCommands = new Set(['memory.documents.create', 'memory.documents.save', 'memory.documents.move', 'memory.documents.mkdir']);
class OutdatedNavigation extends Error {}
export class CompanionMemoryDocuments {
  private closed = false;
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly catalog: CompanionMemoryDocumentCatalog;
  constructor(private readonly options: CompanionMemoryDocumentsOptions) {
    if (!path.isAbsolute(options.libraryDirectory)) throw new Error('伙伴记忆目录必须是绝对路径。');
    this.catalog = new CompanionMemoryDocumentCatalog({ library: options.library, request: options.requestStorage, describe: (...args) => this.describe(...args) });
  }
  handle(command: CompanionMemoryDocumentCommand): Promise<CompanionWorkspaceResponse> {
    if (this.closed) return Promise.resolve({ ok: false, error: '记忆档案已关闭。' });
    if (readonlyCommands.has(command.type)) return Promise.resolve({ ok: false, error: '创建后的认知正文只读。请通过交流、学习目标和反馈影响伙伴，不能直接创建、改写或移动人格和记忆。' });
    const readOnly = ['memory.documents.list', 'memory.documents.locate', 'memory.documents.read', 'memory.documents.tags.status'].includes(command.type);
    const operation = () => this.options.library.withDocuments(command.companionId, async session => {
      switch (command.type) {
        case 'memory.documents.list': return { ok: true, documents: await this.list(session, command) };
        case 'memory.documents.locate': {
          const artifact = await session.registry.get(`memory:${command.noteId}`);
          if (!artifact) throw new Error('记忆正文尚未正式发布或已撤回。');
          return { ok: true, document: await this.read(session, artifact.relativePath) };
        }
        case 'memory.documents.read': return { ok: true, document: await this.read(session, command.path, command.sourceLimit, command.sourceCursor) };
        case 'memory.documents.tags.status': return { ok: true, document: await this.read(session, command.path) };
        case 'memory.documents.tags.retry':
        case 'memory.documents.tags.cancel': {
          const current = await this.read(session, command.path); if (current.document.revision !== command.expectedRevision || !current.memory) throw new Error('标签任务对应正文已变化或没有正式记忆身份。');
          await session.request({ type: command.type === 'memory.documents.tags.retry' ? 'memory.tags.retry' : 'memory.tags.cancel', companionId: session.owner.id, noteId: current.memory.id });
          return { ok: true, document: await this.read(session, command.path) };
        }
        case 'memory.documents.delete': {
          const current = await this.read(session, command.path);
          if (!current.memory || current.document.revision !== command.expectedRevision) throw new Error('只能通过准确版本撤回正式记忆；来源、起点和历史使用各自撤回协议。');
          await session.request({ type: 'memory.library.delete', companionId: session.owner.id, id: current.memory.id, expectedVersion: current.memory.version });
          await session.registry.revoke(`memory:${current.memory.id}`); await this.catalog.dropped(session.owner.id, command.path);
          return { ok: true, deletedPath: command.path };
        }
        default: throw new Error('认知正文只读。');
      }
    }, { readOnly: !['memory.documents.delete', 'memory.documents.tags.retry', 'memory.documents.tags.cancel'].includes(command.type), catalogInventory: command.type === 'memory.documents.list' });
    // One UI read owns one finite proof DAG, including the four parallel page
    // readers. Mutations retain separate reads so a lawful withdrawal does
    // not conflict with an old body witness from before that very mutation.
    const pending = (readOnly ? withCompanionExecutionValidation(operation) : operation())
      .catch((cause: unknown): CompanionWorkspaceResponse => ({ ok: false, error: cause instanceof Error ? cause.message : '档案读取失败。' }));
    this.jobs.add(pending); void pending.finally(() => this.jobs.delete(pending)).catch(() => undefined); return pending;
  }
  private describe(relative: string, content: string, updatedAt: string, note?: CompanionMemory, entry?: MemoryLibraryDocumentSession['manifest']['files'][string]): CompanionMemoryDocument {
    if (!entry) throw new Error('没有正式类型登记的文档不能进入认知资料目录。');
    const type = entry.artifact.kind, history = type === 'revision_history' ? companionHistoryView(content) : undefined;
    const readable = history?.content ?? companionNarrativeText(content), name = path.posix.basename(relative), first = readable.split(/\r?\n/u).find(line => line.trim()) ?? name;
    const category: CompanionMemoryDocument['category'] = type === 'persona_current' ? 'profile' : type === 'episode_memory' ? 'diary' : type === 'knowledge' || type === 'procedure' ? 'material' : type === 'self_understanding' ? 'self' : type === 'navigation' ? 'timeline' : 'other';
    return { path: relative, name, title: (history ? `${history.title} · 第 ${history.version} 版` : first.replace(/^#{1,6}\s+/u, '')).slice(0, 100), directory: path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative),
      kind: type === 'persona_current' ? 'profile' : type === 'navigation' ? 'timeline' : note ? 'note' : 'document', category,
      updatedAt: note?.updatedAt ?? updatedAt, ...(note ? { createdAt: note.createdAt, createdAtSource: 'memory' as const, ...(note.occurredAt ? { occurredAt: note.occurredAt } : {}) } : {}),
      bytes: Buffer.byteLength(content), revision: hash(JSON.stringify([entry.artifact.artifactId, entry.artifact.contentRevision, entry.hash, note?.version, note?.tags])), contentHash: entry.hash,
      readOnly: true, tags: note?.tags ?? history?.tags ?? [], syncState: note ? note.status === 'indexed' ? 'indexed' : 'pending' : 'generated',
      ...(note ? { noteId: note.id, version: note.version, sourceConversationId: note.sourceConversationId, sourceCount: note.sources.length, captureMethod: note.captureMethod, autoTagsEnabled: note.metadata?.autoTags !== false } : {}), excerpt: readable.replace(/\s+/gu, ' ').slice(0, 600) };
  }
  private async read(session: MemoryLibraryDocumentSession, relative: string, sourceLimit = 30, sourceCursor?: number): Promise<CompanionMemoryDocumentRead> {
    memoryLibraryPathParts(relative);
    const entry = await session.currentEntry(relative); if (!entry || !/\.(?:md|txt)$/iu.test(relative)) throw new Error('文档未登记或已撤回；未知目录不作为认知资料发现。');
    const registered = await session.registry.read({ artifactId: entry.artifact.artifactId, consumer: 'audit' });
    if (registered.artifact.contentHash !== entry.hash || registered.artifact.contentRevision !== entry.artifact.contentRevision) throw new Error('档案版本在读取期间变化。');
    const current = entry.noteId ? (await session.request({ type: 'memory.library.read', companionId: session.owner.id, id: entry.noteId, sourceLimit, sourceCursor })).memoryRead : undefined;
    if (entry.noteId && (!current || current.memory.content !== registered.text || current.memory.artifactKind !== entry.artifact.kind)) throw new Error('正文或真实来源已变化；不会用SQL正文替代。');
    if (entry.artifact.kind === 'navigation' && !await session.timelineValid(relative, entry.hash)) throw new OutdatedNavigation('这份导航正在等待依据更新，请稍后重新打开。');
    if (entry.artifact.kind === 'revision_history') {
      const match = /^---\n([^]*?)\n---\n/u.exec(registered.text); if (!match) throw new Error('历史封装无效。');
      const header = JSON.parse(match[1]!) as { id: string; contentRevision: number };
      const scope = (await session.request({ type: 'memory.library.scope.read', companionId: session.owner.id })).conversation;
      if (!scope || (await session.request({ type: 'memory.revision.describe', companionId: session.owner.id, conversationId: scope.id, id: header.id, contentRevision: header.contentRevision })).memoryHistoryDescriptor?.documentHash !== entry.hash) throw new Error('历史授权已撤回。');
    }
    if (entry.artifact.kind === 'source_evidence') {
      const identity = /^source:([a-zA-Z0-9_-]+):r(\d+)$/u.exec(entry.artifact.artifactId), sourceId = identity?.[1], scope = (await session.request({ type: 'memory.library.scope.read', companionId: session.owner.id })).conversation;
      const source = sourceId && scope ? (await session.request({ type: 'memory.sources.filter', companionId: session.owner.id, conversationId: scope.id, ids: [sourceId] })).memorySources?.[0] : undefined;
      if (!source || source.revision !== Number(identity?.[2]) || hash(source.content) !== entry.hash) throw new Error('真实来源已撤回或修订。');
    }
    // This is the user's audit view. Task/model reads use their own audience;
    // the SQL read/descriptor above still enforces withdrawal for this view.
    for (const reference of entry.artifact.sourceRefs) await session.registry.read({ artifactId: reference.artifactId, consumer: 'audit' });
    const tagStatus = current ? (await session.request({ type: 'memory.tags.status', companionId: session.owner.id, noteId: current.memory.id })).memoryTagStatus : undefined;
    const after = await session.registry.read({ artifactId: entry.artifact.artifactId, consumer: 'audit' });
    if (after.artifact.contentHash !== entry.hash) throw new Error('档案在读取期间变化。');
    if (entry.noteId) { const fresh = (await session.request({ type: 'memory.library.read', companionId: session.owner.id, id: entry.noteId, sourceLimit: 1 })).memoryRead; if (!fresh || fresh.memory.version !== current!.memory.version) throw new Error('读取期间记忆或权限已变化。'); }
    return { document: this.describe(relative, registered.text, entry.artifact.committedAt, current?.memory, entry), content: companionNarrativeText(registered.text), ...(current ? { memory: current.memory } : {}), sources: current?.sources ?? [], hasMoreSources: current?.hasMore ?? false, ...(current?.nextSourceCursor !== undefined ? { nextSourceCursor: current.nextSourceCursor } : {}), ...(tagStatus ? { tagStatus } : {}) };
  }
  private async list(session: MemoryLibraryDocumentSession, command: Extract<CompanionMemoryDocumentCommand, { type: 'memory.documents.list' }>): Promise<CompanionMemoryDocumentsPage> {
    if (command.directory) memoryLibraryPathParts(command.directory);
    const state = await this.catalog.ensure(session), query = command.query?.trim() ?? '', tags = command.tags ?? [], sort = command.sort ?? 'updated_desc', dateField = command.dateField ?? 'updatedAt';
    if (command.from && command.to && Date.parse(command.from) > Date.parse(command.to)) throw new Error('开始时间不能晚于结束时间。');
    const semanticMode = command.mode === 'semantic' && !!query;
    const semantic = semanticMode ? await this.options.search?.(session.owner.id, query, command.limit, command.cursor) : undefined;
    if (semanticMode && !semantic) throw new Error('VCP语义检索尚不可用。');
    // A background fill can finish while this page's canonical bodies are
    // being read. That cannot retroactively make its earlier partial SQL
    // page a complete-index page or make its cursor safe to advance.
    const completeAtQuery = state.complete && !state.dirty.size;
    const result = await session.request({ type: 'document.catalog.query', companionId: session.owner.id, directory: command.directory, recordsOnly: command.recordsOnly, query: semantic ? '' : query, tags, sort, dateField, from: command.from, to: command.to,
      ...(semantic ? { noteIds: semantic.hits.map(hit => hit.noteId) } : { cursor: command.cursor }), limit: command.limit });
    const page = result.documentCatalog; if (!page) throw new Error('登记目录索引尚不可用。');
    const items: CompanionMemoryDocument[] = [];
    const paths = semantic ? [...page.paths].sort((a, b) => semantic.hits.findIndex(hit => hit.noteId === session.manifest.files[a]?.noteId) - semantic.hits.findIndex(hit => hit.noteId === session.manifest.files[b]?.noteId)) : page.paths;
    const reads: Array<CompanionMemoryDocumentRead | undefined> = new Array(paths.length); let offset = 0;
    // Independent canonical reads can overlap; the bound avoids turning a
    // page of 64 files into either a serial waterfall or unbounded filesystem IO.
    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
      for (;;) {
        const index = offset++, file = paths[index]; if (!file) return;
        if (!session.manifest.files[file]) { await this.catalog.dropped(session.owner.id, file); continue; }
        try { reads[index] = await this.read(session, file, 1); }
        catch (cause) {
          // A derived navigation's older source revision is normal while fresh
          // diaries arrive, not a failure of all independent human documents.
          if (!(cause instanceof OutdatedNavigation)) throw cause;
          await this.catalog.dropped(session.owner.id, file);
        }
      }
    }));
    for (const read of reads) {
      if (!read) continue;
      const item = read.document;
      if (semantic && !semantic.hits.some(hit => hit.noteId === item.noteId && hit.version === item.version)) continue;
      if (!semantic && query.toLocaleLowerCase().split(/\s+/u).some(token => !(item.title + '\n' + read.content + '\n' + item.tags.join(' ')).toLocaleLowerCase().includes(token))) continue;
      if (tags.some(tag => !item.tags.includes(tag))) continue;
      const date = item[dateField]; if ((command.from || command.to) && (!date || command.from && Date.parse(date) < Date.parse(command.from) || command.to && Date.parse(date) > Date.parse(command.to))) continue;
      items.push(item);
    }
    return { companionId: session.owner.id, directory: command.directory, folders: page.folders, items, ...(semantic ? {} : { total: page.total }),
      index: { state: state.error ? 'error' : !completeAtQuery || state.dirty.size ? 'building' : semantic?.state ?? 'ready', indexed: state.indexed, ...(state.error ? { error: state.error } : {}) },
      hasMore: semantic ? !!semantic.nextCursor : page.hasMore, ...((semantic?.nextCursor ?? (!semantic ? page.nextCursor : undefined)) ? { nextCursor: semantic?.nextCursor ?? page.nextCursor } : {}) };
  }
  async forgetOwner(owner: string) { await this.catalog.forgetOwner(owner); }
  async close() { this.closed = true; await Promise.allSettled(this.jobs); await this.catalog.close(); }
}

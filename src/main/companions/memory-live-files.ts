import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { CompanionMemory } from '../../shared/companions';
import { companionMemoryFileReceiptsSchema, type CompanionMemoryFileReceipt } from '../../shared/companion-memory-files';
import type { CompanionMemoryLibrary, MemoryLibraryDocumentSession, MemoryLibraryEntry } from './memory-library';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const category = (note: CompanionMemory) => note.diaryName === '资料' || note.diaryName === '自我认识' ? note.diaryName
  : note.sources.some(source => source.sourceType === 'world_observation') ? '世界经历' : ['日记', '世界经历', '时间线'].includes(note.diaryName ?? '') ? note.diaryName! : '日记';
const inside = (root: string, candidate: string) => { const relative = path.relative(root, candidate); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
export class CompanionMemoryLiveFileError extends Error {
  readonly code = 'MEMORY_FILE_CHANGED';
  readonly noteIds: readonly string[];
  constructor(message: string, options?: ErrorOptions & { noteIds?: readonly string[] }) { super(message, options); this.name = 'CompanionMemoryLiveFileError'; this.noteIds = options?.noteIds ?? []; }
}
export interface CompanionMemoryFileFlush {
  checked: number; published: number; pending: boolean; nextCursor?: number;
}
type NoteFiles = Map<string, Array<[string, MemoryLibraryEntry]>>;
/** Text files are the current document content. SQL is the immutable revision,
 * provenance and authorization ledger; VCP is a derived retrieval projection.
 * A changed file must first be reconciled through that ledger, never silently
 * substituted into an old authorized revision or overwritten from stale SQL. */
export class CompanionMemoryLiveFiles {
  constructor(private readonly options: { library: CompanionMemoryLibrary; maxFilesPerFlush?: number }) {}
  /** The library's storage port must bypass Main's after-write flush hook:
   * reconciliation itself writes a new revision while holding this owner queue. */
  flush(owner: string, input: { noteIds?: readonly string[]; limit?: number; cursor?: number; reconcile?: boolean } = {}): Promise<CompanionMemoryFileFlush> {
    const limit = Math.max(1, Math.min(256, input.limit ?? this.options.maxFilesPerFlush ?? 64)), cursor = Math.max(0, input.cursor ?? 0);
    return this.options.library.withDocuments(owner, async session => {
      const index = this.index(session);
      let notes: CompanionMemory[], pending: boolean, nextCursor: number | undefined;
      if (input.noteIds) {
        const ids = [...new Set(input.noteIds)], selected = ids.slice(cursor, cursor + limit); notes = [];
        for (const id of selected) {
          const note = (await session.request({ type: 'memory.library.read', companionId: owner, id })).memoryRead?.memory;
          if (note) notes.push(note);
        }
        pending = cursor + selected.length < ids.length; nextCursor = pending ? cursor + selected.length : undefined;
      } else {
        const page = (await session.request({ type: 'memory.library.page', companionId: owner, cursor, limit })).memoryPage;
        notes = page?.items.map(item => item.memory) ?? []; pending = page?.hasMore ?? false; nextCursor = page?.nextCursor;
      }
      let published = 0;
      for (const note of notes) {
        if (note.companionId !== owner) throw new CompanionMemoryLiveFileError('文件提交的伙伴归属不一致。');
        const matches = (index.get(note.id) ?? []).filter(([, entry]) => entry.state !== 'forgotten' || entry.withdrawn);
        if (matches.length > 1) throw new CompanionMemoryLiveFileError('同一记忆关联了多个受管正文，请先核对文档身份。');
        const relative = matches[0]?.[0] ?? `${category(note)}/${note.id}.md`, previous = matches[0]?.[1];
        if (previous && !previous.withdrawn) {
          await session.reconcile(relative);
          const current = session.manifest.files[relative];
          if (!current || current.state === 'forgotten' || current.conflict || current.missingCycle !== undefined
            || await session.text(relative, true) === undefined) throw new CompanionMemoryLiveFileError('正文缺失、撤回或存在并发修改，尚未恢复为可读文件。');
          if (previous.version !== current.version || previous.hash !== current.hash) published++;
        } else {
          const actual = await session.text(relative, true);
          if (actual !== undefined && actual !== note.content) throw new CompanionMemoryLiveFileError('文件已有不同正文，保留外部修改并停止覆盖。');
          await session.directory(path.posix.dirname(relative));
          session.manifest.files[relative] = { noteId: note.id, conversationId: note.sourceConversationId, state: 'projecting', version: note.version, hash: hash(note.content) };
          await session.save(); await session.project(relative, note); published++;
        }
        const committed = session.manifest.files[relative];
        if (!committed || committed.state !== 'tracked' || committed.withdrawn || committed.pending || committed.conflict)
          throw new CompanionMemoryLiveFileError('正文发布期间来源或版本已变化，本次文件提交尚未完成。', { noteIds: [note.id] });
        index.set(note.id, [[relative, committed]]);
      }
      await session.save(); return { checked: notes.length, published, pending, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    }, { synchronize: input.reconcile !== false });
  }
  private async read(session: MemoryLibraryDocumentSession, relative: string): Promise<string> {
    const file = session.file(relative), root = await realpath(session.root);
    const verifyPath = async () => {
      let ancestor = session.root;
      for (const part of path.relative(session.root, path.dirname(file)).split(path.sep).filter(Boolean)) {
        ancestor = path.join(ancestor, part); const info = await lstat(ancestor);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new CompanionMemoryLiveFileError('正文所在目录不能包含链接或目录联接。');
      }
      if (!inside(root, await realpath(file))) throw new CompanionMemoryLiveFileError('正文已离开此伙伴的受管目录。');
    };
    await verifyPath(); const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 1_048_576n) throw new CompanionMemoryLiveFileError('正文不是受管普通文本文件或超过读取上限。');
    const same = (left: typeof before, right: typeof before) => left.dev === right.dev && left.ino === right.ino && left.size === right.size
      && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
    const handle = await open(file, 'r');
    try {
      const opened = await handle.stat({ bigint: true });
      if (!same(before, opened)) throw new CompanionMemoryLiveFileError('正文在打开期间变化，请重新读取。');
      const buffer = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < buffer.length) { const part = await handle.read(buffer, count, buffer.length - count, count); if (!part.bytesRead) break; count += part.bytesRead; }
      const after = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true }); await verifyPath();
      if (!same(before, after) || !same(before, current) || current.isSymbolicLink() || count !== Number(before.size)) throw new CompanionMemoryLiveFileError('正文在读取期间变化，请重新读取。');
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, count));
    } finally { await handle.close(); }
  }
  private index(session: MemoryLibraryDocumentSession): NoteFiles {
    const index: NoteFiles = new Map();
    for (const [relative, entry] of Object.entries(session.manifest.files)) if (entry.noteId) {
      const values = index.get(entry.noteId) ?? []; values.push([relative, entry]); index.set(entry.noteId, values);
    }
    return index;
  }
  private entry(index: NoteFiles, noteId: string) {
    const matches = (index.get(noteId) ?? []).filter(([, entry]) => entry.state !== 'forgotten' && !entry.withdrawn);
    if (matches.length !== 1) throw new CompanionMemoryLiveFileError('记忆正文尚未发布、身份不唯一或已撤回。');
    const [relative, entry] = matches[0]!;
    if (entry.state !== 'tracked' || entry.pending || entry.conflict || entry.missingCycle !== undefined || entry.moveConflict) throw new CompanionMemoryLiveFileError('记忆正文仍在登记或存在待处理修改。');
    return { relative, entry };
  }
  materialize(owner: string, notes: readonly CompanionMemory[]): Promise<{ notes: CompanionMemory[]; receipts: CompanionMemoryFileReceipt[] }> {
    return this.options.library.withDocuments(owner, async session => {
      const index = this.index(session);
      const materialized: CompanionMemory[] = [], receipts: CompanionMemoryFileReceipt[] = [];
      for (const note of notes) {
        try {
        if (note.companionId !== owner || note.contentRevision === undefined) throw new CompanionMemoryLiveFileError('记忆缺少当前伙伴的正文修订。');
        const { relative, entry } = this.entry(index, note.id), current = await session.current(entry), content = await this.read(session, relative);
        if (!current || current.contentRevision !== note.contentRevision || current.content !== content || content !== note.content)
          throw new CompanionMemoryLiveFileError('正文文件与已授权修订不同，必须先登记外部编辑再建立新上下文。');
        materialized.push({ ...note, content }); receipts.push({ companionId: owner, noteId: note.id, contentRevision: note.contentRevision, path: relative, contentHash: hash(content) });
        } catch (error) { throw new CompanionMemoryLiveFileError(error instanceof Error ? error.message : '记忆正文文件不可用。', { cause: error, noteIds: [note.id] }); }
      }
      return { notes: materialized, receipts };
    }, { synchronize: false, readOnly: true });
  }
  async validate(owner: string, input: readonly CompanionMemoryFileReceipt[]): Promise<boolean> {
    const parsed = companionMemoryFileReceiptsSchema.safeParse(input);
    if (!parsed.success || parsed.data.some(receipt => receipt.companionId !== owner)) return false;
    try {
      return await this.options.library.withDocuments(owner, async session => {
        const index = this.index(session);
        for (const receipt of parsed.data) {
          const { relative, entry } = this.entry(index, receipt.noteId);
          if (relative !== receipt.path) return false;
          const content = await this.read(session, relative), current = await session.current(entry);
          if (!current) return false;
          // SQL may have committed a lawful new revision while its atomic file
          // publication is queued. A still-tracked exact old projection is a
          // legal task snapshot; arbitrary external bytes never qualify.
          if (content !== current.content && (hash(content) !== receipt.contentHash || entry.hash !== receipt.contentHash)) return false;
          if (current.contentRevision === receipt.contentRevision && hash(content) === receipt.contentHash) continue;
          // A lawful background revision may publish newer text while an old
          // task keeps its original body. External pending edits, absent files
          // and changed original sources never pass this historical check.
          const scope = (await session.request({ type: 'memory.library.scope', companionId: owner })).conversation;
          if (!scope) return false;
          const historical = (await session.request({ type: 'memory.revision.read', companionId: owner, conversationId: scope.id,
            id: receipt.noteId, contentRevision: receipt.contentRevision })).memories?.[0];
          if (!historical || hash(historical.content) !== receipt.contentHash) return false;
        }
        return true;
      }, { synchronize: false, readOnly: true });
    } catch { return false; }
  }
}
